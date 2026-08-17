import { describe, expect, it } from "vitest";
import type { ScanExclusionClause, ScanRequirementTier } from "@scp/schemas";
import {
  resolveEffectiveScanExclusions,
  type ScanExclusionTargetInput
} from "./scan-requirements.js";

/**
 * M22.2 (ADR-0033 §1, §3) — THE MONOTONE AND, as a pure function.
 *
 * The resolver's DB half is proven end-to-end at the real gate in
 * `scan-exclusions.integration.test.ts`; this file pins the ALGEBRA, which is where the security
 * property lives and where a plausible-looking edit does the damage. Every case below is a
 * behaviour a reasonable implementer might have written the other way round.
 *
 * MUTATIONS RUN (2026-08-17), each reverted by an exact inverse edit. Baseline: 9 passed. These are
 * MEASURED results — one of them survived, and that is recorded rather than quietly dropped.
 *
 *   R-1  flip the AND to an OR (admit when ANY represented tier above admits)
 *          -> 1 failed: "ADMITTED AT COMPONENT BUT NOT AT ORG".
 *   R-2  UNION the per-target clause sets instead of intersecting them
 *          -> 1 failed: "EXCLUSIONS NEVER UNION ACROSS TARGETS".
 *   R-3  ask EVERY tier above, whether or not it is represented on this target's chain
 *          -> 2 failed: "ADMITTED AT COMPONENT BUT NOT AT ORG" and "a tier that is NOT
 *             REPRESENTED". The first is the one worth noting: over-asking is not merely
 *             restrictive, it changes which admissions are recorded in `admittedBy`.
 *   R-4  drop the `targets.length === 0` guard
 *          -> SURVIVED (9 passed). Recorded because a surviving mutation is information: the guard
 *             is a SECOND barrier, not the only one — with no targets the loop never runs, so
 *             `surviving` stays `undefined` and the `!surviving` check below returns `undefined`
 *             anyway. Both are kept: the guard states the intent at the top of the function, where
 *             a reader looking for "what does an empty family mean here" will look.
 *   R-5  stop sorting the resolved clause array
 *          -> 1 failed: "the resolved clause array is ORDER-INDEPENDENT and content-sorted".
 */

const CLAUSE: ScanExclusionClause = { class: "no_fix_available", pkgName: "openssl" };

/** The ordinary chain: platform -> trust domain -> org -> containment domain -> service ->
 *  component. No assembly, which is the common shape. */
const CHAIN: ScanRequirementTier[] = [
  "platform",
  "trust_domain",
  "org",
  "containment_domain",
  "service",
  "component"
];

function target(
  id: string,
  opts: {
    admitAt?: ScanRequirementTier[];
    clauseAt?: ScanRequirementTier;
    clause?: ScanExclusionClause;
    represented?: ScanRequirementTier[];
  }
): ScanExclusionTargetInput {
  return {
    targetObjectId: id,
    representedTiers: opts.represented ?? CHAIN,
    admissions: (opts.admitAt ?? []).map((tier) => ({
      tier,
      class: (opts.clause ?? CLAUSE).class,
      source: `admit:${tier}`
    })),
    clauses: opts.clauseAt
      ? [{ tier: opts.clauseAt, source: "policy:secops@p1", clause: opts.clause ?? CLAUSE }]
      : []
  };
}

