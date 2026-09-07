import { describe, expect, it } from "vitest";
import { ControlRunFindingsResponseSchema, PersistedScanFindingSchema } from "./governance.js";

/** The wire contract of the control-run findings route. See docs/schemas.md §259. */

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
