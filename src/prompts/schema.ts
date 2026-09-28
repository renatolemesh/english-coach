/**
 * Zod model -> strict JSON schema accepted by OpenRouter/OpenAI structured outputs: every object has `additionalProperties: false` and all
 * properties in `required`; validation-only keywords (min/max, lengths, titles, defaults) are
 * dropped (provider support varies; Zod enforces them after the call).
 */
import { z } from "zod";
import type { JsonSchema } from "./registry.js";

const KEEP = new Set([
  "type",
  "description",
  "enum",
  "properties",
  "items",
  "required",
  "anyOf",
  "const",
]);

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (!KEEP.has(key)) continue;
    out[key] =
      key === "properties"
        ? Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([n, p]) => [n, clean(p)]),
          )
        : clean(value);
  }
  if (out.type === "object") {
    out.required = Object.keys((out.properties as Record<string, unknown>) ?? {});
    out.additionalProperties = false;
  }
  return out;
}

export function strictSchema(model: z.ZodType): JsonSchema {
  return clean(z.toJSONSchema(model, { io: "output", unrepresentable: "any" })) as JsonSchema;
}

/** Paths of object properties without a `description` (every field must have one). */
export function missingDescriptions(schema: JsonSchema, path = "$"): string[] {
  const missing: string[] = [];
  const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
  for (const [name, prop] of Object.entries(props)) {
    if (!prop.description) missing.push(`${path}.${name}`);
    missing.push(...missingDescriptions(prop, `${path}.${name}`));
    if (prop.items)
      missing.push(...missingDescriptions(prop.items as JsonSchema, `${path}.${name}[]`));
  }
  return missing;
}
