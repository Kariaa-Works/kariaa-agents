import { defineConfig } from "vitest/config";

export default defineConfig({
  // Run from the repo root: npm test.
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    pool: "threads",
    maxWorkers: 2,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
