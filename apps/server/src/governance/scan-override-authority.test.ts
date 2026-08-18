import { describe, expect, it } from "vitest";
import type { EffectiveScanThreshold, ScanOverrideGrantCandidate } from "@scp/schemas";
import { applyOverrideAuthorityBar } from "./scan-override-grants.js";
import { requiredOverrideApprovalTier, scanRequirementTierOrder } from "./scan-requirements.js";

/**
 * M22.6 (ADR-0033 §6a, owner decision D3) — THE APPROVER-STANDING ALGEBRA, as a pure function.
 *
 * This file pins the two halves of the derivation and nothing else. The WIRING — that the gate
 * actually calls them, with the real ceiling and the real containment chain — is proven at the real
 * gate in `scan-declared-override-exclusions.integration.test.ts` (cases O7-O10), because a pure test
 * cannot tell you whether a component is installed, which is this repo's dominant defect.
 *
 * THE DEFECT THESE EXIST AGAINST: `tierObjectId` was chosen freely by the REQUESTER and read
 * afterwards only for PRESENCE. Since `scopeExpandCte` expands UPWARD, naming a LOWER object strictly
 * WIDENED the approver set — a service lead could approve away a platform-set `maxCritical: 0` and
 * the audit trail would truthfully record "under authority of '<service>'".
 *
 * MUTATIONS RUN (2026-08-18), each applied ALONE against a passing suite and reverted by an exact
 * inverse edit. Baseline: 8 passed. MEASURED, not predicted.
 *
 *   U-1  `applyOverrideAuthorityBar` grants EVERY candidate (both refusal branches disabled)
 *          -> 3 failed here, plus O7 and O9 at the real gate. The whole objection, undone.
 *   U-2  `requiredOverrideApprovalTier` iterates an empty contributor list (always `component`)
 *          -> 2 failed here, plus O7, O8 and O9 at the real gate.
 *   U-3  an off-chain `tierObjectId` falls open to `"component"` instead of being refused
 *          -> 1 failed ("NOT ON THE CHAIN"). The fail-open an absent map lookup invites, and the one
 *             a reviewer is most likely to write while "tidying up a nullable".
 */

/** `TIER_ORDER.indexOf`, taken from the module that owns the order rather than restated here — a
 *  second copy of the tier order in a test is a second opinion about what "above" means. */
const rank = (tier: Parameters<typeof applyOverrideAuthorityBar>[0]["requiredTier"]): number =>
  scanRequirementTierOrder().indexOf(tier);

const candidate = (over: Partial<ScanOverrideGrantCandidate> = {}): ScanOverrideGrantCandidate => ({
  grantObjectId: "g-1",
  vulnerabilityId: "CVE-2026-0001",
  tierObjectId: "svc-1",
  expiresAt: "2099-01-01T00:00:00.000Z",
  ...over
});

const ceiling = (
  ...contributors: EffectiveScanThreshold["contributors"]
): EffectiveScanThreshold => ({ threshold: { maxHigh: 0 }, contributors });

describe("requiredOverrideApprovalTier — the bar is read off the RULE, never off the request", () => {
  it("NO ceiling at all means NO bar: the bottom rung", () => {
    // The shipped default. With no tier-set ceiling there is nothing stricter than the requester's
    // own authority to escalate past, and the control falls back to its per-binding
    // `config.threshold` (M17.1). Getting this wrong in the strict direction would make the whole
    // override feature dead on every deployment that authored no `scanThreshold`.
    expect(requiredOverrideApprovalTier(undefined)).toBe("component");
    expect(requiredOverrideApprovalTier(ceiling())).toBe("component");
  });

  it("the MOST SENIOR contributor sets the bar, whatever order they arrive in", () => {
    const platformFirst = ceiling(
      { tier: "platform", source: "instance:platform:local", threshold: { maxCritical: 0 } },
      { tier: "service", source: "policy:svc@1", threshold: { maxCritical: 0 } }
    );
    const serviceFirst = ceiling(
      { tier: "service", source: "policy:svc@1", threshold: { maxCritical: 0 } },
      { tier: "platform", source: "instance:platform:local", threshold: { maxCritical: 0 } }
    );
    expect(requiredOverrideApprovalTier(platformFirst)).toBe("platform");
    expect(requiredOverrideApprovalTier(serviceFirst)).toBe("platform");
  });

  it("a LOOSER senior contributor still sets the bar — the bar is not the BINDING contributor", () => {
    // The mutation a reasonable implementer writes: "only the tier whose value is the per-severity
    // MIN is actually being waived". Wrong, and this case is the argument. Excluding a finding drops
    // it out of the COUNT, so a count of 6 falling to 5 satisfies platform's ceiling of 5 exactly as
    // it satisfies the service ceiling of 0 that produced the block. Keying on the MIN would let the
    // service tier defeat platform's ceiling indirectly.
    const mixed = ceiling(
      { tier: "platform", source: "instance:platform:local", threshold: { maxCritical: 5 } },
      { tier: "service", source: "policy:svc@1", threshold: { maxCritical: 0 } }
    );
    expect(requiredOverrideApprovalTier(mixed)).toBe("platform");
  });

  it("an UNRECOGNISED tier label raises no bar and does not crash the gate", () => {
    const rogue = ceiling({
      tier: "nonsense" as never,
      source: "policy:x@1",
      threshold: { maxHigh: 0 }
    });
    expect(requiredOverrideApprovalTier(rogue)).toBe("component");
  });
});

