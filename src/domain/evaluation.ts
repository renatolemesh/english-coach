/**
 * Evaluation of one student answer (output of the `evaluate_answer` prompt).
 *
 * Every field has a description: it is exported to schemas/evaluation.schema.json and sent to
 * the model as a strict JSON schema. Numeric/length bounds are enforced here by Zod (not sent on
 * the wire, since provider support for those keywords varies).
 */
import { z } from "zod";
import { type Opcode, SequenceMatcher } from "./sequence-matcher.js";

// 'pronunciation': speech recognition wrote a non-word the way it sounded ('Konshinui'), and
// sound + context say which word it was ('continue'): a pronunciation hint.
// 'unclear': a fragment that makes no sense and matches no word; nobody can tell what the
// student meant, so there is no correction, only a request to say it again.
export const MistakeType = z.enum([
  "grammar",
  "vocabulary",
  "word_choice",
  "pronunciation",
  "other",
  "unclear",
]);
export type MistakeType = z.infer<typeof MistakeType>;

export const MAX_MISTAKES = 8;
export const MAX_STRENGTHS = 5;

export const Mistake = z
  .object({
    original: z
      .string()
      .max(300)
      .describe("Exact fragment the student said, copied from the transcript."),
    correction: z
      .string()
      .max(300)
      .describe("Single best corrected version of that fragment (one option)."),
    type: MistakeType.describe(
      "Category of the mistake. 'pronunciation': a word that is not English, " +
        "written the way it sounded, and the English word it most likely was (by sound and " +
        "context) is the correction. 'unclear': words that match no plausible English at all; " +
        "then 'correction' repeats 'original' exactly.",
    ),
    explanation: z
      .string()
      .max(400)
      .describe("Short explanation in simple English (1-2 sentences) of why it is wrong."),
  })
  .strict();
export type Mistake = z.infer<typeof Mistake>;

const subScore = () => z.number().int().min(0).max(100);

export const ScoreBreakdown = z
  .object({
    grammar: subScore().describe("Grammar accuracy, 0-100."),
    vocabulary: subScore().describe("Range and precision of vocabulary, 0-100."),
    fluency: subScore().describe("Naturalness and flow of the sentences, 0-100."),
    task: subScore().describe("How well the answer addresses the topic, 0-100."),
  })
  .strict();
export type ScoreBreakdown = z.infer<typeof ScoreBreakdown>;

export const Evaluation = z
  .object({
    transcript: z.string().describe("The student's answer exactly as received."),
    corrected: z
      .string()
      .describe("The whole answer rewritten in natural, correct English, same meaning."),
    score: subScore().describe("Overall score 0-100 for the student's level."),
    score_breakdown: ScoreBreakdown.describe("Sub-scores, each 0-100."),
    mistakes: z
      .array(Mistake)
      .max(MAX_MISTAKES)
      .describe(`Most important mistakes, at most ${MAX_MISTAKES}. Empty if none.`),
    strengths: z
      .array(z.string())
      .max(MAX_STRENGTHS)
      .describe(`What the student did well, in simple English, at most ${MAX_STRENGTHS}.`),
    tip: z.string().max(400).describe("One practical tip in simple English for the next answer."),
  })
  .strict();
export type Evaluation = z.infer<typeof Evaluation>;

// --- post-processing -------------------------------------------------------------------------
// Deterministic checks on what the model returned. The prompt asks for all of this, but free
// models drift. Everything works on words (not substrings: "is" must not match inside "this"),
// compared the way speech recognition output should be: no case, accents, punctuation or
// stuttered repeats. A mistake is repaired when possible and dropped only when it changes
// nothing or is not in the answer.

export const TASK_CAP_BELOW = 50; // an answer that does not really answer the question...
export const TASK_CAP_BASE = 50; // ...scores at most this + task/2 overall
export const LONG_FRAGMENT_WORDS = 6; // longer 'original's are shrunk to the words that change
export const SAME_CASE = "Same as the previous item.";
// When every sentence of the model's tip had to go: one for answers that missed the question,
// one for answers that did answer it (a full, correct sentence must not hear "use full sentences")
export const DEFAULT_TIP = "Next time, try to answer the question with one or two full sentences.";
export const DEFAULT_TIP_GOOD = "Nice answer! Next time, try adding one more detail or example.";
export const NO_MISTAKE_FLOOR = 80; // vocabulary of an answer with no mistakes
export const NO_MISTAKE_GRAMMAR = 90; // grammar of an answer with no mistakes
export const GRAMMAR_PER_MISTAKE = 15; // one missing article must not cost 60 grammar points
export const UNCLEAR_FLUENCY_FLOOR = 70; // a garbled recording is not the student's fluency
export const MIN_UNCLEAR_WORDS = 5; // a short fluent phrase ('Like about two years') is never 'unclear'
export const SHORT_WORD_CHARS = 4; // a lone short word ('is', 'have') gets the word before it
export const INVENTED_WORDS = 3; // a correction adding this many content words the student never said
export const UNCLEAR =
  "I couldn't understand this part, maybe because of the audio. Try saying it again slowly.";
