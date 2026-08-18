import { describe, expect, it } from "vitest";
import {
  ComponentSecurityPropertySchema,
  applyScanExclusions,
  scanExclusionClauseMatches,
  scanOverrideGrantFor,
  type AdmittedScanExclusionClause,
  type EffectiveScanExclusions,
  type ScanApprovedOverrides,
  type ScanDeclaredFacts,
  type ScanExclusionClause,
  type ScanFinding
} from "./supply-chain.js";

/**
 * M22.5 (component-declared facts, owner decision D2) and M22.6 (the override request, D3/D4) — THE
 * TWO REMAINING CLASS PREDICATES, pure.
 *
 * A separate file from `scan-exclusion-classes.test.ts` for the reason that file gives for existing
 * at all: these are tests of the CLASSES, and the two here share a property the earlier two do not.
 * `no_fix_available` and `vendor_latest` are assertions about the WORLD (the scanner shipped no fix;
 * the registry has nothing newer). These two are assertions about an ACT SOMEONE PERFORMED — a
 * component owner wrote a property, an authority approved a request — which makes the interesting
 * cases the ones where the act was incomplete, misspelled, or has since expired.
 *
 * WHAT IS DELIBERATELY NOT TESTED HERE: whether the facts are ever RESOLVED, and whether the
 * resolution is WIRED into a gate. A pure test of a pure predicate can say nothing about either, and
 * this repo's dominant defect is a component built, tested green against itself, and installed
 * nowhere. `scan-declared-override-exclusions.integration.test.ts` drives the real gate for that.
 *
 * MUTATIONS RUN against this file (2026-08-17), measured against a baseline of 20 passed and
 * reverted by an exact inverse edit:
 *   S-1  `declaredFactPredicate` accepts a clause with a KEY and no VALUE -> 1 failed. The same
 *        mutation reaches the real gate only after `pnpm -w build`, because the plugin subprocess
 *        loads the BUILT `@scp/schemas` — the unit suite caught it with no rebuild at all.
 */

const finding = (over: Partial<ScanFinding> = {}): ScanFinding => ({
  severity: "high",
  vulnerabilityId: "CVE-2026-1000",
  ...over
});

const admitted = (clause: ScanExclusionClause): AdmittedScanExclusionClause => ({
  clause,
  tier: "org",
  source: "policy:secops@p1",
  admittedBy: [{ tier: "platform", source: "instance:platform:local" }]
});

const withFacts = (
  clause: ScanExclusionClause,
  facts: Partial<Pick<EffectiveScanExclusions, "declaredFacts" | "approvedOverrides">> = {}
): EffectiveScanExclusions => ({ clauses: [admitted(clause)], ...facts });

const declared = (...pairs: Array<[string, string]>): ScanDeclaredFacts => ({
  declarations: pairs.map(([key, value]) => ({ key, value }))
});

// ===========================================================================================
// M22.5 — `declared_fact`
// ===========================================================================================

