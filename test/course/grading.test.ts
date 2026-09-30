import { describe, expect, it } from "vitest";
import {
  align,
  gradeSpeech,
  gradeText,
  isTypo,
  normalize,
  parseChoice,
} from "../../src/course/grading.js";

describe("course grading", () => {
  it("normalizes case, punctuation and contractions", () => {
    expect(normalize("I'm HAPPY, aren't you?")).toBe("i am happy are not you");
    expect(normalize("It’s Tom’s car!")).toBe("it is toms car");
    expect(normalize("I can't go.")).toBe(normalize("I cannot go"));
  });

  it("typos depend on the word length", () => {
    expect(isTypo("hous", "house")).toBe(true);
    expect(isTypo("cat", "car")).toBe(false); // short words must be exact
    expect(isTypo("beautifull", "beautiful")).toBe(true);
    expect(isTypo("bread", "house")).toBe(false);
  });

  it("aligns words with inserts and deletes", () => {
    const ops = align(["i", "live", "big", "house"], ["i", "live", "in", "a", "big", "house"]);
    expect(ops.filter((o) => o.op === "del").length).toBe(2);
  });

  it("grades typed answers against every accepted answer", () => {
    expect(gradeText("I'm very happy today", ["I am very happy today."]).ok).toBe(true);
    const typo = gradeText("I am very hapy today", ["I am very happy today."]);
    expect([typo.ok, typo.typos]).toEqual([true, ["happy"]]); // a slip, flagged
    const slip = gradeText("I live in a big hose", ["I live in a big house."]);
    expect([slip.ok, slip.typos]).toEqual([true, ["house"]]);
    expect(gradeText("I live in house", ["I live in a big house."]).ok).toBe(false);
    expect(gradeText("have some water", ["Drink some water.", "Have some water."]).ok).toBe(true);
  });

  it("reads a choice from a number, a letter or the option text", () => {
    const options = ["casa", "cachorro", "gato"];
    expect(parseChoice("2", options)).toBe(1);
    expect(parseChoice("C)", options)).toBe(2);
    expect(parseChoice(" Casa ", options)).toBe(0);
    expect(parseChoice("4", options)).toBeNull();
    expect(parseChoice("dog", options)).toBeNull();
  });

  it("scores speech by words heard and how clearly", () => {
    const target = ["I live in a big house."];
    const clear = gradeSpeech([{ text: "I live in a big house", p: 0.95 }], target);
    expect(clear.score).toBe(100);
    const unsure = gradeSpeech(
      [
        { text: "I", p: 0.9 },
        { text: "live", p: 0.2 },
        { text: "in a big house", p: 0.9 },
      ],
      target,
    );
    expect(unsure.score).toBeLessThan(90);
    expect(unsure.weak).toEqual(["live"]);
    const missing = gradeSpeech([{ text: "I in a house", p: 0.9 }], target);
    expect(missing.weak).toEqual(["live", "big"]);
    expect(missing.score).toBeLessThan(70);
  });
});