describe("M22.2: resolveEffectiveScanExclusions — the monotone AND", () => {
  it("NOTHING AUTHORED resolves to nothing at all", () => {
    expect(resolveEffectiveScanExclusions([target("a", {})])).toBeUndefined();
  });

  it("a clause with NO admission anywhere has no effect", () => {
    // The shipped default: `scan_exclusion_admissions` is created empty and never seeded, so this
    // is the state of every existing deployment the moment migration 0066 runs.
    expect(
      resolveEffectiveScanExclusions([target("a", { clauseAt: "component" })])
    ).toBeUndefined();
  });

  it("ADMITTED AT COMPONENT BUT NOT AT ORG has NO effect — the AND is top-down, not any-of", () => {
    const missingOrg = resolveEffectiveScanExclusions([
      target("a", {
        clauseAt: "component",
        admitAt: ["platform", "trust_domain", "containment_domain", "service", "component"]
      })
    ]);
    expect(missingOrg).toBeUndefined();

    // NEGATIVE CONTROL: the same clause with EVERY represented tier above it admitting does apply.
    const full = resolveEffectiveScanExclusions([
      target("a", {
        clauseAt: "component",
        admitAt: ["platform", "trust_domain", "org", "containment_domain", "service"]
      })
    ]);
    expect(full?.clauses).toHaveLength(1);
    expect(full?.clauses[0]?.admittedBy.map((a) => a.tier)).toEqual([
      "platform",
      "trust_domain",
      "org",
      "containment_domain",
      "service"
    ]);
  });

  it("a tier BELOW the clause is not asked, and the clause's OWN tier does not admit itself", () => {
    // A clause at `org` needs `platform` and `trust_domain` only. Requiring the clause's own tier to
    // re-admit would make every authoring act need two documents; requiring tiers BELOW it would be
    // incoherent (a component cannot authorise its service's rule).
    const resolved = resolveEffectiveScanExclusions([
      target("a", { clauseAt: "org", admitAt: ["platform", "trust_domain"] })
    ]);
    expect(resolved?.clauses).toHaveLength(1);
  });

  it("a tier that is NOT REPRESENTED on this target's chain is not asked", () => {
    // An org with no containment domain and no assembly must still be able to admit a component
    // clause — there is nobody to speak for a rung that does not exist. The instance rungs are
    // ALWAYS represented, so this is not a hole: it never lets a real rung stay silent.
    const resolved = resolveEffectiveScanExclusions([
      target("a", {
        represented: ["platform", "trust_domain", "org", "component"],
        clauseAt: "component",
        admitAt: ["platform", "trust_domain", "org"]
      })
    ]);
    expect(resolved?.clauses).toHaveLength(1);
    expect(resolved?.clauses[0]?.admittedBy.map((a) => a.tier)).toEqual([
      "platform",
      "trust_domain",
      "org"
    ]);
  });

  it("EXCLUSIONS NEVER UNION ACROSS TARGETS — a clause admitted for A does not reach sibling B", () => {
    // For a CEILING a union is safe (more contributors can only tighten). For an EXCLUSION it is an
    // inversion: it would widen a loosening past the reach of the blocking it loosens, since a
    // failing scan verdict stops only the component it is about.
    const resolved = resolveEffectiveScanExclusions([
      target("a", { clauseAt: "org", admitAt: ["platform", "trust_domain"] }),
      target("b", { clauseAt: "org" }) // B's chain admits nothing
    ]);
    expect(resolved).toBeUndefined();

    // NEGATIVE CONTROL: when BOTH targets independently admit it, the clause applies.
    const both = resolveEffectiveScanExclusions([
      target("a", { clauseAt: "org", admitAt: ["platform", "trust_domain"] }),
      target("b", { clauseAt: "org", admitAt: ["platform", "trust_domain"] })
    ]);
    expect(both?.clauses).toHaveLength(1);
  });

  it("NO TARGETS resolves to nothing — an empty family is never 'everything'", () => {
    expect(resolveEffectiveScanExclusions([])).toBeUndefined();
  });

  it("the resolved clause array is ORDER-INDEPENDENT and content-sorted", () => {
    // `restatesDecision` preserves ARRAY order, so an unsorted array here would defeat
    // `insertDecisionIfChanged` and re-open the measured 1.44 GB/day Decision write amplification.
    const clauseA: ScanExclusionClause = { class: "no_fix_available", pkgName: "aaa" };
    const clauseB: ScanExclusionClause = { class: "no_fix_available", pkgName: "zzz" };
    const build = (order: ScanExclusionClause[]) =>
      resolveEffectiveScanExclusions([
        {
          targetObjectId: "a",
          representedTiers: CHAIN,
          admissions: [
            { tier: "platform", class: "no_fix_available", source: "admit:platform" },
            { tier: "trust_domain", class: "no_fix_available", source: "admit:trust_domain" }
          ],
          clauses: order.map((clause) => ({ tier: "org" as const, source: "policy:p@1", clause }))
        }
      ]);
    const forward = build([clauseA, clauseB]);
    const reverse = build([clauseB, clauseA]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
    expect(forward?.clauses.map((c) => c.clause.pkgName)).toEqual(["aaa", "zzz"]);
  });

  it("admission is PER CLASS — admitting one class never admits another", () => {
    const resolved = resolveEffectiveScanExclusions([
      {
        targetObjectId: "a",
        representedTiers: CHAIN,
        admissions: [
          { tier: "platform", class: "vendor_latest", source: "admit:platform" },
          { tier: "trust_domain", class: "vendor_latest", source: "admit:trust_domain" }
        ],
        clauses: [{ tier: "org", source: "policy:p@1", clause: CLAUSE }]
      }
    ]);
    expect(resolved).toBeUndefined();
  });
});
