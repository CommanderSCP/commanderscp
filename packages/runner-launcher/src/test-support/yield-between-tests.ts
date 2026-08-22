import { afterAll, beforeEach } from "vitest";

/**
 * ================================================================================================
 * RETURN THE WORKER'S EVENT LOOP BETWEEN TESTS — OR THE RUN FAILS WITH EVERY TEST PASSING
 * ================================================================================================
 *
 * WHAT WENT WRONG. CI job 4 ("Unit tests", `pnpm test -- --coverage`) failed on
 * `@scp/runner-launcher#test` with:
 *
 *     Test Files  17 passed (17)
 *          Tests  429 passed (429)
 *         Errors  1 error
 *     Error: [vitest-worker]: Timeout calling "onTaskUpdate"
 *
 * Nothing was wrong with any assertion. vitest exits 1 on an unhandled error, so turbo failed the
 * task on a suite that had just reported 429 passes.
 *
 * THE MECHANISM, MEASURED RATHER THAN INFERRED. `onTaskUpdate` is the worker → main-thread RPC
 * that carries per-test results. It is a birpc CALL: the worker posts the request and awaits a
 * reply, and birpc arms a timer for `DEFAULT_TIMEOUT = 60_000`ms when the call is issued. That
 * constant is compiled into vitest's bundled copy of birpc; vitest passes no `timeout` option from
 * `getRpcOptions()`, so it is NOT reachable from any config file.
 *
 * The reply is not slow. The reply cannot be READ. `persisted-json-bound.test.ts` is 79 purely
 * SYNCHRONOUS sweeps (`for (let budget = 400; budget <= 3_900; budget++)` and friends). A run of
 * synchronous tests never lets the worker's event loop reach its poll phase — `await`ing a
 * non-promise only drains microtasks — so an `onTaskUpdate` issued near the start of the file has
 * its reply sitting unread in the IPC channel for the file's WHOLE duration. When the loop finally
 * turns, the timers phase runs before poll, so birpc's 60s timer fires first and throws.
 *
 * The trigger is therefore ONE NUMBER: the longest stretch in which the worker's loop does not
 * turn. On CI that file measured 62,948ms — 61,134ms of it in eight synchronous tests — against a
 * 60,000ms deadline. It is 4,301ms isolated on the author's machine and 11,628ms under the local
 * 71-task graph; what pushed it over was a 4-vCPU runner executing turbo's graph, ~14x.
 *
 * REPRODUCED, AND CONTROLLED, BEFORE ANY OF THIS WAS WRITTEN:
 *
 *   | condition                                                  | result                        |
 *   |------------------------------------------------------------|-------------------------------|
 *   | this suite, 110 CPU spinners (test time 91s)                | Timeout calling "onTaskUpdate" |
 *   | this suite, 80 CPU spinners, twice (test time 67.5s, 71.7s) | Timeout calling "onTaskUpdate" |
 *   | 3 synthetic sync tests x 21s = 63s, NO load, NO coverage    | Timeout calling "onTaskUpdate" |
 *   | 3 synthetic sync tests x 16s = 48s, NO load                 | clean                          |
 *   | 3 synthetic sync tests x 21s = 63s WITH a yield per test    | clean                          |
 *   | 6 synthetic sync tests x 21s = 126s WITH a yield per test   | clean                          |
 *
 * The last two rows are the whole argument. 126s of the same blocking is HARMLESS once the loop is
 * allowed to turn between tests, and 63s is fatal without it. This is not about duration, load,
 * payload size or the main thread — it is about starvation inside one worker.
 *
 * WHAT THIS FILE DOES, AND WHY IT IS NOT A PAPER-OVER. One macrotask tick before each test. That
 * removes the starvation itself; nothing is suppressed, no budget is weakened, no assertion or
 * real-timer deadline moves, and all 429 tests still run. It also converts the bound from
 * "the whole FILE must stay under 60s" — a number that grows every time a property is added, and
 * that is measured on a machine nobody controls — into "one TEST must stay under 60s", which
 * `testTimeout` (30,000ms here, gated by @scp/source-census's test-budget-census.test.ts) already
 * fails loudly and legibly.
 *
 * WHAT THE YIELD DOES NOT COVER, MEASURED IN THE FIELD RATHER THAN ASSUMED. A `beforeEach` runs
 * between TESTS, so the window it cannot reach is the one before the first test: module load and
 * collection. That window is real. Under a deliberately excessive local load — a 16-spinner CPU
 * flood on top of the whole turbo graph, several times what CI applies —
 * `no-spawn-on-kubernetes.behaviour.test.ts` spent 129,783ms in it and took the RPC deadline with
 * it. The tripwire below caught that one and named it (`around "<file setup>"`), which is exactly
 * the division of labour intended here: bound what can be bounded, REPORT what cannot, and leave
 * neither to a run whose only symptom is "429 passed, 1 error".
 *
 * WHY THE REAL `setImmediate` IS CAPTURED AT MODULE LOAD. `whole-run-budget.test.ts` calls
 * `vi.useFakeTimers()`, which replaces `globalThis.setImmediate`. A yield through a faked
 * `setImmediate` never resolves, which would hang the suite instead of unblocking it. Setup files
 * are evaluated once per test FILE before any test runs, so the binding taken here is always the
 * real one — the same trick vitest's own `withSafeTimers` uses for exactly this reason.
 */

/** Captured before any test body can install fake timers over `globalThis`. */
const realSetImmediate = globalThis.setImmediate;

/**
 * THE TRIPWIRE. Below vitest's 60,000ms worker-RPC deadline, above anything a healthy file can
 * reach: with the yield in place the longest possible stall is one test, and a test over 30,000ms
 * is already a `testTimeout` failure. So this can only fire if the yield stops working — if the
 * setup file is unwired, or a single test learns to block for three quarters of a minute — and
 * when it does it fires with the cause written on it, 15 seconds before the failure that says
 * nothing but "429 passed, 1 error".
 */
export const MAX_WORKER_STALL_MS = 45_000;

/**
 * `process.hrtime.bigint()`, NOT `Date.now()` — this suite MOVES THE WALL CLOCK.
 * `kubernetes-adapter.test.ts` runs `vi.useFakeTimers({ toFake: ["Date"] })` and then
 * `vi.setSystemTime(Date.now() + req.timeoutMs - shortfallMs)` to walk a run up to its deadline
 * without waiting for it. Those arms restore with `vi.useRealTimers()` in a `finally`, so a wall
 * clock read BETWEEN tests happens to be safe today — which is exactly the kind of "safe by where
 * the other file happens to put its cleanup" that this gate should not be built on. A test that
 * leaves a stepped clock installed (an early throw past the `finally`, a new arm written without
 * one) would make this tripwire fire on a suite that never stalled: a gate against a
 * load-dependent failure, itself producing a load-independent false alarm. `hrtime` is monotonic
 * and lives on `process`, which vitest's fake timers — they patch `globalThis` — do not touch.
 */
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
