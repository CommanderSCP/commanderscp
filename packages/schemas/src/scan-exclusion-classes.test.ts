import { describe, expect, it } from "vitest";
import {
  applyScanExclusions,
  parseTrivyFindings,
  purlEcosystem,
  scanExclusionClauseMatches,
  vendorLatestPackageKey,
  type AdmittedScanExclusionClause,
  type EffectiveScanExclusions,
  type ScanExclusionClause,
  type ScanFinding,
  type ScanVendorLatestFacts
} from "./supply-chain.js";

/**
 * M22.3 (`no fix available`) and M22.4 (the vendor rule, owner decision D1) — THE TWO CLASS
 * PREDICATES, pure.
 *
 * `scan-exclusion-classes` rather than an addition to `supply-chain.test.ts` because these are tests
 * of the CLASSES, not of the exclusion machinery: M22.2 already pins the machinery (admission,
 * application-before-counting, the truncation refusal, the evidence projection) and those tests must
 * keep failing for their own reasons.
 *
 * WHAT THE TWO CLASSES HAVE IN COMMON, and why they are in one file: both answer "is this finding
 * one we have already done everything about?", and both must fail CLOSED on every absence. M22.3
 * reads one field off the finding; M22.4 reads facts the SERVER resolved and serialized. Neither may
 * ever degrade into "the narrowing matchers alone", because a clause whose class contributes nothing
 * excludes a strictly LARGER set than the same clause with its class enforced.
 *
 * MUTATIONS RUN against this file — measured, reverted by an exact inverse edit, recorded in the
 * increment report rather than predicted here.
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
  vendorLatest?: ScanVendorLatestFacts
): EffectiveScanExclusions => ({
  clauses: [admitted(clause)],
  ...(vendorLatest ? { vendorLatest } : {})
});

const VENDOR: ScanExclusionClause = { class: "vendor_latest" };

// ===========================================================================================
// M22.3 — `no fix available`: pure data over the retained fields, no join of any kind.
// ===========================================================================================

describe("M22.3 — no_fix_available reads FixedVersion's ABSENCE and nothing else", () => {
  it("excludes a finding with NO FixedVersion and keeps one that has a fix", () => {
    const findings = [
      finding({ pkgName: "openssl" }),
      finding({ pkgName: "zlib", fixedVersion: "1.3.1" })
    ];
    const applied = applyScanExclusions(findings, withFacts({ class: "no_fix_available" }), "full");
    expect(applied.excludedOrdinals).toEqual([0]);
    expect(applied.findings).toEqual([findings[1]]);
  });

  it("a FixedVersion of EMPTY STRING is the same state as absent — one state, not two", () => {
    // `parseTrivyFindings` normalizes `""` to absent, so the predicate must never see an empty
    // string. Pinned here because a hand-built finding (a test fixture, a future producer) could
    // carry one, and `"" === undefined` is false: a predicate written as a truthiness check would
    // behave one way through the parser and another way through any other producer.
    const viaParser = parseOne({ Severity: "HIGH", PkgName: "openssl", FixedVersion: "" });
    expect(viaParser.fixedVersion).toBeUndefined();
    expect(scanExclusionClauseMatches({ class: "no_fix_available" }, viaParser)).toBe(true);
  });

  it("NEEDS NO FACTS — it is the one class that resolves from a finding alone", () => {
    // Handed no facts at all (the shape of every deployment before M22.4), it still decides. This is
    // the negative control for M22.4's own "no facts means no exclusion": the two classes must NOT
    // share a fail-closed condition, or M22.3 would silently stop working the day the vendor query
    // returns nothing.
    expect(scanExclusionClauseMatches({ class: "no_fix_available" }, finding())).toBe(true);
    expect(
      scanExclusionClauseMatches({ class: "no_fix_available" }, finding(), {
        vendorLatest: undefined
      })
    ).toBe(true);
  });

  it("the narrowing matchers still apply ON TOP of the class — the class is a conjunct", () => {
    const findings = [finding({ pkgName: "openssl" }), finding({ pkgName: "zlib" })];
    const applied = applyScanExclusions(
      findings,
      withFacts({ class: "no_fix_available", pkgName: "openssl" }),
      "full"
    );
    expect(applied.excludedOrdinals).toEqual([0]);
  });

  it("is refused wholesale on a TRUNCATED finding set, exactly like every other class", () => {
    const applied = applyScanExclusions(
      [finding(), finding()],
      withFacts({ class: "no_fix_available" }),
      "truncated"
    );
    expect(applied.excludedOrdinals).toEqual([]);
    expect(applied.evidence?.refused).toBe("truncated");
  });

  it("is refused on an OPENSCAP verdict, positively — never 'there were no findings to exclude'", () => {
    // ADR-0033 Context 4: XCCDF rule-results carry no package, no purl, no FixedVersion and no
    // Class. A `no_fix_available` clause is the one that looks most applicable there and is the one
    // that must be refused loudest: every rule-result would have an absent FixedVersion.
    const applied = applyScanExclusions(
      [finding({ severity: "high" })],
      withFacts({ class: "no_fix_available" }),
      "unsupported"
    );
    expect(applied.excludedOrdinals).toEqual([]);
    expect(applied.evidence?.refused).toBe("unsupported");
    expect(applied.evidence?.clauseCount).toBe(1);
  });
});

/** One entry through the real parser, so the empty-string normalization above is the SHIPPED one. */
function parseOne(vuln: Record<string, unknown>): ScanFinding {
  const parsed = parseTrivyFindings({
    Results: [{ Class: "os-pkgs", Target: "img", Vulnerabilities: [vuln] }]
  });
  const first = parsed[0];
  if (!first) throw new Error("fixture produced no finding");
  return first;
}

