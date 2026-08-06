# UNSEEN

UNSEEN reconstructs a multiplayer match across the perspectives of an entire
squad. It aligns independently recorded viewpoints, connects actions with their
reactions and consequences, and turns the shared evidence into three outputs:

- a multi-perspective **Director's Cut**;
- a personalised **What You Missed** feed; and
- **Ask UNSEEN**, grounded session search with playable evidence.

This repository is the judge-facing proof of concept for the Garena AI Build
Challenge. Its primary workflow accepts two to four real local recordings,
extracts timestamped frames and optional opted-in audio in the browser, analyzes
each POV with OpenAI, and runs a second model pass that links evidence across
the squad. A clearly labeled three-player synthetic fixture remains as a stable
interaction benchmark; it is never presented as a live AI result.

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open the local URL printed by the development server.

The disclosed synthetic benchmark works without credentials. The live upload
workflow deliberately does not: it fails closed instead of substituting
prewritten output. To run real vision, transcription, and cross-clip linking:

```bash
cp .env.example .env.local
```

Add `OPENAI_API_KEY` to `.env.local`. Vision and linking default to
`gpt-5.6-sol`; audio defaults to `gpt-4o-mini-transcribe`.
Never expose the key to the browser or commit `.env.local`.

## Live AI flow

1. Export two to four matching squad POV clips, each 45 seconds or shorter.
2. Add them to the **Live multimodal pipeline** and label each perspective.
3. Confirm recording permission. Enable voice analysis only when everyone
   audible opted in.
4. Select **Analyze with OpenAI**. The browser samples eight timestamped JPEG
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

## Synthetic benchmark flow

The submission is zero-setup after the page loads: three complete synthetic POV
recordings and opted-in squad comms are already bundled. Every visible event,
HUD signal, voice line, reaction, synchronization anchor, citation, and edit cut
maps back to those exact files through `session.media`.

Recommended 90-second judge flow:

1. Preview any of the three **Preloaded squad inputs** at its evidence cue.
2. Select **Run disclosed synthetic benchmark** to replay the six-stage trace.
3. Play the Director's Cut and watch it switch among the source recordings.
4. Open Rin's top-ranked flank hold and click an evidence row to seek its exact
   source timestamp.
5. Switch to **What You Missed** to show Ace-only personalization.
6. Ask: “What were my teammates doing during my final clutch?” and open one of
   the answer citations.
7. End on the media-to-evidence trace: source frame, detector modalities,
   canonical timestamp, evidence ID, ranking, and edit decision.

The full flow fits comfortably within roughly two minutes. The fixture path is
intentional: it replays deterministic alignment, multimodal observations,
cross-perspective fusion, ranking, and edit planning over the bundled fictional
recordings. This is a precomputed submission analysis—not a claim that an
arbitrary recording was uploaded or analyzed live during the page request.

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

- `lib/unseen-openai.ts` owns live transcription, vision, structured output
  validation, cross-POV linking, and fail-closed OpenAI errors.
- `lib/real-analysis-types.ts` defines live upload, observation, provenance,
  alignment, story, and edit-decision contracts.
- `app/api/analyze/clip` and `app/api/analyze/link` are the live AI endpoints.
- `app/components/real-analysis-workbench.tsx` performs local media extraction
  and renders source-linked results.

- `lib/unseen-fixture.ts` is the canonical three-player session fixture.
- `lib/unseen-types.ts` defines session, evidence, moment, edit, and API contracts.
- `lib/unseen-pipeline.ts` contains alignment, scoring, and edit-plan logic.
- `lib/unseen-ai.ts` owns grounded answer generation and the optional Responses
  API integration.
- `app/api/demo/*` exposes fixture-backed session, processing, and question APIs.
- `app/components/unseen-experience.tsx` is the interactive product experience.

The model never receives authority to invent timestamps or manipulate video.
Its role is bounded to structured interpretation and concise, grounded language.
The evidence ledger and deterministic renderer remain the source of truth.

## Demo API

### `POST /api/analyze/clip`

Accepts one clip's metadata, two to eight timestamped JPEG samples, and an
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
`lib/unseen-fixture.ts`. The acceptance suite fails if the committed assets no
longer match that manifest.

## Privacy and safety defaults

- The hosted Site uses managed Sign in with ChatGPT and an owner-only access
  policy by default. Anonymous visitors cannot reach the application.
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

This version analyzes arbitrary browser-decodable short gameplay recordings.
It samples frames rather than uploading full video and relies on model vision
for HUD reading; it does not yet run dense frame-by-frame tracking, audio
fingerprinting, server-side FFmpeg, persistent media storage, or final MP4
rendering. The Director's Cut is an evidence-backed edit decision list with
click-to-seek source playback.

Production would additionally require authenticated session ownership,
viewer-scoped responses, working grant/revoke and delete controls, encrypted
short-lived media storage, and a complete deletion lineage. For any future demo
using real footage, obtain every squad member's permission and review the
selected game's recording, music, and sharing rules before distribution.
