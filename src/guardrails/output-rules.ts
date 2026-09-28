/**
 * Deterministic checks on the spoken reply before it goes to TTS.
 *
 * sanitize() makes it speakable (no markdown/emojis/URLs/parentheses, bounded length);
 * problems() rejects replies that are not English or that leak internal text (system prompt,
 * canary token, long verbatim chunks of retrieved context). On any problem the caller uses a
 * pre-defined fallback reply.
 */

import { REPLY_MAX_CHARS } from "../domain/reply.js";
import { SequenceMatcher } from "../domain/sequence-matcher.js";
import { pyLen, pyRe, pyRstrip, pySplit, pyStrip } from "./py-re.js";

const URL_RE = pyRe(
  String.raw`(https?://|www\.)\S+|\b[\w-]+\.(com|net|org|br|io|ai|app|dev|me)\b\S*`,
  "gi",
);
const MARKDOWN_RE = pyRe(String.raw`[*_${"`"}#>|~\[\]{}]`, "g");
const PARENS_RE = pyRe("[()]", "g");
const EMOJI_RE = pyRe(
  "[\\u{1f000}-\\u{1faff}\\u2600-\\u27bf\\u{1f900}-\\u{1f9ff}\\u2190-\\u21ff" +
    "\\u2b00-\\u2bff\\ufe0f\\u200d]",
  "g",
);
const LIST_MARKER_RE = pyRe(String.raw`(^|\n)\s*(?:[-•]|\d+[.)])\s+`, "g");
const SPACES_RE = pyRe(String.raw`\s+`, "g");
const DASH_RE = pyRe("\\s*[\\u2013\\u2014]\\s*", "g"); // en/em dashes read badly in TTS
// [^\W\d_]: unicode letters, keeps don't
const WORD_RE = pyRe(String.raw`[\p{L}\p{Nl}\p{No}]+(?:'[\p{L}\p{Nl}\p{No}]+)?`, "g");
// Language check = "is this clearly NOT English?" (the realistic failure is the model answering
// in Portuguese, the student's language). Proving English with word ratios misfires on short
// casual replies ("Hi! Let's talk."), so count distinctive Portuguese/Spanish words instead.
const ENGLISH_HINTS = new Set(
  pySplit(
    "the and you your i i'm it it's is are was were what what's how why when where who " +
      "that that's this there there's let's do did does have has had can could would will " +
      "like just about my me we they he she oh nice really so so you'd i'd you're don't",
  ),
);
const ROMANCE_HINTS = new Set(
  pySplit(
    "que você voce não nao uma um para com está esta isso muito bem obrigado obrigada " +
      "olá ola sim então entao também tambem mas por porque sobre fala falar eu meu minha " +
      "seu sua legal gostei vamos conversar el la los las usted qué cómo",
  ),
);

export function sanitize(text: string, maxChars: number = REPLY_MAX_CHARS): string {
  let out = text.replace(URL_RE, "");
  out = out.replace(LIST_MARKER_RE, "$1");
  out = out.replace(MARKDOWN_RE, "");
  out = out.replace(PARENS_RE, "");
  out = out.replace(EMOJI_RE, "");
  out = out.replace(DASH_RE, ", ");
  out = pyStrip(out.replace(SPACES_RE, " "));
  return truncate(out, maxChars);
}

const SENTENCE_RE = pyRe("[^.!?]+[.!?]+", "g");
// "How was the weather, and what did you do?" -> a second question glued to the first
// A wh-word, or an auxiliary followed by its subject, starts a new question; ', and why?' and
// '... when you are tired and have some free time?' do not.
const SECOND_QUESTION_RE = pyRe(
  String.raw`,?\s+and\s+(?:(?:what|what's|how|where|when|why|who|which)\b(?:\s+[\w']+){2,}` +
    String.raw`|(?:do|did|does|is|are|was|were|have|has|would|could|can|will)\s+` +
    String.raw`(?:you|it|they|he|she|we|there|that|this|your)\b).*\?$`,
  "i",
);

interface Sentence {
  text: string; // stripped
  start: number;
  end: number;
}

function sentences(text: string): Sentence[] {
  return Array.from(text.matchAll(SENTENCE_RE), (m) => ({
    text: pyStrip(m[0]),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/** No sentences, or text after the last one: the sentence rules leave the text alone. */
function unterminated(text: string, matches: Sentence[]): boolean {
  const last = matches.at(-1);
  return last === undefined || pyStrip(text.slice(last.end)) !== "";
}

const QUESTION_START = new Set(
  pySplit(
    "what what's how where when why who which whose do did does is are was were have has " +
      "had would could can will should shall may am isn't aren't don't doesn't didn't",
  ),
);
const INTERJECTION_RE = pyRe(
  String.raw`^((oh|so|and|but|well|hmm|wow|okay|ok|great|nice|cool|hey|hi)\b[,!]?\s*)+`,
  "i",
);

/** 'Where did you go?' asks something; 'Oh, you went to Rio?' and 'Really?' just react.
 * 'So you build apps or websites?' offers a choice: it asks something too. */
function isRealQuestion(sentence: string): boolean {
  let words = pySplit(sentence.replace(INTERJECTION_RE, "").toLowerCase());
  if (words.length > 1 && (words[0] as string).endsWith(",")) words = words.slice(1); // "Currently, what kind of ...?"
  const first = words[0];
  if (!(sentence.endsWith("?") && first !== undefined)) return false;
  const choice = (first === "you" || first === "you're") && words.slice(1).includes("or");
  return QUESTION_START.has(pyStrip(first, ",")) || choice;
}

/** Keep one real question and end with it. The last real question wins unless it leans on
 * an earlier one ('... plane, car or bus? What do you prefer?', '... city like? What do you
 * enjoy about living there?'): then the earlier, concrete one stays. Statements after the
 * kept question go; echoes ('Oh, you went to Rio?') stay; a glued second question ('How was
 * it, and what did you do?') is cut. A text whose only question is not real is untouched. */
export function oneQuestion(text: string, preferFirst = false): string {
  const matches = sentences(text);
  if (unterminated(text, matches)) return text;
  const all = matches.map((m) => m.text);
  const at = (i: number) => all[i] as string;
  const real = all.flatMap((s, i) => (isRealQuestion(s) ? [i] : []));
  if (real.length === 0) return text;
  let keep: number;
  if (preferFirst) {
    // openers: the first concrete question ('What about you? What do ...?')
    // all lean ('What about you? ... What do you like about living there?'): the longest
    const longest = real.reduce((best, i) =>
      pySplit(at(i)).length > pySplit(at(best)).length ? i : best,
    );
    keep = real.find((i) => !leansOnPrevious(at(i))) ?? longest;
  } else {
    keep = real.at(-1) as number;
  }
  // an options question leans on an open one before it, but can itself be the concrete one
  // ('... plane, car or bus? What do you prefer?'): strict=true ignores the options rule
  if (
    !preferFirst &&
    real.length >= 2 &&
    leansOnPrevious(at(keep)) &&
    !leansOnPrevious(at(real.at(-2) as number), true)
  ) {
    keep = real.at(-2) as number;
  }
  const before = all.slice(0, keep).filter((s) => !isRealQuestion(s));
  let last = at(keep);
  const cut = SECOND_QUESTION_RE.exec(last);
  if (cut && pyLen(last.slice(0, cut.index)) > 10) {
    last = `${pyRstrip(last.slice(0, cut.index), " ,")}?`;
  }
  return [...before, last].join(" ");
}

const REFERRING = new Set("there that it one them".split(" ")); // not 'these days'
const TRAILING_WHY_RE = pyRe(String.raw`,?\s+(and|or)\s+(why|not|how come)\s*$`, "g");
const OBJECTLESS = new Set("prefer think recommend choose".split(" ")); // 'What do you prefer?'
// "What do you do after work? Do you watch a series or go for a run?": the options only
// make sense after the open question
const AUXILIARIES = new Set("do does did is are was were would could can will have has".split(" "));

/** 'What do you prefer?', 'Which one ...?', '... living there?': needs the question before. */
function leansOnPrevious(question: string, strict = false): boolean {
  const text = pyRstrip(question.toLowerCase(), "?").replace(TRAILING_WHY_RE, "");
  const words = pySplit(text).map((w) => pyStrip(w, ","));
  const first = words[0];
  const options = first !== undefined && AUXILIARIES.has(first) && words.includes("or"); // 'Do you X or Y?'
  return (
    words.length <= 3 || // 'What about you?'
    words.some((w) => REFERRING.has(w)) ||
    (first !== undefined && OBJECTLESS.has(words.at(-1) as string)) ||
    first === "and" ||
    first === "or" ||
    (options && !strict)
  );
}

// The tutor has no trips, concerts or shared experiences beyond the persona, but free models keep
// inventing them ("I've seen them live", "I went there too", "I miss those times too").
const OWN_EXPERIENCE_RE = pyRe(
  String.raw`\bI(?:'ve| have)\s+(?:seen|been|visited|done|tried|gone|had)\b` +
    String.raw`|\bI\s+(?:went|used to|miss|saw|visited|did(?!\s+not))\b` +
    String.raw`|\bI(?:'m| am)\s+(?:also\s+|currently\s+|actually\s+)?(?:learning|studying|taking)\b` +
    String.raw`|\bI\s+(?:still\s+)?(?:remember|loved|enjoyed|can't believe how)\b`,
  "i",
);
// "I love the beach too!" (ends the sentence), not "I think that is too expensive."
const ME_TOO_RE = pyRe(
  String.raw`\b(?:I|I'm|I'd|I've|me)\b[^.!?]*\b(?:too|as well)\s*(?:[.!?]*$|,)`,
  "i",
);

// The persona (prompts + domain.tutors hometowns): talking about it is fine.
const PERSONA_RE = pyRe(
  String.raw`\b(cook\w*|hik\w*|indie|rock|design\w*|Toronto|Pixel|cat` +
    String.raw`|Bristol|England|Portland|Oregon|Manchester|Chicago)\b`,
  "i",
);

const YOU_SAID_RE = pyRe(String.raw`^(?:(?:so|oh|okay),?\s+)?you said\b`, "i");
const REQUEST_RE = pyRe(String.raw`^(tell me|describe|talk about|share)\b(.*?)[.!]?$`, "i");

export const FOLLOW_UP = "What about you?";

/** '... Tell me about your city.' -> '... Can you tell me about your city?'; any other
 * reply without a question gets `followUp`, so the student always knows what to answer. */
export function ensureQuestion(text: string, followUp: string | null = FOLLOW_UP): string {
  const matches = sentences(text);
  if (unterminated(text, matches) || pyRstrip(text).endsWith("?")) return text;
  const lastMatch = matches.at(-1) as Sentence;
  const m = REQUEST_RE.exec(lastMatch.text);
  if (!m) return followUp ? `${pyRstrip(text)} ${followUp}` : text;
  const question = `Can you ${(m[1] as string).toLowerCase()}${m[2]}?`;
  return pyStrip(`${pyRstrip(text.slice(0, lastMatch.start))} ${question}`);
}

// a quote opens after a non-letter and closes before one, so "don't" is not a quote mark
const QUOTED_RE = pyRe(
  "(?<!\\w)'[^']*'(?!\\w)|\"[^\"]*\"|\\u2018[^\\u2019]*\\u2019|\\u201c[^\\u201d]*\\u201d",
  "g",
);

/** Examples in quotes ("you don't say 'I did a mistake'") are not Emma's experiences. */
function unquoted(text: string): string {
  return text.replace(QUOTED_RE, " ");
}

/** Remove sentences where Emma claims experiences or repeats the student's words back
 * ('You said you play since...': often the wrong form); the final question always stays. */
export function dropInventedExperiences(text: string): string {
  const matches = sentences(text);
  if (matches.length < 2 || unterminated(text, matches)) return text;
  const all = matches.map((m) => m.text);
  const kept = all
    .slice(0, -1)
    .filter(
      (s) =>
        !OWN_EXPERIENCE_RE.test(unquoted(s)) &&
        !YOU_SAID_RE.test(s) &&
        !(ME_TOO_RE.test(s) && !PERSONA_RE.test(s)),
    );
  return [...kept, all.at(-1) as string].join(" ");
}

export const ECHO_MIN_WORDS = 4;
export const ECHO_SHARE = 0.8; // of the sentence's words that come from what the student said

function words(text: string): string[] {
  return Array.from(text.matchAll(WORD_RE), (m) => m[0].toLowerCase());
}

/** Remove sentences where the tutor says the student's line as their own: the waiter
 * answering 'I want a pizza' with "Great choice! I'd like a pizza and a coke, please." The
 * final question always stays; 'Oh, you went to Rio?' (second person) is a normal reaction. */
export function dropEchoes(text: string, said: string[]): string {
  const matches = sentences(text);
  if (matches.length < 2 || unterminated(text, matches)) return text;
  const student = new Set(said.flatMap(words));

  const echo = (sentence: string): boolean => {
    const ws = words(sentence);
    if (
      ws.length < ECHO_MIN_WORDS ||
      !["i", "i'd", "i'm", "i'll", "i've"].includes(ws[0] as string)
    ) {
      return false;
    }
    return ws.filter((w) => student.has(w)).length / ws.length >= ECHO_SHARE;
  };

  const all = matches.map((m) => m.text);
  return [...all.slice(0, -1).filter((s) => !echo(s)), all.at(-1) as string].join(" ");
}

/** Openers: keep as many leading sentences as fit, plus the final question. */
export function shorten(text: string, maxChars: number): string {
  if (pyLen(text) <= maxChars) return text;
  const all = sentences(text).map((m) => m.text);
  const last = all.at(-1);
  if (last === undefined || pyLen(last) > maxChars) return text;
  const head: string[] = [];
  for (const sentence of all.slice(0, -1)) {
    if (pyLen([...head, sentence, last].join(" ")) > maxChars) break;
    head.push(sentence);
  }
  return [...head, last].join(" ");
}

export const REPEAT_STEM_WORDS = 5; // "how long have you been ..." twice in a row is the same question

function questionWords(sentence: string): string[] {
  const text = pyRstrip(sentence.replace(INTERJECTION_RE, "").toLowerCase(), "?");
  return pySplit(text).map((w) => pyStrip(w, ",'"));
}

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((w, i) => w === b[i]);

/** The reply's question is one the tutor already asked in the last turns (same opening
 * words, or nearly the same words): the student answered it, maybe unclearly. */
export function repeatsQuestion(text: string, previous: string[]): boolean {
  const last = sentences(text).at(-1)?.text;
  if (last === undefined || !isRealQuestion(last)) return false;
  const fresh = questionWords(last);
  for (const earlier of previous) {
    const old = questionWords(earlier);
    const sameStem =
      fresh.length > REPEAT_STEM_WORDS &&
      sameList(fresh.slice(0, REPEAT_STEM_WORDS), old.slice(0, REPEAT_STEM_WORDS));
    if (sameStem || new SequenceMatcher(fresh, old).ratio() >= 0.8) return true;
  }
  return false;
}

export function lastQuestion(text: string): string {
  const last = sentences(text).at(-1);
  return last !== undefined && pyRstrip(text).endsWith("?") ? last.text : "";
}

/** Swap the final question for another one, keeping the reaction before it. */
export function replaceQuestion(text: string, question: string): string {
  const head = sentences(text)
    .slice(0, -1)
    .map((m) => m.text)
    .filter((s) => !isRealQuestion(s));
  return [...head, question].join(" ");
}

export function countQuestions(text: string): number {
  return sentences(text).filter((m) => isRealQuestion(m.text)).length;
}

/** Cut at the last sentence end that fits, preferring to keep a final question. */
function truncate(text: string, maxChars: number): string {
  const chars = Array.from(text); // slice by code points
  if (chars.length <= maxChars) return text;
  const head = chars.slice(0, maxChars);
  const cut = Math.max(head.lastIndexOf("?"), head.lastIndexOf("."), head.lastIndexOf("!"));
  if (cut > Math.floor(maxChars / 3)) return head.slice(0, cut + 1).join("");
  const joined = head.join("");
  const space = joined.lastIndexOf(" ");
  return space === -1 ? joined : joined.slice(0, space);
}

const LETTER_RE = /\p{L}/u; // str.isalpha()

export function looksEnglish(text: string): boolean {
  const ws = words(text);
  if (ws.length === 0) return false;
  const letters = Array.from(text).filter((ch) => LETTER_RE.test(ch));
  const nonLatin = letters.filter((ch) => (ch.codePointAt(0) as number) > 0x24f).length; // CJK, Cyrillic, Arabic...
  if (letters.length && nonLatin / letters.length > 0.2) return false;
  const romance = ws.filter((w) => ROMANCE_HINTS.has(w)).length;
  const english = ws.filter((w) => ENGLISH_HINTS.has(w)).length;
  return !(romance >= 2 && romance > english) && !(romance && english === 0);
}

function ngrams(text: string, n: number): Set<string> {
  const ws = words(text);
  const grams = new Set<string>();
  for (let i = 0; i < ws.length - n + 1; i++) grams.add(ws.slice(i, i + n).join("\u0000"));
  return grams;
}

/** True if `text` shares any n-word sequence with any secret. */
export function leaks(text: string, secrets: string[], n: number): boolean {
  const grams = ngrams(text, n);
  return secrets.some((secret) => {
    if (!secret) return false;
    for (const g of ngrams(secret, n)) if (grams.has(g)) return true;
    return false;
  });
}

export function problems(
  text: string,
  systemTexts: string[],
  context: string,
  canary: string,
): string[] {
  const found: string[] = [];
  if (!text) found.push("empty");
  else if (!looksEnglish(text)) found.push("not_english");
  if (canary && text.toLowerCase().includes(canary.toLowerCase())) found.push("canary_leak");
  if (leaks(text, systemTexts, 8)) found.push("system_prompt_leak");
  if (leaks(text, [context], 12)) found.push("context_leak");
  return found;
}
