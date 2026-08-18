import type { GameplaySearchApiErrorCode } from "@/lib/gameplay-search-types";
import { GameplaySearchOpenAIError } from "@/lib/gameplay-search-openai";

export function gameplayErrorResponse(
  status: number,
  code: GameplaySearchApiErrorCode,
  message: string,
  requestId = "",
  retryAfterMs = 0,
): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (retryAfterMs > 0) headers["Retry-After"] = String(Math.max(1, Math.ceil(retryAfterMs / 1_000)));
  return Response.json(
    { error: { code, message, ...(requestId ? { requestId } : {}) } },
    { status, headers },
  );
}

export function gameplayRouteError(error: unknown, fallback: string): Response {
  if (error instanceof TypeError) return gameplayErrorResponse(400, "INVALID_REQUEST", error.message);
  if (error instanceof GameplaySearchOpenAIError) {
    return gameplayErrorResponse(error.status, error.code, error.message, error.requestId, error.retryAfterMs);
  }
  return gameplayErrorResponse(502, "OPENAI_ERROR", fallback);
}

export function gameplayOpenAIConfig(apiKey: string) {
  return {
    apiKey,
    searchModel:
      process.env.OPENAI_SEARCH_MODEL?.trim() ||
      process.env.OPENAI_VISION_MODEL?.trim() ||
      "gpt-5.6-sol",
    transcriptionModel:
      process.env.OPENAI_SEARCH_TRANSCRIPTION_MODEL?.trim() || "whisper-1",
  };
}
