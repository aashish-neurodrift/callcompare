export interface NormalizedWord {
  text: string;
  start?: number; // seconds
  end?: number; // seconds
  confidence?: number;
  speaker?: string; // "Speaker A", "Speaker B", ...
}

export interface NormalizedUtterance {
  speaker: string; // "Speaker A", "Speaker B", "Channel 1", ...
  text: string;
  start: number; // seconds
  end: number; // seconds
  confidence?: number;
}

export interface TranscriptionResult {
  provider: "Deepgram" | "AssemblyAI" | "Speechmatics" | "OpenAI";
  model: string;
  fullText: string;
  utterances: NormalizedUtterance[];
  words: NormalizedWord[];
  speakerCount: number;
  wordCount: number;
  avgConfidence: number | null;
  responseTimeMs: number;
  /** Unmodified response body returned by the provider's API, before any normalization. */
  raw: unknown;
}
