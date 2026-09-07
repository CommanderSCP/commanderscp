import type {
  DependencyEcosystem,
  ExecutorType,
  PlanDependencyProducerDiffEntry,
  PlanDiff,
  PlanExecutorBindingDiffEntry,
  PlanExecutorBindingTarget,
  PlanGovernanceMoveRungDiffEntry,
  PlanObjectDiffEntry,
  PlanObjectTarget,
  PlanConvergenceDiffEntry,
  PlanPipelineHookDiffEntry,
  PlanPlacementDiffEntry,
  PlanRolloutDiffEntry,
  PlanRoleBindingDiffEntry,
  PlanRoleDiffEntry,
  PlanRelationshipDiffEntry,
  PlanSourceMappingDiffEntry,
  PipelineClassification,
  PipelineHookKind,
  SourceMappingScope,
  WorkflowRef
} from "@scp/schemas";
import { canonicalJson } from "../graph/objects-repo.js";
import { moveRungTierForObjectType } from "../governance/move-enforcement.js";

/** The relationship type that binds a component to its owning service (migration 0021).
 *  EXPORTED because `plans-repo.ts`'s apply path has to ask the same question at its door — a
 *  second string literal one module over is how one of the two comes to mean something else. */
export const CONTAINS_TYPE_ID = "contains";
/** The object type that must always belong to a service (M12 P5a). */
const COMPONENT_TYPE_ID = "component";

/** Pure desired-vs-actual diff engine for `@scp/iac` plans. See docs/iac.md §58. */

export const MANAGED_BY_LABEL = "scp:managed-by";
export const STACK_LABEL = "scp:stack";
export const MANAGED_BY_IAC_VALUE = "iac";

/** The human-readable mirror of stack ownership, on each row. See docs/iac.md §59. */
export function managedLabels(stackName: string): Record<string, unknown> {
  return { [MANAGED_BY_LABEL]: MANAGED_BY_IAC_VALUE, [STACK_LABEL]: stackName };
}

/** True if this row is owned by THIS stack. See docs/iac.md §60. */
/** Stack theft: a manifest claiming another stack's object. See docs/iac.md §61. */
export class StackOwnershipConflictError extends Error {
  constructor(
    readonly conflicts: readonly { urn: string; ownedBy: string }[],
    readonly stackName: string
  ) {
    super(
      `stack '${stackName}' declares ${conflicts.length} object(s) already managed by another ` +
        `stack: ` +
        conflicts.map((c) => `'${c.urn}' (owned by '${c.ownedBy}')`).join(", ") +
        ` — adopting an object another stack manages is refused; remove it from that stack's ` +
        `manifest first, or declare it under the stack that owns it`
    );
    this.name = "StackOwnershipConflictError";
  }
}

export function isStackManaged(
  managedByStack: string | null | undefined,
  stackName: string
): boolean {
  return managedByStack === stackName;
}

/** A manifest object whose domain is already resolved. See docs/iac.md §62. */
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

/** A source-mapping entry with every optional field normalized. See docs/iac.md §63. */
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
  /** Declared reach (migration 0066, §10.6). See docs/iac.md §64. */
  scope?: SourceMappingScope | null;
}

/** An executor-binding entry, normalized the same way. See docs/iac.md §65. */
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

/** A declared `dependency_line_producers` row (ADR-0032 §7e). Identity is `(ecosystem, coordinate)`;
 *  `producerUrn` is the VALUE, which is why this collection has an `update`. Nothing to normalize —
 *  the coordinate is carried verbatim by contract and there are no optional fields. */
export interface ResolvedManifestDependencyProducer {
  producerUrn: string;
  ecosystem: DependencyEcosystem;
  coordinate: string;
}

/** A declared pipeline hook. See docs/iac.md §66. */
export interface ResolvedManifestPipelineHook {
  componentUrn: string;
  /** The hook's own kind. Named `hookKind` for the reason `PlanPipelineHookDiffEntrySchema` gives:
   *  `kind` is already the discriminant every diff entry carries. */
  hookKind: PipelineHookKind;
  hookId: string;
  workflow: WorkflowRef | null;
  stage: string | null;
  everySeconds: number | null;
  maxAgeSeconds: number | null;
  quietWindowSeconds: number | null;
}

export interface ResolvedManifest {
  stackName: string;
  objects: ResolvedManifestObject[];
  relationships: ResolvedManifestRelationship[];
  /** ABSENT AND EMPTY ARE THE SAME THING HERE, deliberately. See docs/iac.md §67. */
  sourceMappings: ResolvedManifestSourceMapping[];
  executorBindings: ResolvedManifestExecutorBinding[];
  placements: ResolvedManifestPlacement[];
  /** HERE, AND ONLY HERE, ABSENT AND EMPTY ARE DIFFERENT. See docs/iac.md §68. */
  producers: ResolvedManifestDependencyProducer[] | null;
  /** The second nullable collection, null for the same reason. See docs/iac.md §69. */
  governanceMoveRungs: string[] | null;
  /** The third nullable collection, null for the same reason. See docs/iac.md §70. */
  pipelineHooks: ResolvedManifestPipelineHook[] | null;
  /** The two collections that were authorable and dropped. See docs/iac.md §71. */
  rollouts: ResolvedManifestRollout[];
  roleBindings: ResolvedManifestRoleBinding[];
  roles: ResolvedManifestRole[];
  convergence: ResolvedManifestConvergence[];
}

