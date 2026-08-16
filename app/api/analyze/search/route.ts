import { unseenApiAuthorizationError } from "@/app/chatgpt-auth";
import { searchGameplay } from "@/lib/gameplay-search-openai";
import {
  gameplayErrorResponse,
  gameplayOpenAIConfig,
  gameplayRouteError,
} from "../_gameplay-response";

export const runtime = "edge";

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return gameplayErrorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  const authorizationError = await unseenApiAuthorizationError(body);
  if (authorizationError) return authorizationError;
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return gameplayErrorResponse(503, "AI_NOT_CONFIGURED", "Gameplay search needs the server-side OpenAI API key.");
  }
  try {
    const result = await searchGameplay(body, gameplayOpenAIConfig(apiKey));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return gameplayRouteError(error, "The gameplay search did not produce a grounded result.");
  }
}
