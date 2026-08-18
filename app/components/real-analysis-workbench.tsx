"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  AnalyzeClipRequest,
  AskRealSessionResponse,
  RealAnalysisApiError,
  RealClipAnalysis,
  RealSessionAnalysis,
  SampledFrame,
} from "@/lib/real-analysis-types";
import { REAL_ANALYSIS_LIMITS } from "@/lib/real-analysis-types";
import { GameplaySearchWorkbench } from "./gameplay-search-workbench";
import "./real-analysis-workbench.css";

type ClipStatus = "ready" | "extracting" | "transcribing" | "analyzed" | "error";

interface LocalClip {
  id: string;
  file: File;
  url: string;
  playerLabel: string;
  durationMs: number;
  status: ClipStatus;
  statusText: string;
  analysis: RealClipAnalysis | null;
}

interface LiveBackendStatus {
  configured: boolean;
  mode: "live_openai" | "unavailable";
  models: {
    vision: string;
    linking: string;
    transcription: string;
  } | null;
  scriptedFallback: false;
}

const MAXIMUM_CLIP_MINUTES = REAL_ANALYSIS_LIMITS.maximumDurationMs / 60_000;
const MAXIMUM_FILE_MEGABYTES = REAL_ANALYSIS_LIMITS.maximumFileBytes / 1024 / 1024;

