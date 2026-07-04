import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { verifyAuth } from '@/lib/auth';
import { getGeminiModel, parseGeneratedReview, describeVisitDateTime } from '@/lib/gemini';

export async function POST(request: Request) {
  try {
    // 1. Verify Authentication
    const user = await verifyAuth(request);

    // 2. Parse request body
    const body = await request.json();
    const { review_id, instruction } = body;

    if (!review_id || typeof review_id !== 'string') {
      return NextResponse.json({ error: 'Invalid review_id' }, { status: 400 });
    }
    if (!instruction || typeof instruction !== 'string' || !instruction.trim() || instruction.length > 500) {
      return NextResponse.json({ error: 'Invalid instruction' }, { status: 400 });
    }

    const model = getGeminiModel();
    const supabaseAdmin = getSupabaseAdmin();

    // Verify that the review exists and belongs to the user
    const { data: reviewData, error: fetchError } = await supabaseAdmin
      .from('tabelog_reviews')
      .select('*')
      .eq('id', review_id)
      .single();

    if (fetchError || !reviewData) {
      return NextResponse.json({ error: 'Review not found' }, { status: 404 });
    }

    const row = reviewData as unknown as { user_id: string; shop_name: string; rating: number; raw_memo: string | null; generated_review: string | null; review_title: string | null; review_comment: string | null; visit_date: string | null; visit_time: string | null; place_genre: string | null };

    if (row.user_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden: You do not own this review' }, { status: 403 });
    }

    const shopName = row.shop_name;
    const rating = row.rating;
    const rawMemo = row.raw_memo;
    // Prefer the structured columns; fall back to the legacy text format for old records
    const currentReview = (row.review_title || row.review_comment)
      ? `タイトル：${row.review_title || ''}\nコメント：${row.review_comment || ''}`
      : row.generated_review;

    // 3. Prepare Prompt for Rewriting & Censorship
    const rewritePrompt = `
あなたは食べログの口コミレビュー作成アシスタントであり、同時に極めて厳格なレビュー検閲官です。
現在、すでに作成されたレビューに対してユーザーから【リライトの指示】がありました。
元の【食事情報】および【現在のレビュー】を踏まえた上で、ユーザーの【リライトの指示】を的確に反映した新しいレビューを作成・検閲してください。

【厳守すべき検閲・修正ルール】
1. 出力形式:
   レビューのタイトルを「title」フィールドに、コメント本文を「comment」フィールドに出力してください。
2. 文字数制限:
   コメント部分（本文）は130文字程度（目安100文字〜150文字程度）の簡潔な文章にしてください。ユーザーから「もっと長く」「もっと短く」などの指示がある場合は指示に合わせつつも、不必要に冗長にせず食べログにふさわしい簡潔さを保ってください。
3. トーン＆マナー:
   - お店のPRではない、一般客としての自然で淡々とした普通の温度感で記述してください。
   - 「とても美味しい」「最高」「絶品」などの過剰な褒め言葉や、かしこまった敬語表現は避け、普段メモに書き残すようなフラットで普通のトーン（例：「〜でした」「〜のようです」）にしてください。
4. 禁止事項の徹底排除:
   - 店舗名（${shopName}）および住所は、タイトルやコメント（本文）の中に絶対に含めないでください。
   - 提供された全ての情報から確認できる事実のみを使用し、確認できない情報（接客態度、店内の隠れた雰囲気、素材の産地や化学調味料など）を想像で捏造（ハルシネーション）しないこと。
5. 書き出しの調整:
   - 「◯月に」「〜頃に」「先日」「休日の夜に」など、訪問時期・時間帯の表現をコメントの書き出し（1文目の冒頭）に置かないでください。コメントは料理や体験の内容から書き始め、時期に触れる場合は文中で自然に触れる程度にしてください（ユーザーが明示的に書き出しへの言及を指示した場合を除く）。

【食事情報】
店舗名: ${shopName}
店舗ジャンル: ${row.place_genre || '不明'}
評価（星5段階）: ${rating}
訪問日時（確認済みの事実。季節や時間帯の文脈として自然に活かして良い）: ${describeVisitDateTime(row.visit_date, row.visit_time) || '不明'}
ユーザーの元の体験メモ:
"""
${rawMemo || 'なし'}
"""

【現在のレビュー】
"""
${currentReview || 'なし'}
"""

【ユーザーからのリライトの指示】
"""
${instruction}
"""

【出力ルール】
検閲と修正を完了した、最終的な安全な食べログ用レビューのタイトルを「title」フィールドに、コメント本文を「comment」フィールドに出力してください。挨拶、説明、修正履歴などは一切含めないでください。
`;

    const result = await model.generateContent(rewritePrompt);
    const finalReview = parseGeneratedReview(result.response.text());

    // 4. Update the DB record (Reset status to 'draft' as content changed)
    // generated_review keeps the legacy canonical text format for backward compatibility.
    const { error: updateError } = await supabaseAdmin
      .from('tabelog_reviews')
      .update({
        generated_review: `タイトル：${finalReview.title}\nコメント：${finalReview.comment}`,
        review_title: finalReview.title,
        review_comment: finalReview.comment,
        status: 'draft',
      } as unknown as never)
      .eq('id', review_id);

    if (updateError) {
      throw updateError;
    }

    return NextResponse.json({
      success: true,
      review_title: finalReview.title,
      review_comment: finalReview.comment,
    });

  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    const status = err.status || 500;
    const message = err.message || 'Internal Server Error';
    if (status === 500) console.error('Error rewriting review:', error);
    return NextResponse.json({ error: message }, { status });
  }
}
