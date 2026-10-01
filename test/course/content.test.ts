// The built course data (data/course): it loads, covers A1 to B2 and has the hand fixes applied.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { PROJECT_ROOT } from "../../src/config.js";
import { CourseContent, levelIndex } from "../../src/course/content.js";
import { GOOD_FIT } from "../../src/course/planner.js";

const dir = path.join(PROJECT_ROOT, "data/course");

describe("course data", () => {
  const content = CourseContent.load(dir);

  it("covers A1 to B2 and gives B2 words to B2 and C students", () => {
    expect(new Set(content.wordList.map((w) => w.level))).toEqual(
      new Set(["A1", "A2", "B1", "B2"]),
    );
    expect(content.maxLevel).toBe("B2");
    expect(content.poolLevel("C1")).toBe(levelIndex("B2"));
    expect(content.poolLevel("B2")).toBe(levelIndex("B2"));
    expect(content.poolLevel("A2")).toBe(levelIndex("A2"));
    for (const level of ["A1", "A2", "B1", "B2"])
      expect(content.sentencesByLevel.get(level)?.length ?? 0).toBeGreaterThan(1000);
  });

  it("every sentence has a fidelity score, and examples point to sentences", () => {
    const sentences = [...content.sentences.values()];
    for (const s of sentences) expect(s.fit >= 0 && s.fit <= 1, s.id).toBe(true);
    const faithful = sentences.filter((s) => s.fit >= GOOD_FIT).length;
    expect(faithful / sentences.length).toBeGreaterThan(0.8);
    for (const w of content.wordList)
      for (const id of w.examples) expect(content.sentences.has(id), id).toBe(true);
    // the production case: an order exercise showed this loose translation
    const emotions = content.sentences.get("s1349");
    expect(emotions === undefined || emotions.fit < GOOD_FIT).toBe(true);
  });

  it("overrides.yaml is applied", () => {
    const raw = parseYaml(readFileSync(path.join(dir, "overrides.yaml"), "utf8"));
    const overrides = raw as Record<string, { gloss?: string; alt?: string[]; drop?: string }>;
    for (const [id, o] of Object.entries(overrides)) {
      const w = content.words.get(id);
      if (o.drop) {
        expect(w, id).toBeUndefined();
        continue;
      }
      if (o.gloss) {
        expect(w?.gloss, id).toBe(o.gloss);
        expect(w?.conf, id).toBeGreaterThanOrEqual(0.9);
      }
      if (o.alt && w) expect(w.alt, id).toEqual(o.alt.filter((a) => a !== w.gloss));
    }
  });
});
