import { describe, expect, it } from "vitest";
import { ScanEvidenceSchema, ScanMethodSchema } from "./supply-chain.js";
import {
  PutScannerAssignmentRequestSchema,
  ScannerAssignmentSchema
} from "./executors.js";

/**
 * M13.3a — the scanner-method enum widening + scanner-assignment registry schemas (ADR-0020 §2).
 * These are the SCHEMA-level invariants the build rests on: the enum accepts both methods, the
 * evidence-widening is additive (a `trivy` document still parses, an `openscap` one now parses too),
 * and the registry write body validates the executor Type + methods.
 */

describe("ScanMethodSchema", () => {
  it("accepts trivy and openscap", () => {
    expect(ScanMethodSchema.safeParse("trivy").success).toBe(true);
    expect(ScanMethodSchema.safeParse("openscap").success).toBe(true);
  });

  it("rejects anything else", () => {
    expect(ScanMethodSchema.safeParse("grype").success).toBe(false);
    expect(ScanMethodSchema.safeParse("").success).toBe(false);
    expect(ScanMethodSchema.safeParse(1).success).toBe(false);
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
      PutScannerAssignmentRequestSchema.safeParse({ executorType: "image", methods: ["trivy"] }).success
    ).toBe(true);
    expect(
      PutScannerAssignmentRequestSchema.safeParse({ executorType: "container", methods: ["trivy"] })
        .success
    ).toBe(false);
  });

  it("PUT body rejects an invalid ScanMethod", () => {
    expect(
      PutScannerAssignmentRequestSchema.safeParse({ executorType: "image", methods: ["grype"] }).success
    ).toBe(false);
  });
});
