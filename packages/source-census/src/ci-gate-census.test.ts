import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * ================================================================================================
 * THE GATE-REACHABILITY CENSUS — EVERY CI JOB EITHER BLOCKS MERGE OR IS NON-GATING BY NAME
 * ================================================================================================
 *
 * WHAT WENT WRONG, TWICE, AND WHAT ALMOST WENT WRONG A THIRD TIME. `main` branch protection
 * requires exactly two checks: "5z. Integration (aggregation gate)" and "3. Codegen drift". Every
 * other job blocks merge ONLY by being reachable from 5z's `needs:` closure — 5z treats any
 * non-success (skips included) as a failure, so a job in the closure that reds or is skipped reds
 * 5z. That reachability was HAND-MAINTAINED and it has already failed silently: job 4b
 * (helm-verify) sat reachable from nothing for weeks while its own comment claimed it gated
 * (ci.yml's CORRECTION note), and the 2026-08-31 needs-graph restructure moved
 * static-checks/unit-tests from transitive coverage (via the shard matrix) to hand-listed entries
 * in 5z's `needs:` — where forgetting one would have dropped it from branch protection with every
 * check still showing green in the PR list. ci.yml's comment on that list says "REMOVE A NAME
 * FROM THIS LIST AND IT LEAVES BRANCH PROTECTION"; this census is that sentence made machinery.
 *
 * THE RULE, BOTH DIRECTIONS. Every job in ci.yml must be reachable from 5z (in its `needs:`
 * closure, walked upward — a needed job's own needs also gate, because their failure skips it and
 * a skip is a failure at 5z), OR be named in NON_GATING with its documented reason. An allowlist
 * entry that becomes reachable, or names a job that no longer exists, is stale and fails. And
 * every job 5z `needs:` must ALSO appear in its result-check loop — `if: always()` means 5z runs
 * regardless, so a needs entry the loop never reads is a job whose failure 5z silently ignores.
 *
 * THE LIMIT, STATED PLAINLY (this package's rule): this census reads the WORKFLOW, not GitHub's
 * settings. It cannot see branch protection itself — if the required-check names change on the
 * GitHub side, or protection is disabled, nothing here reds. The two required names are asserted
 * against the jobs' `name:` fields below so a rename in ci.yml (which would orphan the protection
 * rule) is at least caught on this side.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

/** The one job that is deliberately NOT merge-gating, with the reason ci.yml documents at length. */
const NON_GATING: Record<string, string> = {
  "api-breaking-change":
    "policy gate a human may override via the api-v2-exception label; wiring it into any needs: " +
    "chain once cancelled test execution on an approved break (ci.yml job 3b's own comment, PR #35)"
};

/** The aggregation gate and the other directly-required check (branch protection, 2026-07-24). */
const AGGREGATION_JOB = "integration";
const REQUIRED_CHECK_NAMES: Record<string, string> = {
  [AGGREGATION_JOB]: "5z. Integration (aggregation gate)",
  "codegen-drift": "3. Codegen drift"
};

interface Job {
  name?: string;
  needs?: string | string[];
  steps?: { run?: string }[];
}

const WORKFLOW = parse(readFileSync(resolve(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as {
  jobs: Record<string, Job>;
};
const JOBS = WORKFLOW.jobs;

const needsOf = (id: string): string[] => {
  const needs = JOBS[id]?.needs;
  return needs === undefined ? [] : Array.isArray(needs) ? needs : [needs];
};

/** Upward closure from 5z: everything it needs, and everything those need, transitively. */
function gatedClosure(): Set<string> {
  const gated = new Set<string>();
  const queue = [...needsOf(AGGREGATION_JOB)];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (gated.has(id)) continue;
    gated.add(id);
    queue.push(...needsOf(id));
  }
  return gated;
}

describe("every CI job blocks merge through 5z, or is non-gating by documented name", () => {
  const gated = gatedClosure();

  it("the census actually parsed the workflow (it is not an empty graph)", () => {
    // Non-vacuity: the closure must be substantial and contain the jobs this census was written
    // to protect — the three the 2026-08-31 restructure moved into 5z's hands directly.
    expect(Object.keys(JOBS).length).toBeGreaterThan(15);
    expect(gated.size).toBeGreaterThan(10);
    for (const known of [
      "integration-shard",
      "static-checks",
      "unit-tests",
      "codegen-drift",
      "e2e-web",
      "build"
    ]) {
      expect(
        gated,
        `${known} fell out of 5z's needs closure — it no longer blocks merge`
      ).toContain(known);
    }
  });

  it("EVERY job is gated or allowlisted — an unreachable job is 4b's old defect reborn", () => {
    const unreachable = Object.keys(JOBS).filter(
      (id) => id !== AGGREGATION_JOB && !gated.has(id) && NON_GATING[id] === undefined
    );
    expect(
      unreachable,
      "these jobs are reachable from nothing: red or skipped, they cannot block a merge, and " +
        "every check in the PR list still shows green. Add each to 5z's needs: AND its result " +
        "loop, or name it in NON_GATING with the reason"
    ).toStrictEqual([]);
  });

  it("the NON_GATING allowlist is not stale, in either direction", () => {
    const stale = Object.keys(NON_GATING).filter((id) => JOBS[id] === undefined);
    expect(stale, "allowlisted jobs that no longer exist").toStrictEqual([]);
    const nowGated = Object.keys(NON_GATING).filter((id) => gated.has(id));
    expect(
      nowGated,
      "allowlisted as non-gating but now reachable from 5z — delete the entry (and its reason " +
        "no longer holds: a needs: edge on this job can cancel test execution, see ci.yml 3b)"
    ).toStrictEqual([]);
  });

  it("every job 5z needs: is also read by its result loop — if: always() ignores needs results", () => {
    const runs = (JOBS[AGGREGATION_JOB]?.steps ?? []).map((s) => s.run ?? "").join("\n");
    const unread = needsOf(AGGREGATION_JOB).filter((id) => !runs.includes(`needs.${id}.result`));
    expect(
      unread,
      "in 5z's needs: but never checked by its loop — 5z runs regardless (if: always()) and " +
        "silently ignores this job's failure"
    ).toStrictEqual([]);
  });

  it("the two branch-protection-required check names still exist verbatim", () => {
    for (const [id, requiredName] of Object.entries(REQUIRED_CHECK_NAMES)) {
      expect(
        JOBS[id]?.name,
        `branch protection requires the check "${requiredName}" by NAME; renaming job "${id}" ` +
          "orphans the protection rule (merges block forever on a check that never reports, or " +
          "the rule gets deleted in frustration). Change protection and this census together."
      ).toBe(requiredName);
    }
  });
});
