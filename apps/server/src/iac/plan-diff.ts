import type {
  ExecutorType,
  PlanDiff,
  PlanExecutorBindingDiffEntry,
  PlanExecutorBindingTarget,
  PlanObjectDiffEntry,
  PlanObjectTarget,
  PlanPlacementDiffEntry,
  PlanRelationshipDiffEntry,
  PlanSourceMappingDiffEntry,
  PipelineClassification
} from "@scp/schemas";
import { canonicalJson } from "../graph/objects-repo.js";

/** The relationship type that binds a component to its owning service (migration 0021). */
const CONTAINS_TYPE_ID = "contains";
/** The object type that must always belong to a service (M12 P5a). */
const COMPONENT_TYPE_ID = "component";

/**
 * Pure desired-vs-actual diff engine for `@scp/iac` plans (BUILD_AND_TEST.md §8 M2 item 4,
 * DESIGN.md §15). Takes plain data in, produces plain data out — no DB, no I/O — per
 * BUILD_AND_TEST.md §4.1's "anything testable as a pure function must be written as a pure
 * function" rule (same split as `authz/resolve.ts` vs its integration test). The DB-aware
 * assembly of `PlanDiffSnapshot` (querying live objects/relationships) lives in the thin wrapper,
 * `iac/plans-repo.ts`.
 */

export const MANAGED_BY_LABEL = "scp:managed-by";
export const STACK_LABEL = "scp:stack";
export const MANAGED_BY_IAC_VALUE = "iac";

/** The labels every IaC-managed object/relationship carries, merged in at PLAN time (goal statement — "this happens at PLAN time... not an apply-time surprise"). */
export function managedLabels(stackName: string): Record<string, unknown> {
  return { [MANAGED_BY_LABEL]: MANAGED_BY_IAC_VALUE, [STACK_LABEL]: stackName };
}

/** True if `labels` carries THIS stack's managed-by marker — the sole scoping test for pruning (goal statement: "pruning is scoped"). */
export function isStackManaged(
  labels: Record<string, unknown> | null | undefined,
  stackName: string
): boolean {
  if (!labels) return false;
  return labels[MANAGED_BY_LABEL] === MANAGED_BY_IAC_VALUE && labels[STACK_LABEL] === stackName;
}

/**
 * A manifest object with `domainId` already resolved to a concrete value — `undefined` ("default
 * to the org root") resolved via `graph/objects-repo.ts`'s `resolveDomainId` in `plans-repo.ts`,
 * since that resolution needs a DB read and this function must stay pure. `properties`/`labels`
 * are defaulted to `{}` by the same caller (the raw `ManifestObject` from `@scp/schemas` leaves
 * both optional).
 */
export interface ResolvedManifestObject {
  urn: string;
  typeId: string;
  name: string;
  domainId: string | null;
  properties: Record<string, unknown>;
  labels: Record<string, unknown>;
}

export interface ResolvedManifestRelationship {
  typeId: string;
  fromUrn: string;
  toUrn: string;
}

/**
 * A manifest `sourceMappings` entry with every optional field normalized to the row that will
 * actually be written (`null` patterns, the `configuration` Type default) — so the diff compares
 * like with like and the reviewed entry shows the real row, not the author's shorthand.
 */
export interface ResolvedManifestSourceMapping {
  componentUrn: string;
  sourceKind: string;
  repoPattern: string | null;
  pathPattern: string | null;
  refPattern: string | null;
  type: ExecutorType;
  classification: PipelineClassification | null;
  /** Declared mirror-of-shared provenance (outpost-ui.md §9.3a) — descriptive like
   *  `classification`, and like it NOT part of `sourceMappingKey`: a mapping whose declared
   *  provenance changed is the same mapping, not a delete + create. */
  mirrorOfShared: boolean;
  /** The pause switch (migration 0063) — like `classification`/`mirrorOfShared`, NOT part of
   *  `sourceMappingKey`: disabling a live mapping is an in-place correction, not a delete + create
   *  of the route. (It IS an enforcement input at the correlation matcher — but that read happens
   *  off the live table, never off this diff, so it has no bearing on identity here.) */
  enabled: boolean;
}

