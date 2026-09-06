import { describe, expect, it } from "vitest";
import {
  SCAN_EXCLUSION_EVIDENCE_CAP,
  SCAN_FINDINGS_PERSIST_CAP,
  SCAN_FINDINGS_TRANSPORT_KEY,
  SCAN_FINDINGS_TRUNCATED_TRANSPORT_KEY,
  ScanEvidenceSchema,
  ScanExclusionClauseSchema,
  ScanExclusionEffectSchema,
  applyScanExclusions,
  attachScanFindingsForTransport,
  capScanFindings,
  effectiveSeverityCountsAfterExclusions,
  parseTrivyFindings,
  scanFindingRetentionClass,
  scanFindingsRecordFor,
  scanMethodCarriesFindings,
  severityCountsFromFindings,
  takeScanFindingsFromTransport,
  type AdmittedScanExclusionClause,
  type ScanExclusionClause,
  type ScanFinding
} from "./supply-chain.js";

/**
 * M22.1b (ADR-0033 §7) — the pure half of "persist the findings": the cap, the record marker, the
 * per-row retention class, and the plugin→server transport seam.
 *
 * MUTATIONS RUN against this file (2026-08-17) — the MEASURED results, not predicted ones, because a
 * green suite proves nothing about whether it would have gone red:
 *
 *   1. `scanMethodCarriesFindings` returning `true` for `openscap`  -> 3 failed / 14 passed
 *        ("says so about the METHOD", "refuses an openscap set that DOES arrive with findings",
 *        "full / truncated / unsupported / ABSENT"). The mutation that matters most: it is the one
 *        an implementer makes by writing `return true` or by deriving the answer from
 *        `findings.length`.
 *   2. `capScanFindings` returning `truncated: false` unconditionally -> 3 failed / 14 passed
 *        ("caps a set OVER the cap", "the production cap is a real bound", "RE-CAPS server-side").
 *   3. `takeScanFindingsFromTransport` returning the evidence unchanged (no `delete`)
 *        -> 2 failed / 15 passed ("the transport keys DO NOT SURVIVE the read", "a MALFORMED payload
 *        records nothing"). That first one is the property that keeps findings out of the bundle.
 *   4. `scanFindingsRecordFor` returning `"full"` for `capped === undefined` -> 1 failed / 16 passed.
 *   5. `scanFindingRetentionClass` returning `"E"` unconditionally -> 1 failed / 16 passed.
 */

const finding = (over: Partial<ScanFinding> = {}): ScanFinding => ({
  severity: "high",
  vulnerabilityId: "CVE-2026-0001",
  pkgName: "openssl",
  ...over
});

describe("M22.1b — the per-scan cap", () => {
  it("keeps a set at or under the cap intact and reports it untruncated", () => {
    const findings = Array.from({ length: 5 }, () => finding());
    const capped = capScanFindings(findings, 5);
    expect(capped.findings).toHaveLength(5);
    expect(capped.truncated).toBe(false);
  });

  it("caps a set OVER the cap and reports truncated, in parse order", () => {
    const findings = Array.from({ length: 7 }, (_, i) =>
      finding({ vulnerabilityId: `CVE-2026-000${i}` })
    );
    const capped = capScanFindings(findings, 3);
    expect(capped.truncated).toBe(true);
    expect(capped.findings.map((f) => f.vulnerabilityId)).toEqual([
      "CVE-2026-0000",
      "CVE-2026-0001",
      "CVE-2026-0002"
    ]);
  });

  it("does not move severityCounts — the cap bounds what is PERSISTED, never what was FOUND", () => {
    const findings = [
      ...Array.from({ length: 4 }, () => finding({ severity: "critical" })),
      ...Array.from({ length: 6 }, () => finding({ severity: "low" }))
    ];
    // Counts are derived from the FULL set, before any capping.
    expect(severityCountsFromFindings(findings)).toEqual({
      critical: 4,
      high: 0,
      medium: 0,
      low: 6
    });
    const capped = capScanFindings(findings, 2);
    expect(capped.findings).toHaveLength(2);
    // The counts object above is untouched by capping — the two are computed from different inputs
    // on purpose, which is what lets `severityCounts` keep meaning "what the scanner found".
    expect(severityCountsFromFindings(findings)).toEqual({
      critical: 4,
      high: 0,
      medium: 0,
      low: 6
    });
  });

  it("the production cap is a real bound, not a placeholder that never trims", () => {
    const findings = Array.from({ length: SCAN_FINDINGS_PERSIST_CAP + 1 }, () => finding());
    const capped = capScanFindings(findings);
    expect(capped.findings).toHaveLength(SCAN_FINDINGS_PERSIST_CAP);
    expect(capped.truncated).toBe(true);
  });
});

