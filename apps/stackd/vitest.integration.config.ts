import { defineConfig } from "vitest/config";

/** Integration layer: the built scp-stackd image, run for real (needs a Docker daemon). */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 900_000
  }
});
