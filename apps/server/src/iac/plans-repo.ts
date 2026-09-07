import { and, eq, inArray, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type {
  DependencyLineProducer,
  DesiredStateManifest,
  ManifestPipelineHook,
  Plan,
  PlanDependencyProducerDiffEntry,
  PlanDiff,
  PlanExecutorBindingDiffEntry,
  PlanStatus,
  WorkflowRef
} from "@scp/schemas";
import { containmentDomainIdFromWire } from "../domain-id-edge.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects, plans, relationships, roleBindings, roles } from "../db/schema.js";
import {
  createStackManagedRoleBinding,
  deleteStackManagedRole,
  deleteStackManagedRoleBinding,
  upsertStackManagedRole
} from "./iac-rbac-apply.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import type { Permission } from "../authz/resolve.js";
import {
  createObject,
  deleteObject,
  getObjectByIdOrUrn,
  getObjectByIdOrUrnAnyType,
  resolveDomainId,
  updateObject
} from "../graph/objects-repo.js";
import {
  createRelationship,
  deleteRelationship,
  listRelationships
} from "../graph/relationships-repo.js";
import {
  isGovernanceManagedObjectType,
  isProjectionBoundObjectType,
  projectionBoundRefusalDetail
} from "../governance/governance-managed-types.js";
import { isPeerBoundObjectType } from "../federation/outpost-binding.js";
import { isPairBoundObjectType } from "../graph/pair-bound-types.js";
import { isSystemManagedRelationshipType } from "../graph/system-managed-relationships.js";
import { assertPolicyScopeWithinAuthority } from "../governance/policy-scope-authz.js";
import { assertCampaignTargetsWithinAuthority } from "../coordination/campaign-scope-authz.js";
import {
  assertGovernanceMoveAdmits,
  assertRungSubjectType,
  listGovernanceMoveRungs
} from "../governance/move-enforcement.js";
import {
  disableGovernanceMoveRungWithEffects,
  enableGovernanceMoveRungWithEffects,
  governanceMoveRungScopeCheck
} from "../governance/move-rung-write.js";
import {
  computePlanDiff,
  StackOwnershipConflictError,
  CONTAINS_TYPE_ID,
  duplicateProjectionDeclarations,
  invalidGovernanceMoveRungDeclarations,
  invalidProducerDeclarations,
  managedLabels,
  uncontainedComponentCreates,
  unownedProjectionDeclarations,
  unresolvedProducerUrn,
  type ExistingObjectSnapshot,
  type ExistingRelationshipTriple,
  type ResolvedManifest,
  type ResolvedManifestDependencyProducer,
  type ResolvedManifestExecutorBinding,
  type ResolvedManifestObject,
  type ResolvedManifestConvergence,
  type ResolvedManifestPipelineHook,
  type ResolvedManifestRollout,
  type ResolvedManifestRoleBinding,
  type ResolvedManifestPlacement,
  type ResolvedManifestSourceMapping
} from "./plan-diff.js";
import { stampObjectStackOwnership, stampRelationshipStackOwnership } from "./stack-ownership.js";
import {
  getDependencyLineProducer,
  listDependencyLineProducersForComponents
} from "../dependencies/dependency-inventory-repo.js";
import {
  declareProducerWithEffects,
  dependencyProducerScopeCheck,
  retractProducerWithEffects
} from "../dependencies/producer-declaration.js";
import {
  DEFAULT_BINDING_TYPE,
  EXECUTION_SYSTEM_INSTANCE_PREFIX,
  deleteExecutorBinding,
  executionSystemBindingIdentity,
  isKnownExecutorModule,
  listExecutorBindingsForTarget,
  listExecutorBindingsForTargets,
  upsertExecutorBinding
} from "../coordination/executor-bindings-repo.js";
import {
  createPlacement,
  findLivePlacement,
  listPlacementsForComponents,
  withdrawPlacement
} from "../graph/placements-repo.js";
import {
  createSourceMapping,
  deleteSourceMappingsMatching,
  listSourceMappingsForComponents,
  setSourceMappingScopeMatching
} from "../coordination/source-mappings-repo.js";
import {
  deleteHook,
  listHooksForComponents,
  upsertHook
} from "../coordination/pipeline-hooks-repo.js";
import {
  deleteComponentConvergence,
  deleteComponentRollout,
  listConvergenceForComponents,
  listRolloutsForComponents,
  upsertComponentConvergence,
  upsertComponentRollout
} from "./rollout-convergence-repo.js";
import { validatePluginConfig } from "../plugin-host/plugin-manifests.js";

/** Rejects a diff creating a component with no owning service. See docs/iac.md §103. */
function assertComponentsContained(diff: PlanDiff): void {
  const uncontained = uncontainedComponentCreates(diff);
  if (uncontained.length === 0) return;
  throw badRequest(
    `plan creates component(s) with no container (no incoming 'contains' edge): ` +
      `${uncontained.join(", ")}. A component must belong to a service or an assembly — create it ` +
      `with \`new Component(stack, id, { service })\` or add a 'contains' relationship from a ` +
      `service or assembly.`
  );
}

/** Rejects a plan that would write such a row it may not. See docs/iac.md §104. */
function assertProjectionsOwned(diff: PlanDiff): void {
  const unowned = unownedProjectionDeclarations(diff);
  if (unowned.length === 0) return;
  throw badRequest(
    `plan declares source mapping(s)/executor binding(s)/pipeline hook(s) on object(s) this stack ` +
      `does not manage: ${unowned.join(", ")}. None of those tables carries an owner of its own, so ` +
      `ownership is inherited from the object the row hangs off — declare that object in this ` +
      `stack's manifest (which adopts it), or configure it from the stack that already manages it.`
  );
}

/** Rejects a plan whose producer declarations it may not make. See docs/iac.md §105. */
/** Rejects a plan whose move-rung declarations it may not make. See docs/iac.md §106. */
function assertGovernanceMoveRungsValid(diff: PlanDiff): void {
  const invalid = invalidGovernanceMoveRungDeclarations(diff);
  if (invalid.length === 0) return;
  throw badRequest(
    `plan declares governance:move rung(s) it may not: ${invalid.join("; ")}. ` +
      `'governance_move_rungs' carries no stack labels, so ownership is inherited from the SUBJECT ` +
      `CONTAINER — declare that container in this stack's manifest, or enable the rung through ` +
      `PUT /governance/move-enforcement/rungs/{idOrUrn}.`
  );
}

function assertProducerDeclarationsValid(diff: PlanDiff): void {
  const invalid = invalidProducerDeclarations(diff);
  if (invalid.length === 0) return;
  throw badRequest(
    `plan declares dependency-line producer(s) it may not: ${invalid.join("; ")}. ` +
      `'dependency_line_producers' carries no stack labels, so ownership is inherited from the ` +
      `producing COMPONENT — declare that component in this stack's manifest, or use ` +
      `POST /dependencies/producers.`
  );
}

/** Rejects a manifest declaring the same thing twice. See docs/iac.md §107. */
/** A manifest hook, flattened to the row shape the diff keys on. See docs/iac.md §108. */
function resolvePipelineHook(hook: ManifestPipelineHook): ResolvedManifestPipelineHook {
  const base = {
    componentUrn: hook.componentUrn,
    hookKind: hook.kind,
    hookId: hook.hookId,
    everySeconds: null,
    maxAgeSeconds: null,
    quietWindowSeconds: null
  };
  switch (hook.kind) {
    case "postMerge":
      return { ...base, hookKind: "postMerge", workflow: hook.workflow, stage: null };
    case "postDeploy":
      return {
        ...base,
        hookKind: "postDeploy",
        workflow: hook.workflow,
        // ABSENT = EVERY WAVE, the strict end of the range (D21(a)) — `null` on the row IS that
        // statement, not an unset field.
        stage: hook.stage ?? null
      };
    case "continuous":
      return {
        ...base,
        hookKind: "continuous",
        workflow: hook.workflow,
        stage: null,
        everySeconds: hook.everySeconds,
        maxAgeSeconds: hook.maxAgeSeconds
      };
    case "bakeAlarms":
      return {
        ...base,
        hookKind: "bakeAlarms",
        workflow: null,
        stage: hook.stage ?? null,
        quietWindowSeconds: hook.quietWindowSeconds
      };
  }
}

function assertProjectionsUnique(manifest: ResolvedManifest): void {
  const duplicates = duplicateProjectionDeclarations(manifest);
  if (duplicates.length === 0) return;
  throw badRequest(
    `manifest declares the same configuration twice: ${duplicates.join(", ")}. ` +
      `A source mapping is identified by its whole tuple, an executor binding by (target, type), and ` +
      `a pipeline hook by (componentUrn, kind, hookId) — remove the duplicate rather than relying ` +
      `on which one wins.`
  );
}

/** Runs the same three checks for every inline binding. See docs/iac.md §109. */
function bindingTargetLabel(entry: PlanExecutorBindingDiffEntry): string {
  return entry.deploymentTargetUrn
    ? `placement ${entry.targetUrn}@${entry.deploymentTargetUrn}`
    : entry.targetUrn;
}

function assertInlineBindingsValid(diff: PlanDiff): void {
  for (const entry of diff.executorBindings ?? []) {
    if (entry.action !== "create" && entry.action !== "update") continue;
    const target = entry.target;
    if (!target || target.executionSystemId) continue;
    if (!target.pluginModule || !isKnownExecutorModule(target.pluginModule)) {
      throw badRequest(
        `executor binding for '${bindingTargetLabel(entry)}' (${entry.type}) names unknown or non-executor plugin module '${target.pluginModule}'`
      );
    }
    // Same rejection the route makes, surfaced as a 400 rather than `assertNotReservedInstanceId`'s
    // internal-error throw (which is the repo's last-ditch net, not a user-facing message).
    if (target.pluginInstanceId?.startsWith(EXECUTION_SYSTEM_INSTANCE_PREFIX)) {
      throw badRequest(
        `executor binding for '${bindingTargetLabel(entry)}' (${entry.type}) uses the reserved ` +
          `'${EXECUTION_SYSTEM_INSTANCE_PREFIX}' pluginInstanceId namespace — declare executionSystemId instead`
      );
    }
    validatePluginConfig(target.pluginModule, target.config);
  }
}

/** The thin database wrapper around the pure diff engine. See docs/iac.md §110. */

async function fetchObjectsByUrns(tx: TenantTx, orgId: string, urns: string[]) {
  if (urns.length === 0) return [];
  return tx
    .select()
    .from(objects)
    .where(and(eq(objects.orgId, orgId), inArray(objects.urn, urns), isNull(objects.deletedAt)));
}

async function fetchObjectsByIds(tx: TenantTx, orgId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return tx
    .select()
    .from(objects)
    .where(and(eq(objects.orgId, orgId), inArray(objects.id, ids), isNull(objects.deletedAt)));
}

/** The URN of one object by id, TOMBSTONES INCLUDED. See docs/iac.md §111. */
async function objectUrnByIdIncludingTombstones(
  tx: TenantTx,
  orgId: string,
  id: string
): Promise<string | null> {
  const [row] = await tx
    .select({ urn: objects.urn })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), eq(objects.id, id)))
    .limit(1);
  return row?.urn ?? null;
}

