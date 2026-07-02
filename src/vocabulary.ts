import { readFileSync } from "node:fs";

/**
 * Builds the custom-vocabulary term list used to boost recognition of domain-specific
 * words (company/product names, agent names, street names, etc.) that generic models
 * tend to mishear. Terms can come from an inline comma-separated flag and/or a text file
 * (one term per line, "#" starts a comment); both sources are merged and de-duplicated.
 */
export function loadVocabulary(inlineValue?: string, filePath?: string): string[] {
  const terms = new Set<string>();

  if (inlineValue) {
    for (const term of inlineValue.split(",")) {
      const trimmed = term.trim();
      if (trimmed) terms.add(trimmed);
    }
  }

  if (filePath) {
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) terms.add(trimmed);
    }
  }

  return [...terms];
}
