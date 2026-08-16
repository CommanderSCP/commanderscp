import { describe, expect, it } from "vitest";
import { cellText, tableLines } from "./output.js";

/**
 * The table printer owns cell coercion. Before this, `printTable` typed rows as
 * `Record<string, string>` while 22 call sites handed it raw API objects through a cast; the first
 * numeric field (`scp federation import` → `appliedEntries`) crashed with `v.padEnd is not a
 * function` — AFTER the import had already applied server-side, so the operator saw an error for a
 * command that had succeeded. The property is "a cell that is not a string", not "the import
 * command", so the fixture below is the whole class: number, 0, boolean, false, null, undefined,
 * nested object, array.
 */
describe("cellText: every JSON value becomes printable text", () => {
  it("numbers and booleans print canonically — 0 and false are VALUES, not absences", () => {
    expect(cellText(381)).toBe("381");
    expect(cellText(0)).toBe("0");
    expect(cellText(true)).toBe("true");
    expect(cellText(false)).toBe("false");
    expect(cellText(10n)).toBe("10");
  });

  it("null and undefined are blank — the printer's long-standing convention for an absent field", () => {
    expect(cellText(null)).toBe("");
    expect(cellText(undefined)).toBe("");
  });

  it("nested objects and arrays print as compact JSON, never `[object Object]`", () => {
    expect(cellText({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
    expect(cellText(["x", 2])).toBe('["x",2]');
    expect(cellText({ a: 1 })).not.toContain("[object");
  });

  it("strings pass through untouched", () => {
    expect(cellText("seq 381")).toBe("seq 381");
    expect(cellText("")).toBe("");
  });
});

describe("tableLines: the `scp federation import` result (numeric columns) renders instead of throwing", () => {
  const importResult = {
    peerDomainId: "019fece9-92b3-77f2-ba05-6ddb3aaf0791",
    appliedEntries: 0,
    skippedEntries: 381,
    lastAppliedSequence: 381,
    kind: "sync"
  };

  it("does not throw and pads every column to its widest cell", () => {
    const lines = tableLines([importResult]);
    expect(lines).toHaveLength(2);
    const [header, row] = lines as [string, string];
    expect(header).toBe(
      ["PEERDOMAINID".padEnd(36), "APPLIEDENTRIES", "SKIPPEDENTRIES", "LASTAPPLIEDSEQUENCE", "KIND"].join(
        "  "
      )
    );
    // Numeric cells are text now; 0 is printed, not blanked.
    expect(row).toContain("019fece9-92b3-77f2-ba05-6ddb3aaf0791  0");
    expect(row).toContain("381");
    expect(row.endsWith("sync")).toBe(true);
  });

  it("a mixed row (bool, null, nested, number) prints one text cell per column", () => {
    const lines = tableLines([{ ok: true, missing: null, detail: { n: 1 }, count: 2 }]);
    // Every column is padded to max(header, widest cell) — including the last one (existing
    // behaviour, kept): OK→4, MISSING→7, DETAIL→7 ('{"n":1}'), COUNT→5.
    expect(lines[1]).toBe(["true", "       ", '{"n":1}', "2    "].join("  "));
  });

  it("no rows still says so", () => {
    expect(tableLines([])).toEqual(["(no results)"]);
  });
});
