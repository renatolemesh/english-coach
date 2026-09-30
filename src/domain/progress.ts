/**
 * Goals that keep students coming back: a daily goal of practices (the student picks it), the
 * way up to the next CEFR level (good answers at the current level) and weekly points for the
 * ranking. Pure rules; the counts come from the turns table.
 */

import { LEVELS } from "./topics.js";

// The student picks any goal from 1 to MAX_DAILY_GOAL (never above the plan's daily limit);
// these are the suggestions shown next to it.
export const DAILY_GOALS = [3, 5, 10] as const;
export const DEFAULT_DAILY_GOAL = 5;
export const MAX_DAILY_GOAL = 30;

// A "good answer" for the way up. The median score is about 80, so most students get there
// with steady practice, not with one lucky day.
export const GOOD_SCORE = 75;
// Good answers at a level to move up to the next one (C2 is the top).
export const LEVEL_UP: Readonly<Record<string, number>> = {
  A1: 20,
  A2: 30,
  B1: 40,
  B2: 60,
  C1: 80,
};

// Weekly points: every practice counts, a better score and speaking count more, and meeting the
// daily goal is worth a bonus. Only the first MAX_PRACTICES_A_DAY of a day count, so an
// unlimited plan cannot buy the top of the ranking by sending a hundred messages.
export const POINTS = { practice: 5, audio: 3, goal: 20 } as const;
export const MAX_PRACTICES_A_DAY = 20;
export const RANKING_SIZE = 20;

/** '8' -> 8; null unless a whole number from 1 to MAX_DAILY_GOAL. */
export function parseGoal(arg: string): number | null {
  const text = arg.trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= MAX_DAILY_GOAL ? n : null;
}

/** Why a goal is refused: above the plan's messages per day (it could never be met). */
export function goalAboveLimit(goal: number, perDay: number | null | undefined): boolean {
  return perDay !== null && perDay !== undefined && perDay > 0 && goal > perDay;
}

export function goalOf(goal: number | null | undefined): number {
  return goal && goal > 0 ? goal : DEFAULT_DAILY_GOAL;
}

export function nextLevel(level: string): string | null {
  const i = (LEVELS as readonly string[]).indexOf(level);
  return i >= 0 && i < LEVELS.length - 1 ? (LEVELS[i + 1] ?? null) : null;
}

export interface Practice {
  day: string; // YYYY-MM-DD, local
  score: number | null;
  audio: boolean;
  points?: number; // a finished lesson (/aula): its own points (right answers + bonus)
}

/** 5 + up to 10 for the score (0-100) + 3 for a voice answer; a lesson brings its points. */
export function practicePoints(p: Practice): number {
  if (p.points !== undefined) return p.points;
  return POINTS.practice + Math.round((p.score ?? 0) / 10) + (p.audio ? POINTS.audio : 0);
}

/** Points of one student's practices (in the order they happened). */
export function weekPoints(practices: readonly Practice[], goal: number): number {
  const byDay = new Map<string, Practice[]>();
  for (const p of practices) byDay.set(p.day, [...(byDay.get(p.day) ?? []), p]);
  let total = 0;
  for (const day of byDay.values()) {
    total += day.slice(0, MAX_PRACTICES_A_DAY).reduce((sum, p) => sum + practicePoints(p), 0);
    if (day.length >= goalOf(goal)) total += POINTS.goal;
  }
  return total;
}

/** "Maria Clara Souza" -> "Maria S."; the ranking never shows full names or phones. */
export function rankingName(name: string | null | undefined, id: number): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first) return `Aluno ${id}`;
  const last = words.length > 1 ? words.at(-1) : undefined;
  return last ? `${first} ${[...last][0]?.toUpperCase()}.` : first;
}
