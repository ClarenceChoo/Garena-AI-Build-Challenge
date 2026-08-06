import type {
  AnalyzeClipRequest,
  AskRealSessionRequest,
  AskRealSessionResponse,
  ClipAlignment,
  DirectorCutBeat,
  LinkedSquadMoment,
  LinkClipsRequest,
  RealClipAnalysis,
  RealClipObservation,
  RealSessionAnalysis,
  PersonalizedMissedMoment,
} from "./real-analysis-types";
import { REAL_ANALYSIS_LIMITS } from "./real-analysis-types";

const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const TRANSCRIPTIONS_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

export interface RealOpenAIConfig {
  apiKey: string;
  visionModel?: string;
  linkingModel?: string;
  transcriptionModel?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class UnseenOpenAIError extends Error {
  constructor(
    message: string,
    public readonly code: "OPENAI_ERROR" | "OPENAI_INVALID_OUTPUT",
    public readonly status = 502,
    public readonly requestId = "",
  ) {
    super(message);
    this.name = "UnseenOpenAIError";
  }
}

interface ResponsesApiResult {
  id?: unknown;
  model?: unknown;
  output_text?: unknown;
  output?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
  };
  error?: { message?: unknown };
}

interface ResponseEnvelope<T> {
  payload: T;
  responseId: string;
  requestId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

const CLIP_ANALYSIS_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    gameTitle: { type: "string" },
    perspectiveSummary: { type: "string" },
    observations: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          timestampMs: { type: "number" },
          endMs: { type: "number" },
          category: {
            type: "string",
            enum: [
              "gameplay",
              "hud",
              "teamwork",
              "mistake",
              "reaction",
              "dialogue",
              "transition",
            ],
          },
          description: { type: "string" },
          importance: { type: "number", minimum: 0, maximum: 100 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidenceFrameIds: { type: "array", items: { type: "string" } },
          transcriptQuote: { type: ["string", "null"] },
        },
        required: [
          "id",
          "timestampMs",
          "endMs",
          "category",
          "description",
          "importance",
          "confidence",
          "evidenceFrameIds",
          "transcriptQuote",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["gameTitle", "perspectiveSummary", "observations"],
  additionalProperties: false,
});

const LINKED_SESSION_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    storyTitle: { type: "string" },
    recap: { type: "string" },
    alignment: {
      type: "array",
      items: {
        type: "object",
        properties: {
          clipId: { type: "string" },
          offsetMs: { type: "number" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          basis: { type: "array", items: { type: "string" } },
        },
        required: ["clipId", "offsetMs", "confidence", "basis"],
        additionalProperties: false,
      },
    },
    linkedMoments: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          sharedTimeMs: { type: "number" },
          importance: { type: "number", minimum: 0, maximum: 100 },
          emotion: { type: "string" },
          whyLinked: { type: "string" },
          sourceLinks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                clipId: { type: "string" },
                observationId: { type: "string" },
                timestampMs: { type: "number" },
                role: {
                  type: "string",
                  enum: ["setup", "action", "reaction", "context"],
                },
              },
              required: ["clipId", "observationId", "timestampMs", "role"],
              additionalProperties: false,
            },
          },
        },
        required: [
          "id",
          "title",
          "summary",
          "sharedTimeMs",
          "importance",
          "emotion",
          "whyLinked",
          "sourceLinks",
        ],
        additionalProperties: false,
      },
    },
    directorCut: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        properties: {
          order: { type: "number" },
          momentId: { type: "string" },
          clipId: { type: "string" },
          timestampMs: { type: "number" },
          durationMs: { type: "number" },
          reason: { type: "string" },
        },
        required: ["order", "momentId", "clipId", "timestampMs", "durationMs", "reason"],
        additionalProperties: false,
      },
    },
    whatYouMissed: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        properties: {
          viewerClipId: { type: "string" },
          momentId: { type: "string" },
          title: { type: "string" },
          explanation: { type: "string" },
          evidenceLinks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                clipId: { type: "string" },
                observationId: { type: "string" },
                timestampMs: { type: "number" },
                role: {
                  type: "string",
                  enum: ["setup", "action", "reaction", "context"],
                },
              },
              required: ["clipId", "observationId", "timestampMs", "role"],
              additionalProperties: false,
            },
          },
        },
        required: ["viewerClipId", "momentId", "title", "explanation", "evidenceLinks"],
        additionalProperties: false,
      },
    },
  },
  required: ["storyTitle", "recap", "alignment", "linkedMoments", "directorCut", "whatYouMissed"],
  additionalProperties: false,
});

