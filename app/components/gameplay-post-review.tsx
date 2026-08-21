"use client";

import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CoachGameplayRequest,
  GameplayClipMetadata,
  GameplayCoachCitation,
  GameplayCoachMessage,
  GameplayCoachResponse,
  GameplayEvidenceRating,
  GameplayPlayerReview,
  GameplayPostReview,
  GameplaySegmentIndex,
  GameplayTeamReview,
  ReviewGameplayRequest,
} from "@/lib/gameplay-search-types";
import "./gameplay-post-review.css";

type ReviewState = "generating" | "ready" | "insufficient" | "error";
type ReviewScope = { type: "player"; clipId: string } | { type: "team"; clipId: null };
type ReviewContent = GameplayPlayerReview | GameplayTeamReview;

export interface GameplayReviewSource extends GameplayClipMetadata {
  url: string;
}

interface GameplayPostReviewProps {
  clips: GameplayReviewSource[];
  segments: GameplaySegmentIndex[];
  indexCompleteness: "complete" | "partial";
  voiceAnalysisEnabled: boolean;
  onPlayMoment: (clipId: string, startMs: number) => void;
}

interface ApiFailure {
  error?: { message?: string; requestId?: string };
}

interface CoachEntry extends GameplayCoachMessage {
  id: string;
  answerType?: GameplayCoachResponse["answerType"];
  nextAction?: string;
  citations?: GameplayCoachCitation[];
}

const ratingLabels: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "Needs attention",
  2: "Developing",
  3: "Solid",
  4: "Strong",
  5: "Standout",
};

function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function readableDimension(value: GameplayEvidenceRating["dimension"]): string {
  return value.replace("_", " ");
}

async function apiError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as ApiFailure | null;
  const message = body?.error?.message || `Request failed with HTTP ${response.status}.`;
  return body?.error?.requestId ? `${message} Request ${body.error.requestId}` : message;
}

function EvidenceLinks({
  eventIds,
  segments,
  clips,
  onPlayMoment,
}: {
  eventIds: string[];
  segments: GameplaySegmentIndex[];
  clips: GameplayReviewSource[];
  onPlayMoment: (clipId: string, startMs: number) => void;
}) {
  const events = eventIds.flatMap((eventId) => {
    const event = segments.flatMap((segment) => segment.events).find((candidate) => candidate.id === eventId);
    return event ? [event] : [];
  });
  if (!events.length) return null;
  return (
    <div className="post-review-evidence" aria-label="Supporting gameplay evidence">
      {events.map((event) => (
        <button type="button" key={event.id} onClick={() => onPlayMoment(event.clipId, event.startMs)}>
          <span>{formatTime(event.startMs)}</span>
          {clips.find((clip) => clip.id === event.clipId)?.label ?? "Source"} · {event.title} ↗
        </button>
      ))}
    </div>
  );
}

function RatingCard({
  rating,
  segments,
  clips,
  onPlayMoment,
}: {
  rating: GameplayEvidenceRating;
  segments: GameplaySegmentIndex[];
  clips: GameplayReviewSource[];
  onPlayMoment: (clipId: string, startMs: number) => void;
}) {
  const observed = rating.status === "observed" && rating.level !== null;
  return (
    <article className={`post-review-rating${observed ? " observed" : " not-observed"}`}>
      <span>{readableDimension(rating.dimension)}</span>
      <strong>{observed ? ratingLabels[rating.level as 1 | 2 | 3 | 4 | 5] : "Not observed"}</strong>
      <div aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <i className={observed && index < (rating.level ?? 0) ? "filled" : ""} key={index} />
        ))}
      </div>
      <p>{rating.rationale}</p>
      <small>{observed ? `${Math.round(rating.confidence * 100)}% evidence confidence` : "No reliable evidence in this footage"}</small>
      {observed && <EvidenceLinks eventIds={rating.eventIds} segments={segments} clips={clips} onPlayMoment={onPlayMoment} />}
    </article>
  );
}