describe("M22.5 — declared_fact needs BOTH halves of the clause and a matching declaration", () => {
  const EGRESS_NONE: ScanExclusionClause = {
    class: "declared_fact",
    declaredFact: "egress",
    declaredValue: "none"
  };

  it("excludes when the targets declared exactly the pair the clause names", () => {
    const applied = applyScanExclusions(
      [finding({ pkgName: "curl" })],
      withFacts(EGRESS_NONE, { declaredFacts: declared(["egress", "none"]) }),
      "full"
    );
    expect(applied.excludedOrdinals).toEqual([0]);
    // ADR-0033 §6 guard 2 — the DECLARED VALUE, verbatim, in evidence. "Passed because component X
    // asserted `egress: none`", never just "passed".
    expect(applied.evidence?.applied[0]).toMatchObject({
      class: "declared_fact",
      declaredFact: "egress",
      declaredValue: "none"
    });
  });

  it("a clause naming the KEY but no VALUE excludes NOTHING — the component would otherwise write its own exemption", () => {
    // This is the guard that keeps D2's accepted escalation seam bounded. Without it,
    // `{class: "declared_fact", declaredFact: "egress"}` would fire on ANY value at all, including
    // `egress: internet` — a component excusing itself by writing a property whose content nobody
    // constrained.
    const applied = applyScanExclusions(
      [finding()],
      withFacts(
        { class: "declared_fact", declaredFact: "egress" },
        { declaredFacts: declared(["egress", "internet"]) }
      ),
      "full"
    );
    expect(applied.excludedOrdinals).toEqual([]);
  });

  it("a clause naming a VALUE but no KEY excludes nothing either", () => {
    const applied = applyScanExclusions(
      [finding()],
      withFacts(
        { class: "declared_fact", declaredValue: "none" },
        { declaredFacts: declared(["egress", "none"]) }
      ),
      "full"
    );
    expect(applied.excludedOrdinals).toEqual([]);
  });

  it("a DIFFERENT declared value on the same key excludes nothing", () => {
    const applied = applyScanExclusions(
      [finding()],
      withFacts(EGRESS_NONE, { declaredFacts: declared(["egress", "internal-only"]) }),
      "full"
    );
    expect(applied.excludedOrdinals).toEqual([]);
  });

  it("no declared facts at all excludes nothing — an absent declaration is never a declaration", () => {
    expect(
      applyScanExclusions([finding()], withFacts(EGRESS_NONE), "full").excludedOrdinals
    ).toEqual([]);
    expect(
      applyScanExclusions(
        [finding()],
        withFacts(EGRESS_NONE, { declaredFacts: declared() }),
        "full"
      ).excludedOrdinals
    ).toEqual([]);
  });

  it("values are compared EXACTLY — no case folding, no trimming", () => {
    // The vocabulary is the org's, and an equality this file invented would be a FALSE POSITIVE on a
    // loosening, which is the one direction this feature may not fail in.
    for (const value of ["None", "NONE", " none", "none "]) {
      expect(
        scanExclusionClauseMatches(EGRESS_NONE, finding(), {
          declaredFacts: declared(["egress", value])
        })
      ).toBe(false);
    }
  });

  it("the clause's OTHER matchers still narrow which findings the fact excuses", () => {
    // The declaration says nothing about a finding, so the narrowing is the clause's job — authored
    // at `policy:write` by whoever admitted the class, never by the component. That split is the
    // whole of ADR-0033 §6 guard 1.
    const findings = [
      finding({ class: "os-pkgs", pkgName: "curl" }),
      finding({ class: "lang-pkgs", pkgName: "axios" })
    ];
    const applied = applyScanExclusions(
      findings,
      withFacts(
        { ...EGRESS_NONE, findingClass: "os-pkgs" },
        { declaredFacts: declared(["egress", "none"]) }
      ),
      "full"
    );
    expect(applied.excludedOrdinals).toEqual([0]);
  });

  it("a TRUNCATED finding set refuses a declared-fact exclusion too", () => {
    const applied = applyScanExclusions(
      [finding()],
      withFacts(EGRESS_NONE, { declaredFacts: declared(["egress", "none"]) }),
      "truncated"
    );
    expect(applied.excludedOrdinals).toEqual([]);
    expect(applied.evidence?.refused).toBe("truncated");
  });
});

describe("M22.5 — the request body is STRICT even though the registry schema is open", () => {
  it("accepts a well-formed declaration bag", () => {
    expect(
      ComponentSecurityPropertySchema.safeParse({ declarations: { egress: "none" } }).success
    ).toBe(true);
  });

  it("refuses a MISSPELLED wrapper key and an extra sibling — the two silent-failure shapes", () => {
    // Both would otherwise be stored, read by the gate as NO declarations, and leave the author
    // believing they had declared something. The mistake is always fail-CLOSED, which is precisely
    // why it would never surface as an incident — only as a rule that mysteriously never fires.
    expect(
      ComponentSecurityPropertySchema.safeParse({ declarationz: { egress: "none" } }).success
    ).toBe(false);
    expect(
      ComponentSecurityPropertySchema.safeParse({
        declarations: { egress: "none" },
        egress: "none"
      }).success
    ).toBe(false);
  });

  it("refuses an out-of-vocabulary KEY and a multi-line VALUE", () => {
    expect(
      ComponentSecurityPropertySchema.safeParse({ declarations: { Egress: "none" } }).success
    ).toBe(false);
    expect(
      ComponentSecurityPropertySchema.safeParse({ declarations: { egress: "no\nne" } }).success
    ).toBe(false);
  });

  it("refuses a non-string value — a boolean `true` is not a declaration anyone can read back", () => {
    expect(
      ComponentSecurityPropertySchema.safeParse({ declarations: { egress: true } }).success
    ).toBe(false);
  });
});

// ===========================================================================================
// M22.6 — `approved_override`
// ===========================================================================================

