/**
 * What goes into a lesson (10 exercises, about 5 minutes on WhatsApp):
 * - 2-3 new words, each introduced (meaning) and tested again a few exercises later;
 * - reviews that are due (FSRS), in a harder shape as the word matures:
 *   recognise (meaning) -> recall with support (word, cloze) -> listen -> produce (type);
 * - one Brazilian trap (grammar, false friend, chat or minimal pair), rotating;
 * - one of the student's own mistakes from the conversation, when there is one;
 * - one sentence exercise (order, dictation or translation) and one speaking exercise.
 * Fewer new items when reviews pile up, so accuracy stays around 85%.
 */
import type { Card } from "ts-fsrs";
import { LEVELS } from "../domain/topics.js";
import { type CourseContent, GOOD_FIT, levelIndex, type Sentence, type Word } from "./content.js";
import {
  AUDIO_TYPES,
  cardKey,
  type ExerciseType,
  hasName,
  type MistakeData,
  pick,
  type Step,
  shuffle,
} from "./exercises.js";
import { relearning } from "./srs.js";

export const LESSON_SIZE = 10;
const RETEST_GAP = 4; // a new word comes back this many exercises later
const MIN_CONF = 0.5; // gloss confidence below this is not taught

export { GOOD_FIT };

type SentenceType = "order" | "dictation" | "translate" | "repeat" | "say";
const SHOWS_PT: ReadonlySet<SentenceType> = new Set(["order", "translate", "say"]);
// Content words are taught as vocabulary; pronouns, prepositions, auxiliaries and the like are
// learned inside sentences (a multiple choice for "of = de" teaches little).
const TEACH_POS: ReadonlySet<string> = new Set(["noun", "verb", "adjective", "adverb", "number"]);
const NOT_TAUGHT: ReadonlySet<string> = new Set(["be", "do", "have", "get", "not", "let"]);

export interface DueCard {
  item: string;
  card: Card;
  data?: MistakeData | null;
}

export interface PlanInput {
  content: CourseContent;
  level: string;
  kind: "lesson" | "review";
  due: DueCard[]; // most overdue first
  known: ReadonlySet<string>; // every item with a card
  mistakes: { key: string; data: MistakeData }[]; // conversation mistakes without a card yet
  usedSentences: ReadonlySet<string>; // recently practised sentence ids
  lessonsDone: number;
  rng: () => number;
}

export function typeForCard(item: string, card: Card, rng: () => number): ExerciseType {
  if (item.startsWith("g:")) return "fix";
  if (item.startsWith("ff:")) return "false_friend";
  if (item.startsWith("mp:")) return "pair";
  if (item.startsWith("c:")) return "chat";
  if (item.startsWith("m:")) return "mistake";
  if (relearning(card)) return "meaning";
  if (card.reps <= 1) return pick(["word", "cloze"], rng) as ExerciseType;
  if (card.reps === 2) return pick(["listen", "cloze", "word"], rng) as ExerciseType;
  return pick(["type", "cloze", "listen", "type"], rng) as ExerciseType;
}

function teachable(w: Word): boolean {
  return w.conf >= MIN_CONF && TEACH_POS.has(w.pos) && !NOT_TAUGHT.has(w.word);
}

/** The next new words: the student's level first (then what they skipped below it), in
 * frequency order, mixing parts of speech (a noun, a verb, an adjective... not three verbs). */
function newWords(input: PlanInput, n: number): string[] {
  const { content, known } = input;
  const pool = content.poolLevel(input.level);
  const candidates: Word[] = [];
  for (const level of [pool, ...Array.from({ length: pool }, (_, i) => i)]) {
    for (const w of content.wordList) {
      if (candidates.length >= 40) break;
      if (levelIndex(w.level) === level && teachable(w) && !known.has(cardKey.word(w.id))) {
        candidates.push(w);
      }
    }
  }
  const out: Word[] = [];
  while (out.length < n && candidates.length) {
    const used = new Set(out.map((w) => w.pos));
    const i = Math.max(
      0,
      candidates.findIndex((w) => !used.has(w.pos)),
    );
    out.push(...candidates.splice(i, 1));
  }
  return out.map((w) => cardKey.word(w.id));
}

const TRAP_KINDS = ["g", "ff", "c", "mp"] as const;

function newTrap(input: PlanInput): Step | null {
  const { content, known } = input;
  const max = levelIndex(input.level);
  const kinds = TRAP_KINDS.map((_, i) => TRAP_KINDS[(input.lessonsDone + i) % TRAP_KINDS.length]);
  for (const kind of kinds) {
    const [items, type, key] =
      kind === "g"
        ? [[...content.grammar.values()], "fix" as const, cardKey.grammar]
        : kind === "ff"
          ? [[...content.falseFriends.values()], "false_friend" as const, cardKey.falseFriend]
          : kind === "c"
            ? [[...content.chats.values()], "chat" as const, cardKey.chat]
            : [[...content.pairs.values()], "pair" as const, cardKey.pair];
    // any trap up to the student's level (a B1 student still says "I have 20 years")
    const next = pick(
      items.filter((i) => levelIndex(i.level) <= max && !known.has(key(i.id))),
      input.rng,
    );
    if (next) return { type, item: key(next.id), fresh: true };
  }
  return null;
}

