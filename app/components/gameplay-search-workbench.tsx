"use client";

import {
  ChangeEvent,
  FormEvent,
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
import type {
  GameplayAudioDeclaration,
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
import "./gameplay-search-workbench.css";

type IndexStatus = "pending" | "running" | "complete" | "failed";
type WorkbenchState = "idle" | "indexing" | "ready" | "partial" | "error";

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

export function GameplaySearchWorkbench() {
  const [clips, setClips] = useState<GameplayClip[]>([]);
  const [audioDeclaration, setAudioDeclaration] = useState<GameplayAudioDeclaration | "">("");
  const [permissionConfirmed, setPermissionConfirmed] = useState(false);
  const [backend, setBackend] = useState<SearchBackendStatus | null>(null);
  const [backendFailed, setBackendFailed] = useState(false);
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
          setBackendFailed(false);
        }
      })
      .catch(() => {
        if (!canceled) setBackendFailed(true);
      });
    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => () => {
    indexingAbort.current?.abort();
    renderingAbort.current?.abort();
    clipsRef.current.forEach((clip) => URL.revokeObjectURL(clip.url));
  }, []);

  useEffect(() => () => {
    if (download) URL.revokeObjectURL(download.url);
  }, [download]);

  const totalBytes = useMemo(() => clips.reduce((sum, clip) => sum + clip.file.size, 0), [clips]);
  const totalDurationMs = useMemo(() => clips.reduce((sum, clip) => sum + clip.durationMs, 0), [clips]);
  const completedJobs = jobs.filter((job) => job.status === "complete").length;
  const failedJobs = jobs.filter((job) => job.status === "failed").length;
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
  const canIndex = clips.length >= 1
    && clips.length <= GAMEPLAY_SEARCH_LIMITS.maximumClips
    && totalBytes <= GAMEPLAY_SEARCH_LIMITS.maximumTotalFileBytes
    && totalDurationMs <= GAMEPLAY_SEARCH_LIMITS.maximumTotalDurationMs
    && Boolean(audioDeclaration)
    && permissionConfirmed
    && backend?.configured === true
    && state !== "indexing";

  function resetDerivedState() {
    setJobs([]);
    setSegments([]);
    setSearchResult(null);
    setSelectedEventIds([]);
    setPlan(null);
    setReelState("idle");
    setReelError("");
    if (download) URL.revokeObjectURL(download.url);
    setDownload(null);
  }

  async function addFiles(event: ChangeEvent<HTMLInputElement>) {
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
      setMessage(`${next.length} source${next.length === 1 ? "" : "s"} added. Raw video remains on this device.`);
    }
  }

  function removeClip(id: string) {
    const target = clips.find((clip) => clip.id === id);
    if (target) URL.revokeObjectURL(target.url);
    setClips((current) => current.filter((clip) => clip.id !== id));
    resetDerivedState();
    setState("idle");
    setMessage("Source removed. Re-index to search the updated session.");
  }

  function updateJob(id: string, patch: Partial<SegmentJob>) {
    setJobs((current) => current.map((job) => job.id === id ? { ...job, ...patch } : job));
  }

  async function transcribeConsentedAudio(controller: AbortController): Promise<Map<string, GameplayTranscriptSegment[]>> {
    const byClip = new Map<string, GameplayTranscriptSegment[]>();
    for (const clip of clips) {
      const transcript: GameplayTranscriptSegment[] = [];
      for (let startMs = 0; startMs < clip.durationMs; startMs += GAMEPLAY_SEARCH_LIMITS.audioChunkDurationMs) {
        if (controller.signal.aborted) throw new DOMException("Indexing canceled.", "AbortError");
        const endMs = Math.min(clip.durationMs, startMs + GAMEPLAY_SEARCH_LIMITS.audioChunkDurationMs);
        setMessage(`Encoding consented audio locally · ${clip.label} · ${formatTime(startMs)}`);
        const audio = await createConsentedAudioChunk(clip.file, startMs, endMs, controller.signal);
        if (!audio) continue;
        if (audio.size > GAMEPLAY_SEARCH_LIMITS.maximumAudioChunkBytes) {
          throw new Error(`A consented audio chunk exceeded 25 MB for ${clip.label}.`);
        }
        const form = new FormData();
        form.append("file", audio, `${clip.id}-${startMs}.webm`);
        form.append("clipId", clip.id);
        form.append("chunkStartMs", String(startMs));
        form.append("voiceConsent", "true");
        setMessage(`Transcribing opted-in voices · ${clip.label} · ${formatTime(startMs)}`);
        const response = await fetch("/api/analyze/transcribe", { method: "POST", body: form, signal: controller.signal });
        if (!response.ok) throw new Error(await apiError(response));
        const result = await response.json() as TranscribeGameplayAudioResponse;
        if (result.api.real !== true) throw new Error("The transcription response was not verifiable.");
        transcript.push(...result.segments);
      }
      byClip.set(clip.id, transcript);
      setClips((current) => current.map((candidate) => candidate.id === clip.id
        ? { ...candidate, transcripts: transcript }
        : candidate));
    }
    return byClip;
  }

  function createJobs(): SegmentJob[] {
    return clips.flatMap((clip) => {
      const next: SegmentJob[] = [];
      for (let startMs = 0, index = 0; startMs < clip.durationMs; startMs += GAMEPLAY_SEARCH_LIMITS.segmentDurationMs, index += 1) {
        next.push({
          id: `${clip.id}-segment-${String(index + 1).padStart(3, "0")}`,
          clipId: clip.id,
          startMs,
          endMs: Math.min(clip.durationMs, startMs + GAMEPLAY_SEARCH_LIMITS.segmentDurationMs),
          status: "pending",
          attempts: 0,
          message: "Queued",
        });
      }
      return next;
    });
  }

  async function processJobs(
    work: SegmentJob[],
    transcriptMap: Map<string, GameplayTranscriptSegment[]>,
    controller: AbortController,
  ) {
    let cursor = 0;
    const failed = new Set<string>();
    const completed = new Map(segmentsRef.current.map((segment) => [segment.segmentId, segment]));
    const worker = async () => {
      while (cursor < work.length) {
        const job = work[cursor];
        cursor += 1;
        const clip = clips.find((candidate) => candidate.id === job.clipId);
        if (!clip) continue;
        updateJob(job.id, { status: "running", attempts: job.attempts + 1, message: "Sampling locally" });
        setMessage(`Scanning ${clip.label} · ${formatTime(job.startMs)}–${formatTime(job.endMs)} · two segments in parallel`);
        let lastError = "Segment indexing failed.";
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            const evidence = await extractAdaptiveSegmentEvidence(
              clip.file,
              clip.id,
              job.id,
              job.startMs,
              job.endMs,
              controller.signal,
            );
            updateJob(job.id, { attempts: job.attempts + attempt, message: `${evidence.frames.length} evidence images · analyzing` });
            const prior = [...completed.values()]
              .filter((segment) => segment.clipId === clip.id && segment.segmentStartMs < job.startMs)
              .sort((a, b) => b.segmentStartMs - a.segmentStartMs)[0];
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
                priorContext: prior ? { gameTitle: prior.gameTitle, gameMode: prior.gameMode } : null,
              }),
            });
            if (!response.ok) throw new Error(await apiError(response));
            const indexed = await response.json() as GameplaySegmentIndex;
            if (indexed.api.real !== true || !indexed.api.responseId || indexed.segmentId !== job.id) {
              throw new Error("The segment response lacked verifiable OpenAI provenance.");
            }
            completed.set(job.id, indexed);
            failed.delete(job.id);
            updateJob(job.id, { status: "complete", attempts: job.attempts + attempt, message: `${indexed.events.length} events` });
            setSegments([...completed.values()].sort((a, b) => a.segmentStartMs - b.segmentStartMs));
            break;
          } catch (error) {
            if (controller.signal.aborted) throw error;
            lastError = error instanceof Error ? error.message : lastError;
            if (attempt === 1) {
              updateJob(job.id, { attempts: job.attempts + 1, message: "Retrying once" });
              continue;
            }
            updateJob(job.id, { status: "failed", attempts: job.attempts + attempt, message: lastError });
            failed.add(job.id);
          }
        }
      }
    };
    await Promise.all([worker(), worker()]);
    return failed.size;
  }

  async function startIndexing(retryFailed = false) {
    if ((!canIndex && !retryFailed) || state === "indexing") return;
    const controller = new AbortController();
    indexingAbort.current = controller;
    setState("indexing");
    setSearchResult(null);
    setSearchError("");
    setPlan(null);
    try {
      let transcriptMap = new Map(clips.map((clip) => [clip.id, clip.transcripts]));
      if (!retryFailed && audioDeclaration === "voices_consented") {
        try {
          transcriptMap = await transcribeConsentedAudio(controller);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          setMessage(`${error instanceof Error ? error.message : "Voice transcription failed."} Continuing with visual evidence.`);
        }
      }
      const work = retryFailed
        ? jobs.filter((job) => job.status === "failed").map((job) => ({ ...job, status: "pending" as const, message: "Queued for retry" }))
        : createJobs();
      if (!retryFailed) {
        setJobs(work);
        segmentsRef.current = [];
        setSegments([]);
      } else {
        setJobs((current) => current.map((job) => job.status === "failed" ? { ...job, status: "pending", message: "Queued for retry" } : job));
      }
      const remainingFailed = await processJobs(work, transcriptMap, controller);
      setState(remainingFailed > 0 ? "partial" : "ready");
      setMessage("Indexing finished. Search the verified event timeline or generate a reel.");
    } catch (error) {
      if (controller.signal.aborted) {
        setState(segmentsRef.current.length ? "partial" : "idle");
        setMessage("Indexing canceled. Completed segments remain available in this tab.");
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
    const video = videoRefs.current.get(clipId);
    const clip = clips.find((candidate) => candidate.id === clipId);
    if (!video || !clip) return;
    video.currentTime = Math.min(Math.max(0, (startMs - 2_000) / 1_000), Math.max(0, clip.durationMs / 1_000 - 0.1));
    void video.play().catch(() => undefined);
    document.getElementById(`gameplay-source-${clipId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim() || !segments.length || searching) return;
    setSearching(true);
    setSearchError("");
    setSearchResult(null);
    try {
      const response = await fetch("/api/analyze/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), clips: metadata, segments }),
      });
      if (!response.ok) throw new Error(await apiError(response));
      const result = await response.json() as GameplaySearchResponse;
      if (result.api.real !== true || !result.api.responseId) throw new Error("The search result was not verifiable.");
      setSearchResult(result);
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "Gameplay search failed.");
    } finally {
      setSearching(false);
    }
  }

  function toggleReelEvent(eventId: string) {
    setSelectedEventIds((current) => current.includes(eventId)
      ? current.filter((id) => id !== eventId)
      : [...current, eventId]);
  }

  async function createPlan() {
    if (!segments.length || planning) return;
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
      if (result.api.real !== true || !result.api.responseId || !result.beats.length) {
        throw new Error("The highlight plan was not verifiable.");
      }
      setPlan(result);
    } catch (error) {
      setReelError(error instanceof Error ? error.message : "Highlight planning failed.");
    } finally {
      setPlanning(false);
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
        audioDeclaration !== "voices_unconsented",
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
    <section className="gameplay-search" id="live-analysis" aria-labelledby="gameplay-search-title">
      <div className="gameplay-search-hero">
        <div>
          <span className="gameplay-kicker"><i /> GAME-AGNOSTIC / LOCAL-FIRST</span>
          <h1 id="gameplay-search-title">Find the exact moment. Cut the reel.</h1>
          <p>
            Give UNSEEN a long gameplay recording, then search it naturally. Raw video stays in your
            browser; only selected evidence images and explicitly consented audio reach OpenAI.
          </p>
        </div>
        <aside className={`gameplay-backend ${backend?.configured ? "ready" : backendFailed ? "error" : "offline"}`}>
          <strong>{backend?.configured ? "LIVE SEARCH BACKEND READY" : backendFailed ? "BACKEND STATUS UNREACHABLE" : "OPENAI KEY REQUIRED"}</strong>
          <span>{backend?.configured ? `${backend.models?.search ?? backend.models?.vision} search` : "Fail-closed until configured"}</span>
          <span>Index clears when this page reloads</span>
          <span>Every result cites real source evidence</span>
          <span>No raw gameplay upload</span>
        </aside>
      </div>

      <div className="gameplay-flow" aria-label="Gameplay search stages">
        <span>01 ADD FOOTAGE</span><i>→</i><span>02 LOCAL SCAN</span><i>→</i>
        <span>03 EVIDENCE INDEX</span><i>→</i><span>04 NATURAL SEARCH</span><i>→</i><span>05 EXPORT</span>
      </div>

      <div className="gameplay-source-grid">
        {clips.map((clip, index) => (
          <article className="gameplay-source" id={`gameplay-source-${clip.id}`} key={clip.id}>
            <div>
              <video
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
              <button type="button" onClick={() => removeClip(clip.id)} aria-label={`Remove ${clip.label}`}>×</button>
            </div>
            <label>
              Source label
              <input value={clip.label} onChange={(event) => setClips((current) => current.map((candidate) => candidate.id === clip.id ? { ...candidate, label: event.target.value } : candidate))} />
            </label>
            <p title={clip.name}>{clip.name}</p>
            <small>{formatTime(clip.durationMs)} · {readableBytes(clip.file.size)} · LOCAL BLOB</small>
          </article>
        ))}
        {clips.length < GAMEPLAY_SEARCH_LIMITS.maximumClips && (
          <button className="gameplay-add-source" type="button" onClick={() => inputRef.current?.click()}>
            <span>＋</span>
            <strong>Add gameplay videos</strong>
            <small>MP4, MOV, WebM · 1–4 files · 60 min / 2 GB combined</small>
          </button>
        )}
        <input ref={inputRef} className="gameplay-file-input" type="file" accept="video/mp4,video/quicktime,video/webm,.mkv" multiple onChange={(event) => void addFiles(event)} />
      </div>

      <div className="gameplay-session-meter">
        <span><strong>{clips.length}/4</strong> SOURCES</span>
        <span><strong>{formatTime(totalDurationMs)}</strong> / 60:00</span>
        <span><strong>{readableBytes(totalBytes)}</strong> / 2 GB</span>
        <span><strong>{eventCount}</strong> VERIFIED EVENTS</span>
      </div>

      <fieldset className="gameplay-audio-declaration">
        <legend>Required audio declaration</legend>
        {([
          ["game_only", "Game audio only", "Use local audio energy and preserve source audio in exports."],
          ["voices_consented", "Voices — everyone consented", "Transcribe timestamped speech and preserve source audio."],
          ["voices_unconsented", "Voices — consent incomplete", "Never transcribe speech; exported reels are muted."],
        ] as const).map(([value, title, description]) => (
          <label key={value} className={audioDeclaration === value ? "selected" : ""}>
            <input type="radio" name="gameplay-audio" value={value} checked={audioDeclaration === value} onChange={() => setAudioDeclaration(value)} />
            <span><strong>{title}</strong><small>{description}</small></span>
          </label>
        ))}
      </fieldset>
      <label className="gameplay-permission">
        <input type="checkbox" checked={permissionConfirmed} onChange={(event) => setPermissionConfirmed(event.target.checked)} />
        <span><strong>I have permission to analyze these recordings.</strong> Selected JPEG evidence may be sent to OpenAI. UNSEEN stores no raw video or persistent index.</span>
      </label>

      <div className={`gameplay-index-bar state-${state}`}>
        <div>
          <i />
          <span><strong>{state === "indexing" ? `INDEXING ${indexProgress}%` : state === "ready" ? "INDEX READY" : state === "partial" ? "PARTIAL INDEX" : "LOCAL FOOTAGE READY"}</strong>{message}</span>
        </div>
        <div className="gameplay-index-actions">
          {state === "indexing" ? (
            <button type="button" className="secondary" onClick={cancelIndexing}>Cancel</button>
          ) : failedJobs > 0 ? (
            <button type="button" className="secondary" onClick={() => void startIndexing(true)}>Retry {failedJobs} failed</button>
          ) : null}
          <button type="button" disabled={!canIndex} onClick={() => void startIndexing(false)}>{segments.length ? "Rebuild index" : "Index footage with AI ✦"}</button>
        </div>
      </div>
      {jobs.length > 0 && (
        <div className="gameplay-index-progress">
          <div><span style={{ width: `${indexProgress}%` }} /></div>
          <p>{completedJobs} complete · {jobs.filter((job) => job.status === "running").length} running · {failedJobs} failed · {jobs.length} total</p>
          {failedJobs > 0 && <small>{jobs.filter((job) => job.status === "failed").map((job) => `${job.id}: ${job.message}`).join(" · ")}</small>}
        </div>
      )}

      {segments.length > 0 && (
        <div className="gameplay-index-context">
          <div><span>DETECTED GAME</span><strong>{context.game}</strong><small>{context.mode}</small></div>
          <div><span>EVENT ONTOLOGY</span><strong>{eventCount} grounded moments</strong><small>Eliminations · assists · objectives · clutches · mistakes · reactions</small></div>
          <div><span>INDEX LIFETIME</span><strong>This tab only</strong><small>Reload to clear all frames, transcripts, and events from memory.</small></div>
        </div>
      )}

      {segments.length > 0 && (
        <section className="gameplay-search-panel" aria-labelledby="natural-search-title">
          <div>
            <span className="gameplay-kicker"><i /> EVIDENCE-BOUND RETRIEVAL</span>
            <h2 id="natural-search-title">Search what happened.</h2>
            <p>Try a player matchup, a clutch, a mistake, an objective, or an observable reaction.</p>
          </div>
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
              <header><div><span>{searchResult.answerType.replace("_", " ")}</span><h3>{searchResult.summary}</h3></div><code>{searchResult.api.responseId}</code></header>
              {searchResult.hits.map((hit, index) => {
                const clip = clips.find((candidate) => candidate.id === hit.clipId);
                const selected = selectedEventIds.includes(hit.eventId);
                return (
                  <article key={hit.eventId}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div><h4>{hit.title}</h4><p>{hit.whyMatch}</p><small>{clip?.label ?? hit.clipId} · {formatTime(hit.startMs)}–{formatTime(hit.endMs)} · {Math.round(hit.confidence * 100)}% confidence</small><code>FRAMES {hit.evidenceFrameIds.join(" · ")}{hit.transcriptSegmentIds.length ? ` · TRANSCRIPT ${hit.transcriptSegmentIds.join(" · ")}` : ""}</code></div>
                    <div><button type="button" onClick={() => playMoment(hit.clipId, hit.startMs)}>Play moment ↗</button><button type="button" className={selected ? "selected" : ""} onClick={() => toggleReelEvent(hit.eventId)}>{selected ? "Added ✓" : "Add to reel +"}</button></div>
                  </article>
                );
              })}
              {searchResult.answerType === "insufficient_evidence" && <p>UNSEEN found no reliable indexed event for that request, so it will not invent a timestamp.</p>}
            </div>
          )}
        </section>
      )}

      {segments.length > 0 && eventCount > 0 && (
        <section className="gameplay-reel" aria-labelledby="gameplay-reel-title">
          <div className="gameplay-reel-heading">
            <div><span className="gameplay-kicker"><i /> DEVICE-LOCAL RENDERER</span><h2 id="gameplay-reel-title">Generate a post-ready reel.</h2><p>AI chooses only indexed beats. Your browser performs the actual cuts and download.</p></div>
            <span>{selectedEventIds.length ? `${selectedEventIds.length} SEARCH RESULT${selectedEventIds.length === 1 ? "" : "S"} PINNED` : "AI SELECTS ACROSS THE FULL INDEX"}</span>
          </div>
          <div className="gameplay-reel-controls">
            <label>Reel direction<textarea value={reelPrompt} maxLength={500} onChange={(event) => setReelPrompt(event.target.value)} /></label>
            <fieldset><legend>Duration</legend>{([30_000, 60_000, 90_000] as HighlightDurationMs[]).map((duration) => <button type="button" className={reelDuration === duration ? "selected" : ""} key={duration} onClick={() => setReelDuration(duration)}>{duration / 1_000}s</button>)}</fieldset>
            <fieldset><legend>Format</legend><button type="button" className={reelAspect === "16:9" ? "selected" : ""} onClick={() => setReelAspect("16:9")}>1280×720</button><button type="button" className={reelAspect === "9:16" ? "selected" : ""} onClick={() => setReelAspect("9:16")}>720×1280</button></fieldset>
            <button type="button" disabled={planning} onClick={() => void createPlan()}>{planning ? "Planning from evidence…" : "Create edit plan ✦"}</button>
          </div>
          {plan && (
            <div className="gameplay-edit-plan">
              <header><div><span>VERIFIED EDIT DECISION LIST</span><h3>{plan.title}</h3><p>{formatTime(plan.estimatedDurationMs)} planned for a {formatTime(plan.targetDurationMs)} target{plan.estimatedDurationMs < plan.targetDurationMs ? " · shortened honestly to available evidence" : ""}</p></div><code>{plan.api.responseId}</code></header>
              <div>{plan.beats.map((beat) => <button type="button" key={beat.eventId} onClick={() => playMoment(beat.clipId, beat.startMs)}><span>{String(beat.order).padStart(2, "0")}</span><strong>{beat.caption}</strong><small>{clips.find((clip) => clip.id === beat.clipId)?.label} · {formatTime(beat.startMs)}–{formatTime(beat.endMs)}</small></button>)}</div>
              <div className="gameplay-render-actions">
                {reelState === "rendering" ? <button type="button" className="secondary" onClick={() => renderingAbort.current?.abort()}>Cancel export</button> : <button type="button" onClick={() => void renderReel()}>Render downloadable reel</button>}
                {download && <a href={download.url} download={download.name}>Download {download.name} ↓</a>}
                <span>{audioDeclaration === "voices_unconsented" ? "MUTED · CONSENT INCOMPLETE" : "ORIGINAL PERMITTED AUDIO · 100MS FADES"}</span>
              </div>
              {reelState === "rendering" && <div className="gameplay-render-progress"><div><span style={{ width: `${Math.round(reelProgress * 100)}%` }} /></div><p>Rendering locally · {Math.round(reelProgress * 100)}%</p></div>}
            </div>
          )}
          {reelError && <p className="gameplay-error">{reelError}</p>}
        </section>
      )}
    </section>
  );
}
