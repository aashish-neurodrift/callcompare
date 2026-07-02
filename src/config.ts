import "dotenv/config";

export interface Config {
  deepgramApiKey: string;
  assemblyaiApiKey: string;
  speechmaticsApiKey: string;
  openaiApiKey: string;
}

/**
 * Loads and validates the API keys from environment variables (populated from .env).
 * Throws a clear error listing exactly which key(s) are missing.
 */
export function loadConfig(): Config {
  const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
  const assemblyaiApiKey = process.env.ASSEMBLYAI_API_KEY;
  const speechmaticsApiKey = process.env.SPEECHMATIC_API_KEY;
  const openaiApiKey = process.env.WHISPER_API_KEY;

  const missing: string[] = [];
  if (!deepgramApiKey) missing.push("DEEPGRAM_API_KEY");
  if (!assemblyaiApiKey) missing.push("ASSEMBLYAI_API_KEY");
  if (!speechmaticsApiKey) missing.push("SPEECHMATIC_API_KEY");
  if (!openaiApiKey) missing.push("WHISPER_API_KEY");

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}.\n` +
        `Create a .env file in the project root (copy .env.example) and set these keys.`
    );
  }

  return {
    deepgramApiKey: deepgramApiKey as string,
    assemblyaiApiKey: assemblyaiApiKey as string,
    speechmaticsApiKey: speechmaticsApiKey as string,
    openaiApiKey: openaiApiKey as string,
  };
}
