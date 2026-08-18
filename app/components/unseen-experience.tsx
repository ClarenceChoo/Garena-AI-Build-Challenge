"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import type {
  ApiError,
  AskCitation,
  AskDemoResponse,
  DemoSessionResponse,
  UnseenSession,
} from "@/lib/unseen-types";
import { RealAnalysisWorkbench } from "./real-analysis-workbench";
import "./unseen-experience.css";

interface AskReasoningResponse {
  version: string;
}

interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  citations?: AskCitation[];
}

interface UnseenExperienceProps {
  viewer: { displayName: string; email: string } | null;
  signInPath: string;
  signOutPath: string;
}

const initialMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content: "Ask what happened off-screen. I’ll answer only from permitted session evidence.",
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

export function UnseenExperience({
  viewer,
  signInPath,
  signOutPath,
}: UnseenExperienceProps) {
  const [session, setSession] = useState<UnseenSession | null>(null);
  const [reasoning, setReasoning] = useState<AskReasoningResponse | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [question, setQuestion] = useState("");
  const [isAsking, setIsAsking] = useState(false);
  const [chatError, setChatError] = useState("");
  const requestCounter = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function loadAskSession() {
      try {
        const [sessionResponse, reasoningResponse] = await Promise.all([
          fetch("/api/demo/session", { cache: "no-store" }),
          fetch("/api/demo/reasoning", { cache: "no-store" }),
        ]);
        if (!sessionResponse.ok || !reasoningResponse.ok) {
          throw new Error("Ask UNSEEN evidence could not be loaded.");
        }
        const sessionPayload = (await sessionResponse.json()) as DemoSessionResponse;
        const reasoningPayload = (await reasoningResponse.json()) as AskReasoningResponse;
        if (cancelled) return;
        setSession(sessionPayload.session);
        setReasoning(reasoningPayload);
      } catch (error) {
        if (!cancelled) {
          setChatError(error instanceof Error ? error.message : "Ask UNSEEN is unavailable.");
        }
      }
    }

    void loadAskSession();
    return () => {
      cancelled = true;
    };
  }, []);

  async function askUnseen(prompt: string) {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || isAsking || !session || !reasoning) return;

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
          await parseErrorResponse(response, "UNSEEN could not answer from this session’s evidence."),
        );
      }
      const answer = (await response.json()) as AskDemoResponse;
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${requestId}`,
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

  const viewerInitials = session?.participants.find(
    (participant) => participant.id === session.focusParticipantId,
  )?.avatarInitials ?? "AE";
  const consentedCount = session?.participants.filter(
    (participant) =>
      participant.consent.gameplayRecording === "granted" &&
      participant.consent.aiAnalysis === "granted" &&
      participant.consent.squadSharing === "granted",
  ).length ?? 0;
  const askReady = Boolean(session && reasoning);

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
          <div className="consent-summary" aria-label={`${consentedCount} players opted in`}>
            <span aria-hidden="true">✓</span> {consentedCount}/{session?.participants.length ?? 3} opted in
          </div>
          <button className="reconstruct-button" type="button" onClick={() => document.getElementById("live-analysis")?.scrollIntoView({ behavior: "smooth" })}>
            <span className="button-spark" aria-hidden="true">✦</span>Analyze clips
          </button>
        </div>
      </header>

      <RealAnalysisWorkbench />

      <section className={`ask-section ${!askReady ? "ask-locked" : ""}`} aria-labelledby="ask-title">
        <div className="ask-intro">
          <span className="ask-orbit" aria-hidden="true"><i /><i /><i /></span>
          <span className="eyebrow">CONVERSATIONAL SESSION SEARCH</span>
          <h2 id="ask-title">Ask the game what<br />you never saw.</h2>
          <p>In the simulator, answers cite synchronized mock squad recordings. Real uploads use only the frames and opted-in audio supplied by your team.</p>
        </div>

        <div className="chat-card">
          <div className="chat-header">
            <div><span className="ai-presence" aria-hidden="true">U</span><p><strong>Ask UNSEEN</strong><small>{reasoning ? `${reasoning.version} · simulated evidence` : "Loading evidence…"}</small></p></div>
            <span className="online-status"><i /> {askReady ? "READY" : "LOADING"}</span>
          </div>

          <div className="chat-messages" aria-live="polite" aria-busy={isAsking}>
            {messages.map((message) => (
              <div key={message.id} className={`chat-message message-${message.role}`}>
                <span className="message-author">{message.role === "assistant" ? "U" : viewerInitials}</span>
                <div>
                  <p>{message.content}</p>
                  {message.citations && message.citations.length > 0 && (
                    <div className="chat-sources" aria-label="Answer evidence citations">
                      {message.citations.map((citation) => (
                        <button type="button" key={citation.evidenceId} onClick={() => setChatError(`${citation.label} · ${citation.timestampLabel} · ${citation.evidenceId}`)}>
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
              <button type="button" key={suggestion} onClick={() => void askUnseen(suggestion)} disabled={isAsking || !askReady}>
                <span aria-hidden="true">✦</span>{suggestion}
              </button>
            ))}
          </div>

          <form className="ask-form" onSubmit={submitQuestion}>
            <label htmlFor="unseen-question" className="sr-only">Ask a question about this game session</label>
            <input id="unseen-question" type="text" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={askReady ? "Ask what happened in this session…" : "Loading session evidence…"} autoComplete="off" maxLength={280} disabled={isAsking || !askReady} />
            <button type="submit" disabled={!question.trim() || isAsking || !askReady} aria-label="Send question"><span aria-hidden="true">↗</span></button>
          </form>
          {chatError && (
            <div className="chat-error" role="alert"><strong>Evidence boundary</strong><span>{chatError}</span><button type="button" onClick={() => setChatError("")}>Dismiss</button></div>
          )}
          <p className="chat-disclaimer">Simulated squad media · grounded evidence only · explicit abstention when support is insufficient.</p>
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
