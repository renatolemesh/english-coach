/**
 * Grading without a model: multiple-choice answers typed or tapped, typed answers with typo
 * tolerance, and spoken answers (a Whisper transcript with word probabilities) against the
 * sentence the student was asked to say.
 *
 * Whisper tends to "hear" the right word even when it was mispronounced, so speech scores
 * measure whether the words came through clearly, not phoneme accuracy; low word probability
 * is the signal for "say this one again".
 */

const CONTRACTIONS: [RegExp, string][] = [
  [/\bcan't\b/g, "cannot"],
  [/\bcan not\b/g, "cannot"],
  [/\bwon't\b/g, "will not"],
  [/\bshan't\b/g, "shall not"],
  [/\bain't\b/g, "is not"],
  [/\blet's\b/g, "let us"],
  [/n't\b/g, " not"],
  [/\bi'm\b/g, "i am"],
  [/'re\b/g, " are"],
  [/'ve\b/g, " have"],
  [/'ll\b/g, " will"],
  [/'d\b/g, " would"],
  [/\b(it|he|she|that|what|where|who|there|here|how)'s\b/g, "$1 is"],
];

// Function words weigh half in scores: missing "the" is not missing "house".
export const FUNCTION_WORDS: ReadonlySet<string> = new Set(
  (
    "a an the to of in on at for with by from and or but is am are was were be been it i you he " +
    "she we they me him her us them my your his its our their this that these those do does did " +
    "not no so as if then than there here have has had will would can could shall should may might"
  ).split(" "),
);

/** Lower case, straight quotes, no punctuation, contractions expanded. */
export function normalize(text: string): string {
  let t = text
    .toLowerCase()
    .replace(/[‘’ʼ`´]/g, "'")
    .replace(/[“”]/g, '"');
  for (const [re, to] of CONTRACTIONS) t = t.replace(re, to);
  return t
    .replace(/'s\b/g, "s") // possessive: "tom's" ~ "toms"
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/'/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const tokens = (text: string): string[] => normalize(text).split(" ").filter(Boolean);

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] as number;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(up + 1, (prev[j - 1] as number) + 1, diag + cost);
      diag = up;
    }
  }
  return prev[b.length] as number;
}

/** A spelling slip, not a different word: 0 edits for short words, 1 up to 7 letters, 2 above. */
export function isTypo(given: string, target: string): boolean {
  if (given === target) return false;
  const allowed = target.length <= 3 ? 0 : target.length <= 7 ? 1 : 2;
  return levenshtein(given, target) <= allowed;
}

type Op = "match" | "typo" | "sub" | "del" | "ins";

/** Word alignment of `given` against `target` (edit distance over words, typos cost less). */
export function align(given: string[], target: string[]): { op: Op; g?: number; t?: number }[] {
  const n = given.length;
  const m = target.length;
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) (cost[i] as number[])[0] = i;
  for (let j = 0; j <= m; j++) (cost[0] as number[])[j] = j;
  const pairCost = (i: number, j: number) => {
    const g = given[i - 1] as string;
    const t = target[j - 1] as string;
    return g === t ? 0 : isTypo(g, t) ? 0.4 : 1;
  };
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const row = cost[i] as number[];
      row[j] = Math.min(
        ((cost[i - 1] as number[])[j] as number) + 1,
        (row[j - 1] as number) + 1,
        ((cost[i - 1] as number[])[j - 1] as number) + pairCost(i, j),
      );
    }
  }
  const ops: { op: Op; g?: number; t?: number }[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const here = (cost[i] as number[])[j] as number;
    if (i > 0 && j > 0 && here === ((cost[i - 1] as number[])[j - 1] as number) + pairCost(i, j)) {
      const c = pairCost(i, j);
      ops.push({ op: c === 0 ? "match" : c < 1 ? "typo" : "sub", g: i - 1, t: j - 1 });
      i--;
      j--;
    } else if (i > 0 && here === ((cost[i - 1] as number[])[j] as number) + 1) {
      ops.push({ op: "ins", g: i - 1 });
      i--;
    } else {
      ops.push({ op: "del", t: j - 1 });
      j--;
    }
  }
  return ops.reverse();
}

export interface TextGrade {
  ok: boolean; // right (typos allowed)
  typos: string[]; // target words written with a slip (feedback: "watch the spelling")
  score: number; // 0-100, function words weigh half
  best: string; // the accepted answer it was compared with
}

/** A typed answer against the accepted ones (the first is the canonical one). */
export function gradeText(answer: string, accepted: readonly string[]): TextGrade {
  const given = tokens(answer);
  let best: TextGrade = { ok: false, typos: [], score: 0, best: accepted[0] ?? "" };
  for (const option of accepted) {
    const target = tokens(option);
    if (!target.length) continue;
    let got = 0;
    let total = 0;
    let extra = 0;
    const typos: string[] = [];
    for (const step of align(given, target)) {
      if (step.op === "ins") {
        extra++;
        continue;
      }
      const word = target[step.t as number] as string;
      const weight = FUNCTION_WORDS.has(word) ? 0.5 : 1;
      total += weight;
      if (step.op === "match") got += weight;
      if (step.op === "typo") {
        got += 0.9 * weight;
        typos.push(word);
      }
    }
    const score = Math.max(0, Math.round((100 * got) / total - 5 * extra));
    const ok = got >= total - 0.1 * typos.length - 1e-9 && extra === 0;
    if (Number(ok) > Number(best.ok) || (ok === best.ok && score > best.score)) {
      best = { ok, typos, score, best: option };
    }
  }
  return best;
}

/**
 * The option a text answer points at: "2", "b", "B)", "(c)", or the option's own text.
 * Returns the 0-based index, or null.
 */
export function parseChoice(answer: string, options: readonly string[]): number | null {
  const raw = answer.trim().toLowerCase();
  const m = /^[([]?\s*([1-9]|[a-j])\s*[).\]]?$/.exec(raw);
  if (m) {
    const key = m[1] as string;
    const index = /\d/.test(key) ? Number(key) - 1 : key.charCodeAt(0) - 97;
    return index >= 0 && index < options.length ? index : null;
  }
  const said = normalize(raw);
  const found = options.findIndex((o) => normalize(o) === said);
  return found >= 0 ? found : null;
}

export interface HeardWord {
  text: string;
  p: number; // Whisper's probability for the word (lowest of its tokens)
}

export interface SpeechGrade {
  score: number; // 0-100
  weak: string[]; // target words to practise (missing, replaced or unclear)
  best: string; // the accepted sentence it was compared with
}

const CLEAR = 0.6;
const UNSURE = 0.3;

/** A spoken answer (transcript words with probabilities) against the accepted sentences. */
export function gradeSpeech(heard: readonly HeardWord[], accepted: readonly string[]): SpeechGrade {
  const words = heard.flatMap((w) => tokens(w.text).map((t) => ({ t, p: w.p })));
  const given = words.map((w) => w.t);
  let best: SpeechGrade = { score: 0, weak: [], best: accepted[0] ?? "" };
  for (const option of accepted) {
    const target = tokens(option);
    if (!target.length) continue;
    let got = 0;
    let total = 0;
    let extra = 0;
    const weak: string[] = [];
    for (const step of align(given, target)) {
      if (step.op === "ins") {
        extra++;
        continue;
      }
      const word = target[step.t as number] as string;
      const weight = FUNCTION_WORDS.has(word) ? 0.5 : 1;
      total += weight;
      if (step.op === "match" || step.op === "typo") {
        const p = words[step.g as number]?.p ?? 1;
        const credit = p >= CLEAR ? 1 : p >= UNSURE ? 0.6 : 0.3;
        got += credit * weight;
        if (credit < 1 && weight === 1) weak.push(word);
      } else if (weight === 1) {
        weak.push(word);
      }
    }
    const score = Math.max(0, Math.round((100 * got) / total - 3 * Math.min(extra, 5)));
    if (score > best.score) best = { score, weak, best: option };
  }
  return best;
}
