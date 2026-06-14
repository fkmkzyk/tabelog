import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize Gemini API
const geminiApiKey = process.env.GEMINI_API_KEY || '';
const geminiModelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const genAI = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;

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
    const { review_id, instruction } = body;

    if (!review_id || !instruction || !instruction.trim()) {
      return NextResponse.json({ error: 'Missing required parameters' }, { status: 400 });
    }

    if (!genAI) {
      return NextResponse.json({ error: 'Gemini API is not configured on the server.' }, { status: 500 });
    }

    // Initialize Supabase Admin client
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

    if (reviewData.user_id !== user.id) {
      return NextResponse.json({ error: 'Forbidden: You do not own this review' }, { status: 403 });
    }

    const model = genAI.getGenerativeModel({ model: geminiModelName });

    // 3. Prepare Prompt for Rewriting & Censorship
    // We combine the rewriting and strict validation/censorship rules in a single, high-fidelity prompt.
    const rewritePrompt = `
あなたは食べログ of 口コミレビュー作成アシスタントであり、同時に極めて厳格なレビュー検閲官です。
現在、すでに作成されたレビューに対してユーザーから【リライトの指示】がありました。
元の【食事情報】および【現在のレビュー】を踏まえた上で、ユーザーの【リライトの指示】を的確に反映した新しいレビューを作成・検閲してください。

【厳守すべき検閲・修正ルール】
1. 構成:
   必ず「タイトル：[タイトル内容]」と「コメント：[コメント内容]」の2行構成で出力してください。
2. 文字数制限:
   コメント部分（本文）は130文字程度（目安100文字〜150文字程度）の簡潔な文章にしてください。ユーザーから「もっと長く」「もっと短く」などの指示がある場合は指示に合わせつつも、不必要に冗長にせず食べログにふさわしい簡潔さを保ってください。
3. トーン＆マナー:
   - お店のPRではない、一般客としての自然で淡々とした普通の温度感で記述してください。
   - 「とても美味しい」「最高」「絶品」などの過剰な褒め言葉や、かしこまった敬語表現は避け、普段メモに書き残すようなフラットで普通のトーン（例：「〜でした」「〜のようです」）にしてください。
4. 禁止事項の徹底排除:
   - 店舗名（${reviewData.shop_name}）および住所は、タイトルやコメント（本文）の中に絶対に含めないでください。
   - 提供された全ての情報から確認できる事実のみを使用し、確認できない情報（接客態度、店内の隠れた雰囲気、素材の産地や化学調味料など）を想像で捏造（ハルシネーション）しないこと。

【食事情報】
店舗名: ${reviewData.shop_name}
評価（星5段階）: ${reviewData.rating}
ユーザーの元の体験メモ: ${reviewData.raw_memo || 'なし'}

【現在のレビュー】
${reviewData.generated_review || 'なし'}

【ユーザーからのリライトの指示】
${instruction}

【出力ルール】
検閲と修正を完了した、最終的な安全な食べログ用レビュー（タイトルとコメント）のみを返してください。挨拶、説明、修正履歴などは一切出力しないでください。
`;

    const result = await model.generateContent(rewritePrompt);
    const finalReview = result.response.text().trim();

    // 4. Update the DB record (Reset status to 'draft' as content changed)
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
    console.error('Error rewriting review:', error);
    return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
  }
}
