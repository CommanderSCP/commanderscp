import { defineConfig } from "vitest/config";

/** Docker-backed: every case builds or runs the scp-runner-ops image. */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 900_000
  }
});