function DirectorPreview({
  plan,
  clips,
}: {
  plan: NonNullable<GameplayPostReview["directorPreview"]>;
  clips: GameplayReviewSource[];
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeBeat = plan.beats[activeIndex];
  const activeClip = clips.find((clip) => clip.id === activeBeat?.clipId);

  useEffect(() => {
    function pauseWhenHidden() {
      if (!document.hidden) return;
      videoRef.current?.pause();
      setPlaying(false);
    }

    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", pauseWhenHidden);
    };
  }, []);

  function startActiveBeat(shouldPlay: boolean) {
    const video = videoRef.current;
    if (!video || !activeBeat) return;
    video.currentTime = Math.max(0, activeBeat.startMs / 1_000);
    if (shouldPlay) void video.play().catch(() => setPlaying(false));
  }

  function selectBeat(index: number, shouldPlay = playing) {
    setActiveIndex(Math.max(0, Math.min(plan.beats.length - 1, index)));
    setPlaying(shouldPlay);
  }

  function advance() {
    if (activeIndex >= plan.beats.length - 1) {
      videoRef.current?.pause();
      setPlaying(false);
      return;
    }
    selectBeat(activeIndex + 1, true);
  }

  if (!activeBeat || !activeClip) return null;

  return (
    <section className="director-preview" aria-labelledby="director-preview-title">
      <header>
        <div>
          <span className="post-review-label">DIRECTOR&apos;S CUT · LOCAL PREVIEW</span>
          <h3 id="director-preview-title">{plan.title}</h3>
          <p>{plan.subtitle}</p>
        </div>
        <div className="director-preview-meta">
          <strong>{formatTime(plan.durationMs)}</strong>
          <span>{plan.beats.length} BEATS · {plan.sourceCount} SOURCE{plan.sourceCount === 1 ? "" : "S"}</span>
        </div>
      </header>

      <div className="director-preview-layout">
        <div className="director-stage">
          <video
            key={`${activeBeat.clipId}-${activeIndex}`}
            ref={videoRef}
            src={activeClip.url}
            playsInline
            preload="metadata"
            onLoadedMetadata={() => startActiveBeat(playing)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(event) => {
              if (event.currentTarget.currentTime * 1_000 >= activeBeat.endMs - 60) advance();
            }}
            onEnded={advance}
          />
          <div className="director-stage-overlay">
            <span>{activeClip.label}</span>
            <strong>{activeBeat.caption}</strong>
            <small>{activeBeat.narrativeRole.replace("_", " ")} · {formatTime(activeBeat.startMs)}–{formatTime(activeBeat.endMs)}</small>
          </div>
          <div className="director-controls" aria-label="Director's Cut controls">
            <button type="button" onClick={() => selectBeat(activeIndex - 1, playing)} disabled={activeIndex === 0} aria-label="Previous beat">←</button>
            {playing ? (
              <button type="button" onClick={() => videoRef.current?.pause()}>Pause</button>
            ) : (
              <button type="button" onClick={() => {
                const video = videoRef.current;
                if (!video) return;
                if (video.currentTime * 1_000 < activeBeat.startMs || video.currentTime * 1_000 >= activeBeat.endMs) {
                  video.currentTime = activeBeat.startMs / 1_000;
                }
                setPlaying(true);
                void video.play().catch(() => setPlaying(false));
              }}>Play</button>
            )}
            <button type="button" onClick={() => { if (activeIndex === 0) { videoRef.current?.pause(); setPlaying(false); startActiveBeat(false); } else { selectBeat(0, false); } }}>Restart</button>
            <button type="button" onClick={() => selectBeat(activeIndex + 1, playing)} disabled={activeIndex === plan.beats.length - 1} aria-label="Next beat">→</button>
          </div>
        </div>

        <ol className="director-timeline">
          {plan.beats.map((beat, index) => {
            const clip = clips.find((candidate) => candidate.id === beat.clipId);
            return (
              <li key={`${beat.eventId}-${beat.order}`}>
                <button type="button" className={index === activeIndex ? "active" : ""} onClick={() => selectBeat(index, true)}>
                  <span>{String(beat.order).padStart(2, "0")}</span>
                  <strong>{beat.caption}</strong>
                  <small>{clip?.label ?? beat.clipId} · {formatTime(beat.startMs)}–{formatTime(beat.endMs)}</small>
                  <p>{beat.reason}</p>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

export function GameplayPostGameReview({
  clips,
  segments,
  indexCompleteness,
  voiceAnalysisEnabled,
  onPlayMoment,
}: GameplayPostReviewProps) {
  const eventCount = segments.reduce((sum, segment) => sum + segment.events.length, 0);
  const [reviewState, setReviewState] = useState<ReviewState>(() => eventCount ? "generating" : "insufficient");
  const [review, setReview] = useState<GameplayPostReview | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const [scope, setScope] = useState<ReviewScope>({ type: "player", clipId: clips[0]?.id ?? "" });
  const [coachEntries, setCoachEntries] = useState<Record<string, CoachEntry[]>>({});
  const [coachQuestion, setCoachQuestion] = useState("");
  const [coachThinking, setCoachThinking] = useState(false);
  const [coachError, setCoachError] = useState("");
  const coachAbort = useRef<AbortController | null>(null);
  const scopeTabRefs = useRef(new Map<number, HTMLButtonElement>());
  const scopeTabsId = `post-review-scope-${useId().replace(/:/g, "")}`;
  const reviewInput = useMemo<ReviewGameplayRequest>(
    () => ({
      clips: clips.map(({ id, name, label, durationMs, sizeBytes }) => ({ id, name, label, durationMs, sizeBytes })),
      segments,
      indexCompleteness,
      voiceAnalysisEnabled,
    }),
    [clips, indexCompleteness, segments, voiceAnalysisEnabled],
  );

  useEffect(() => {
    if (!eventCount) return;
    const controller = new AbortController();
    const body = reviewInput;
    const timeout = window.setTimeout(() => {
      void fetch("/api/analyze/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(await apiError(response));
          return await response.json() as GameplayPostReview;
        })
        .then((result) => {
          if (controller.signal.aborted) return;
          if (result.answerType === "review" && (!result.api?.real || !result.api.responseId)) {
            throw new Error("The post-game review was not verifiable.");
          }
          coachAbort.current?.abort();
          coachAbort.current = null;
          setCoachEntries({});
          setCoachQuestion("");
          setCoachThinking(false);
          setCoachError("");
          setReview(result);
          setReviewState(result.answerType === "review" ? "ready" : "insufficient");
          const firstPlayer = result.playerReviews[0];
          setScope(firstPlayer
            ? { type: "player", clipId: firstPlayer.clipId }
            : result.teamReview
              ? { type: "team", clipId: null }
              : { type: "player", clipId: body.clips[0]?.id ?? "" });
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          setReviewState("error");
          setReviewError(error instanceof Error ? error.message : "Post-game coaching could not be generated.");
        });
    }, 350);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [eventCount, reviewInput, retryNonce]);

  useEffect(() => () => coachAbort.current?.abort(), []);

  const selectedReview: ReviewContent | null = useMemo(() => {
    if (!review) return null;
    if (scope.type === "team") return review.teamReview;
    return review.playerReviews.find((candidate) => candidate.clipId === scope.clipId) ?? null;
  }, [review, scope]);
  const scopeKey = scope.type === "team" ? "team" : scope.clipId;
  const visibleCoachEntries = coachEntries[scopeKey] ?? [];
  const selectedLabel = scope.type === "team"
    ? "Squad"
    : clips.find((clip) => clip.id === scope.clipId)?.label ?? "Player";
  const reviewScopes: ReviewScope[] = review
    ? [
        ...review.playerReviews.map((player): ReviewScope => ({ type: "player", clipId: player.clipId })),
        ...(review.teamReview ? [{ type: "team", clipId: null } as const] : []),
      ]
    : [];
  const selectedScopeIndex = reviewScopes.findIndex((candidate) => (
    candidate.type === scope.type
    && (candidate.type === "team" || candidate.clipId === scope.clipId)
  ));
  const selectedTabId = selectedScopeIndex >= 0 ? `${scopeTabsId}-tab-${selectedScopeIndex}` : undefined;
  const selectedPanelId = selectedScopeIndex >= 0 ? `${scopeTabsId}-panel-${selectedScopeIndex}` : undefined;
  const suggestedPrompts = selectedReview ? [
    "What should I focus on next match?",
    selectedReview.improvements[0]
      ? `Walk me through how to improve: ${selectedReview.improvements[0].title}`
      : `How can I improve ${selectedReview.primaryPriority}?`,
    scope.type === "team" ? "Where did our squad timing break down?" : "Show me the decision that hurt me most.",
  ] : [];

  function selectScope(nextScope: ReviewScope) {
    coachAbort.current?.abort();
    coachAbort.current = null;
    setCoachThinking(false);
    setCoachError("");
    setCoachQuestion("");
    setScope(nextScope);
  }

  function handleScopeTabKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % reviewScopes.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + reviewScopes.length) % reviewScopes.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = reviewScopes.length - 1;
    if (nextIndex === null || nextIndex < 0) return;

    event.preventDefault();
    selectScope(reviewScopes[nextIndex]);
    window.requestAnimationFrame(() => scopeTabRefs.current.get(nextIndex)?.focus());
  }

  function retryReview() {
    coachAbort.current?.abort();
    coachAbort.current = null;
    setReview(null);
    setReviewState("generating");
    setReviewError("");
    setCoachEntries({});
    setCoachQuestion("");
    setCoachThinking(false);
    setCoachError("");
    setRetryNonce((value) => value + 1);
  }

  async function askCoach(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = coachQuestion.trim();
    if (!question || !review || !selectedReview || coachThinking) return;
    const prior = visibleCoachEntries;
    const userEntry: CoachEntry = { id: crypto.randomUUID(), role: "user", content: question };
    setCoachEntries((current) => ({ ...current, [scopeKey]: [...(current[scopeKey] ?? []), userEntry] }));
    setCoachQuestion("");
    setCoachThinking(true);
    setCoachError("");
    const controller = new AbortController();
    coachAbort.current?.abort();
    coachAbort.current = controller;
    const body: CoachGameplayRequest = {
      question,
      scope,
      history: prior.slice(-6).map(({ role, content }) => ({ role, content })),
      clips: clips.map(({ id, name, label, durationMs, sizeBytes }) => ({ id, name, label, durationMs, sizeBytes })),
      segments,
      review,
    };
    try {
      const response = await fetch("/api/analyze/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(await apiError(response));
      const result = await response.json() as GameplayCoachResponse;
      if (controller.signal.aborted) return;
      if (!result.api.real || !result.api.responseId) throw new Error("The coaching answer was not verifiable.");
      const assistantEntry: CoachEntry = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: result.answer,
        answerType: result.answerType,
        nextAction: result.nextAction,
        citations: result.citations,
      };
      setCoachEntries((current) => ({ ...current, [scopeKey]: [...(current[scopeKey] ?? []), assistantEntry] }));
    } catch (error) {
      if (!controller.signal.aborted) setCoachError(error instanceof Error ? error.message : "Ask Coach failed.");
    } finally {
      if (!controller.signal.aborted) setCoachThinking(false);
      if (coachAbort.current === controller) coachAbort.current = null;
    }
  }

  if (reviewState === "generating") {
    return (
      <section className="post-game-review post-game-review-status" aria-live="polite">
        <span className="post-review-orbit" aria-hidden="true"><i /><i /><i /></span>
        <div><h2>Building your review…</h2><p>You can keep using Search while coaching is generated.</p></div>
      </section>
    );
  }

  if (reviewState === "error") {
    return (
      <section className="post-game-review post-game-review-status state-error" aria-live="polite">
        <div><h2>Review paused.</h2><p>{reviewError}</p></div>
        <button type="button" onClick={retryReview}>Retry review</button>
      </section>
    );
  }

  if (reviewState === "insufficient" || !review) {
    return (
      <section className="post-game-review post-game-review-status state-insufficient" aria-live="polite">
        <div><h2>Not enough evidence yet.</h2><p>Add clearer or longer footage for coaching. Search still works.</p></div>
      </section>
    );
  }

  return (
    <section className="post-game-review" aria-labelledby="post-game-review-title">
      <header className="post-game-review-hero">
        <div>
          <span className="post-review-label">AI POST-GAME COACH · {review.coverage.toUpperCase()} REVIEW</span>
          <h2 id="post-game-review-title">{review.title}</h2>
          <p>{review.summary}</p>
        </div>
        <div className="post-review-coverage">
          <strong>{review.indexedEventCount}</strong><span>VERIFIED EVENTS</span>
          <strong>{review.indexedClipCount}</strong><span>PERSPECTIVES</span>
          <small>{review.voiceEvidenceAvailable ? "CONSENTED VOICE INCLUDED" : "VISUAL EVIDENCE ONLY"}</small>
        </div>
      </header>

      {review.coverage === "partial" && (
        <div className="post-review-partial"><strong>Partial evidence review.</strong> Some index segments failed, so advice only covers verified moments. Retrying those segments will automatically replace this review.</div>
      )}

      {review.indexedClipCount > 1 && (
        <div className={`post-review-relationship relationship-${review.sessionRelationship.status}`}>
          <strong>{review.teamReview ? "Squad connection verified." : "Team review unavailable—these clips could not be reliably connected."}</strong>
          <span>{review.sessionRelationship.summary} · {Math.round(review.sessionRelationship.confidence * 100)}% confidence</span>
        </div>
      )}

      <div className="post-review-tabs" role="tablist" aria-label="Coaching perspective" aria-orientation="horizontal">
        {reviewScopes.map((candidateScope, index) => {
          const selected = index === selectedScopeIndex;
          const label = candidateScope.type === "team"
            ? "Squad"
            : clips.find((clip) => clip.id === candidateScope.clipId)?.label ?? "Player";
          const tabId = `${scopeTabsId}-tab-${index}`;
          const panelId = `${scopeTabsId}-panel-${index}`;
          return (
            <button
              type="button"
              role="tab"
              id={tabId}
              aria-controls={panelId}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className={selected ? "active" : ""}
              key={candidateScope.type === "team" ? "team" : candidateScope.clipId}
              ref={(node) => {
                if (node) scopeTabRefs.current.set(index, node);
                else scopeTabRefs.current.delete(index);
              }}
              onClick={() => selectScope(candidateScope)}
              onKeyDown={(event) => handleScopeTabKeyDown(event, index)}
            >
              {label}
            </button>
          );
        })}
      </div>

      {reviewScopes.map((candidateScope, index) => index === selectedScopeIndex ? null : (
        <div
          id={`${scopeTabsId}-panel-${index}`}
          role="tabpanel"
          aria-labelledby={`${scopeTabsId}-tab-${index}`}
          tabIndex={0}
          hidden
          key={`hidden-${candidateScope.type === "team" ? "team" : candidateScope.clipId}`}
        />
      ))}

      {selectedReview && (
        <div
          className="post-review-content"
          id={selectedPanelId}
          role="tabpanel"
          aria-labelledby={selectedTabId}
          tabIndex={0}
        >
          <section className="post-review-summary">
            <div><h3>{selectedReview.summary}</h3></div>
            <aside><span>PRIMARY PRIORITY</span><strong>{selectedReview.primaryPriority}</strong></aside>
          </section>

          <section className="post-review-ratings" aria-label={`${selectedLabel} evidence ratings`}>
            {selectedReview.ratings.map((rating) => <RatingCard key={rating.dimension} rating={rating} segments={segments} clips={clips} onPlayMoment={onPlayMoment} />)}
          </section>

          <div className="post-review-columns">
            <section>
              <h3>Strengths</h3>
              {selectedReview.strengths.map((strength, index) => (
                <article className="post-review-coaching-card strength" key={`${strength.title}-${index}`}>
                  <span>{String(index + 1).padStart(2, "0")}</span><h4>{strength.title}</h4><p>{strength.summary}</p>
                  <EvidenceLinks eventIds={strength.eventIds} segments={segments} clips={clips} onPlayMoment={onPlayMoment} />
                </article>
              ))}
            </section>
            <section>
              <h3>Improve next</h3>
              {selectedReview.improvements.map((improvement, index) => (
                <article className="post-review-coaching-card improvement" key={`${improvement.title}-${index}`}>
                  <span>{String(index + 1).padStart(2, "0")}</span><h4>{improvement.title}</h4>
                  <dl><div><dt>What happened</dt><dd>{improvement.whatHappened}</dd></div><div><dt>Why it mattered</dt><dd>{improvement.whyItMattered}</dd></div><div><dt>Better decision</dt><dd>{improvement.betterDecision}</dd></div></dl>
                  <EvidenceLinks eventIds={improvement.eventIds} segments={segments} clips={clips} onPlayMoment={onPlayMoment} />
                </article>
              ))}
            </section>
          </div>

          <section className="post-review-practice">
            <header><h3>Next game</h3></header>
            <div>{selectedReview.nextSessionPlan.map((action, index) => (
              <article key={`${action.title}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><h4>{action.title}</h4><p>{action.action}</p><small>SUCCESS MEASURE · {action.successMeasure}</small><EvidenceLinks eventIds={action.eventIds} segments={segments} clips={clips} onPlayMoment={onPlayMoment} /></article>
            ))}</div>
          </section>
        </div>
      )}

      {review.directorPreview && <DirectorPreview plan={review.directorPreview} clips={clips} />}

      {selectedReview && (
        <section className="ask-coach" aria-labelledby="ask-coach-title">
          <header><div><h3 id="ask-coach-title">Ask Coach</h3></div></header>
          <div className="ask-coach-prompts">
            {suggestedPrompts.map((prompt) => <button type="button" key={prompt} onClick={() => setCoachQuestion(prompt)}>{prompt}</button>)}
          </div>
          {visibleCoachEntries.length > 0 && (
            <div className="ask-coach-thread" aria-live="polite">
              {visibleCoachEntries.map((entry) => (
                <article className={`role-${entry.role}${entry.answerType === "insufficient_evidence" ? " insufficient" : ""}`} key={entry.id}>
                  <span>{entry.role === "user" ? "YOU" : entry.answerType === "insufficient_evidence" ? "COACH · INSUFFICIENT EVIDENCE" : "AI COACH"}</span>
                  <p>{entry.content}</p>
                  {entry.nextAction && <strong>NEXT ACTION · {entry.nextAction}</strong>}
                  {entry.citations && entry.citations.length > 0 && <div className="ask-coach-citations">{entry.citations.map((citation) => <button type="button" key={citation.eventId} onClick={() => onPlayMoment(citation.clipId, citation.startMs)}><span>{formatTime(citation.startMs)}</span>{clips.find((clip) => clip.id === citation.clipId)?.label} · {citation.title} ↗</button>)}</div>}
                </article>
              ))}
              {coachThinking && <article className="role-assistant thinking"><span>AI COACH</span><p>Checking the cited gameplay evidence…</p></article>}
            </div>
          )}
          <form onSubmit={(event) => void askCoach(event)}>
            <label htmlFor="ask-coach-question">Question for {selectedLabel}</label>
            <div><input id="ask-coach-question" value={coachQuestion} maxLength={500} onChange={(event) => setCoachQuestion(event.target.value)} placeholder="What should I do differently next match?" /><button type="submit" disabled={!coachQuestion.trim() || coachThinking}>{coachThinking ? "Reviewing…" : "Ask Coach ↗"}</button></div>
          </form>
          {coachError && <p className="ask-coach-error">{coachError}</p>}
        </section>
      )}
    </section>
  );
}
