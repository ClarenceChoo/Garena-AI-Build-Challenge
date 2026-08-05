/**
 * Deterministic reasoning primitives for UNSEEN.
 *
 * This module is deliberately runtime-light: it uses no Node APIs and no SDK,
 * so it can run in a Cloudflare Worker/edge route. An OpenAI call is optional;
 * callers must pass the API key from a server-side binding.
 */

import type {
  AskCitation,
  AskDemoResponse,
  SessionEvidence,
  UnseenAiQuestionInput,
} from "./unseen-types";
import { buildSessionConsentScope } from "./unseen-consent";

export type AlignmentAnchorKind =
  | "audio"
  | "timer"
  | "visual_event"
  | "manual";

export interface TimelineAnchor {
  id: string;
  sourceId: string;
  /** Timestamp in the uploaded recording. */
  localMs: number;
  /** Timestamp on the canonical squad clock. */
  sharedMs: number;
  kind: AlignmentAnchorKind;
  confidence?: number;
}

export interface AlignmentTrackInput {
  sourceId: string;
  durationMs: number;
  anchors: TimelineAnchor[];
}

export interface TimelineTransform {
  sourceId: string;
  /** sharedMs = rate * localMs + offsetMs */
  rate: number;
  offsetMs: number;
  driftPpm: number;
  confidence: number;
  confidenceLabel: "high" | "medium" | "low";
  medianResidualMs: number;
  anchorIds: string[];
  rejectedAnchorIds: string[];
}

export interface AlignmentResult {
  referenceSourceId: string;
  transforms: TimelineTransform[];
  overallConfidence: number;
  warnings: string[];
}

export interface AlignmentOptions {
  referenceSourceId?: string;
  /** Maximum clock drift accepted from capture software. Default: 20,000 ppm (2%). */
  maxDriftPpm?: number;
  /** Minimum residual threshold before deterministic outlier removal. */
  minOutlierThresholdMs?: number;
}

interface FittedLine {
  rate: number;
  offsetMs: number;
}

const clamp = (value: number, minimum = 0, maximum = 1): number =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));

const round = (value: number, places = 3): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

function fitWeightedLine(anchors: TimelineAnchor[]): FittedLine {
  if (anchors.length === 0) return { rate: 1, offsetMs: 0 };
  if (anchors.length === 1) {
    return {
      rate: 1,
      offsetMs: anchors[0].sharedMs - anchors[0].localMs,
    };
  }

  const totalWeight = anchors.reduce(
    (sum, anchor) => sum + clamp(anchor.confidence ?? 1, 0.05, 1),
    0,
  );
  const meanLocal =
    anchors.reduce(
      (sum, anchor) =>
        sum + anchor.localMs * clamp(anchor.confidence ?? 1, 0.05, 1),
      0,
    ) / totalWeight;
  const meanShared =
    anchors.reduce(
      (sum, anchor) =>
        sum + anchor.sharedMs * clamp(anchor.confidence ?? 1, 0.05, 1),
      0,
    ) / totalWeight;

  let numerator = 0;
  let denominator = 0;
  for (const anchor of anchors) {
    const weight = clamp(anchor.confidence ?? 1, 0.05, 1);
    const localDelta = anchor.localMs - meanLocal;
    numerator += weight * localDelta * (anchor.sharedMs - meanShared);
    denominator += weight * localDelta * localDelta;
  }

  const rate = denominator > 0 ? numerator / denominator : 1;
  return {
    rate: Number.isFinite(rate) ? rate : 1,
    offsetMs: meanShared - (Number.isFinite(rate) ? rate : 1) * meanLocal,
  };
}

function residualsFor(anchors: TimelineAnchor[], line: FittedLine): number[] {
  return anchors.map((anchor) =>
    Math.abs(line.rate * anchor.localMs + line.offsetMs - anchor.sharedMs),
  );
}

function confidenceLabel(confidence: number): TimelineTransform["confidenceLabel"] {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.55) return "medium";
  return "low";
}

/**
 * Fits a deterministic affine clock transform for every recording.
 *
 * Anchors already refer to the canonical/shared clock. With 2+ anchors the
 * transform corrects drift; with one anchor it estimates offset only. Outlier
 * rejection uses median absolute deviation, so repeated runs are identical.
 */
