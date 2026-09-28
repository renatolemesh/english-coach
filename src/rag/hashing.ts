/**
 * Content hash that identifies a stored document (idempotent ingestion).
 *
 * Seeds hash every field that is stored (moving an item to another file or renaming its key
 * re-inserts it; the embedding itself is cached by text, so this costs no API call).
 * Student mistakes hash only user + wording, so the same mistake made in two topics or with a
 * different explanation is stored once. The hashes must not change: rows already stored would
 * be re-inserted.
 */
import { createHash } from "node:crypto";
import type { Document } from "../ports/vector-store.js";

/** JSON with sorted keys, ", " / ": " separators and non-ASCII kept as is (the hashed text). */
function pyJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${pyJson(v)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(doc: Document): string {
  const parts =
    doc.collection === "student_mistakes"
      ? [doc.collection, doc.userId === null ? "None" : String(doc.userId), doc.content]
      : [
          doc.collection,
          doc.key ?? "",
          doc.source ?? "",
          doc.topic ?? "",
          doc.level ?? "",
          doc.kind,
          doc.content,
          pyJson(doc.metadata),
        ];
  return createHash("sha256").update(parts.join("\x1f"), "utf8").digest("hex");
}
