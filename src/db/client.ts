/** Postgres pool + Drizzle. One pool per process; `close()` on shutdown. */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;

export interface Database {
  db: Db;
  pool: pg.Pool;
  close(): Promise<void>;
}

export function connect(databaseUrl: string, max = 5): Database {
  const pool = new pg.Pool({ connectionString: databaseUrl, max });
  const db = drizzle(pool, { schema, casing: "snake_case" });
  return { db, pool, close: () => pool.end() };
}