export interface ExistingObjectSnapshot {
  urn: string;
  typeId: string;
  name: string;
  domainId: string | null;
  properties: Record<string, unknown>;
  labels: Record<string, unknown>;
  /** drizzle/0068 — the server-written owning stack, or `null`. THE prune-scoping input; `labels`
   *  above is compared for drift and read for nothing else. */
  managedByStack: string | null;
}

export interface ExistingRelationshipTriple {
  typeId: string;
  fromUrn: string;
  toUrn: string;
}

export interface ResolvedManifestRollout {
  componentUrn: string;
  targetClass: string;
  rollout: unknown;
}

export interface ResolvedManifestRoleBinding {
  subjectUrn: string;
  roleName: string;
  scopeUrn: string;
  reason: string;
}

export interface ResolvedManifestRole {
  name: string;
  permissions: string[];
  bindableAt?: string[];
  reason: string;
}

export interface ResolvedManifestConvergence {
  componentUrn: string;
  targetUrn: string;
  converge: boolean;
  scope: string;
}

/** Identity keys. A rollout's identity is `(component, targetClass)` and a convergence row's is
 *  `(component, target)` — the PAYLOAD is deliberately NOT part of either, which is what makes a
 *  changed strategy an `update` in place rather than the delete+create a hook gets. */
function rolloutKey(r: { componentUrn: string; targetClass: string }): string {
  return [r.componentUrn, r.targetClass].join("\u0000");
}

function convergenceKey(c: { componentUrn: string; targetUrn: string }): string {
  return [c.componentUrn, c.targetUrn].join("\u0000");
}

/** A role binding's identity is the WHOLE grant — the same triple `role_bindings_grant_key`
 *  (drizzle/0097) makes unique. Nothing is left over to be its "value", which is why the diff has
 *  no `update`: a different grant is a different binding, and showing it as an update would hide
 *  which authority went away. */
function roleBindingKey(b: { subjectUrn: string; roleName: string; scopeUrn: string }): string {
  return [b.subjectUrn, b.roleName, b.scopeUrn].join("\u0000");
}

