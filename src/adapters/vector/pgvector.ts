/** VectorStore on Postgres + pgvector. Swappable for Qdrant behind the same interface. */
import { and, desc, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { documents } from "../../db/schema.js";
import type { Embeddings } from "../../ports/embeddings.js";
import { Document, type SearchFilters, type VectorStore } from "../../ports/vector-store.js";
import { contentHash } from "../../rag/hashing.js";
import { HYBRID_SEARCH } from "../../rag/hybrid-sql.js";
import { ftsTerms } from "../../rag/query-builder.js";

export const CANDIDATES = 40; // per method, before fusion

export const vectorLiteral = (vec: number[]) => `[${vec.map((v) => v.toFixed(7)).join(",")}]`;

interface HitRow {
  collection: string;
  key: string | null;
  source: string | null;
  content: string;
  topic: string | null;
  level: string | null;
  kind: string;
  user_id: number | null;
  metadata: Record<string, unknown> | null;
  score: string | number;
}

export class PgVectorStore implements VectorStore {
  constructor(
    private readonly database: Pick<Database, "db" | "pool">,
    readonly embeddings: Embeddings,
  ) {}

  async search(
    query: string,
    filters: SearchFilters,
    k: number,
    queryVector?: number[],
  ): Promise<Document[]> {
    const qvec = queryVector ?? (await this.embeddings.embedQuery(query));
    const params = [
      filters.collection,
      filters.topic,
      filters.levels,
      filters.userId,
      vectorLiteral(qvec),
      ftsTerms(query),
      CANDIDATES,
      k,
    ];
    const client = await this.database.pool.connect();
    let rows: HitRow[];
    try {
      await client.query("BEGIN");
      // pgvector >= 0.8: keep scanning the HNSW index until enough rows pass the filters.
      await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
      rows = (await client.query<HitRow>(HYBRID_SEARCH, params)).rows;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return rows.map((row) =>
      Document.parse({
        collection: row.collection,
        key: row.key,
        source: row.source,
        content: row.content,
        topic: row.topic,
        level: row.level,
        kind: row.kind,
        userId: row.user_id,
        metadata: row.metadata ?? {},
        score: Number(row.score),
      }),
    );
  }

  async upsert(docs: Document[]): Promise<number> {
    if (!docs.length) return 0;
    const { db } = this.database;
    const byHash = new Map(docs.map((d) => [contentHash(d), d] as const));
    const existing = new Set(
      (
        await db
          .select({ h: documents.contentHash })
          .from(documents)
          .where(inArray(documents.contentHash, [...byHash.keys()]))
      ).map((r) => r.h),
    );
    const fresh = [...byHash].filter(([h]) => !existing.has(h));
    if (!fresh.length) return 0;
    const vectors = await this.embeddings.embedDocuments(fresh.map(([, d]) => d.content));
    const rows = fresh.map(([h, d], i) => ({
      collection: d.collection,
      contentHash: h,
      key: d.key,
      source: d.source,
      content: d.content,
      topic: d.topic,
      level: d.level,
      kind: d.kind,
      userId: d.userId,
      metadata: d.metadata,
      embedding: vectors[i] ?? [],
    }));
    const inserted = await db
      .insert(documents)
      .values(rows)
      .onConflictDoNothing({ target: documents.contentHash })
      .returning({ id: documents.id });
    return inserted.length;
  }

  async deleteStaleSeeds(keep: ReadonlySet<string>): Promise<number> {
    const deleted = await this.database.db
      .delete(documents)
      .where(and(isNotNull(documents.source), notInArray(documents.contentHash, [...keep])))
      .returning({ id: documents.id });
    return deleted.length;
  }

  async trimUserDocuments(userId: number, keepLatest: number): Promise<number> {
    const { db } = this.database;
    const newest = db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.userId, userId))
      .orderBy(desc(documents.id))
      .limit(keepLatest);
    const deleted = await db
      .delete(documents)
      .where(and(eq(documents.userId, userId), notInArray(documents.id, newest)))
      .returning({ id: documents.id });
    return deleted.length;
  }
}