export function alignRecordingsFromAnchors(
  tracks: AlignmentTrackInput[],
  options: AlignmentOptions = {},
): AlignmentResult {
  if (tracks.length === 0) {
    return {
      referenceSourceId: options.referenceSourceId ?? "",
      transforms: [],
      overallConfidence: 0,
      warnings: ["No recordings were supplied for alignment."],
    };
  }

  const sortedTracks = [...tracks].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId),
  );
  const referenceSourceId =
    options.referenceSourceId &&
    sortedTracks.some((track) => track.sourceId === options.referenceSourceId)
      ? options.referenceSourceId
      : sortedTracks[0].sourceId;
  const maxDriftPpm = Math.max(0, options.maxDriftPpm ?? 20_000);
  const minOutlierThresholdMs = Math.max(
    1,
    options.minOutlierThresholdMs ?? 250,
  );
  const warnings: string[] = [];

  const transforms = sortedTracks.map<TimelineTransform>((track) => {
    const anchors = track.anchors
      .filter(
        (anchor) =>
          anchor.sourceId === track.sourceId &&
          Number.isFinite(anchor.localMs) &&
          Number.isFinite(anchor.sharedMs),
      )
      .sort(
        (left, right) =>
          left.localMs - right.localMs || left.id.localeCompare(right.id),
      );

    if (anchors.length === 0) {
      warnings.push(`${track.sourceId} has no usable alignment anchors.`);
      return {
        sourceId: track.sourceId,
        rate: 1,
        offsetMs: 0,
        driftPpm: 0,
        confidence: track.sourceId === referenceSourceId ? 0.5 : 0.15,
        confidenceLabel: "low",
        medianResidualMs: 0,
        anchorIds: [],
        rejectedAnchorIds: [],
      };
    }

    const initial = fitWeightedLine(anchors);
    const initialResiduals = residualsFor(anchors, initial);
    const residualMedian = median(initialResiduals);
    const mad = median(
      initialResiduals.map((residual) => Math.abs(residual - residualMedian)),
    );
    const threshold = Math.max(
      minOutlierThresholdMs,
      residualMedian + Math.max(3 * mad, minOutlierThresholdMs),
    );
    const accepted = anchors.filter(
      (_anchor, index) => initialResiduals[index] <= threshold,
    );
    const usable = accepted.length > 0 ? accepted : anchors;
    let fitted = fitWeightedLine(usable);

    const rawDriftPpm = (fitted.rate - 1) * 1_000_000;
    if (Math.abs(rawDriftPpm) > maxDriftPpm) {
      warnings.push(
        `${track.sourceId} produced implausible drift; offset-only alignment was used.`,
      );
      const weightedOffset =
        usable.reduce(
          (sum, anchor) =>
            sum +
            (anchor.sharedMs - anchor.localMs) *
              clamp(anchor.confidence ?? 1, 0.05, 1),
          0,
        ) /
        usable.reduce(
          (sum, anchor) => sum + clamp(anchor.confidence ?? 1, 0.05, 1),
          0,
        );
      fitted = { rate: 1, offsetMs: weightedOffset };
    }

    const finalResiduals = residualsFor(usable, fitted);
    const medianResidualMs = median(finalResiduals);
    const meanAnchorConfidence =
      usable.reduce(
        (sum, anchor) => sum + clamp(anchor.confidence ?? 1),
        0,
      ) / usable.length;
    const countFactor = usable.length === 1 ? 0.6 : 1;
    const span =
      usable.length > 1
        ? usable[usable.length - 1].localMs - usable[0].localMs
        : 0;
    const spanFactor =
      usable.length === 1 ? 0.6 : clamp(span / 60_000, 0.75, 1);
    const anchorKindFactor =
      new Set(usable.map((anchor) => anchor.kind)).size > 1 ? 1 : 0.92;
    const residualFactor = 1 / (1 + medianResidualMs / 500);
    const confidence = clamp(
      meanAnchorConfidence *
        countFactor *
        spanFactor *
        anchorKindFactor *
        residualFactor,
    );
    const rejectedAnchorIds = anchors
      .filter((anchor) => !usable.some((acceptedAnchor) => acceptedAnchor.id === anchor.id))
      .map((anchor) => anchor.id);

    if (rejectedAnchorIds.length > 0) {
      warnings.push(
        `${track.sourceId}: rejected ${rejectedAnchorIds.length} inconsistent anchor(s).`,
      );
    }

    return {
      sourceId: track.sourceId,
      rate: round(fitted.rate, 9),
      offsetMs: round(fitted.offsetMs),
      driftPpm: round((fitted.rate - 1) * 1_000_000, 1),
      confidence: round(confidence),
      confidenceLabel: confidenceLabel(confidence),
      medianResidualMs: round(medianResidualMs),
      anchorIds: usable.map((anchor) => anchor.id),
      rejectedAnchorIds,
    };
  });

  const overallConfidence =
    transforms.length > 0
      ? transforms.reduce((sum, transform) => sum + transform.confidence, 0) /
        transforms.length
      : 0;

  return {
    referenceSourceId,
    transforms,
    overallConfidence: round(overallConfidence),
    warnings,
  };
}

export function localToSharedMs(
  localMs: number,
  transform: Pick<TimelineTransform, "rate" | "offsetMs">,
): number {
  return round(transform.rate * localMs + transform.offsetMs);
}

export function sharedToLocalMs(
  sharedMs: number,
  transform: Pick<TimelineTransform, "rate" | "offsetMs">,
): number {
  if (transform.rate === 0) return sharedMs - transform.offsetMs;
  return round((sharedMs - transform.offsetMs) / transform.rate);
}

export interface EvidenceReference {
  id: string;
  type: "visual" | "transcript" | "audio" | "hud" | "cross_perspective";
  sourceId?: string;
  startMs: number;
  endMs: number;
  text: string;
  actorIds?: string[];
  round?: number;
  confidence: number;
  /** False means excluded or consent-revoked. */
  permitted?: boolean;
  sensitivity?: "none" | "review" | "blocked";
}

