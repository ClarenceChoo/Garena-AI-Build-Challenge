import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { buildSessionConsentScope } from "../lib/unseen-consent.js";

const projectRoot = new URL("../", import.meta.url);
const AUTH_HEADERS = Object.freeze({
  "oai-authenticated-user-id": "test-user-123",
  "oai-authenticated-user-email": "judge@example.com",
});
process.env.UNSEEN_ALLOWED_EMAILS = "judge@example.com";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

async function dispatch(path, init = {}) {
  const worker = await loadWorker();
  return worker.fetch(
    new Request(`http://localhost${path}`, init),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

function coachingFixture() {
  const clips = [
    { id: "coach-a", name: "ace.mp4", label: "Ace", durationMs: 120_000, sizeBytes: 12_000_000 },
    { id: "coach-b", name: "rin.mp4", label: "Rin", durationMs: 120_000, sizeBytes: 12_000_000 },
  ];
  const segment = (clipId, event, transcriptSegmentIds = []) => ({
    clipId,
    segmentId: `${clipId}-segment-001`,
    segmentStartMs: 0,
    segmentEndMs: 120_000,
    gameTitle: "Free Fire",
    gameMode: "Clash Squad",
    contextSummary: `${clips.find((clip) => clip.id === clipId).label} perspective.`,
    evidenceFrameIds: [...event.evidenceFrameIds, `${clipId}-segment-001-frame-context`],
    transcriptSegmentIds,
    events: [event],
    api: {
      real: true,
      responseId: `resp-index-${clipId}`,
      requestId: `req-index-${clipId}`,
      model: "gpt-5.6-sol",
      inputTokens: 100,
      outputTokens: 40,
    },
  });
  const aceEvent = {
    id: "coach-a-segment-001-event-clutch",
    clipId: "coach-a",
    segmentId: "coach-a-segment-001",
    startMs: 44_000,
    endMs: 47_000,
    type: "clutch",
    title: "Ace commits to the final duel",
    description: "Ace wins the duel after a teammate calls the remaining angle.",
    actors: ["Ace"],
    target: "Opponent",
    ocrText: "ACE eliminated OPPONENT",
    importance: 94,
    confidence: 0.95,
    evidenceFrameIds: ["coach-a-frame-44000"],
    transcriptSegmentIds: ["coach-a-transcript-43000-1"],
  };
  const rinEvent = {
    id: "coach-b-segment-001-event-rotation",
    clipId: "coach-b",
    segmentId: "coach-b-segment-001",
    startMs: 42_000,
    endMs: 45_000,
    type: "assist",
    title: "Rin covers the squad rotation",
    description: "Rin holds the rear angle while Ace advances.",
    actors: ["Rin"],
    target: null,
    ocrText: "",
    importance: 82,
    confidence: 0.9,
    evidenceFrameIds: ["coach-b-frame-42000"],
    transcriptSegmentIds: [],
  };
  const segments = [
    segment("coach-a", aceEvent, ["coach-a-transcript-43000-1"]),
    segment("coach-b", rinEvent),
  ];
  return { clips, segments, aceEvent, rinEvent };
}

const COACHING_DIMENSIONS = [
  "awareness",
  "positioning",
  "timing",
  "decision_making",
  "teamwork",
  "communication",
];

function reviewBody(eventId, { communicationObserved = false } = {}) {
  return {
    summary: "The perspective shows one clear decision pattern worth repeating and refining.",
    primaryPriority: "Confirm available information before committing.",
    ratings: COACHING_DIMENSIONS.map((dimension) => {
      const observed = dimension === "awareness" || (dimension === "communication" && communicationObserved);
      return {
        dimension,
        status: observed ? "observed" : "not_observed",
        level: observed ? 4 : null,
        confidence: observed ? 0.9 : 0,
        rationale: observed ? "The cited event directly supports this rating." : "This category was not reliably visible.",
        eventIds: observed ? [eventId] : [],
      };
    }),
    strengths: [{ title: "Useful awareness", summary: "The player reacts to visible information.", eventIds: [eventId] }],
    improvements: [{
      title: "Commit with a confirmation cue",
      whatHappened: "The player committed as the fight developed.",
      whyItMattered: "The timing narrowed the available options.",
      betterDecision: "Confirm the safe angle before the final commitment.",
      eventIds: [eventId],
    }],
    nextSessionPlan: [1, 2, 3].map((number) => ({
      title: `Review habit ${number}`,
      action: `Practice one evidence-backed decision cue ${number}.`,
      successMeasure: `Use the cue in three relevant rounds ${number}.`,
      eventIds: [eventId],
    })),
  };
}

function validRawReview({ invalidClipId = "", invalidEventId = "", communicationWithoutTranscript = false } = {}) {
  const aceEventId = invalidEventId || "coach-a-segment-001-event-clutch";
  return {
    answerType: "review",
    title: "Clarity before commitment",
    summary: "The squad converted good awareness but can tighten the timing of its final decisions.",
    sessionRelationship: {
      status: "likely_same_session",
      confidence: 0.91,
      summary: "Matching round context and complementary actions connect both perspectives.",
      eventIds: ["coach-a-segment-001-event-clutch", "coach-b-segment-001-event-rotation"],
    },
    playerReviews: [
      { clipId: invalidClipId || "coach-a", ...reviewBody(aceEventId, { communicationObserved: true }) },
      { clipId: "coach-b", ...reviewBody("coach-b-segment-001-event-rotation", { communicationObserved: communicationWithoutTranscript }) },
    ],
    teamReview: reviewBody("coach-a-segment-001-event-clutch", { communicationObserved: true }),
    directorPreview: {
      title: "The final turn",
      subtitle: "The cover, call, and conversion from both perspectives.",
      beats: [
        {
          eventId: "coach-b-segment-001-event-rotation",
          clipId: "coach-b",
          startMs: -10_000,
          endMs: 999_000,
          narrativeRole: "setup",
          caption: "Rin covers the rotation",
          reason: "Establish the protection behind the push.",
        },
        {
          eventId: "coach-a-segment-001-event-clutch",
          clipId: "coach-a",
          startMs: -10_000,
          endMs: 999_000,
          narrativeRole: "resolution",
          caption: "Ace closes the duel",
          reason: "Show the observable payoff.",
        },
      ],
    },
  };
}

async function mp4DurationSeconds(fileUrl) {
  const buffer = await readFile(fileUrl);
  const marker = buffer.indexOf(Buffer.from("mvhd"));
  assert.ok(marker >= 0, `${fileUrl.pathname} should contain an mvhd atom`);
  const version = buffer.readUInt8(marker + 4);
  if (version === 1) {
    const timescale = buffer.readUInt32BE(marker + 24);
    const duration = Number(buffer.readBigUInt64BE(marker + 28));
    return duration / timescale;
  }
  const timescale = buffer.readUInt32BE(marker + 16);
  const duration = buffer.readUInt32BE(marker + 20);
  return duration / timescale;
}

test("server-renders the finished UNSEEN product shell", async () => {
  const anonymousResponse = await dispatch("/");
  assert.equal(anonymousResponse.status, 307);
  assert.match(
    anonymousResponse.headers.get("location") ?? "",
    /\/signin-with-chatgpt\?return_to=/,
  );

  const response = await dispatch("/", { headers: AUTH_HEADERS });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>UNSEEN — Search every moment\. See the whole squad story\.<\/title>/i);
  assert.match(html, /UNSEEN/);
  assert.match(html, /judge@example\.com/);
  assert.match(html, /Sign out/);
  assert.match(html, /og\.png/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Building your site/i);

  await access(new URL("public/og.png", projectRoot));
  const demoVideos = ["ace", "rin", "miko"].map(
    (player) => new URL(`public/demo/${player}.mp4`, projectRoot),
  );
  await Promise.all(demoVideos.map((file) => access(file)));
  const durations = await Promise.all(demoVideos.map(mp4DurationSeconds));
  assert.ok(
    durations.every((duration) => duration >= 828),
    "Every synthetic POV should span the full fixture clock for exact evidence seeking",
  );
  const layout = await readFile(new URL("app/layout.tsx", projectRoot), "utf8");
  assert.match(layout, /summary_large_image/);
  const experience = await readFile(
    new URL("app/components/unseen-experience.tsx", projectRoot),
    "utf8",
  );
  assert.match(experience, /<RealAnalysisWorkbench onIndexChange=\{setGameplayIndex\} \/>/);
  assert.doesNotMatch(experience, /Ask UNSEEN|ask-section|unseen-question|playIndexedMoment|\/api\/analyze\/search/);
  assert.doesNotMatch(experience, /\/api\/demo\/(?:ask|session|reasoning)|simulated evidence|simulated squad media/i);
  assert.doesNotMatch(experience, /Consent-aware by design/);
  assert.doesNotMatch(experience, /The game you won|The story you missed/);
  assert.doesNotMatch(experience, /REAL INPUTS \+ HONEST SIMULATION/);
  assert.doesNotMatch(experience, /FULL MULTI-POV INTERACTION SIMULATOR/);
  assert.doesNotMatch(
    experience,
    /PRELOADED REAL GARENA FOOTAGE|DFxrTiUqpCM|Free Fire Esports Official|REAL FOOTAGE \/ BROADCAST-LIMITED DEMO/,
  );
  assert.doesNotMatch(html, /youtube-nocookie\.com\/embed\/DFxrTiUqpCM/);
  const realWorkbench = await readFile(
    new URL("app/components/real-analysis-workbench.tsx", projectRoot),
    "utf8",
  );
  assert.match(realWorkbench, /return <GameplaySearchWorkbench onIndexChange=\{onIndexChange\} \/>/);
  assert.doesNotMatch(realWorkbench, /Squad Reconstruction|SquadAnalysisWorkbench|analysis-mode-tabs/);
  assert.doesNotMatch(experience, /opted-in audio supplied by your team/);
  const gameplayWorkbench = await readFile(
    new URL("app/components/gameplay-search-workbench.tsx", projectRoot),
    "utf8",
  );
  assert.match(gameplayWorkbench, /Upload once\. Use every tool\./);
  assert.match(gameplayWorkbench, /role="tablist"/);
  assert.match(gameplayWorkbench, /role="tab"/);
  assert.match(gameplayWorkbench, /role="tabpanel"/);
  assert.match(gameplayWorkbench, /aria-controls=/);
  assert.match(gameplayWorkbench, /aria-selected=\{selected\}/);
  assert.match(gameplayWorkbench, /tabIndex=\{selected \? 0 : -1\}/);
  assert.match(gameplayWorkbench, /onKeyDown=/);
  assert.match(gameplayWorkbench, /hidden=\{activeTab !==/);
  assert.match(gameplayWorkbench, /ArrowRight/);
  assert.match(gameplayWorkbench, /ArrowLeft/);
  assert.match(gameplayWorkbench, /event\.key === "Home"/);
  assert.match(gameplayWorkbench, /event\.key === "End"/);
  assert.match(gameplayWorkbench, /Add gameplay/);
  assert.match(gameplayWorkbench, /Search footage/);
  assert.match(gameplayWorkbench, /AI coach/);
  assert.match(gameplayWorkbench, /Create highlights/);
  assert.doesNotMatch(gameplayWorkbench, /LIVE SEARCH BACKEND READY/);
  assert.match(gameplayWorkbench, /\/api\/analyze\/index-segment/);
  assert.match(gameplayWorkbench, /\/api\/analyze\/search/);
  assert.match(gameplayWorkbench, /\/api\/analyze\/highlights/);
  assert.match(gameplayWorkbench, /\/api\/analyze\/transcribe/);
  assert.doesNotMatch(gameplayWorkbench, /voices_consented|voices_unconsented|Required audio declaration/);
  assert.match(gameplayWorkbench, /Analyze voice chat/);
  assert.match(gameplayWorkbench, /createConsentedAudioChunk/);
  assert.match(gameplayWorkbench, /form\.append\("voiceConsent", "true"\)/);
  assert.match(gameplayWorkbench, /maximumAudioChunkBytes/);
  assert.match(gameplayWorkbench, /onIndexChange\?\.\(\{/);
  assert.match(gameplayWorkbench, /id=\{`gameplay-video-\$\{clip\.id\}`\}/);
  assert.match(gameplayWorkbench, /renderGameplayReel\([\s\S]*?plan,[\s\S]*?voiceAnalysisEnabled,/);
  assert.match(gameplayWorkbench, /insufficient_evidence/);
  assert.match(gameplayWorkbench, /MAXIMUM_INDEX_API_CONCURRENCY = 8/);
  assert.match(gameplayWorkbench, /MAXIMUM_LOCAL_MEDIA_CONCURRENCY = 2/);
  assert.match(gameplayWorkbench, /MAXIMUM_TRANSCRIPTION_API_CONCURRENCY = 4/);
  assert.match(gameplayWorkbench, /createConcurrencyGate\(extractionConcurrency\)/);
  assert.match(gameplayWorkbench, /createConcurrencyGate\(localMediaWorkerCount\(work\.length\)\)/);
  assert.match(gameplayWorkbench, /partitionSeedJobs\(work, \[\.\.\.completed\.values\(\)\]\)/);
  assert.match(gameplayWorkbench, /runPhase\(seedJobs, "context"/);
  assert.match(gameplayWorkbench, /runPhase\(parallelJobs, "parallel"/);
  assert.match(gameplayWorkbench, /prior\.segmentStartMs < job\.startMs/);
  assert.doesNotMatch(gameplayWorkbench, /sort\(\(a, b\) => b\.segmentStartMs - a\.segmentStartMs\)/);
  assert.match(gameplayWorkbench, /navigator\.hardwareConcurrency/);
  assert.match(gameplayWorkbench, /Array\.from\(\{ length: workerCount \}/);
  assert.match(gameplayWorkbench, /const workerResults = await Promise\.allSettled/);
  assert.match(gameplayWorkbench, /if \(controller\.signal\.aborted\) \{[\s\S]*?throw new DOMException\("Indexing canceled\.", "AbortError"\)/);
  assert.match(gameplayWorkbench, /const canRetryIndex = canIndex && retryableJobs > 0/);
  assert.match(gameplayWorkbench, /if \(retryFailed \? !canRetryIndex : !canIndex\) return/);
  assert.match(gameplayWorkbench, /if \(!confirmed\) \{[\s\S]*?resetDerivedState\(\)/);
  assert.match(gameplayWorkbench, /retry-after/);
  assert.doesNotMatch(gameplayWorkbench, /Promise\.all\(\[worker\(\), worker\(\)\]\)/);
  assert.match(gameplayWorkbench, /GameplayPostGameReview/);
  assert.match(gameplayWorkbench, /indexCompleteness=/);
  assert.match(gameplayWorkbench, /onPlayMoment=/);
  assert.match(gameplayWorkbench, /key=\{reviewRevision\}/);
  assert.equal((gameplayWorkbench.match(/<GameplayPostGameReview\b/g) ?? []).length, 1);
  assert.equal((gameplayWorkbench.match(/fetch\("\/api\/analyze\/search"/g) ?? []).length, 1);
  assert.doesNotMatch(gameplayWorkbench, /key=\{activeTab\}/);
  assert.match(gameplayWorkbench, /function focusToolTab[\s\S]*?requestAnimationFrame[\s\S]*?\.focus\(\)/);
  assert.match(gameplayWorkbench, /video\.focus\(\{ preventScroll: true \}\)/);
  assert.match(gameplayWorkbench, /onClick=\{\(\) => focusToolTab\("clips"\)\}/);
  assert.match(gameplayWorkbench, /disabled=\{state === "indexing"\}/);
  assert.match(gameplayWorkbench, /status: "canceled", message: "Canceled · ready to retry"/);
  assert.match(gameplayWorkbench, /const indexProgress = jobs\.length \? Math\.round\(\(completedJobs \+ failedJobs\)/);
  assert.match(gameplayWorkbench, /a\.clipId\.localeCompare\(b\.clipId\)/);
  assert.match(gameplayWorkbench, /\(startMs - 2_000\)/);
  const postGameReview = await readFile(
    new URL("app/components/gameplay-post-review.tsx", projectRoot),
    "utf8",
  );
  assert.match(postGameReview, /Building your review/);
  assert.match(postGameReview, /\/api\/analyze\/review/);
  assert.match(postGameReview, /\/api\/analyze\/coach/);
  assert.match(postGameReview, /result\.api\?\.real/);
  assert.match(postGameReview, /window\.setTimeout/);
  assert.match(postGameReview, /window\.clearTimeout/);
  assert.match(postGameReview, /controller\.abort\(\)/);
  assert.match(postGameReview, /setCoachEntries\(\{\}\)/);
  assert.match(postGameReview, /Partial evidence review/);
  assert.match(postGameReview, /Retry review/);
  assert.match(postGameReview, /Not observed/);
  assert.match(postGameReview, /observed && <EvidenceLinks eventIds=\{rating\.eventIds\}/);
  assert.match(postGameReview, /candidateScope\.type === "team"[\s\S]*?\? "Squad"/);
  assert.match(postGameReview, /Team review unavailable—these clips could not be reliably connected/);
  assert.match(postGameReview, /DIRECTOR&apos;S CUT · LOCAL PREVIEW/);
  assert.match(postGameReview, /activeBeat\.endMs/);
  assert.match(postGameReview, /Previous beat/);
  assert.match(postGameReview, /Next beat/);
  assert.doesNotMatch(postGameReview, /temporary playable sequence, not an exported file/i);
  assert.match(postGameReview, /prior\.slice\(-6\)/);
  assert.match(postGameReview, /insufficient_evidence/);
  assert.match(postGameReview, /Not enough evidence yet/);
  assert.match(postGameReview, /onPlayMoment\(citation\.clipId, citation\.startMs\)/);
  assert.match(postGameReview, /aria-orientation="horizontal"/);
  assert.match(postGameReview, /aria-controls=\{panelId\}/);
  assert.match(postGameReview, /aria-labelledby=\{selectedTabId\}/);
  assert.match(postGameReview, /role="tabpanel"[\s\S]*?aria-labelledby=\{selectedTabId\}[\s\S]*?tabIndex=\{0\}/);
  assert.match(postGameReview, /tabIndex=\{selected \? 0 : -1\}/);
  assert.match(postGameReview, /event\.key === "ArrowRight"/);
  assert.match(postGameReview, /event\.key === "ArrowLeft"/);
  assert.match(postGameReview, /event\.key === "Home"/);
  assert.match(postGameReview, /event\.key === "End"/);
  assert.match(postGameReview, /document\.addEventListener\("visibilitychange", pauseWhenHidden\)/);
  assert.match(postGameReview, /document\.hidden/);
  assert.doesNotMatch(postGameReview, /imageDataUrl|audioBase64/);
  const gameplayLimits = await readFile(new URL("lib/gameplay-search-types.ts", projectRoot), "utf8");
  assert.match(gameplayLimits, /maximumClips: 4/);
  assert.match(gameplayLimits, /maximumTotalDurationMs: 60 \* 60_000/);
  assert.match(gameplayLimits, /maximumFramesPerSegment: 24/);
  assert.match(gameplayLimits, /interface GameplayPostReview/);
  assert.match(gameplayLimits, /interface GameplayCoachResponse/);
  assert.match(gameplayLimits, /interface DirectorPreviewPlan/);
  const gameplayClient = await readFile(new URL("lib/gameplay-search-client.ts", projectRoot), "utf8");
  assert.match(gameplayClient, /new BlobSource\(file/);
  assert.match(gameplayClient, /new Mp4OutputFormat/);
  assert.match(gameplayClient, /new WebMOutputFormat/);
  assert.match(gameplayClient, /fit: "contain"/);
  const realLimits = await readFile(new URL("lib/real-analysis-types.ts", projectRoot), "utf8");
  assert.match(realLimits, /maximumDurationMs: 3 \* 60_000/);
  assert.match(realLimits, /framesPerClip: 16/);

  const deniedResponse = await dispatch("/", {
    headers: {
      "oai-authenticated-user-id": "unapproved-user",
      "oai-authenticated-user-email": "unapproved@example.com",
    },
  });
  assert.equal(deniedResponse.status, 200);
  assert.match(await deniedResponse.text(), /Access not approved/);

  const previousAuthProvider = process.env.UNSEEN_AUTH_PROVIDER;
  process.env.UNSEEN_AUTH_PROVIDER = "cloudflare_access";
  try {
    const cloudflareAccessResponse = await dispatch("/", {
      headers: {
        "cf-access-authenticated-user-email": "judge@example.com",
        "cf-access-jwt-assertion": "test-access-jwt",
      },
    });
    assert.equal(cloudflareAccessResponse.status, 200);
    const cloudflareAccessHtml = await cloudflareAccessResponse.text();
    assert.match(cloudflareAccessHtml, /judge@example\.com/);
    assert.match(cloudflareAccessHtml, /\/cdn-cgi\/access\/logout/);
  } finally {
    if (previousAuthProvider === undefined) delete process.env.UNSEEN_AUTH_PROVIDER;
    else process.env.UNSEEN_AUTH_PROVIDER = previousAuthProvider;
  }
});

test("live analysis fails closed when the server secret is absent", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousAccessToken = process.env.UNSEEN_API_ACCESS_TOKEN;
  delete process.env.OPENAI_API_KEY;
  process.env.UNSEEN_API_ACCESS_TOKEN = "test-service-token";
  try {
    const statusResponse = await dispatch("/api/analyze/status");
    assert.equal(statusResponse.status, 200);
    assert.equal(statusResponse.headers.get("cache-control"), "no-store");
    const statusPayload = await statusResponse.json();
    assert.equal(statusPayload.configured, false);
    assert.equal(statusPayload.mode, "unavailable");
    assert.equal(statusPayload.scriptedFallback, false);

    const unauthorizedResponse = await dispatch("/api/analyze/clip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthorizedResponse.status, 401);
    const unauthorizedPayload = await unauthorizedResponse.json();
    assert.equal(unauthorizedPayload.error.code, "UNAUTHORIZED");

    const forbiddenResponse = await dispatch("/api/analyze/clip", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "oai-authenticated-user-id": "unapproved-user",
        "oai-authenticated-user-email": "unapproved@example.com",
      },
      body: "{}",
    });
    assert.equal(forbiddenResponse.status, 403);
    const forbiddenPayload = await forbiddenResponse.json();
    assert.equal(forbiddenPayload.error.code, "FORBIDDEN");

    const invalidServiceTokenResponse = await dispatch("/api/analyze/clip", {
      method: "POST",
      headers: {
        "x-unseen-service-token": "wrong-token",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(invalidServiceTokenResponse.status, 401);

    const serviceTokenResponse = await dispatch("/api/analyze/clip", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ serviceToken: "test-service-token" }),
    });
    assert.equal(serviceTokenResponse.status, 503);
    assert.equal((await serviceTokenResponse.json()).error.code, "AI_NOT_CONFIGURED");

    const response = await dispatch("/api/analyze/clip", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.json();
    assert.equal(payload.error.code, "AI_NOT_CONFIGURED");
    assert.match(payload.error.message, /will not substitute prewritten results/i);

    const searchResponse = await dispatch("/api/analyze/search", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(searchResponse.status, 503);
    assert.equal((await searchResponse.json()).error.code, "AI_NOT_CONFIGURED");

    const unauthorizedReview = await dispatch("/api/analyze/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unauthorizedReview.status, 401);
    assert.equal((await unauthorizedReview.json()).error.code, "UNAUTHORIZED");

    const reviewResponse = await dispatch("/api/analyze/review", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(reviewResponse.status, 503);
    assert.equal(reviewResponse.headers.get("cache-control"), "no-store");
    assert.equal((await reviewResponse.json()).error.code, "AI_NOT_CONFIGURED");

    const coachResponse = await dispatch("/api/analyze/coach", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(coachResponse.status, 503);
    assert.equal(coachResponse.headers.get("cache-control"), "no-store");
    assert.equal((await coachResponse.json()).error.code, "AI_NOT_CONFIGURED");
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousAccessToken === undefined) delete process.env.UNSEEN_API_ACCESS_TOKEN;
    else process.env.UNSEEN_API_ACCESS_TOKEN = previousAccessToken;
  }
});

test("gameplay search indexes cited events, seeks only known IDs, and clamps reel cuts", { concurrency: false }, async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only-key";
  const upstreamRequests = [];
  globalThis.fetch = async (_url, init) => {
    const outbound = JSON.parse(init.body);
    upstreamRequests.push(outbound);
    assert.equal(outbound.store, false);
    assert.equal(outbound.model, "gpt-5.6-sol");
    const schema = outbound.text.format.name;
    if (schema === "unseen_gameplay_segment_index") {
      assert.equal(
        outbound.input[0].content.filter((item) => item.type === "input_image").length,
        2,
      );
      return new Response(JSON.stringify({
        id: "resp_gameplay_index",
        model: "gpt-5.6-sol-2026-08-01",
        output_text: JSON.stringify({
          gameTitle: "Free Fire",
          gameMode: "Battle Royale",
          contextSummary: "Player X wins a close fight against Player Y.",
          events: [{
            id: "clip-long-segment-001-event-1",
            startMs: 44_000,
            endMs: 46_000,
            type: "elimination",
            title: "X eliminates Y",
            description: "The kill feed visibly credits X with eliminating Y.",
            actors: ["X"],
            target: "Y",
            ocrText: "X eliminated Y",
            importance: 90,
            confidence: 0.96,
            evidenceFrameIds: ["clip-long-segment-001-frame-44000"],
            transcriptSegmentIds: [],
          }, {
            id: "clip-long-segment-001-event-duplicate",
            startMs: 44_100,
            endMs: 46_100,
            type: "elimination",
            title: "X eliminates Y",
            description: "A duplicate read of the same kill feed event.",
            actors: ["X"],
            target: "Y",
            ocrText: "X eliminated Y",
            importance: 80,
            confidence: 0.88,
            evidenceFrameIds: ["clip-long-segment-001-frame-44000"],
            transcriptSegmentIds: [],
          }],
        }),
        usage: { input_tokens: 500, output_tokens: 100 },
      }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_gameplay_index" } });
    }
    if (schema === "unseen_gameplay_search") {
      const requestedGhost = outbound.input.includes("ghost event");
      const requestedSkin = outbound.input.includes("equipped skin");
      return new Response(JSON.stringify({
        id: "resp_gameplay_search",
        model: "gpt-5.6-sol-2026-08-01",
        output_text: JSON.stringify({
          answerType: requestedSkin ? "insufficient_evidence" : "matches",
          summary: requestedSkin ? "No indexed evidence identifies the equipped skin." : "One cited elimination matches.",
          hits: requestedSkin ? [] : [{ eventId: requestedGhost ? "unknown-event" : "clip-long-segment-001-event-1", title: "X eliminates Y", whyMatch: "The visible kill feed matches both players.", confidence: 0.97 }],
        }),
        usage: { input_tokens: 150, output_tokens: 40 },
      }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_gameplay_search" } });
    }
    assert.equal(schema, "unseen_highlight_plan");
    return new Response(JSON.stringify({
      id: "resp_gameplay_highlights",
      model: "gpt-5.6-sol-2026-08-01",
      output_text: JSON.stringify({
        title: "The X vs Y Finish",
        beats: [{ eventId: "clip-long-segment-001-event-1", startMs: -5_000, endMs: 200_000, caption: "X closes the fight against Y" }],
      }),
      usage: { input_tokens: 180, output_tokens: 55 },
    }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_gameplay_highlights" } });
  };

  const clip = { id: "clip-long", name: "full-game.mp4", label: "Player X", durationMs: 120_000, sizeBytes: 20_000_000 };
  try {
    const indexResponse = await dispatch("/api/analyze/index-segment", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        clip,
        segment: { id: "clip-long-segment-001", startMs: 0, endMs: 120_000 },
        frames: [
          { id: "clip-long-segment-001-frame-44000", timestampMs: 44_000, imageDataUrl: "data:image/jpeg;base64,AA==", width: 960, height: 540, detail: "high", reason: "hud_change" },
          { id: "clip-long-segment-001-frame-46000", timestampMs: 46_000, imageDataUrl: "data:image/jpeg;base64,AA==", width: 320, height: 180, detail: "low", reason: "context" },
        ],
        audioFeatures: [{ timestampMs: 44_000, rms: 0.4, peak: 0.9 }],
        transcriptSegments: [],
        priorContext: null,
      }),
    });
    assert.equal(indexResponse.status, 200);
    const indexed = await indexResponse.json();
    assert.equal(indexed.api.responseId, "resp_gameplay_index");
    assert.equal(indexed.events[0].clipId, clip.id);
    assert.equal(indexed.events.length, 1, "duplicate detections in one event window should collapse");
    assert.deepEqual(indexed.events[0].evidenceFrameIds, ["clip-long-segment-001-frame-44000"]);

    const searchResponse = await dispatch("/api/analyze/search", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ query: "a moment where X kills Y", clips: [clip], segments: [indexed] }),
    });
    assert.equal(searchResponse.status, 200);
    const search = await searchResponse.json();
    assert.equal(search.answerType, "matches");
    assert.equal(search.hits[0].startMs, 44_000);
    assert.deepEqual(search.hits[0].evidenceFrameIds, ["clip-long-segment-001-frame-44000"]);

    const insufficientResponse = await dispatch("/api/analyze/search", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ query: "which equipped skin was visible", clips: [clip], segments: [indexed] }),
    });
    assert.equal(insufficientResponse.status, 200);
    const insufficient = await insufficientResponse.json();
    assert.equal(insufficient.answerType, "insufficient_evidence");
    assert.deepEqual(insufficient.hits, []);

    const unknownEventResponse = await dispatch("/api/analyze/search", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ query: "find the ghost event", clips: [clip], segments: [indexed] }),
    });
    assert.equal(unknownEventResponse.status, 502);
    assert.equal((await unknownEventResponse.json()).error.code, "OPENAI_INVALID_OUTPUT");

    const highlightResponse = await dispatch("/api/analyze/highlights", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "Make a reel about the X vs Y fight",
        targetDurationMs: 30_000,
        aspectRatio: "9:16",
        clips: [clip],
        segments: [indexed],
        selectedEventIds: [indexed.events[0].id],
      }),
    });
    assert.equal(highlightResponse.status, 200);
    const highlight = await highlightResponse.json();
    assert.equal(highlight.aspectRatio, "9:16");
    assert.ok(highlight.beats[0].startMs >= 0);
    assert.ok(highlight.beats[0].endMs <= clip.durationMs);
    assert.ok(highlight.beats[0].endMs - highlight.beats[0].startMs <= 12_000);
    assert.ok(highlight.estimatedDurationMs <= 30_000);
    assert.equal(upstreamRequests.length, 5);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("gameplay routes reject unknown evidence and unconsented voice transmission", { concurrency: false }, async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only-key";
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({
      id: "resp_bad_index",
      model: "gpt-5.6-sol",
      output_text: JSON.stringify({
        gameTitle: "Unknown game",
        gameMode: "Unknown mode",
        contextSummary: "Unclear footage.",
        events: [{
          id: "segment-a-event-1", startMs: 1_000, endMs: 2_000, type: "other",
          title: "Unverified", description: "Bad citation", actors: [], target: null,
          ocrText: "", importance: 20, confidence: 0.2,
          evidenceFrameIds: ["hallucinated-frame"], transcriptSegmentIds: [],
        }],
      }),
      usage: { input_tokens: 20, output_tokens: 20 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const invalidIndex = await dispatch("/api/analyze/index-segment", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        clip: { id: "clip-a", name: "a.mp4", label: "A", durationMs: 10_000, sizeBytes: 1_000_000 },
        segment: { id: "segment-a", startMs: 0, endMs: 10_000 },
        frames: [
          { id: "frame-a", timestampMs: 1_000, imageDataUrl: "data:image/jpeg;base64,AA==", width: 2, height: 2, detail: "high", reason: "visual_change" },
          { id: "frame-b", timestampMs: 8_000, imageDataUrl: "data:image/jpeg;base64,AA==", width: 2, height: 2, detail: "low", reason: "context" },
        ],
        audioFeatures: [], transcriptSegments: [], priorContext: null,
      }),
    });
    assert.equal(invalidIndex.status, 502);
    assert.equal((await invalidIndex.json()).error.code, "OPENAI_INVALID_OUTPUT");

    const audio = new FormData();
    audio.append("file", new Blob(["voice"], { type: "audio/webm" }), "voice.webm");
    audio.append("clipId", "clip-a");
    audio.append("chunkStartMs", "0");
    audio.append("voiceConsent", "false");
    const unconsented = await dispatch("/api/analyze/transcribe", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: audio,
    });
    assert.equal(unconsented.status, 400);
    assert.equal((await unconsented.json()).error.code, "INVALID_REQUEST");

    const overDuration = await dispatch("/api/analyze/search", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        query: "find a clutch",
        clips: [
          { id: "long-a", name: "a.mp4", label: "A", durationMs: 31 * 60_000, sizeBytes: 500_000_000 },
          { id: "long-b", name: "b.mp4", label: "B", durationMs: 31 * 60_000, sizeBytes: 500_000_000 },
        ],
        segments: [],
      }),
    });
    assert.equal(overDuration.status, 400);
    assert.match((await overDuration.json()).error.message, /60-minute/i);
    assert.equal(upstreamCalls, 1, "unconsented audio must be rejected before any upstream request");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("consented voice analysis returns absolute Whisper segment timestamps", { concurrency: false }, async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only-key";
  let upstreamForm;
  globalThis.fetch = async (_url, init) => {
    upstreamForm = init?.body;
    return new Response(JSON.stringify({
      text: "Go left now",
      segments: [{ start: 1.2, end: 2.8, text: " Go left now " }],
    }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "req_voice_transcript" },
    });
  };
  try {
    const audio = new FormData();
    audio.append("file", new Blob(["consented voice"], { type: "audio/webm" }), "voice.webm");
    audio.append("clipId", "clip-voice");
    audio.append("chunkStartMs", "10000");
    audio.append("voiceConsent", "true");
    const response = await dispatch("/api/analyze/transcribe", {
      method: "POST",
      headers: AUTH_HEADERS,
      body: audio,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const payload = await response.json();
    assert.equal(payload.api.real, true);
    assert.equal(payload.api.requestId, "req_voice_transcript");
    assert.equal(payload.api.model, "whisper-1");
    assert.deepEqual(payload.segments, [{
      id: "clip-voice-transcript-10000-1",
      clipId: "clip-voice",
      startMs: 11200,
      endMs: 12800,
      text: "Go left now",
    }]);
    assert.ok(upstreamForm instanceof FormData);
    assert.equal(upstreamForm.get("model"), "whisper-1");
    assert.equal(upstreamForm.get("response_format"), "verbose_json");
    assert.equal(upstreamForm.get("timestamp_granularities[]"), "segment");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("post-game review grounds every claim, clamps Director beats, and abstains without events", { concurrency: false }, async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousCoachModel = process.env.OPENAI_COACH_MODEL;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only-key";
  process.env.OPENAI_COACH_MODEL = "gpt-coach-test";
  const fixture = coachingFixture();
  let reviewMode = "valid";
  let upstreamCalls = 0;
  globalThis.fetch = async (_url, init) => {
    upstreamCalls += 1;
    const outbound = JSON.parse(init.body);
    assert.equal(outbound.store, false);
    assert.equal(outbound.model, "gpt-coach-test");
    assert.equal(outbound.text.format.name, "unseen_gameplay_post_review");
    assert.doesNotMatch(JSON.stringify(outbound), /data:image|blob:|audioBase64|video\/mp4/i);
    let raw = validRawReview({
      invalidClipId: reviewMode === "unknown-clip" ? "ghost-clip" : "",
      invalidEventId: reviewMode === "unknown-event" ? "ghost-event" : "",
      communicationWithoutTranscript: reviewMode === "communication-without-transcript",
    });
    if (reviewMode === "director-wrong-source") raw.directorPreview.beats[0].clipId = "coach-a";
    if (reviewMode === "low-confidence-relationship") raw.sessionRelationship.confidence = 0.64;
    if (reviewMode === "mixed-director" || reviewMode === "uncertain-director") {
      raw.sessionRelationship.status = reviewMode === "mixed-director" ? "mixed_sources" : "uncertain";
      raw.sessionRelationship.confidence = 0.9;
      raw.teamReview = null;
    }
    if (reviewMode === "model-insufficient") {
      raw = {
        answerType: "insufficient_evidence",
        title: "MODEL CLAIM: Ace dominated every opponent",
        summary: "MODEL CLAIM: hidden statistics prove flawless mechanics",
        sessionRelationship: {
          status: "likely_same_session",
          confidence: 0.99,
          summary: "MODEL CLAIM: these sources are certainly synchronized",
          eventIds: ["coach-a-segment-001-event-clutch", "coach-b-segment-001-event-rotation"],
        },
        playerReviews: [],
        teamReview: null,
        directorPreview: null,
      };
    }
    return new Response(JSON.stringify({
      id: `resp-review-${reviewMode}`,
      model: "gpt-coach-test-2026-08-01",
      output_text: JSON.stringify(raw),
      usage: { input_tokens: 720, output_tokens: 330 },
    }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": `req-review-${reviewMode}` },
    });
  };

  const requestBody = {
    clips: fixture.clips,
    segments: fixture.segments,
    indexCompleteness: "complete",
    voiceAnalysisEnabled: true,
  };
  try {
    const response = await dispatch("/api/analyze/review", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("cache-control"), "no-store");
    const review = await response.json();
    assert.equal(review.answerType, "review");
    assert.equal(review.coverage, "complete");
    assert.equal(review.playerReviews.length, 2);
    assert.equal(review.teamReview.ratings.length, 6);
    assert.equal(review.voiceEvidenceAvailable, true);
    assert.equal(review.api.real, true);
    assert.equal(review.api.responseId, "resp-review-valid");
    assert.equal(review.api.requestId, "req-review-valid");
    assert.equal(review.api.model, "gpt-coach-test-2026-08-01");
    const rinCommunication = review.playerReviews
      .find((player) => player.clipId === "coach-b")
      .ratings.find((rating) => rating.dimension === "communication");
    assert.equal(rinCommunication.status, "not_observed");
    assert.equal(rinCommunication.level, null);
    assert.deepEqual(rinCommunication.eventIds, []);
    assert.equal(review.directorPreview.sourceCount, 2);
    assert.equal(review.directorPreview.beats.length, 2);
    assert.deepEqual(
      review.directorPreview.beats.map(({ clipId, startMs, endMs }) => ({ clipId, startMs, endMs })),
      [
        { clipId: "coach-b", startMs: 39_000, endMs: 50_000 },
        { clipId: "coach-a", startMs: 41_000, endMs: 52_000 },
      ],
    );
    assert.equal(review.directorPreview.durationMs, 22_000);

    const emptySegments = fixture.segments.map((segment, index) => index === 1 ? { ...segment, events: [] } : segment);
    const insufficientResponse = await dispatch("/api/analyze/review", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ ...requestBody, segments: emptySegments }),
    });
    assert.equal(insufficientResponse.status, 200);
    const insufficient = await insufficientResponse.json();
    assert.equal(insufficient.answerType, "insufficient_evidence");
    assert.equal(insufficient.coverage, "insufficient");
    assert.equal(insufficient.api, null);
    assert.deepEqual(insufficient.playerReviews, []);
    assert.equal(insufficient.teamReview, null);
    assert.equal(insufficient.directorPreview, null);
    assert.equal(upstreamCalls, 1, "a perspective with no events should abstain without calling OpenAI");

    reviewMode = "model-insufficient";
    const modelInsufficientResponse = await dispatch("/api/analyze/review", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    assert.equal(modelInsufficientResponse.status, 200, await modelInsufficientResponse.clone().text());
    const modelInsufficient = await modelInsufficientResponse.json();
    assert.equal(modelInsufficient.answerType, "insufficient_evidence");
    assert.equal(modelInsufficient.title, "Not enough evidence to coach this session");
    assert.equal(
      modelInsufficient.summary,
      "The indexed gameplay events do not contain enough reliable evidence for an evidence-grounded coaching review.",
    );
    assert.equal(modelInsufficient.sessionRelationship.status, "uncertain");
    assert.equal(modelInsufficient.sessionRelationship.confidence, 0);
    assert.equal(
      modelInsufficient.sessionRelationship.summary,
      "The index does not contain enough evidence to connect these sources.",
    );
    assert.deepEqual(modelInsufficient.sessionRelationship.eventIds, []);

    for (const [mode, expectedPattern] of [
      ["unknown-event", /unknown event/i],
      ["unknown-clip", /unknown or duplicate player review clip/i],
      ["communication-without-transcript", /communication without transcript evidence/i],
      ["director-wrong-source", /invalid Director source clip/i],
      ["low-confidence-relationship", /linked sources without sufficient cross-source confidence/i],
      ["mixed-director", /multi-source Director preview.*not reliably linked/i],
      ["uncertain-director", /multi-source Director preview.*not reliably linked/i],
    ]) {
      reviewMode = mode;
      const invalidResponse = await dispatch("/api/analyze/review", {
        method: "POST",
        headers: { ...AUTH_HEADERS, "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      assert.equal(invalidResponse.status, 502, mode);
      const invalid = await invalidResponse.json();
      assert.equal(invalid.error.code, "OPENAI_INVALID_OUTPUT", mode);
      assert.match(invalid.error.message, expectedPattern, mode);
    }

    reviewMode = "valid";
    const noVoiceResponse = await dispatch("/api/analyze/review", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ ...requestBody, voiceAnalysisEnabled: false }),
    });
    assert.equal(noVoiceResponse.status, 502);
    const noVoice = await noVoiceResponse.json();
    assert.equal(noVoice.error.code, "OPENAI_INVALID_OUTPUT");
    assert.match(noVoice.error.message, /communication without transcript evidence/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousCoachModel === undefined) delete process.env.OPENAI_COACH_MODEL;
    else process.env.OPENAI_COACH_MODEL = previousCoachModel;
  }
});

test("Ask Coach bounds conversation context and resolves only known scoped citations", { concurrency: false }, async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only-key";
  const fixture = coachingFixture();
  let coachMode = "coaching";
  let coachInput = "";
  globalThis.fetch = async (_url, init) => {
    const outbound = JSON.parse(init.body);
    assert.equal(outbound.store, false);
    if (outbound.text.format.name === "unseen_gameplay_post_review") {
      return new Response(JSON.stringify({
        id: "resp-review-for-coach",
        model: "gpt-5.6-sol-2026-08-01",
        output_text: JSON.stringify(validRawReview()),
        usage: { input_tokens: 700, output_tokens: 300 },
      }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "req-review-for-coach" } });
    }
    assert.equal(outbound.text.format.name, "unseen_gameplay_coach");
    coachInput = typeof outbound.input === "string" ? outbound.input : JSON.stringify(outbound.input);
    const citationEventIds = coachMode === "coaching"
      ? ["coach-a-segment-001-event-clutch"]
      : coachMode === "unknown-event"
        ? ["ghost-event"]
        : [];
    return new Response(JSON.stringify({
      id: `resp-coach-${coachMode}`,
      model: "gpt-5.6-sol-2026-08-01",
      output_text: JSON.stringify({
        answerType: coachMode === "insufficient" ? "insufficient_evidence" : "coaching",
        answer: coachMode === "insufficient"
          ? "UNSUPPORTED MODEL COACHING: push every fight because aggression always wins."
          : "Pause for the teammate's angle confirmation before taking the final duel.",
        nextAction: coachMode === "insufficient"
          ? "UNSUPPORTED MODEL ACTION: ignore the index and trust this uncited instruction."
          : "Use a one-second confirmation cue before committing in three rounds.",
        citationEventIds,
      }),
      usage: { input_tokens: 240, output_tokens: 70 },
    }), { status: 200, headers: { "content-type": "application/json", "x-request-id": `req-coach-${coachMode}` } });
  };

  try {
    const reviewResponse = await dispatch("/api/analyze/review", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        clips: fixture.clips,
        segments: fixture.segments,
        indexCompleteness: "complete",
        voiceAnalysisEnabled: true,
      }),
    });
    assert.equal(reviewResponse.status, 200, await reviewResponse.clone().text());
    const review = await reviewResponse.json();
    const clientReviewProseSentinel = "CLIENT_REVIEW_PROSE_MUST_NOT_REACH_OPENAI_4FBD";
    review.title = clientReviewProseSentinel;
    review.summary = clientReviewProseSentinel;
    review.playerReviews[0].summary = clientReviewProseSentinel;
    review.playerReviews[0].primaryPriority = clientReviewProseSentinel;
    review.playerReviews[0].ratings[0].rationale = clientReviewProseSentinel;
    const history = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `history-message-${index}`,
    }));
    const body = {
      question: "What should Ace change on the final commitment?",
      scope: { type: "player", clipId: "coach-a" },
      history,
      clips: fixture.clips,
      segments: fixture.segments,
      review,
    };

    const coachResponse = await dispatch("/api/analyze/coach", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(coachResponse.status, 200);
    assert.equal(coachResponse.headers.get("cache-control"), "no-store");
    const coaching = await coachResponse.json();
    assert.equal(coaching.answerType, "coaching");
    assert.equal(coaching.citations.length, 1);
    assert.deepEqual(coaching.citations[0], {
      eventId: "coach-a-segment-001-event-clutch",
      clipId: "coach-a",
      startMs: 44_000,
      endMs: 47_000,
      title: "Ace commits to the final duel",
      evidenceFrameIds: ["coach-a-frame-44000"],
      transcriptSegmentIds: ["coach-a-transcript-43000-1"],
    });
    assert.doesNotMatch(coachInput, /history-message-[01]/);
    for (let index = 2; index < 8; index += 1) assert.match(coachInput, new RegExp(`history-message-${index}`));
    assert.doesNotMatch(coachInput, new RegExp(clientReviewProseSentinel));
    assert.match(coachInput, /coach-a-segment-001-event-clutch/);
    assert.doesNotMatch(coachInput, /data:image|blob:|audioBase64|video\/mp4/i);

    coachMode = "insufficient";
    const insufficientResponse = await dispatch("/api/analyze/coach", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(insufficientResponse.status, 200);
    const insufficient = await insufficientResponse.json();
    assert.equal(insufficient.answerType, "insufficient_evidence");
    assert.equal(insufficient.answer, "The indexed gameplay events do not contain enough reliable evidence to answer that coaching question.");
    assert.equal(insufficient.nextAction, "Ask about an observed event or index more footage.");
    assert.doesNotMatch(`${insufficient.answer} ${insufficient.nextAction}`, /UNSUPPORTED MODEL/);
    assert.deepEqual(insufficient.citations, []);

    coachMode = "unknown-event";
    const unknownResponse = await dispatch("/api/analyze/coach", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(unknownResponse.status, 502);
    const unknown = await unknownResponse.json();
    assert.equal(unknown.error.code, "OPENAI_INVALID_OUTPUT");
    assert.match(unknown.error.message, /unknown event/i);

    coachMode = "coaching";
    const wrongScopeResponse = await dispatch("/api/analyze/coach", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ ...body, scope: { type: "player", clipId: "coach-b" } }),
    });
    assert.equal(wrongScopeResponse.status, 502);
    const wrongScope = await wrongScopeResponse.json();
    assert.equal(wrongScope.error.code, "OPENAI_INVALID_OUTPUT");
    assert.match(wrongScope.error.message, /another perspective/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("gameplay indexing relays OpenAI rate-limit retry guidance", { concurrency: false }, async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only-key";
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: "Please retry shortly." } }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "3",
        "x-request-id": "req_rate_limited",
      },
    },
  );
  try {
    const response = await dispatch("/api/analyze/index-segment", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        clip: { id: "clip-rate", name: "rate.mp4", label: "Rate test", durationMs: 10_000, sizeBytes: 1_000_000 },
        segment: { id: "segment-rate", startMs: 0, endMs: 10_000 },
        frames: [
          { id: "frame-rate-a", timestampMs: 1_000, imageDataUrl: "data:image/jpeg;base64,AA==", width: 2, height: 2, detail: "high", reason: "visual_change" },
          { id: "frame-rate-b", timestampMs: 8_000, imageDataUrl: "data:image/jpeg;base64,AA==", width: 2, height: 2, detail: "low", reason: "context" },
        ],
        audioFeatures: [], transcriptSegments: [], priorContext: null,
      }),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "3");
    const payload = await response.json();
    assert.equal(payload.error.requestId, "req_rate_limited");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("live clip route rejects recordings longer than three minutes", { concurrency: false }, async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only-key";
  globalThis.fetch = async () => {
    throw new Error("OpenAI must not be called for an invalid clip.");
  };
  try {
    const response = await dispatch("/api/analyze/clip", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        clip: { id: "clip-too-long", name: "full-match.mp4", playerLabel: "Player A", durationMs: 180_001 },
        frames: [
          { id: "frame-01", timestampMs: 10_000, imageDataUrl: "data:image/jpeg;base64,AA==", width: 2, height: 2 },
          { id: "frame-02", timestampMs: 170_000, imageDataUrl: "data:image/jpeg;base64,AA==", width: 2, height: 2 },
        ],
        audio: null,
        voiceConsent: false,
      }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, "INVALID_REQUEST");
    assert.match(payload.error.message, /3 minutes or shorter/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("live clip route accepts a two-minute clip with sixteen sampled frames", { concurrency: false }, async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  const upstreamCalls = [];
  process.env.OPENAI_API_KEY = "test-only-key";
  globalThis.fetch = async (url, init) => {
    upstreamCalls.push({ url: String(url), init });
    if (String(url).endsWith("/audio/transcriptions")) {
      assert.ok(init.body instanceof FormData);
      return new Response(JSON.stringify({ text: "Flank left, I have it." }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "req_transcription_real" },
      });
    }
    const outbound = JSON.parse(init.body);
    assert.equal(outbound.model, "gpt-5.6-sol");
    assert.equal(outbound.store, false);
    assert.equal(outbound.text.format.type, "json_schema");
    assert.ok(
      outbound.input[0].content.some((item) => item.type === "input_image"),
      "the real frame must be sent as multimodal model input",
    );
    return new Response(
      JSON.stringify({
        id: "resp_clip_real",
        model: "gpt-5.6-sol-2026-08-01",
        output_text: JSON.stringify({
          gameTitle: "Free Fire",
          perspectiveSummary: "The player watches the left flank and calls the rotation.",
          observations: [
            {
              id: "obs-flank",
              timestampMs: 1100,
              endMs: 1500,
              category: "teamwork",
              description: "A hostile silhouette enters from the left while the player holds cover.",
              importance: 0.84,
              confidence: 0.94,
              evidenceFrameIds: ["clip-a-frame-01"],
              transcriptQuote: "Flank left, I have it.",
            },
          ],
        }),
        usage: { input_tokens: 321, output_tokens: 88 },
      }),
      { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_clip_real" } },
    );
  };

  try {
    const response = await dispatch("/api/analyze/clip", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        clip: { id: "clip-a", name: "garena-pov-a.mp4", playerLabel: "Player A", durationMs: 120_000 },
        frames: Array.from({ length: 16 }, (_, index) => ({
          id: `clip-a-frame-${String(index + 1).padStart(2, "0")}`,
          timestampMs: 3_750 + index * 7_500,
          imageDataUrl: "data:image/jpeg;base64,AA==",
          width: 2,
          height: 2,
        })),
        audio: { mimeType: "audio/wav", dataBase64: "UklGRg==" },
        voiceConsent: true,
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.api.real, true);
    assert.equal(payload.api.visionResponseId, "resp_clip_real");
    assert.equal(payload.api.visionRequestId, "req_clip_real");
    assert.equal(payload.api.transcriptionRequestId, "req_transcription_real");
    assert.equal(payload.audioStatus, "transcribed");
    assert.equal(payload.observations[0].importance, 84);
    assert.deepEqual(payload.observations[0].evidenceFrameIds, ["clip-a-frame-01"]);
    assert.equal(upstreamCalls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("cross-clip route links only valid observations and exposes the real response trace", { concurrency: false }, async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-only-key";
  globalThis.fetch = async (_url, init) => {
    const outbound = JSON.parse(init.body);
    assert.equal(outbound.model, "gpt-5.6-sol");
    if (outbound.text.format.name === "unseen_real_session_answer") {
      assert.match(outbound.input, /What happened off-screen/);
      return new Response(
        JSON.stringify({
          id: "resp_answer_real",
          model: "gpt-5.6-sol-2026-08-01",
          output_text: JSON.stringify({
            answer: "Player B called the left flank before Player A pushed.",
            confidence: 0.92,
            answerType: "observation",
            caveat: "Limited to the supplied session evidence.",
            citations: [{ clipId: "clip-b", observationId: "obs-b", timestampMs: 1_250 }],
          }),
          usage: { input_tokens: 200, output_tokens: 60 },
        }),
        { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_answer_real" } },
      );
    }
    assert.match(outbound.input, /resp_clip_a/);
    assert.match(outbound.input, /resp_clip_b/);
    return new Response(
      JSON.stringify({
        id: "resp_link_real",
        model: "gpt-5.6-sol-2026-08-01",
        output_text: JSON.stringify({
          storyTitle: "The Flank Nobody Else Saw",
          recap: "Player B's warning explains why Player A survived the final push.",
          alignment: [
            { clipId: "clip-a", offsetMs: 0, confidence: 1, basis: ["reference clip"] },
            { clipId: "clip-b", offsetMs: -250, confidence: 0.86, basis: ["matching HUD timer", "same flank call"] },
          ],
          linkedMoments: [
            {
              id: "moment-flank",
              title: "The unseen warning",
              summary: "One perspective shows the push; the other reveals the warning that enabled it.",
              sharedTimeMs: 1_000,
              importance: 0.91,
              emotion: "tense",
              whyLinked: "Both observations show the same HUD timer and complementary action.",
              sourceLinks: [
                { clipId: "clip-a", observationId: "obs-a", timestampMs: 1_000, role: "action" },
                { clipId: "clip-b", observationId: "obs-b", timestampMs: 1_250, role: "setup" },
              ],
            },
          ],
          directorCut: [
            { order: 1, momentId: "moment-flank", clipId: "clip-b", timestampMs: 1_250, durationMs: 3_000, reason: "Reveal the warning before the push." },
            { order: 2, momentId: "moment-flank", clipId: "clip-a", timestampMs: 1_000, durationMs: 3_000, reason: "Show its payoff." },
          ],
          whatYouMissed: [
            {
              viewerClipId: "clip-a",
              momentId: "moment-flank",
              title: "The warning behind your push",
              explanation: "Player B saw and called the flank outside Player A's view.",
              evidenceLinks: [
                { clipId: "clip-b", observationId: "obs-b", timestampMs: 1_250, role: "setup" },
              ],
            },
          ],
        }),
        usage: { input_tokens: 444, output_tokens: 111 },
      }),
      { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_link_real" } },
    );
  };

  const clip = (id, observationId, responseId) => ({
    clipId: id,
    clipName: `${id}.mp4`,
    playerLabel: id === "clip-a" ? "Player A" : "Player B",
    durationMs: 2_000,
    gameTitle: "Free Fire",
    perspectiveSummary: "Gameplay perspective.",
    transcript: "Flank left.",
    audioStatus: "transcribed",
    observations: [{
      id: observationId,
      timestampMs: 1_000,
      endMs: 1_300,
      category: "teamwork",
      description: "A linked action.",
      importance: 80,
      confidence: 0.9,
      evidenceFrameIds: [`${id}-frame-01`],
      transcriptQuote: "Flank left.",
    }],
    api: {
      real: true,
      visionResponseId: responseId,
      visionRequestId: `req_${id}`,
      visionModel: "gpt-5.6-sol",
      transcriptionRequestId: "req_transcript",
      transcriptionModel: "gpt-4o-mini-transcribe",
      inputTokens: 100,
      outputTokens: 50,
    },
  });

  try {
    const response = await dispatch("/api/analyze/link", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ clips: [clip("clip-a", "obs-a", "resp_clip_a"), clip("clip-b", "obs-b", "resp_clip_b")] }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.api.real, true);
    assert.equal(payload.api.responseId, "resp_link_real");
    assert.equal(payload.linkedMoments[0].importance, 91);
    assert.equal(payload.api.requestId, "req_link_real");
    assert.equal(payload.linkedMoments[0].sourceLinks.length, 2);
    assert.equal(payload.directorCut.length, 2);
    assert.equal(payload.whatYouMissed.length, 1);

    const askResponse = await dispatch("/api/analyze/ask", {
      method: "POST",
      headers: { ...AUTH_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        question: "What happened off-screen?",
        viewerClipId: "clip-a",
        clips: [clip("clip-a", "obs-a", "resp_clip_a"), clip("clip-b", "obs-b", "resp_clip_b")],
        session: payload,
      }),
    });
    assert.equal(askResponse.status, 200);
    const askPayload = await askResponse.json();
    assert.equal(askPayload.api.real, true);
    assert.equal(askPayload.api.responseId, "resp_answer_real");
    assert.equal(askPayload.citations[0].observationId, "obs-b");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test("session endpoint returns a referentially valid three-player story", async () => {
  const response = await dispatch("/api/demo/session");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { session, provenance } = await response.json();

  assert.equal(provenance.kind, "synthetic_demo_fixture");
  assert.equal(provenance.representsRealPlayers, false);
  assert.equal(provenance.containsRealGameplay, false);
  assert.deepEqual(session.provenance, provenance);

  assert.equal(session.participants.length, 3);
  assert.equal(session.sources.length, 3);
  assert.equal(session.media.mode, "preloaded_submission_demo");
  assert.equal(session.media.recordings.length, 3);
  assert.equal(session.media.traces.length, session.evidence.length);
  assert.ok(session.evidence.length >= 10);
  assert.ok(session.moments.length >= 3);
  assert.ok(session.directorCut.editBeats.length >= 5);
  assert.ok(
    session.participants.every(
      (participant) =>
        participant.consent.gameplayRecording === "granted" &&
        participant.consent.aiAnalysis === "granted",
    ),
  );

  const participantIds = new Set(session.participants.map(({ id }) => id));
  const evidenceIds = new Set(session.evidence.map(({ id }) => id));
  for (const source of session.sources) {
    assert.ok(participantIds.has(source.participantId));
  }
  for (const moment of session.moments) {
    assert.ok(moment.evidenceIds.every((id) => evidenceIds.has(id)));
  }

  const sourceById = new Map(session.sources.map((source) => [source.id, source]));
  for (const recording of session.media.recordings) {
    const asset = new URL(`public${recording.assetUrl}`, projectRoot);
    const bytes = await readFile(asset);
    assert.equal(bytes.length, recording.bytes, recording.sourceId);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      recording.sha256,
      recording.sourceId,
    );
    assert.ok(bytes.includes(Buffer.from("vide")), `${recording.sourceId} needs video`);
    assert.ok(bytes.includes(Buffer.from("soun")), `${recording.sourceId} needs audio`);
    await access(
      new URL(
        `public/demo/${sourceById.get(recording.sourceId).participantId}-poster.jpg`,
        projectRoot,
      ),
    );
  }

  const tracedEvidenceIds = new Set(
    session.media.traces.map((trace) => trace.evidenceId),
  );
  assert.deepEqual(tracedEvidenceIds, evidenceIds);
  for (const trace of session.media.traces) {
    assert.ok(trace.modalities.length > 0, trace.evidenceId);
    assert.ok(trace.sourceObservations.length > 0, trace.evidenceId);
    for (const observation of trace.sourceObservations) {
      const source = sourceById.get(observation.sourceId);
      assert.ok(source, `${trace.evidenceId} has an unknown source`);
      assert.ok(observation.sourceTimeMs >= 0);
      assert.ok(observation.sourceTimeMs < source.durationMs);
      assert.ok(
        Math.abs(
          observation.sourceTimeMs + source.alignmentOffsetMs - trace.sharedTimeMs,
        ) <= 1,
        `${trace.evidenceId} is not aligned to its shared timestamp`,
      );
    }
  }
});

test("reconstruction advances through all deterministic stages", async () => {
  const progress = [];
  const observedEvidence = [];
  for (let cursor = 0; cursor <= 5; cursor += 1) {
    const response = await dispatch("/api/demo/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursor }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.json();
    assert.equal(payload.cursor, cursor);
    assert.equal(payload.stages.length, 6);
    progress.push(payload.overallProgress);
    observedEvidence.push(payload.mediaAnalysis.evidenceObserved);
    assert.equal(payload.mediaAnalysis.recordingsVerified, 3);
    assert.equal(payload.mediaAnalysis.mode, "precomputed_media_trace");
    assert.ok(payload.mediaAnalysis.summary.length > 30);
    if (cursor < 5) assert.equal(payload.nextCursor, cursor + 1);
    else {
      assert.equal(payload.complete, true);
      assert.equal(payload.nextCursor, null);
      assert.ok(payload.outputCounts.editBeats >= 5);
      assert.equal(payload.mediaAnalysis.anchorsMatched, 6);
      assert.equal(payload.mediaAnalysis.evidenceObserved, 13);
      assert.ok(
        payload.mediaAnalysis.activeDetectors.includes(
          "cross_perspective_fusion",
        ),
      );
    }
  }
  assert.deepEqual(progress, [...progress].sort((a, b) => a - b));
  assert.deepEqual(
    observedEvidence,
    [...observedEvidence].sort((a, b) => a - b),
  );
});

test("reasoning endpoint produces aligned, ranked, evidence-linked edit artifacts", async () => {
  const response = await dispatch("/api/demo/reasoning");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json();

  assert.equal(payload.provenance.mode, "synthetic_fixture");
  assert.equal(payload.provenance.containsRealPlayerData, false);
  assert.equal(payload.version, "unseen-reasoning-v1");
  assert.equal(payload.alignment.transforms.length, 3);
  assert.ok(payload.alignment.overallConfidence >= 0.8);
  assert.equal(payload.rankedMoments.length, 3);
  assert.ok(payload.rankedMoments.every((moment) => moment.score > 0));
  assert.ok(payload.editPlan.clips.length >= 5);
  assert.ok(payload.editPlan.estimatedDurationMs <= payload.editPlan.targetDurationMs);
  assert.ok(payload.editPlan.clips.every((clip) => clip.evidenceIds.length > 0));
  assert.ok(payload.whatYouMissed.some((moment) => moment.revealSourceIds.length > 0));
  assert.equal(payload.audit.at(-1).stage, "ready");
});

test("Ask UNSEEN grounds every PRD benchmark question with playable evidence", async () => {
  const benchmarkQuestions = [
    "What were my teammates doing during my final clutch?",
    "Why did everyone start laughing in round seven?",
    "Who first noticed the flank?",
    "Which action helped us secure the objective?",
    "Show me a moment I could not see from my perspective.",
    "Did anyone warn me before I pushed?",
    "What changed between our failed plan and the winning play?",
  ];

  for (const question of benchmarkQuestions) {
    const response = await dispatch("/api/demo/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ viewerId: "ace", question }),
    });
    assert.equal(response.status, 200, question);
    assert.equal(response.headers.get("cache-control"), "no-store", question);

    const payload = await response.json();
    assert.equal(payload.question, question);
    assert.ok(payload.answer.length > 40, question);
    assert.ok(payload.confidence >= 0.9, question);
    assert.ok(payload.citations.length >= 2, question);
    assert.ok(
      payload.citations.every(
        (citation) =>
          /^\d{1,2}:\d{2}$/.test(citation.timestampLabel) &&
          typeof citation.evidenceId === "string",
      ),
      question,
    );
    assert.ok(
      payload.citations.some((citation) => typeof citation.sourceId === "string"),
      `${question} should cite at least one seekable source`,
    );
  }
});

test("demo APIs reject invalid and ungrounded requests explicitly", async () => {
  const invalidJson = await dispatch("/api/demo/process", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.headers.get("cache-control"), "no-store");
  assert.equal((await invalidJson.json()).error.code, "INVALID_JSON");

  const ungrounded = await dispatch("/api/demo/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "What skin was equipped?" }),
  });
  assert.equal(ungrounded.status, 422);
  assert.equal((await ungrounded.json()).error.code, "QUESTION_NOT_GROUNDED");
});

test("shared consent scope fails closed for revoked gameplay and voice evidence", () => {
  const grantAll = {
    gameplayRecording: "granted",
    voiceChat: "granted",
    aiAnalysis: "granted",
    squadSharing: "granted",
  };
  const session = {
    participants: [
      { id: "ace", consent: { ...grantAll } },
      { id: "rin", consent: { ...grantAll } },
    ],
    evidence: [
      { id: "ace-visual", type: "visual_event", participantId: "ace" },
      { id: "rin-visual", type: "visual_event", participantId: "rin" },
      { id: "rin-voice", type: "voice_transcript", participantId: "rin" },
      { id: "squad-reaction", type: "audio_reaction" },
      { id: "cross-view", type: "cross_perspective" },
    ],
  };

  const allGranted = buildSessionConsentScope(session);
  assert.equal(allGranted.allSessionEvidencePermitted, true);

  session.participants[1].consent.voiceChat = "declined";
  const voiceRevoked = buildSessionConsentScope(session);
  assert.equal(voiceRevoked.permittedEvidenceIds.has("rin-voice"), false);
  assert.equal(voiceRevoked.permittedEvidenceIds.has("squad-reaction"), false);
  assert.equal(voiceRevoked.permittedEvidenceIds.has("rin-visual"), true);

  session.participants[1].consent.gameplayRecording = "declined";
  const gameplayRevoked = buildSessionConsentScope(session);
  assert.equal(gameplayRevoked.permittedEvidenceIds.has("rin-visual"), false);
  assert.equal(gameplayRevoked.permittedEvidenceIds.has("cross-view"), false);
  assert.equal(gameplayRevoked.permittedEvidenceIds.has("ace-visual"), true);
});
