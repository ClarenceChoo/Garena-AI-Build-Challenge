import type {
  GameplayClipMetadata,
  GameplayEvent,
  GameplayEventType,
  GameplaySearchHit,
  GameplaySearchResponse,
  GameplaySegmentIndex,
  GameplayTranscriptSegment,
  HighlightBeat,
  HighlightPlan,
  IndexGameplaySegmentRequest,
  PlanHighlightsRequest,
  SearchGameplayRequest,
  TranscribeGameplayAudioResponse,
} from "./gameplay-search-types";
import { GAMEPLAY_SEARCH_LIMITS } from "./gameplay-search-types";

const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const TRANSCRIPTIONS_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";

export interface GameplaySearchOpenAIConfig {
  apiKey: string;
  searchModel?: string;
  transcriptionModel?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class GameplaySearchOpenAIError extends Error {
  constructor(
    message: string,
    public readonly code: "OPENAI_ERROR" | "OPENAI_INVALID_OUTPUT",
    public readonly status = 502,
    public readonly requestId = "",
  ) {
    super(message);
    this.name = "GameplaySearchOpenAIError";
  }
}

interface ResponsesApiResult {
  id?: unknown;
  model?: unknown;
  output_text?: unknown;
  output?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
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

const EVENT_TYPES: GameplayEventType[] = [
  "elimination",
  "assist",
  "death",
  "objective",
  "clutch",
  "mistake",
  "reaction",
  "dialogue",
  "transition",
  "other",
];

const GAMEPLAY_INDEX_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    gameTitle: { type: "string" },
    gameMode: { type: "string" },
    contextSummary: { type: "string" },
    events: {
      type: "array",
      maxItems: GAMEPLAY_SEARCH_LIMITS.maximumEventsPerSegment,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          startMs: { type: "number" },
          endMs: { type: "number" },
          type: { type: "string", enum: EVENT_TYPES },
          title: { type: "string" },
          description: { type: "string" },
          actors: { type: "array", items: { type: "string" } },
          target: { type: ["string", "null"] },
          ocrText: { type: "string" },
          importance: { type: "number", minimum: 0, maximum: 100 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidenceFrameIds: { type: "array", items: { type: "string" } },
          transcriptSegmentIds: { type: "array", items: { type: "string" } },
        },
        required: [
          "id",
          "startMs",
          "endMs",
          "type",
          "title",
          "description",
          "actors",
          "target",
          "ocrText",
          "importance",
          "confidence",
          "evidenceFrameIds",
          "transcriptSegmentIds",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["gameTitle", "gameMode", "contextSummary", "events"],
  additionalProperties: false,
});

const GAMEPLAY_SEARCH_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    answerType: { type: "string", enum: ["matches", "insufficient_evidence"] },
    summary: { type: "string" },
    hits: {
      type: "array",
      maxItems: GAMEPLAY_SEARCH_LIMITS.maximumSearchHits,
      items: {
        type: "object",
        properties: {
          eventId: { type: "string" },
          title: { type: "string" },
          whyMatch: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["eventId", "title", "whyMatch", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["answerType", "summary", "hits"],
  additionalProperties: false,
});

const HIGHLIGHT_PLAN_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    title: { type: "string" },
    beats: {
      type: "array",
      maxItems: 18,
      items: {
        type: "object",
        properties: {
          eventId: { type: "string" },
          startMs: { type: "number" },
          endMs: { type: "number" },
          caption: { type: "string" },
        },
        required: ["eventId", "startMs", "endMs", "caption"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "beats"],
  additionalProperties: false,
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function cleanText(value: unknown, fallback = "", maximum = 500): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : fallback;
}

function safeMessage(value: unknown, fallback: string): string {
  if (!record(value) || !record(value.error) || typeof value.error.message !== "string") {
    return fallback;
  }
  return value.error.message.slice(0, 300);
}

function extractResponseText(response: ResponsesApiResult): string | null {
  if (typeof response.output_text === "string") return response.output_text;
  if (!Array.isArray(response.output)) return null;
  for (const item of response.output) {
    if (!record(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (record(part) && part.type === "output_text" && typeof part.text === "string") {
        return part.text;
      }
    }
  }
  return null;
}

async function fetchWithTimeout(
  config: GameplaySearchOpenAIConfig,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(15_000, config.timeoutMs ?? 180_000));
  try {
    return await (config.fetchImpl ?? globalThis.fetch)(input, { ...init, signal: controller.signal });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "OpenAI processing timed out. Retry this segment."
      : "OpenAI could not be reached.";
    throw new GameplaySearchOpenAIError(message, "OPENAI_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

async function requestStructured<T>(
  config: GameplaySearchOpenAIConfig,
  schemaName: string,
  schema: object,
  instructions: string,
  input: unknown,
  maximumOutputTokens: number,
): Promise<ResponseEnvelope<T>> {
  const model = config.searchModel ?? "gpt-5.6-sol";
  const response = await fetchWithTimeout(config, RESPONSES_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: "low" },
      max_output_tokens: maximumOutputTokens,
      instructions,
      input,
      text: {
        verbosity: "medium",
        format: { type: "json_schema", name: schemaName, strict: true, schema },
      },
    }),
  });
  const requestId = response.headers.get("x-request-id") ?? "";
  const body = (await response.json().catch(() => null)) as ResponsesApiResult | null;
  if (!response.ok) {
    throw new GameplaySearchOpenAIError(
      safeMessage(body, `OpenAI returned HTTP ${response.status}.`),
      "OPENAI_ERROR",
      502,
      requestId,
    );
  }
  const outputText = body ? extractResponseText(body) : null;
  if (!outputText) {
    throw new GameplaySearchOpenAIError(
      "OpenAI returned no structured gameplay result.",
      "OPENAI_INVALID_OUTPUT",
      502,
      requestId,
    );
  }
  let payload: T;
  try {
    payload = JSON.parse(outputText) as T;
  } catch {
    throw new GameplaySearchOpenAIError(
      "OpenAI returned malformed structured gameplay data.",
      "OPENAI_INVALID_OUTPUT",
      502,
      requestId,
    );
  }
  return {
    payload,
    responseId: typeof body?.id === "string" ? body.id : "",
    requestId,
    model: typeof body?.model === "string" ? body.model : model,
    inputTokens: numberOrZero(body?.usage?.input_tokens),
    outputTokens: numberOrZero(body?.usage?.output_tokens),
  };
}

function validateClipMetadata(value: unknown): GameplayClipMetadata {
  if (!record(value)) throw new TypeError("clip metadata is required.");
  const id = cleanText(value.id, "", 120);
  const name = cleanText(value.name, "", 220);
  const label = cleanText(value.label, "", 120);
  const durationMs = numberOrZero(value.durationMs);
  const sizeBytes = numberOrZero(value.sizeBytes);
  if (!id || !name || !label || durationMs <= 0 || durationMs > GAMEPLAY_SEARCH_LIMITS.maximumTotalDurationMs || sizeBytes <= 0 || sizeBytes > GAMEPLAY_SEARCH_LIMITS.maximumTotalFileBytes) {
    throw new TypeError("clip metadata is invalid.");
  }
  return { id, name, label, durationMs, sizeBytes };
}

function validateClipCollection(clips: GameplayClipMetadata[]): void {
  if (clips.length === 0 || clips.length > GAMEPLAY_SEARCH_LIMITS.maximumClips) {
    throw new TypeError(`Gameplay search requires 1-${GAMEPLAY_SEARCH_LIMITS.maximumClips} clips.`);
  }
  if (clips.reduce((sum, clip) => sum + clip.durationMs, 0) > GAMEPLAY_SEARCH_LIMITS.maximumTotalDurationMs) {
    throw new TypeError("Gameplay clips exceed the 60-minute session limit.");
  }
  if (clips.reduce((sum, clip) => sum + clip.sizeBytes, 0) > GAMEPLAY_SEARCH_LIMITS.maximumTotalFileBytes) {
    throw new TypeError("Gameplay clips exceed the 2 GB session limit.");
  }
}

export function validateIndexGameplaySegmentRequest(value: unknown): IndexGameplaySegmentRequest {
  if (!record(value) || !record(value.segment) || !Array.isArray(value.frames)) {
    throw new TypeError("clip, segment, and frames are required.");
  }
  const clip = validateClipMetadata(value.clip);
  const segmentId = cleanText(value.segment.id, "", 160);
  const startMs = numberOrZero(value.segment.startMs);
  const endMs = numberOrZero(value.segment.endMs);
  if (!segmentId || startMs < 0 || endMs <= startMs || endMs > clip.durationMs + 1 || endMs - startMs > GAMEPLAY_SEARCH_LIMITS.segmentDurationMs + 1_000) {
    throw new TypeError("segment timing is invalid.");
  }
  if (value.frames.length < 2 || value.frames.length > GAMEPLAY_SEARCH_LIMITS.maximumFramesPerSegment) {
    throw new TypeError(`Each segment must contain 2-${GAMEPLAY_SEARCH_LIMITS.maximumFramesPerSegment} evidence frames.`);
  }
  const frames = value.frames.map((frame, index) => {
    if (!record(frame)) throw new TypeError(`Frame ${index + 1} is invalid.`);
    const id = cleanText(frame.id, "", 180);
    const timestampMs = numberOrZero(frame.timestampMs);
    const imageDataUrl = cleanText(frame.imageDataUrl, "", 900_000);
    const width = numberOrZero(frame.width);
    const height = numberOrZero(frame.height);
    const detail = frame.detail === "high" ? "high" : "low";
    const reasons = new Set(["context", "visual_change", "hud_change", "audio_peak"]);
    const reason = reasons.has(String(frame.reason)) ? frame.reason : "context";
    if (!id || !imageDataUrl.startsWith("data:image/jpeg;base64,") || width <= 0 || height <= 0 || timestampMs < startMs - 2_000 || timestampMs > endMs + 2_000) {
      throw new TypeError(`Frame ${index + 1} is invalid.`);
    }
    return { id, timestampMs, imageDataUrl, width, height, detail, reason } as IndexGameplaySegmentRequest["frames"][number];
  });
  const audioFeatures = Array.isArray(value.audioFeatures)
    ? value.audioFeatures.slice(0, 120).filter(record).map((item) => ({
        timestampMs: clamp(numberOrZero(item.timestampMs), startMs, endMs),
        rms: clamp(numberOrZero(item.rms), 0, 1),
        peak: clamp(numberOrZero(item.peak), 0, 1),
      }))
    : [];
  const transcriptSegments = Array.isArray(value.transcriptSegments)
    ? value.transcriptSegments.filter(record).map((item) => ({
        id: cleanText(item.id, "", 180),
        clipId: cleanText(item.clipId, "", 120),
        startMs: clamp(numberOrZero(item.startMs), 0, clip.durationMs),
        endMs: clamp(numberOrZero(item.endMs), 0, clip.durationMs),
        text: cleanText(item.text, "", 1_000),
      })).filter((item) => item.id && item.clipId === clip.id && item.endMs >= startMs && item.startMs <= endMs && item.text)
    : [];
  const priorContext = record(value.priorContext)
    ? {
        gameTitle: cleanText(value.priorContext.gameTitle, "", 120),
        gameMode: cleanText(value.priorContext.gameMode, "", 120),
      }
    : null;
  return {
    clip,
    segment: { id: segmentId, startMs, endMs },
    frames,
    audioFeatures,
    transcriptSegments,
    priorContext,
  };
}

function validateIndexedEvents(
  raw: unknown,
  request: IndexGameplaySegmentRequest,
): Pick<GameplaySegmentIndex, "gameTitle" | "gameMode" | "contextSummary" | "events"> {
  if (!record(raw) || !Array.isArray(raw.events)) {
    throw new GameplaySearchOpenAIError("OpenAI segment indexing failed validation.", "OPENAI_INVALID_OUTPUT");
  }
  const frameIds = new Set(request.frames.map((frame) => frame.id));
  const transcriptIds = new Set(request.transcriptSegments.map((segment) => segment.id));
  const seenIds = new Set<string>();
  const rawEvents = raw.events.slice(0, GAMEPLAY_SEARCH_LIMITS.maximumEventsPerSegment).filter(record).map((item, index) => {
    const rawFrameIds = Array.isArray(item.evidenceFrameIds)
      ? item.evidenceFrameIds.filter((id): id is string => typeof id === "string")
      : [];
    const rawTranscriptIds = Array.isArray(item.transcriptSegmentIds)
      ? item.transcriptSegmentIds.filter((id): id is string => typeof id === "string")
      : [];
    if (rawFrameIds.length === 0 || rawFrameIds.some((id) => !frameIds.has(id))) {
      throw new GameplaySearchOpenAIError("OpenAI cited an unknown gameplay frame.", "OPENAI_INVALID_OUTPUT");
    }
    if (rawTranscriptIds.some((id) => !transcriptIds.has(id))) {
      throw new GameplaySearchOpenAIError("OpenAI cited an unknown gameplay transcript.", "OPENAI_INVALID_OUTPUT");
    }
    const type = EVENT_TYPES.includes(item.type as GameplayEventType) ? item.type as GameplayEventType : "other";
    let id = cleanText(item.id, `${request.segment.id}-event-${index + 1}`, 180);
    if (!id.startsWith(request.segment.id) || seenIds.has(id)) id = `${request.segment.id}-event-${index + 1}`;
    seenIds.add(id);
    const startMs = clamp(numberOrZero(item.startMs), request.segment.startMs, request.segment.endMs);
    return {
      id,
      clipId: request.clip.id,
      segmentId: request.segment.id,
      startMs,
      endMs: clamp(Math.max(startMs, numberOrZero(item.endMs)), startMs, request.segment.endMs),
      type,
      title: cleanText(item.title, "Observed gameplay event", 120),
      description: cleanText(item.description, "Evidence-backed gameplay event.", 600),
      actors: Array.isArray(item.actors)
        ? item.actors.filter((actor): actor is string => typeof actor === "string").map((actor) => actor.trim().slice(0, 80)).filter(Boolean).slice(0, 8)
        : [],
      target: typeof item.target === "string" && item.target.trim() ? item.target.trim().slice(0, 80) : null,
      ocrText: cleanText(item.ocrText, "", 500),
      importance: clamp(numberOrZero(item.importance), 0, 100),
      confidence: clamp(numberOrZero(item.confidence), 0, 1),
      evidenceFrameIds: [...new Set(rawFrameIds)],
      transcriptSegmentIds: [...new Set(rawTranscriptIds)],
    } satisfies GameplayEvent;
  });
  const events = rawEvents.filter((event, index) => !rawEvents.slice(0, index).some((earlier) => {
    if (earlier.type !== event.type || earlier.clipId !== event.clipId) return false;
    const overlaps = Math.min(earlier.endMs, event.endMs) - Math.max(earlier.startMs, event.startMs) >= 0;
    const nearlySameTime = Math.abs(earlier.startMs - event.startMs) <= 500;
    const sameTarget = Boolean(earlier.target && event.target && earlier.target.toLocaleLowerCase() === event.target.toLocaleLowerCase());
    const earlierActors = new Set(earlier.actors.map((actor) => actor.toLocaleLowerCase()));
    const actorOverlap = event.actors.some((actor) => earlierActors.has(actor.toLocaleLowerCase()));
    const sameTitle = earlier.title.toLocaleLowerCase() === event.title.toLocaleLowerCase();
    return (overlaps || nearlySameTime) && (sameTitle || sameTarget || actorOverlap);
  }));
  return {
    gameTitle: cleanText(raw.gameTitle, request.priorContext?.gameTitle || "Unknown game", 120),
    gameMode: cleanText(raw.gameMode, request.priorContext?.gameMode || "Unknown mode", 120),
    contextSummary: cleanText(raw.contextSummary, "No reliable segment summary.", 600),
    events,
  };
}

export async function indexGameplaySegment(
  value: unknown,
  config: GameplaySearchOpenAIConfig,
): Promise<GameplaySegmentIndex> {
  const request = validateIndexGameplaySegmentRequest(value);
  const frameContent = request.frames.flatMap((frame) => [
    {
      type: "input_text" as const,
      text: `EVIDENCE ${frame.id} at ${frame.timestampMs}ms; selection=${frame.reason}`,
    },
    {
      type: "input_image" as const,
      image_url: frame.imageDataUrl,
      detail: frame.detail,
    },
  ]);
  const response = await requestStructured<unknown>(
    config,
    "unseen_gameplay_segment_index",
    GAMEPLAY_INDEX_SCHEMA,
    [
      "Index one segment of a gameplay recording without relying on a game-specific preset.",
      "Infer the game and mode only when the frames support them. Detect eliminations, assists, deaths, objectives, clutches, mistakes, observable reactions, dialogue, transitions, and other meaningful events.",
      "Every event must cite supplied frame IDs. Cite transcript IDs only when their text directly supports the event. Preserve exact source timestamps. Read player names from visible HUD text only; use an empty actor list or null target when identity is unreadable.",
      "Treat audio RMS and peak values only as timing signals, not proof of a specific sound or emotion. Do not infer intent, hidden actions, identity, or causality. It is valid to return zero events when evidence is weak.",
      "Use integer importance from 0 to 100 and confidence from 0 to 1.",
    ].join("\n"),
    [{
      role: "user",
      content: [
        {
          type: "input_text",
          text: JSON.stringify({
            clip: request.clip,
            segment: request.segment,
            priorContext: request.priorContext,
            audioFeatures: request.audioFeatures,
            transcriptSegments: request.transcriptSegments,
          }),
        },
        ...frameContent,
      ],
    }],
    3_400,
  );
  const validated = validateIndexedEvents(response.payload, request);
  return {
    clipId: request.clip.id,
    segmentId: request.segment.id,
    segmentStartMs: request.segment.startMs,
    segmentEndMs: request.segment.endMs,
    ...validated,
    evidenceFrameIds: request.frames.map((frame) => frame.id),
    transcriptSegmentIds: request.transcriptSegments.map((segment) => segment.id),
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

function validateSegments(value: unknown, clips: GameplayClipMetadata[]): GameplaySegmentIndex[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("indexed segments are required.");
  const clipMap = new Map(clips.map((clip) => [clip.id, clip]));
  const eventIds = new Set<string>();
  const segments = value.slice(0, 240).map((segment) => {
    if (!record(segment) || !record(segment.api) || segment.api.real !== true || typeof segment.api.responseId !== "string" || !segment.api.responseId || !Array.isArray(segment.events)) {
      throw new TypeError("Every segment must come from a completed AI index response.");
    }
    const clipId = cleanText(segment.clipId, "", 120);
    const clip = clipMap.get(clipId);
    if (!clip) throw new TypeError("An indexed segment references an unknown clip.");
    const segmentId = cleanText(segment.segmentId, "", 160);
    const segmentStartMs = clamp(numberOrZero(segment.segmentStartMs), 0, clip.durationMs);
    const segmentEndMs = clamp(numberOrZero(segment.segmentEndMs), segmentStartMs, clip.durationMs);
    const evidenceFrameIds = Array.isArray(segment.evidenceFrameIds)
      ? segment.evidenceFrameIds.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, GAMEPLAY_SEARCH_LIMITS.maximumFramesPerSegment)
      : [];
    const transcriptSegmentIds = Array.isArray(segment.transcriptSegmentIds)
      ? segment.transcriptSegmentIds.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, 240)
      : [];
    if (evidenceFrameIds.length < 2) throw new TypeError("Every indexed segment requires its evidence frame catalog.");
    const evidenceFrameSet = new Set(evidenceFrameIds);
    const transcriptSegmentSet = new Set(transcriptSegmentIds);
    const events = segment.events.filter(record).map((event) => {
      const id = cleanText(event.id, "", 180);
      if (!id || eventIds.has(id)) throw new TypeError("Indexed event IDs must be unique.");
      if (!id.startsWith(`${segmentId}-`) || cleanText(event.clipId, "", 120) !== clipId || cleanText(event.segmentId, "", 160) !== segmentId) {
        throw new TypeError("An indexed event references an unknown clip or segment.");
      }
      eventIds.add(id);
      const startMs = clamp(numberOrZero(event.startMs), segmentStartMs, segmentEndMs);
      const type = EVENT_TYPES.includes(event.type as GameplayEventType) ? event.type as GameplayEventType : "other";
      const evidenceFrameIds = Array.isArray(event.evidenceFrameIds)
        ? event.evidenceFrameIds.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, 24)
        : [];
      if (evidenceFrameIds.length === 0 || evidenceFrameIds.some((id) => !evidenceFrameSet.has(id))) {
        throw new TypeError("An indexed event references an unknown frame.");
      }
      const eventTranscriptIds = Array.isArray(event.transcriptSegmentIds)
        ? event.transcriptSegmentIds.filter((id): id is string => typeof id === "string").slice(0, 20)
        : [];
      if (eventTranscriptIds.some((id) => !transcriptSegmentSet.has(id))) {
        throw new TypeError("An indexed event references an unknown transcript.");
      }
      return {
        id,
        clipId,
        segmentId,
        startMs,
        endMs: clamp(Math.max(startMs, numberOrZero(event.endMs)), startMs, segmentEndMs),
        type,
        title: cleanText(event.title, "Gameplay event", 120),
        description: cleanText(event.description, "", 600),
        actors: Array.isArray(event.actors) ? event.actors.filter((actor): actor is string => typeof actor === "string").slice(0, 8) : [],
        target: typeof event.target === "string" ? event.target.slice(0, 80) : null,
        ocrText: cleanText(event.ocrText, "", 500),
        importance: clamp(numberOrZero(event.importance), 0, 100),
        confidence: clamp(numberOrZero(event.confidence), 0, 1),
        evidenceFrameIds,
        transcriptSegmentIds: eventTranscriptIds,
      } satisfies GameplayEvent;
    });
    return {
      clipId,
      segmentId,
      segmentStartMs,
      segmentEndMs,
      gameTitle: cleanText(segment.gameTitle, "Unknown game", 120),
      gameMode: cleanText(segment.gameMode, "Unknown mode", 120),
      contextSummary: cleanText(segment.contextSummary, "", 600),
      evidenceFrameIds,
      transcriptSegmentIds,
      events,
      api: segment.api as GameplaySegmentIndex["api"],
    } satisfies GameplaySegmentIndex;
  });
  const totalEvents = segments.reduce((sum, segment) => sum + segment.events.length, 0);
  if (totalEvents > GAMEPLAY_SEARCH_LIMITS.maximumIndexedEvents) throw new TypeError("The gameplay index is too large.");
  return segments;
}

function validateSearchRequest(value: unknown): SearchGameplayRequest {
  if (!record(value) || typeof value.query !== "string" || !Array.isArray(value.clips)) {
    throw new TypeError("query, clips, and indexed segments are required.");
  }
  const query = value.query.trim();
  if (query.length < 3 || query.length > 500) throw new TypeError("query must contain 3-500 characters.");
  if (value.clips.length > GAMEPLAY_SEARCH_LIMITS.maximumClips) throw new TypeError("Too many gameplay clips.");
  const clips = value.clips.map(validateClipMetadata);
  validateClipCollection(clips);
  return { query, clips, segments: validateSegments(value.segments, clips) };
}

function compactEvents(segments: GameplaySegmentIndex[]) {
  return segments.flatMap((segment) => segment.events.map((event) => ({
    id: event.id,
    clipId: event.clipId,
    startMs: event.startMs,
    endMs: event.endMs,
    type: event.type,
    title: event.title,
    description: event.description,
    actors: event.actors,
    target: event.target,
    ocrText: event.ocrText,
    importance: event.importance,
    confidence: event.confidence,
    gameTitle: segment.gameTitle,
    gameMode: segment.gameMode,
  })));
}

export async function searchGameplay(
  value: unknown,
  config: GameplaySearchOpenAIConfig,
): Promise<GameplaySearchResponse> {
  const request = validateSearchRequest(value);
  const events = request.segments.flatMap((segment) => segment.events);
  const eventMap = new Map(events.map((event) => [event.id, event]));
  const response = await requestStructured<unknown>(
    config,
    "unseen_gameplay_search",
    GAMEPLAY_SEARCH_SCHEMA,
    [
      "Search an evidence-backed gameplay event index using the player's natural-language request.",
      "Return up to five ranked event IDs. Match exact visible player names, OCR text, semantic event descriptions, game state, and requested mood only when the index supports them.",
      "Never invent an event, player, timestamp, or causal explanation. If no supplied event directly or reasonably matches, return answerType insufficient_evidence with an empty hits array.",
    ].join("\n"),
    JSON.stringify({ query: request.query, clips: request.clips, events: compactEvents(request.segments) }),
    1_800,
  );
  if (!record(response.payload) || !Array.isArray(response.payload.hits)) {
    throw new GameplaySearchOpenAIError("OpenAI gameplay search failed validation.", "OPENAI_INVALID_OUTPUT");
  }
  const answerType = response.payload.answerType === "matches" ? "matches" : "insufficient_evidence";
  const seen = new Set<string>();
  const hits: GameplaySearchHit[] = response.payload.hits.filter(record).map((item) => {
    const event = eventMap.get(cleanText(item.eventId, "", 180));
    if (!event) throw new GameplaySearchOpenAIError("OpenAI returned an unknown gameplay event ID.", "OPENAI_INVALID_OUTPUT");
    if (seen.has(event.id)) return null;
    seen.add(event.id);
    return {
      eventId: event.id,
      clipId: event.clipId,
      startMs: event.startMs,
      endMs: event.endMs,
      title: cleanText(item.title, event.title, 120),
      whyMatch: cleanText(item.whyMatch, event.description, 500),
      confidence: clamp(numberOrZero(item.confidence), 0, 1),
      evidenceFrameIds: event.evidenceFrameIds,
      transcriptSegmentIds: event.transcriptSegmentIds,
    } satisfies GameplaySearchHit;
  }).filter((hit): hit is GameplaySearchHit => Boolean(hit)).slice(0, GAMEPLAY_SEARCH_LIMITS.maximumSearchHits);
  if (answerType === "matches" && hits.length === 0) {
    throw new GameplaySearchOpenAIError("OpenAI returned a match without valid event evidence.", "OPENAI_INVALID_OUTPUT");
  }
  return {
    query: request.query,
    answerType: hits.length > 0 ? "matches" : "insufficient_evidence",
    summary: cleanText(response.payload.summary, hits.length ? "Evidence-backed matches found." : "No indexed moment reliably matches that search.", 600),
    hits,
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

function validateHighlightRequest(value: unknown): PlanHighlightsRequest {
  if (!record(value) || !Array.isArray(value.clips)) throw new TypeError("highlight request is invalid.");
  if (value.clips.length > GAMEPLAY_SEARCH_LIMITS.maximumClips) throw new TypeError("Too many gameplay clips.");
  const clips = value.clips.map(validateClipMetadata);
  validateClipCollection(clips);
  const targetDurationMs = [30_000, 60_000, 90_000].includes(numberOrZero(value.targetDurationMs))
    ? numberOrZero(value.targetDurationMs) as PlanHighlightsRequest["targetDurationMs"]
    : 60_000;
  const aspectRatio = value.aspectRatio === "9:16" ? "9:16" : "16:9";
  const prompt = cleanText(value.prompt, "Select the most important, varied, and entertaining moments.", 500);
  const segments = validateSegments(value.segments, clips);
  const selectedEventIds = Array.isArray(value.selectedEventIds)
    ? value.selectedEventIds.filter((id): id is string => typeof id === "string").slice(0, 30)
    : [];
  return { prompt, targetDurationMs, aspectRatio, clips, segments, selectedEventIds };
}

export function compileHighlightPlan(
  raw: unknown,
  request: PlanHighlightsRequest,
  response: ResponseEnvelope<unknown>,
): HighlightPlan {
  if (!record(raw) || !Array.isArray(raw.beats)) {
    throw new GameplaySearchOpenAIError("OpenAI highlight plan failed validation.", "OPENAI_INVALID_OUTPUT");
  }
  const clips = new Map(request.clips.map((clip) => [clip.id, clip]));
  const events = request.segments.flatMap((segment) => segment.events);
  const eventMap = new Map(events.map((event) => [event.id, event]));
  const usedEvents = new Set<string>();
  let remainingMs = request.targetDurationMs;
  const beats: HighlightBeat[] = [];
  for (const item of raw.beats.filter(record)) {
    const event = eventMap.get(cleanText(item.eventId, "", 180));
    if (!event) throw new GameplaySearchOpenAIError("OpenAI returned an unknown highlight event ID.", "OPENAI_INVALID_OUTPUT");
    if (usedEvents.has(event.id) || remainingMs < 1_500) continue;
    const clip = clips.get(event.clipId);
    if (!clip) continue;
    let startMs = clamp(numberOrZero(item.startMs), Math.max(0, event.startMs - 3_000), Math.min(clip.durationMs, event.endMs + 5_000));
    let endMs = clamp(numberOrZero(item.endMs), startMs, Math.min(clip.durationMs, event.endMs + 5_000));
    if (endMs - startMs < 3_000) {
      startMs = Math.max(0, Math.min(startMs, event.startMs - 1_500));
      endMs = Math.min(clip.durationMs, Math.max(endMs, startMs + 3_000, event.endMs + 1_500));
    }
    if (endMs - startMs > 12_000) endMs = startMs + 12_000;
    const durationMs = Math.min(endMs - startMs, remainingMs);
    if (durationMs < 1_500) continue;
    endMs = startMs + durationMs;
    const overlaps = beats.some((beat) => beat.clipId === event.clipId && Math.min(beat.endMs, endMs) - Math.max(beat.startMs, startMs) > durationMs * 0.7);
    if (overlaps) continue;
    usedEvents.add(event.id);
    beats.push({
      order: beats.length + 1,
      eventId: event.id,
      clipId: event.clipId,
      startMs,
      endMs,
      caption: cleanText(item.caption, event.title, 140),
    });
    remainingMs -= durationMs;
    if (beats.length >= 18 || remainingMs < 1_500) break;
  }
  if (beats.length === 0) {
    throw new GameplaySearchOpenAIError("OpenAI could not create a highlight plan from the indexed evidence.", "OPENAI_INVALID_OUTPUT");
  }
  return {
    id: `highlight-${response.responseId || crypto.randomUUID()}`,
    title: cleanText(raw.title, "UNSEEN Gameplay Highlights", 100),
    targetDurationMs: request.targetDurationMs,
    estimatedDurationMs: beats.reduce((sum, beat) => sum + beat.endMs - beat.startMs, 0),
    aspectRatio: request.aspectRatio,
    beats,
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

export async function planGameplayHighlights(
  value: unknown,
  config: GameplaySearchOpenAIConfig,
): Promise<HighlightPlan> {
  const request = validateHighlightRequest(value);
  const allEvents = request.segments.flatMap((segment) => segment.events);
  const selected = new Set(request.selectedEventIds);
  const availableEvents = selected.size > 0 ? allEvents.filter((event) => selected.has(event.id)) : allEvents;
  if (availableEvents.length === 0) throw new TypeError("No indexed events are available for this reel.");
  const response = await requestStructured<unknown>(
    config,
    "unseen_highlight_plan",
    HIGHLIGHT_PLAN_SCHEMA,
    [
      "Create a concise, varied highlight edit plan from evidence-backed gameplay events.",
      "Choose only supplied event IDs. Prefer meaningful action, narrative progression, observable reactions, and variety. Avoid overlapping or repetitive beats.",
      "Each beat should normally run 3-12 seconds and may add at most three seconds before and five seconds after its event for context. Captions must describe only supplied evidence and fit on two short lines.",
      "Do not invent footage, dialogue, players, outcomes, or timestamps. A deterministic renderer will validate and clamp every cut.",
    ].join("\n"),
    JSON.stringify({
      prompt: request.prompt,
      targetDurationMs: request.targetDurationMs,
      aspectRatio: request.aspectRatio,
      clips: request.clips,
      events: availableEvents.map((event) => ({
        id: event.id,
        clipId: event.clipId,
        startMs: event.startMs,
        endMs: event.endMs,
        type: event.type,
        title: event.title,
        description: event.description,
        actors: event.actors,
        target: event.target,
        importance: event.importance,
        confidence: event.confidence,
      })),
    }),
    2_200,
  );
  return compileHighlightPlan(response.payload, request, response);
}

export async function transcribeGameplayAudio(
  audio: Blob,
  clipId: string,
  chunkStartMs: number,
  config: GameplaySearchOpenAIConfig,
): Promise<TranscribeGameplayAudioResponse> {
  if (!clipId || chunkStartMs < 0 || audio.size <= 0 || audio.size > GAMEPLAY_SEARCH_LIMITS.maximumAudioChunkBytes) {
    throw new TypeError("audio chunk metadata is invalid.");
  }
  const model = config.transcriptionModel ?? "whisper-1";
  const form = new FormData();
  form.append("file", audio, "gameplay-audio.webm");
  form.append("model", model);
  form.append("response_format", model === "whisper-1" ? "verbose_json" : "json");
  if (model === "whisper-1") form.append("timestamp_granularities[]", "segment");
  const response = await fetchWithTimeout(config, TRANSCRIPTIONS_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
  });
  const requestId = response.headers.get("x-request-id") ?? "";
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new GameplaySearchOpenAIError(
      safeMessage(body, `OpenAI transcription returned HTTP ${response.status}.`),
      "OPENAI_ERROR",
      502,
      requestId,
    );
  }
  const rawSegments = record(body) && Array.isArray(body.segments) ? body.segments : [];
  const segments: GameplayTranscriptSegment[] = rawSegments.filter(record).map((segment, index) => {
    const startMs = chunkStartMs + Math.max(0, numberOrZero(segment.start) * 1_000);
    const endMs = chunkStartMs + Math.max(numberOrZero(segment.start), numberOrZero(segment.end)) * 1_000;
    return {
      id: `${clipId}-transcript-${chunkStartMs}-${index + 1}`,
      clipId,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      text: cleanText(segment.text, "", 1_000),
    };
  }).filter((segment) => segment.text);
  if (segments.length === 0 && record(body) && typeof body.text === "string" && body.text.trim()) {
    segments.push({
      id: `${clipId}-transcript-${chunkStartMs}-1`,
      clipId,
      startMs: chunkStartMs,
      endMs: chunkStartMs,
      text: body.text.trim().slice(0, 4_000),
    });
  }
  return {
    clipId,
    chunkStartMs,
    segments,
    api: { real: true, requestId, model },
  };
}
