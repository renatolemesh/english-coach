/** Search query from what the student said + the topic (never the raw text alone). */

// Only pure hesitations: "like", "so", "well" are real words too ("I like pizza").
const FILLERS = /\b(um+|uh+|erm*|hmm+|you know|i mean)\b/gi;
export const MAX_QUERY_CHARS = 400;

export function buildQuery(text: string, topic: string): string {
  const cleaned = text.replace(FILLERS, " ").split(/\s+/).filter(Boolean).join(" ");
  return [...`${topic}: ${cleaned}`].slice(0, MAX_QUERY_CHARS).join("");
}

/** OR-query for Postgres to_tsquery from free text (sanitized: letters only). */
export function ftsTerms(query: string): string {
  const words = [...new Set([...query.matchAll(/[A-Za-z]{3,}/g)].map((m) => m[0].toLowerCase()))];
  return words.slice(0, 24).join(" | ");
}
