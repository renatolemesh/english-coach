import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../../src/adapters/cache/memory.js";
import { HashEmbeddings } from "../../src/adapters/embeddings/fake.js";
import { OpenRouterEmbeddings } from "../../src/adapters/embeddings/openrouter.js";
import { NullRetriever } from "../../src/adapters/retrieval/null.js";
import { loadSettings } from "../../src/config.js";
import { Document } from "../../src/ports/vector-store.js";
import { buildRetriever } from "../../src/rag/build.js";
import { contentHash } from "../../src/rag/hashing.js";
import { KnowledgeBase } from "../../src/rag/knowledge-base.js";

afterEach(() => vi.unstubAllGlobals());

describe("HashEmbeddings", () => {
  it("gives the reference vectors", async () => {
    const v = await new HashEmbeddings(16).embedQuery("I don't goed home, home!");
    const expected = [0, 0.904534, 0, -0.301511, 0, 0, 0, 0, 0, 0, -0.301511, 0, 0, 0, 0, 0];
    for (const [i, x] of v.entries()) expect(x).toBeCloseTo(expected[i] ?? NaN, 6);
  });
});

describe("contentHash", () => {
  it("matches the reference hashes", () => {
    const seed = Document.parse({
      collection: "grammar_notes",
      key: "since-for",
      kind: "rule",
      source: "grammar/tenses.md",
      level: "B1",
      content: "Since and for: x",
    });
    const mistake = Document.parse({
      collection: "student_mistakes",
      content: "Said x",
      userId: 7,
      metadata: { explanation: "é" },
    });
    // stored rows carry these hashes: they must not change
    expect(contentHash(seed)).toBe(
      "dd62ca1f7353f880771fbd3703604c2a72143a3c8f1586bd0c74ab78e7cc7bc1",
    );
    expect(contentHash(mistake)).toBe(
      "24e0e8f4738bae20bd7777b30966a9301cae297429632cff0d1110c121c80c7a",
    );
    const withMeta = Document.parse({
      collection: "lesson_content",
      content: "c",
      metadata: { b: 1, a: ["x", "é", null, true] },
    });
    expect(contentHash(withMeta)).toBe(
      "e65f95e28e38516b94e0859364956b7cf051538f839af1d75e2bb4522213f226",
    );
  });
});

describe("OpenRouterEmbeddings", () => {
  it("embeds only texts that are not cached", async () => {
    const settings = loadSettings({}, { embeddingBackend: "openrouter" });
    const calls: string[][] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const { input } = JSON.parse(String(init.body)) as { input: string[] };
      calls.push(input);
      const data = input.map((t, index) => ({ index, embedding: [t.length, 1] }));
      return new Response(JSON.stringify({ data: data.reverse() }), { status: 200 });
    });
    const emb = new OpenRouterEmbeddings(settings, new MemoryCache());
    expect(await emb.embedDocuments(["a", "bb"])).toEqual([
      [1, 1],
      [2, 1],
    ]);
    expect(await emb.embedDocuments(["bb", "ccc"])).toEqual([
      [2, 1],
      [3, 1],
    ]);
    expect(await emb.embedQuery("a")).toEqual([1, 1]);
    expect(calls).toEqual([["a", "bb"], ["ccc"]]);
  });
});

describe("buildRetriever", () => {
  const cache = new MemoryCache();
  it("is a NullRetriever when RAG is disabled", () => {
    expect(buildRetriever(loadSettings({}, { ragEnabled: false }), cache, null)).toBeInstanceOf(
      NullRetriever,
    );
  });

  it("uses the memory store with hash embeddings without a database", async () => {
    const kb = buildRetriever(loadSettings({}), cache, null);
    expect(kb).toBeInstanceOf(KnowledgeBase);
    expect((kb as KnowledgeBase).embeddings).toBeInstanceOf(HashEmbeddings);
    expect(await kb.retrieve("travel: hi", "travel", "B1", 1)).toBe("(none)");
  });

  it("refuses an embedding dim that does not match the column", () => {
    const fakeDb = {} as Parameters<typeof buildRetriever>[2];
    expect(() => buildRetriever(loadSettings({}, { embeddingDim: 1536 }), cache, fakeDb)).toThrow(
      /vector\(384\)/,
    );
  });
});
