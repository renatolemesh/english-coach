/** Hybrid SQL on real Postgres with deterministic embeddings (no network): filters, RRF,
 * idempotent upsert, and that one student's mistakes are never returned for another. */
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { HashEmbeddings } from "../../src/adapters/embeddings/fake.js";
import { SqlRepository } from "../../src/adapters/repo/sql.js";
import { PgVectorStore } from "../../src/adapters/vector/pgvector.js";
import { connect } from "../../src/db/client.js";
import { students } from "../../src/db/schema.js";
import { Document, SearchFilters } from "../../src/ports/vector-store.js";
import { EMBEDDING_DIM } from "../../src/rag/build.js";
import { TEST_DATABASE_URL } from "./helpers.js";

const database = connect(TEST_DATABASE_URL);
afterAll(() => database.close());

const mistake = (userId: number, content: string) =>
  Document.parse({ collection: "student_mistakes", content, userId, kind: "grammar" });

describe("PgVectorStore", () => {
  it("student mistakes are isolated and hybrid ranked", async () => {
    const repo = new SqlRepository(database.db);
    const connId = `pgv-${Date.now() / 1000}`;
    const alice = await repo.getOrCreateStudent(connId, "1");
    const bob = await repo.getOrCreateStudent(connId, "2");
    const store = new PgVectorStore(database, new HashEmbeddings(EMBEDDING_DIM));
    try {
      const docs = [
        mistake(alice, "Said 'since five years' instead of 'for five years' (grammar)."),
        mistake(alice, "Said 'responsible of' instead of 'responsible for' (grammar)."),
        mistake(bob, "Said 'since five years' instead of 'for five years' (grammar)."),
      ];
      expect(await store.upsert(docs)).toBe(3);
      expect(await store.upsert(docs)).toBe(0); // idempotent by content hash

      const found = await store.search(
        "I work here since five years",
        SearchFilters.parse({ collection: "student_mistakes", userId: alice }),
        5,
      );
      expect(new Set(found.map((d) => d.userId))).toEqual(new Set([alice]));
      expect(found[0]?.content).toContain("since five years"); // vector and full-text agree
      expect(found[0]?.score).toBeGreaterThan(found.at(-1)?.score ?? Infinity);

      const nothing = await store.search(
        "responsible of",
        SearchFilters.parse({ collection: "student_mistakes", userId: bob }),
        5,
      );
      expect(nothing.every((d) => !d.content.includes("responsible"))).toBe(true);

      // shared collections never return personal documents (fail closed on userId=null)
      const shared = await store.search(
        "since five years",
        SearchFilters.parse({ collection: "grammar_notes" }),
        50,
      );
      expect(shared.every((d) => d.userId === null)).toBe(true);

      expect(await store.trimUserDocuments(alice, 1)).toBe(1);
      const left = await store.search(
        "said",
        SearchFilters.parse({ collection: "student_mistakes", userId: alice }),
        5,
      );
      expect(left.map((d) => d.content)).toEqual([docs[1]?.content]); // the newest one survives
    } finally {
      await database.db.delete(students).where(inArray(students.id, [alice, bob]));
      const { rows } = await database.pool.query<{ n: string }>(
        "select count(*) as n from documents where user_id = any($1)",
        [[alice, bob]],
      );
      expect(Number(rows[0]?.n)).toBe(0); // ON DELETE CASCADE removed the student's documents
    }
  });

  it("filters by topic and nearby levels, keeping level-less documents", async () => {
    const store = new PgVectorStore(database, new HashEmbeddings(EMBEDDING_DIM));
    const source = `test/pgv-${Date.now()}.yaml`;
    const doc = (key: string, topic: string, level: string | null) =>
      Document.parse({
        collection: "lesson_content",
        key,
        topic,
        level,
        source,
        content: `the boarding pass ${key}`,
      });
    const docs = [
      doc("t-a2", "zz-travel", "A2"),
      doc("t-c2", "zz-travel", "C2"),
      doc("t-any", "zz-travel", null),
      doc("s-a2", "zz-shopping", "A2"),
    ];
    try {
      expect(await store.upsert(docs)).toBe(4);
      const found = await store.search(
        "boarding pass",
        SearchFilters.parse({
          collection: "lesson_content",
          topic: "zz-travel",
          levels: ["A1", "A2", "B1"],
        }),
        10,
      );
      const keys = found
        .map((d) => d.key)
        .filter((k) => k?.startsWith("t-") || k?.startsWith("s-"));
      expect(new Set(keys)).toEqual(new Set(["t-a2", "t-any"]));
      expect(found.every((d) => d.userId === null)).toBe(true);
    } finally {
      await database.pool.query("delete from documents where source = $1", [source]);
    }
  });
});
