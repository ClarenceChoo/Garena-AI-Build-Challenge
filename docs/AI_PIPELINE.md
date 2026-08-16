# UNSEEN AI and media reasoning pipeline

This module reconstructs a squad session from facts extracted from multiple recordings. It is intentionally split from video decoding and rendering: AI proposes evidence-backed structure, while deterministic code owns timestamps, ranking, privacy gates, and the edit decision list.

## What is implemented

The default long-footage path is implemented in three bounded layers:

- `lib/gameplay-search-client.ts` uses Mediabunny random-access sources to scan
  low-resolution frames every two seconds, retain ten-second context, score
  visual/HUD change and local audio energy, and select at most 24 evidence
  images per two-minute segment. It also creates consented Opus chunks and
  renders validated highlight plans without loading the entire source into memory.
- `lib/gameplay-search-openai.ts` indexes a game-agnostic event ontology,
  searches the compact index, transcribes only consented voice, and proposes
  diverse reel beats through strict Structured Outputs with `store: false`.
- Authenticated `/api/analyze/index-segment`, `/search`, `/highlights`, and
  `/transcribe` routes reject unknown IDs, missing credentials, invalid consent,
  and upstream failures rather than substituting fixture output.

Every `GameplayEvent` preserves its source clip/segment, clamped time range,
readable actors, OCR, confidence, and frame/transcript evidence IDs. Search can
only return those event IDs. The deterministic highlight compiler can only use
known clips/events, clamps ranges to media duration, limits each beat to 12
seconds, removes substantial overlaps, and enforces the target duration. The
browser renderer never executes a model-generated media command.

`lib/unseen-ai.ts` exports edge-compatible primitives for:

- `alignRecordingsFromAnchors(tracks, options)` — fits an affine local-to-shared clock transform from audio, timer, visual-event, or manual anchors. It uses weighted least squares, deterministic median-absolute-deviation outlier rejection, and an offset-only fallback for implausible drift.
- `localToSharedMs` / `sharedToLocalMs` — reversible timestamp helpers.
- `scoreMoment(signals)` — returns an inspectable 0–100 score across gameplay importance, cross-perspective novelty, reaction strength, narrative value, and a redundancy penalty.
- `rankMomentCandidates(candidates, limit)` — diversity-aware greedy ranking with deterministic tie-breaking.
- `generateEditPlan(moments, options)` — generates evidence-linked source trims, perspective switches, captions, audio policy, transitions, and source/shared timestamps. It does **not** modify media.
- `retrieveGroundingEvidence` and `answerGroundedQuestionDeterministically` — consent-aware retrieval and an always-available grounded response/abstention path.
- `answerGroundedQuestion(input)` — optionally calls the OpenAI Responses API with a strict JSON schema and falls back safely if there is no key, network/API failure, refusal, invalid JSON, schema failure, or an invented evidence ID.
- `answerUnseenQuestion(input, openAI?)` — adapter used by the `/api/demo/ask` route. It returns the existing `AskDemoResponse` shape or `null` when the evidence is insufficient, allowing the route to use its curated fallback.

`lib/unseen-pipeline.ts` exports:

- `runUnseenReasoningPipeline(input, options)` — composes alignment, ranking, evidence indexing, and edit planning into one idempotent artifact.
- `buildWhatYouMissed(artifacts, playerId)` — selects moments where another permitted perspective materially changes what that player knew.
- `createPipelineInputFromDemoSession(session)` — explicitly adapts the bundled fixture into the same contracts expected from real extraction workers.

## Deterministic alignment

Every anchor has a recording-local timestamp and a canonical squad timestamp. For a source, the fitted clock is:

```text
shared_ms = rate × local_ms + offset_ms
drift_ppm = (rate - 1) × 1,000,000
```

Two or more well-spaced anchors allow drift estimation. One anchor yields offset only. With no anchors, the transform is identity and low confidence, so the product should ask for a manual matching point. Outlier removal is deterministic; there is no random RANSAC seed to make demos flaky.

Production extractors should contribute multiple independent anchor kinds:

1. shared audio fingerprints or announcer cues;
2. OCR game/round timers;
3. kill-feed, score-change, objective, or barrier-drop events;
4. an optional user-confirmed matching point.

## Moment scoring

All signal inputs are normalised to `0..1`. The score is:

```text
100 × (
  0.30 × gameplay_importance
  + 0.25 × cross_perspective_novelty
  + 0.20 × reaction_strength
  + 0.25 × narrative_value
  - 0.25 × redundancy_penalty
)
```

The greedy ranker recalculates redundancy after every selection using temporal overlap, text similarity, and actor overlap. That keeps five individually strong but near-identical detections from crowding out the shared story.

Reaction strength is a weak editorial signal, not a psychological diagnosis. It should come from observable laughter, cheering, vocal-energy change, or squad responses; the product must not label a player's internal emotional state as fact.

## OpenAI Responses API integration

No OpenAI npm package is required. The module calls `fetch` only when a server route explicitly passes an API key:

```ts
const answer = await answerGroundedQuestion({
  question,
  evidence,
  openAI: {
    apiKey: env.OPENAI_API_KEY,
    model: "gpt-5.6", // default; "gpt-5.6-terra" may also be configured
  },
});
```

The key must come from a server/Worker secret and must never be serialised into a page, client component, database row, fixture, log, or response. `fetchImpl` and `endpoint` are injectable for tests and controlled gateways.