describe("M22.1b — OpenSCAP can NEVER carry findings (ADR-0033 Context 4)", () => {
  it("says so about the METHOD", () => {
    expect(scanMethodCarriesFindings("trivy")).toBe(true);
    expect(scanMethodCarriesFindings("trivy-vm")).toBe(true);
    expect(scanMethodCarriesFindings("openscap")).toBe(false);
  });

  it("refuses an openscap set that DOES arrive with findings — by method, not by emptiness", () => {
    // The distinction ADR-0033's consequences list demands be explicit "and tested, not left to
    // 'there were no findings to exclude'". A non-empty array is handed in deliberately: if the
    // refusal were `findings.length === 0` this case would report `full`.
    const capped = capScanFindings([finding(), finding()]);
    expect(capped.findings).toHaveLength(2);
    expect(scanFindingsRecordFor("openscap", capped)).toBe("unsupported");
  });

  it("negative control: the same non-empty set under trivy IS recorded", () => {
    const capped = capScanFindings([finding(), finding()]);
    expect(scanFindingsRecordFor("trivy", capped)).toBe("full");
  });
});

describe("M22.1b — the record marker distinguishes four states", () => {
  it("full / truncated / unsupported / ABSENT", () => {
    expect(scanFindingsRecordFor("trivy", { findings: [finding()], truncated: false })).toBe(
      "full"
    );
    // A trivy scan that genuinely found NOTHING is a `full` record of an empty set — a materially
    // different claim from "this scanner cannot have findings".
    expect(scanFindingsRecordFor("trivy", { findings: [], truncated: false })).toBe("full");
    expect(scanFindingsRecordFor("trivy", { findings: [finding()], truncated: true })).toBe(
      "truncated"
    );
    expect(scanFindingsRecordFor("openscap", { findings: [], truncated: false })).toBe(
      "unsupported"
    );
    // Nothing transported at all — a pre-M22.1b producer, or a malformed payload. ABSENT, which a
    // consumer must refuse exclusions for exactly as it does `truncated`.
    expect(scanFindingsRecordFor("trivy", undefined)).toBeUndefined();
  });

  it("the marker is accepted by ScanEvidenceSchema and is OPTIONAL there", () => {
    const base = {
      scanner: "trivy" as const,
      scannerVersion: "0.50.0",
      artifactDigest: "sha256:aa",
      expectedDigest: "sha256:aa",
      digestMatch: true,
      severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
      threshold: { maxCritical: 0, maxHigh: 0 }
    };
    // Pre-M22.1b documents still parse — the ABSENT state.
    expect(ScanEvidenceSchema.parse(base).findingsRecord).toBeUndefined();
    expect(ScanEvidenceSchema.parse({ ...base, findingsRecord: "truncated" }).findingsRecord).toBe(
      "truncated"
    );
  });
});

describe("M22.1b — retention class is assigned PER ROW (ADR-0024 §D1, ADR-0033 D10)", () => {
  it("an ordinary finding is telemetry (O); an excluded one is accepted-risk evidence (E)", () => {
    expect(scanFindingRetentionClass(false)).toBe("O");
    expect(scanFindingRetentionClass(true)).toBe("E");
  });
});

