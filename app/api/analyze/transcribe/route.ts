import { unseenApiAuthorizationError } from "@/app/chatgpt-auth";
import { transcribeGameplayAudio } from "@/lib/gameplay-search-openai";
import { GAMEPLAY_SEARCH_LIMITS } from "@/lib/gameplay-search-types";
import {
  gameplayErrorResponse,
  gameplayOpenAIConfig,
  gameplayRouteError,
} from "../_gameplay-response";

export const runtime = "edge";

export async function POST(request: Request): Promise<Response> {
  const authorizationError = await unseenApiAuthorizationError();
  if (authorizationError) return authorizationError;
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return gameplayErrorResponse(503, "AI_NOT_CONFIGURED", "Gameplay transcription needs the server-side OpenAI API key.");
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return gameplayErrorResponse(400, "INVALID_REQUEST", "Audio transcription must use multipart form data.");
  }
  const file = form.get("file");
  const clipId = String(form.get("clipId") ?? "").trim();
  const chunkStartMs = Number(form.get("chunkStartMs"));
  const voiceConsent = form.get("voiceConsent") === "true";
  if (!(file instanceof File) || !clipId || !Number.isFinite(chunkStartMs) || chunkStartMs < 0 || !voiceConsent) {
    return gameplayErrorResponse(400, "INVALID_REQUEST", "A consented audio file, clip ID, and chunk start are required.");
  }
  if (file.size <= 0 || file.size > GAMEPLAY_SEARCH_LIMITS.maximumAudioChunkBytes) {
    return gameplayErrorResponse(400, "INVALID_REQUEST", "Each consented audio chunk must be 25 MB or smaller.");
  }
  try {
    const result = await transcribeGameplayAudio(file, clipId, chunkStartMs, gameplayOpenAIConfig(apiKey, request.signal));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return gameplayRouteError(error, "The consented audio chunk could not be transcribed.");
  }
}
