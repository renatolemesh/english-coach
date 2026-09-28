import { defineConfig } from "vitest/config";

const shared = { environment: "node" as const, setupFiles: ["test/setup.ts"], testTimeout: 20_000 };

export default defineConfig({
  test: {
    projects: [
      { test: { ...shared, name: "unit", include: ["test/**/*.test.ts"], exclude: ["test/integration/**"] } },
      // One file at a time: they share coach_test, and sql-repo's TRUNCATE ... CASCADE also
      // empties the documents the RAG eval reads.
      { test: { ...shared, name: "integration", include: ["test/integration/**/*.test.ts"], fileParallelism: false } },
    ],
  },
});
