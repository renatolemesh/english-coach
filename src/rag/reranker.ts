/** Reranking extension point (off by default). A cross-encoder or an LLM-based reranker can
 * implement `Reranker` and be selected in build.ts. */
import type { Document } from "../ports/vector-store.js";

export interface Reranker {
  rerank(query: string, docs: Document[], k: number): Promise<Document[]>;
}

export class NoopReranker implements Reranker {
  async rerank(_query: string, docs: Document[], k: number): Promise<Document[]> {
    return docs.slice(0, k);
  }
}
