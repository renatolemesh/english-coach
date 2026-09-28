import { z } from "zod";
import type { Collection } from "../rag/sections.js";

export type { Collection } from "../rag/sections.js";

const COLLECTIONS = [
  "lesson_content",
  "grammar_notes",
  "student_mistakes",
] as const satisfies readonly Collection[];

export const Document = z
  .object({
    collection: z.enum(COLLECTIONS),
    content: z.string().min(1).max(2000),
    key: z.string().nullable().default(null).describe("Stable id for seed items (rag_eval)."),
    topic: z.string().nullable().default(null),
    level: z.string().nullable().default(null).describe("CEFR level; None = any level."),
    kind: z.string().default("item").describe("vocabulary | phrase | scenario | rule ..."),
    userId: z.number().int().nullable().default(null).describe("Only for student_mistakes."),
    source: z.string().nullable().default(null).describe("Seed file it came from."),
    metadata: z.record(z.string(), z.unknown()).default({}),
    score: z.number().default(0),
  })
  .strict();
export type Document = z.infer<typeof Document>;
export type DocumentInput = z.input<typeof Document>;

/** userId=null only ever matches shared documents (user_id IS NULL): fail closed. */
export const SearchFilters = z
  .object({
    collection: z.enum(COLLECTIONS),
    topic: z.string().nullable().default(null),
    levels: z.array(z.string()).nullable().default(null), // these levels or level-less documents
    userId: z.number().int().nullable().default(null),
  })
  .strict()
  .refine((f) => !(f.collection === "student_mistakes" && f.userId === null), {
    message: "student_mistakes searches must be scoped to one user_id",
  });
export type SearchFilters = z.infer<typeof SearchFilters>;
export type SearchFiltersInput = z.input<typeof SearchFilters>;

export interface VectorStore {
  /** Hybrid (vector + full-text, RRF) search within the filters. Pass `queryVector` to reuse
   * one embedding across several searches. */
  search(
    query: string,
    filters: SearchFilters,
    k: number,
    queryVector?: number[],
  ): Promise<Document[]>;
  /** Insert documents not stored yet (by content hash); return how many were new. */
  upsert(docs: Document[]): Promise<number>;
  /** Delete seed documents (source IS NOT NULL) whose hash is not in `keep`: items edited,
   * moved or removed, including whole files that no longer exist. */
  deleteStaleSeeds(keep: ReadonlySet<string>): Promise<number>;
  /** Keep only the newest `keepLatest` documents of one student. */
  trimUserDocuments(userId: number, keepLatest: number): Promise<number>;
}
