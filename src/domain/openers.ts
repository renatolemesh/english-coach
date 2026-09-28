/**
 * Ready-made first questions per topic (data/topics/*.yaml `openers:`).
 *
 * topic_opener gets one of them as a starting idea, which gives variety across sessions, and the
 * same line is the spoken fallback when the model fails. Custom topics (/tema anything) have none.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const cache = new Map<string, ReadonlyMap<string, readonly string[]>>();

/** topic -> openers, read once per data dir. */
export function loadOpeners(dataDir: string): ReadonlyMap<string, readonly string[]> {
  const key = path.resolve(dataDir);
  const cached = cache.get(key);
  if (cached) return cached;
  const openers = new Map<string, readonly string[]>();
  const dir = path.join(key, "topics");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort();
  for (const file of files) {
    const data = (parse(readFileSync(path.join(dir, file), "utf-8")) ?? {}) as Record<
      string,
      unknown
    >;
    const lines = data.openers;
    if (data.topic && Array.isArray(lines) && lines.length > 0) {
      openers.set(String(data.topic), Object.freeze(lines.map((line) => String(line))));
    }
  }
  cache.set(key, openers);
  return openers;
}

export interface PickOptions {
  /** Returns a float in [0, 1), like Math.random (the default). */
  random?: () => number;
  /** Recently used lines, avoided while there are others. */
  avoid?: readonly string[];
}

/** A first question for the topic, preferring ones not in `avoid` (recently used). */
export function pickOpener(dataDir: string, topic: string, opts: PickOptions = {}): string | null {
  const lines = loadOpeners(dataDir).get(topic);
  if (!lines || lines.length === 0) return null;
  const avoid = opts.avoid ?? [];
  const fresh = lines.filter((line) => !avoid.includes(line));
  const pool = fresh.length > 0 ? fresh : lines;
  const random = opts.random ?? Math.random;
  return pool[Math.floor(random() * pool.length)] ?? null;
}
