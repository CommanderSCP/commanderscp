import { describe, expect, it } from "vitest";
import {
  SCAN_FINDINGS_PERSIST_CAP,
  SCAN_FINDINGS_TRANSPORT_KEY,
  SCAN_FINDINGS_TRUNCATED_TRANSPORT_KEY,
  ScanEvidenceSchema,
  attachScanFindingsForTransport,
  capScanFindings,
  parseTrivyFindings,
  scanFindingRetentionClass,
  scanFindingsRecordFor,
  scanMethodCarriesFindings,
  severityCountsFromFindings,
  takeScanFindingsFromTransport,
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
    // Everything else is preserved verbatim.
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
