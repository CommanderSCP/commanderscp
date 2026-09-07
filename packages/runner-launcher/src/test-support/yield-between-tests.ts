import { afterAll, beforeEach } from "vitest";

/** RETURN THE WORKER'S EVENT LOOP BETWEEN TESTS. See docs/runner-launcher.md §412. */

/** Captured before any test body can install fake timers over `globalThis`. */
const realSetImmediate = globalThis.setImmediate;

/** The tripwire, below the worker deadline. See docs/runner-launcher.md §413. */
export const MAX_WORKER_STALL_MS = 45_000;

/** `process.hrtime.bigint()`, NOT `Date.now()`. See docs/runner-launcher.md §414. */
const nowMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

let lastYieldAt = nowMs();
let maxStallMs = 0;
let stalledTest = "<none>";
let currentTest = "<file setup>";

beforeEach(async (ctx) => {
  await new Promise<void>((resolve) => {
    realSetImmediate(resolve);
  });
  const now = nowMs();
  const stallMs = now - lastYieldAt;
  if (stallMs > maxStallMs) {
    maxStallMs = stallMs;
    stalledTest = currentTest;
  }
  lastYieldAt = now;
  currentTest = ctx.task.name;
});

afterAll(() => {
  if (maxStallMs > MAX_WORKER_STALL_MS) {
    throw new Error(
      `this worker's event loop did not turn for ${maxStallMs}ms (around "${stalledTest}"). ` +
        `vitest's worker->main "onTaskUpdate" RPC has a hard-coded 60,000ms deadline that no ` +
        `config can raise, and a reply cannot be READ while the loop is blocked — at 60,000ms the ` +
        `run fails with "[vitest-worker]: Timeout calling \\"onTaskUpdate\\"" and every test ` +
        `still reported as passed. Yield inside the offending test (await a real setImmediate), ` +
        `or split it. See src/test-support/yield-between-tests.ts.`
    );
  }
});
