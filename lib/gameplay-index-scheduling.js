/**
 * Split an indexing batch into a deterministic context-seed phase and the
 * remaining parallel work. A completed earliest segment already satisfies the
 * seed requirement, which keeps failed-segment retries fast.
 *
 * @template {{ id: string, clipId: string, startMs: number }} Job
 * @param {Job[]} work
 * @param {{ segmentId: string, clipId: string, segmentStartMs: number }[]} completed
 * @returns {{ seedJobs: Job[], parallelJobs: Job[] }}
 */
export function partitionSeedJobs(work, completed) {
  const earliestStartByClip = new Map();
  for (const segment of completed) {
    const current = earliestStartByClip.get(segment.clipId);
    if (current === undefined || segment.segmentStartMs < current) {
      earliestStartByClip.set(segment.clipId, segment.segmentStartMs);
    }
  }
  for (const job of work) {
    const current = earliestStartByClip.get(job.clipId);
    if (current === undefined || job.startMs < current) {
      earliestStartByClip.set(job.clipId, job.startMs);
    }
  }

  const completedSeeds = new Set(completed
    .filter((segment) => segment.segmentStartMs === earliestStartByClip.get(segment.clipId))
    .map((segment) => segment.clipId));
  const seedIdByClip = new Map();
  for (const job of [...work].sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id))) {
    if (
      !completedSeeds.has(job.clipId)
      && !seedIdByClip.has(job.clipId)
      && job.startMs === earliestStartByClip.get(job.clipId)
    ) {
      seedIdByClip.set(job.clipId, job.id);
    }
  }

  const seedJobs = [];
  const parallelJobs = [];
  for (const job of work) {
    (seedIdByClip.get(job.clipId) === job.id ? seedJobs : parallelJobs).push(job);
  }
  return { seedJobs, parallelJobs };
}

/**
 * Freeze one stable prior context per clip. Choosing the earliest indexed
 * segment makes the result independent of which of the parallel calls happened
 * to finish first.
 *
 * @param {{ segmentId: string, clipId: string, segmentStartMs: number, gameTitle: string, gameMode: string }[]} completed
 */
export function stablePriorContextByClip(completed) {
  const firstByClip = new Map();
  for (const segment of completed) {
    const current = firstByClip.get(segment.clipId);
    if (
      !current
      || segment.segmentStartMs < current.segmentStartMs
      || (
        segment.segmentStartMs === current.segmentStartMs
        && segment.segmentId.localeCompare(current.segmentId) < 0
      )
    ) {
      firstByClip.set(segment.clipId, segment);
    }
  }
  return new Map([...firstByClip].map(([clipId, segment]) => [clipId, {
    segmentStartMs: segment.segmentStartMs,
    gameTitle: segment.gameTitle,
    gameMode: segment.gameMode,
  }]));
}
