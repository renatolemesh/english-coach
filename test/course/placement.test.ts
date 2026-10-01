/** Placement test (/teste): the adaptive rule and the flow through the course engine. */
import { describe, expect, it } from "vitest";
import { placementBlock, placementNext } from "../../src/course/placement.js";
import { COURSE_PT } from "../../src/course/texts.js";
import { formatText } from "../../src/domain/texts.js";
import { CourseHarness, content, message, seeded } from "./helpers.js";

const LEVELS = ["A1", "A2", "B1", "B2"];
const block = (level: string, right: number, total = 4) =>
  Array.from({ length: total }, (_, i) => ({ level, ok: i < right }));

describe("placement rule", () => {
  it("goes up after a pass and down after a fail, until two levels disagree", () => {
    expect(placementNext(block("A2", 3), LEVELS)).toEqual({ next: "B1" });
    expect(placementNext([...block("A2", 4), ...block("B1", 1)], LEVELS)).toEqual({
      result: "A2",
    });
    expect(placementNext(block("A2", 2), LEVELS)).toEqual({ next: "A1" });
    expect(placementNext([...block("A2", 2), ...block("A1", 3)], LEVELS)).toEqual({
      result: "A1",
    });
    expect(placementNext([...block("A2", 0), ...block("A1", 0)], LEVELS)).toEqual({
      result: "A1",
    });
    const climb = [...block("A2", 4), ...block("B1", 3), ...block("B2", 4)];
    expect(placementNext(climb, LEVELS)).toEqual({ result: "B2" }); // the top: as far as it goes
  });

  it("a short block (thin content) needs all of its items", () => {
    expect(placementNext(block("A2", 2, 2), ["A1", "A2"])).toEqual({ result: "A2" });
    expect(placementNext(block("A2", 1, 2), ["A1", "A2"])).toEqual({ next: "A1" });
  });

  it("a block: a grammar trap and word meanings of that level, never repeated", () => {
    const steps = placementBlock(content(), "A1", new Set(), seeded(3));
    expect(steps).toHaveLength(4);
    expect(steps.every((s) => s.level === "A1")).toBe(true);
    expect(steps.filter((s) => s.type === "fix")).toHaveLength(1);
    const again = placementBlock(
      content(),
      "A1",
      new Set(steps.map((s) => s.item ?? "")),
      seeded(3),
    );
    expect(again.some((s) => steps.some((t) => t.item === s.item))).toBe(false);
  });
});

describe("placement through the engine", () => {
  it("right answers: the top level the content covers, saved; no cards, no lesson counted", async () => {
    const h = new CourseHarness();
    await h.send("/teste");
    expect(h.last().startsWith(COURSE_PT.placementIntro)).toBe(true);
    expect(h.last()).toContain(formatText(COURSE_PT.placementHeader, { n: 1 }));
    for (let i = 0; i < 20 && h.lesson?.status === "active"; i++) {
      const [text] = h.rightAnswer();
      await h.send(text);
    }
    expect(h.lesson?.status).toBe("done");
    expect(h.repo.levels.get(1)).toBe("A2"); // the fixture's words go up to A2
    expect(h.last()).toContain("*Seu nível: A2*");
    expect(h.last()).toContain(formatText(COURSE_PT.placementTop, { next: "B1" }));
    expect(h.last()).toContain("[start aula menu]"); // never talked: the first-meeting welcome
    expect(h.repo.cards.size).toBe(0);
    expect(await h.repo.lessonsDone(1)).toBe(0);
  });

  it("'não sei' all the way: down to A1", async () => {
    const h = new CourseHarness();
    h.access = { ...h.access, topic: "travel" }; // has talked before
    await h.send("/teste");
    for (let i = 0; i < 20 && h.lesson?.status === "active"; i++) await h.send("não sei");
    expect(h.repo.levels.get(1)).toBe("A1");
    const levels = h.lesson?.plan.map((s) => s.level);
    expect(levels?.[0]).toBe("A2"); // starts at A2, then A1
    expect(levels?.at(-1)).toBe("A1");
    expect(h.last()).toContain("[resume aula menu]");
  });

  it("offered right after signup", async () => {
    const h = new CourseHarness();
    h.channel.sent.length = 0;
    const msg = message("ATIVAR 123456");
    expect(
      await h.engine.offerPlacement({
        msg,
        access: h.access,
        channel: h.channel,
        config: h.config,
      }),
    ).toBe(true);
    expect(h.last()).toBe(`${COURSE_PT.placementOffer} [teste start]`);
  });
});
