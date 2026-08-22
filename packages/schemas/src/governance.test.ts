import { describe, expect, it } from "vitest";
import { ControlRunFindingsResponseSchema, PersistedScanFindingSchema } from "./governance.js";

/**
 * M22.9 (ADR-0033 §7) — the wire contract of `GET /control-runs/{id}/findings`.
 *
 * WHAT IS ACTUALLY AT STAKE HERE, because a response-shape test can easily be about nothing: until
 * M22.9 `scan_findings` had no reader at all, and the reader it was owed has ONE property that makes
 * it safe — the finding-set MARKER comes back with the rows and cannot be omitted. Every marker
 * state except `full` (`truncated`, `unsupported`, and ABSENT) refuses every exclusion for that
 * scan, so a consumer handed a bare array reads a partial or structurally-empty set as the whole
 * one. `findingsRecord` being REQUIRED-and-nullable is what forecloses that, and it is the first
 * thing a later "tidy the schema" edit would relax.
 *
 * MUTATIONS RUN against this file (2026-08-18) — the MEASURED results, because a green suite proves
 * nothing about whether it would have gone red. 6 tests total:
 *
 *   1. `findingsRecord: ScanFindingsRecordSchema.nullable()` -> `.nullable().optional()`
 *        -> 1 failed / 5 passed ("refuses an envelope with no marker at all"). This is exactly the
 *        defect this endpoint was built to foreclose: a reader that can hand back rows alone.
 *   2. delete `retentionClass` from `PersistedScanFindingSchema`
 *        -> 2 failed / 4 passed ("projects the ordinal and the ADR-0024 class", "refuses 'P'"). Past
 *        `SCAN_EXCLUSION_EVIDENCE_CAP` (100) these rows are the only per-finding record of what an
 *        operator chose to tolerate, so losing the class loses the accepted-risk evidence itself.
 *   3. add `pkgName: z.string().nullish()` to that same extend — the shape someone reaches for on
 *        seeing a `null` from a nullable column -> 1 failed / 5 passed ("refuses a NULL attribution
 *        column forwarded as `null`"). The columns are nullable and the wire fields are not, which
 *        is why `toPersistedScanFinding` (scan-findings-repo.ts) DROPS nulls rather than passing
 *        them through.
 */

const row = { ordinal: 0, severity: "high", retentionClass: "O" } as const;

const envelope = (over: Record<string, unknown> = {}) => ({
  findingsRecord: "full",
  items: [row],
  nextCursor: null,
  ...over
});

describe("M22.9 — the finding-set marker travels WITH the rows", () => {
  it("refuses an envelope with no marker at all", () => {
    const bare = envelope();
    delete (bare as Record<string, unknown>).findingsRecord;
    expect(ControlRunFindingsResponseSchema.safeParse(bare).success).toBe(false);
  });

  it("accepts `null` as the ABSENT marker — a positive statement, not a missing key", () => {
    const parsed = ControlRunFindingsResponseSchema.parse(envelope({ findingsRecord: null }));
    expect(parsed.findingsRecord).toBeNull();
  });

  it("carries each of the three recorded states", () => {
    for (const state of ["full", "truncated", "unsupported"] as const) {
      expect(
        ControlRunFindingsResponseSchema.parse(envelope({ findingsRecord: state })).findingsRecord
      ).toBe(state);
    }
  });
});

describe("M22.9 — one persisted finding on the wire", () => {
  it("projects the ordinal and the ADR-0024 class the WRITE decided", () => {
    const parsed = PersistedScanFindingSchema.parse({ ...row, ordinal: 41, retentionClass: "E" });
    expect(parsed.ordinal).toBe(41);
    expect(parsed.retentionClass).toBe("E");
  });

  it("refuses 'P' — no finding is permanent evidence, and the migration's CHECK agrees", () => {
    expect(PersistedScanFindingSchema.safeParse({ ...row, retentionClass: "P" }).success).toBe(
      false
    );
  });

  it("refuses a NULL attribution column forwarded as `null`", () => {
    // The columns ARE nullable (a finding is retained on `Severity` alone), so the loader must DROP
    // them rather than pass them through — `toPersistedScanFinding`, scan-findings-repo.ts.
    expect(PersistedScanFindingSchema.safeParse({ ...row, pkgName: null }).success).toBe(false);
    expect(PersistedScanFindingSchema.parse({ ...row }).pkgName).toBeUndefined();
  });
});