describe("M22.1b — the plugin→server transport seam", () => {
  it("round-trips findings a plugin cannot persist itself", () => {
    const findings = [finding({ pkgName: "libssl" }), finding({ severity: "low" })];
    const wire = attachScanFindingsForTransport({ severityCounts: {} }, capScanFindings(findings));
    const taken = takeScanFindingsFromTransport(wire);
    expect(taken.capped?.findings).toEqual(findings);
    expect(taken.capped?.truncated).toBe(false);
  });

  it("the transport keys DO NOT SURVIVE the read — this is what keeps findings out of the bundle", () => {
    const wire = attachScanFindingsForTransport(
      { severityCounts: { critical: 0, high: 1, medium: 0, low: 0 } },
      capScanFindings([finding()])
    );
    expect(wire).toHaveProperty(SCAN_FINDINGS_TRANSPORT_KEY);
    expect(wire).toHaveProperty(SCAN_FINDINGS_TRUNCATED_TRANSPORT_KEY);

    const taken = takeScanFindingsFromTransport(wire);
    expect(taken.evidence).not.toHaveProperty(SCAN_FINDINGS_TRANSPORT_KEY);
    expect(taken.evidence).not.toHaveProperty(SCAN_FINDINGS_TRUNCATED_TRANSPORT_KEY);
    expect(taken.evidence).toEqual({ severityCounts: { critical: 0, high: 1, medium: 0, low: 0 } });
    // And the source object was not mutated in place — the caller's copy is still whole.
    expect(wire).toHaveProperty(SCAN_FINDINGS_TRANSPORT_KEY);
  });

  it("preserves a producer's truncation flag across the wire", () => {
    const wire = attachScanFindingsForTransport({}, { findings: [finding()], truncated: true });
    expect(takeScanFindingsFromTransport(wire).capped?.truncated).toBe(true);
  });

  it("RE-CAPS server-side: a plugin cannot steer how many rows land", () => {
    // Deliberately bypasses `capScanFindings` — a buggy or tampered plugin process attaching more
    // than the cap. The server re-caps and reports truncation itself.
    const wire = {
      [SCAN_FINDINGS_TRANSPORT_KEY]: Array.from({ length: SCAN_FINDINGS_PERSIST_CAP + 3 }, () =>
        finding()
      ),
      [SCAN_FINDINGS_TRUNCATED_TRANSPORT_KEY]: false
    };
    const taken = takeScanFindingsFromTransport(wire);
    expect(taken.capped?.findings).toHaveLength(SCAN_FINDINGS_PERSIST_CAP);
    expect(taken.capped?.truncated).toBe(true);
  });

  it("a MALFORMED payload records nothing rather than something wrong", () => {
    const taken = takeScanFindingsFromTransport({
      [SCAN_FINDINGS_TRANSPORT_KEY]: [{ severity: "spicy" }]
    });
    expect(taken.capped).toBeUndefined();
    // Still stripped — a malformed payload must not survive onto the persisted evidence either.
    expect(taken.evidence).not.toHaveProperty(SCAN_FINDINGS_TRANSPORT_KEY);
  });

  it("evidence with no transport key at all is returned untouched, with no findings", () => {
    const taken = takeScanFindingsFromTransport({ status: "ok" });
    expect(taken.capped).toBeUndefined();
    expect(taken.evidence).toEqual({ status: "ok" });
  });

  it("survives the JSON round-trip the plugin-host RPC actually performs", () => {
    const findings = parseTrivyFindings({
      Results: [
        {
          Class: "os-pkgs",
          Target: "alpine:3.20",
          Vulnerabilities: [
            {
              Severity: "CRITICAL",
              VulnerabilityID: "CVE-2026-9",
              PkgName: "zlib",
              PkgIdentifier: { PURL: "pkg:apk/alpine/zlib@1.3" }
            }
          ]
        }
      ]
    });
    const wire = attachScanFindingsForTransport({ scanner: "trivy" }, capScanFindings(findings));
    const overRpc = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
    const taken = takeScanFindingsFromTransport(overRpc);
    expect(taken.capped?.findings).toEqual([
      {
        severity: "critical",
        vulnerabilityId: "CVE-2026-9",
        pkgName: "zlib",
        class: "os-pkgs",
        target: "alpine:3.20",
        purl: "pkg:apk/alpine/zlib@1.3"
      }
    ]);
  });
});

