import { describe, expect, it } from "vitest";
import type { PlanSourceMappingDiffEntry } from "@scp/schemas";
import { diffEntryRow } from "./cli.js";

/**
 * `scp iac plan`'s source-mapping row must show the REF (ADR-0030 §1).
 *
 * This is review integrity, not formatting. The ref is part of the mapping identity, so a prune
 * matches on it — and two mappings differing only by ref (`refs/heads/dev` → the dev pipeline,
 * `refs/heads/main` → production) render IDENTICALLY without it. An operator approving
 * "delete source-mapping github:acme/api:*" would have no way to tell which of the two routes the
 * plan is about to remove.
 */
describe("diffEntryRow: source-mapping entries carry the ref that identifies them", () => {
  const base: PlanSourceMappingDiffEntry = {
    kind: "source-mapping",
    action: "delete",
    componentUrn: "urn:scp:acme:component:api",
    sourceKind: "github",
    repoPattern: "acme/api",
    pathPattern: null,
    refPattern: null,
    type: "configuration",
    classification: null,
    reason: "no longer declared"
  };

  it("distinguishes two mappings that differ ONLY by ref", () => {
    const dev = diffEntryRow({ ...base, refPattern: "refs/heads/dev" });
    const prod = diffEntryRow({ ...base, refPattern: "refs/heads/main" });

    expect(dev.ref).toContain("refs/heads/dev");
    expect(prod.ref).toContain("refs/heads/main");
    // The whole point: these must not collide.
    expect(dev.ref).not.toBe(prod.ref);
  });

  it("renders an unset ref as the `*` wildcard, in the glob's third position", () => {
    // `*` and not omission — an absent ref means "matches any ref", which is information the
    // operator needs, and dropping the segment would make the two-glob and three-glob forms
    // ambiguous with each other.
    expect(diffEntryRow(base).ref).toContain("github:acme/api:*:*");
  });
});