/**
 * A manifest `executorBindings` entry, normalized the same way, with `executionSystemId` already
 * resolved from an id-or-URN reference to a real object id by `plans-repo.ts` (a DB read, hence not
 * here). Without that resolution a manifest naming a system by URN would diff as a perpetual
 * `update` against the uuid the table stores — DoD (b)'s "apply twice is a no-op" would be false.
 */
export interface ResolvedManifestExecutorBinding {
  targetUrn: string;
  /** Non-null iff the row hangs off a PLACEMENT (`targetUrn` @ this deployment-target). The diff
   *  must key on the same identity the manifest declared, or a re-plan would never match. */
  deploymentTargetUrn: string | null;
  type: ExecutorType;
  pluginModule: string | null;
  pluginInstanceId: string | null;
  config: Record<string, unknown>;
  secretRefs: Record<string, string>;
  allowedHosts: string[];
  externalRef: string | null;
  executionSystemId: string | null;
}

/** A declared placement (ADR-0026). Identity IS the pair — there is no id or urn to resolve,
 *  which is why this type has no resolution step of its own. */
export interface ResolvedManifestPlacement {
  componentUrn: string;
  deploymentTargetUrn: string;
}

export interface ResolvedManifest {
  stackName: string;
  objects: ResolvedManifestObject[];
  relationships: ResolvedManifestRelationship[];
  /** ABSENT AND EMPTY ARE THE SAME THING HERE, deliberately — do not "fix" this.
   *
   *  `Stack.synth()` OMITS a collection when it is empty (construct.ts), so an absent key is the
   *  ONLY way an author can express "this stack has no mappings/bindings/placements". If absent
   *  meant "assert nothing, prune nothing", the LAST row in a collection could never be removed
   *  through IaC — you could add the final mapping and never take it away.
   *
   *  `@scp/schemas`'s "an absent collection must not read as 'prune everything'" is about a
   *  pre-C1 or hand-rolled manifest staying VALID, not about suppressing prune. I misread it as the
   *  latter, made absent skip pruning, and broke three `plans.integration` tests that assert exactly
   *  this: `build(false)` synthesizes a manifest with no `sourceMappings` key and expects
   *  `deletes === 2`. The tests were right. */
  sourceMappings: ResolvedManifestSourceMapping[];
  executorBindings: ResolvedManifestExecutorBinding[];
  placements: ResolvedManifestPlacement[];
}

export interface ExistingObjectSnapshot {
  urn: string;
  typeId: string;
  name: string;
  domainId: string | null;
  properties: Record<string, unknown>;
  labels: Record<string, unknown>;
}

export interface ExistingRelationshipTriple {
  typeId: string;
  fromUrn: string;
  toUrn: string;
}

export interface PlanDiffSnapshot {
  /**
   * Live objects the diff needs to reason about, keyed implicitly by `urn` (one entry per live
   * URN). Must cover: every URN referenced by `manifest.objects` that currently exists, every URN
   * referenced as a relationship endpoint (`fromUrn`/`toUrn`, including "external" URNs outside
   * this stack) that currently exists, AND every object currently labeled
   * `scp:managed-by=iac`/`scp:stack=<this stack>` regardless of whether it's still in the
   * manifest (prune detection). A superset is harmless — `plans-repo.ts` errs toward fetching
   * more rather than risking a missed prune/create signal.
   */
  existingObjects: ExistingObjectSnapshot[];
  /**
   * Live relationship `(typeId, fromUrn, toUrn)` triples currently labeled
   * `scp:managed-by=iac`/`scp:stack=<this stack>` — the exhaustive prune-candidate pool. Anything
   * in here NOT present in `manifest.relationships` becomes a `delete` entry.
   */
  managedRelationships: ExistingRelationshipTriple[];
  /**
   * Live relationship `(typeId, fromUrn, toUrn)` triples that exist for ANY reason (managed by
   * this stack, another stack, or created by hand) — the "does this already exist" pool used for
   * create/noop determination, so a plan never proposes creating a relationship that would 409 at
   * apply time. Overlapping with `managedRelationships` is expected and harmless.
   */
  existingRelationships: ExistingRelationshipTriple[];
  /**
   * Live `source_mappings` rows hanging off an object THIS stack owns, URN-keyed (C1). This is BOTH
   * the prune-candidate pool AND the "does this already exist" pool — ONE pool, because ownership is
   * inherited from the owning object rather than carried on the row (see `@scp/schemas`'s `iac.ts`
   * C1 note): a row on an object this stack owns is this stack's to converge, and a row on any other
   * object is invisible here and therefore unprunable. `plans-repo.ts` builds it; a duplicate tuple
   * (the table has no unique constraint) collapses to one entry here, and pruning removes every
   * duplicate.
   */
  managedSourceMappings: ResolvedManifestSourceMapping[];
  /** Live `executor_bindings` rows hanging off an object THIS stack owns — same one-pool rationale. */
  managedExecutorBindings: ResolvedManifestExecutorBinding[];
  /** Live `placement` objects whose COMPONENT this stack owns (decision Q4) — same one-pool
   *  rationale. Ownership follows the component, not the deployment-target, so a placement at a
   *  target owned by another stack is still this stack's to converge. */
  managedPlacements: ResolvedManifestPlacement[];
}

