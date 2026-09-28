/**
 * Seed files -> Documents, one semantic item per chunk (never fixed-size chunks).
 *
 * data/topics/<topic>.yaml:
 *     topic: travel
 *     scenario: "..."               # 1 chunk (kind=scenario, no level: shown to every level)
 *     vocabulary:                   # 1 chunk per item (kind=vocabulary)
 *       - {key: travel-boarding-pass, term: boarding pass, meaning_pt: cartão de embarque,
 *          example: "Can I see your boarding pass?", level: A2}
 *     phrases:                      # 1 chunk per item (kind=phrase)
 *       - {key: travel-ask-directions, text: "Excuse me, how do I get to ...?", level: A2}
 *
 * data/grammar/<file>.md: one rule per `## Title {#key}` section (kind=rule, level from a
 * `Level: B1` line inside the section, else none).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { Document } from "../ports/vector-store.js";

const RULE_RE = /^##\s+(?<title>.+?)\s*\{#(?<key>[\w-]+)\}\s*$/gm;
const LEVEL_RE = /^Level:\s*(?<level>[ABC][12])\s*$/m;

type Item = Record<string, unknown>;

/** Text of a YAML scalar (True/False/None for booleans and null; the text is embedded and
 * hashed, so this spelling must not change). */
function pyStr(value: unknown): string {
  if (value === true) return "True";
  if (value === false) return "False";
  if (value === null || value === undefined) return "None";
  return String(value);
}

const optional = (value: unknown) => (value === undefined || value === null ? null : pyStr(value));
const relative = (file: string, dataDir: string) =>
  path.relative(dataDir, file).split(path.sep).join("/");

export function topicDocuments(file: string, dataDir: string): Document[] {
  // YAML 1.1 like PyYAML's safe_load (yes/no are booleans there).
  const data = parse(readFileSync(file, "utf8"), { version: "1.1" }) as Item | null;
  if (!data) return []; // empty file: nothing to ingest (its old rows are deleted as stale)
  const topic = pyStr(data.topic);
  const source = relative(file, dataDir);
  const stem = path.basename(file, path.extname(file));
  const docs = [
    Document.parse({
      collection: "lesson_content",
      key: `${stem}-scenario`,
      topic,
      level: null, // lesson items without a level are shown to every level
      kind: "scenario",
      source,
      content: `Scenario (${topic}): ${pyStr(data.scenario).trim()}`,
    }),
  ];
  for (const item of (data.vocabulary ?? []) as Item[]) {
    docs.push(
      Document.parse({
        collection: "lesson_content",
        key: pyStr(item.key),
        topic,
        level: optional(item.level),
        kind: "vocabulary",
        source,
        content: `${pyStr(item.term)} (${pyStr(item.meaning_pt)}): ${pyStr(item.example)}`,
      }),
    );
  }
  for (const item of (data.phrases ?? []) as Item[]) {
    docs.push(
      Document.parse({
        collection: "lesson_content",
        key: pyStr(item.key),
        topic,
        level: optional(item.level),
        kind: "phrase",
        source,
        content: `Useful phrase: ${pyStr(item.text)}`,
      }),
    );
  }
  return docs;
}

export function grammarDocuments(file: string, dataDir: string): Document[] {
  const text = readFileSync(file, "utf8");
  const source = relative(file, dataDir);
  const matches = [...text.matchAll(RULE_RE)];
  return matches.map((match, i) => {
    const start = match.index + match[0].length;
    const end = matches[i + 1]?.index ?? text.length;
    let body = text.slice(start, end).trim();
    const level = LEVEL_RE.exec(body)?.groups?.level ?? null;
    body = body.replace(new RegExp(LEVEL_RE.source, "gm"), "").trim();
    return Document.parse({
      collection: "grammar_notes",
      key: match.groups?.key,
      kind: "rule",
      source,
      level,
      content: `${match.groups?.title}: ${body.split(/\s+/).filter(Boolean).join(" ")}`,
    });
  });
}

function listFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(ext))
    .sort()
    .map((name) => path.join(dir, name));
}

/** {source file: documents} for every seed file. */
export function loadSeeds(dataDir: string): Map<string, Document[]> {
  const seeds = new Map<string, Document[]>();
  for (const file of listFiles(path.join(dataDir, "topics"), ".yaml")) {
    seeds.set(relative(file, dataDir), topicDocuments(file, dataDir));
  }
  for (const file of listFiles(path.join(dataDir, "grammar"), ".md")) {
    seeds.set(relative(file, dataDir), grammarDocuments(file, dataDir));
  }
  return seeds;
}
