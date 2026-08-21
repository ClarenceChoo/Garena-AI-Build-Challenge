"use client";

import {
  ChangeEvent,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createConsentedAudioChunk,
  extractAdaptiveSegmentEvidence,
  readGameplayDuration,
  renderGameplayReel,
  transcriptsForSegment,
} from "@/lib/gameplay-search-client";
import { createConcurrencyGate } from "@/lib/bounded-concurrency.js";
import {
  createSegmentWindows,
  deduplicateOverlappingSegments,
  partitionSeedJobs,
  selectGameplaySegmentationMode,
  stablePriorContextByClip,
} from "@/lib/gameplay-index-scheduling.js";
import type {
  GameplayClipMetadata,
  GameplaySearchResponse,
  GameplaySegmentIndex,
  GameplayTranscriptSegment,
  HighlightAspectRatio,
  HighlightDurationMs,
  HighlightPlan,
  TranscribeGameplayAudioResponse,
} from "@/lib/gameplay-search-types";
import { GAMEPLAY_SEARCH_LIMITS } from "@/lib/gameplay-search-types";
import { GameplayPostGameReview } from "./gameplay-post-review";
import "./gameplay-search-workbench.css";

type IndexStatus = "pending" | "running" | "complete" | "failed" | "canceled";
type WorkbenchState = "idle" | "indexing" | "ready" | "partial" | "error";
type ToolTab = "clips" | "search" | "coach" | "highlights";

const TOOL_TABS: Array<{ id: ToolTab; label: string }> = [
  { id: "clips", label: "Clips" },
  { id: "search", label: "Search" },
  { id: "coach", label: "Coach" },
  { id: "highlights", label: "Highlights" },
];

export interface GameplayIndexSnapshot {
  clips: GameplayClipMetadata[];
  segments: GameplaySegmentIndex[];
  eventCount: number;
  isReady: boolean;
}

interface GameplaySearchWorkbenchProps {
  onIndexChange?: (snapshot: GameplayIndexSnapshot) => void;
}

interface GameplayClip extends GameplayClipMetadata {
  file: File;
  url: string;
  transcripts: GameplayTranscriptSegment[];
}

interface SegmentJob {
  id: string;
  clipId: string;
  startMs: number;
  endMs: number;
  status: IndexStatus;
  attempts: number;
  message: string;
}

interface SearchBackendStatus {
  configured: boolean;
  models: {
    search?: string;
    searchTranscription?: string;
    vision: string;
  } | null;
}

interface ApiFailure {
  error?: { message?: string; requestId?: string };
}

const GIB = 1024 * 1024 * 1024;
const MAXIMUM_INDEX_API_CONCURRENCY = 8;
const MAXIMUM_LOCAL_MEDIA_CONCURRENCY = 2;
const MAXIMUM_TRANSCRIPTION_API_CONCURRENCY = 4;
const FAST_DEMO_MAXIMUM_TOTAL_DURATION_MS = 2 * 60_000;

class IndexRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs: number,
  ) {
    super(message);
    this.name = "IndexRequestError";
  }
}

function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function readableBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(2)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function cleanLabel(filename: string, index: number): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || `Gameplay ${index + 1}`;
}

async function apiError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as ApiFailure | null;
  const message = body?.error?.message || `Request failed with HTTP ${response.status}.`;
  return body?.error?.requestId ? `${message} Request ${body.error.requestId}` : message;
}

