import {
  DEMO_SESSION,
  DEMO_SESSION_ID,
  formatSessionTimestamp,
} from "@/lib/unseen-fixture";
import { answerUnseenQuestion } from "@/lib/unseen-ai";
import { buildSessionConsentScope } from "@/lib/unseen-consent";
import type {
  ApiError,
  AskCitation,
  AskDemoRequest,
  AskDemoResponse,
  ParticipantId,
  SessionEvidence,
} from "@/lib/unseen-types";

export const runtime = "edge";

interface GroundedRecipe {
  answer: string;
  confidence: number;
  evidenceIds: string[];
  relatedMomentIds: string[];
  followUps: string[];
}

function errorResponse(
  status: number,
  code: ApiError["error"]["code"],
  message: string,
  details?: ApiError["error"]["details"],
): Response {
  return Response.json(
    { error: { code, message, ...(details ? { details } : {}) } } satisfies ApiError,
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<unknown> {
  const body = await request.text();
  if (!body.trim()) return {};
  return JSON.parse(body) as unknown;
}

function canonicalCitation(evidence: SessionEvidence): AskCitation {
  return {
    evidenceId: evidence.id,
    timestampMs: evidence.timestampMs,
    timestampLabel: formatSessionTimestamp(evidence.timestampMs),
    label: evidence.label,
    ...(evidence.participantId ? { participantId: evidence.participantId } : {}),
    ...(evidence.sourceId ? { sourceId: evidence.sourceId } : {}),
  };
}

function citationsFor(
  evidenceIds: string[],
  permittedEvidenceIds = buildSessionConsentScope(DEMO_SESSION).permittedEvidenceIds,
): AskCitation[] {
  const requested = new Set(evidenceIds);
  return DEMO_SESSION.evidence
    .filter(
      (evidence) =>
        requested.has(evidence.id) && permittedEvidenceIds.has(evidence.id),
    )
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .map(canonicalCitation);
}

function buildRecipe(question: string, viewerId: ParticipantId): GroundedRecipe | null {
  const normalized = question
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  if (
    normalized.includes("laugh") ||
    normalized.includes("round seven") ||
    normalized.includes("round 7") ||
    normalized.includes("flash")
  ) {
    return {
      answer:
        "At 8:40, Miko's flash clipped the closing door frame and bounced back into the squad. All three aligned views white out at 8:42. Miko then said, “That was meant for them. Nobody saw that, right?” — and the overlapping voice tracks show the squad's laughter peaking at 8:43. That rebound, not an enemy play, is why everyone started laughing in round seven.",
      confidence: 0.98,
      evidenceIds: [
        "ev-r7-flash-throw",
        "ev-r7-team-blind",
        "ev-r7-miko-voice",
        "ev-r7-laughter",
      ],
      relatedMomentIds: ["moment-round-seven"],
      followUps: [
        "Show the flash from all three perspectives.",
        "What was the squad's biggest reaction?",
      ],
    };
  }

  if (normalized.includes("smoke") || normalized.includes("sniper") || normalized.includes("140")) {
    return {
      answer:
        "At 10:07, Rin's smoke crossed the sniper lane just 140 milliseconds before the shot. Ace's view makes the peek look safe; Rin's aligned view reveals that the angle was lethal until the smoke landed. The cross-perspective timing is why UNSEEN classifies this as a save rather than ordinary utility.",
      confidence: 0.93,
      evidenceIds: ["ev-r10-save"],
      relatedMomentIds: ["moment-smoke-save"],
      followUps: [
        "What did Ace miss in that round?",
        "Which teammate action had the biggest unseen impact?",
      ],
    };
  }

  if (
    normalized.includes("flank") &&
    (normalized.includes("first") ||
      normalized.includes("noticed") ||
      normalized.includes("spot"))
  ) {
    return {
      answer:
        "Rin noticed the flank first. At 11:21, Rin's trip sensor revealed two enemies rotating behind the squad. At 11:23, Rin immediately called, “Two wrapping. Stay main — I've got it.” The aligned sources show that Ace and Miko were still facing the objective and could not see those enemies when Rin made the call.",
      confidence: 0.98,
      evidenceIds: ["ev-r13-flank-hud", "ev-r13-rin-call"],
      relatedMomentIds: ["moment-unseen-hold"],
      followUps: [
        "What did Rin do after the warning?",
        "Show me the flank from Rin's perspective.",
      ],
    };
  }

  if (
    (normalized.includes("secure") && normalized.includes("objective")) ||
    normalized.includes("helped us win the objective") ||
    normalized.includes("secured the objective")
  ) {
    return {
      answer:
        "Miko's utility-drawing sacrifice most directly helped secure the objective. At 11:29, Miko stepped into the crossfire and forced the last defender to spend both remaining charges. At 11:30, Miko called that the utility was gone, giving Ace the clear timing and route used to start the winning 1v2 at 11:34.",
      confidence: 0.96,
      evidenceIds: ["ev-r13-miko-draw", "ev-r13-miko-call", "ev-r13-ace-clutch"],
      relatedMomentIds: ["moment-unseen-hold"],
      followUps: [
        "What was Rin doing during that objective push?",
        "Show the opening from Miko's perspective.",
      ],
    };
  }

  if (
    normalized.includes("could not see") ||
    normalized.includes("couldnt see") ||
    normalized.includes("couldn t see") ||
    normalized.includes("from my perspective") ||
    normalized.includes("moment i missed")
  ) {
    if (viewerId === "rin") {
      return {
        answer:
          "After you fell holding the flank, you could not see Ace's finish. From 11:34, Ace used the time your delay created to isolate both defenders and complete the 1v2. The celebration at 11:41 is where the three voice tracks reconnect with the same outcome.",
        confidence: 0.97,
        evidenceIds: ["ev-r13-rin-hold", "ev-r13-ace-clutch", "ev-r13-reaction"],
        relatedMomentIds: ["moment-unseen-hold"],
        followUps: [
          "How did my flank hold change Ace's fights?",
          "Show Ace's final perspective.",
        ],
      };
    }

    return {
      answer:
        "At 11:24, Rin was fighting two flankers behind you while your view stayed on the objective. Rin eliminated one, critically damaged the other, and prevented a rear pinch. Your perspective contained only a brief kill-feed clue; Rin's aligned recording reveals the full hold you could not see.",
      confidence: 0.97,
      evidenceIds: [
        "ev-r13-flank-hud",
        "ev-r13-rin-call",
        "ev-r13-rin-hold",
        "ev-r13-feed",
      ],
      relatedMomentIds: ["moment-unseen-hold"],
      followUps: [
        "Who first noticed that flank?",
        "What happened immediately after Rin's hold?",
      ],
    };
  }

  if (
    normalized.includes("warn") ||
    normalized.includes("warning") ||
    normalized.includes("before i pushed") ||
    normalized.includes("before the push")
  ) {
    return {
      answer:
        "Yes. Rin warned the squad at 11:23, before Ace committed deeper to the A push: “Two wrapping. Stay main — I've got it.” Rin's sensor had identified the two-player flank at 11:21. It was both a warning and a decision call: keep pushing the objective while Rin contained the danger behind you.",
      confidence: 0.98,
      evidenceIds: ["ev-r13-flank-hud", "ev-r13-rin-call"],
      relatedMomentIds: ["moment-unseen-hold"],
      followUps: [
        "Did Rin stop the flank?",
        "What did I see when Rin made the call?",
      ],
    };
  }

  if (
    normalized.includes("miko") &&
    (normalized.includes("final") ||
      normalized.includes("clutch") ||
      normalized.includes("doing") ||
      normalized.includes("sacrifice"))
  ) {
    return {
      answer:
        "At 11:29, Miko stepped into the site crossfire and forced the last defender to spend both utility charges. At 11:30 Miko called, “Swing on me — last charge is gone.” That sacrifice created the clear route and timing Ace used to begin the winning 1v2 at 11:34.",
      confidence: 0.96,
      evidenceIds: ["ev-r13-miko-draw", "ev-r13-miko-call", "ev-r13-ace-clutch"],
      relatedMomentIds: ["moment-unseen-hold"],
      followUps: [
        "What was Rin doing at the same time?",
        "Show me the complete final-round sequence.",
      ],
    };
  }

  if (
    /(?:^| )rin(?: |$)/.test(normalized) &&
    (normalized.includes("final") ||
      normalized.includes("clutch") ||
      normalized.includes("doing") ||
      normalized.includes("impact"))
  ) {
    return {
      answer:
        "At 11:21, Rin's sensor caught two enemies wrapping behind the squad. Rin told Ace and Miko to stay on the main push, then held both flankers alone from 11:24: one was eliminated and the other left at critical health. Ace saw only a brief kill-feed update, but Rin's delay removed the pinch that would have collapsed the final clutch.",
      confidence: 0.97,
      evidenceIds: [
        "ev-r13-flank-hud",
        "ev-r13-rin-call",
        "ev-r13-rin-hold",
        "ev-r13-feed",
      ],
      relatedMomentIds: ["moment-unseen-hold"],
      followUps: [
        "What did Miko contribute to the clutch?",
        "Show the flank beside Ace's site entry.",
      ],
    };
  }

  if (
    normalized.includes("biggest") ||
    normalized.includes("most impact") ||
    normalized.includes("unseen impact") ||
    normalized.includes("decisive")
  ) {
    return {
      answer:
        "Rin's final-round flank hold had the largest unseen impact. The model scored it 0.97 for gameplay impact: at 11:21 Rin detected two rotators, told the squad to continue, then delayed both alone. That action prevented a rear pinch and turned Ace's finish into two isolated fights. Miko's utility-drawing sacrifice was the second hidden contribution.",
      confidence: 0.96,
      evidenceIds: [
        "ev-r13-flank-hud",
        "ev-r13-rin-call",
        "ev-r13-rin-hold",
        "ev-r13-miko-draw",
      ],
      relatedMomentIds: ["moment-unseen-hold"],
      followUps: [
        "How did Miko create Ace's opening?",
        "Show me Rin's perspective.",
      ],
    };
  }

  if (
    normalized.includes("failed plan") ||
    (normalized.includes("failed") && normalized.includes("winning play")) ||
    (normalized.includes("changed") && normalized.includes("winning"))
  ) {
    return {
      answer:
        "The failed round-seven plan relied on utility without a clean path: at 8:40 Miko's flash hit the door frame, returned, and blinded all three squad members. The winning play used short, evidence-driven handoffs across roles. Rin identified and contained the flank at 11:21–11:24; Miko confirmed the defender's last utility was gone at 11:30; Ace converted those advantages at 11:34. The change was not individual aim — it was shared information, role separation, and timing.",
      confidence: 0.97,
      evidenceIds: [
        "ev-r7-flash-throw",
        "ev-r7-team-blind",
        "ev-r13-flank-hud",
        "ev-r13-rin-call",
        "ev-r13-rin-hold",
        "ev-r13-miko-draw",
        "ev-r13-miko-call",
        "ev-r13-ace-clutch",
      ],
      relatedMomentIds: ["moment-round-seven", "moment-unseen-hold"],
      followUps: [
        "Show the failed plan and winning play side by side.",
        "Which call changed the final round?",
      ],
    };
  }

  const asksAboutFinalRound =
    normalized.includes("final") ||
    normalized.includes("clutch") ||
    normalized.includes("teammate") ||
    normalized.includes("last round") ||
    normalized.includes("winning play") ||
    normalized.includes("evidence") ||
    normalized.includes("proof");

  if (asksAboutFinalRound) {
    const viewerLead =
      viewerId === "ace"
        ? "While you were entering A and finishing the final clutch"
        : "During the final-round execute";
    return {
      answer: `${viewerLead}, two off-screen plays built the win. At 11:24 Rin held a two-player flank alone, stopping the squad from being pinched. At 11:29 Miko drew the defender's last utility and called that the final charge was gone. Ace then began the winning 1v2 at 11:34. The synced evidence shows a single squad play: Rin created time, Miko created space, and Ace converted both advantages.`,
      confidence: 0.98,
      evidenceIds: [
        "ev-r13-flank-hud",
        "ev-r13-rin-call",
        "ev-r13-rin-hold",
        "ev-r13-miko-draw",
        "ev-r13-miko-call",
        "ev-r13-ace-clutch",
        "ev-r13-reaction",
      ],
      relatedMomentIds: ["moment-unseen-hold"],
      followUps: [
        "Show me Rin's unseen flank hold.",
        "Why was Miko's sacrifice important?",
      ],
    };
  }

  if (normalized.includes("what happened") || normalized.includes("recap")) {
    return {
      answer:
        "The session's defining story was a three-part final-round play. Rin stopped a two-player flank at 11:24, Miko drew the last defensive utility at 11:29, and Ace converted the 1v2 from 11:34. The most emotional earlier moment came at 8:40, when Miko accidentally bounced a flash back into the squad and triggered round seven's biggest laugh.",
      confidence: 0.96,
      evidenceIds: [
        "ev-r7-flash-throw",
        "ev-r7-laughter",
        "ev-r13-rin-hold",
        "ev-r13-miko-draw",
        "ev-r13-ace-clutch",
      ],
      relatedMomentIds: ["moment-unseen-hold", "moment-round-seven"],
      followUps: [
        "What were my teammates doing during my final clutch?",
        "Why did everyone start laughing in round seven?",
      ],
    };
  }

  return null;
}

function createFallbackResponse(
  question: string,
  recipe: GroundedRecipe,
  permittedEvidenceIds: Set<string>,
): AskDemoResponse | null {
  if (recipe.evidenceIds.some((id) => !permittedEvidenceIds.has(id))) {
    return null;
  }
  return {
    sessionId: DEMO_SESSION_ID,
    question,
    answer: recipe.answer,
    confidence: recipe.confidence,
    grounding: "session_evidence",
    citations: citationsFor(recipe.evidenceIds, permittedEvidenceIds),
    relatedMomentIds: recipe.relatedMomentIds,
    followUps: recipe.followUps,
  };
}

function isGroundedAiResponse(value: unknown): value is AskDemoResponse {
  if (!isRecord(value)) return false;
  if (typeof value.answer !== "string" || value.answer.trim().length === 0) return false;
  if (typeof value.confidence !== "number" || value.confidence < 0 || value.confidence > 1) {
    return false;
  }
  if (!Array.isArray(value.citations) || value.citations.length === 0) return false;
  if (
    !Array.isArray(value.relatedMomentIds) ||
    !value.relatedMomentIds.every((momentId) => typeof momentId === "string")
  ) {
    return false;
  }
  if (
    !Array.isArray(value.followUps) ||
    !value.followUps.every((followUp) => typeof followUp === "string")
  ) {
    return false;
  }

  const knownEvidenceIds = new Set(DEMO_SESSION.evidence.map((evidence) => evidence.id));
  const knownMomentIds = new Set(DEMO_SESSION.moments.map((moment) => moment.id));
  return (
    value.relatedMomentIds.every((momentId) => knownMomentIds.has(momentId)) &&
    value.citations.every(
    (citation) =>
      isRecord(citation) &&
      typeof citation.evidenceId === "string" &&
      knownEvidenceIds.has(citation.evidenceId),
    )
  );
}

async function tryOptionalAiAnswer(
  question: string,
  viewerId: ParticipantId,
  fallback: AskDemoResponse,
): Promise<AskDemoResponse | null> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  try {
    const candidate = await answerUnseenQuestion({
      question,
      viewerId,
      session: DEMO_SESSION,
      fallback,
    }, {
      apiKey,
      model: process.env.OPENAI_MODEL?.trim() || "gpt-5.6",
    });
    if (!isGroundedAiResponse(candidate)) return null;
    if (candidate.citations.length < Math.min(2, fallback.citations.length)) {
      return null;
    }
    const fallbackEvidenceIds = new Set(
      fallback.citations.map((citation) => citation.evidenceId),
    );
    if (
      candidate.citations.some(
        (citation) => !fallbackEvidenceIds.has(citation.evidenceId),
      )
    ) {
      return null;
    }

    const citedEvidenceIds = candidate.citations.map((citation) => citation.evidenceId);
    return {
      ...candidate,
      sessionId: DEMO_SESSION_ID,
      question,
      grounding:
        candidate.grounding === "ai_with_session_evidence"
          ? "ai_with_session_evidence"
          : "session_evidence",
      citations: citationsFor(citedEvidenceIds),
    };
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  let rawPayload: unknown;

  try {
    rawPayload = await readJson(request);
  } catch {
    return errorResponse(400, "INVALID_JSON", "Request body must be valid JSON.");
  }

  if (!isRecord(rawPayload)) {
    return errorResponse(400, "INVALID_REQUEST", "Request body must be a JSON object.");
  }

  const payload = rawPayload as Partial<AskDemoRequest>;
  if (payload.sessionId !== undefined && typeof payload.sessionId !== "string") {
    return errorResponse(400, "INVALID_REQUEST", "sessionId must be a string.");
  }
  if (payload.sessionId && payload.sessionId !== DEMO_SESSION_ID) {
    return errorResponse(
      404,
      "SESSION_NOT_FOUND",
      `Demo session '${payload.sessionId}' was not found.`,
    );
  }
  if (typeof payload.question !== "string") {
    return errorResponse(400, "INVALID_REQUEST", "question is required and must be a string.");
  }

  const question = payload.question.trim();
  if (question.length < 3 || question.length > 280) {
    return errorResponse(
      400,
      "INVALID_REQUEST",
      "question must contain between 3 and 280 characters.",
      { minLength: 3, maxLength: 280 },
    );
  }

  const participantIds = new Set<string>(
    DEMO_SESSION.participants.map((participant) => participant.id),
  );
  if (payload.viewerId !== undefined && typeof payload.viewerId !== "string") {
    return errorResponse(400, "INVALID_REQUEST", "viewerId must be a string.");
  }
  if (payload.viewerId && !participantIds.has(payload.viewerId)) {
    return errorResponse(
      404,
      "PARTICIPANT_NOT_FOUND",
      `Participant '${payload.viewerId}' is not part of this demo session.`,
    );
  }

  const viewerId = (payload.viewerId ?? DEMO_SESSION.focusParticipantId) as ParticipantId;
  const consentScope = buildSessionConsentScope(DEMO_SESSION);
  if (consentScope.participantBaseConsent.get(viewerId) !== true) {
    return errorResponse(
      422,
      "QUESTION_NOT_GROUNDED",
      "I could not answer because this viewer's required session permissions are unavailable.",
    );
  }
  const recipe = buildRecipe(question, viewerId);
  if (!recipe) {
    return errorResponse(
      422,
      "QUESTION_NOT_GROUNDED",
      "I could not answer that from this session's evidence. Try asking about the final clutch, Rin, Miko, the round-seven laughter, or the smoke save.",
    );
  }

  const fallback = createFallbackResponse(
    question,
    recipe,
    consentScope.permittedEvidenceIds,
  );
  if (!fallback) {
    return errorResponse(
      422,
      "QUESTION_NOT_GROUNDED",
      "I could not answer because one or more required evidence grants are unavailable.",
    );
  }
  const aiAnswer = await tryOptionalAiAnswer(question, viewerId, fallback);

  return Response.json(aiAnswer ?? fallback, {
    headers: { "Cache-Control": "no-store" },
  });
}
