import { defineConfig } from "drizzle-kit";

// Schema in src/db/schema.ts mirrors the tables created by the Python/Alembic migrations
// (0001-0008). New migrations are generated into drizzle/ from here on.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: process.env.DRIZZLE_OUT ?? "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
