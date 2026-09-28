/** Integration tests use the stack's Postgres (database coach_test, already migrated by the
 * app's migrations) and Redis db 15, on 127.0.0.1. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../../src/config.js";

function envValue(name: string): string {
  const line = readFileSync(path.join(PROJECT_ROOT, ".env"), "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim() ?? "";
}

export const TEST_DATABASE_URL = envValue("DATABASE_URL").replace(/\/coach$/, "/coach_test");
export const TEST_REDIS_URL = "redis://127.0.0.1:6380/15";
export const TRUNCATE =
  "TRUNCATE students, admin_users, web_sessions, app_settings, audit_log, turns, mistakes RESTART IDENTITY CASCADE";
