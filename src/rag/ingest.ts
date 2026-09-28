/** Idempotent seed ingestion: upsert every seed file first (new/changed items are embedded;
 * unchanged ones cost nothing), then delete in one pass every stored seed item that is no longer
 * in any file (edited, moved, or its whole file deleted). */
import type { VectorStore } from "../ports/vector-store.js";
import { contentHash } from "./hashing.js";
import { loadSeeds } from "./seeds.js";

export interface IngestReport {
  files: number;
  documents: number;
  inserted: number;
  deleted: number;
}

export async function ingestSeeds(store: VectorStore, dataDir: string): Promise<IngestReport> {
  const report: IngestReport = { files: 0, documents: 0, inserted: 0, deleted: 0 };
  const keep = new Set<string>();
  for (const docs of loadSeeds(dataDir).values()) {
    report.files += 1;
    report.documents += docs.length;
    report.inserted += await store.upsert(docs);
    for (const d of docs) keep.add(contentHash(d));
  }
  report.deleted = await store.deleteStaleSeeds(keep);
  return report;
}
