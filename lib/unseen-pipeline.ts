/**
 * UNSEEN media reasoning orchestration.
 *
 * The heavy media jobs (decode, OCR, ASR, frame sampling, and final encoding)
 * live outside this edge-compatible module. This file composes their typed
 * artifacts into alignment, ranking, personalisation, and an edit plan.
 */

import type { UnseenSession } from "./unseen-types";
import {
  alignRecordingsFromAnchors,
  filterPermittedMomentCandidates,
  generateEditPlan,
  rankMomentCandidates,
  type AlignmentOptions,
  type AlignmentResult,
  type AlignmentTrackInput,
  type EditPlan,
  type EditPlanOptions,
  type EvidenceReference,
  type MomentCandidate,
  type RankedMediaMoment,
} from "./unseen-ai";

export interface UnseenPipelineInput {
  sessionId: string;
  tracks: AlignmentTrackInput[];
  candidates: MomentCandidate[];
}

export interface UnseenPipelineOptions {
  alignment?: AlignmentOptions;
  momentLimit?: number;
  editPlan?: Omit<EditPlanOptions, "transforms">;
}

export type ReasoningStage =
  | "align"
  | "reconstruct"
  | "rank"
  | "direct"
  | "ready";

export interface PipelineAuditEntry {
  stage: ReasoningStage;
  status: "complete" | "warning";
  summary: string;
  artifactCount: number;
}

export interface UnseenPipelineArtifacts {
  version: "unseen-reasoning-v1";
  sessionId: string;
  alignment: AlignmentResult;
  rankedMoments: RankedMediaMoment[];
  editPlan: EditPlan;
  evidenceIndex: EvidenceReference[];
  audit: PipelineAuditEntry[];
}

export interface MissedPerspectiveMoment {
  momentId: string;
  title: string;
  summary: string;
  startMs: number;
  endMs: number;
  score: number;
  revealSourceIds: string[];
  evidenceIds: string[];
}

function uniqueEvidence(moments: RankedMediaMoment[]): EvidenceReference[] {
  const byId = new Map<string, EvidenceReference>();
  for (const moment of moments) {
    for (const evidence of moment.evidence) {
      if (
        evidence.permitted !== false &&
        evidence.sensitivity !== "blocked" &&
        !byId.has(evidence.id)
      ) {
        byId.set(evidence.id, evidence);
      }
    }
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.startMs - right.startMs || left.id.localeCompare(right.id),
  );
}

/**
 * Runs the deterministic reasoning core over already-extracted media facts.
 * It is synchronous, idempotent for equal inputs, and safe in edge runtimes.
 */
export function runUnseenReasoningPipeline(
  input: UnseenPipelineInput,
  options: UnseenPipelineOptions = {},
): UnseenPipelineArtifacts {
  const alignment = alignRecordingsFromAnchors(input.tracks, options.alignment);
  const permittedCandidates = filterPermittedMomentCandidates(input.candidates);
  const rankedMoments = rankMomentCandidates(
    permittedCandidates,
    options.momentLimit ?? 5,
  );
  const editPlan = generateEditPlan(rankedMoments, {
    ...options.editPlan,
    transforms: alignment.transforms,
  });
  const evidenceIndex = uniqueEvidence(rankedMoments);
  const audit: PipelineAuditEntry[] = [
    {
      stage: "align",
      status: alignment.warnings.length > 0 ? "warning" : "complete",
      summary: `${alignment.transforms.length} recording clock(s) mapped to the shared timeline.`,
      artifactCount: alignment.transforms.length,
    },
    {
      stage: "reconstruct",
      status: "complete",
      summary: `${permittedCandidates.length} permitted, evidence-backed candidate moment(s) reconstructed.`,
      artifactCount: permittedCandidates.length,
    },
    {
      stage: "rank",
      status: rankedMoments.length > 0 ? "complete" : "warning",
      summary: `${rankedMoments.length} diverse moment(s) selected with inspectable scores.`,
      artifactCount: rankedMoments.length,
    },
    {
      stage: "direct",
      status: editPlan.warnings.length > 0 ? "warning" : "complete",
      summary: `${editPlan.clips.length} evidence-linked edit decision(s) generated.`,
      artifactCount: editPlan.clips.length,
    },
    {
      stage: "ready",
      status:
        rankedMoments.length > 0 && editPlan.clips.length > 0
          ? "complete"
          : "warning",
      summary: "Reasoning artifacts are ready for UI playback or a media renderer.",
      artifactCount: evidenceIndex.length,
    },
  ];

  return {
    version: "unseen-reasoning-v1",
    sessionId: input.sessionId,
    alignment,
    rankedMoments,
    editPlan,
    evidenceIndex,
    audit,
  };
}