export interface MomentPerspective {
  sourceId: string;
  playerId: string;
  visibility: "visible" | "audible_only" | "not_visible";
  quality: number;
  canUseAudio?: boolean;
  permitted?: boolean;
}

export interface MomentSignals {
  gameplayImportance: number;
  crossPerspectiveNovelty: number;
  reactionStrength: number;
  narrativeValue: number;
  /** Existing domain penalty, normalised to 0..1. */
  redundancyPenalty?: number;
}

export interface MomentCandidate {
  id: string;
  startMs: number;
  endMs: number;
  title: string;
  summary: string;
  category: string;
  actorIds: string[];
  /** Players for whom another perspective materially changes the story. */
  missedByPlayerIds?: string[];
  signals: MomentSignals;
  perspectives: MomentPerspective[];
  evidence: EvidenceReference[];
  round?: number;
}

export interface MomentScoreBreakdown {
  gameplayImportance: number;
  crossPerspectiveNovelty: number;
  reactionStrength: number;
  narrativeValue: number;
  redundancyPenalty: number;
  total: number;
}

export interface RankedMediaMoment extends MomentCandidate {
  rank: number;
  score: number;
  breakdown: MomentScoreBreakdown;
}

/**
 * Fail-closed privacy gate for derived narrative fields. A title or summary may
 * have been generated from every attached evidence item, so a moment is not
 * safe to expose when any supporting evidence is blocked/withdrawn or when an
 * actor's own perspective is no longer permitted.
 */
export function isMomentPermittedForOutput(
  moment: MomentCandidate,
): boolean {
  if (moment.evidence.length === 0) return false;
  if (
    moment.evidence.some(
      (evidence) =>
        evidence.permitted === false || evidence.sensitivity === "blocked",
    )
  ) {
    return false;
  }
  if (!moment.perspectives.some((perspective) => perspective.permitted !== false)) {
    return false;
  }
  return !moment.perspectives.some(
    (perspective) =>
      perspective.permitted === false &&
      moment.actorIds.includes(perspective.playerId),
  );
}

/** Removes unsafe moments and strips non-actor perspectives without mutating inputs. */
export function filterPermittedMomentCandidates<T extends MomentCandidate>(
  candidates: T[],
): T[] {
  return candidates
    .filter(isMomentPermittedForOutput)
    .map((candidate) => ({
      ...candidate,
      missedByPlayerIds: candidate.missedByPlayerIds?.filter((playerId) =>
        candidate.perspectives.some(
          (perspective) =>
            perspective.playerId === playerId && perspective.permitted !== false,
        ),
      ),
      perspectives: candidate.perspectives.filter(
        (perspective) => perspective.permitted !== false,
      ),
      evidence: candidate.evidence.filter(
        (evidence) =>
          evidence.permitted !== false && evidence.sensitivity !== "blocked",
      ),
    }));
}

export const MOMENT_SCORE_WEIGHTS = Object.freeze({
  gameplayImportance: 0.3,
  crossPerspectiveNovelty: 0.25,
  reactionStrength: 0.2,
  narrativeValue: 0.25,
  redundancyPenalty: 0.25,
});

/** Scores a moment on 0..100 with an explicit, inspectable breakdown. */
export function scoreMoment(
  signals: MomentSignals,
  dynamicRedundancyPenalty = 0,
): MomentScoreBreakdown {
  const gameplayImportance =
    100 *
    MOMENT_SCORE_WEIGHTS.gameplayImportance *
    clamp(signals.gameplayImportance);
  const crossPerspectiveNovelty =
    100 *
    MOMENT_SCORE_WEIGHTS.crossPerspectiveNovelty *
    clamp(signals.crossPerspectiveNovelty);
  const reactionStrength =
    100 *
    MOMENT_SCORE_WEIGHTS.reactionStrength *
    clamp(signals.reactionStrength);
  const narrativeValue =
    100 *
    MOMENT_SCORE_WEIGHTS.narrativeValue *
    clamp(signals.narrativeValue);
  const redundancyPenalty =
    100 *
    MOMENT_SCORE_WEIGHTS.redundancyPenalty *
    clamp(Math.max(signals.redundancyPenalty ?? 0, dynamicRedundancyPenalty));
  const total = clamp(
    gameplayImportance +
      crossPerspectiveNovelty +
      reactionStrength +
      narrativeValue -
      redundancyPenalty,
    0,
    100,
  );

  return {
    gameplayImportance: round(gameplayImportance),
    crossPerspectiveNovelty: round(crossPerspectiveNovelty),
    reactionStrength: round(reactionStrength),
    narrativeValue: round(narrativeValue),
    redundancyPenalty: round(redundancyPenalty),
    total: round(total),
  };
}

function tokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 2),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function overlapRatio(left: MomentCandidate, right: MomentCandidate): number {
  const overlap = Math.max(
    0,
    Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs),
  );
  const shorterDuration = Math.max(
    1,
    Math.min(left.endMs - left.startMs, right.endMs - right.startMs),
  );
  return clamp(overlap / shorterDuration);
}

