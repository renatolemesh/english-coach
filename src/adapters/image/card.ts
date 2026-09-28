/**
 * Evaluation -> HTML (pure, testable without a browser). Student/model text is escaped by
 * Nunjucks autoescape; the only raw HTML is built here from escaped pieces (highlightMistakes).
 * Template: templates/evaluation.njk (Nunjucks).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import nunjucks from "nunjucks";
import type { Evaluation } from "../../domain/evaluation.js";

const ELLIPSIS_RE = /\s*(?:\.\.\.|…)\s*/;

// The card is in English like the feedback on it: the student stays immersed.
export const MISTAKE_TYPE_LABEL: Record<string, string> = {
  grammar: "grammar",
  vocabulary: "vocabulary",
  word_choice: "word choice",
  pronunciation: "pronunciation",
  other: "other",
  unclear: "unclear",
};
export const BREAKDOWN_LABEL: Record<string, string> = {
  grammar: "Grammar",
  vocabulary: "Vocabulary",
  fluency: "Fluency",
  task: "Answer",
};

/** [css class, headline]. */
export function scoreBand(score: number): [string, string] {
  if (score >= 85) return ["great", "Excellent!"];
  if (score >= 70) return ["good", "Well done!"];
  if (score >= 50) return ["ok", "Good progress!"];
  return ["low", "Keep practicing!"];
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&#34;")
    .replace(/'/g, "&#39;");

/** Models sometimes elide words ("I am working ... since five years"): use each piece, dropping
 * tiny leftovers ("I") that would highlight random words. */
function fragments(originals: string[]): Set<string> {
  const found = new Set<string>();
  for (const original of originals) {
    const pieces = original.split(ELLIPSIS_RE).map((p) => p.replace(/^[ .,]+|[ .,]+$/g, ""));
    if (pieces.length === 1) found.add(original.trim());
    else for (const p of pieces) if ([...p].length >= 3) found.add(p);
  }
  found.delete("");
  return found;
}

/** Wrap the first non-overlapping, case-insensitive occurrence of each fragment in <mark>
 * (class "unclear" for fragments nobody could understand, "err" for mistakes). */
export function highlightMistakes(
  transcript: string,
  originals: string[],
  unclear: Set<string> = new Set(),
): string {
  const spans: [number, number, string][] = [];
  const lower = transcript.toLowerCase();
  const ordered = [...fragments(originals)].sort((a, b) => b.length - a.length);
  for (const fragment of ordered) {
    const css = unclear.has(fragment) ? "unclear" : "err";
    const needle = fragment.toLowerCase();
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (spans.every(([s, e]) => end <= s || at >= e)) {
        spans.push([at, end, css]);
        break;
      }
    }
  }
  let out = "";
  let cursor = 0;
  for (const [start, end, css] of spans.sort((a, b) => a[0] - b[0])) {
    out += escapeHtml(transcript.slice(cursor, start));
    out += `<mark class="${css}">${escapeHtml(transcript.slice(start, end))}</mark>`;
    cursor = end;
  }
  return out + escapeHtml(transcript.slice(cursor));
}

const fontCache = new Map<string, string>();
function fontFaces(fontsDir: string): string {
  if (!fontCache.has(fontsDir)) {
    const rules: string[] = [];
    for (const weight of [400, 600, 800]) {
      const file = path.join(fontsDir, `inter-latin-${weight}-normal.woff2`);
      if (existsSync(file)) {
        const data = readFileSync(file).toString("base64");
        rules.push(
          `@font-face{font-family:'Inter';font-weight:${weight};font-style:normal;src:url(data:font/woff2;base64,${data}) format('woff2');}`,
        );
      }
    }
    fontCache.set(fontsDir, rules.join("\n"));
  }
  return fontCache.get(fontsDir) ?? "";
}

export class CardBuilder {
  private readonly env: nunjucks.Environment;

  constructor(private readonly templatesDir: string) {
    this.env = new nunjucks.Environment(new nunjucks.FileSystemLoader(templatesDir), {
      autoescape: true,
      throwOnUndefined: true, // a renamed field fails the tests instead of vanishing
      trimBlocks: true,
      lstripBlocks: true,
    });
  }

  html(evaluation: Evaluation, topic: string | null = null, level: string | null = null): string {
    const [band, headline] = scoreBand(evaluation.score);
    const unclear = new Set(
      evaluation.mistakes.filter((m) => m.type === "unclear").map((m) => m.original.trim()),
    );
    return this.env.render("evaluation.njk", {
      ev: evaluation,
      topic,
      level,
      band,
      headline,
      transcript_html: highlightMistakes(
        evaluation.transcript,
        evaluation.mistakes.map((m) => m.original),
        unclear,
      ),
      breakdown: Object.entries(evaluation.score_breakdown).map(([name, value]) => [
        BREAKDOWN_LABEL[name],
        value,
      ]),
      type_label: MISTAKE_TYPE_LABEL,
      has_real_mistakes: evaluation.mistakes.some((m) => m.type !== "unclear"),
      font_faces: fontFaces(path.join(this.templatesDir, "fonts")),
    });
  }
}