The request uses the Responses API `text.format` JSON-schema form with `strict: true`. Every field is required and every object has `additionalProperties: false`. Application-side validation still enforces that cited evidence IDs are a subset of the permitted evidence sent to the model. A non-abstaining answer with no citation is rejected. The request sets `store: false`.

The default model is `gpt-5.6`, following current OpenAI guidance for new projects and Structured Outputs. See the official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs) and [Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create).

## Real uploads, official footage, and the interaction simulator

The browser upload path accepts two to four real clips up to three minutes each,
extracts sixteen timestamped frames and optional consented audio, sends those
samples to the live OpenAI routes, and cross-links only response-backed
observations. Raw video remains browser-local.

The zero-upload showcase embeds three real 30-second scenes from the verified
Free Fire Esports Official channel. They are different broadcast scenes around
one real clutch, not synchronized private squad recordings, and the UI says so.

The separate `DEMO_SESSION` is a wholly synthetic, curated artifact used only
to demonstrate features a public broadcast cannot expose: synchronized private
POVs, opted-in private comms, per-player reveals, and grounded squad search. Its
player names, media, quotes, timestamps, anchors, evidence, incidents, consent
records, and candidate moments are fictional. `createPipelineInputFromDemoSession`
transforms it and runs the same deterministic reasoning functions used for real
data.

In production, upstream workers would extend the browser samples with:

- canonical media proxies, sparse frames, dense event windows, and waveforms;
- OCR/timer observations and audio fingerprints;
- timestamped speech-to-text for opted-in voice only;
- conservative multimodal event observations with confidence and evidence IDs;
- fused incidents across sources.

Those workers should emit `AlignmentTrackInput`, `MomentCandidate`, and `EvidenceReference`. The reasoning code then remains unchanged.

## Privacy and safety boundary

- Evidence with `permitted: false` or `sensitivity: "blocked"` is removed before retrieval, model context, edit planning, and What You Missed output.
- The demo adapter requires gameplay-recording, AI-analysis, and squad-sharing consent for every evidence item. Voice transcripts and audio reactions additionally require voice-chat consent. Any missing or revoked grant excludes the affected source from reasoning, model context, edit planning, Q&A, and citations.
- Derived titles and summaries do not have field-level provenance in the prototype, so the pipeline fails closed: if any evidence supporting a moment is blocked or consent-withdrawn, that whole moment is omitted rather than exposing a possibly derived detail. Revoked actor perspectives and their alignment tracks are also removed.
- The model sees compact evidence text, not raw recordings. In production, minimise text further and use short-lived storage references.
- Grounded Q&A cites session evidence and abstains when the evidence is missing, weak, contradictory, blocked, or consent-revoked.
- When any session evidence is consent-restricted, the demo adapter suppresses unverified related-moment links and suggested follow-ups. If the remaining evidence cannot answer, it returns a consent-safe abstention rather than delegating to a richer fallback that may predate revocation.
- Prompts prohibit inferring intent, identity, or internal emotion. Deterministic fallbacks use only evidence text.
- No voiceprint, facial identity profile, synthetic speech, or fabricated footage is produced.
- Long-gameplay raw bytes remain behind browser-local `File`/blob access. Only
  selected JPEG frames, numeric audio features, and fully consented audio chunks
  under 25 MB reach the APIs. Game-only and fully consented sources may preserve
  original audio in local exports; incomplete voice consent forces muted output.
- The gameplay event index and rendered object URLs live in page memory only and
  clear on reload. No D1 or R2 store is attached to the Site.
- The public challenge endpoints serve only the wholly synthetic fixture and use `Cache-Control: no-store`; they are not an authenticated production data plane. Production must enforce session ownership and squad membership before every read, authorise responses to the specific viewer, re-check current grants at request and job-execution time, cancel/rebuild derived artifacts after revocation, and prevent caches or queued jobs from returning stale pre-revocation data. Deletion must cover raw media, derived frames/transcripts, embeddings/index entries, edit plans, and outputs using the same session lineage ID.

## Future FFmpeg integration

`generateEditPlan` is the contract for a separate trusted media worker. Each clip includes canonical and source-local in/out points, source ID, transition, caption, audio policy, and evidence IDs. A future worker can translate these decisions into an FFmpeg filter graph:

1. validate every source ID and clamp trims to probed media duration;
2. trim with source-local timestamps;
3. normalise frame rate, aspect ratio, resolution, and loudness;
4. apply hard cuts, short transitions, captions, and approved audio mixing;
5. render MP4/H.264 and persist an output-to-source lineage map;
6. never execute arbitrary model-generated shell text—the renderer must compile the typed plan through allow-listed operations.

Rendering should be retryable independently of AI analysis. The saved edit plan makes a failed encode cheap to replay and makes every final frame auditable back to source evidence.

## Current assumptions and limits

- Anchor timestamps use milliseconds and a single monotonic shared session clock.
- Capture drift is approximately linear within the short challenge session; long sessions may need piecewise transforms.
- Candidate feature values are already calibrated to `0..1` by upstream extractors or game adapters.
- Lexical evidence retrieval is sufficient for the curated demo. Production should add a session-scoped semantic index while retaining the same consent filters and evidence-ID validation.
- The edit plan estimates duration; audio overlaps, transition handles, and final encoder timing are resolved by the media worker.
- Grounded answers explain supported sequences, not hidden player intent or definitive causality.
- Long-footage sessions support 1–4 files, 60 minutes, and 2 GB combined. Game
  and mode detection are best-effort; unreadable identities remain unknown.
- Current Chrome and Edge are the supported reel-export browsers. The renderer
  prefers H.264/AAC MP4 after codec checks and falls back to VP9/Opus WebM.
