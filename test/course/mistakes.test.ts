/** The student's own mistakes as exercises: real cases from the conversation's corrections. */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "../../src/config.js";
import { CourseContent } from "../../src/course/content.js";
import {
  type Exercise,
  type MistakeData,
  makeExercise,
  mistakePlan,
  NOTHING,
} from "../../src/course/exercises.js";
import { COURSE_PT } from "../../src/course/texts.js";
import { formatText } from "../../src/domain/texts.js";
import { seeded } from "./helpers.js";

const real = CourseContent.load(path.join(PROJECT_ROOT, "data/course"));
const isWord = (w: string) => real.isWord(w);
const m = (original: string, correction: string, more: Partial<MistakeData> = {}) => ({
  original,
  correction,
  explanation: "",
  ...more,
});
const build = (data: MistakeData, seed = 1) =>
  makeExercise(
    { type: "mistake", item: "m:x", data },
    { content: real, level: "B1", texts: COURSE_PT, rng: seeded(seed) },
  ) as Exercise;

describe("which mistakes make a fair exercise", () => {
  it("one slip: a gap with the right words and what the student said", () => {
    expect(mistakePlan(m("work for system locations", "work on system locations"), isWord)).toEqual(
      {
        kind: "gap",
        before: ["work"],
        after: ["system", "locations"],
        right: "on",
        wrong: "for",
      },
    );
    expect(mistakePlan(m("near of our house", "near our house"), isWord)).toMatchObject({
      right: "",
      wrong: "of",
    });
    // contractions are written out, so only the missing article is the slip
    expect(
      mistakePlan(m("I'm software engineer", "I am a software engineer"), isWord),
    ).toMatchObject({ before: ["I", "am"], right: "a", wrong: "" });
  });

  it("not: capitals and contractions, rewrites, broken corrections, no context", () => {
    for (const [original, correction] of [
      ["i am", "I'm"],
      ["I am Henad Lemis", "I My name is Henad Lemis"],
      ["for commoners in sisterland", "for the public"],
      ["i preffer AK, is", "I prefer the AK; it is"],
      ["entry", "entry-frag"],
    ]) {
      expect(mistakePlan(m(original as string, correction as string), isWord)).toBeNull();
    }
  });

  it("word order and a Portuguese word get their own shapes", () => {
    expect(
      mistakePlan(m("I miss very much this time", "I miss this time very much"), isWord),
    ).toEqual({ kind: "order", tokens: ["I", "miss", "this", "time", "very", "much"] });
    expect(mistakePlan(m("praia", "beach"), isWord)).toEqual({
      kind: "word",
      said: "praia",
      right: "beach",
    });
    // "the" is not in the word bank, but it is English: a gap, not a Portuguese word
    expect(mistakePlan(m("the nuke", "Nuke"), isWord)).toMatchObject({ kind: "gap", wrong: "the" });
  });
});

describe("the exercise", () => {
  const data = m("work for system locations", "work on system locations", {
    explanation: "Use 'work on' for projects and 'work for' for the company.",
    context:
      "I work in municipality management system, for commoners in sisterland, and the other " +
      "company I work for system locations like trucks and others.",
  });

  it("does not give the answer away: the gap sits in the student's sentence", () => {
    const ex = build(data);
    expect(ex.body).toBe(
      formatText(COURSE_PT.mistake, {
        sentence:
          "… in sisterland, and the other company I work ___ system locations like trucks and others.",
      }),
    );
    expect(ex.body).not.toContain("work for");
    expect(ex.options[ex.answer]).toBe("on");
    expect(ex.options).toContain("for"); // what they said, among the others
    expect(ex.options).toHaveLength(3); // and another preposition
    expect(ex.tip).toContain(formatText(COURSE_PT.mistakeSaid, { said: data.original }));
    expect(ex.reveal).toBe("work on system locations");
  });

  it("punctuation right after the gap stays attached", () => {
    const ex = build(
      m("on the United States", "in the United States", {
        context: "I need to talk about remote jobs on the United States.",
      }),
    );
    expect(ex.body).toContain("*I need to talk about remote jobs ___ the United States.*");
  });

  it("a missing or extra word has a 'nothing' option; useless explanations are dropped", () => {
    const ex = build(m("I am agree", "I agree", { explanation: "Same as the previous item." }));
    expect(ex.body).toContain("*I ___ agree*");
    expect(ex.options[ex.answer]).toBe(NOTHING);
    expect(ex.options).toContain("am");
    expect(ex.tip).toBe(formatText(COURSE_PT.mistakeSaid, { said: "I am agree" }));
  });

  it("word order is typed or numbered tiles; a Portuguese word is typed", () => {
    const order = build(m("I miss very much this time", "I miss this time very much"));
    expect([order.mode, order.tiles.length]).toEqual(["text", 6]);
    expect(order.accept[0]).toBe("I miss this time very much");
    const word = build(m("praia", "beach"));
    expect(word.body).toBe(formatText(COURSE_PT.mistakeWord, { said: "praia" }));
    expect(word.accept).toContain("beach");
  });

  it("no exercise for a mistake that cannot be fair", () => {
    expect(
      makeExercise(
        { type: "mistake", item: "m:x", data: m("i am", "I'm") },
        {
          content: real,
          level: "B1",
          texts: COURSE_PT,
          rng: seeded(1),
        },
      ),
    ).toBeNull();
  });
});
