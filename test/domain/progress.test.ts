import { describe, expect, it } from "vitest";
import { lockedPick } from "../../src/domain/commands.js";
import {
  goalAboveLimit,
  MAX_PRACTICES_A_DAY,
  nextLevel,
  type Practice,
  parseGoal,
  practicePoints,
  rankingName,
  weekPoints,
} from "../../src/domain/progress.js";
import { effectiveSpeed, effectiveTutor } from "../../src/domain/tutors.js";

const p = (day: string, score: number | null, audio = false): Practice => ({ day, score, audio });

describe("progress rules", () => {
  it("points: practice + score + voice, a bonus per day with the goal met", () => {
    expect(practicePoints(p("d", 80, true))).toBe(5 + 8 + 3);
    expect(practicePoints(p("d", null))).toBe(5);
    const week = [p("a", 80), p("a", 80), p("b", 100, true)];
    expect(weekPoints(week, 2)).toBe(13 + 13 + 20 + 18); // day a met the goal of 2
    expect(weekPoints(week, 5)).toBe(13 + 13 + 18);
  });

  it("only the first practices of a day count", () => {
    const many = Array.from({ length: MAX_PRACTICES_A_DAY + 30 }, () => p("a", 100));
    expect(weekPoints(many, 3)).toBe(MAX_PRACTICES_A_DAY * 15 + 20);
  });

  it("levels, goals and names", () => {
    expect(nextLevel("B1")).toBe("B2");
    expect(nextLevel("C2")).toBeNull();
    expect(parseGoal(" 10 ")).toBe(10);
    expect(parseGoal("7")).toBe(7);
    expect(parseGoal("0")).toBeNull();
    expect(parseGoal("31")).toBeNull();
    expect(parseGoal("2.5")).toBeNull();
    expect(goalAboveLimit(20, 15)).toBe(true);
    expect(goalAboveLimit(20, null)).toBe(false);
    expect(rankingName("Maria Clara da Silva", 1)).toBe("Maria S.");
    expect(rankingName("ana", 2)).toBe("ana");
    expect(rankingName("  ", 3)).toBe("Aluno 3");
    expect(rankingName(null, 4)).toBe("Aluno 4");
  });

  it("the plan's voices and speeds", () => {
    expect(effectiveTutor("emma", ["sarah"]).id).toBe("sarah");
    expect(effectiveTutor("emma", null).id).toBe("emma");
    expect(effectiveSpeed(0.7, [1, 0.9])).toBe(0.9);
    expect(effectiveSpeed(0.8, null)).toBe(0.8);
    expect(lockedPick("voz", "emma", ["sarah"], null)).toBe(true);
    expect(lockedPick("voz", "2", ["sarah"], null)).toBe(false); // 2 = Sarah
    expect(lockedPick("velocidade", "70", null, [1, 0.9])).toBe(true);
    expect(lockedPick("voz", "", ["sarah"], null)).toBe(false); // the menu
    expect(lockedPick("tema", "emma", ["sarah"], null)).toBe(false);
  });
});