/** Live objects this stack OWNS. See docs/iac.md §112. */
async function fetchManagedObjects(tx: TenantTx, orgId: string, stackName: string) {
  return tx
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        isNull(objects.deletedAt),
        eq(objects.managedByStack, stackName)
      )
    );
}

/** Live relationships this stack owns — the relationship prune pool. Same column, same reason. */
/** Bindings THIS stack owns. See docs/iac.md §113. */
async function listStackManagedRoleBindings(tx: TenantTx, orgId: string, stackName: string) {
  return tx
    .select({
      subjectId: roleBindings.subjectId,
      scopeObjectId: roleBindings.scopeObjectId,
      roleName: roles.name
    })
    .from(roleBindings)
    .innerJoin(roles, eq(roles.id, roleBindings.roleId))
    .where(
      and(
        eq(roleBindings.orgId, orgId),
        eq(roleBindings.managedByStack, stackName),
        eq(roleBindings.effect, "allow")
      )
    );
}

/** Org roles THIS stack authored. Built-ins carry `org_id IS NULL` and can never match. */
async function listStackManagedRoles(tx: TenantTx, orgId: string, stackName: string) {
  return tx
    .select({ name: roles.name, permissions: roles.permissions })
    .from(roles)
    .where(and(eq(roles.orgId, orgId), eq(roles.managedByStack, stackName)));
}

async function fetchManagedRelationships(tx: TenantTx, orgId: string, stackName: string) {
  return tx
    .select()
    .from(relationships)
    .where(
      and(
        eq(relationships.orgId, orgId),
        isNull(relationships.deletedAt),
        eq(relationships.managedByStack, stackName)
      )
    );
}

/** Live relationships between any two of `objectIds` — the "does this already exist" pool for create/noop determination. */
async function fetchRelationshipsAmong(tx: TenantTx, orgId: string, objectIds: string[]) {
  if (objectIds.length === 0) return [];
  return tx
    .select()
    .from(relationships)
    .where(
      and(
        eq(relationships.orgId, orgId),
        isNull(relationships.deletedAt),
        inArray(relationships.fromId, objectIds),
        inArray(relationships.toId, objectIds)
      )
    );
}

function toTriple(
  row: { typeId: string; fromId: string; toId: string },
  objectsById: Map<string, { urn: string }>
): ExistingRelationshipTriple | null {
  const from = objectsById.get(row.fromId);
  const to = objectsById.get(row.toId);
  if (!from || !to) return null; // defensive — closed by the "unresolved ids" follow-up query below
  return { typeId: row.typeId, fromUrn: from.urn, toUrn: to.urn };
}

