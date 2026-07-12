import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { verifyAuth } from '@/lib/auth';
import { getGeminiMultiDraftModel, fileToGenerativePart, parseGeneratedDrafts, describeVisitDateTime } from '@/lib/gemini';
import { describeRevisit } from '@/lib/revisit';

export async function POST(request: Request) {
  // Set after the ownership check passes, so the catch block can safely
  // mark the record as 'failed' without letting callers flag other users' rows.
  let ownedReviewId: string | null = null;

  try {
    // 1. Verify Authentication
    const user = await verifyAuth(request);

    // 2. Parse request body
    const body = await request.json();
    const { review_id, image_base64, images_base64 } = body;

    // Support both single image (image_base64) and multiple images (images_base64)
    const imagesArray: string[] = Array.isArray(images_base64)
      ? images_base64
      : (image_base64 ? [image_base64] : []);

    if (!review_id || typeof review_id !== 'string') {
      return NextResponse.json({ error: 'Invalid review_id' }, { status: 400 });
    }
    if (imagesArray.length === 0 || imagesArray.length > 3) {
      return NextResponse.json({ error: 'Invalid images count (must be 1-3)' }, { status: 400 });
    }

    const supabaseAdmin = getSupabaseAdmin();

    // Verify that the review belongs to the user
    const { data: reviewData, error: fetchError } = await supabaseAdmin
      .from('tabelog_reviews')
      .select('*')
      .eq('id', review_id)
      .single();

    if (fetchError || !reviewData) {
      return NextResponse.json({ error: 'Review not found' }, { status: 404 });
    }

    const row = reviewData as unknown as {
      user_id: string;
      shop_name: string;
      rating: number;
      raw_memo: string | null;
      visit_date: string | null;
      visit_time: string | null;
      place_genre: string | null;
      place_id: string | null;
    };

    if (row.user_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden: You do not own this review' }, { status: 403 });
    }

    ownedReviewId = review_id;

    // Use the trusted values stored in the DB, not the request body
    const shop_name = row.shop_name;
    const rating = row.rating;
    const raw_memo = row.raw_memo;
    const visitDesc = describeVisitDateTime(row.visit_date, row.visit_time);
    const revisitDesc = await describeRevisit(supabaseAdmin, user.id, row.place_id, review_id);

    const model = getGeminiMultiDraftModel();

    // 3. Prepare Image Generative Parts
    let imageParts;
    try {
      imageParts = imagesArray.map(img => fileToGenerativePart(img));
    } catch (e: unknown) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to process images' }, { status: 400 });
    }

    // 4. Step 1: AI Vision (Generation)
    const visionPrompt = `
あなたは食べログの口コミレビュー作成アシスタントです。
提供された【画像（料理や店舗外観など、最大3枚）】と、ユーザーからの【体験メモ（入力がない場合は空）】を厳密に解析し、以下の指示に従って淡々とした短いレビュー（下書き）を作成してください。

【厳守すべき指示】
1. 出力形式:
   文体の異なるレビュー3案を「drafts」配列に出力してください（各案はタイトルを「title」、コメント本文を「comment」フィールドに）。
   - 案1: 淡々と簡潔（事実中心・最もフラット）
   - 案2: 料理の描写をやや多めに（見た目・食感など画像から確認できる範囲で）
   - 案3: 少しカジュアルな一言感想風
   3案とも、以下のすべてのルール（文字数・トーン・禁止事項）を守ってください。
2. 文字数制限:
   コメント部分（本文）は130文字程度（目安100文字〜150文字程度）の簡潔な文章にしてください。
3. トーン＆マナー:
   - お店のPRではない、一般客としての自然で淡々とした普通の温度感で記述してください。
   - 「とても美味しい」「最高」「絶品」などの過剰な褒め言葉や、かしこまった敬語表現は避け、普段メモに書き残すようなフラットで普通のトーン（例：「〜でした」「〜のようです」）にしてください。
4. 禁止事項:
   - 店舗名および住所は、タイトルやコメント（本文）の中に絶対に含めないでください。
   - 提供された全ての画像と体験メモから確認できる情報のみを使用し、確認できない情報（接客態度、店内の隠れた雰囲気、素材の産地や化学調味料など）を想像で捏造しないこと。
5. 内容:
   - アップロードされた画像から得られる視覚的特徴（具材、盛り付け、色合いなど）から客観的に考えられる感想。
   - 体験メモがある場合は、そこに書かれている事実を自然に反映させてください。
   - 訪問日時の情報がある場合は、季節や時間帯（ランチ／ディナーなど）の文脈として自然に活かして構いません（無理に言及する必要はなく、日付そのものを羅列しないこと）。
   - ただし、「6月に訪問」「先日の夜に」「休日のランチで」など、時期・時間帯の表現を**コメントの書き出し（1文目の冒頭）に置くことは禁止**します。コメントは料理や体験の内容から書き始め、時期に触れる場合は文中で自然に触れる程度にしてください。
   - 再訪情報がある場合は、「再訪」「また来た」のように再訪であることを自然に踏まえて構いません（無理に言及する必要はありません）。前回との味の比較など、確認できない内容を捏造しないこと。

【食事情報（※本文には店舗名・住所は絶対に入れないこと）】
店舗名: ${shop_name}
店舗ジャンル: ${row.place_genre || '不明'}
評価（星5段階）: ${rating}
訪問日時: ${visitDesc || '不明'}
再訪情報: ${revisitDesc || '初訪問（過去の記録なし）'}
ユーザーの体験メモ:
"""
${raw_memo || 'なし'}
"""
`;

    const visionResult = await model.generateContent([visionPrompt, ...imageParts]);
    const drafts = parseGeneratedDrafts(visionResult.response.text());

    // 5. Step 2: AI Prompt (Censorship & Hallucination Filter)
    const draftsText = drafts
      .map((d, i) => `案${i + 1}:\nタイトル: ${d.title}\nコメント: ${d.comment}`)
      .join('\n\n');

    const censorshipPrompt = `
あなたは極めて厳格なレビュー検閲官です。前段のAIが作成した【生成レビュー下書き（${drafts.length}案）】と、ユーザーの【体験メモ】を対比し、以下の検閲・修正ルールに従って**すべての案を**修正してください。

【検閲・修正ルール】
1. 文字数の調整: コメント（本文）の部分が130文字程度になっていることを確認してください。長すぎる場合は簡潔に削り、短すぎる場合は画像の特徴に基づく自然な描写を少し補ってください。
2. 禁止事項の徹底排除:
   - 店舗名（${shop_name}）や住所が、タイトルおよびコメントに含まれている場合は完全に削除してください。
   - 画像および体験メモから確認できないハルシネーション（勝手な想像）はすべて削除または修正してください。ただし下記の訪問日時・再訪情報は確認済みの事実であり、それらに基づく季節・時間帯（ランチ／ディナーなど）や再訪への自然な言及は削除しないでください。
3. トーンの調整:
   - お店のPR広告のような響きを一切排除し、淡々とした普通の温度感の日本語に修正してください。
4. 書き出しの調整:
   - コメントが「◯月に」「〜頃に」「先日」「休日の夜に」など訪問時期・時間帯の表現から始まっている場合は、料理や体験の内容から始まる書き出しに必ず修正してください（時期への言及は文中に移すか削除）。

【出力ルール】
検閲と修正を完了した、最終的な安全な食べログ用レビューを、入力と同じ順序・同じ案数で「drafts」配列に出力してください（各案はタイトルを「title」、コメント本文を「comment」フィールドに）。挨拶、説明、修正履歴などは一切含めないでください。

【入力データ】
生成レビュー下書き（${drafts.length}案）:
"""
${draftsText}
"""

訪問日時（確認済みの事実）: ${visitDesc || '不明'}
再訪情報（確認済みの事実）: ${revisitDesc || '初訪問（過去の記録なし）'}

ユーザーの体験メモ:
"""
${raw_memo || 'なし'}
"""
`;

    const censorshipResult = await model.generateContent(censorshipPrompt);
    const finalDrafts = parseGeneratedDrafts(censorshipResult.response.text());
    const primary = finalDrafts[0];

    // 6. Step 3: Write back to Supabase
    // review_title/comment hold the currently selected draft (initially 案1);
    // generated_review keeps the legacy canonical text format for backward compatibility.
    const { error: updateError } = await supabaseAdmin
      .from('tabelog_reviews')
      .update({
        generated_review: `タイトル：${primary.title}\nコメント：${primary.comment}`,
        review_title: primary.title,
        review_comment: primary.comment,
        review_drafts: finalDrafts,
        status: 'draft',
      } as unknown as never)
      .eq('id', review_id);

    if (updateError) {
      throw updateError;
    }

    return NextResponse.json({
      success: true,
      review_title: primary.title,
      review_comment: primary.comment,
      review_drafts: finalDrafts,
    });

  } catch (error: unknown) {
    // Mark the record as 'failed' so it does not stay stuck in 'processing'
    // even if the client has disconnected and cannot clean up.
    if (ownedReviewId) {
      const { error: failError } = await getSupabaseAdmin()
        .from('tabelog_reviews')
        .update({ status: 'failed' } as unknown as never)
        .eq('id', ownedReviewId);
      if (failError) console.error('Failed to mark review as failed:', failError);
    }

    const err = error as { status?: number; message?: string };
    const status = err.status || 500;
    const message = err.message || 'Internal Server Error';
    if (status === 500) console.error('Error generating review:', error);
    return NextResponse.json({ error: message }, { status });
  }
}
