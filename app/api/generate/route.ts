import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize Gemini API
const geminiApiKey = process.env.GEMINI_API_KEY || '';
const geminiModelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash'; // Default to gemini-2.0-flash

const genAI = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;

// Helper to convert base64 image data to generative part
function fileToGenerativePart(base64Str: string) {
  const match = base64Str.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid base64 image format. Must start with "data:image/...;base64,"');
  }
  const mimeType = match[1];
  const data = match[2];
  
  return {
    inlineData: {
      data,
      mimeType,
    },
  };
}

export async function POST(request: Request) {
  try {
    // 1. Verify Authentication
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized: Missing token' }, { status: 401 });
    }
    
    const token = authHeader.replace('Bearer ', '');
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    
    // Create temporary supabase client with user's token to verify identity
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
    
    const { data: { user }, error: authError } = await userClient.auth.getUser(token);
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized: Invalid token' }, { status: 401 });
    }

    // 2. Parse request body
    const body = await request.json();
    const { review_id, shop_name, rating, raw_memo, image_base64 } = body;

    if (!review_id || !shop_name || !rating || !image_base64) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    if (!genAI) {
      return NextResponse.json({ error: 'Gemini API is not configured on the server.' }, { status: 500 });
    }

    // Initialize Supabase Admin client
    const supabaseAdmin = getSupabaseAdmin();

    // Verify that the review belongs to the user
    const { data: reviewData, error: fetchError } = await supabaseAdmin
      .from('tabelog_reviews')
      .select('id, user_id')
      .eq('id', review_id)
      .single();

    if (fetchError || !reviewData) {
      return NextResponse.json({ error: 'Review not found' }, { status: 404 });
    }

    if (reviewData.user_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden: You do not own this review' }, { status: 403 });
    }

    // 3. Prepare Image Generative Part
    let imagePart;
    try {
      imagePart = fileToGenerativePart(image_base64);
    } catch (e: any) {
      return NextResponse.json({ error: e.message || 'Failed to process image' }, { status: 400 });
    }

    const model = genAI.getGenerativeModel({ model: geminiModelName });

    // 4. Step 1: AI Vision (Generation)
    const visionPrompt = `
あなたは食べログの口コミレビュー作成アシスタントです。
提供された【画像（料理や店舗外観など）】と、ユーザーからの【体験メモ（入力がない場合は空）】を厳密に解析し、以下の指示に従って淡々とした短いレビュー（下書き）を作成してください。

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
   - 画像や体験メモから確認できない情報（接客態度、店内の隠れた雰囲気、素材の産地や化学調味料など）を想像で捏造しないこと。
5. 内容:
   - 画像から視覚的に判断できる特徴（具材、色合い、盛り付けの様子など）から客観的に考えられる感想。
   - 体験メモがある場合は、そこに書かれている事実を自然に反映させてください。

【食事情報（※本文には店舗名・住所は絶対に入れないこと）】
店舗名: ${shop_name}
評価（星5段階）: ${rating}
ユーザーの体験メモ: ${raw_memo || 'なし'}
`;

    const visionResult = await model.generateContent([visionPrompt, imagePart]);
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
      })
      .eq('id', review_id);

    if (updateError) {
      throw updateError;
    }

    return NextResponse.json({
      success: true,
      generated_review: finalReview,
    });

  } catch (error: any) {
    console.error('Error generating review:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
