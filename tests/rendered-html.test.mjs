import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { buildSessionConsentScope } from "../lib/unseen-consent.js";

const projectRoot = new URL("../", import.meta.url);

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
  const response = await dispatch("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>UNSEEN — The whole squad story<\/title>/i);
  assert.match(html, /UNSEEN/);
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
  assert.match(experience, /PRELOADED SQUAD INPUTS/);
  assert.match(experience, /MEDIA → EVIDENCE/);
  assert.match(experience, /Analyze preloaded recordings/);
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
