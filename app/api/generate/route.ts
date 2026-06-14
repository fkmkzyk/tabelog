import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { verifyAuth } from '@/lib/auth';
import { getGeminiModel, fileToGenerativePart } from '@/lib/gemini';

export async function POST(request: Request) {
  try {
    // 1. Verify Authentication
    const user = await verifyAuth(request);

    // 2. Parse request body
    const body = await request.json();
    const { review_id, shop_name, rating, raw_memo, image_base64, images_base64 } = body;

    // Support both single image (image_base64) and multiple images (images_base64)
    const imagesArray: string[] = Array.isArray(images_base64)
      ? images_base64
      : (image_base64 ? [image_base64] : []);

    if (!review_id || !shop_name || !rating || imagesArray.length === 0) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    const model = getGeminiModel();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabaseAdmin: any = getSupabaseAdmin();

    // Verify that the review belongs to the user
    const { data: reviewData, error: fetchError } = await supabaseAdmin
      .from('tabelog_reviews')
      .select('*')
      .eq('id', review_id)
      .single();

    if (fetchError || !reviewData) {
      return NextResponse.json({ error: 'Review not found' }, { status: 404 });
    }

    if ((reviewData as any).user_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden: You do not own this review' }, { status: 403 });
    }

    // 3. Prepare Image Generative Parts
    let imageParts;
    try {
      imageParts = imagesArray.map(img => fileToGenerativePart(img));
    } catch (e: any) {
      return NextResponse.json({ error: e.message || 'Failed to process images' }, { status: 400 });
    }

    // 4. Step 1: AI Vision (Generation)
    const visionPrompt = `
あなたは食べログの口コミレビュー作成アシスタントです。
提供された【画像（料理や店舗外観など、最大3枚）】と、ユーザーからの【体験メモ（入力がない場合は空）】を厳密に解析し、以下の指示に従って淡々とした短いレビュー（下書き）を作成してください。

【厳守すべき指示】
1. 構成:
   必ず「タイトル：[タイトル内容]」と「コメント：[コメント内容]」の2行構成で出力してください。
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

【食事情報（※本文には店舗名・住所は絶対に入れないこと）】
店舗名: ${shop_name}
評価（星5段階）: ${rating}
ユーザーの体験メモ: ${raw_memo || 'なし'}
`;

    const visionResult = await model.generateContent([visionPrompt, ...imageParts]);
    const generatedDraft = visionResult.response.text();

    // 5. Step 2: AI Prompt (Censorship & Hallucination Filter)
    const censorshipPrompt = `
あなたは極めて厳格なレビュー検閲官です。前段のAIが作成した【生成レビュー下書き】と、ユーザーの【体験メモ】を対比し、以下の検閲・修正ルールに従って最終的なレビュー文を修正してください。

【検閲・修正ルール】
1. 構成の確認: 必ず「タイトル：〇〇」と「コメント：〇〇」の構成になっているか確認し、崩れている場合は修正してください。
2. 文字数の調整: コメント（本文）の部分が130文字程度になっていることを確認してください。長すぎる場合は簡潔に削り、短すぎる場合は画像の特徴に基づく自然な描写を少し補ってください。
3. 禁止事項の徹底排除:
   - 店舗名（${shop_name}）や住所が、タイトルおよびコメントに含まれている場合は完全に削除してください。
   - 画像および体験メモから確認できないハルシネーション（勝手な想像）はすべて削除または修正してください。
4. トーンの調整:
   - お店のPR広告のような響きを一切排除し、淡々とした普通の温度感の日本語に修正してください。

【出力ルール】
検閲と修正を完了した、最終的な安全な食べログ用レビュー（タイトルとコメント）のみを返してください。挨拶、説明、修正履歴などは一切出力しないでください。

【入力データ】
生成レビュー下書き:
${generatedDraft}

ユーザーの体験メモ:
${raw_memo || 'なし'}
`;

    const censorshipResult = await model.generateContent(censorshipPrompt);
    const finalReview = censorshipResult.response.text().trim();

    // 6. Step 3: Write back to Supabase
    const { error: updateError } = await supabaseAdmin
      .from('tabelog_reviews')
      .update({
        generated_review: finalReview,
        status: 'draft',
      } as any)
      .eq('id', review_id);

    if (updateError) {
      throw updateError;
    }

    return NextResponse.json({
      success: true,
      generated_review: finalReview,
    });

  } catch (error: any) {
    const status = error.status || 500;
    const message = error.message || 'Internal Server Error';
    if (status === 500) console.error('Error generating review:', error);
    return NextResponse.json({ error: message }, { status });
  }
}