/** Assembles a snapshot from live state and runs the diff. See docs/iac.md §114. */
export async function computeDiffForManifest(
  tx: TenantTx,
  orgId: string,
  manifest: DesiredStateManifest
): Promise<PlanDiff> {
  const resolvedObjects: ResolvedManifestObject[] = [];
  for (const obj of manifest.objects) {
    // WIRE BOUNDARY (ADR-0021 D4) — see src/domain-id-edge.ts: the IaC manifest's `domainId` is
    // a plain string in `DesiredStateManifestSchema`, and names a CONTAINMENT parent.
    const domainId = await resolveDomainId(
      tx,
      orgId,
      containmentDomainIdFromWire(obj.domainId) ?? undefined
    );
    resolvedObjects.push({
      urn: obj.urn,
      typeId: obj.typeId,
      name: obj.name,
      domainId,
      properties: obj.properties ?? {},
      labels: obj.labels ?? {}
    });
  }

  // `governance:move` RUNG SUBJECTS. See docs/iac.md §115.
  const declaredObjectUrns = new Set(manifest.objects.map((o) => o.urn));
  let resolvedRungSubjectUrns: string[] | null = null;
  if (manifest.governanceMoveRungs !== undefined) {
    resolvedRungSubjectUrns = [];
    for (const rung of manifest.governanceMoveRungs) {
      if (declaredObjectUrns.has(rung.subjectIdOrUrn)) {
        resolvedRungSubjectUrns.push(rung.subjectIdOrUrn);
        continue;
      }
      let resolved;
      try {
        resolved = await getObjectByIdOrUrnAnyType(tx, orgId, rung.subjectIdOrUrn);
      } catch {
        throw badRequest(
          `governance:move rung names subject '${rung.subjectIdOrUrn}', which does not exist and is ` +
            `not declared by this manifest`
        );
      }
      resolvedRungSubjectUrns.push(resolved.urn);
    }
  }

  const referencedUrns = new Set<string>();
  for (const obj of manifest.objects) referencedUrns.add(obj.urn);
  // A rung's owning object is its SUBJECT CONTAINER — the row hangs off it and inherits its
  // ownership, the same rule a source mapping's component and a producer's component get.
  for (const subjectUrn of resolvedRungSubjectUrns ?? []) referencedUrns.add(subjectUrn);
  for (const rel of manifest.relationships) {
    referencedUrns.add(rel.fromUrn);
    referencedUrns.add(rel.toUrn);
  }
  // C1: a mapping/binding's owning object must be resolvable too — it is what the row hangs off and
  // what its ownership is inherited from.
  for (const mapping of manifest.sourceMappings ?? []) referencedUrns.add(mapping.componentUrn);
  for (const placement of manifest.placements ?? []) {
    referencedUrns.add(placement.componentUrn);
    referencedUrns.add(placement.deploymentTargetUrn);
  }
  // A producer declaration's owning object is its PRODUCER COMPONENT — the row hangs off it and
  // inherits its ownership, the same rule a source mapping's component gets.
  for (const declaration of manifest.producers ?? []) referencedUrns.add(declaration.producerUrn);
  // A hook's owning object is its COMPONENT — the row hangs off it and inherits its ownership, the
  // same rule a source mapping's component and a producer's component get.
  for (const hook of manifest.pipelineHooks ?? []) referencedUrns.add(hook.componentUrn);
  // A role binding names TWO objects and OWNS NEITHER. See docs/iac.md §116.
  for (const binding of manifest.roleBindings ?? []) {
    referencedUrns.add(binding.subjectUrn);
    referencedUrns.add(binding.scopeUrn);
  }
  for (const binding of manifest.executorBindings ?? []) {
    referencedUrns.add(binding.targetUrn);
    // A placement-targeted binding resolves BOTH halves at apply, never the placement itself —
    // its URN is derived (ADR-0026 D3) rather than something a manifest names.
    if (binding.deploymentTargetUrn) referencedUrns.add(binding.deploymentTargetUrn);
  }

  const [referencedRows, managedObjectRows] = await Promise.all([
    fetchObjectsByUrns(tx, orgId, [...referencedUrns]),
    fetchManagedObjects(tx, orgId, manifest.stackName)
  ]);

  const objectsByUrn = new Map<string, (typeof referencedRows)[number]>();
  const objectsById = new Map<string, (typeof referencedRows)[number]>();
  for (const row of [...referencedRows, ...managedObjectRows]) {
    objectsByUrn.set(row.urn, row);
    objectsById.set(row.id, row);
  }

  const managedRelRows = await fetchManagedRelationships(tx, orgId, manifest.stackName);

  // Resolve URNs for any managed-relationship endpoint id not already known (an "external"
  // reference this round's manifest no longer mentions — plan-diff.ts's PlanDiffSnapshot doc).
  const unresolvedIds = new Set<string>();
  for (const row of managedRelRows) {
    if (!objectsById.has(row.fromId)) unresolvedIds.add(row.fromId);
    if (!objectsById.has(row.toId)) unresolvedIds.add(row.toId);
  }
  if (unresolvedIds.size > 0) {
    const extra = await fetchObjectsByIds(tx, orgId, [...unresolvedIds]);
    for (const row of extra) {
      objectsByUrn.set(row.urn, row);
      objectsById.set(row.id, row);
    }
  }

  const existingObjects: ExistingObjectSnapshot[] = [...objectsByUrn.values()].map((row) => ({
    urn: row.urn,
    typeId: row.typeId,
    name: row.name,
    domainId: row.domainId,
    properties: row.properties as Record<string, unknown>,
    labels: row.labels as Record<string, unknown>,
    managedByStack: row.managedByStack
  }));

  const managedRelationships = managedRelRows
    .map((row) => toTriple(row, objectsById))
    .filter((t): t is ExistingRelationshipTriple => t !== null);

  const candidateRelRows = await fetchRelationshipsAmong(tx, orgId, [...objectsById.keys()]);
  const existingRelationships = [...candidateRelRows, ...managedRelRows]
    .map((row) => toTriple(row, objectsById))
    .filter((t): t is ExistingRelationshipTriple => t !== null);

  // C1 — the ownership pool for `source_mappings`/`executor_bindings`. See docs/iac.md §117.
  const manifestObjectUrns = new Set(manifest.objects.map((o) => o.urn));
  const ownedObjectIds = new Set<string>();
  for (const row of managedObjectRows) ownedObjectIds.add(row.id);
  for (const urn of manifestObjectUrns) {
    const row = objectsByUrn.get(urn);
    if (row) ownedObjectIds.add(row.id);
  }
  const ownedIdList = [...ownedObjectIds];

  const [ownedMappingRows, ownedPlacementRows] = await Promise.all([
    listSourceMappingsForComponents(tx, orgId, ownedIdList),
    // Decision Q4: ownership follows the COMPONENT, so the pool is keyed on owned components — a
    // placement at a deployment-target another stack owns is still this stack's to converge.
    listPlacementsForComponents(tx, orgId, ownedIdList)
  ]);

  // THE BINDING POOL SPANS OBJECTS *AND* PLACEMENTS. See docs/iac.md §118.
  const ownedBindingRows = await listExecutorBindingsForTargets(tx, orgId, [
    ...ownedIdList,
    ...ownedPlacementRows.map((row) => row.placementId)
  ]);

  const urnOfOwnedId = (id: string): string | undefined => objectsById.get(id)?.urn;

  const managedPlacements: ResolvedManifestPlacement[] = [];
  /** placement id -> its pair, so a binding row hanging off a placement resolves to the SAME
   *  addressing a manifest uses. A placement whose pair does not resolve is absent from this map,
   *  which drops its bindings from the pool too — invisible to both create-matching and prune,
   *  never mis-attributed. */
  const placementPairById = new Map<
    string,
    { componentUrn: string; deploymentTargetUrn: string }
  >();
  for (const row of ownedPlacementRows) {
    const componentUrn = urnOfOwnedId(row.componentObjectId);
    // The deployment-target may belong to ANOTHER stack, so resolve it from the wider by-id map. A
    // miss (it vanished, or was never loaded) drops the row: invisible to BOTH create-matching and
    // prune, which is the conservative half — never mis-attributed to another pair.
    const targetUrn = objectsById.get(row.deploymentTargetObjectId)?.urn;
    if (!componentUrn || !targetUrn) continue;
    managedPlacements.push({ componentUrn, deploymentTargetUrn: targetUrn });
    placementPairById.set(row.placementId, { componentUrn, deploymentTargetUrn: targetUrn });
  }

  const managedSourceMappings: ResolvedManifestSourceMapping[] = [];
  for (const row of ownedMappingRows) {
    const componentUrn = urnOfOwnedId(row.componentObjectId);
    // Defensive: every owned id came from a row already in `objectsById`. A miss would mean the
    // object vanished mid-transaction; dropping it is safe (it becomes invisible to the diff, so
    // the plan neither prunes nor duplicates it) — never silently mis-attributed to another URN.
    if (!componentUrn) continue;
    managedSourceMappings.push({
      componentUrn,
      sourceKind: row.sourceKind,
      repoPattern: row.repoPattern,
      pathPattern: row.pathPattern,
      // Must be carried into the snapshot, not defaulted: this is the ACTUAL side of the diff, so a
      // ref-scoped row read back as ref-null would key differently from the manifest that declared
      // it — the plan would propose a create for a mapping that already exists and a prune for the
      // one that does, on every single run.
      refPattern: row.refPattern,
      type: row.type,
      classification: row.classification,
      mirrorOfShared: row.mirrorOfShared,
      enabled: row.enabled,
      // The ACTUAL side's scope — what the diff's `update` verdict compares against (§10.6).
      scope: row.scope
    });
  }

  const managedExecutorBindings: ResolvedManifestExecutorBinding[] = [];
  for (const row of ownedBindingRows) {
    const pair = placementPairById.get(row.targetObjectId);
    // A placement-targeted row reports as its COMPONENT narrowed by the deployment-target, which is
    // exactly how a manifest declares it — so the diff keys on one identity, not two shapes.
    const targetUrn = pair ? pair.componentUrn : urnOfOwnedId(row.targetObjectId);
    if (!targetUrn) continue;
    managedExecutorBindings.push({
      targetUrn,
      deploymentTargetUrn: pair ? pair.deploymentTargetUrn : null,
      type: row.type,
      pluginModule: row.pluginModule,
      pluginInstanceId: row.pluginInstanceId,
      config: (row.config ?? {}) as Record<string, unknown>,
      secretRefs: row.secretRefs,
      allowedHosts: row.allowedHosts,
      externalRef: row.externalRef,
      executionSystemId: row.executionSystemId
    });
  }

  // PRODUCER DECLARATIONS (ADR-0032 §7e). See docs/iac.md §119.
  let managedDependencyProducers: ResolvedManifestDependencyProducer[] = [];
  let existingDependencyProducers: ResolvedManifestDependencyProducer[] = [];
  if (manifest.producers !== undefined) {
    const producerRows = await listDependencyLineProducersForComponents(tx, orgId, ownedIdList);
    const declaredRows = [];
    for (const declaration of manifest.producers) {
      const live = await getDependencyLineProducer(tx, orgId, {
        ecosystem: declaration.ecosystem,
        coordinate: declaration.coordinate
      });
      if (live) declaredRows.push(live);
    }
    // The displaced producer may belong to ANOTHER stack and therefore be absent from every map
    // built above. Resolve those ids so the diff can NAME it — an unnamed displacement is a
    // displacement an operator cannot check, and the guard downstream keys on the URN.
    const unresolvedProducerIds = new Set<string>();
    for (const row of [...producerRows, ...declaredRows]) {
      if (!objectsById.has(row.producerObjectId)) unresolvedProducerIds.add(row.producerObjectId);
    }
    if (unresolvedProducerIds.size > 0) {
      for (const row of await fetchObjectsByIds(tx, orgId, [...unresolvedProducerIds])) {
        objectsByUrn.set(row.urn, row);
        objectsById.set(row.id, row);
      }
    }
    // THE TWO POOLS MAP DIFFERENTLY ON AN UNRESOLVABLE PRODUCER, because "the safe direction" points
    // opposite ways for them. One shared mapping used to drop the row from both and call that
    // conservative; the existence-pool half of that claim was false — see each function's own note.
    type ProducerRow = { ecosystem: string; coordinate: string; producerObjectId: string };
    const ecosystemOf = (row: ProducerRow) =>
      row.ecosystem as ResolvedManifestDependencyProducer["ecosystem"];

    // THE PRUNE POOL. See docs/iac.md §120.
    const toManaged = (row: ProducerRow): ResolvedManifestDependencyProducer | null => {
      const producerUrn = objectsById.get(row.producerObjectId)?.urn;
      if (!producerUrn) return null;
      return { producerUrn, ecosystem: ecosystemOf(row), coordinate: row.coordinate };
    };

    // THE EXISTENCE POOL. See docs/iac.md §121.
    const toExisting = (row: ProducerRow): ResolvedManifestDependencyProducer => ({
      producerUrn:
        objectsById.get(row.producerObjectId)?.urn ?? unresolvedProducerUrn(row.producerObjectId),
      ecosystem: ecosystemOf(row),
      coordinate: row.coordinate
    });

    managedDependencyProducers = producerRows
      .map(toManaged)
      .filter((p): p is ResolvedManifestDependencyProducer => p !== null);
    existingDependencyProducers = declaredRows.map(toExisting);
  }

  // `governance:move` RUNGS (ADR-0038 §2). See docs/iac.md §122.
  const managedGovernanceMoveRungs: string[] = [];
  if (resolvedRungSubjectUrns !== null) {
    const owned = new Set(ownedIdList);
    for (const rung of await listGovernanceMoveRungs(tx, orgId)) {
      if (!owned.has(rung.subjectObjectId)) continue;
      const subjectUrn = objectsById.get(rung.subjectObjectId)?.urn;
      // DROP an unnameable subject, the conservative direction here: this pool decides what gets
      // DISABLED, and a rung whose container cannot be named is one this plan can neither honestly
      // report a prune of nor prove ownership of. Dropping it means the disable does not happen —
      // inaction, and the subtree keeps the bar it has today.
      if (!subjectUrn) continue;
      managedGovernanceMoveRungs.push(subjectUrn);
    }
  }

  // PIPELINE HOOKS (D11/D21; migration 0096). See docs/iac.md §123.
  const managedPipelineHooks: ResolvedManifestPipelineHook[] = [];
  if (manifest.pipelineHooks !== undefined) {
    for (const row of await listHooksForComponents(tx, orgId, ownedIdList)) {
      const componentUrn = urnOfOwnedId(row.componentObjectId);
      // Defensive, and the conservative direction: a hook whose component cannot be named is
      // invisible to BOTH create-matching and prune, so this plan neither disarms it nor duplicates
      // it — never silently mis-attributed to another component.
      if (!componentUrn) continue;
      managedPipelineHooks.push({
        componentUrn,
        hookKind: row.kind,
        hookId: row.hookId,
        // The ACTUAL side, carried verbatim so it keys byte-for-byte against the DESIRED side.
        workflow: (row.workflow ?? null) as WorkflowRef | null,
        stage: row.stage,
        everySeconds: row.everySeconds,
        maxAgeSeconds: row.maxAgeSeconds,
        quietWindowSeconds: row.quietWindowSeconds
      });
    }
  }

  // ROLLOUTS AND CONVERGENCE POOLS (D12/D25(b); migration 0106). Read UNCONDITIONALLY, unlike the
  // hook pool above: absent means EMPTY for these two, so a prune is always in scope and a pool we
  // skipped reading would silently make every prune a no-op.
  const managedRollouts: ResolvedManifestRollout[] = [];
  for (const row of await listRolloutsForComponents(tx, orgId, ownedIdList)) {
    const componentUrn = urnOfOwnedId(row.componentObjectId);
    if (!componentUrn) continue;
    managedRollouts.push({
      componentUrn,
      targetClass: row.targetClass,
      rollout: row.rollout
    });
  }
  // ROLE BINDINGS AND ORG ROLES. See docs/iac.md §124.
  const managedRoleBindings: ResolvedManifestRoleBinding[] = [];
  const roleBindingRows = await listStackManagedRoleBindings(tx, orgId, manifest.stackName);
  // Both endpoints are raw object-id foreign-key columns, never URNs, so the id-or-urn ambiguity
  // `getObjectByIdOrUrnAnyType` exists for never applies — a batched `fetchObjectsByIds` (same
  // primitive `unresolvedProducerIds` above uses) resolves the whole set in one read instead of
  // two `findFirst`-equivalent lookups per row.
  const roleBindingEndpointIds = [
    ...new Set(roleBindingRows.flatMap((row) => [row.subjectId, row.scopeObjectId]))
  ];
  const roleBindingUrnById = new Map(
    (await fetchObjectsByIds(tx, orgId, roleBindingEndpointIds)).map((r) => [r.id, r.urn])
  );
  for (const row of roleBindingRows) {
    const subjectUrn = roleBindingUrnById.get(row.subjectId);
    const scopeUrn = roleBindingUrnById.get(row.scopeObjectId);
    // A row whose endpoints cannot be named is skipped rather than half-reported: it would appear
    // as a phantom delete line naming nothing an author could act on.
    if (!subjectUrn || !scopeUrn) continue;
    managedRoleBindings.push({
      subjectUrn,
      roleName: row.roleName,
      scopeUrn,
      // `reason` is not stored on the row; the DESIRED side supplies it and the ACTUAL side has
      // none, which is fine because `reason` is deliberately not part of the identity.
      reason: ""
    });
  }
  const managedRoles = await listStackManagedRoles(tx, orgId, manifest.stackName);

  const managedConvergence: ResolvedManifestConvergence[] = [];
  const convergenceRows = await listConvergenceForComponents(tx, orgId, ownedIdList);
  // The PRODUCT is not in `objectsById` — that map holds this stack's owned objects and their
  // placements, and a convergence row points at an infrastructure product another stack may own.
  // Batched: one read for every target across the whole set instead of one per row.
  const convergenceTargetUrnById = new Map(
    (
      await fetchObjectsByIds(tx, orgId, [
        ...new Set(convergenceRows.map((row) => row.targetObjectId))
      ])
    ).map((r) => [r.id, r.urn])
  );
  for (const row of convergenceRows) {
    const componentUrn = urnOfOwnedId(row.componentObjectId);
    const targetUrn = convergenceTargetUrnById.get(row.targetObjectId);
    // Both endpoints must be nameable, for the reason the hook pool gives for one: a row whose
    // component or product cannot be named is invisible to matching AND pruning, so this plan
    // neither duplicates it nor deletes it.
    if (!componentUrn || !targetUrn) continue;
    managedConvergence.push({
      componentUrn,
      targetUrn,
      converge: row.converge,
      scope: row.scope
    });
  }

  // A manifest may name its execution-system by id OR URN (`CreateExecutorBindingRequest` semantics,
  // and a URN is the only stable reference an offline-authored manifest has). The table stores a real
  // object id, so resolve here — a DB read, hence not in the pure diff engine. Without it a
  // URN-referencing manifest would diff as a perpetual `update` and DoD (b) would be false.
  const resolvedExecutionSystemIds = new Map<string, string>();
  for (const binding of manifest.executorBindings ?? []) {
    const ref = binding.executionSystemId;
    if (!ref || resolvedExecutionSystemIds.has(ref)) continue;
    let resolved;
    try {
      resolved = await getObjectByIdOrUrnAnyType(tx, orgId, ref);
    } catch {
      // Surfaced as "your manifest is wrong" (400), not "the plan wasn't found" (404). The object's
      // TYPE is deliberately not inspected here — that check is authorization-gated and happens at
      // apply (`executionSystemBindingIdentity`), so plan-compute can't be a type oracle.
      throw badRequest(
        `executor binding for '${binding.targetUrn}' references execution-system '${ref}', which does not exist`
      );
    }
    resolvedExecutionSystemIds.set(ref, resolved.id);
  }

  const resolvedManifest: ResolvedManifest = {
    stackName: manifest.stackName,
    roleBindings: manifest.roleBindings ?? [],
    roles: (manifest.roles ?? []).map((r) => ({
      name: r.name,
      permissions: r.permissions,
      ...(r.bindableAt ? { bindableAt: r.bindableAt } : {}),
      reason: r.reason
    })),
    objects: resolvedObjects,
    relationships: manifest.relationships.map((r) => ({
      typeId: r.typeId,
      fromUrn: r.fromUrn,
      toUrn: r.toUrn
    })),
    sourceMappings: (manifest.sourceMappings ?? []).map((m) => ({
      componentUrn: m.componentUrn,
      sourceKind: m.sourceKind,
      repoPattern: m.repoPattern ?? null,
      pathPattern: m.pathPattern ?? null,
      refPattern: m.refPattern ?? null,
      type: m.type ?? DEFAULT_BINDING_TYPE,
      classification: m.classification ?? null,
      // Descriptive, like classification — NOT part of the identity (iac.ts): a mapping that only
      // changed its declared provenance is the same mapping, not a delete+create.
      mirrorOfShared: m.mirrorOfShared ?? false,
      // The pause switch (migration 0063) — also descriptive here (see `sourceMappingKey`).
      // Omitted ⇒ enabled, the pre-0063 behaviour and the safer default for a hand-authored
      // manifest that has never heard of this field.
      enabled: m.enabled ?? true,
      // §10.6 — deliberately NOT defaulted: `undefined` means "this manifest does not manage the
      // scope" (no update proposed, a create writes NULL), `null` means "declare it undeclared".
      // Collapsing the two would make every pre-0066 manifest clear every hand-set scope on apply.
      ...(m.scope !== undefined ? { scope: m.scope } : {})
    })),
    placements: (manifest.placements ?? []).map((pl) => ({
      componentUrn: pl.componentUrn,
      deploymentTargetUrn: pl.deploymentTargetUrn
    })),
    // `undefined` -> `null` — ABSENT MEANS UNMANAGED HERE, unlike every collection around it. The
    // mapping is written out rather than `?? []` precisely so this line reads as a decision.
    producers:
      manifest.producers === undefined
        ? null
        : manifest.producers.map((declaration) => ({
            producerUrn: declaration.producerUrn,
            ecosystem: declaration.ecosystem,
            coordinate: declaration.coordinate
          })),
    // `undefined` -> `null` — ABSENT MEANS UNMANAGED HERE TOO, the second of the two collections
    // that diverge from the prune-on-absent rule (see `ResolvedManifest.governanceMoveRungs`).
    // Already resolved to URNs above, because the manifest addresses a subject by id OR URN.
    governanceMoveRungs: resolvedRungSubjectUrns,
    // `undefined` -> `null` — ABSENT MEANS UNMANAGED HERE TOO, the THIRD and last collection that
    // diverges from the prune-on-absent rule (see `ResolvedManifest.pipelineHooks`). `rollouts` and
    // `convergence` follow the ordinary rule and are not projected at all yet.
    pipelineHooks:
      manifest.pipelineHooks === undefined ? null : manifest.pipelineHooks.map(resolvePipelineHook),
    // D12 / D25(b) — ORDINARY rule, so `?? []`: absent and empty both mean "declares none" and both
    // prune. Until migration 0106 these two were projected NOWHERE, so a declared canary reached
    // the server and was discarded without a word.
    rollouts: (manifest.rollouts ?? []).map((r) => ({
      componentUrn: r.componentUrn,
      targetClass: r.targetClass,
      rollout: r.rollout
    })),
    convergence: (manifest.convergence ?? []).map((c) => ({
      componentUrn: c.componentUrn,
      targetUrn: c.targetUrn,
      converge: c.converge,
      scope: c.scope
    })),
    executorBindings: (manifest.executorBindings ?? []).map((b) => ({
      targetUrn: b.targetUrn,
      deploymentTargetUrn: b.deploymentTargetUrn ?? null,
      type: b.type ?? DEFAULT_BINDING_TYPE,
      pluginModule: b.pluginModule ?? null,
      pluginInstanceId: b.pluginInstanceId ?? null,
      config: b.config ?? {},
      secretRefs: b.secretRefs ?? {},
      allowedHosts: b.allowedHosts ?? [],
      externalRef: b.externalRef ?? null,
      executionSystemId: b.executionSystemId
        ? (resolvedExecutionSystemIds.get(b.executionSystemId) ?? b.executionSystemId)
        : null
    }))
  };

  // Rejected BEFORE the diff is computed: `computePlanDiff` collapses a duplicate declaration to keep
  // its output well-formed, which would otherwise hide the manifest bug behind a plausible plan.
  assertProjectionsUnique(resolvedManifest);

  // §9 — STACK THEFT IS A 409, NOT AN INTERNAL ERROR. See docs/iac.md §125.
  const diff = computeDiffOrConflict(resolvedManifest, {
    existingObjects,
    managedRelationships,
    existingRelationships,
    managedSourceMappings,
    managedExecutorBindings,
    managedPlacements,
    managedDependencyProducers,
    existingDependencyProducers,
    managedGovernanceMoveRungs,
    managedPipelineHooks,
    managedRollouts,
    managedRoleBindings,
    managedRoles,
    managedConvergence
  });
  // Strict create-in-service, IaC path (M12 P5a): reject at plan-compute so the invalid manifest
  // never becomes a stored plan and the human reviews only a valid diff. C1's two guards run at the
  // same point, for the same reason.
  assertComponentsContained(diff);
  assertProjectionsOwned(diff);
  assertProducerDeclarationsValid(diff);
  assertGovernanceMoveRungsValid(diff);
  assertInlineBindingsValid(diff);
  return diff;
}