export function calculateRedundancyPenalty(
  candidate: MomentCandidate,
  selected: MomentCandidate[],
): number {
  if (selected.length === 0) return 0;
  const candidateTokens = tokenSet(
    `${candidate.title} ${candidate.summary} ${candidate.category}`,
  );
  return selected.reduce((maximum, prior) => {
    const semantic = jaccard(
      candidateTokens,
      tokenSet(`${prior.title} ${prior.summary} ${prior.category}`),
    );
    const temporal = overlapRatio(candidate, prior);
    const sameActors = jaccard(
      new Set(candidate.actorIds),
      new Set(prior.actorIds),
    );
    return Math.max(maximum, 0.5 * temporal + 0.35 * semantic + 0.15 * sameActors);
  }, 0);
}

/** Greedy diversity-aware ranking with deterministic ID tie-breaking. */
export function rankMomentCandidates(
  candidates: MomentCandidate[],
  limit = candidates.length,
): RankedMediaMoment[] {
  const remaining = filterPermittedMomentCandidates(candidates);
  const selected: RankedMediaMoment[] = [];

  while (remaining.length > 0 && selected.length < Math.max(0, limit)) {
    const rescored = remaining
      .map((candidate) => {
        const dynamicPenalty = calculateRedundancyPenalty(candidate, selected);
        const breakdown = scoreMoment(candidate.signals, dynamicPenalty);
        return { candidate, breakdown };
      })
      .sort(
        (left, right) =>
          right.breakdown.total - left.breakdown.total ||
          left.candidate.startMs - right.candidate.startMs ||
          left.candidate.id.localeCompare(right.candidate.id),
      );
    const winner = rescored[0];
    selected.push({
      ...winner.candidate,
      rank: selected.length + 1,
      score: winner.breakdown.total,
      breakdown: winner.breakdown,
    });
    remaining.splice(remaining.indexOf(winner.candidate), 1);
  }

  return selected;
}

export type StoryRole = "cold_open" | "setup" | "reveal" | "payoff" | "reaction";
export type AudioPolicy = "source" | "balanced" | "duck_game" | "mute";
export type EditTransition = "hard_cut" | "audio_lead" | "match_cut" | "dissolve";

export interface EditPlanClip {
  id: string;
  sequence: number;
  momentId: string;
  storyRole: StoryRole;
  sourceId: string;
  playerId: string;
  sharedStartMs: number;
  sharedEndMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
  caption: string;
  audioPolicy: AudioPolicy;
  transition: EditTransition;
  evidenceIds: string[];
  rationale: string;
}

export interface EditPlan {
  version: "unseen-edit-plan-v1";
  targetDurationMs: number;
  estimatedDurationMs: number;
  clips: EditPlanClip[];
  selectedMomentIds: string[];
  omittedMomentIds: string[];
  warnings: string[];
}

export interface EditPlanOptions {
  targetDurationMs?: number;
  minClipMs?: number;
  maxClipMs?: number;
  /** Context included before and after a detected incident. Default: 6 seconds. */
  contextPaddingMs?: number;
  maxMoments?: number;
  targetPlayerId?: string;
  transforms?: TimelineTransform[];
}

function choosePerspectives(
  moment: RankedMediaMoment,
  targetPlayerId?: string,
): MomentPerspective[] {
  const permitted = moment.perspectives.filter(
    (perspective) => perspective.permitted !== false,
  );
  return permitted.sort((left, right) => {
    const leftReveal =
      targetPlayerId && left.playerId !== targetPlayerId && left.visibility === "visible"
        ? 1
        : 0;
    const rightReveal =
      targetPlayerId &&
      right.playerId !== targetPlayerId &&
      right.visibility === "visible"
        ? 1
        : 0;
    return (
      rightReveal - leftReveal ||
      right.quality - left.quality ||
      left.sourceId.localeCompare(right.sourceId)
    );
  });
}

/**
 * Produces an evidence-preserving edit decision list. It does not render video.
 * The renderer can later translate sourceStart/sourceEnd into FFmpeg trims.
 */
