import type { SampledFrame } from "./real-analysis-types";

export const GAMEPLAY_SEARCH_LIMITS = Object.freeze({
  maximumClips: 4,
  maximumTotalDurationMs: 60 * 60_000,
  maximumTotalFileBytes: 2 * 1024 * 1024 * 1024,
  segmentDurationMs: 2 * 60_000,
  scanIntervalMs: 2_000,
  contextIntervalMs: 10_000,
  maximumFramesPerSegment: 24,
  maximumEventsPerSegment: 12,
  maximumIndexedEvents: 360,
  maximumSearchHits: 5,
  maximumAudioChunkBytes: 25 * 1024 * 1024,
  audioChunkDurationMs: 10 * 60_000,
});

export type GameplayEventType =
  | "elimination"
  | "assist"
  | "death"
  | "objective"
  | "clutch"
  | "mistake"
  | "reaction"
  | "dialogue"
  | "transition"
  | "other";

export type GameplayAudioDeclaration =
  | "game_only"
  | "voices_consented"
  | "voices_unconsented";

export interface GameplayEvidenceFrame extends SampledFrame {
  detail: "low" | "high";
  reason: "context" | "visual_change" | "hud_change" | "audio_peak";
}

export interface GameplayAudioFeature {
  timestampMs: number;
  rms: number;
  peak: number;
}

export interface GameplayTranscriptSegment {
  id: string;
  clipId: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface GameplayClipMetadata {
  id: string;
  name: string;
  label: string;
  durationMs: number;
  sizeBytes: number;
}

export interface IndexGameplaySegmentRequest {
  clip: GameplayClipMetadata;
  segment: {
    id: string;
    startMs: number;
    endMs: number;
  };
  frames: GameplayEvidenceFrame[];
  audioFeatures: GameplayAudioFeature[];
  transcriptSegments: GameplayTranscriptSegment[];
  priorContext: {
    gameTitle: string;
    gameMode: string;
  } | null;
}

export interface GameplayEvent {
  id: string;
  clipId: string;
  segmentId: string;
  startMs: number;
  endMs: number;
  type: GameplayEventType;
  title: string;
  description: string;
  actors: string[];
  target: string | null;
  ocrText: string;
  importance: number;
  confidence: number;
  evidenceFrameIds: string[];
  transcriptSegmentIds: string[];
}

export interface GameplaySegmentIndex {
  clipId: string;
  segmentId: string;
  segmentStartMs: number;
  segmentEndMs: number;
  gameTitle: string;
  gameMode: string;
  contextSummary: string;
  evidenceFrameIds: string[];
  transcriptSegmentIds: string[];
  events: GameplayEvent[];
  api: {
    real: true;
    responseId: string;
    requestId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  };
}

export interface SearchGameplayRequest {
  query: string;
  clips: GameplayClipMetadata[];
  segments: GameplaySegmentIndex[];
}

export interface GameplaySearchHit {
  eventId: string;
  clipId: string;
  startMs: number;
  endMs: number;
  title: string;
  whyMatch: string;
  confidence: number;
  evidenceFrameIds: string[];
  transcriptSegmentIds: string[];
}

export interface GameplaySearchResponse {
  query: string;
  answerType: "matches" | "insufficient_evidence";
  summary: string;
  hits: GameplaySearchHit[];
  api: {
    real: true;
    responseId: string;
    requestId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  };
}

export type HighlightAspectRatio = "16:9" | "9:16";
export type HighlightDurationMs = 30_000 | 60_000 | 90_000;

export interface PlanHighlightsRequest {
  prompt: string;
  targetDurationMs: HighlightDurationMs;
  aspectRatio: HighlightAspectRatio;
  clips: GameplayClipMetadata[];
  segments: GameplaySegmentIndex[];
  selectedEventIds: string[];
}

export interface HighlightBeat {
  order: number;
  eventId: string;
  clipId: string;
  startMs: number;
  endMs: number;
  caption: string;
}

export interface HighlightPlan {
  id: string;
  title: string;
  targetDurationMs: HighlightDurationMs;
  estimatedDurationMs: number;
  aspectRatio: HighlightAspectRatio;
  beats: HighlightBeat[];
  api: {
    real: true;
    responseId: string;
    requestId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  };
}

export interface TranscribeGameplayAudioResponse {
  clipId: string;
  chunkStartMs: number;
  segments: GameplayTranscriptSegment[];
  api: {
    real: true;
    requestId: string;
    model: string;
  };
}

export type GameplaySearchApiErrorCode =
  | "AI_NOT_CONFIGURED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INVALID_JSON"
  | "INVALID_REQUEST"
  | "OPENAI_ERROR"
  | "OPENAI_INVALID_OUTPUT";
