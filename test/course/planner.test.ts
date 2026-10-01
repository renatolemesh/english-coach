// Sentence choice by fidelity: exercises that show the Portuguese only use faithful pairs.
import { describe, expect, it } from "vitest";
import { CourseContent, Sentence } from "../../src/course/content.js";
import { GOOD_FIT, type PlanInput, planLesson } from "../../src/course/planner.js";
import { content as fixture, seeded } from "./helpers.js";

const words = [...fixture().wordList];
const sentence = (id: number, fit?: number) =>
  Sentence.parse({
    id: `s${id}`,
    en: `We like the big house number ${id}.`,
    pt: `Nós gostamos da casa grande número ${id}.`,
    level: "A1",
    words: ["house.n", "big.adj"],
    ...(fit === undefined ? {} : { fit }),
  });

const input = (sentences: Sentence[], lessonsDone: number): PlanInput => ({
  content: new CourseContent(words, sentences),
  level: "A1",
  kind: "lesson",
  due: [],
  known: new Set(),
  mistakes: [],
  usedSentences: new Set(),
  lessonsDone,
  rng: seeded(lessonsDone + 1),
});

const SHOWS_PT = new Set(["order", "translate", "say"]);
const sentenceSteps = (plan: ReturnType<typeof planLesson>) => plan.filter((s) => s.sentence);

describe("sentences by fidelity", () => {
  it("a sentence without a score loads as faithful", () => {
    expect(sentence(1).fit).toBe(1);
    expect(fixture().sentences.get("s1")?.fit).toBe(1);
  });

  it("order, translate and say only show faithful translations", () => {
    const mixed = Array.from({ length: 40 }, (_, i) => sentence(i + 1, i % 2 ? 0.5 : 0.9));
    for (let lessons = 0; lessons < 12; lessons++) {
      const plan = planLesson(input(mixed, lessons));
      const steps = sentenceSteps(plan);
      expect(steps.length).toBe(2);
      for (const step of steps) {
        const fit = mixed.find((s) => s.id === step.sentence)?.fit ?? 0;
        if (SHOWS_PT.has(step.type)) expect(fit).toBeGreaterThanOrEqual(GOOD_FIT);
      }
    }
  });

  it("without a faithful pair they become dictation and repeat", () => {
    const loose = Array.from({ length: 20 }, (_, i) => sentence(i + 1, 0.5));
    const types = new Set<string>();
    for (let lessons = 0; lessons < 6; lessons++) {
      const steps = sentenceSteps(planLesson(input(loose, lessons)));
      expect(steps.length).toBe(2);
      for (const step of steps) types.add(step.type);
    }
    expect([...types].sort()).toEqual(["dictation", "repeat"]);
  });
});
