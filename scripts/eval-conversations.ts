/**
 * Run scripted conversations through the real graph and the real LLM, and dump what came back.
 *
 *   npm run eval                               # all scenarios
 *   npm run eval -- -k portuguese -k dont
 *   npm run eval -- --fake-llm                 # FakeLLM + real database: no quota spent
 *   USE_FAKES=true npm run eval -- --out /tmp/x  # FakeLLM, no database: checks the script only
 *
 * No WhatsApp, Whisper, Kokoro or Chromium: the channel is in-memory, "audio" steps go through
 * FakeSTT (the bytes are the transcript), so the audio path of the graph runs without the models.
 * RAG and the turn log use the real Postgres (database coach_test, or the one given with
 * --database) under connection_id "eval" (wiped at start).
 *
 * Scenarios come from test/conversation-eval.yaml; out/eval/<timestamp>/ gets results.json and
 * report.md (see eval-report.ts for the checks and the report). Every
 * step costs ~1-3 OpenRouter requests; calls are paced to stay under the free-model limit.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { FakeChannel } from "../src/adapters/channels/fake.js";
import { modelSetup, OpenRouterLLM, OpenRouterTransport } from "../src/adapters/llm/openrouter.js";
import { SqlRepository } from "../src/adapters/repo/sql.js";
import type { FakeSTT } from "../src/adapters/stt/fake.js";
import { fallbackModels, getSettings, PROJECT_ROOT, type Settings } from "../src/config.js";
import { buildContainer } from "../src/container.js";
import { connect, type Database } from "../src/db/client.js";
import { commandForOption } from "../src/domain/choices.js";
import { IncomingMessage } from "../src/domain/messages.js";
import { ConversationRunner, threadId } from "../src/graph/runner.js";
import { configureLogging, setLogDestination } from "../src/logging.js";
import type { Cache } from "../src/ports/cache.js";
import {
  ACCOUNT_RATE_LIMIT,
  type LLMClient,
  type LLMResult,
  QUOTA_FLAG_KEY,
} from "../src/ports/llm.js";
import type { TurnLog } from "../src/ports/repository.js";
import { buildRetriever } from "../src/rag/build.js";
import {
  type LlmCall,
  llmEvent,
  pyRepr,
  RateWindow,
  report,
  round1,
  routeOf,
  runChecks,
  type ScenarioResult,
  type StepResult,
  sleepSeconds,
  untilNextMinute,
} from "./eval-report.js";

const CONNECTION = "eval";
const SCENARIOS = path.join(PROJECT_ROOT, "test", "conversation-eval.yaml");
// Free models: 20 HTTP requests per fixed clock minute for the whole ACCOUNT, and one call can
// be 2-4 requests (a retry on invalid JSON, fallback models). The live bot counts too.
const MAX_CALLS_PER_MINUTE = 6;
const RATE_LIMIT_RETRIES = 2; // a call refused by the quota waits for the next minute, then retries

// Values the app needs whatever .env says (same overrides as the x-app environment in
// docker-compose.yml); an explicit environment variable still wins.
const TS_ENV: Record<string, string> = {
  STT_MIN_CONFIDENCE: "-2.0",
  STT_SURE_CONFIDENCE: "-1.05",
  LOCAL_EMBEDDING_MODEL: "Xenova/bge-small-en-v1.5",
};

type Step = Record<string, unknown> & { check?: Record<string, unknown> };
interface Scenario {
  id: string;
  about?: string;
  topic?: string;
  level?: string;
  opener?: boolean;
  steps: Step[];
}
interface Spec {
  defaults: { topic: string; level: string };
  scenarios: Scenario[];
}

// Log records the report shows (retries, invalid outputs, fallback models); the rest of the
// warnings go to stderr as usual.
const EVENTS: string[] = [];
let lastRateLimit = "";

function captureLogs(): void {
  configureLogging("warning");
  setLogDestination(
    new Writable({
      write(chunk, _enc, cb) {
        for (const line of String(chunk).split("\n").filter(Boolean)) {
          process.stderr.write(`${line}\n`);
          try {
            const record = JSON.parse(line) as Record<string, unknown>;
            const event = llmEvent(record);
            if (event) EVENTS.push(event);
            if (record.event === "llm_rate_limited") lastRateLimit = String(record.error ?? "");
          } catch {
            // not JSON: already on stderr
          }
        }
        cb();
      },
    }),
  );
}

/** Delegates to the real client, pacing calls and recording them for the report. */
class PacedLLM implements LLMClient {
  readonly calls: LlmCall[] = [];