function relKey(t: ExistingRelationshipTriple): string {
  return `${t.typeId} ${t.fromUrn} ${t.toUrn}`;
}

/** Whole-tuple identity for a source mapping (`ManifestSourceMappingSchema`: no update path). */
/** A placement's identity is the PAIR and nothing else (ADR-0026 D3) — no urn, no id. That is why
 *  there is no `update` action for placements: a changed pair is a DIFFERENT placement, so it
 *  diffs as a delete plus a create rather than an in-place edit. */
function placementKey(p: ResolvedManifestPlacement): string {
  return canonicalJson({
    componentUrn: p.componentUrn,
    deploymentTargetUrn: p.deploymentTargetUrn
  });
}

/**
 * `refPattern` is IN the key and `classification` is deliberately OUT of it (ADR-0030 §1/§2).
 *
 * The ref is a ROUTING discriminator: `refs/heads/dev` → the dev pipeline and `refs/heads/main` →
 * the production one are two legitimate rows differing in nothing else. Leaving it out would make
 * them one key — the second declaration would diff as a `noop` (so the dev pipeline would never be
 * created, silently), and a prune of either would match both.
 *
 * The classification is a descriptive label. Keying on it would turn "relabel this pipeline `dev`"
 * into a delete-plus-create of a LIVE route, which is a real interruption for a cosmetic edit.
 */
function sourceMappingKey(m: ResolvedManifestSourceMapping): string {
  return canonicalJson({
    componentUrn: m.componentUrn,
    sourceKind: m.sourceKind,
    repoPattern: m.repoPattern,
    pathPattern: m.pathPattern,
    refPattern: m.refPattern,
    type: m.type
  });
}

/**
 * A binding's identity — `(target, type)`, mirroring `UNIQUE (org_id, target_object_id, type)`.
 *
 * The two addressings are TAGGED rather than merged into one string. An untagged key would let an
 * object URN and a placement pair collide in principle, and — more practically — makes the key
 * unreadable in a failing diff. `target_object_id` is a single column, so the two forms are two
 * ways of naming one row, never two rows.
 */
function bindingKey(b: {
  targetUrn: string;
  deploymentTargetUrn: string | null;
  type: ExecutorType;
}): string {
  return canonicalJson({
    targetUrn: b.targetUrn,
    deploymentTargetUrn: b.deploymentTargetUrn,
    type: b.type
  });
}

/** As `describeBindingTarget`, for a DIFF entry (whose qualifier is `undefined`, not `null`). */
function describeDiffTarget(b: { targetUrn: string; deploymentTargetUrn?: string }): string {
  return describeBindingTarget({ ...b, deploymentTargetUrn: b.deploymentTargetUrn ?? null });
}

/** How a binding's target reads in an error message. */
function describeBindingTarget(b: {
  targetUrn: string;
  deploymentTargetUrn: string | null;
}): string {
  return b.deploymentTargetUrn ? `placement ${b.targetUrn}@${b.deploymentTargetUrn}` : b.targetUrn;
}

/** The addressing fields to copy onto a diff entry, omitting the qualifier for an object target. */
function bindingAddress(b: { targetUrn: string; deploymentTargetUrn: string | null }): {
  targetUrn: string;
  deploymentTargetUrn?: string;
} {
  return b.deploymentTargetUrn
    ? { targetUrn: b.targetUrn, deploymentTargetUrn: b.deploymentTargetUrn }
    : { targetUrn: b.targetUrn };
}

