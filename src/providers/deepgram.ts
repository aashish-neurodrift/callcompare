import { readFileSync } from "node:fs";
import { DeepgramClient } from "@deepgram/sdk";
import type { AudioInfo } from "../audioInfo.js";
import type { NormalizedUtterance, NormalizedWord, TranscriptionResult } from "../types.js";

const SPEAKER_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function speakerLabel(speakerIndex: number): string {
  return `Speaker ${SPEAKER_LETTERS[speakerIndex] ?? speakerIndex}`;
}

/**
 * Transcribes the given audio file with Deepgram's Nova-3 model.
 * Enables diarize, punctuate, smart_format and utterances (which is what gives us clean,
 * turn-by-turn "who said what" segments with a speaker label already attached).
 * When the audio is stereo, multichannel is also enabled per-request.
 * `vocabTerms` (company/product names, agent names, street names, ...) are passed as
 * key term prompting, which biases the model toward recognizing those exact terms
 * instead of phonetically similar but wrong words.
 */
export async function transcribeWithDeepgram(
  apiKey: string,
  audioInfo: AudioInfo,
  vocabTerms: string[] = []
): Promise<TranscriptionResult> {
  const client = new DeepgramClient({ apiKey });

  const started = Date.now();

  // Buffer, not a stream: Node 24's undici throws "expected non-null body source"
  // when a fs.ReadStream is used as the fetch body for this SDK's upload call.
  const response = await client.listen.v1.media.transcribeFile(readFileSync(audioInfo.filePath), {
    model: "nova-3",
    // diarize_model supersedes the deprecated diarize:true flag and lets us pin the more
    // accurate v2 diarization model instead of whatever the implicit default is.
    diarize_model: "v2",
    language: "en",
    punctuate: true,
    smart_format: true,
    // Converts spoken numbers to digits (addresses, account numbers) for consistency
    // with how the other providers format numerals.
    numerals: true,
    utterances: true,
    multichannel: audioInfo.isStereo ? true : undefined,
    keyterm: vocabTerms.length > 0 ? vocabTerms : undefined,
  });

  const responseTimeMs = Date.now() - started;

  if (!("results" in response)) {
    // The SDK's response type is a union with an "accepted" (async/callback) shape.
    // transcribeFile against Deepgram's synchronous REST endpoint should always return
    // the full `results` payload, but we guard against the union anyway.
    throw new Error(
      "Deepgram returned an accepted/async response instead of a synchronous transcript. " +
        "This tool expects synchronous (non-callback) transcription."
    );
  }

  const alternative = response.results.channels[0]?.alternatives?.[0];
  const fullText = alternative?.transcript ?? "";

  const rawUtterances = response.results.utterances ?? [];

  const utterances: NormalizedUtterance[] = rawUtterances.map((u) => ({
    speaker:
      u.speaker !== undefined
        ? speakerLabel(u.speaker)
        : u.channel !== undefined
          ? `Channel ${u.channel + 1}`
          : "Speaker A",
    text: u.transcript ?? "",
    start: u.start ?? 0,
    end: u.end ?? 0,
    confidence: u.confidence,
  }));

  const words: NormalizedWord[] = rawUtterances.flatMap((u) =>
    (u.words ?? []).map((w) => ({
      text: w.punctuated_word ?? w.word ?? "",
      start: w.start,
      end: w.end,
      confidence: w.confidence,
      speaker: w.speaker !== undefined ? speakerLabel(w.speaker) : undefined,
    }))
  );

  const speakerSet = new Set(utterances.map((u) => u.speaker));
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;

  const wordConfidences = words
    .map((w) => w.confidence)
    .filter((c): c is number => typeof c === "number");
  const avgConfidence =
    wordConfidences.length > 0
      ? wordConfidences.reduce((a, b) => a + b, 0) / wordConfidences.length
      : (alternative?.confidence ?? null);

  return {
    provider: "Deepgram",
    model: "nova-3",
    fullText,
    utterances,
    words,
    speakerCount: speakerSet.size,
    wordCount,
    avgConfidence,
    responseTimeMs,
  };
}
