/**
 * Schema migrations (Drizzle, `drizzle/`), run by the API at startup.
 *
 * `0000_baseline` is the schema of existing databases created before Drizzle (revision 0007 in
 * their `alembic_version` table) and `0001_accounts_panel` adds accounts and the panel (revision
 * 0008, with its plans and the update of existing students). Such a database adopts the
 * migrations it already has without running them (ADOPTED); any other recorded revision is
 * refused. New migrations come from
 * `npx drizzle-kit generate` after editing src/db/schema.ts.
 */
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";
import { PROJECT_ROOT } from "../config.js";
import { getLogger } from "../logging.js";
import type { Database } from "./client.js";

const log = getLogger("coach.db.migrate");
/** alembic_version revision (pre-Drizzle databases) -> Drizzle migrations it already covers. */
export const ADOPTED: Record<string, number> = { "0007": 1, "0008": 2 };
export const MIGRATIONS_DIR = path.join(PROJECT_ROOT, "drizzle");
const TABLE = "drizzle.__drizzle_migrations";

export async function runMigrations(database: Database, folder = MIGRATIONS_DIR): Promise<void> {
  await adoptAlembic(database.pool, folder);
  await migrate(database.db, { migrationsFolder: folder });
  log.info("migrations_done");
}

async function adoptAlembic(pool: pg.Pool, folder: string): Promise<void> {
  const alembic = await pool.query("SELECT to_regclass('public.alembic_version') AS t");
  if (!alembic.rows[0]?.t) return; // a new database: the baseline creates everything
  const drizzle = await pool.query("SELECT to_regclass($1) AS t", [TABLE]);
  if (drizzle.rows[0]?.t && (await pool.query(`SELECT 1 FROM ${TABLE} LIMIT 1`)).rowCount) return; // adopted before
  const version = (await pool.query("SELECT version_num FROM alembic_version")).rows[0]
    ?.version_num as string | undefined;
  const covered = version ? ADOPTED[version] : undefined;
  if (covered === undefined) {
    throw new Error(
      `alembic is at ${version ?? "nothing"}, expected one of ${Object.keys(ADOPTED)}`,
    );
  }
  const migrations = readMigrationFiles({ migrationsFolder: folder }).slice(0, covered);
  if (migrations.length < covered) throw new Error(`missing migrations in ${folder}`);
  await pool.query("CREATE SCHEMA IF NOT EXISTS drizzle");
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
  );
  for (const m of migrations) {
    await pool.query(`INSERT INTO ${TABLE} (hash, created_at) VALUES ($1, $2)`, [
      m.hash,
      m.folderMillis,
    ]);
  }
  log.info("alembic_adopted", { alembic: version });
}