  constructor(
    private readonly inner: LLMClient,
    private readonly cache: Cache, // holds the scenario's "busy" flag
    private readonly window: RateWindow,
  ) {}

  async structured<S extends z.ZodType>(
    promptId: string,
    variables: Record<string, string>,
    outputModel: S,
    fallback: z.infer<S>,
    metadata?: Record<string, unknown>,
  ): Promise<LLMResult<z.infer<S>>> {
    await this.window.acquire();
    const start = performance.now();
    let result!: LLMResult<z.infer<S>>;
    for (let i = 0; i <= RATE_LIMIT_RETRIES; i++) {
      result = await this.inner.structured(promptId, variables, outputModel, fallback, metadata);
      if (!(result.fallbackReason ?? "").includes(ACCOUNT_RATE_LIMIT)) break;
      console.log(`  quota hit on ${promptId}: waiting for the next minute (${lastRateLimit})`);
      await sleepSeconds(untilNextMinute());
      await this.cache.delete(QUOTA_FLAG_KEY); // the test's flag, not the bot's
    }
    this.calls.push({
      prompt: promptId,
      fallback: result.fallbackUsed ? result.fallbackReason : null,
      seconds: round1((performance.now() - start) / 1000),
    });
    return result;
  }
}

let lastTurn: TurnLog | null = null;

/** Keeps the last TurnLog: persist clears evaluation/reply from the graph state. */
class RecordingRepo extends SqlRepository {
  override async saveTurn(userId: number, log: TurnLog): Promise<void> {
    lastTurn = log;
    await super.saveTurn(userId, log);
  }
}

function message(phone: string, n: number, step: Step): IncomingMessage {
  const base = { id: `eval-${phone}-${n}`, from: phone, timestamp: new Date() };
  if ("audio" in step)
    return IncomingMessage.parse({ ...base, type: "audio", media_ref: `step-${n}` });
  // a tap on a button or list row arrives as the command of its option id ("tema:2" -> "/tema 2")
  const text = "tap" in step ? commandForOption(String(step.tap)) : String(step.text ?? "");
  if (!text) throw new Error(`unknown option id ${JSON.stringify(step.tap)}`);
  return IncomingMessage.parse({ ...base, type: "text", text });
}

/** A stable fake number per scenario (the same on every run). */
function phoneFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (Math.imul(h, 31) + (ch.codePointAt(0) ?? 0)) >>> 0;
  return `99${String(h % 10 ** 9).padStart(9, "0")}`;
}

async function runScenario(
  scenario: Scenario,
  defaults: Spec["defaults"],
  settings: Settings,
  database: Database | null,
  window: RateWindow,
  fakeLlm: boolean,
): Promise<ScenarioResult> {
  const container = await buildContainer({ ...settings, useFakes: true }, { withMedia: true });
  const real = { ...settings, useFakes: false };
  const inner: LLMClient = !fakeLlm
    ? new OpenRouterLLM(
        real,
        container.prompts,
        container.cache,
        new OpenRouterTransport(real),
        modelSetup(real, fallbackModels(real)),
      )
    : container.llm; // FakeLLM (--fake-llm or USE_FAKES)
  const llm = new PacedLLM(inner, container.cache, window);
  container.llm = llm;
  if (database) {
    container.repo = new RecordingRepo(database.db);
    container.retriever = buildRetriever(real, container.cache, database);
  } else {
    // USE_FAKES: memory repo and retriever
    const repo = container.repo;
    const save = repo.saveTurn.bind(repo);
    repo.saveTurn = async (userId, log) => {
      lastTurn = log;
      await save(userId, log);
    };
  }
  const stt = container.requireMedia().stt as FakeSTT;
  const channel = new FakeChannel();
  const runner = new ConversationRunner();
  const phone = phoneFor(scenario.id);
  const topic = scenario.topic ?? defaults.topic;
  const level = scenario.level ?? defaults.level;
  const { user_id: userId } = await container.repo.createStudent(CONNECTION, phone, "Ilimitado");
  await runner.setProfile(userId, { topic, level });

  const steps: Step[] = [...scenario.steps];
  if (scenario.opener ?? true) steps.unshift({ text: `/tema ${topic}`, setup: true }); // Emma asks first
  const results: StepResult[] = [];
  for (const [n, step] of steps.entries()) {
    if ("idle_hours" in step) {
      // pretend the student went away
      await runner.graph.updateState(
        { configurable: { thread_id: threadId(userId) } },
        { last_seen: Date.now() / 1000 - Number(step.idle_hours) * 3600 },
        "persist",
      );
      continue;
    }
    if ("audio" in step) {
      channel.media.set(`step-${n}`, [Buffer.from(String(step.audio)), "audio/ogg"]);
      // optional whisper confidence for the transcript
      stt.avgLogprob = typeof step.avg_logprob === "number" ? step.avg_logprob : -0.2;
    }
    channel.sent.length = 0;
    EVENTS.length = 0;
    lastTurn = null;
    const firstCall = llm.calls.length;
    const start = performance.now();
    const state = await runner.handle(
      message(phone, n, step),
      CONNECTION,
      container.graphContext(channel),
    );
    // persist clears per-turn fields; the turn log keeps them
    const out = collect(step, state.kind ?? null, channel, llm.calls.slice(firstCall), start);
    results.push({ ...out, failures: runChecks(step.check ?? {}, out) });
  }
  await container.close();
  return { id: scenario.id, topic, level, about: scenario.about ?? "", steps: results };
}

