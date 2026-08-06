import { linkRealClips, UnseenOpenAIError } from "@/lib/unseen-openai";
import type { RealAnalysisApiError } from "@/lib/real-analysis-types";
import { unseenApiAuthorizationError } from "@/app/chatgpt-auth";

export const runtime = "edge";

function errorResponse(status: number, code: RealAnalysisApiError["error"]["code"], message: string, requestId = "") {
  return Response.json(
    { error: { code, message, ...(requestId ? { requestId } : {}) } } satisfies RealAnalysisApiError,
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  const authorizationError = await unseenApiAuthorizationError(body);
  if (authorizationError) return authorizationError;
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return errorResponse(503, "AI_NOT_CONFIGURED", "Live AI is not configured on this deployment. Add the OPENAI_API_KEY server secret; UNSEEN will not substitute prewritten results.");
  }
  try {
    const result = await linkRealClips(body, {
      apiKey,
      visionModel: process.env.OPENAI_VISION_MODEL?.trim() || "gpt-5.6-sol",
      linkingModel: process.env.OPENAI_LINKING_MODEL?.trim() || "gpt-5.6-sol",
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof TypeError) return errorResponse(400, "INVALID_REQUEST", error.message);
    if (error instanceof UnseenOpenAIError) return errorResponse(error.status, error.code, error.message, error.requestId);
    return errorResponse(502, "OPENAI_ERROR", "The cross-clip linking run failed before producing a story.");
  }
}
