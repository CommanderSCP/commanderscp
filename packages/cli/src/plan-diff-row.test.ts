import { describe, expect, it } from "vitest";
import type { PlanDiff, PlanSourceMappingDiffEntry } from "@scp/schemas";
import { diffEntryRow, planDiffEntries } from "./cli.js";

/** `scp iac plan`'s source-mapping row must show the REF. See docs/cli.md §135. */
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

/** NOTHING `computePlanDiff` COMPUTES MAY BE INVISIBLE IN `scp plan`. See docs/cli.md §136. */
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
