import { createEmptyCard } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import {
  AUDIO_TYPES,
  EXERCISE_TYPES,
  type Exercise,
  type GenContext,
  makeExercise,
  type Step,
  tilesOf,
} from "../../src/course/exercises.js";
import { LESSON_SIZE, planLesson, spreadAudio, typeForCard } from "../../src/course/planner.js";
import { review } from "../../src/course/srs.js";
import { COURSE_PT } from "../../src/course/texts.js";
import { content, seeded } from "./helpers.js";

const g = (seed = 1): GenContext => ({
  content: content(),
  level: "A1",
  texts: COURSE_PT,
  rng: seeded(seed),
});

const STEPS: Step[] = [
  { type: "meaning", item: "w:house.n" },
  { type: "word", item: "w:house.n" },
  { type: "listen", item: "w:house.n" },
  { type: "cloze", item: "w:like.v" },
  { type: "type", item: "w:dog.n" },
  { type: "order", item: null, sentence: "s1" },
  { type: "dictation", item: null, sentence: "s3" },
  { type: "translate", item: null, sentence: "s6" },
  { type: "repeat", item: null, sentence: "s8" },
  { type: "say", item: null, sentence: "s10" },
  { type: "fix", item: "g:age-be" },
  { type: "false_friend", item: "ff:actually" },
  { type: "pair", item: "mp:ship-sheep" },
  { type: "chat", item: "c:cafe-order" },
  {
    type: "mistake",
    item: "m:x1",
    data: { original: "I am work", correction: "I work", explanation: "Simple present." },
  },
];

describe("exercises", () => {
  it("every type can be built from the content", () => {
    expect(STEPS.map((s) => s.type).sort()).toEqual([...EXERCISE_TYPES].sort());
    for (const step of STEPS) {
      const ex = makeExercise(step, g()) as Exercise;
      expect(ex, step.type).not.toBeNull();
      expect(ex.body.length).toBeGreaterThan(5);
      expect(Boolean(ex.audio)).toBe(AUDIO_TYPES.has(step.type));
      if (ex.mode === "choice") {
        expect(ex.options[ex.answer]).toBeDefined();
        expect(new Set(ex.options).size).toBe(ex.options.length);
        if (!ex.labelled) for (const o of ex.options) expect([...o].length).toBeLessThanOrEqual(20);
      } else {
        expect(ex.accept.length).toBeGreaterThan(0);
      }
      expect(ex.nonce).toMatch(/^[a-z0-9]{5}$/);
    }
  });

  it("distractors are never synonyms of the answer", () => {
    for (let seed = 1; seed < 30; seed++) {
      const ex = makeExercise({ type: "meaning", item: "w:drink.v" }, g(seed)) as Exercise;
      expect(ex.options[ex.answer]).toBe("beber");
      expect(ex.options).not.toContain("tomar");
      const dog = makeExercise({ type: "word", item: "w:dog.n" }, g(seed)) as Exercise;
      expect(dog.options).not.toContain("cat".repeat(0) || "dog ");
    }
  });

  it("cloze inflects the distractors like the gap", () => {
    const ex = makeExercise({ type: "cloze", item: "w:like.v" }, g(3)) as Exercise;
    expect(ex.body).toContain("My dog ___ water.");
    expect(ex.options[ex.answer]).toBe("likes");
    for (const o of ex.options) expect(o.endsWith("s")).toBe(true);
  });

  it("word tiles keep I and names, drop the full stop", () => {
    expect(tilesOf("I live in a big house.")).toEqual(["I", "live", "in", "a", "big", "house"]);
    expect(tilesOf("The cat is small.")).toEqual(["the", "cat", "is", "small"]);
    const ex = makeExercise({ type: "order", item: null, sentence: "s1" }, g(2)) as Exercise;
    expect(ex.tiles.join(" ")).not.toBe("I live in a big house");
    expect(ex.body).toContain("1️⃣");
  });

  it("grammar traps list long sentences as A) B) C)", () => {
    const ex = makeExercise({ type: "fix", item: "g:age-be" }, g()) as Exercise;
    expect(ex.labelled).toBe(true);
    expect(ex.body).toContain("*A)*");
    expect(ex.options[ex.answer]).toBe("I'm 20 years old.");
  });
});

describe("lesson planning", () => {
  const input = (over = {}) => ({
    content: content(),
    level: "A1",
    kind: "lesson" as const,
    due: [],
    known: new Set<string>(),
    mistakes: [],
    usedSentences: new Set<string>(),
    lessonsDone: 0,
    rng: seeded(5),
    ...over,
  });

  it("a first lesson: new words introduced and tested again later, plus practice", () => {
    const plan = planLesson(input());
    expect(plan.length).toBeGreaterThanOrEqual(LESSON_SIZE - 1);
    const intros = plan.flatMap((s, i) => (s.type === "meaning" && s.fresh ? [[s.item, i]] : []));
    expect(intros.length).toBeGreaterThanOrEqual(3);
    for (const [item, at] of intros) {
      const again = plan.findIndex((s, i) => i > (at as number) && s.item === item);
      expect(again - (at as number)).toBeGreaterThanOrEqual(2);
    }
    expect(plan.some((s) => s.sentence)).toBe(true);
    expect(plan.some((s) => s.type === "repeat" || s.type === "say")).toBe(true);
    expect(plan.some((s) => s.item?.startsWith("g:"))).toBe(true); // the first trap: grammar
  });

  it("many reviews due: fewer new words", () => {
    const now = new Date();
    const due = content()
      .wordList.slice(0, 15)
      .map((w) => ({ item: `w:${w.id}`, card: review(review(null, "good", now), "good", now) }));
    const plan = planLesson(input({ due, known: new Set(due.map((d) => d.item)) }));
    expect(plan.filter((s) => s.fresh && s.item?.startsWith("w:")).length).toBe(1);
  });

  it("harder shapes as a card matures", () => {
    const rng = seeded(1);
    const fresh = review(createEmptyCard(), "good");
    expect(["word", "cloze"]).toContain(typeForCard("w:x", fresh, rng));
    let card = fresh;
    for (let i = 0; i < 4; i++) card = review(card, "good");
    expect(["type", "cloze", "listen"]).toContain(typeForCard("w:x", card, rng));
    expect(typeForCard("ff:x", card, rng)).toBe("false_friend");
  });

  it("no two audio exercises in a row", () => {
    const steps: Step[] = ["listen", "dictation", "pair", "meaning", "word", "cloze"].map(
      (type) => ({ type: type as Step["type"], item: null }),
    );
    const out = spreadAudio(steps).map((s) => s.type);
    for (let i = 1; i < out.length; i++) {
      expect(
        AUDIO_TYPES.has(out[i - 1] as Step["type"]) && AUDIO_TYPES.has(out[i] as Step["type"]),
      ).toBe(false);
    }
  });

  it("a review is only due cards", () => {
    expect(planLesson(input({ kind: "review" }))).toEqual([]);
  });
});