function retryAfterMilliseconds(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

async function indexApiError(response: Response): Promise<IndexRequestError> {
  return new IndexRequestError(
    await apiError(response),
    response.status,
    retryAfterMilliseconds(response.headers.get("retry-after")),
  );
}

function indexWorkerCount(jobCount: number): number {
  return Math.max(1, Math.min(jobCount, MAXIMUM_INDEX_API_CONCURRENCY));
}

function localMediaWorkerCount(jobCount: number): number {
  const logicalCores = typeof navigator === "undefined" ? 8 : navigator.hardwareConcurrency || 8;
  const deviceBudget = logicalCores <= 4 ? 1 : MAXIMUM_LOCAL_MEDIA_CONCURRENCY;
  return Math.max(1, Math.min(jobCount, deviceBudget));
}

function transcriptionWorkerCount(jobCount: number): number {
  return Math.max(1, Math.min(jobCount, MAXIMUM_TRANSCRIPTION_API_CONCURRENCY));
}

function isRetryableIndexError(error: unknown): boolean {
  if (error instanceof IndexRequestError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
}

async function waitForIndexRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Indexing canceled.", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function dominantContext(segments: GameplaySegmentIndex[]): { game: string; mode: string } {
  const scores = new Map<string, { game: string; mode: string; count: number }>();
  for (const segment of segments) {
    const game = segment.gameTitle.trim() || "Unknown game";
    const mode = segment.gameMode.trim() || "Unknown mode";
    if (/^unknown/i.test(game)) continue;
    const key = `${game}\u0000${mode}`;
    const current = scores.get(key);
    scores.set(key, { game, mode, count: (current?.count ?? 0) + 1 });
  }
  return [...scores.values()].sort((a, b) => b.count - a.count)[0] ?? {
    game: "Not reliably detected",
    mode: "Unknown mode",
  };
}

function compareIndexedSegments(a: GameplaySegmentIndex, b: GameplaySegmentIndex): number {
  return a.clipId.localeCompare(b.clipId) || a.segmentStartMs - b.segmentStartMs;
}

export function GameplaySearchWorkbench({ onIndexChange }: GameplaySearchWorkbenchProps = {}) {
  const [activeTab, setActiveTab] = useState<ToolTab>("clips");
  const [clips, setClips] = useState<GameplayClip[]>([]);
  const [permissionConfirmed, setPermissionConfirmed] = useState(false);
  const [voiceAnalysisEnabled, setVoiceAnalysisEnabled] = useState(false);
  const [fastDemoEnabled, setFastDemoEnabled] = useState(true);
  const [backend, setBackend] = useState<SearchBackendStatus | null>(null);
  const [state, setState] = useState<WorkbenchState>("idle");
  const [message, setMessage] = useState("Add up to four gameplay videos to build a private, temporary index.");
  const [jobs, setJobs] = useState<SegmentJob[]>([]);
  const [segments, setSegments] = useState<GameplaySegmentIndex[]>([]);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<GameplaySearchResponse | null>(null);
  const [searchError, setSearchError] = useState("");
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([]);
  const [reelPrompt, setReelPrompt] = useState("Create a varied squad highlight reel with the strongest action and reactions.");
  const [reelDuration, setReelDuration] = useState<HighlightDurationMs>(60_000);
  const [reelAspect, setReelAspect] = useState<HighlightAspectRatio>("16:9");
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<HighlightPlan | null>(null);
  const [reelState, setReelState] = useState<"idle" | "rendering" | "ready" | "error">("idle");
  const [reelProgress, setReelProgress] = useState(0);
  const [reelError, setReelError] = useState("");
  const [download, setDownload] = useState<{ url: string; name: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const clipsRef = useRef<GameplayClip[]>([]);
  const segmentsRef = useRef<GameplaySegmentIndex[]>([]);
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());
  const indexingAbort = useRef<AbortController | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const planningAbort = useRef<AbortController | null>(null);
  const renderingAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  useEffect(() => {
    let canceled = false;
    void fetch("/api/analyze/status", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Status request failed.");
        return await response.json() as SearchBackendStatus;
      })
      .then((status) => {
        if (!canceled) {
          setBackend(status);
          if (!status.configured) setMessage("Add OPENAI_API_KEY to enable gameplay indexing.");
        }
      })
      .catch(() => {
        if (!canceled) {
          setBackend(null);
          setMessage("Backend status is unavailable. Restart the development server and try again.");
        }
      });
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => () => {
    indexingAbort.current?.abort();
    searchAbort.current?.abort();
    planningAbort.current?.abort();
    renderingAbort.current?.abort();
    clipsRef.current.forEach((clip) => URL.revokeObjectURL(clip.url));
  }, []);

  useEffect(() => () => {
    if (download) URL.revokeObjectURL(download.url);
  }, [download]);

  useEffect(() => {
    for (const tab of TOOL_TABS) {
      if (tab.id === activeTab) continue;
      document
        .querySelectorAll<HTMLVideoElement>(`#unseen-tool-panel-${tab.id} video`)
        .forEach((video) => video.pause());
    }
  }, [activeTab]);

  const totalBytes = useMemo(() => clips.reduce((sum, clip) => sum + clip.file.size, 0), [clips]);
  const totalDurationMs = useMemo(() => clips.reduce((sum, clip) => sum + clip.durationMs, 0), [clips]);
  const segmentationMode = selectGameplaySegmentationMode(
    totalDurationMs,
    fastDemoEnabled,
    FAST_DEMO_MAXIMUM_TOTAL_DURATION_MS,
  );
  const fastDemoEligible = totalDurationMs <= FAST_DEMO_MAXIMUM_TOTAL_DURATION_MS;
  const fastDemoActive = segmentationMode === "fast";
  const completedJobs = jobs.filter((job) => job.status === "complete").length;
  const failedJobs = jobs.filter((job) => job.status === "failed").length;
  const canceledJobs = jobs.filter((job) => job.status === "canceled").length;
  const retryableJobs = failedJobs + canceledJobs;
  const indexProgress = jobs.length ? Math.round((completedJobs + failedJobs) / jobs.length * 100) : 0;
  const eventCount = segments.reduce((sum, segment) => sum + segment.events.length, 0);
  const context = useMemo(() => dominantContext(segments), [segments]);
  const metadata = useMemo<GameplayClipMetadata[]>(() => clips.map(({ id, name, label, durationMs, sizeBytes }) => ({
    id,
    name,
    label,
    durationMs,
    sizeBytes,
  })), [clips]);
  const reviewSources = useMemo(() => clips.map(({ id, name, label, durationMs, sizeBytes, url }) => ({
    id,
    name,
    label,
    durationMs,
    sizeBytes,
    url,
  })), [clips]);
  const reviewRevision = useMemo(() => [
    state === "partial" ? "partial" : "complete",
    voiceAnalysisEnabled ? "voice" : "silent",
    clips.map((clip) => `${clip.id}:${clip.label}`).join("|"),
    segments.map((segment) => `${segment.segmentId}:${segment.api.responseId}:${segment.events.length}`).join("|"),
  ].join("::"), [clips, segments, state, voiceAnalysisEnabled]);
  useEffect(() => {
    onIndexChange?.({
      clips: metadata,
      segments,
      eventCount,
      isReady: (state === "ready" || state === "partial") && segments.length > 0,
    });
  }, [eventCount, metadata, onIndexChange, segments, state]);
  const canIndex = clips.length >= 1
    && clips.length <= GAMEPLAY_SEARCH_LIMITS.maximumClips
    && totalBytes <= GAMEPLAY_SEARCH_LIMITS.maximumTotalFileBytes
    && totalDurationMs <= GAMEPLAY_SEARCH_LIMITS.maximumTotalDurationMs
    && permissionConfirmed
    && backend?.configured === true
    && state !== "indexing";
  const canRetryIndex = canIndex && retryableJobs > 0;
  const indexFinalized = (state === "ready" || state === "partial") && segments.length > 0;

  const toolStatuses: Record<ToolTab, string> = {
    clips: state === "indexing"
      ? `${indexProgress}%`
      : retryableJobs > 0
        ? `${retryableJobs} retry`
        : segments.length > 0
          ? "Ready"
          : clips.length > 0
            ? `${clips.length} added`
            : "Add clips",
    search: state === "indexing"
      ? `${completedJobs}/${jobs.length} windows`
      : indexFinalized && eventCount > 0
        ? `${eventCount} events`
        : "Index first",
    coach: eventCount > 0 && (state === "ready" || state === "partial") ? "Ready" : "Index first",
    highlights: download
      ? "Download"
      : reelState === "rendering"
        ? `${Math.round(reelProgress * 100)}%`
        : state === "indexing"
          ? "Indexing"
          : selectedEventIds.length > 0
            ? `${selectedEventIds.length} pinned`
            : indexFinalized && eventCount > 0
              ? "Ready"
              : "Index first",
  };

  function handleToolTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, tab: ToolTab) {
    const currentIndex = TOOL_TABS.findIndex((candidate) => candidate.id === tab);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % TOOL_TABS.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + TOOL_TABS.length) % TOOL_TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TOOL_TABS.length - 1;
    else return;
    event.preventDefault();
    const next = TOOL_TABS[nextIndex].id;
    setActiveTab(next);
    document.getElementById(`unseen-tool-tab-${next}`)?.focus();
  }

  function focusToolTab(tab: ToolTab) {
    setActiveTab(tab);
    window.requestAnimationFrame(() => {
      document.getElementById(`unseen-tool-tab-${tab}`)?.focus();
    });
  }

  function clearDerivedOutputs() {
    searchAbort.current?.abort();
    planningAbort.current?.abort();
    renderingAbort.current?.abort();
    setSearching(false);
    setPlanning(false);
    setSearchResult(null);
    setSearchError("");
    setSelectedEventIds([]);
    setPlan(null);
    setReelState("idle");
    setReelProgress(0);
    setReelError("");
    if (download) URL.revokeObjectURL(download.url);
    setDownload(null);
  }

  function resetDerivedState() {
    clearDerivedOutputs();
    setJobs([]);
    segmentsRef.current = [];
    setSegments([]);
  }

  async function addFiles(event: ChangeEvent<HTMLInputElement>) {
    if (state === "indexing") return;
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!selected.length) return;
    const accepted = selected.slice(0, GAMEPLAY_SEARCH_LIMITS.maximumClips - clips.length);
    const next: GameplayClip[] = [];
    let runningBytes = totalBytes;
    let runningDuration = totalDurationMs;
    for (const file of accepted) {
      if (!file.type.startsWith("video/") && !/\.(mp4|mov|webm|mkv)$/i.test(file.name)) {
        setState("error");
        setMessage(`${file.name} is not a supported gameplay video.`);
        continue;
      }
      if (runningBytes + file.size > GAMEPLAY_SEARCH_LIMITS.maximumTotalFileBytes) {
        setState("error");
        setMessage("The selected files exceed the 2 GB session limit.");
        break;
      }
      try {
        const durationMs = await readGameplayDuration(file);
        if (durationMs <= 0 || runningDuration + durationMs > GAMEPLAY_SEARCH_LIMITS.maximumTotalDurationMs) {
          setState("error");
          setMessage("The selected files exceed the 60-minute session limit.");
          break;
        }
        const index = clips.length + next.length;
        next.push({
          id: `gameplay-${crypto.randomUUID()}`,
          file,
          url: URL.createObjectURL(file),
          name: file.name,
          label: cleanLabel(file.name, index),
          durationMs,
          sizeBytes: file.size,
          transcripts: [],
        });
        runningBytes += file.size;
        runningDuration += durationMs;
      } catch (error) {
        setState("error");
        setMessage(error instanceof Error ? error.message : `${file.name} could not be decoded.`);
      }
    }
    if (next.length) {
      resetDerivedState();
      setClips((current) => [...current, ...next]);
      setState("idle");
      setMessage(fastDemoEnabled && runningDuration > FAST_DEMO_MAXIMUM_TOTAL_DURATION_MS
        ? `${next.length} source${next.length === 1 ? "" : "s"} added. This session exceeds 2:00, so Standard indexing will be used.`
        : `${next.length} source${next.length === 1 ? "" : "s"} added. Raw video remains on this device.`);
    }
  }

  function removeClip(id: string) {
    if (state === "indexing") return;
    const target = clips.find((clip) => clip.id === id);
    if (target) URL.revokeObjectURL(target.url);
    setClips((current) => current.filter((clip) => clip.id !== id));
    resetDerivedState();
    setState("idle");
    setMessage("Source removed. Re-index to search the updated session.");
  }

  function updateClipLabel(id: string, label: string) {
    setClips((current) => current.map((clip) => clip.id === id ? { ...clip, label } : clip));
  }

  function updateJob(id: string, patch: Partial<SegmentJob>) {
    setJobs((current) => current.map((job) => job.id === id ? { ...job, ...patch } : job));
  }

  function createJobs(): SegmentJob[] {
    return clips.flatMap((clip) => {
      const windows = createSegmentWindows(clip.durationMs, segmentationMode);
      return windows.map(({ startMs, endMs }, index) => ({
        id: `${clip.id}-segment-${String(index + 1).padStart(3, "0")}`,
        clipId: clip.id,
        startMs,
        endMs,
        status: "pending",
        attempts: 0,
        message: "Queued",
      }));
    });
  }

  async function transcribeConsentedAudio(
    controller: AbortController,
  ): Promise<Map<string, GameplayTranscriptSegment[]>> {
    const transcriptMap = new Map(clips.map((clip) => [clip.id, [] as GameplayTranscriptSegment[]]));
    const work = clips.flatMap((clip) => {
      const chunks: Array<{ clip: GameplayClip; startMs: number; endMs: number }> = [];
      for (
        let startMs = 0;
        startMs < clip.durationMs;
        startMs += GAMEPLAY_SEARCH_LIMITS.audioChunkDurationMs
      ) {
        chunks.push({
          clip,
          startMs,
          endMs: Math.min(clip.durationMs, startMs + GAMEPLAY_SEARCH_LIMITS.audioChunkDurationMs),
        });
      }
      return chunks;
    });
    if (!work.length) return transcriptMap;

    let cursor = 0;
    let finished = 0;
    let fatalError: unknown = null;
    const clipsWithoutAudio = new Set<string>();
    const workerCount = transcriptionWorkerCount(work.length);
    const extractionGate = createConcurrencyGate(localMediaWorkerCount(work.length));
    const worker = async () => {
      while (cursor < work.length && !fatalError) {
        const job = work[cursor];
        cursor += 1;
        try {
          setMessage(`Preparing voice evidence · ${finished}/${work.length} chunks · ${workerCount} calls in parallel`);
          const audio = await extractionGate.run(
            () => clipsWithoutAudio.has(job.clip.id)
              ? null
              : createConsentedAudioChunk(
                job.clip.file,
                job.startMs,
                job.endMs,
                controller.signal,
              ),
            controller.signal,
          );
          if (!audio) {
            clipsWithoutAudio.add(job.clip.id);
            finished += 1;
            continue;
          }
          if (audio.size > GAMEPLAY_SEARCH_LIMITS.maximumAudioChunkBytes) {
            throw new Error(`${job.clip.label} produced an audio chunk larger than 25 MB. Shorten the source and try again.`);
          }
          const form = new FormData();
          form.append("file", audio, `${job.clip.id}-${job.startMs}.webm`);
          form.append("clipId", job.clip.id);
          form.append("chunkStartMs", String(job.startMs));
          form.append("voiceConsent", "true");
          setMessage(`Transcribing voice chat · ${finished}/${work.length} chunks · ${workerCount} calls in parallel`);
          const response = await fetch("/api/analyze/transcribe", {
            method: "POST",
            body: form,
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(await apiError(response));
          const result = await response.json() as TranscribeGameplayAudioResponse;
          if (result.api.real !== true || result.clipId !== job.clip.id) {
            throw new Error("The voice transcript response was not verifiable.");
          }
          transcriptMap.get(job.clip.id)?.push(...result.segments);
          finished += 1;
        } catch (error) {
          fatalError ??= error;
        }
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (fatalError) throw fatalError;
    for (const transcript of transcriptMap.values()) {
      transcript.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    }
    setClips((current) => current.map((clip) => ({
      ...clip,
      transcripts: transcriptMap.get(clip.id) ?? [],
    })));
    return transcriptMap;
  }

  async function processJobs(
    work: SegmentJob[],
    transcriptMap: Map<string, GameplayTranscriptSegment[]>,
    controller: AbortController,
    fastMode: boolean,
  ) {
    const failed = new Set<string>();
    const completed = new Map(segmentsRef.current.map((segment) => [segment.segmentId, segment]));
    const extractionConcurrency = localMediaWorkerCount(work.length);
    const extractionGate = createConcurrencyGate(extractionConcurrency);
    const schedule = fastMode
      ? { seedJobs: [] as SegmentJob[], parallelJobs: work }
      : partitionSeedJobs(work, [...completed.values()]);
    const { seedJobs, parallelJobs } = schedule;

    const runPhase = async (
      phaseWork: SegmentJob[],
      phase: "context" | "parallel",
      priorContextByClip: ReturnType<typeof stablePriorContextByClip>,
    ) => {
      if (!phaseWork.length) return;
      let cursor = 0;
      const workerCount = indexWorkerCount(phaseWork.length);
      const worker = async () => {
        while (cursor < phaseWork.length) {
          const job = phaseWork[cursor];
          cursor += 1;
          const clip = clips.find((candidate) => candidate.id === job.clipId);
          if (!clip) continue;
          updateJob(job.id, { status: "running", attempts: job.attempts + 1, message: "Waiting for local decoder" });
          setMessage(fastMode
            ? `Fast Demo · ${workerCount} windows in parallel · ${extractionConcurrency} local decoder${extractionConcurrency === 1 ? "" : "s"}`
            : phase === "context"
            ? `Detecting game context from ${workerCount} clip${workerCount === 1 ? "" : "s"} in parallel`
            : `Indexing ${workerCount} segments in parallel · ${extractionConcurrency} local decoder${extractionConcurrency === 1 ? "" : "s"}`);
          let lastError = "Segment indexing failed.";
          let evidence: Awaited<ReturnType<typeof extractAdaptiveSegmentEvidence>>;
          try {
            evidence = await extractionGate.run(
              () => {
                updateJob(job.id, { message: `Sampling ${formatTime(job.startMs)}–${formatTime(job.endMs)} locally` });
                return extractAdaptiveSegmentEvidence(
                  clip.file,
                  clip.id,
                  job.id,
                  job.startMs,
                  job.endMs,
                  controller.signal,
                );
              },
              controller.signal,
            );
          } catch (error) {
            if (controller.signal.aborted) throw error;
            lastError = error instanceof Error ? error.message : lastError;
            updateJob(job.id, { status: "failed", attempts: job.attempts + 1, message: lastError });
            failed.add(job.id);
            continue;
          }
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            try {
              updateJob(job.id, { attempts: job.attempts + attempt, message: `${evidence.frames.length} evidence images · analyzing` });
              const prior = priorContextByClip.get(clip.id);
              const response = await fetch("/api/analyze/index-segment", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: controller.signal,
                body: JSON.stringify({
                  clip: { id: clip.id, name: clip.name, label: clip.label, durationMs: clip.durationMs, sizeBytes: clip.sizeBytes },
                  segment: { id: job.id, startMs: job.startMs, endMs: job.endMs },
                  frames: evidence.frames,
                  audioFeatures: evidence.audioFeatures,
                  transcriptSegments: transcriptsForSegment(transcriptMap.get(clip.id) ?? clip.transcripts, job.startMs, job.endMs),
                  priorContext: prior && prior.segmentStartMs < job.startMs
                    ? { gameTitle: prior.gameTitle, gameMode: prior.gameMode }
                    : null,
                }),
              });
              if (!response.ok) throw await indexApiError(response);
              const indexed = await response.json() as GameplaySegmentIndex;
              if (controller.signal.aborted) {
                throw new DOMException("Indexing canceled.", "AbortError");
              }
              if (indexed.api.real !== true || !indexed.api.responseId || indexed.segmentId !== job.id) {
                throw new Error("The segment response lacked verifiable OpenAI provenance.");
              }
              completed.set(job.id, indexed);
              failed.delete(job.id);
              updateJob(job.id, { status: "complete", attempts: job.attempts + attempt, message: `${indexed.events.length} events` });
              const nextSegments = deduplicateOverlappingSegments(
                [...completed.values()].sort(compareIndexedSegments),
              ) as GameplaySegmentIndex[];
              segmentsRef.current = nextSegments;
              setSegments(nextSegments);
              break;
            } catch (error) {
              if (controller.signal.aborted) throw error;
              lastError = error instanceof Error ? error.message : lastError;
              if (attempt === 1 && isRetryableIndexError(error)) {
                const retryAfterMs = error instanceof IndexRequestError ? error.retryAfterMs : 0;
                const backoffMs = Math.max(retryAfterMs, 750 + Math.floor(Math.random() * 500));
                updateJob(job.id, {
                  attempts: job.attempts + 1,
                  message: `Rate-safe retry in ${Math.max(1, Math.ceil(backoffMs / 1_000))}s`,
                });
                await waitForIndexRetry(backoffMs, controller.signal);
                continue;
              }
              updateJob(job.id, { status: "failed", attempts: job.attempts + attempt, message: lastError });
              failed.add(job.id);
              break;
            }
          }
        }
      };
      const workerResults = await Promise.allSettled(
        Array.from({ length: workerCount }, () => worker()),
      );
      if (controller.signal.aborted) {
        throw new DOMException("Indexing canceled.", "AbortError");
      }
      const rejectedWorker = workerResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (rejectedWorker) throw rejectedWorker.reason;
    };

    await runPhase(seedJobs, "context", stablePriorContextByClip([...completed.values()]));
    await runPhase(
      parallelJobs,
      "parallel",
      fastMode ? new Map() : stablePriorContextByClip([...completed.values()]),
    );
    return {
      failedCount: failed.size,
      completedSegments: deduplicateOverlappingSegments(
        [...completed.values()].sort(compareIndexedSegments),
      ) as GameplaySegmentIndex[],
    };
  }

  async function startIndexing(retryFailed = false) {
    if (state === "indexing") return;
    if (retryFailed ? !canRetryIndex : !canIndex) return;
    const controller = new AbortController();
    indexingAbort.current = controller;
    setState("indexing");
    clearDerivedOutputs();
    try {
      let transcriptMap = new Map(clips.map((clip) => [clip.id, clip.transcripts]));
      if (!retryFailed && voiceAnalysisEnabled) {
        transcriptMap = await transcribeConsentedAudio(controller);
      }
      const work = retryFailed
        ? jobs
            .filter((job) => job.status === "failed" || job.status === "canceled")
            .map((job) => ({ ...job, status: "pending" as const, message: "Queued for retry" }))
        : createJobs();
      if (!retryFailed) {
        setJobs(work);
        segmentsRef.current = [];
        setSegments([]);
      } else {
        setJobs((current) => current.map((job) =>
          job.status === "failed" || job.status === "canceled"
            ? { ...job, status: "pending", message: "Queued for retry" }
            : job,
        ));
      }
      const result = await processJobs(work, transcriptMap, controller, fastDemoActive);
      segmentsRef.current = result.completedSegments;
      setSegments(result.completedSegments);
      setState(result.failedCount > 0 ? "partial" : "ready");
      setMessage(fastDemoActive
        ? "Fast Demo index ready. Overlap duplicates were removed before Search and Coach unlocked."
        : "Indexing finished. AI coaching is generating while the verified timeline stays searchable.");
    } catch (error) {
      if (controller.signal.aborted) {
        setJobs((current) => current.map((job) =>
          job.status === "pending" || job.status === "running"
            ? { ...job, status: "canceled", message: "Canceled · ready to retry" }
            : job,
        ));
        setState(segmentsRef.current.length ? "partial" : "idle");
        setMessage("Indexing paused. Completed segments remain available; retry the rest when ready.");
      } else {
        setState("error");
        setMessage(error instanceof Error ? error.message : "Gameplay indexing stopped.");
      }
    } finally {
      indexingAbort.current = null;
    }
  }

  function cancelIndexing() {
    indexingAbort.current?.abort();
  }

  function playMoment(clipId: string, startMs: number) {
    setActiveTab("clips");
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const video = videoRefs.current.get(clipId);
      const clip = clips.find((candidate) => candidate.id === clipId);
      if (!video || !clip) return;
      video.currentTime = Math.min(Math.max(0, (startMs - 2_000) / 1_000), Math.max(0, clip.durationMs / 1_000 - 0.1));
      document.getElementById(`gameplay-source-${clipId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      video.focus({ preventScroll: true });
      void video.play().catch(() => undefined);
    }));
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim() || !indexFinalized || searching) return;
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    setSearching(true);
    setSearchError("");
    setSearchResult(null);
    try {
      const response = await fetch("/api/analyze/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), clips: metadata, segments }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await apiError(response));
      const result = await response.json() as GameplaySearchResponse;
      if (controller.signal.aborted) return;
      if (result.api.real !== true || !result.api.responseId) throw new Error("The search result was not verifiable.");
      setSearchResult(result);
    } catch (error) {
      if (!controller.signal.aborted) {
        setSearchError(error instanceof Error ? error.message : "Gameplay search failed.");
      }
    } finally {
      if (searchAbort.current === controller) {
        setSearching(false);
        searchAbort.current = null;
      }
    }
  }

  function toggleReelEvent(eventId: string) {
    setSelectedEventIds((current) => current.includes(eventId)
      ? current.filter((id) => id !== eventId)
      : [...current, eventId]);
  }

  async function createPlan() {
    if (!indexFinalized || planning || reelState === "rendering") return;
    planningAbort.current?.abort();
    const controller = new AbortController();
    planningAbort.current = controller;
    setPlanning(true);
    setReelError("");
    setPlan(null);
    setReelState("idle");
    if (download) URL.revokeObjectURL(download.url);
    setDownload(null);
    try {
      const response = await fetch("/api/analyze/highlights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          prompt: reelPrompt,
          targetDurationMs: reelDuration,
          aspectRatio: reelAspect,
          clips: metadata,
          segments,
          selectedEventIds,
        }),
      });
      if (!response.ok) throw new Error(await apiError(response));
      const result = await response.json() as HighlightPlan;
      if (controller.signal.aborted) return;
      if (result.api.real !== true || !result.api.responseId || !result.beats.length) {
        throw new Error("The highlight plan was not verifiable.");
      }
      setPlan(result);
    } catch (error) {
      if (!controller.signal.aborted) {
        setReelError(error instanceof Error ? error.message : "Highlight planning failed.");
      }
    } finally {
      if (planningAbort.current === controller) {
        setPlanning(false);
        planningAbort.current = null;
      }
    }
  }

  async function renderReel() {
    if (!plan || reelState === "rendering") return;
    const controller = new AbortController();
    renderingAbort.current = controller;
    setReelState("rendering");
    setReelProgress(0);
    setReelError("");
    try {
      const rendered = await renderGameplayReel(
        clips.map((clip) => ({ id: clip.id, file: clip.file })),
        plan,
        voiceAnalysisEnabled,
        setReelProgress,
        controller.signal,
      );
      if (download) URL.revokeObjectURL(download.url);
      const safeTitle = plan.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "unseen-highlights";
      setDownload({ url: URL.createObjectURL(rendered.blob), name: `${safeTitle}.${rendered.extension}` });
      setReelState("ready");
    } catch (error) {
      if (controller.signal.aborted) {
        setReelState("idle");
        setReelError("Reel export canceled.");
      } else {
        setReelState("error");
        setReelError(error instanceof Error ? error.message : "Reel rendering failed.");
      }
    } finally {
      renderingAbort.current = null;
    }
  }

  return (
    <section className="gameplay-search" id="live-analysis" aria-labelledby="gameplay-workbench-title">
      <div className="gameplay-workspace-header" id="unseen-tools">
        <div>
          <h1 id="gameplay-workbench-title">Upload once. Use every tool.</h1>
          <p>Search moments, get coached, and create highlights from one private index.</p>
        </div>
        <span>UP TO 8 AI CALLS IN PARALLEL</span>
      </div>

      <div className="gameplay-tool-tabs" role="tablist" aria-label="UNSEEN tools">
        {TOOL_TABS.map((tab) => {
          const selected = activeTab === tab.id;
          return (
            <button
              type="button"
              role="tab"
              id={`unseen-tool-tab-${tab.id}`}
              aria-controls={`unseen-tool-panel-${tab.id}`}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className={selected ? "active" : ""}
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => handleToolTabKeyDown(event, tab.id)}
            >
              <strong>{tab.label}</strong>
              <span>{toolStatuses[tab.id]}</span>
            </button>
          );
        })}
      </div>

      <div
        className="gameplay-tool-panel"
        id="unseen-tool-panel-clips"
        role="tabpanel"
        aria-labelledby="unseen-tool-tab-clips"
        hidden={activeTab !== "clips"}
      >
        <header className="gameplay-tool-heading">
          <h2>Add gameplay</h2>
          <p>1–4 videos · up to 60 min · kept on this device</p>
        </header>

        <div className="gameplay-source-grid">
        {clips.map((clip, index) => (
          <article className="gameplay-source" id={`gameplay-source-${clip.id}`} key={clip.id}>
            <div>
              <video
                id={`gameplay-video-${clip.id}`}
                ref={(node) => {
                  if (node) videoRefs.current.set(clip.id, node);
                  else videoRefs.current.delete(clip.id);
                }}
                controls
                playsInline
                preload="metadata"
                src={clip.url}
              />
              <span>SOURCE {String(index + 1).padStart(2, "0")}</span>
              <button type="button" disabled={state === "indexing"} onClick={() => removeClip(clip.id)} aria-label={`Remove ${clip.label}`}>×</button>
            </div>
            <label>
              Source label
              <input value={clip.label} disabled={state === "indexing"} onChange={(event) => updateClipLabel(clip.id, event.target.value)} />
            </label>
            <p title={clip.name}>{clip.name}</p>
            <small>{formatTime(clip.durationMs)} · {readableBytes(clip.file.size)} · LOCAL BLOB</small>
          </article>
        ))}
        {clips.length < GAMEPLAY_SEARCH_LIMITS.maximumClips && (
          <button className="gameplay-add-source" type="button" disabled={state === "indexing"} onClick={() => inputRef.current?.click()}>
            <span>＋</span>
            <strong>Add gameplay videos</strong>
            <small>MP4, MOV, WebM · 1–4 files · 60 min / 2 GB combined</small>
          </button>
        )}
        <input ref={inputRef} className="gameplay-file-input" type="file" accept="video/mp4,video/quicktime,video/webm,.mkv" multiple disabled={state === "indexing"} onChange={(event) => void addFiles(event)} />
      </div>

        <div className="gameplay-session-summary" aria-label="Current gameplay index summary">
          <span><strong>{clips.length}</strong> clip{clips.length === 1 ? "" : "s"}</span>
          <span><strong>{formatTime(totalDurationMs)}</strong> / 60:00</span>
          <span><strong>{readableBytes(totalBytes)}</strong> / 2 GB</span>
          <span><strong>{eventCount}</strong> events</span>
          <span><strong>{fastDemoActive ? "Fast" : "Standard"}</strong> index</span>
          {segments.length > 0 && <span><strong>{context.game}</strong> / {context.mode}</span>}
        </div>

        <label className={`gameplay-fast-demo-option${fastDemoEnabled ? " selected" : ""}`}>
          <input
            type="checkbox"
            role="switch"
            aria-labelledby="gameplay-fast-demo-label"
            aria-describedby="gameplay-fast-demo-description"
            checked={fastDemoEnabled}
            disabled={state === "indexing"}
            onChange={(event) => {
              const enabled = event.target.checked;
              setFastDemoEnabled(enabled);
              resetDerivedState();
              setState("idle");
              setMessage(enabled
                ? fastDemoEligible
                  ? "Fast Demo enabled. Short clips use 12s windows every 10s; voice analysis still adds time."
                  : "Fast Demo is on, but this session exceeds 2:00 combined and will use Standard indexing."
                : "Standard indexing selected. Recommended for long gameplay sessions.");
            }}
          />
          <span>
            <strong id="gameplay-fast-demo-label">Fast Demo</strong>
            <small id="gameplay-fast-demo-description">Parallel indexing for judge sessions up to 2:00 combined. Uses 12s windows every 10s; longer sessions automatically fall back to Standard. Voice stays separately controlled and adds time.</small>
          </span>
          <span className="gameplay-fast-demo-switch" aria-hidden="true">
            <i />
            <b>{fastDemoEnabled ? fastDemoEligible ? "ON" : "STD" : "OFF"}</b>
          </span>
        </label>

        <label className={`gameplay-voice-option${voiceAnalysisEnabled ? " selected" : ""}`}>
        <input
          type="checkbox"
          checked={voiceAnalysisEnabled}
          disabled={state === "indexing"}
          onChange={(event) => {
            const enabled = event.target.checked;
            setVoiceAnalysisEnabled(enabled);
            setClips((current) => current.map((clip) => ({ ...clip, transcripts: [] })));
            resetDerivedState();
            setState("idle");
            setMessage(enabled
              ? "Voice analysis enabled. Re-index to add timestamped dialogue and reactions."
              : "Voice analysis disabled. Re-indexing will keep audio local and exports muted.");
          }}
        />
          <span>
            <strong>Analyze voice chat</strong>
            <small>Only enable if everyone audible has agreed.</small>
          </span>
        </label>
        <label className="gameplay-permission">
        <input
          type="checkbox"
          checked={permissionConfirmed}
          disabled={state === "indexing"}
          onChange={(event) => {
            const confirmed = event.target.checked;
            setPermissionConfirmed(confirmed);
            if (!confirmed) {
              resetDerivedState();
              setState("idle");
              setMessage("Recording permission changed. Confirm permission and re-index to continue.");
            }
          }}
        />
          <span><strong>I have permission to analyze these recordings.</strong> Selected evidence may be sent to OpenAI; raw video stays here.</span>
        </label>

      <div className={`gameplay-index-bar state-${state}`}>
        <div>
          <i />
          <span><strong>{state === "indexing" ? `INDEXING ${indexProgress}%` : state === "ready" ? "INDEX READY" : state === "partial" ? "PARTIAL INDEX" : "LOCAL FOOTAGE READY"}</strong>{message}</span>
        </div>
        <div className="gameplay-index-actions">
          {state === "indexing" ? (
            <button type="button" className="secondary" onClick={cancelIndexing}>Cancel</button>
          ) : retryableJobs > 0 ? (
            <button type="button" className="secondary" disabled={!canRetryIndex} onClick={() => void startIndexing(true)}>Retry {retryableJobs} unfinished</button>
          ) : null}
          <button type="button" disabled={!canIndex} onClick={() => void startIndexing(false)}>{segments.length ? "Rebuild index" : fastDemoActive ? "Fast index with AI ✦" : "Index footage with AI ✦"}</button>
        </div>
      </div>
      {jobs.length > 0 && (
        <div className="gameplay-index-progress">
          <div><span style={{ width: `${indexProgress}%` }} /></div>
          <p>{completedJobs} complete · {jobs.filter((job) => job.status === "running").length} running · {failedJobs} failed{canceledJobs ? ` · ${canceledJobs} paused` : ""} · {jobs.length} total</p>
          {failedJobs > 0 && <small>{jobs.filter((job) => job.status === "failed").map((job) => `${job.id}: ${job.message}`).join(" · ")}</small>}
        </div>
      )}

        {indexFinalized && eventCount > 0 && (
          <button className="gameplay-next-tool" type="button" onClick={() => focusToolTab("search")}>
            Index ready · Search {eventCount} event{eventCount === 1 ? "" : "s"} →
          </button>
        )}
      </div>

      <div
        className="gameplay-tool-panel"
        id="unseen-tool-panel-coach"
        role="tabpanel"
        aria-labelledby="unseen-tool-tab-coach"
        hidden={activeTab !== "coach"}
      >
        <header className="gameplay-tool-heading"><h2>AI coach</h2></header>
        {(state === "ready" || state === "partial") && segments.length > 0 ? (
          <GameplayPostGameReview
            key={reviewRevision}
            clips={reviewSources}
            segments={segments}
            indexCompleteness={state === "partial" ? "partial" : "complete"}
            voiceAnalysisEnabled={voiceAnalysisEnabled}
            onPlayMoment={playMoment}
          />
        ) : (
          <div className="gameplay-tool-empty">
            <strong>{state === "indexing" ? "Coaching starts after indexing." : "Index clips to unlock coaching."}</strong>
            <button type="button" onClick={() => focusToolTab("clips")}>Go to Clips</button>
          </div>
        )}
      </div>

      <div
        className="gameplay-tool-panel"
        id="unseen-tool-panel-search"
        role="tabpanel"
        aria-labelledby="unseen-tool-tab-search"
        hidden={activeTab !== "search"}
      >
        {indexFinalized && eventCount > 0 ? (
        <section className="gameplay-search-panel" aria-labelledby="natural-search-title">
          <div><h2 id="natural-search-title">Search footage</h2></div>
          <form onSubmit={(event) => void search(event)}>
            <label htmlFor="gameplay-query">Describe the moment</label>
            <div>
              <input id="gameplay-query" value={query} maxLength={500} onChange={(event) => setQuery(event.target.value)} placeholder="A moment where X eliminates Y" />
              <button type="submit" disabled={!query.trim() || searching}>{searching ? "Searching evidence…" : "Search footage ↗"}</button>
            </div>
            <div className="gameplay-query-examples">
              {["the final clutch", "the funniest reaction", "when our team captured the objective"].map((example) => (
                <button type="button" key={example} onClick={() => setQuery(example)}>{example}</button>
              ))}
            </div>
          </form>
          {searchError && <p className="gameplay-error">{searchError}</p>}
          {searchResult && (
            <div className={`gameplay-hits result-${searchResult.answerType}`}>
              <header><div><span>{searchResult.answerType.replace("_", " ")}</span><h3>{searchResult.summary}</h3></div></header>
              {searchResult.hits.map((hit, index) => {
                const clip = clips.find((candidate) => candidate.id === hit.clipId);
                const selected = selectedEventIds.includes(hit.eventId);
                return (
                  <article key={hit.eventId}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <h4>{hit.title}</h4>
                      <p>{hit.whyMatch}</p>
                      <small>{clip?.label ?? hit.clipId} · {formatTime(hit.startMs)}–{formatTime(hit.endMs)} · {Math.round(hit.confidence * 100)}% confidence</small>
                      <details className="gameplay-evidence-details"><summary>Evidence</summary><code>RESPONSE {searchResult.api.responseId} · FRAMES {hit.evidenceFrameIds.join(" · ")}{hit.transcriptSegmentIds.length ? ` · TRANSCRIPT ${hit.transcriptSegmentIds.join(" · ")}` : ""}</code></details>
                    </div>
                    <div><button type="button" onClick={() => playMoment(hit.clipId, hit.startMs)}>Play moment ↗</button><button type="button" className={selected ? "selected" : ""} onClick={() => toggleReelEvent(hit.eventId)}>{selected ? "Added ✓" : "Add to reel +"}</button></div>
                  </article>
                );
              })}
              {searchResult.answerType === "insufficient_evidence" && <p>UNSEEN found no reliable indexed event for that request, so it will not invent a timestamp.</p>}
            </div>
          )}
        </section>
        ) : (
          <div className="gameplay-tool-empty"><strong>{state === "indexing" ? "Fast windows are still indexing. Search unlocks after deduplication." : "Index clips to search them."}</strong><button type="button" onClick={() => focusToolTab("clips")}>Go to Clips</button></div>
        )}
      </div>

      <div
        className="gameplay-tool-panel"
        id="unseen-tool-panel-highlights"
        role="tabpanel"
        aria-labelledby="unseen-tool-tab-highlights"
        hidden={activeTab !== "highlights"}
      >
        {indexFinalized && eventCount > 0 ? (
        <section className="gameplay-reel" aria-labelledby="gameplay-reel-title">
          <div className="gameplay-reel-heading">
            <div><h2 id="gameplay-reel-title">Create highlights</h2></div>
            <span>{selectedEventIds.length ? `${selectedEventIds.length} PINNED` : "AI SELECTS"}</span>
          </div>
          <div className="gameplay-reel-controls">
            <label>Reel direction<textarea value={reelPrompt} maxLength={500} onChange={(event) => setReelPrompt(event.target.value)} /></label>
            <fieldset><legend>Duration</legend>{([30_000, 60_000, 90_000] as HighlightDurationMs[]).map((duration) => <button type="button" className={reelDuration === duration ? "selected" : ""} key={duration} onClick={() => setReelDuration(duration)}>{duration / 1_000}s</button>)}</fieldset>
            <fieldset><legend>Format</legend><button type="button" className={reelAspect === "16:9" ? "selected" : ""} onClick={() => setReelAspect("16:9")}>1280×720</button><button type="button" className={reelAspect === "9:16" ? "selected" : ""} onClick={() => setReelAspect("9:16")}>720×1280</button></fieldset>
            <button type="button" disabled={planning || reelState === "rendering"} onClick={() => void createPlan()}>{planning ? "Planning from evidence…" : reelState === "rendering" ? "Finish or cancel export" : "Create edit plan ✦"}</button>
          </div>
          {plan && (
            <div className="gameplay-edit-plan">
              <header><div><h3>{plan.title}</h3><p>{formatTime(plan.estimatedDurationMs)} / {formatTime(plan.targetDurationMs)} target{plan.estimatedDurationMs < plan.targetDurationMs ? " · shortened to available evidence" : ""}</p></div><details className="gameplay-evidence-details"><summary>Evidence</summary><code>{plan.api.responseId}</code></details></header>
              <div>{plan.beats.map((beat) => <button type="button" key={beat.eventId} onClick={() => playMoment(beat.clipId, beat.startMs)}><span>{String(beat.order).padStart(2, "0")}</span><strong>{beat.caption}</strong><small>{clips.find((clip) => clip.id === beat.clipId)?.label} · {formatTime(beat.startMs)}–{formatTime(beat.endMs)}</small></button>)}</div>
              <div className="gameplay-render-actions">
                {reelState === "rendering" ? <button type="button" className="secondary" onClick={() => renderingAbort.current?.abort()}>Cancel export</button> : <button type="button" onClick={() => void renderReel()}>Render downloadable reel</button>}
                {download && <a href={download.url} download={download.name}>Download {download.name} ↓</a>}
                <span>{voiceAnalysisEnabled ? "ORIGINAL AUDIO · VOICE CONSENT CONFIRMED" : "MUTED · VOICE ANALYSIS OFF"}</span>
              </div>
              {reelState === "rendering" && <div className="gameplay-render-progress"><div><span style={{ width: `${Math.round(reelProgress * 100)}%` }} /></div><p>Rendering locally · {Math.round(reelProgress * 100)}%</p></div>}
            </div>
          )}
          {reelError && <p className="gameplay-error">{reelError}</p>}
        </section>
        ) : (
          <div className="gameplay-tool-empty"><strong>{state === "indexing" ? "Highlights unlock after the final deduplicated index is ready." : "Index clips to create highlights."}</strong><button type="button" onClick={() => focusToolTab("clips")}>Go to Clips</button></div>
        )}
      </div>
    </section>
  );
}