export function generateEditPlan(
  moments: RankedMediaMoment[],
  options: EditPlanOptions = {},
): EditPlan {
  const targetDurationMs = Math.max(5_000, options.targetDurationMs ?? 75_000);
  const minClipMs = Math.max(1_000, options.minClipMs ?? 3_000);
  const maxClipMs = Math.max(minClipMs, options.maxClipMs ?? 24_000);
  const contextPaddingMs = Math.max(0, options.contextPaddingMs ?? 6_000);
  const maxMoments = Math.max(1, options.maxMoments ?? 5);
  const transforms = new Map(
    (options.transforms ?? []).map((transform) => [transform.sourceId, transform]),
  );
  const warnings: string[] = [];
  const safeMoments = filterPermittedMomentCandidates(moments);
  const byScore = [...safeMoments].sort(
    (left, right) =>
      right.score - left.score ||
      left.startMs - right.startMs ||
      left.id.localeCompare(right.id),
  );

  const chosen: RankedMediaMoment[] = [];
  let reservedMs = 0;
  for (const moment of byScore) {
    if (chosen.length >= maxMoments) break;
    const desired = clamp(
      moment.endMs - moment.startMs + contextPaddingMs * 2,
      minClipMs,
      maxClipMs,
    );
    if (chosen.length > 0 && reservedMs + desired > targetDurationMs) continue;
    chosen.push(moment);
    reservedMs += desired;
  }
  if (chosen.length === 0 && byScore.length > 0) chosen.push(byScore[0]);

  const chronological = [...chosen].sort(
    (left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id),
  );
  // Tease the strongest outcome first, then rewind into chronological context.
  const opener = [...chosen].sort(
    (left, right) => right.score - left.score || left.id.localeCompare(right.id),
  )[0];
  const narrativeOrder = opener
    ? [opener, ...chronological.filter((moment) => moment.id !== opener.id)]
    : chronological;
  const clips: EditPlanClip[] = [];

  for (const [momentIndex, moment] of narrativeOrder.entries()) {
    const perspectives = choosePerspectives(moment, options.targetPlayerId).slice(0, 2);
    if (perspectives.length === 0) {
      warnings.push(`${moment.id} was omitted because it has no permitted perspective.`);
      continue;
    }

    const paddedStartMs = Math.max(0, moment.startMs - contextPaddingMs);
    const momentDuration = clamp(
      moment.endMs - moment.startMs + contextPaddingMs * 2,
      minClipMs,
      maxClipMs,
    );
    const clipCount =
      perspectives.length > 1 && momentDuration >= minClipMs * 2 ? 2 : 1;
    for (let index = 0; index < clipCount; index += 1) {
      const perspective = perspectives[index];
      const sharedStartMs = round(
        paddedStartMs + (momentDuration * index) / clipCount,
      );
      const sharedEndMs = round(
        paddedStartMs + (momentDuration * (index + 1)) / clipCount,
      );
      const transform = transforms.get(perspective.sourceId);
      const sourceStartMs = transform
        ? sharedToLocalMs(sharedStartMs, transform)
        : sharedStartMs;
      const sourceEndMs = transform
        ? sharedToLocalMs(sharedEndMs, transform)
        : sharedEndMs;
      const isFirst = clips.length === 0;
      const isLastMoment = momentIndex === narrativeOrder.length - 1;
      const storyRole: StoryRole = isFirst
        ? "cold_open"
        : index === 0
          ? "setup"
          : isLastMoment
            ? "reaction"
            : "reveal";

      clips.push({
        id: `clip-${String(clips.length + 1).padStart(2, "0")}-${moment.id}`,
        sequence: clips.length + 1,
        momentId: moment.id,
        storyRole,
        sourceId: perspective.sourceId,
        playerId: perspective.playerId,
        sharedStartMs,
        sharedEndMs,
        sourceStartMs: Math.max(0, sourceStartMs),
        sourceEndMs: Math.max(0, sourceEndMs),
        caption: index === 0 ? moment.title : moment.summary,
        audioPolicy:
          perspective.canUseAudio === false
            ? "mute"
            : index === 1
              ? "duck_game"
              : "balanced",
        transition: isFirst
          ? "hard_cut"
          : index === 1
            ? "audio_lead"
            : "match_cut",
        evidenceIds: moment.evidence
          .filter(
            (evidence) =>
              evidence.permitted !== false && evidence.sensitivity !== "blocked",
          )
          .map((evidence) => evidence.id),
        rationale:
          index === 0
            ? `Establish ${moment.category} from the clearest available view.`
            : "Switch perspective only where it adds information the first view missed.",
      });
    }
  }

  const estimatedDurationMs = clips.reduce(
    (sum, clip) => sum + Math.max(0, clip.sharedEndMs - clip.sharedStartMs),
    0,
  );
  const selectedMomentIds = [...new Set(clips.map((clip) => clip.momentId))];

  return {
    version: "unseen-edit-plan-v1",
    targetDurationMs,
    estimatedDurationMs: round(estimatedDurationMs),
    clips,
    selectedMomentIds,
    omittedMomentIds: safeMoments
      .filter((moment) => !selectedMomentIds.includes(moment.id))
      .map((moment) => moment.id),
    warnings,
  };
}

export interface RetrievedEvidence extends EvidenceReference {
  relevance: number;
}

export interface GroundedQuestionInput {
  question: string;
  evidence: EvidenceReference[];
  participantNames?: Record<string, string>;
  maxEvidence?: number;
  minimumConfidence?: number;
  safetyIdentifier?: string;
  openAI?: OpenAIResponsesConfig;
}

export interface GroundedAnswer {
  question: string;
  answer: string;
  status: "answered" | "abstained";
  confidence: number;
  grounding: "deterministic_evidence" | "openai_with_session_evidence";
  answerType: "observation" | "inference" | "insufficient_evidence";
  evidence: RetrievedEvidence[];
  caveat: string;
  provider: {
    attempted: boolean;
    model: string;
    responseId: string;
    fallbackReason: string;
  };
}

