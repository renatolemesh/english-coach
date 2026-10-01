/**
 * Exercises built on the fly from the content bank: the right answer plus distractors drawn
 * for this student now, so the same word comes back in a different shape each time.
 *
 * Distractor rules (from item-writing research): same part of speech and a nearby frequency
 * rank, never a synonym of the answer (its Portuguese glosses overlap), three options at most
 * (WhatsApp reply buttons, and the psychometric sweet spot).
 */
import { formatText } from "../domain/texts.js";
import { type CourseContent, GOOD_FIT, levelIndex, type Sentence, type Word } from "./content.js";
import { levenshtein, normalize } from "./grading.js";
import type { CourseTexts } from "./texts.js";

export const EXERCISE_TYPES = [
  "meaning", // EN word -> PT meaning (buttons)
  "word", // PT meaning -> EN word (buttons)
  "listen", // hear a word -> pick it (voice + buttons)
  "cloze", // sentence with a gap -> pick the word (buttons)
  "type", // PT meaning -> type the EN word
  "order", // numbered word tiles -> the sentence
  "dictation", // hear a sentence -> type it
  "translate", // PT sentence -> type it in English
  "repeat", // hear and read a sentence -> say it (voice)
  "say", // PT sentence -> say it in English (voice)
  "fix", // which sentence is correct? (Brazilian grammar traps)
  "false_friend", // what does this look-alike word mean?
  "pair", // minimal pair: which word did you hear?
  "chat", // complete the chat: the best reply
  "mistake", // a mistake the student made in the conversation
] as const;
export type ExerciseType = (typeof EXERCISE_TYPES)[number];

export const AUDIO_TYPES: ReadonlySet<ExerciseType> = new Set([
  "listen",
  "dictation",
  "repeat",
  "pair",
]);

/** A mistake from the free conversation (mistakes table), kept on its card. */
export interface MistakeData {
  original: string;
  correction: string;
  explanation: string;
}

/** One planned exercise (course_lessons.plan). */
export interface Step {
  type: ExerciseType;
  item: string | null; // card key; null for sentence practice
  sentence?: string | null;
  data?: MistakeData;
  fresh?: boolean; // first time the student sees this item
  ready?: Exercise; // built ahead so its audio could be rendered while the student answered
  level?: string; // placement test: the level this step tests
  ok?: boolean; // placement test: answered right
}

export interface Exercise {
  type: ExerciseType;
  item: string | null;
  sentence: string | null;
  nonce: string; // in the button ids: a tap on an old exercise is recognised
  body: string; // the question; header and feedback are added when sending
  mode: "choice" | "text" | "voice";
  options: string[];
  answer: number; // index of the right option (choice), -1 otherwise
  labelled: boolean; // options too long for buttons: listed as A) B) C) in the body
  accept: string[]; // text/voice: accepted answers, the first is shown
  tiles: string[]; // order: the tiles in the numbered order shown
  audio: string | null; // spoken (TTS) before the question
  reveal: string; // the answer, as shown after answering
  tip: string; // Portuguese note shown after answering
}

export interface GenContext {
  content: CourseContent;
  level: string; // the student's level
  texts: CourseTexts;
  rng: () => number;
}

export const BUTTON_CHARS = 20;
const LETTERS = ["A", "B", "C", "D", "E"];
const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
export const MAX_TILES = 8;

export const cardKey = {
  word: (id: string) => `w:${id}`,
  grammar: (id: string) => `g:${id}`,
  falseFriend: (id: string) => `ff:${id}`,
  pair: (id: string) => `mp:${id}`,
  chat: (id: string) => `c:${id}`,
};

export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export function pick<T>(items: readonly T[], rng: () => number): T | undefined {
  return items[Math.floor(rng() * items.length)];
}

export function nonce(rng: () => number): string {
  let s = "";
  for (let i = 0; i < 5; i++) s += "abcdefghjkmnpqrstuvwxyz23456789"[Math.floor(rng() * 31)];
  return s;
}

function base(g: GenContext, type: ExerciseType, item: string | null): Exercise {
  return {
    type,
    item,
    sentence: null,
    nonce: nonce(g.rng),
    body: "",
    mode: "choice",
    options: [],
    answer: -1,
    labelled: false,
    accept: [],
    tiles: [],
    audio: null,
    reveal: "",
    tip: "",
  };
}

