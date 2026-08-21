import assert from "node:assert/strict";
import test from "node:test";
import {
  partitionSeedJobs,
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