/**
 * The fields whose drift makes a binding an `update`. MODE-DEPENDENT, and that is load-bearing: for
 * an execution-system-backed binding the module, instance id, config, secret refs and egress
 * allowlist are all SERVER-derived from the system at write time (`bindTargetToExecutionSystem`), so
 * comparing the manifest's (necessarily absent) values against the stored derived ones would make
 * every re-plan an `update` forever — DoD (b)'s "apply the same manifest twice is a no-op" would be
 * false for every Mode A binding. Only what the author actually declares is compared.
 */
function bindingComparisonKey(b: ResolvedManifestExecutorBinding): string {
  if (b.executionSystemId) {
    return canonicalJson({ executionSystemId: b.executionSystemId, externalRef: b.externalRef });
  }
  return canonicalJson({
    pluginModule: b.pluginModule,
    pluginInstanceId: b.pluginInstanceId,
    config: b.config,
    secretRefs: b.secretRefs,
    allowedHosts: b.allowedHosts,
    externalRef: b.externalRef,
    executionSystemId: null
  });
}

function bindingTarget(b: ResolvedManifestExecutorBinding): PlanExecutorBindingTarget {
  return {
    pluginModule: b.pluginModule,
    pluginInstanceId: b.pluginInstanceId,
    config: b.config,
    secretRefs: b.secretRefs,
    allowedHosts: b.allowedHosts,
    externalRef: b.externalRef,
    executionSystemId: b.executionSystemId
  };
}

/**
 * Computes the create/update/delete/noop diff for one `@scp/iac` plan (DESIGN.md §15 —
 * "Kubernetes-apply semantics, not client-side Terraform semantics"). Object identity is the
 * URN; comparison uses the same canonical-JSON-equality discipline as
 * `objects-repo.ts`'s `upsertObjectByUrn` true-idempotency check, so a plan re-computed against
 * unchanged state is always all-noop (BUILD_AND_TEST.md §8 M2 DoD (b)).
 *
 * Relationship diffing is identity-only (does a live `(typeId, fromUrn, toUrn)` triple exist?) —
 * relationship `properties` drift is not diffed in this milestone (a changed relationship is
 * effectively a delete+create the caller must express explicitly in the manifest); documented
 * simplification, not an oversight.
 */
