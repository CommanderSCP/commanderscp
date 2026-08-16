import { describe, expect, it } from "vitest";
import type { SourceMapping } from "@scp/schemas";
import { parseScopeFlag, sourceMappingRow } from "./cli.js";
import { tableLines } from "./output.js";

/**
 * `scp change-source list-mappings` carries a SCOPE column (§10.6, migration 0066) — `global` |
 * `domain`, BLANK when not declared. Blank and not a guess: the CLI, like the pipeline tile, never
 * infers a scope from the site it is talking to. `?` is reserved for an OLDER server whose response
 * predates the field — absence of the key is not "undeclared".
 */
describe("sourceMappingRow: the SCOPE column", () => {
  const base: SourceMapping = {
    id: "019f0000-0000-7000-8000-000000000001",
    orgId: "019f0000-0000-7000-8000-000000000000",
    sourceKind: "github",
    repoPattern: "acme/platform-iac",
    pathPattern: "asg/**",
    refPattern: null,
    componentObjectId: "019f0000-0000-7000-8000-0000000000c1",
    type: "infrastructure",
    category: "infrastructure",
    classification: null,
    mirrorOfShared: false,
    enabled: true,
    disabledUntil: null,
    effectivelyEnabled: true,
    scope: null,
    createdAt: "2026-08-16T00:00:00.000Z"
  };

  it("prints a declared scope verbatim", () => {
    expect(sourceMappingRow({ ...base, scope: "global" }).scope).toBe("global");
    expect(sourceMappingRow({ ...base, scope: "domain" }).scope).toBe("domain");
  });

  it("prints BLANK for a scope that is not declared (null) — never a guessed value", () => {
    expect(sourceMappingRow(base).scope).toBe("");
  });

  it("prints `?` when the scope key is ABSENT (defensive: unreachable through the SDK, whose response validator requires it — a hand-built row must not crash the table)", () => {
    const legacy = { ...base } as Partial<SourceMapping>;
    delete legacy.scope;
    expect(sourceMappingRow(legacy as SourceMapping).scope).toBe("?");
  });

  it("the table has a SCOPE header, and the undeclared row's cell is empty in it", () => {
    const lines = tableLines([
      sourceMappingRow({ ...base, scope: "global" }),
      sourceMappingRow({ ...base, id: "019f0000-0000-7000-8000-000000000002" })
    ]);
    expect(lines[0]).toContain("SCOPE");
    expect(lines[1]).toContain("global");
    // The second row is the undeclared one: its scope cell is blank, so the literal never appears.
    expect(lines[2]).not.toContain("global");
    expect(lines[2]).not.toContain("domain");
  });

  it("keeps the routing identity readable beside it: repo/path/ref with `*` for match-any", () => {
    const row = sourceMappingRow({ ...base, pathPattern: null });
    expect(row.repo).toBe("acme/platform-iac");
    expect(row.path).toBe("*");
    expect(row.ref).toBe("*");
  });
});

describe("parseScopeFlag: --scope global|domain|none", () => {
  it("accepts the two declared values", () => {
    expect(parseScopeFlag("global")).toBe("global");
    expect(parseScopeFlag("domain")).toBe("domain");
  });

  it("maps `none` to null — the CLEAR the sibling PATCH takes", () => {
    expect(parseScopeFlag("none")).toBeNull();
  });

  it("refuses anything else by name — a typo is a usage error, never silently 'undeclared'", () => {
    expect(() => parseScopeFlag("regional")).toThrow(/global\|domain\|none/);
    expect(() => parseScopeFlag("")).toThrow(/global\|domain\|none/);
  });
});
