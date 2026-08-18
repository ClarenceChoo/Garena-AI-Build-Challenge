"use client";

import {
  FormEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  GameplaySearchHit,
  GameplaySearchResponse,
} from "@/lib/gameplay-search-types";
import type { ApiError } from "@/lib/unseen-types";
import {
  RealAnalysisWorkbench,
} from "./real-analysis-workbench";
import type { GameplayIndexSnapshot } from "./gameplay-search-workbench";
import "./unseen-experience.css";

interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  citations?: GameplaySearchHit[];
}

interface UnseenExperienceProps {
  viewer: { displayName: string; email: string } | null;
  signInPath: string;
  signOutPath: string;
}

const EMPTY_INDEX: GameplayIndexSnapshot = Object.freeze({
  clips: [],
  segments: [],
  eventCount: 0,
  isReady: false,
});

const initialMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content: "Index footage above, then ask about any moment. I’ll search only your verified gameplay events.",
  },
];

function errorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const apiError = payload as Partial<ApiError>;
  return apiError.error?.message || fallback;
}

async function parseErrorResponse(response: Response, fallback: string) {
  const payload = await response.json().catch(() => null);
  return errorMessage(payload, fallback);
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function initials(name: string | undefined): string {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  return (parts.map((part) => part[0]).join("").slice(0, 2) || "YOU").toUpperCase();
}

export function UnseenExperience({
  viewer,
  signInPath,
  signOutPath,
}: UnseenExperienceProps) {
  const [gameplayIndex, setGameplayIndex] = useState<GameplayIndexSnapshot>(EMPTY_INDEX);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [question, setQuestion] = useState("");
  const [isAsking, setIsAsking] = useState(false);
  const [chatError, setChatError] = useState("");
  const requestCounter = useRef(0);
  const indexReadyRef = useRef(false);

  const handleIndexChange = useCallback((snapshot: GameplayIndexSnapshot) => {
    if (indexReadyRef.current && !snapshot.isReady) {
      setMessages(initialMessages);
      setQuestion("");
      setChatError("");
    }
    indexReadyRef.current = snapshot.isReady;
    setGameplayIndex(snapshot);
  }, []);

  const suggestedQuestions = useMemo(() => {
    if (!gameplayIndex.isReady) return [];
    const events = gameplayIndex.segments
      .flatMap((segment) => segment.events)
      .sort((a, b) => b.importance - a.importance || b.confidence - a.confidence);
    const strongest = events[0];
    const next = events.find((event) => event.id !== strongest?.id);
    const actor = events.flatMap((event) => event.actors).find((name) => name.trim());
    return [
      strongest ? `What happened during “${strongest.title}”?` : "What was the most important moment?",
      actor ? `What did ${actor} do in this gameplay?` : next ? `Find “${next.title}”.` : "Which event had the strongest evidence?",
    ];
  }, [gameplayIndex.isReady, gameplayIndex.segments]);

  async function askUnseen(prompt: string) {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || isAsking || !gameplayIndex.isReady) return;

    requestCounter.current += 1;
    const requestId = String(requestCounter.current);
    setMessages((current) => [
      ...current,
      { id: `user-${requestId}`, role: "user", content: cleanPrompt },
    ]);
    setQuestion("");
    setChatError("");
    setIsAsking(true);

    try {
      const response = await fetch("/api/analyze/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: cleanPrompt,
          clips: gameplayIndex.clips,
          segments: gameplayIndex.segments,
        }),
      });
      if (!response.ok) {
        throw new Error(
          await parseErrorResponse(response, "UNSEEN could not search the current gameplay index."),
        );
      }
      const answer = (await response.json()) as GameplaySearchResponse;
      if (answer.api.real !== true || !answer.api.responseId) {
        throw new Error("The index search response was not verifiable.");
      }
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${requestId}`,
          role: "assistant",
          content: answer.summary,
          citations: answer.answerType === "matches" ? answer.hits : [],
        },
      ]);
    } catch (error) {
      setChatError(
        error instanceof Error
          ? error.message
          : "UNSEEN could not search the current gameplay index.",
      );
    } finally {
      setIsAsking(false);
    }
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void askUnseen(question);
  }

  function playIndexedMoment(hit: GameplaySearchHit) {
    const video = document.getElementById(`gameplay-video-${hit.clipId}`);
    if (!(video instanceof HTMLVideoElement)) {
      setChatError("The source video for this indexed event is no longer available in this tab.");
      return;
    }
    const contextSeconds = Math.max(0, (hit.startMs - 2_000) / 1_000);
    const maximum = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.05) : contextSeconds;
    video.currentTime = Math.min(contextSeconds, maximum);
    video.scrollIntoView({ behavior: "smooth", block: "center" });
    void video.play().catch(() => undefined);
  }

  const viewerInitials = initials(viewer?.displayName);
  const askReady = gameplayIndex.isReady && gameplayIndex.eventCount > 0;

  return (
    <main className="unseen-shell">
      <div className="unseen-ambient unseen-ambient-one" aria-hidden="true" />
      <div className="unseen-ambient unseen-ambient-two" aria-hidden="true" />

      <header className="unseen-header">
        <a className="unseen-brand" href="#live-analysis" aria-label="UNSEEN home">
          <span className="unseen-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>UNSEEN</span>
        </a>
        <div className="header-actions">
          <div className={`auth-account ${viewer ? "is-signed-in" : "is-guest"}`}>
            <span aria-hidden="true" />
            <div>
              <strong title={viewer?.email}>{viewer?.displayName ?? "Guest viewer"}</strong>
              <a href={viewer ? signOutPath : signInPath}>{viewer ? "Sign out" : "Sign in with ChatGPT"}</a>
            </div>
          </div>
          <div className="index-summary" aria-label={`${gameplayIndex.eventCount} indexed gameplay events`}>
            <span aria-hidden="true">✓</span> {askReady ? `${gameplayIndex.eventCount} events indexed` : "Index not ready"}
          </div>
          <button className="reconstruct-button" type="button" onClick={() => document.getElementById("live-analysis")?.scrollIntoView({ behavior: "smooth" })}>
            <span className="button-spark" aria-hidden="true">✦</span>Analyze clips
          </button>
        </div>
      </header>

      <RealAnalysisWorkbench onIndexChange={handleIndexChange} />

      <section className={`ask-section ${!askReady ? "ask-locked" : ""}`} aria-labelledby="ask-title">
        <div className="ask-intro">
          <span className="ask-orbit" aria-hidden="true"><i /><i /><i /></span>
          <span className="eyebrow">LIVE INDEX SEARCH</span>
          <h2 id="ask-title">Ask your indexed<br />gameplay.</h2>
          <p>Questions run against the verified event index built from your uploaded footage. Every match links back to its real source timestamp.</p>
        </div>

        <div className="chat-card">
          <div className="chat-header">
            <div><span className="ai-presence" aria-hidden="true">U</span><p><strong>Ask UNSEEN</strong><small>{askReady ? `${gameplayIndex.eventCount} verified events · live index` : "Index footage above to enable search"}</small></p></div>
            <span className="online-status"><i /> {askReady ? "READY" : "INDEX FIRST"}</span>
          </div>

          <div className="chat-messages" aria-live="polite" aria-busy={isAsking}>
            {messages.map((message) => (
              <div key={message.id} className={`chat-message message-${message.role}`}>
                <span className="message-author">{message.role === "assistant" ? "U" : viewerInitials}</span>
                <div>
                  <p>{message.content}</p>
                  {message.citations && message.citations.length > 0 && (
                    <div className="chat-sources" aria-label="Indexed gameplay citations">
                      {message.citations.map((citation) => {
                        const clip = gameplayIndex.clips.find((candidate) => candidate.id === citation.clipId);
                        return (
                          <button type="button" key={citation.eventId} onClick={() => playIndexedMoment(citation)}>
                            <span>⌁ {formatTime(citation.startMs)}</span>{clip?.label ?? citation.title} · {citation.title}<i aria-hidden="true">↗</i>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isAsking && (
              <div className="chat-message message-assistant typing-message">
                <span className="message-author">U</span>
                <div><span /><span /><span /><small>Searching verified events…</small></div>
              </div>
            )}
          </div>

          <div className="suggested-questions" aria-label="Questions generated from the current index">
            {suggestedQuestions.map((suggestion) => (
              <button type="button" key={suggestion} onClick={() => void askUnseen(suggestion)} disabled={isAsking || !askReady}>
                <span aria-hidden="true">✦</span>{suggestion}
              </button>
            ))}
          </div>

          <form className="ask-form" onSubmit={submitQuestion}>
            <label htmlFor="unseen-question" className="sr-only">Search the indexed gameplay</label>
            <input id="unseen-question" type="text" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={askReady ? "Ask what happened in the indexed footage…" : "Index gameplay above to start asking…"} autoComplete="off" maxLength={500} disabled={isAsking || !askReady} />
            <button type="submit" disabled={!question.trim() || isAsking || !askReady} aria-label="Search indexed gameplay"><span aria-hidden="true">↗</span></button>
          </form>
          {chatError && (
            <div className="chat-error" role="alert"><strong>Index search</strong><span>{chatError}</span><button type="button" onClick={() => setChatError("")}>Dismiss</button></div>
          )}
          <p className="chat-disclaimer">Current in-memory index · evidence-linked timestamps · explicit insufficient-evidence responses.</p>
        </div>
      </section>

      <footer className="unseen-footer">
        <a className="unseen-brand footer-brand" href="#live-analysis"><span className="unseen-mark" aria-hidden="true"><i /><i /><i /></span><span>UNSEEN</span></a>
        <p>Every perspective tells part of the story.</p>
        <span>GARENA AI BUILD CHALLENGE PROTOTYPE · 2026</span>
      </footer>
    </main>
  );
}

export default UnseenExperience;
