/**
 * Builds the single consent scope used by deterministic Q&A and optional AI.
 * The helper is plain ESM so the exact permission rules are independently
 * testable without a browser or a TypeScript runtime.
 */
export function buildSessionConsentScope(session) {
  const participantBaseConsent = new Map(
    session.participants.map((participant) => [
      participant.id,
      participant.consent.gameplayRecording === "granted" &&
        participant.consent.aiAnalysis === "granted" &&
        participant.consent.squadSharing === "granted",
    ]),
  );
  const participantVoiceConsent = new Map(
    session.participants.map((participant) => [
      participant.id,
      participantBaseConsent.get(participant.id) === true &&
        participant.consent.voiceChat === "granted",
    ]),
  );
  const participantIds = [...participantBaseConsent.keys()];
  const permittedEvidenceIds = new Set();

  for (const evidence of session.evidence) {
    const usesVoice =
      evidence.type === "voice_transcript" ||
      evidence.type === "audio_reaction";
    const consentMap = usesVoice
      ? participantVoiceConsent
      : participantBaseConsent;
    const relevantParticipantIds = evidence.participantId
      ? [evidence.participantId]
      : participantIds;
    if (
      relevantParticipantIds.length > 0 &&
      relevantParticipantIds.every(
        (participantId) => consentMap.get(participantId) === true,
      )
    ) {
      permittedEvidenceIds.add(evidence.id);
    }
  }

  return {
    participantBaseConsent,
    participantVoiceConsent,
    permittedEvidenceIds,
    allSessionEvidencePermitted:
      permittedEvidenceIds.size === session.evidence.length,
  };
}