/** The apply-time half of the stack-theft refusal. See docs/iac.md §126. */
async function assertNoStackTheftAtApply(
  tx: TenantTx,
  orgId: string,
  diff: PlanDiff,
  stackName: string
): Promise<void> {
  const urns = diff.objects.filter((e) => e.action !== "delete").map((e) => e.urn);
  if (urns.length === 0) return;
  const rows = await tx
    .select({ urn: objects.urn, managedByStack: objects.managedByStack })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), inArray(objects.urn, urns), isNull(objects.deletedAt)));

  const conflicts = rows
    .filter((r) => r.managedByStack !== null && r.managedByStack !== stackName)
    .map((r) => ({ urn: r.urn, ownedBy: r.managedByStack as string }));
  if (conflicts.length > 0) {
    throw conflict(new StackOwnershipConflictError(conflicts, stackName).message);
  }
}

/** The diff, with its one typed refusal shaped for HTTP. See docs/iac.md §127. */
function computeDiffOrConflict(
  resolvedManifest: ResolvedManifest,
  snapshot: Parameters<typeof computePlanDiff>[1]
): PlanDiff {
  try {
    return computePlanDiff(resolvedManifest, snapshot);
  } catch (error) {
    if (error instanceof StackOwnershipConflictError) throw conflict(error.message);
    throw error;
  }
}

