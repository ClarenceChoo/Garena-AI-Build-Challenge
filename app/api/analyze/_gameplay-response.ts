import type { GameplaySearchApiErrorCode } from "@/lib/gameplay-search-types";
import { GameplaySearchOpenAIError } from "@/lib/gameplay-search-openai";

export function gameplayErrorResponse(
  status: number,
  code: GameplaySearchApiErrorCode,
  message: string,
  requestId = "",
): Response {
  return Response.json(
    { error: { code, message, ...(requestId ? { requestId } : {}) } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export function gameplayRouteError(error: unknown, fallback: string): Response {
  if (error instanceof TypeError) return gameplayErrorResponse(400, "INVALID_REQUEST", error.message);
  if (error instanceof GameplaySearchOpenAIError) {
    return gameplayErrorResponse(error.status, error.code, error.message, error.requestId);
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
