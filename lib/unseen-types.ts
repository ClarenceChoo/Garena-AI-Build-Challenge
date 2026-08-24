export type Milliseconds = number;

export type ParticipantId = "ace" | "rin" | "miko";

export type ConsentState = "granted" | "declined" | "pending";

export interface ParticipantConsent {
  gameplayRecording: ConsentState;
  voiceChat: ConsentState;
  aiAnalysis: ConsentState;
  squadSharing: ConsentState;
  grantedAt: string;
  canRevoke: boolean;
}

export interface Participant {
  id: ParticipantId;
  handle: string;
  displayName: string;
  role: "duelist" | "sentinel" | "support";
  character: string;
  accent: "ember" | "cyan" | "violet";
  avatarInitials: string;
  consent: ParticipantConsent;
}

export type PipelineStageId =
  | "ingest"
  | "align"
  | "understand"
  | "reconstruct"
  | "direct"
  | "ready";

export type PipelineStageState = "queued" | "active" | "complete";

export interface PipelineStageDefinition {
  id: PipelineStageId;
  label: string;
  shortLabel: string;
  description: string;
  progress: number;
  durationHintMs: number;
}

export interface PipelineStageStatus extends PipelineStageDefinition {
  state: PipelineStageState;
}

export type AlignmentAnchorType =
  | "round_timer"
  | "shared_audio"
  | "kill_feed"
  | "round_start";

export interface AlignmentAnchor {
  id: string;
  type: AlignmentAnchorType;
  sourceTimeMs: Milliseconds;
  masterTimeMs: Milliseconds;
  confidence: number;
  label: string;
}

export interface AlignedSource {
  id: string;
  participantId: ParticipantId;
  fileName: string;
  durationMs: Milliseconds;
  alignmentOffsetMs: number;
  alignmentConfidence: number;
  resolution: "960x540" | "1920x1080" | "2560x1440";
  frameRate: 15 | 60;
  audio: {
    game: boolean;
    optedInVoice: boolean;
    sampleRateHz: 48000;
  };
  anchors: AlignmentAnchor[];
}

export type MediaAnalysisModality =
  | "visual_detection"
  | "hud_ocr"
  | "speech_to_text"
  | "audio_reaction"
  | "cross_perspective_fusion";

export interface PreloadedRecording {
  sourceId: string;
  assetUrl: string;
  sha256: string;
  bytes: number;
  durationMs: Milliseconds;
  preloadCueMs: Milliseconds;
  containsGameAudio: boolean;
  containsOptedInVoice: boolean;
  label: string;
}

export interface SourceObservation {
  sourceId: string;
  sourceTimeMs: Milliseconds;
}

export interface MediaEvidenceTrace {
  evidenceId: string;
  sharedTimeMs: Milliseconds;
  modalities: MediaAnalysisModality[];
  sourceObservations: SourceObservation[];
  observation: string;
}

export interface DemoMediaBundle {
  mode: "preloaded_submission_demo";
  manifestVersion: "unseen-media-v1";
  label: string;
  analysisDisclosure: string;
  recordings: PreloadedRecording[];
  traces: MediaEvidenceTrace[];
}

export type EvidenceType =
  | "visual_event"
  | "voice_transcript"
  | "audio_reaction"
  | "hud_signal"
  | "cross_perspective";

export interface SessionEvidence {
  id: string;
  type: EvidenceType;
  timestampMs: Milliseconds;
  endMs?: Milliseconds;
  participantId?: ParticipantId;
  sourceId?: string;
  label: string;
  detail: string;
  quote?: string;
  confidence: number;
}

export type IncidentCategory =
  | "teamwork"
  | "clutch"
  | "sacrifice"
  | "mistake"
  | "reaction"
  | "setup";

export interface Incident {
  id: string;
  category: IncidentCategory;
  startMs: Milliseconds;
  endMs: Milliseconds;
  headline: string;
  summary: string;
  participantIds: ParticipantId[];
  evidenceIds: string[];
  gameplayImpact: number;
  emotionalIntensity: number;
  confidence: number;
}

export type MomentKind =
  | "team_play"
  | "clutch"
  | "comedy"
  | "sacrifice"
  | "turning_point";

