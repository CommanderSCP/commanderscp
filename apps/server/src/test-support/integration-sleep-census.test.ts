import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchingParen, readStripped } from "@scp/source-census";

/**
 * ================================================================================================
 * THE FIXED-SLEEP REGISTRY — a CI guard for the flake class that cost three sessions a day
 * ================================================================================================
 *
 * THE PROPERTY: *a fixed wall-clock sleep standing in for "the asynchronous engine has had its
 * chance", followed by an assertion about what did or did not happen in that window.*
 *
 * Such a test is not merely slow. It is wrong in BOTH directions at once, and which direction it
 * lands in depends on how busy the machine is:
 *
 *   - Under contention it FAILS SPURIOUSLY, because the thing it waited for had not happened yet.
 *     The worst shape is a sleep that is silently also the wait for ARRIVAL: `assertStaysExecuting`
 *     slept 3-4s and then asserted `state === "executing"`, so a change still walking
 *     `proposed -> evaluated -> coordinated` reported the same failure as one that had escaped the
 *     gate. Measured on 2026-08-17: four independent sessions chasing phantom regressions in
 *     governance.integration.test.ts, a different test failing each run and every one of them
 *     passing in isolation.
 *   - On an idle machine it PASSES VACUOUSLY, because "several ticks" was never several ticks. The
 *     arithmetic those comments relied on is simply not true here: `RECONCILE_TICK_INTERVAL_SECONDS`
 *     is 1, but the tick re-schedules itself with `startAfter: 1` onto pg-boss, whose polling
 *     interval defaults to 2000ms and is not overridden anywhere in this repo, and each tick then
 *     walks EVERY org in the database (`runReconcileSweep`). Measured: a 2025ms median tick with ONE
 *     org, 2821ms (max 5972ms) with 21, and `propose -> executing` going from 1391ms to **10903ms**
 *     over the same range — against a 4000ms grace. A 3s "several ticks" grace is at most one tick,
 *     and often zero. `RECONCILE_TICK_BUDGET_MS` in `harness.ts` carries the full table.
 *
 * THE REMEDY IS A POSITIVE SIGNAL, not a longer sleep — `harness.ts`'s `assertStaysExecuting` and
 * `waitForChangeParked` are the worked examples. Both watch something the engine WRITES when it
 * does the thing the test is asserting about (`reconcile_cursor_at` for "the gate refused again",
 * `reconcile_blocked_at` for "the failed wave has been parked and will never be served again"), so
 * they are exactly as slow as the engine actually is and cannot be made vacuous by a fast box or
 * flaky by a slow one.
 *
 * WHAT THIS GUARD CAN AND CANNOT DO. It is a source census — `@scp/source-census`'s doc comment
 * lists the six things one still cannot prove, all of which apply here. It cannot tell a
 * legitimate sleep from an illegitimate one; that is what the registry below is for. What it buys
 * is that ADDING one becomes a deliberate act that fails CI until somebody writes down which side
 * of the property it falls on.
 *
 * THE MATCH IS DELIBERATELY WIDER THAN "A BIG NUMBER". The first census written for this bug
 * grepped `setTimeout\(\w+, [0-9_]{4,}` and reported the governance file clean — while the second
 * copy of the very helper under repair sat in `scoped-scan-requirements.integration.test.ts`
 * spelled `setTimeout(resolve, graceMs)`. A named constant is not a smaller hazard than a literal;
 * it is the same hazard with the number moved. So: every `setTimeout` in an integration test counts
 * EXCEPT one whose delay is a literal under 1000ms (a yield or a debounce nudge, not a stand-in for
 * engine progress).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, "..");

/**
 * Every surviving fixed sleep in an integration test, with the count expected in that file and why
 * it is there. Counts are EXACT in both directions: a file that grows one fails, and a file that
 * loses its last one fails too, so a stale entry cannot sit here pretending to authorise something
 * that no longer exists.
 */
