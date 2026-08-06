"use client";

import {
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ApiError,
  AskCitation,
  AskDemoResponse,
  DemoSessionResponse,
  Participant,
  ParticipantId,
  PreloadedRecording,
  ProcessDemoResponse,
  SessionEvidence,
  UnseenSession,
} from "@/lib/unseen-types";
import type {
  AlignmentResult,
  EditPlan,
  RankedMediaMoment,
} from "@/lib/unseen-ai";
import type {
  MissedPerspectiveMoment,
  PipelineAuditEntry,
} from "@/lib/unseen-pipeline";
import { RealAnalysisWorkbench } from "./real-analysis-workbench";
import "./unseen-experience.css";

type StoryMode = "director" | "missed";
type ProcessState = "idle" | "running" | "complete" | "error";

interface ReasoningResponse {
  version: string;
  sessionId: string;
  alignment: AlignmentResult;
  rankedMoments: RankedMediaMoment[];
  editPlan: EditPlan;
  whatYouMissed: MissedPerspectiveMoment[];
  audit: PipelineAuditEntry[];
}

interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  citations?: AskCitation[];
}

interface TimelineItem {
  id: string;
  momentId: string;
  title: string;
  summary: string;
  startMs: number;
  endMs: number;
  score: number;
  playerId: ParticipantId;
  evidenceIds: string[];
  category: string;
}

type OfficialScanState = "idle" | "running" | "complete";

interface OfficialGarenaClip {
  id: "setup" | "triple" | "reaction";
  index: string;
  startSeconds: number;
  endSeconds: number;
  title: string;
  beat: string;
  summary: string;
  signals: string[];
}

const OFFICIAL_GARENA_VIDEO_ID = "DFxrTiUqpCM";

const OFFICIAL_GARENA_CLIPS: OfficialGarenaClip[] = [
  {
    id: "setup",
    index: "01",
    startSeconds: 21_957,
    endSeconds: 21_970,
    title: "Match-point setup",
    beat: "6:05:57 · GAME 3 / ROUND 10",
    summary:
      "The broadcast follows AG.DEW with Fluxo leading the positional fight and All Gamers one round from the map.",
    signals: [
      "HUD OCR · GAME 3, ROUND 10/11, FX 4 — AG 5",
      "State detection · MATCH POINT banner is active",
      "Player focus · broadcast perspective isolates AG.DEW",
      "Caption signal · commentary calls out Fluxo's positional edge",
    ],
  },
  {
    id: "triple",
    index: "02",
    startSeconds: 21_980,
    endSeconds: 21_989,
    title: "The clutch turns",
    beat: "6:06:20 · COMBAT INFLECTION",
    summary:
      "At one second remaining, the combat overlay credits AG.DEW with a triple kill and the caster reaction spikes.",
    signals: [
      "Combat overlay · TRIPLE KILL credited to AG.DEW",
      "Timer OCR · 00:01 remains on the round clock",
      "Player-state fusion · final opposition silhouette stays active",
      "Audio + captions · caster reacts, ‘Oh, dude, what?’",
    ],
  },
  {
    id: "reaction",
    index: "03",
    startSeconds: 21_989,
    endSeconds: 22_004,
    title: "The payoff lands",
    beat: "6:06:29 · LIVE TEAM REACTION",
    summary:
      "The feed cuts from gameplay to the All Gamers stage as the broadcast confirms an ace on map three.",
    signals: [
      "Scene transition · gameplay cuts to the All Gamers stage",
      "Caption signal · ‘finish line with an ace on map three’",
      "Reaction detection · players rise as stage effects fire",
      "Story link · triple kill → ace → team celebration",
    ],
  },
];

const initialMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "Once reconstruction finishes, ask what happened off-screen. I’ll answer only from this session’s permitted evidence.",
  },
];