function formatMs(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function cleanPlayerLabel(name: string, index: number): string {
  const cleaned = name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
  return cleaned || `Player ${index + 1}`;
}

function waitForEvent(target: HTMLMediaElement, eventName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("The browser could not decode this video."));
    };
    const cleanup = () => {
      target.removeEventListener(eventName, onSuccess);
      target.removeEventListener("error", onError);
    };
    target.addEventListener(eventName, onSuccess, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

async function readDuration(url: string): Promise<number> {
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.src = url;
  await waitForEvent(video, "loadedmetadata");
  const durationMs = Math.round(video.duration * 1_000);
  video.removeAttribute("src");
  video.load();
  return durationMs;
}

async function seek(video: HTMLVideoElement, seconds: number): Promise<void> {
  if (Math.abs(video.currentTime - seconds) < 0.03) return;
  const promise = waitForEvent(video, "seeked");
  video.currentTime = seconds;
  await promise;
}

async function extractFrames(clip: LocalClip): Promise<SampledFrame[]> {
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = clip.url;
  await waitForEvent(video, "loadedmetadata");

  const sampleCount = REAL_ANALYSIS_LIMITS.framesPerClip;
  const durationSeconds = clip.durationMs / 1_000;
  const sourceWidth = video.videoWidth || 1280;
  const sourceHeight = video.videoHeight || 720;
  const width = Math.min(768, sourceWidth);
  const height = Math.max(1, Math.round((sourceHeight / sourceWidth) * width));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas frame extraction is unavailable.");

  const frames: SampledFrame[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const seconds = Math.min(
      Math.max(0, durationSeconds - 0.05),
      ((index + 0.5) / sampleCount) * durationSeconds,
    );
    await seek(video, seconds);
    context.drawImage(video, 0, 0, width, height);
    frames.push({
      id: `${clip.id}-frame-${String(index + 1).padStart(2, "0")}`,
      timestampMs: Math.round(seconds * 1_000),
      imageDataUrl: canvas.toDataURL("image/jpeg", 0.72),
      width,
      height,
    });
  }
  video.removeAttribute("src");
  video.load();
  return frames;
}

function encodeWav(samples: Float32Array, sampleRate: number): string {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function extractAudio(file: File): Promise<string | null> {
  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) return null;
  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    const sampleRate = 16_000;
    const length = Math.min(
      Math.ceil((REAL_ANALYSIS_LIMITS.maximumDurationMs / 1_000) * sampleRate),
      Math.ceil(decoded.duration * sampleRate),
    );
    const offline = new OfflineAudioContext(1, length, sampleRate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return encodeWav(rendered.getChannelData(0), sampleRate);
  } catch {
    return null;
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function parseApiError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as RealAnalysisApiError | null;
  const message = body?.error?.message || `Analysis failed with HTTP ${response.status}.`;
  return body?.error?.requestId ? `${message} Request ${body.error.requestId}` : message;
}

function SquadAnalysisWorkbench() {
  const [clips, setClips] = useState<LocalClip[]>([]);
  const [permissionConfirmed, setPermissionConfirmed] = useState(false);
  const [voiceConsent, setVoiceConsent] = useState(false);
  const [runState, setRunState] = useState<"idle" | "running" | "complete" | "error">("idle");
  const [runMessage, setRunMessage] = useState("Choose two to four matching squad POV clips.");
  const [result, setResult] = useState<RealSessionAnalysis | null>(null);
  const [selectedMomentId, setSelectedMomentId] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskRealSessionResponse | null>(null);
  const [askError, setAskError] = useState("");
  const [isAsking, setIsAsking] = useState(false);
  const [backendStatus, setBackendStatus] = useState<LiveBackendStatus | null>(null);
  const [backendCheckFailed, setBackendCheckFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const clipsRef = useRef<LocalClip[]>([]);
  const videoRefs = useRef(new Map<string, HTMLVideoElement>());

  useEffect(() => {
    clipsRef.current = clips;
  }, [clips]);

  useEffect(() => {
    let cancelled = false;
    async function checkBackend() {
      try {
        const response = await fetch("/api/analyze/status", { cache: "no-store" });
        if (!response.ok) throw new Error("Status request failed.");
        const status = (await response.json()) as LiveBackendStatus;
        if (!cancelled) {
          setBackendStatus(status);
          setBackendCheckFailed(false);
        }
      } catch {
        if (!cancelled) setBackendCheckFailed(true);
      }
    }
    void checkBackend();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    clipsRef.current.forEach((clip) => URL.revokeObjectURL(clip.url));
  }, []);

  const canAnalyze =
    clips.length >= REAL_ANALYSIS_LIMITS.minimumClips &&
    clips.length <= REAL_ANALYSIS_LIMITS.maximumClips &&
    clips.every((clip) => clip.durationMs > 0 && clip.durationMs <= REAL_ANALYSIS_LIMITS.maximumDurationMs) &&
    permissionConfirmed &&
    backendStatus?.configured === true &&
    runState !== "running";

  const selectedMoment = useMemo(
    () => result?.linkedMoments.find((moment) => moment.id === selectedMomentId) ?? result?.linkedMoments[0],
    [result, selectedMomentId],
  );

  function updateClip(id: string, patch: Partial<LocalClip>) {
    setClips((current) => current.map((clip) => clip.id === id ? { ...clip, ...patch } : clip));
  }

  async function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (selected.length === 0) return;
    const slots = REAL_ANALYSIS_LIMITS.maximumClips - clips.length;
    const accepted = selected.slice(0, slots);
    const next: LocalClip[] = [];
    for (const file of accepted) {
      if (file.size > REAL_ANALYSIS_LIMITS.maximumFileBytes) {
        setRunState("error");
        setRunMessage(`${file.name} is larger than ${MAXIMUM_FILE_MEGABYTES} MB.`);
        continue;
      }
      const url = URL.createObjectURL(file);
      try {
        const durationMs = await readDuration(url);
        const index = clips.length + next.length;
        next.push({
          id: `clip-${crypto.randomUUID()}`,
          file,
          url,
          playerLabel: cleanPlayerLabel(file.name, index),
          durationMs,
          status: durationMs <= REAL_ANALYSIS_LIMITS.maximumDurationMs ? "ready" : "error",
          statusText: durationMs <= REAL_ANALYSIS_LIMITS.maximumDurationMs
            ? `Ready to sample ${REAL_ANALYSIS_LIMITS.framesPerClip} frames`
            : `Trim to ${MAXIMUM_CLIP_MINUTES} minutes`,
          analysis: null,
        });
      } catch {
        URL.revokeObjectURL(url);
        setRunState("error");
        setRunMessage(`${file.name} could not be decoded by this browser.`);
      }
    }
    if (next.length) {
      setClips((current) => [...current, ...next]);
      setResult(null);
      setRunState("idle");
      setRunMessage("Sources loaded. Confirm consent, then start the real AI run.");
    }
  }

  function removeClip(id: string) {
    setClips((current) => {
      const target = current.find((clip) => clip.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return current.filter((clip) => clip.id !== id);
    });
    setResult(null);
    setRunState("idle");
  }

  async function runAnalysis() {
    if (!canAnalyze) return;
    setRunState("running");
    setResult(null);
    setSelectedMomentId("");
    setAnswer(null);
    setAskError("");
    const completed: RealClipAnalysis[] = [];
    try {
      for (let index = 0; index < clips.length; index += 1) {
        const clip = clips[index];
        setRunMessage(`Extracting timestamped evidence from ${clip.playerLabel} (${index + 1}/${clips.length})…`);
        updateClip(clip.id, {
          status: "extracting",
          statusText: `Sampling ${REAL_ANALYSIS_LIMITS.framesPerClip} real frames`,
        });
        const frames = await extractFrames(clip);
        let audioBase64: string | null = null;
        if (voiceConsent) {
          updateClip(clip.id, { status: "transcribing", statusText: "Extracting consented audio" });
          audioBase64 = await extractAudio(clip.file);
        }
        setRunMessage(`Sending ${clip.playerLabel}'s real frames${audioBase64 ? " and audio" : ""} to OpenAI…`);
        updateClip(clip.id, { status: "transcribing", statusText: audioBase64 ? "Transcription + vision running" : "Vision analysis running" });
        const payload: AnalyzeClipRequest = {
          clip: { id: clip.id, name: clip.file.name, playerLabel: clip.playerLabel, durationMs: clip.durationMs },
          frames,
          audio: audioBase64 ? { mimeType: "audio/wav", dataBase64: audioBase64 } : null,
          voiceConsent,
        };
        const response = await fetch("/api/analyze/clip", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error(await parseApiError(response));
        const analysis = (await response.json()) as RealClipAnalysis;
        if (analysis.api.real !== true || !analysis.api.visionResponseId) {
          throw new Error("The server did not return verifiable OpenAI provenance.");
        }
        completed.push(analysis);
        updateClip(clip.id, {
          status: "analyzed",
          statusText: `${analysis.observations.length} observations · ${analysis.audioStatus === "transcribed" ? "audio transcribed" : "visual only"}`,
          analysis,
        });
      }

      setRunMessage("Linking matching HUD events, actions, and reactions across all POVs…");
      const linkResponse = await fetch("/api/analyze/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clips: completed }),
      });
      if (!linkResponse.ok) throw new Error(await parseApiError(linkResponse));
      const linked = (await linkResponse.json()) as RealSessionAnalysis;
      if (linked.api.real !== true || !linked.api.responseId) {
        throw new Error("The server did not return verifiable cross-clip AI provenance.");
      }
      setResult(linked);
      setSelectedMomentId(linked.linkedMoments[0]?.id ?? "");
      setRunState("complete");
      setRunMessage(`${completed.length} real clips analyzed · ${linked.linkedMoments.length} squad moments linked.`);
    } catch (error) {
      setClips((current) => current.map((clip) =>
        clip.status === "extracting" || clip.status === "transcribing"
          ? { ...clip, status: "error", statusText: "Analysis stopped" }
          : clip,
      ));
      setRunState("error");
      setRunMessage(error instanceof Error ? error.message : "The real AI run failed.");
    }
  }

  function seekEvidence(clipId: string, timestampMs: number) {
    const video = videoRefs.current.get(clipId);
    if (!video) return;
    video.currentTime = Math.min(Math.max(0, timestampMs / 1_000), Math.max(0, video.duration - 0.1));
    void video.play().catch(() => undefined);
    document.getElementById(`live-source-${clipId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function askSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanQuestion = question.trim();
    if (!result || !cleanQuestion || isAsking || clips.length === 0) return;
    setIsAsking(true);
    setAskError("");
    setAnswer(null);
    try {
      const response = await fetch("/api/analyze/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: cleanQuestion,
          viewerClipId: clips[0].id,
          clips: clips.map((clip) => clip.analysis).filter((analysis): analysis is RealClipAnalysis => Boolean(analysis)),
          session: result,
        }),
      });
      if (!response.ok) throw new Error(await parseApiError(response));
      const groundedAnswer = (await response.json()) as AskRealSessionResponse;
      if (groundedAnswer.api.real !== true || !groundedAnswer.api.responseId) {
        throw new Error("The server did not return a verifiable grounded answer.");
      }
      setAnswer(groundedAnswer);
    } catch (error) {
      setAskError(error instanceof Error ? error.message : "The session question failed.");
    } finally {
      setIsAsking(false);
    }
  }

  return (
    <section className="real-workbench" id="live-analysis" aria-labelledby="real-analysis-title">
      <div className="real-hero">
        <div>
          <span className="real-kicker"><i /> LIVE MULTIMODAL PIPELINE</span>
          <h1 id="real-analysis-title">Upload real squad clips. See AI link what each player missed.</h1>
          <p>
            UNSEEN samples actual frames in your browser, optionally transcribes opted-in audio,
            analyzes every POV with OpenAI, then builds one evidence-linked squad timeline.
          </p>
        </div>
        <div className={`real-integrity-card backend-${backendStatus?.configured ? "ready" : backendCheckFailed ? "error" : "offline"}`}>
          <strong>{backendStatus?.configured ? "LIVE OPENAI BACKEND READY" : backendCheckFailed ? "BACKEND STATUS UNREACHABLE" : "LIVE AI NEEDS CONFIGURATION"}</strong>
          <span>{backendStatus?.configured ? `${backendStatus.models?.vision} vision + ${backendStatus.models?.linking} linking` : "OPENAI_API_KEY is not configured"}</span>
          <span>Real OpenAI response IDs required</span>
          <span>Every claim cites a source frame</span>
          <span>Failures stay failures — never fake results</span>
        </div>
      </div>

      <div className="real-flow" aria-label="Live processing stages">
        <span>01 LOCAL SAMPLE</span><i>→</i><span>02 TRANSCRIBE</span><i>→</i>
        <span>03 VISION</span><i>→</i><span>04 CROSS-LINK</span><i>→</i><span>05 DIRECT</span>
      </div>

      <div className="real-source-grid">
        {clips.map((clip, index) => (
          <article className={`real-source source-${clip.status}`} id={`live-source-${clip.id}`} key={clip.id}>
            <div className="real-video-wrap">
              <video
                ref={(node) => {
                  if (node) videoRefs.current.set(clip.id, node);
                  else videoRefs.current.delete(clip.id);
                }}
                src={clip.url}
                controls
                playsInline
                preload="metadata"
              />
              <span>POV {String(index + 1).padStart(2, "0")}</span>
              <button type="button" onClick={() => removeClip(clip.id)} aria-label={`Remove ${clip.file.name}`}>×</button>
            </div>
            <label>
              Player / perspective
              <input
                value={clip.playerLabel}
                disabled={runState === "running"}
                onChange={(event) => updateClip(clip.id, { playerLabel: event.target.value })}
              />
            </label>
            <div className="real-source-meta">
              <strong>{clip.file.name}</strong>
              <span>{formatMs(clip.durationMs)} · {(clip.file.size / 1024 / 1024).toFixed(1)} MB</span>
            </div>
            <div className={`real-source-status status-${clip.status}`}><i /> {clip.statusText}</div>
            {clip.analysis && (
              <div className="real-source-proof">
                <span>OPENAI VISION RESPONSE</span>
                <code>{clip.analysis.api.visionResponseId}</code>
                <small>{clip.analysis.api.visionModel} · {clip.analysis.api.inputTokens + clip.analysis.api.outputTokens} tokens</small>
              </div>
            )}
          </article>
        ))}

        {clips.length < REAL_ANALYSIS_LIMITS.maximumClips && (
          <button className="real-add-source" type="button" onClick={() => inputRef.current?.click()}>
            <span>+</span>
            <strong>Add real gameplay clips</strong>
            <small>
              MP4, MOV, or WebM · max {MAXIMUM_CLIP_MINUTES} min / {MAXIMUM_FILE_MEGABYTES} MB each
            </small>
          </button>
        )}
        <input
          ref={inputRef}
          className="real-file-input"
          type="file"
          accept="video/mp4,video/webm,video/quicktime"
          multiple
          onChange={(event) => void addFiles(event)}
        />
      </div>

      <div className="real-consent-panel">
        <label>
          <input type="checkbox" checked={permissionConfirmed} onChange={(event) => setPermissionConfirmed(event.target.checked)} />
          <span><strong>I have permission to analyze these recordings.</strong> Gameplay frames will be sent to OpenAI and are not stored by UNSEEN.</span>
        </label>
        <label>
          <input type="checkbox" checked={voiceConsent} onChange={(event) => setVoiceConsent(event.target.checked)} />
          <span><strong>Everyone audible opted in to voice analysis.</strong> If unchecked, UNSEEN sends frames only.</span>
        </label>
      </div>

      <div className={`real-runbar run-${runState}`} aria-live="polite">
        <div><i /><span><strong>{runState === "running" ? "REAL AI RUN IN PROGRESS" : runState === "complete" ? "REAL AI RUN VERIFIED" : runState === "error" ? "RUN STOPPED — NO FALLBACK USED" : backendStatus?.configured ? "READY FOR REAL CLIPS" : "LIVE AI BACKEND NOT CONFIGURED"}</strong>{backendStatus?.configured === false && runState === "idle" ? "A server-side OPENAI_API_KEY is required before real clips can be analyzed." : runMessage}</span></div>
        <button type="button" disabled={!canAnalyze} onClick={() => void runAnalysis()}>
          {runState === "running" ? "Analyzing…" : result ? "Analyze again" : "Analyze with OpenAI"} <span>✦</span>
        </button>
      </div>

      {result && selectedMoment && (
        <div className="real-results">
          <div className="real-result-heading">
            <div><span className="real-kicker"><i /> VERIFIED SQUAD RECONSTRUCTION</span><h2>{result.storyTitle}</h2><p>{result.recap}</p></div>
            <div className="real-link-proof"><span>CROSS-CLIP RESPONSE</span><code>{result.api.responseId}</code><small>{result.api.model} · {result.api.inputTokens + result.api.outputTokens} tokens</small></div>
          </div>

          <div className="real-result-grid">
            <nav className="real-moment-list" aria-label="AI-linked squad moments">
              {result.linkedMoments.map((moment, index) => (
                <button type="button" key={moment.id} className={moment.id === selectedMoment.id ? "active" : ""} onClick={() => setSelectedMomentId(moment.id)}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <span><strong>{moment.title}</strong><small>{formatMs(moment.sharedTimeMs)} · impact {Math.round(moment.importance)}</small></span>
                </button>
              ))}
            </nav>
            <article className="real-moment-detail">
              <div className="real-moment-title"><span>{selectedMoment.emotion}</span><h3>{selectedMoment.title}</h3><p>{selectedMoment.summary}</p></div>
              <div className="real-link-reason"><strong>WHY THESE POVs WERE LINKED</strong><p>{selectedMoment.whyLinked}</p></div>
              <div className="real-evidence-list">
                {selectedMoment.sourceLinks.map((source, index) => {
                  const clip = clips.find((candidate) => candidate.id === source.clipId);
                  const observation = clip?.analysis?.observations.find((candidate) => candidate.id === source.observationId);
                  return (
                    <button type="button" key={`${source.clipId}-${source.observationId}-${index}`} onClick={() => seekEvidence(source.clipId, source.timestampMs)}>
                      <span>{source.role.toUpperCase()}</span>
                      <strong>{clip?.playerLabel ?? source.clipId} · {formatMs(source.timestampMs)}</strong>
                      <p>{observation?.description ?? source.observationId}</p>
                      <small>{observation?.evidenceFrameIds.join(" · ")} ↗ PLAY SOURCE</small>
                    </button>
                  );
                })}
              </div>
            </article>
          </div>

          <div className="real-director-cut">
            <div><span className="real-kicker"><i /> GENERATED EDIT DECISION LIST</span><h3>Director’s Cut</h3></div>
            <div>
              {result.directorCut.map((beat) => {
                const clip = clips.find((candidate) => candidate.id === beat.clipId);
                return (
                  <button type="button" key={`${beat.order}-${beat.momentId}`} onClick={() => seekEvidence(beat.clipId, beat.timestampMs)}>
                    <span>{String(beat.order).padStart(2, "0")}</span>
                    <strong>{clip?.playerLabel ?? beat.clipId} · {formatMs(beat.timestampMs)}</strong>
                    <small>{beat.reason}</small>
                  </button>
                );
              })}
            </div>
          </div>

          {result.whatYouMissed.length > 0 && (
            <div className="real-missed">
              <div><span className="real-kicker"><i /> PERSONALIZED REVEALS</span><h3>What You Missed</h3></div>
              <div className="real-missed-grid">
                {result.whatYouMissed.map((missed, index) => {
                  const viewer = clips.find((clip) => clip.id === missed.viewerClipId);
                  return (
                    <article key={`${missed.viewerClipId}-${missed.momentId}-${index}`}>
                      <span>FOR {viewer?.playerLabel.toUpperCase() ?? missed.viewerClipId}</span>
                      <h4>{missed.title}</h4>
                      <p>{missed.explanation}</p>
                      <div>
                        {missed.evidenceLinks.map((link) => {
                          const source = clips.find((clip) => clip.id === link.clipId);
                          return (
                            <button type="button" key={`${link.clipId}-${link.observationId}`} onClick={() => seekEvidence(link.clipId, link.timestampMs)}>
                              {source?.playerLabel ?? link.clipId} · {formatMs(link.timestampMs)} ↗
                            </button>
                          );
                        })}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}

          <div className="real-ask">
            <div>
              <span className="real-kicker"><i /> GROUNDED SESSION SEARCH</span>
              <h3>Ask what happened off-screen.</h3>
              <p>Answers use only this run’s verified observations and return playable citations.</p>
            </div>
            <form onSubmit={(event) => void askSession(event)}>
              <label htmlFor="real-session-question">Question about this session</label>
              <div>
                <input
                  id="real-session-question"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="What were my teammates doing during the final fight?"
                  maxLength={500}
                />
                <button type="submit" disabled={!question.trim() || isAsking}>{isAsking ? "Checking evidence…" : "Ask UNSEEN ↗"}</button>
              </div>
            </form>
            {askError && <p className="real-ask-error">{askError}</p>}
            {answer && (
              <article className="real-answer">
                <div><span>{answer.answerType.replaceAll("_", " ")}</span><code>{answer.api.responseId}</code></div>
                <p>{answer.answer}</p>
                <small>{answer.caveat}</small>
                <div>
                  {answer.citations.map((citation) => {
                    const source = clips.find((clip) => clip.id === citation.clipId);
                    return (
                      <button type="button" key={`${citation.clipId}-${citation.observationId}`} onClick={() => seekEvidence(citation.clipId, citation.timestampMs)}>
                        {source?.playerLabel ?? citation.clipId} · {formatMs(citation.timestampMs)} · {citation.observationId} ↗
                      </button>
                    );
                  })}
                </div>
              </article>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export function RealAnalysisWorkbench() {
  const [mode, setMode] = useState<"gameplay-search" | "squad-reconstruction">("gameplay-search");

  return (
    <>
      <nav className="analysis-mode-tabs" aria-label="UNSEEN analysis mode">
        <button
          type="button"
          className={mode === "gameplay-search" ? "active" : ""}
          aria-pressed={mode === "gameplay-search"}
          onClick={() => setMode("gameplay-search")}
        >
          <span>01</span>
          <strong>Gameplay Search</strong>
          <small>Find moments in long footage + export reels</small>
        </button>
        <button
          type="button"
          className={mode === "squad-reconstruction" ? "active" : ""}
          aria-pressed={mode === "squad-reconstruction"}
          onClick={() => setMode("squad-reconstruction")}
        >
          <span>02</span>
          <strong>Squad Reconstruction</strong>
          <small>Link the same session across 2–4 POVs</small>
        </button>
      </nav>
      <div hidden={mode !== "gameplay-search"}>
        <GameplaySearchWorkbench />
      </div>
      <div hidden={mode !== "squad-reconstruction"}>
        <SquadAnalysisWorkbench />
      </div>
    </>
  );
}
