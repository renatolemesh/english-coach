/**
 * LLMClient over OpenRouter: strict JSON schema, Zod validation, one repair retry, transport
 * retries with backoff, a chain of fallback models under one deadline, response cache and
 * token/cost logging. Only when every model in the chain fails does the caller get its fixed
 * fallback.
 */
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type { ReasoningEffort, Settings } from "../../config.js";
import { getLogger } from "../../logging.js";
import type { Cache } from "../../ports/cache.js";
import {
  ACCOUNT_RATE_LIMIT,
  addUsage,
  emptyUsage,
  type LLMClient,
  type LLMResult,
  QUOTA_FLAG_KEY,
  type Usage,
} from "../../ports/llm.js";
import {
  PromptError,
  type PromptRegistry,
  type RenderedPrompt,
  type Role,
} from "../../prompts/registry.js";
import { strictSchema } from "../../prompts/schema.js";
import type { ModelRole } from "../../prompts/spec.js";
import { cacheKey } from "../cache/keys.js";

const log = getLogger("coach.adapters.llm.openrouter");
// Fallback models reason (their reasoning cannot always be turned off) and reasoning tokens
// count against max_tokens: give them room so they do not stop before the JSON.
export const FALLBACK_MAX_TOKENS_FACTOR = 4;
const FENCE_RE = /^```(?:json)?\s*|\s*```$/g;

// --- transport -------------------------------------------------------------------------------

export interface ChatRequest {
  model: string;
  messages: { role: Role; content: string }[];
  schemaName: string;
  schema: Record<string, unknown>;
  temperature: number;
  maxTokens: number;
  reasoning: ReasoningEffort;
}

export interface ChatResponse {
  content: string;
  finishReason: string | null;
  usage: Usage;
}

export type ChatErrorKind = "rate_limit" | "transient" | "api" | "client";

export class ChatError extends Error {
  constructor(
    readonly kind: ChatErrorKind,
    message: string,
    readonly status = 0,
    readonly errorName = "ChatError",
  ) {
    super(message);
  }
}

export interface ChatTransport {
  complete(request: ChatRequest): Promise<ChatResponse>;
}

/** OpenRouter's 429 for the per-account :free quota ("free-models-per-day"/"-per-min"):
 * trying other free models only burns more of it. Other 429s (one provider busy) do. */
export const isAccountLimit = (exc: unknown) =>
  exc instanceof ChatError && exc.kind === "rate_limit" && exc.message.includes("free-models-per");

/** Transient errors are retried, except the account quota: it will not reset in seconds. */
const retryable = (exc: unknown) =>
  exc instanceof ChatError &&
  (exc.kind === "transient" || exc.kind === "rate_limit") &&
  !isAccountLimit(exc);

/** The real HTTP transport (fetch). */
export class OpenRouterTransport implements ChatTransport {
  constructor(private readonly settings: Settings) {}

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      response_format: {
        type: "json_schema",
        json_schema: { name: req.schemaName, strict: true, schema: req.schema },
      },
      // Route only to providers that support every parameter we send (json_schema strict).
      provider: { require_parameters: true },
    };
    if (req.reasoning !== "default") body.reasoning = { effort: req.reasoning };
    let resp: Response;
    try {
      resp = await fetch(`${this.settings.openrouterBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.settings.openrouterApiKey.value}`,
          "Content-Type": "application/json",
          "X-Title": "saybest",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.settings.llmTimeoutS * 1000),
      });
    } catch (exc) {
      const name =
        exc instanceof Error && exc.name === "TimeoutError"
          ? "APITimeoutError"
          : "APIConnectionError";
      throw new ChatError("transient", String(exc), 0, name);
    }
    const text = await resp.text();
    if (resp.status === 429)
      throw new ChatError("rate_limit", text.slice(0, 500), 429, "RateLimitError");
    if (resp.status >= 500)
      throw new ChatError("transient", text.slice(0, 300), resp.status, "InternalServerError");
    if (!resp.ok) throw new ChatError("api", text.slice(0, 300), resp.status, "APIStatusError");
    const data = JSON.parse(text) as {
      choices?: { finish_reason?: string; message?: { content?: string | null } }[];
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
        cost?: number;
      };
      error?: { message?: string; code?: number };
    };
    if (data.error) {
      // errors can come with HTTP 200 (upstream provider failures)
      const code = Number(data.error.code ?? 0);
      const kind = code === 429 ? "rate_limit" : code >= 500 || code === 0 ? "transient" : "api";
      throw new ChatError(kind, String(data.error.message ?? "").slice(0, 500), code);
    }
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") {
      throw new ChatError("client", "max_tokens reached", 0, "LengthFinishReasonError");
    }
    const usage = data.usage ?? {};
    return {
      content: choice?.message?.content ?? "",
      finishReason: choice?.finish_reason ?? null,
      usage: {
        ...emptyUsage(req.model),
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
        costUsd: usage.cost ?? 0,
      },
    };
  }
}

