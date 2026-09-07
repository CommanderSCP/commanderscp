import { defineConfig } from "vitest/config";

/** THE KIND LAYER. See docs/runner-launcher.md §434. */
export default defineConfig({
  test: {
    include: ["src/**/*.kind.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } }
  }
});
