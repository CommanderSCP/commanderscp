import { describe, expect, it } from "vitest";
import type { PlanDiff, PlanSourceMappingDiffEntry } from "@scp/schemas";
import { diffEntryRow, planDiffEntries } from "./cli.js";

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
    mirrorOfShared: false,
    enabled: true,
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

/**
 * NOTHING `computePlanDiff` COMPUTES MAY BE INVISIBLE IN `scp plan`.
 *
 * The summary counters are computed over EVERY collection, but the table used to be built from four
 * of them. A plan whose only content was a `governanceMoveRungs` delete therefore printed an EMPTY
 * table under `creates=0 updates=0 deletes=1 noops=0` — the table and the summary contradicting each
 * other, with the missing row being the one that says "this DISABLES the governance:move bar on
 * service X". That is the worst omission of the three, because a disabled bar's symptom is an
 * ABSENCE of refusals: nothing downstream ever surfaces the mistake.
 *
 * The gate is deliberately a COUNT over the whole diff rather than a per-kind assertion, so it is a
 * statement about the property ("every collection is printable") and not about the three instances
 * that happened to be missing on the day it was written.
 *
 * MUTATION LOG — each applied, watched fail, reverted, watched pass:
 * | Mutation | Measured |
 * |---|---|
 * | drop `...(diff.governanceMoveRungs ?? [])` from `planDiffEntries` | "every entry the diff carries reaches the table": `expected 7 to be 8`, and the rung-row case reds too |
 * | drop `...(diff.placements ?? [])` / `...(diff.producers ?? [])` | same count case reds (`7 to be 8`) |
 * | `diffEntryRow`'s governance-move-rung branch removed (falls through) | TYPE ERROR at the `const unknown: never = entry` binding — the omission cannot even compile |
 */
describe("planDiffEntries: every collection computePlanDiff can emit reaches the printed table", () => {
  const full: PlanDiff = {
    objects: [
      { kind: "object", action: "create", urn: "urn:scp:s:service:a", reason: "declared" } as never
    ],
    relationships: [
      {
        kind: "relationship",
        action: "create",
        typeId: "depends_on",
        fromUrn: "urn:scp:s:service:a",
        toUrn: "urn:scp:s:service:b",
        reason: "declared"
      }
    ],
    sourceMappings: [
      {
        kind: "source-mapping",
        action: "create",
        componentUrn: "urn:scp:s:component:api",
        sourceKind: "github",
        repoPattern: "acme/api",
        pathPattern: null,
        refPattern: null,
        type: "configuration",
        classification: null,
        mirrorOfShared: false,
        enabled: true,
        reason: "declared"
      }
    ],
    placements: [
      {
        kind: "placement",
        action: "create",
        componentUrn: "urn:scp:s:component:api",
        deploymentTargetUrn: "urn:scp:s:deployment-target:prod",
        reason: "declared"
      }
    ],
    executorBindings: [
      {
        kind: "executor-binding",
        action: "create",
        targetUrn: "urn:scp:s:component:api",
        type: "configuration",
        reason: "declared"
      }
    ],
    producers: [
      {
        kind: "dependency-producer",
        action: "update",
        ecosystem: "npm",
        coordinate: "@acme/sdk",
        producerUrn: "urn:scp:s:component:api",
        displacedProducerUrn: "urn:scp:s:component:legacy",
        reason: "re-pointed"
      }
    ],
    governanceMoveRungs: [
      {
        kind: "governance-move-rung",
        action: "delete",
        subjectUrn: "urn:scp:s:service:a",
        reason: "no longer declared"
      }
    ],
    summary: { creates: 5, updates: 1, deletes: 1, noops: 0 }
  };

  it("flattens all seven collections — a collection missing here is a change nobody is shown", () => {
    expect(planDiffEntries(full), "every entry the diff carries reaches the table").toHaveLength(7);
    expect(new Set(planDiffEntries(full).map((e) => e.kind))).toEqual(
      new Set([
        "object",
        "relationship",
        "source-mapping",
        "placement",
        "executor-binding",
        "dependency-producer",
        "governance-move-rung"
      ])
    );
  });

  it("tolerates a plan stored before the optional collections existed", () => {
    const old: PlanDiff = {
      objects: full.objects,
      relationships: full.relationships,
      summary: full.summary
    };
    expect(planDiffEntries(old)).toHaveLength(2);
  });

  it("every row carries the SAME four keys — the table takes its columns from the FIRST row only", () => {
    for (const entry of planDiffEntries(full)) {
      expect(Object.keys(diffEntryRow(entry)), `kind ${entry.kind}`).toEqual([
        "kind",
        "action",
        "ref",
        "reason"
      ]);
    }
  });

  it("a rung DELETE reads as a disable, not as an unlabelled row", () => {
    const row = diffEntryRow(full.governanceMoveRungs![0]!);
    // Not "relationship" — the old fall-through mislabelled every unknown kind as one, with
    // `undefined --undefined--> undefined` for its ref.
    expect(row.kind).toBe("governance-move-rung");
    expect(row.ref).toContain("urn:scp:s:service:a");
    expect(row.ref).toContain("DISABLE");
  });

  it("a producer UPDATE names the component it TAKES the coordinate from", () => {
    // The transfer is the entry's most consequential fact and the manifest never mentions the
    // displaced component, so a row that omits it hides exactly what needs reviewing.
    expect(diffEntryRow(full.producers![0]!).ref).toContain("urn:scp:s:component:legacy");
  });
});