export interface OpenAIResponsesConfig {
  /** Pass only from a server-side secret/binding; never expose this to the browser. */
  apiKey?: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "during",
  "everyone",
  "from",
  "have",
  "that",
  "their",
  "them",
  "then",
  "there",
  "they",
  "this",
  "what",
  "were",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
]);

function queryTokens(value: string): string[] {
  return [...tokenSet(value)]
    .filter((token) => !STOP_WORDS.has(token))
    .map((token) => {
      if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
      if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
      return token;
    });
}

const ROUND_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
};

function requestedRoundFromQuestion(question: string): number | undefined {
  const match = question
    .toLocaleLowerCase()
    .match(/\bround\s+([a-z]+|\d{1,3})\b/);
  if (!match) return undefined;
  if (/^\d+$/.test(match[1])) return Number.parseInt(match[1], 10);
  return ROUND_WORDS[match[1]];
}

/** Consent-aware lexical retrieval. Blocked or unpermitted evidence never enters context. */
export function retrieveGroundingEvidence(
  question: string,
  evidence: EvidenceReference[],
  maxEvidence = 5,
): RetrievedEvidence[] {
  const lowerQuestion = question.toLocaleLowerCase();
  const tokens = queryTokens(question);
  const requestedRound = requestedRoundFromQuestion(lowerQuestion);

  return evidence
    .filter(
      (item) =>
        item.permitted !== false &&
        item.sensitivity !== "blocked" &&
        item.text.trim().length > 0,
    )
    .map((item) => {
      const haystack = `${item.text} ${(item.actorIds ?? []).join(" ")} ${item.type} ${item.round ? `round ${item.round}` : ""}`.toLocaleLowerCase();
      const termMatches = tokens.filter((token) => haystack.includes(token)).length;
      const termScore = tokens.length > 0 ? termMatches / tokens.length : 0;
      const roundScore =
        requestedRound === undefined ? 0 : item.round === requestedRound ? 0.55 : -0.3;
      const exactPhrase =
        lowerQuestion.length > 5 && haystack.includes(lowerQuestion) ? 0.25 : 0;
      const relevance = clamp(
        0.72 * termScore + roundScore + exactPhrase + 0.08 * clamp(item.confidence),
      );
      return { ...item, relevance: round(relevance) };
    })
    .filter((item) => item.relevance > 0.04)
    .sort(
      (left, right) =>
        right.relevance - left.relevance ||
        right.confidence - left.confidence ||
        left.startMs - right.startMs ||
        left.id.localeCompare(right.id),
    )
    .slice(0, Math.max(1, maxEvidence));
}

function uniqueEvidenceSentences(evidence: RetrievedEvidence[]): string[] {
  const seen = new Set<string>();
  const sentences: string[] = [];
  for (const item of evidence) {
    const cleaned = item.text.trim().replace(/\s+/g, " ");
    const key = cleaned.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      sentences.push(cleaned.replace(/[.?!]+$/, ""));
    }
  }
  return sentences;
}

/** Always-available, deterministic answer path. */
export function answerGroundedQuestionDeterministically(
  input: Omit<GroundedQuestionInput, "openAI">,
): GroundedAnswer {
  const minimumConfidence = clamp(input.minimumConfidence ?? 0.42);
  const evidence = retrieveGroundingEvidence(
    input.question,
    input.evidence,
    input.maxEvidence ?? 5,
  );
  const strongEvidence = evidence.filter(
    (item) => item.confidence >= minimumConfidence && item.relevance >= 0.08,
  );
  const model = "deterministic";

  if (strongEvidence.length === 0) {
    return {
      question: input.question,
      answer:
        "I couldn’t find enough permitted session evidence to answer that reliably.",
      status: "abstained",
      confidence: 0,
      grounding: "deterministic_evidence",
      answerType: "insufficient_evidence",
      evidence: [],
      caveat: "No factual answer was generated without supporting evidence.",
      provider: {
        attempted: false,
        model,
        responseId: "",
        fallbackReason: "",
      },
    };
  }

  const selected = strongEvidence.slice(0, 3);
  const sentences = uniqueEvidenceSentences(selected);
  const confidence =
    selected.reduce(
      (sum, item) => sum + item.confidence * item.relevance,
      0,
    ) / selected.reduce((sum, item) => sum + item.relevance, 0);
  const asksWhy = /\bwhy\b/i.test(input.question);

  return {
    question: input.question,
    answer: `The recordings show: ${sentences.join("; ")}.`,
    status: "answered",
    confidence: round(clamp(confidence)),
    grounding: "deterministic_evidence",
    answerType: asksWhy ? "inference" : "observation",
    evidence: selected,
    caveat: asksWhy
      ? "This explains the sequence supported by the recordings; it does not infer anyone’s intent."
      : "This answer is limited to the cited session evidence.",
    provider: {
      attempted: false,
      model,
      responseId: "",
      fallbackReason: "",
    },
  };
}