function toPlan(row: typeof plans.$inferSelect): Plan {
  return {
    id: row.id,
    orgId: row.orgId,
    actorId: row.actorId,
    stackName: row.stackName,
    manifest: row.manifest as DesiredStateManifest,
    diff: row.diff as PlanDiff,
    status: row.status as PlanStatus,
    createdAt: row.createdAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null
  };
}

export async function insertPlan(
  tx: TenantTx,
  input: { orgId: string; actorId: string; manifest: DesiredStateManifest; diff: PlanDiff }
): Promise<Plan> {
  const [row] = await tx
    .insert(plans)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      actorId: input.actorId,
      stackName: input.manifest.stackName,
      manifest: input.manifest,
      diff: input.diff,
      status: "pending"
    })
    .returning();
  if (!row) throw new Error("failed to insert plan");
  return toPlan(row);
}

export async function getPlanById(tx: TenantTx, orgId: string, id: string): Promise<Plan> {
  const row = await tx.query.plans.findFirst({
    where: (t, { eq: eqOp, and: andOp }) => andOp(eqOp(t.orgId, orgId), eqOp(t.id, id))
  });
  if (!row) throw notFound(`plan '${id}' not found`);
  return toPlan(row);
}

/** Locks the plan row for the duration of the apply transaction — two concurrent applies of the same plan can't both succeed. */
async function lockPlan(
  tx: TenantTx,
  orgId: string,
  id: string
): Promise<typeof plans.$inferSelect> {
  const rows = await tx
    .select()
    .from(plans)
    .where(and(eq(plans.orgId, orgId), eq(plans.id, id)))
    .for("update");
  const row = rows[0];
  if (!row) throw notFound(`plan '${id}' not found`);
  return row;
}

/** Loads and locks a plan for apply, rejecting non-pending. See docs/iac.md §128. */
export async function lockPendingPlan(tx: TenantTx, orgId: string, id: string): Promise<Plan> {
  const row = await lockPlan(tx, orgId, id);
  if (row.status !== "pending") {
    throw conflict(
      `plan '${id}' is already '${row.status}' — POST /plans again for a fresh diff before applying`
    );
  }
  return toPlan(row);
}

export async function markPlanApplied(tx: TenantTx, orgId: string, id: string): Promise<Plan> {
  const [row] = await tx
    .update(plans)
    .set({ status: "applied", appliedAt: new Date() })
    .where(and(eq(plans.orgId, orgId), eq(plans.id, id)))
    .returning();
  if (!row) throw new Error("failed to mark plan applied");
  return toPlan(row);
}

// Apply: per-entry authorization-scope resolution, then mutation execution. See docs/iac.md §129.

export interface ScopeCheck {
  permission: Permission;
  scopeObjectId: string;
}

export interface ObjectResolution {
  /** Known once the object exists — unset for a `create` entry until `executePlanDiff` runs it. */
  id?: string;
  scopeObjectId: string;
}

/** Object write for ordinary types, policy write for governed. See docs/iac.md §130. */
function writePermissionFor(typeId: string): Permission {
  if (isGovernanceManagedObjectType(typeId)) return "policy:write";
  if (isPeerBoundObjectType(typeId)) return "federation:write";
  return "object:write";
}

