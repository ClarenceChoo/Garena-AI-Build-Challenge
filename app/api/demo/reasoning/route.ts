import { DEMO_SESSION } from "@/lib/unseen-fixture";
import {
  buildWhatYouMissed,
  createPipelineInputFromDemoSession,
  runUnseenReasoningPipeline,
} from "@/lib/unseen-pipeline";

export const runtime = "edge";

export async function GET(): Promise<Response> {
  const input = createPipelineInputFromDemoSession(DEMO_SESSION);
  const artifacts = runUnseenReasoningPipeline(input, {
    alignment: { referenceSourceId: "src-ace" },
    momentLimit: 5,
    editPlan: {
      targetDurationMs: 75_000,
      targetPlayerId: DEMO_SESSION.focusParticipantId,
    },
  });
  const whatYouMissed = buildWhatYouMissed(
    artifacts,
    DEMO_SESSION.focusParticipantId,
  );

  return Response.json(
    {
      provenance: {
        mode: "synthetic_fixture",
        label: "Curated synthetic squad session",
        containsRealPlayerData: false,
      },
      version: artifacts.version,
      sessionId: artifacts.sessionId,
      alignment: artifacts.alignment,
      rankedMoments: artifacts.rankedMoments,
      editPlan: artifacts.editPlan,
      whatYouMissed,
      audit: artifacts.audit,
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