/** The right option among distractors, shuffled; long options are listed in the body. */
function withOptions(ex: Exercise, right: string, wrong: string[], g: GenContext): Exercise {
  const options = shuffle([right, ...wrong], g.rng);
  return {
    ...ex,
    options,
    answer: options.indexOf(right),
    labelled: options.some((o) => [...o].length > BUTTON_CHARS),
  };
}

export function labelledOptions(options: readonly string[]): string {
  return options.map((o, i) => `*${LETTERS[i]})* ${o}`).join("\n");
}

export const optionLabel = (i: number) => LETTERS[i] ?? String(i + 1);

// --- words --------------------------------------------------------------------------------

const RANK_WINDOW = 400;

function sameMeaning(a: Word, b: Word): boolean {
  const ga = [a.gloss, ...a.alt].map(normalize);
  const gb = [b.gloss, ...b.alt].map(normalize);
  return ga.some((x) => gb.some((y) => x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `)));
}

/** Words that can stand next to `w` as wrong options. */
function neighbours(w: Word, g: GenContext, samePos = true): Word[] {
  const cap = Math.max(levelIndex(g.level), levelIndex(w.level)) + 1;
  const all = g.content.wordList.filter(
    (c) =>
      c.id !== w.id &&
      c.word !== w.word &&
      (!samePos || c.pos === w.pos) &&
      levelIndex(c.level) <= cap &&
      !sameMeaning(c, w),
  );
  const near = all.filter((c) => Math.abs(c.rank - w.rank) <= RANK_WINDOW);
  return near.length >= 6 ? near : all;
}

function distinctBy<T>(items: T[], key: (t: T) => string, n: number, taken: string[]): T[] {
  const seen = new Set(taken.map(normalize));
  const out: T[] = [];
  for (const item of items) {
    const k = normalize(key(item));
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
    if (out.length === n) break;
  }
  return out;
}

function exampleOf(w: Word, g: GenContext): Sentence | undefined {
  for (const id of w.examples) {
    const s = g.content.sentences.get(id);
    if (s) return s;
  }
  return undefined;
}

function meaning(w: Word, g: GenContext, item: string): Exercise | null {
  const wrong = distinctBy(shuffle(neighbours(w, g), g.rng), (c) => c.gloss, 2, [w.gloss]);
  if (wrong.length < 2) return null;
  const ex = exampleOf(w, g);
  const body = [
    formatText(g.texts.meaning, { word: w.word }),
    ex ? formatText(g.texts.example, { en: ex.en }) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...withOptions(
      base(g, "meaning", item),
      w.gloss,
      wrong.map((c) => c.gloss),
      g,
    ),
    body,
    reveal: `${w.word} = ${w.gloss}`,
    tip: ex ? `_${ex.en}_ = ${ex.pt}` : "",
  };
}

function wordChoice(w: Word, g: GenContext, item: string): Exercise | null {
  const wrong = distinctBy(shuffle(neighbours(w, g), g.rng), (c) => c.word, 2, [w.word]);
  if (wrong.length < 2) return null;
  return {
    ...withOptions(
      base(g, "word", item),
      w.word,
      wrong.map((c) => c.word),
      g,
    ),
    body: formatText(g.texts.word, { pt: w.gloss }),
    reveal: `${w.word} = ${w.gloss}`,
  };
}

function listen(w: Word, g: GenContext, item: string): Exercise | null {
  // words that look (and mostly sound) alike: the ear has to do the work
  const pool = neighbours(w, g, false).filter((c) => !c.word.includes(" "));
  const close = pool
    .map((c) => ({ c, d: levenshtein(c.word, w.word) + (c.word[0] === w.word[0] ? 0 : 1) }))
    .sort((a, b) => a.d - b.d || g.rng() - 0.5)
    .slice(0, 8)
    .map((x) => x.c);
  const wrong = distinctBy(shuffle(close, g.rng), (c) => c.word, 2, [w.word]);
  if (wrong.length < 2) return null;
  return {
    ...withOptions(
      base(g, "listen", item),
      w.word,
      wrong.map((c) => c.word),
      g,
    ),
    body: g.texts.listen,
    audio: `The word is: ${w.word}.`,
    reveal: `${w.word} = ${w.gloss}`,
  };
}

/** How a form is inflected, to inflect the distractors the same way. */
function shape(form: string, word: string): string {
  if (form === word) return "base";
  if (form.endsWith("ing")) return "ing";
  if (form.endsWith("ed")) return "ed";
  if (form.endsWith("s")) return "s";
  return "other";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function cloze(w: Word, g: GenContext, item: string): Exercise | null {
  const forms = [...new Set([w.word, ...w.forms])].sort((a, b) => b.length - a.length);
  for (const id of w.examples) {
    const s = g.content.sentences.get(id);
    if (!s || s.fit < GOOD_FIT) continue; // the translation is shown under the gap
    for (const form of forms) {
      const re = new RegExp(`(^|[^\\p{L}'])(${escapeRe(form)})(?=$|[^\\p{L}'])`, "iu");
      const m = re.exec(s.en);
      if (!m) continue;
      const used = (m[2] as string).toLowerCase();
      const kind = shape(used, w.word);
      const wrong: string[] = [];
      for (const c of shuffle(neighbours(w, g), g.rng)) {
        const f = [c.word, ...c.forms].find((x) => shape(x, c.word) === kind && !x.includes(" "));
        if (f && f !== used && !wrong.includes(f)) wrong.push(f);
        if (wrong.length === 2) break;
      }
      if (wrong.length < 2) continue;
      const gap = s.en.replace(re, "$1___");
      return {
        ...withOptions(base(g, "cloze", item), used, wrong, g),
        sentence: s.id,
        body: formatText(g.texts.cloze, { sentence: gap, pt: s.pt }),
        reveal: s.en.replace(re, `$1${m[2]}`),
        tip: `${w.word} = ${w.gloss}`,
      };
    }
  }
  return null;
}

function typeWord(w: Word, g: GenContext, item: string): Exercise {
  return {
    ...base(g, "type", item),
    mode: "text",
    body: formatText(g.texts.type, { pt: w.gloss }),
    accept: [w.word],
    reveal: w.word,
    tip: exampleOf(w, g)?.en ? `_${exampleOf(w, g)?.en}_` : "",
  };
}

// --- sentences ----------------------------------------------------------------------------

/** "This is my house." -> ["this", "is", "my", "house"]: the first word loses its capital
 * unless it is "I" or a name (not in the word bank: "Lucas took Ana with him."). */
export function tilesOf(en: string, isWord: (w: string) => boolean = () => true): string[] {
  const words = en
    .replace(/[.!?]+$/, "")
    .split(/\s+/)
    .filter(Boolean);
  return words.map((w, i) => {
    const bare = w.replace(/[,;:]$/, "");
    const lower = bare.charAt(0).toLowerCase() + bare.slice(1);
    if (i > 0 || bare === "I" || bare.startsWith("I'") || !isWord(lower)) return bare;
    return lower;
  });
}

/** A name in the sentence (a capital after the first word, "I" aside): Whisper spells names
 * its own way (Ana -> Anna), so spoken and dictation exercises avoid them. */
export const hasName = (en: string) => /\s(?!I\b|I')[A-Z]/.test(en);

function order(s: Sentence, g: GenContext): Exercise | null {
  const right = tilesOf(s.en, (w) => g.content.isWord(w));
  if (right.length < 4 || right.length > MAX_TILES) return null; // 3 tiles is a giveaway
  let tiles = shuffle(right, g.rng);
  for (let i = 0; i < 5 && tiles.join(" ") === right.join(" "); i++) tiles = shuffle(right, g.rng);
  const shown = tiles.map((t, i) => `${KEYCAPS[i]} ${t}`).join("   ");
  return {
    ...base(g, "order", null),
    sentence: s.id,
    mode: "text",
    body: formatText(g.texts.order, { pt: s.pt, tiles: shown }),
    tiles,
    accept: [s.en],
    reveal: s.en,
  };
}

function dictation(s: Sentence, g: GenContext): Exercise {
  return {
    ...base(g, "dictation", null),
    sentence: s.id,
    mode: "text",
    body: g.texts.dictation,
    audio: s.en,
    accept: [s.en],
    reveal: s.en,
    tip: s.pt,
  };
}

function translate(s: Sentence, g: GenContext): Exercise {
  return {
    ...base(g, "translate", null),
    sentence: s.id,
    mode: "text",
    body: formatText(g.texts.translate, { pt: s.pt }),
    accept: [s.en, ...s.alt_en],
    reveal: s.en,
  };
}

function repeat(s: Sentence, g: GenContext): Exercise {
  return {
    ...base(g, "repeat", null),
    sentence: s.id,
    mode: "voice",
    body: formatText(g.texts.repeat, { en: s.en }),
    audio: s.en,
    accept: [s.en],
    reveal: s.en,
    tip: s.pt,
  };
}

function say(s: Sentence, g: GenContext): Exercise {
  return {
    ...base(g, "say", null),
    sentence: s.id,
    mode: "voice",
    body: formatText(g.texts.say, { pt: s.pt }),
    accept: [s.en, ...s.alt_en],
    reveal: s.en,
  };
}

// --- traps and personal mistakes ------------------------------------------------------------

function fix(id: string, g: GenContext, item: string): Exercise | null {
  const trap = g.content.grammar.get(id);
  if (!trap) return null;
  const ex = withOptions(base(g, "fix", item), trap.right, trap.wrong, g);
  return {
    ...ex,
    labelled: true, // sentences: listed in the body, buttons A/B/C
    body: formatText(g.texts.fix, { pt: trap.pt, options: labelledOptions(ex.options) }),
    reveal: trap.right,
    tip: trap.tip,
  };
}

function falseFriend(id: string, g: GenContext, item: string): Exercise | null {
  const ff = g.content.falseFriends.get(id);
  if (!ff) return null;
  return {
    ...withOptions(base(g, "false_friend", item), ff.meaning, [ff.trap, ff.other], g),
    body: formatText(g.texts.falseFriend, { word: ff.word }),
    reveal: `${ff.word} = ${ff.meaning}`,
    tip: [ff.tip, `_${ff.example.en}_ = ${ff.example.pt}`].filter(Boolean).join("\n"),
  };
}

function pair(id: string, g: GenContext, item: string): Exercise | null {
  const mp = g.content.pairs.get(id);
  if (!mp) return null;
  const target = pick(mp.words, g.rng) as string;
  const options = shuffle(mp.words, g.rng);
  return {
    ...base(g, "pair", item),
    options,
    answer: options.indexOf(target),
    body: formatText(g.texts.pair, { sound: g.content.sounds[mp.sound] ?? mp.sound }),
    audio: `The word is: ${target}.`,
    reveal: target,
    tip: mp.tip,
  };
}

function chat(id: string, g: GenContext, item: string): Exercise | null {
  const c = g.content.chats.get(id);
  if (!c) return null;
  const [right, ...wrong] = c.options as [string, ...string[]];
  const ex = withOptions(base(g, "chat", item), right, wrong, g);
  const them = c.them.map((line) => `👤 _${line}_`).join("\n");
  const body = formatText(g.texts.chat, { context: c.context, them });
  return {
    ...ex,
    body: ex.labelled ? `${body}\n\n${labelledOptions(ex.options)}` : body,
    reveal: right,
    tip: c.tip,
  };
}

function mistake(data: MistakeData, g: GenContext, item: string): Exercise {
  const ex = withOptions(base(g, "mistake", item), data.correction, [data.original], g);
  const body = formatText(g.texts.mistake, { said: data.original });
  return {
    ...ex,
    body: ex.labelled ? `${body}\n\n${labelledOptions(ex.options)}` : body,
    reveal: data.correction,
    tip: data.explanation,
  };
}

/** The exercise for a planned step, or null when it cannot be built (then another type). */
export function makeExercise(step: Step, g: GenContext): Exercise | null {
  const item = step.item;
  const [prefix, id = ""] = item ? (item.split(/:(.*)/s) as [string, string]) : ["", ""];
  if (prefix === "w") {
    const w = g.content.words.get(id);
    if (!w || !item) return null;
    if (step.type === "meaning") return meaning(w, g, item);
    if (step.type === "word") return wordChoice(w, g, item);
    if (step.type === "listen") return listen(w, g, item);
    if (step.type === "cloze") return cloze(w, g, item);
    if (step.type === "type") return typeWord(w, g, item);
    return null;
  }
  if (item && prefix === "g") return fix(id, g, item);
  if (item && prefix === "ff") return falseFriend(id, g, item);
  if (item && prefix === "mp") return pair(id, g, item);
  if (item && prefix === "c") return chat(id, g, item);
  if (item && prefix === "m" && step.data) return mistake(step.data, g, item);
  const s = step.sentence ? g.content.sentences.get(step.sentence) : undefined;
  if (!s) return null;
  if (step.type === "order") return order(s, g);
  if (step.type === "dictation") return dictation(s, g);
  if (step.type === "translate") return translate(s, g);
  if (step.type === "repeat") return repeat(s, g);
  if (step.type === "say") return say(s, g);
  return null;
}

/** When a word exercise cannot be built (no example for a cloze...), the plainer ones. */
export function fallbackTypes(type: ExerciseType): ExerciseType[] {
  if (type === "cloze" || type === "listen" || type === "type") return ["word", "meaning"];
  if (type === "word") return ["meaning"];
  return [];
}
