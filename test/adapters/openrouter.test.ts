import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../../src/adapters/cache/memory.js";
import {
  ChatError,
  type ChatRequest,
  type ChatResponse,
  type ChatTransport,
  OpenRouterLLM,
  OpenRouterTransport,
} from "../../src/adapters/llm/openrouter.js";
import { loadSettings, PROJECT_ROOT, type Settings } from "../../src/config.js";
import { GuardResult } from "../../src/domain/guard.js";
import { Reply } from "../../src/domain/reply.js";
import type { Cache } from "../../src/ports/cache.js";
import { emptyUsage, QUOTA_FLAG_KEY } from "../../src/ports/llm.js";
import { PromptError, PromptRegistry } from "../../src/prompts/registry.js";

const ALLOW = JSON.stringify({ verdict: "allow", reason: "ok" });
const FALLBACK: GuardResult = { verdict: "allow", reason: "fallback" };
const VARS = { topic: "travel", last_question: "(none)", text: "I like trains" };
const settings: Settings = loadSettings({}, { llmRetryInitialWaitS: 0 });
const registry = () => new PromptRegistry(path.join(PROJECT_ROOT, "prompts"), PROJECT_ROOT);

type Outcome = string | ChatError | Error | (() => Promise<never>);
const ok = (content: string, cost = 0.001): ChatResponse => ({
  content,
  finishReason: "stop",
  usage: { ...emptyUsage(), inputTokens: 100, outputTokens: 20, costUsd: cost },
});

/** Returns/throws a queued outcome per call, per model name; records the requests. */
class Scripted implements ChatTransport {
  calls: ChatRequest[] = [];
  constructor(public outcomes: Record<string, Outcome[]>) {}
  async complete(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    const next = this.outcomes[req.model]?.shift();
    if (next === undefined) throw new Error(`no outcome for ${req.model}`);
    if (typeof next === "function") return next();
    if (next instanceof Error) throw next;
    return ok(next);
  }
  callsTo(model: string) {
    return this.calls.filter((c) => c.model === model);
  }
}

function build(
  outcomes: Record<string, Outcome[]>,
  opts: { cache?: Cache; guardReasoning?: "low"; fallback?: string[]; s?: Settings } = {},
) {
  const transport = new Scripted(outcomes);
  const llm = new OpenRouterLLM(
    opts.s ?? settings,
    registry(),
    opts.cache ?? new MemoryCache(),
    transport,
    {
      names: { evaluator: "m/eval", conversation: "m/conv", guard: "m/guard" },
      reasoning: { evaluator: "none", conversation: "none", guard: opts.guardReasoning ?? "none" },
      fallbackModels: opts.fallback ?? [],
      fallbackReasoning: "low",
    },
  );
  return { llm, transport };
}

const guard = (llm: OpenRouterLLM) => llm.structured("guard_input", VARS, GuardResult, FALLBACK);
const transient = (name = "APIConnectionError") => new ChatError("transient", "down", 0, name);
const rateLimited = (message: string) =>
  new ChatError("rate_limit", message, 429, "RateLimitError");

