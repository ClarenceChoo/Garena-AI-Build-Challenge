import assert from "node:assert/strict";
import test from "node:test";
import {
  createSegmentWindows,
  deduplicateOverlappingEvents,
  deduplicateOverlappingSegments,
  partitionSeedJobs,
  selectGameplaySegmentationMode,
  stablePriorContextByClip,
} from "../lib/gameplay-index-scheduling.js";

const job = (clipId, number) => ({
  id: `${clipId}-segment-${String(number).padStart(3, "0")}`,
  clipId,
  startMs: (number - 1) * 120_000,
});

const segment = (clipId, number, gameTitle = "Free Fire") => ({
  segmentId: `${clipId}-segment-${String(number).padStart(3, "0")}`,
  clipId,
  segmentStartMs: (number - 1) * 120_000,
  gameTitle,
  gameMode: "Clash Squad",
});

test("normal windows preserve the existing two-minute segmentation", () => {
  assert.deepEqual(createSegmentWindows(250_000), [
    { startMs: 0, endMs: 120_000 },
    { startMs: 120_000, endMs: 240_000 },
    { startMs: 240_000, endMs: 250_000 },
  ]);
  assert.deepEqual(createSegmentWindows(35_000, "normal"), [
    { startMs: 0, endMs: 35_000 },
  ]);
});

test("fast windows use a ten-second stride with two seconds of overlap", () => {
  const windows = createSegmentWindows(35_000, "fast");
  assert.deepEqual(windows, [
    { startMs: 0, endMs: 12_000 },
    { startMs: 10_000, endMs: 22_000 },
    { startMs: 20_000, endMs: 32_000 },
    { startMs: 30_000, endMs: 35_000 },
  ]);
  assert.equal(windows[0].endMs - windows[1].startMs, 2_000);
  assert.equal(windows.at(-1).endMs, 35_000);
  assert.throws(() => createSegmentWindows(0, "fast"), /positive integer/i);
  assert.throws(() => createSegmentWindows(10_000, "turbo"), /unknown gameplay segmentation mode/i);
});

test("two thirty-five-second demo clips fit exactly one eight-call wave", () => {
  const jobs = [35_000, 35_000].flatMap((durationMs) => createSegmentWindows(durationMs, "fast"));
  assert.equal(jobs.length, 8);
  assert.ok(jobs.every(({ startMs, endMs }) => endMs > startMs));
});

test("Fast Demo falls back to normal mode above two combined minutes", () => {
  assert.equal(selectGameplaySegmentationMode(120_000, true), "fast");
  assert.equal(selectGameplaySegmentationMode(120_001, true), "normal");
  assert.equal(selectGameplaySegmentationMode(35_000, false), "normal");
  assert.throws(() => selectGameplaySegmentationMode(-1, true), /non-negative integer/i);
});

test("fast windows skip trailing calls that add no new coverage", () => {
  assert.deepEqual(createSegmentWindows(11_000, "fast"), [{ startMs: 0, endMs: 11_000 }]);
  assert.deepEqual(createSegmentWindows(12_000, "fast"), [{ startMs: 0, endMs: 12_000 }]);
  assert.deepEqual(createSegmentWindows(21_000, "fast"), [
    { startMs: 0, endMs: 12_000 },
    { startMs: 10_000, endMs: 21_000 },
  ]);
  assert.deepEqual(createSegmentWindows(22_000, "fast"), [
    { startMs: 0, endMs: 12_000 },
    { startMs: 10_000, endMs: 22_000 },
  ]);
});

test("the first segment of every clip is seeded before later parallel work", () => {
  const work = [job("b", 3), job("a", 2), job("b", 1), job("a", 1), job("b", 2)];
  const { seedJobs, parallelJobs } = partitionSeedJobs(work, []);
  assert.deepEqual(seedJobs.map(({ id }) => id).sort(), ["a-segment-001", "b-segment-001"]);
  assert.deepEqual(parallelJobs.map(({ id }) => id).sort(), [
    "a-segment-002",
    "b-segment-002",
    "b-segment-003",
  ]);
});

