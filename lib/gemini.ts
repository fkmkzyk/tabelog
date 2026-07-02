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