describe("OpenRouterLLM", () => {
  it("returns a valid output with usage, sending the strict schema", async () => {
    const { llm, transport } = build({ "m/guard": [ALLOW] });
    const result = await guard(llm);
    expect(result).toMatchObject({
      value: { verdict: "allow", reason: "ok" },
      fallbackUsed: false,
    });
    expect(result.usage.costUsd).toBe(0.001);
    expect(transport.calls[0]?.schemaName).toBe("guard_input");
    expect(transport.calls[0]?.schema.additionalProperties).toBe(false);
  });

  it("retries once with the validation error, then uses the fallback", async () => {
    const { llm, transport } = build({ "m/guard": ['{"verdict": "maybe"}', ALLOW] });
    expect((await guard(llm)).fallbackUsed).toBe(false);
    const repair = transport.calls[1]?.messages.at(-1)?.content ?? "";
    expect(repair).toContain("did not match the required schema");
    const twice = build({ "m/guard": ["nope", "still nope"] });
    const result = await guard(twice.llm);
    expect(result.fallbackUsed && result.fallbackReason).toBe("invalid_output");
    expect(result.value).toBe(FALLBACK);
  });

  it("tolerates JSON in ``` fences", async () => {
    const { llm } = build({ "m/guard": [`\`\`\`json\n${ALLOW}\n\`\`\``] });
    expect((await guard(llm)).value.reason).toBe("ok");
  });

  it("caches cacheable prompts, never conversation_reply", async () => {
    const { llm, transport } = build({ "m/guard": [ALLOW] });
    await guard(llm);
    const second = await guard(llm);
    expect(second.usage.cached).toBe(true);
    expect(transport.calls).toHaveLength(1);
    const reply = JSON.stringify({ text: "Oh nice! Where did you go?" });
    const conv = build({ "m/conv": [reply, reply] });
    const vars = {
      topic: "travel",
      level: "B1",
      tutor: "Emma",
      history: "",
      transcript: "I went out.",
      correction: "No mistakes.",
      retrieved_context: "",
    };
    await conv.llm.structured("conversation_reply", vars, Reply, { text: "Sorry?" });
    await conv.llm.structured("conversation_reply", vars, Reply, { text: "Sorry?" });
    expect(conv.transport.calls).toHaveLength(2);
  });

  it("retries transient errors, gives up after the retries, never retries 4xx", async () => {
    const a = build({ "m/guard": [transient("APITimeoutError"), ALLOW] });
    expect((await guard(a.llm)).fallbackUsed).toBe(false);
    expect(a.transport.calls).toHaveLength(2);
    const b = build({ "m/guard": [transient(), transient(), transient()] });
    const result = await guard(b.llm);
    expect(result.fallbackReason).toBe("transient_error:APIConnectionError");
    expect(b.transport.calls).toHaveLength(settings.llmMaxRetries + 1);
    const c = build({ "m/guard": [new ChatError("api", "no credits", 402, "APIStatusError")] });
    expect((await guard(c.llm)).fallbackReason).toBe("api_error:APIStatusError:402");
    expect(c.transport.calls).toHaveLength(1);
    const d = build({ "m/guard": [new ChatError("client", "max", 0, "LengthFinishReasonError")] });
    expect((await guard(d.llm)).fallbackReason).toBe("client_error:LengthFinishReasonError");
    const e = build({ "m/guard": [new TypeError("boom")] });
    expect((await guard(e.llm)).fallbackReason).toBe("unexpected:TypeError");
  });

  it("fails open when the cache is down", async () => {
    class Broken extends MemoryCache {
      override async get(): Promise<Buffer | null> {
        throw new Error("redis down");
      }
      override async set(): Promise<void> {
        throw new Error("redis down");
      }
    }
    const { llm } = build({ "m/guard": [ALLOW] }, { cache: new Broken() });
    expect((await guard(llm)).value.reason).toBe("ok");
  });

  it("keys the cache by reasoning and temperature", async () => {
    const shared = new MemoryCache();
    const a = build({ "m/guard": [ALLOW] }, { cache: shared });
    const b = build({ "m/guard": [ALLOW] }, { cache: shared, guardReasoning: "low" });
    await guard(a.llm);
    await guard(b.llm);
    expect(a.transport.calls).toHaveLength(1);
    expect(b.transport.calls).toHaveLength(1); // no cross hit
  });

  it("refuses an output model that does not match the prompt's schema", async () => {
    const { llm, transport } = build({ "m/guard": [ALLOW] });
    await expect(llm.structured("guard_input", VARS, Reply, { text: "x" })).rejects.toThrow(
      PromptError,
    );
    expect(transport.calls).toHaveLength(0);
  });

  it("tries fallback models in order (with room for reasoning) before the fixed fallback", async () => {
    const { llm, transport } = build(
      { "m/guard": ["nope", "still nope"], "m/backup": [ALLOW] },
      { fallback: ["m/guard", "m/backup"] }, // the primary itself is skipped
    );
    const result = await guard(llm);
    expect(result.fallbackUsed).toBe(false);
    expect(result.usage.model).toBe("m/backup");
    expect(transport.callsTo("m/backup")[0]?.maxTokens).toBe(
      4 * (transport.callsTo("m/guard")[0]?.maxTokens ?? 0),
    );
    expect(transport.callsTo("m/backup")[0]?.reasoning).toBe("low");
  });

  it("joins the reasons when every model fails", async () => {
    const { llm } = build(
      { "m/guard": ["x", "y"], "m/backup": [transient(), transient(), transient()] },
      { fallback: ["m/backup"] },
    );
    const result = await guard(llm);
    expect(result.fallbackReason).toBe("invalid_output|transient_error:APIConnectionError");
  });

  it("stops at the account quota, flags it, and tries no other free model", async () => {
    const cache = new MemoryCache();
    const { llm, transport } = build(
      { "m/guard": [rateLimited("Rate limit exceeded: free-models-per-min")], "m/backup": [ALLOW] },
      { fallback: ["m/backup"], cache },
    );
    const result = await guard(llm);
    expect(result.fallbackReason).toBe("account_rate_limit");
    expect(transport.calls).toHaveLength(1); // no retries either
    expect((await cache.get(QUOTA_FLAG_KEY))?.toString()).toBe("1");
  });

  it("tries fallback models once and never caches their answers", async () => {
    const upstream = () =>
      [0, 1, 2].map(() => rateLimited("Provider returned error: upstream busy"));
    const { llm, transport } = build(
      { "m/guard": upstream(), "m/backup": [transient(), ALLOW] },
      { fallback: ["m/backup"] },
    );
    expect((await guard(llm)).fallbackUsed).toBe(true);
    expect(transport.callsTo("m/backup")).toHaveLength(1);
    transport.outcomes = { "m/guard": upstream(), "m/backup": [ALLOW] };
    expect((await guard(llm)).usage.model).toBe("m/backup");
    transport.outcomes = { "m/guard": [ALLOW] };
    expect((await guard(llm)).usage.cached).toBe(false);
  });

  it("gives the whole chain one deadline", async () => {
    const slow = () => new Promise<never>(() => {});
    const { llm } = build(
      { "m/guard": [slow], "m/backup": [ALLOW] },
      { fallback: ["m/backup"], s: loadSettings({}, { llmChainTimeoutS: 0.05 }) },
    );
    expect((await guard(llm)).fallbackReason).toBe("chain_timeout");
  });
});

