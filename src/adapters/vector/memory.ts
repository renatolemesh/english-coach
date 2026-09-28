/** In-memory VectorStore (tests): cosine + keyword overlap fused with the same RRF formula. */
import type { Embeddings } from "../../ports/embeddings.js";
import type { Document, SearchFilters, VectorStore } from "../../ports/vector-store.js";
import { contentHash } from "../../rag/hashing.js";
import { RRF_K } from "../../rag/hybrid-sql.js";
import { ftsTerms } from "../../rag/query-builder.js";

type Stored = readonly [Document, number[]];

const words = (text: string) => new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
const overlap = (terms: Set<string>, text: string) => {
  let n = 0;
  for (const w of words(text)) if (terms.has(w)) n++;
  return n;
};

export class MemoryVectorStore implements VectorStore {
  /** content hash -> (document, vector), in insertion order. */
  readonly docs = new Map<string, Stored>();

  constructor(readonly embeddings: Embeddings) {}

  private static matches(doc: Document, f: SearchFilters): boolean {
    return (
      doc.collection === f.collection &&
      (f.topic === null || doc.topic === f.topic || doc.topic === null) &&
      (f.levels === null || doc.level === null || f.levels.includes(doc.level)) &&
      doc.userId === f.userId // null matches only shared documents
    );
  }

  async search(
    query: string,
    filters: SearchFilters,
    k: number,
    queryVector?: number[],
  ): Promise<Document[]> {
    const qvec = queryVector ?? (await this.embeddings.embedQuery(query));
    const pool = [...this.docs.values()].filter(([d]) => MemoryVectorStore.matches(d, filters));
    const byVec = pool
      .map((dv) => [dv, cosine(qvec, dv[1])] as const)
      .sort((a, b) => b[1] - a[1])
      .map(([dv]) => dv);
    const terms = new Set(ftsTerms(query).split(" | "));
    terms.delete("");
    const byKw = pool
      .map((dv) => [dv, overlap(terms, dv[0].content)] as const)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([dv]) => dv);
    const scores = new Map<string, number>();
    for (const ranking of [byVec, byKw]) {
      for (const [i, [doc]] of ranking.entries()) {
        const h = contentHash(doc);
        scores.set(h, (scores.get(h) ?? 0) + 1 / (RRF_K + i + 1));
      }
    }
    const best = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
    return best.flatMap(([h, score]) => {
      const stored = this.docs.get(h);
      return stored ? [{ ...stored[0], score }] : [];
    });
  }

  async upsert(docs: Document[]): Promise<number> {
    const byHash = new Map(docs.map((d) => [contentHash(d), d] as const)); // dedupe, like Postgres
    const fresh = [...byHash].filter(([h]) => !this.docs.has(h));
    const vectors = await this.embeddings.embedDocuments(fresh.map(([, d]) => d.content));
    for (const [i, [h, doc]] of fresh.entries()) this.docs.set(h, [doc, vectors[i] ?? []]);
    return fresh.length;
  }

  async deleteStaleSeeds(keep: ReadonlySet<string>): Promise<number> {
    const doomed = [...this.docs].filter(([h, [d]]) => d.source !== null && !keep.has(h));
    for (const [h] of doomed) this.docs.delete(h);
    return doomed.length;
  }

  async trimUserDocuments(userId: number, keepLatest: number): Promise<number> {
    const mine = [...this.docs].filter(([, [d]]) => d.userId === userId); // insertion order
    const doomed = mine.slice(0, Math.max(0, mine.length - keepLatest));
    for (const [h] of doomed) this.docs.delete(h);
    return doomed.length;
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
