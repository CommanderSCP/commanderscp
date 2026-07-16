import { describe, expect, it } from "vitest";
import {
  computePlanDiff,
  isStackManaged,
  managedLabels,
  uncontainedComponentCreates,
  type PlanDiffSnapshot,
  type ResolvedManifest
} from "./plan-diff.js";

/**
 * Pure unit tests over hand-built "manifest + current-state snapshot" fixtures — no DB, per
 * BUILD_AND_TEST.md §4.1 ("anything testable as a pure function must be written as a pure
 * function"). The DB-aware assembly (`iac/plans-repo.ts`'s `computeDiffForManifest`) is exercised
 * separately by `routes/plans.integration.test.ts`.
 */

const STACK = "billing-platform";

function emptySnapshot(): PlanDiffSnapshot {
  return { existingObjects: [], managedRelationships: [], existingRelationships: [] };
}

describe("iac/plan-diff: computePlanDiff", () => {
  it("create: a manifest object with no existing URN match becomes a create with merged managed-by labels", () => {
    const manifest: ResolvedManifest = {
      stackName: STACK,
      objects: [
        {
          urn: "urn:scp:billing-platform:service:billing-api",
          typeId: "service",
          name: "Billing API",
          domainId: null,
          properties: { tier: "critical" },
          labels: { team: "payments" }
        }
      ],
      relationships: []
    };

    const diff = computePlanDiff(manifest, emptySnapshot());

    expect(diff.summary).toEqual({ creates: 1, updates: 0, deletes: 0, noops: 0 });
    expect(diff.objects).toEqual([
      {
        kind: "object",
        action: "create",
        urn: "urn:scp:billing-platform:service:billing-api",
        typeId: "service",
        reason: "no existing object with this URN",
        target: {
          urn: "urn:scp:billing-platform:service:billing-api",
          typeId: "service",
          name: "Billing API",
          domainId: null,
          properties: { tier: "critical" },
          labels: { team: "payments", ...managedLabels(STACK) }
        }
      }
    ]);
  });

  it("noop: a manifest object matching current state (including merged labels) produces zero diff", () => {
    const urn = "urn:scp:billing-platform:service:billing-api";
    const manifest: ResolvedManifest = {
      stackName: STACK,
      objects: [
        {
          urn,
          typeId: "service",
          name: "Billing API",
          domainId: "0198f2a0-0000-7000-8000-000000000001",
          properties: { tier: "critical" },
          labels: {}
        }
      ],
      relationships: []
    };
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [
        {
          urn,
          typeId: "service",
          name: "Billing API",
          domainId: "0198f2a0-0000-7000-8000-000000000001",
          properties: { tier: "critical" },
          labels: managedLabels(STACK) // already carries what the plan would merge in
        }
      ],
      managedRelationships: [],
      existingRelationships: []
    };

    const diff = computePlanDiff(manifest, snapshot);

    expect(diff.summary).toEqual({ creates: 0, updates: 0, deletes: 0, noops: 1 });
    expect(diff.objects).toEqual([
      { kind: "object", action: "noop", urn, typeId: "service", reason: "matches current state" }
    ]);
  });

  it("update: changed properties produce an update entry naming the changed field", () => {
    const urn = "urn:scp:billing-platform:service:billing-api";
    const manifest: ResolvedManifest = {
      stackName: STACK,
      objects: [
        {
          urn,
          typeId: "service",
          name: "Billing API",
          domainId: null,
          properties: { tier: "high" },
          labels: {}
        }
      ],
      relationships: []
    };
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [
        {
          urn,
          typeId: "service",
          name: "Billing API",
          domainId: null,
          properties: { tier: "critical" },
          labels: managedLabels(STACK)
        }
      ],
      managedRelationships: [],
      existingRelationships: []
    };

    const diff = computePlanDiff(manifest, snapshot);

    expect(diff.summary).toEqual({ creates: 0, updates: 1, deletes: 0, noops: 0 });
    expect(diff.objects[0]).toMatchObject({ action: "update", reason: "properties changed" });
  });

  it("update: changed name is reported distinctly from changed properties", () => {
    const urn = "urn:scp:billing-platform:service:billing-api";
    const manifest: ResolvedManifest = {
      stackName: STACK,
      objects: [
        { urn, typeId: "service", name: "Billing API v2", domainId: null, properties: {}, labels: {} }
      ],
      relationships: []
    };
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [
        {
          urn,
          typeId: "service",
          name: "Billing API",
          domainId: null,
          properties: {},
          labels: managedLabels(STACK)
        }
      ],
      managedRelationships: [],
      existingRelationships: []
    };

    const diff = computePlanDiff(manifest, snapshot);
    expect(diff.objects[0]).toMatchObject({ action: "update", reason: "name changed" });
  });

  it("delete via pruning: a stack-managed object no longer in the manifest is proposed for deletion", () => {
    const staleUrn = "urn:scp:billing-platform:service:decommissioned";
    const manifest: ResolvedManifest = { stackName: STACK, objects: [], relationships: [] };
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [
        {
          urn: staleUrn,
          typeId: "service",
          name: "Decommissioned",
          domainId: null,
          properties: {},
          labels: managedLabels(STACK)
        }
      ],
      managedRelationships: [],
      existingRelationships: []
    };

    const diff = computePlanDiff(manifest, snapshot);
    expect(diff.summary).toEqual({ creates: 0, updates: 0, deletes: 1, noops: 0 });
    expect(diff.objects).toEqual([
      {
        kind: "object",
        action: "delete",
        urn: staleUrn,
        typeId: "service",
        reason: "previously managed by this stack, no longer present in the desired manifest"
      }
    ]);
  });

  it("pruning is strictly scoped: an object not managed by THIS stack is never proposed for deletion, even absent from the manifest", () => {
    const otherStackUrn = "urn:scp:billing-platform:service:unrelated";
    const unmanagedUrn = "urn:scp:billing-platform:service:hand-created";
    const manifest: ResolvedManifest = { stackName: STACK, objects: [], relationships: [] };
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [
        {
          urn: otherStackUrn,
          typeId: "service",
          name: "Unrelated",
          domainId: null,
          properties: {},
          labels: managedLabels("some-other-stack")
        },
        {
          urn: unmanagedUrn,
          typeId: "service",
          name: "Hand Created",
          domainId: null,
          properties: {},
          labels: {} // no scp:managed-by label at all
        }
      ],
      managedRelationships: [],
      existingRelationships: []
    };

    const diff = computePlanDiff(manifest, snapshot);
    expect(diff.objects).toEqual([]);
    expect(diff.summary).toEqual({ creates: 0, updates: 0, deletes: 0, noops: 0 });
  });

  it("relationship create: no matching existing triple", () => {
    const fromUrn = "urn:scp:billing-platform:service:worker";
    const toUrn = "urn:scp:billing-platform:service:api";
    const manifest: ResolvedManifest = {
      stackName: STACK,
      objects: [],
      relationships: [{ typeId: "depends_on", fromUrn, toUrn }]
    };

    const diff = computePlanDiff(manifest, emptySnapshot());
    expect(diff.summary).toEqual({ creates: 1, updates: 0, deletes: 0, noops: 0 });
    expect(diff.relationships).toEqual([
      {
        kind: "relationship",
        action: "create",
        typeId: "depends_on",
        fromUrn,
        toUrn,
        reason: "will be created once its endpoint object(s), also created by this plan, exist"
      }
    ]);
  });

  it("relationship create: both endpoints already exist gets a different reason", () => {
    const fromUrn = "urn:scp:billing-platform:service:worker";
    const toUrn = "urn:scp:billing-platform:service:api";
    const manifest: ResolvedManifest = {
      stackName: STACK,
      objects: [],
      relationships: [{ typeId: "depends_on", fromUrn, toUrn }]
    };
    const existingObj = (urn: string) => ({
      urn,
      typeId: "service",
      name: urn,
      domainId: null,
      properties: {},
      labels: {}
    });
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [existingObj(fromUrn), existingObj(toUrn)],
      managedRelationships: [],
      existingRelationships: []
    };

    const diff = computePlanDiff(manifest, snapshot);
    expect(diff.relationships[0]).toMatchObject({
      action: "create",
      reason: "no existing relationship of this type between these endpoints"
    });
  });

  it("relationship noop: matches an existing triple", () => {
    const fromUrn = "urn:scp:billing-platform:service:worker";
    const toUrn = "urn:scp:billing-platform:service:api";
    const manifest: ResolvedManifest = {
      stackName: STACK,
      objects: [],
      relationships: [{ typeId: "depends_on", fromUrn, toUrn }]
    };
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [],
      managedRelationships: [],
      existingRelationships: [{ typeId: "depends_on", fromUrn, toUrn }]
    };

    const diff = computePlanDiff(manifest, snapshot);
    expect(diff.summary).toEqual({ creates: 0, updates: 0, deletes: 0, noops: 1 });
    expect(diff.relationships).toEqual([
      { kind: "relationship", action: "noop", typeId: "depends_on", fromUrn, toUrn, reason: "matches current state" }
    ]);
  });

  it("relationship delete via pruning: a managed relationship no longer in the manifest is proposed for deletion", () => {
    const fromUrn = "urn:scp:billing-platform:service:worker";
    const toUrn = "urn:scp:billing-platform:service:api";
    const manifest: ResolvedManifest = { stackName: STACK, objects: [], relationships: [] };
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [],
      managedRelationships: [{ typeId: "depends_on", fromUrn, toUrn }],
      existingRelationships: [{ typeId: "depends_on", fromUrn, toUrn }]
    };

    const diff = computePlanDiff(manifest, snapshot);
    expect(diff.summary).toEqual({ creates: 0, updates: 0, deletes: 1, noops: 0 });
    expect(diff.relationships).toEqual([
      {
        kind: "relationship",
        action: "delete",
        typeId: "depends_on",
        fromUrn,
        toUrn,
        reason: "previously managed by this stack, no longer present in the desired manifest"
      }
    ]);
  });

  it("full scenario: create + update + noop + object-prune + relationship-prune combine into one summary", () => {
    const keepUrn = "urn:scp:billing-platform:service:keep";
    const updateUrn = "urn:scp:billing-platform:service:update-me";
    const createUrn = "urn:scp:billing-platform:service:brand-new";
    const pruneUrn = "urn:scp:billing-platform:service:prune-me";

    const manifest: ResolvedManifest = {
      stackName: STACK,
      objects: [
        {
          urn: keepUrn,
          typeId: "service",
          name: "Keep",
          domainId: null,
          properties: {},
          labels: {}
        },
        {
          urn: updateUrn,
          typeId: "service",
          name: "Update Me",
          domainId: null,
          properties: { v: 2 },
          labels: {}
        },
        {
          urn: createUrn,
          typeId: "service",
          name: "Brand New",
          domainId: null,
          properties: {},
          labels: {}
        }
      ],
      relationships: [{ typeId: "depends_on", fromUrn: createUrn, toUrn: keepUrn }]
    };

    const snapshot: PlanDiffSnapshot = {
      existingObjects: [
        {
          urn: keepUrn,
          typeId: "service",
          name: "Keep",
          domainId: null,
          properties: {},
          labels: managedLabels(STACK)
        },
        {
          urn: updateUrn,
          typeId: "service",
          name: "Update Me",
          domainId: null,
          properties: { v: 1 },
          labels: managedLabels(STACK)
        },
        {
          urn: pruneUrn,
          typeId: "service",
          name: "Prune Me",
          domainId: null,
          properties: {},
          labels: managedLabels(STACK)
        }
      ],
      managedRelationships: [{ typeId: "depends_on", fromUrn: pruneUrn, toUrn: keepUrn }],
      existingRelationships: [{ typeId: "depends_on", fromUrn: pruneUrn, toUrn: keepUrn }]
    };

    const diff = computePlanDiff(manifest, snapshot);

    expect(diff.summary).toEqual({ creates: 2, updates: 1, deletes: 2, noops: 1 });
    const actionsByUrn = Object.fromEntries(diff.objects.map((o) => [o.urn, o.action]));
    expect(actionsByUrn).toEqual({
      [keepUrn]: "noop",
      [updateUrn]: "update",
      [createUrn]: "create",
      [pruneUrn]: "delete"
    });
    expect(diff.relationships.map((r) => r.action).sort()).toEqual(["create", "delete"]);
  });
});

