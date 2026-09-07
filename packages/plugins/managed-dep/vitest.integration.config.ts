import { defineConfig } from "vitest/config";

/** Docker-requiring integration layer. See docs/plugins.md §405. */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 600_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }
  }
});
