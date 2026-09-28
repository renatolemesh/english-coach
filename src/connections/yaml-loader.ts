/**
 * connections.yaml (development): upserted into the database at boot.
 *
 * The file is the source of truth for the connections it defines: every restart overwrites
 * their DB row (including `enabled`). Manage a connection EITHER here OR via the admin API.
 *
 * Values may reference environment variables as ${NAME}, so secrets stay in .env:
 *
 *     connections:
 *       - id: evo-main
 *         name: Evolution principal
 *         provider: evolution
 *         webhook_secret: ${EVO_WEBHOOK_SECRET}
 *         credentials: {api_key: ${EVO_API_KEY}}
 *         settings: {base_url: http://evolution_api:8080, instance: coach}
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { ConnectionConfig } from "../domain/connections.js";

const ENV_RE = /\$\{([A-Z0-9_]+)\}/g;

export class MissingEnvVarError extends Error {
  override name = "KeyError";
}

function expand(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_RE, (_, name: string) => {
      const found = env[name];
      if (found === undefined) {
        throw new MissingEnvVarError(`connections.yaml references undefined env var ${name}`);
      }
      return found;
    });
  }
  if (Array.isArray(value)) return value.map((v) => expand(v, env));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, env)]));
  }
  return value;
}

export function loadConnectionsYaml(
  path: string,
  env: Record<string, string | undefined> = process.env,
): ConnectionConfig[] {
  const data = (parse(readFileSync(path, "utf8")) ?? {}) as { connections?: unknown[] };
  return (data.connections ?? []).map((item) => ConnectionConfig.parse(expand(item, env)));
}