/** Resolves which permission and scope each entry needs. See docs/iac.md §131. */
export async function prepareApplyChecks(
  tx: TenantTx,
  orgId: string,
  actorObjectId: string,
  diff: PlanDiff,
  /** The stack this diff belongs to, required not optional. See docs/iac.md §132. */
  stackName: string
): Promise<{ checks: ScopeCheck[]; objectResolutions: Map<string, ObjectResolution> }> {
  const objectResolutions = new Map<string, ObjectResolution>();
  const checks: ScopeCheck[] = [];

  // Strict create-in-service, IaC path (M12 P5a) — re-checked here against the STORED diff, not
  // trusting plan-compute ran (e.g. a plan created by a pre-P5a build). Fail-closed: an uncaught
  // throw aborts before `executePlanDiff`, inside the route's transaction, so nothing applies.
  assertComponentsContained(diff);
  // §9 STACK THEFT, RE-CHECKED AT APPLY AGAINST LIVE OWNERSHIP. See docs/iac.md §133.
  await assertNoStackTheftAtApply(tx, orgId, diff, stackName);
  // Those two invariants get the same defence in depth. See docs/iac.md §134.
  assertProjectionsOwned(diff);
  assertProducerDeclarationsValid(diff);
  assertGovernanceMoveRungsValid(diff);
  assertInlineBindingsValid(diff);

  for (const entry of diff.objects) {
    // A PAIR-BOUND type. See docs/iac.md §135.
    if (entry.action !== "noop" && isPairBoundObjectType(entry.typeId)) {
      throw forbidden(
        `object type '${entry.typeId}' is identified by a pair of objects and cannot be declared ` +
          `as a manifest object — an IaC apply cannot resolve or type-check its endpoints, nor ` +
          `write the derived edges that make the pair traversable. Use /api/v1/${entry.typeId}s.`
      );
    }
    // M25.7 — A PROJECTION-BOUND type. See docs/iac.md §136.
    if (entry.action !== "noop" && isProjectionBoundObjectType(entry.typeId)) {
      throw forbidden(projectionBoundRefusalDetail(entry.typeId, "an IaC plan apply"));
    }
    if (entry.action === "create") {
      const scopeObjectId = entry.target?.domainId ?? orgId;
      objectResolutions.set(entry.urn, { scopeObjectId });
      checks.push({ permission: writePermissionFor(entry.typeId), scopeObjectId });
      if (entry.typeId === "policy") {
        await assertPolicyScopeWithinAuthority(tx, {
          orgId,
          actorObjectId,
          properties: entry.target?.properties
        });
      }
      // M5 (BUILD_AND_TEST.md §8 M5 security note). See docs/iac.md §137.
      if (entry.typeId === "campaign") {
        await assertCampaignTargetsWithinAuthority(tx, {
          orgId,
          actorObjectId,
          properties: entry.target?.properties
        });
      }
      continue;
    }
    const found = await getObjectByIdOrUrn(tx, orgId, entry.typeId, entry.urn);
    objectResolutions.set(entry.urn, { id: found.id, scopeObjectId: found.id });
    if (entry.action !== "noop") {
      checks.push({ permission: writePermissionFor(entry.typeId), scopeObjectId: found.id });
      // A containment move is a write at two places. See docs/iac.md §138.
      const destination = entry.target?.domainId;
      if (entry.action === "update" && destination && destination !== found.domainId) {
        if (destination !== orgId) {
          checks.push({ permission: writePermissionFor(entry.typeId), scopeObjectId: destination });
        }
        if (found.domainId && found.domainId !== orgId) {
          checks.push({
            permission: writePermissionFor(entry.typeId),
            scopeObjectId: found.domainId
          });
        }
        // THE `governance:move` TWIN. See docs/iac.md §139.
        await assertGovernanceMoveAdmits(tx, {
          orgId,
          subjectObjectId: actorObjectId,
          movedObjectId: found.id,
          destinationObjectId: destination,
          permissionSetForExplain: writePermissionFor(entry.typeId)
        });
      }
      if (entry.typeId === "policy" && entry.action === "update") {
        await assertPolicyScopeWithinAuthority(tx, {
          orgId,
          actorObjectId,
          properties: entry.target?.properties
        });
      }
      if (entry.typeId === "campaign" && entry.action === "update") {
        await assertCampaignTargetsWithinAuthority(tx, {
          orgId,
          actorObjectId,
          properties: entry.target?.properties
        });
        // AND `properties.deadline` IS NOT CHECKED HERE, DELIBERATELY — stated so the absence reads
        // as a decision rather than as the omission it used to be. `writePermissionFor("campaign")`
        // returns plain `object:write` and the line above reads only `targets`, so until 2026-08-25
        // a manifest that omitted `deadline` (or moved it to 2099) released every target this
        // campaign was withholding changes from, at exactly the permission the owner ruling of that
        // date raised the `POST /campaigns/{id}/deadline` route above.
        //
        // The refusal lives at `graph/objects-repo.ts`'s `updateObject`, which `executePlanDiff`
        // writes through — `governance/campaign-deadline-widening-guard.ts`. Not repeated here for
        // the reason this file's own header gives about the `policy` scope check's siblings: a
        // per-door copy is how the route-only fix produced this hole in the first place, and the
        // widening test needs the STORED instant, which `prepareApplyChecks` would have to re-read.
        // A throw from there aborts inside the route's transaction exactly as an eager throw here
        // would, so nothing partially applies either way.
      }
    }
  }

  async function resolveEndpoint(urn: string): Promise<ObjectResolution> {
    const existing = objectResolutions.get(urn);
    if (existing) return existing;
    const found = await getObjectByIdOrUrnAnyType(tx, orgId, urn);
    const resolution: ObjectResolution = { id: found.id, scopeObjectId: found.id };
    objectResolutions.set(urn, resolution);
    return resolution;
  }

  // ROLE BINDING ENDPOINTS. See docs/iac.md §140.
  for (const entry of diff.roleBindings ?? []) {
    if (entry.action === "noop") continue;
    await resolveEndpoint(entry.subjectUrn);
    await resolveEndpoint(entry.scopeUrn);
  }

  for (const entry of diff.relationships) {
    // RESOLVED FOR EVERY NON-DELETE ENTRY, INCLUDING `noop`. See docs/iac.md §141.
    await resolveEndpoint(entry.fromUrn);
    await resolveEndpoint(entry.toUrn);
    if (entry.action === "noop") continue;
    // M5 CRITICAL (adversarial review). See docs/iac.md §142.
    if (isSystemManagedRelationshipType(entry.typeId)) {
      throw forbidden(
        `relationship type '${entry.typeId}' is system-managed and cannot be created or deleted via an IaC plan/apply — ` +
          `campaign membership is declared through a campaign's authority-checked 'targets', not a raw 'coordinates' edge`
      );
    }
    const from = await resolveEndpoint(entry.fromUrn);
    const to = await resolveEndpoint(entry.toUrn);
    checks.push({ permission: "relationship:write", scopeObjectId: from.scopeObjectId });
    checks.push({ permission: "relationship:write", scopeObjectId: to.scopeObjectId });

    // THE `governance:move` TWIN FOR ROUTE 2. See docs/iac.md §143.
    if (entry.typeId === CONTAINS_TYPE_ID && to.id !== undefined) {
      await assertGovernanceMoveAdmits(tx, {
        orgId,
        subjectObjectId: actorObjectId,
        movedObjectId: to.id,
        destinationObjectId: entry.action === "delete" ? null : (from.id ?? from.scopeObjectId),
        permissionSetForExplain: "relationship:write"
      });
    }
  }

  // C1 — `object:write` at the OWNING object, the identical bar
  // `PUT /executors/{idOrUrn}/binding` requires on its binding target. Per-object rather than one
  // coarse org-root check, matching this module's discipline everywhere else; authz walks
  // containment, so an org-wide writer still passes.
  for (const entry of diff.sourceMappings ?? []) {
    if (entry.action === "noop") continue;
    const component = await resolveEndpoint(entry.componentUrn);
    checks.push({ permission: "object:write", scopeObjectId: component.scopeObjectId });
  }

  // PIPELINE HOOKS (D11/D21). See docs/iac.md §144.
  for (const entry of diff.pipelineHooks ?? []) {
    if (entry.action === "noop") continue;
    const component = await resolveEndpoint(entry.componentUrn);
    checks.push({ permission: "object:write", scopeObjectId: component.scopeObjectId });
  }

  // ROLLOUTS (D12) and CONVERGENCE (D25(b)). See docs/iac.md §145.
  for (const entry of diff.rollouts ?? []) {
    if (entry.action === "noop") continue;
    const component = await resolveEndpoint(entry.componentUrn);
    checks.push({ permission: "object:write", scopeObjectId: component.scopeObjectId });
  }
  for (const entry of diff.convergence ?? []) {
    if (entry.action === "noop") continue;
    const component = await resolveEndpoint(entry.componentUrn);
    checks.push({ permission: "object:write", scopeObjectId: component.scopeObjectId });
    // Resolved but NOT checked — the product may belong to another stack, and demanding write on it
    // would hand every product owner a veto over who may converge onto it. Same rule, same reason,
    // as the placement loop's deployment-target.
    await resolveEndpoint(entry.targetUrn);
  }

  // C1/ADR-0026 — `object:write` at the COMPONENT, which is also where OWNERSHIP lives (decision
  // Q4). Checking the component and not the deployment-target is deliberate: a platform team owning
  // the targets must not thereby own every app team's placements, and it matches how a source
  // mapping's ownership is already inherited from its component.
  for (const entry of diff.placements ?? []) {
    if (entry.action === "noop") continue;
    const component = await resolveEndpoint(entry.componentUrn);
    checks.push({ permission: "object:write", scopeObjectId: component.scopeObjectId });
    // RESOLVED BUT NOT CHECKED. See docs/iac.md §146.
    await resolveEndpoint(entry.deploymentTargetUrn);
  }

  // Producer declarations: policy write at the org root. See docs/iac.md §147.
  const producerEntries = (diff.producers ?? []).filter((entry) => entry.action !== "noop");
  if (producerEntries.length > 0) {
    checks.push(dependencyProducerScopeCheck(orgId));
    // Resolved so `executePlanDiff`'s `endpointId` can name the producer object. A `create` entry
    // whose producer this same plan creates resolves to the pending entry (no id yet) — filled in by
    // the object-create loop, which runs first. A `delete` needs nothing: a retraction is keyed on
    // the coordinate alone.
    for (const entry of producerEntries) {
      if (entry.action !== "delete") await resolveEndpoint(entry.producerUrn);
    }
  }

  // Move rungs: policy write at or above the subject, per entry. See docs/iac.md §148.
  for (const entry of diff.governanceMoveRungs ?? []) {
    if (entry.action === "noop") continue;
    const subject = await resolveEndpoint(entry.subjectUrn);
    checks.push(governanceMoveRungScopeCheck(subject.scopeObjectId));
  }

  for (const entry of diff.executorBindings ?? []) {
    if (entry.action === "noop") continue;
    // A placement-targeted binding authorizes at the component. See docs/iac.md §149.
    const target = await resolveEndpoint(entry.targetUrn);
    checks.push({ permission: "object:write", scopeObjectId: target.scopeObjectId });
    // Same reason as the placement loop above: `bindingTargetObjectId` hands BOTH halves to
    // `endpointId`, so both must be resolved, and the target half carries no check of its own.
    if (entry.deploymentTargetUrn) await resolveEndpoint(entry.deploymentTargetUrn);

    // A system-backed binding dispatches with that system's token. See docs/iac.md §150.
    const executionSystemId = entry.target?.executionSystemId;
    if (executionSystemId) {
      checks.push({ permission: "object:write", scopeObjectId: executionSystemId });
    }
  }

  return { checks, objectResolutions };
}

async function findLiveRelationshipId(
  tx: TenantTx,
  orgId: string,
  params: { fromId: string; toId: string; typeId: string }
): Promise<string> {
  const page = await listRelationships(tx, orgId, { ...params, limit: 1 });
  const found = page.items[0];
  if (!found) {
    throw notFound(
      `no live '${params.typeId}' relationship from '${params.fromId}' to '${params.toId}' (apply-time prune)`
    );
  }
  return found.id;
}

