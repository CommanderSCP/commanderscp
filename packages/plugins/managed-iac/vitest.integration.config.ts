import { defineConfig } from "vitest/config";

/** Docker-requiring integration layer. See docs/plugins.md §461. */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 300_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }
  }
});