export const FUZZY_MIN_RATIO = 0.75;

// --- Unicode-aware text helpers ---------------------------------------------------------------
// Word, space and word-boundary classes that are Unicode-aware (JS's \w and \b are ASCII-only
// even with the `u` flag).
const W = "\\p{L}\\p{N}_"; // word characters: letters, numbers, '_' (a character-class body)
// whitespace: JS \s minus U+FEFF, plus U+001C-U+001F and U+0085
const S =
  "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const B = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`; // Unicode word boundary
const SPLIT_RE = new RegExp(`[${S}]+`, "u");
const STRIP_RE = new RegExp(`^[${S}]+|[${S}]+$`, "gu");

/** Split on runs of whitespace, no empty strings. */
function split(text: string): string[] {
  return text.split(SPLIT_RE).filter((w) => w !== "");
}

/** Strip Unicode whitespace, or the given characters, from both ends. */
function strip(text: string, chars?: string): string {
  if (chars === undefined) return text.replace(STRIP_RE, "");
  const cps = [...text];
  let i = 0;
  let j = cps.length;
  while (i < j && chars.includes(cps[i] as string)) i++;
  while (j > i && chars.includes(cps[j - 1] as string)) j--;
  return cps.slice(i, j).join("");
}

/** The first n code points (not UTF-16 units). */
function head(text: string, n: number): string {
  return [...text].slice(0, n).join("");
}

/** Length in code points. */
function len(text: string): number {
  return [...text].length;
}

/** Round to an integer; halves go to the even neighbour. */
function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

const combiningCache = new Map<string, boolean>();
/** Whether ch has a nonzero canonical combining class, exactly: canonical ordering moves a mark with a
 *  nonzero class in front of U+0345 (class 240, the highest); a starter (class 0) stays. */
function combining(ch: string): boolean {
  let known = combiningCache.get(ch);
  if (known === undefined) {
    known = ch === "ͅ" || !`ͅ${ch}`.normalize("NFD").startsWith("ͅ");
    combiningCache.set(ch, known);
  }
  return known;
}

function dropCombining(text: string): string {
  let out = "";
  for (const ch of text) if (!combining(ch)) out += ch;
  return out;
}

const LOWER_RE = /^\p{Lowercase}/u; // one-character str.islower()
const UPPER_RE = /^\p{Uppercase}/u; // one-character str.isupper()

// --- regexes ----------------------------------------------------------------------------------
const MEMORY_RE = new RegExp(
  `[^.!?]*(${B}(made|making)[${S}]+(this|that|the[${S}]+same)[${S}]+mistake[${S}]+(before|again)` +
    `|${B}j[aá][${S}]+(errou|cometeu|tinha[${S}]+errado))[^.!?]*[.!?]?[${S}]*`,
  "giu",
);
const PUNCT_RE = new RegExp(`[^${W}${S}']|(?<![${W}])'|'(?![${W}])`, "gu"); // keeps don't, drops 'quotes'
const REPEAT_RE = new RegExp(`${B}([${W}]+)([${S}]+\\1${B})+`, "gu");
// a closing quote after the full stop stays with its sentence: "... 'five years.' Use ..."
const SENTENCE_RE = /[^.!?]+[.!?]*['"’”]?/gu;
const QUOTED_RE = /'[^']*'|"[^"]*"|‘[^’]*’|“[^”]*”/gu;
// "The sentence is correct", "'Usually I work' is correct, but"
const SAYS_CORRECT_RE = new RegExp(
  `${B}(sentence|answer|it|this)[${S}]+(is|was)[${S}]+(already[${S}]+|also[${S}]+)?(correct|fine|ok)${B}` +
    `|${B}(is|was)[${S}]+(already[${S}]+|also[${S}]+|grammatically[${S}]+)?(correct|fine|ok),?[${S}]+but${B}`,
  "iu",
);
const PUNCTUATION_RE = new RegExp(`${B}(punctuation|semicolons?|commas?)${B}`, "iu"); // not "period": time
const CAPITALIZATION_RE = new RegExp(
  `[^.!?]*${B}(mai[uú]scul[${W}]*|capital[${S}]+letter[${W}]*|capitali[sz][${W}]*)[^.!?]*[.!?]?[${S}]*`,
  "giu",
);
const GARBLED_RE = new RegExp(`${B}[${W}]*[a-zà-ú][A-Z][${W}]*`, "gu"); // "maisEducation": noise inside a word

