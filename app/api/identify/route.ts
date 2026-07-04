import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getGeminiIdentifyModel, fileToGenerativePart, parseIdentifiedShop } from '@/lib/gemini';

// Identify the shop name and location from uploaded photos (+ optional EXIF GPS).
// This is a form-assist endpoint: it does not touch the DB — the result is
// only a suggestion the user can edit before creating a review record.
export async function POST(request: Request) {
  try {
    // 1. Verify Authentication (Gemini calls cost money; never allow anonymous use)
    await verifyAuth(request);

    // 2. Parse request body
    const body = await request.json();
    const { images_base64, latitude, longitude } = body;

    const imagesArray: string[] = Array.isArray(images_base64) ? images_base64 : [];
    if (imagesArray.length === 0 || imagesArray.length > 3) {
      return NextResponse.json({ error: 'Invalid images count (must be 1-3)' }, { status: 400 });
    }

    const hasGps =
      typeof latitude === 'number' && Number.isFinite(latitude) &&
      typeof longitude === 'number' && Number.isFinite(longitude) &&
      latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;

    const model = getGeminiIdentifyModel();

    let imageParts;
    try {
      imageParts = imagesArray.map(img => fileToGenerativePart(img));
    } catch (e: unknown) {
      return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to process images' }, { status: 400 });
    }

    // 3. Ask Gemini to identify the shop
    const gpsContext = hasGps
      ? `撮影場所のGPS座標: 緯度 ${latitude}, 経度 ${longitude}
この座標が示す地名・エリアを「location」フィールドに記述し、店名の推定にもこの周辺の店であることを考慮してください。`
      : '撮影場所のGPS座標: なし（写真の内容のみから推定してください）';

    const identifyPrompt = `
あなたは写真から飲食店を特定するアシスタントです。
提供された【画像（最大3枚）】と【GPS座標（ある場合）】を解析し、その店の「店名」と「場所」を推定してください。

【解析の手がかり】
- 看板・のれん・店頭サイン・提灯などに写っている店名の文字
- レシート・伝票・箸袋・おしぼり・コースター・メニューに印字された店名やロゴ
- 内装・外観・料理の特徴と、GPS座標から分かる地域性

【出力ルール】
1. shop_name: 推定した店名。画像内の文字から読み取れた場合はそのまま使用してください。確実な手がかりがなく推定できない場合は空文字にしてください。存在しない店名を創作しないこと。
2. location: 店の場所の説明。GPS座標がある場合は「都道府県＋市区町村＋地区名（例：東京都中央区銀座付近）」の形式で記述してください。GPSがなく画像からも分からない場合は空文字にしてください。
3. confidence: 推定の信頼度。
   - high: 画像内の文字（看板・レシート等）で店名を直接確認できた
   - medium: 間接的な手がかり（ロゴ・特徴的な内外装など）から高い確度で推定できた
   - low: 推測の域を出ない、または店名を特定できなかった

【位置情報】
${gpsContext}
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
