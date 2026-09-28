/** What nodes see of the LLM: a structured call that never throws at runtime (fallback). */
import type { z } from "zod";

// Set by the LLM client when OpenRouter says the account's free quota is used up; while it
// exists, messages get a fixed "busy" text instead of burning more requests.
export const QUOTA_FLAG_KEY = "llm:quota_exhausted";
// fallbackReason when OpenRouter refused because of that quota (every :free model shares it)
export const ACCOUNT_RATE_LIMIT = "account_rate_limit";

export interface Usage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number; // included in outputTokens
  costUsd: number;
  cached: boolean;
}

export const emptyUsage = (model = ""): Usage => ({
  model,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  cached: false,
});

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    model: a.model || b.model,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    costUsd: a.costUsd + b.costUsd,
    cached: a.cached && b.cached,
  };
}

export interface LLMResult<V> {
  value: V;
  usage: Usage;
  fallbackUsed: boolean;
  fallbackReason: string | null;
}

export interface LLMClient {
  /** Render the prompt, call with a strict JSON schema, validate; retry once with the error,
   * then other models, else `fallback`. `metadata` goes to logs only, never to the model.
   * Throws PromptError only for programming errors (unknown prompt, wrong variables/model). */
  structured<S extends z.ZodType>(
    promptId: string,
    variables: Record<string, string>,
    outputModel: S,
    fallback: z.infer<S>,
    metadata?: Record<string, unknown>,
  ): Promise<LLMResult<z.infer<S>>>;
}