export function computePlanDiff(manifest: ResolvedManifest, snapshot: PlanDiffSnapshot): PlanDiff {
  const existingByUrn = new Map(snapshot.existingObjects.map((o) => [o.urn, o] as const));
  const manifestUrns = new Set(manifest.objects.map((o) => o.urn));

  let creates = 0;
  let updates = 0;
  let deletes = 0;
  let noops = 0;

  const objectEntries: PlanObjectDiffEntry[] = [];

  for (const obj of manifest.objects) {
    const target: PlanObjectTarget = {
      urn: obj.urn,
      typeId: obj.typeId,
      name: obj.name,
      domainId: obj.domainId,
      properties: obj.properties,
      // Merged at PLAN time (module doc) — the diff the caller reviews already shows what apply
      // will write, including any user-supplied labels from the manifest itself.
      labels: { ...obj.labels, ...managedLabels(manifest.stackName) }
    };

    const existing = existingByUrn.get(obj.urn);
    if (!existing) {
      objectEntries.push({
        kind: "object",
        action: "create",
        urn: obj.urn,
        typeId: obj.typeId,
        reason: "no existing object with this URN",
        target
      });
      creates++;
      continue;
    }

    const changedFields: string[] = [];
    if (existing.typeId !== target.typeId) changedFields.push("typeId");
    if (existing.name !== target.name) changedFields.push("name");
    if (existing.domainId !== target.domainId) changedFields.push("domainId");
    if (canonicalJson(existing.properties) !== canonicalJson(target.properties)) {
      changedFields.push("properties");
    }
    if (canonicalJson(existing.labels) !== canonicalJson(target.labels)) {
      changedFields.push("labels");
    }

    if (changedFields.length === 0) {
      objectEntries.push({
        kind: "object",
        action: "noop",
        urn: obj.urn,
        typeId: obj.typeId,
        reason: "matches current state"
      });
      noops++;
    } else {
      objectEntries.push({
        kind: "object",
        action: "update",
        urn: obj.urn,
        typeId: obj.typeId,
        reason: `${changedFields.join(", ")} changed`,
        target
      });
      updates++;
    }
  }

  // Prune: objects this stack managed last time that are no longer in the manifest. Strictly
  // scoped by `isStackManaged` — an object outside this stack's managed-by/stack labels is never
  // a delete candidate here, even if its URN happens to collide with something (security
  // self-check item 2, goal statement).
  for (const existing of snapshot.existingObjects) {
    if (manifestUrns.has(existing.urn)) continue;
    if (!isStackManaged(existing.labels, manifest.stackName)) continue;
    objectEntries.push({
      kind: "object",
      action: "delete",
      urn: existing.urn,
      typeId: existing.typeId,
      reason: "previously managed by this stack, no longer present in the desired manifest"
    });
    deletes++;
  }

  const existingRelSet = new Set(snapshot.existingRelationships.map(relKey));
  const manifestRelKeys = new Set<string>();
  const relationshipEntries: PlanRelationshipDiffEntry[] = [];

  for (const rel of manifest.relationships) {
    const key = relKey(rel);
    manifestRelKeys.add(key);
    if (existingRelSet.has(key)) {
      relationshipEntries.push({
        kind: "relationship",
        action: "noop",
        typeId: rel.typeId,
        fromUrn: rel.fromUrn,
        toUrn: rel.toUrn,
        reason: "matches current state"
      });
      noops++;
      continue;
    }
    const bothEndpointsExist =
      (existingByUrn.has(rel.fromUrn) || manifestUrns.has(rel.fromUrn)) &&
      (existingByUrn.has(rel.toUrn) || manifestUrns.has(rel.toUrn));
    relationshipEntries.push({
      kind: "relationship",
      action: "create",
      typeId: rel.typeId,
      fromUrn: rel.fromUrn,
      toUrn: rel.toUrn,
      reason: bothEndpointsExist
        ? "no existing relationship of this type between these endpoints"
        : "will be created once its endpoint object(s), also created by this plan, exist"
    });
    creates++;
  }

  // Prune: relationships this stack managed last time that are no longer in the manifest — same
  // strict scoping as the object prune above (`managedRelationships` is already filtered to this
  // stack's labels by the caller, `plans-repo.ts`).
  for (const managed of snapshot.managedRelationships) {
    const key = relKey(managed);
    if (manifestRelKeys.has(key)) continue;
    relationshipEntries.push({
      kind: "relationship",
      action: "delete",
      typeId: managed.typeId,
      fromUrn: managed.fromUrn,
      toUrn: managed.toUrn,
      reason: "previously managed by this stack, no longer present in the desired manifest"
    });
    deletes++;
  }

  // -----------------------------------------------------------------------------------------
  // Projection collections (C1). Same converge-then-prune shape as the two above; the difference
  // is only WHERE ownership comes from — the row's owning object, not a label on the row.
  // -----------------------------------------------------------------------------------------

  const existingMappingKeys = new Set(snapshot.managedSourceMappings.map(sourceMappingKey));
  const manifestMappingKeys = new Set<string>();
  const sourceMappingEntries: PlanSourceMappingDiffEntry[] = [];

  for (const mapping of manifest.sourceMappings) {
    const key = sourceMappingKey(mapping);
    // A manifest declaring the same tuple twice would produce two identical create entries and
    // two identical rows on apply — the table has no unique constraint to stop it. Collapse to
    // one; the second declaration is redundant, not a second mapping.
    if (manifestMappingKeys.has(key)) continue;
    manifestMappingKeys.add(key);
    const exists = existingMappingKeys.has(key);
    sourceMappingEntries.push({
      kind: "source-mapping",
      action: exists ? "noop" : "create",
      componentUrn: mapping.componentUrn,
      sourceKind: mapping.sourceKind,
      repoPattern: mapping.repoPattern,
      pathPattern: mapping.pathPattern,
      refPattern: mapping.refPattern,
      type: mapping.type,
      classification: mapping.classification,
      mirrorOfShared: mapping.mirrorOfShared,
      enabled: mapping.enabled,
      reason: exists ? "matches current state" : "no existing source mapping with this identity"
    });
    if (exists) noops++;
    else creates++;
  }

  // -----------------------------------------------------------------------------------------
  // PLACEMENTS (C1, ADR-0026). Same one-pool shape as source mappings; no `update`, because the
  // pair IS the identity, so a changed pair is a different placement.
  // -----------------------------------------------------------------------------------------
  const existingPlacementKeys = new Set(snapshot.managedPlacements.map(placementKey));
  const manifestPlacementKeys = new Set<string>();
  const placementEntries: PlanPlacementDiffEntry[] = [];

  for (const placement of manifest.placements) {
    const key = placementKey(placement);
    // The unique index would reject a duplicate at apply time; collapsing here means a manifest
    // that says the same thing twice still plans cleanly rather than failing mid-apply.
    if (manifestPlacementKeys.has(key)) continue;
    manifestPlacementKeys.add(key);
    const exists = existingPlacementKeys.has(key);
    placementEntries.push({
      kind: "placement",
      action: exists ? "noop" : "create",
      componentUrn: placement.componentUrn,
      deploymentTargetUrn: placement.deploymentTargetUrn,
      reason: exists ? "matches current state" : "no existing placement for this pair"
    });
    if (exists) noops++;
    else creates++;
  }

  const placementPrunes = [...snapshot.managedPlacements]
    .filter((pl) => !manifestPlacementKeys.has(placementKey(pl)))
    .sort((a, b) => placementKey(a).localeCompare(placementKey(b)));
  const seenPlacementPrunes = new Set<string>();
  for (const managed of placementPrunes) {
    const key = placementKey(managed);
    if (seenPlacementPrunes.has(key)) continue;
    seenPlacementPrunes.add(key);
    placementEntries.push({
      kind: "placement",
      action: "delete",
      componentUrn: managed.componentUrn,
      deploymentTargetUrn: managed.deploymentTargetUrn,
      reason: "managed by this stack but no longer declared"
    });
    deletes++;
  }

  // Prune, sorted by identity so the reviewed diff is stable regardless of row order from the DB.
  const mappingPrunes = [...snapshot.managedSourceMappings]
    .filter((m) => !manifestMappingKeys.has(sourceMappingKey(m)))
    .sort((a, b) => sourceMappingKey(a).localeCompare(sourceMappingKey(b)));
  const seenMappingPrunes = new Set<string>();
  for (const managed of mappingPrunes) {
    const key = sourceMappingKey(managed);
    if (seenMappingPrunes.has(key)) continue; // duplicate rows collapse to one delete entry
    seenMappingPrunes.add(key);
    sourceMappingEntries.push({
      kind: "source-mapping",
      action: "delete",
      componentUrn: managed.componentUrn,
      sourceKind: managed.sourceKind,
      repoPattern: managed.repoPattern,
      pathPattern: managed.pathPattern,
      refPattern: managed.refPattern,
      type: managed.type,
      classification: managed.classification,
      mirrorOfShared: managed.mirrorOfShared,
      enabled: managed.enabled,
      reason:
        "on an object this stack owns, no longer present in the desired manifest's sourceMappings"
    });
    deletes++;
  }

  const existingBindingsByKey = new Map(
    snapshot.managedExecutorBindings.map((b) => [bindingKey(b), b] as const)
  );
  const manifestBindingKeys = new Set<string>();
  const executorBindingEntries: PlanExecutorBindingDiffEntry[] = [];

  for (const binding of manifest.executorBindings) {
    const key = bindingKey(binding);
    // Two declarations for the same (target, type) would race each other through the SAME upsert
    // row: whichever ran last would silently win. `UNIQUE (org_id, target_object_id, type)` says
    // there is exactly one, so a manifest claiming two is malformed desired state, not a
    // precedence question (proposal §11: "a silently-preferred key is how parseTopologyWaves
    // already loses malformed documents"). Rejected outright by `duplicateBindingDeclarations`
    // before this function's output is ever used; the guard here just keeps the diff well-formed.
    if (manifestBindingKeys.has(key)) continue;
    manifestBindingKeys.add(key);

    const existing = existingBindingsByKey.get(key);
    if (!existing) {
      executorBindingEntries.push({
        kind: "executor-binding",
        action: "create",
        ...bindingAddress(binding),
        type: binding.type,
        reason: "no existing executor binding for this target and type",
        target: bindingTarget(binding)
      });
      creates++;
      continue;
    }
    if (bindingComparisonKey(existing) === bindingComparisonKey(binding)) {
      executorBindingEntries.push({
        kind: "executor-binding",
        action: "noop",
        ...bindingAddress(binding),
        type: binding.type,
        reason: "matches current state"
      });
      noops++;
    } else {
      executorBindingEntries.push({
        kind: "executor-binding",
        action: "update",
        ...bindingAddress(binding),
        type: binding.type,
        reason: "binding configuration changed",
        target: bindingTarget(binding)
      });
      updates++;
    }
  }

  const bindingPrunes = [...snapshot.managedExecutorBindings]
    .filter((b) => !manifestBindingKeys.has(bindingKey(b)))
    .sort((a, b) => bindingKey(a).localeCompare(bindingKey(b)));
  for (const managed of bindingPrunes) {
    executorBindingEntries.push({
      kind: "executor-binding",
      action: "delete",
      ...bindingAddress(managed),
      type: managed.type,
      reason:
        "on an object this stack owns, no longer present in the desired manifest's executorBindings"
    });
    deletes++;
  }

  return {
    objects: objectEntries,
    relationships: relationshipEntries,
    sourceMappings: sourceMappingEntries,
    executorBindings: executorBindingEntries,
    placements: placementEntries,
    summary: { creates, updates, deletes, noops }
  };
}