export interface PlanDiffSnapshot {
  /** Live objects the diff must reason about, keyed by urn. See docs/iac.md §72. */
  existingObjects: ExistingObjectSnapshot[];
  /** Live relationship triples this stack manages. See docs/iac.md §73. */
  managedRelationships: ExistingRelationshipTriple[];
  /** Live relationship triples that exist for any reason. See docs/iac.md §74. */
  existingRelationships: ExistingRelationshipTriple[];
  /** Live source mappings hanging off objects this stack owns. See docs/iac.md §75. */
  managedSourceMappings: ResolvedManifestSourceMapping[];
  /** Live `executor_bindings` rows hanging off an object THIS stack owns — same one-pool rationale. */
  managedExecutorBindings: ResolvedManifestExecutorBinding[];
  /** Live `placement` objects whose COMPONENT this stack owns (decision Q4) — same one-pool
   *  rationale. Ownership follows the component, not the deployment-target, so a placement at a
   *  target owned by another stack is still this stack's to converge. */
  managedPlacements: ResolvedManifestPlacement[];
  /**
   * Live `dependency_line_producers` rows whose PRODUCER COMPONENT this stack owns — the PRUNE
   * pool, and the only one of the three producer inputs that is ownership-scoped.
   */
  managedDependencyProducers: ResolvedManifestDependencyProducer[];
  /** Live declarations for the coordinates this manifest names. See docs/iac.md §76. */
  existingDependencyProducers: ResolvedManifestDependencyProducer[];
  /** Live move rungs whose subject container this stack owns. See docs/iac.md §77. */
  managedGovernanceMoveRungs: string[];
  /** Live `pipeline_hooks` rows whose COMPONENT this stack owns. See docs/iac.md §78. */
  managedPipelineHooks: ResolvedManifestPipelineHook[];
  /** Rows on components this stack owns — the pool for both matching and pruning, exactly as for
   *  hooks. Always read (unlike the hook pool) because absent means empty here, so a prune is
   *  always in scope. */
  managedRollouts: ResolvedManifestRollout[];
  /** Bindings carrying THIS stack's `managed_by_stack` (drizzle/0108) — the prune population.
   *  Hand-granted bindings carry NULL and are invisible here, which is what stops one manifest
   *  revoking an Owner binding somebody granted through the typed door. */
  managedRoleBindings: ResolvedManifestRoleBinding[];
  managedRoles: { name: string; permissions: string[] }[];
  managedConvergence: ResolvedManifestConvergence[];
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

/** A hook's DIFF key. See docs/iac.md §79. */
function pipelineHookKey(h: ResolvedManifestPipelineHook): string {
  return canonicalJson({
    componentUrn: h.componentUrn,
    hookKind: h.hookKind,
    hookId: h.hookId,
    workflow: h.workflow,
    stage: h.stage,
    everySeconds: h.everySeconds,
    maxAgeSeconds: h.maxAgeSeconds,
    quietWindowSeconds: h.quietWindowSeconds
  });
}

/** The `pipeline_hooks_identity` tuple — the UNIQUE constraint, and the write key an apply uses.
 *  See {@link pipelineHookKey} for why the DIFF keys on more than this. */
function pipelineHookIdentityKey(h: ResolvedManifestPipelineHook): string {
  return canonicalJson({
    componentUrn: h.componentUrn,
    hookKind: h.hookKind,
    hookId: h.hookId
  });
}

/** Human-readable identity for a hook, for a refusal message. */
function describePipelineHook(h: {
  componentUrn: string;
  hookKind: string;
  hookId: string;
}): string {
  return `${h.hookKind} hook '${h.hookId}' on ${h.componentUrn}`;
}

/** The ref pattern is in the key and the other is deliberately out. See docs/iac.md §80. */
/** A producer declaration's identity. See docs/iac.md §81. */
function producerKey(p: { ecosystem: DependencyEcosystem; coordinate: string }): string {
  return canonicalJson({ ecosystem: p.ecosystem, coordinate: p.coordinate });
}

/** How a producer declaration reads in an error message — the coordinate, never the URN slug of it. */
function describeProducerCoordinate(p: {
  ecosystem: DependencyEcosystem;
  coordinate: string;
}): string {
  return `${p.ecosystem} '${p.coordinate}'`;
}

/** The stand-in urn when a producer object cannot be named. See docs/iac.md §82. */
const UNRESOLVED_PRODUCER_URN_PREFIX = "urn:scp:unresolvable:producer-object:";

/** @see UNRESOLVED_PRODUCER_URN_PREFIX */
export function unresolvedProducerUrn(producerObjectId: string): string {
  return `${UNRESOLVED_PRODUCER_URN_PREFIX}${producerObjectId}`;
}

/** @see UNRESOLVED_PRODUCER_URN_PREFIX */
export function isUnresolvedProducerUrn(urn: string): boolean {
  return urn.startsWith(UNRESOLVED_PRODUCER_URN_PREFIX);
}

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

/** A binding's identity. See docs/iac.md §83. */
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

/** The fields whose drift makes a binding an `update`. See docs/iac.md §84. */
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

/** Computes the create/update/delete/noop diff for one `@scp/iac` plan. See docs/iac.md §85. */
export function computePlanDiff(manifest: ResolvedManifest, snapshot: PlanDiffSnapshot): PlanDiff {
  const existingByUrn = new Map(snapshot.existingObjects.map((o) => [o.urn, o] as const));
  const manifestUrns = new Set(manifest.objects.map((o) => o.urn));

  let creates = 0;
  let updates = 0;
  let deletes = 0;
  let noops = 0;

  const objectEntries: PlanObjectDiffEntry[] = [];
  /** Collected across the WHOLE loop rather than thrown at the first one, so an operator fixing a
   *  bad manifest sees every conflicting URN at once instead of one per attempt. */
  const ownershipConflicts: { urn: string; ownedBy: string }[] = [];

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
    // ADOPTION AND THEFT ARE THE SAME READ, taken once and used twice: `managed_by_stack` is NULL
    // for an unmanaged object (adoptable), this stack's name (ordinary), or another stack's (theft).
    const adopted = existing !== undefined && existing.managedByStack === null;
    if (
      existing !== undefined &&
      existing.managedByStack !== null &&
      existing.managedByStack !== manifest.stackName
    ) {
      ownershipConflicts.push({ urn: obj.urn, ownedBy: existing.managedByStack });
    }
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
        // A `noop` CAN be an adoption: the declared state already matches, but ownership does not.
        // Apply still stamps it, so calling this a plain no-op would hide the one thing that
        // changes.
        reason: adopted
          ? "ADOPTING an unmanaged object; declared state already matches"
          : "matches current state",
        ...(adopted ? { adopted: true } : {})
      });
      noops++;
    } else {
      objectEntries.push({
        kind: "object",
        action: "update",
        urn: obj.urn,
        typeId: obj.typeId,
        // The reason SAYS adoption when it is one — §9 requires a review to see a stack claiming
        // existing estate, and "properties changed" would hide the part that matters.
        reason: adopted
          ? `ADOPTING an unmanaged object; ${changedFields.join(", ")} changed`
          : `${changedFields.join(", ")} changed`,
        ...(adopted ? { adopted: true } : {}),
        target
      });
      updates++;
    }
  }

  // Prune: objects this stack managed that the manifest dropped. See docs/iac.md §86.
  for (const existing of snapshot.existingObjects) {
    if (manifestUrns.has(existing.urn)) continue;
    if (!isStackManaged(existing.managedByStack, manifest.stackName)) continue;
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

  // Keyed to the ROWS (not a bare key set) so the scope convergence below can read what the live
  // tuple currently holds; several rows may share one key (no unique constraint on the table).
  const existingMappingsByKey = new Map<string, ResolvedManifestSourceMapping[]>();
  for (const managed of snapshot.managedSourceMappings) {
    const key = sourceMappingKey(managed);
    const rows = existingMappingsByKey.get(key);
    if (rows) rows.push(managed);
    else existingMappingsByKey.set(key, [managed]);
  }
  const manifestMappingKeys = new Set<string>();
  const sourceMappingEntries: PlanSourceMappingDiffEntry[] = [];

  for (const mapping of manifest.sourceMappings) {
    const key = sourceMappingKey(mapping);
    // A manifest declaring the same tuple twice would produce two identical create entries and
    // two identical rows on apply — the table has no unique constraint to stop it. Collapse to
    // one; the second declaration is redundant, not a second mapping.
    if (manifestMappingKeys.has(key)) continue;
    manifestMappingKeys.add(key);
    const existing = existingMappingsByKey.get(key);
    // §10.6 — the ONE in-place convergence this diff performs on a mapping. See docs/iac.md §87.
    const desiredScope = mapping.scope;
    const scopeDrifts =
      existing !== undefined &&
      desiredScope !== undefined &&
      existing.some((row) => (row.scope ?? null) !== desiredScope);
    const action = existing === undefined ? "create" : scopeDrifts ? "update" : "noop";
    const currentScope = existing?.[0]?.scope ?? null;
    sourceMappingEntries.push({
      kind: "source-mapping",
      action,
      componentUrn: mapping.componentUrn,
      sourceKind: mapping.sourceKind,
      repoPattern: mapping.repoPattern,
      pathPattern: mapping.pathPattern,
      refPattern: mapping.refPattern,
      type: mapping.type,
      classification: mapping.classification,
      mirrorOfShared: mapping.mirrorOfShared,
      enabled: mapping.enabled,
      // What the row WILL hold after apply: the declaration for create/update; the live value
      // (unmanaged, or already equal) for noop.
      scope: desiredScope !== undefined ? desiredScope : currentScope,
      reason:
        action === "create"
          ? "no existing source mapping with this identity"
          : action === "update"
            ? `scope differs: ${currentScope ?? "not declared"} -> ${desiredScope ?? "not declared"}`
            : "matches current state"
    });
    if (action === "noop") noops++;
    else if (action === "update") updates++;
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
    if (seenMappingPrunes.has(key)) continue;
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
      scope: managed.scope ?? null,
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
    // Two declarations for the same. See docs/iac.md §88.
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

  // DEPENDENCY-LINE PRODUCERS (ADR-0032 §7e). See docs/iac.md §89.
  let producerEntries: PlanDependencyProducerDiffEntry[] | undefined;
  if (manifest.producers !== null) {
    const entries: PlanDependencyProducerDiffEntry[] = [];
    const existingProducerByKey = new Map(
      snapshot.existingDependencyProducers.map((p) => [producerKey(p), p] as const)
    );
    const manifestProducerKeys = new Set<string>();

    for (const declaration of manifest.producers) {
      const key = producerKey(declaration);
      // Two declarations of one coordinate would race through the SAME primary-key row and the last
      // would silently win — the shape `duplicateProjectionDeclarations` rejects for bindings, for
      // the same reason. Collapsing here only keeps the diff well-formed; the rejection is the
      // caller's, before this output is used.
      if (manifestProducerKeys.has(key)) continue;
      manifestProducerKeys.add(key);

      const existing = existingProducerByKey.get(key);
      if (!existing) {
        entries.push({
          kind: "dependency-producer",
          action: "create",
          ecosystem: declaration.ecosystem,
          coordinate: declaration.coordinate,
          producerUrn: declaration.producerUrn,
          reason: `no producer is declared for ${describeProducerCoordinate(declaration)} — it is polled as third-party today`
        });
        creates++;
        continue;
      }
      if (existing.producerUrn === declaration.producerUrn) {
        entries.push({
          kind: "dependency-producer",
          action: "noop",
          ecosystem: declaration.ecosystem,
          coordinate: declaration.coordinate,
          producerUrn: declaration.producerUrn,
          reason: "matches current state"
        });
        noops++;
        continue;
      }
      entries.push({
        kind: "dependency-producer",
        action: "update",
        ecosystem: declaration.ecosystem,
        coordinate: declaration.coordinate,
        producerUrn: declaration.producerUrn,
        // THE TRANSFER, ON THE ENTRY THE OPERATOR REVIEWS. Also the input the ownership guard needs
        // to refuse a cross-stack steal from the STORED diff at apply time, without re-reading.
        displacedProducerUrn: existing.producerUrn,
        reason: `${describeProducerCoordinate(declaration)} is currently produced by '${existing.producerUrn}' — this plan TRANSFERS it`
      });
      updates++;
    }

    // THE PRUNE, reached only because the key was present. Sorted by identity so the reviewed diff
    // is stable regardless of row order from the DB, exactly like the mapping/placement prunes.
    const producerPrunes = [...snapshot.managedDependencyProducers]
      .filter((p) => !manifestProducerKeys.has(producerKey(p)))
      .sort((a, b) => producerKey(a).localeCompare(producerKey(b)));
    for (const managed of producerPrunes) {
      entries.push({
        kind: "dependency-producer",
        action: "delete",
        ecosystem: managed.ecosystem,
        coordinate: managed.coordinate,
        producerUrn: managed.producerUrn,
        reason:
          "declared on a component this stack owns, no longer present in the desired manifest's " +
          "producers — the coordinate RETURNS TO THIRD-PARTY POLLING"
      });
      deletes++;
    }
    producerEntries = entries;
  }

  // `governance:move` RUNGS (ADR-0038 §2; proposal §9.6 Q4). See docs/iac.md §90.
  let governanceMoveRungEntries: PlanGovernanceMoveRungDiffEntry[] | undefined;
  if (manifest.governanceMoveRungs !== null) {
    const entries: PlanGovernanceMoveRungDiffEntry[] = [];
    const live = new Set(snapshot.managedGovernanceMoveRungs);
    const declared = new Set<string>();

    for (const subjectUrn of manifest.governanceMoveRungs) {
      // Two declarations of one subject are one rung; collapsing keeps the diff well-formed (the
      // same treatment a duplicate producer coordinate gets). There is nothing to reject here — a
      // repeated rung is idempotent rather than ambiguous, because the collection carries no value
      // the two copies could disagree about.
      if (declared.has(subjectUrn)) continue;
      declared.add(subjectUrn);
      if (live.has(subjectUrn)) {
        entries.push({
          kind: "governance-move-rung",
          action: "noop",
          subjectUrn,
          reason: "matches current state"
        });
        noops++;
        continue;
      }
      entries.push({
        kind: "governance-move-rung",
        action: "create",
        subjectUrn,
        reason:
          "governance:move enforcement is not enabled at this container — this plan ENABLES it, so " +
          "every containment move under it will require 'governance:move' at BOTH ends"
      });
      creates++;
    }

    // THE PRUNE, reached only because the key was present. Sorted by subject so the reviewed diff is
    // stable regardless of row order from the DB, exactly like every other prune here.
    const prunes = [...live].filter((urn) => !declared.has(urn)).sort((a, b) => a.localeCompare(b));
    for (const subjectUrn of prunes) {
      entries.push({
        kind: "governance-move-rung",
        action: "delete",
        subjectUrn,
        reason:
          "enabled at a container this stack owns, no longer present in the desired manifest's " +
          "governanceMoveRungs — this plan DISABLES the bar (refused 409 at apply if an upper rung " +
          "is enabled, because an enablement above cannot be undone below)"
      });
      deletes++;
    }
    governanceMoveRungEntries = entries;
  }

  // PIPELINE HOOKS (D11/D21; migration 0096). See docs/iac.md §91.
  let pipelineHookEntries: PlanPipelineHookDiffEntry[] | undefined;
  if (manifest.pipelineHooks !== null) {
    const entries: PlanPipelineHookDiffEntry[] = [];
    const existingHookKeys = new Set(snapshot.managedPipelineHooks.map(pipelineHookKey));
    const manifestHookKeys = new Set<string>();

    const hookEntryFields = (h: ResolvedManifestPipelineHook) => ({
      componentUrn: h.componentUrn,
      hookKind: h.hookKind,
      hookId: h.hookId,
      workflow: h.workflow,
      stage: h.stage,
      everySeconds: h.everySeconds,
      maxAgeSeconds: h.maxAgeSeconds,
      quietWindowSeconds: h.quietWindowSeconds
    });

    for (const hook of manifest.pipelineHooks) {
      const key = pipelineHookKey(hook);
      // A byte-identical repeat is one hook, not two; collapsing keeps the diff well-formed. The
      // ambiguous case — two declarations sharing an IDENTITY but differing in payload — is not
      // collapsed here, it is REJECTED by `duplicateProjectionDeclarations` before this output is
      // ever used, because there the two copies disagree about what the gate is.
      if (manifestHookKeys.has(key)) continue;
      manifestHookKeys.add(key);
      const exists = existingHookKeys.has(key);
      entries.push({
        kind: "pipeline-hook",
        action: exists ? "noop" : "create",
        ...hookEntryFields(hook),
        reason: exists ? "matches current state" : "no existing pipeline hook with this declaration"
      });
      if (exists) noops++;
      else creates++;
    }

    // THE PRUNE, reached only because the key was present. Sorted by declaration so the reviewed
    // diff is stable regardless of row order from the DB, exactly like every other prune here.
    const hookPrunes = [...snapshot.managedPipelineHooks]
      .filter((h) => !manifestHookKeys.has(pipelineHookKey(h)))
      .sort((a, b) => pipelineHookKey(a).localeCompare(pipelineHookKey(b)));
    for (const managed of hookPrunes) {
      entries.push({
        kind: "pipeline-hook",
        action: "delete",
        ...hookEntryFields(managed),
        reason:
          "declared on a component this stack owns, no longer present in the desired manifest's " +
          "pipelineHooks — this plan DISARMS the gate"
      });
      deletes++;
    }
    pipelineHookEntries = entries;
  }

  // ROLLOUTS (D12) and CONVERGENCE (D25(b)). See docs/iac.md §92.
  const rolloutEntries: PlanRolloutDiffEntry[] = [];
  const existingRollouts = new Map(snapshot.managedRollouts.map((r) => [rolloutKey(r), r]));
  const declaredRolloutKeys = new Set<string>();
  for (const declared of manifest.rollouts) {
    const key = rolloutKey(declared);
    if (declaredRolloutKeys.has(key)) continue;
    declaredRolloutKeys.add(key);
    const existing = existingRollouts.get(key);
    const same =
      existing !== undefined && canonicalJson(existing.rollout) === canonicalJson(declared.rollout);
    rolloutEntries.push({
      kind: "rollout",
      action: existing === undefined ? "create" : same ? "noop" : "update",
      componentUrn: declared.componentUrn,
      targetClass: declared.targetClass,
      rollout: declared.rollout,
      reason:
        existing === undefined
          ? "no existing rollout for this component and target class"
          : same
            ? "matches current state"
            : "declared strategy differs from the stored one"
    });
    if (existing === undefined) creates++;
    else if (same) noops++;
    else updates++;
  }
  for (const managed of [...snapshot.managedRollouts]
    .filter((r) => !declaredRolloutKeys.has(rolloutKey(r)))
    .sort((a, b) => rolloutKey(a).localeCompare(rolloutKey(b)))) {
    rolloutEntries.push({
      kind: "rollout",
      action: "delete",
      componentUrn: managed.componentUrn,
      targetClass: managed.targetClass,
      rollout: null,
      reason:
        "declared on a component this stack owns, no longer present in the desired manifest's rollouts"
    });
    deletes++;
  }

  // ROLE BINDINGS (drizzle/0108). See docs/iac.md §93.
  const roleBindingEntries: PlanRoleBindingDiffEntry[] = [];
  const existingRoleBindings = new Map(
    snapshot.managedRoleBindings.map((b) => [roleBindingKey(b), b])
  );
  const declaredRoleBindingKeys = new Set<string>();
  for (const declared of manifest.roleBindings) {
    const key = roleBindingKey(declared);
    if (declaredRoleBindingKeys.has(key)) continue;
    declaredRoleBindingKeys.add(key);
    const exists = existingRoleBindings.has(key);
    roleBindingEntries.push({
      kind: "roleBinding",
      action: exists ? "noop" : "create",
      subjectUrn: declared.subjectUrn,
      roleName: declared.roleName,
      scopeUrn: declared.scopeUrn,
      reason: exists
        ? "matches current state"
        : "no existing binding for this subject, role and scope"
    });
    if (exists) noops++;
    else creates++;
  }
  for (const managed of [...snapshot.managedRoleBindings]
    .filter((b) => !declaredRoleBindingKeys.has(roleBindingKey(b)))
    .sort((a, b) => roleBindingKey(a).localeCompare(roleBindingKey(b)))) {
    roleBindingEntries.push({
      kind: "roleBinding",
      action: "delete",
      subjectUrn: managed.subjectUrn,
      roleName: managed.roleName,
      scopeUrn: managed.scopeUrn,
      // Worded as what it DOES, not as what the manifest omits — this line is the review surface
      // for someone losing access.
      reason:
        "granted by this stack, no longer declared — applying this plan REVOKES this subject's " +
        `'${managed.roleName}' at this scope`
    });
    deletes++;
  }

  // -----------------------------------------------------------------------------------------
  // ORG ROLES — create/update/delete. `update` IS meaningful: a role's identity is its NAME and
  // its permission set is its value, so widening one is a change in place.
  // -----------------------------------------------------------------------------------------
  const roleEntries: PlanRoleDiffEntry[] = [];
  const existingRoles = new Map(snapshot.managedRoles.map((r) => [r.name, r]));
  const declaredRoleNames = new Set<string>();
  for (const declared of manifest.roles) {
    if (declaredRoleNames.has(declared.name)) continue;
    declaredRoleNames.add(declared.name);
    const existing = existingRoles.get(declared.name);
    const same =
      existing !== undefined &&
      canonicalJson([...existing.permissions].sort()) ===
        canonicalJson([...declared.permissions].sort());
    roleEntries.push({
      kind: "role",
      action: existing === undefined ? "create" : same ? "noop" : "update",
      name: declared.name,
      permissions: declared.permissions,
      reason:
        existing === undefined
          ? "no existing org role of this name"
          : same
            ? "matches current state"
            : "declared permissions differ from the stored set"
    });
    if (existing === undefined) creates++;
    else if (same) noops++;
    else updates++;
  }
  for (const managed of [...snapshot.managedRoles]
    .filter((r) => !declaredRoleNames.has(r.name))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    roleEntries.push({
      kind: "role",
      action: "delete",
      name: managed.name,
      permissions: null,
      // The delete door refuses while any binding still points at the role, so this line can fail
      // LOUDLY at apply rather than performing an unreviewable mass revoke.
      reason: "authored by this stack, no longer declared"
    });
    deletes++;
  }

  const convergenceEntries: PlanConvergenceDiffEntry[] = [];
  const existingConvergence = new Map(
    snapshot.managedConvergence.map((c) => [convergenceKey(c), c])
  );
  const declaredConvergenceKeys = new Set<string>();
  for (const declared of manifest.convergence) {
    const key = convergenceKey(declared);
    if (declaredConvergenceKeys.has(key)) continue;
    declaredConvergenceKeys.add(key);
    const existing = existingConvergence.get(key);
    const same =
      existing !== undefined &&
      existing.converge === declared.converge &&
      existing.scope === declared.scope;
    convergenceEntries.push({
      kind: "convergence",
      action: existing === undefined ? "create" : same ? "noop" : "update",
      componentUrn: declared.componentUrn,
      targetUrn: declared.targetUrn,
      // `false` is a DECLARED VALUE, not an absence — a plan showing `converge: false` is showing
      // an opt-out someone wrote, which is exactly why D8 makes the manifest say which.
      converge: declared.converge,
      scope: declared.scope,
      reason:
        existing === undefined
          ? "no existing convergence declaration for this component and product"
          : same
            ? "matches current state"
            : "declared convergence differs from the stored one"
    });
    if (existing === undefined) creates++;
    else if (same) noops++;
    else updates++;
  }
  for (const managed of [...snapshot.managedConvergence]
    .filter((c) => !declaredConvergenceKeys.has(convergenceKey(c)))
    .sort((a, b) => convergenceKey(a).localeCompare(convergenceKey(b)))) {
    convergenceEntries.push({
      kind: "convergence",
      action: "delete",
      componentUrn: managed.componentUrn,
      targetUrn: managed.targetUrn,
      converge: null,
      scope: null,
      reason:
        "declared on a component this stack owns, no longer present in the desired manifest's convergence"
    });
    deletes++;
  }

  // REFUSED BEFORE ANYTHING IS RETURNED, so a stolen object cannot appear in a reviewable plan at
  // all. `plans-repo.ts` maps this to a 409 at BOTH doors — plan computation and apply — because a
  // plan is stored and applied later, and ownership can change in between.
  if (ownershipConflicts.length > 0) {
    throw new StackOwnershipConflictError(ownershipConflicts, manifest.stackName);
  }

  return {
    objects: objectEntries,
    relationships: relationshipEntries,
    sourceMappings: sourceMappingEntries,
    executorBindings: executorBindingEntries,
    placements: placementEntries,
    // OMITTED, not `[]`, when the stack manages no producers — the absent key IS the statement.
    ...(producerEntries !== undefined ? { producers: producerEntries } : {}),
    // Same rule, same reason — see `ResolvedManifest.governanceMoveRungs`.
    ...(governanceMoveRungEntries !== undefined
      ? { governanceMoveRungs: governanceMoveRungEntries }
      : {}),
    // Same rule, same reason — see `ResolvedManifest.pipelineHooks`.
    ...(pipelineHookEntries !== undefined ? { pipelineHooks: pipelineHookEntries } : {}),
    // ORDINARY RULE, so these are emitted whenever they have content and omitted when empty — the
    // omission carries no meaning here (absent and empty are the same), it just keeps a manifest
    // that declares neither byte-identical to one from before they existed.
    ...(rolloutEntries.length > 0 ? { rollouts: rolloutEntries } : {}),
    ...(roleBindingEntries.length > 0 ? { roleBindings: roleBindingEntries } : {}),
    ...(roleEntries.length > 0 ? { roles: roleEntries } : {}),
    ...(convergenceEntries.length > 0 ? { convergence: convergenceEntries } : {}),
    summary: { creates, updates, deletes, noops }
  };
}

/** Components this plan creates with no incoming containment. See docs/iac.md §94. */
/** Readable descriptions of the entries this plan may not write. See docs/iac.md §95. */
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
  // A coordinate declared twice. See docs/iac.md §96.
  const seenProducers = new Set<string>();
  for (const declaration of manifest.producers ?? []) {
    const key = producerKey(declaration);
    if (seenProducers.has(key)) {
      offenders.push(
        `producer ${describeProducerCoordinate(declaration)} (-> ${declaration.producerUrn})`
      );
      continue;
    }
    seenProducers.add(key);
  }
  // A hook is keyed on its identity here, not its declaration. See docs/iac.md §97.
  const seenHooks = new Map<string, string>();
  for (const hook of manifest.pipelineHooks ?? []) {
    const identity = pipelineHookIdentityKey(hook);
    const declaration = pipelineHookKey(hook);
    const first = seenHooks.get(identity);
    if (first === undefined) {
      seenHooks.set(identity, declaration);
      continue;
    }
    if (first === declaration) continue;
    offenders.push(describePipelineHook(hook));
  }
  return offenders;
}