// ===========================================================================================
// M22.4 — the vendor rule's key and the purl→ecosystem read.
// ===========================================================================================

describe("M22.4 — the join key is canonicalised ONCE, per ecosystem's own rule", () => {
  it("folds python by PEP 503 and NOTHING ELSE", () => {
    expect(vendorLatestPackageKey("python", "Flask")).toBe(
      vendorLatestPackageKey("python", "flask")
    );
    expect(vendorLatestPackageKey("python", "zope.interface")).toBe(
      vendorLatestPackageKey("python", "zope_interface")
    );
    expect(vendorLatestPackageKey("python", "zope.interface")).toBe("python|zope-interface");
  });

  it("does NOT case-fold go, npm or maven — an invented equality is a false positive here", () => {
    // Go module paths are case-sensitive by language specification; Maven coordinates likewise. For
    // a LOOSENING an invented equality excuses a finding on a package the org never declared, which
    // is the one direction this feature may not fail in.
    expect(vendorLatestPackageKey("go", "github.com/Masterminds/semver")).not.toBe(
      vendorLatestPackageKey("go", "github.com/masterminds/semver")
    );
    expect(vendorLatestPackageKey("maven", "com.Acme:Lib")).not.toBe(
      vendorLatestPackageKey("maven", "com.acme:lib")
    );
    expect(vendorLatestPackageKey("npm", "@babel/core")).toBe("npm|@babel/core");
  });

  it("keys are ECOSYSTEM-QUALIFIED, so one name never crosses ecosystems", () => {
    expect(vendorLatestPackageKey("npm", "requests")).not.toBe(
      vendorLatestPackageKey("python", "requests")
    );
  });

  it("reads the four LANGUAGE purl types and refuses everything else", () => {
    expect(purlEcosystem("pkg:npm/lodash@4.17.21")).toBe("npm");
    expect(purlEcosystem("pkg:golang/github.com%2Facme%2Flib@v1.2.3")).toBe("go");
    expect(purlEcosystem("pkg:maven/com.acme/lib@1.0.0")).toBe("maven");
    expect(purlEcosystem("pkg:pypi/requests@2.31.0")).toBe("python");
    // OS package types are NOT language ecosystems — they reach the base image arm instead.
    expect(purlEcosystem("pkg:apk/alpine/openssl@3.1.4-r5")).toBeUndefined();
    expect(purlEcosystem("pkg:deb/debian/libc6@2.36")).toBeUndefined();
    expect(purlEcosystem("pkg:rpm/redhat/glibc@2.34")).toBeUndefined();
    // `oci` is deliberately absent: an image is never a lang-pkgs finding.
    expect(purlEcosystem("pkg:oci/alpine@sha256:abc")).toBeUndefined();
    expect(purlEcosystem("not-a-purl")).toBeUndefined();
    expect(purlEcosystem(undefined)).toBeUndefined();
  });
});