/**
 * URNs of components this plan CREATES that have no incoming `contains` edge in the same plan — the
 * strict create-in-service invariant, enforced on the IaC path too (owner ruling 2026-07-16, "make
 * IaC strict"; M12 P5a, docs/proposals/organize-after.md). A component ALWAYS belongs to a service;
 * a manifest that mints one with no owning service is malformed desired state, rejected 400 at
 * plan-compute AND (defense-in-depth, matching every other invariant this module's apply path
 * re-checks) at apply — `plans-repo.ts` is the caller for both.
 *
 * Pure (plain data in, `string[]` out — this module's discipline) so it's unit-testable without a
 * DB. Only object CREATES are checked: updating or reading an already-existing component (including
 * an orphan imported via discovery/accept, which is permissive by design) needs no service, and
 * re-assigning one between services is P5b's `move` verb. A `contains` edge counts whether it is
 * itself being created (the usual case — both endpoints are new) or already live and merely
 * restated as a noop; only a `delete` of the edge does NOT satisfy containment.
 */
/**
 * Human-readable descriptions of any `sourceMappings`/`executorBindings` entry declared TWICE in one
 * manifest (C1). Rejected 400 at plan-compute rather than resolved by precedence: for a binding the
 * two declarations would race through the same `UNIQUE (org_id, target_object_id, type)` row and the
 * last one would silently win; for a mapping the table has no unique constraint, so both would be
 * written and correlation would match a component twice. Proposal §11's rule — "a silently-preferred
 * key is how `parseTopologyWaves` already loses malformed documents" — applied to the same shape.
 *
 * Pure over the RESOLVED manifest (normalized patterns/Types), so `{repoPattern: undefined}` and an
 * omitted `repoPattern` are correctly seen as the same declaration rather than two.
 */
