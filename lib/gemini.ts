import { GoogleGenerativeAI } from '@google/generative-ai';

const geminiApiKey = process.env.GEMINI_API_KEY || '';
const geminiModelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const genAI = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;

/**
 * Get the initialized Gemini GenerativeModel instance.
 * Throws a structured error if the API key is not configured.
 */
export function getGeminiModel() {
  if (!genAI) {
    throw { message: 'Gemini API is not configured on the server.', status: 500 };
  }
  return genAI.getGenerativeModel({ model: geminiModelName });
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