describe("iac/plan-diff: uncontainedComponentCreates (strict create-in-service, M12 P5a)", () => {
  const SVC = "urn:scp:s:service:checkout";
  const COMP = "urn:scp:s:component:checkout-api";

  /** Builds a diff by running the real engine over a hand-built manifest — exercises the
   *  create-detection + relationship-action shape the checker actually reads, not a stubbed diff. */
  function diffOf(
    objects: ResolvedManifest["objects"],
    relationships: ResolvedManifest["relationships"],
    snapshot: PlanDiffSnapshot = emptySnapshot()
  ) {
    return computePlanDiff({ stackName: STACK, objects, relationships }, snapshot);
  }

  function obj(urn: string, typeId: string): ResolvedManifest["objects"][number] {
    return { urn, typeId, name: urn, domainId: null, properties: {}, labels: {} };
  }

  it("flags a component CREATE with no incoming contains edge", () => {
    const diff = diffOf([obj(COMP, "component")], []);
    expect(uncontainedComponentCreates(diff)).toEqual([COMP]);
  });

  it("passes a component CREATE that has a contains edge from its service (both new)", () => {
    const diff = diffOf(
      [obj(COMP, "component"), obj(SVC, "service")],
      [{ typeId: "contains", fromUrn: SVC, toUrn: COMP }]
    );
    expect(uncontainedComponentCreates(diff)).toEqual([]);
  });

  it("still flags it when the ONLY contains edge is a DELETE (removing containment ≠ providing it)", () => {
    // The manifest keeps the component but drops its edge: the service+edge were managed last round,
    // the component is (implausibly, but the checker must be robust) re-created this round with no
    // edge. The prune produces a `contains` DELETE, which must NOT satisfy the create.
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [
        { urn: SVC, typeId: "service", name: SVC, domainId: null, properties: {}, labels: managedLabels(STACK) }
      ],
      managedRelationships: [{ typeId: "contains", fromUrn: SVC, toUrn: COMP }],
      existingRelationships: [{ typeId: "contains", fromUrn: SVC, toUrn: COMP }]
    };
    const diff = diffOf([obj(COMP, "component"), obj(SVC, "service")], [], snapshot);
    expect(diff.relationships.some((r) => r.typeId === "contains" && r.action === "delete")).toBe(true);
    expect(uncontainedComponentCreates(diff)).toEqual([COMP]);
  });

  it("ignores an UPDATE to an already-existing (possibly orphaned) component — only creates are strict", () => {
    // An imported orphan (no service) that the manifest merely updates: re-assignment is P5b's move
    // verb, so an update needs no contains edge.
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [
        { urn: COMP, typeId: "component", name: "old", domainId: null, properties: {}, labels: {} }
      ],
      managedRelationships: [],
      existingRelationships: []
    };
    const diff = diffOf([{ ...obj(COMP, "component"), name: "renamed" }], [], snapshot);
    expect(diff.objects[0]?.action).toBe("update");
    expect(uncontainedComponentCreates(diff)).toEqual([]);
  });

  it("does not flag non-component creates (a service needs no containment)", () => {
    const diff = diffOf([obj(SVC, "service")], []);
    expect(uncontainedComponentCreates(diff)).toEqual([]);
  });

  it("reports EVERY uncontained component when several are minted at once", () => {
    const c2 = "urn:scp:s:component:checkout-worker";
    const diff = diffOf(
      [obj(COMP, "component"), obj(c2, "component"), obj(SVC, "service")],
      [{ typeId: "contains", fromUrn: SVC, toUrn: COMP }] // only the first is contained
    );
    expect(uncontainedComponentCreates(diff)).toEqual([c2]);
  });
});

describe("iac/plan-diff: isStackManaged / managedLabels", () => {
  it("managedLabels produces the scp:managed-by/scp:stack marker pair", () => {
    expect(managedLabels("my-stack")).toEqual({ "scp:managed-by": "iac", "scp:stack": "my-stack" });
  });

  it("isStackManaged is true only for an exact stack-name match", () => {
    expect(isStackManaged(managedLabels("my-stack"), "my-stack")).toBe(true);
    expect(isStackManaged(managedLabels("my-stack"), "other-stack")).toBe(false);
    expect(isStackManaged({}, "my-stack")).toBe(false);
    expect(isStackManaged(null, "my-stack")).toBe(false);
    expect(isStackManaged({ "scp:managed-by": "not-iac", "scp:stack": "my-stack" }, "my-stack")).toBe(
      false
    );
  });
});
