import { readFileSync } from "node:fs";
import { AssemblyAI } from "assemblyai";
import type { AudioInfo } from "../audioInfo.js";
import type { NormalizedUtterance, NormalizedWord, TranscriptionResult } from "../types.js";

/**
 * Transcribes the given audio file with AssemblyAI's Universal speech model.
 * Enables speaker_labels and punctuate. When the audio is stereo, multichannel is also
 * enabled so each channel is transcribed separately (useful for two-track call recordings).
 * `client.transcripts.transcribe()` submits the job and polls until it completes.
 * `vocabTerms` are passed as word_boost at max strength, which biases the model toward
 * recognizing those exact words/phrases (company/product names, agent names, etc.)
 * instead of phonetically similar but wrong words.
 */
export async function transcribeWithAssemblyAI(
  apiKey: string,
  audioInfo: AudioInfo,
  speakersExpected?: number,
  vocabTerms: string[] = []
): Promise<TranscriptionResult> {
  const client = new AssemblyAI({ apiKey });

  const started = Date.now();

  // Buffer, not a file path/stream: Node 24's undici throws "expected non-null body source"
  // when the SDK streams the upload internally from a path.
  const transcript = await client.transcripts.transcribe({
    audio: readFileSync(audioInfo.filePath),
    speech_models: ["universal-3-pro", "universal-2"],
    speaker_labels: true,
    // Telling the model how many speakers to expect measurably tightens speaker boundaries
    // (fewer mid-utterance mislabels) versus letting it infer the count from scratch.
    speakers_expected: speakersExpected,
    // Pinning the language avoids auto-detection ever drifting onto the wrong language
    // mid-call for accented or noisy speech.
    language_code: "en",
    punctuate: true,
    multichannel: audioInfo.isStereo ? true : undefined,
    word_boost: vocabTerms.length > 0 ? vocabTerms : undefined,
    boost_param: vocabTerms.length > 0 ? "high" : undefined,
  });

  const responseTimeMs = Date.now() - started;

  if (transcript.status === "error") {
    throw new Error(`AssemblyAI transcription failed: ${transcript.error ?? "unknown error"}`);
  }

  const fullText = transcript.text ?? "";
  const rawUtterances = transcript.utterances ?? [];

  const utterances: NormalizedUtterance[] = rawUtterances.map((u) => ({
    speaker: `Speaker ${u.speaker}`,
    text: u.text,
    start: u.start / 1000,
    end: u.end / 1000,
    confidence: u.confidence,
  }));

  const words: NormalizedWord[] = (transcript.words ?? []).map((w) => ({
    text: w.text,
    start: w.start / 1000,
    end: w.end / 1000,
    confidence: w.confidence,
    speaker: w.speaker ? `Speaker ${w.speaker}` : undefined,
  }));

  const speakerSet = new Set(utterances.map((u) => u.speaker));
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;

  return {
    provider: "AssemblyAI",
    model: transcript.speech_model_used ?? "universal",
    fullText,
    utterances,
    words,
    speakerCount: speakerSet.size,
    wordCount,
    avgConfidence: transcript.confidence ?? null,
    responseTimeMs,
    raw: transcript,
  };
}
