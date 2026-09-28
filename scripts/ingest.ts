/**
 * Load data/topics/*.yaml and data/grammar/*.md into pgvector (idempotent; safe to re-run).
 *
 *   npx tsx scripts/ingest.ts
 */
import { RedisCache } from "../src/adapters/cache/redis.js";
import { PgVectorStore } from "../src/adapters/vector/pgvector.js";
import { getSettings } from "../src/config.js";
import { connect } from "../src/db/client.js";
import { configureLogging } from "../src/logging.js";
import { buildEmbeddings } from "../src/rag/build.js";
import { ingestSeeds } from "../src/rag/ingest.js";

async function main(): Promise<void> {
  configureLogging("warn");
  const settings = getSettings();
  const database = connect(settings.databaseUrl);
  const cache = RedisCache.fromUrl(settings.redisUrl);
  try {
    const store = new PgVectorStore(database, buildEmbeddings(settings, cache));
    const report = await ingestSeeds(store, settings.dataDir);
    console.log(
      `${report.files} files, ${report.documents} documents: ` +
        `${report.inserted} inserted, ${report.deleted} deleted, ` +
        `${report.documents - report.inserted} unchanged`,
    );
  } finally {
    await database.close();
    await cache.close();
  }
}

await main();
