/**
 * Offline builder for the course word bank and sentence bank (data/course/*.jsonl).
 *
 *   npx tsx scripts/build-course.ts [inputDir]
 *
 * inputDir holds the downloaded sources: olp/cefrj-vocabulary-profile-1.5.csv,
 * tatoeba/{eng_sentences_detailed,por_sentences,eng-por_links}.tsv and wikt/ptwikt.jsonl.gz
 * (Portuguese Wiktionary extracted by Wiktextract). No network and no LLM: the same inputs give
 * the same files. Default inputDir: out/course-sources. Sources:
 *   https://github.com/openlanguageprofiles/olp-en-cefrj (cefrj-vocabulary-profile-1.5.csv)
 *   https://downloads.tatoeba.org/exports/per_language/{eng,por}/ (eng_sentences_detailed,
 *     por_sentences, eng-por_links; .tsv.bz2, unpack with bunzip2)
 *   https://kaikki.org/ptwiktionary/raw-wiktextract-data.jsonl.gz (save as wikt/ptwikt.jsonl.gz) Writes data/course/{words,sentences}.jsonl and out/course-build-report.txt.
 *
 * Glosses: the Portuguese candidates (glosses of the English Wiktionary entry, Portuguese entries
 * that translate to the word, and lemmas that co-occur strongly in Tatoeba) are scored by how
 * often they appear, lemmatized, in the Brazilian translations of sentences that use the word
 * with the same part of speech, weighted by part-of-speech agreement: "paint" as a noun is
 * "tinta", not "pintar", even though most "paint" sentences are about painting.
 */
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_INPUT = path.join(ROOT, "out", "course-sources");
const OUT_DIR = path.join(ROOT, "data", "course");
const REPORT_FILE = path.join(ROOT, "out", "course-build-report.txt");

const LEVELS = ["A1", "A2", "B1"] as const;
const MIN_WORDS = 3;
const MAX_WORDS = 12;
const POOL_PER_LEVEL = 3000;
const MAX_EXAMPLES = 3;
const MIN_CONF = 0.2; // below this a word is dropped (the planner only teaches >= 0.35)
const GLOSS_MAX = 20;
const SAMPLE_CAP = 2000; // sentences per word used to score glosses (shortest first)

// --- small helpers ------------------------------------------------------------------------

