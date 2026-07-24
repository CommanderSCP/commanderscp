import { provisionWorkerDatabase } from "./db-clone.js";

/**
 * LEVER 3 — per-worker template-DB isolation, the Vitest `setupFiles` entry (see
 * vitest.integration.config.ts). Unlike `globalSetup`, a setup file runs INSIDE each worker fork,
 * which is exactly where the per-worker database clone + env repointing must happen. The real work
 * lives in test-support/db-clone.ts (kept side-effect free so globalSetup can share its helpers);
 * this module just drives it once per worker, before any test file's `buildTestServer` call.
 */
await provisionWorkerDatabase();
