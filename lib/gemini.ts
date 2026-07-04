import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from '@google/generative-ai';

const geminiApiKey = process.env.GEMINI_API_KEY || '';
const geminiModelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const genAI = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;

// Structured output schema shared by all review-generation calls, so Gemini
// returns {title, comment} directly instead of free text that needs regex parsing.
const reviewResponseSchema: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    title: { type: SchemaType.STRING, description: 'レビューのタイトル' },
    comment: { type: SchemaType.STRING, description: 'レビューの本文（コメント）' },
  },
  required: ['title', 'comment'],
};

/**
 * Get the initialized Gemini GenerativeModel instance, configured to return
 * structured JSON ({title, comment}) for review generation.
 * Throws a structured error if the API key is not configured.
 */
export function getGeminiModel() {
  if (!genAI) {
    throw { message: 'Gemini API is not configured on the server.', status: 500 };
  }
  return genAI.getGenerativeModel({
    model: geminiModelName,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: reviewResponseSchema,
    },
  });
}

// Structured output schema for shop identification from photos.
const identifyResponseSchema: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    shop_name: {
      type: SchemaType.STRING,
      description: '写真から推定した飲食店の店名。特定できない場合は空文字',
    },
    location: {
      type: SchemaType.STRING,
      description: '推定した店の場所（例：「東京都中央区銀座付近」）。不明な場合は空文字',
    },
    confidence: {
      type: SchemaType.STRING,
      description: '推定の信頼度',
      enum: ['high', 'medium', 'low'],
      format: 'enum',
    },
  },
  required: ['shop_name', 'location', 'confidence'],
};

/**
 * Get a Gemini model configured to return structured JSON
 * ({shop_name, location, confidence}) for shop identification.
 */
export function getGeminiIdentifyModel() {
  if (!genAI) {
    throw { message: 'Gemini API is not configured on the server.', status: 500 };
  }
  return genAI.getGenerativeModel({
    model: geminiModelName,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: identifyResponseSchema,
    },
  });
}

export interface IdentifiedShop {
  shop_name: string;
  location: string;
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Parse a structured-output response into {shop_name, location, confidence}.
 * Throws a structured error if the response is not the expected JSON.
 */
export function parseIdentifiedShop(raw: string): IdentifiedShop {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw { message: 'AIの応答（JSON）の解析に失敗しました', status: 502 };
  }
  const obj = parsed as { shop_name?: unknown; location?: unknown; confidence?: unknown };
  if (typeof obj.shop_name !== 'string' || typeof obj.location !== 'string') {
    throw { message: 'AIの応答に必要なフィールド（shop_name / location）がありません', status: 502 };
  }
  const confidence =
    obj.confidence === 'high' || obj.confidence === 'medium' ? obj.confidence : 'low';
  return { shop_name: obj.shop_name.trim(), location: obj.location.trim(), confidence };
}

export interface GeneratedReview {
  title: string;
  comment: string;
}

/**
 * Parse a structured-output response into {title, comment}.
 * Throws a structured error if the response is not the expected JSON.
 */
export function parseGeneratedReview(raw: string): GeneratedReview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw { message: 'AIの応答（JSON）の解析に失敗しました', status: 502 };
  }
  const obj = parsed as { title?: unknown; comment?: unknown };
  if (typeof obj.title !== 'string' || typeof obj.comment !== 'string') {
    throw { message: 'AIの応答に必要なフィールド（title / comment）がありません', status: 502 };
  }
  return { title: obj.title.trim(), comment: obj.comment.trim() };
}

/**
 * Format visit date/time stored in the DB ('YYYY-MM-DD', 'HH:MM[:SS]') into a
 * Japanese description for prompts, e.g. "2026年6月13日 19時ごろ".
 * Returns null when no valid visit date is available.
 */
export function describeVisitDateTime(visitDate: string | null, visitTime: string | null): string | null {
  if (!visitDate) return null;
  const dateMatch = visitDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return null;

  let desc = `${Number(dateMatch[1])}年${Number(dateMatch[2])}月${Number(dateMatch[3])}日`;
  const timeMatch = visitTime ? visitTime.match(/^(\d{1,2}):/) : null;
  if (timeMatch) {
    desc += ` ${Number(timeMatch[1])}時ごろ`;
  }
  return desc;
}

/**
 * Convert a data-URI base64 image string to a Gemini-compatible inline data part.
 */
export function fileToGenerativePart(base64Str: string) {
  const match = base64Str.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid base64 image format. Must start with "data:image/...;base64,"');
  }
  return {
    inlineData: {
      data: match[2],
      mimeType: match[1],
    },
  };
}