export interface RankedMoment {
  id: string;
  rank: number;
  kind: MomentKind;
  title: string;
  startMs: Milliseconds;
  endMs: Milliseconds;
  summary: string;
  storyBeat: string;
  participantIds: ParticipantId[];
  perspectiveOrder: ParticipantId[];
  evidenceIds: string[];
  scores: {
    gameplay: number;
    reaction: number;
    novelty: number;
    teamwork: number;
    overall: number;
  };
  tags: string[];
}

export type EditTransition =
  | "hard_cut"
  | "audio_lead"
  | "match_cut"
  | "split_screen"
  | "dip_to_black";

export interface EditBeat {
  id: string;
  order: number;
  momentId: string;
  startMs: Milliseconds;
  endMs: Milliseconds;
  perspectiveId: ParticipantId;
  transition: EditTransition;
  caption: string;
  narration?: string;
  audioFocus: "game" | "voice" | "balanced";
}

export interface MissedMoment {
  id: string;
  viewerId: ParticipantId;
  momentId: string;
  timestampMs: Milliseconds;
  headline: string;
  explanation: string;
  revealedPerspectiveId: ParticipantId;
  evidenceIds: string[];
}

export interface DirectorCut {
  id: string;
  title: string;
  subtitle: string;
  durationMs: Milliseconds;
  status: "ready";
  aspectRatio: "16:9";
  quality: "1080p";
  editBeats: EditBeat[];
}

export interface FixtureProvenance {
  kind: "synthetic_demo_fixture";
  disclosure: string;
  generatedBy: "Team UNSEEN";
  representsRealPlayers: false;
  containsRealGameplay: false;
  intendedUse: "Garena AI Build Challenge prototype demonstration";
}

export interface UnseenSession {
  id: string;
  provenance: FixtureProvenance;
  title: string;
  game: string;
  mode: string;
  map: string;
  result: "victory" | "defeat";
  score: string;
  playedAt: string;
  durationMs: Milliseconds;
  rounds: number;
  focusParticipantId: ParticipantId;
  participants: Participant[];
  pipeline: PipelineStageDefinition[];
  sources: AlignedSource[];
  media: DemoMediaBundle;
  incidents: Incident[];
  moments: RankedMoment[];
  evidence: SessionEvidence[];
  directorCut: DirectorCut;
  missedMoments: MissedMoment[];
  suggestedQuestions: string[];
}

export interface ApiError {
  error: {
    code:
      | "INVALID_JSON"
      | "INVALID_REQUEST"
      | "PAYLOAD_TOO_LARGE"
      | "SESSION_NOT_FOUND"
      | "PARTICIPANT_NOT_FOUND"
      | "QUESTION_NOT_GROUNDED"
      | "INTERNAL_ERROR";
    message: string;
    details?: Record<string, string | number | boolean>;
  };
}

export interface DemoSessionResponse {
  session: UnseenSession;
  generatedAt: string;
  provenance: FixtureProvenance;
}

export interface ProcessDemoRequest {
  sessionId?: string;
  cursor?: number;
}

export interface ProcessDemoResponse {
  sessionId: string;
  runId: string;
  cursor: number;
  nextCursor: number | null;
  complete: boolean;
  currentStage: PipelineStageId;
  overallProgress: number;
  statusLine: string;
  stages: PipelineStageStatus[];
  outputCounts: {
    alignedSources: number;
    incidents: number;
    rankedMoments: number;
    editBeats: number;
  };
  mediaAnalysis: {
    mode: "precomputed_media_trace";
    recordingsVerified: number;
    anchorsMatched: number;
    evidenceObserved: number;
    observedEvidenceIds: string[];
    activeDetectors: MediaAnalysisModality[];
    summary: string;
  };
}

export interface AskDemoRequest {
  sessionId?: string;
  viewerId?: ParticipantId;
  question: string;
}

export interface AskCitation {
  evidenceId: string;
  timestampMs: Milliseconds;
  timestampLabel: string;
  label: string;
  participantId?: ParticipantId;
  sourceId?: string;
}

export interface AskDemoResponse {
  sessionId: string;
  question: string;
  answer: string;
  confidence: number;
  grounding: "session_evidence" | "ai_with_session_evidence";
  citations: AskCitation[];
  relatedMomentIds: string[];
  followUps: string[];
}

export interface UnseenAiQuestionInput {
  question: string;
  viewerId: ParticipantId;
  session: UnseenSession;
  fallback: AskDemoResponse;
}

export type UnseenAiQuestionHelper = (
  input: UnseenAiQuestionInput,
) => Promise<AskDemoResponse | null>;
