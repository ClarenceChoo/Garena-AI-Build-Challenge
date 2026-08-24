import { DEMO_PIPELINE, DEMO_SESSION, DEMO_SESSION_ID } from "@/lib/unseen-fixture";
import type {
  ApiError,
  MediaAnalysisModality,
  PipelineStageStatus,
  ProcessDemoRequest,
  ProcessDemoResponse,
} from "@/lib/unseen-types";
import { readTextRequest, RequestBodyTooLargeError } from "@/app/api/_request-body";

export const runtime = "edge";

function errorResponse(
  status: number,
  code: ApiError["error"]["code"],
  message: string,
  details?: ApiError["error"]["details"],
): Response {
  return Response.json(
    { error: { code, message, ...(details ? { details } : {}) } } satisfies ApiError,
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<unknown> {
  const body = await readTextRequest(request, 64 * 1024);
  if (!body.trim()) return {};
  return JSON.parse(body) as unknown;
}

export async function POST(request: Request): Promise<Response> {
  let rawPayload: unknown;

  try {
    rawPayload = await readJson(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", error.message);
    }
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  if (!isRecord(rawPayload)) {
    return errorResponse(400, "INVALID_REQUEST", "Request body must be a JSON object.");
  }

  const payload = rawPayload as ProcessDemoRequest;
  if (payload.sessionId !== undefined && typeof payload.sessionId !== "string") {
    return errorResponse(400, "INVALID_REQUEST", "sessionId must be a string.");
  }
  if (payload.sessionId && payload.sessionId !== DEMO_SESSION_ID) {
    return errorResponse(
      404,
      "SESSION_NOT_FOUND",
      `Demo session '${payload.sessionId}' was not found.`,
    );
  }

  const cursor = payload.cursor ?? 0;
  if (!Number.isInteger(cursor) || cursor < 0 || cursor >= DEMO_PIPELINE.length) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      `cursor must be an integer from 0 to ${DEMO_PIPELINE.length - 1}.`,
      { min: 0, max: DEMO_PIPELINE.length - 1 },
    );
  }

  const finalCursor = DEMO_PIPELINE.length - 1;
  const complete = cursor === finalCursor;
  const currentDefinition = DEMO_PIPELINE[cursor];
  const stages: PipelineStageStatus[] = DEMO_PIPELINE.map((stage, index) => ({
    ...stage,
    state:
      complete || index < cursor
        ? "complete"
        : index === cursor
          ? "active"
          : "queued",
  }));

  const response: ProcessDemoResponse = {
    sessionId: DEMO_SESSION_ID,
    runId: `${DEMO_SESSION_ID}-run-v1`,
    cursor,
    nextCursor: complete ? null : cursor + 1,
    complete,
    currentStage: currentDefinition.id,
    overallProgress: currentDefinition.progress,
    statusLine: currentDefinition.label,
    stages,
    outputCounts: {
      alignedSources: cursor >= 1 ? DEMO_SESSION.sources.length : 0,
      incidents: cursor >= 3 ? DEMO_SESSION.incidents.length : 0,
      rankedMoments: cursor >= 4 ? DEMO_SESSION.moments.length : 0,
      editBeats: cursor >= 5 ? DEMO_SESSION.directorCut.editBeats.length : 0,
    },
    mediaAnalysis: (() => {
      const traces = DEMO_SESSION.media.traces;
      const observedEvidenceIds =
        cursor < 2
          ? []
          : cursor === 2
            ? traces
                .filter((trace) => !trace.modalities.includes("cross_perspective_fusion"))
                .map((trace) => trace.evidenceId)
            : traces.map((trace) => trace.evidenceId);
      const detectorStages: MediaAnalysisModality[][] = [
        [],
        ["hud_ocr", "audio_reaction"],
        ["visual_detection", "hud_ocr", "speech_to_text", "audio_reaction"],
        [
          "visual_detection",
          "hud_ocr",
          "speech_to_text",
          "audio_reaction",
          "cross_perspective_fusion",
        ],
        ["cross_perspective_fusion"],
        ["cross_perspective_fusion"],
      ];
      const summaries = [
        "Verified the three preloaded media fingerprints and consent grants.",
        "Matched six timer, audio, round-start, and kill-feed anchors.",
        "Read visible events, HUD signals, opted-in speech, and audio reactions.",
        "Fused the observations into one shared evidence timeline.",
        "Ranked the squad moments and selected evidence-backed perspectives.",
        "Generated the Director's Cut, What You Missed, and grounded session index.",
      ];
      return {
        mode: "precomputed_media_trace" as const,
        recordingsVerified: DEMO_SESSION.media.recordings.length,
        anchorsMatched: cursor >= 1
          ? DEMO_SESSION.sources.reduce(
              (total, source) => total + source.anchors.length,
              0,
            )
          : 0,
        evidenceObserved: observedEvidenceIds.length,
        observedEvidenceIds,
        activeDetectors: detectorStages[cursor],
        summary: summaries[cursor],
      };
    })(),
  };

  return Response.json(response, {
    headers: { "Cache-Control": "no-store" },
  });
}
