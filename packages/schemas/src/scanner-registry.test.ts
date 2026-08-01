import { describe, expect, it } from "vitest";
import { ScanEvidenceSchema, ScanMethodSchema, usesTrivyDb } from "./supply-chain.js";
import { PutScannerAssignmentRequestSchema, ScannerAssignmentSchema } from "./executors.js";

/**
 * M13.3a — the scanner-method enum widening + scanner-assignment registry schemas (ADR-0020 §2).
 * These are the SCHEMA-level invariants the build rests on: the enum accepts every shipped method
 * (`trivy`, `openscap`, and the 13.3a machine-image arm `trivy-vm`), the evidence-widening is
 * additive (a `trivy` document still parses, the newer ones parse too), the Trivy-DB predicate
 * classifies every enum member, and the registry write body validates the executor Type + methods.
 */

describe("ScanMethodSchema", () => {
  it("accepts trivy, openscap and trivy-vm", () => {
    expect(ScanMethodSchema.safeParse("trivy").success).toBe(true);
    expect(ScanMethodSchema.safeParse("openscap").success).toBe(true);
    // 13.3a machine-image arm.
    expect(ScanMethodSchema.safeParse("trivy-vm").success).toBe(true);
  });

  it("rejects anything else", () => {
    expect(ScanMethodSchema.safeParse("grype").success).toBe(false);
    expect(ScanMethodSchema.safeParse("").success).toBe(false);
    expect(ScanMethodSchema.safeParse(1).success).toBe(false);
    // Near-misses on the new value — the enum is exact, not prefix-matched.
    expect(ScanMethodSchema.safeParse("trivy-vm-experimental").success).toBe(false);
    expect(ScanMethodSchema.safeParse("trivyvm").success).toBe(false);
  });
});

/**
 * `usesTrivyDb` is the ONE predicate every Trivy-DB-dependent concern routes through (the M13.3b-ii
 * offline pre-load seam, the staleness gate, the `scanDb*` evidence fields). Its whole reason to
 * exist is that a `method === "trivy"` comparison would let the machine-image arm slip past the
 * staleness gate and scan against an unclassified DB — so it is pinned EXHAUSTIVELY over the enum:
 * a new method added without a decision about its DB dependence fails here, not in production.
 */
describe("usesTrivyDb — exhaustive over ScanMethodSchema", () => {
  it("is true for every Trivy-family method and false for OpenSCAP", () => {
    expect(usesTrivyDb("trivy")).toBe(true);
    expect(usesTrivyDb("trivy-vm")).toBe(true);
    expect(usesTrivyDb("openscap")).toBe(false);
  });

  it("classifies EVERY enum member (no method is left unclassified)", () => {
    const classified = new Set(["trivy", "trivy-vm", "openscap"]);
    expect([...ScanMethodSchema.options].sort()).toEqual([...classified].sort());
  });
});

describe("ScanEvidenceSchema.scanner widening (ADDITIVE, gate-invisible)", () => {
  const base = {
    scannerVersion: "0.50.0",
    artifactDigest: "sha256:" + "a".repeat(64),
    expectedDigest: "sha256:" + "a".repeat(64),
    digestMatch: true,
    severityCounts: { critical: 0, high: 0, medium: 0, low: 0 },
    threshold: { maxCritical: 0, maxHigh: 0 }
  } as const;

  it("still accepts scanner: 'trivy' unchanged (the E6 gate fixture never regresses)", () => {
    const parsed = ScanEvidenceSchema.safeParse({ ...base, scanner: "trivy" });
    expect(parsed.success).toBe(true);
  });

  it("now accepts scanner: 'openscap' (the widening)", () => {
    const parsed = ScanEvidenceSchema.safeParse({ ...base, scanner: "openscap" });
    expect(parsed.success).toBe(true);
  });

  it("now accepts scanner: 'trivy-vm' (the machine-image arm, 13.3a)", () => {
    const parsed = ScanEvidenceSchema.safeParse({ ...base, scanner: "trivy-vm" });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown scanner", () => {
    expect(ScanEvidenceSchema.safeParse({ ...base, scanner: "grype" }).success).toBe(false);
  });
});

describe("scanner-assignment registry schemas", () => {
  it("validates a well-formed assignment", () => {
    const parsed = ScannerAssignmentSchema.safeParse({
      executorType: "image",
      methods: ["trivy"],
      updatedAt: new Date().toISOString()
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts an empty methods set (a Type with no managed scanner — fail-closed)", () => {
    const parsed = ScannerAssignmentSchema.safeParse({
      executorType: "configuration",
      methods: [],
      updatedAt: new Date().toISOString()
    });
    expect(parsed.success).toBe(true);
  });

  it("PUT body requires a valid ExecutorType", () => {
    expect(
      PutScannerAssignmentRequestSchema.safeParse({ executorType: "image", methods: ["trivy"] })
        .success
    ).toBe(true);
    expect(
      PutScannerAssignmentRequestSchema.safeParse({ executorType: "container", methods: ["trivy"] })
        .success
    ).toBe(false);
  });

  it("PUT body rejects an invalid ScanMethod", () => {
    expect(
      PutScannerAssignmentRequestSchema.safeParse({ executorType: "image", methods: ["grype"] })
        .success
    ).toBe(false);
  });

  it("accepts the machine-image assignment the 0048 seed writes (infrastructure -> trivy-vm)", () => {
    expect(
      PutScannerAssignmentRequestSchema.safeParse({
        executorType: "infrastructure",
        methods: ["trivy-vm"]
      }).success
    ).toBe(true);
  });
});
