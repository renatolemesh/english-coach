/**
 * Local embeddings with transformers.js (ONNX, CPU): free, no API quota, ~ms per query.
 *
 * Runs in the worker (and scripts/ingest.ts); the model is loaded once per process and cached
 * under settings.modelsDir. bge models use the [CLS] token + L2 normalization (the pooling
 * the stored vectors were made with), and the retrieval instruction
 * from the model card is added to queries only (QUERY_PREFIXES), never to passages.
 */
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import type { Settings } from "../../config.js";
import { getLogger } from "../../logging.js";
import type { Embeddings } from "../../ports/embeddings.js";

const log = getLogger("coach.adapters.embeddings.local");

const BGE_QUERY = "Represent this sentence for searching relevant passages: ";
// Retrieval instructions from the model cards, applied to queries only (never to passages).
export const QUERY_PREFIXES: Readonly<Record<string, string>> = {
  "BAAI/bge-small-en-v1.5": BGE_QUERY,
  "BAAI/bge-base-en-v1.5": BGE_QUERY,
  "Xenova/bge-small-en-v1.5": BGE_QUERY,
  "Xenova/bge-base-en-v1.5": BGE_QUERY,
};

const BATCH = 32;

export interface LocalEmbeddingsOptions {
  /** false: only use files already in modelsDir (tests, offline). */
  allowDownload?: boolean;
}

export class LocalEmbeddings implements Embeddings {
  readonly dim: number;
  private readonly modelName: string;
  private readonly modelsDir: string;
  private readonly allowDownload: boolean;
  private model: Promise<FeatureExtractionPipeline> | null = null;

  constructor(settings: Settings, opts: LocalEmbeddingsOptions = {}) {
    this.dim = settings.embeddingDim;
    this.modelName = settings.localEmbeddingModel;
    this.modelsDir = settings.modelsDir;
    this.allowDownload = opts.allowDownload ?? true;
  }

  async load(): Promise<void> {
    await this.extractor();
  }

  private extractor(): Promise<FeatureExtractionPipeline> {
    this.model ??= this.create().catch((err: unknown) => {
      this.model = null; // retry on the next call (e.g. a failed download)
      throw err;
    });
    return this.model;
  }

  private async create(): Promise<FeatureExtractionPipeline> {
    const { env, pipeline } = await import("@huggingface/transformers"); // onnxruntime: lazy
    env.cacheDir = this.modelsDir;
    env.allowRemoteModels = this.allowDownload;
    const model = await pipeline("feature-extraction", this.modelName, {
      dtype: "fp32",
      device: "cpu",
    });
    log.info("embedding_model_loaded", { model: this.modelName });
    return model;
  }

  private async embed(texts: string[]): Promise<number[][]> {
    const model = await this.extractor();
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const tensor = await model(texts.slice(i, i + BATCH), { pooling: "cls", normalize: true });
      out.push(...(tensor.tolist() as number[][]));
    }
    this.check(out);
    return out;
  }

  embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.length ? this.embed(texts) : Promise.resolve([]);
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vector] = await this.embed([(QUERY_PREFIXES[this.modelName] ?? "") + text]);
    if (!vector) throw new Error("embedding model returned no vector");
    return vector;
  }

  private check(vectors: number[][]): void {
    const got = vectors[0]?.length;
    if (got !== undefined && got !== this.dim) {
      throw new Error(`${this.modelName} returns ${got} dims but EMBEDDING_DIM=${this.dim}`);
    }
  }
}
