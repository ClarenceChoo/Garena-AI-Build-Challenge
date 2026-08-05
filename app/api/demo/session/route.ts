import { DEMO_GENERATED_AT, DEMO_SESSION, DEMO_SESSION_ID } from "@/lib/unseen-fixture";
import type { ApiError, DemoSessionResponse } from "@/lib/unseen-types";

export const runtime = "edge";

function errorResponse(
  status: number,
  code: ApiError["error"]["code"],
  message: string,
): Response {
  return Response.json(
    { error: { code, message } } satisfies ApiError,
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request): Promise<Response> {
  const requestedSessionId = new URL(request.url).searchParams.get("sessionId");

  if (requestedSessionId && requestedSessionId !== DEMO_SESSION_ID) {
    return errorResponse(
      404,
      "SESSION_NOT_FOUND",
      `Demo session '${requestedSessionId}' was not found.`,
    );
  }

  return Response.json(
    {
      session: DEMO_SESSION,
      generatedAt: DEMO_GENERATED_AT,
      provenance: DEMO_SESSION.provenance,
    } satisfies DemoSessionResponse,
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}