export function duplicateProjectionDeclarations(manifest: ResolvedManifest): string[] {
  const offenders: string[] = [];
  const seenMappings = new Set<string>();
  for (const mapping of manifest.sourceMappings) {
    const key = sourceMappingKey(mapping);
    if (seenMappings.has(key)) {
      offenders.push(
        `sourceMapping ${mapping.sourceKind}:${mapping.repoPattern ?? "*"}:${mapping.pathPattern ?? "*"}` +
          `:${mapping.refPattern ?? "*"} -> ${mapping.componentUrn} (${mapping.type})`
      );
      continue;
    }
    seenMappings.add(key);
  }
  const seenBindings = new Set<string>();
  for (const binding of manifest.executorBindings) {
    const key = bindingKey(binding);
    if (seenBindings.has(key)) {
      offenders.push(`executorBinding ${describeBindingTarget(binding)} (${binding.type})`);
      continue;
    }
    seenBindings.add(key);
  }
  return offenders;
}

/**
 * Human-readable descriptions of any `sourceMappings`/`executorBindings` entry this plan would WRITE
 * whose owning object the stack does not own (C1) — the enforcement half of the ownership-scoping
 * decision documented in `@scp/schemas`'s `iac.ts`.
 *
 * WHY IT MUST EXIST. Neither projection table carries labels, so ownership is inherited from the
 * graph object the row hangs off. Inheritance only scopes pruning if the converse also holds: a
 * stack may only WRITE a row onto an object it owns. Without this, stack A could create or update a
 * binding on stack B's component — a row A can never see again (it is outside A's prune pool,
 * because the object is labelled `scp:stack=B`), so A can never remove it and B's next apply prunes
 * a row it never declared. Refusing the write is what keeps ownership single-valued in both
 * directions, and it is what makes "a stack never touches another stack's rows" true rather than
 * merely true-for-deletes.
 *
 * DERIVED PURELY FROM THE DIFF, exactly like `uncontainedComponentCreates`, so `plans-repo.ts` can
 * re-run it at APPLY time against the STORED diff without re-reading the graph — defence in depth
 * against a plan computed by an older build. An object entry with any action other than `delete` is
 * an object this stack will own once the plan applies (the diff carries an entry for every manifest
 * object, and apply stamps `scp:managed-by=iac`/`scp:stack=<stack>` on each). A `delete` mapping or
 * binding entry is exempt: it can only have come from the prune pool, which is already
 * ownership-scoped, and its owning object may legitimately be being deleted by this same plan.
 */