function collect(
  step: Step,
  stateKind: string | null,
  channel: FakeChannel,
  calls: LlmCall[],
  start: number,
): Omit<StepResult, "failures"> {
  const log = lastTurn;
  lastTurn = null;
  const evaluation = log?.evaluation ? { ...log.evaluation } : null;
  const kind = log ? log.kind : stateKind;
  const blocked = log ? log.blocked_reason : null;
  const sent = channel.sent;
  return {
    input: Object.fromEntries(
      Object.entries(step).filter(([k]) => ["text", "audio", "tap"].includes(k)),
    ),
    setup: Boolean(step.setup),
    expect: String(step.expect ?? ""),
    route: routeOf({ kind, blocked_reason: blocked, evaluation }),
    texts: sent.filter((s) => s.kind === "text").map((s) => s.text ?? ""),
    choices: sent.filter((s) => s.kind === "choice").map((s) => s.text ?? ""),
    caption: sent.find((s) => s.kind === "image")?.text ?? null,
    sent_kinds: sent.map((s) => s.kind),
    evaluation,
    reply: log && sent.some((s) => s.kind === "voice") ? log.reply_text : null,
    errors: log ? [...log.errors] : [],
    notes: log ? [...log.notes] : [], // what the code fixed; STT confidence
    llm_calls: calls,
    llm_events: [...EVENTS],
    seconds: round1((performance.now() - start) / 1000),
  };
}

/** settings.databaseUrl with another database name (the .env points at production). */
function withDatabase(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      k: { type: "string", short: "k", multiple: true, default: [] },
      file: { type: "string", default: SCENARIOS },
      out: { type: "string", default: path.join(PROJECT_ROOT, "out", "eval") },
      database: { type: "string", default: "coach_test" },
      "fake-llm": { type: "boolean", default: false },
    },
  });
  for (const [key, value] of Object.entries(TS_ENV)) process.env[key] ??= value;
  captureLogs();

  const spec = parseYaml(readFileSync(args.file, "utf8")) as Spec;
  const ks = args.k ?? [];
  const scenarios = spec.scenarios.filter((s) => !ks.length || ks.some((k) => s.id.includes(k)));
  const settings = getSettings();
  const fake = settings.useFakes || Boolean(args["fake-llm"]);
  const database = settings.useFakes
    ? null
    : connect(withDatabase(settings.databaseUrl, args.database));
  // fresh students => no "você já errou isso antes" leaks
  await database?.pool.query("DELETE FROM students WHERE connection_id = $1", [CONNECTION]);
  const window = new RateWindow(fake ? Number.POSITIVE_INFINITY : MAX_CALLS_PER_MINUTE);

  const results: ScenarioResult[] = [];
  try {
    for (const scenario of scenarios) {
      console.log(`> ${scenario.id}`);
      const result = await runScenario(scenario, spec.defaults, settings, database, window, fake);
      for (const s of result.steps)
        if (s.failures.length) console.log(`    FAIL ${pyRepr(s.input)}: ${s.failures.join("; ")}`);
      results.push(result);
    }
  } finally {
    await database?.close();
  }

  const out = path.join(args.out, timestamp());
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
  writeFileSync(path.join(out, "report.md"), report(results));
  const steps = results.flatMap((r) => r.steps);
  const calls = steps.reduce((sum, s) => sum + s.llm_calls.length, 0);
  const failed = steps.filter((s) => s.failures.length).length;
  console.log(
    `\n${results.length} scenarios, ${calls} LLM calls, ${failed} steps failed checks -> ${out}` +
      (fake ? " (FakeLLM, not the real model)" : ""),
  );
}

await main();
