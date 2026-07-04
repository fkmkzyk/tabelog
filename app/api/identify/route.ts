import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getGeminiIdentifyModel, fileToGenerativePart, parseIdentifiedShop } from '@/lib/gemini';

// Identify the shop name and location from uploaded photos.
// This is a form-assist endpoint: it does not touch the DB — the result is
// only a suggestion the user can edit before creating a review record.
// NOTE: GPS coordinates are deliberately NOT passed to the model. LLMs cannot
// reliably reverse-geocode raw coordinates and produced wrong addresses
// (e.g. a completely different city). When photos have GPS, the accurate
// address comes from the Places API candidates instead.
export async function POST(request: Request) {
  try {
    // 1. Verify Authentication (Gemini calls cost money; never allow anonymous use)
    await verifyAuth(request);

    // 2. Parse request body
    const body = await request.json();
    const { images_base64 } = body;

    const imagesArray: string[] = Array.isArray(images_base64) ? images_base64 : [];
    if (imagesArray.length === 0 || imagesArray.length > 3) {
      return NextResponse.json({ error: 'Invalid images count (must be 1-3)' }, { status: 400 });
    }

    const model = getGeminiIdentifyModel();

    let imageParts;
    try {
      imageParts = imagesArray.map(img => fileToGenerativePart(img));
    } catch (e: unknown) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to process images' }, { status: 400 });
    }

    // 3. Ask Gemini to identify the shop
    const identifyPrompt = `
あなたは写真から飲食店を特定するアシスタントです。
提供された【画像（最大3枚）】を解析し、その店の「店名」と「場所」を推定してください。

【解析の手がかり】
- 看板・のれん・店頭サイン・提灯などに写っている店名の文字
- レシート・伝票・箸袋・おしぼり・コースター・メニューに印字された店名・住所・ロゴ

【出力ルール】
1. shop_name: 推定した店名。画像内の文字から読み取れた場合はそのまま使用してください。確実な手がかりがなく推定できない場合は空文字にしてください。存在しない店名を創作しないこと。
2. location: 店の場所の説明（例：「東京都中央区銀座付近」）。**画像内に住所・地名が実際に写っている場合のみ**（レシートに印字された住所、看板の「◯◯店」表記など）、その読み取った内容に基づいて記述してください。
   - 店名に関する既存知識（チェーン店の所在地など）や、料理・内装の雰囲気から場所を推測することは絶対に禁止します。
   - 画像から住所・地名を直接確認できない場合は、必ず空文字にしてください。
3. confidence: 推定の信頼度。
   - high: 画像内の文字（看板・レシート等）で店名を直接確認できた
   - medium: 間接的な手がかり（ロゴ・特徴的な内外装など）から高い確度で推定できた
   - low: 推測の域を出ない、または店名を特定できなかった
`;

    const result = await model.generateContent([identifyPrompt, ...imageParts]);
    const identified = parseIdentifiedShop(result.response.text());

    return NextResponse.json({
      success: true,
      shop_name: identified.shop_name,
      location: identified.location,
      confidence: identified.confidence,
    });

  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    const status = err.status || 500;
    const message = err.message || 'Internal Server Error';
    if (status === 500) console.error('Error identifying shop:', error);
    return NextResponse.json({ error: message }, { status });
  }
}
