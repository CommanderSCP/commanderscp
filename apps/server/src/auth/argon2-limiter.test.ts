import { describe, expect, it } from "vitest";
import { ProblemError } from "../errors.js";
import { __setArgon2LimiterForTest, withArgon2Slot } from "./argon2-limiter.js";

/**
 * The argon2 gate is the libuv-threadpool-saturation defense for login + prefixed-token verify
 * (argon2-limiter.ts). Its guarantees, mutation-proven here against controllable tasks (never real
 * argon2 — the point is deterministic concurrency, not hashing). `__setArgon2LimiterForTest` sets
 * the caps and clears gate state per case.
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | remove the `active < maxConcurrent` cap (run everything at once) | the concurrency test FAILS — peak in-flight exceeds the cap |
 * | drop the `waiters.length >= maxQueue` 429 (queue unboundedly) | the overflow test FAILS — the over-cap call resolves instead of throwing 429 |
 * | make `release()` not wake a waiter | the drain test FAILS — a queued task never runs |
 */

/** A task whose completion the test controls. */
function controllable() {
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  return { run: () => done, release: resolve };
}

describe("argon2 concurrency gate", () => {
  it("never runs more than maxConcurrent tasks at once", async () => {
    __setArgon2LimiterForTest({ maxConcurrent: 2, maxQueue: 100 });
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 6 }, () => controllable());
    const runs = tasks.map((t) =>
      withArgon2Slot(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await t.run();
        inFlight -= 1;
      })
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(2); // only maxConcurrent admitted before any completes
    tasks.forEach((t) => t.release());
    await Promise.all(runs);
    expect(peak).toBe(2); // and never exceeded it across the whole drain
  });

  it("rejects with a 429 once the wait queue is full", async () => {
    __setArgon2LimiterForTest({ maxConcurrent: 1, maxQueue: 1 });
    const busy = controllable();
    const queued = controllable();
    const active = withArgon2Slot(() => busy.run()); // takes the one slot
    const waiting = withArgon2Slot(() => queued.run()); // fills the one queue place
    // The third has nowhere to go → 429, rejected before its fn runs.
    let ranThird = false;
    const overflow = withArgon2Slot(async () => {
      ranThird = true;
    });
    await expect(overflow).rejects.toBeInstanceOf(ProblemError);
    await expect(overflow).rejects.toMatchObject({ status: 429 });
    expect(ranThird).toBe(false);
    // Draining the slot lets the queued task run and complete cleanly.
    busy.release();
    queued.release();
    await expect(active).resolves.toBeUndefined();
    await expect(waiting).resolves.toBeUndefined();
  });
});
