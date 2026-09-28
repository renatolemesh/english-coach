/** `npx tsx scripts/migrate.ts`: apply the Drizzle migrations to DATABASE_URL. */
import { getSettings } from "../src/config.js";
import { connect } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";

const database = connect(getSettings().databaseUrl, 1);
try {
  await runMigrations(database);
} finally {
  await database.close();
}
