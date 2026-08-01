import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE CANDIDATE-LOOP REGISTRY — a CI guard for one specific, expensive failure class.
 *
 * THE PROPERTY: *a batch-limited candidate query, ordered by a column the loop can fail to write,
 * whose body may re-serve a row without writing it.* Such a loop starves everything queued behind
 * the rows it keeps re-serving, silently and forever.
 *
 * IT HAS BEEN HIT FOUR TIMES IN THIS FILE'S SUBJECT AREA:
 *   1. `advanceWaitingChanges`   — found, fixed, and well commented ("STARVATION fix,
 *                                   coupled-pipelines.md §3.5 hazard"). Only that ONE instance.
 *   2. `advanceExecutingChanges` — the same property, untouched. In production it stopped
 *                                   coordination for 13 DAYS behind green health checks: 25
 *                                   gate-blocked changes pinned every batch slot and 231 changes
 *                                   were never evaluated once.
 *   3. `advanceValidatingChanges`— the same property, latent (7 rows against a limit of 25).
 *   4. `reconcileCampaignsOrgTick` — the same property, latent (0 campaigns), and found ONLY by
 *                                   censusing the property rather than chasing the symptom.
 *
 * A comment naming the hazard as a class did not stop instances 2-4 from existing. That is what
 * this test is for: it cannot prove a loop is correct, but it makes ADDING one a deliberate act
 * that fails CI until somebody writes down which side of the property it falls on.
 *
 * WHEN THIS TEST FAILS, DO NOT JUST ADD THE NAME. Answer the question first:
 *
 *   Can this loop re-serve the same row on the next tick WITHOUT having written the column its
 *   ORDER BY reads?
 *
 *   - NO  (it always transitions, or it parks the row out of the candidate set) -> add it to
 *          `SELF_EVICTING` with a one-line reason.
 *   - YES -> it needs a round-robin bump on the not-advanced path, like the four above, plus a
 *          regression test. Then add it to `BUMPED`.
 *
 * Deliberately a SOURCE-TEXT check, not a type- or runtime-level one: the property is about
 * control flow that no type expresses, and the failure mode is a loop nobody thought about. A
 * grep-shaped guard that catches "a new loop appeared" is worth more here than a precise analysis
 * that only runs on loops we already know about.
 */

const SOURCES = ["reconcile.ts", "campaign-reconcile.ts", "watchdog.ts", "observe.ts"] as const;

/**
 * Batch-fetch helpers that feed a per-tick candidate loop. A call to one of these inside the
 * coordination sweep is what makes a loop subject to the property above.
 */
const CANDIDATE_FETCHERS = ["listChangeRowsInStates", "listActiveCampaignObjectIds"] as const;

/**
 * Loops that CAN re-serve without writing, and therefore carry an explicit round-robin bump.
 *
 * `bumpIn` names the function the bump actually lives in, which is NOT always the function that
 * fetched the batch — `advanceExecutingChanges` delegates to `reconcileExecutingChange`, and the
 * gate-blocked path that needs the bump is in the callee. An earlier cut of this guard checked only
 * the fetching function's own body and reported the (present, working) executing bump as missing;
 * recording the location is what makes the check precise instead of merely loud.
 */
const BUMPED: Record<string, { bumpIn: string; why: string }> = {
  advanceWaitingChanges: {
    bumpIn: "advanceWaitingChanges",
    why: "a still-unsatisfied waiter writes nothing (coupled-pipelines.md §3.5)"
  },
  advanceExecutingChanges: {
    bumpIn: "reconcileExecutingChange",
    why: "a gate-blocked wave stays pending and writes nothing (the 13-day production outage)"
  },
  advanceValidatingChanges: {
    bumpIn: "advanceValidatingChanges",
    why: "the loop only prewarms governance and never writes the change row"
  },
  reconcileCampaignsOrgTick: {
    bumpIn: "reconcileCampaignsOrgTick",
    why: "nothing in reconcileOneCampaign writes the campaign's objects row"
  }
};

/** Loops that CANNOT re-serve without writing — each either always transitions the row on its
 *  success path, or parks it out of the candidate set. No bump needed, and adding one would be
 *  noise. Keep the reason specific enough to re-check. */
const SELF_EVICTING: Record<string, string> = {
  advanceProposedChanges: "always transitions proposed->evaluated (that edge is never gated)",
  advanceEvaluatedChanges: "always compiles a plan and transitions on its success path",
  advanceCoordinatedChanges:
    "a blocked gate PARKS the change (reconcile_blocked_at non-null), which listChangeRowsInStates filters out"
};

function readSource(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

/** Every `async function <name>(` in the given sources — the universe of candidate loop bodies. */
function functionNames(source: string): string[] {
  return [...source.matchAll(/async function (\w+)\s*\(/g)].map((m) => m[1]!);
}

/**
 * The text of one `async function`, from its declaration to the start of the next one.
 *
 * The boundary pattern MUST accept the `export ` prefix. Without it, an unexported function
 * declared above an exported one swallowed the exported one's entire body — which made
 * `reconcileOneCampaign` look like it fetched a candidate batch (it does not; its caller does) and
 * produced a false positive that read exactly like a real finding. A guard that cries wolf gets
 * silenced, so this is worth the precision.
 */
function bodyOf(source: string, fnName: string): string | null {
  const start = source.search(new RegExp(`(?:export )?async function ${fnName}\\(`));
  if (start === -1) return null;
  const rest = source.slice(start + 1);
  const nextIdx = rest.search(/\n(?:export )?async function \w+\s*\(/);
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

describe("candidate-loop registry: every batch-limited reconcile loop is classified", () => {
  const sources = new Map<string, string>();
  for (const name of SOURCES) {
    try {
      sources.set(name, readSource(name));
    } catch {
      // A source listed here that no longer exists is itself worth failing on — asserted below
      // rather than silently skipped, so a rename can't quietly shrink this guard's coverage.
      sources.set(name, "");
    }
  }

  it("every source this guard claims to cover actually exists", () => {
    for (const [name, text] of sources) {
      expect(text, `${name} is listed in SOURCES but could not be read — did it move?`).not.toBe(
        ""
      );
    }
  });

  it("every function that fetches a candidate batch is classified as BUMPED or SELF_EVICTING", () => {
    const classified = new Set([...Object.keys(BUMPED), ...Object.keys(SELF_EVICTING)]);
    const unclassified: string[] = [];

    for (const [file, text] of sources) {
      if (!text) continue;
      const names = functionNames(text);
      for (const fnName of names) {
        const body = bodyOf(text, fnName) ?? "";
        const fetchesCandidates = CANDIDATE_FETCHERS.some((f) => body.includes(`${f}(`));
        if (!fetchesCandidates) continue;
        if (!classified.has(fnName)) unclassified.push(`${file}:${fnName}`);
      }
    }

    expect(
      unclassified,
      "A new batch-limited candidate loop appeared and is not classified. Read this file's header " +
        "BEFORE adding it: decide whether it can re-serve a row without writing the column its " +
        "ORDER BY reads. If it can, it needs a round-robin bump and a regression test (see " +
        "executing-batch-starvation.integration.test.ts), then add it to BUMPED. If it cannot, add " +
        "it to SELF_EVICTING with the reason."
    ).toEqual([]);
  });

  it("every loop registered as BUMPED still contains a bump", () => {
    // Guards the other direction: a refactor that deletes a bump must not leave the registry
    // asserting a protection that is no longer there. Looks for the write, not for a comment.
    const missing: string[] = [];
    for (const [fnName, { bumpIn }] of Object.entries(BUMPED)) {
      let found = false;
      for (const text of sources.values()) {
        if (!text) continue;
        const body = bodyOf(text, bumpIn);
        if (body && /\.set\(\{\s*updatedAt: new Date\(\)/.test(body)) found = true;
      }
      if (!found) missing.push(`${fnName} (bump expected in ${bumpIn})`);
    }
    expect(
      missing,
      "A loop registered as BUMPED no longer contains an `updatedAt` round-robin bump. Either the " +
        "bump was removed (restore it — see this file's header for what it costs) or the loop was " +
        "restructured so it can no longer re-serve without writing (then move it to SELF_EVICTING)."
    ).toEqual([]);
  });

  it("the registry has no stale entries", () => {
    const allNames = new Set<string>();
    for (const text of sources.values()) {
      if (!text) continue;
      for (const n of functionNames(text)) allNames.add(n);
    }
    const stale = [
      ...Object.keys(BUMPED),
      ...Object.values(BUMPED).map((b) => b.bumpIn),
      ...Object.keys(SELF_EVICTING)
    ].filter((n) => !allNames.has(n));
    expect(
      stale,
      "The registry names functions that no longer exist — a rename that silently dropped this " +
        "guard's coverage. Update the entry to the new name."
    ).toEqual([]);
  });
});