interface OpenAIGroundedPayload {
  answer: string;
  confidence: number;
  answerType: "observation" | "inference" | "insufficient_evidence";
  evidenceIds: string[];
  caveat: string;
}

export const GROUNDED_ANSWER_JSON_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    answer: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    answerType: {
      type: "string",
      enum: ["observation", "inference", "insufficient_evidence"],
    },
    evidenceIds: { type: "array", items: { type: "string" } },
    caveat: { type: "string" },
  },
  required: ["answer", "confidence", "answerType", "evidenceIds", "caveat"],
  additionalProperties: false,
});

interface ResponsesApiShape {
  id?: unknown;
  output_text?: unknown;
  output?: unknown;
  error?: { message?: unknown };
}

function extractResponseText(response: ResponsesApiShape): string | null {
  if (typeof response.output_text === "string") return response.output_text;
  if (!Array.isArray(response.output)) return null;
  for (const item of response.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const record = part as { type?: unknown; text?: unknown; refusal?: unknown };
      if (record.type === "refusal" || typeof record.refusal === "string") return null;
      if (record.type === "output_text" && typeof record.text === "string") {
        return record.text;
      }
    }
  }
  return null;
}

function isOpenAIGroundedPayload(value: unknown): value is OpenAIGroundedPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "answer",
    "confidence",
    "answerType",
    "evidenceIds",
    "caveat",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return false;
  return (
    typeof record.answer === "string" &&
    typeof record.confidence === "number" &&
    Number.isFinite(record.confidence) &&
    ["observation", "inference", "insufficient_evidence"].includes(
      String(record.answerType),
    ) &&
    Array.isArray(record.evidenceIds) &&
    record.evidenceIds.every((item) => typeof item === "string") &&
    typeof record.caveat === "string"
  );
}

