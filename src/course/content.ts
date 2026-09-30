/**
 * Course content (data/course): the word bank and sentence bank built by scripts/build-course.ts
 * from CEFR-J, Wiktionary and Tatoeba, and the hand-written items for Brazilian learners
 * (traps.yaml). Loaded once per process; everything here is read-only.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { LEVELS } from "../domain/topics.js";

const list = z.array(z.string()).default([]);

export const Word = z.object({
  id: z.string(), // "house.n"
  word: z.string(),
  pos: z.string(),
  level: z.string(),
  rank: z.number(),
  gloss: z.string(),
  alt: list,
  conf: z.number().default(1),
  forms: list,
  examples: list,
});
export type Word = z.infer<typeof Word>;

export const Sentence = z.object({
  id: z.string(), // "s1234"
  en: z.string(),
  pt: z.string(),
  alt_en: list,
  level: z.string(),
  words: list,
  src: z.string().default(""),
});
export type Sentence = z.infer<typeof Sentence>;

const GrammarTrap = z.object({
  id: z.string(),
  level: z.string(),
  pt: z.string(),
  right: z.string(),
  wrong: z.array(z.string()).min(1).max(2),
  tip: z.string().default(""),
});
export type GrammarTrap = z.infer<typeof GrammarTrap>;

const FalseFriend = z.object({
  id: z.string(),
  level: z.string(),
  word: z.string(),
  meaning: z.string(),
  trap: z.string(),
  other: z.string(),
  example: z.object({ en: z.string(), pt: z.string() }),
  tip: z.string().default(""),
});
export type FalseFriend = z.infer<typeof FalseFriend>;

const MinimalPair = z.object({
  id: z.string(),
  sound: z.string(),
  level: z.string(),
  words: z.array(z.string()).min(2).max(3),
  tip: z.string().default(""),
});
export type MinimalPair = z.infer<typeof MinimalPair>;

const Chat = z.object({
  id: z.string(),
  level: z.string(),
  context: z.string(),
  them: z.union([z.string().transform((s) => [s]), z.array(z.string()).min(1)]),
  options: z.array(z.string()).length(3), // the first is the right reply
  tip: z.string().default(""),
});
export type Chat = z.infer<typeof Chat>;

const Traps = z.object({
  grammar: z.array(GrammarTrap).default([]),
  false_friends: z.array(FalseFriend).default([]),
  minimal_pair_sounds: z.record(z.string(), z.string()).default({}),
  minimal_pairs: z.array(MinimalPair).default([]),
  chats: z.array(Chat).default([]),
});

/** 'A1' -> 0 ... 'C2' -> 5 (unknown: A1). */
export function levelIndex(level: string): number {
  return Math.max(0, (LEVELS as readonly string[]).indexOf(level));
}

function jsonl<T>(file: string, schema: z.ZodType<T>): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => schema.parse(JSON.parse(line)));
}

const loaded = new Map<string, CourseContent>();

export class CourseContent {
  readonly words: ReadonlyMap<string, Word>;
  readonly sentences: ReadonlyMap<string, Sentence>;
  readonly grammar: ReadonlyMap<string, GrammarTrap>;
  readonly falseFriends: ReadonlyMap<string, FalseFriend>;
  readonly pairs: ReadonlyMap<string, MinimalPair>;
  readonly chats: ReadonlyMap<string, Chat>;
  readonly sounds: Readonly<Record<string, string>>;
  /** Words in teaching order (rank). */
  readonly wordList: readonly Word[];
  /** Sentences by level, shortest first. */
  readonly sentencesByLevel: ReadonlyMap<string, readonly Sentence[]>;
  readonly maxLevel: string;

  constructor(
    words: Word[],
    sentences: Sentence[],
    traps: z.infer<typeof Traps> = Traps.parse({}),
  ) {
    const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((i) => [i.id, i]));
    this.wordList = [...words].sort((a, b) => a.rank - b.rank);
    this.words = byId([...this.wordList]);
    this.sentences = byId(sentences);
    const byLevel = new Map<string, Sentence[]>();
    for (const s of sentences) byLevel.set(s.level, [...(byLevel.get(s.level) ?? []), s]);
    for (const group of byLevel.values()) group.sort((a, b) => a.en.length - b.en.length);
    this.sentencesByLevel = byLevel;
    this.grammar = byId(traps.grammar);
    this.falseFriends = byId(traps.false_friends);
    this.pairs = byId(traps.minimal_pairs);
    this.chats = byId(traps.chats);
    this.sounds = traps.minimal_pair_sounds;
    const top = Math.max(0, ...words.map((w) => levelIndex(w.level)));
    this.maxLevel = LEVELS[top] ?? "A1";
  }

  /** Loaded once per directory (the sentence bank is a few MB). */
  static load(dir: string): CourseContent {
    const cached = loaded.get(dir);
    if (cached) return cached;
    const content = CourseContent.read(dir);
    loaded.set(dir, content);
    return content;
  }

  private static read(dir: string): CourseContent {
    const trapsFile = path.join(dir, "traps.yaml");
    const traps = existsSync(trapsFile)
      ? Traps.parse(parseYaml(readFileSync(trapsFile, "utf8")) ?? {})
      : Traps.parse({});
    return new CourseContent(
      jsonl(path.join(dir, "words.jsonl"), Word),
      jsonl(path.join(dir, "sentences.jsonl"), Sentence),
      traps,
    );
  }

  /** A word or inflected form of the bank ("lucas" is not; "took" is). */
  isWord(text: string): boolean {
    this.forms ??= new Set(this.wordList.flatMap((w) => [w.word.toLowerCase(), ...w.forms]));
    return this.forms.has(text.replace(/'.*$/, "").toLowerCase());
  }

  private forms: Set<string> | undefined;

  get empty(): boolean {
    return this.words.size === 0;
  }

  /** The level new material comes from: the student's, capped at what the content covers. */
  poolLevel(studentLevel: string): number {
    return Math.min(levelIndex(studentLevel), levelIndex(this.maxLevel));
  }
}