/** The object type a producer declaration must name — mirrored from `assertDeclarableProducer`. */
const PRODUCER_TYPE_ID = "component";

/** Readable descriptions of producer declarations it may not make. See docs/iac.md §98. */
export function invalidProducerDeclarations(diff: PlanDiff): string[] {
  const ownedUrns = new Set<string>();
  const typeByUrn = new Map<string, string>();
  /** Every URN this stack owns OR owned — see refusal (2) on why a `delete` entry counts. */
  const stackUrns = new Set<string>();
  for (const obj of diff.objects) {
    stackUrns.add(obj.urn);
    if (obj.action !== "delete") {
      ownedUrns.add(obj.urn);
      typeByUrn.set(obj.urn, obj.typeId);
    }
  }

  const offenders: string[] = [];
  for (const entry of diff.producers ?? []) {
    const coordinate = `${entry.ecosystem} '${entry.coordinate}'`;
    if (entry.action !== "delete") {
      if (!ownedUrns.has(entry.producerUrn)) {
        offenders.push(
          `producer ${coordinate} -> ${entry.producerUrn}, which this stack does not manage`
        );
        continue;
      }
      const typeId = typeByUrn.get(entry.producerUrn);
      if (typeId !== PRODUCER_TYPE_ID) {
        offenders.push(
          typeId === "service"
            ? `producer ${coordinate} -> ${entry.producerUrn}, which is a SERVICE — a service-valued ` +
                `declaration is refused in the first cut (ADR-0032 §7e): it would remove the coordinate ` +
                `from third-party polling and derive no head at all. Declare the component that ` +
                `publishes the artifact`
            : `producer ${coordinate} -> ${entry.producerUrn}, which is a ${typeId ?? "non-object"}, not a component`
        );
        continue;
      }
    }
    if (entry.displacedProducerUrn && isUnresolvedProducerUrn(entry.displacedProducerUrn)) {
      // REFUSAL (2b) — the same displacement, with the holder unnameable. Its own branch rather than
      // set membership: see {@link UNRESOLVED_PRODUCER_URN_PREFIX} for why a real URN here could be
      // made to pass the membership test on precisely the plan that must be refused.
      offenders.push(
        `producer ${coordinate} is currently declared on a producer object that no longer resolves ` +
          `(${entry.displacedProducerUrn}) — the component was deleted and the declaration outlived ` +
          `it, so this plan would OVERWRITE a standing declaration rather than make a first one. ` +
          `Retract it through POST /dependencies/producers/retract, which reports the bumps already ` +
          `in flight, and then declare`
      );
    } else if (entry.displacedProducerUrn && !stackUrns.has(entry.displacedProducerUrn)) {
      offenders.push(
        `producer ${coordinate} is currently produced by ${entry.displacedProducerUrn}, which this ` +
          `stack does not manage — a transfer away from another stack's component must go through ` +
          `POST /dependencies/producers, which reports the blast radius and the bumps in flight`
      );
    }
  }
  return offenders;
}