describe("M22.4 — vendor_latest excludes only what the SERVER said was at head", () => {
  const atHead: ScanVendorLatestFacts = {
    baseImageAtLatest: true,
    packageKeys: [
      vendorLatestPackageKey("npm", "lodash"),
      vendorLatestPackageKey("python", "flask")
    ]
  };

  it("WITH NO FACTS AT ALL, a vendor_latest clause excludes NOTHING (D7)", () => {
    // The component with no dependency automation: no ingested manifests, no polled head, therefore
    // no facts — and therefore no vendor-pass. The gate is decoupled from automation; the DATA is
    // not. This is also the shape every deployment is in before an inventory exists.
    const findings = [finding({ class: "os-pkgs" }), finding({ class: "lang-pkgs" })];
    const applied = applyScanExclusions(findings, withFacts(VENDOR), "full");
    expect(applied.excludedOrdinals).toEqual([]);
    expect(applied.evidence?.appliedCount).toBe(0);
  });

  it("os-pkgs findings ride the BASE IMAGE line — all of them, or none", () => {
    const findings = [
      finding({ class: "os-pkgs", pkgName: "openssl" }),
      finding({ class: "os-pkgs", pkgName: "busybox" })
    ];
    expect(
      applyScanExclusions(findings, withFacts(VENDOR, atHead), "full").excludedOrdinals
    ).toEqual([0, 1]);
    const stale: ScanVendorLatestFacts = { ...atHead, baseImageAtLatest: false };
    expect(
      applyScanExclusions(findings, withFacts(VENDOR, stale), "full").excludedOrdinals
    ).toEqual([]);
  });

  it("a DECLARED lang-pkgs dependency at head is excluded; a TRANSITIVE one is not", () => {
    const findings = [
      // Declared, at head.
      finding({ class: "lang-pkgs", pkgName: "lodash", purl: "pkg:npm/lodash@4.17.21" }),
      // Transitive: no line of its own, so no key, so no pass. It is fixed by moving the DIRECT
      // parent that pulls it — which has a line.
      finding({ class: "lang-pkgs", pkgName: "minimist", purl: "pkg:npm/minimist@0.0.8" })
    ];
    const applied = applyScanExclusions(findings, withFacts(VENDOR, atHead), "full");
    expect(applied.excludedOrdinals).toEqual([0]);
    expect(applied.findings).toEqual([findings[1]]);
  });

  it("a lang-pkgs finding with NO PURL yields no ecosystem and therefore NO exclusion", () => {
    const findings = [finding({ class: "lang-pkgs", pkgName: "lodash" })];
    expect(
      applyScanExclusions(findings, withFacts(VENDOR, atHead), "full").excludedOrdinals
    ).toEqual([]);
  });

  it("A NAME AT HEAD IN ONE ECOSYSTEM DOES NOT EXCUSE THE SAME NAME IN ANOTHER", () => {
    // The specific false positive the ecosystem qualifier exists for: `requests` is a household
    // Python distribution AND an npm package. Facts say the PYTHON one is current.
    const facts: ScanVendorLatestFacts = {
      baseImageAtLatest: false,
      packageKeys: [vendorLatestPackageKey("python", "requests")]
    };
    const findings = [
      finding({ class: "lang-pkgs", pkgName: "requests", purl: "pkg:npm/requests@0.0.1" }),
      finding({ class: "lang-pkgs", pkgName: "requests", purl: "pkg:pypi/requests@2.31.0" })
    ];
    const applied = applyScanExclusions(findings, withFacts(VENDOR, facts), "full");
    expect(applied.excludedOrdinals).toEqual([1]);
  });

  it("python findings match through PEP 503 — the fold is applied to BOTH sides of the join", () => {
    const facts: ScanVendorLatestFacts = {
      baseImageAtLatest: false,
      packageKeys: [vendorLatestPackageKey("python", "zope.interface")]
    };
    const findings = [
      finding({
        class: "lang-pkgs",
        pkgName: "zope_interface",
        purl: "pkg:pypi/zope-interface@6.1"
      })
    ];
    expect(
      applyScanExclusions(findings, withFacts(VENDOR, facts), "full").excludedOrdinals
    ).toEqual([0]);
  });

  it("a finding with an UNRECOGNISED or ABSENT Class attributes to nothing", () => {
    // Trivy emits `license`, `secret` and `config` results too, and `parseTrivyFindings` retains an
    // entry on its severity alone — so a finding with no `Class` at all is a real shape. Neither the
    // base image nor a package line speaks for it, and guessing one is the inversion.
    const findings = [
      finding({ class: "license", pkgName: "lodash", purl: "pkg:npm/lodash@4.17.21" }),
      finding({ pkgName: "lodash", purl: "pkg:npm/lodash@4.17.21" })
    ];
    expect(
      applyScanExclusions(findings, withFacts(VENDOR, atHead), "full").excludedOrdinals
    ).toEqual([]);
  });

  it("the clause's narrowing matchers still apply on top of the facts", () => {
    const findings = [
      finding({ class: "os-pkgs", pkgName: "openssl" }),
      finding({ class: "os-pkgs", pkgName: "busybox" })
    ];
    const applied = applyScanExclusions(
      findings,
      withFacts({ class: "vendor_latest", pkgName: "openssl" }, atHead),
      "full"
    );
    expect(applied.excludedOrdinals).toEqual([0]);
  });

  it("facts DO NOT leak across classes: the VENDOR facts cannot satisfy declared_fact or approved_override", () => {
    // Both of those classes are now BUILT (M22.5/M22.6) and read their own facts, so this is no
    // longer "unbuilt classes stay inert" — it is the stronger property that each class consults
    // ONLY its own resolved fact. A `vendor_latest` resolution reaching a `declared_fact` clause
    // would mean a component at the head of its dependency lines silently satisfied a declaration it
    // never made.
    for (const cls of ["declared_fact", "approved_override"] as const) {
      const applied = applyScanExclusions(
        [finding({ class: "os-pkgs", pkgName: "openssl" })],
        withFacts({ class: cls }, atHead),
        "full"
      );
      expect(applied.excludedOrdinals).toEqual([]);
    }
  });

  it("a TRUNCATED finding set refuses the vendor pass too — you cannot except what you did not record", () => {
    const applied = applyScanExclusions(
      [finding({ class: "os-pkgs" })],
      withFacts(VENDOR, atHead),
      "truncated"
    );
    expect(applied.excludedOrdinals).toEqual([]);
    expect(applied.evidence?.refused).toBe("truncated");
  });
});
