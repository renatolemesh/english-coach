/**
 * Placement test (/teste, offered at signup): blocks of 4 tap-to-answer items at one CEFR level,
 * 3 right to pass. It starts at A2 and goes up after a pass, down after a fail, until two
 * neighbouring levels disagree (or the content runs out): the result is the highest level
 * passed. Blocks of 4 with 3 to pass keep a lucky guesser (1 in 3 per item) below 12%; the
 * intro asks for "não sei" instead of guesses.
 *
 * Items: word meanings at that exact level (CEFR-J) and one grammar trap of that level, the
 * kinds of mistakes that separate the levels for Brazilians.
 */
import { type CourseContent, levelIndex, type Word } from "./content.js";
import { cardKey, type Step, shuffle } from "./exercises.js";

export const BLOCK = 4;
export const PASS = 3;
export const START_LEVEL = "A2";
const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
const WORD_CONF = 0.7; // only words whose meaning is certain
const TESTED_POS: ReadonlySet<string> = new Set(["noun", "verb", "adjective", "adverb"]);

/** Levels the content can test: A1 up to the highest level with words. */
export function placementLevels(content: CourseContent): string[] {
  return LEVELS.slice(0, levelIndex(content.maxLevel) + 1);
}

/** One block of steps at `level`, avoiding items already used in this test. */
export function placementBlock(
  content: CourseContent,
  level: string,
  used: ReadonlySet<string>,
  rng: () => number,
): Step[] {
  const words = shuffle(
    content.wordList.filter(
      (w: Word) =>
        w.level === level &&
        w.conf >= WORD_CONF &&
        TESTED_POS.has(w.pos) &&
        !used.has(cardKey.word(w.id)),
    ),
    rng,
  );
  const traps = shuffle(
    [...content.grammar.values()].filter(
      (g) => g.level === level && !used.has(cardKey.grammar(g.id)),
    ),
    rng,
  );
  const steps: Step[] = [];
  const trap = traps[0];
  if (trap) steps.push({ type: "fix", item: cardKey.grammar(trap.id), level });
  for (const w of words) {
    if (steps.length >= BLOCK) break;
    steps.push({ type: "meaning", item: cardKey.word(w.id), level });
  }
  return shuffle(steps, rng);
}

export type PlacementNext = { next: string } | { result: string };

/** After a block: the level to test next, or the result. `results`: every answered step. */
export function placementNext(
  results: readonly { level: string; ok: boolean }[],
  levels: readonly string[],
): PlacementNext {
  const blocks = new Map<string, { right: number; total: number }>();
  for (const r of results) {
    const b = blocks.get(r.level) ?? { right: 0, total: 0 };
    blocks.set(r.level, { right: b.right + (r.ok ? 1 : 0), total: b.total + 1 });
  }
  const passed = (level: string | undefined) => {
    const b = level ? blocks.get(level) : undefined;
    return b ? b.right >= Math.min(PASS, b.total) : undefined;
  };
  const last = results.at(-1)?.level ?? START_LEVEL;
  const i = levels.indexOf(last);
  const below = levels[i - 1];
  const above = levels[i + 1];
  if (passed(last)) {
    if (!above || passed(above) === false) return { result: last };
    return { next: above };
  }
  if (!below) return { result: last }; // failed A1: A1 all the same
  if (passed(below)) return { result: below };
  return { next: below };
}