/** Executes an authorized diff inside the caller's transaction. See docs/iac.md §151. */
export async function executePlanDiff(
  tx: TenantTx,
  input: {
    orgId: string;
    actorObjectId: string;
    requestId: string;
    stackName: string;
    diff: PlanDiff;
    objectResolutions: Map<string, ObjectResolution>;
  }
): Promise<void> {
  const { orgId, actorObjectId, requestId, stackName, diff, objectResolutions } = input;

  for (const entry of diff.objects) {
    if (entry.action !== "create") continue;
    const target = entry.target;
    if (!target) throw new Error(`internal: create entry for '${entry.urn}' missing target`);
    const created = await createObject(tx, {
      orgId,
      typeId: target.typeId,
      actorObjectId,
      requestId,
      urn: target.urn,
      name: target.name,
      // WIRE BOUNDARY (ADR-0021 D4) — the plan diff round-trips through `PlanDiffSchema`, whose
      // `domainId` is a plain string; it was produced by `resolveDomainId` above.
      domainId: containmentDomainIdFromWire(target.domainId),
      properties: target.properties,
      labels: target.labels
    });
    objectResolutions.set(entry.urn, { id: created.id, scopeObjectId: created.id });
  }

  for (const entry of diff.objects) {
    if (entry.action !== "update") continue;
    const target = entry.target;
    if (!target) throw new Error(`internal: update entry for '${entry.urn}' missing target`);
    // `typeId` is immutable once an object exists (updateObject has no typeId param) — a diff
    // entry whose only listed change is "typeId" is a manifest bug (URNs should embed the type,
    // graph/urn.ts) and intentionally won't converge; out of scope to auto-fix here.
    await updateObject(tx, {
      orgId,
      typeId: target.typeId,
      actorObjectId,
      requestId,
      idOrUrn: entry.urn,
      name: target.name,
      // WIRE BOUNDARY (ADR-0021 D4) — see the `create` branch above.
      domainId: containmentDomainIdFromWire(target.domainId),
      properties: target.properties,
      labels: target.labels
    });
  }

  // OWNERSHIP, STAMPED FOR EVERY OBJECT THIS MANIFEST DECLARES. See docs/iac.md §152.
  await stampObjectStackOwnership(
    tx,
    orgId,
    stackName,
    diff.objects
      .filter((entry) => entry.action !== "delete")
      .map((entry) => objectResolutions.get(entry.urn)?.id)
      .filter((id): id is string => id !== undefined)
  );

  function endpointId(urn: string): string {
    const resolved = objectResolutions.get(urn);
    if (resolved?.id) return resolved.id;
    // `prepareApplyChecks` always populates every referenced URN's resolution (creating one via
    // a live lookup for external references) — reaching this means a real internal invariant
    // violation, not a user-facing error.
    throw new Error(`internal: could not resolve object id for URN '${urn}' during apply`);
  }

  // Deletes BEFORE creates (see the doc comment) — a declarative re-parent must free the old edge
  // before the new one is created, or a cardinality-constrained edge (e.g. `contains`) 409s.
  for (const entry of diff.relationships) {
    if (entry.action !== "delete") continue;
    const id = await findLiveRelationshipId(tx, orgId, {
      fromId: endpointId(entry.fromUrn),
      toId: endpointId(entry.toUrn),
      typeId: entry.typeId
    });
    await deleteRelationship(tx, { orgId, actorObjectId, requestId, id });
  }

  for (const entry of diff.relationships) {
    if (entry.action !== "create") continue;
    await createRelationship(tx, {
      orgId,
      actorObjectId,
      requestId,
      typeId: entry.typeId,
      fromId: endpointId(entry.fromUrn),
      toId: endpointId(entry.toUrn),
      // The descriptive mirror only (see `managedLabels`) — ownership itself is the stamp below.
      labels: managedLabels(stackName)
    });
  }

  // The relationship half of the same stamp, after the creates. See docs/iac.md §153.
  await stampRelationshipStackOwnership(
    tx,
    orgId,
    stackName,
    diff.relationships
      .filter((entry) => entry.action !== "delete")
      .map((entry) => ({
        typeId: entry.typeId,
        fromId: endpointId(entry.fromUrn),
        toId: endpointId(entry.toUrn)
      }))
  );

  // C1 — projection rows. See docs/iac.md §154.

  for (const entry of diff.sourceMappings ?? []) {
    if (entry.action !== "delete") continue;
    const removed = await deleteSourceMappingsMatching(tx, {
      orgId,
      componentObjectId: endpointId(entry.componentUrn),
      sourceKind: entry.sourceKind,
      repoPattern: entry.repoPattern,
      pathPattern: entry.pathPattern,
      refPattern: entry.refPattern,
      type: entry.type
    });
    if (removed === 0) {
      throw notFound(
        `no live source mapping '${entry.sourceKind}' -> '${entry.componentUrn}' (${entry.type}) to prune`
      );
    }
  }

  /** The binding target a diff entry names, either way. See docs/iac.md §155. */
  const bindingTargetObjectId = async (entry: PlanExecutorBindingDiffEntry): Promise<string> => {
    if (!entry.deploymentTargetUrn) return endpointId(entry.targetUrn);
    const placement = await findLivePlacement(
      tx,
      orgId,
      endpointId(entry.targetUrn),
      endpointId(entry.deploymentTargetUrn)
    );
    if (!placement) {
      throw notFound(
        `no live placement '${entry.targetUrn}' @ '${entry.deploymentTargetUrn}' to carry its '${entry.type}' executor binding`
      );
    }
    return placement.id;
  };

  const describeTarget = (entry: PlanExecutorBindingDiffEntry): string =>
    entry.deploymentTargetUrn
      ? `placement '${entry.targetUrn}' @ '${entry.deploymentTargetUrn}'`
      : `'${entry.targetUrn}'`;

  for (const entry of diff.executorBindings ?? []) {
    if (entry.action !== "delete") continue;
    const removed = await deleteExecutorBinding(
      tx,
      orgId,
      await bindingTargetObjectId(entry),
      entry.type,
      actorObjectId,
      requestId
    );
    if (!removed) {
      throw notFound(
        `no live '${entry.type}' executor binding on ${describeTarget(entry)} to prune (apply-time prune)`
      );
    }
  }

  // PLACEMENT PRUNE runs AFTER the binding prune above and BEFORE the creates below. That order is
  // decision Q3's guard doing its job: by the time a placement is considered, any binding the
  // manifest asked to remove is already gone — so a binding still present here means the manifest
  // genuinely did not ask, which is exactly the case decision Q2 refuses.
  for (const entry of diff.placements ?? []) {
    if (entry.action !== "delete") continue;
    const placement = await findLivePlacement(
      tx,
      orgId,
      endpointId(entry.componentUrn),
      endpointId(entry.deploymentTargetUrn)
    );
    if (!placement) {
      throw notFound(
        `no live placement '${entry.componentUrn}' @ '${entry.deploymentTargetUrn}' to prune`
      );
    }
    // DECISION Q2 — REFUSE, naming the binding. See docs/iac.md §156.
    const survivingBindings = await listExecutorBindingsForTarget(tx, orgId, placement.id);
    if (survivingBindings.length > 0) {
      const named = survivingBindings.map((b) => `'${b.type}'`).join(", ");
      throw conflict(
        `cannot prune placement '${entry.componentUrn}' @ '${entry.deploymentTargetUrn}': it still ` +
          `carries ${survivingBindings.length} executor binding(s) (${named}) that this manifest ` +
          `does not remove. Delete the binding first — pruning it implicitly would destroy ` +
          `execution configuration the manifest never mentioned.`
      );
    }
    await withdrawPlacement(tx, {
      orgId,
      actorObjectId,
      requestId,
      idOrUrn: placement.id
    });
  }

  // Placement creates run first, because a binding may need one. See docs/iac.md §157.
  for (const entry of diff.placements ?? []) {
    if (entry.action !== "create") continue;
    await createPlacement(tx, {
      orgId,
      actorObjectId,
      requestId,
      componentIdOrUrn: endpointId(entry.componentUrn),
      deploymentTargetIdOrUrn: endpointId(entry.deploymentTargetUrn)
    });
  }
  for (const entry of diff.executorBindings ?? []) {
    if (entry.action !== "create" && entry.action !== "update") continue;
    const target = entry.target;
    if (!target) {
      throw new Error(
        `internal: ${entry.action} binding entry for ${describeTarget(entry)} has no target`
      );
    }
    const targetObjectId = await bindingTargetObjectId(entry);
    if (target.executionSystemId) {
      // Every `authorize()` — including `object:write` at this system (prepareApplyChecks) — has
      // already run to completion, so validating the system here cannot be an oracle.
      const sys = await getObjectByIdOrUrnAnyType(tx, orgId, target.executionSystemId);
      const identity = executionSystemBindingIdentity(sys, target.executionSystemId);
      await upsertExecutorBinding(tx, {
        orgId,
        targetObjectId,
        type: entry.type,
        ...identity,
        externalRef: target.externalRef,
        actorObjectId,
        requestId
      });
      continue;
    }
    await upsertExecutorBinding(tx, {
      orgId,
      targetObjectId,
      type: entry.type,
      // Non-null by `assertInlineBindingsValid`, which ran (twice) before any mutation.
      pluginModule: target.pluginModule!,
      pluginInstanceId: target.pluginInstanceId!,
      config: target.config,
      secretRefs: target.secretRefs,
      allowedHosts: target.allowedHosts,
      externalRef: target.externalRef,
      executionSystemId: null,
      actorObjectId,
      requestId
    });
  }

  for (const entry of diff.sourceMappings ?? []) {
    if (entry.action === "update") {
      // In-place convergence of the one non-identity attribute. See docs/iac.md §158.
      const converged = await setSourceMappingScopeMatching(
        tx,
        {
          orgId,
          componentObjectId: endpointId(entry.componentUrn),
          sourceKind: entry.sourceKind,
          repoPattern: entry.repoPattern,
          pathPattern: entry.pathPattern,
          refPattern: entry.refPattern,
          type: entry.type
        },
        entry.scope ?? null
      );
      if (converged === 0) {
        throw notFound(
          `no live source mapping '${entry.sourceKind}' -> '${entry.componentUrn}' (${entry.type}) to update`
        );
      }
      continue;
    }
    if (entry.action !== "create") continue;
    await createSourceMapping(tx, {
      orgId,
      sourceKind: entry.sourceKind,
      ...(entry.repoPattern !== null ? { repoPattern: entry.repoPattern } : {}),
      ...(entry.pathPattern !== null ? { pathPattern: entry.pathPattern } : {}),
      ...(entry.refPattern !== null ? { refPattern: entry.refPattern } : {}),
      componentIdOrUrn: endpointId(entry.componentUrn),
      type: entry.type,
      ...(entry.classification !== null ? { classification: entry.classification } : {}),
      ...(entry.mirrorOfShared ? { mirrorOfShared: true } : {}),
      // `createSourceMapping` defaults `enabled` to `true`, so only pass it through when the plan
      // says the row should be created already-paused.
      ...(entry.enabled === false ? { enabled: false } : {}),
      // Declared reach (§10.6) — written as the plan showed it; absent/null ⇒ not declared.
      ...(entry.scope ? { scope: entry.scope } : {})
    });
  }

  // PIPELINE HOOKS (D11/D21; migration 0096). See docs/iac.md §159.
  for (const entry of diff.pipelineHooks ?? []) {
    if (entry.action !== "delete") continue;
    await deleteHook(tx, orgId, {
      componentObjectId: endpointId(entry.componentUrn),
      kind: entry.hookKind,
      hookId: entry.hookId
    });
  }

  // ROLLOUTS AND CONVERGENCE. See docs/iac.md §160.
  for (const entry of diff.rollouts ?? []) {
    if (entry.action !== "delete") continue;
    await deleteComponentRollout(tx, orgId, endpointId(entry.componentUrn), entry.targetClass);
  }
  for (const entry of diff.rollouts ?? []) {
    if (entry.action !== "create" && entry.action !== "update") continue;
    await upsertComponentRollout(tx, orgId, {
      componentObjectId: endpointId(entry.componentUrn),
      targetClass: entry.targetClass,
      // Written as the plan SHOWED it — the entry the operator reviewed is the row that lands.
      rollout: entry.rollout
    });
  }
  // ROLE BINDINGS AND ORG ROLES. See docs/iac.md §161.
  for (const entry of diff.roleBindings ?? []) {
    if (entry.action !== "delete") continue;
    await deleteStackManagedRoleBinding(tx, {
      orgId,
      actorObjectId,
      requestId,
      stackName,
      subjectObjectId: endpointId(entry.subjectUrn),
      roleName: entry.roleName,
      scopeObjectId: endpointId(entry.scopeUrn)
    });
  }
  for (const entry of diff.roles ?? []) {
    if (entry.action !== "delete") continue;
    await deleteStackManagedRole(tx, {
      orgId,
      actorObjectId,
      requestId,
      stackName,
      name: entry.name
    });
  }
  for (const entry of diff.roles ?? []) {
    if (entry.action !== "create" && entry.action !== "update") continue;
    await upsertStackManagedRole(tx, {
      orgId,
      actorObjectId,
      requestId,
      stackName,
      name: entry.name,
      permissions: entry.permissions ?? []
    });
  }
  for (const entry of diff.roleBindings ?? []) {
    if (entry.action !== "create") continue;
    await createStackManagedRoleBinding(tx, {
      orgId,
      actorObjectId,
      requestId,
      stackName,
      subjectObjectId: endpointId(entry.subjectUrn),
      roleName: entry.roleName,
      scopeObjectId: endpointId(entry.scopeUrn)
    });
  }

  for (const entry of diff.convergence ?? []) {
    if (entry.action !== "delete") continue;
    await deleteComponentConvergence(
      tx,
      orgId,
      endpointId(entry.componentUrn),
      endpointId(entry.targetUrn)
    );
  }
  for (const entry of diff.convergence ?? []) {
    if (entry.action !== "create" && entry.action !== "update") continue;
    await upsertComponentConvergence(tx, orgId, {
      componentObjectId: endpointId(entry.componentUrn),
      targetObjectId: endpointId(entry.targetUrn),
      // `converge: false` lands as a stored `false`, never as a missing row — D8 makes the manifest
      // say which, and an opt-out has to be as visible in the database as an opt-in.
      converge: entry.converge ?? false,
      scope: entry.scope ?? "changedSubset"
    });
  }

  for (const entry of diff.pipelineHooks ?? []) {
    if (entry.action !== "create") continue;
    await upsertHook(tx, orgId, {
      componentObjectId: endpointId(entry.componentUrn),
      kind: entry.hookKind,
      hookId: entry.hookId,
      // Written as the plan SHOWED it, every field included — the entry the operator reviewed is
      // the row that lands, which is the whole of property (7).
      workflow: entry.workflow,
      stage: entry.stage,
      everySeconds: entry.everySeconds,
      maxAgeSeconds: entry.maxAgeSeconds,
      quietWindowSeconds: entry.quietWindowSeconds
    });
  }

  // PRODUCER DECLARATIONS (ADR-0032 §7e). See docs/iac.md §162.

  /** The coordinate must still be held by whoever the plan said. See docs/iac.md §163. */
  const assertPlannedProducerHolder = async (
    entry: PlanDependencyProducerDiffEntry
  ): Promise<DependencyLineProducer | null> => {
    const key = { ecosystem: entry.ecosystem, coordinate: entry.coordinate };
    const live = await getDependencyLineProducer(tx, orgId, key);
    // `create` planned against nobody; `update` against the displaced producer it named; `delete`
    // against the producer whose name is in the reviewed prune entry. An `update` with no
    // `displacedProducerUrn` is not a shape `computePlanDiff` emits — it expects nobody, and so
    // refuses, which is the fail-closed direction for a diff this build did not write.
    const expectedUrn =
      entry.action === "create"
        ? null
        : entry.action === "update"
          ? (entry.displacedProducerUrn ?? null)
          : entry.producerUrn;
    const liveUrn =
      live === null
        ? null
        : // A holder that resolves to no row at all is still a HOLDER; naming it by id keeps it
          // unequal to every expectation rather than collapsing into "nobody".
          ((await objectUrnByIdIncludingTombstones(tx, orgId, live.producerObjectId)) ??
          `object ${live.producerObjectId}`);
    if (liveUrn === expectedUrn) return live;
    throw conflict(
      `this plan is stale for ${entry.ecosystem} '${entry.coordinate}': it was computed when the ` +
        `coordinate was ${expectedUrn === null ? "declared by nobody" : `declared by '${expectedUrn}'`}` +
        `, and it is now ${liveUrn === null ? "declared by nobody" : `declared by '${liveUrn}'`}. ` +
        `Applying the '${entry.action}' anyway would act on a declaration this plan never showed ` +
        `its reviewer. Re-plan against current state.`
    );
  };

  for (const entry of diff.producers ?? []) {
    if (entry.action !== "delete") continue;
    const key = { ecosystem: entry.ecosystem, coordinate: entry.coordinate };
    const existing = await getDependencyLineProducer(tx, orgId, key);
    if (!existing) {
      // The same shape as every other apply-time prune miss: the row went away between plan and
      // apply. Refusing beats silently reporting a delete that removed nothing.
      throw notFound(
        `no declared producer for ${entry.ecosystem} '${entry.coordinate}' to retract (apply-time prune)`
      );
    }
    // …and the row that IS there must be the one the plan meant to remove. Kept separate from the
    // miss above so the two failures stay distinguishable to an operator: "it is already gone" and
    // "it now belongs to somebody else" are different facts with different remedies.
    await assertPlannedProducerHolder(entry);
    await retractProducerWithEffects(tx, {
      orgId,
      actorObjectId,
      requestId,
      key,
      existing
    });
  }

  for (const entry of diff.producers ?? []) {
    if (entry.action !== "create" && entry.action !== "update") continue;
    await assertPlannedProducerHolder(entry);
    await declareProducerWithEffects(tx, {
      orgId,
      actorObjectId,
      requestId,
      key: { ecosystem: entry.ecosystem, coordinate: entry.coordinate },
      producerObjectId: endpointId(entry.producerUrn)
    });
  }

  // The move rungs, and the permission each entry needs. See docs/iac.md §164.
  for (const entry of diff.governanceMoveRungs ?? []) {
    if (entry.action !== "delete") continue;
    // Resolved BY ID (`endpointId`), not by URN, so the subject's `typeId` and `name` come from the
    // row this apply is actually about. The tier is DERIVED here exactly as the HTTP door derives
    // it — a manifest never names one.
    const subject = await getObjectByIdOrUrnAnyType(tx, orgId, endpointId(entry.subjectUrn));
    const tier = assertRungSubjectType(subject.typeId, entry.subjectUrn);
    // The same shape as every other apply-time prune miss: the rung went away between plan and
    // apply. Refusing beats silently reporting a disable that disabled nothing.
    const live = await listGovernanceMoveRungs(tx, orgId);
    if (!live.some((rung) => rung.subjectObjectId === subject.id)) {
      throw notFound(
        `governance:move enforcement is not enabled at '${entry.subjectUrn}' — there is no rung ` +
          `here to disable (apply-time prune)`
      );
    }
    // A disable refused by an enabled upper rung throws the verb's own 409, inside this
    // transaction, so the whole apply rolls back rather than half-converging.
    await disableGovernanceMoveRungWithEffects(tx, {
      orgId,
      actorObjectId,
      requestId,
      subject: { id: subject.id, name: subject.name },
      tier
    });
  }

  for (const entry of diff.governanceMoveRungs ?? []) {
    if (entry.action !== "create") continue;
    const subject = await getObjectByIdOrUrnAnyType(tx, orgId, endpointId(entry.subjectUrn));
    const tier = assertRungSubjectType(subject.typeId, entry.subjectUrn);
    // `enableGovernanceMoveRung` is an upsert, so a `create` that raced another enabler converges
    // rather than 409s — re-stating an enabled rung is what `scp apply` does routinely, and the
    // end state is the one the reviewed plan described either way.
    await enableGovernanceMoveRungWithEffects(tx, {
      orgId,
      actorObjectId,
      requestId,
      subject: { id: subject.id, name: subject.name },
      tier
    });
  }

  for (const entry of diff.objects) {
    if (entry.action !== "delete") continue;
    await deleteObject(tx, {
      orgId,
      typeId: entry.typeId,
      actorObjectId,
      requestId,
      idOrUrn: entry.urn
    });
  }
}