// ===========================================================================================
// M22.2 (ADR-0033 §1–§4, §7) — the EXCLUSION dimension's pure half: what a clause reaches, what
// refuses one outright, and how the post-exclusion count is derived.
//
// MUTATIONS RUN against this file (2026-08-17), each reverted by an exact inverse edit. MEASURED
// results; baseline 33 passed. The WIRING mutations live in the header of
// `apps/server/src/governance/scan-exclusions.integration.test.ts`.
//
//   S-1  skip the `record !== "full"` refusal entirely
//          -> 4 failed (truncated refuses / OpenSCAP never excluded / an ABSENT record refuses /
//             a truncated scan's effective counts equal its raw counts).
//   S-2  give the not-yet-built classes a predicate (`() => true`)
//          -> 1 failed ("a clause of a class whose PREDICATE is not yet built").
//   S-3  stop decrementing in `effectiveSeverityCountsAfterExclusions`
//          -> 1 failed ("effectiveSeverityCounts is severityCounts MINUS the excluded").
//   S-4  drop the `pkgName` matcher comparison
//          -> 2 failed (A MATCHER MISS / a finding that LACKS the field a clause names).
// ===========================================================================================

describe("M22.2: applying exclusion clauses to findings", () => {
  const admitted = (
    clause: ScanExclusionClause,
    over: Partial<AdmittedScanExclusionClause> = {}
  ): AdmittedScanExclusionClause => ({
    clause,
    tier: "org",
    source: "policy:secops@p1",
    admittedBy: [{ tier: "platform", source: "instance:platform:local" }],
    ...over
  });

  /** The base `finding()` helper above carries NO `fixedVersion`, so these two spell the
   *  distinction out rather than relying on it: `fixable` has one, `noFix` deliberately does not. */
  const fixable = (over: Partial<ScanFinding> = {}): ScanFinding =>
    finding({ fixedVersion: "1.1.1t", ...over });
  const noFix = (over: Partial<ScanFinding> = {}): ScanFinding => {
    const { fixedVersion: _drop, ...rest } = finding(over);
    return rest as ScanFinding;
  };

  it("with NO clauses, nothing is excluded and NO evidence key is produced at all", () => {
    // The byte-identical default. An `exclusions` key on a deployment with nothing authored would
    // change every evidence document (and every promotion bundle) on the day this ships.
    const findings = [fixable(), noFix()];
    const applied = applyScanExclusions(findings, undefined, "full");
    expect(applied.findings).toEqual(findings);
    expect(applied.excludedOrdinals).toEqual([]);
    expect(applied.evidence).toBeUndefined();
    expect(applyScanExclusions(findings, { clauses: [] }, "full").evidence).toBeUndefined();
  });

  it("a `no_fix_available` clause excludes ONLY the findings with no FixedVersion", () => {
    const findings = [fixable(), noFix({ vulnerabilityId: "CVE-2026-2" }), fixable()];
    const applied = applyScanExclusions(
      findings,
      { clauses: [admitted({ class: "no_fix_available" })] },
      "full"
    );
    expect(applied.excludedOrdinals).toEqual([1]);
    expect(applied.findings).toHaveLength(2);
    expect(applied.evidence?.appliedCount).toBe(1);
    expect(applied.evidence?.applied[0]).toMatchObject({
      ordinal: 1,
      class: "no_fix_available",
      tier: "org",
      source: "policy:secops@p1",
      vulnerabilityId: "CVE-2026-2"
    });
  });

  it("A MATCHER MISS YIELDS NO EXCLUSION — the opposite sign from the ceiling's fail-closed miss", () => {
    const findings = [noFix({ pkgName: "openssl" })];
    const missed = applyScanExclusions(
      findings,
      { clauses: [admitted({ class: "no_fix_available", pkgName: "zlib" })] },
      "full"
    );
    expect(missed.excludedOrdinals).toEqual([]);
    expect(missed.evidence?.appliedCount).toBe(0);
    // Negative control: the same clause naming the package that is actually there DOES exclude.
    const hit = applyScanExclusions(
      findings,
      { clauses: [admitted({ class: "no_fix_available", pkgName: "openssl" })] },
      "full"
    );
    expect(hit.excludedOrdinals).toEqual([0]);
  });

  it("a finding that LACKS the field a clause names never matches it", () => {
    // `ScanFindingSchema` makes nearly every field optional because an entry is counted on Severity
    // alone. An unidentifiable finding is therefore one no clause can reach — and it still counts.
    const applied = applyScanExclusions(
      [{ severity: "high" }],
      { clauses: [admitted({ class: "no_fix_available", pkgName: "openssl" })] },
      "full"
    );
    expect(applied.excludedOrdinals).toEqual([]);
  });

  it("EVERY matcher a clause carries must match — they narrow, they never widen", () => {
    const findings = [noFix({ pkgName: "openssl", class: "os-pkgs" })];
    const wrongClass = applyScanExclusions(
      findings,
      {
        clauses: [
          admitted({ class: "no_fix_available", pkgName: "openssl", findingClass: "lang-pkgs" })
        ]
      },
      "full"
    );
    expect(wrongClass.excludedOrdinals).toEqual([]);
  });

  it("a clause of a class whose PREDICATE is not yet built excludes NOTHING", () => {
    // `vendor_latest`, `declared_fact` and `approved_override` need machinery M22.4–M22.6 build.
    // Until then a clause of that class is admitted (that is a separate question) and matches
    // nothing — degrading to "the matchers alone" would exclude a strictly larger set today than
    // the day the real predicate lands.
    for (const cls of ["vendor_latest", "declared_fact", "approved_override"] as const) {
      const applied = applyScanExclusions(
        [noFix({ pkgName: "openssl" })],
        { clauses: [admitted({ class: cls, pkgName: "openssl" })] },
        "full"
      );
      expect(applied.excludedOrdinals, `${cls} must exclude nothing yet`).toEqual([]);
    }
  });

  it("A TRUNCATED finding set REFUSES EVERY exclusion, and says so", () => {
    const findings = [noFix()];
    const applied = applyScanExclusions(
      findings,
      { clauses: [admitted({ class: "no_fix_available" })] },
      "truncated"
    );
    expect(applied.excludedOrdinals).toEqual([]);
    expect(applied.findings).toEqual(findings);
    expect(applied.evidence).toEqual({
      clauseCount: 1,
      appliedCount: 0,
      applied: [],
      refused: "truncated"
    });
  });

  it("AN OPENSCAP VERDICT CAN NEVER BE EXCLUDED FROM — refused by WHAT SCANNED, never by an empty set", () => {
    // The refusal must survive a NON-EMPTY findings array. A guard keyed on "there were no findings
    // to exclude" would pass this test's inverse and be fail-open the day a runner shim emitted
    // something for OpenSCAP.
    const applied = applyScanExclusions(
      [noFix({ pkgName: "openssl" })],
      { clauses: [admitted({ class: "no_fix_available" })] },
      scanFindingsRecordFor("openscap", capScanFindings([noFix({ pkgName: "openssl" })]))
    );
    expect(applied.excludedOrdinals).toEqual([]);
    expect(applied.evidence?.refused).toBe("unsupported");
  });

  it("AN ABSENT record (every pre-M22.1b verdict) refuses too — `not_recorded`, stated positively", () => {
    const applied = applyScanExclusions(
      [noFix()],
      { clauses: [admitted({ class: "no_fix_available" })] },
      undefined
    );
    expect(applied.evidence?.refused).toBe("not_recorded");
    expect(applied.excludedOrdinals).toEqual([]);
  });

  it("the applied ENUMERATION is capped while `appliedCount` stays EXACT", () => {
    // Evidence is copied verbatim into every signed promotion bundle, so the list is bounded — but
    // the count an operator reads must never be the bounded one.
    const findings = Array.from({ length: SCAN_EXCLUSION_EVIDENCE_CAP + 5 }, () => noFix());
    const applied = applyScanExclusions(
      findings,
      { clauses: [admitted({ class: "no_fix_available" })] },
      "full"
    );
    expect(applied.evidence?.appliedCount).toBe(SCAN_EXCLUSION_EVIDENCE_CAP + 5);
    expect(applied.evidence?.applied).toHaveLength(SCAN_EXCLUSION_EVIDENCE_CAP);
    expect(applied.excludedOrdinals).toHaveLength(SCAN_EXCLUSION_EVIDENCE_CAP + 5);
  });

  it("effectiveSeverityCounts is severityCounts MINUS the excluded, per severity", () => {
    const findings = [
      noFix({ severity: "critical" }),
      fixable({ severity: "critical" }),
      noFix({ severity: "high" }),
      fixable({ severity: "low" })
    ];
    const counts = severityCountsFromFindings(findings);
    expect(counts).toEqual({ critical: 2, high: 1, medium: 0, low: 1 });
    const applied = applyScanExclusions(
      findings,
      { clauses: [admitted({ class: "no_fix_available" })] },
      "full"
    );
    expect(effectiveSeverityCountsAfterExclusions(counts, applied, findings)).toEqual({
      critical: 1,
      high: 0,
      medium: 0,
      low: 1
    });
  });

  it("a TRUNCATED scan's effective counts equal its raw counts — the delta, not a recount", () => {
    // A recount of the SURVIVORS would report the capped subset's numbers, which are smaller than
    // what the scanner found. Because a truncated set excludes nothing, the delta is zero and the
    // two counts stay identical — the property a recount would silently break.
    const findings = Array.from({ length: SCAN_FINDINGS_PERSIST_CAP + 10 }, () =>
      noFix({ severity: "high" })
    );
    const counts = severityCountsFromFindings(findings);
    const capped = capScanFindings(findings);
    const applied = applyScanExclusions(
      capped.findings,
      { clauses: [admitted({ class: "no_fix_available" })] },
      scanFindingsRecordFor("trivy", capped)
    );
    expect(applied.evidence?.refused).toBe("truncated");
    expect(effectiveSeverityCountsAfterExclusions(counts, applied, capped.findings)).toEqual(
      counts
    );
  });

  it("the excluded ORDINALS survive the transport and are re-validated server-side", () => {
    const findings = [fixable(), noFix()];
    const wire = attachScanFindingsForTransport(
      { scanner: "trivy" },
      capScanFindings(findings),
      // `99` is past the end — a buggy or tampered producer must not be able to promote a row that
      // does not exist to accepted-risk retention.
      [1, 99]
    );
    const overRpc = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
    const taken = takeScanFindingsFromTransport(overRpc);
    expect(taken.excludedOrdinals).toEqual([1]);
    expect(taken.evidence).not.toHaveProperty("$scanFindingsExcluded");
  });

  it("no excluded ordinals means no transport key at all", () => {
    const wire = attachScanFindingsForTransport({ scanner: "trivy" }, capScanFindings([finding()]));
    expect(wire).not.toHaveProperty("$scanFindingsExcluded");
    expect(takeScanFindingsFromTransport(wire).excludedOrdinals).toEqual([]);
  });

  it("retention class splits by role: an EXCLUDED finding is `E`, an ordinary one `O`", () => {
    expect(scanFindingRetentionClass(true)).toBe("E");
    expect(scanFindingRetentionClass(false)).toBe("O");
  });

  it("a clause with an unknown key is REFUSED, not silently widened", () => {
    // The strictObject is the whole guard: a stripped narrowing key leaves FEWER matchers, and for
    // a loosening fewer matchers is a WIDENING.
    expect(
      ScanExclusionClauseSchema.safeParse({ class: "no_fix_available", pkgNmae: "openssl" }).success
    ).toBe(false);
    expect(ScanExclusionEffectSchema.safeParse({ admitt: ["no_fix_available"] }).success).toBe(
      false
    );
  });
});