export function unownedProjectionDeclarations(diff: PlanDiff): string[] {
  const ownedUrns = new Set<string>();
  for (const obj of diff.objects) {
    if (obj.action !== "delete") ownedUrns.add(obj.urn);
  }
  const offenders: string[] = [];
  for (const mapping of diff.sourceMappings ?? []) {
    if (mapping.action === "delete") continue;
    if (!ownedUrns.has(mapping.componentUrn)) {
      offenders.push(`sourceMapping -> ${mapping.componentUrn}`);
    }
  }
  // A placement this plan will own once applied. `noop` counts: the pair is already live AND
  // declared, so it survives the prune. `delete` does not — see the second check below.
  const declaredPlacements = new Set<string>();
  for (const placement of diff.placements ?? []) {
    if (placement.action !== "delete") {
      declaredPlacements.add(
        canonicalJson([placement.componentUrn, placement.deploymentTargetUrn])
      );
    }
  }

  for (const binding of diff.executorBindings ?? []) {
    if (binding.action === "delete") continue;
    // ONE unconditional ownership rule for both shapes, which is the point of expressing a placement
    // as a QUALIFIER on `targetUrn` rather than as an alternative to it: for a placement-targeted
    // binding `targetUrn` IS the component, and ownership follows the component (decision Q4).
    if (!ownedUrns.has(binding.targetUrn)) {
      offenders.push(`executorBinding -> ${describeDiffTarget(binding)} (${binding.type})`);
      continue;
    }
    // The pair must ALSO survive this plan. Apply runs binding-prune, placement-prune,
    // placement-create, binding-create in that order, so a binding declared on a pair the manifest
    // does not declare would be written onto a placement the SAME apply just pruned — failing at the
    // resolve step, mid-apply, after other writes had landed. Refusing here turns that into a
    // plan-time error naming both halves.
    if (
      binding.deploymentTargetUrn &&
      !declaredPlacements.has(canonicalJson([binding.targetUrn, binding.deploymentTargetUrn]))
    ) {
      offenders.push(
        `executorBinding -> ${describeDiffTarget(binding)} (${binding.type}), whose pair this manifest does not declare in placements`
      );
    }
  }
  return offenders;
}

export function uncontainedComponentCreates(diff: PlanDiff): string[] {
  const containedToUrns = new Set<string>();
  for (const rel of diff.relationships) {
    if (rel.typeId === CONTAINS_TYPE_ID && rel.action !== "delete") containedToUrns.add(rel.toUrn);
  }
  const offenders: string[] = [];
  for (const obj of diff.objects) {
    if (
      obj.action === "create" &&
      obj.typeId === COMPONENT_TYPE_ID &&
      !containedToUrns.has(obj.urn)
    ) {
      offenders.push(obj.urn);
    }
  }
  return offenders;
}