describe("M22.6 — approved_override joins a finding to a live grant, exactly", () => {
  const OVERRIDE: ScanExclusionClause = { class: "approved_override" };
  const grants = (...g: ScanApprovedOverrides["grants"]): ScanApprovedOverrides => ({ grants: g });
  const grant = (over: Partial<ScanApprovedOverrides["grants"][number]> = {}) => ({
    grantObjectId: "11111111-1111-1111-1111-111111111111",
    vulnerabilityId: "CVE-2026-1000",
    tierObjectId: "22222222-2222-2222-2222-222222222222",
    // M22.6 (D3) — the DERIVED tier. The predicate never reads it (a grant reaching this array has
    // already cleared the authority bar in `applyOverrideAuthorityBar`); it is here because the fact
    // type requires it, and because a fixture that omitted it would be typing away the field the
    // enforcement is carried on.
    tier: "service" as const,
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...over
  });

  it("excludes the granted finding and records the grant, its authority and its expiry", () => {
    const applied = applyScanExclusions(
      [finding({ pkgName: "openssl" })],
      withFacts(OVERRIDE, { approvedOverrides: grants(grant()) }),
      "full"
    );
    expect(applied.excludedOrdinals).toEqual([0]);
    // ADR-0033 §11 — "its clause, admitting tier, AUTHORITY and EXPIRY".
    expect(applied.evidence?.applied[0]).toMatchObject({
      class: "approved_override",
      grantObjectId: "11111111-1111-1111-1111-111111111111",
      grantTierObjectId: "22222222-2222-2222-2222-222222222222",
      grantExpiresAt: "2099-01-01T00:00:00.000Z"
    });
  });

  it("a DIFFERENT CVE is untouched — a grant is per (component x finding), never a blanket waiver", () => {
    const applied = applyScanExclusions(
      [finding({ vulnerabilityId: "CVE-2026-9999" })],
      withFacts(OVERRIDE, { approvedOverrides: grants(grant()) }),
      "full"
    );
    expect(applied.excludedOrdinals).toEqual([]);
  });

  it("a grant that also names a pkgName does NOT excuse the same CVE in another package", () => {
    const findings = [finding({ pkgName: "openssl" }), finding({ pkgName: "libcrypto" })];
    const applied = applyScanExclusions(
      findings,
      withFacts(OVERRIDE, { approvedOverrides: grants(grant({ pkgName: "openssl" })) }),
      "full"
    );
    expect(applied.excludedOrdinals).toEqual([0]);
  });

  it("a finding with NO vulnerabilityId can never be excused", () => {
    // `parseTrivyFindings` retains an entry on its severity alone, so this is a real shape rather
    // than a hypothetical: an unidentifiable finding is not one anybody approved.
    const bare: ScanFinding = { severity: "critical" };
    expect(
      applyScanExclusions(
        [bare],
        withFacts(OVERRIDE, { approvedOverrides: grants(grant()) }),
        "full"
      ).excludedOrdinals
    ).toEqual([]);
  });

  it("NO grants excludes nothing — an empty grant list is not a predicate that is always false", () => {
    expect(applyScanExclusions([finding()], withFacts(OVERRIDE), "full").excludedOrdinals).toEqual(
      []
    );
    expect(
      applyScanExclusions([finding()], withFacts(OVERRIDE, { approvedOverrides: grants() }), "full")
        .excludedOrdinals
    ).toEqual([]);
  });

  it("evidence names the grant the PREDICATE used — one function answers both questions", () => {
    // Two functions answering "does a grant match?" and "which grant matched?" is exactly the shape
    // where evidence names one grant and the verdict was decided by another.
    const a = grant({ grantObjectId: "aaaaaaaa-0000-0000-0000-000000000000", pkgName: "openssl" });
    const b = grant({ grantObjectId: "bbbbbbbb-0000-0000-0000-000000000000" });
    const f = finding({ pkgName: "openssl" });
    const facts = grants(a, b);
    expect(scanOverrideGrantFor(facts, f)?.grantObjectId).toBe(a.grantObjectId);
    const applied = applyScanExclusions(
      [f],
      withFacts(OVERRIDE, { approvedOverrides: facts }),
      "full"
    );
    expect(applied.evidence?.applied[0]?.grantObjectId).toBe(a.grantObjectId);
  });

  it("a TRUNCATED finding set refuses a granted exclusion too", () => {
    const applied = applyScanExclusions(
      [finding()],
      withFacts(OVERRIDE, { approvedOverrides: grants(grant()) }),
      "truncated"
    );
    expect(applied.excludedOrdinals).toEqual([]);
    expect(applied.evidence?.refused).toBe("truncated");
  });

  it("an UNSUPPORTED (OpenSCAP) verdict refuses it too, and says so positively", () => {
    // ADR-0033's consequences list requires this be explicit, never left to "there were no findings
    // to exclude". An XCCDF rule-result has no package, no purl and no CVE — there is nothing for a
    // grant to be about.
    const applied = applyScanExclusions(
      [finding()],
      withFacts(OVERRIDE, { approvedOverrides: grants(grant()) }),
      "unsupported"
    );
    expect(applied.excludedOrdinals).toEqual([]);
    expect(applied.evidence?.refused).toBe("unsupported");
  });
});
