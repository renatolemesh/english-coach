/**
 * Pure parts of scripts/eval-conversations.ts: checks, the report and the call pacing.
 * The report prints values in a repr-like notation ('text', True, None, {'k': 1}) and JSON with
 * ", " / ": " separators, so reports from different runs stay comparable.
 */
import { REPLY_MAX_CHARS } from "../src/domain/reply.js";
import { countQuestions } from "../src/guardrails/output-rules.js";

export interface LlmCall {
  prompt: string;
  fallback: string | null;
  seconds: number;
}

export interface StepResult {
  input: Record<string, unknown>;
  setup: boolean;
  expect: string;
  route: string;
  texts: string[];
  choices: string[];
  caption: string | null;
  sent_kinds: string[];
  evaluation: Record<string, unknown> | null;
  reply: string | null;
  errors: string[];
  notes: string[];
  llm_calls: LlmCall[];
  llm_events: string[];
  seconds: number;
  failures: string[];
}

export interface ScenarioResult {
  id: string;
  topic: string;
  level: string;
  about: string;
  steps: StepResult[];
}

// --- repr-style formatting ---------------------------------------------------------------

// Non-printable categories, escaped in reprs (the space is the exception)
const NOT_PRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

/** A quoted string: single quotes unless the text has ' and no ", escapes for \\, the quote,
 * \n \r \t and non-printable characters (\xNN, \uNNNN, \UNNNNNNNN). */
export function pyStrRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += `\\${ch}`;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch !== " " && NOT_PRINTABLE.test(ch)) {
      const hex = code.toString(16);
      if (code < 0x100) out += `\\x${hex.padStart(2, "0")}`;
      else if (code < 0x10000) out += `\\u${hex.padStart(4, "0")}`;
      else out += `\\U${hex.padStart(8, "0")}`;
    } else out += ch;
  }
  return quote + out + quote;
}

/** A float that always has a decimal point (3.0, 2.5). */
export function pyFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/** Repr of JSON-like data: None/True/False, quoted strings, [..] and {'k': v} (ints stay ints). */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return pyStrRepr(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
  if (typeof value === "object") {
    const items = Object.entries(value).map(([k, v]) => `${pyStrRepr(k)}: ${pyRepr(v)}`);
    return `{${items.join(", ")}}`;
  }
  return String(value);
}

/** Strings as they are, everything else as pyRepr. */
export const pyStr = (value: unknown): string =>
  typeof value === "string" ? value : pyRepr(value);