const REGISTRY: Record<string, { count: number; why: string }> = {
  "coordination/boundary-segment.integration.test.ts": {
    count: 1,
    why:
      "NOT an instance. The sleep is INSIDE an open transaction and its purpose is to HOLD that " +
      "transaction open while a second one races it — it constructs the concurrency window rather " +
      "than waiting for a loop to notice something. There is no engine progress to observe, and a " +
      "longer machine pause only widens the window the test wants."
  },
  "coordination/coupling.integration.test.ts": {
    count: 0,
    why:
      "Converted to `assertStaysWaiting`: `advanceWaitingChanges` bumps " +
      "`reconcile_cursor_at` on every tick it leaves a waiter unsatisfied (BUMP 1 OF 5), so 'it " +
      "stayed parked' is now an observed refusal instead of three seconds of hope."
  },
  "governance/governance.integration.test.ts": {
    count: 0,
    why: "Converted to `assertStaysExecuting` / `waitForChangeParked` (harness.ts)."
  },
  "governance/scoped-scan-requirements.integration.test.ts": {
    count: 0,
    why: "Second copy of the same helper; converted to the shared `assertStaysExecuting`."
  },
  "dependencies/internal-release-detection.integration.test.ts": {
    count: 2,
    why:
      "KNOWN INSTANCES, not yet converted — the risk direction here is VACUITY rather than " +
      "flakiness (both sleeps precede a negative assertion about a pg-boss delivery that must NOT " +
      "have been routed), so a slow box makes them weaker rather than red. The positive signal " +
      "they want is the delivery job reaching a terminal state, not a duration."
  },
  "federation/federation-sync-loop.integration.test.ts": {
    count: 1,
    why:
      "KNOWN INSTANCE, not yet converted: sleeps 1s and then asserts `pendingJobs() === 1`. Both " +
      "directions are live here — a duplicate tick scheduled after the window is missed, and a " +
      "tick CLAIMED during the window makes the count 0 and reds the test."
  },
  "events/outbox-relay.integration.test.ts": {
    count: 1,
    why:
      "KNOWN INSTANCE, not yet converted, and the mildest of them: the sleep is followed by a " +
      "POSITIVE assertion (`>1 publish attempt for the probe row`), so it cannot pass vacuously — " +
      "it can only fail spuriously when 2.5s buys fewer than two retry cycles. `waitUntil` on the " +
      "attempt count is the drop-in."
  }
};

function integrationTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...integrationTestFiles(full));
    } else if (entry.name.endsWith(".integration.test.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every `setTimeout(callback, delay)` in `source` whose delay is NOT a literal under 1000ms.
 *
 * The argument list is walked with {@link matchingParen} rather than matched by a regex, for the
 * same reason `exportedDeclarations` does it: `[^)]*` cannot cross a callback that has its own
 * parentheses, so `setTimeout(() => resume(), 5_000)` is invisible to the obvious pattern. A census
 * whose filter cannot see a form is a census that certifies that form clean.
 */
function fixedSleeps(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/setTimeout\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = matchingParen(source, open);
    if (close === -1) continue;
    const args = source.slice(open + 1, close);
    // The delay is everything after the LAST top-level comma.
    let depth = 0;
    let lastComma = -1;
    for (let i = 0; i < args.length; i++) {
      const ch = args[i];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") depth--;
      else if (ch === "," && depth === 0) lastComma = i;
    }
    const delay = (lastComma === -1 ? "" : args.slice(lastComma + 1)).trim();
    const literal = Number(delay.replace(/_/g, ""));
    if (Number.isFinite(literal) && literal < 1000) continue;
    out.push(`setTimeout(…, ${delay || "<no delay argument>"})`);
  }
  return out;
}

describe("integration tests do not stand a fixed sleep in for engine progress", () => {
  const files = integrationTestFiles(SERVER_SRC);

  it("finds integration tests to census at all (the census is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("every fixed sleep in an integration test is in the registry, with the registered count", () => {
    const found: Record<string, number> = {};
    for (const file of files) {
      const sleeps = fixedSleeps(readStripped(file));
      if (sleeps.length > 0) {
        found[relative(SERVER_SRC, file)] = sleeps.length;
      }
    }
    const expected = Object.fromEntries(
      Object.entries(REGISTRY)
        .filter(([, entry]) => entry.count > 0)
        .map(([file, entry]) => [file, entry.count])
    );
    expect(
      found,
      "a fixed sleep appeared in (or vanished from) an integration test without a registry entry — " +
        "read this file's header, then either convert it to a positive signal or register it with " +
        "the reason it is not an instance of the property"
    ).toEqual(expected);
  });

  it("the registry has no stale zero entries — a converted file must actually be clean", () => {
    for (const [file, entry] of Object.entries(REGISTRY)) {
      if (entry.count !== 0) continue;
      const full = join(SERVER_SRC, file);
      expect(fixedSleeps(readStripped(full)), `${file} is registered as converted`).toEqual([]);
    }
  });
});
