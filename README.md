# UNSEEN

UNSEEN reconstructs a multiplayer match across the perspectives of an entire
squad. It aligns independently recorded viewpoints, connects actions with their
reactions and consequences, and turns the shared evidence into three outputs:

- a multi-perspective **Director's Cut**;
- a personalised **What You Missed** feed; and
- **Ask UNSEEN**, grounded session search with playable evidence.

This repository is the judge-facing proof of concept for the Garena AI Build
Challenge. The experience is deliberately built around one high-quality,
three-player synthetic fixture so the product insight is obvious and the demo
is reliable. Every player name, quote, event, and POV clip in the fixture is
fictional; the repository contains no real player recording or voice data.

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open the local URL printed by the development server.

The prototype works without credentials. In that mode, analysis runs through a
deterministic evidence pipeline and answers use grounded fixture recipes. The
page visibly identifies this as a synthetic reconstruction. To exercise the optional
OpenAI Responses API path:

```bash
cp .env.example .env.local
```

Add `OPENAI_API_KEY` to `.env.local`. `OPENAI_MODEL` defaults to `gpt-5.6`.
Never expose the key to the browser or commit `.env.local`.

## Demo flow

The submission is zero-setup after the page loads: three complete synthetic POV
recordings and opted-in squad comms are already bundled. Every visible event,
HUD signal, voice line, reaction, synchronization anchor, citation, and edit cut
maps back to those exact files through `session.media`.

Recommended 90-second judge flow:

1. Preview any of the three **Preloaded squad inputs** at its evidence cue.
2. Select **Analyze demo session** to replay the six-stage media-analysis trace.
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

The current prototype separates deterministic evidence processing from model
judgment:

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
session and provenance contracts, non-cacheable demo APIs, staged reconstruction,
media fingerprints, audio/video tracks, source-to-shared timestamp mappings,
reasoning artifacts, the complete benchmark Q&A set, and invalid-input behavior.

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

This version proves the shared-story interaction and the evidence contracts. It
does not yet upload long recordings, run OCR or transcription over arbitrary
games, or execute FFmpeg in the hosted request path. Those production stages are
designed behind the same contracts and documented in `docs/AI_PIPELINE.md`.

Production would additionally require authenticated session ownership,
viewer-scoped responses, working grant/revoke and delete controls, encrypted
short-lived media storage, and a complete deletion lineage. For any future demo
using real footage, obtain every squad member's permission and review the
selected game's recording, music, and sharing rules before distribution.