function formatTimestamp(timestampMs: number) {
  const totalSeconds = Math.max(0, Math.floor(timestampMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function titleCase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function playerFromSource(session: UnseenSession, sourceId: string | undefined) {
  return session.sources.find((source) => source.id === sourceId)?.participantId;
}

function errorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const apiError = payload as Partial<ApiError>;
  return apiError.error?.message || fallback;
}

async function parseErrorResponse(response: Response, fallback: string) {
  const payload = await response.json().catch(() => null);
  return errorMessage(payload, fallback);
}

function PreloadedRecordingCard({
  recording,
  participant,
}: {
  recording: PreloadedRecording;
  participant: Participant;
}) {
  function cuePreview(video: HTMLVideoElement) {
    video.currentTime = Math.min(
      Math.max(0, recording.preloadCueMs / 1000),
      Math.max(0, video.duration - 0.3),
    );
  }

  return (
    <article className={`input-recording input-${participant.id}`}>
      <div className="input-video-wrap">
        <video
          src={recording.assetUrl}
          poster={`/demo/${participant.id}-poster.jpg`}
          preload="metadata"
          playsInline
          muted
          controls
          onLoadedMetadata={(event) => cuePreview(event.currentTarget)}
          aria-label={`${participant.displayName} preloaded synthetic source recording`}
        />
        <span className="input-ready"><i /> PRELOADED</span>
        <span className="input-cue">CUE {formatTimestamp(recording.preloadCueMs)}</span>
      </div>
      <div className="input-meta">
        <span className={`avatar avatar-${participant.accent}`}>{participant.avatarInitials}<i /></span>
        <div>
          <strong>{recording.label}</strong>
          <span>{formatDuration(recording.durationMs)} · gameplay + opted-in voice</span>
        </div>
        <code>{recording.sha256.slice(0, 8)}</code>
      </div>
    </article>
  );
}

function OfficialGarenaFootage() {
  const [activeClipId, setActiveClipId] = useState<OfficialGarenaClip["id"]>("triple");
  const [scanState, setScanState] = useState<OfficialScanState>("idle");
  const [scanProgress, setScanProgress] = useState(0);
  const activeClip =
    OFFICIAL_GARENA_CLIPS.find((clip) => clip.id === activeClipId) ??
    OFFICIAL_GARENA_CLIPS[1];
  const visibleSignalCount =
    scanState === "complete"
      ? activeClip.signals.length
      : scanState === "running"
        ? Math.max(1, Math.ceil((scanProgress / 100) * activeClip.signals.length))
        : 0;
  const embedUrl = `https://www.youtube-nocookie.com/embed/${OFFICIAL_GARENA_VIDEO_ID}?start=${activeClip.startSeconds}&end=${activeClip.endSeconds}&rel=0&modestbranding=1&playsinline=1`;

  function selectClip(id: OfficialGarenaClip["id"]) {
    setActiveClipId(id);
    setScanState("idle");
    setScanProgress(0);
  }

  async function runOfficialScan() {
    if (scanState === "running") return;
    setScanState("running");
    setScanProgress(8);
    for (const nextProgress of [31, 57, 78, 100]) {
      await new Promise((resolve) => setTimeout(resolve, 280));
      setScanProgress(nextProgress);
    }
    setScanState("complete");
  }

  return (
    <section className="official-footage" aria-labelledby="official-footage-title">
      <div className="official-footage-heading">
        <div>
          <span className="eyebrow">01 · AUTHENTIC GARENA GAMEPLAY</span>
          <h2 id="official-footage-title">A real Free Fire clutch. Read beat by beat.</h2>
        </div>
        <div className="official-source-lockup">
          <span><i /> OFFICIAL SOURCE</span>
          <strong>Free Fire Esports Official</strong>
          <small>FFWS Global Finals 2025 · Clash Squad</small>
        </div>
      </div>

      <div className="official-footage-grid">
        <div className="official-player-column">
          <div className="official-player-wrap">
            <iframe
              key={activeClip.id}
              src={embedUrl}
              title={`Official Free Fire gameplay — ${activeClip.title}`}
              loading="lazy"
              allow="accelerometer; encrypted-media; picture-in-picture"
              allowFullScreen
            />
            <span className="official-player-badge"><i /> REAL FREE FIRE BROADCAST</span>
            <span className="official-player-time">{activeClip.beat}</span>
          </div>

          <div className="official-clip-selector" role="group" aria-label="Select official Free Fire clip">
            {OFFICIAL_GARENA_CLIPS.map((clip) => (
              <button
                key={clip.id}
                type="button"
                className={activeClip.id === clip.id ? "active" : ""}
                aria-pressed={activeClip.id === clip.id}
                onClick={() => selectClip(clip.id)}
              >
                <span>{clip.index}</span>
                <span><strong>{clip.title}</strong><small>{clip.beat}</small></span>
              </button>
            ))}
          </div>
        </div>

        <aside className="official-analysis" aria-live="polite">
          <div className="official-analysis-kicker">
            <span><i /> VERIFIED CLIP TRACE</span>
            <code>GAR-FFWS-2025-06:06</code>
          </div>
          <h3>{activeClip.title}</h3>
          <p>{activeClip.summary}</p>

          <button
            className="official-scan-button"
            type="button"
            onClick={() => void runOfficialScan()}
            disabled={scanState === "running"}
          >
            {scanState === "running"
              ? `Scanning official clip · ${scanProgress}%`
              : scanState === "complete"
                ? "Replay evidence scan"
                : "Replay verified observations"}
          </button>

          <div className="official-scan-track" aria-hidden="true">
            <i style={{ width: `${scanProgress}%` }} />
          </div>

          <div className={`official-signals signals-${scanState}`}>
            {activeClip.signals.map((signal, index) => (
              <div key={signal} className={index < visibleSignalCount ? "observed" : ""}>
                <span>{index < visibleSignalCount ? "✓" : String(index + 1).padStart(2, "0")}</span>
                <p>{signal}</p>
              </div>
            ))}
          </div>

          <div className="official-disclosure">
            <strong>REAL FOOTAGE / HONEST PROTOTYPE</strong>
            <p>
              Playback stays embedded from Garena’s verified channel. For submission reliability,
              the scan replays observations verified against these exact broadcast frames; it does
              not claim access to private player comms or missing squad POVs.
            </p>
            <a
              href={`https://www.youtube.com/watch?v=${OFFICIAL_GARENA_VIDEO_ID}&t=${activeClip.startSeconds}s`}
              target="_blank"
              rel="noreferrer"
            >
              View official source ↗
            </a>
          </div>
        </aside>
      </div>
    </section>
  );
}

interface UnseenExperienceProps {
  viewer: { displayName: string; email: string } | null;
  signInPath: string;
  signOutPath: string;
}

export function UnseenExperience({ viewer, signInPath, signOutPath }: UnseenExperienceProps) {
  const [session, setSession] = useState<UnseenSession | null>(null);
  const [sessionError, setSessionError] = useState("");
  const [reasoning, setReasoning] = useState<ReasoningResponse | null>(null);
  const [activePerspective, setActivePerspective] = useState<ParticipantId>("ace");
  const [activeMomentId, setActiveMomentId] = useState("");
  const [activeEvidenceId, setActiveEvidenceId] = useState("");
  const [mode, setMode] = useState<StoryMode>("director");
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackProgress, setPlaybackProgress] = useState(0);
  const [activeClipIndex, setActiveClipIndex] = useState(0);
  const [seekMs, setSeekMs] = useState(0);
  const [processState, setProcessState] = useState<ProcessState>("idle");
  const [progress, setProgress] = useState(0);
  const [processMessage, setProcessMessage] = useState(
    "Loading the consented session fixture…",
  );
  const [analysisStatus, setAnalysisStatus] = useState<
    ProcessDemoResponse["mediaAnalysis"] | null
  >(null);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [question, setQuestion] = useState("");
  const [isAsking, setIsAsking] = useState(false);
  const [chatError, setChatError] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const seekOriginSeconds = useRef(0);
  const advancingClip = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      try {
        const response = await fetch("/api/demo/session", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(
            await parseErrorResponse(response, "The demo session could not be loaded."),
          );
        }
        const payload = (await response.json()) as DemoSessionResponse;
        if (cancelled) return;
        setSession(payload.session);
        setActivePerspective(payload.session.focusParticipantId);
        setProcessMessage(
          `${payload.session.media.recordings.length} preloaded recordings are ready to analyze.`,
        );
      } catch (error) {
        if (cancelled) return;
        setSessionError(
          error instanceof Error ? error.message : "The demo session could not be loaded.",
        );
        setProcessMessage("Session input is unavailable.");
      }
    }

    void loadSession();
    return () => {
      cancelled = true;
    };
  }, []);

  const participantById = useMemo(
    () => new Map(session?.participants.map((participant) => [participant.id, participant]) ?? []),
    [session],
  );
  const evidenceById = useMemo(
    () => new Map(session?.evidence.map((evidence) => [evidence.id, evidence]) ?? []),
    [session],
  );

  const missedMoments = useMemo(() => {
    if (!reasoning || !session) return [];
    const aceSource = session.sources.find(
      (source) => source.participantId === session.focusParticipantId,
    )?.id;
    return reasoning.whatYouMissed.filter(
      (moment) =>
        moment.revealSourceIds.length > 0 &&
        moment.revealSourceIds.every((sourceId) => sourceId !== aceSource),
    );
  }, [reasoning, session]);

  const timelineItems = useMemo<TimelineItem[]>(() => {
    if (!reasoning || !session) return [];

    if (mode === "missed") {
      return missedMoments.map((missed) => {
        const sourceId = missed.revealSourceIds[0];
        return {
          id: `missed-${missed.momentId}-${sourceId}`,
          momentId: missed.momentId,
          title: missed.title,
          summary: missed.summary,
          startMs: missed.startMs,
          endMs: missed.endMs,
          score: missed.score,
          playerId:
            playerFromSource(session, sourceId) ?? session.focusParticipantId,
          evidenceIds: missed.evidenceIds,
          category: "what_you_missed",
        };
      });
    }

    return reasoning.rankedMoments.map((moment) => {
      const preferred = moment.perspectives.find(
        (perspective) =>
          perspective.permitted !== false && perspective.visibility === "visible",
      );
      return {
        id: moment.id,
        momentId: moment.id,
        title: moment.title,
        summary: moment.summary,
        startMs: moment.startMs,
        endMs: moment.endMs,
        score: moment.score,
        playerId: (preferred?.playerId as ParticipantId) ?? session.focusParticipantId,
        evidenceIds: moment.evidence.map((evidence) => evidence.id),
        category: moment.category,
      };
    });
  }, [missedMoments, mode, reasoning, session]);

  const activeItem =
    timelineItems.find(
      (item) => item.id === activeMomentId || item.momentId === activeMomentId,
    ) ?? timelineItems[0];
  const activeReasoningMoment = reasoning?.rankedMoments.find(
    (moment) => moment.id === activeItem?.momentId,
  );
  const selectedEvidence = (activeItem?.evidenceIds ?? [])
    .map((id) => evidenceById.get(id))
    .filter((item): item is SessionEvidence => Boolean(item));
  const transcriptEvidence = selectedEvidence.find(
    (evidence) => evidence.type === "voice_transcript" && Boolean(evidence.quote),
  );
  const activeParticipant = participantById.get(activePerspective);
  const activeClip = reasoning?.editPlan.clips[activeClipIndex];
  const activeSource = session?.sources.find(
    (source) => source.participantId === activePerspective,
  );
  const activeRecording = session?.media.recordings.find(
    (recording) => recording.sourceId === activeSource?.id,
  );
  const activeTraceEvidenceId = activeEvidenceId || selectedEvidence[0]?.id;
  const activeMediaTrace = session?.media.traces.find(
    (trace) => trace.evidenceId === activeTraceEvidenceId,
  );
  const activeSourceObservation = activeMediaTrace?.sourceObservations.find(
    (observation) => observation.sourceId === activeSource?.id,
  ) ?? activeMediaTrace?.sourceObservations[0];
  const observedTraces =
    session?.media.traces.filter((trace) =>
      analysisStatus?.observedEvidenceIds.includes(trace.evidenceId),
    ) ?? [];

  function sourceTimeFor(sharedMs: number, participantId: ParticipantId) {
    if (!reasoning || !session) return sharedMs;
    const sourceId = session.sources.find(
      (source) => source.participantId === participantId,
    )?.id;
    const transform = reasoning.alignment.transforms.find(
      (candidate) => candidate.sourceId === sourceId,
    );
    if (!transform || transform.rate === 0) return sharedMs;
    return Math.max(0, (sharedMs - transform.offsetMs) / transform.rate);
  }

  function safeVideoTime(video: HTMLVideoElement, requestedMs: number) {
    const requestedSeconds = Math.max(0, requestedMs / 1000);
    if (!Number.isFinite(video.duration) || video.duration <= 0.5) {
      return requestedSeconds;
    }
    const usableDuration = Math.max(0.25, video.duration - 0.25);
    return requestedSeconds <= usableDuration
      ? requestedSeconds
      : requestedSeconds % usableDuration;
  }

  function applySeek(video: HTMLVideoElement) {
    const target = safeVideoTime(video, seekMs);
    video.currentTime = target;
    seekOriginSeconds.current = target;
    if (isPlaying) void video.play().catch(() => setIsPlaying(false));
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 1) return;
    applySeek(video);
    // applySeek intentionally follows the currently selected synthetic source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePerspective, seekMs]);

  useEffect(() => {
    advancingClip.current = false;
  }, [activeClipIndex]);

  function seekTo(
    timestampMs: number,
    participantId: ParticipantId,
    play = false,
  ) {
    setActivePerspective(participantId);
    setSeekMs(timestampMs);
    setIsPlaying(play);
    if (participantId === activePerspective && videoRef.current?.readyState) {
      const target = safeVideoTime(videoRef.current, timestampMs);
      videoRef.current.currentTime = target;
      seekOriginSeconds.current = target;
      if (play) void videoRef.current.play().catch(() => setIsPlaying(false));
    }
  }

  function activateClip(index: number, play: boolean) {
    if (!reasoning || !session || reasoning.editPlan.clips.length === 0) return;
    const boundedIndex = Math.min(
      Math.max(index, 0),
      reasoning.editPlan.clips.length - 1,
    );
    const clip = reasoning.editPlan.clips[boundedIndex];
    const participantId = clip.playerId as ParticipantId;
    setMode("director");
    setActiveClipIndex(boundedIndex);
    setActiveMomentId(clip.momentId);
    setActiveEvidenceId("");
    seekTo(clip.sourceStartMs, participantId, play);
  }

  function selectTimelineItem(item: TimelineItem) {
    if (!reasoning || !session) return;
    setActiveMomentId(item.id);
    setActiveEvidenceId("");
    setIsPlaying(false);
    setPlaybackProgress(0);

    const matchingClipIndex = reasoning.editPlan.clips.findIndex(
      (clip) =>
        clip.momentId === item.momentId && clip.playerId === item.playerId,
    );
    if (matchingClipIndex >= 0) setActiveClipIndex(matchingClipIndex);
    const matchingClip = reasoning.editPlan.clips[matchingClipIndex];
    seekTo(
      matchingClip?.sourceStartMs ?? sourceTimeFor(item.startMs, item.playerId),
      item.playerId,
    );
  }

  function revealEvidence(evidence: SessionEvidence) {
    if (!session) return;
    const participantId =
      evidence.participantId ??
      playerFromSource(session, evidence.sourceId) ??
      activePerspective;
    setActiveEvidenceId(evidence.id);
    setPlaybackProgress(0);
    seekTo(
      sourceTimeFor(evidence.timestampMs, participantId),
      participantId,
    );
  }

  function revealCitation(citation: AskCitation) {
    if (!session) return;
    const evidence = evidenceById.get(citation.evidenceId);
    if (evidence) {
      const containingMoment = reasoning?.rankedMoments.find((moment) =>
        moment.evidence.some((item) => item.id === evidence.id),
      );
      if (containingMoment) setActiveMomentId(containingMoment.id);
      revealEvidence(evidence);
      document.getElementById("unseen-player")?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      return;
    }
    const participantId =
      citation.participantId ??
      playerFromSource(session, citation.sourceId) ??
      session.focusParticipantId;
    seekTo(sourceTimeFor(citation.timestampMs, participantId), participantId);
  }

  async function runReconstruction() {
    if (!session || processState === "running") return;

    setReasoning(null);
    setActiveMomentId("");
    setProcessState("running");
    setProgress(0);
    setAnalysisStatus(null);
    setProcessMessage("Verifying the three preloaded media fingerprints…");
    setIsPlaying(false);

    try {
      let cursor = 0;
      while (cursor < 6) {
        const response = await fetch("/api/demo/process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: session.id, cursor }),
        });
        if (!response.ok) {
          throw new Error(
            await parseErrorResponse(response, "Reconstruction could not continue."),
          );
        }
        const payload = (await response.json()) as ProcessDemoResponse;
        setProgress(payload.overallProgress);
        setAnalysisStatus(payload.mediaAnalysis);
        setProcessMessage(payload.mediaAnalysis.summary);
        if (payload.complete || payload.nextCursor === null) break;
        cursor = payload.nextCursor;
        await new Promise((resolve) => setTimeout(resolve, 380));
      }

      const reasoningResponse = await fetch("/api/demo/reasoning", {
        cache: "no-store",
      });
      if (!reasoningResponse.ok) {
        throw new Error(
          await parseErrorResponse(
            reasoningResponse,
            "Reasoning artifacts could not be loaded.",
          ),
        );
      }
      const artifacts = (await reasoningResponse.json()) as ReasoningResponse;
      setReasoning(artifacts);
      setProcessState("complete");
      setProgress(100);
      setProcessMessage(
        `${artifacts.rankedMoments.length} moments ranked · ${artifacts.editPlan.clips.length} evidence-linked cuts ready.`,
      );
      const firstClip = artifacts.editPlan.clips[0];
      if (firstClip) {
        setActiveClipIndex(0);
        setActiveMomentId(firstClip.momentId);
        setActivePerspective(firstClip.playerId as ParticipantId);
        setSeekMs(firstClip.sourceStartMs);
      }
    } catch (error) {
      setReasoning(null);
      setProcessState("error");
      setProcessMessage(
        error instanceof Error
          ? error.message
          : "Reconstruction could not be started. Please try again.",
      );
    }
  }

  function advanceDirectorCut() {
    if (!reasoning || advancingClip.current) return;
    advancingClip.current = true;
    const nextIndex = activeClipIndex + 1;
    if (nextIndex >= reasoning.editPlan.clips.length) {
      setIsPlaying(false);
      setPlaybackProgress(100);
      advancingClip.current = false;
      return;
    }
    activateClip(nextIndex, true);
  }

  function updatePlaybackProgress() {
    const video = videoRef.current;
    if (!video || !reasoning) return;
    const elapsedInClipMs = Math.max(
      0,
      (video.currentTime - seekOriginSeconds.current) * 1000,
    );
    if (mode === "missed") {
      const duration = Math.max(1, (activeItem?.endMs ?? 1) - (activeItem?.startMs ?? 0));
      setPlaybackProgress(Math.min(100, (elapsedInClipMs / duration) * 100));
      return;
    }
    if (!activeClip) return;
    const clipDurations = reasoning.editPlan.clips.map((clip) =>
      Math.max(0, clip.sharedEndMs - clip.sharedStartMs),
    );
    const elapsedBefore = clipDurations
      .slice(0, activeClipIndex)
      .reduce((total, duration) => total + duration, 0);
    const total = clipDurations.reduce((sum, duration) => sum + duration, 0) || 1;
    setPlaybackProgress(
      Math.min(100, ((elapsedBefore + elapsedInClipMs) / total) * 100),
    );
    if (
      isPlaying &&
      elapsedInClipMs >= activeClip.sharedEndMs - activeClip.sharedStartMs - 120
    ) {
      advanceDirectorCut();
    }
  }

  function togglePlayback() {
    if (!reasoning || reasoning.editPlan.clips.length === 0) return;
    const video = videoRef.current;
    if (isPlaying) {
      video?.pause();
      setIsPlaying(false);
      return;
    }
    if (mode === "director" && playbackProgress >= 99) {
      setPlaybackProgress(0);
      activateClip(0, true);
      return;
    }
    setIsPlaying(true);
    void video?.play().catch(() => setIsPlaying(false));
  }

  function switchMode(nextMode: StoryMode) {
    setMode(nextMode);
    setIsPlaying(false);
    setPlaybackProgress(0);
    const nextItems =
      nextMode === "missed"
        ? missedMoments.map((missed) => {
            const sourceId = missed.revealSourceIds[0];
            return {
              id: `missed-${missed.momentId}-${sourceId}`,
              momentId: missed.momentId,
              title: missed.title,
              summary: missed.summary,
              startMs: missed.startMs,
              endMs: missed.endMs,
              score: missed.score,
              playerId:
                (session && playerFromSource(session, sourceId)) || "ace",
              evidenceIds: missed.evidenceIds,
              category: "what_you_missed",
            } satisfies TimelineItem;
          })
        : reasoning?.rankedMoments.map((moment) => {
            const preferred = moment.perspectives.find(
              (perspective) =>
                perspective.permitted !== false && perspective.visibility === "visible",
            );
            return {
              id: moment.id,
              momentId: moment.id,
              title: moment.title,
              summary: moment.summary,
              startMs: moment.startMs,
              endMs: moment.endMs,
              score: moment.score,
              playerId: (preferred?.playerId as ParticipantId) || "ace",
              evidenceIds: moment.evidence.map((evidence) => evidence.id),
              category: moment.category,
            } satisfies TimelineItem;
          }) ?? [];
    if (nextItems[0]) selectTimelineItem(nextItems[0]);
  }

  async function askUnseen(prompt: string) {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || isAsking || !session || !reasoning) return;

    const messageIndex = messages.length;
    setMessages((current) => [
      ...current,
      { id: `user-${messageIndex}`, role: "user", content: cleanPrompt },
    ]);
    setQuestion("");
    setChatError("");
    setIsAsking(true);

    try {
      const response = await fetch("/api/demo/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: session.id,
          question: cleanPrompt,
          viewerId: session.focusParticipantId,
        }),
      });
      if (!response.ok) {
        throw new Error(
          await parseErrorResponse(
            response,
            "UNSEEN could not answer from this session’s evidence.",
          ),
        );
      }
      const answer = (await response.json()) as AskDemoResponse;
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${messageIndex}`,
          role: "assistant",
          content: answer.answer,
          citations: answer.citations,
        },
      ]);
    } catch (error) {
      setChatError(
        error instanceof Error
          ? error.message
          : "UNSEEN could not answer from this session’s evidence.",
      );
    } finally {
      setIsAsking(false);
    }
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void askUnseen(question);
  }

  const consentedCount =
    session?.participants.filter(
      (participant) =>
        participant.consent.gameplayRecording === "granted" &&
        participant.consent.aiAnalysis === "granted" &&
        participant.consent.squadSharing === "granted",
    ).length ?? 0;

  return (
    <main className="unseen-shell">
      <div className="unseen-ambient unseen-ambient-one" aria-hidden="true" />
      <div className="unseen-ambient unseen-ambient-two" aria-hidden="true" />

      <header className="unseen-header">
        <a className="unseen-brand" href="#experience" aria-label="UNSEEN home">
          <span className="unseen-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>UNSEEN</span>
        </a>
        <div className="session-identity">
          <span className="live-dot" aria-hidden="true" />
          <div>
            <strong>{session ? `${session.map} · ${session.mode}` : "LOADING SESSION"}</strong>
            <span>
              {session
                ? `${session.game} · ${formatDuration(session.durationMs)} · ${session.result} ${session.score}`
                : "Consent-gated fixture"}
            </span>
          </div>
        </div>
        <div className="header-actions">
          <div className={`auth-account ${viewer ? "is-signed-in" : "is-guest"}`}>
            <span aria-hidden="true" />
            <div>
              <strong title={viewer?.email}>{viewer?.displayName ?? "Guest viewer"}</strong>
              <a href={viewer ? signOutPath : signInPath}>
                {viewer ? "Sign out" : "Sign in with ChatGPT"}
              </a>
            </div>
          </div>
          <div className="consent-summary" aria-label={`${consentedCount} players opted in`}>
            <span aria-hidden="true">✓</span> {consentedCount}/{session?.participants.length ?? 3} opted in
          </div>
          <button
            className="reconstruct-button"
            type="button"
            onClick={() => document.getElementById("live-analysis")?.scrollIntoView({ behavior: "smooth" })}
          >
            <span className="button-spark" aria-hidden="true">✦</span>
            Analyze real clips
          </button>
        </div>
      </header>

      <div className="fixture-banner" role="note">
        <span>LIVE AI PIPELINE</span>
        The upload workbench runs real OpenAI vision, transcription, and cross-POV linking. The lower fixture remains a clearly disclosed benchmark only.
      </div>

      <RealAnalysisWorkbench />

      <OfficialGarenaFootage />

      {session && (
        <section className="media-intake" aria-labelledby="media-intake-title">
          <div className="media-intake-heading">
            <div>
              <span className="eyebrow">02 · CONSENTED MULTI-POV BENCHMARK</span>
              <h2 id="media-intake-title">Three POVs. One reconstructed squad story.</h2>
            </div>
            <p>
              Official broadcasts do not expose synchronized player recordings and
              private comms. This disclosed fixture safely demonstrates the complete product loop.
            </p>
          </div>
          <div className="input-recordings">
            {session.media.recordings.map((recording) => {
              const source = session.sources.find(
                (candidate) => candidate.id === recording.sourceId,
              );
              const participant = source
                ? participantById.get(source.participantId)
                : undefined;
              return participant ? (
                <PreloadedRecordingCard
                  key={recording.sourceId}
                  recording={recording}
                  participant={participant}
                />
              ) : null;
            })}
          </div>
          <div className="media-proof-strip">
            <span><i /> 3 media fingerprints verified</span>
            <span><i /> 6 alignment anchors embedded</span>
            <span><i /> {session.media.traces.length} evidence observations mapped</span>
            <span><i /> Synthetic benchmark · not a live AI result</span>
          </div>
          <button
            className="reconstruct-button"
            type="button"
            onClick={() => void runReconstruction()}
            disabled={!session || processState === "running"}
          >
            <span className="button-spark" aria-hidden="true">✦</span>
            {processState === "running"
              ? "Running benchmark…"
              : processState === "complete"
                ? "Replay synthetic benchmark"
                : "Run disclosed synthetic benchmark"}
          </button>
        </section>
      )}

      <section className="reconstruction-status" aria-live="polite">
        <div className={`status-icon status-${processState}`} aria-hidden="true">
          {processState === "complete" ? "✓" : processState === "error" ? "!" : "AI"}
        </div>
        <div className="status-copy">
          <div>
            <strong>
              {processState === "running"
                ? "Reconstructing shared reality"
                : processState === "complete"
                  ? "Reasoning artifacts ready"
                  : processState === "error"
                    ? "Reconstruction paused"
                    : "Session input ready"}
            </strong>
            <span>{sessionError || processMessage}</span>
          </div>
          <span className="status-percentage">
            {processState === "idle" ? "READY" : `${progress}%`}
          </span>
        </div>
        <div
          className="status-track"
          role="progressbar"
          aria-label="Reconstruction progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={processState === "idle" ? 0 : progress}
        >
          <span style={{ width: `${processState === "idle" ? 0 : progress}%` }} />
        </div>
      </section>

      {analysisStatus && session && (
        <section className="analysis-console" aria-label="Media analysis trace" aria-live="polite">
          <div className="analysis-console-head">
            <span><i /> MEDIA ANALYSIS TRACE</span>
            <strong>{analysisStatus.summary}</strong>
            <code>{analysisStatus.mode}</code>
          </div>
          <div className="analysis-metrics">
            <span><b>{analysisStatus.recordingsVerified}</b><small>files verified</small></span>
            <span><b>{analysisStatus.anchorsMatched}</b><small>anchors matched</small></span>
            <span><b>{analysisStatus.evidenceObserved}</b><small>signals observed</small></span>
            <span><b>{progress}%</b><small>pipeline complete</small></span>
          </div>
          <div className="detector-row" aria-label="Active analysis detectors">
            {analysisStatus.activeDetectors.length > 0 ? (
              analysisStatus.activeDetectors.map((detector) => (
                <span key={detector}><i /> {titleCase(detector)}</span>
              ))
            ) : (
              <span><i /> Media integrity + consent gate</span>
            )}
          </div>
          <div className="trace-stream">
            {observedTraces.length > 0 ? (
              observedTraces.slice(-4).map((trace) => (
                <div key={trace.evidenceId}>
                  <time>{formatTimestamp(trace.sharedTimeMs)}</time>
                  <span>{trace.observation}</span>
                  <code>{trace.evidenceId}</code>
                </div>
              ))
            ) : (
              <div><time>00:00</time><span>Waiting for synchronized observations…</span><code>media_scan</code></div>
            )}
          </div>
        </section>
      )}

      <section className="experience-heading" id="experience">
        <div>
          <span className="eyebrow">MULTI-PERSPECTIVE RECONSTRUCTION</span>
          <h1>The round you won.<br /><em>The story you missed.</em></h1>
        </div>
        <div className="mode-switch" role="group" aria-label="Recap mode">
          <button
            className={mode === "director" ? "active" : ""}
            type="button"
            aria-pressed={mode === "director"}
            disabled={!reasoning}
            onClick={() => switchMode("director")}
          >
            <span aria-hidden="true">▶</span>
            <span><strong>Director’s Cut</strong><small>AI edit plan</small></span>
          </button>
          <button
            className={mode === "missed" ? "active" : ""}
            type="button"
            aria-pressed={mode === "missed"}
            disabled={!reasoning || missedMoments.length === 0}
            onClick={() => switchMode("missed")}
          >
            <span aria-hidden="true">◎</span>
            <span><strong>What You Missed</strong><small>Filtered for Ace</small></span>
          </button>
        </div>
      </section>

      {!reasoning ? (
        <section className="locked-reconstruction" aria-labelledby="locked-title">
          <span className="locked-orbit" aria-hidden="true"><i /><i /><i /></span>
          <span className="eyebrow">RESULTS GATED</span>
          <h2 id="locked-title">
            {processState === "running" ? "Analyzing the preloaded squad footage…" : "The footage is loaded. Reveal what nobody saw."}
          </h2>
          <p>
            One click replays the media analysis trace: fingerprint verification,
            synchronization, HUD and visual detection, opted-in speech, cross-POV
            fusion, moment ranking, and the final edit plan.
          </p>
          <button
            type="button"
            onClick={() => void runReconstruction()}
            disabled={!session || processState === "running"}
          >
            {processState === "running" ? `${progress}% complete` : "Analyze preloaded recordings"}
          </button>
        </section>
      ) : (
        <>
          <section className="story-grid" id="unseen-player" aria-label="Reconstructed session player">
            <div className="player-column">
              <div className={`game-viewport pov-${activePerspective}`}>
                <div className="viewport-chrome">
                  <span className="pov-pill"><i /> {activeParticipant?.displayName.toUpperCase()} POV</span>
                  <span className="moment-counter">
                    {mode === "director" && activeClip
                      ? `EDIT BEAT ${activeClipIndex + 1} / ${reasoning.editPlan.clips.length}`
                      : `EVIDENCE REVEAL`}
                  </span>
                  <span className="sync-pill">SYNTHETIC CLIP · SYNCED</span>
                </div>

                <div className="game-world video-world">
                  <video
                    key={activePerspective}
                    ref={videoRef}
                    className="pov-video"
                    src={activeRecording?.assetUrl}
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={(event) => applySeek(event.currentTarget)}
                    onTimeUpdate={updatePlaybackProgress}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() =>
                      mode === "director" ? advanceDirectorCut() : setIsPlaying(false)
                    }
                    aria-label={`${activeParticipant?.displayName ?? activePerspective} synthetic challenge gameplay clip`}
                  />
                  <div className="video-vignette" aria-hidden="true" />
                  <div className="synthetic-watermark">SYNTHETIC CHALLENGE FOOTAGE</div>
                  <button
                    className={`play-control ${isPlaying ? "playing" : ""}`}
                    type="button"
                    onClick={togglePlayback}
                    aria-label={
                      isPlaying
                        ? mode === "director" ? "Pause Director’s Cut" : "Pause evidence clip"
                        : mode === "director" ? "Play Director’s Cut" : "Play evidence clip"
                    }
                  >
                    <span aria-hidden="true">{isPlaying ? "Ⅱ" : "▶"}</span>
                  </button>

                  <div className="story-caption">
                    <span className="story-tag">
                      {mode === "missed" ? "WHAT ACE MISSED" : titleCase(activeClip?.storyRole ?? "model edit")}
                    </span>
                    <h2>{activeItem?.title ?? activeClip?.caption}</h2>
                    <p>{activeItem?.summary ?? activeClip?.rationale}</p>
                  </div>

                  <div className="playback-bar">
                    <span>{mode === "director" ? "DIRECTOR’S CUT" : "EVIDENCE CLIP"}</span>
                    <div
                      role="progressbar"
                      aria-label="Director’s Cut playback progress"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(playbackProgress)}
                    >
                      <i style={{ width: `${playbackProgress}%` }} />
                    </div>
                    <b>{Math.round(playbackProgress)}%</b>
                  </div>
                </div>
              </div>

              <div className="perspective-rail" aria-label="Switch player perspective">
                <div className="rail-label">
                  <span>SWITCH PERSPECTIVE</span>
                  <small>Seek stays evidence-linked</small>
                </div>
                {session?.participants.map((player) => {
                  const source = session?.sources.find((item) => item.participantId === player.id);
                  return (
                    <button
                      key={player.id}
                      className={`perspective-card ${activePerspective === player.id ? "active" : ""}`}
                      type="button"
                      aria-pressed={activePerspective === player.id}
                      onClick={() =>
                        seekTo(
                          sourceTimeFor(activeItem?.startMs ?? 0, player.id),
                          player.id,
                        )
                      }
                    >
                      <span className={`avatar avatar-${player.accent}`}>{player.avatarInitials}<i /></span>
                      <span className="perspective-copy">
                        <strong>{player.displayName}<small>{player.role}</small></strong>
                        <span>{player.character} · {source?.alignmentConfidence ? `${Math.round(source.alignmentConfidence * 100)}% aligned` : "source ready"}</span>
                      </span>
                      <span className="consent-badge"><i /> Gameplay + AI · {player.consent.voiceChat === "granted" ? "Voice on" : "Voice off"}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <aside className="evidence-panel" aria-labelledby="evidence-title">
              <div className="panel-kicker">
                <span>TRACEABLE REASONING</span>
                <span className="confidence"><i /> {selectedEvidence.length} linked evidence</span>
              </div>
              <h2 id="evidence-title">Why this moment matters</h2>
              <p className="evidence-lede">
                <strong>Model note · </strong>{activeReasoningMoment?.summary ?? activeItem?.summary}
              </p>

              {activeReasoningMoment && (
                <div className="impact-score">
                  <div className="score-ring" style={{ "--score": `${activeReasoningMoment.score * 3.6}deg` } as React.CSSProperties}>
                    <span>{Math.round(activeReasoningMoment.score)}</span><small>/100</small>
                  </div>
                  <div>
                    <span>NARRATIVE IMPACT</span>
                    <strong>{activeReasoningMoment.score >= 90 ? "Round-defining" : activeReasoningMoment.score >= 75 ? "High impact" : "Story context"}</strong>
                    <small>
                      Weighted contributions · gameplay +{activeReasoningMoment.breakdown.gameplayImportance.toFixed(1)} · cross-POV +{activeReasoningMoment.breakdown.crossPerspectiveNovelty.toFixed(1)} · reaction +{activeReasoningMoment.breakdown.reactionStrength.toFixed(1)} · story +{activeReasoningMoment.breakdown.narrativeValue.toFixed(1)}
                    </small>
                  </div>
                </div>
              )}

              <div className="evidence-block">
                <h3><span aria-hidden="true">⌁</span> Evidence trail · tap to inspect</h3>
                <div className="evidence-list">
                  {selectedEvidence.map((evidence, index) => {
                    const trace = session?.media.traces.find(
                      (candidate) => candidate.evidenceId === evidence.id,
                    );
                    return (
                      <button
                        key={evidence.id}
                        type="button"
                        className={activeEvidenceId === evidence.id ? "active" : ""}
                        onClick={() => revealEvidence(evidence)}
                      >
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <span>
                          <strong>{evidence.label}</strong>
                          <small>
                            {trace?.modalities.map(titleCase).join(" + ") ?? titleCase(evidence.type)} · {formatTimestamp(evidence.timestampMs)}
                          </small>
                        </span>
                        <i aria-hidden="true">↗</i>
                      </button>
                    );
                  })}
                </div>
              </div>

              {transcriptEvidence?.quote ? (
                <blockquote>
                  <span aria-hidden="true">“</span>
                  <p>{transcriptEvidence.quote}</p>
                  <cite>
                    Verified transcript · {participantById.get(transcriptEvidence.participantId ?? "ace")?.displayName} · {formatTimestamp(transcriptEvidence.timestampMs)}
                  </cite>
                </blockquote>
              ) : (
                <div className="model-note-card">
                  <span>MODEL / EVIDENCE NOTE</span>
                  <p>No opted-in transcript is attached to this selected evidence. The description above is an AI reasoning summary, not a player quote.</p>
                </div>
              )}

              {activeMediaTrace && (
                <div className="source-proof-card">
                  <span>MEDIA → EVIDENCE</span>
                  <strong>{activeMediaTrace.observation}</strong>
                  <small>
                    {activeMediaTrace.modalities.map(titleCase).join(" + ")} · source frame {formatTimestamp(activeSourceObservation?.sourceTimeMs ?? activeMediaTrace.sharedTimeMs)} · {activeMediaTrace.evidenceId}
                  </small>
                </div>
              )}

              <div className="model-notes">
                <span><i aria-hidden="true" /> Visual <b>{selectedEvidence.filter((item) => item.type === "visual_event" || item.type === "hud_signal").length}</b></span>
                <span><i aria-hidden="true" /> Transcript <b>{selectedEvidence.filter((item) => item.type === "voice_transcript").length}</b></span>
                <span><i aria-hidden="true" /> Visible POVs <b>{activeReasoningMoment?.perspectives.filter((item) => item.visibility === "visible" && item.permitted !== false).length ?? 0}/3</b></span>
              </div>
            </aside>
          </section>

          <section className="timeline-section" aria-labelledby="timeline-title">
            <div className="section-title-row">
              <div>
                <span className="eyebrow">
                  {mode === "missed" ? "ACE’S CANONICAL MISSED MOMENTS" : "RANKED REASONING OUTPUT"}
                </span>
                <h2 id="timeline-title">
                  {mode === "missed"
                    ? `${timelineItems.length} moments Ace couldn’t see.`
                    : `${timelineItems.length} evidence-backed stories.`}
                </h2>
              </div>
              <div className="timeline-legend">
                <span><i className="legend-tactical" /> Narrative impact</span>
                <span><i className="legend-turn" /> Click to seek</span>
              </div>
            </div>

            <div className="timeline-track" style={{ "--timeline-count": timelineItems.length } as React.CSSProperties}>
              <div className="timeline-line" aria-hidden="true" />
              {timelineItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`timeline-moment moment-${item.category} ${activeItem?.id === item.id ? "active" : ""}`}
                  aria-pressed={activeItem?.id === item.id}
                  onClick={() => selectTimelineItem(item)}
                >
                  <span className="moment-time"><b>{formatTimestamp(item.startMs)}</b><small>{formatDuration(item.endMs - item.startMs)}</small></span>
                  <span className="moment-node"><i /></span>
                  <span className="moment-card">
                    <span className="moment-topline"><i className={`mini-avatar mini-${item.playerId}`} />{participantById.get(item.playerId)?.displayName}<b>{Math.round(item.score)}</b></span>
                    <strong>{item.title}</strong>
                    <small>{item.summary}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      <section className={`ask-section ${!reasoning ? "ask-locked" : ""}`} aria-labelledby="ask-title">
        <div className="ask-intro">
          <span className="ask-orbit" aria-hidden="true"><i /><i /><i /></span>
          <span className="eyebrow">CONVERSATIONAL SESSION SEARCH</span>
          <h2 id="ask-title">Ask the game what<br />you never saw.</h2>
          <p>Answers cite the synchronized preloaded recordings. Every citation switches POV and seeks the supporting source frame.</p>
          <div className="privacy-note"><span aria-hidden="true">◈</span><p><strong>Consent-aware by design</strong>Gameplay, voice, analysis, and squad sharing grants are checked before evidence enters the story.</p></div>
        </div>

        <div className="chat-card">
          <div className="chat-header">
            <div><span className="ai-presence" aria-hidden="true">U</span><p><strong>Ask UNSEEN</strong><small>{reasoning ? `${reasoning.version} · fixture evidence` : "Available after reconstruction"}</small></p></div>
            <span className="online-status"><i /> {reasoning ? "READY" : "LOCKED"}</span>
          </div>

          <div className="chat-messages" aria-live="polite" aria-busy={isAsking}>
            {messages.map((message) => (
              <div key={message.id} className={`chat-message message-${message.role}`}>
                <span className="message-author">{message.role === "assistant" ? "U" : participantById.get(session?.focusParticipantId ?? "ace")?.avatarInitials ?? "AE"}</span>
                <div>
                  <p>{message.content}</p>
                  {message.citations && message.citations.length > 0 && (
                    <div className="chat-sources" aria-label="Answer evidence citations">
                      {message.citations.map((citation) => (
                        <button
                          type="button"
                          key={citation.evidenceId}
                          onClick={() => revealCitation(citation)}
                        >
                          <span>⌁ {citation.timestampLabel}</span>{citation.label}<i aria-hidden="true">↗</i>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isAsking && (
              <div className="chat-message message-assistant typing-message">
                <span className="message-author">U</span>
                <div><span /><span /><span /><small>Tracing permitted evidence…</small></div>
              </div>
            )}
          </div>

          <div className="suggested-questions" aria-label="Suggested questions">
            {(session?.suggestedQuestions ?? []).slice(0, 2).map((suggestion) => (
              <button type="button" key={suggestion} onClick={() => void askUnseen(suggestion)} disabled={isAsking || !reasoning}>
                <span aria-hidden="true">✦</span>{suggestion}
              </button>
            ))}
          </div>

          <form className="ask-form" onSubmit={submitQuestion}>
            <label htmlFor="unseen-question" className="sr-only">Ask a question about this game session</label>
            <input
              id="unseen-question"
              type="text"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder={reasoning ? "Ask what happened in this session…" : "Analyze the preloaded session to unlock search"}
              autoComplete="off"
              maxLength={280}
              disabled={isAsking || !reasoning}
            />
            <button type="submit" disabled={!question.trim() || isAsking || !reasoning} aria-label="Send question">
              <span aria-hidden="true">↗</span>
            </button>
          </form>
          {chatError && (
            <div className="chat-error" role="alert">
              <strong>Evidence boundary</strong>
              <span>{chatError}</span>
              <button type="button" onClick={() => setChatError("")}>Dismiss</button>
            </div>
          )}
          <p className="chat-disclaimer">Preloaded synthetic media · grounded evidence only · explicit abstention when support is insufficient.</p>
        </div>
      </section>

      <footer className="unseen-footer">
        <a className="unseen-brand footer-brand" href="#experience"><span className="unseen-mark" aria-hidden="true"><i /><i /><i /></span><span>UNSEEN</span></a>
        <p>Every perspective tells part of the story.</p>
        <span>SYNTHETIC AI BUILD CHALLENGE PROTOTYPE · 2026</span>
      </footer>
    </main>
  );
}

export default UnseenExperience;
