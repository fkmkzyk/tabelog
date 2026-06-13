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
あなたは食べログの「利用規約」および「口コミガイドライン」を完璧に把握している、プロのレビュー作成アシスタントです。
提供された【画像（料理や店舗外観など）】と、ユーザーからの【体験メモ（入力がない場合は空）】を厳密に解析し、食べログのガイドラインを100%厳守した自然で読みやすいレビュー下書きを生成してください。

【厳守すべきガイドライン】
1. 事実の捏造禁止（超重要）:
   提供された【画像】から客観的に判断できる視覚情報（例：具材の種類、盛り付け、色合い、器、メニューの文字等）と、【体験メモ】に明記されている事実のみを使用してください。
   データに含まれない「店員の接客態度」「店内の雰囲気（画像にない場合）」「肉の柔らかさやスープのコク」などの感覚情報を、文章の肉付けのために「勝手に想像・創作して美化する」ことは完全に禁止します。
2. 主観表現への言い換え:
   見た目から推測する箇所は、必ず「〜のように見える」「美しい盛り付けで食欲をそそる」など、視覚情報に基づく主観表現に限定してください。
3. 事実確認が困難な表現の排除:
   「化学調味料を使用している」「店が経費削減をしている」「お腹を壊した」など、主観評価を超えた断定的批判、真偽不明な情報の暴露、他店と比較して著しく貶めるような表現は一切含めないでください。

【出力フォーマット】
以下の構成で、親しみやすく丁寧な日本語（300文字〜600文字程度）で出力してください。
・店舗名や利用した目的の紹介
・画像解析から得られた、料理の見た目や具材、盛り付けの特徴
・ユーザーメモがある場合、そこに含まれる具体的な感想の統合

【店舗・食事情報】
店舗名: ${shop_name}
評価（星5段階）: ${rating}
ユーザーの体験メモ: ${raw_memo || 'なし'}
`;

    const visionResult = await model.generateContent([visionPrompt, imagePart]);
    const generatedDraft = visionResult.response.text();

    // 5. Step 2: AI Prompt (Censorship & Hallucination Filter)
    const censorshipPrompt = `
あなたは極めて厳格な「食べログ公式レビュー検閲官」です。前段のAIが作成した【生成レビュー下書き】と、ユーザーの【体験メモ】を対比し、ハルシネーション（元のデータにない勝手な味付け・肉付け・嘘の褒め言葉）がないかを確認・修正してください。

【検閲ルール】
1. 【体験メモ】に記載がなく、かつ提供された【画像】のみからでは判断できない以下のような「盛り文句」が含まれている場合、それらを完全に削除、または事実ベースに書き換えてください。
   （例：「お肉が口の中でとろけました」「スタッフの方がとても親切でした」「素晴らしい雰囲気で〜」など）
2. 食べログの審査に落ちる原因となる「断定的な決め付け表現」がある場合は、「〜のように感じられました」「〜のように見えました」という主観的な表現にマイルドに修正してください。

【出力ルール】
検閲と修正を完了した、最終的な安全な食べログ用レビュー本文のみを返してください。不要な挨拶、説明、修正履歴などは一切出力しないでください。

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
