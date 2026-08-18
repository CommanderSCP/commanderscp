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
    expect(vendorLatestPackageKey("python", "Flask", "3.0.0")).toBe(
      vendorLatestPackageKey("python", "flask", "3.0.0")
    );
    expect(vendorLatestPackageKey("python", "zope.interface", "6.1")).toBe(
      vendorLatestPackageKey("python", "zope_interface", "6.1")
    );
    expect(vendorLatestPackageKey("python", "zope.interface", "6.1")).toBe(
      "python|zope-interface|6.1"
    );
  });

  it("does NOT case-fold go, npm or maven — an invented equality is a false positive here", () => {
    // Go module paths are case-sensitive by language specification; Maven coordinates likewise. For
    // a LOOSENING an invented equality excuses a finding on a package the org never declared, which
    // is the one direction this feature may not fail in.
    expect(vendorLatestPackageKey("go", "github.com/Masterminds/semver", "v1.2.3")).not.toBe(
      vendorLatestPackageKey("go", "github.com/masterminds/semver", "v1.2.3")
    );
    expect(vendorLatestPackageKey("maven", "com.Acme:Lib", "1.0.0")).not.toBe(
      vendorLatestPackageKey("maven", "com.acme:lib", "1.0.0")
    );
    expect(vendorLatestPackageKey("npm", "@babel/core", "7.24.0")).toBe("npm|@babel/core|7.24.0");
  });

  it("keys are ECOSYSTEM-QUALIFIED, so one name never crosses ecosystems", () => {
    expect(vendorLatestPackageKey("npm", "requests", "2.31.0")).not.toBe(
      vendorLatestPackageKey("python", "requests", "2.31.0")
    );
  });

  it("keys are VERSION-QUALIFIED, so one name never crosses versions or majors", () => {
    // The defect this closed: the key answered "the MANIFEST declares this package at head", not
    // "the ARTIFACT contains it at head". Two spellings of that, both loosenings — a declared
    // `4.17.21` excusing a shipped `4.17.15`, and an at-head `4` line excusing a stale `3` line,
    // since at-head-ness is computed per `(ecosystem, coordinate, MAJOR)` and the key had no major.
    expect(vendorLatestPackageKey("npm", "lodash", "4.17.21")).not.toBe(
      vendorLatestPackageKey("npm", "lodash", "4.17.15")
    );
    expect(vendorLatestPackageKey("npm", "lodash", "4.17.21")).not.toBe(
      vendorLatestPackageKey("npm", "lodash", "3.10.1")
    );
    // The VERSION is not canonicalised at all — only the coordinate is, and only for python. Both
    // sides of the join are exact published version strings (`resolved_version` vs Trivy's
    // `InstalledVersion`), and a difference in spelling costs a pass rather than granting one.
    expect(vendorLatestPackageKey("python", "Flask", "3.0")).not.toBe(
      vendorLatestPackageKey("python", "flask", "3.0.0")
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
      vendorLatestPackageKey("npm", "lodash", "4.17.21"),
      vendorLatestPackageKey("python", "flask", "3.0.0")
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
      // Declared, at head, and SHIPPING the version the manifest declared.
      finding({
        class: "lang-pkgs",
        pkgName: "lodash",
        purl: "pkg:npm/lodash@4.17.21",
        installedVersion: "4.17.21"
      }),
      // Transitive: no line of its own, so no key, so no pass. It is fixed by moving the DIRECT
      // parent that pulls it — which has a line.
      finding({
        class: "lang-pkgs",
        pkgName: "minimist",
        purl: "pkg:npm/minimist@0.0.8",
        installedVersion: "0.0.8"
      })
    ];
    const applied = applyScanExclusions(findings, withFacts(VENDOR, atHead), "full");
    expect(applied.excludedOrdinals).toEqual([0]);
    expect(applied.findings).toEqual([findings[1]]);
  });

  it("THE MANIFEST IS NOT THE ARTIFACT: a declared package at head does not excuse a DIFFERENT installed version", () => {
    // The blocking defect the version join closes. The manifest declares `lodash@4.17.21` and the
    // line really is at its head — but the image ships `4.17.15`, and Trivy reports a HIGH against
    // what it found. Excusing it drops a finding with a shipped upstream fix under a rule whose whole
    // justification is "there is nothing more the team can do".
    const drifted = finding({
      class: "lang-pkgs",
      pkgName: "lodash",
      purl: "pkg:npm/lodash@4.17.15",
      installedVersion: "4.17.15"
    });
    expect(
      applyScanExclusions([drifted], withFacts(VENDOR, atHead), "full").excludedOrdinals
    ).toEqual([]);
  });

  it("A CURRENT SIBLING ON ANOTHER MAJOR DOES NOT VOTE AWAY A STALE LINE", () => {
    // `dependency_lines` is keyed by `(ecosystem, coordinate, MAJOR)` and at-head-ness is computed
    // per line, so a component declaring `lodash@4.17.21` (head of `4`) AND `lodash@3.10.1` (behind
    // head of `3`) has exactly one at-head line. A version-less key projected both onto `npm|lodash`
    // and excused the 3.10.1 finding — the current sibling voting away the stale one that
    // `foldVendorLatestFacts`' own docblock says cannot happen.
    const stale = finding({
      class: "lang-pkgs",
      pkgName: "lodash",
      purl: "pkg:npm/lodash@3.10.1",
      installedVersion: "3.10.1"
    });
    expect(
      applyScanExclusions([stale], withFacts(VENDOR, atHead), "full").excludedOrdinals
    ).toEqual([]);
  });

  it("A FIX IN A NEWER MAJOR STILL EXCUSES — D1 is 'latest of a MAJOR version', not 'no fix anywhere'", () => {
    // THIS CASE INVERTED (owner decision, 2026-08-18). A blanket `fixedVersion !== undefined ⇒
    // refuse` backstop was implemented in the review round and removed: it reads like free
    // fail-closed safety and instead refuses the exact case D1 exists for. The component IS at the
    // head of the line it declared; the fix shipped in a different major line, and a major upgrade
    // is a project rather than a patch. With the backstop, `vendor_latest` excused nothing that
    // `no_fix_available` would not already excuse, so the class could not earn its own existence.
    const lang = finding({
      class: "lang-pkgs",
      pkgName: "lodash",
      purl: "pkg:npm/lodash@4.17.21",
      installedVersion: "4.17.21",
      // The declared line is major 4 and it is at head; the fix is in 5.x.
      fixedVersion: "5.0.1"
    });
    expect(
      applyScanExclusions([lang], withFacts(VENDOR, atHead), "full").excludedOrdinals
    ).toEqual([0]);
  });

  it("a fix in the SAME major is still refused — by the version join, not by a backstop", () => {
    // The half that makes dropping the backstop safe, and the reason it cost nothing real. If a fix
    // shipped INSIDE the declared major line then the line's head has moved past what is installed,
    // the org's own inventory says so, and the join refuses on that basis — from observed data
    // rather than from the scanner's opinion. `atHead` puts the line at 4.17.21, so an artifact
    // still carrying 4.17.20 misses the key no matter what `fixedVersion` says.
    const lang = finding({
      class: "lang-pkgs",
      pkgName: "lodash",
      purl: "pkg:npm/lodash@4.17.20",
      installedVersion: "4.17.20",
      fixedVersion: "4.17.21"
    });
    expect(
      applyScanExclusions([lang], withFacts(VENDOR, atHead), "full").excludedOrdinals
    ).toEqual([]);
  });

  it("a lang-pkgs finding with NO INSTALLED VERSION cannot be shown to be the one at head", () => {
    // `parseTrivyFindings` retains an entry on its severity alone, so this is a real shape. The facts
    // say which VERSION is at head; a finding that will not say which version it is gets no pass,
    // rather than falling back to matching on the name — which was the whole defect.
    //
    // WHICH MUTATION THIS ACTUALLY KILLS, measured rather than claimed: deleting the predicate's
    // `installedVersion === undefined` refusal leaves this green, because a `…|undefined` key misses
    // the set anyway. It dies against the mutation that MATTERS — degrading the lookup to a
    // name-prefix match, the pre-fix behaviour — which also kills the three cases above it.
    const findings = [
      finding({ class: "lang-pkgs", pkgName: "lodash", purl: "pkg:npm/lodash@4.17.21" })
    ];
    expect(
      applyScanExclusions(findings, withFacts(VENDOR, atHead), "full").excludedOrdinals
    ).toEqual([]);
  });

  it("a lang-pkgs finding with NO PURL yields no ecosystem and therefore NO exclusion", () => {
    const findings = [
      finding({ class: "lang-pkgs", pkgName: "lodash", installedVersion: "4.17.21" })
    ];
    expect(
      applyScanExclusions(findings, withFacts(VENDOR, atHead), "full").excludedOrdinals
    ).toEqual([]);
  });

  it("A NAME AT HEAD IN ONE ECOSYSTEM DOES NOT EXCUSE THE SAME NAME IN ANOTHER", () => {
    // The specific false positive the ecosystem qualifier exists for: `requests` is a household
    // Python distribution AND an npm package. Facts say the PYTHON one is current — and at the same
    // version, so only the ecosystem qualifier can separate them.
    const facts: ScanVendorLatestFacts = {
      baseImageAtLatest: false,
      packageKeys: [vendorLatestPackageKey("python", "requests", "2.31.0")]
    };
    const findings = [
      finding({
        class: "lang-pkgs",
        pkgName: "requests",
        purl: "pkg:npm/requests@2.31.0",
        installedVersion: "2.31.0"
      }),
      finding({
        class: "lang-pkgs",
        pkgName: "requests",
        purl: "pkg:pypi/requests@2.31.0",
        installedVersion: "2.31.0"
      })
    ];
    const applied = applyScanExclusions(findings, withFacts(VENDOR, facts), "full");
    expect(applied.excludedOrdinals).toEqual([1]);
  });

  it("python findings match through PEP 503 — the fold is applied to BOTH sides of the join", () => {
    const facts: ScanVendorLatestFacts = {
      baseImageAtLatest: false,
      packageKeys: [vendorLatestPackageKey("python", "zope.interface", "6.1")]
    };
    const findings = [
      finding({
        class: "lang-pkgs",
        pkgName: "zope_interface",
        purl: "pkg:pypi/zope-interface@6.1",
        installedVersion: "6.1"
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
    // Both carry a purl, a name AND the installed version the facts say is at head, so the ONLY
    // thing refusing them is the class arm — without that, this would pass for the wrong reason.
    const findings = [
      finding({
        class: "license",
        pkgName: "lodash",
        purl: "pkg:npm/lodash@4.17.21",
        installedVersion: "4.17.21"
      }),
      finding({ pkgName: "lodash", purl: "pkg:npm/lodash@4.17.21", installedVersion: "4.17.21" })
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
