import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readStripped } from "@scp/source-census";

/** THE CANDIDATE-LOOP REGISTRY. See docs/coordination.md §243. */

const SOURCES = ["reconcile.ts", "campaign-reconcile.ts", "watchdog.ts", "observe.ts"] as const;

/** The two files holding the candidate queries, read apart. See docs/coordination.md §244. */
const QUERY_SOURCES = ["changes-repo.ts", "campaign-repo.ts"] as const;

/**
 * Batch-fetch helpers that feed a per-tick candidate loop. A call to one of these inside the
 * coordination sweep is what makes a loop subject to the property above.
 */
const CANDIDATE_FETCHERS = ["listChangeRowsInStates", "listActiveCampaignObjectIds"] as const;

/** Loops that can re-serve without writing carry a bump. See docs/coordination.md §245. */
const BUMPED: Record<
  string,
  { bumpIn: string[]; count: number; queryIn: (typeof CANDIDATE_FETCHERS)[number]; why: string }
> = {
  advanceWaitingChanges: {
    bumpIn: ["advanceWaitingChanges"],
    count: 1,
    queryIn: "listChangeRowsInStates",
    // The bump covers the still-waiting path ONLY. The S10 foreign-origin skip in the same loop is
    // a different not-advanced path with a different remedy — filtered out of the candidate query,
    // never bumped, because bumping writes a read-only replica's row.
    why: "a still-unsatisfied waiter writes nothing (coupled-pipelines.md §3.5)"
  },
  advanceExecutingChanges: {
    // Three bumps across two functions, enumerated on purpose. See docs/coordination.md §246.
    bumpIn: [
      "reconcileExecutingChange",
      "recordStageDependencyHold",
      "recordFreezeAdmissionHold",
      "recordContinuousHold"
    ],
    count: 5,
    queryIn: "listChangeRowsInStates",
    why:
      "a gate-blocked wave stays pending and writes nothing (the 13-day production outage); a " +
      "wave whose targets are merely POLLED writes only change_wave_targets, never the change row; " +
      "a stage-dependency hold (ADR-0028) withholds its targets and writes only a Decision; and " +
      "M25.2's FREEZE hold does the same for a target an active freeze covers — a change whose " +
      "targets are all frozen stays `executing` with its wave `running`, so nothing else moves its " +
      "cursor for the whole freeze window, which can be weeks; and increment 8's CONTINUOUS-TEST " +
      "hold does the same for a target whose declared probe has gone stale, which is a condition " +
      "that lasts as long as the prober stays dead " +
      "(its FIFTH not-advanced path, the S10 foreign-origin skip, is filtered out of the candidate " +
      "query instead — a bump there would write a read-only replica's row)"
  },
  advanceValidatingChanges: {
    bumpIn: ["advanceValidatingChanges"],
    count: 1,
    queryIn: "listChangeRowsInStates",
    // THE SIXTH `listChangeRowsInStates` CALL SITE, and the one with no origin guard in its body at
    // all — so the bump below used to fire on a foreign-origin row, writing a replica. The query
    // filter is what stops that; the bump remains for the ordinary local case.
    why: "the loop only prewarms governance and never writes the change row"
  },
  reconcileCampaignsOrgTick: {
    bumpIn: ["reconcileCampaignsOrgTick"],
    count: 1,
    // The campaign side did not move, recorded as a checked fact. See docs/coordination.md §247.
    queryIn: "listActiveCampaignObjectIds",
    // The bump sits BELOW this loop's S10 guard, deliberately. See docs/coordination.md §248.
    why:
      "nothing in reconcileOneCampaign writes the campaign's objects row (its second not-advanced " +
      "path, the S10 foreign-origin skip, is filtered out of the candidate query instead — a bump " +
      "there would write a read-only replica's row)"
  }
};

/** Loops that CANNOT re-serve without writing. See docs/coordination.md §249. */
const SELF_EVICTING: Record<string, string> = {
  advanceProposedChanges:
    "always transitions proposed->evaluated (that edge is never gated); the S10 foreign-origin skip " +
    "cannot re-serve because listChangeRowsInStates filters those rows out on origin_domain_id",
  advanceEvaluatedChanges:
    "always compiles a plan and transitions on its success path; S10 foreign-origin rows are " +
    "filtered out of the candidate query, not skipped in the body",
  advanceCoordinatedChanges:
    "a blocked gate PARKS the change (reconcile_blocked_at non-null), which listChangeRowsInStates " +
    "filters out; the same query also filters out S10 foreign-origin rows"
};

