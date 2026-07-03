import { writeFile } from "node:fs/promises";
import type { AudioInfo } from "./audioInfo.js";
import type { ComparisonResult } from "./compare.js";
import type { TranscriptionResult } from "./types.js";

export interface RoleMappingOptions {
  /** Provider name (e.g. "Deepgram") -> speaker letter -> role name. */
  rolesByProvider: Map<string, Map<string, string>>;
}

const COLUMN_WIDTH = 30;

function formatRoleMap(roles: Map<string, string>): string {
  return [...roles.entries()].map(([letter, role]) => `Speaker ${letter} => ${role}`).join(", ");
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

/** Renders a label followed by one value per provider column. */
function padRow(label: string, values: string[]): string {
  return (
    label.padEnd(20) +
    values.map((v, i) => (i === values.length - 1 ? v : v.padEnd(COLUMN_WIDTH))).join("")
  );
}

/**
 * Writes a turn-by-turn transcript file: "[start–end] Speaker A: text" per line.
 * If a roles map is supplied (speaker letter -> role name, e.g. A -> Agent, C -> IVR),
 * mapped speakers are relabeled and any speaker not in the map is left as "Speaker X"
 * (a manual, per-call mapping — providers' "Speaker A" labels are not guaranteed to
 * refer to the same person, and calls can have more than two speakers).
 */
export async function writeTranscriptFile(
  filePath: string,
  result: TranscriptionResult,
  roles?: Map<string, string>
): Promise<void> {
  const lines: string[] = [];
  lines.push(`# ${result.provider} transcript (model: ${result.model})`);
  lines.push(
    `# Response time: ${result.responseTimeMs} ms | Words: ${result.wordCount} | Speakers: ${result.speakerCount}` +
      (result.avgConfidence !== null ? ` | Avg. confidence: ${result.avgConfidence.toFixed(3)}` : "")
  );
  if (roles && roles.size > 0) {
    lines.push(`# Role mapping: ${formatRoleMap(roles)}`);
  }
  lines.push("");

  if (result.utterances.length === 0) {
    lines.push("(No utterances returned — diarization may have found only one speaker, or the audio is silent.)");
  }

  for (const u of result.utterances) {
    const letter = u.speaker.replace(/^Speaker /, "");
    const label = roles?.get(letter) ?? u.speaker;
    lines.push(`[${formatTime(u.start)}-${formatTime(u.end)}] ${label}: ${u.text}`);
  }

  await writeFile(filePath, lines.join("\n") + "\n", "utf-8");
}

/**
 * Writes the provider's raw, unmodified API response to disk as pretty-printed JSON —
 * exactly what came back over the wire, before diarization normalization, role mapping,
 * or --corrections are applied. Useful for debugging a provider-specific quirk or
 * re-deriving fields the normalized TranscriptionResult doesn't carry.
 */
export async function writeRawResponseFile(filePath: string, result: TranscriptionResult): Promise<void> {
  await writeFile(filePath, JSON.stringify(result.raw, null, 2) + "\n", "utf-8");
}

/**
 * Writes the side-by-side comparison_report.txt: summary stats, every pairwise word-level
 * diff, flagged disagreement segments per pair, speaker role mapping (if provided), and
 * caveats. Works across any number of providers (currently Deepgram, AssemblyAI, Speechmatics).
 */
export async function writeComparisonReport(
  filePath: string,
  comparison: ComparisonResult,
  audioInfo: AudioInfo,
  options: RoleMappingOptions
): Promise<void> {
  const { results, pairwise } = comparison;
  const bar = "=".repeat(70);
  const thin = "-".repeat(70);
  const lines: string[] = [];

  lines.push(bar);
  lines.push(`  ${results.map((r) => r.provider.toUpperCase()).join(" vs ")} - TRANSCRIPTION COMPARISON REPORT`);
  lines.push(bar);
  lines.push(`Generated:   ${new Date().toISOString()}`);
  lines.push(`Audio file:  ${audioInfo.filePath}`);
  lines.push(
    `Audio type:  ${audioInfo.isStereo ? "STEREO" : "MONO"} (${audioInfo.channels}ch, ${audioInfo.sampleRate}Hz, ` +
      `${audioInfo.durationSeconds.toFixed(1)}s, codec: ${audioInfo.codec})`
  );
  lines.push("");

  lines.push(thin);
  lines.push("SUMMARY");
  lines.push(thin);
  lines.push(padRow("", results.map((r) => `${r.provider} (${r.model})`)));
  lines.push(padRow("Response time", results.map((r) => `${r.responseTimeMs} ms`)));
  lines.push(padRow("Total words", results.map((r) => `${r.wordCount}`)));
  lines.push(padRow("Speakers detected", results.map((r) => `${r.speakerCount}`)));
  lines.push(padRow("Avg. confidence", results.map((r) => (r.avgConfidence !== null ? r.avgConfidence.toFixed(3) : "n/a"))));
  lines.push("");

  const byTime = [...results].sort((a, b) => a.responseTimeMs - b.responseTimeMs);
  const fastest = byTime[0];
  const slowest = byTime[byTime.length - 1];
  lines.push(
    fastest.responseTimeMs === slowest.responseTimeMs
      ? "Fastest tool: tie (identical response time)"
      : `Fastest tool: ${fastest.provider} (${slowest.responseTimeMs - fastest.responseTimeMs} ms faster than slowest: ${slowest.provider})`
  );
  lines.push("");

  for (const pair of pairwise) {
    lines.push(thin);
    lines.push(`WORD-LEVEL DIFFERENCES: ${pair.aProvider} vs ${pair.bProvider} (normalized: lowercase, punctuation stripped)`);
    lines.push(thin);
    const added = pair.wordDiff.filter((d) => d.type === "added").map((d) => d.text);
    const removed = pair.wordDiff.filter((d) => d.type === "removed").map((d) => d.text);
    if (added.length === 0 && removed.length === 0) {
      lines.push("No word-level differences found - transcripts match exactly after normalization.");
    } else {
      lines.push(`In ${pair.bProvider} but not ${pair.aProvider} (${added.length} segment(s)):`);
      lines.push(...(added.length ? added.map((t) => `  + "${t}"`) : ["  (none)"]));
      lines.push("");
      lines.push(`In ${pair.aProvider} but not ${pair.bProvider} (${removed.length} segment(s)):`);
      lines.push(...(removed.length ? removed.map((t) => `  - "${t}"`) : ["  (none)"]));
    }
    lines.push("");
  }

  for (const pair of pairwise) {
    lines.push(thin);
    lines.push(`SIGNIFICANT DISAGREEMENTS: ${pair.aProvider} vs ${pair.bProvider} (utterance-level similarity < 70%)`);
    lines.push(thin);
    if (pair.disagreementSegments.length === 0) {
      lines.push("No significant disagreements found - transcripts are highly consistent turn-by-turn.");
      lines.push("");
    } else {
      for (const seg of pair.disagreementSegments) {
        lines.push(`[${formatTime(seg.startSeconds)}-${formatTime(seg.endSeconds)}] similarity: ${seg.similarityPercent}%`);
        lines.push(`  ${pair.aProvider}: "${seg.aText}"`);
        lines.push(`  ${pair.bProvider}: "${seg.bText}"`);
        lines.push("");
      }
    }
  }

  lines.push(thin);
  lines.push("SPEAKER ROLE MAPPING");
  lines.push(thin);
  const anyRolesGiven = [...options.rolesByProvider.values()].some((m) => m.size > 0);
  if (anyRolesGiven) {
    for (const r of results) {
      const roles = options.rolesByProvider.get(r.provider);
      lines.push(`${r.provider}: ${roles?.size ? formatRoleMap(roles) : "(no mapping given)"}`);
    }
  } else {
    lines.push("No --deepgram-roles / --assemblyai-roles / --speechmatics-roles flag was passed, so");
    lines.push("speakers are left as Speaker A / Speaker B / etc. in the output files. Listen to the");
    lines.push("start of each provider's output file to identify who each letter is for this specific");
    lines.push("call, then re-run with e.g. --deepgram-roles=A:Agent,B:Customer,C:IVR to relabel.");
  }
  lines.push("");

  lines.push(thin);
  lines.push("NOTES");
  lines.push(thin);
  lines.push("- Speaker labels are assigned independently by each provider's diarization model.");
  lines.push('  "Speaker A" in one provider\'s file is not guaranteed to be the same physical person');
  lines.push('  as "Speaker A" in another provider\'s file - verify against the audio before assuming.');
  lines.push("- Word-level and disagreement diffs are computed on lowercased, punctuation-stripped");
  lines.push("  text, so formatting differences (casing, commas) are ignored; only wording differs.");
  lines.push("- Disagreement segments are found by aligning each provider's utterances to whichever");
  lines.push("  other provider's utterance(s) overlap it in time, then comparing the words spoken.");

  await writeFile(filePath, lines.join("\n") + "\n", "utf-8");
}
