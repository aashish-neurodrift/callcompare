import path from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { detectAudioInfo, printAudioInfo } from "./audioInfo.js";
import { transcribeWithDeepgram } from "./providers/deepgram.js";
import { transcribeWithAssemblyAI } from "./providers/assemblyai.js";
import { transcribeWithSpeechmatics } from "./providers/speechmatics.js";
import { transcribeWithOpenAI } from "./providers/openai.js";
import { compareTranscripts } from "./compare.js";
import { writeTranscriptFile, writeComparisonReport, writeRawResponseFile } from "./report.js";
import { loadVocabulary } from "./vocabulary.js";
import { loadCorrections, applyCorrections } from "./corrections.js";
import type { TranscriptionResult } from "./types.js";

interface CliOptions {
  audioFile: string;
  outDir: string;
  deepgramRoles?: Map<string, string>;
  assemblyaiRoles?: Map<string, string>;
  speechmaticsRoles?: Map<string, string>;
  openaiRoles?: Map<string, string>;
  speakers: number;
  vocabTerms: string[];
  corrections: ReturnType<typeof loadCorrections>;
}

/**
 * Parses "A:Agent,B:Customer,C:IVR" into a Map of speaker letter -> role name.
 */
function parseRoleMap(value: string | undefined): Map<string, string> | undefined {
  if (!value) return undefined;
  const roles = new Map<string, string>();
  for (const pair of value.split(",")) {
    const [letter, ...roleParts] = pair.split(":");
    if (letter && roleParts.length > 0) {
      roles.set(letter.trim().toUpperCase(), roleParts.join(":").trim());
    }
  }
  return roles;
}

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  npm start -- <path-to-audio-file> [options]",
      "",
      "Options:",
      "  --out=<dir>                Base output directory; a subfolder named after the audio",
      "                             file is created inside it (default: ./output)",
      "  --deepgram-roles=<map>     Speaker letter -> role name, e.g. A:Agent,B:Customer,C:IVR",
      "  --assemblyai-roles=<map>   Same, for AssemblyAI's speaker letters",
      "  --speechmatics-roles=<map> Same, for Speechmatics' speaker letters",
      "  --openai-roles=<map>       Same, for OpenAI's speaker letters",
      "  --speakers=<n>             Expected speaker count, passed to AssemblyAI to sharpen",
      "                             diarization boundaries (default: 2, i.e. agent + customer)",
      "  --vocab=<terms>            Comma-separated domain terms (company/product/agent names,",
      "                             street names, ...) to boost recognition of, on every",
      "                             provider that supports it (Deepgram, AssemblyAI, Speechmatics)",
      "  --vocab-file=<path>        Same, loaded from a file (one term per line, # comments)",
      "  --corrections=<pairs>      Comma-separated from=>to find/replace pairs applied to every",
      "                             provider's output after transcription, e.g. 10Q=>Thank you",
      "  --corrections-file=<path>  Same, loaded from a file (one 'from=>to' pair per line)",
      "",
      "Example:",
      "  npm start -- ./audio/sample-call.wav \\",
      "    --deepgram-roles=A:Agent,B:Customer \\",
      "    --assemblyai-roles=A:Agent,B:Customer,C:IVR,D:Agent2 \\",
      "    --speechmatics-roles=A:Agent,B:Customer \\",
      "    --openai-roles=A:Agent,B:Customer",
    ].join("\n")
  );
}

