export const REAL_ANALYSIS_LIMITS = Object.freeze({
  minimumClips: 2,
  maximumClips: 4,
  maximumDurationMs: 45_000,
  maximumFileBytes: 120 * 1024 * 1024,
  framesPerClip: 8,
  maximumFrameDataUrlLength: 900_000,
  maximumAudioBase64Length: 2_400_000,
});

export interface SampledFrame {
  id: string;
  timestampMs: number;
  imageDataUrl: string;
  width: number;
  height: number;
}

export interface SampledAudio {
  mimeType: "audio/wav";
  dataBase64: string;
}

export interface AnalyzeClipRequest {
  clip: {
    id: string;
    name: string;
    playerLabel: string;
    durationMs: number;
  };
  frames: SampledFrame[];
  audio: SampledAudio | null;
  voiceConsent: boolean;
}

export type ObservationCategory =
  | "gameplay"
  | "hud"
  | "teamwork"
  | "mistake"
  | "reaction"
  | "dialogue"
  | "transition";

export interface RealClipObservation {
  id: string;
  timestampMs: number;
  endMs: number;
  category: ObservationCategory;
  description: string;
  importance: number;
  confidence: number;
  evidenceFrameIds: string[];
  transcriptQuote: string | null;
}

export interface RealClipAnalysis {
  clipId: string;
  clipName: string;
  playerLabel: string;
  durationMs: number;
  gameTitle: string;
  perspectiveSummary: string;
  transcript: string;
  audioStatus: "transcribed" | "not_supplied";
  observations: RealClipObservation[];
  api: {
    real: true;
    visionResponseId: string;
    visionRequestId: string;
    visionModel: string;
    transcriptionRequestId: string;
    transcriptionModel: string | null;
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ClipAlignment {
  clipId: string;
  offsetMs: number;
  confidence: number;
  basis: string[];
}

export interface LinkedSourceEvidence {
  clipId: string;
  observationId: string;
  timestampMs: number;
  role: "setup" | "action" | "reaction" | "context";
}

export interface LinkedSquadMoment {
  id: string;
  title: string;
  summary: string;
  sharedTimeMs: number;
  importance: number;
  emotion: string;
  whyLinked: string;
  sourceLinks: LinkedSourceEvidence[];
}

export interface DirectorCutBeat {
  order: number;
  momentId: string;
  clipId: string;
  timestampMs: number;
  durationMs: number;
  reason: string;
}

export interface PersonalizedMissedMoment {
  viewerClipId: string;
  momentId: string;
  title: string;
  explanation: string;
  evidenceLinks: LinkedSourceEvidence[];
}

export interface LinkClipsRequest {
  clips: RealClipAnalysis[];
}

export interface RealSessionAnalysis {
  runId: string;
  createdAt: string;
  storyTitle: string;
  recap: string;
  alignment: ClipAlignment[];
  linkedMoments: LinkedSquadMoment[];
  directorCut: DirectorCutBeat[];
  whatYouMissed: PersonalizedMissedMoment[];
  api: {
    real: true;
    responseId: string;
    requestId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  };
}

export interface AskRealSessionRequest {
  question: string;
  viewerClipId: string;
  clips: RealClipAnalysis[];
  session: RealSessionAnalysis;
}

export interface RealAnswerCitation {
  clipId: string;
  observationId: string;
  timestampMs: number;
}

export interface AskRealSessionResponse {
  question: string;
  answer: string;
  confidence: number;
  answerType: "observation" | "inference" | "insufficient_evidence";
  caveat: string;
  citations: RealAnswerCitation[];
  api: {
    real: true;
    responseId: string;
    requestId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  };
}

export interface RealAnalysisApiError {
  error: {
    code:
      | "AI_NOT_CONFIGURED"
      | "UNAUTHORIZED"
      | "FORBIDDEN"
      | "INVALID_JSON"
      | "INVALID_REQUEST"
      | "OPENAI_ERROR"
      | "OPENAI_INVALID_OUTPUT";
    message: string;
    requestId?: string;
  };
}
