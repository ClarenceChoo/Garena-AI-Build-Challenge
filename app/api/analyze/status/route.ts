export const runtime = "edge";

export async function GET(): Promise<Response> {
  const configured = Boolean(process.env.OPENAI_API_KEY?.trim());
  return Response.json(
    {
      configured,
      mode: configured ? "live_openai" : "unavailable",
      models: configured
        ? {
            vision: process.env.OPENAI_VISION_MODEL?.trim() || "gpt-5.6-sol",
            linking: process.env.OPENAI_LINKING_MODEL?.trim() || "gpt-5.6-sol",
            transcription:
              process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() ||
              "gpt-4o-mini-transcribe",
            search:
              process.env.OPENAI_SEARCH_MODEL?.trim() ||
              process.env.OPENAI_VISION_MODEL?.trim() ||
              "gpt-5.6-sol",
            searchTranscription:
              process.env.OPENAI_SEARCH_TRANSCRIPTION_MODEL?.trim() ||
              "whisper-1",
          }
        : null,
      scriptedFallback: false,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
