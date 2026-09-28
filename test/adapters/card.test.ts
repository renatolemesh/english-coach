import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CardBuilder, highlightMistakes, scoreBand } from "../../src/adapters/image/card.js";
import { PROJECT_ROOT } from "../../src/config.js";
import type { Evaluation } from "../../src/domain/evaluation.js";

const cards = new CardBuilder(path.join(PROJECT_ROOT, "templates"));
const squash = (html: string) =>
  html
    .replace(/&quot;/g, "&#34;")
    .replace(/\s+/g, " ")
    .replace(/> </g, "><")
    .trim(); // same entity
const cases = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "../fixtures/card-parity.json"), "utf8"),
) as {
  evaluation: Evaluation;
  topic: string | null;
  level: string | null;
  html: string;
}[];

describe("evaluation card", () => {
  it("renders the reference HTML", () => {
    for (const c of cases)
      expect(squash(cards.html(c.evaluation, c.topic, c.level))).toBe(squash(c.html));
  });

  it("escapes everything the student or the model wrote", () => {
    const html = cards.html(cases[3]?.evaluation as Evaluation, "<b>", "C1");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("highlights mistakes, unclear parts differently, never overlapping", () => {
    expect(highlightMistakes("I goed home", ["goed"])).toBe('I <mark class="err">goed</mark> home');
    expect(highlightMistakes("I show use it", ["show use"], new Set(["show use"]))).toContain(
      '<mark class="unclear">',
    );
    expect(highlightMistakes("a b a", ["a b", "b a"])).toBe('<mark class="err">a b</mark> a');
  });

  it.each([
    [95, "great"],
    [72, "good"],
    [55, "ok"],
    [10, "low"],
  ])("score %i is band %s", (score, band) => {
    expect(scoreBand(score)[0]).toBe(band);
  });
});
