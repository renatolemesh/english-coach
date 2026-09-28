/** Settings the admin changes in the panel (table `app_settings`), read by the API and the
 * worker. Unknown keys in the table are ignored; missing keys use the defaults. Values are
 * cached for CACHE_TTL_S in the shared cache; saving clears that cache. */
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { appSettings } from "../db/schema.js";
import { getLogger } from "../logging.js";
import type { Cache } from "../ports/cache.js";
import {
  CACHE_KEY,
  CACHE_TTL_S,
  defaultRuntimeConfig,
  type RuntimeConfig,
  RuntimeConfigSchema,
} from "./runtime.js";

const log = getLogger("coach.accounts.runtime");

export class RuntimeConfigStore {
  constructor(
    private readonly db: Db | null, // null: tests and simulate use the defaults
    private readonly cache: Cache,
  ) {}

  async get(): Promise<RuntimeConfig> {
    if (!this.db) return defaultRuntimeConfig();
    try {
      const cached = await this.cache.get(CACHE_KEY);
      if (cached) return RuntimeConfigSchema.parse(JSON.parse(cached.toString()));
    } catch (exc) {
      log.warning("runtime_config_cache_failed", { error: String(exc) }); // read the table
    }
    const config = await this.load();
    try {
      await this.cache.set(CACHE_KEY, Buffer.from(JSON.stringify(config)), CACHE_TTL_S);
    } catch {
      // best effort
    }
    return config;
  }

  private async load(): Promise<RuntimeConfig> {
    if (!this.db) return defaultRuntimeConfig();
    let rows: { key: string; value: unknown }[];
    try {
      // the JSON as text: Drizzle's jsonb re-parses string values ('"5541999990000"' would
      // come back as a number)
      const raw = await this.db
        .select({ key: appSettings.key, value: sql<string>`${appSettings.value}::text` })
        .from(appSettings);
      rows = raw.map((r) => ({ key: r.key, value: JSON.parse(r.value) as unknown }));
    } catch (exc) {
      log.warning("runtime_config_load_failed", { error: String(exc) }); // defaults keep the bot up
      return defaultRuntimeConfig();
    }
    const known = new Set(Object.keys(RuntimeConfigSchema.shape));
    const values = Object.fromEntries(
      rows.filter((r) => known.has(r.key)).map((r) => [r.key, r.value]),
    );
    const parsed = RuntimeConfigSchema.safeParse(values);
    if (parsed.success) return parsed.data;
    log.warning("runtime_config_invalid", { error: parsed.error.message });
    return defaultRuntimeConfig();
  }

  /** Validate the whole config, then store every field. Throws the Zod error when invalid. */
  async save(values: Record<string, unknown>, actor: string): Promise<RuntimeConfig> {
    if (!this.db) throw new Error("no database");
    const config = RuntimeConfigSchema.parse(values);
    await this.db.transaction(async (tx) => {
      for (const [key, raw] of Object.entries(config)) {
        // JSON null, not SQL NULL (the column is NOT NULL; existing rows store 'null')
        const value = sql`${JSON.stringify(raw)}::jsonb`;
        await tx
          .insert(appSettings)
          .values({ key, value, updatedBy: actor })
          .onConflictDoUpdate({
            target: appSettings.key,
            set: { value, updatedBy: actor, updatedAt: sql`now()` },
          });
      }
    });
    await this.cache.delete(CACHE_KEY);
    return config;
  }
}