test("a completed seed is reused and a failed seed is reseeded on retry", () => {
  const completedSeed = partitionSeedJobs([job("a", 2)], [segment("a", 1)]);
  assert.deepEqual(completedSeed.seedJobs, []);
  assert.deepEqual(completedSeed.parallelJobs.map(({ id }) => id), ["a-segment-002"]);

  const failedSeed = partitionSeedJobs([job("a", 1), job("a", 3)], [segment("a", 2)]);
  assert.deepEqual(failedSeed.seedJobs.map(({ id }) => id), ["a-segment-001"]);
  assert.deepEqual(failedSeed.parallelJobs.map(({ id }) => id), ["a-segment-003"]);
});

test("prior context is stable regardless of completion order", () => {
  const later = segment("a", 3, "Incorrect later guess");
  const seed = segment("a", 1, "Free Fire");
  const middle = segment("a", 2, "Another guess");
  const forward = stablePriorContextByClip([later, seed, middle]);
  const reverse = stablePriorContextByClip([middle, seed, later]);
  assert.deepEqual([...forward], [...reverse]);
  assert.deepEqual(forward.get("a"), {
    segmentStartMs: 0,
    gameTitle: "Free Fire",
    gameMode: "Clash Squad",
  });
});

const event = (overrides = {}) => ({
  id: "clip-a-segment-001-event-1",
  clipId: "clip-a",
  segmentId: "clip-a-segment-001",
  startMs: 10_400,
  endMs: 11_200,
  type: "elimination",
  title: "Ace eliminates Ryu",
  actors: ["Ace"],
  target: "Ryu",
  confidence: 0.8,
  importance: 80,
  ...overrides,
});

const indexedSegment = (overrides = {}) => ({
  clipId: "clip-a",
  segmentId: "clip-a-segment-001",
  segmentStartMs: 0,
  segmentEndMs: 12_000,
  gameTitle: "Free Fire",
  gameMode: "Clash Squad",
  contextSummary: "A fight crosses the analysis boundary.",
  evidenceFrameIds: ["frame-1", "frame-2"],
  transcriptSegmentIds: [],
  events: [],
  api: { responseId: "response-1", requestId: "request-1" },
  ...overrides,
});

test("overlap dedup keeps the stronger whole event but retains a distinct nearby event", () => {
  const earlierObservation = event();
  const strongerBoundaryObservation = event({
    id: "clip-a-segment-002-event-1",
    segmentId: "clip-a-segment-002",
    startMs: 10_600,
    endMs: 11_300,
    title: "Ryu eliminated by Ace",
    confidence: 0.94,
  });
  const distinctNearbyEvent = event({
    id: "clip-a-segment-002-event-2",
    segmentId: "clip-a-segment-002",
    startMs: 11_301,
    endMs: 11_800,
    title: "Ace eliminates Kai",
    target: "Kai",
    confidence: 0.7,
  });
  const sameMomentOtherClip = event({
    id: "clip-b-segment-001-event-1",
    clipId: "clip-b",
    segmentId: "clip-b-segment-001",
    confidence: 0.99,
  });
  const result = deduplicateOverlappingEvents(
    [distinctNearbyEvent, sameMomentOtherClip, strongerBoundaryObservation, earlierObservation],
    new Map([
      ["clip-a-segment-001", 0],
      ["clip-a-segment-002", 10_000],
      ["clip-b-segment-001", 0],
    ]),
  );

  assert.deepEqual(result.map(({ id }) => id), [
    "clip-a-segment-002-event-1",
    "clip-a-segment-002-event-2",
    "clip-b-segment-001-event-1",
  ]);
  assert.equal(result[0], strongerBoundaryObservation, "the winner must not merge source evidence");
});

