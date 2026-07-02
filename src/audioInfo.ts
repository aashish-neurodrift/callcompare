import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

const execFileAsync = promisify(execFile);

export interface AudioInfo {
  filePath: string;
  channels: number;
  channelLayout: string;
  sampleRate: number;
  durationSeconds: number;
  codec: string;
  isStereo: boolean;
}

interface FfprobeStream {
  codec_type: string;
  codec_name: string;
  channels: number;
  channel_layout?: string;
  sample_rate?: string;
}

interface FfprobeFormat {
  duration?: string;
}

interface FfprobeOutput {
  streams: FfprobeStream[];
  format: FfprobeFormat;
}

/**
 * Runs ffprobe (bundled static binary, no system ffmpeg install required) against the
 * given audio file and returns channel count / layout / sample rate / duration.
 */
export async function detectAudioInfo(filePath: string): Promise<AudioInfo> {
  const args = ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", filePath];

  let stdout: string;
  try {
    const result = await execFileAsync(ffprobeInstaller.path, args);
    stdout = result.stdout;
  } catch (err) {
    throw new Error(
      `ffprobe failed to analyze "${filePath}". Is the path correct and is it a valid audio file? ` +
        `Original error: ${(err as Error).message}`
    );
  }

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const audioStream = parsed.streams.find((s) => s.codec_type === "audio");

  if (!audioStream) {
    throw new Error(`No audio stream found in "${filePath}".`);
  }

  const channels = audioStream.channels;
  const durationSeconds = parseFloat(parsed.format.duration ?? "0");

  return {
    filePath,
    channels,
    channelLayout:
      audioStream.channel_layout ?? (channels === 1 ? "mono" : channels === 2 ? "stereo" : `${channels}ch`),
    sampleRate: parseInt(audioStream.sample_rate ?? "0", 10),
    durationSeconds,
    codec: audioStream.codec_name,
    isStereo: channels >= 2,
  };
}

export function printAudioInfo(info: AudioInfo): void {
  console.log("── Audio file info ──────────────────────────");
  console.log(`  File:        ${info.filePath}`);
  console.log(`  Codec:       ${info.codec}`);
  console.log(`  Channels:    ${info.channels} (${info.isStereo ? "STEREO" : "MONO"})`);
  console.log(`  Layout:      ${info.channelLayout}`);
  console.log(`  Sample rate: ${info.sampleRate} Hz`);
  console.log(`  Duration:    ${info.durationSeconds.toFixed(2)}s`);
  console.log("──────────────────────────────────────────────");
}
