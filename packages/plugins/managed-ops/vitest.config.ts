import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts"],
    // A REVIEWED budget, not vitest's implicit 5,000ms default — the census gate exists because
    // that default flaked @scp/runner-launcher 5 runs in 23 under the parallel graph.
    testTimeout: 20_000,
    hookTimeout: 30_000
  }
});
