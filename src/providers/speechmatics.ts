import { BatchClient, type RecognitionResult } from "@speechmatics/batch-client";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { AudioInfo } from "../audioInfo.js";
import type { NormalizedUtterance, NormalizedWord, TranscriptionResult } from "../types.js";

const SPEAKER_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Speechmatics labels speakers "S1", "S2", ... - map to the same "Speaker A"/"B" scheme
 *  used by the other providers so relabeling flags work the same way everywhere. */
function speakerLabel(speechmaticsSpeaker: string | undefined): string {
  const match = speechmaticsSpeaker?.match(/^S(\d+)$/);
  if (!match) return "Speaker A";
  const index = Number(match[1]) - 1;
  return `Speaker ${SPEAKER_LETTERS[index] ?? speechmaticsSpeaker}`;
}

/**
 * Transcribes the given audio file with Speechmatics' enhanced model (its highest-accuracy
 * tier for single-language audio; melia-1 is only better for multilingual/code-switching
 * audio, not relevant here).
 * Speechmatics returns a flat array of word/punctuation items (not pre-grouped turns like
 * Deepgram/AssemblyAI), so utterances are built here by grouping consecutive items spoken
 * by the same speaker.
 * `vocabTerms` are passed as additional_vocab, which biases the model toward recognizing
 * those exact words/phrases (company/product names, agent names, etc.) instead of
 * phonetically similar but wrong words.
 */
export async function transcribeWithSpeechmatics(
  apiKey: string,
  audioInfo: AudioInfo,
  vocabTerms: string[] = []
): Promise<TranscriptionResult> {
  const client = new BatchClient({ apiKey, appId: "callcompare" });

  const started = Date.now();

  // Blob, not a stream/path: Node 24's undici throws "expected non-null body source"
  // when a Node ReadStream is used as the fetch body, so we hand it a fully-buffered Blob.
  const audioBlob = new Blob([readFileSync(audioInfo.filePath)]);

  const response = await client.transcribe(
    { data: audioBlob, fileName: basename(audioInfo.filePath) },
    {
      transcription_config: {
        language: "en",
        model: "enhanced",
        diarization: "speaker",
        additional_vocab: vocabTerms.length > 0 ? vocabTerms.map((content) => ({ content })) : undefined,
      },
    },
    "json-v2"
  );

  const responseTimeMs = Date.now() - started;

  if (typeof response === "string") {
    throw new Error("Speechmatics returned a non-JSON response; expected json-v2 format.");
  }

  const items = response.results ?? [];

  const utterances: NormalizedUtterance[] = [];
  let current: NormalizedUtterance | null = null;

  for (const item of items) {
    const alt = item.alternatives?.[0];
    if (!alt) continue;
    const speaker = speakerLabel(alt.speaker);
    const attachesToPrevious = item.attaches_to === "previous";

    if (current && current.speaker === speaker) {
      current.text += attachesToPrevious ? alt.content : ` ${alt.content}`;
      current.end = item.end_time;
    } else {
      if (current) utterances.push(current);
      current = { speaker, text: alt.content, start: item.start_time, end: item.end_time, confidence: alt.confidence };
    }
  }
  if (current) utterances.push(current);

  const words: NormalizedWord[] = items
    .filter((item: RecognitionResult) => item.type === "word")
    .map((item) => {
      const alt = item.alternatives?.[0];
      return {
        text: alt?.content ?? "",
        start: item.start_time,
        end: item.end_time,
        confidence: alt?.confidence,
        speaker: speakerLabel(alt?.speaker),
      };
    });

  const fullText = utterances.map((u) => u.text).join(" ");
  const speakerSet = new Set(utterances.map((u) => u.speaker));
  const wordCount = words.length;

  const wordConfidences = words
    .map((w) => w.confidence)
    .filter((c): c is number => typeof c === "number");
  const avgConfidence =
    wordConfidences.length > 0 ? wordConfidences.reduce((a, b) => a + b, 0) / wordConfidences.length : null;

  return {
    provider: "Speechmatics",
    model: "enhanced",
    fullText,
    utterances,
    words,
    speakerCount: speakerSet.size,
    wordCount,
    avgConfidence,
    responseTimeMs,
  };
}