describe("applyOverrideAuthorityBar — the grant's tier is DERIVED from the target's own chain", () => {
  it("a grant AT the bar applies; the identical grant one rung BELOW does not", () => {
    // The whole objection, in two lines. Same grant, same component, same everything — only the tier
    // the named object actually occupies differs.
    const chain = { "org-1": "org" as const, "svc-1": "service" as const };
    const atBar = applyOverrideAuthorityBar({
      candidates: [candidate({ tierObjectId: "org-1" })],
      chainTierByObjectId: chain,
      requiredTier: "org",
      rankOf: rank
    });
    expect(atBar.granted.map((g) => g.tier)).toEqual(["org"]);
    expect(atBar.refused).toEqual([]);

    const belowBar = applyOverrideAuthorityBar({
      candidates: [candidate({ tierObjectId: "svc-1" })],
      chainTierByObjectId: chain,
      requiredTier: "org",
      rankOf: rank
    });
    expect(belowBar.granted).toEqual([]);
    expect(belowBar.refused).toEqual([
      { grantObjectId: "g-1", tier: "service", reason: "tier_below_required" }
    ]);
  });

  it("a grant ABOVE the bar applies — authority expands upward, exactly as scopeExpandCte does", () => {
    const result = applyOverrideAuthorityBar({
      candidates: [candidate({ tierObjectId: "org-1" })],
      chainTierByObjectId: { "org-1": "org", "svc-1": "service" },
      requiredTier: "service",
      rankOf: rank
    });
    expect(result.granted.map((g) => g.grantObjectId)).toEqual(["g-1"]);
  });

  it("a tierObjectId that is NOT ON THE CHAIN is refused outright — never silently read as 'component'", () => {
    // The fail-open an absent lookup invites: defaulting an unknown object to the bottom rung would
    // make "name an object somewhere else in the graph" a way to satisfy a `component` bar. An
    // object that is not an ancestor holds no authority over this component through any route the
    // RBAC walk uses.
    const result = applyOverrideAuthorityBar({
      candidates: [candidate({ tierObjectId: "stranger" })],
      chainTierByObjectId: { "svc-1": "service" },
      requiredTier: "component",
      rankOf: rank
    });
    expect(result.granted).toEqual([]);
    expect(result.refused).toEqual([
      { grantObjectId: "g-1", reason: "tier_not_on_containment_chain" }
    ]);
  });

  it("partitions a mixed set and keeps BOTH halves content-sorted", () => {
    // Determinism is not cosmetic here: both arrays land in the gate Decision, and an unsorted array
    // defeats `insertDecisionIfChanged` (the measured 1.44 GB/day write amplification).
    const result = applyOverrideAuthorityBar({
      candidates: [
        candidate({ grantObjectId: "g-z", tierObjectId: "svc-1" }),
        candidate({ grantObjectId: "g-a", tierObjectId: "org-1" }),
        candidate({ grantObjectId: "g-m", tierObjectId: "svc-1" }),
        candidate({ grantObjectId: "g-b", tierObjectId: "org-1" })
      ],
      chainTierByObjectId: { "org-1": "org", "svc-1": "service" },
      requiredTier: "org",
      rankOf: rank
    });
    expect(result.granted.map((g) => g.grantObjectId)).toEqual(["g-a", "g-b"]);
    expect(result.refused.map((g) => g.grantObjectId)).toEqual(["g-m", "g-z"]);
  });
});
