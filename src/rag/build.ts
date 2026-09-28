/** Picks the retriever from Settings. */
import { HashEmbeddings } from "../adapters/embeddings/fake.js";
import { LocalEmbeddings } from "../adapters/embeddings/local.js";
import { OpenRouterEmbeddings } from "../adapters/embeddings/openrouter.js";
import { NullRetriever } from "../adapters/retrieval/null.js";
import { MemoryVectorStore } from "../adapters/vector/memory.js";
import { PgVectorStore } from "../adapters/vector/pgvector.js";
import type { Settings } from "../config.js";
import type { Database } from "../db/client.js";
import type { Cache } from "../ports/cache.js";
import type { Embeddings } from "../ports/embeddings.js";
import type { Retriever } from "../ports/retriever.js";
import { KnowledgeBase } from "./knowledge-base.js";

export const EMBEDDING_DIM = 384; // documents.embedding is vector(384) (db/schema.ts)

export function buildEmbeddings(settings: Settings, cache: Cache): Embeddings {
  return settings.embeddingBackend === "local"
    ? new LocalEmbeddings(settings)
    : new OpenRouterEmbeddings(settings, cache);
}

export function buildRetriever(
  settings: Settings,
  cache: Cache,
  database: Pick<Database, "db" | "pool"> | null,
): Retriever {
  if (!settings.ragEnabled) return new NullRetriever();
  if (database === null) {
    // fakes: same logic over an in-memory store with hashing embeddings
    const fake = new HashEmbeddings(settings.embeddingDim);
    return new KnowledgeBase(new MemoryVectorStore(fake), fake, settings);
  }
  if (settings.embeddingDim !== EMBEDDING_DIM) {
    throw new Error(
      `EMBEDDING_DIM=${settings.embeddingDim} but documents.embedding is ` +
        `vector(${EMBEDDING_DIM}); add a migration and re-ingest (see rag/CLAUDE.md)`,
    );
  }
  const embeddings = buildEmbeddings(settings, cache);
  return new KnowledgeBase(new PgVectorStore(database, embeddings), embeddings, settings);
}