const REAL_ANSWER_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    answer: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    answerType: {
      type: "string",
      enum: ["observation", "inference", "insufficient_evidence"],
    },
    caveat: { type: "string" },
    citations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          clipId: { type: "string" },
          observationId: { type: "string" },
          timestampMs: { type: "number" },
        },
        required: ["clipId", "observationId", "timestampMs"],
        additionalProperties: false,
      },
    },
  },
  required: ["answer", "confidence", "answerType", "caveat", "citations"],
  additionalProperties: false,
});

function extractResponseText(response: ResponsesApiResult): string | null {
  if (typeof response.output_text === "string") return response.output_text;
  if (!Array.isArray(response.output)) return null;
  for (const item of response.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const record = part as { type?: unknown; text?: unknown };
      if (record.type === "output_text" && typeof record.text === "string") {
        return record.text;
      }
    }
  }
  return null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeImportance(value: unknown): number {
  const score = numberOrZero(value);
  const percentageScale = score >= 0 && score <= 1 ? score * 100 : score;
  return Math.min(100, Math.max(0, percentageScale));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeMessage(value: unknown, fallback: string): string {
  if (!record(value)) return fallback;
  const error = value.error;
  if (!record(error) || typeof error.message !== "string") return fallback;
  return error.message.slice(0, 300);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "OpenAI analysis timed out. Try shorter clips."
      : "OpenAI analysis could not be reached.";
    throw new UnseenOpenAIError(message, "OPENAI_ERROR", 502);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestStructured<T>(
  config: RealOpenAIConfig,
  model: string,
  schemaName: string,
  schema: object,
  instructions: string,
  input: unknown,
  maxOutputTokens: number,
): Promise<ResponseEnvelope<T>> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const response = await fetchWithTimeout(
    fetchImpl,
    RESPONSES_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: maxOutputTokens,
        instructions,
        input,
        text: {
          verbosity: "medium",
          format: {
            type: "json_schema",
            name: schemaName,
            strict: true,
            schema,
          },
        },
      }),
    },
    Math.max(15_000, config.timeoutMs ?? 120_000),
  );
  const requestId = response.headers.get("x-request-id") ?? "";
  const apiResult = (await response.json().catch(() => null)) as ResponsesApiResult | null;
  if (!response.ok) {
    throw new UnseenOpenAIError(
      safeMessage(apiResult, `OpenAI returned HTTP ${response.status}.`),
      "OPENAI_ERROR",
      502,
      requestId,
    );
  }
  const outputText = apiResult ? extractResponseText(apiResult) : null;
  if (!outputText) {
    throw new UnseenOpenAIError(
      "OpenAI returned no structured analysis.",
      "OPENAI_INVALID_OUTPUT",
      502,
      requestId,
    );
  }
  let payload: T;
  try {
    payload = JSON.parse(outputText) as T;
  } catch {
    throw new UnseenOpenAIError(
      "OpenAI returned malformed structured analysis.",
      "OPENAI_INVALID_OUTPUT",
      502,
      requestId,
    );
  }
  return {
    payload,
    responseId: typeof apiResult?.id === "string" ? apiResult.id : "",
    requestId,
    model: typeof apiResult?.model === "string" ? apiResult.model : model,
    inputTokens: numberOrZero(apiResult?.usage?.input_tokens),
    outputTokens: numberOrZero(apiResult?.usage?.output_tokens),
  };
}

