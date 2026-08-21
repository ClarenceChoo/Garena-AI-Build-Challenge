export const GAMEPLAY_SEGMENT_WINDOWS = Object.freeze({
  normal: Object.freeze({ durationMs: 120_000, strideMs: 120_000 }),
  fast: Object.freeze({ durationMs: 12_000, strideMs: 10_000 }),
});

/**
 * Fast Demo is deliberately bounded so short judge sessions gain parallelism
 * without turning long recordings into hundreds of API calls.
 *
 * @param {number} combinedDurationMs
 * @param {boolean} fastDemoEnabled
 * @param {number} [maximumFastDurationMs]
 * @returns {keyof typeof GAMEPLAY_SEGMENT_WINDOWS}
 */
export function selectGameplaySegmentationMode(
  combinedDurationMs,
  fastDemoEnabled,
  maximumFastDurationMs = 120_000,
) {
  if (!Number.isSafeInteger(combinedDurationMs) || combinedDurationMs < 0) {
    throw new TypeError("Combined gameplay duration must be a non-negative integer.");
  }
  return fastDemoEnabled && combinedDurationMs <= maximumFastDurationMs ? "fast" : "normal";
}

/**
 * Create bounded, absolute clip windows without physically splitting media.
 * Normal mode preserves the existing two-minute segmentation. Fast mode starts
 * a twelve-second window every ten seconds, leaving two seconds of context on
 * both sides of each interior boundary.
 *
 * @param {number} durationMs
 * @param {keyof typeof GAMEPLAY_SEGMENT_WINDOWS} [mode]
 * @returns {{ startMs: number, endMs: number }[]}
 */
export function createSegmentWindows(durationMs, mode = "normal") {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new TypeError("Clip duration must be a positive integer number of milliseconds.");
  }
  const configuration = GAMEPLAY_SEGMENT_WINDOWS[mode];
  if (!configuration) throw new TypeError(`Unknown gameplay segmentation mode: ${String(mode)}.`);

  const windows = [];
  let coveredUntilMs = 0;
  for (let startMs = 0; startMs < durationMs; startMs += configuration.strideMs) {
    const endMs = Math.min(durationMs, startMs + configuration.durationMs);
    if (endMs <= coveredUntilMs) continue;
    windows.push({ startMs, endMs });
    coveredUntilMs = endMs;
  }
  return windows;
}

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

function normalizedIdentity(value) {
  return typeof value === "string"
    ? value.trim().toLocaleLowerCase().replace(/\s+/g, " ")
    : "";
}

