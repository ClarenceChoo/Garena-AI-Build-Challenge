# UNSEEN

UNSEEN searches long gameplay recordings and reconstructs multiplayer matches
across the perspectives of an entire squad. It turns source-bound evidence into
four outputs:

- natural-language **Gameplay Search** with exact playable citations;
- downloadable **30/60/90-second highlight reels**;
- a multi-perspective **Director's Cut**;
- a personalised **What You Missed** feed; and
- **Ask UNSEEN**, grounded session search with playable evidence.

This repository is the judge-facing proof of concept for the Garena AI Build
Challenge. Its default workflow accepts one to four local recordings totaling
up to 60 minutes and 2 GB, adaptively indexes selected frames, and searches a
temporary in-memory event ledger without uploading raw footage. It can compile
and render a source-audio highlight reel locally in current Chrome or Edge.
The secondary squad workflow accepts two to four real local recordings,
extracts timestamped frames and optional opted-in audio in the browser, analyzes
each POV with OpenAI, and runs a second model pass that links evidence across
the squad. Three preloaded real-footage clips from Garena's verified Free Fire
Esports channel provide a zero-upload demonstration. A separate, clearly
labeled three-player simulation remains only for private squad features that an
official broadcast cannot expose, such as synchronized personal POVs and comms.

## Contents