/**
 * Personalises the ranked moments without re-running analysis. A moment is
 * "missed" when the target player lacks a visible view while another permitted
 * perspective shows it.
 */
export function buildWhatYouMissed(
  artifacts: Pick<UnseenPipelineArtifacts, "rankedMoments">,
  targetPlayerId: string,
  limit = 5,
): MissedPerspectiveMoment[] {
  return filterPermittedMomentCandidates(artifacts.rankedMoments)
    .filter((moment) => {
      const explicitlyMissed = moment.missedByPlayerIds?.includes(targetPlayerId) === true;
      const targetViews = moment.perspectives.filter(
        (perspective) => perspective.playerId === targetPlayerId,
      );
      const targetSawIt = targetViews.some(
        (perspective) =>
          perspective.permitted !== false && perspective.visibility === "visible",
      );
      const revealExists = moment.perspectives.some(
        (perspective) =>
          perspective.playerId !== targetPlayerId &&
          perspective.permitted !== false &&
          perspective.visibility === "visible",
      );
      return (explicitlyMissed || !targetSawIt) && revealExists;
    })
    .slice(0, Math.max(0, limit))
    .map((moment) => ({
      momentId: moment.id,
      title: moment.title,
      summary: moment.summary,
      startMs: moment.startMs,
      endMs: moment.endMs,
      score: moment.score,
      revealSourceIds: moment.perspectives
        .filter(
          (perspective) =>
            perspective.playerId !== targetPlayerId &&
            perspective.permitted !== false &&
            perspective.visibility === "visible",
        )
        .sort(
          (left, right) =>
            right.quality - left.quality ||
            left.sourceId.localeCompare(right.sourceId),
        )
        .map((perspective) => perspective.sourceId),
      evidenceIds: moment.evidence
        .filter(
          (evidence) =>
            evidence.permitted !== false && evidence.sensitivity !== "blocked",
        )
        .map((evidence) => evidence.id),
    }));
}

function fixtureEvidence(session: UnseenSession, evidenceId: string): EvidenceReference | null {
  const evidence = session.evidence.find((candidate) => candidate.id === evidenceId);
  if (!evidence) return null;
  const participant = evidence.participantId
    ? session.participants.find((candidate) => candidate.id === evidence.participantId)
    : undefined;
  const usesVoice =
    evidence.type === "voice_transcript" || evidence.type === "audio_reaction";
  const hasBaseConsent = (member: (typeof session.participants)[number]) =>
    member.consent.gameplayRecording === "granted" &&
    member.consent.aiAnalysis === "granted" &&
    member.consent.squadSharing === "granted";
  const relevantParticipants = participant ? [participant] : session.participants;
  const permitted = relevantParticipants.every(
    (member) =>
      hasBaseConsent(member) &&
      (!usesVoice || member.consent.voiceChat === "granted"),
  );

  const roundMatch = evidence.id.match(/(?:^|-)r(\d+)(?:-|$)/i);
  return {
    id: evidence.id,
    type:
      evidence.type === "voice_transcript"
        ? "transcript"
        : evidence.type === "audio_reaction"
          ? "audio"
          : evidence.type === "hud_signal"
            ? "hud"
            : evidence.type === "cross_perspective"
              ? "cross_perspective"
              : "visual",
    sourceId: evidence.sourceId,
    startMs: evidence.timestampMs,
    endMs: evidence.endMs ?? evidence.timestampMs + 1_000,
    text: evidence.quote
      ? `${evidence.label}: ${evidence.detail} Quote: ${evidence.quote}`
      : `${evidence.label}: ${evidence.detail}`,
    actorIds: evidence.participantId ? [evidence.participantId] : [],
    round: roundMatch ? Number.parseInt(roundMatch[1], 10) : undefined,
    confidence: evidence.confidence,
    permitted,
    sensitivity: "none",
  };
}

