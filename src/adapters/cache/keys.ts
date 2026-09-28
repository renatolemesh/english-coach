/** Deterministic cache keys: namespace + sha256 of the parts (sorted-key JSON). */
import { createHash } from "node:crypto";

function stable(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${stable(v)}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

export function cacheKey(namespace: string, ...parts: unknown[]): string {
  return `${namespace}:${createHash("sha256").update(stable(parts)).digest("hex")}`;
}

export function bytesKey(namespace: string, data: Buffer, ...parts: unknown[]): string {
  return cacheKey(namespace, createHash("sha256").update(data).digest("hex"), ...parts);
}
