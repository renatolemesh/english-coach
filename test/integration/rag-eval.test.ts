/**
 * recall@k of the real hybrid search (Postgres + local embeddings) over the seeds:
 *
 *     npx vitest run test/integration/rag-eval.test.ts
 *
 * Prints per-case ranks so a change that hurts retrieval is visible, and fails below the
 * threshold in test/rag-eval.yaml. The model must already be in settings.modelsDir (tests
 * never download: run `npx tsx scripts/ingest.ts` once, which fetches it).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { LocalEmbeddings } from "../../src/adapters/embeddings/local.js";
import { PgVectorStore } from "../../src/adapters/vector/pgvector.js";
import { loadSettings, PROJECT_ROOT } from "../../src/config.js";
import { connect } from "../../src/db/client.js";
import { DEFAULT_TOPIC } from "../../src/domain/topics.js";
import { SearchFilters } from "../../src/ports/vector-store.js";
import { ingestSeeds } from "../../src/rag/ingest.js";
import { nearbyLevels } from "../../src/rag/knowledge-base.js";
import { buildQuery } from "../../src/rag/query-builder.js";
import { TEST_DATABASE_URL } from "./helpers.js";

interface Case {
  collection: "lesson_content" | "grammar_notes";
  level: string;
  topic?: string;
  query: string;
  expected: string[];
}
const EVAL = parse(readFileSync(path.join(PROJECT_ROOT, "test", "rag-eval.yaml"), "utf8")) as {
  k: number;
  min_recall: number;
  cases: Case[];
};

const settings = loadSettings({}, { embeddingBackend: "local" });
const modelDir = path.join(settings.modelsDir, settings.localEmbeddingModel);
const database = connect(TEST_DATABASE_URL);
afterAll(() => database.close());

describe("rag eval", () => {
  it.runIf(existsSync(modelDir))(
    "recall at k",
    async () => {
      const store = new PgVectorStore(
        database,
        new LocalEmbeddings(settings, { allowDownload: false }),
      );
      await ingestSeeds(store, settings.dataDir); // idempotent
      const { k } = EVAL;
      let hits = 0;
      const lines: string[] = [];
      for (const c of EVAL.cases) {
        const query = buildQuery(c.query, c.topic ?? DEFAULT_TOPIC); // as in prod
        const filters = SearchFilters.parse({
          collection: c.collection,
          topic: c.topic ?? null,
          levels: nearbyLevels(c.level),
        });
        const keys = (await store.search(query, filters, k)).map((d) => d.key);
        const hit = c.expected.some((key) => keys.includes(key));
        hits += Number(hit);
        lines.push(
          `${hit ? "HIT " : "MISS"} ${JSON.stringify(c.expected)} <- ${JSON.stringify(keys)} :: ${c.query}`,
        );
      }
      const recall = hits / EVAL.cases.length;
      console.log(`\n${lines.join("\n")}\nrecall@${k} = ${recall.toFixed(2)}`);
      expect(recall).toBeGreaterThanOrEqual(EVAL.min_recall);
    },
    180_000,
  );
});