async function transcribeAudio(
  audioBase64: string,
  config: RealOpenAIConfig,
): Promise<{ text: string; requestId: string; model: string }> {
  const model = config.transcriptionModel ?? "gpt-4o-mini-transcribe";
  const form = new FormData();
  const bytes = base64ToBytes(audioBase64);
  const audioBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  form.append("file", new Blob([audioBuffer], { type: "audio/wav" }), "clip.wav");
  form.append("model", model);
  form.append("response_format", "json");
  const response = await fetchWithTimeout(
    config.fetchImpl ?? globalThis.fetch,
    TRANSCRIPTIONS_ENDPOINT,
    { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}` }, body: form },
    Math.max(15_000, config.timeoutMs ?? 120_000),
  );
  const requestId = response.headers.get("x-request-id") ?? "";
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new UnseenOpenAIError(
      safeMessage(body, `OpenAI transcription returned HTTP ${response.status}.`),
      "OPENAI_ERROR",
      502,
      requestId,
    );
  }
  if (!record(body) || typeof body.text !== "string") {
    throw new UnseenOpenAIError(
      "OpenAI transcription returned no text.",
      "OPENAI_INVALID_OUTPUT",
      502,
      requestId,
    );
  }
  return { text: body.text.trim(), requestId, model };
}

function validateClipOutput(
  raw: unknown,
  request: AnalyzeClipRequest,
): { gameTitle: string; perspectiveSummary: string; observations: RealClipObservation[] } {
  if (!record(raw) || typeof raw.gameTitle !== "string" || typeof raw.perspectiveSummary !== "string" || !Array.isArray(raw.observations)) {
    throw new UnseenOpenAIError("OpenAI clip analysis failed validation.", "OPENAI_INVALID_OUTPUT");
  }
  const frameIds = new Set(request.frames.map((frame) => frame.id));
  const categories = new Set(["gameplay", "hud", "teamwork", "mistake", "reaction", "dialogue", "transition"]);
  const observations = raw.observations.filter(record).map((item, index) => {
    const evidenceFrameIds = Array.isArray(item.evidenceFrameIds)
      ? item.evidenceFrameIds.filter((id): id is string => typeof id === "string" && frameIds.has(id))
      : [];
    if (evidenceFrameIds.length === 0 || typeof item.description !== "string" || !categories.has(String(item.category))) {
      throw new UnseenOpenAIError("OpenAI cited an unknown source frame.", "OPENAI_INVALID_OUTPUT");
    }
    const timestampMs = Math.min(request.clip.durationMs, Math.max(0, numberOrZero(item.timestampMs)));
    return {
      id: typeof item.id === "string" && item.id ? item.id : `${request.clip.id}-obs-${index + 1}`,
      timestampMs,
      endMs: Math.min(request.clip.durationMs, Math.max(timestampMs, numberOrZero(item.endMs))),
      category: item.category as RealClipObservation["category"],
      description: item.description,
      importance: normalizeImportance(item.importance),
      confidence: Math.min(1, Math.max(0, numberOrZero(item.confidence))),
      evidenceFrameIds,
      transcriptQuote: typeof item.transcriptQuote === "string" ? item.transcriptQuote : null,
    };
  });
  if (observations.length === 0) {
    throw new UnseenOpenAIError("OpenAI found no evidence-backed observations in this clip.", "OPENAI_INVALID_OUTPUT");
  }
  return { gameTitle: raw.gameTitle, perspectiveSummary: raw.perspectiveSummary, observations };
}

export function validateAnalyzeClipRequest(value: unknown): AnalyzeClipRequest {
  if (!record(value) || !record(value.clip) || !Array.isArray(value.frames)) {
    throw new TypeError("clip and frames are required.");
  }
  const clip = value.clip;
  if (typeof clip.id !== "string" || typeof clip.name !== "string" || typeof clip.playerLabel !== "string" || typeof clip.durationMs !== "number") {
    throw new TypeError("clip metadata is invalid.");
  }
  if (clip.durationMs <= 0 || clip.durationMs > REAL_ANALYSIS_LIMITS.maximumDurationMs) {
    throw new TypeError("Each clip must be 45 seconds or shorter.");
  }
  if (value.frames.length < 2 || value.frames.length > REAL_ANALYSIS_LIMITS.framesPerClip) {
    throw new TypeError(`Each clip must include 2-${REAL_ANALYSIS_LIMITS.framesPerClip} sampled frames.`);
  }
  const frames = value.frames.map((frame, index) => {
    if (!record(frame) || typeof frame.id !== "string" || typeof frame.timestampMs !== "number" || typeof frame.imageDataUrl !== "string" || typeof frame.width !== "number" || typeof frame.height !== "number") {
      throw new TypeError(`Frame ${index + 1} is invalid.`);
    }
    if (!frame.imageDataUrl.startsWith("data:image/jpeg;base64,") || frame.imageDataUrl.length > REAL_ANALYSIS_LIMITS.maximumFrameDataUrlLength) {
      throw new TypeError(`Frame ${index + 1} is not a supported JPEG sample.`);
    }
    return frame as unknown as AnalyzeClipRequest["frames"][number];
  });
  const voiceConsent = value.voiceConsent === true;
  let audio: AnalyzeClipRequest["audio"] = null;
  if (value.audio !== null && value.audio !== undefined) {
    if (!voiceConsent || !record(value.audio) || value.audio.mimeType !== "audio/wav" || typeof value.audio.dataBase64 !== "string" || value.audio.dataBase64.length > REAL_ANALYSIS_LIMITS.maximumAudioBase64Length) {
      throw new TypeError("Audio requires explicit voice consent and a supported WAV sample.");
    }
    audio = { mimeType: "audio/wav", dataBase64: value.audio.dataBase64 };
  }
  return {
    clip: { id: clip.id, name: clip.name, playerLabel: clip.playerLabel, durationMs: clip.durationMs },
    frames,
    audio,
    voiceConsent,
  };
}

export async function analyzeRealClip(
  request: AnalyzeClipRequest,
  config: RealOpenAIConfig,
): Promise<RealClipAnalysis> {
  const transcription = request.audio
    ? await transcribeAudio(request.audio.dataBase64, config)
    : null;
  const transcript = transcription?.text ?? "";
  const frameContent = request.frames.flatMap((frame) => [
    {
      type: "input_text" as const,
      text: `SOURCE FRAME ${frame.id} at ${frame.timestampMs}ms (${frame.width}x${frame.height})`,
    },
    {
      type: "input_image" as const,
      image_url: frame.imageDataUrl,
      detail: "high" as const,
    },
  ]);
  const response = await requestStructured<unknown>(
    config,
    config.visionModel ?? "gpt-5.6-sol",
    "unseen_clip_analysis",
    CLIP_ANALYSIS_SCHEMA,
    [
      "Analyze this actual gameplay recording from timestamped sampled frames and the optional opted-in transcript.",
      "Success means: identify only directly observable gameplay, HUD state, teamwork, mistakes, reactions, dialogue, and scene transitions; preserve source timestamps; cite one or more supplied frame IDs for every observation; avoid player identity or intent guesses; return no observation that lacks visual evidence.",
      "Use integer importance scores from 0 to 100. Confidence remains a decimal from 0 to 1.",
      "The transcript may add dialogue context but never overrides the frames. Empty transcript means audio was not supplied.",
    ].join("\n"),
    [{
      role: "user",
      content: [
        { type: "input_text", text: JSON.stringify({ clip: request.clip, transcript }) },
        ...frameContent,
      ],
    }],
    2_800,
  );
  const validated = validateClipOutput(response.payload, request);
  return {
    clipId: request.clip.id,
    clipName: request.clip.name,
    playerLabel: request.clip.playerLabel,
    durationMs: request.clip.durationMs,
    gameTitle: validated.gameTitle,
    perspectiveSummary: validated.perspectiveSummary,
    transcript,
    audioStatus: transcription ? "transcribed" : "not_supplied",
    observations: validated.observations,
    api: {
      real: true,
      visionResponseId: response.responseId,
      visionRequestId: response.requestId,
      visionModel: response.model,
      transcriptionRequestId: transcription?.requestId ?? "",
      transcriptionModel: transcription?.model ?? null,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    },
  };
}

function validateLinkRequest(value: unknown): LinkClipsRequest {
  if (!record(value) || !Array.isArray(value.clips)) throw new TypeError("clips are required.");
  if (value.clips.length < REAL_ANALYSIS_LIMITS.minimumClips || value.clips.length > REAL_ANALYSIS_LIMITS.maximumClips) {
    throw new TypeError("Linking requires 2-4 analyzed clips.");
  }
  for (const clip of value.clips) {
    if (!record(clip) || typeof clip.clipId !== "string" || !Array.isArray(clip.observations) || !record(clip.api) || clip.api.real !== true || typeof clip.api.visionResponseId !== "string" || !clip.api.visionResponseId) {
      throw new TypeError("Every clip must be a real, completed AI analysis.");
    }
  }
  return value as unknown as LinkClipsRequest;
}

function validateLinkedOutput(raw: unknown, clips: RealClipAnalysis[]): Omit<RealSessionAnalysis, "runId" | "createdAt" | "api"> {
  if (!record(raw) || typeof raw.storyTitle !== "string" || typeof raw.recap !== "string" || !Array.isArray(raw.alignment) || !Array.isArray(raw.linkedMoments) || !Array.isArray(raw.directorCut) || !Array.isArray(raw.whatYouMissed)) {
    throw new UnseenOpenAIError("OpenAI cross-clip result failed validation.", "OPENAI_INVALID_OUTPUT");
  }
  const clipMap = new Map(clips.map((clip) => [clip.clipId, clip]));
  const observationIds = new Map(clips.map((clip) => [clip.clipId, new Set(clip.observations.map((item) => item.id))]));
  const alignment = raw.alignment.filter(record).map((item) => ({
    clipId: String(item.clipId ?? ""),
    offsetMs: numberOrZero(item.offsetMs),
    confidence: Math.min(1, Math.max(0, numberOrZero(item.confidence))),
    basis: Array.isArray(item.basis) ? item.basis.filter((entry): entry is string => typeof entry === "string") : [],
  } satisfies ClipAlignment)).filter((item) => clipMap.has(item.clipId));
  const linkedMoments = raw.linkedMoments.filter(record).map((item) => {
    const sourceLinks = Array.isArray(item.sourceLinks) ? item.sourceLinks.filter(record).map((link) => ({
      clipId: String(link.clipId ?? ""),
      observationId: String(link.observationId ?? ""),
      timestampMs: numberOrZero(link.timestampMs),
      role: link.role as "setup" | "action" | "reaction" | "context",
    })).filter((link) => clipMap.has(link.clipId) && observationIds.get(link.clipId)?.has(link.observationId)) : [];
    if (sourceLinks.length === 0) throw new UnseenOpenAIError("A linked moment cited no valid source observations.", "OPENAI_INVALID_OUTPUT");
    return {
      id: String(item.id ?? ""), title: String(item.title ?? ""), summary: String(item.summary ?? ""),
      sharedTimeMs: numberOrZero(item.sharedTimeMs), importance: normalizeImportance(item.importance),
      emotion: String(item.emotion ?? ""), whyLinked: String(item.whyLinked ?? ""), sourceLinks,
    } satisfies LinkedSquadMoment;
  });
  const momentIds = new Set(linkedMoments.map((moment) => moment.id));
  const directorCut = raw.directorCut.filter(record).map((item) => ({
    order: numberOrZero(item.order), momentId: String(item.momentId ?? ""), clipId: String(item.clipId ?? ""),
    timestampMs: numberOrZero(item.timestampMs), durationMs: Math.max(1_500, Math.min(12_000, numberOrZero(item.durationMs))), reason: String(item.reason ?? ""),
  } satisfies DirectorCutBeat)).filter((beat) => momentIds.has(beat.momentId) && clipMap.has(beat.clipId)).sort((a, b) => a.order - b.order);
  const whatYouMissed = raw.whatYouMissed.filter(record).map((item) => {
    const evidenceLinks = Array.isArray(item.evidenceLinks) ? item.evidenceLinks.filter(record).map((link) => ({
      clipId: String(link.clipId ?? ""),
      observationId: String(link.observationId ?? ""),
      timestampMs: numberOrZero(link.timestampMs),
      role: link.role as "setup" | "action" | "reaction" | "context",
    })).filter((link) => clipMap.has(link.clipId) && observationIds.get(link.clipId)?.has(link.observationId)) : [];
    return {
      viewerClipId: String(item.viewerClipId ?? ""),
      momentId: String(item.momentId ?? ""),
      title: String(item.title ?? ""),
      explanation: String(item.explanation ?? ""),
      evidenceLinks,
    } satisfies PersonalizedMissedMoment;
  }).filter((item) => clipMap.has(item.viewerClipId) && momentIds.has(item.momentId) && item.evidenceLinks.some((link) => link.clipId !== item.viewerClipId));
  if (linkedMoments.length === 0 || directorCut.length === 0) {
    throw new UnseenOpenAIError("OpenAI could not build an evidence-linked squad story.", "OPENAI_INVALID_OUTPUT");
  }
  return { storyTitle: raw.storyTitle, recap: raw.recap, alignment, linkedMoments, directorCut, whatYouMissed };
}

export async function linkRealClips(value: unknown, config: RealOpenAIConfig): Promise<RealSessionAnalysis> {
  const request = validateLinkRequest(value);
  const packet = request.clips.map((clip) => ({
    clipId: clip.clipId, clipName: clip.clipName, playerLabel: clip.playerLabel, durationMs: clip.durationMs,
    gameTitle: clip.gameTitle, perspectiveSummary: clip.perspectiveSummary, transcript: clip.transcript,
    observations: clip.observations,
    provenance: { responseId: clip.api.visionResponseId, model: clip.api.visionModel },
  }));
  const response = await requestStructured<unknown>(
    config,
    config.linkingModel ?? config.visionModel ?? "gpt-5.6-sol",
    "unseen_linked_session",
    LINKED_SESSION_SCHEMA,
    [
      "Reconstruct one squad session from independently analyzed POV clips.",
      "Success means: align clips only when timers, repeated HUD events, matching actions, or transcript/audio cues support it; cite exact clip and observation IDs; explain why evidence belongs to the same moment; preserve low confidence where alignment is uncertain; include meaningful single-POV moments when teammates likely missed them; create a concise director cut that switches perspective only when it adds information; produce personalized whatYouMissed entries only when another clip contains evidence absent from the viewer clip.",
      "Use integer importance scores from 0 to 100. Alignment confidence remains a decimal from 0 to 1.",
      "Never invent a player, event, timestamp, or relationship absent from the supplied analyses. Use the first clip as offset 0. If clips do not overlap, keep alignment confidence low and tell that truth in the recap.",
    ].join("\n"),
    JSON.stringify({ clips: packet }),
    3_600,
  );
  const validated = validateLinkedOutput(response.payload, request.clips);
  return {
    runId: `unseen-live-${response.responseId || crypto.randomUUID()}`,
    createdAt: new Date().toISOString(),
    ...validated,
    api: {
      real: true,
      responseId: response.responseId,
      requestId: response.requestId,
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    },
  };
}

function validateAskRealSessionRequest(value: unknown): AskRealSessionRequest {
  if (!record(value) || typeof value.question !== "string" || typeof value.viewerClipId !== "string" || !Array.isArray(value.clips) || !record(value.session)) {
    throw new TypeError("question, viewerClipId, clips, and session are required.");
  }
  const question = value.question.trim();
  if (question.length < 3 || question.length > 500) throw new TypeError("question must contain 3-500 characters.");
  const clips = validateLinkRequest({ clips: value.clips }).clips;
  if (!clips.some((clip) => clip.clipId === value.viewerClipId)) throw new TypeError("viewerClipId must match an analyzed clip.");
  const session = value.session as unknown as RealSessionAnalysis;
  if (session.api?.real !== true || typeof session.api.responseId !== "string" || !session.api.responseId || !Array.isArray(session.linkedMoments)) {
    throw new TypeError("session must be a completed real AI reconstruction.");
  }
  return { question, viewerClipId: value.viewerClipId, clips, session };
}

export async function askRealSession(value: unknown, config: RealOpenAIConfig): Promise<AskRealSessionResponse> {
  const request = validateAskRealSessionRequest(value);
  const evidence = request.clips.map((clip) => ({
    clipId: clip.clipId,
    playerLabel: clip.playerLabel,
    perspectiveSummary: clip.perspectiveSummary,
    transcript: clip.transcript,
    observations: clip.observations,
  }));
  const response = await requestStructured<unknown>(
    config,
    config.linkingModel ?? config.visionModel ?? "gpt-5.6-sol",
    "unseen_real_session_answer",
    REAL_ANSWER_SCHEMA,
    [
      "Answer the player's question only from the supplied, already analyzed session evidence.",
      "Success means: cite exact clip and observation IDs for each factual claim; distinguish direct observation from inference; compare the viewer clip against teammates when relevant; abstain with answerType insufficient_evidence when support is missing or contradictory; never infer intent or identity.",
    ].join("\n"),
    JSON.stringify({
      question: request.question,
      viewerClipId: request.viewerClipId,
      story: {
        recap: request.session.recap,
        alignment: request.session.alignment,
        linkedMoments: request.session.linkedMoments,
      },
      evidence,
    }),
    1_400,
  );
  if (!record(response.payload) || typeof response.payload.answer !== "string" || typeof response.payload.answerType !== "string" || typeof response.payload.caveat !== "string" || !Array.isArray(response.payload.citations)) {
    throw new UnseenOpenAIError("OpenAI session answer failed validation.", "OPENAI_INVALID_OUTPUT");
  }
  const clipMap = new Map(request.clips.map((clip) => [clip.clipId, new Set(clip.observations.map((observation) => observation.id))]));
  const citations = response.payload.citations.filter(record).map((citation) => ({
    clipId: String(citation.clipId ?? ""),
    observationId: String(citation.observationId ?? ""),
    timestampMs: numberOrZero(citation.timestampMs),
  })).filter((citation) => clipMap.get(citation.clipId)?.has(citation.observationId));
  const answerType = response.payload.answerType as AskRealSessionResponse["answerType"];
  if (!["observation", "inference", "insufficient_evidence"].includes(answerType)) {
    throw new UnseenOpenAIError("OpenAI returned an unknown answer type.", "OPENAI_INVALID_OUTPUT");
  }
  if (answerType !== "insufficient_evidence" && citations.length === 0) {
    throw new UnseenOpenAIError("OpenAI answered without a valid session citation.", "OPENAI_INVALID_OUTPUT");
  }
  return {
    question: request.question,
    answer: response.payload.answer,
    confidence: Math.min(1, Math.max(0, numberOrZero(response.payload.confidence))),
    answerType,
    caveat: response.payload.caveat,
    citations,
    api: {
      real: true,
      responseId: response.responseId,
      requestId: response.requestId,
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    },
  };
}