const started = Date.now();
// COURSE_DEBUG=paint.n,star.n prints the scored gloss candidates of those words
const DEBUG = new Set((process.env.COURSE_DEBUG ?? "").split(",").filter(Boolean));
function progress(msg: string): void {
  process.stderr.write(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}\n`);
}

async function* readLines(file: string, gzip = false): AsyncGenerator<string> {
  const stream = createReadStream(file);
  const input = gzip ? stream.pipe(createGunzip()) : stream;
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of rl) yield line;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample<T>(items: readonly T[], n: number, rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy.slice(0, n);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const stripAccents = (s: string) => s.normalize("NFD").replace(/\p{Mn}/gu, "");

// --- parts of speech ------------------------------------------------------------------------

interface PosInfo {
  pos: string; // written to words.jsonl
  code: string; // id suffix
  wikt: readonly string[]; // Wiktionary pos of the English entry that agree
  pt: readonly string[]; // pos of a Portuguese candidate that agree
  ptNear: readonly string[]; // pos that half agree ("rápido" is an adjective for "fast" adv)
}

/** part-of-speech table row: space-separated lists */
function posInfo(pos: string, code: string, wikt: string, pt: string, near: string): PosInfo {
  const list = (x: string) => x.split(" ").filter(Boolean);
  return { pos, code, wikt: list(wikt), pt: list(pt), ptNear: list(near) };
}
const VERB = posInfo("verb", "v", "verb", "verb", "");
const POS_INFO: Record<string, PosInfo> = {
  noun: posInfo("noun", "n", "noun name abbrev", "noun name", "adj intj"),
  verb: VERB,
  "be-verb": VERB,
  "do-verb": VERB,
  "have-verb": VERB,
  "modal auxiliary": posInfo("modal", "modal", "verb", "verb", "adv"),
  adjective: posInfo("adjective", "adj", "adj", "adj", "noun adv"),
  adverb: posInfo("adverb", "adv", "adv", "adv intj phrase", "adj prep conj"),
  preposition: posInfo("preposition", "prep", "prep", "prep contraction phrase", "adv conj"),
  pronoun: posInfo("pronoun", "pron", "pron", "pron", "adv noun contraction article"),
  determiner: posInfo("determiner", "det", "det pron article adj", "pron article adj num", "adv"),
  conjunction: posInfo("conjunction", "conj", "conj", "conj phrase", "adv prep pron"),
  number: posInfo("number", "num", "num", "num noun adj", "article"),
  interjection: posInfo("interjection", "intj", "intj", "intj phrase", "adj noun adv"),
  "infinitive-to": posInfo("other", "other", "", "", ""),
};

// --- English morphology -----------------------------------------------------------------------

// base past participle (commas separate variants); only verbs in the word list matter
const IRREGULAR_VERBS = `arise arose arisen|awake awoke awoken|bear bore borne|beat beat beaten|
become became become|begin began begun|bend bent bent|bet bet bet|bind bound bound|bite bit bitten|
bleed bled bled|blow blew blown|break broke broken|breed bred bred|bring brought brought|
broadcast broadcast broadcast|build built built|burn burnt,burned burnt,burned|burst burst burst|
buy bought bought|catch caught caught|choose chose chosen|cling clung clung|come came come|
cost cost cost|creep crept crept|cut cut cut|deal dealt dealt|dig dug dug|dive dived,dove dived|
do did done|draw drew drawn|dream dreamt,dreamed dreamt,dreamed|drink drank drunk|
drive drove driven|eat ate eaten|fall fell fallen|feed fed fed|feel felt felt|fight fought fought|
find found found|fit fit,fitted fit,fitted|flee fled fled|fly flew flown|forbid forbade forbidden|
forecast forecast forecast|foresee foresaw foreseen|forget forgot forgotten|
forgive forgave forgiven|freeze froze frozen|get got got,gotten|give gave given|go went gone|
grind ground ground|grow grew grown|hang hung,hanged hung,hanged|have had had|hear heard heard|
hide hid hidden|hit hit hit|hold held held|hurt hurt hurt|keep kept kept|
kneel knelt,kneeled knelt,kneeled|know knew known|lay laid laid|lead led led|
lean leant,leaned leant,leaned|leap leapt,leaped leapt,leaped|learn learnt,learned learnt,learned|
leave left left|lend lent lent|let let let|lie lay,lied lain,lied|light lit,lighted lit,lighted|
lose lost lost|make made made|mean meant meant|meet met met|mislead misled misled|
mistake mistook mistaken|misunderstand misunderstood misunderstood|overcome overcame overcome|
overhear overheard overheard|oversleep overslept overslept|overtake overtook overtaken|
pay paid paid|prove proved proven,proved|put put put|quit quit quit|read read read|
rebuild rebuilt rebuilt|redo redid redone|rewrite rewrote rewritten|ride rode ridden|
ring rang rung|rise rose risen|run ran run|say said said|see saw seen|seek sought sought|
sell sold sold|send sent sent|set set set|sew sewed sewn,sewed|shake shook shaken|
shine shone,shined shone,shined|shoot shot shot|show showed shown,showed|shrink shrank shrunk|
shut shut shut|sing sang sung|sink sank sunk|sit sat sat|sleep slept slept|slide slid slid|
smell smelt,smelled smelt,smelled|speak spoke spoken|speed sped,speeded sped,speeded|
spell spelt,spelled spelt,spelled|spend spent spent|spill spilt,spilled spilt,spilled|
spin spun spun|spit spat spat|split split split|spoil spoilt,spoiled spoilt,spoiled|
spread spread spread|spring sprang sprung|stand stood stood|steal stole stolen|stick stuck stuck|
sting stung stung|stink stank stunk|strike struck struck|swear swore sworn|sweep swept swept|
swell swelled swollen|swim swam swum|swing swung swung|take took taken|teach taught taught|
tear tore torn|tell told told|think thought thought|throw threw thrown|
understand understood understood|undertake undertook undertaken|undo undid undone|
upset upset upset|wake woke woken|wear wore worn|weave wove woven|weep wept wept|
wet wet,wetted wet,wetted|win won won|wind wound wound|withdraw withdrew withdrawn|
write wrote written`;

// biome-ignore format: a word list
const IRREGULAR_PLURALS: Record<string, string> = {
  child: "children", person: "persons", foot: "feet", tooth: "teeth", goose: "geese",
  mouse: "mice", ox: "oxen", sheep: "sheep", fish: "fish", deer: "deer", knife: "knives",
  wife: "wives", life: "lives", leaf: "leaves", half: "halves", shelf: "shelves", wolf: "wolves",
  thief: "thieves", loaf: "loaves", calf: "calves", self: "selves", potato: "potatoes",
  tomato: "tomatoes", hero: "heroes", echo: "echoes", crisis: "crises", analysis: "analyses",
  cactus: "cacti", medium: "media", phenomenon: "phenomena", criterion: "criteria",
};

// comparatives that are not headwords of their own (better, best, more... are)
const IRREGULAR_ADJ: Record<string, string[]> = {
  old: ["older", "oldest", "elder", "eldest"],
  far: ["farthest", "furthest"],
};

const IRREGULAR = new Map<string, { past: string[]; pp: string[] }>();
for (const item of IRREGULAR_VERBS.replace(/\n/g, "").split("|")) {
  const [base, past, pp] = item.trim().split(" ");
  if (base && past && pp) IRREGULAR.set(base, { past: past.split(","), pp: pp.split(",") });
}

type Infl = "base" | "s" | "past" | "pp" | "ing" | "cmp" | "var";

const syllables = (w: string) => (w.match(/[aeiouy]+/g) ?? []).length;
// stop -> stopped, big -> bigger; "qu" counts as a consonant (quit -> quitting)
const cvc = (w: string) => /[^aeiou][aeiou][bcdfgklmnprstvz]$/.test(w.replace(/qu/g, "q"));

/** Candidate inflections; the ones never seen in Tatoeba are dropped later. */
function inflect(word: string, pos: string): Array<[string, Infl]> {
  const w = word.toLowerCase();
  const out: Array<[string, Infl]> = [[w, "base"]];
  if (!/^[a-z]+$/.test(w)) return out;
  const last = w.at(-1) ?? "";
  const double = cvc(w) ? w + last : "";
  if (pos === "noun") {
    const irr = IRREGULAR_PLURALS[w];
    if (irr) out.push([irr, "s"]);
    if (w.endsWith("man") && !/(hu|ger|ro|sha)man$/.test(w))
      out.push([`${w.slice(0, -3)}men`, "s"]);
    else if (/(s|x|z|ch|sh)$/.test(w)) out.push([`${w}es`, "s"]);
    else if (/[^aeiou]y$/.test(w)) out.push([`${w.slice(0, -1)}ies`, "s"]);
    else {
      out.push([`${w}s`, "s"]);
      if (last === "o") out.push([`${w}es`, "s"]);
    }
  } else if (pos === "verb") {
    if (/(s|x|z|ch|sh|o)$/.test(w)) out.push([`${w}es`, "s"]);
    else if (/[^aeiou]y$/.test(w)) out.push([`${w.slice(0, -1)}ies`, "s"]);
    else out.push([`${w}s`, "s"]);
    if (w.endsWith("ie")) out.push([`${w.slice(0, -2)}ying`, "ing"]);
    else if (/[^aeioy]e$/.test(w)) out.push([`${w.slice(0, -1)}ing`, "ing"]);
    else if (last === "c") out.push([`${w}king`, "ing"]);
    else {
      out.push([`${w}ing`, "ing"]);
      if (double) out.push([`${double}ing`, "ing"]);
    }
    const irr = IRREGULAR.get(w);
    if (irr) {
      for (const f of irr.past) out.push([f, "past"]);
      for (const f of irr.pp) out.push([f, "pp"]);
    } else if (w.endsWith("e")) out.push([`${w}d`, "past"]);
    else if (/[^aeiou]y$/.test(w)) out.push([`${w.slice(0, -1)}ied`, "past"]);
    else if (last === "c") out.push([`${w}ked`, "past"]);
    else {
      out.push([`${w}ed`, "past"]);
      if (double) out.push([`${double}ed`, "past"]);
    }
  } else if ((pos === "adjective" || pos === "adverb") && syllables(w) <= 2) {
    for (const f of IRREGULAR_ADJ[w] ?? []) out.push([f, "cmp"]);
    if (w.endsWith("e")) out.push([`${w}r`, "cmp"], [`${w}st`, "cmp"]);
    else if (/[^aeiou]y$/.test(w))
      out.push([`${w.slice(0, -1)}ier`, "cmp"], [`${w.slice(0, -1)}iest`, "cmp"]);
    else {
      out.push([`${w}er`, "cmp"], [`${w}est`, "cmp"]);
      if (double && syllables(w) === 1) out.push([`${double}er`, "cmp"], [`${double}est`, "cmp"]);
    }
  }
  return out;
}

// --- word list --------------------------------------------------------------------------------

interface Entry {
  n: number;
  id: string;
  word: string;
  lookup: string[]; // spellings to look up in Wiktionary
  info: PosInfo;
  level: number; // 0 A1, 1 A2, 2 B1
  order: number;
  forms: Map<string, Infl>; // single tokens, lowercase
  phrases: string[][]; // multiword forms
  capital: boolean; // May, March, Miss: the capitalized use is this entry
  capsOnly: boolean; // IT: only when written in capitals ("it" is the pronoun)
  vocab: boolean; // false: known for levelling, never taught
  dropReason: string;
}

// merged into one verb entry each; 'm 're 's are expanded by the tokenizer
// biome-ignore format: one line
const MERGE: Record<string, string> = {
  "be-verb": "be", "do-verb": "do", "have-verb": "have",
};
const MERGED_FORMS: Record<string, string[]> = {
  be: ["be", "am", "is", "are", "was", "were", "been", "being"],
  do: ["do", "does", "did", "done", "doing"],
  have: ["have", "has", "had", "having"],
};
// function words that make poor vocabulary items (kept for levelling sentences)
const NOT_TAUGHT: Record<string, string> = {
  "a.det": "article",
  "an.det": "article",
  "the.det": "article",
  "to.other": "infinitive marker",
  "will.modal": "grammar word (future)",
  "would.modal": "grammar word (conditional)",
  "shall.modal": "grammar word (future)",
};
// forms that belong to another word in practice: "am" is "be", "born" is not "bear" for learners
const SKIP_FORMS: Record<string, string[]> = {
  "a.m..adv": ["am"],
  "p.m..adv": ["pm"],
  "bear.v": ["born", "borne"],
  "Mr..n": ["mrs"],
};
const EXTRA_FORMS: Record<string, string[]> = {
  "lot.pron": ["lots"],
  "other.pron": ["others"],
  "one.pron": ["ones"],
  "yourself.pron": ["yourselves"],
  "hundred.num": ["hundreds"],
  "thousand.num": ["thousands"],
  "million.num": ["millions"],
  "dozen.det": ["dozens"],
};
// known for levelling sentences but not in CEFR-J (not taught): level index
// biome-ignore format: a word list
const EXTRA_KNOWN: Record<string, number> = {
  born: 0, goodbye: 0, bye: 0, oh: 0, wow: 1, ah: 1, english: 0, portuguese: 0, brazil: 0,
  brazilian: 1, spanish: 1, french: 1, german: 1, italian: 1, japanese: 1, chinese: 1,
  america: 1, american: 1, england: 1, japan: 1, china: 1, france: 1, germany: 1, italy: 1,
  spain: 1, portugal: 1, canada: 1, australia: 1, europe: 1, london: 1, paris: 1, tokyo: 1,
  boston: 1, christmas: 1,
};

async function loadEntries(file: string): Promise<Entry[]> {
  const byId = new Map<string, Entry>();
  let order = 0;
  for await (const line of readLines(file)) {
    if (!line.trim() || line.startsWith("headword,")) continue;
    const [head = "", cefrPos = "", cefr = ""] = parseCsvLine(line);
    const level = (LEVELS as readonly string[]).indexOf(cefr);
    if (level < 0) continue;
    let info = POS_INFO[cefrPos];
    if (!info) continue;
    let variants = head
      .split("/")
      .map((v) => v.trim())
      .filter(Boolean);
    const merged = MERGE[cefrPos];
    if (merged) variants = [merged];
    // "need" is listed as a modal (A1) and a verb (A2): one verb for learners
    if (cefrPos === "modal auxiliary" && variants[0] === "need") info = VERB;
    const word = variants[0] ?? "";
    if (!word || word.startsWith("'")) {
      // 'm 're 's: forms of "be"
      continue;
    }
    const id = `${word.replace(/ /g, "_")}.${info.code}`;
    const existing = byId.get(id);
    if (existing) {
      existing.level = Math.min(existing.level, level);
      for (const v of variants) if (!existing.lookup.includes(v)) existing.lookup.push(v);
      continue;
    }
    byId.set(id, {
      n: 0,
      id,
      word,
      lookup: variants,
      info,
      level,
      order: order++,
      forms: new Map(),
      phrases: [],
      capital: /^[A-Z][a-z]/.test(word),
      capsOnly: false,
      vocab: !NOT_TAUGHT[id],
      dropReason: NOT_TAUGHT[id] ? `function word (${NOT_TAUGHT[id]})` : "",
    });
  }
  const entries = [...byId.values()];
  entries.forEach((e, i) => {
    e.n = i;
  });
  return entries;
}

/** All candidate forms of every entry, before the attestation filter. */
function candidateForms(e: Entry): { single: Array<[string, Infl]>; multi: string[][] } {
  const single: Array<[string, Infl]> = [];
  const multi: string[][] = [];
  const skip = new Set(SKIP_FORMS[e.id] ?? []);
  const merged = MERGED_FORMS[e.word];
  if (merged && e.info === VERB) {
    for (const f of merged) single.push([f, f === e.word ? "base" : "var"]);
    return { single, multi };
  }
  const pos = e.info.pos;
  for (const variant of e.lookup) {
    const v = variant.toLowerCase().replace(/\.$/, "");
    const parts = v.split(" ");
    if (parts.length > 1) {
      // inflect the head: last word of a noun ("living rooms"), first of a verb ("has to")
      const headLast = pos === "noun";
      const head = (headLast ? parts.at(-1) : parts[0]) ?? "";
      const infl = pos === "modal" && head === "have" ? (MERGED_FORMS.have ?? []) : null;
      const forms = infl ?? inflect(head, pos).map(([f]) => f);
      for (const f of forms) {
        multi.push(headLast ? [...parts.slice(0, -1), f] : [f, ...parts.slice(1)]);
      }
      continue;
    }
    for (const [f, infl] of inflect(v, pos)) {
      if (!skip.has(f))
        single.push([f, variant === e.word ? infl : infl === "base" ? "var" : infl]);
    }
    if (/^[a-z]\.[a-z]\.$/.test(variant)) single.push([variant, "var"]);
  }
  for (const f of EXTRA_FORMS[e.id] ?? []) single.push([f, "s"]);
  return { single, multi };
}

// --- Portuguese lexicon (Wiktionary) ------------------------------------------------------------

interface EnSense {
  glosses: string[];
  weight: number;
}
interface EnWikt {
  pos: string;
  senses: EnSense[];
}

interface Lexicon {
  lemmaPos: Map<string, Set<string>>; // Portuguese lemma -> pos (not form-of entries)
  formOf: Map<string, Set<string>>; // inflected form -> lemmas
  known: Set<string>; // every Portuguese word with an entry
  second: Map<string, number>; // form -> 1: only 2nd person singular analyses, 0: some other
  cased: Map<string, string>; // lowercase -> spelling of a capitalized entry
  proper: Set<string>; // lowercase words that only have capitalized entries (names, places)
  en: Map<string, EnWikt[]>; // English headword (exact case) -> entries glossed in Portuguese
  rev: Map<string, Array<{ pt: string; pos: string }>>; // English word (exact case) -> pt words
}

// biome-ignore format: one line
const PHRASE_POS: Record<string, string> = {
  substantive: "noun", noun: "noun", adjectival: "adj", adverbial: "adv", verb: "verb",
  interjection: "intj", prepositional: "prep",
};
// biome-ignore format: a word list
const SKIP_SENSE_TAGS = new Set([
  "form-of", "no-gloss", "archaic", "obsolete", "vulgar", "pejorative", "derogatory", "rare",
  "slang", "poetic", "historical", "ironic", "uncommon", "Portugal",
]);

interface WiktEntry {
  word?: string;
  lang_code?: string;
  pos?: string;
  tags?: string[];
  senses?: Array<{
    glosses?: string[];
    tags?: string[];
    raw_tags?: string[];
    form_of?: Array<{ word?: string }>;
  }>;
  translations?: Array<{ lang_code?: string; word?: string }>;
}

async function loadLexicon(file: string): Promise<Lexicon> {
  const lex: Lexicon = {
    lemmaPos: new Map(),
    formOf: new Map(),
    known: new Set(),
    second: new Map(),
    cased: new Map(),
    proper: new Set(),
    en: new Map(),
    rev: new Map(),
  };
  const lowerSeen = new Set<string>();
  for await (const line of readLines(file, true)) {
    const head = line.slice(0, 400);
    const isPt = head.includes('"lang_code": "pt"');
    if (!isPt && !head.includes('"lang_code": "en"')) continue;
    const e = JSON.parse(line) as WiktEntry;
    const word = e.word ?? "";
    if (!word || (e.lang_code !== "pt" && e.lang_code !== "en")) continue;
    const senses = e.senses ?? [];
    if (e.lang_code === "en") {
      const kept: EnSense[] = [];
      senses.forEach((s, i) => {
        if (s.form_of?.length || s.tags?.some((t) => SKIP_SENSE_TAGS.has(t))) return;
        if (s.raw_tags?.some((t) => /gíria|vulgar|chulo|obsoleto|arcaico/i.test(t))) return;
        // domain senses (Music, Maths...) come after the everyday ones
        const weight = (1 / (1 + 0.4 * i)) * (s.raw_tags?.length ? 0.5 : 1);
        kept.push({ glosses: s.glosses ?? [], weight });
      });
      if (kept.length) push(lex.en, word, { pos: e.pos ?? "", senses: kept });
      continue;
    }
    const lower = word.toLowerCase();
    lex.known.add(lower);
    if (word !== lower && !lex.cased.has(lower)) lex.cased.set(lower, word);
    if (word === lower) lowerSeen.add(lower);
    const tags = e.tags ?? [];
    let pos = e.pos ?? "";
    // "CASA" (an acronym) must not make "casa" a function word
    if (pos === "abbrev" && word !== lower) continue;
    if (pos === "phrase") pos = tags.map((t) => PHRASE_POS[t]).find(Boolean) ?? "phrase";
    const formOf = senses.flatMap((s) => (s.form_of ?? []).map((f) => f.word ?? ""));
    const isForm = tags.includes("form-of") || formOf.length > 0;
    for (const s of senses) {
      const gloss = (s.glosses ?? []).join(" ");
      const twoSg = /segunda pessoa do singular/.test(gloss);
      if (lex.second.get(lower) !== 0) lex.second.set(lower, twoSg ? 1 : 0);
      if (pos === "contraction") {
        const m = /contração d[ao] preposição (\p{L}+)/u.exec(gloss);
        if (m?.[1]) addTo(lex.formOf, lower, m[1].toLowerCase());
      }
    }
    for (const lemma of formOf) if (lemma) addTo(lex.formOf, lower, lemma.toLowerCase());
    if (!isForm) addTo(lex.lemmaPos, lower, pos);
    for (const t of e.translations ?? []) {
      if (t.lang_code !== "en" || !t.word) continue;
      push(lex.rev, t.word, { pt: word, pos });
    }
  }
  for (const k of lex.cased.keys()) if (!lowerSeen.has(k)) lex.proper.add(k);
  return lex;
}

// --- Portuguese analysis ------------------------------------------------------------------------

// biome-ignore format: one preposition per line
const PT_CONTRACTIONS: Record<string, string> = {
  em: `no na nos nas num numa nuns numas neste nesta nestes nestas nesse nessa nesses nessas
    naquele naquela naqueles naquelas nisso nisto naquilo nele nela neles nelas`,
  de: `do da dos das dum duma duns dumas deste desta destes destas desse dessa desses dessas
    daquele daquela daqueles daquelas disso disto daquilo dele dela deles delas daqui daí dali`,
  a: `ao aos à às àquele àquela àquilo`,
  por: `pelo pela pelos pelas`,
};
const CONTRACTION_OF = new Map<string, string>();
for (const [prep, forms] of Object.entries(PT_CONTRACTIONS))
  for (const f of forms.split(/\s+/)) CONTRACTION_OF.set(f, prep);

const CLITICS = new Set("me te se lhe lhes nos vos o a os as lo la los las no na nas".split(" "));

// common irregular verb forms Wiktionary sometimes lacks (lemma: forms)
// biome-ignore format: one verb per line
const PT_IRREGULAR: Record<string, string> = {
  ser: `sou és é somos são era eras éramos eram fui foi fomos foram fora seja sejam sejamos será
    serão seria seriam fosse fossem for forem sido sendo`,
  estar: `estou está estamos estão estava estavam estávamos estive esteve estivemos estiveram
    esteja estejam estivesse estivessem estiver estiverem`,
  ter: `tenho tem têm temos tinha tinham tínhamos tive teve tivemos tiveram tenha tenham tivesse
    tivessem tiver tiverem terei terá teria`,
  ir: `vou vai vamos vão ia iam íamos fui foi fomos foram vá vão fosse for irei irá iria indo ido`,
  fazer: `faço faz fazem fazemos fiz fez fizemos fizeram faça façam fizesse fizessem fizer
    fizerem farei fará faremos farão faria fariam feito feita`,
  poder: `posso pode podem podemos pude pôde pudemos puderam possa possam pudesse pudessem puder
    puderem`,
  querer: `quero quer querem queremos quis quisemos quiseram queira queiram quisesse quisessem
    quiser quiserem`,
  saber: `sei sabe sabem sabemos soube soubemos souberam saiba saibam soubesse soubessem souber
    souberem`,
  dizer: `digo diz dizem dizemos disse dissemos disseram diga digam dissesse dissessem disser
    disserem direi dirá diria dito`,
  ver: `vejo vê veem vemos vi viu vimos viram veja vejam visse vissem vir virem visto`,
  vir: `venho vem vêm vimos vim veio vieram venha venham viesse viessem vier vierem vindo`,
  dar: `dou dá dão damos dei deu demos deram dê deem desse dessem der derem`,
  trazer: `trago traz trazem trouxe trouxemos trouxeram traga tragam trouxesse trouxer trarei
    traria`,
  pôr: `ponho põe põem pus pôs puseram ponha ponham pusesse puser posto`,
  haver: `há hei houve haja houvesse houver haverá haveria`,
  ler: `leio lê leem lemos li leu leram leia leiam`,
  sair: `saio sai saem saí saiu saíram saia saiam`,
  cair: `caio cai caem caí caiu caíram caia`,
  dormir: `durmo dorme dormem durma durmam`,
  sentir: `sinto sente sentem sinta sintam`,
  pedir: `peço pede pedem peça peçam`,
  ouvir: `ouço ouve ouvem ouça ouçam`,
  preferir: `prefiro prefere preferem prefira`,
  conseguir: `consigo consegue conseguem consiga consigam`,
  seguir: `sigo segue seguem siga sigam`,
  perder: `perco perde perdem perca percam`,
  mentir: `minto mente mentem`,
  vestir: `visto veste vestem`,
};
const PT_IRREGULAR_OF = new Map<string, Set<string>>();
for (const [lemma, forms] of Object.entries(PT_IRREGULAR))
  for (const f of forms.split(/\s+/)) addTo(PT_IRREGULAR_OF, f, lemma);

const PLURALS: Array<[RegExp, string]> = [
  [/ões$|ães$|ãos$/, "ão"],
  [/ais$/, "al"],
  [/éis$/, "el"],
  [/ns$/, "m"],
  [/(r|z|s)es$/, "$1"],
  [/([aeiouáéêíóôú])s$/, "$1"],
];
const suffixes = (s: string) => s.trim().split(/\s+/);
// biome-ignore format: one conjugation per line
const VERB_ENDINGS: Array<[string, string[]]> = [
  [
    "ar",
    suffixes(`
    o as a amos ais am ei aste ou astes aram ava avas ávamos áveis avam arei arás ará aremos
    areis arão aria arias aríamos aríeis ariam e es emos eis em asse asses ássemos ásseis assem
    ares armos ardes arem ando ado ada ados adas ara aras áramos`),
  ],
  [
    "er",
    suffixes(`
    o es e emos eis em i este eu estes eram ia ias íamos íeis iam erei erás erá eremos ereis erão
    eria erias eríamos eríeis eriam a as amos ais am esse esses êssemos êsseis essem eres ermos
    erdes erem endo ido ida idos idas era eras êramos`),
  ],
  [
    "ir",
    suffixes(`
    o es e imos is em i iste iu istes iram ia ias íamos íeis iam irei irás irá iremos ireis irão
    iria irias iríamos iríeis iriam a as amos ais am isse isses íssemos ísseis issem ires irmos
    irdes irem indo ido ida idos idas ira iras íramos`),
  ],
];
const TWO_SG_ENDINGS = /(aste|este|iste|arás|erás|irás|avas|arias|erias|irias)$/;

// hand list of "tu" verb forms (the regular ones are also found through Wiktionary)
const TU_FORMS = new Set(
  `és estás tens vais vens podes queres sabes fazes dizes vês dás trazes pões hás lês crês foste
  fizeste disseste quiseste pudeste soubeste vieste viste trouxeste puseste estiveste tiveste eras
  estavas tinhas ias vinhas fazias dizias podias querias sabias serás estarás terás irás farás
  dirás poderás sejas estejas tenhas vás venhas faças digas possas queiras saibas vejas tragas
  ponhas fores tiveres fizeres puderes quiseres souberes vieres disseres estiveres achas gostas
  precisas falas moras conheces pensas acreditas lembras esqueceste chegaste compraste comeste
  bebeste falaste`.split(/\s+/),
);
// European Portuguese words and spellings (a Brazilian translation never uses them)
const EU_WORDS = new Set(
  `autocarro autocarros comboio comboios telemóvel telemóveis pequeno-almoço ecrã ecrãs equipa
  equipas facto factos rapariga raparigas miúdo miúda miúdos miúdas frigorífico sumo sumos talho
  montra chávena chávenas casa-de-banho gajo gaja fixe bué tu vós vos convosco vosso vossa vossos
  vossas desporto desportos cancro ficheiro ficheiros utilizador utilizadores registo contacto
  contactos óptimo óptima acção acções direcção actual actualmente exacto exactamente objecto
  objectos projecto arquitecto director actor actores actriz bebé bebés ténis económico económica
  fenómeno género anónimo golo golos guarda-redes relvado carrinha rebuçado casota apelido
  propina propinas sanita autoclismo talhante montras secção secções quotidiano quotidiana
  miradouro mulher-polícia estoirar registar contactar sénior júnior camião naifa mamã dezanove
  dezasseis dezassete eletrão eletrões`.split(/\s+/),
);
const EU_BIGRAMS = new Set(["casa de", "pequeno almoço"]);
const EU_SOFT = new Set(["teu", "tua", "teus", "tuas", "ti", "contigo"]);
const EU_ACCENT = /[éó][mn][aeiouáéíóú]/;
const PT_BLOCK = new Set(
  "porra merda caralho puta puto foda foder cu buceta pica cacete bicha".split(" "),
);

class PtAnalyzer {
  private readonly ids = new Map<string, number>();
  readonly strs: string[] = [];
  private readonly cache = new Map<string, Int32Array>();
  private readonly verbs = new Set<string>();

  constructor(private readonly lex: Lexicon) {
    for (const [lemma, pos] of lex.lemmaPos) if (pos.has("verb")) this.verbs.add(lemma);
  }

  id(s: string): number {
    let id = this.ids.get(s);
    if (id === undefined) {
      id = this.strs.length;
      this.ids.set(s, id);
      this.strs.push(s);
    }
    return id;
  }

  lookup(s: string): number | undefined {
    return this.ids.get(s);
  }

  isVerb(lemma: string): boolean {
    return this.verbs.has(lemma);
  }

  /** Lemmas guessed by suffix for words Wiktionary does not list (poderia, querem, dólares). */
  guess(tok: string): string[] {
    const out: string[] = [];
    const nominal: Array<[RegExp, string]> = [
      [/ões$|ães$|ãos$/, "ão"],
      [/éis$/, "el"],
      [/óis$/, "ol"],
      [/ais$/, "al"],
      [/eis$/, "el"],
      [/ns$/, "m"],
      [/es$/, ""],
      [/s$/, ""],
      [/as$/, "o"],
      [/a$/, "o"],
    ];
    for (const [re, rep] of nominal) {
      if (!re.test(tok)) continue;
      const lemma = tok.replace(re, rep);
      const pos = this.lex.lemmaPos.get(lemma);
      if (pos && (pos.has("noun") || pos.has("adj"))) out.push(lemma);
    }
    for (const [inf, ends] of VERB_ENDINGS) {
      for (const end of ends) {
        if (!tok.endsWith(end) || tok.length - end.length < 1) continue;
        let stem = tok.slice(0, -end.length);
        // fiquei -> ficar, cheguei -> chegar, conheço -> conhecer, comecei -> começar
        if (inf === "ar" && /^[eé]/.test(end)) stem = stem.replace(/qu$/, "c").replace(/gu$/, "g");
        if (inf === "ar" && /^[eé]/.test(end) && stem.endsWith("c") && !this.verbs.has(`${stem}ar`))
          stem = `${stem.slice(0, -1)}ç`;
        if (inf !== "ar" && /^[oaá]/.test(end)) stem = stem.replace(/ç$/, "c").replace(/j$/, "g");
        const lemma = stem + inf;
        if (this.verbs.has(lemma)) out.push(lemma);
      }
    }
    return out;
  }

  private analyzeString(tok: string): Set<string> {
    const out = new Set<string>([tok]);
    const prep = CONTRACTION_OF.get(tok);
    if (prep) out.add(prep);
    for (const l of this.lex.formOf.get(tok) ?? []) out.add(l);
    for (const l of PT_IRREGULAR_OF.get(tok) ?? []) out.add(l);
    // Wiktionary lists "estrelas" only as a form of "estrelar": plurals of known nouns count too
    for (const [re, rep] of PLURALS) {
      if (!re.test(tok)) continue;
      const lemma = tok.replace(re, rep);
      const pos = this.lex.lemmaPos.get(lemma);
      if (pos && (pos.has("noun") || pos.has("adj"))) out.add(lemma);
    }
    if (tok.includes("-") && !this.lex.known.has(tok)) {
      const parts = tok.split("-");
      if (CLITICS.has(parts.at(-1) ?? "")) {
        // fazê-lo -> fazer, diga-me -> dizer (the clitic is dropped)
        let base = parts.slice(0, -1).join("-");
        if (/[áêô]$/.test(base)) base = `${stripAccents(base)}r`;
        else if (/[íi]$/.test(base) && /^l/.test(parts.at(-1) ?? ""))
          base = `${stripAccents(base)}r`;
        for (const l of this.analyzeString(base)) out.add(l);
      }
    } else if (!this.lex.known.has(tok) && !PT_IRREGULAR_OF.has(tok)) {
      for (const l of this.guess(tok)) out.add(l);
    }
    return out;
  }

  analyze(tok: string): Int32Array {
    let hit = this.cache.get(tok);
    if (!hit) {
      hit = Int32Array.from([...this.analyzeString(tok)].map((s) => this.id(s)));
      this.cache.set(tok, hit);
    }
    return hit;
  }

  lemmas(tok: string): string[] {
    return [...this.analyze(tok)].map((i) => this.strs[i] as string);
  }

  /** "tu" forms mark European Portuguese in Tatoeba (Brazilians use "você"). */
  isTuForm(tok: string): boolean {
    if (TU_FORMS.has(tok)) return true;
    if (this.lex.second.get(tok) === 1) return true;
    if (this.lex.known.has(tok) || !TWO_SG_ENDINGS.test(tok)) return false;
    return this.guess(tok).length > 0;
  }
}

const PT_TOKEN = /\p{L}+(?:-\p{L}+)*/gu;
const ptTokens = (text: string) => text.toLowerCase().match(PT_TOKEN) ?? [];

interface PtCheck {
  hard: string; // reason it is European Portuguese (or blocked); "" when fine
  soft: number; // how European it sounds (lower is more Brazilian)
}

function checkPortuguese(tokens: string[], an: PtAnalyzer): PtCheck {
  let soft = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (EU_WORDS.has(t) || t.endsWith("-vos")) return { hard: `pt-eu:${t}`, soft };
    if (PT_BLOCK.has(t)) return { hard: `pt-block:${t}`, soft };
    if (an.isTuForm(t)) return { hard: `pt-tu:${t}`, soft };
    const next = tokens[i + 1];
    if (next && EU_BIGRAMS.has(`${t} ${next}`) && (t !== "casa" || tokens[i + 2] === "banho"))
      return { hard: `pt-eu:${t} ${next}`, soft };
    // "estou a trabalhar": European progressive
    const after = tokens[i + 2];
    if (next === "a" && after && /r$/.test(after) && an.isVerb(after)) {
      const lemmas = an.lemmas(t);
      if (lemmas.includes("estar") || lemmas.includes("andar"))
        return { hard: "pt-eu:estar a", soft };
      if (lemmas.includes("continuar") || lemmas.includes("ficar")) soft += 1;
    }
    if (EU_SOFT.has(t) || EU_ACCENT.test(t)) soft += 1;
    // enclisis ("Vou-me embora", "Deixe-o ir", "dir-lhe-ei") is written Portuguese from
    // Portugal or very formal Brazilian: learners should see how Brazilians say it
    if (/-(me|te|se|lhes?|nos|vos|[ao]s?|l[ao]s?|n[ao]s?)(-|$)/.test(t)) {
      return { hard: `pt-enclisis:${t}`, soft };
    }
    if (t === "você" || t === "vocês") soft -= 0.5;
  }
  return { hard: "", soft };
}

// --- English tokens -----------------------------------------------------------------------------

interface Tok {
  w: string; // lowercase, contractions expanded
  raw: string;
  lit: boolean; // written as is (a cloze can blank it)
  initial: boolean;
  num: boolean;
}

const EN_WORD = /(?<![\p{L}\p{N}])[ap]\.m\.|[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*'?/giu;
const CONTRACTIONS: Record<string, string[]> = {
  "can't": ["can", "not"],
  "won't": ["will", "not"],
  "shan't": ["shall", "not"],
  cannot: ["can", "not"],
  "let's": ["let", "us"],
};
const CLITIC_EN: Record<string, string> = {
  m: "am",
  re: "are",
  ve: "have",
  ll: "will",
  d: "would",
  s: "'s",
};

const countWords = (text: string) => (text.replace(/’/g, "'").match(EN_WORD) ?? []).length;

function tokenizeEn(text: string, isForm: (w: string) => boolean): Tok[] {
  const out: Tok[] = [];
  const matches = text.replace(/’/g, "'").match(EN_WORD) ?? [];
  for (const [i, raw] of matches.entries()) {
    const lower = raw.toLowerCase();
    const initial = i === 0;
    const add = (w: string, lit: boolean, piece = w) => {
      out.push({ w, raw: piece, lit, initial, num: /^\d/.test(w) });
    };
    const fixed = CONTRACTIONS[lower];
    if (fixed) {
      for (const w of fixed) add(w, false);
      continue;
    }
    if (/^\d/.test(lower) || isForm(lower) || !/['-]/.test(lower)) {
      add(lower, true, raw);
      continue;
    }
    if (lower.endsWith("n't")) {
      add(lower.slice(0, -3), false, raw.slice(0, -3));
      add("not", false);
      continue;
    }
    const m = /^(.+)'(m|re|ve|ll|d|s)$/i.exec(raw);
    if (m?.[1] && m[2]) {
      add(m[1].toLowerCase(), false, m[1]);
      add(CLITIC_EN[m[2].toLowerCase()] ?? m[2], false);
      continue;
    }
    if (lower.endsWith("'")) {
      add(lower.slice(0, -1), false, raw.slice(0, -1));
      continue;
    }
    if (lower.includes("-") && !lower.includes("'")) {
      for (const part of raw.split("-")) if (part) add(part.toLowerCase(), false, part);
      continue;
    }
    add(lower, true, raw);
  }
  return out;
}

// --- context rules for words with several entries -----------------------------------------------

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
const DETS = words(`
  a an the my your his her its our their this that these those some any no every each another
  many much few several whose which what all both either neither 's`);
const SUBJ = words("i you we they he she it who");
const BEFORE_VERB = words(`
  to can could will would shall should may might must do does did not never always often usually
  also just please let sometimes still ever already`);
const BE = words("am is are was were be been being");
const LINKING = words(`
  look looks looked feel feels felt seem seems seemed get gets got become became stay sound
  sounds taste smells smell very so too quite really pretty more most less how as`);
const OBJ = words("me you him her it us them");
const PARTICLES = words("up down out in on off away back here there as to at for with");
const IS_BEFORE = words(`
  it he she that what there here who where how when this everything nothing everyone everybody
  something someone somebody why which`);

// expressions whose words are not the vocabulary item: "of course" is not about a course
// biome-ignore format: a word list
const FIXED = [
  "of course", "as well", "at least", "at all", "right now", "right away", "by the way",
  "in front of", "thank you", "no longer", "so far", "kind of", "at last",
].map((x) => x.split(" "));
const NAME_TOKENS = new Set(["tom", "mary"]);

interface Cand {
  e: Entry;
  infl: Infl;
}

interface Scored {
  key: string;
  score: number;
  cooc: number; // share of the word's sentences whose translation has it
  lift: number; // the same above the base rate
  prior: number; // Wiktionary support, 0..1
  match: number; // Wiktionary support with the same part of speech, 0..1
  pf: number; // part-of-speech agreement
  wikt: boolean;
  df: number; // Brazilian translations (any word) that contain it
}

interface Gloss {
  gloss: string;
  alt: string[];
  conf: number;
  why: string;
  top: Scored[];
}

const FUNCTION_PT = new Set(["pron", "article", "prep", "conj", "contraction", "num", "abbrev"]);
const INHERITED_POS = new Set(["adj", "pron", "num", "article"]);
const withoutArticle = (s: string) => s.replace(/^(o|a|os|as|um|uma) /, "");
// the last word of a compound preposition, contractions folded ("perto da" -> "perto de")
// biome-ignore format: a table
const NGRAM_PREPS = new Map<string, string>([
  ["de", "de"], ["do", "de"], ["da", "de"], ["dos", "de"], ["das", "de"], ["a", "a"], ["ao", "a"],
  ["à", "a"], ["aos", "a"], ["às", "a"], ["em", "em"], ["no", "em"], ["na", "em"], ["nos", "em"],
  ["nas", "em"], ["para", "para"], ["por", "por"], ["pelo", "por"], ["pela", "por"], ["com", "com"],
]);
const NGRAM_ADV_HEADS = new Set(["para", "de", "em", "por", "lá", "ali", "aqui", "pra"]);
// glosses that start like a definition ("que serve para...") are not translations
const DEFINITION_WORDS =
  `que quem aquele aquela aquilo qualquer ato ação relativo diz-se usado forma indica
  expressa variante tipo espécie nome abreviação abreviatura sigla símbolo plural feminino
  diminutivo mesmo_que`
    .split(/\s+/)
    .map((w) => w.replace(/_/g, " "));
const DEFINITION_START = new RegExp(`^(${DEFINITION_WORDS.join("|")})(?!\\p{L})`, "u");

// --- main ---------------------------------------------------------------------------------------

interface SentenceOut {
  id: string;
  en: string;
  pt: string;
  alt_en: string[];
  level: string;
  words: string[];
  src: string;
}

interface WordOut {
  id: string;
  word: string;
  pos: string;
  level: string;
  rank: number;
  gloss: string;
  alt: string[];
  conf: number;
  forms: string[];
  examples: string[];
}

// Hand fixes for high-frequency words the statistics get wrong; each one was checked.
const OVERRIDES: Record<string, { gloss: string; alt?: string[] }> = {
  // Wiktionary only has the Latin degree ("artium magister")
  "a.m..adv": { gloss: "da manhã", alt: ["de manhã", "manhã"] },
  "p.m..adv": { gloss: "da tarde", alt: ["da noite", "tarde", "noite"] },
  // Tatoeba spreads it over a dozen verbs; none reaches the teaching threshold
  "get.v": { gloss: "conseguir", alt: ["obter", "pegar", "receber", "ficar"] },
  "turn.v": { gloss: "virar", alt: ["girar", "transformar", "ficar"] },
  "away.adv": { gloss: "longe", alt: ["embora", "fora", "distante"] },
  "back.adv": { gloss: "de volta", alt: ["para trás", "atrás", "voltar"] },
  "up.prep": { gloss: "para cima", alt: ["em cima", "acima"] },
  "around.prep": {
    gloss: "ao redor de",
    alt: ["em volta de", "por volta de", "em torno de", "perto de"],
  },
  // "que" and "o que" are everywhere, so the base rate hides them
  "what.pron": { gloss: "o que", alt: ["que", "qual"] },
  "anything.pron": { gloss: "alguma coisa", alt: ["algo", "qualquer coisa", "nada"] },
  "those.det": { gloss: "aqueles", alt: ["aquelas", "esses", "essas"] },
  // "seu" is also "your": dele/dela/deles is what a learner can map back
  "his.det": { gloss: "dele", alt: ["seu", "sua"] },
  "her.det": { gloss: "dela", alt: ["seu", "sua"] },
  "their.det": { gloss: "deles", alt: ["delas", "seu", "sua"] },
  // no Wiktionary entry
  "all_right.adj": { gloss: "tudo bem", alt: ["bem", "certo", "ok"] },
  "all_right.adv": { gloss: "tudo bem", alt: ["bem", "certo", "ok"] },
  "sure.adj": { gloss: "certo", alt: ["seguro", "com certeza", "certeza"] },
  // Tatoeba writes "TV" more often; the word is what a learner needs
  "TV.n": { gloss: "televisão", alt: ["TV", "tevê"] },
  "CV.n": { gloss: "currículo", alt: ["CV"] },
  // Wiktionary offers "vegetal"/"hortaliça"; Brazilians say "legume" or "verdura"
  "vegetable.n": { gloss: "legume", alt: ["verdura", "vegetal", "hortaliça"] },
  // "a lot" is "muito"; Wiktionary only has lot = "lote", "destino"
  "lot.pron": { gloss: "muito", alt: ["bastante", "muitos", "vários"] },
  "lot.adv": { gloss: "muito", alt: ["bastante"] },
  "hers.pron": { gloss: "dela", alt: ["seu", "sua"] },
  // Tatoeba is full of "a few" (alguns); "few" alone is "poucos"
  "few.det": { gloss: "poucos", alt: ["alguns", "pouco"] },
  "else.adv": { gloss: "mais", alt: ["outro", "outra coisa", "de outro modo"] },
  "o'clock.adv": { gloss: "em ponto", alt: ["hora", "horas"] },
  // Portuguese drops "it" or uses o/a; ele/ela alone would read as "he/she"
  "it.pron": { gloss: "isso", alt: ["ele", "ela", "o", "a"] },
  // CEFR-J lists these as a noun and an adjective; Portuguese says them as interjections
  "hello.n": { gloss: "olá", alt: ["oi", "alô"] },
  "sorry.adj": { gloss: "desculpe", alt: ["desculpa", "sinto muito", "arrependido", "com pena"] },
  "most.det": { gloss: "a maioria", alt: ["maioria", "mais", "maior parte"] },
  "than.prep": { gloss: "do que", alt: ["que", "de"] },
  "than.conj": { gloss: "do que", alt: ["que", "de"] },
  "each_other.pron": { gloss: "um ao outro", alt: ["uns aos outros", "se"] },
  "yourself.pron": { gloss: "você mesmo", alt: ["se", "si mesmo", "você"] },
};

const MALE = ["Lucas", "Pedro", "Leo", "Rafael", "Noah", "Daniel", "Gabriel", "Bruno"];
const FEMALE = ["Ana", "Julia", "Mia", "Sofia", "Emma", "Laura", "Clara", "Helena"];
const REPLACED: Record<string, string[]> = { Tom: MALE, Mary: FEMALE };
// other first names left as they are (they must appear in the Portuguese too)
const KEPT_NAMES = new Set(
  `John Alice Jack Bob Jane Emily Paul Peter David Kate Mike Lucy Nancy Tony Jim Betty Susan Mark
  Ann Anna Sarah Ben Linda Bill Maria Ken`.split(/\s+/),
);
const ALL_NAMES = new Set([...KEPT_NAMES, ...MALE, ...FEMALE]);
const NAMES_RE = new RegExp(`\\b(${[...ALL_NAMES].join("|")})\\b`, "g");
const NATIVE_OWNERS = new Set(
  `CK CM CH CN CT CC CF Hybrid Spamster OsoHombre AlanF_US shekitten _undertoad Zifre Scott Eccles17
  papabear Source_VOA mailohilohi erikspen CarpeLanam`.split(/\s+/),
);

// sentences with these (English) words are not used: violence, death, drugs, sex, religion,
// politics, insults
const BLOCK_WORDS = words(`kill kills killed killing killer killers murder murders murdered
  murderer suicide gun guns shoot shoots shot shooting bomb bombs bombed weapon weapons blood
  bloody bleed bleeding die dies died dying dead death deaths drug drugs drunk sex sexy naked
  war wars army soldier soldiers attack attacked terrorist rape stab stabbed poison poisoned
  religion religious pray prays prayed praying prayer god gods heaven hell devil jesus christ
  christian politics political politician politicians election elections stupid idiot idiots
  fool fools moron dumb damn corpse funeral grave coffin cancer`);
const BLOCK_PATTERNS = [
  /\b(sleep|slept|sleeping|sleeps) with\b/i,
  /\bmake love\b/i,
  /\b(hang|hanged|hung) (him|her|my|your|them|our)sel(f|ves)\b/i,
  /\byou(?:'re| are| look) (so |very |too |really )?(fat|ugly|lazy|crazy|weird)\b/i,
  /\b(black|white|asian) (people|man|men|woman|women|guy|guys)\b/i,
];

async function main(): Promise<void> {
  const input = path.resolve(process.argv[2] ?? DEFAULT_INPUT);
  const report: string[] = [];
  const stats = new Map<string, number>();
  const bump = (k: string, n = 1) => stats.set(k, (stats.get(k) ?? 0) + n);

  // 1. word list and candidate forms
  const entries = await loadEntries(path.join(input, "olp", "cefrj-vocabulary-profile-1.5.csv"));
  progress(`${entries.length} CEFR-J entries A1-B1`);
  const cand = entries.map(candidateForms);

  // 2. Wiktionary
  const lex = await loadLexicon(path.join(input, "wikt", "ptwikt.jsonl.gz"));
  const an = new PtAnalyzer(lex);
  progress(`Wiktionary: ${lex.lemmaPos.size} pt lemmas, ${lex.en.size} en entries`);

  // 3. Tatoeba links and Portuguese sentences
  const linksEn = new Map<number, number[]>();
  const linksPt = new Map<number, number[]>();
  for await (const line of readLines(path.join(input, "tatoeba", "eng-por_links.tsv"))) {
    const [a, b] = line.split("\t");
    if (!a || !b) continue;
    push(linksEn, Number(a), Number(b));
    push(linksPt, Number(b), Number(a));
  }
  const pt = new Map<number, { text: string; toks: string[]; check: PtCheck }>();
  for await (const line of readLines(path.join(input, "tatoeba", "por_sentences.tsv"))) {
    const [id, , text] = line.split("\t");
    const n = Number(id);
    if (!text || !linksPt.has(n)) continue;
    const toks = ptTokens(text);
    const check = checkPortuguese(toks, an);
    bump(check.hard ? `pt rejected (${check.hard.split(":")[0]})` : "pt accepted");
    pt.set(n, { text: text.trim(), toks, check });
  }
  progress(`${pt.size} linked Portuguese sentences`);

  // 4. English: document frequency over the whole corpus, texts of the linked ones
  const phraseFirst = new Map<string, Array<{ e: Entry; toks: string[] }>>();
  cand.forEach((c, i) => {
    const e = entries[i] as Entry;
    for (const toks of c.multi) push(phraseFirst, toks[0] ?? "", { e, toks });
  });
  const candidateSet = new Set<string>();
  for (const c of cand) for (const [f] of c.single) candidateSet.add(f);
  const docFreq = new Map<string, number>();
  const phraseFreq = new Map<Entry, number>();
  const en = new Map<number, { text: string; owner: string }>();
  let enTotal = 0;
  const lastSeen = new Map<string, number>();
  for await (const line of readLines(path.join(input, "tatoeba", "eng_sentences_detailed.tsv"))) {
    const [id, , text, owner] = line.split("\t");
    if (!text) continue;
    enTotal++;
    const n = Number(id);
    if (linksEn.has(n)) en.set(n, { text: text.trim(), owner: owner ?? "" });
    // a cheap split is enough for counts: contractions only lose their clitic
    const toks =
      text
        .toLowerCase()
        .replace(/’/g, "'")
        .match(/[a-z0-9]+(?:['.-][a-z0-9]+)*/g) ?? [];
    const found = new Set<Entry>();
    for (let i = 0; i < toks.length; i++) {
      let t = toks[i] as string;
      if (!candidateSet.has(t)) t = t.replace(/(n't|'[a-z]+)$/, "");
      if (candidateSet.has(t) && lastSeen.get(t) !== enTotal) {
        lastSeen.set(t, enTotal);
        docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
      }
      for (const p of phraseFirst.get(t) ?? [])
        if (p.toks.every((w, j) => j === 0 || toks[i + j] === w)) found.add(p.e);
    }
    for (const e of found) phraseFreq.set(e, (phraseFreq.get(e) ?? 0) + 1);
  }
  progress(`${enTotal} English sentences, ${en.size} linked to Portuguese`);

  // 5. forms seen in Tatoeba (irregular ones and the base always count)
  const formMap = new Map<string, Cand[]>();
  cand.forEach((c, i) => {
    const e = entries[i] as Entry;
    const irr = IRREGULAR.get(e.word.toLowerCase());
    for (const [f, infl] of c.single) {
      const trusted =
        infl === "base" ||
        infl === "var" ||
        irr?.past.includes(f) ||
        irr?.pp.includes(f) ||
        Object.values(IRREGULAR_PLURALS).includes(f) ||
        (EXTRA_FORMS[e.id] ?? []).includes(f);
      if (e.forms.has(f) || (!trusted && (docFreq.get(f) ?? 0) < 2)) continue;
      e.forms.set(f, infl);
      push(formMap, f, { e, infl });
    }
    const seenPhrases = new Set<string>();
    for (const toks of c.multi) {
      const key = toks.join(" ");
      if (seenPhrases.has(key)) continue;
      seenPhrases.add(key);
      e.phrases.push(toks);
    }
    if (/^[A-Z]{2,}$/.test(e.word) && e.word.toLowerCase() !== e.word) {
      e.capsOnly = entries.some(
        (o) =>
          o !== e && o.word.toLowerCase() === e.word.toLowerCase() && !/^[A-Z]{2,}$/.test(o.word),
      );
    }
  });
  const isForm = (w: string) => formMap.has(w);
  const phraseMap = new Map<string, Entry[]>();
  for (const e of entries) for (const p of e.phrases) push(phraseMap, p[0] ?? "", e);

  // 6. linked English sentences: tokens -> entries
  const hasNoun = (w: string | undefined) =>
    !!w &&
    (formMap.get(w) ?? []).some((c) => c.e.info.pos === "noun" || c.e.info.pos === "adjective");

  /** One entry per token (or null), phrases first, then the context rules. */
  function assign(toks: Tok[]): Array<{ e: Entry | null; infl: Infl | null; covered: boolean }> {
    const out: Array<{ e: Entry | null; infl: Infl | null; covered: boolean }> = toks.map(() => ({
      e: null,
      infl: null,
      covered: false,
    }));
    for (let i = 0; i < toks.length; i++) {
      for (const fx of FIXED) {
        if (!fx.every((w, j) => toks[i + j]?.w === w)) continue;
        for (let j = 0; j < fx.length; j++) out[i + j] = { e: null, infl: null, covered: true };
      }
    }
    for (let i = 0; i < toks.length; i++) {
      if (out[i]?.covered) continue;
      let best: { e: Entry; len: number } | null = null;
      for (const e of phraseMap.get(toks[i]?.w ?? "") ?? []) {
        for (const p of e.phrases) {
          if (!p.every((w, j) => toks[i + j]?.w === w && !out[i + j]?.covered)) continue;
          // "I'm used to it" is the adjective, "I used to" the modal
          if (e.id === "used_to.modal" && BE.has(toks[i - 1]?.w ?? "")) continue;
          if (!best || p.length > best.len) best = { e, len: p.length };
        }
      }
      if (best) {
        out[i] = { e: best.e, infl: "base", covered: false };
        for (let j = 1; j < best.len; j++) out[i + j] = { e: null, infl: null, covered: true };
        i += best.len - 1;
      }
    }
    for (let i = 0; i < toks.length; i++) {
      const slot = out[i];
      const t = toks[i];
      if (!slot || !t || slot.e || slot.covered) continue;
      if (!t.initial && ALL_NAMES.has(t.raw)) continue; // "Mark" and "Bill" are names here
      const prev = toks[i - 1]?.w;
      const next = toks[i + 1]?.w;
      if (t.w === "'s") {
        if (prev && IS_BEFORE.has(prev)) {
          const be = (formMap.get("is") ?? [])[0];
          if (be) out[i] = { e: be.e, infl: "var", covered: false };
        }
        continue;
      }
      let cands = formMap.get(t.w) ?? [];
      const allCaps = /^[A-Z]{2,}$/.test(t.raw);
      cands = cands.filter((c) => !c.e.capsOnly || allCaps);
      if (allCaps) {
        const caps = cands.filter((c) => c.e.capsOnly);
        if (caps.length) cands = caps;
      }
      if (!cands.length) continue;
      if (cands.length === 1) {
        const c = cands[0] as Cand;
        out[i] = { e: c.e, infl: c.infl, covered: false };
        continue;
      }
      const prevEntry = out[i - 1]?.e;
      const prevTok = toks[i - 1];
      // "Tom left", "the kids saw": a noun or a name before a verb form is its subject
      const nominalPrev =
        !!prevTok &&
        (SUBJ.has(prevTok.w) ||
          NAME_TOKENS.has(prevTok.w) ||
          ALL_NAMES.has(prevTok.raw) ||
          prevEntry?.info.pos === "noun" ||
          (/^[A-Z]/.test(prevTok.raw) && !prevTok.initial && !prevEntry));
      const nextCands = formMap.get(next ?? "") ?? [];
      const nextVerb = nextCands.some((c) => c.e.info === VERB || c.e.info.pos === "modal");
      const nextNounOnly = nextCands.length > 0 && nextCands.every((c) => c.e.info.pos === "noun");
      // after "is": an adjective ends the phrase, an adverb leads into more ("is still young")
      const beforeMore =
        !!next &&
        (["here", "there", "a", "an", "the", "not", "in", "at", "on"].includes(next) ||
          nextCands.some((c) => c.e.info.pos === "adjective" || c.infl === "ing"));
      let bestScore = Number.NEGATIVE_INFINITY;
      let best = cands[0] as Cand;
      for (const c of cands) {
        const pos = c.e.info.pos;
        let s = -0.3 * c.e.level + (c.infl === "base" ? 0.4 : 0) - c.e.order * 1e-6;
        const afterDet = !!prev && (DETS.has(prev) || prevEntry?.info.pos === "adjective");
        if (pos === "noun") {
          if (afterDet) s += 2;
          if (prev && (BEFORE_VERB.has(prev) || SUBJ.has(prev)) && prev !== "to") s -= 1.5;
          if (prevEntry?.info === VERB && !nextVerb) s += 0.5;
        } else if (pos === "verb" || pos === "modal") {
          // imperatives open many Tatoeba sentences: "Walk as fast as you can", "Tie the apron"
          if (
            i === 0 &&
            c.infl === "base" &&
            (!next || DETS.has(next) || OBJ.has(next) || PARTICLES.has(next))
          )
            s += 2;
          // "Stop right now", "Love one another"
          else if (i === 0 && c.infl === "base" && !nextVerb) s += 1.2;
          if (prev && (BEFORE_VERB.has(prev) || SUBJ.has(prev))) s += 2;
          else if (nominalPrev && c.infl !== "ing") s += 1.5;
          if (afterDet && prev !== "that") s -= 2.5;
          if (c.infl === "ing" && prev && BE.has(prev)) s += 2;
          if ((c.infl === "past" || c.infl === "s") && !prev) s += 0.5;
        } else if (pos === "adjective") {
          if (prev && (BE.has(prev) || LINKING.has(prev)) && !beforeMore) s += 2;
          if (afterDet) s += hasNoun(next) && !nextVerb ? 1.5 : -0.5;
          if (nextVerb && !hasNoun(next)) s -= 0.8;
          if (nextNounOnly) s += 0.5;
          if (c.infl === "cmp") s += 0.5;
        } else if (pos === "adverb") {
          if (prevEntry && (prevEntry.info.pos === "verb" || prevEntry.info === VERB)) s += 1;
          // "I still love you", "she often goes", "he is still young"
          if (nextVerb && !nextNounOnly) s += 1.2;
          if (prev && BE.has(prev) && beforeMore) s += 2;
          if (prev && SUBJ.has(prev)) s += 0.8;
          if (!next) s += 0.5;
        } else if (pos === "preposition") {
          const place = /^[A-Z]/.test(toks[i + 1]?.raw ?? "") || /^\d/.test(next ?? "");
          if (next && (DETS.has(next) || OBJ.has(next) || hasNoun(next) || place)) s += 1.2;
        } else if (pos === "conjunction") {
          if (next && SUBJ.has(next)) s += 1;
        } else if (pos === "pronoun") {
          if (!next || BE.has(next) || BEFORE_VERB.has(next)) s += 1;
          if (hasNoun(next) && !BE.has(next ?? "")) s -= 1;
        } else if (pos === "determiner") {
          s += hasNoun(next) ? 1.5 : -0.5;
        } else if (pos === "number") {
          s += 0.5;
        } else if (pos === "interjection") {
          s += i === 0 ? 0.5 : -0.5;
        }
        if (c.e.capital) {
          const upper = /^[A-Z]/.test(t.raw);
          s += upper && !t.initial ? 3 : upper ? 0 : -2;
        }
        if (s > bestScore) {
          bestScore = s;
          best = c;
        }
      }
      out[i] = { e: best.e, infl: best.infl, covered: false };
    }
    return out;
  }

  const enIds = [...en.keys()].sort((a, b) => a - b);
  const entrySents: number[][] = entries.map(() => []);
  const entryAny: number[][] = entries.map(() => []);
  const shareCount = new Map<string, number>(); // "form|entry" -> occurrences
  const formCount = new Map<string, number>();
  const lemmaSets: Int32Array[] = [];
  const brPt: number[][] = []; // Brazilian translations per English sentence
  enIds.forEach((id, si) => {
    const rec = en.get(id);
    if (!rec) return;
    const toks = tokenizeEn(rec.text, isForm);
    const slots = assign(toks);
    const assigned = new Set<number>();
    const any = new Set<number>();
    slots.forEach((slot, i) => {
      const t = toks[i];
      if (!t) return;
      for (const c of formMap.get(t.w) ?? []) if (!c.e.capsOnly) any.add(c.e.n);
      if (!slot.e) return;
      assigned.add(slot.e.n);
      if (!slot.e.phrases.length || slot.e.forms.has(t.w)) {
        const k = `${t.w}|${slot.e.n}`;
        shareCount.set(k, (shareCount.get(k) ?? 0) + 1);
        formCount.set(t.w, (formCount.get(t.w) ?? 0) + 1);
      }
    });
    for (const n of assigned) {
      entrySents[n]?.push(si);
      any.add(n);
    }
    for (const n of any) entryAny[n]?.push(si);
    const br = (linksEn.get(id) ?? []).filter((p) => {
      const s = pt.get(p);
      return !!s && !s.check.hard;
    });
    brPt.push(br);
    const set = new Set<number>();
    for (const p of br)
      for (const tok of pt.get(p)?.toks ?? []) for (const l of an.analyze(tok)) set.add(l);
    lemmaSets.push(Int32Array.from([...set]).sort());
  });
  const lemmaDf = new Int32Array(an.strs.length + 1);
  const postings = new Map<number, number[]>();
  let withBr = 0;
  lemmaSets.forEach((set, si) => {
    if (set.length) withBr++;
    for (const l of set) {
      lemmaDf[l] = (lemmaDf[l] ?? 0) + 1;
      push(postings, l, si);
    }
  });
  progress(`assigned entries in ${enIds.length} linked sentences (${withBr} with Brazilian pt)`);

  // frequency for the teaching order: corpus counts of the forms, split between entries that
  // share a form by how the context rules assigned them in the linked sentences
  const freq = new Map<Entry, number>();
  for (const e of entries) {
    let f = phraseFreq.get(e) ?? 0;
    for (const form of e.forms.keys()) {
      const total = formCount.get(form) ?? 0;
      const sharers = (formMap.get(form) ?? []).length || 1;
      const share = total ? (shareCount.get(`${form}|${e.n}`) ?? 0) / total : 1 / sharers;
      f += (docFreq.get(form) ?? 0) * share;
    }
    freq.set(e, Math.round(f));
  }

  // 7. glosses
  const sharesForms = (e: Entry) =>
    [...e.forms.keys()].some((f) => (formMap.get(f) ?? []).length > 1);

  /** Portuguese parts of speech of a candidate; `all` adds those of the lemmas it is a form of. */
  function ptPosOf(candidate: string, all = false): Set<string> {
    const direct = lex.lemmaPos.get(candidate);
    if (all) {
      const out = new Set(direct ?? []);
      for (const lemma of lex.formOf.get(candidate) ?? [])
        for (const p of lex.lemmaPos.get(lemma) ?? []) out.add(p);
      return out;
    }
    if (direct?.size) {
      // "pior" is a noun and an adverb in Wiktionary; its adjective sense is on "mau"
      const out = new Set(direct);
      for (const lemma of lex.formOf.get(candidate) ?? [])
        for (const p of lex.lemmaPos.get(lemma) ?? []) if (INHERITED_POS.has(p)) out.add(p);
      return out;
    }
    const parts = candidate.split(" ");
    if (parts.length > 1) {
      const first = parts[0] ?? "";
      const firstPos = lex.lemmaPos.get(first) ?? new Set<string>();
      // "com fome", "de novo": a prepositional phrase works as an adjective or adverb
      if (["com", "de", "em", "a", "sem", "por", "ao", "à", "no", "na"].includes(first))
        return new Set(["adj", "adv", "prep", "intj"]);
      if (firstPos.has("verb")) return new Set(["verb"]);
      if (firstPos.has("noun")) return new Set(["noun"]);
      if (firstPos.has("adj")) return new Set(["adj", "noun"]);
      return new Set();
    }
    const forms = lex.formOf.get(candidate);
    if (forms?.size) {
      const out = new Set<string>();
      for (const lemma of forms) for (const p of lex.lemmaPos.get(lemma) ?? []) out.add(p);
      // "decepcionado" is listed as a participle; it is the adjective "disappointed"
      if (out.has("verb") && /[ai]d[oa]s?$/.test(candidate)) out.add("adj");
      return out;
    }
    return new Set();
  }

  let gerundVerbs = false; // set per word in chooseGlosses
  function posFactor(e: Entry, candidate: string, matched: boolean): number {
    const pos = ptPosOf(candidate);
    let pf = 0.3;
    if (!pos.size) pf = candidate.includes(" ") ? 0.75 : 0.6;
    else if (e.info.pt.some((p) => pos.has(p))) pf = 1;
    else if (e.info.ptNear.some((p) => pos.has(p))) pf = 0.5;
    // "correr" is a noun too in Wiktionary, but not what "run" (noun) means
    const verbal = e.info === VERB || e.info.pos === "modal";
    if (!verbal && !matched && pos.has("verb") && /r$/.test(candidate)) pf = Math.min(pf, 0.5);
    if (gerundVerbs && pos.has("verb") && /r$/.test(candidate)) pf = Math.max(pf, 0.6);
    if (candidate === e.word.toLowerCase() && /^[A-Z]{2,}$/.test(e.word)) pf = 1;
    return pf;
  }

  function splitGloss(g: string, e: Entry): string[] {
    if (/:\s*$/.test(g)) return [];
    const clean = g
      .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
      .replace(/["“”«»]/g, "")
      .trim();
    const out: string[] = [];
    for (let seg of clean.split(/[;,/]| ou /)) {
      if (/^\s*\p{L}{1,4}\.\s*$/u.test(seg)) continue; // "sra.": an abbreviation, not a gloss
      seg = seg
        .trim()
        .replace(/[.!?]+$/, "")
        .replace(/\s+/g, " ");
      if (e.info.pos === "noun")
        seg = seg.replace(/^(o|a|os|as|um|uma|uns|umas) (?=\p{L}{2,})/u, "");
      if (!seg || seg.length > 24 || seg.split(" ").length > 3) continue;
      if (/[^\p{L} '-]/u.test(seg)) continue;
      if (DEFINITION_START.test(seg)) continue;
      out.push(seg);
    }
    return out;
  }

  function isEuropean(candidate: string): boolean {
    if (candidate.includes("casa de banho")) return true;
    // "cómico", "ténis": Brazil writes a closed vowel before m/n (cômico, tênis)
    if (EU_ACCENT.test(candidate)) return true;
    return EU_WORDS.has(candidate) || candidate.split(/[ -]/).some((p) => EU_WORDS.has(p));
  }

  function chooseGlosses(): Map<Entry, Gloss> {
    const result = new Map<Entry, Gloss>();
    const multiCache = new Map<string, number>();
    const hasBr = (s: number) => (lemmaSets[s]?.length ?? 0) > 0;

    const phraseIn = (toks: string[], parts: number[][]): boolean => {
      for (let i = 0; i + parts.length <= toks.length; i++) {
        let ok = true;
        for (let j = 0; j < parts.length && ok; j++) {
          const set = an.analyze(toks[i + j] as string);
          ok = (parts[j] as number[]).some((c) => set.includes(c));
        }
        if (ok) return true;
      }
      return false;
    };
    const sentenceHasPhrase = (si: number, parts: number[][]): boolean =>
      (brPt[si] ?? []).some((p) => phraseIn(pt.get(p)?.toks ?? [], parts));

    for (const e of entries) {
      if (!e.vocab) continue;
      // candidates: glosses of the English entry, Portuguese words translated to it
      const prior = new Map<string, number>();
      const match = new Map<string, number>(); // the part of the prior with the same pos
      const add = (c: string, w: number, matched: boolean) => {
        const key = c.toLowerCase().normalize("NFC").trim();
        if (!key || isEuropean(key)) return;
        prior.set(key, (prior.get(key) ?? 0) + w);
        if (matched) match.set(key, (match.get(key) ?? 0) + w);
      };
      const lookups = new Set<string>();
      for (const v of e.lookup) {
        for (const x of [v, v.replace(/\.$/, "")]) {
          lookups.add(x);
          // "May" is the month: the modal "may" is another word
          if (!e.capital) lookups.add(x.toLowerCase());
        }
      }
      for (const v of lookups) {
        for (const w of lex.en.get(v) ?? []) {
          const matched = e.info.wikt.includes(w.pos);
          for (const sense of w.senses)
            for (const g of sense.glosses)
              for (const seg of splitGloss(g, e))
                add(seg, (matched ? 1 : 0.3) * sense.weight, matched);
        }
        const seen = new Set<string>();
        for (const r of lex.rev.get(v) ?? []) {
          const key = r.pt.toLowerCase();
          if (seen.has(key) || r.pt.length > 24 || r.pt.split(" ").length > 3) continue;
          seen.add(key);
          const matched = e.info.pt.includes(r.pos);
          add(r.pt, 0.6 * (matched ? 1 : 0.4), matched);
        }
      }
      // CD, DVD: Portuguese uses the same letters (a real word wins: TV is "televisão")
      if (/^[A-Z]{2,}$/.test(e.word) && !e.capsOnly) add(e.word, 0.15, false);
      const wiktKeys = new Set(prior.keys());

      // sentences where the context rules chose this entry (all with a form when no other
      // entry shares them)
      let sents = (entrySents[e.n] ?? []).filter(hasBr);
      if (sents.length < 5 && !sharesForms(e)) sents = (entryAny[e.n] ?? []).filter(hasBr);
      sents = sents
        .map((s) => ({ s, len: en.get(enIds[s] ?? 0)?.text.length ?? 0 }))
        .sort((a, b) => a.len - b.len || a.s - b.s)
        .slice(0, SAMPLE_CAP)
        .map((x) => x.s);
      const n = sents.length;
      const counts = new Map<number, number>();
      for (const s of sents)
        for (const l of lemmaSets[s] ?? []) counts.set(l, (counts.get(l) ?? 0) + 1);

      const coocOf = (key: string) => {
        const id = an.lookup(key);
        return id === undefined || !n ? 0 : (counts.get(id) ?? 0) / n;
      };
      gerundVerbs =
        e.info.pos === "noun" &&
        /ing$/.test(e.word) &&
        ![...wiktKeys].some((k) => lex.lemmaPos.get(k)?.has("noun") && coocOf(k) >= 0.05);
      // strong co-occurring lemmas Wiktionary did not offer (content words only)
      const open = ["noun", "verb", "adjective", "adverb", "interjection"].includes(e.info.pos);
      if (n >= 5) {
        // closed classes only take strong candidates ("isso" for that, "alguém" for somebody)
        const minCooc = open ? 0.1 : 0.3;
        const minLift = open ? 0.1 : 0.2;
        const stat = [...counts.entries()]
          .filter(([, c]) => c >= 3 && c / n >= minCooc)
          .map(([l, c]) => {
            const base = (lemmaDf[l] ?? 0) / withBr;
            return { l, lift: (c / n - base) / (1 - base), base };
          })
          .filter((x) => x.lift >= minLift)
          .sort((a, b) => b.lift - a.lift)
          .slice(0, 12);
        for (const { l, base } of stat) {
          const key = an.strs[l] as string;
          const pos = ptPosOf(key);
          const acronym = key === e.word.toLowerCase();
          if (prior.has(key) || !pos.size || isEuropean(key) || lex.proper.has(key)) continue;
          if (key.length < 3 && !acronym) continue;
          // forms only as participle adjectives ("decepcionado"), never "gosta" for a verb
          const participle = e.info.pos === "adjective" && /[ai]d[oa]s?$/.test(key);
          if (!lex.lemmaPos.has(key) && !participle) continue;
          if (open) {
            if ([...pos].some((p) => FUNCTION_PT.has(p)) || base > 0.03) continue;
          } else if (posFactor(e, key, false) < 0.5 || base > 0.1) continue;
          // an adjective that Portuguese says with a noun: "hungry" is "com fome"
          if (e.info.pos === "adjective" && pos.has("noun") && !pos.has("adj")) {
            prior.set(`com ${key}`, 0);
            continue;
          }
          if (open && posFactor(e, key, false) < (gerundVerbs ? 0.6 : 1)) continue;
          prior.set(key, 0);
        }
      }
      // Portuguese says many of these with two or three words: "perto de", "de volta"
      const ngrams = new Set<string>();
      if (["preposition", "adverb", "modal"].includes(e.info.pos) && n >= 5) {
        const seen = new Map<string, number>();
        for (const si of sents.slice(0, 800)) {
          const here = new Set<string>();
          for (const p of brPt[si] ?? []) {
            const toks = pt.get(p)?.toks ?? [];
            for (let i = 0; i < toks.length; i++) {
              for (const g of ptNgrams(toks, i, e.info.pos)) here.add(g);
            }
          }
          for (const g of here) seen.set(g, (seen.get(g) ?? 0) + 1);
        }
        const limit = Math.min(800, n);
        if (DEBUG.has(e.id))
          progress(
            `  n-grams: ${[...seen]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([g, c]) => `${g} ${c}`)
              .join(", ")}`,
          );
        for (const [g, c] of [...seen].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
          if (c < 3 || c / limit < 0.08 || prior.has(g) || isEuropean(g)) continue;
          prior.set(g, 0);
          ngrams.add(g);
        }
      }
      if (e.info.pos === "adjective") {
        for (const [key, p] of [...prior]) {
          if (key.includes(" ") || !lex.lemmaPos.get(key)?.has("noun") || coocOf(key) < 0.15)
            continue;
          if (!prior.has(`com ${key}`)) prior.set(`com ${key}`, 0.5 * p);
        }
      }
      if (!prior.size) {
        result.set(e, { gloss: "", alt: [], conf: 0, why: "no candidate", top: [] });
        continue;
      }

      const maxPrior = Math.max(...prior.values(), 1e-9);
      const maxMatch = Math.max(...match.values(), 1e-9);
      const w = n / (n + 4);
      const scored: Scored[] = [];
      for (const [key, p] of prior) {
        const parts = key.split(" ");
        let hits = 0;
        let df = 0;
        if (parts.length === 1) {
          const id = an.lookup(key);
          if (id !== undefined) {
            hits = counts.get(id) ?? 0;
            df = lemmaDf[id] ?? 0;
          }
        } else {
          const ids = parts.map((x) => {
            const id = an.lookup(x);
            return id === undefined ? [] : [id];
          });
          if (ids.every((x) => x.length)) {
            for (const s of sents) if (sentenceHasPhrase(s, ids)) hits++;
            let cached = multiCache.get(key);
            if (cached === undefined) {
              cached = 0;
              const rarest = ids
                .map((x) => x[0] as number)
                .sort((a, b) => (lemmaDf[a] ?? 0) - (lemmaDf[b] ?? 0))[0] as number;
              for (const si of postings.get(rarest) ?? []) if (sentenceHasPhrase(si, ids)) cached++;
              multiCache.set(key, cached);
            }
            df = cached;
          }
        }
        const cooc = n ? hits / n : 0;
        // above the base rate: "de" is in half of all translations, whatever the word
        const base = df / withBr;
        const lift = cooc > base ? (cooc - base) / (1 - base) : 0;
        const dice = (2 * hits) / (n + df || 1);
        const pn = p / maxPrior;
        const m = match.get(key) ?? 0;
        const pf = posFactor(e, key, m >= 0.3);
        // candidates found only by co-occurrence are often collocates ("skiing" -> "inverno")
        const source = wiktKeys.has(key) || ngrams.has(key) ? 1 : 0.8;
        const score = source * pf * (w * (lift + 0.5 * dice) + 0.3 * (1 - w) * pn + 0.08 * pn);
        scored.push({
          key,
          score,
          cooc,
          lift,
          prior: pn,
          match: m / maxMatch,
          pf,
          wikt: wiktKeys.has(key),
          df,
        });
      }
      // co-occurrence alone is a fallback when Wiktionary has a gloss that shows up, unless it
      // is in most translations ("falar" for talk): collocates ("livro" for reading) rarely are
      if (scored.some((sc) => sc.wikt && sc.match >= 0.3 && sc.pf === 1 && sc.cooc >= 0.1))
        for (const sc of scored)
          if (!sc.wikt && !ngrams.has(sc.key) && sc.cooc < 0.5) sc.score *= 0.5;
      // a word inside a better multiword gloss: "casa" in "dever de casa", "de" in "perto de"
      // (and "medo" in "com medo" when the phrase has the right part of speech)
      for (const sc of scored) {
        if (sc.key.includes(" ") || !sc.cooc) continue;
        let within = 0;
        let better = false;
        for (const m of scored) {
          const parts = m.key.split(" ");
          if (parts.length < 2 || !parts.some((x) => x === sc.key || an.lemmas(x).includes(sc.key)))
            continue;
          within += m.cooc;
          if (m.pf > sc.pf && m.cooc >= 0.2 * sc.cooc) better = true;
        }
        if (better || within >= 0.35 * sc.cooc) sc.score *= 0.5;
      }
      // and "em toda" inside "em toda parte"
      for (const sc of scored) {
        if (!sc.key.includes(" ")) continue;
        const longer = scored.some(
          (m) =>
            m.key.length > sc.key.length &&
            ` ${m.key} `.includes(` ${sc.key} `) &&
            m.cooc >= 0.5 * sc.cooc,
        );
        if (longer) sc.score *= 0.5;
      }

      // an inflected candidate and its lemma are one choice: "senhora"/"senhor" for "lady"
      const index = new Map(scored.map((sc, i) => [sc.key, i]));
      const parent = scored.map((_, i) => i);
      const find = (i: number): number => {
        let r = i;
        while (parent[r] !== r) r = parent[r] as number;
        return r;
      };
      scored.forEach((sc, i) => {
        const pos = ptPosOf(sc.key);
        for (const l of lex.formOf.get(sc.key) ?? []) {
          const j = index.get(l);
          // "estrela" is also a form of "estrelar": a noun and a verb are two choices
          if (j === undefined || ![...ptPosOf(l)].some((p) => pos.has(p))) continue;
          parent[find(i)] = find(j);
        }
      });
      const pluralEn = e.info.pos !== "noun" || /s$/.test(e.word) || e.word === "people";
      const groups = new Map<number, Scored[]>();
      scored.forEach((sc, i) => {
        push(groups, find(i), sc);
      });
      const acronym = /^[A-Z]{2,}$/.test(e.word);
      const valid = (sc: Scored) =>
        sc.key.length <= GLOSS_MAX &&
        (sc.key !== e.word.toLowerCase() || lex.lemmaPos.has(sc.key) || acronym);
      const ranked = [...groups.values()]
        .map((members) => {
          const top = [...members].sort((a, b) => b.score - a.score)[0] as Scored;
          // the spelling Wiktionary gives for this pos, else the form that is used the most
          const own = (sc: Scored) =>
            sc.cooc -
            members
              .filter((o) => o !== sc && an.lemmas(o.key).includes(sc.key))
              .reduce((a, o) => a + o.cooc, 0);
          // dictionaries list the masculine: "muitos", not "muitas"
          const feminine = (sc: Scored) =>
            /as?$/.test(sc.key) && members.some((o) => o.key === sc.key.replace(/a(s?)$/, "o$1"));
          // and the singular for a singular English noun: "luva", not "luvas"
          const plural = (sc: Scored) =>
            !pluralEn &&
            /s$/.test(sc.key) &&
            [...(lex.formOf.get(sc.key) ?? [])].some((l) => index.has(l));
          // and the infinitive for a verb: "querer", not "queria"
          const conjugated = (sc: Scored) =>
            (e.info === VERB || e.info.pos === "modal") &&
            !sc.key.includes(" ") &&
            !an.isVerb(sc.key);
          const rank = (sc: Scored) =>
            own(sc) +
            (sc.match >= 0.3 ? 0.3 : 0) -
            (feminine(sc) ? 0.25 : 0) -
            (plural(sc) ? 0.5 : 0) -
            (conjugated(sc) ? 0.5 : 0);
          const rep = members
            .filter(valid)
            .sort((a, b) => rank(b) - rank(a) || b.prior - a.prior)[0];
          return { top, rep, members };
        })
        .sort((a, b) => b.top.score - a.top.score || a.top.key.localeCompare(b.top.key));
      if (DEBUG.has(e.id)) {
        progress(`${e.id}: ${n} sentences`);
        for (const sc of [...scored].sort((a, b) => b.score - a.score).slice(0, 10))
          progress(
            `  ${sc.key} score=${sc.score.toFixed(3)} cooc=${sc.cooc.toFixed(2)} ` +
              `lift=${sc.lift.toFixed(2)} prior=${sc.prior.toFixed(2)} ` +
              `match=${sc.match.toFixed(2)} pf=${sc.pf} df=${sc.df} wikt=${sc.wikt}`,
          );
      }
      const top4 = ranked.slice(0, 4).map((g) => g.rep ?? g.top);
      // function words map loosely across languages ("more" is "mais", an adverb)
      const minPf = open && e.info.pos !== "adverb" && e.info.pos !== "interjection" ? 0.6 : 0.5;
      const bestGroup = ranked.find((g) => g.rep && g.rep.pf >= minPf);
      const best = bestGroup?.rep;
      if (!bestGroup || !best) {
        const other = ranked.find((g) => g.rep)?.rep;
        const why = other ? "no gloss with this part of speech" : "no candidate";
        result.set(e, {
          gloss: other ? display(other.key, e) : "",
          alt: [],
          conf: 0,
          why,
          top: top4,
        });
        continue;
      }
      const pf = best.pf;
      const lift = Math.max(...bestGroup.members.map((m) => m.lift));
      const evidence = Math.min(1, lift / 0.5);
      const wikt = bestGroup.members.some((m) => m.wikt);
      const priorBest = Math.max(...bestGroup.members.map((m) => m.prior));
      let conf = (w * evidence + (1 - w) * (wikt ? 0.5 * priorBest : 0)) * pf;
      if (wikt && evidence >= 0.3) conf += 0.1;
      conf = Math.max(0, Math.min(1, Math.round(conf * 100) / 100));
      const bestCooc = Math.max(...bestGroup.members.map((m) => m.cooc));
      const alt: string[] = [];
      for (const g of ranked) {
        const r = g.rep;
        if (alt.length >= 4) break;
        if (g === bestGroup || !r || r.pf < 1 || !g.members.some((m) => m.wikt)) continue;
        const pos = ptPosOf(r.key);
        if (open && pos.size && [...pos].every((p) => FUNCTION_PT.has(p))) continue;
        const gl = best.key;
        if (stripAccents(r.key) === stripAccents(gl) || withoutArticle(r.key) === gl) continue;
        if (gl.split(" ").includes(r.key)) continue; // "manhã" is not a synonym of "café da manhã"
        const cooc = Math.max(...g.members.map((m) => m.cooc));
        const match = Math.max(...g.members.map((m) => m.match));
        // rare dictionary words ("varão" for man) are not what a learner would answer
        if (r.df < 3) continue;
        if (
          cooc >= Math.max(0.03, 0.1 * bestCooc) ||
          (match >= 0.5 && r.df >= 20 && (cooc > 0 || n < 5))
        )
          alt.push(display(r.key, e));
      }
      result.set(e, { gloss: display(best.key, e), alt, conf, why: "", top: top4 });
    }
    return result;
  }

  /** "perto de", "ao lado de" (prepositions); "de volta", "para cima" (adverbs). */
  function ptNgrams(toks: string[], i: number, kind: string): string[] {
    const prep = kind === "preposition";
    const t1 = toks[i] as string;
    const t2 = toks[i + 1];
    const t3 = toks[i + 2];
    const out: string[] = [];
    const prepOf = (t: string | undefined) => (t ? (NGRAM_PREPS.get(t) ?? "") : "");
    const posOf = (t: string | undefined) => (t ? ptPosOf(t, true) : new Set<string>());
    // content words only: no "para o", no names ("em boston")
    const content = (t: string | undefined, ...want: string[]) => {
      const p = posOf(t);
      return (
        !!t &&
        t.length > 2 &&
        !prepOf(t) &&
        want.some((w) => p.has(w)) &&
        ![...p].some((x) => FUNCTION_PT.has(x))
      );
    };
    if (!t2 || lex.proper.has(t1) || lex.proper.has(t2) || (t3 && lex.proper.has(t3))) return out;
    if (kind === "modal") {
      // "tenho que ir" -> "ter que"
      const verb = an.lemmas(t1).find((l) => an.isVerb(l) && l !== "ser" && l !== "estar");
      if (verb && (t2 === "que" || t2 === "de")) out.push(`${verb} ${t2}`);
      return out;
    }
    if (prep) {
      const p2 = prepOf(t2);
      if (p2 && !prepOf(t1) && (posOf(t1).has("adv") || posOf(t1).has("prep")))
        out.push(`${t1} ${p2}`);
      const p3 = prepOf(t3);
      if (p3 && prepOf(t1) && content(t2, "noun")) out.push(`${t1} ${t2} ${p3}`);
    } else if (NGRAM_ADV_HEADS.has(t1)) {
      if (content(t2, "adv", "noun")) out.push(`${t1} ${t2}`);
      // "em outro lugar", "de maneira diferente"
      const det = posOf(t2).has("pron") || posOf(t2).has("adj");
      if (t3 && det && content(t3, "noun")) out.push(`${t1} ${t2} ${t3}`);
      if (t3 && content(t2, "noun") && content(t3, "adj")) out.push(`${t1} ${t2} ${t3}`);
    }
    return out;
  }

  function display(key: string, e: Entry): string {
    if (/^[A-Z]{2,}$/.test(e.word) && key === e.word.toLowerCase()) return e.word; // TV, CD
    const cased = lex.cased.get(key);
    if (e.capital && cased && !lex.lemmaPos.has(key)) return cased;
    return key;
  }

  const glosses = chooseGlosses();
  // overrides
  for (const e of entries) {
    const o = OVERRIDES[e.id];
    const g = glosses.get(e);
    if (o && g) {
      g.gloss = o.gloss;
      g.alt = o.alt ?? g.alt.filter((a) => a !== o.gloss);
      g.conf = Math.max(g.conf, 0.9);
      g.why = "";
    }
  }
  progress("glosses chosen");

  // 8. sentence pairs
  interface Rec {
    enId: number;
    ptId: number;
    en: string;
    pt: string;
    level: number;
    words: Entry[];
    nWords: number;
    native: boolean;
    litEntries: Set<Entry>;
    ptLemmas: Set<string>;
    difficulty: number;
    toks: Set<string>;
    names: Map<string, string>;
  }
  const rank = new Map<Entry, number>();
  const ordered = entries
    .filter((e) => e.vocab)
    .sort(
      (a, b) => a.level - b.level || (freq.get(b) ?? 0) - (freq.get(a) ?? 0) || a.order - b.order,
    );
  ordered.forEach((e, i) => {
    rank.set(e, i + 1);
  });
  const unknownCount = new Map<string, number>();

  /** Tokens of an English sentence as they would be graded; null when not usable. */
  function analyzeEn(
    text: string,
    ptText: string | null,
  ): { level: number; slots: ReturnType<typeof assign>; toks: Tok[] } | string {
    const nw = countWords(text);
    if (nw < MIN_WORDS || nw > MAX_WORDS) return "length";
    if (/[^\p{L}\p{N}\s.,!?'’"“”:;$%-]/u.test(text)) return "characters";
    const toks = tokenizeEn(text, isForm);
    for (const p of BLOCK_PATTERNS) if (p.test(text)) return "content";
    for (const t of toks) if (BLOCK_WORDS.has(t.w)) return "content";
    const slots = assign(toks);
    let level = 0;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i] as Tok;
      const slot = slots[i];
      if (slot?.e) {
        level = Math.max(level, slot.e.level);
        continue;
      }
      if (slot?.covered || t.num || t.w === "'s") continue;
      if (ALL_NAMES.has(t.raw)) {
        const re = new RegExp(`(?<!\\p{L})${t.raw}(?!\\p{L})`, "u");
        if (ptText !== null && !re.test(ptText)) return "name missing in pt";
        continue;
      }
      const extra = EXTRA_KNOWN[t.w];
      if (extra !== undefined) {
        level = Math.max(level, extra);
        continue;
      }
      if (/^[A-Z]/.test(t.raw) && !t.initial) return "proper noun";
      unknownCount.set(t.w, (unknownCount.get(t.w) ?? 0) + 1);
      return "unknown word";
    }
    return { level, slots, toks };
  }

  const recs: Rec[] = [];
  const usedEn = new Set<string>();
  const usedPt = new Set<string>();
  const normEn = (s: string) =>
    s
      .toLowerCase()
      .replace(/’/g, "'")
      .replace(/[^\p{L}\p{N}' ]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  // preferred versions first, so the kept one of two near-duplicates is the better one
  const order = enIds
    .map((id, si) => ({ id, si, rec: en.get(id) }))
    .filter((x) => x.rec)
    .sort((a, b) => {
      const na = NATIVE_OWNERS.has(a.rec?.owner ?? "") ? 0 : 1;
      const nb = NATIVE_OWNERS.has(b.rec?.owner ?? "") ? 0 : 1;
      return na - nb || (a.rec?.text.length ?? 0) - (b.rec?.text.length ?? 0) || a.id - b.id;
    });
  for (const { id, si, rec } of order) {
    if (!rec) continue;
    // teu/tua/contigo are fine for statistics, not for teaching Brazilian Portuguese
    const options = (brPt[si] ?? [])
      .map((p) => ({ p, s: pt.get(p) }))
      .filter((x) => x.s && !x.s.toks.some((t) => EU_SOFT.has(t)))
      .sort(
        (a, b) =>
          (a.s?.check.soft ?? 0) - (b.s?.check.soft ?? 0) ||
          (a.s?.text.length ?? 0) - (b.s?.text.length ?? 0) ||
          a.p - b.p,
      );
    if (!options.length) {
      bump("pair: no Brazilian translation");
      continue;
    }
    // names: Tom and Mary are replaced (same name in both texts), others kept
    let chosen: { p: number; text: string; en: string; names: Map<string, string> } | null = null;
    let why = "";
    for (const o of options) {
      const ptText = o.s?.text ?? "";
      const names = new Map<string, string>();
      let enText = rec.text;
      let ok = true;
      for (const [name, pool] of Object.entries(REPLACED)) {
        const reEn = new RegExp(`\\b${name}\\b`, "g");
        const rePt = new RegExp(`(?<!\\p{L})${name}(?!\\p{L})`, "gu");
        const inEn = reEn.test(enText);
        const inPt = rePt.test(ptText);
        if (inEn !== inPt) {
          ok = false;
          break;
        }
        if (!inEn) continue;
        let k = id % pool.length;
        let pick = pool[k] as string;
        for (
          let tries = 0;
          tries < pool.length && (rec.text.includes(pick) || ptText.includes(pick));
          tries++
        ) {
          k = (k + 1) % pool.length;
          pick = pool[k] as string;
        }
        names.set(name, pick);
      }
      if (!ok) {
        why = "name missing in pt";
        continue;
      }
      let ptOut = ptText;
      for (const [name, pick] of names) {
        enText = enText.replace(new RegExp(`\\b${name}\\b`, "g"), pick);
        ptOut = ptOut.replace(new RegExp(`(?<!\\p{L})${name}(?!\\p{L})`, "gu"), pick);
      }
      const ptWords = ptTokens(ptOut).length;
      const enWords = countWords(enText);
      if (ptWords > 2.5 * enWords + 2 || ptWords * 2.5 + 2 < enWords) {
        why = "length mismatch";
        continue;
      }
      chosen = { p: o.p, text: ptOut, en: enText, names };
      break;
    }
    if (!chosen) {
      bump(`pair: ${why || "no translation"}`);
      continue;
    }
    const analysis = analyzeEn(chosen.en, chosen.text);
    if (typeof analysis === "string") {
      bump(`pair: ${analysis}`);
      continue;
    }
    const key = normEn(chosen.en.replace(NAMES_RE, "NAME"));
    const ptKey = normEn(chosen.text);
    if (usedEn.has(key) || usedPt.has(ptKey)) {
      bump("pair: near-duplicate");
      continue;
    }
    usedEn.add(key);
    usedPt.add(ptKey);
    const wordsIn: Entry[] = [];
    const lit = new Set<Entry>();
    analysis.slots.forEach((slot, i) => {
      if (!slot.e?.vocab) return;
      if (!wordsIn.includes(slot.e)) wordsIn.push(slot.e);
      if (analysis.toks[i]?.lit) lit.add(slot.e);
    });
    const ptLemmas = new Set<string>();
    for (const tok of ptTokens(chosen.text)) for (const l of an.lemmas(tok)) ptLemmas.add(l);
    const ranks = wordsIn.map((e) => rank.get(e) ?? ordered.length);
    const difficulty = ranks.length
      ? ranks.reduce((a, b) => a + b, 0) / ranks.length / ordered.length
      : 0;
    recs.push({
      enId: id,
      ptId: chosen.p,
      en: chosen.en,
      pt: chosen.text,
      level: analysis.level,
      words: wordsIn,
      nWords: countWords(chosen.en),
      native: NATIVE_OWNERS.has(rec.owner),
      litEntries: lit,
      ptLemmas,
      difficulty,
      toks: new Set(analysis.toks.map((t) => t.w)),
      names: chosen.names,
    });
    bump("pair: usable");
  }
  progress(`${recs.length} usable sentence pairs`);

  // 9. examples per word, then the pool per level
  const byEntry = new Map<Entry, Rec[]>();
  for (const r of recs) for (const e of r.words) push(byEntry, e, r);
  const keep = new Set<Rec>();
  const examples = new Map<Entry, Rec[]>();
  const glossLemmas = (e: Entry): Set<string> => {
    const g = glosses.get(e);
    const out = new Set<string>();
    for (const x of [g?.gloss ?? "", ...(g?.alt ?? [])]) {
      if (!x) continue;
      const first = x.toLowerCase().split(" ")[0] ?? "";
      for (const l of an.lemmas(first)) out.add(l);
    }
    return out;
  };
  const jaccard = (a: Set<string>, b: Set<string>) => {
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / (a.size + b.size - inter || 1);
  };
  for (const e of ordered) {
    const g = glosses.get(e);
    if (!g?.gloss || g.conf < MIN_CONF) continue;
    const gl = glossLemmas(e);
    const scoredRecs = (byEntry.get(e) ?? []).map((r) => {
      let s = r.nWords * 0.15 + r.difficulty * 2 + (r.native ? 0 : 0.3);
      if (r.level > e.level) s += 3;
      if (!r.litEntries.has(e)) s += 2;
      if (![...gl].some((l) => r.ptLemmas.has(l))) s += 1.5;
      return { r, s };
    });
    scoredRecs.sort((a, b) => a.s - b.s || a.r.enId - b.r.enId);
    const picked: Rec[] = [];
    for (const { r } of scoredRecs) {
      if (picked.length >= MAX_EXAMPLES) break;
      if (picked.some((p) => jaccard(p.toks, r.toks) > 0.5)) continue;
      picked.push(r);
    }
    picked.sort((a, b) => a.nWords - b.nWords || a.difficulty - b.difficulty || a.enId - b.enId);
    examples.set(e, picked);
    for (const r of picked) keep.add(r);
  }
  const poolCount = [0, 0, 0];
  for (let level = 0; level < LEVELS.length; level++) {
    const perWord = new Map<Entry, number>();
    // short first, but not only three-word sentences: up to 5/7/9 words cost nothing
    const comfort = 5 + 2 * level;
    const cands = recs
      .filter((r) => r.level === level && r.words.length)
      .map((r) => ({
        r,
        s:
          Math.max(0, r.nWords - comfort) * 0.25 +
          (r.nWords <= 3 ? 0.3 : 0) +
          r.difficulty * 3 +
          (r.native ? 0 : 0.4) +
          (/["“”:;]/.test(r.en) ? 1 : 0),
      }))
      .sort((a, b) => a.s - b.s || a.r.enId - b.r.enId);
    let taken = 0;
    for (const { r } of cands) {
      if (taken >= POOL_PER_LEVEL) break;
      if (keep.has(r)) continue;
      // spread the pool over many words instead of a thousand "Lucas is..." sentences
      if (
        r.words.some(
          (e) =>
            (perWord.get(e) ?? 0) >=
            (e.info.pos === "noun" || e.info.pos === "verb" || e.info.pos === "adjective"
              ? 25
              : 200),
        )
      )
        continue;
      for (const e of r.words) perWord.set(e, (perWord.get(e) ?? 0) + 1);
      keep.add(r);
      taken++;
      poolCount[level] = (poolCount[level] ?? 0) + 1;
    }
  }

  // alternative English answers: other sentences linked to the same Portuguese one
  const altEn = new Map<Rec, string[]>();
  for (const r of keep) {
    const out: string[] = [];
    const main = normEn(r.en);
    for (const other of linksPt.get(r.ptId) ?? []) {
      if (other === r.enId) continue;
      const text = en.get(other)?.text;
      if (!text) continue;
      let replaced = text;
      let ok = true;
      for (const name of Object.keys(REPLACED)) {
        const has = new RegExp(`\\b${name}\\b`).test(text);
        const pick = r.names.get(name);
        if (has && !pick) ok = false;
        if (has && pick) replaced = replaced.replace(new RegExp(`\\b${name}\\b`, "g"), pick);
      }
      if (!ok) continue;
      const a = analyzeEn(replaced, r.pt);
      if (typeof a === "string") continue;
      const k = normEn(replaced);
      if (k === main || out.some((o) => normEn(o) === k)) continue;
      out.push(replaced);
      if (out.length >= 5) break;
    }
    altEn.set(r, out);
  }

  // 10. write
  const taught = new Set<Entry>();
  for (const e of ordered) {
    const g = glosses.get(e);
    if (g?.gloss && g.conf >= MIN_CONF) taught.add(e);
  }
  // "Sofia! Sofia!" teaches nothing
  const keptRecs = [...keep]
    .filter((r) => r.words.some((e) => taught.has(e)))
    .sort((a, b) => a.enId - b.enId);
  const sentencesOut: SentenceOut[] = keptRecs.map((r) => ({
    id: `s${r.enId}`,
    en: r.en,
    pt: r.pt,
    alt_en: altEn.get(r) ?? [],
    level: LEVELS[r.level] ?? "A1",
    words: r.words.filter((e) => taught.has(e)).map((e) => e.id),
    src: `tatoeba:${r.enId}-${r.ptId}`,
  }));
  let finalRank = 0;
  const wordsOut: WordOut[] = [];
  for (const e of ordered) {
    if (!taught.has(e)) continue;
    const g = glosses.get(e);
    if (!g) continue;
    const forms = [...e.forms.keys(), ...e.phrases.map((p) => p.join(" "))];
    wordsOut.push({
      id: e.id,
      word: e.word,
      pos: e.info.pos,
      level: LEVELS[e.level] ?? "A1",
      rank: ++finalRank,
      gloss: g.gloss,
      alt: g.alt,
      conf: g.conf,
      forms: [...new Set(forms)],
      examples: (examples.get(e) ?? []).map((r) => `s${r.enId}`),
    });
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonl = (items: object[]) => `${items.map((x) => JSON.stringify(x)).join("\n")}\n`;
  writeFileSync(path.join(OUT_DIR, "words.jsonl"), jsonl(wordsOut));
  writeFileSync(path.join(OUT_DIR, "sentences.jsonl"), jsonl(sentencesOut));

  // 11. report
  const rng = mulberry32(20260930);
  const sentById = new Map(sentencesOut.map((s) => [s.id, s]));
  const line = (s = "") => report.push(s);
  line(`saybest course build — ${new Date().toISOString()}`);
  line(`input: ${input}`);
  line(`runtime: ${((Date.now() - started) / 1000).toFixed(1)} s`);
  line();
  line("== counts ==");
  for (const [i, lv] of LEVELS.entries()) {
    const nw = wordsOut.filter((w) => w.level === lv).length;
    const ns = sentencesOut.filter((s) => s.level === lv).length;
    line(`${lv}: ${nw} words, ${ns} sentences (${poolCount[i]} pool + examples)`);
  }
  line(`total: ${wordsOut.length} words, ${sentencesOut.length} sentences`);
  const noEx = wordsOut.filter((w) => !w.examples.length).length;
  const lowConf = wordsOut.filter((w) => w.conf < 0.35).length;
  line(`words without examples: ${noEx}; below planner threshold 0.35: ${lowConf}`);
  line();
  line("== filters ==");
  for (const [k, v] of [...stats.entries()].sort()) line(`${k}: ${v}`);
  line();
  line("== dropped words ==");
  const dropped = new Map<string, string[]>();
  for (const e of entries) {
    if (!e.vocab) {
      push(dropped, e.dropReason, e.id);
      continue;
    }
    const g = glosses.get(e);
    if (!g?.gloss) push(dropped, g?.why || "no candidate", `${e.id} (${LEVELS[e.level]})`);
    else if (g.why) push(dropped, g.why, `${e.id} (${LEVELS[e.level]}) -> ${g.gloss}`);
    else if (g.conf < MIN_CONF)
      push(
        dropped,
        `confidence < ${MIN_CONF}`,
        `${e.id} (${LEVELS[e.level]}) -> ${g.gloss} ${g.conf}`,
      );
  }
  for (const [reason, ids] of dropped) {
    line(`${reason}: ${ids.length} (all A1/A2, up to 40 B1)`);
    const early = ids.filter((id) => !id.includes("(B1)"));
    for (const id of [...early, ...ids.filter((id) => id.includes("(B1)")).slice(0, 40)])
      line(`  ${id}`);
  }
  line();
  line("== 60 lowest-confidence glosses kept ==");
  for (const w of [...wordsOut].sort((a, b) => a.conf - b.conf || a.rank - b.rank).slice(0, 60)) {
    const top = glosses.get(entries.find((e) => e.id === w.id) as Entry)?.top ?? [];
    const others = top.filter((t) => t.key !== w.gloss).map((t) => `${t.key} ${t.cooc.toFixed(2)}`);
    line(
      `${w.conf.toFixed(2)} ${w.id} (${w.level}) -> ${w.gloss} [${w.alt.join(", ")}]  ` +
        `vs ${others.join("; ")}`,
    );
  }
  line();
  line("== 40 random words ==");
  for (const w of sample(wordsOut, 40, rng)) {
    const ex = sentById.get(w.examples[0] ?? "");
    line(`${w.id} (${w.level}, conf ${w.conf}) -> ${w.gloss} [${w.alt.join(", ")}]`);
    line(`    ${ex ? `${ex.en} = ${ex.pt}` : "(no example)"}`);
  }
  line();
  line("== 30 random sentence pairs ==");
  for (const s of sample(sentencesOut, 30, rng)) {
    line(
      `${s.id} ${s.level} ${s.en} = ${s.pt}` +
        (s.alt_en.length ? `  (also: ${s.alt_en.join(" | ")})` : ""),
    );
    line(`    ${s.words.join(" ")}`);
  }
  line();
  line("== most frequent unknown tokens in 3-12 word sentences ==");
  line(
    [...unknownCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 80)
      .map(([w, c]) => `${w} ${c}`)
      .join(", "),
  );
  line();
  line("== all words (for review) ==");
  for (const w of wordsOut)
    line(`${w.rank} ${w.id} ${w.level} ${w.conf} -> ${w.gloss} [${w.alt.join(", ")}]`);
  mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
  writeFileSync(REPORT_FILE, `${report.join("\n")}\n`);
  progress(`wrote ${wordsOut.length} words, ${sentencesOut.length} sentences`);
}

await main();
