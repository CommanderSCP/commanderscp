import { describe, expect, it } from "vitest";
import { heldInputsCaption, heldInputsSummary } from "./outpost-dashboard";

/** pipeline-substrate-registry-scan.md §10.6 on the OUTPOST DASHBOARD. See docs/web.md §388. */
describe("outpost dashboard §10.6: held inputs are counted, labels are READ", () => {
  it("no mappings → 'no inputs held here yet' — never 'no domain-specific inputs' (nothing was declared)", () => {
    const summary = heldInputsSummary([]);
    expect(summary).toEqual({ held: 0, domain: 0, global: 0, mirrors: 0 });
    const caption = heldInputsCaption(summary);
    expect(caption).toBe("shared · no inputs held here yet");
    expect(caption).not.toContain("domain-specific");
  });

  it("undeclared mappings → the held count alone, NO scope label (nothing inferred from the site)", () => {
    const summary = heldInputsSummary([
      { scope: null, mirrorOfShared: false },
      { scope: null, mirrorOfShared: false }
    ]);
    expect(summary).toEqual({ held: 2, domain: 0, global: 0, mirrors: 0 });
    const caption = heldInputsCaption(summary);
    expect(caption).toBe("shared · 2 inputs held here");
    expect(caption).not.toContain("domain-specific");
    expect(caption).not.toContain("global");
  });

  it("declared labels are counted off each row: domain / global / mirror, orthogonally", () => {
    const summary = heldInputsSummary([
      { scope: "domain", mirrorOfShared: false },
      { scope: "domain", mirrorOfShared: true },
      { scope: "global", mirrorOfShared: false },
      { scope: null, mirrorOfShared: false }
    ]);
    expect(summary).toEqual({ held: 4, domain: 2, global: 1, mirrors: 1 });
    expect(heldInputsCaption(summary)).toBe(
      "shared · 4 inputs held here (2 domain-specific, 1 global, 1 mirror of global)"
    );
  });

  it("singular/plural read naturally", () => {
    expect(heldInputsCaption(heldInputsSummary([{ scope: "domain", mirrorOfShared: false }]))).toBe(
      "shared · 1 input held here (1 domain-specific)"
    );
    expect(
      heldInputsCaption(
        heldInputsSummary([
          { scope: null, mirrorOfShared: true },
          { scope: null, mirrorOfShared: true }
        ])
      )
    ).toBe("shared · 2 inputs held here (2 mirrors of global)");
  });
});