/** (normalized, raw) per word. */
export type Words = [norm: string, raw: string][];

const norms = (words: Words): string[] => words.map(([n]) => n);

function sameList<T>(x: readonly T[], y: readonly T[]): boolean {
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function sameWords(x: Words, y: Words): boolean {
  return x.length === y.length && x.every(([n, r], i) => n === y[i]?.[0] && r === y[i]?.[1]);
}

function isSubset(set: Set<string>, of: ReadonlySet<string>): boolean {
  for (const v of set) if (!of.has(v)) return false;
  return true;
}

function nonEqualOpcodes(a: string[], b: string[]): Opcode[] {
  return new SequenceMatcher(a, b).getOpcodes().filter((op) => op[0] !== "equal");
}

export function normalize(text: string): string {
  const t = dropCombining(text.toLowerCase().normalize("NFKD"));
  return split(t.replace(PUNCT_RE, " ")).join(" ").replace(REPEAT_RE, "$1");
}

/** (normalized, raw) per word; punctuation-only tokens and stuttered repeats are skipped. */
function words(text: string): Words {
  const out: Words = [];
  for (const raw of split(text)) {
    // 'well-known' -> 'well' + 'known' (as normalize(text).split() sees it); the raw word
    // goes with the first part only, so joining gives it back once
    split(normalize(raw)).forEach((norm, n) => {
      if (!(out.length && out[out.length - 1]?.[0] === norm)) out.push([norm, n === 0 ? raw : ""]);
    });
  }
  return out;
}

function join(ws: Words): string {
  return strip(
    ws
      .filter(([, raw]) => raw)
      .map(([, raw]) => raw)
      .join(" "),
    " .,;:!?",
  );
}

/** 0.75 x language + 0.25 x task; an answer that does not answer the question is capped
 *  (task 0 -> 50, task 30 -> 65, no cap from task 50 on). */
export function overallScore(breakdown: ScoreBreakdown): number {
  const language = (breakdown.grammar + breakdown.vocabulary + breakdown.fluency) / 3;
  let score = roundHalfEven(0.75 * language + 0.25 * breakdown.task);
  if (breakdown.task < TASK_CAP_BELOW) {
    score = Math.min(score, TASK_CAP_BASE + Math.floor(breakdown.task / 2));
  }
  return score;
}

const ENGLISH_HINTS: ReadonlySet<string> = new Set(
  // none of these is also Portuguese ('a', 'use' are)
  split(
    "is are was the an you your this it's very good great correct never also after before " +
      "always instead when with for of to and it we they not say means need only more natural " +
      "sounds",
  ),
);
const PORTUGUESE_HINTS: ReadonlySet<string> = new Set(
  // none of these is also English
  split(
    "o os um uma de da em com para que voce sua seu muito bem boa bom frase uso " +
      "esta foi na nos nas ao mas ou nao usamos quando depois antes aqui",
  ),
);

/** A sentence written in Portuguese ("Use o simple past.") instead of English. Quoted words
 *  do not count: "'Pretend' means 'fingir'." is English with a Portuguese example. */
function portuguese(text: string): boolean {
  const unquoted = text.replace(QUOTED_RE, " ");
  const ws = split(normalize(unquoted));
  const english = ws.filter((w) => ENGLISH_HINTS.has(w)).length;
  const pt = ws.filter((w) => PORTUGUESE_HINTS.has(w)).length;
  return pt > english || (accentedWord(unquoted) && english === 0);
}

/** A lowercase word with an accent ('saudação'); names ('São Paulo') are capitalized. */
function accentedWord(text: string): boolean {
  return split(text).some(
    (w) => LOWER_RE.test(w) && [...w.normalize("NFKD")].some((ch) => combining(ch)),
  );
}

const ARTICLES: ReadonlySet<string> = new Set(["the", "a", "an"]);
const REGISTER_FROM: ReadonlySet<string> = new Set(["i", "want", "need", "give", "me"]);
const REGISTER_TO: ReadonlySet<string> = new Set(
  split("i'd i would like could can have please may"),
);
const STOPWORDS: ReadonlySet<string> = new Set(
  split(
    "the a an to of in on at for and or but is are was were be i you he she it we they my your " +
      "his her its our their me him us them this that there have has had do does did",
  ),
);
const FILLERS: ReadonlySet<string> = new Set(split("um uh er erm hmm ah"));
const DISCOURSE: ReadonlySet<string> = new Set([
  ...FILLERS,
  ...split("yes yeah no well so like oh okay ok and but actually"),
]);
// glue words the model adds or drops
const NOISE: ReadonlySet<string> = new Set([...FILLERS, "and", "but", "so", "or", "well"]);
const BRANDS: ReadonlySet<string> = new Set(
  split(
    "youtube whatsapp iphone ipad mcdonald's mcdonalds linkedin tiktok " +
      "playstation paypal ebay imac macbook",
  ),
);
const PRONOUNS: ReadonlySet<string> = new Set(split("i we you he she they it"));

function changes(mistake: Mistake): [string[], string[], Opcode[]] {
  const o = norms(words(mistake.original));
  const c = norms(words(mistake.correction));
  return [o, c, nonEqualOpcodes(o, c)];
}

/** Why a 'mistake' is not one, or null. Free models invent these even when told not to. */
export function implausible(
  mistake: Mistake,
  corrected: ReadonlySet<string>,
  answer: Words,
): string | null {
  const [o, c, ops] = changes(mistake);
  const removed = new Set(ops.flatMap(([, i1, i2]) => o.slice(i1, i2)));
  const added = new Set(ops.flatMap(([, , , j1, j2]) => c.slice(j1, j2)));
  if (ops.length && !removed.size && isSubset(added, ARTICLES)) {
    // an article was only inserted
    if (ops.some(([, i1]) => i1 > 0 && o[i1 - 1] === "play")) {
      return "play_instrument"; // 'play guitar' is fine in American English
    }
    if (ops.some(([, i1]) => isName(answer, o, i1))) {
      return "article_before_name"; // 'Foo Fighters' -> 'the Foo Fighters'
    }
  }
  if (ops.length && !added.size && isSubset(removed, DISCOURSE)) {
    return "discourse_word"; // 'Yes I went' -> 'I went': 'yes' answers the question
  }
  if (PUNCTUATION_RE.test(mistake.explanation)) {
    return "punctuation"; // 'add a semicolon between the clauses': speech has none
  }
  if (SAYS_CORRECT_RE.test(mistake.explanation)) {
    return "says_correct"; // "The sentence is correct, but ..." is not a mistake
  }
  const wanting = ["want", "need", "give"].some((w) => removed.has(w));
  if (ops.length && wanting && isSubset(removed, REGISTER_FROM) && isSubset(added, REGISTER_TO)) {
    return "register"; // 'I want' -> "I'd like" is politeness, not a mistake
  }
  const content = [...added].filter((w) => !STOPWORDS.has(w) && len(w) > 2);
  if (corrected.size && content.length && !content.some((w) => corrected.has(w))) {
    return "not_in_corrected"; // 'their show' -> 'the Foo Fighters', corrected keeps it
  }
  return null;
}

/** Is original[at] capitalized in the answer, and not just because a sentence starts? */
function isName(answer: Words, original: string[], at: number): boolean {
  const starts = findAll(norms(answer), original);
  if (!starts.length || at >= original.length) return false;
  const i = (starts[0] as number) + at;
  const raw = answer[i]?.[1] ?? "";
  const prev = answer[i - 1]?.[1] ?? "";
  const sentenceStart = i === 0 || [".", "!", "?"].some((p) => prev.endsWith(p));
  return UPPER_RE.test(raw) && !sentenceStart;
}

/** Model noise in feedback text: 'maisEducation', or CJK characters ('comum em英语'). */
function garbled(text: string): boolean {
  for (const ch of text) if ((ch.codePointAt(0) as number) >= 0x2e80) return true;
  return [...text.matchAll(GARBLED_RE)].some((m) => !BRANDS.has(m[0].toLowerCase()));
}

/** The student's own answer as a clean sentence: no fillers or stuttered repeats. */
function tidy(text: string): string {
  const kept = words(text)
    .filter(([norm, raw]) => raw && !FILLERS.has(norm)) // 'a.m.': 1 raw
    .map(([, raw]) => raw);
  let out = strip(kept.join(" "), " ,");
  if (out && !".!?".includes(out.slice(-1))) out += ".";
  return head(out, 1).toUpperCase() + [...out].slice(1).join("");
}

/** A mistake located in the answer: it replaces answer[start : start + orig.length]. */
class Piece {
  constructor(
    readonly start: number,
    readonly orig: Words,
    readonly corr: Words,
  ) {}

  get end(): number {
    return this.start + this.orig.length;
  }

  changes(): boolean {
    return !sameList(norms(this.orig), norms(this.corr));
  }
}

/** Start of the window of the same length most similar to `needle` (>= 75% of words). */
function fuzzyFind(haystack: string[], needle: string[]): number[] {
  const size = needle.length;
  let best = 0.0;
  let where = -1;
  for (let i = 0; i < haystack.length - size + 1; i++) {
    const ratio = new SequenceMatcher(needle, haystack.slice(i, i + size)).ratio();
    if (ratio > best) {
      best = ratio;
      where = i;
    }
  }
  return best >= FUZZY_MIN_RATIO && size >= 3 ? [where] : [];
}

function findAll(haystack: string[], needle: string[]): number[] {
  const size = needle.length;
  const out: number[] = [];
  for (let i = 0; i < haystack.length - size + 1; i++) {
    if (sameList(haystack.slice(i, i + size), needle)) out.push(i);
  }
  return out;
}

/** The answer -> corrected diff around answer[start:end], as [s, e, js, je]: replacing
 *  answer[s:e] with corrected[js:je] gives the corrected text there. Glue words the model
 *  adds or drops (and, so, um) are ignored. null when no change touches the span. */
function alignedSpan(
  a: string[],
  c: string[],
  ops: Opcode[],
  start: number,
  end: number,
): [number, number, number, number] | null {
  const noise = ([tag, i1, i2, j1, j2]: Opcode): boolean =>
    (tag === "insert" || tag === "delete") &&
    [...a.slice(i1, i2), ...c.slice(j1, j2)].every((w) => NOISE.has(w));
  const touches = ([, i1, i2]: Opcode): boolean =>
    (i1 < end && i2 > start) || (i1 === i2 && start <= i1 && i1 <= end);

  const touching = ops.filter((op) => op[0] !== "equal" && !noise(op) && touches(op));
  if (!touching.length) return null;
  const s = Math.min(start, ...touching.map((op) => op[1]));
  const e = Math.max(end, ...touching.map((op) => op[2]));
  let js: number | null = null;
  let je: number | null = null;
  for (const op of ops) {
    const [tag, i1, i2, j1, j2] = op;
    if (tag === "equal") {
      if (js === null && i1 <= s && s < i2) js = j1 + (s - i1);
      if (i1 < e && e <= i2) je = j1 + (e - i1);
    } else if (!noise(op)) {
      if (js === null && i1 === s) js = j1;
      if (i2 === e && (i1 < i2 || touching.some((t) => sameList(t, op)))) je = j2;
    }
  }
  if (js === null || je === null || je <= js) return null;
  return [s, e, js, je];
}

/** Find the mistake in the answer and line it up with the corrected text. With a repeated
 *  fragment ('was' in 'When I was child ... we was happy'), the occurrence whose change in
 *  'corrected' matches the model's correction wins. Returns [piece or null, note]. */
export function locate(
  mistake: Mistake,
  answer: Words,
  corrected: Words,
  ops: Opcode[],
): [Piece | null, string] {
  const orig = words(mistake.original);
  const corr = words(mistake.correction);
  let o = norms(orig);
  const c = norms(corr);
  if (!o.length || sameList(o, c)) return [null, "no_change"];
  const a = norms(answer);
  const cw = norms(corrected);
  let starts = findAll(a, o);
  let note = "";
  if (!starts.length) {
    // copied with a slip ('stayed at a hotel' for 'stayed in a hotel')?
    starts = fuzzyFind(a, o);
    note = "fuzzy";
    if (!starts.length) return [null, "not_in_answer"];
    o = a.slice(starts[0], (starts[0] as number) + o.length);
  }
  const oSet = new Set(o);
  const added = new Set(c.filter((w) => !oSet.has(w)));
  const span = (at: number) => (cw.length ? alignedSpan(a, cw, ops, at, at + o.length) : null);
  const fitness = (at: number): number => {
    const sp = span(at);
    return sp ? new Set(cw.slice(sp[2], sp[3]).filter((w) => added.has(w))).size : 0;
  };

  let start = starts[0] as number; // ties: the first one
  let bestFit = fitness(start);
  for (const at of starts.slice(1)) {
    const f = fitness(at);
    if (f > bestFit) {
      start = at;
      bestFit = f;
    }
  }
  note = note || (start !== starts[0] ? "moved" : "");
  const found = span(start);
  if (found) {
    const [s0, e, js, je] = found;
    let s = s0;
    let fixed = corrected.slice(js, je);
    while (fixed.length > 1 && NOISE.has(fixed[0]?.[0] as string) && fixed[0]?.[0] !== a[s]) {
      fixed = fixed.slice(1); // 'I play' -> 'and I've been playing': the 'and' joins sentences
    }
    while (e - s > 1 && NOISE.has(a[s] as string) && fixed.length && fixed[0]?.[0] !== a[s]) {
      s += 1; // 'and in the night' -> 'At night': the 'and' was not the mistake
    }
    const as = a[s] as string;
    if (PRONOUNS.has(as) && fixed.length && !(fixed[0] as [string, string])[0].startsWith(as)) {
      fixed = [answer[s] as [string, string], ...fixed]; // 'we make' -> 'did' -> 'we did'
    }
    const piece = new Piece(s, answer.slice(s, e), fixed);
    if (piece.changes()) {
      if (s !== start || e !== start + o.length || !sameList(norms(fixed), c)) {
        note = note || "aligned";
      }
      return [piece, note];
    }
  }
  return [new Piece(start, answer.slice(start, start + o.length), corr), note];
}

/** Long pieces: keep what changes plus one word each side; changes separated by 2+
 *  unchanged words become separate pieces (they never share a word). */
function splitPiece(piece: Piece): Piece[] {
  if (piece.orig.length <= LONG_FRAGMENT_WORDS) return [piece];
  const o = norms(piece.orig);
  const c = norms(piece.corr);
  const groups: Opcode[][] = [];
  for (const op of nonEqualOpcodes(o, c)) {
    const last = groups[groups.length - 1];
    if (last && op[1] - (last[last.length - 1] as Opcode)[2] < 2) last.push(op);
    else groups.push([op]);
  }
  return groups.map((group) => {
    const first = group[0] as Opcode;
    const lastOp = group[group.length - 1] as Opcode;
    const [i1, j1, i2, j2] = [first[1], first[3], lastOp[2], lastOp[4]];
    const left = Math.min(1, i1, j1);
    const right = Math.min(1, o.length - i2, c.length - j2);
    return new Piece(
      piece.start + i1 - left,
      piece.orig.slice(i1 - left, i2 + right),
      piece.corr.slice(j1 - left, j2 + right),
    );
  });
}

/** A lone short word ('is' -> 'are') gets the word before it: 'people is' -> 'people are'. */
function widen(piece: Piece, answer: Words): Piece {
  const o = norms(piece.orig);
  if (o.length === 1 && len(o[0] as string) <= SHORT_WORD_CHARS && piece.start > 0) {
    const before = answer[piece.start - 1] as [string, string];
    return new Piece(piece.start - 1, [before, ...piece.orig], [before, ...piece.corr]);
  }
  return piece;
}

function sentences(text: string): string[] {
  return text.match(SENTENCE_RE) ?? [];
}

/** 'Use o simple past.' in English feedback: Portuguese is only for quoted examples. */
function dropPortugueseSentences(text: string): string {
  const t = text.replace(CAPITALIZATION_RE, ""); // speech has no capitals: never a mistake
  return strip(
    sentences(t)
      .filter((s) => !portuguese(s) && !garbled(s))
      .join(""),
  );
}

interface Candidate {
  index: number; // model position
  part: number; // parts > 0 were cut out of one mistake
  start: number;
  end: number;
  mistake: Mistake;
}

/** Repair or drop mistakes that cannot be right, fix derived fields.
 *  Returns [evaluation, notes about what changed]. */
export function cleanEvaluation(
  evaluation: Evaluation,
  hasMemory: boolean,
): [Evaluation, string[]] {
  const answer = words(evaluation.transcript);
  const corrected = new Set(split(normalize(evaluation.corrected)));
  const correctedWords = words(evaluation.corrected);
  const ops = new SequenceMatcher(norms(answer), norms(correctedWords)).getOpcodes();
  const candidates: Candidate[] = [];
  const notes: string[] = [];
  const dropped: string[] = []; // corrections the tip must not teach either
  const said = new Set(norms(answer));
  let correctedText = evaluation.corrected;
  evaluation.mistakes.forEach((m, index) => {
    if (m.type === "unclear" || invented(m, said)) {
      // 'I work has been show use' -> 'I have been working as a software engineer for
      // five years' (taken from the history): a guess, not a correction
      if (m.type !== "unclear") {
        notes.push(`invented:${head(m.original, 40)}`);
        dropped.push(normalize(m.correction));
        correctedText = unguess(correctedText, m);
      }
      const found = unclear(m, answer);
      if (m.type === "unclear" && split(m.original).length < MIN_UNCLEAR_WORDS) {
        notes.push(`short_unclear:${head(m.original, 40)}`); // clear, just off-question
      } else if (found) {
        candidates.push({ index, part: 0, ...found });
      } else {
        notes.push(`not_in_answer:${head(m.original, 40)}`);
      }
      return;
    }
    if (m.type === "pronunciation") {
      // one word swapped: no alignment, no widening
      const found = unclear(m, answer);
      if (found) {
        const { start, end } = found;
        const fixed = { ...m, original: join(answer.slice(start, end)) };
        candidates.push({ index, part: 0, start, end, mistake: fixed });
      } else {
        notes.push(`not_in_answer:${head(m.original, 40)}`);
      }
      return;
    }
    const reason = implausible(m, corrected, answer);
    if (reason) {
      notes.push(`${reason}:${head(m.original, 40)}`);
      dropped.push(normalize(m.correction));
      return;
    }
    let explanation = dropPortugueseSentences(m.explanation) || m.explanation;
    if (!hasMemory) explanation = stripMemory(explanation);
    const [piece, located] = locate(m, answer, correctedWords, ops);
    const parts = piece ? splitPiece(piece) : [];
    let note = located;
    if (
      parts.length > 1 ||
      (piece && parts.length && !sameWords(parts[0]?.orig ?? [], piece.orig))
    ) {
      note = parts.length === 1 ? "shrunk" : "split";
    }
    if (note) notes.push(`${note}:${head(m.original, 40)}`);
    parts
      .map((p) => widen(p, answer))
      .forEach((part, n) => {
        if (!part.changes()) return;
        const fixed: Mistake = {
          ...m,
          original: join(part.orig),
          correction: join(part.corr),
          explanation,
        };
        // 'guitar' -> 'the guitar' after 'play'
        const why = implausible(withWordBefore(part, fixed, answer), corrected, answer);
        if (why) {
          notes.push(`${why}:${head(fixed.original, 40)}`);
          dropped.push(normalize(fixed.correction));
          return;
        }
        candidates.push({ index, part: n, start: part.start, end: part.end, mistake: fixed });
      });
  });
  // On overlap the most precise (shortest) fragment wins, then a whole mistake over a part
  // cut out of a long one. The model's order is kept.
  const chosen: Candidate[] = [];
  const spans: [number, number][] = [];
  const bySize = [...candidates].sort(
    (x, y) => x.end - x.start - (y.end - y.start) || Number(x.part > 0) - Number(y.part > 0),
  );
  for (const cand of bySize) {
    const { start, end } = cand;
    if (spans.some(([s, e]) => start < e && s < end)) {
      notes.push(`overlap:${head(cand.mistake.original, 40)}`);
      continue;
    }
    spans.push([start, end]);
    chosen.push(cand);
  }
  chosen.sort((x, y) => x.index - y.index || x.start - y.start);
  const kept: Mistake[] = chosen.slice(0, MAX_MISTAKES).map((cand, i) =>
    // second part of the same mistake
    i > 0 && chosen[i - 1]?.index === cand.index
      ? { ...cand.mistake, explanation: SAME_CASE }
      : cand.mistake,
  );
  const wrong = kept
    .filter((m) => split(m.original).length >= 2)
    .map((m) => ` ${normalize(m.original)} `);
  const strengths: string[] = [];
  for (const text of evaluation.strengths) {
    if (wrong.some((w) => ` ${normalize(text)} `.includes(w))) {
      notes.push(`strength_praises_mistake:${head(text, 40)}`);
    } else if (portuguese(text) || garbled(text)) {
      notes.push(`strength_in_portuguese:${head(text, 40)}`);
    } else {
      strengths.push(text);
    }
  }
  const tip =
    dropSentencesQuoting(dropPortugueseSentences(evaluation.tip), dropped) ||
    (evaluation.score_breakdown.task < TASK_CAP_BELOW ? DEFAULT_TIP : DEFAULT_TIP_GOOD);
  // nothing to fix: the answer is its own natural version, no rewrite
  if (kept.every((m) => m.type === "unclear")) correctedText = tidy(evaluation.transcript);
  const breakdown = fairScores(evaluation.score_breakdown, kept);
  return [
    {
      ...evaluation,
      corrected: correctedText,
      mistakes: kept,
      strengths,
      tip,
      score_breakdown: breakdown,
      score: overallScore(breakdown),
    },
    notes,
  ];
}

/** The model's sub-scores, bounded by what the code knows: few grammar mistakes cannot
 *  mean a very low grammar score, and audio noise ('unclear') is not the student's fault. */
export function fairScores(breakdown: ScoreBreakdown, mistakes: Mistake[]): ScoreBreakdown {
  const grammarMistakes = mistakes.filter((m) => m.type === "grammar").length;
  const real = mistakes.filter((m) => m.type !== "unclear");
  const update: Partial<ScoreBreakdown> = {
    grammar: Math.max(breakdown.grammar, 100 - GRAMMAR_PER_MISTAKE * grammarMistakes),
  };
  if (!real.length) {
    update.grammar = Math.max(breakdown.grammar, NO_MISTAKE_GRAMMAR);
    update.vocabulary = Math.max(breakdown.vocabulary, NO_MISTAKE_FLOOR);
  }
  if (real.length < mistakes.length) {
    update.fluency = Math.max(breakdown.fluency, UNCLEAR_FLUENCY_FLOOR);
  }
  return { ...breakdown, ...update };
}

/** The mistake with the answer's word before it, for the plausibility rules only. */
function withWordBefore(part: Piece, mistake: Mistake, answer: Words): Mistake {
  if (part.start === 0) return mistake;
  const before = answer[part.start - 1]?.[1] ?? "";
  return {
    ...mistake,
    original: `${before} ${mistake.original}`,
    correction: `${before} ${mistake.correction}`,
  };
}

/** What the written correction says, for the tutor's spoken reply (<correction>). */
export function feedbackForReply(evaluation: Evaluation | null | undefined): string {
  if (!evaluation) return "(not available)";
  const real = evaluation.mistakes.filter((m) => m.type !== "unclear");
  const unclearParts = evaluation.mistakes
    .filter((m) => m.type === "unclear")
    .map((m) => m.original);
  const lines = [
    real.length ? `What they meant, in correct English: ${evaluation.corrected}` : "No mistakes.",
    ...real.map((m) =>
      m.type === "pronunciation"
        ? `Heard as '${m.original}', probably '${m.correction}' (pronunciation)`
        : `Fixed: '${m.original}' -> '${m.correction}'`,
    ),
    ...unclearParts.map((u) => `Unclear (bad audio, nobody knows what they said): '${u}'`),
  ];
  return lines.join("\n");
}

/** The correction brings in content the student never said (from the history, or a guess). */
function invented(mistake: Mistake, said: ReadonlySet<string>): boolean {
  const original = new Set(norms(words(mistake.original)));
  const known = (n: string) => original.has(n) || said.has(n) || STOPWORDS.has(n);
  const fresh = new Set(norms(words(mistake.correction)).filter((n) => !known(n) && len(n) > 2));
  return fresh.size >= INVENTED_WORDS;
}

/** {start, end, mistake} for an 'unclear' fragment, found in the answer. */
function unclear(
  mistake: Mistake,
  answer: Words,
): { start: number; end: number; mistake: Mistake } | null {
  const a = norms(answer);
  const o = norms(words(mistake.original));
  let starts: number[] = [];
  if (o.length) {
    starts = findAll(a, o);
    if (!starts.length) starts = fuzzyFind(a, o);
  }
  if (!starts.length) return null;
  const start = starts[0] as number;
  const end = start + o.length;
  const text = join(answer.slice(start, end));
  const fixed: Mistake = {
    ...mistake,
    type: "unclear",
    original: text,
    correction: text,
    explanation: UNCLEAR,
  };
  return { start, end, mistake: fixed };
}

const escapeRegExp = (s: string) => s.replace(/[\^$\\.*+?()[\]{}|/]/g, "\\$&");

/** Put the student's own words back where 'corrected' used the guessed ones. */
function unguess(corrected: string, mistake: Mistake): string {
  const guess = strip(mistake.correction, " .,;:!?");
  if (!guess) return corrected;
  const own = strip(mistake.original, " .,;:!?");
  return corrected.replace(new RegExp(escapeRegExp(guess), "iu"), () => own);
}

/** 'Remember to use the before band names' after that 'mistake' was dropped. */
function dropSentencesQuoting(text: string, phrases: string[]): string {
  const padded = phrases.filter((p) => split(p).length >= 2).map((p) => ` ${p} `);
  const kept = sentences(text.replaceAll("...", "…")) // keep 'like...' whole
    .filter((s) => !padded.some((p) => ` ${normalize(s)} `.includes(p)));
  return strip(kept.join(""));
}

/** 'You made this mistake before' with no stored mistakes is made up. */
function stripMemory(text: string): string {
  return strip(text.replace(MEMORY_RE, ""));
}