- [Run locally](#run-locally)
- [Gameplay Search and reel export](#gameplay-search-and-reel-export)
- [Live AI flow](#live-ai-flow)
- [Preloaded real-footage demo and interaction simulator](#preloaded-real-footage-demo-and-interaction-simulator)
- [Product architecture](#product-architecture)
- [Demo API](#demo-api)
- [Validation](#validation)
- [Privacy and safety defaults](#privacy-and-safety-defaults)
- [Prototype boundaries](#prototype-boundaries)
- [Submission evaluation guide](#submission-evaluation-guide)
- [Third-party libraries, models, data, and APIs](#third-party-libraries-models-data-and-apis)

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open the local URL printed by the development server.

The preloaded official-footage demo and disclosed interaction simulator work
without credentials. The live upload
workflow deliberately does not: it fails closed instead of substituting
prewritten output. To run real vision, transcription, and cross-clip linking:

```bash
cp .env.example .env.local
```

Add `OPENAI_API_KEY` to `.env.local`. Vision, linking, and gameplay search
default to `gpt-5.6-sol`; squad audio defaults to `gpt-4o-mini-transcribe`, and
long-gameplay transcript segments default to `whisper-1`.
Never expose the key to the browser or commit `.env.local`.

## Gameplay Search and reel export

1. Open the default **Gameplay Search** tab and add one to four videos totaling
   no more than 60 minutes and 2 GB.
2. Make the required audio declaration and confirm recording permission.
3. Select **Index footage with AI**. The browser scans low-resolution frames
   every two seconds, retains ten-second context, reacts to scene/HUD changes
   and audio-energy spikes, and sends at most 24 timestamped JPEGs per two-minute
   segment. Two segment requests run concurrently and one failed request is
   retried once.
4. Search naturally, for example “X kills Y,” “the final clutch,” or “the
   funniest reaction.” UNSEEN returns up to five ranked matches with source
   clip, exact range, confidence, frame/transcript IDs, and a two-second pre-roll
   playback action. Weak searches return `insufficient_evidence`.
5. Pin search results or ask AI to select varied indexed beats. Choose 30, 60,
   or 90 seconds and landscape or vertical. The deterministic browser renderer
   clamps every cut, preserves the full frame with blurred vertical fill, adds
   two-line evidence-based captions, and downloads H.264/AAC MP4 when supported
   or VP9/Opus WebM otherwise.

Raw videos stay behind local `File`/blob access. Only selected JPEG evidence,
numeric audio-energy features, and explicitly consented sub-25 MB audio chunks
reach the APIs. Voice is never transcribed without complete consent; exports
are muted when audible voices lack complete consent. The index exists only in
page memory and clears on reload. There is no D1 or R2 storage.

## GitHub automatic deployment

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) validates every push to `main` and can deploy the
production build to Cloudflare Workers. The existing `chatgpt.site` deployment
continues to be managed by OpenAI Sites; Sites does not currently expose a
GitHub Actions deployment hook.

Add these GitHub repository secrets under **Settings → Secrets and variables →
Actions** to activate the deploy step:

- `CLOUDFLARE_API_TOKEN` — a Workers Scripts edit token;
- `CLOUDFLARE_ACCOUNT_ID` — the target Cloudflare account;
- `OPENAI_API_KEY` — the server-only key used by the live analysis routes; and
- `UNSEEN_ALLOWED_EMAILS` — the comma-separated tester allowlist.

The Cloudflare Worker should be protected with Cloudflare Access. UNSEEN accepts
Cloudflare Access's authenticated-email header and still applies the same
`UNSEEN_ALLOWED_EMAILS` application allowlist. Without the four repository
secrets, GitHub Actions still runs the full validation suite but safely skips
the production deploy step.

## Live AI flow

1. Export two to four matching squad POV clips, each up to 3 minutes long.
2. Add them to the **Live multimodal pipeline** and label each perspective.
3. Confirm recording permission. Enable voice analysis only when everyone
   audible opted in.
4. Select **Analyze with OpenAI**. The browser samples sixteen timestamped JPEG
   frames per clip and, when allowed, extracts a mono WAV track.
5. `/api/analyze/clip` transcribes and visually analyzes each real source.
   Every observation must cite a supplied frame ID.
6. `/api/analyze/link` aligns and links the independently generated evidence,
   then returns the squad story and Director's Cut decision list.
7. The UI exposes OpenAI response IDs, request IDs, model names, token usage,
   source observations, and click-to-seek timestamps. Missing credentials or
   invalid model output remain visible failures; no fixture result is used.

Raw video files remain browser-local. Only sampled frames and the optional
consented audio excerpt are sent to the server and then to OpenAI. The routes
set `store: false` for Responses API requests and return `Cache-Control:
no-store`.

## Preloaded real-footage demo and interaction simulator

The submission is zero-setup after the page loads. Three 30-second clips are
embedded from the verified Free Fire Esports Official YouTube channel and come
from the same FFWS Global Finals 2025 Clash Squad final. They show the setup,
AG.DEW gameplay POV, and live team reaction around one real clutch.

Because an official broadcast does not publish synchronized private recordings
or private squad comms, the deeper squad-only product interactions remain a
separate labeled simulation. Every simulated event, HUD signal, voice line,
reaction, synchronization anchor, citation, and edit cut maps back to the local
simulation files through `session.media`.

Recommended 90-second judge flow:

1. Play any of the three **Preloaded real Garena footage** clips.
2. Select a clip and run its verified evidence scan.
3. Launch the clearly labeled multi-POV interaction simulator.
4. Play the Director's Cut and watch it switch among the simulated source recordings.
5. Open Rin's top-ranked flank hold and click an evidence row to seek its exact
   source timestamp.
6. Switch to **What You Missed** to show Ace-only personalization.
7. Ask: “What were my teammates doing during my final clutch?” and open one of
   the answer citations.
8. End on the media-to-evidence trace: source frame, detector modalities,
   canonical timestamp, evidence ID, ranking, and edit decision.

The full flow fits comfortably within roughly two minutes. The simulator is
intentional: it replays deterministic alignment, multimodal observations,
cross-perspective fusion, ranking, and edit planning over bundled fictional
recordings. It is never presented as analysis of the official footage or as a
claim that arbitrary media was uploaded during the page request.

---

## Product architecture

```text
three consented recordings
        |
        v
ingest -> align -> understand -> reconstruct -> direct
        |                     |
        |                     +-> ranked, evidence-backed moments
        v
shared event ledger
        |
        +-> Director's Cut
        +-> What You Missed
        +-> Ask UNSEEN
```

The product separates live multimodal inference from deterministic benchmark
evidence:

- [`lib/gameplay-search-client.ts`](lib/gameplay-search-client.ts) owns adaptive local sampling,
  consented audio chunking, codec selection, and deterministic local reel rendering.
- [`lib/gameplay-search-openai.ts`](lib/gameplay-search-openai.ts) owns strict gameplay indexing,
  search, transcription, highlight planning, evidence-ID validation, timestamp clamping, and fail-closed errors.
- [`lib/gameplay-search-types.ts`](lib/gameplay-search-types.ts) defines the shared index, event,
  search-hit, transcript, and highlight-plan contracts.
- [`app/api/analyze/index-segment`](app/api/analyze/index-segment), [`search`](app/api/analyze/search),
  [`highlights`](app/api/analyze/highlights), and [`transcribe`](app/api/analyze/transcribe) are the authenticated gameplay APIs.
- [`app/components/gameplay-search-workbench.tsx`](app/components/gameplay-search-workbench.tsx) is the
  default long-footage search and reel-export experience.
- [`lib/unseen-openai.ts`](lib/unseen-openai.ts) owns live transcription, vision, structured output
  validation, cross-POV linking, and fail-closed OpenAI errors.
- [`lib/real-analysis-types.ts`](lib/real-analysis-types.ts) defines live upload, observation, provenance,
  alignment, story, and edit-decision contracts.
- [`app/api/analyze/clip`](app/api/analyze/clip) and [`app/api/analyze/link`](app/api/analyze/link) are the live AI endpoints.
- [`app/components/real-analysis-workbench.tsx`](app/components/real-analysis-workbench.tsx) performs local media extraction
  and renders source-linked results.

- [`lib/unseen-fixture.ts`](lib/unseen-fixture.ts) is the canonical three-player session fixture.
- [`lib/unseen-types.ts`](lib/unseen-types.ts) defines session, evidence, moment, edit, and API contracts.
- [`lib/unseen-pipeline.ts`](lib/unseen-pipeline.ts) contains alignment, scoring, and edit-plan logic.
- [`lib/unseen-ai.ts`](lib/unseen-ai.ts) owns grounded answer generation and the optional Responses
  API integration.
- [`app/api/demo/*`](app/api/demo) exposes fixture-backed session, processing, and question APIs.
- [`app/components/unseen-experience.tsx`](app/components/unseen-experience.tsx) is the interactive product experience.

The model never receives authority to invent timestamps or manipulate video.
Its role is bounded to structured interpretation and concise, grounded language.
The evidence ledger and deterministic renderer remain the source of truth.

---

## Demo API

### `POST /api/analyze/index-segment`

Accepts one two-minute source segment with at most 24 timestamped JPEG evidence
frames, numeric audio features, optional consented transcript segments, and
prior detected context. It returns game-agnostic, evidence-linked
`GameplayEvent` records and real OpenAI request provenance.

### `POST /api/analyze/search`

Accepts a natural-language query plus the compact completed event index. It
returns at most five validated `GameplaySearchHit` records or an explicit
`insufficient_evidence` result. Unknown clip, segment, event, frame, or
transcript IDs are rejected.

### `POST /api/analyze/highlights`

Accepts a reel prompt, duration, aspect ratio, completed index, and optional
pinned event IDs. It returns a validated `HighlightPlan`; application code
clamps ranges to source duration, removes substantial overlaps, and enforces the
duration budget before any media is decoded.

### `POST /api/analyze/transcribe`

Accepts only multipart audio chunks under 25 MB with an explicit complete-voice-
consent assertion. It returns timestamped `whisper-1` transcript segments.

### `POST /api/analyze/clip`

Accepts one clip's metadata, two to sixteen timestamped JPEG samples, and an
optional consented WAV track. It returns a real model response trace plus
evidence-backed observations. It returns `AI_NOT_CONFIGURED` when the server
secret is absent.

### `POST /api/analyze/link`

Accepts two to four completed real clip analyses. Analyses without a non-empty
OpenAI response ID are rejected. The result includes inferred offsets with
confidence and basis, linked source observations, a squad recap, and an ordered
Director's Cut.

### `GET /api/demo/session`

Returns the complete consented squad fixture: participants, aligned recordings,
incidents, ranked moments, evidence, edit decisions, personal reveals, and
suggested questions.

### `POST /api/demo/process`

Advances one deterministic processing stage at a time.

```json
{ "sessionId": "unseen-demo-neon-district-0813", "cursor": 0 }
```

The response includes the current stage, total progress, stage states, output
counts, media-verification status, active detector modalities, observed evidence
IDs, and the next cursor. The final response has `complete: true`.

### `POST /api/demo/ask`

Answers a question only when session evidence can support it.

```json
{
  "sessionId": "unseen-demo-neon-district-0813",
  "viewerId": "ace",
  "question": "What were my teammates doing during my final clutch?"
}
```

Answers include confidence, grounding mode, and timestamped evidence citations.
Unsupported questions return a conservative abstention or a structured error.

### `GET /api/demo/reasoning`

Runs the deterministic reasoning core over the fixture and exposes the resulting
clock transforms, ranked moment score breakdowns, edit decision list,
personalised missed moments, and stage audit. This is the inspectable proof that
the product logic is more than a prewritten highlight reel.

## Validation

```bash
npm run build
npm test
```

The test suite verifies the production build, server-rendered product shell,
fail-closed live configuration, multimodal image/transcription request shape,
real response/request provenance, cross-clip source-link validation,
gameplay event citation validation, unknown-evidence rejection, consent-gated
transcription, insufficient-evidence semantics, and reel timestamp clamping,
non-cacheable routes, session and fixture contracts, media fingerprints,
source-to-shared mappings, reasoning artifacts, benchmark Q&A, and invalid
input behavior.

## Rebuilding the synthetic media

The committed MP4 files are the canonical submission inputs. On macOS with
FFmpeg installed, they can be rebuilt deterministically from the timed HUD,
visual-event, and synthetic voice assets:

```bash
./scripts/generate-demo-media.sh
```

After regeneration, update the manifest hashes and byte sizes in
[`lib/unseen-fixture.ts`](lib/unseen-fixture.ts). The acceptance suite fails if the committed assets no
longer match that manifest.

## Privacy and safety defaults

- The hosted Site uses managed Sign in with ChatGPT plus a server-side email
  allowlist. Anonymous and non-allowlisted visitors cannot reach the product.
- Live analysis, linking, and session-search endpoints independently require
  the authenticated Sites user headers before they can consume API credits.
- The account indicator exposes a safe same-origin sign-out link; the
  application never handles passwords, tokens, or OAuth callbacks itself.
- Gameplay recording, voice analysis, AI analysis, and squad sharing are modeled
  as separate consent grants in the synthetic fixture.
- Evidence is filtered at the source: gameplay evidence requires the three base
  grants, and voice-derived evidence additionally requires voice consent.
- Demo endpoints return only fictional data with `Cache-Control: no-store`; there
  is no upload bucket or real player-data store in this prototype.
- Model prompts use the evidence ledger, not raw unrelated conversation.
- Answers distinguish observation from inference and include citations.
- Missing or conflicting evidence results in abstention.
- The product describes observable mistakes without inferring malicious intent.

## Prototype boundaries

This version analyzes arbitrary browser-decodable short squad recordings and
long gameplay sessions. It relies on model vision for best-effort HUD reading
and does not run dense frame-by-frame tracking, player re-identification,
server-side FFmpeg, persistent media storage, or a persistent semantic index.
Local reel rendering is intentionally limited to codecs exposed by the current
browser; current Chrome and Edge are the supported demo targets.

Production would additionally require authenticated session ownership,
viewer-scoped responses, working grant/revoke and delete controls, encrypted
short-lived media storage, and a complete deletion lineage. For any future demo
using real footage, obtain every squad member's permission and review the
selected game's recording, music, and sharing rules before distribution.

---

## Submission evaluation guide

The recommended judging path is local. The preloaded official-footage opener and
the clearly disclosed interaction simulator run without credentials after
following [Run locally](#run-locally). A judge can optionally configure their own
server-side OpenAI key to exercise the live multimodal workflow.

The repository deliberately keeps these three evidence types distinct:

- **Real footage:** embedded excerpts from the verified Free Fire Esports
  Official YouTube channel.
- **Fictional simulation:** committed, synchronized squad recordings used to
  demonstrate private POVs and opted-in comms unavailable in a public broadcast.
- **Live AI output:** created only from clips uploaded during the current run
  after OpenAI is configured. Failed live runs never substitute fixture output.

### Challenge requirement mapping

| Case-brief requirement | Implemented evidence |
| --- | --- |
| Complete user interaction and outcome | [`app/components/unseen-experience.tsx`](app/components/unseen-experience.tsx) lets judges process a session, review source-linked moments, switch personalized views, and ask grounded questions. |
| Initial trigger or input | [`app/components/real-analysis-workbench.tsx`](app/components/real-analysis-workbench.tsx) accepts two to four clips, perspective labels, recording permission, and separate voice consent. |
| Models, tools, and APIs | [`lib/unseen-openai.ts`](lib/unseen-openai.ts) contains the OpenAI Responses and Audio Transcriptions API calls, structured prompts, schemas, provenance capture, and response validation. |
| Human review points | Users preview clips, confirm permissions, inspect model observations and response IDs, seek cited source timestamps, and review edit decisions. |
| Exception handling | [`app/api/analyze/*`](app/api/analyze) rejects invalid input, missing configuration, API failures, invalid structured output, and unsupported citations. Insufficient evidence produces abstention. |
| Final output or action | The product creates a Director's Cut decision list, personalized What You Missed moments, a squad recap, and grounded answers with playable citations. |
| Architecture overview | See [Product architecture](#product-architecture) and [`docs/AI_PIPELINE.md`](docs/AI_PIPELINE.md). |
| Prompts and model configuration | Live prompts and JSON schemas are in [`lib/unseen-openai.ts`](lib/unseen-openai.ts); grounded fixture Q&A instructions are in [`lib/unseen-ai.ts`](lib/unseen-ai.ts); model defaults are in [`.env.example`](.env.example). No autonomous agent framework is used. |
| Third-party disclosure | See [Third-party libraries, models, data, and APIs](#third-party-libraries-models-data-and-apis). |

## Third-party libraries, models, data, and APIs

### Direct libraries and tooling

| Component | Version | License | Use |
| --- | --- | --- | --- |
| Next.js | 16.2.6 | MIT | Application and route-handler framework |
| React / React DOM | 19.2.6 | MIT | Interactive user interface |
| vinext | 0.0.50 | MIT | Vite-based Next.js-compatible build and Cloudflare output |
| Vite | 8.0.13 | MIT | Build tooling |
| Tailwind CSS | 4.2.1 | MIT | Styling toolchain |
| Drizzle ORM | 0.45.2 | Apache-2.0 | Typed database scaffold; not required by the demo flow |
| TypeScript | 5.9.3 | Apache-2.0 | Type checking and development |
| ESLint | 9.39.4 | MIT | Static analysis |
| Wrangler | 4.92.0 | MIT OR Apache-2.0 | Optional Cloudflare Workers deployment |

Additional direct development dependencies and exact versions are disclosed in
[`package.json`](package.json); transitive dependency versions and integrity hashes are locked
in [`package-lock.json`](package-lock.json).

### Models and external APIs

| Component | Use | Data sent |
| --- | --- | --- |
| OpenAI Responses API | Structured vision observations, cross-POV linking, and grounded answers | Sampled JPEG frames, compact evidence, and optional transcript context |
| `gpt-5.6-sol` | Default live vision and linking model | Same as above |
| OpenAI Audio Transcriptions API | Optional opted-in speech transcription | Consented mono WAV excerpt |
| `gpt-4o-mini-transcribe` | Default transcription model | Consented mono WAV excerpt |
| `gpt-5.6` | Optional grounded language generation for the disclosed fixture | Consent-filtered evidence text |
| YouTube privacy-enhanced embed | Plays the official-footage opener | Standard embedded-player requests; the repository does not store the broadcast file |

### Media and datasets

- `public/demo/*.mp4` and `public/demo/*-poster.jpg` are fictional,
  locally generated three-player demo media.
- [`assets/demo/`](assets/demo) contains the timed subtitle and filter sources used to
  regenerate that media.
- [`lib/unseen-fixture.ts`](lib/unseen-fixture.ts) contains the disclosed fictional players, quotes,
  timestamps, consent records, anchors, observations, and expected events.
- No separately trained model, scraped dataset, biometric dataset, persistent
  upload store, or persistent real-player dataset is included.
- Third-party packages and services remain subject to their upstream licenses
  and terms. Real squad footage additionally requires participant permission and
  compliance with applicable game, music, privacy, and sharing rules.