test("overlapping events with different known targets stay distinct", () => {
  const firstElimination = event();
  const secondElimination = event({
    id: "clip-a-segment-002-event-2",
    segmentId: "clip-a-segment-002",
    startMs: 11_000,
    endMs: 11_700,
    title: "Ace eliminates Kai",
    target: "Kai",
    confidence: 0.95,
  });
  assert.deepEqual(
    deduplicateOverlappingEvents([secondElimination, firstElimination]).map(({ id }) => id),
    [firstElimination.id, secondElimination.id],
  );
});

test("rapid unknown-target eliminations are not collapsed on actor identity alone", () => {
  const firstElimination = event({ target: null, title: "Enemy eliminated" });
  const secondElimination = event({
    id: "clip-a-segment-002-event-2",
    segmentId: "clip-a-segment-002",
    startMs: 11_050,
    endMs: 11_700,
    title: "Enemy eliminated",
    target: null,
    confidence: 0.95,
  });
  assert.deepEqual(
    deduplicateOverlappingEvents([secondElimination, firstElimination]).map(({ id }) => id),
    [firstElimination.id, secondElimination.id],
  );
});

test("confidence, importance, and source time deterministically break duplicate ties", () => {
  const earlier = event({ confidence: 0.9, importance: 90 });
  const laterLowerImportance = event({
    id: "clip-a-segment-002-event-1",
    segmentId: "clip-a-segment-002",
    confidence: 0.9,
    importance: 89,
  });
  assert.equal(deduplicateOverlappingEvents(
    [laterLowerImportance, earlier],
    { "clip-a-segment-001": 0, "clip-a-segment-002": 10_000 },
  )[0], earlier);

  const laterTie = { ...laterLowerImportance, importance: 90 };
  assert.equal(deduplicateOverlappingEvents(
    [laterTie, earlier],
    { "clip-a-segment-001": 0, "clip-a-segment-002": 10_000 },
  )[0], earlier);
});

test("segment dedup is completion-order independent and preserves winning provenance", () => {
  const weaker = event();
  const stronger = event({
    id: "clip-a-segment-002-event-1",
    segmentId: "clip-a-segment-002",
    confidence: 0.95,
  });
  const nearby = event({
    id: "clip-a-segment-002-event-2",
    segmentId: "clip-a-segment-002",
    startMs: 11_201,
    endMs: 11_700,
    target: "Kai",
    title: "Ace eliminates Kai",
  });
  const first = indexedSegment({ events: [weaker] });
  const second = indexedSegment({
    segmentId: "clip-a-segment-002",
    segmentStartMs: 10_000,
    segmentEndMs: 22_000,
    events: [stronger, nearby],
    api: { responseId: "response-2", requestId: "request-2" },
  });

  const forward = deduplicateOverlappingSegments([first, second]);
  const reverse = deduplicateOverlappingSegments([second, first]);
  const eventIds = (segments) => segments.flatMap((item) => item.events.map(({ id }) => id));
  assert.deepEqual(eventIds(forward), [stronger.id, nearby.id]);
  assert.deepEqual(eventIds(reverse), eventIds(forward));
  assert.equal(forward[1], second, "a segment that loses no event should remain unchanged");
  assert.equal(forward[1].events[0], stronger);
  assert.deepEqual(forward[0].events, []);
  assert.equal(forward[0].api, first.api, "non-event provenance must stay untouched");
});

test("duplicate responses for one segment resolve to the same complete version", () => {
  const weakerVersion = indexedSegment({
    events: [event({ confidence: 0.7 })],
    api: { responseId: "response-weaker", requestId: "request-weaker" },
  });
  const strongerEvent = event({ confidence: 0.91 });
  const strongerVersion = indexedSegment({
    events: [strongerEvent],
    api: { responseId: "response-stronger", requestId: "request-stronger" },
  });

  assert.equal(deduplicateOverlappingSegments([weakerVersion, strongerVersion])[0], strongerVersion);
  assert.equal(deduplicateOverlappingSegments([strongerVersion, weakerVersion])[0], strongerVersion);
  assert.equal(deduplicateOverlappingSegments([weakerVersion, strongerVersion])[0].events[0], strongerEvent);
});