/** JSON with ", " and ": " separators, non-ASCII kept as is. */
export function pyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  if (typeof value === "object") {
    const items = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${pyJson(v)}`);
    return `{${items.join(", ")}}`;
  }
  return JSON.stringify(value);
}

/** Round to 1 decimal. */
export const round1 = (x: number) => Math.round(x * 10) / 10;

// --- routes and checks -------------------------------------------------------------------

export function routeOf(state: {
  kind?: string | null;
  blocked_reason?: string | null;
  evaluation?: unknown;
}): string {
  if (state.blocked_reason === "portuguese") return "portuguese";
  if (state.kind === "blocked") return `blocked:${pyStr(state.blocked_reason)}`;
  if (state.kind === "command") return "command";
  return state.evaluation !== null && state.evaluation !== undefined
    ? "evaluated"
    : "no_evaluation";
}

type Check = Record<string, unknown>;
type StepOut = Omit<StepResult, "failures">;
const BREAKDOWN_FIELDS = ["grammar", "vocabulary", "fluency", "task"];

export function runChecks(check: Check, out: StepOut): string[] {
  const failures: string[] = [];
  const ev = (out.evaluation ?? {}) as Record<string, unknown>;
  const hasEv = Object.keys(ev).length > 0;
  const breakdown = (ev.score_breakdown ?? {}) as Record<string, number>;
  const mistakes = (ev.mistakes ?? []) as unknown[];
  const score = ev.score as number;
  const shown = [...out.texts, ...out.choices, out.reply ?? "", out.caption ?? ""];
  const everything = [...shown, pyJson(ev)].join("\n").toLowerCase();
  const reply = out.reply;
  if (reply) {
    // Emma's spoken text, every step
    if (reply.length > REPLY_MAX_CHARS) failures.push(`reply has ${reply.length} chars`);
    if (!reply.trimEnd().endsWith("?")) failures.push("reply does not end with a question");
    const questions = countQuestions(reply);
    if (questions > 1) failures.push(`reply asks ${questions} questions`);
  }
  for (const [key, want] of Object.entries(check)) {
    const needsEval =
      key.startsWith("score_") ||
      key.startsWith("mistakes_") ||
      BREAKDOWN_FIELDS.includes(key.split("_")[0] ?? "");
    if (needsEval && !hasEv) {
      failures.push(`${key}: no evaluation`);
      continue;
    }
    const n = want as number;
    const cut = key.lastIndexOf("_");
    const [field, bound] = [key.slice(0, cut), key.slice(cut + 1)];
    if (key === "route") {
      if (out.route !== want) failures.push(`route ${pyRepr(out.route)} != ${pyRepr(want)}`);
    } else if (key === "score_min") {
      if (score < n) failures.push(`score ${score} < ${n}`);
    } else if (key === "score_max") {
      if (score > n) failures.push(`score ${score} > ${n}`);
    } else if ((bound === "min" || bound === "max") && cut > 0 && field in breakdown) {
      const value = breakdown[field] as number;
      if ((bound === "min" && value < n) || (bound === "max" && value > n))
        failures.push(`${field} ${value} not ${bound} ${n}`);
    } else if (key === "mistakes_max") {
      if (mistakes.length > n) failures.push(`${mistakes.length} mistakes > ${n}`);
    } else if (key === "mistakes_min") {
      if (mistakes.length < n) failures.push(`${mistakes.length} mistakes < ${n}`);
    } else if (key === "contains") {
      for (const w of want as string[])
        if (!everything.includes(w.toLowerCase())) failures.push(`missing ${pyRepr(w)}`);
    } else if (key === "not_contains") {
      for (const w of want as string[])
        if (everything.includes(w.toLowerCase())) failures.push(`has ${pyRepr(w)}`);
    } else if (key === "reply") {
      if (Boolean(out.reply) !== want)
        failures.push(`reply present=${pyRepr(Boolean(out.reply))}, expected ${pyRepr(want)}`);
    } else if (key === "no_errors") {
      if (want && out.errors.length) failures.push(`errors ${pyRepr(out.errors)}`);
    }
  }
  return failures;
}

// --- LLM events from the logs ------------------------------------------------------------

/** Retries / invalid outputs / fallback models (they never reach the result). */
export const WATCHED_EVENTS = [
  "llm_retry",
  "llm_invalid_output",
  "llm_model_failed",
  "llm_fallback_model_used",
  "evaluation_cleaned",
  "reply_trimmed",
  "llm_rate_limited",
];

/** "prompt_id:event:detail" for a watched log record, else null. */
export function llmEvent(record: Record<string, unknown>): string | null {
  const event = record.event;
  if (typeof event !== "string" || !WATCHED_EVENTS.includes(event)) return null;
  const truthy = (v: unknown) =>
    v !== undefined && v !== null && v !== "" && v !== 0 && !(Array.isArray(v) && !v.length);
  const trim = `${pyRepr(record.before)} -> ${pyRepr(record.after)}`;
  const detail =
    [record.notes, record.error, record.model, record.reason, record.attempt].find(truthy) ?? trim;
  return `${pyStr(record.prompt_id)}:${event}:${pyStr(detail)}`;
}

// --- report ------------------------------------------------------------------------------

export function report(results: ScenarioResult[]): string {
  const lines = ["# Conversation eval", ""];
  const steps = results.flatMap((r) => r.steps);
  const total = steps.filter((s) => !s.setup).length;
  const failed = steps.filter((s) => s.failures.length).length;
  lines.push(`${total} steps, ${failed} with failed checks.`, "");
  for (const r of results) {
    lines.push(`## ${r.id} (${r.topic}, ${r.level})`, r.about, "");
    for (const s of r.steps) {
      const tag = s.setup ? "setup" : s.failures.length ? `FAIL ${s.failures.join("; ")}` : "ok";
      lines.push(`### > ${pyJson(s.input)}  [${s.route}] ${tag}`);
      if (s.expect) lines.push(`expect: ${s.expect}`);
      for (const t of s.texts) lines.push(`- text: ${pyStrRepr(t)}`);
      for (const c of s.choices) lines.push(`- choice: ${pyStrRepr(c)}`);
      if (s.caption) lines.push(`- caption: ${pyStrRepr(s.caption)}`);
      const ev = s.evaluation as Record<string, unknown> | null;
      if (ev) {
        lines.push(`- score ${pyStr(ev.score)} ${pyRepr(ev.score_breakdown)}`);
        lines.push(`  corrected: ${pyRepr(ev.corrected)}`);
        for (const m of (ev.mistakes ?? []) as Record<string, unknown>[])
          lines.push(
            `  * ${pyRepr(m.original)} -> ${pyRepr(m.correction)} [${pyStr(m.type)}] ` +
              pyStr(m.explanation),
          );
        lines.push(`  strengths: ${pyStr(ev.strengths)}`);
        lines.push(`  tip: ${pyStr(ev.tip)}`);
      }
      if (s.reply) lines.push(`- Emma (voice): ${pyStrRepr(s.reply)}`);
      if (s.errors.length) lines.push(`- errors: ${pyRepr(s.errors)}`);
      const notes = s.notes.filter((n) => !n.startsWith("stt:"));
      if (notes.length) lines.push(`- fixed by code: ${pyRepr(notes)}`);
      const calls = s.llm_calls
        .map((c) => c.prompt + (c.fallback ? `!${c.fallback}` : ""))
        .join(", ");
      lines.push(`- llm: [${calls}] ${pyFloat(s.seconds)}s`);
      if (s.llm_events.length) lines.push(`- llm events: ${pyRepr(s.llm_events)}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

// --- pacing ------------------------------------------------------------------------------

/** At most `max` calls in any 60 s, shared by every scenario (the quota is per account). */
export class RateWindow {
  private readonly recent: number[] = [];

  constructor(
    readonly max: number,
    private readonly now: () => number = () => performance.now() / 1000,
    private readonly sleep: (s: number) => Promise<void> = sleepSeconds,
  ) {}

  async acquire(): Promise<void> {
    while (this.recent.length >= this.max) {
      const wait = 60 - (this.now() - (this.recent[0] ?? 0));
      if (wait <= 0) {
        this.recent.shift();
        continue;
      }
      await this.sleep(wait);
    }
    this.recent.push(this.now());
  }
}

export const sleepSeconds = (s: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, s * 1000));

/** Seconds until just after the next clock minute (the free quota resets per fixed minute). */
export const untilNextMinute = (now: Date = new Date()) => 62 - now.getUTCSeconds();
