import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { matchingParen, readStripped } from "@scp/source-census";

/** THE FIXED-SLEEP REGISTRY. See docs/test-support.md §32. */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(HERE, "..");

/** Every surviving fixed sleep, with an exact expected count. See docs/test-support.md §33. */
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

/** Every `setTimeout` delay that is not a small literal. See docs/test-support.md §34. */
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

  it("every registry entry says WHY — the reason is the point, the count is bookkeeping", () => {
    // Without this, the cheapest way past the guard above is `{ count: n, why: "" }`, which
    // authorises an instance while recording nothing about which side of the property it is on.
    for (const [file, entry] of Object.entries(REGISTRY)) {
      expect(entry.why.length, `${file} needs a reason, not just a count`).toBeGreaterThan(60);
    }
  });
});