async function askOpenAIWithEvidence(
  question: string,
  evidence: RetrievedEvidence[],
  config: OpenAIResponsesConfig,
  safetyIdentifier?: string,
): Promise<{
  payload: OpenAIGroundedPayload;
  responseId: string;
  model: string;
} | null> {
  if (!config.apiKey) return null;
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return null;
  const model = config.model ?? "gpt-5.6";
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1_000, config.timeoutMs ?? 12_000),
  );

  try {
    const evidencePacket = evidence.map((item) => ({
      id: item.id,
      type: item.type,
      startMs: item.startMs,
      endMs: item.endMs,
      actorIds: item.actorIds ?? [],
      round: item.round ?? null,
      text: item.text,
      confidence: item.confidence,
    }));
    const response = await fetchImpl(
      config.endpoint ?? "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          store: false,
          ...(safetyIdentifier
            ? { safety_identifier: safetyIdentifier }
            : {}),
          max_output_tokens: 700,
          instructions:
            "Answer only from the supplied session evidence. Cite every factual claim using evidenceIds. Separate observed facts from inference. Never infer player intent, identity, or emotion. If evidence is insufficient or contradictory, set answerType to insufficient_evidence and abstain.",
          input: JSON.stringify({ question, evidence: evidencePacket }),
          text: {
            format: {
              type: "json_schema",
              name: "unseen_grounded_answer",
              strict: true,
              schema: GROUNDED_ANSWER_JSON_SCHEMA,
            },
          },
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) return null;
    const apiResponse = (await response.json()) as ResponsesApiShape;
    const text = extractResponseText(apiResponse);
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    if (!isOpenAIGroundedPayload(parsed)) return null;

    const allowedIds = new Set(evidence.map((item) => item.id));
    if (parsed.evidenceIds.some((id) => !allowedIds.has(id))) return null;
    if (
      parsed.answerType !== "insufficient_evidence" &&
      parsed.evidenceIds.length === 0
    ) {
      return null;
    }

    return {
      payload: parsed,
      responseId: typeof apiResponse.id === "string" ? apiResponse.id : "",
      model,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Uses the Responses API when explicitly configured, then safely falls back to
 * the deterministic answer if the key is absent, the request fails, the model
 * refuses, or validation/grounding fails.
 */
export async function answerGroundedQuestion(
  input: GroundedQuestionInput,
): Promise<GroundedAnswer> {
  const fallback = answerGroundedQuestionDeterministically(input);
  if (!input.openAI?.apiKey) return fallback;

  const retrieved = retrieveGroundingEvidence(
    input.question,
    input.evidence,
    input.maxEvidence ?? 5,
  );
  if (retrieved.length === 0) return fallback;
  const aiResult = await askOpenAIWithEvidence(
    input.question,
    retrieved,
    input.openAI,
    input.safetyIdentifier,
  );
  if (!aiResult) {
    return {
      ...fallback,
      provider: {
        attempted: true,
        model: input.openAI.model ?? "gpt-5.6",
        responseId: "",
        fallbackReason: "OpenAI response was unavailable or failed grounding validation.",
      },
    };
  }

  const cited = new Set(aiResult.payload.evidenceIds);
  const selectedEvidence = retrieved.filter((item) => cited.has(item.id));
  const abstained = aiResult.payload.answerType === "insufficient_evidence";
  return {
    question: input.question,
    answer: abstained
      ? "I couldn’t find enough permitted session evidence to answer that reliably."
      : aiResult.payload.answer,
    status: abstained ? "abstained" : "answered",
    confidence: abstained ? 0 : round(clamp(aiResult.payload.confidence)),
    grounding: "openai_with_session_evidence",
    answerType: aiResult.payload.answerType,
    evidence: abstained ? [] : selectedEvidence,
    caveat: aiResult.payload.caveat,
    provider: {
      attempted: true,
      model: aiResult.model,
      responseId: aiResult.responseId,
      fallbackReason: "",
    },
  };
}

function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function fixtureEvidenceToReference(evidence: SessionEvidence): EvidenceReference {
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
    permitted: true,
    sensitivity: "none",
  };
}

function deterministicFollowUps(input: UnseenAiQuestionInput): string[] {
  return input.session.suggestedQuestions
    .filter(
      (suggestion) =>
        suggestion.toLocaleLowerCase() !== input.question.toLocaleLowerCase(),
    )
    .slice(0, 2);
}

function groundedToDemoResponse(
  input: UnseenAiQuestionInput,
  grounded: GroundedAnswer,
  disclosure: {
    permittedEvidenceIds: Set<string>;
    permittedParticipantIds: Set<string>;
    allSessionEvidencePermitted: boolean;
  },
): AskDemoResponse | null {
  if (grounded.status === "abstained") return null;
  const evidenceById = new Map(
    input.session.evidence
      .filter((evidence) => disclosure.permittedEvidenceIds.has(evidence.id))
      .map((evidence) => [evidence.id, evidence]),
  );
  const citations: AskCitation[] = grounded.evidence
    .map((retrieved) => evidenceById.get(retrieved.id))
    .filter((evidence): evidence is SessionEvidence => Boolean(evidence))
    .map((evidence) => ({
      evidenceId: evidence.id,
      timestampMs: evidence.timestampMs,
      timestampLabel: formatTimestamp(evidence.timestampMs),
      label: evidence.label,
      participantId: evidence.participantId,
      sourceId: evidence.sourceId,
    }));
  const citedIds = new Set(citations.map((citation) => citation.evidenceId));
  const relatedMomentIds = input.session.moments
    .filter(
      (moment) =>
        moment.evidenceIds.length > 0 &&
        moment.evidenceIds.every((id) =>
          disclosure.permittedEvidenceIds.has(id),
        ) &&
        moment.participantIds.every((id) =>
          disclosure.permittedParticipantIds.has(id),
        ) &&
        moment.evidenceIds.some((id) => citedIds.has(id)),
    )
    .map((moment) => moment.id);

  return {
    sessionId: input.session.id,
    question: input.question,
    answer: grounded.answer,
    confidence: grounded.confidence,
    grounding:
      grounded.grounding === "openai_with_session_evidence"
        ? "ai_with_session_evidence"
        : "session_evidence",
    citations,
    relatedMomentIds,
    followUps: disclosure.allSessionEvidencePermitted
      ? deterministicFollowUps(input)
      : [],
  };
}

function consentSafeAbstention(input: UnseenAiQuestionInput): AskDemoResponse {
  return {
    sessionId: input.session.id,
    question: input.question,
    answer:
      "I can’t answer that because the required session evidence is unavailable or consent-restricted.",
    confidence: 0,
    grounding: "session_evidence",
    citations: [],
    relatedMomentIds: [],
    followUps: [],
  };
}

/**
 * Backend adapter for the challenge demo route.
 *
 * `OPENAI_API_KEY` is intentionally not read here. The backend may pass it in
 * a future extended input/config path; this fixture contract remains safe and
 * returns a grounded deterministic answer or `null` so the route can use its
 * own known-good fallback.
 */
export async function answerUnseenQuestion(
  input: UnseenAiQuestionInput,
  openAI?: OpenAIResponsesConfig,
): Promise<AskDemoResponse | null> {
  const {
    participantBaseConsent,
    permittedEvidenceIds,
    allSessionEvidencePermitted,
  } = buildSessionConsentScope(input.session);
  if (participantBaseConsent.get(input.viewerId) !== true) {
    return consentSafeAbstention(input);
  }
  const references = input.session.evidence.map((evidence) => {
    const reference = fixtureEvidenceToReference(evidence);
    if (!permittedEvidenceIds.has(evidence.id)) {
      reference.permitted = false;
    }
    return reference;
  });
  const grounded = await answerGroundedQuestion({
    question: input.question,
    evidence: references,
    maxEvidence: 5,
    safetyIdentifier: `unseen_${input.viewerId}`,
    openAI,
  });
  const disclosure = {
    permittedEvidenceIds,
    permittedParticipantIds: new Set(
      [...participantBaseConsent.entries()]
        .filter(([, permitted]) => permitted)
        .map(([participantId]) => participantId),
    ),
    allSessionEvidencePermitted,
  };
  const response = groundedToDemoResponse(input, grounded, disclosure);
  if (response) return response;
  return disclosure.allSessionEvidencePermitted
    ? null
    : consentSafeAbstention(input);
}