/**
 * Adapts the bundled demo session into the same contracts expected from real
 * OCR/ASR/vision workers. It keeps fixture behavior explicit and replaceable.
 */
export function createPipelineInputFromDemoSession(
  session: UnseenSession,
): UnseenPipelineInput {
  const hasBaseConsent = (participantId: string) => {
    const participant = session.participants.find(
      (candidate) => candidate.id === participantId,
    );
    return (
      participant?.consent.gameplayRecording === "granted" &&
      participant.consent.aiAnalysis === "granted" &&
      participant.consent.squadSharing === "granted"
    );
  };
  const permittedSources = session.sources.filter((source) =>
    hasBaseConsent(source.participantId),
  );
  const tracks: AlignmentTrackInput[] = permittedSources.map((source) => ({
    sourceId: source.id,
    durationMs: source.durationMs,
    anchors: source.anchors.map((anchor) => ({
      id: anchor.id,
      sourceId: source.id,
      localMs: anchor.sourceTimeMs,
      sharedMs: anchor.masterTimeMs,
      kind:
        anchor.type === "shared_audio"
          ? "audio"
          : anchor.type === "round_timer"
            ? "timer"
            : "visual_event",
      confidence: anchor.confidence,
    })),
  }));

  const sourceByParticipant = new Map(
    permittedSources.map((source) => [source.participantId, source]),
  );
  const candidates: MomentCandidate[] = session.moments.map((moment) => {
    const evidence = moment.evidenceIds
      .map((evidenceId) => fixtureEvidence(session, evidenceId))
      .filter(
        (item): item is EvidenceReference =>
          item !== null && item.permitted !== false && item.sensitivity !== "blocked",
      );
    const visibleParticipants = new Set(moment.perspectiveOrder);
    const missedBy = new Set(
      session.missedMoments
        .filter((missed) => missed.momentId === moment.id)
        .map((missed) => missed.viewerId),
    );
    return {
      id: moment.id,
      startMs: moment.startMs,
      endMs: moment.endMs,
      title: moment.title,
      summary: moment.summary,
      category: moment.kind,
      actorIds: [...moment.participantIds],
      missedByPlayerIds: [...missedBy],
      signals: {
        gameplayImportance: moment.scores.gameplay,
        crossPerspectiveNovelty: moment.scores.novelty,
        reactionStrength: moment.scores.reaction,
        narrativeValue: moment.scores.teamwork,
        redundancyPenalty: 0,
      },
      perspectives: session.participants.map((participant) => {
        const source = sourceByParticipant.get(participant.id);
        return {
          sourceId: source?.id ?? `src-${participant.id}`,
          playerId: participant.id,
          visibility: visibleParticipants.has(participant.id)
            ? "visible"
            : "not_visible",
          quality: source?.alignmentConfidence ?? 0.5,
          canUseAudio:
            participant.consent.voiceChat === "granted" &&
            Boolean(source?.audio.optedInVoice),
          permitted:
            participant.consent.gameplayRecording === "granted" &&
            participant.consent.aiAnalysis === "granted" &&
            participant.consent.squadSharing === "granted",
        };
      }),
      evidence,
    };
  });

  return {
    sessionId: session.id,
    tracks,
    candidates: filterPermittedMomentCandidates(candidates),
  };
}