/** Comments stripped, and this guard needed it both ways. See docs/coordination.md §250. */
function readSource(name: string): string {
  return readStripped(fileURLToPath(new URL(name, import.meta.url)));
}

/** Every `async function <name>(` in the given sources — the universe of candidate loop bodies. */
function functionNames(source: string): string[] {
  return [...source.matchAll(/async function (\w+)\s*\(/g)].map((m) => m[1]!);
}

/** The text of one function, to the start of the next. See docs/coordination.md §251. */
function bodyOf(source: string, fnName: string): string | null {
  const start = source.search(new RegExp(`(?:export )?async function ${fnName}\\(`));
  if (start === -1) return null;
  const rest = source.slice(start + 1);
  const nextIdx = rest.search(/\n(?:export )?async function \w+\s*\(/);
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

/** The columns a function's round-robin bumps WRITE. See docs/coordination.md §252. */
function bumpColumnsIn(body: string): string[] {
  return [...body.matchAll(/\.set\(\{\s*(\w+): new Date\(\)\s*\}\)/g)].map((m) => m[1]!);
}

/** The column a candidate fetcher's `ORDER BY` actually reads, parsed from its own body. Scoped to
 *  the function so an unrelated ordered query elsewhere in the same repo file cannot answer for it. */
function orderByColumnOf(fetcher: string): string | null {
  for (const name of QUERY_SOURCES) {
    let text: string;
    try {
      text = readSource(name);
    } catch {
      continue;
    }
    const body = bodyOf(text, fetcher);
    if (!body) continue;
    const m = body.match(/\.orderBy\(asc\(\w+\.(\w+)\)\)/);
    if (m) return m[1]!;
  }
  return null;
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

  it("every loop registered as BUMPED still contains EXACTLY the bumps it claims", () => {
    // Guards the other direction. See docs/coordination.md §253.
    const wrong: string[] = [];
    for (const [fnName, { bumpIn, count }] of Object.entries(BUMPED)) {
      let found = 0;
      for (const fn of bumpIn) {
        for (const text of sources.values()) {
          if (!text) continue;
          const body = bodyOf(text, fn);
          if (body) found += bumpColumnsIn(body).length;
        }
      }
      if (found !== count) {
        wrong.push(`${fnName}: expected ${count} bump(s) in ${bumpIn.join(" + ")}, found ${found}`);
      }
    }
    expect(
      wrong,
      "A loop registered as BUMPED no longer holds the round-robin bumps it claims. Either a bump " +
        "was removed (restore it — see this file's header for what it costs), or one was added " +
        "without updating `count`, or the loop was restructured so it can no longer re-serve " +
        "without writing (then move it to SELF_EVICTING)."
    ).toEqual([]);
  });

  it("THE CURSOR AGREES WITH ITSELF: every bump writes the column its own candidate query orders by", () => {
    // The invariant no count can express. See docs/coordination.md §254.
    const mismatches: string[] = [];
    for (const [fnName, { bumpIn, queryIn }] of Object.entries(BUMPED)) {
      const ordered = orderByColumnOf(queryIn);
      expect(
        ordered,
        `Could not find the ORDER BY column of ${queryIn} — the guard cannot check what it cannot read.`
      ).not.toBeNull();
      for (const fn of bumpIn) {
        for (const text of sources.values()) {
          if (!text) continue;
          const body = bodyOf(text, fn);
          if (!body) continue;
          for (const col of bumpColumnsIn(body)) {
            if (col !== ordered) {
              mismatches.push(
                `${fnName}/${fn} bumps \`${col}\` but ${queryIn} orders by \`${ordered}\``
              );
            }
          }
        }
      }
    }
    expect(
      mismatches,
      "A round-robin bump writes a different column from the one its candidate query orders by. " +
        "The bump therefore does nothing for scheduling: the loop re-serves the same rows forever " +
        "and starves everything behind them. Move the bump onto the ORDER BY column."
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
      ...Object.values(BUMPED).flatMap((b) => b.bumpIn),
      ...Object.keys(SELF_EVICTING)
    ].filter((n) => !allNames.has(n));
    expect(
      stale,
      "The registry names functions that no longer exist — a rename that silently dropped this " +
        "guard's coverage. Update the entry to the new name."
    ).toEqual([]);
  });
});