function finiteNumber(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sourceStartForEvent(event, segmentStarts) {
  const value = segmentStarts instanceof Map
    ? segmentStarts.get(event.segmentId)
    : segmentStarts?.[event.segmentId];
  return finiteNumber(value, finiteNumber(event.startMs));
}

function compareEventPreference(a, b, segmentStarts) {
  return finiteNumber(b.confidence) - finiteNumber(a.confidence)
    || finiteNumber(b.importance) - finiteNumber(a.importance)
    || sourceStartForEvent(a, segmentStarts) - sourceStartForEvent(b, segmentStarts)
    || normalizedIdentity(a.segmentId).localeCompare(normalizedIdentity(b.segmentId))
    || finiteNumber(a.startMs) - finiteNumber(b.startMs)
    || finiteNumber(a.endMs) - finiteNumber(b.endMs)
    || normalizedIdentity(a.id).localeCompare(normalizedIdentity(b.id));
}

function compareEventsChronologically(a, b) {
  return normalizedIdentity(a.clipId).localeCompare(normalizedIdentity(b.clipId))
    || finiteNumber(a.startMs) - finiteNumber(b.startMs)
    || finiteNumber(a.endMs) - finiteNumber(b.endMs)
    || normalizedIdentity(a.type).localeCompare(normalizedIdentity(b.type))
    || normalizedIdentity(a.id).localeCompare(normalizedIdentity(b.id));
}

function eventsDescribeSameMoment(a, b) {
  if (
    normalizedIdentity(a.clipId) !== normalizedIdentity(b.clipId)
    || normalizedIdentity(a.type) !== normalizedIdentity(b.type)
  ) {
    return false;
  }
  const overlaps = Math.min(finiteNumber(a.endMs), finiteNumber(b.endMs))
    - Math.max(finiteNumber(a.startMs), finiteNumber(b.startMs)) >= 0;
  if (!overlaps) return false;

  const aTitle = normalizedIdentity(a.title);
  const bTitle = normalizedIdentity(b.title);
  const sameTitle = Boolean(aTitle && bTitle && aTitle === bTitle);
  const closelyAligned = Math.abs(finiteNumber(a.startMs) - finiteNumber(b.startMs)) <= 500;
  const aTarget = normalizedIdentity(a.target);
  const bTarget = normalizedIdentity(b.target);
  if (aTarget && bTarget && aTarget !== bTarget) return false;
  const sameTarget = Boolean(aTarget && bTarget && aTarget === bTarget);
  const aActors = new Set(Array.isArray(a.actors) ? a.actors.map(normalizedIdentity).filter(Boolean) : []);
  const actorOverlap = Array.isArray(b.actors)
    && b.actors.some((actor) => aActors.has(normalizedIdentity(actor)));
  return closelyAligned && (sameTitle || sameTarget || actorOverlap);
}

/**
 * Remove repeat observations produced by overlapping analysis windows. A
 * winner is selected as a whole record so its source segment and evidence
 * catalog remain valid. Results do not depend on completion/input order.
 *
 * Events are compared only when their time ranges overlap and their clip and
 * type match. The higher-confidence observation wins, followed by importance,
 * the earlier source window, and stable IDs.
 *
 * @template {{ id: string, clipId: string, segmentId: string, startMs: number, endMs: number, type: string, title?: string, actors?: string[], target?: string | null, confidence?: number, importance?: number }} Event
 * @param {readonly Event[]} events
 * @param {ReadonlyMap<string, number> | Record<string, number>} [segmentStarts]
 * @returns {Event[]}
 */
export function deduplicateOverlappingEvents(events, segmentStarts = new Map()) {
  const winners = [];
  const preferredFirst = [...events].sort((a, b) => compareEventPreference(a, b, segmentStarts));
  for (const candidate of preferredFirst) {
    if (!winners.some((winner) => eventsDescribeSameMoment(candidate, winner))) {
      winners.push(candidate);
    }
  }
  return winners.sort(compareEventsChronologically);
}

function compareSegmentsChronologically(a, b) {
  return normalizedIdentity(a.clipId).localeCompare(normalizedIdentity(b.clipId))
    || finiteNumber(a.segmentStartMs) - finiteNumber(b.segmentStartMs)
    || finiteNumber(a.segmentEndMs) - finiteNumber(b.segmentEndMs)
    || normalizedIdentity(a.segmentId).localeCompare(normalizedIdentity(b.segmentId));
}

function segmentVersionSignature(segment) {
  if (segment === null) return "null";
  if (Array.isArray(segment)) return `[${segment.map(segmentVersionSignature).join(",")}]`;
  if (typeof segment === "object") {
    return `{${Object.keys(segment).sort().map((key) => (
      `${JSON.stringify(key)}:${segmentVersionSignature(segment[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(segment) ?? String(segment);
}

function compareSegmentVersions(a, b) {
  const aEvents = Array.isArray(a.events) ? a.events : [];
  const bEvents = Array.isArray(b.events) ? b.events : [];
  const aBestConfidence = Math.max(0, ...aEvents.map((event) => finiteNumber(event.confidence)));
  const bBestConfidence = Math.max(0, ...bEvents.map((event) => finiteNumber(event.confidence)));
  const aBestImportance = Math.max(0, ...aEvents.map((event) => finiteNumber(event.importance)));
  const bBestImportance = Math.max(0, ...bEvents.map((event) => finiteNumber(event.importance)));
  return bBestConfidence - aBestConfidence
    || bBestImportance - aBestImportance
    || bEvents.length - aEvents.length
    || segmentVersionSignature(a).localeCompare(segmentVersionSignature(b));
}

/**
 * Canonicalize completed segment responses and remove cross-window event
 * duplicates. Duplicate responses for one source window resolve to one stable
 * version. Segments without removed events are returned by reference; segments
 * that lose an event are shallow-copied with every non-event field untouched.
 *
 * @template {{ clipId: string, segmentId: string, segmentStartMs: number, segmentEndMs: number, events: Array<{ id: string, clipId: string, segmentId: string, startMs: number, endMs: number, type: string, title?: string, actors?: string[], target?: string | null, confidence?: number, importance?: number }> }} Segment
 * @param {readonly Segment[]} segments
 * @returns {Segment[]}
 */
export function deduplicateOverlappingSegments(segments) {
  const canonicalBySource = new Map();
  for (const segment of segments) {
    const key = `${normalizedIdentity(segment.clipId)}\u0000${normalizedIdentity(segment.segmentId)}`;
    const current = canonicalBySource.get(key);
    if (!current || compareSegmentVersions(segment, current) < 0) {
      canonicalBySource.set(key, segment);
    }
  }

  const canonical = [...canonicalBySource.values()].sort(compareSegmentsChronologically);
  const segmentStarts = new Map(canonical.map((segment) => [segment.segmentId, segment.segmentStartMs]));
  const retainedEvents = new Set(deduplicateOverlappingEvents(
    canonical.flatMap((segment) => segment.events),
    segmentStarts,
  ));

  return canonical.map((segment) => {
    const events = segment.events.filter((event) => retainedEvents.has(event));
    return events.length === segment.events.length ? segment : { ...segment, events };
  });
}
