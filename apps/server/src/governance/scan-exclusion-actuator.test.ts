import { describe, expect, it } from "vitest";
import type { EffectiveScanExclusions } from "@scp/schemas";
import { scanExclusionSetHash, scanExclusionSetHashOfContext } from "./scan-exclusion-actuator.js";

/**
 * M22.7 — the PURE half of the actuator: what the recorded digest is a function of.
 *
 * The wiring is proven in `scan-exclusion-actuator.integration.test.ts` against the real gate; none
 * of these cases can tell you whether anything is installed. What they pin is the contract that makes
 * the wiring safe — an empty set hashing to nothing, a stable set hashing stably, and every field of
 * the resolved set actually reaching the digest. A digest that ignored a field would leave a change
 * to that field invisible to the actuator, which is the same defect as having no actuator at all,
 * only harder to see.
 *
 * MUTATIONS RUN (2026-08-17), each applied alone against a passing suite and reverted by an exact
 * inverse edit. Baseline: 9 passed. Measured, not predicted.
 *   U-M1  hash `canonicalJson(resolved.clauses)` instead of the whole resolved object
 *           -> 3 failed (the vendor, declared-fact and grant cases). A grant approved, revoked or
 *              expired under an UNCHANGED clause list — which is the ordinary case, since the clause
 *              is authored once by SecOps and the grants move underneath it — would never be noticed.
 *              The integration suite does catch this one too, but only through the gate; this is the
 *              cheap version that says exactly which field went missing.
 *   U-M2  return a fixed string instead of `undefined` for an empty clause list
 *           -> 1 failed here, and 1 in the integration suite (A4, the byte-identical promise).
 */

function clause(cls: string, extra: Record<string, unknown> = {}) {
  return {
    clause: { class: cls, ...extra },
    tier: "org",
    source: "policy:p@obj",
    admittedBy: [{ tier: "platform", source: "instance" }]
  };
}

function setOf(overrides: Partial<EffectiveScanExclusions> = {}): EffectiveScanExclusions {
  return {
    clauses: [clause("approved_override")],
    ...overrides
  } as EffectiveScanExclusions;
}

describe("scanExclusionSetHash", () => {
  it("is undefined when nothing was resolved, and when nothing was admitted", () => {
    // THE BYTE-IDENTICAL PROMISE. `undefined` is what makes the stamp write no key and the
    // comparison never force, so a deployment that authored no exclusion pays nothing.
    expect(scanExclusionSetHash(undefined)).toBeUndefined();
    expect(scanExclusionSetHash({ clauses: [] } as EffectiveScanExclusions)).toBeUndefined();
  });

  it("is stable across two structurally identical sets, whatever order their KEYS were built in", () => {
    // `canonicalJson` sorts object keys recursively. Without that, two resolutions that differ only
    // in construction order would disagree and re-run the control on every tick.
    const a = setOf();
    const b = JSON.parse(
      JSON.stringify({
        clauses: [
          {
            admittedBy: [{ source: "instance", tier: "platform" }],
            source: "policy:p@obj",
            tier: "org",
            clause: { class: "approved_override" }
          }
        ]
      })
    ) as EffectiveScanExclusions;
    expect(scanExclusionSetHash(a)).toBe(scanExclusionSetHash(b));
  });

  it("changes when a CLAUSE changes", () => {
    expect(scanExclusionSetHash(setOf())).not.toBe(
      scanExclusionSetHash(setOf({ clauses: [clause("no_fix_available")] } as never))
    );
  });

  it("changes when the ADMITTING tier chain changes", () => {
    // An admission withdrawn above is a real change to what is in force, even though the clause
    // itself is untouched.
    const narrowed = setOf({
      clauses: [
        {
          ...clause("approved_override"),
          admittedBy: [{ tier: "platform", source: "instance-2" }]
        }
      ]
    } as never);
    expect(scanExclusionSetHash(setOf())).not.toBe(scanExclusionSetHash(narrowed));
  });

  it("changes when the VENDOR facts move", () => {
    // The head of a dependency line moving is invisible in the clause list and decides the verdict.
    const atHead = setOf({
      vendorLatest: { baseImageAtLatest: true, packageKeys: ["npm|lodash"] }
    });
    const behind = setOf({
      vendorLatest: { baseImageAtLatest: false, packageKeys: ["npm|lodash"] }
    });
    expect(scanExclusionSetHash(atHead)).not.toBe(scanExclusionSetHash(behind));
  });

  it("changes when a DECLARED FACT is edited", () => {
    const none = setOf({ declaredFacts: { declarations: [{ key: "egress", value: "none" }] } });
    const internet = setOf({
      declaredFacts: { declarations: [{ key: "egress", value: "internet" }] }
    });
    expect(scanExclusionSetHash(none)).not.toBe(scanExclusionSetHash(internet));
  });

  it("changes when a GRANT is added, and when only its EXPIRY moves", () => {
    // `expiresAt` is a STORED value, so it hashes stably tick to tick — but editing it (or the grant
    // lapsing out of the resolver's read-time window) has to be visible, or an expiry never binds on
    // a change whose gate already ran.
    const none = setOf();
    const granted = setOf({
      approvedOverrides: {
        grants: [
          {
            grantObjectId: "g1",
            vulnerabilityId: "CVE-1",
            tierObjectId: "svc",
            tier: "service" as const,
            expiresAt: "2030-01-01T00:00:00.000Z"
          }
        ]
      }
    });
    const laterExpiry = setOf({
      approvedOverrides: {
        grants: [
          {
            grantObjectId: "g1",
            vulnerabilityId: "CVE-1",
            tierObjectId: "svc",
            tier: "service" as const,
            expiresAt: "2031-01-01T00:00:00.000Z"
          }
        ]
      }
    });
    expect(scanExclusionSetHash(none)).not.toBe(scanExclusionSetHash(granted));
    expect(scanExclusionSetHash(granted)).not.toBe(scanExclusionSetHash(laterExpiry));
  });

  it("is the SAME value whether taken from the resolved object or from the control-run context", () => {
    // The stamp reads the context and the comparison reads the resolver's own object. Two functions
    // computing "the hash" is exactly the shape where the two drift and the loop never converges —
    // this pins that there is one.
    const resolved = setOf();
    expect(scanExclusionSetHashOfContext({ changeId: "c", scanExclusions: resolved })).toBe(
      scanExclusionSetHash(resolved)
    );
  });

  it("yields no hash for a context with no exclusions, or with an unparseable value", () => {
    expect(scanExclusionSetHashOfContext({ changeId: "c" })).toBeUndefined();
    expect(
      scanExclusionSetHashOfContext({ changeId: "c", scanExclusions: { clauses: "nope" } })
    ).toBeUndefined();
  });
});