/** Readable descriptions of move rungs this plan may not write. See docs/iac.md §99. */
export function invalidGovernanceMoveRungDeclarations(diff: PlanDiff): string[] {
  const typeByUrn = new Map<string, string>();
  for (const obj of diff.objects) {
    if (obj.action !== "delete") typeByUrn.set(obj.urn, obj.typeId);
  }

  const offenders: string[] = [];
  for (const entry of diff.governanceMoveRungs ?? []) {
    if (entry.action === "delete") continue;
    const typeId = typeByUrn.get(entry.subjectUrn);
    if (typeId === undefined) {
      offenders.push(
        `governance:move rung at ${entry.subjectUrn}, which this stack does not manage — a rung's ` +
          `ownership is inherited from its subject container, so declare that container in this ` +
          `stack's manifest, or enable the rung through PUT /governance/move-enforcement/rungs`
      );
      continue;
    }
    if (!moveRungTierForObjectType(typeId)) {
      offenders.push(
        `governance:move rung at ${entry.subjectUrn}, which is a '${typeId}' — a rung sits on a ` +
          `CONTAINER (the org root, a containment domain, a service or an assembly), because it ` +
          `governs moves of the things inside it, and nothing is contained by a '${typeId}'`
      );
    }
  }
  return offenders;
}

/** Readable descriptions of the entries this plan may not touch. See docs/iac.md §100. */
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
    // The pair must ALSO survive this plan. See docs/iac.md §101.
    if (
      binding.deploymentTargetUrn &&
      !declaredPlacements.has(canonicalJson([binding.targetUrn, binding.deploymentTargetUrn]))
    ) {
      offenders.push(
        `executorBinding -> ${describeDiffTarget(binding)} (${binding.type}), whose pair this manifest does not declare in placements`
      );
    }
  }
  // PIPELINE HOOKS, under the identical rule and for the identical reason. See docs/iac.md §102.
  for (const hook of diff.pipelineHooks ?? []) {
    if (hook.action === "delete") continue;
    if (!ownedUrns.has(hook.componentUrn)) {
      offenders.push(`pipelineHook -> ${describePipelineHook(hook)}`);
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
