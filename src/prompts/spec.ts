/** Zod model of a prompt file (prompts/*.json). */
import { z } from "zod";

export const ModelRole = z.enum(["evaluator", "conversation", "guard"]);
export type ModelRole = z.infer<typeof ModelRole>;

export const SystemSpec = z
  .object({
    role: z.string(),
    task: z.string(),
    rules: z.array(z.string()).default([]),
    tone: z.string().default(""),
  })
  .strict();

export const PromptExample = z
  .object({ input: z.record(z.string(), z.unknown()), output: z.record(z.string(), z.unknown()) })
  .strict();

export const PromptSpec = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    model_role: ModelRole,
    temperature: z.number().min(0).max(2),
    max_tokens: z.number().int().positive().default(800),
    cache: z.boolean(), // cache the LLM response (off for conversational variety)
    cache_ttl_s: z.number().int().positive().nullable().default(null), // overrides CACHE_TTL_LLM_S
    system: SystemSpec,
    input_variables: z.array(z.string()),
    untrusted_variables: z.array(z.string()).default([]), // student/RAG content
    user_template: z.string(),
    output_schema: z.string(), // path relative to the project root
    examples: z.array(PromptExample).default([]),
  })
  .strict();
export type PromptSpec = z.infer<typeof PromptSpec>;
