import { readFileSync } from "node:fs";
import type { TranscriptionResult } from "./types.js";

export interface Correction {
  from: string;
  to: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the find/replace correction list, used as a universal fallback for providers
 * that don't support native vocabulary boosting (OpenAI's gpt-4o-transcribe-diarize has
 * no prompt/vocab hook at all) and to clean up persistent mishearings any provider makes
 * despite boosting (e.g. "10Q" -> "Thank you", "youtube.com" -> "xfinity.com").
 * Inline pairs use "from=>to"; the file format is the same, one pair per line, "#" comments.
 */
export function loadCorrections(inlineValue?: string, filePath?: string): Correction[] {
  const corrections: Correction[] = [];

  const parseLine = (line: string) => {
    const [from, ...toParts] = line.split("=>");
    if (from && toParts.length > 0) {
      corrections.push({ from: from.trim(), to: toParts.join("=>").trim() });
    }
  };

  if (inlineValue) {
    for (const pair of inlineValue.split(",")) parseLine(pair);
  }

  if (filePath) {
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) parseLine(trimmed);
    }
  }

  return corrections;
}

/**
 * Applies every correction as a whole-word, case-insensitive replacement across a
 * transcription result's full text and utterance text.
 */
export function applyCorrections(result: TranscriptionResult, corrections: Correction[]): TranscriptionResult {
  if (corrections.length === 0) return result;

  const apply = (text: string): string =>
    corrections.reduce(
      (acc, c) => acc.replace(new RegExp(`\\b${escapeRegExp(c.from)}\\b`, "gi"), c.to),
      text
    );

  const fullText = apply(result.fullText);

  return {
    ...result,
    fullText,
    utterances: result.utterances.map((u) => ({ ...u, text: apply(u.text) })),
    // Recomputed since a correction can change the word count (e.g. "10Q" -> "Thank you").
    wordCount: fullText.split(/\s+/).filter(Boolean).length,
  };
}
