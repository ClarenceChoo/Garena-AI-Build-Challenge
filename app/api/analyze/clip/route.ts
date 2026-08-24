import { analyzeRealClip, UnseenOpenAIError, validateAnalyzeClipRequest } from "@/lib/unseen-openai";
import type { RealAnalysisApiError } from "@/lib/real-analysis-types";
import { REAL_ANALYSIS_LIMITS } from "@/lib/real-analysis-types";
import { unseenApiAuthorizationError } from "@/app/chatgpt-auth";
import { readJsonRequest, RequestBodyTooLargeError } from "@/app/api/_request-body";

export const runtime = "edge";

function errorResponse(status: number, code: RealAnalysisApiError["error"]["code"], message: string, requestId = "") {
  return Response.json(
    { error: { code, message, ...(requestId ? { requestId } : {}) } } satisfies RealAnalysisApiError,
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const authorizationError = await unseenApiAuthorizationError();
  if (authorizationError) return authorizationError;
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return errorResponse(503, "AI_NOT_CONFIGURED", "Live AI is not configured on this deployment. Add the OPENAI_API_KEY server secret; UNSEEN will not substitute prewritten results.");
  }
  let body: unknown;
  try {
    body = await readJsonRequest(request, REAL_ANALYSIS_LIMITS.maximumClipRequestBytes);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return errorResponse(413, "PAYLOAD_TOO_LARGE", error.message);
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
  try {
    const payload = validateAnalyzeClipRequest(body);
    const result = await analyzeRealClip(payload, {
      apiKey,
      visionModel: process.env.OPENAI_VISION_MODEL?.trim() || "gpt-5.6-sol",
      transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-mini-transcribe",
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof TypeError) return errorResponse(400, "INVALID_REQUEST", error.message);
    if (error instanceof UnseenOpenAIError) return errorResponse(error.status, error.code, error.message, error.requestId);
    return errorResponse(502, "OPENAI_ERROR", "The live clip analysis failed before producing evidence.");
  }
}