// --- client ----------------------------------------------------------------------------------

export interface ModelSetup {
  names: Record<ModelRole, string>;
  reasoning: Record<ModelRole, ReasoningEffort>;
  fallbackModels: string[];
  fallbackReasoning: ReasoningEffort;
}

export function modelSetup(settings: Settings, fallbackModels: string[]): ModelSetup {
  return {
    names: {
      evaluator: settings.llmModelEvaluator,
      conversation: settings.llmModelConversation,
      guard: settings.llmModelGuard,
    },
    reasoning: {
      evaluator: settings.llmReasoningEvaluator,
      conversation: settings.llmReasoningConversation,
      guard: settings.llmReasoningGuard,
    },
    fallbackModels,
    fallbackReasoning: settings.llmFallbackReasoning,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenRouterLLM implements LLMClient {
  private readonly checked = new Set<string>();
  private readonly modelIds = new WeakMap<z.ZodType, number>();
  private nextModelId = 0;

  constructor(
    private readonly settings: Settings,
    private readonly registry: PromptRegistry,
    private readonly cache: Cache,
    private readonly transport: ChatTransport,
    private readonly models: ModelSetup,
  ) {}

  async structured<S extends z.ZodType>(
    promptId: string,
    variables: Record<string, string>,
    outputModel: S,
    fallback: z.infer<S>,
    metadata: Record<string, unknown> = {},
  ): Promise<LLMResult<z.infer<S>>> {
    const rendered = this.registry.render(promptId, variables);
    const spec = rendered.spec;
    this.checkOutputModel(rendered, outputModel);
    const modelName = this.models.names[spec.model_role];
    const meta = { prompt_id: spec.id, prompt_version: spec.version, ...metadata };
    const key = spec.cache ? this.cacheKey(rendered, modelName) : null;

    if (key) {
      const hit = await this.fromCache(key, outputModel);
      if (hit !== null) {
        log.info("llm_cache_hit", { model: modelName, ...meta });
        return {
          value: hit,
          usage: { ...emptyUsage(modelName), cached: true },
          fallbackUsed: false,
          fallbackReason: null,
        };
      }
    }

    let usage = emptyUsage(modelName);
    const reasons: string[] = [];
    const deadline = AbortSignal.timeout(this.settings.llmChainTimeoutS * 1000);
    const timedOut = new Promise<"timeout">((resolve) =>
      deadline.addEventListener("abort", () => resolve("timeout"), { once: true }),
    );
    // the whole chain has one deadline: a turn must end well within the thread lock
    for (const [name, maxTokens] of this.chain(modelName, spec.max_tokens)) {
      const primary = name === modelName;
      const outcome = await Promise.race([
        this.attempt(rendered, outputModel, name, maxTokens, meta, primary),
        timedOut,
      ]);
      if (outcome === "timeout") {
        reasons.push("chain_timeout");
        break;
      }
      const [value, callUsage, reason] = outcome;
      usage = addUsage(usage, callUsage);
      if (value !== null) {
        if (!primary) {
          // not cached: the key names the primary model
          log.warning("llm_fallback_model_used", { model: name, primary: modelName, ...meta });
        } else if (key) {
          await this.toCache(key, value, spec.cache_ttl_s);
        }
        return {
          value,
          usage: { ...usage, model: name },
          fallbackUsed: false,
          fallbackReason: null,
        };
      }
      reasons.push(reason);
      log.warning("llm_model_failed", { reason, model: name, ...meta });
      if (reason === ACCOUNT_RATE_LIMIT) break; // every :free model shares the same quota
    }
    const reason = reasons.join("|");
    log.warning("llm_fallback", { reason, model: modelName, ...meta });
    return { value: fallback, usage, fallbackUsed: true, fallbackReason: reason };
  }

  private chain(modelName: string, maxTokens: number): [string, number][] {
    const extra = this.models.fallbackModels.filter((m) => m !== modelName);
    return [
      [modelName, maxTokens],
      ...extra.map((m): [string, number] => [m, maxTokens * FALLBACK_MAX_TOKENS_FACTOR]),
    ];
  }

  /** One model: up to 2 calls (the second sends the validation error back). */
  private async attempt<S extends z.ZodType>(
    rendered: RenderedPrompt,
    outputModel: S,
    modelName: string,
    maxTokens: number,
    meta: Record<string, unknown>,
    primary: boolean,
  ): Promise<[z.infer<S> | null, Usage, string]> {
    let usage = emptyUsage(modelName);
    const messages = rendered.messages.map(([role, content]) => ({ role, content }));
    const reasoning = primary
      ? this.models.reasoning[rendered.spec.model_role]
      : this.models.fallbackReasoning;
    try {
      for (const attemptNo of [1, 2]) {
        const resp = await this.call(
          rendered,
          messages,
          modelName,
          maxTokens,
          reasoning,
          meta,
          primary,
        );
        usage = addUsage(usage, resp.usage);
        const parsed = parseOutput(outputModel, resp.content);
        if (parsed.ok) return [parsed.value, usage, ""];
        log.warning("llm_invalid_output", {
          attempt: attemptNo,
          error: parsed.error,
          model: modelName,
          ...meta,
        });
        messages.push(
          { role: "assistant", content: resp.content },
          { role: "user", content: repairText(parsed.error) },
        );
      }
      return [null, usage, "invalid_output"];
    } catch (exc) {
      if (exc instanceof ChatError) {
        if (exc.kind === "rate_limit") {
          // which limit (per-min/per-day, account or upstream provider) is only in the text
          log.warning("llm_rate_limited", {
            model: modelName,
            error: exc.message.slice(0, 300),
            ...meta,
          });
          if (isAccountLimit(exc)) {
            await this.flagQuota(exc);
            return [null, usage, ACCOUNT_RATE_LIMIT];
          }
          return [null, usage, `transient_error:${exc.errorName}`];
        }
        if (exc.kind === "transient") return [null, usage, `transient_error:${exc.errorName}`];
        if (exc.kind === "api") return [null, usage, `api_error:${exc.errorName}:${exc.status}`];
        return [null, usage, `client_error:${exc.errorName}`];
      }
      log.exception("llm_unexpected_error", exc, { model: modelName, ...meta });
      return [null, usage, `unexpected:${exc instanceof Error ? exc.name : "Error"}`];
    }
  }

  private async call(
    rendered: RenderedPrompt,
    messages: { role: Role; content: string }[],
    modelName: string,
    maxTokens: number,
    reasoning: ReasoningEffort,
    meta: Record<string, unknown>,
    retry: boolean,
  ): Promise<ChatResponse> {
    const spec = rendered.spec;
    const attempts = retry ? this.settings.llmMaxRetries + 1 : 1;
    const start = performance.now();
    for (let n = 1; ; n++) {
      if (n > 1) log.warning("llm_retry", { attempt: n, ...meta });
      try {
        const resp = await this.transport.complete({
          model: modelName,
          messages: [...messages],
          schemaName: spec.id,
          schema: rendered.schema,
          temperature: spec.temperature,
          maxTokens,
          reasoning,
        });
        log.info("llm_call", {
          model: modelName,
          latency_ms: Math.round((performance.now() - start) * 10) / 10,
          input_tokens: resp.usage.inputTokens,
          output_tokens: resp.usage.outputTokens,
          reasoning_tokens: resp.usage.reasoningTokens,
          finish_reason: resp.finishReason,
          cost_usd: resp.usage.costUsd,
          ...meta,
        });
        return { ...resp, usage: { ...resp.usage, model: modelName } };
      } catch (exc) {
        if (n >= attempts || !retryable(exc)) throw exc;
        const base = this.settings.llmRetryInitialWaitS * 1000 * 2 ** (n - 1);
        await sleep(Math.min(base + Math.random() * base, 8000)); // exponential + jitter
      }
    }
  }

  private async flagQuota(exc: ChatError): Promise<void> {
    // per-minute quota: back in a minute; per-day: at 00:00 UTC
    let ttl = 60;
    if (exc.message.includes("per-day")) {
      const now = new Date();
      const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      ttl = Math.floor((midnight - now.getTime()) / 1000) + 60;
    }
    try {
      await this.cache.set(QUOTA_FLAG_KEY, Buffer.from("1"), ttl);
    } catch (cacheExc) {
      log.warning("quota_flag_failed", { error: String(cacheExc) });
    }
    log.warning("llm_quota_exhausted", { ttl_s: ttl });
  }

  /** Everything that changes the output is part of the key. */
  private cacheKey(rendered: RenderedPrompt, modelName: string): string {
    const spec = rendered.spec;
    return cacheKey(
      "llm",
      spec.id,
      spec.version,
      modelName,
      this.models.reasoning[spec.model_role],
      spec.temperature,
      spec.max_tokens,
      rendered.schema,
      rendered.messages,
    );
  }

  private checkOutputModel(rendered: RenderedPrompt, model: z.ZodType): void {
    let id = this.modelIds.get(model);
    if (id === undefined) {
      id = this.nextModelId++;
      this.modelIds.set(model, id);
    }
    const pair = `${rendered.spec.id}:${id}`;
    if (this.checked.has(pair)) return;
    if (!isDeepStrictEqual(strictSchema(model), rendered.schema)) {
      throw new PromptError(
        `${rendered.spec.id}: output model does not match ${rendered.spec.output_schema}`,
      );
    }
    this.checked.add(pair);
  }

  private async fromCache<S extends z.ZodType>(key: string, model: S): Promise<z.infer<S> | null> {
    let raw: Buffer | null;
    try {
      raw = await this.cache.get(key);
    } catch (exc) {
      log.warning("llm_cache_get_failed", { error: String(exc) }); // an optimization: fail open
      return null;
    }
    if (raw === null) return null;
    const parsed = parseOutput(model, raw.toString());
    return parsed.ok ? parsed.value : null; // model changed since it was cached
  }

  private async toCache(key: string, value: unknown, ttlS: number | null): Promise<void> {
    try {
      await this.cache.set(
        key,
        Buffer.from(JSON.stringify(value)),
        ttlS ?? this.settings.cacheTtlLlmS,
      );
    } catch (exc) {
      log.warning("llm_cache_set_failed", { error: String(exc) }); // a valid result still returns
    }
  }
}

/** Some providers wrap JSON in ``` fences even in json_schema mode. */
export function extractJson(text: string): string {
  return text.trim().replace(FENCE_RE, "");
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseOutput<S extends z.ZodType>(model: S, text: string): Parsed<z.infer<S>> {
  let data: unknown;
  try {
    data = JSON.parse(extractJson(text));
  } catch (exc) {
    return { ok: false, error: `$: invalid JSON (${String(exc).slice(0, 80)})` };
  }
  const result = model.safeParse(data);
  if (result.success) return { ok: true, value: result.data };
  const error = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "$"}: ${i.message}`)
    .join("; ");
  return { ok: false, error };
}

function repairText(error: string): string {
  return `Your previous answer did not match the required schema: ${error}. Reply again with only the corrected JSON object.`;
}