function sentence(
  input: PlanInput,
  maxWords: number,
  taken: Set<string>,
  { noNames = false, faithful = false } = {},
): Sentence | null {
  const { content, known } = input;
  const pool = content.poolLevel(input.level);
  const candidates: Sentence[] = [];
  for (let level = pool; level >= 0 && candidates.length < 400; level--) {
    const group = content.sentencesByLevel.get(LEVELS[level] ?? "");
    for (const s of shuffle(group ?? [], input.rng).slice(0, 400)) {
      const n = s.en.split(/\s+/).length;
      if (noNames && hasName(s.en)) continue;
      if (faithful && s.fit < GOOD_FIT) continue;
      if (n >= 4 && n <= maxWords && !input.usedSentences.has(s.id) && !taken.has(s.id)) {
        candidates.push(s);
      }
    }
  }
  // words the student already studied, among the ones that are taught (not "the", "is"...);
  // and a natural length: 5-7 words sound like real speech, 3-word Tatoeba lines often don't
  const score = (s: Sentence) => {
    const taught = s.words.map((id) => content.words.get(id)).filter((w) => w && teachable(w));
    const seen = taught.filter((w) => known.has(cardKey.word((w as Word).id))).length;
    const familiar = taught.length ? seen / taught.length : 0.5;
    return 2 * familiar - 0.15 * Math.abs(s.en.split(/\s+/).length - 6);
  };
  const best = candidates
    .map((s) => ({ s, score: score(s) }))
    .sort((a, b) => b.score - a.score)[0]?.s;
  if (best) taken.add(best.id);
  return best ?? null;
}

/** A sentence exercise. Spoken ones and dictation avoid names (Whisper spells them its own way);
 * one that shows the Portuguese needs a faithful pair, else it becomes the exercise that shows
 * the English instead (dictation, repeat), where the Portuguese is only a tip. */
function sentenceStep(
  input: PlanInput,
  type: SentenceType,
  maxWords: number,
  taken: Set<string>,
): Step | null {
  const spoken = type === "repeat" || type === "say";
  const noNames = spoken || type === "dictation";
  const s = sentence(input, maxWords, taken, { noNames, faithful: SHOWS_PT.has(type) });
  if (s) return { type, item: null, sentence: s.id };
  if (!SHOWS_PT.has(type)) return null;
  const other = sentence(input, maxWords, taken, { noNames: true });
  return other ? { type: spoken ? "repeat" : "dictation", item: null, sentence: other.id } : null;
}

function retestType(i: number): ExerciseType {
  return (["word", "listen", "cloze"] as const)[i % 3] as ExerciseType;
}

export function planLesson(input: PlanInput): Step[] {
  const rng = input.rng;
  const dueSteps = input.due.map(
    (d): Step => ({
      type: typeForCard(d.item, d.card, rng),
      item: d.item,
      ...(d.data ? { data: d.data } : {}),
    }),
  );
  if (input.kind === "review") return dueSteps.slice(0, LESSON_SIZE);

  const taken = new Set<string>();
  const extras: Step[] = [];
  const mistake = input.mistakes[0];
  if (mistake) extras.push({ type: "mistake", item: mistake.key, data: mistake.data, fresh: true });
  const backlog = input.due.length;
  if (backlog <= 20) {
    const trap = newTrap(input);
    if (trap) extras.push(trap);
  }
  const practice = (["order", "dictation", "translate"] as const)[input.lessonsDone % 3] ?? "order";
  const s1 = sentenceStep(input, practice, practice === "order" ? 8 : 10, taken);
  if (s1) extras.push(s1);
  const speaking = (["repeat", "say"] as const)[input.lessonsDone % 2] ?? "repeat";
  const s2 = sentenceStep(input, speaking, 9, taken);
  if (s2) extras.push(s2);

  let fresh = backlog > 12 ? 1 : backlog > 6 ? 2 : 3;
  const reviewRoom = Math.max(0, LESSON_SIZE - extras.length - 2 * fresh);
  const reviews = dueSteps.slice(0, reviewRoom);
  // not enough reviews yet (a new student): more new words fill the lesson
  const room = LESSON_SIZE - extras.length - reviews.length;
  fresh = Math.max(fresh, Math.min(4, Math.floor(room / 2)));
  const words = newWords(input, fresh);
  const intros: Step[] = words.map((item) => ({ type: "meaning", item, fresh: true }));

  // new words early (every other slot), each back RETEST_GAP exercises later in another shape,
  // the rest shuffled into the free slots
  const others = shuffle([...reviews, ...extras], rng);
  const total = 2 * intros.length + others.length;
  const slots: (Step | undefined)[] = new Array(total).fill(undefined);
  intros.forEach((intro, k) => {
    slots[2 * k] = intro;
  });
  intros.forEach((intro, k) => {
    const from = 2 * k + RETEST_GAP;
    let at = slots.findIndex((s, i) => i >= from && !s);
    if (at < 0) at = slots.findLastIndex((s, i) => i > 2 * k && !s);
    slots[at] = { type: retestType(k), item: intro.item };
  });
  const seq = slots.map((s) => s ?? (others.shift() as Step));
  return spreadAudio(seq.slice(0, LESSON_SIZE + 2));
}

/** No two exercises with audio in a row: each costs a voice note and a few seconds of TTS. */
export function spreadAudio(seq: Step[]): Step[] {
  const audio = (s: Step | undefined) => Boolean(s && AUDIO_TYPES.has(s.type));
  const rest = [...seq];
  const out: Step[] = [];
  while (rest.length) {
    // after an audio exercise, the next one without audio comes forward (order kept otherwise)
    const j = audio(out.at(-1)) ? rest.findIndex((s) => !audio(s)) : 0;
    out.push(rest.splice(Math.max(j, 0), 1)[0] as Step);
  }
  return out;
}
