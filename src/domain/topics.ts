/** Conversation topics and CEFR levels (whitelisted values; see prompts/CLAUDE.md). */

export const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type Level = (typeof LEVELS)[number];
export const DEFAULT_LEVEL: Level = "B1";
export const DEFAULT_TOPIC = "introducing yourself";
export const MAX_TOPIC_CHARS = 60;

// Suggested topics (phase 5 seeds lesson content for each in data/topics/*.yaml).
export const SUGGESTED_TOPICS: readonly string[] = [
  "introducing yourself",
  "job interview",
  "ordering at a restaurant",
  "travel",
  "shopping",
  "daily routine",
];

export function parseLevel(raw: string): Level | null {
  const value = raw.trim().toUpperCase();
  return (LEVELS as readonly string[]).includes(value) ? (value as Level) : null;
}

// Unicode-aware \w and \b (JS \b is ASCII-only, even with the u flag).
const W = String.raw`[\p{L}\p{N}_]`;
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const URL_RE = new RegExp(
  String.raw`(https?://|www\.)\S+|${B}[\p{L}\p{N}_-]+\.(com|net|org|br|io|ai|app)${B}\S*`,
  "giu",
);
const NOT_TOPIC_CHARS = /[^\p{L}\p{N}_\s'&,-]/gu; // keeps accented letters

function stripChars(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text.charAt(start))) start++;
  while (end > start && chars.includes(text.charAt(end - 1))) end--;
  return text.slice(start, end);
}

/** Free-text topic from /tema: letters/digits/spaces only, bounded, no URLs or markdown.
 * It is echoed in WhatsApp texts and still treated as untrusted inside prompts. */
export function cleanTopic(raw: string): string | null {
  const text = raw.replace(URL_RE, " ").replace(NOT_TOPIC_CHARS, " ").replaceAll("_", " ");
  const joined = text.split(/\s+/u).filter(Boolean).join(" ");
  const topic = stripChars(Array.from(joined).slice(0, MAX_TOPIC_CHARS).join(""), " ,'-&");
  if (/^[0-9]+$/.test(topic)) {
    const n = Number(topic);
    if (n >= 1 && n <= SUGGESTED_TOPICS.length) return SUGGESTED_TOPICS[n - 1] ?? null;
  }
  return topic.toLowerCase() || null;
}
