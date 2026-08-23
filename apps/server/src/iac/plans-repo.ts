import { and, eq, inArray, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type {
  DependencyLineProducer,
  DesiredStateManifest,
  Plan,
  PlanDependencyProducerDiffEntry,
  PlanDiff,
  PlanExecutorBindingDiffEntry,
  PlanStatus
} from "@scp/schemas";
import { containmentDomainIdFromWire } from "../domain-id-edge.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects, plans, relationships } from "../db/schema.js";
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
import { isGovernanceManagedObjectType } from "../governance/governance-managed-types.js";
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
import { validatePluginConfig } from "../plugin-host/plugin-manifests.js";

/**
 * Rejects (400) a diff that CREATES any component with no owning service (M12 P5a, owner ruling
 * 2026-07-16 "make IaC strict"). Called at BOTH plan-compute (so `POST /plans` fails fast, and the
 * reviewed plan is guaranteed valid) AND apply (defense-in-depth: `prepareApplyChecks` re-derives
 * every invariant from the STORED diff rather than trusting plan-compute ran — the same fail-closed
 * discipline the policy-scope / campaign-target / system-managed-type checks in this module use).
 * The message points at both the IaC ergonomics fix and the raw-manifest fix.
 */
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

/**
 * Rejects (400) a plan that would WRITE a `source_mappings`/`executor_bindings` row onto an object
 * this stack does not own (C1). Run at BOTH plan-compute and apply, exactly like
 * `assertComponentsContained` and for the same reason: `prepareApplyChecks` re-derives every
 * invariant from the STORED diff rather than trusting plan-compute ran.
 *
 * This is the enforcement half of the ownership-scoping decision (see
 * `plan-diff.ts`'s `unownedProjectionDeclarations` for the full rationale) — it is what makes
 * "a stack never touches another stack's rows" true for writes as well as for prunes.
 */
function assertProjectionsOwned(diff: PlanDiff): void {
  const unowned = unownedProjectionDeclarations(diff);
  if (unowned.length === 0) return;
  throw badRequest(
    `plan declares source mapping(s)/executor binding(s) on object(s) this stack does not manage: ` +
      `${unowned.join(", ")}. Neither table carries an owner of its own, so ownership is inherited ` +
      `from the object the row hangs off — declare that object in this stack's manifest (which ` +
      `adopts it), or configure it from the stack that already manages it.`
  );
}

/**
 * Rejects (400) a plan whose producer declarations this stack may not make — the producer it does
 * not own, the CURRENT producer it would displace and does not own, or a producer that is not a
 * `component` (ADR-0032 §7e). Run at BOTH plan-compute and apply, from the DIFF alone, exactly like
 * `assertProjectionsOwned` and for the same fail-closed reason.
 *
 * The displacement half has no analogue in the other collections and is the one worth pausing on: a
 * producer declaration is keyed on the COORDINATE and upserted, so it can change hands with NO row
 * deleted anywhere. Owning the destination component is therefore not sufficient to make a transfer
 * this stack's business — `invalidProducerDeclarations` carries the full argument.
 */
/**
 * Rejects (400) a plan whose `governance:move` rung declarations this stack may not make — a rung on
 * a container it does not own, or on a type that cannot carry one. Run at BOTH plan-compute and
 * apply, exactly like the three guards around it and for the same reason: `prepareApplyChecks`
 * re-derives every invariant from the STORED diff rather than trusting plan-compute ran.
 *
 * `invalidGovernanceMoveRungDeclarations` carries the full argument for both refusals.
 */
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

/**
 * Rejects (400) a manifest declaring the same source mapping or the same `(target, type)` binding
 * twice. See `duplicateProjectionDeclarations` — silently preferring one is the failure mode
 * proposal §11 names explicitly.
 */
function assertProjectionsUnique(manifest: ResolvedManifest): void {
  const duplicates = duplicateProjectionDeclarations(manifest);
  if (duplicates.length === 0) return;
  throw badRequest(
    `manifest declares the same configuration twice: ${duplicates.join(", ")}. ` +
      `A source mapping is identified by its whole tuple and an executor binding by (target, type) — ` +
      `remove the duplicate rather than relying on which one wins.`
  );
}

/**
 * Runs, for every INLINE binding this plan would write, the exact three checks
 * `PUT /executors/{idOrUrn}/binding` runs before storing one — module allowlist, reserved
 * instance-id namespace, and plugin config-schema validation. Called at BOTH plan-compute and apply.
 *
 * This is the census, not a nicety. IaC apply is a SECOND door into `executor_bindings`, and each of
 * these guards was written because the FIRST door needed it: an unknown/wrong-kind `pluginModule`
 * otherwise surfaces as a confusing dispatch-time failure (M8 item 6); a `pluginInstanceId` in the
 * reserved `execution-system:` namespace silently re-points a real system's coordination traffic at
 * tenant config (`assertNotReservedInstanceId`); and `managed-iac`'s `additionalProperties: false`
 * config schema is what stops a tenant setting the server-governed runnerImage/networkMode/
 * workspaceRoot (adversarial-review CRITICAL #1). A guard on one door only is not a guard.
 *
 * Execution-system-backed bindings are deliberately NOT checked here — their module and instance id
 * are derived from the system object at write time, and validating them needs a read of that object,
 * which must not happen before `authorize()` (see `executionSystemBindingIdentity`'s call-order note).
 */
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

/**
 * The thin DB-I/O wrapper around `iac/plan-diff.ts`'s pure diff engine, plus the `plans` table's
 * CRUD and the apply-time authorization-scope resolution + mutation execution. Everything that
 * *can* be a pure function lives in plan-diff.ts (BUILD_AND_TEST.md §4.1); this module is where
 * that meets `graph/objects-repo.ts`/`graph/relationships-repo.ts` (reused, never reimplemented —
 * per the parent task's explicit instruction).
 */

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

/**
 * The URN of one object by id, TOMBSTONES INCLUDED — deliberately unlike every other object read in
 * this file, all of which filter `deleted_at IS NULL`.
 *
 * Used only to NAME the current holder of a producer coordinate in an apply-time refusal.
 * `dependency_line_producers` has no `deleted_at` and `deleteObject` is a soft delete, so a holder
 * may perfectly well be tombstoned while its declaration stands; a refusal that could not name it
 * would leave the operator with a coordinate, a conflict, and nothing to go and look at. Never used
 * to resolve an address — nothing is written to a tombstoned object on the strength of this.
 */
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

/**
 * Live objects this stack OWNS — the object prune pool.
 *
 * Keyed on the server-written `managed_by_stack` column (drizzle/0068), NOT on
 * `labels @> {"scp:managed-by":"iac","scp:stack":…}` as it was until then. That containment test
 * read a map the prune target itself could write under plain `object:write`, so two label keys put
 * an arbitrary object into this delete pool — or took an object out of it, so its own stack could
 * never decommission it. `iac/stack-ownership.ts` has the full account.
 */
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

/**
 * Assembles a `PlanDiffSnapshot` from live graph state and runs the pure diff engine
 * (`plan-diff.ts`). Zod validation of `manifest` (400 on malformed input) happens in the route
 * handler BEFORE this is ever called — security self-check item 3 (goal statement).
 */
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

  // ---------------------------------------------------------------------------------------
  // `governance:move` RUNG SUBJECTS — id-or-URN in, URN out, resolved HERE (a DB read, hence not in
  // the pure diff engine) so every downstream stage speaks the one vocabulary the rest of the diff
  // uses. Same shape as the `executionSystemId` resolution further down, with one addition that
  // matters:
  //
  // A URN THIS MANIFEST ITSELF DECLARES IS CARRIED VERBATIM AND NOT LOOKED UP, because the subject
  // may not exist yet — "create this service and govern moves under it" is the ordinary first
  // manifest, and resolving it here would 404 on precisely the plan that is allowed to create it.
  // Every other reference must already exist, and a miss is "your manifest is wrong" (400) rather
  // than a plan that silently manages nothing.
  // ---------------------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------------------
  // C1 — the ownership pool for `source_mappings`/`executor_bindings`.
  //
  // Neither table carries an owner of its own, so a row's owner is the owner of the object it hangs
  // off. The pool is therefore "every object this stack will own once this plan applies": the
  // objects it ALREADY owns (`managedObjectRows` — `managed_by_stack` = this stack) UNION the live
  // objects this manifest declares (apply stamps ownership onto each, so declaring an object
  // adopts it).
  //
  // One pool serves BOTH prune detection and create/noop matching, and that union is what makes it
  // correct. Restricting it to already-labelled objects would make the FIRST apply that adopts a
  // discovery-imported component blind to that component's existing mapping rows — it would create
  // a byte-identical duplicate (the table has no unique constraint to stop it) and then propose
  // deleting it on the next plan, so the same manifest applied twice would not be a no-op.
  // ---------------------------------------------------------------------------------------
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

  // THE BINDING POOL SPANS OBJECTS *AND* PLACEMENTS. `executor_bindings.target_object_id` points at
  // either, and a placement is not in `manifest.objects` (that door refuses pair-bound types, #207),
  // so keying the pool on owned OBJECTS alone made every binding on a placement invisible to the
  // diff: unadoptable (a re-plan proposes it forever) and unprunable. Sequenced after the placement
  // read rather than folded into the Promise.all above, because the placement ids ARE the extra
  // targets — the dependency is real, not incidental ordering.
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
    if (!targetUrn) continue; // defensive — see above
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

  // ---------------------------------------------------------------------------------------
  // PRODUCER DECLARATIONS (ADR-0032 §7e) — TWO pools, mirroring `managedRelationships` vs
  // `existingRelationships` rather than the projection tables' one-pool shape.
  //
  // The prune pool is ownership-scoped: declarations whose PRODUCER is a component this stack owns.
  // The existence pool is NOT, and must not be — a declaration is keyed on the coordinate and
  // upserted, so `@acme/lib` can move from stack B's component to stack A's with nothing deleted.
  // Reading only the scoped pool would make that transfer look like a `create` and let apply perform
  // it silently; reading the live row for each DECLARED coordinate is what turns it into an `update`
  // naming the displaced producer, which `invalidProducerDeclarations` then refuses when the
  // displaced producer is not this stack's.
  //
  // Skipped entirely when the manifest has no `producers` key: that means UNMANAGED (see
  // `ResolvedManifest.producers`), so there is nothing to converge and nothing to prune, and reading
  // a prune pool we must never act on would only invite a later edit to act on it.
  // ---------------------------------------------------------------------------------------
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

    // THE PRUNE POOL — DROP, and here the claim holds. This pool decides what gets RETRACTED. A
    // declaration whose producer cannot be named is one this plan can neither honestly report a
    // prune of (the reviewed entry names the producer LOSING the coordinate) nor prove ownership
    // of, since ownership is inherited from a component that is no longer there. Dropping it means
    // the retraction does not happen: inaction, and the coordinate keeps the behaviour it has today.
    const toManaged = (row: ProducerRow): ResolvedManifestDependencyProducer | null => {
      const producerUrn = objectsById.get(row.producerObjectId)?.urn;
      if (!producerUrn) return null;
      return { producerUrn, ecosystem: ecosystemOf(row), coordinate: row.coordinate };
    };

    // THE EXISTENCE POOL — KEEP, ALWAYS. This pool answers "does this coordinate already have a
    // holder", and the answer is YES whether or not the holder can be named: the row is live and the
    // next declaration is an upsert straight over it. Dropping it made the diff emit a `create`,
    // whose reason sentence tells the reviewing operator the coordinate "is polled as third-party
    // today" — so the plan inverted its own most consequential fact and the apply performed an
    // unreviewed overwrite. Keeping the row under {@link unresolvedProducerUrn} makes it an `update`
    // that NAMES the situation, which `invalidProducerDeclarations` refuses in its own branch.
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

  // ---------------------------------------------------------------------------------------
  // `governance:move` RUNGS (ADR-0038 §2) — ONE pool, ownership-scoped, and the reason it is one
  // rather than the two `producers` needs is on `PlanDiffSnapshot.managedGovernanceMoveRungs`.
  //
  // Read through `listGovernanceMoveRungs` — the same function the API list read and the Admin page
  // use — rather than a SELECT written here, so a plan can never disagree with what an operator sees
  // on the page they authored the rung from. The whole org's rungs is a handful of rows by
  // construction (one per governed container), so the filter is in memory.
  //
  // Skipped entirely when the manifest has no `governanceMoveRungs` key: absent means UNMANAGED, so
  // there is nothing to converge and nothing to prune, and reading a prune pool we must never act on
  // would only invite a later edit to act on it.
  // ---------------------------------------------------------------------------------------
  let managedGovernanceMoveRungs: string[] = [];
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

  const diff = computePlanDiff(resolvedManifest, {
    existingObjects,
    managedRelationships,
    existingRelationships,
    managedSourceMappings,
    managedExecutorBindings,
    managedPlacements,
    managedDependencyProducers,
    existingDependencyProducers,
    managedGovernanceMoveRungs
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

// -------------------------------------------------------------------------------------------
// `plans` table CRUD
// -------------------------------------------------------------------------------------------

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

/**
 * Loads and locks a plan for apply, rejecting anything not `pending` with 409 (goal statement:
 * "re-applying an already-applied plan should be rejected with 409" — the diff it recorded may be
 * stale; callers re-converge by POSTing a fresh `/plans`, which is also what makes "apply the same
 * manifest twice" naturally produce an all-noop second diff, DoD (b)).
 */
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

// -------------------------------------------------------------------------------------------
// Apply: per-entry authorization-scope resolution, then mutation execution. Split into two
// functions so the route handler (routes/plans.ts) can run EVERY `authorize()` call from
// `checks` to completion before calling `executePlanDiff` — "check every entry's permission
// BEFORE executing any mutation" (goal statement's security note), matching every other route's
// convention of owning the authz decision itself (objects-generic.ts, ownership.ts).
// -------------------------------------------------------------------------------------------

export interface ScopeCheck {
  permission: Permission;
  scopeObjectId: string;
}

export interface ObjectResolution {
  /** Known once the object exists — unset for a `create` entry until `executePlanDiff` runs it. */
  id?: string;
  scopeObjectId: string;
}

/** `object:write` for every ordinary type; `policy:write` for the governance-owned `policy`/
 *  `control` types — mirrors `routes/typed-registries.ts`'s `writePermission` gate so the IaC
 *  apply path can never authorize a governance-object write with a weaker permission than the
 *  typed `/policies`/`/controls` routes require (security fast-follow after PR #9).
 *
 *  M16.2 phase A (E1) adds the same treatment for the peer-bound `outpost` type: its own routes
 *  (`/api/v1/federation/outposts`) require `federation:write`, so a manifest declaring an `outpost`
 *  object must clear the SAME bar rather than the weaker `object:write` — otherwise `POST /plans` +
 *  `.../apply` would be a third door into commander-authored federation config with the wrong gate,
 *  exactly the shape the governance carve-out above was written to close. The 1:1 peer BINDING needs
 *  no work here: it is enforced inside `graph/objects-repo.ts`, which this path calls
 *  (`federation/outpost-binding.ts` explains the single-choke-point choice). */
function writePermissionFor(typeId: string): Permission {
  if (isGovernanceManagedObjectType(typeId)) return "policy:write";
  if (isPeerBoundObjectType(typeId)) return "federation:write";
  return "object:write";
}

/**
 * Resolves, for every non-noop diff entry, which permission + scope `authorize()` must allow.
 * Object creates check `object:write` at the resolved target domain (mirrors
 * `objects-generic.ts`'s create handler); updates/deletes check at the object's own id. Relationship
 * creates/deletes check `relationship:write` at BOTH endpoints (mirrors the M1 security review's
 * "relationship writes require write permission at both endpoints' scopes" — CRITICAL 1 — applied
 * here too, not just on the generic endpoint). An endpoint not covered by any object diff entry in
 * this plan (an "external" URN reference, or a plain pre-existing dependency) is resolved via a
 * live lookup and must already exist — `getObjectByIdOrUrnAnyType` 404s otherwise.
 *
 * **Governance carve-out (security fast-follow after PR #9's adversarial review):** a manifest can
 * declare `policy`/`control` objects like any other type — `typeId` is a free-form string
 * (`ManifestObjectSchema`), so nothing before this function stops a caller from including one. The
 * ORIGINAL code checked only `object:write` here, meaning an actor with no `policy:write` anywhere
 * could plant a `policy`/`control` object through `POST /plans` + `.../apply` even though both the
 * typed `/policies` route AND (after this fix) the generic `/objects/policy` endpoint refuse that.
 * Worse, for `policy` specifically, the DECLARED `properties.scope` was never bound to the actor's
 * own authority — a narrow-scope actor's apply could plant an org-wide `required` policy, the exact
 * CRITICAL #1b vector `assertPolicyScopeWithinAuthority` closes on the typed route. Fixed here by
 * (a) using `policy:write` instead of `object:write` for these types (`writePermissionFor`), and
 * (b) calling `assertPolicyScopeWithinAuthority` for every `policy` create/update, exactly like
 * `routes/typed-registries.ts`'s POST/PATCH/PUT handlers do. Thrown eagerly (not deferred into the
 * `checks` array the caller drains after this returns) — still fully fail-closed: an uncaught throw
 * here aborts `prepareApplyChecks` before `executePlanDiff` ever runs, inside the same transaction
 * the route handler opened, so nothing partially applies.
 */
export async function prepareApplyChecks(
  tx: TenantTx,
  orgId: string,
  actorObjectId: string,
  diff: PlanDiff
): Promise<{ checks: ScopeCheck[]; objectResolutions: Map<string, ObjectResolution> }> {
  const objectResolutions = new Map<string, ObjectResolution>();
  const checks: ScopeCheck[] = [];

  // Strict create-in-service, IaC path (M12 P5a) — re-checked here against the STORED diff, not
  // trusting plan-compute ran (e.g. a plan created by a pre-P5a build). Fail-closed: an uncaught
  // throw aborts before `executePlanDiff`, inside the route's transaction, so nothing applies.
  assertComponentsContained(diff);
  // C1's two invariants get the same defense-in-depth treatment, and for a sharper reason: a plan
  // stored by a pre-C1 build cannot carry these collections at all, but a plan stored between
  // plan-compute and apply by ANY build must still be re-proved to write only onto objects this
  // stack owns, and to carry only inline bindings whose module/config clear the same bar the
  // typed route requires.
  assertProjectionsOwned(diff);
  assertProducerDeclarationsValid(diff);
  assertGovernanceMoveRungsValid(diff);
  assertInlineBindingsValid(diff);

  for (const entry of diff.objects) {
    // A PAIR-BOUND type (`placement`) cannot be declared as a raw manifest object. This is the
    // IaC-apply twin of `routes/objects-generic.ts`'s `assertNotPairBoundObjectType`, and it was
    // missing: apply calls `createObject` DIRECTLY, so the route's refusal never ran here. A
    // manifest declaring `typeId: "placement"` therefore wrote a row carrying two unresolved,
    // un-type-checked UUIDs and — decisively — NO derived `places`/`placed_at` edges, leaving an
    // island invisible to every traversal and impact query. Proven reachable on this exact code
    // path before the guard existed, not reasoned about.
    //
    // `pair-bound-types.ts` names its consumers as "the generic route and the federation overlay
    // route — both user-facing create surfaces". IaC apply is a third, and was not on the list;
    // the same omission shape as the system-managed RELATIONSHIP refusal below, which this file
    // already carries for exactly the same "second injection vector" reason.
    //
    // Refused for every non-noop action, not just `create`: an update would rewrite the pair
    // without re-deriving the edges, and a delete would tombstone the object while leaving them.
    // Placements are authored through `/api/v1/placements`; a stack that needs them declares them
    // there until a typed manifest collection exists (post-import-configuration.md §8).
    if (entry.action !== "noop" && isPairBoundObjectType(entry.typeId)) {
      throw forbidden(
        `object type '${entry.typeId}' is identified by a pair of objects and cannot be declared ` +
          `as a manifest object — an IaC apply cannot resolve or type-check its endpoints, nor ` +
          `write the derived edges that make the pair traversable. Use /api/v1/${entry.typeId}s.`
      );
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
      // M5 (BUILD_AND_TEST.md §8 M5 security note): the IaC-apply-path twin of
      // `routes/objects-generic.ts`'s `campaign` block — a manifest declaring a `campaign` object
      // is a free-form `typeId` just like `policy` is, so this apply path must independently bind
      // its DECLARED `properties.targets` to the actor's own authority (same fail-closed shape as
      // the policy-scope check right above), not rely on `POST /campaigns` having done so.
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
      // A CONTAINMENT MOVE IS A WRITE AT TWO PLACES, and IaC apply is a door like any other.
      // `executePlanDiff` writes `target.domainId` onto the row through the same `updateObject` the
      // HTTP doors use, so without this a manifest re-parents an object the actor holds
      // `object:write` over into a subtree they hold nothing at — and because RBAC scope expands
      // strictly upward (`authz/resolve.ts`), that hands the destination subtree's holders custody
      // of it. The apply-path twin of `graph/containment-parent-authz.ts`, written as a `checks`
      // entry rather than a call to that helper because this path authorizes through one drained
      // list (module doc above) and because the diff engine has ALREADY decided whether the parent
      // changes — `plan-diff.ts` records exactly that as the `domainId` changed-field. Only a real
      // change is checked, so an unchanged re-apply demands nothing extra: the same "re-stating the
      // current parent is not a move" rule the helper applies, for the same idempotency reason.
      //
      // BOTH ends, not just the destination. The entry below was only half of "a write at two
      // places": authority expands strictly UPWARD, so holding it at the OBJECT says nothing about
      // the container the object is being taken OUT of, and a manifest could yank a row out of a
      // subtree the applier holds nothing at — the mirror image of the escalation the destination
      // entry stops. The same second end `graph/containment-parent-authz.ts` now checks, and the
      // one `graph/components-repo.ts`'s `setComponentService` has always checked ("the OLD service
      // too on a move (it loses a child)").
      //
      // TWO SOURCES ARE EXEMPT. `found.domainId` is null only for the org root ITSELF, which has no
      // source container to authorize at — and `found.domainId === orgId`, the org ROOT OBJECT, is
      // exempt too, because the org root cannot lose custody of anything that stays inside the org:
      // `updateObject`'s `assertRootedContainmentParent` proves on this same write that the
      // destination reaches the root, so the root is on the row's chain after the move exactly as it
      // was before, and the premise of this check ("its holders lose custody") is false for it.
      //
      // That second half was missing HERE as well as in the helper — the identical over-broad
      // refusal, in the identical words, in the twin. It is not an edge case: `createObject` defaults
      // an unnamed `domainId` to the org root, so MOST rows sit there, and apply refused every
      // manifest that re-parented one of them unless the applier held ORG-ROOT authority. See
      // `graph/containment-parent-authz.ts` for the full argument — the two copies must agree, and
      // `routes/containment-root-source-and-create-rooting.integration.test.ts` pins both doors.
      //
      // AND THE DESTINATION IS EXEMPT AT THE ORG ROOT FOR THE MIRROR REASON — the half that was
      // reasoned about at neither end. A manifest that moves a row BACK to the top level named the
      // org root as its destination, and demanding authority there refused an applier who owns the
      // whole subtree the row is leaving. Nobody gains custody: X's chain already terminated at the
      // org root (the root-reachability invariant), so the org root's holders held it before the move
      // and hold it after, while the intermediate holders LOSE it — a strictly shrinking custodian
      // set is not the escalation the destination entry stops. Full argument, including where the
      // proof is one step weaker than the source-side one, in `graph/containment-parent-authz.ts`;
      // `routes/containment-root-destination-authz.integration.test.ts` pins both doors.
      //
      // Reachable on this path in TWO shapes, not one: an explicit `domainId` naming the org root,
      // and — because `resolveDomainId` maps an ABSENT `domainId` to the org root — a manifest that
      // simply omits the field for a row that currently sits inside a domain. The second is the
      // common one and it is why this refusal bit IaC harder than it bit the HTTP doors.
      //
      // The CYCLE half of the same fix is deliberately NOT duplicated here: it is a subject-free
      // invariant and lives in `graph/objects-repo.ts`'s `updateObject`, which this path writes
      // through — see the comment there for why the repo, not the doors, owns it. The ROOT-
      // REACHABILITY half of the CREATE branch above is subject-free for the same reason and lives
      // in `createObject`, which `executePlanDiff` calls directly.
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
        // THE `governance:move` TWIN (proposal §9.2 door (b), owner ruling 2026-08-18). A door-only
        // fix ships INERT on IaC — proven by mutation in #244 — so the second bar has to be added
        // here as well as in `graph/containment-parent-authz.ts`, and the two must agree.
        //
        // Thrown EAGERLY rather than pushed onto `checks`, for the reason
        // `assertPolicyScopeWithinAuthority` and `assertCampaignTargetsWithinAuthority` are: the
        // demand is CONDITIONAL (it exists only where a rung is enabled) and its refusal carries a
        // written explanation naming the rung, neither of which a `{permission, scopeObjectId}` pair
        // can express. Still fully fail-closed: an uncaught throw aborts `prepareApplyChecks` before
        // `executePlanDiff` runs, inside the route's transaction, so nothing partially applies.
        //
        // The applying principal is the REAL one (`actorObjectId`, resolved at apply time), which is
        // what makes this path a genuine door rather than a replay of a plan-time decision.
        //
        // NO ORG-ROOT EXEMPTION at either end, unlike the four `object:write` entries above — see
        // `governance/move-enforcement.ts`'s header: custody shrinks at the root, but governance
        // REACH is exactly what a move to the root reduces.
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

  for (const entry of diff.relationships) {
    if (entry.action === "noop") continue;
    // M5 CRITICAL (adversarial review): a manifest can declare any `typeId` on a relationship entry
    // (`ManifestRelationshipSchema`), so this apply path — exactly like the generic
    // `POST /relationships` endpoint (`routes/relationships.ts`) — must refuse an engine-owned
    // system-managed type (`coordinates`/`approves`) outright. Otherwise IaC apply becomes a second
    // injection vector for a `coordinates` membership edge that only needs `relationship:write`,
    // bypassing the authority-checked campaign membership path
    // (`graph/system-managed-relationships.ts` has the full rationale). Legitimate campaign IaC
    // membership goes exclusively through the authority-checked `campaign.properties.targets`
    // declaration (`assertCampaignTargetsWithinAuthority`, above).
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

    // THE `governance:move` TWIN FOR ROUTE 2 — the SECOND half of door (b), and it was missing.
    //
    // The twin above guards `objects[].domainId` (containment route 1). A manifest reaches the
    // SAME move through route 2: a `contains` relationship entry. `contains` is not system-managed
    // (`graph/system-managed-relationships.ts` lists `approves`/`coordinates`/`annotates` only), so
    // the refusal above does not touch it, and `executePlanDiff` mints it — and prunes it — from
    // the manifest verbatim. That is exactly what a manifest's `component.service` change compiles
    // to (`plan-diff.ts`: a `contains` create plus a prune-delete), so without this, door (c)
    // (`components-repo.ts::setComponentService`, `routes/relationships.ts`) shipped INERT on IaC
    // and an Operator holding `relationship:write` could perform through `POST /plans/{id}/apply`
    // the very move the HTTP doors refuse them. #244's lesson repeated one loop lower: the twin was
    // added where the first hole was found rather than to the whole class.
    //
    // Endpoints, matching `routes/relationships.ts` exactly:
    //   create → the child is the `to`, the destination container is the `from` (:104);
    //   delete → the child is the `to`, the destination is the ORG ROOT (`null`), because losing a
    //            `contains` parent drops the row back onto its `domain_id` route (:252).
    // Thrown EAGERLY for the reason the route-1 twin above is: the demand is conditional and its
    // refusal names a rung, neither of which a `{permission, scopeObjectId}` pair can carry.
    // A MISSING `id` MEANS "created by THIS apply" (`ObjectResolution.id` is unset for a `create`
    // entry until `executePlanDiff` runs it), and that decides both halves:
    //   - `to.id` unset → the child is being created here, so there is no prior governance reach for
    //     it to leave. A create is not a move; door (a) does not gate a create either
    //     (`resolveDeclaredContainmentParent` runs on an object that already exists), and
    //     `POST /discovery/accept` carves out the same shape for the same reason. Gating it would
    //     refuse the ordinary "new service and its new components" manifest under any enabled rung.
    //   - `from.id` unset → the destination CONTAINER is being created here; it can carry no rung of
    //     its own yet, and its reach is exactly its declared parent's, which is what `scopeObjectId`
    //     already holds (`entry.target?.domainId ?? orgId`). So the destination chain is checked at
    //     that parent rather than skipped.
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

  // C1/ADR-0026 — `object:write` at the COMPONENT, which is also where OWNERSHIP lives (decision
  // Q4). Checking the component and not the deployment-target is deliberate: a platform team owning
  // the targets must not thereby own every app team's placements, and it matches how a source
  // mapping's ownership is already inherited from its component.
  for (const entry of diff.placements ?? []) {
    if (entry.action === "noop") continue;
    const component = await resolveEndpoint(entry.componentUrn);
    checks.push({ permission: "object:write", scopeObjectId: component.scopeObjectId });
    // RESOLVED BUT NOT CHECKED. `endpointId` throws an INTERNAL error for a URN this pass did not
    // resolve, and the deployment-target may legitimately belong to another stack — so a placement
    // at a foreign target used to fail apply with "internal: could not resolve object id". No
    // `object:write` is pushed for it deliberately: ownership follows the COMPONENT (decision Q4),
    // and demanding write on the target would hand every deployment-target owner a veto.
    await resolveEndpoint(entry.deploymentTargetUrn);
  }

  // PRODUCER DECLARATIONS — `policy:write` AT THE ORG ROOT, and deliberately NOT the per-object
  // `object:write` every other collection in this function uses.
  //
  // The rule is `dependencyProducerScopeCheck`'s, imported rather than restated so this door and
  // `POST /dependencies/producers` cannot come to require different things. The reason it is not
  // per-object is the reason the verb's is not: declaring "X produces @acme/lib" changes behaviour
  // for every OTHER component in the org that depends on that coordinate, and RBAC scope expands
  // strictly UPWARD — so `object:write` at X reaches none of the siblings it affects. One check for
  // the whole plan, because the permission and scope do not vary per entry.
  //
  // `noop` entries are exempt, matching every other loop here: a re-apply that changes nothing must
  // not demand authority the first apply already exercised.
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

  // `governance:move` RUNGS — `policy:write` AT-OR-ABOVE THE SUBJECT, per entry.
  //
  // The pair is `governanceMoveRungScopeCheck`'s, imported rather than restated so this door and
  // `PUT /governance/move-enforcement/rungs/{idOrUrn}` cannot come to require different things. It is
  // per-subject and not one org-root check (unlike producers, whose blast radius really is org-wide):
  // a rung's reach is exactly the subtree under its container, and `authorize` expands strictly
  // UPWARD, so a narrowly-bound Administrator can govern their own service and an org-wide one still
  // passes everywhere.
  //
  // `noop` entries are exempt, matching every other loop here: a re-apply that changes nothing must
  // not demand authority the first apply already exercised.
  //
  // A `create` whose subject THIS PLAN creates resolves to the pending entry — no id yet, and
  // `scopeObjectId` is the declared containment parent (`entry.target?.domainId ?? orgId`). That is
  // the right scope and not a weaker one: authority expands upward, so `policy:write` at-or-above the
  // parent is `policy:write` at-or-above a child of it.
  for (const entry of diff.governanceMoveRungs ?? []) {
    if (entry.action === "noop") continue;
    const subject = await resolveEndpoint(entry.subjectUrn);
    checks.push(governanceMoveRungScopeCheck(subject.scopeObjectId));
  }

  for (const entry of diff.executorBindings ?? []) {
    if (entry.action === "noop") continue;
    // A PLACEMENT-targeted binding authorizes at the COMPONENT, exactly as the placement loop above
    // does (decision Q4) — and it must, because the placement object may not exist yet: on a first
    // apply the same plan creates it a few steps later. Resolving the placement here would 404 on
    // precisely the plan that is allowed to create it.
    // `targetUrn` IS the component for a placement-targeted binding, so this one check covers both
    // shapes — ownership follows the component (decision Q4).
    const target = await resolveEndpoint(entry.targetUrn);
    checks.push({ permission: "object:write", scopeObjectId: target.scopeObjectId });
    // Same reason as the placement loop above: `bindingTargetObjectId` hands BOTH halves to
    // `endpointId`, so both must be resolved, and the target half carries no check of its own.
    if (entry.deploymentTargetUrn) await resolveEndpoint(entry.deploymentTargetUrn);

    // A system-backed binding makes SCP dispatch with THAT system's decrypted token (and, where
    // both egress layers agree, its internal-egress reach) — a use-of-credentials capability. The
    // typed route gates it with `object:write` at the system itself (ADR-0003); this door must too,
    // or IaC apply is a way to borrow a system an actor may not use. The id is already resolved
    // (plan-compute), so pushing the check needs no read — which is exactly what keeps this path
    // from becoming the type/existence oracle `bindTargetToExecutionSystem`'s authorize-first
    // ordering exists to prevent. The system's typeId/kind/serverUrl are validated later, in
    // `executePlanDiff`, after every one of these checks has been authorized.
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

/**
 * Executes an already-authorized diff, all inside the caller's transaction (transactional apply,
 * goal statement). Order matters: object creates/updates first (so relationship creates can resolve
 * freshly-created endpoints), then relationship DELETES, then relationship CREATES, then C1's
 * projection rows (mapping/binding deletes, then binding creates/updates, then mapping creates),
 * then object deletes last (so a relationship delete never races an already-gone endpoint, and no
 * projection row is orphaned behind a soft-deleted object).
 *
 * Relationship deletes run BEFORE creates so a declarative re-parent converges in one apply (M12
 * P5b): changing a component's `service` in a manifest yields a `contains` create (new service) plus
 * a prune-delete (old service) — with creates first, the new edge would trip migration 0022's
 * one-service-per-component index while the old edge is still live (a false 409). Deleting first
 * frees the component. Delete-before-create is safe generally: both endpoints are objects, which are
 * created earlier (creates loop) and deleted later (object-deletes loop), so an edge's endpoints
 * always exist during both its delete and its create; and no relationship depends on another
 * relationship existing.
 */
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

  // OWNERSHIP, STAMPED FOR EVERY OBJECT THIS MANIFEST DECLARES (drizzle/0068). One statement, and
  // one rule: a stack owns exactly the rows its manifest declares, plus the rows it already owned.
  //
  // `noop` counts, and that is the case worth stating. A declared object that happens to be
  // byte-identical to what is stored is still an object this stack declares — skipping it because
  // "nothing changed" would leave it undeletable by the stack that owns it, which is the escape
  // direction of the very defect this replaces, arrived at by accident. Under the old label scheme
  // this was accidentally handled: adopting an object rewrote its labels, so it was never a noop on
  // the apply that adopted it. Ownership is now explicit rather than a side effect of a label merge,
  // so it has to be said.
  //
  // `delete` entries are excluded by construction — they are not in this list — and ownership is
  // never CLEARED here: a row leaves a stack by being pruned, not by being disowned into an orphan
  // no stack could ever clean up.
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

  // The relationship half of the same stamp, for the same reason, after the creates so a
  // just-created edge is included. It also closes a gap the label scheme had: only edge CREATES were
  // ever labelled, so an edge a manifest declared but that some other door had already written
  // (`POST /components` writes a `contains` edge) stayed declared-but-unowned forever and could
  // never be pruned by the stack that declared it. Objects never had that gap.
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

  // -----------------------------------------------------------------------------------------
  // C1 — projection rows. These run AFTER object creates (a binding needs its deployment-target /
  // a mapping needs its component to exist) and BEFORE object deletes. The delete ordering is
  // load-bearing, not cosmetic: `deleteObject` is a SOFT delete, and both projection tables are
  // keyed on the object id with no `deleted_at` of their own. Prune the object first and its rows
  // become permanently unreachable garbage — invisible to every list query (they filter on a live
  // target) and outside every future plan's ownership pool (which is built from LIVE labelled
  // objects), so nothing would ever remove them.
  //
  // Deletes before creates/updates, mirroring the relationship ordering above and for the same
  // reason: `UNIQUE (org_id, target_object_id, type)` means two bindings swapping Types in one plan
  // would collide if the creates ran first.
  // -----------------------------------------------------------------------------------------

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

  /**
   * The `executor_bindings.target_object_id` a diff entry names, whichever way it was addressed.
   *
   * A placement is resolved BY ITS PAIR — its URN is derived (ADR-0026 D3), so there is no stable
   * URN to look up. It must already be live at the moment of the call, which the apply ORDER makes
   * true in both directions: binding-prune runs BEFORE placement-prune, and binding-create runs
   * AFTER placement-create.
   */
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
      entry.type
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
    // DECISION Q2 — REFUSE, naming the binding. A cascade would delete execution configuration the
    // manifest never mentioned, and an orphaned binding fails SILENTLY (no FK, no deleted_at, and
    // `targetObjectIsLive` hides it at read time).
    //
    // Q2 WAS DECIDED ON A PREMISE THAT NO LONGER HOLDS, and this is now a different guard than it
    // was. The ruling's reasoning was "the manifest cannot even name it (its target is the
    // placement)" — true when bindings could only be addressed by object URN. A manifest CAN now
    // declare a binding on a placement by its pair, so a stack that wants both gone declares
    // neither and the binding-prune above removes it first; the common case no longer reaches here.
    //
    // What survives is narrower and still worth having: this is the APPLY-TIME net for a binding
    // that was NOT in the plan's prune set — most realistically one written between plan and apply,
    // which no diff computed earlier could have known about. Refusing beats destroying it, and the
    // message still has to name what to remove first.
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

  // PLACEMENT CREATE runs BEFORE the binding creates below, because a binding may TARGET a
  // placement — after the ADR-0026 migration most do — and its target must exist first.
  //
  // Goes through `createPlacement`, the same function `POST /v1/placements` uses, and NOT
  // `createObject`. That is the whole reason this is a typed collection: `createPlacement` resolves
  // and type-checks both endpoints, derives the URN from the pair, and writes the two derived
  // `places`/`placed_at` edges in the SAME transaction. `createObject` does none of those, which is
  // why the generic door refuses pair-bound types outright (#207) — and this apply path is one of
  // the doors that refusal had to be added to.
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
        externalRef: target.externalRef
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
      executionSystemId: null
    });
  }

  for (const entry of diff.sourceMappings ?? []) {
    if (entry.action === "update") {
      // §10.6 — the in-place convergence of the ONE non-identity attribute the diff manages. Every
      // row sharing the tuple, for the same reason `deleteSourceMappingsMatching` takes them all: a
      // byte-identical sibling left behind would re-propose this update on every plan forever. A
      // plan stored without a scope key (`undefined`) cannot have produced an `update` verdict, so
      // reading it as null here is unreachable rather than a silent clear.
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

  // -----------------------------------------------------------------------------------------
  // PRODUCER DECLARATIONS (ADR-0032 §7e). AFTER object creates (a declaration needs its producer
  // component to exist) and BEFORE object deletes, for the same reason the projection rows above
  // run there: `deleteObject` is a SOFT delete and `dependency_line_producers` has no `deleted_at`
  // of its own, so a declaration left behind a tombstoned component is unreachable garbage —
  // invisible to the poll's internal/third-party join and outside every future plan's ownership
  // pool, which is built from LIVE labelled objects.
  //
  // EACH ENTRY GOES THROUGH THE SAME FUNCTION THE VERB CALLS. A declaration is not a row write: the
  // covered lines' observed heads must be cleared (a poisoned public head would otherwise survive
  // the declaration meant to undo it; a stale internal head is an M22 vendor-scan-rule input on a
  // coordinate that is third-party again), a Decision must be recorded, and an audit event
  // appended. `dependencies/producer-declaration.ts` owns all four so this door cannot perform a
  // fraction of the verb.
  //
  // Deletes before creates/updates, mirroring every other collection here — though for this one it
  // cannot matter: identity is the coordinate, so a single plan can never both prune and declare the
  // same key.
  //
  // AND EVERY NON-NOOP ENTRY RE-READS WHO HOLDS THE COORDINATE, HERE, RATHER THAN TRUSTING THE
  // STORED DIFF — see `assertPlannedProducerHolder`.
  // -----------------------------------------------------------------------------------------

  /**
   * THE COORDINATE MUST STILL BE HELD BY WHOEVER THE PLAN SAID HELD IT.
   *
   * `plan-diff.ts` computes `create` / `update` + `displacedProducerUrn` / `delete` from a snapshot
   * taken at `POST /plans` time, and `dependency_line_producers` is keyed on the COORDINATE and
   * UPSERTED — so the coordinate can change hands between plan and apply with no row deleted and
   * nothing stale-marking the plan. `displacedProducerUrn` exists precisely because a transfer is a
   * supported act, which is the same reason one can happen inside this window. Trusting the stored
   * answer produced three distinct wrong outcomes, all silent:
   *
   *  - a `create` whose coordinate was claimed in the window OVERWRITES the new holder. The
   *    reviewed plan said "no producer is declared … it is polled as third-party today"; the apply
   *    performs a transfer, and `invalidProducerDeclarations` cannot object because the STORED diff
   *    carries no displacement to object to.
   *  - an `update` whose displaced producer was itself displaced in the window takes the coordinate
   *    from a THIRD component that the plan never named and no guard ever saw — the cross-stack
   *    steal that refusal (2) exists to refuse, arriving through the back door.
   *  - a `delete` whose row changed hands in the window RETRACTS SOMEBODY ELSE'S DECLARATION. The
   *    existence check alone passes (a row is there), and the coordinate silently returns to
   *    third-party polling for the component that just took it — a dependency-confusion re-arm
   *    (ADR-0032 §7b) performed by a plan whose reviewed text names a different producer entirely.
   *
   * SO A STALE PLAN FAILS LOUDLY. The refusal is a 409 inside the apply transaction, so nothing
   * partially applies, and the remedy is the ordinary one: re-plan against current state. The holder
   * is compared BY URN because that is the vocabulary of the diff, and the read includes tombstones
   * so a holder whose component was deleted is NAMED rather than reading as "nobody" — the null-drop
   * that would otherwise let a `create` sail past a standing declaration for the second time.
   */
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

  // -----------------------------------------------------------------------------------------
  // `governance:move` RUNGS (ADR-0038 §2; proposal governance-reach-on-containment-move.md §9.6 Q4).
  //
  // POSITION IS LOAD-BEARING AT BOTH ENDS, the same sandwich the producer block above sits in:
  //  - AFTER object creates, because "create this service and govern moves under it" is the ordinary
  //    first manifest and the subject has no id until then.
  //  - BEFORE object deletes, because `deleteObject` is a SOFT delete and `governance_move_rungs` has
  //    no `deleted_at` of its own. A rung left behind a tombstoned container is a bar nobody can see
  //    (it is outside every list read's join and outside every future plan's ownership pool) that
  //    would spring back to life on any object restore.
  //
  // EACH ENTRY GOES THROUGH THE SAME FUNCTION THE VERB CALLS
  // (`governance/move-rung-write.ts`), so this door writes the whole act — row, Decision, audit
  // event — or none of it. Nothing here reaches `governance_move_rungs` directly, and that is the
  // point: a second writer that wrote only the row would make
  // `GET /decisions?kind=governance.move_enforcement` silently false for exactly the rungs an
  // auditor came looking for (charter principle 6).
  //
  // Deletes before creates, mirroring every other collection here — and unlike the producers', this
  // ordering CAN matter: identity is the subject, and disabling a rung above before enabling one
  // below is precisely the sequence the monotone refusal permits (the reverse order 409s).
  //
  // NO STALE-PLAN HOLDER CHECK. The producers' `assertPlannedProducerHolder` exists because a
  // coordinate can change hands between plan and apply with no row deleted. A rung cannot change
  // hands: it is enabled at its subject or it is not, both states are re-read here, and each of the
  // two mismatches has its own honest failure below — a create finds the upsert idempotent, and a
  // delete that lost its row 404s as a prune miss.
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
