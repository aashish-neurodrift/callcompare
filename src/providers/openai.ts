import { readFileSync } from "node:fs";
import { basename } from "node:path";
import OpenAI, { toFile } from "openai";
import type { TranscriptionDiarized } from "openai/resources/audio/transcriptions.js";
import type { AudioInfo } from "../audioInfo.js";
import type { NormalizedUtterance, TranscriptionResult } from "../types.js";

/**
 * Transcribes the given audio file with OpenAI's gpt-4o-transcribe-diarize model.
 * Plain whisper-1 has no diarization at all (just one blob of text, no speaker labels),
 * so this uses OpenAI's newer diarization-capable transcription model instead, which
 * returns segments with real speaker labels comparable to the other providers.
 * The SDK's TypeScript overloads don't model `diarized_json` specifically, so the
 * response is cast to the documented diarized shape after a runtime shape check.
 * Unlike the other three providers, this model has no custom-vocabulary hook at all -
 * `prompt` is explicitly unsupported when using gpt-4o-transcribe-diarize - so it can't
 * be boosted toward domain-specific terms; the `--corrections` post-processing flag is
 * the only lever available for fixing its persistent mishearings.
 */
export async function transcribeWithOpenAI(apiKey: string, audioInfo: AudioInfo): Promise<TranscriptionResult> {
  const client = new OpenAI({ apiKey });

  const started = Date.now();

  const file = await toFile(readFileSync(audioInfo.filePath), basename(audioInfo.filePath));

  const response = (await client.audio.transcriptions.create({
    file,
    model: "gpt-4o-transcribe-diarize",
    response_format: "diarized_json",
    language: "en",
    // Required by the API for any input longer than 30 seconds.
    chunking_strategy: "auto",
  })) as unknown as TranscriptionDiarized;

  const responseTimeMs = Date.now() - started;

  if (!Array.isArray(response.segments)) {
    throw new Error("OpenAI returned an unexpected response shape (no diarized segments).");
  }

  const utterances: NormalizedUtterance[] = response.segments.map((s) => ({
    speaker: `Speaker ${s.speaker}`,
    text: s.text,
    start: s.start,
    end: s.end,
  }));

  const fullText = response.text;
  const speakerSet = new Set(utterances.map((u) => u.speaker));
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;

  return {
    provider: "OpenAI",
    model: "gpt-4o-transcribe-diarize",
    fullText,
    utterances,
    words: [], // diarized_json has no word-level timestamps/confidence
    speakerCount: speakerSet.size,
    wordCount,
    avgConfidence: null, // this model/format doesn't return per-word confidence scores
    responseTimeMs,
    raw: response,
  };
}