function parseArgs(argv: string[]): CliOptions {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flags = new Map<string, string>();
  for (const a of argv) {
    if (a.startsWith("--")) {
      const body = a.slice(2);
      // Split on the first "=" only: flag values (like --corrections=from=>to) can
      // legitimately contain their own "=" characters.
      const eqIndex = body.indexOf("=");
      const key = eqIndex === -1 ? body : body.slice(0, eqIndex);
      const value = eqIndex === -1 ? "true" : body.slice(eqIndex + 1);
      flags.set(key, value);
    }
  }

  const audioFile = positional[0];
  if (!audioFile) {
    printUsage();
    process.exit(1);
  }

  return {
    audioFile: path.resolve(audioFile),
    outDir: path.resolve(flags.get("out") ?? "./output"),
    deepgramRoles: parseRoleMap(flags.get("deepgram-roles")),
    assemblyaiRoles: parseRoleMap(flags.get("assemblyai-roles")),
    speechmaticsRoles: parseRoleMap(flags.get("speechmatics-roles")),
    openaiRoles: parseRoleMap(flags.get("openai-roles")),
    speakers: Number(flags.get("speakers") ?? "2"),
    vocabTerms: loadVocabulary(flags.get("vocab"), flags.get("vocab-file")),
    corrections: loadCorrections(flags.get("corrections"), flags.get("corrections-file")),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  const callOutDir = path.join(options.outDir, path.basename(options.audioFile, path.extname(options.audioFile)));
  await mkdir(callOutDir, { recursive: true });

  console.log(`\nAnalyzing audio file: ${options.audioFile}\n`);
  const audioInfo = await detectAudioInfo(options.audioFile);
  printAudioInfo(audioInfo);

  console.log(
    "\nSending audio to Deepgram (nova-3), AssemblyAI (universal-3-pro/universal-2), " +
      "Speechmatics (enhanced), and OpenAI (gpt-4o-transcribe-diarize) concurrently...\n"
  );

  const providerNames = ["Deepgram", "AssemblyAI", "Speechmatics", "OpenAI"] as const;
  const settled = await Promise.allSettled([
    transcribeWithDeepgram(config.deepgramApiKey, audioInfo, options.vocabTerms),
    transcribeWithAssemblyAI(config.assemblyaiApiKey, audioInfo, options.speakers, options.vocabTerms),
    transcribeWithSpeechmatics(config.speechmaticsApiKey, audioInfo, options.vocabTerms),
    transcribeWithOpenAI(config.openaiApiKey, audioInfo),
  ]);

  let hadError = false;
  settled.forEach((result, i) => {
    if (result.status === "rejected") {
      console.error(`${providerNames[i]} transcription failed:`, (result.reason as Error)?.message ?? result.reason);
      hadError = true;
    }
  });
  if (hadError) {
    process.exit(1);
  }

  const rawResults = settled.map((r) => (r as PromiseFulfilledResult<TranscriptionResult>).value);
  const results = rawResults.map((r) => applyCorrections(r, options.corrections));

  for (const result of results) {
    console.log(`${result.provider} done in ${result.responseTimeMs} ms (${result.wordCount} words, ${result.speakerCount} speakers)`);
  }

  const rawOutPaths: string[] = [];
  for (const result of rawResults) {
    const rawPath = path.join(callOutDir, `${result.provider.toLowerCase()}_raw.json`);
    await writeRawResponseFile(rawPath, result);
    rawOutPaths.push(rawPath);
  }

  const rolesByProvider = new Map<string, Map<string, string>>([
    ["Deepgram", options.deepgramRoles ?? new Map()],
    ["AssemblyAI", options.assemblyaiRoles ?? new Map()],
    ["Speechmatics", options.speechmaticsRoles ?? new Map()],
    ["OpenAI", options.openaiRoles ?? new Map()],
  ]);

  const outPaths: string[] = [];
  for (const result of results) {
    const outPath = path.join(callOutDir, `${result.provider.toLowerCase()}_output.txt`);
    await writeTranscriptFile(outPath, result, rolesByProvider.get(result.provider));
    outPaths.push(outPath);
  }

  const comparison = compareTranscripts(results);
  const reportPath = path.join(callOutDir, "comparison_report.txt");
  await writeComparisonReport(reportPath, comparison, audioInfo, { rolesByProvider });

  console.log(`\nDone. Output files written to: ${callOutDir}`);
  for (const outPath of outPaths) {
    console.log(`  - ${outPath}`);
  }
  for (const rawPath of rawOutPaths) {
    console.log(`  - ${rawPath}`);
  }
  console.log(`  - ${reportPath}`);
}

main().catch((err) => {
  console.error("\nFatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
