import { describe, expect, it } from "vitest";
import {
  computePlanDiff,
  duplicateProjectionDeclarations,
  invalidProducerDeclarations,
  isStackManaged,
  managedLabels,
  uncontainedComponentCreates,
  unownedProjectionDeclarations,
  unresolvedProducerUrn,
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
  return {
    existingObjects: [],
    managedRelationships: [],
    existingRelationships: [],
    managedSourceMappings: [],
    managedExecutorBindings: [],
    managedPlacements: [],
    managedDependencyProducers: [],
    existingDependencyProducers: [],
    managedGovernanceMoveRungs: [],
    managedPipelineHooks: [],
    managedRollouts: [],
    managedConvergence: []
  };
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
      relationships: [],
      sourceMappings: [],
      executorBindings: [],
      placements: [],
      producers: null,
      governanceMoveRungs: null,
      pipelineHooks: null,
      rollouts: [],
      convergence: []
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
      relationships: [],
      sourceMappings: [],
      executorBindings: [],
      placements: [],
      producers: null,
      governanceMoveRungs: null,
      pipelineHooks: null,
      rollouts: [],
      convergence: []
    };
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [
        {
          urn,
          typeId: "service",
          name: "Billing API",
          domainId: "0198f2a0-0000-7000-8000-000000000001",
          properties: { tier: "critical" },
          labels: managedLabels(STACK), // already carries what the plan would merge in
          managedByStack: STACK
        }
      ],
      managedRelationships: [],
      existingRelationships: [],
      managedSourceMappings: [],
      managedExecutorBindings: [],
      managedPlacements: [],
      managedDependencyProducers: [],
      existingDependencyProducers: [],
      managedGovernanceMoveRungs: [],
      managedPipelineHooks: [],
      managedRollouts: [],
      managedConvergence: []
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
      relationships: [],
      sourceMappings: [],
      executorBindings: [],
      placements: [],
      producers: null,
      governanceMoveRungs: null,
      pipelineHooks: null,
      rollouts: [],
      convergence: []
    };
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [
        {
          urn,
          typeId: "service",
          name: "Billing API",
          domainId: null,
          properties: { tier: "critical" },
          labels: managedLabels(STACK),
          managedByStack: STACK
        }
      ],
      managedRelationships: [],
      existingRelationships: [],
      managedSourceMappings: [],
      managedExecutorBindings: [],
      managedPlacements: [],
      managedDependencyProducers: [],
      existingDependencyProducers: [],
      managedGovernanceMoveRungs: [],
      managedPipelineHooks: [],
      managedRollouts: [],
      managedConvergence: []
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
        {
          urn,
          typeId: "service",
          name: "Billing API v2",
          domainId: null,
          properties: {},
          labels: {}
        }
      ],
      relationships: [],
      sourceMappings: [],
      executorBindings: [],
      placements: [],
      producers: null,
      governanceMoveRungs: null,
      pipelineHooks: null,
      rollouts: [],
      convergence: []
    };
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [
        {
          urn,
          typeId: "service",
          name: "Billing API",
          domainId: null,
          properties: {},
          labels: managedLabels(STACK),
          managedByStack: STACK
        }
      ],
      managedRelationships: [],
      existingRelationships: [],
      managedSourceMappings: [],
      managedExecutorBindings: [],
      managedPlacements: [],
      managedDependencyProducers: [],
      existingDependencyProducers: [],
      managedGovernanceMoveRungs: [],
      managedPipelineHooks: [],
      managedRollouts: [],
      managedConvergence: []
    };

    const diff = computePlanDiff(manifest, snapshot);
    expect(diff.objects[0]).toMatchObject({ action: "update", reason: "name changed" });
  });

  it("delete via pruning: a stack-managed object no longer in the manifest is proposed for deletion", () => {
    const staleUrn = "urn:scp:billing-platform:service:decommissioned";
    const manifest: ResolvedManifest = {
      stackName: STACK,
      objects: [],
      relationships: [],
      sourceMappings: [],
      executorBindings: [],
      placements: [],
      producers: null,
      governanceMoveRungs: null,
      pipelineHooks: null,
      rollouts: [],
      convergence: []
    };
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [
        {
          urn: staleUrn,
          typeId: "service",
          name: "Decommissioned",
          domainId: null,
          properties: {},
          labels: managedLabels(STACK),
          managedByStack: STACK
        }
      ],
      managedRelationships: [],
      existingRelationships: [],
      managedSourceMappings: [],
      managedExecutorBindings: [],
      managedPlacements: [],
      managedDependencyProducers: [],
      existingDependencyProducers: [],
      managedGovernanceMoveRungs: [],
      managedPipelineHooks: [],
      managedRollouts: [],
      managedConvergence: []
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
    const manifest: ResolvedManifest = {
      stackName: STACK,
      objects: [],
      relationships: [],
      sourceMappings: [],
      executorBindings: [],
      placements: [],
      producers: null,
      governanceMoveRungs: null,
      pipelineHooks: null,
      rollouts: [],
      convergence: []
    };
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [
        {
          urn: otherStackUrn,
          typeId: "service",
          name: "Unrelated",
          domainId: null,
          properties: {},
          labels: managedLabels("some-other-stack"),
          managedByStack: "some-other-stack"
        },
        {
          urn: unmanagedUrn,
          typeId: "service",
          name: "Hand Created",
          domainId: null,
          properties: {},
          labels: {}, // no scp:managed-by label at all
          managedByStack: null
        }
      ],
      managedRelationships: [],
      existingRelationships: [],
      managedSourceMappings: [],
      managedExecutorBindings: [],
      managedPlacements: [],
      managedDependencyProducers: [],
      existingDependencyProducers: [],
      managedGovernanceMoveRungs: [],
      managedPipelineHooks: [],
      managedRollouts: [],
      managedConvergence: []
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
      relationships: [{ typeId: "depends_on", fromUrn, toUrn }],
      sourceMappings: [],
      executorBindings: [],
      placements: [],
      producers: null,
      governanceMoveRungs: null,
      pipelineHooks: null,
      rollouts: [],
      convergence: []
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
      relationships: [{ typeId: "depends_on", fromUrn, toUrn }],
      sourceMappings: [],
      executorBindings: [],
      placements: [],
      producers: null,
      governanceMoveRungs: null,
      pipelineHooks: null,
      rollouts: [],
      convergence: []
    };
    const existingObj = (urn: string) => ({
      urn,
      typeId: "service",
      name: urn,
      domainId: null,
      properties: {},
      labels: {},
      managedByStack: null
    });
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [existingObj(fromUrn), existingObj(toUrn)],
      managedRelationships: [],
      existingRelationships: [],
      managedSourceMappings: [],
      managedExecutorBindings: [],
      managedPlacements: [],
      managedDependencyProducers: [],
      existingDependencyProducers: [],
      managedGovernanceMoveRungs: [],
      managedPipelineHooks: [],
      managedRollouts: [],
      managedConvergence: []
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
      relationships: [{ typeId: "depends_on", fromUrn, toUrn }],
      sourceMappings: [],
      executorBindings: [],
      placements: [],
      producers: null,
      governanceMoveRungs: null,
      pipelineHooks: null,
      rollouts: [],
      convergence: []
    };
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [],
      managedRelationships: [],
      existingRelationships: [{ typeId: "depends_on", fromUrn, toUrn }],
      managedSourceMappings: [],
      managedExecutorBindings: [],
      managedPlacements: [],
      managedDependencyProducers: [],
      existingDependencyProducers: [],
      managedGovernanceMoveRungs: [],
      managedPipelineHooks: [],
      managedRollouts: [],
      managedConvergence: []
    };

    const diff = computePlanDiff(manifest, snapshot);
    expect(diff.summary).toEqual({ creates: 0, updates: 0, deletes: 0, noops: 1 });
    expect(diff.relationships).toEqual([
      {
        kind: "relationship",
        action: "noop",
        typeId: "depends_on",
        fromUrn,
        toUrn,
        reason: "matches current state"
      }
    ]);
  });

  it("relationship delete via pruning: a managed relationship no longer in the manifest is proposed for deletion", () => {
    const fromUrn = "urn:scp:billing-platform:service:worker";
    const toUrn = "urn:scp:billing-platform:service:api";
    const manifest: ResolvedManifest = {
      stackName: STACK,
      objects: [],
      relationships: [],
      sourceMappings: [],
      executorBindings: [],
      placements: [],
      producers: null,
      governanceMoveRungs: null,
      pipelineHooks: null,
      rollouts: [],
      convergence: []
    };
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [],
      managedRelationships: [{ typeId: "depends_on", fromUrn, toUrn }],
      existingRelationships: [{ typeId: "depends_on", fromUrn, toUrn }],
      managedSourceMappings: [],
      managedExecutorBindings: [],
      managedPlacements: [],
      managedDependencyProducers: [],
      existingDependencyProducers: [],
      managedGovernanceMoveRungs: [],
      managedPipelineHooks: [],
      managedRollouts: [],
      managedConvergence: []
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
      relationships: [{ typeId: "depends_on", fromUrn: createUrn, toUrn: keepUrn }],
      sourceMappings: [],
      executorBindings: [],
      placements: [],
      producers: null,
      governanceMoveRungs: null,
      pipelineHooks: null,
      rollouts: [],
      convergence: []
    };

    const snapshot: PlanDiffSnapshot = {
      existingObjects: [
        {
          urn: keepUrn,
          typeId: "service",
          name: "Keep",
          domainId: null,
          properties: {},
          labels: managedLabels(STACK),
          managedByStack: STACK
        },
        {
          urn: updateUrn,
          typeId: "service",
          name: "Update Me",
          domainId: null,
          properties: { v: 1 },
          labels: managedLabels(STACK),
          managedByStack: STACK
        },
        {
          urn: pruneUrn,
          typeId: "service",
          name: "Prune Me",
          domainId: null,
          properties: {},
          labels: managedLabels(STACK),
          managedByStack: STACK
        }
      ],
      managedRelationships: [{ typeId: "depends_on", fromUrn: pruneUrn, toUrn: keepUrn }],
      existingRelationships: [{ typeId: "depends_on", fromUrn: pruneUrn, toUrn: keepUrn }],
      managedSourceMappings: [],
      managedExecutorBindings: [],
      managedPlacements: [],
      managedDependencyProducers: [],
      existingDependencyProducers: [],
      managedGovernanceMoveRungs: [],
      managedPipelineHooks: [],
      managedRollouts: [],
      managedConvergence: []
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
    return computePlanDiff(
      {
        stackName: STACK,
        objects,
        relationships,
        sourceMappings: [],
        executorBindings: [],
        placements: [],
        producers: null,
        governanceMoveRungs: null,
        pipelineHooks: null,
        rollouts: [],
        convergence: []
      },
      snapshot
    );
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
        {
          urn: SVC,
          typeId: "service",
          name: SVC,
          domainId: null,
          properties: {},
          labels: managedLabels(STACK),
          managedByStack: STACK
        }
      ],
      managedRelationships: [{ typeId: "contains", fromUrn: SVC, toUrn: COMP }],
      existingRelationships: [{ typeId: "contains", fromUrn: SVC, toUrn: COMP }],
      managedSourceMappings: [],
      managedExecutorBindings: [],
      managedPlacements: [],
      managedDependencyProducers: [],
      existingDependencyProducers: [],
      managedGovernanceMoveRungs: [],
      managedPipelineHooks: [],
      managedRollouts: [],
      managedConvergence: []
    };
    const diff = diffOf([obj(COMP, "component"), obj(SVC, "service")], [], snapshot);
    expect(diff.relationships.some((r) => r.typeId === "contains" && r.action === "delete")).toBe(
      true
    );
    expect(uncontainedComponentCreates(diff)).toEqual([COMP]);
  });

  it("ignores an UPDATE to an already-existing (possibly orphaned) component — only creates are strict", () => {
    // An imported orphan (no service) that the manifest merely updates: re-assignment is P5b's move
    // verb, so an update needs no contains edge.
    const snapshot: PlanDiffSnapshot = {
      existingObjects: [
        {
          urn: COMP,
          typeId: "component",
          name: "old",
          domainId: null,
          properties: {},
          labels: {},
          managedByStack: null
        }
      ],
      managedRelationships: [],
      existingRelationships: [],
      managedSourceMappings: [],
      managedExecutorBindings: [],
      managedPlacements: [],
      managedDependencyProducers: [],
      existingDependencyProducers: [],
      managedGovernanceMoveRungs: [],
      managedPipelineHooks: [],
      managedRollouts: [],
      managedConvergence: []
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

  it("isStackManaged is true only for an exact stack-name match on the SERVER-WRITTEN column", () => {
    expect(isStackManaged("my-stack", "my-stack")).toBe(true);
    expect(isStackManaged("my-stack", "other-stack")).toBe(false);
    expect(isStackManaged(null, "my-stack")).toBe(false);
    expect(isStackManaged(undefined, "my-stack")).toBe(false);
    // Not a prefix/`startsWith` test, and not case-folded: a stack literally named `my-stack-2`
    // must not inherit `my-stack`'s prune pool.
    expect(isStackManaged("my-stack-2", "my-stack")).toBe(false);
    expect(isStackManaged("My-Stack", "my-stack")).toBe(false);
    expect(isStackManaged("", "my-stack")).toBe(false);
  });

  it("the marker LABELS no longer decide anything — the predicate cannot even be handed them", () => {
    // drizzle/0068. This is a compile-time property expressed as a runtime assertion: the only
    // argument `isStackManaged` accepts is the column, so the label pair that used to BE ownership
    // now reaches it only as the plain string it wraps — and the wrapper object is not assignable.
    // If someone widens the signature back to a labels map, the `@ts-expect-error` below stops
    // erroring and this test fails, which is the point of writing it here rather than in prose.
    const labels = managedLabels("my-stack");
    // @ts-expect-error a labels map is not an ownership value
    expect(isStackManaged(labels, "my-stack")).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
// C1 — sourceMappings / executorBindings (docs/proposals/post-import-configuration.md §8)
// -------------------------------------------------------------------------------------------

type ManifestMapping = ResolvedManifest["sourceMappings"][number];
type ManifestBinding = ResolvedManifest["executorBindings"][number];

function ownedObject(urn: string, typeId: string): ResolvedManifest["objects"][number] {
  return { urn, typeId, name: urn, domainId: null, properties: {}, labels: {} };
}

describe("iac/plan-diff: source mappings (C1)", () => {
  const COMP = "urn:scp:billing-platform:component:api";

  function mapping(over: Partial<ManifestMapping> = {}): ManifestMapping {
    return {
      componentUrn: COMP,
      sourceKind: "github",
      repoPattern: "acme/api",
      pathPattern: null,
      refPattern: null,
      type: "configuration",
      classification: null,
      mirrorOfShared: false,
      enabled: true,
      ...over
    };
  }

  function manifestWith(sourceMappings: ManifestMapping[]): ResolvedManifest {
    return {
      stackName: STACK,
      objects: [ownedObject(COMP, "component")],
      relationships: [],
      sourceMappings,
      executorBindings: [],
      placements: [],
      producers: null,
      governanceMoveRungs: null,
      pipelineHooks: null,
      rollouts: [],
      convergence: []
    };
  }

  it("creates a mapping with no matching live row, and counts it in the summary", () => {
    const diff = computePlanDiff(manifestWith([mapping()]), emptySnapshot());
    expect(diff.sourceMappings).toEqual([
      {
        kind: "source-mapping",
        action: "create",
        componentUrn: COMP,
        sourceKind: "github",
        repoPattern: "acme/api",
        pathPattern: null,
        refPattern: null,
        type: "configuration",
        classification: null,
        mirrorOfShared: false,
        enabled: true,
        // Not declared by the manifest, no live row → the row will hold NULL.
        scope: null,
        reason: "no existing source mapping with this identity"
      }
    ]);
    expect(diff.summary.creates).toBe(2); // the component + the mapping
  });

  it("noops against an identical live row — re-planning an applied manifest proposes nothing", () => {
    const diff = computePlanDiff(manifestWith([mapping()]), {
      ...emptySnapshot(),
      managedSourceMappings: [mapping()]
    });
    expect(diff.sourceMappings?.map((m) => m.action)).toEqual(["noop"]);
  });

  it("a mapping differing only in Type is a DIFFERENT mapping — delete + create, never an update", () => {
    const diff = computePlanDiff(manifestWith([mapping({ type: "image" })]), {
      ...emptySnapshot(),
      managedSourceMappings: [mapping({ type: "configuration" })]
    });
    expect(diff.sourceMappings?.map((m) => ({ action: m.action, type: m.type }))).toEqual([
      { action: "create", type: "image" },
      { action: "delete", type: "configuration" }
    ]);
  });

  it("prunes a row on an owned component that the manifest no longer declares", () => {
    const diff = computePlanDiff(manifestWith([]), {
      ...emptySnapshot(),
      managedSourceMappings: [mapping()]
    });
    expect(diff.sourceMappings?.map((m) => m.action)).toEqual(["delete"]);
    expect(diff.summary.deletes).toBe(1);
  });

  it("collapses duplicate live rows to ONE delete — the table has no unique constraint", () => {
    const diff = computePlanDiff(manifestWith([]), {
      ...emptySnapshot(),
      managedSourceMappings: [mapping(), mapping()]
    });
    expect(diff.sourceMappings).toHaveLength(1);
  });

  // §10.6 — `scope` is an ATTRIBUTE outside the identity tuple, and the ONE attribute the diff
  // converges on an existing tuple: an `update` verdict, in place, never delete + create of a live
  // route. Three desired-side states matter, and the omitted one is the trap: a manifest that has
  // never heard of the field must not clear a scope an operator set by hand.
  describe("scope (§10.6): the additive `update` verdict", () => {
    it("a declared scope that differs from the live row's is an UPDATE — counted as one, no delete, no create", () => {
      const diff = computePlanDiff(manifestWith([mapping({ scope: "global" })]), {
        ...emptySnapshot(),
        managedSourceMappings: [mapping({ scope: null })]
      });
      expect(diff.sourceMappings).toEqual([
        expect.objectContaining({
          action: "update",
          scope: "global",
          reason: "scope differs: not declared -> global"
        })
      ]);
      expect(diff.summary.updates).toBe(1);
      expect(diff.summary.deletes).toBe(0);
      expect(diff.summary.creates).toBe(1); // the component only
    });

    it("an explicit `null` CLEARS a live scope — an update to 'not declared'", () => {
      const diff = computePlanDiff(manifestWith([mapping({ scope: null })]), {
        ...emptySnapshot(),
        managedSourceMappings: [mapping({ scope: "domain" })]
      });
      expect(diff.sourceMappings?.[0]).toMatchObject({
        action: "update",
        scope: null,
        reason: "scope differs: domain -> not declared"
      });
    });

    it("an OMITTED scope manages nothing: the live value is reported and the verdict is noop", () => {
      const desired = mapping();
      delete (desired as { scope?: unknown }).scope;
      const diff = computePlanDiff(manifestWith([desired]), {
        ...emptySnapshot(),
        managedSourceMappings: [mapping({ scope: "global" })]
      });
      expect(diff.sourceMappings?.[0]).toMatchObject({ action: "noop", scope: "global" });
      expect(diff.summary.updates).toBe(0);
    });

    it("an equal declared scope is a noop", () => {
      const diff = computePlanDiff(manifestWith([mapping({ scope: "domain" })]), {
        ...emptySnapshot(),
        managedSourceMappings: [mapping({ scope: "domain" })]
      });
      expect(diff.sourceMappings?.map((m) => m.action)).toEqual(["noop"]);
    });

    it("duplicate live rows sharing the tuple: ANY one differing is enough to propose the update (apply converges them all)", () => {
      const diff = computePlanDiff(manifestWith([mapping({ scope: "global" })]), {
        ...emptySnapshot(),
        managedSourceMappings: [mapping({ scope: "global" }), mapping({ scope: null })]
      });
      expect(diff.sourceMappings?.map((m) => m.action)).toEqual(["update"]);
    });

    it("a create carries the declared scope; a prune carries the live row's", () => {
      const created = computePlanDiff(
        manifestWith([mapping({ scope: "domain" })]),
        emptySnapshot()
      );
      expect(created.sourceMappings?.[0]).toMatchObject({ action: "create", scope: "domain" });
      const pruned = computePlanDiff(manifestWith([]), {
        ...emptySnapshot(),
        managedSourceMappings: [mapping({ scope: "global" })]
      });
      expect(pruned.sourceMappings?.[0]).toMatchObject({ action: "delete", scope: "global" });
    });
  });
});

describe("iac/plan-diff: executor bindings (C1)", () => {
  const TARGET = "urn:scp:billing-platform:deployment-target:prod";
  const SYSTEM_ID = "11111111-1111-1111-1111-111111111111";

  function binding(over: Partial<ManifestBinding> = {}): ManifestBinding {
    return {
      targetUrn: TARGET,
      deploymentTargetUrn: null,
      type: "configuration",
      pluginModule: "argocd",
      pluginInstanceId: "argocd-1",
      config: { serverUrl: "https://argocd.internal" },
      secretRefs: {},
      allowedHosts: [],
      externalRef: null,
      executionSystemId: null,
      ...over
    };
  }

  function manifestWith(executorBindings: ManifestBinding[]): ResolvedManifest {
    return {
      stackName: STACK,
      objects: [ownedObject(TARGET, "deployment-target")],
      relationships: [],
      placements: [],
      sourceMappings: [],
      executorBindings,
      producers: null,
      governanceMoveRungs: null,
      pipelineHooks: null,
      rollouts: [],
      convergence: []
    };
  }

  it("creates a binding and carries the full desired row on the entry", () => {
    const diff = computePlanDiff(manifestWith([binding()]), emptySnapshot());
    expect(diff.executorBindings).toHaveLength(1);
    const entry = diff.executorBindings?.[0];
    expect(entry?.action).toBe("create");
    expect(entry?.target).toMatchObject({
      pluginModule: "argocd",
      pluginInstanceId: "argocd-1",
      config: { serverUrl: "https://argocd.internal" }
    });
  });

  it("noops against an identical live binding", () => {
    const diff = computePlanDiff(manifestWith([binding()]), {
      ...emptySnapshot(),
      managedExecutorBindings: [binding()]
    });
    expect(diff.executorBindings?.map((b) => b.action)).toEqual(["noop"]);
  });

  it("updates in place when the config drifts — never delete+create, which would churn the row", () => {
    const diff = computePlanDiff(
      manifestWith([binding({ config: { serverUrl: "https://argocd.example" } })]),
      { ...emptySnapshot(), managedExecutorBindings: [binding()] }
    );
    expect(diff.executorBindings?.map((b) => b.action)).toEqual(["update"]);
    expect(diff.summary.deletes).toBe(0);
  });

  it("two bindings on one target with different Types coexist — one row per Type", () => {
    const diff = computePlanDiff(
      manifestWith([
        binding(),
        binding({ type: "image", pluginModule: "github", pluginInstanceId: "gh-1" })
      ]),
      { ...emptySnapshot(), managedExecutorBindings: [binding()] }
    );
    expect(diff.executorBindings?.map((b) => ({ type: b.type, action: b.action }))).toEqual([
      { type: "configuration", action: "noop" },
      { type: "image", action: "create" }
    ]);
  });

  it("prunes a binding on an owned target that the manifest no longer declares", () => {
    const diff = computePlanDiff(manifestWith([]), {
      ...emptySnapshot(),
      managedExecutorBindings: [binding()]
    });
    expect(diff.executorBindings?.map((b) => b.action)).toEqual(["delete"]);
  });

  it("an execution-system-backed binding noops against the SERVER-DERIVED module/instance it was stored with", () => {
    // The stored row carries a module and an instance id the manifest never declared — both come
    // from the execution-system object at write time. Comparing them would make every re-plan an
    // eternal `update`, so "apply the same manifest twice is a no-op" would be false for Mode A.
    const declared = binding({
      pluginModule: null,
      pluginInstanceId: null,
      config: {},
      executionSystemId: SYSTEM_ID,
      externalRef: "billing-prod"
    });
    const stored = binding({
      pluginModule: "argocd",
      pluginInstanceId: `execution-system:${SYSTEM_ID}`,
      config: {},
      executionSystemId: SYSTEM_ID,
      externalRef: "billing-prod"
    });
    const diff = computePlanDiff(manifestWith([declared]), {
      ...emptySnapshot(),
      managedExecutorBindings: [stored]
    });
    expect(diff.executorBindings?.map((b) => b.action)).toEqual(["noop"]);
  });

  it("an execution-system-backed binding whose externalRef drifts IS an update", () => {
    const declared = binding({
      pluginModule: null,
      pluginInstanceId: null,
      config: {},
      executionSystemId: SYSTEM_ID,
      externalRef: "billing-prod-v2"
    });
    const stored = binding({
      pluginModule: "argocd",
      pluginInstanceId: `execution-system:${SYSTEM_ID}`,
      config: {},
      executionSystemId: SYSTEM_ID,
      externalRef: "billing-prod"
    });
    const diff = computePlanDiff(manifestWith([declared]), {
      ...emptySnapshot(),
      managedExecutorBindings: [stored]
    });
    expect(diff.executorBindings?.map((b) => b.action)).toEqual(["update"]);
  });
});

describe("iac/plan-diff: unownedProjectionDeclarations (C1 ownership guard)", () => {
  const COMP = "urn:scp:billing-platform:component:api";
  const FOREIGN = "urn:scp:other-stack:component:theirs";

  const mapping = (componentUrn: string): ManifestMapping => ({
    componentUrn,
    sourceKind: "github",
    repoPattern: "acme/api",
    pathPattern: null,
    refPattern: null,
    type: "configuration",
    classification: null,
    mirrorOfShared: false,
    enabled: true
  });

  const bindingOn = (targetUrn: string): ManifestBinding => ({
    targetUrn,
    deploymentTargetUrn: null,
    type: "configuration",
    pluginModule: "argocd",
    pluginInstanceId: "argocd-1",
    config: {},
    secretRefs: {},
    allowedHosts: [],
    externalRef: null,
    executionSystemId: null
  });

  function diffFor(
    objects: ResolvedManifest["objects"],
    sourceMappings: ManifestMapping[],
    executorBindings: ManifestBinding[],
    snapshot: PlanDiffSnapshot = emptySnapshot()
  ) {
    return computePlanDiff(
      {
        stackName: STACK,
        objects,
        relationships: [],
        sourceMappings,
        executorBindings,
        placements: [],
        producers: null,
        governanceMoveRungs: null,
        pipelineHooks: null,
        rollouts: [],
        convergence: []
      },
      snapshot
    );
  }

  it("passes when the owning object is declared in the same manifest", () => {
    const diff = diffFor([ownedObject(COMP, "component")], [mapping(COMP)], [bindingOn(COMP)]);
    expect(unownedProjectionDeclarations(diff)).toEqual([]);
  });

  it("flags a mapping AND a binding whose owning object this stack does not manage", () => {
    const diff = diffFor(
      [ownedObject(COMP, "component")],
      [mapping(FOREIGN)],
      [bindingOn(FOREIGN)]
    );
    expect(unownedProjectionDeclarations(diff)).toEqual([
      `sourceMapping -> ${FOREIGN}`,
      `executorBinding -> ${FOREIGN} (configuration)`
    ]);
  });

  it("flags a declaration on an object THIS plan prunes — you cannot configure what you are deleting", () => {
    // Stack-labelled but absent from the manifest, so the object gets a `delete` entry.
    const diff = diffFor([], [mapping(COMP)], [], {
      ...emptySnapshot(),
      existingObjects: [
        {
          urn: COMP,
          typeId: "component",
          name: "API",
          domainId: null,
          properties: {},
          labels: managedLabels(STACK),
          managedByStack: STACK
        }
      ]
    });
    expect(diff.objects.map((o) => o.action)).toEqual(["delete"]);
    expect(unownedProjectionDeclarations(diff)).toEqual([`sourceMapping -> ${COMP}`]);
  });

  it("does NOT flag a prune entry — its pool is already ownership-scoped and its object may be going away", () => {
    const diff = diffFor([], [], [], {
      ...emptySnapshot(),
      managedSourceMappings: [mapping(COMP)],
      managedExecutorBindings: [bindingOn(COMP)]
    });
    expect(diff.sourceMappings?.map((m) => m.action)).toEqual(["delete"]);
    expect(diff.executorBindings?.map((b) => b.action)).toEqual(["delete"]);
    expect(unownedProjectionDeclarations(diff)).toEqual([]);
  });
});

describe("iac/plan-diff: duplicateProjectionDeclarations (C1)", () => {
  const COMP = "urn:scp:billing-platform:component:api";

  const base = (over: Partial<ResolvedManifest> = {}): ResolvedManifest => ({
    stackName: STACK,
    objects: [],
    relationships: [],
    sourceMappings: [],
    executorBindings: [],
    placements: [],
    producers: null,
    governanceMoveRungs: null,
    pipelineHooks: null,
    rollouts: [],
    convergence: [],
    ...over
  });

  const mapping: ManifestMapping = {
    componentUrn: COMP,
    sourceKind: "github",
    repoPattern: "acme/api",
    pathPattern: null,
    refPattern: null,
    type: "configuration",
    classification: null,
    mirrorOfShared: false,
    enabled: true
  };

  const bindingOn: ManifestBinding = {
    targetUrn: COMP,
    deploymentTargetUrn: null,
    type: "configuration",
    pluginModule: "argocd",
    pluginInstanceId: "a",
    config: {},
    secretRefs: {},
    allowedHosts: [],
    externalRef: null,
    executionSystemId: null
  };

  it("accepts distinct declarations", () => {
    expect(
      duplicateProjectionDeclarations(
        base({ sourceMappings: [mapping, { ...mapping, type: "image" }] })
      )
    ).toEqual([]);
  });

  it("flags the same mapping tuple declared twice", () => {
    expect(duplicateProjectionDeclarations(base({ sourceMappings: [mapping, mapping] }))).toEqual([
      `sourceMapping github:acme/api:*:* -> ${COMP} (configuration)`
    ]);
  });

  it("flags two bindings on the same (target, type) — UNIQUE(org,target,type) admits only one", () => {
    expect(
      duplicateProjectionDeclarations(
        base({ executorBindings: [bindingOn, { ...bindingOn, pluginInstanceId: "b" }] })
      )
    ).toEqual([`executorBinding ${COMP} (configuration)`]);
  });

  it("accepts two bindings on the same target with DIFFERENT types", () => {
    expect(
      duplicateProjectionDeclarations(
        base({ executorBindings: [bindingOn, { ...bindingOn, type: "image" }] })
      )
    ).toEqual([]);
  });
});

/**
 * PRODUCER DECLARATIONS (ADR-0032 §7e) — the one collection where ABSENT and EMPTY differ.
 *
 * The type carries the ruling (`ResolvedManifest.producers` is `T[] | null`, not `T[]`), so the
 * first two cases below are what that type is FOR: `null` must skip the block entirely and `[]` must
 * prune. A mutation that maps absent to `[]` in `plans-repo.ts` cannot be caught here — it is caught
 * in `iac-dependency-producers.integration.test.ts` — so these cases pin the ENGINE's half and that
 * file pins the wiring's.
 */
describe("iac/plan-diff: dependency producers", () => {
  const COMP = "urn:scp:billing-platform:component:lib";
  const OTHER = "urn:scp:billing-platform:component:other";
  const FOREIGN = "urn:scp:other-stack:component:theirs";

  const manifest = (over: Partial<ResolvedManifest> = {}): ResolvedManifest => ({
    stackName: STACK,
    objects: [],
    relationships: [],
    sourceMappings: [],
    executorBindings: [],
    placements: [],
    producers: null,
    governanceMoveRungs: null,
    pipelineHooks: null,
    rollouts: [],
    convergence: [],
    ...over
  });

  const declaration = (producerUrn: string, coordinate = "@acme/lib") => ({
    producerUrn,
    ecosystem: "npm" as const,
    coordinate
  });

  it("ABSENT (null) emits NO producers key at all and prunes nothing, even with a standing declaration", () => {
    const diff = computePlanDiff(manifest({ producers: null }), {
      ...emptySnapshot(),
      managedDependencyProducers: [declaration(COMP)]
    });
    // Absent, not `[]`: the stored plan records "this stack manages no producer declarations",
    // which is a different statement from "manages them, nothing to do".
    expect(diff.producers).toBeUndefined();
    expect(diff.summary).toEqual({ creates: 0, updates: 0, deletes: 0, noops: 0 });
  });

  it("PRESENT AND EMPTY prunes every declaration on a component this stack owns — the deliberate escape hatch", () => {
    const diff = computePlanDiff(manifest({ producers: [] }), {
      ...emptySnapshot(),
      managedDependencyProducers: [declaration(COMP)]
    });
    expect(diff.producers?.map((p) => p.action)).toEqual(["delete"]);
    expect(diff.producers?.[0]?.producerUrn).toBe(COMP);
    expect(diff.summary.deletes).toBe(1);
  });

  it("a present collection is AUTHORITATIVE OVER ITS MEMBERS: removing B from [A, B] deletes B and noops A", () => {
    const a = declaration(COMP, "@acme/a");
    const b = declaration(COMP, "@acme/b");
    const diff = computePlanDiff(manifest({ producers: [a] }), {
      ...emptySnapshot(),
      managedDependencyProducers: [a, b],
      existingDependencyProducers: [a]
    });
    expect(diff.producers?.map((p) => [p.coordinate, p.action])).toEqual([
      ["@acme/a", "noop"],
      ["@acme/b", "delete"]
    ]);
  });

  it("a coordinate with no live declaration is a CREATE; the same one re-declared is a NOOP", () => {
    const d = declaration(COMP);
    expect(
      computePlanDiff(manifest({ producers: [d] }), emptySnapshot()).producers?.map((p) => p.action)
    ).toEqual(["create"]);
    expect(
      computePlanDiff(manifest({ producers: [d] }), {
        ...emptySnapshot(),
        managedDependencyProducers: [d],
        existingDependencyProducers: [d]
      }).producers?.map((p) => p.action)
    ).toEqual(["noop"]);
  });

  it("re-pointing a coordinate is an UPDATE naming the displaced producer — never a create, and never delete+create", () => {
    const diff = computePlanDiff(manifest({ producers: [declaration(OTHER)] }), {
      ...emptySnapshot(),
      managedDependencyProducers: [declaration(COMP)],
      existingDependencyProducers: [declaration(COMP)]
    });
    // ONE entry. Identity is the coordinate and the table upserts, so a delete plus a create would
    // be two entries against one primary key whose apply order decides the outcome.
    expect(diff.producers).toHaveLength(1);
    expect(diff.producers?.[0]).toMatchObject({
      action: "update",
      producerUrn: OTHER,
      displacedProducerUrn: COMP
    });
    expect(diff.summary).toEqual({ creates: 0, updates: 1, deletes: 0, noops: 0 });
  });

  it("a live declaration OUTSIDE this stack's prune pool still surfaces as an update — the transfer that deletes no row", () => {
    // The foreign producer is absent from `managedDependencyProducers` (it is not this stack's) but
    // present in `existingDependencyProducers` (the coordinate really is taken). Reading only the
    // scoped pool would report `create` and let apply steal it silently.
    const diff = computePlanDiff(manifest({ producers: [declaration(COMP)] }), {
      ...emptySnapshot(),
      existingDependencyProducers: [declaration(FOREIGN)]
    });
    expect(diff.producers?.[0]).toMatchObject({
      action: "update",
      displacedProducerUrn: FOREIGN
    });
  });

  it("a coordinate declared twice collapses to ONE entry, and is reported as a duplicate", () => {
    const m = manifest({ producers: [declaration(COMP), declaration(OTHER)] });
    expect(computePlanDiff(m, emptySnapshot()).producers).toHaveLength(1);
    expect(duplicateProjectionDeclarations(m)).toEqual([`producer npm '@acme/lib' (-> ${OTHER})`]);
  });
});

describe("iac/plan-diff: invalidProducerDeclarations", () => {
  const COMP = "urn:scp:billing-platform:component:lib";
  const FOREIGN = "urn:scp:other-stack:component:theirs";

  const objectEntry = (urn: string, typeId: string, action: "create" | "delete" = "create") => ({
    kind: "object" as const,
    action,
    urn,
    typeId,
    reason: "fixture"
  });

  const producerEntry = (over: Record<string, unknown> = {}) => ({
    kind: "dependency-producer" as const,
    action: "create" as const,
    ecosystem: "npm" as const,
    coordinate: "@acme/lib",
    producerUrn: COMP,
    reason: "fixture",
    ...over
  });

  const diffWith = (objects: ReturnType<typeof objectEntry>[], producers: unknown[]) =>
    ({
      objects,
      relationships: [],
      producers,
      summary: { creates: 0, updates: 0, deletes: 0, noops: 0 }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  it("accepts a declaration on a component this stack declares", () => {
    expect(
      invalidProducerDeclarations(diffWith([objectEntry(COMP, "component")], [producerEntry()]))
    ).toEqual([]);
  });

  it("refuses a producer this stack does not manage", () => {
    const offenders = invalidProducerDeclarations(
      diffWith([], [producerEntry({ producerUrn: FOREIGN })])
    );
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("this stack does not manage");
  });

  it("refuses a SERVICE-valued producer, and says why rather than only that it is the wrong type", () => {
    const offenders = invalidProducerDeclarations(
      diffWith([objectEntry(COMP, "service")], [producerEntry()])
    );
    expect(offenders).toHaveLength(1);
    // The wording IS the requirement here (owner ruling, ADR-0032 §7e) — pinned for the same reason
    // the typed route's service arm is: a generic "wrong type" message is indistinguishable from it.
    expect(offenders[0]).toMatch(/first cut/i);
    expect(offenders[0]).toMatch(/polling/i);
  });

  it("refuses a producer of any other non-component type, naming what was found", () => {
    const offenders = invalidProducerDeclarations(
      diffWith([objectEntry(COMP, "deployment-target")], [producerEntry()])
    );
    expect(offenders[0]).toContain("deployment-target");
  });

  it("refuses DISPLACING a producer belonging to another stack, even when the destination is owned", () => {
    const offenders = invalidProducerDeclarations(
      diffWith(
        [objectEntry(COMP, "component")],
        [producerEntry({ action: "update", displacedProducerUrn: FOREIGN })]
      )
    );
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain(FOREIGN);
  });

  it("ALLOWS displacing a producer this stack is DELETING in the same plan — a delete entry proves ownership", () => {
    // The ordinary "component OLD is replaced by NEW, and the coordinate moves with it" manifest.
    // Keying the displacement check on non-delete entries alone would refuse it.
    const NEW = "urn:scp:billing-platform:component:new";
    expect(
      invalidProducerDeclarations(
        diffWith(
          [objectEntry(NEW, "component"), objectEntry(COMP, "component", "delete")],
          [
            producerEntry({
              action: "update",
              producerUrn: NEW,
              displacedProducerUrn: COMP
            })
          ]
        )
      )
    ).toEqual([]);
  });

  it("refuses a displacement whose holder cannot be NAMED, with its own remedy rather than the other stack's", () => {
    // A tombstoned producer component leaves its declaration standing and resolves to no URN, so the
    // snapshot carries `unresolvedProducerUrn`. It gets its own branch rather than failing the
    // membership test: the fixture below puts the sentinel IN `diff.objects`, which a real URN could
    // legitimately be (a manifest still naming the deleted component diffs it as a `create`) — and
    // membership alone would then wave the overwrite through on precisely the plan to refuse.
    const stranded = unresolvedProducerUrn("01a012aa-b584-75cd-a938-3e92263538df");
    const offenders = invalidProducerDeclarations(
      diffWith(
        [objectEntry(COMP, "component"), objectEntry(stranded, "component")],
        [producerEntry({ action: "update", displacedProducerUrn: stranded })]
      )
    );
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("no longer resolves");
    // The remedy is the RETRACT verb, because there is no stack to hand the coordinate back to; the
    // other-stack message would send an operator looking for a manifest that does not exist.
    expect(offenders[0]).toContain("retract");
    expect(offenders[0]).not.toContain("this stack does not manage");
  });

  it("exempts a DELETE entry from the producer-type and ownership checks — the prune pool is already scoped", () => {
    expect(
      invalidProducerDeclarations(
        diffWith([objectEntry(COMP, "component", "delete")], [producerEntry({ action: "delete" })])
      )
    ).toEqual([]);
  });
});
