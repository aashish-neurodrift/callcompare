import { diffWords, type Change } from "diff";
import type { NormalizedUtterance, TranscriptionResult } from "./types.js";

export interface WordDiffEntry {
  type: "added" | "removed";
  text: string;
}

export interface DisagreementSegment {
  startSeconds: number;
  endSeconds: number;
  aText: string;
  bText: string;
  similarityPercent: number;
}

export interface PairwiseComparison {
  aProvider: string;
  bProvider: string;
  wordDiff: WordDiffEntry[];
  disagreementSegments: DisagreementSegment[];
}

export interface ComparisonResult {
  results: TranscriptionResult[];
  fastestProvider: string;
  pairwise: PairwiseComparison[];
}

/** Below this utterance-level similarity %, a segment is flagged as a significant disagreement. */
const SIGNIFICANT_DISAGREEMENT_THRESHOLD = 70;

function normalizeForDiff(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:"'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function computeWordDiff(a: string, b: string): WordDiffEntry[] {
  const changes: Change[] = diffWords(normalizeForDiff(a), normalizeForDiff(b));
  const entries: WordDiffEntry[] = [];
  for (const change of changes) {
    const text = change.value.trim();
    if (!text) continue;
    if (change.added) entries.push({ type: "added", text });
    if (change.removed) entries.push({ type: "removed", text });
  }
  return entries;
}

/** Percentage of words shared between two strings, based on a word-level diff. */
function similarityRatio(a: string, b: string): number {
  const na = normalizeForDiff(a);
  const nb = normalizeForDiff(b);
  if (na.length === 0 && nb.length === 0) return 100;

  const changes = diffWords(na, nb);
  let unchanged = 0;
  let total = 0;
  for (const change of changes) {
    const len = change.value.trim().split(/\s+/).filter(Boolean).length;
    total += len;
    if (!change.added && !change.removed) unchanged += len;
  }
  return total === 0 ? 100 : Math.round((unchanged / total) * 100);
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Concatenates the text of every utterance from `others` that time-overlaps `target`. */
function findOverlappingText(target: NormalizedUtterance, others: NormalizedUtterance[]): string {
  return others
    .filter((o) => overlaps(target.start, target.end, o.start, o.end))
    .map((o) => o.text)
    .join(" ");
}

/**
 * Builds one pairwise comparison: word-level diff on the overall transcript, and
 * utterance-by-utterance disagreement detection (aligning each provider's utterances by
 * timestamp overlap, since providers segment turns differently).
 */
function comparePair(a: TranscriptionResult, b: TranscriptionResult): PairwiseComparison {
  const wordDiff = computeWordDiff(a.fullText, b.fullText);

  const disagreementSegments: DisagreementSegment[] = [];
  for (const aUtt of a.utterances) {
    const matchedText = findOverlappingText(aUtt, b.utterances);
    if (!matchedText) continue;
    const similarity = similarityRatio(aUtt.text, matchedText);
    if (similarity < SIGNIFICANT_DISAGREEMENT_THRESHOLD) {
      disagreementSegments.push({
        startSeconds: aUtt.start,
        endSeconds: aUtt.end,
        aText: aUtt.text,
        bText: matchedText,
        similarityPercent: similarity,
      });
    }
  }

  return { aProvider: a.provider, bProvider: b.provider, wordDiff, disagreementSegments };
}

/**
 * Builds the full comparison across any number of providers: fastest response time, and
 * every pairwise word-level diff + disagreement segments (one pair per unique combination).
 */
export function compareTranscripts(results: TranscriptionResult[]): ComparisonResult {
  const fastestProvider = results.reduce((min, r) => (r.responseTimeMs < min.responseTimeMs ? r : min)).provider;

  const pairwise: PairwiseComparison[] = [];
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      pairwise.push(comparePair(results[i], results[j]));
    }
  }

  return { results, fastestProvider, pairwise };
}
