/**
 * Application settings from environment variables (and `.env` outside tests), validated with Zod.
 * Each camelCase field is read from its UPPER_SNAKE env var (llmTimeoutS <- LLM_TIMEOUT_S).
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Secrets never show up in logs or JSON: only `.value` gives the text. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  get value(): string {
    return this.#value;
  }
  toJSON(): string {
    return this.#value ? "***" : "";
  }
  toString(): string {
    return this.toJSON();
  }
}

/** The repository root (prompts/, data/, templates/ live there). */
export const PROJECT_ROOT = path.resolve(
  process.env.SAYBEST_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);

// OpenRouter `reasoning.effort`; "default" = do not send the parameter.
export const ReasoningEffort = z.enum(["default", "none", "minimal", "low", "medium", "high"]);
export type ReasoningEffort = z.infer<typeof ReasoningEffort>;

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase()),
  );
const secret = z
  .string()
  .default("")
  .transform((v) => new Secret(v));
const num = z.coerce.number();
const int = z.coerce.number().int();
const root = (...parts: string[]) => path.join(PROJECT_ROOT, ...parts);

export const SettingsSchema = z.object({
  env: z.enum(["dev", "test", "prod"]).default("dev"),
  logLevel: z.string().default("info"),
  useFakes: bool.default(false),

  databaseUrl: z.string().default("postgresql://coach:coach@localhost:5433/coach"),
  redisUrl: z.string().default("redis://localhost:6380/0"),

  openrouterApiKey: secret,
  openrouterBaseUrl: z.string().default("https://openrouter.ai/api/v1"),
  llmModelEvaluator: z.string().default("dots-studio/dots-3-note-preview:free"),
  llmModelConversation: z.string().default("dots-studio/dots-3-note-preview:free"),
  llmModelGuard: z.string().default("dots-studio/dots-3-note-preview:free"),
  llmReasoningEvaluator: ReasoningEffort.default("none"),
  llmReasoningConversation: ReasoningEffort.default("none"),
  llmReasoningGuard: ReasoningEffort.default("none"),
  llmFallbackModels: z
    .string()
    .default("qwen/qwen3.8-27b:free,nvidia/nemotron-3-super-120b-a12b:free"),
  llmFallbackReasoning: ReasoningEffort.default("low"),
  llmChainTimeoutS: num.default(60),
  embeddingBackend: z.enum(["local", "openrouter"]).default("local"),
  localEmbeddingModel: z.string().default("Xenova/bge-small-en-v1.5"),
  embeddingModel: z.string().default("openai/text-embedding-3-small"),
  embeddingDim: int.default(384),
  llmTimeoutS: num.default(30),
  llmMaxRetries: int.default(2),
  llmRetryInitialWaitS: num.default(1),

  cacheTtlLlmS: int.default(7 * 24 * 3600),
  cacheTtlTtsS: int.default(30 * 24 * 3600),
  cacheTtlSttS: int.default(7 * 24 * 3600),
  cacheTtlEmbeddingsS: int.default(30 * 24 * 3600),

  whisperModelPath: z.string().default(root("models", "ggml-small.en.bin")),
  whisperVadModelPath: z.string().default(root("models", "ggml-silero-v6.2.0.bin")),
  whisperCli: z.string().default("whisper-cli"),
  whisperCpuThreads: int.default(2),
  sttMinConfidence: num.default(-2.0), // whisper.cpp scale (mean ln(p) of the text tokens)
  sttSureConfidence: num.default(-1.05), // whisper.cpp scale (mean ln(p) of the text tokens)

  kokoroModel: z.string().default("onnx-community/Kokoro-82M-v1.0-ONNX"),
  kokoroDtype: z.enum(["fp32", "fp16", "q8", "q4", "q4f16"]).default("fp32"),
  ttsSpeed: num.default(1),
  ttsCpuThreads: int.default(2),
  voiceMaxBytes: int.default(512 * 1024),

  promptCanary: z.string().default(() => randomBytes(6).toString("hex")),

  maxAudioSeconds: int.default(90),
  maxAudioBytes: int.default(16 * 1024 * 1024),
  maxTextChars: int.default(1000),
  rateLimitPerMinute: int.default(6),
  freeCommandsPerMinute: int.default(30),
  dailyTokenBudget: int.default(200_000),
  dailyCostBudgetUsd: num.default(0.5),

  ragEnabled: bool.default(true),
  ragK: int.default(3),
  ragMaxContextChars: int.default(1600),

  publicBaseUrl: z.string().default(""),
  fernetKey: secret,
  adminApiKey: secret,
  connectionsFile: z.string().optional(),
  metaGraphVersion: z.string().default("v26.0"),
  webhookIdempotencyTtlS: int.default(48 * 3600),
  webhookMaxBodyBytes: int.default(2 * 1024 * 1024),
  threadLockTimeoutS: int.default(300),
  threadLockWaitS: int.default(30),

  promptsDir: z.string().default(root("prompts")),
  templatesDir: z.string().default(root("templates")),
  dataDir: z.string().default(root("data")),
  modelsDir: z.string().default(root("models")),
});

export type Settings = z.infer<typeof SettingsSchema>;

const camel = (key: string) =>
  key.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Settings from an env-like record (UPPER_SNAKE keys) plus explicit overrides (camelCase). */
export function loadSettings(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<Record<keyof Settings, unknown>> = {},
): Settings {
  const values: Record<string, unknown> = {};
  const known = new Set(Object.keys(SettingsSchema.shape));
  for (const [key, value] of Object.entries(env)) {
    const name = camel(key);
    if (value !== undefined && known.has(name)) values[name] = value;
  }
  return SettingsSchema.parse({ ...values, ...overrides });
}

let cached: Settings | undefined;

/** Process-wide settings; reads `.env` from the project root unless running tests. */
export function getSettings(): Settings {
  if (!cached) {
    const file = path.join(PROJECT_ROOT, ".env");
    if (process.env.ENV !== "test" && existsSync(file)) process.loadEnvFile(file);
    cached = loadSettings();
  }
  return cached;
}

export function fallbackModels(settings: Settings): string[] {
  return settings.llmFallbackModels
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
}