describe("OpenRouterTransport (HTTP body and parsing)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends strict json_schema, provider routing and reasoning; reads usage and cost", async () => {
    let sent: { url: string; body: Record<string, unknown>; auth: string } | undefined;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent = {
        url,
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get("authorization") ?? "",
      };
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: ALLOW } }],
          usage: {
            prompt_tokens: 900,
            completion_tokens: 150,
            completion_tokens_details: { reasoning_tokens: 40 },
            cost: 0.00045,
          },
        }),
      );
    });
    const s = loadSettings({ OPENROUTER_API_KEY: "sk-or-test" });
    const resp = await new OpenRouterTransport(s).complete({
      model: "m/x",
      messages: [{ role: "user", content: "hi" }],
      schemaName: "guard_input",
      schema: { type: "object" },
      temperature: 0,
      maxTokens: 100,
      reasoning: "low",
    });
    expect(sent?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent?.auth).toBe("Bearer sk-or-test");
    expect(sent?.body).toMatchObject({
      model: "m/x",
      max_tokens: 100,
      provider: { require_parameters: true },
      reasoning: { effort: "low" },
      response_format: { type: "json_schema", json_schema: { name: "guard_input", strict: true } },
    });
    expect(resp.usage).toMatchObject({
      inputTokens: 900,
      outputTokens: 150,
      reasoningTokens: 40,
      costUsd: 0.00045,
    });
  });

  it("maps HTTP errors to retry kinds", async () => {
    const answer = (status: number, body: string) =>
      vi.stubGlobal("fetch", async () => new Response(body, { status }));
    const t = new OpenRouterTransport(loadSettings({}));
    const req = {
      model: "m",
      messages: [],
      schemaName: "x",
      schema: {},
      temperature: 0,
      maxTokens: 1,
      reasoning: "default" as const,
    };
    answer(429, '{"error":{"message":"Rate limit exceeded: free-models-per-day"}}');
    await expect(t.complete(req)).rejects.toMatchObject({ kind: "rate_limit" });
    answer(503, "busy");
    await expect(t.complete(req)).rejects.toMatchObject({ kind: "transient", status: 503 });
    answer(402, "no credits");
    await expect(t.complete(req)).rejects.toMatchObject({ kind: "api", status: 402 });
    answer(
      200,
      JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "{" } }] }),
    );
    await expect(t.complete(req)).rejects.toMatchObject({
      kind: "client",
      errorName: "LengthFinishReasonError",
    });
  });
});
