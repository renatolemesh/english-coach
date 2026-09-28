/** Embeddings through OpenRouter's /embeddings endpoint (OpenAI-compatible), cached by text. */
import type { Settings } from "../../config.js";
import type { Cache } from "../../ports/cache.js";
import type { Embeddings } from "../../ports/embeddings.js";
import { cacheKey } from "../cache/keys.js";

interface EmbeddingResponse {
  data: { index: number; embedding: number[] }[];
}

export class OpenRouterEmbeddings implements Embeddings {
  readonly dim: number;
  private readonly model: string;
  private readonly ttl: number;

  constructor(
    private readonly settings: Settings,
    private readonly cache: Cache,
  ) {
    this.dim = settings.embeddingDim;
    this.model = settings.embeddingModel;
    this.ttl = settings.cacheTtlEmbeddingsS;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const keys = texts.map((t) => cacheKey("emb", this.model, t));
    const found = new Map<number, number[]>();
    for (const [i, key] of keys.entries()) {
      try {
        const raw = await this.cache.get(key); // the cache is an optimization
        if (raw !== null) found.set(i, JSON.parse(raw.toString("utf8")) as number[]);
      } catch {}
    }
    const missing = texts.map((_, i) => i).filter((i) => !found.has(i));
    if (missing.length) {
      const vectors = await this.request(missing.map((i) => texts[i] ?? ""));
      for (const [j, i] of missing.entries()) {
        const vec = vectors[j];
        if (!vec) throw new Error("embeddings response is missing vectors");
        found.set(i, vec);
        try {
          await this.cache.set(keys[i] ?? "", Buffer.from(JSON.stringify(vec)), this.ttl);
        } catch {}
      }
    }
    return texts.map((_, i) => found.get(i) ?? []);
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embedDocuments([text]);
    return vector ?? [];
  }

  /** Raw strings (not token ids), with the same timeout/retries as the LLM calls. */
  private async request(input: string[]): Promise<number[][]> {
    const s = this.settings;
    let lastError: unknown;
    for (let attempt = 0; attempt <= s.llmMaxRetries; attempt++) {
      if (attempt) await sleep(s.llmRetryInitialWaitS * 1000 * 2 ** (attempt - 1));
      try {
        const resp = await fetch(`${s.openrouterBaseUrl}/embeddings`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${s.openrouterApiKey.value}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: this.model, input }),
          signal: AbortSignal.timeout(s.llmTimeoutS * 1000),
        });
        if (!resp.ok) {
          lastError = new Error(`embeddings HTTP ${resp.status}: ${await resp.text()}`);
          if (resp.status < 500 && resp.status !== 429) break; // not retryable
          continue;
        }
        const body = (await resp.json()) as EmbeddingResponse;
        return [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
