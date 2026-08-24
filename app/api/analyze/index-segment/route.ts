import { unseenApiAuthorizationError } from "@/app/chatgpt-auth";
import { readJsonRequest, RequestBodyTooLargeError } from "@/app/api/_request-body";
import { indexGameplaySegment } from "@/lib/gameplay-search-openai";
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
    return gameplayErrorResponse(503, "AI_NOT_CONFIGURED", "Gameplay search needs the server-side OpenAI API key.");
  }
  let body: unknown;
  try {
    body = await readJsonRequest(request, GAMEPLAY_SEARCH_LIMITS.maximumIndexRequestBytes);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return gameplayErrorResponse(413, "PAYLOAD_TOO_LARGE", error.message);
    return gameplayErrorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  try {
    const result = await indexGameplaySegment(body, gameplayOpenAIConfig(apiKey, request.signal));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return gameplayRouteError(error, "The gameplay segment could not be indexed.");
  }
}
