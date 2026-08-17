import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type {
  DesiredStateManifest,
  Plan,
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
  computePlanDiff,
  duplicateProjectionDeclarations,
  managedLabels,
  uncontainedComponentCreates,
  unownedProjectionDeclarations,
  type ExistingObjectSnapshot,
  type ExistingRelationshipTriple,
  type ResolvedManifest,
  type ResolvedManifestExecutorBinding,
  type ResolvedManifestObject,
  type ResolvedManifestPlacement,
  type ResolvedManifestSourceMapping
} from "./plan-diff.js";
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
  listSourceMappingsForComponents
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
      `${unowned.join(", ")}. Neither table carries stack labels, so ownership is inherited from the ` +
      `object the row hangs off — declare that object in this stack's manifest (which adopts it), or ` +
      `configure it from the stack that already manages it.`
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

/** Live objects currently carrying `scp:managed-by=iac`/`scp:stack=<stackName>` — the object prune pool. */
async function fetchManagedObjects(tx: TenantTx, orgId: string, stackName: string) {
  return tx
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        isNull(objects.deletedAt),
        sql`${objects.labels} @> ${JSON.stringify(managedLabels(stackName))}::jsonb`
      )
    );
}

/** Live relationships currently carrying this stack's managed-by labels — the relationship prune pool. */
async function fetchManagedRelationships(tx: TenantTx, orgId: string, stackName: string) {
  return tx
    .select()
    .from(relationships)
    .where(
      and(
        eq(relationships.orgId, orgId),
        isNull(relationships.deletedAt),
        sql`${relationships.labels} @> ${JSON.stringify(managedLabels(stackName))}::jsonb`
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

  const referencedUrns = new Set<string>();
  for (const obj of manifest.objects) referencedUrns.add(obj.urn);
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
    labels: row.labels as Record<string, unknown>
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
  // Neither table carries labels, so a row's owner is the owner of the object it hangs off. The
  // pool is therefore "every object this stack will own once this plan applies": the objects it
  // ALREADY owns (`managedObjectRows` — this stack's labels) UNION the live objects this manifest
  // declares (apply stamps the stack's labels onto each, so declaring an object adopts it).
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
      classification: row.classification
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
      classification: m.classification ?? null
    })),
    placements: (manifest.placements ?? []).map((pl) => ({
      componentUrn: pl.componentUrn,
      deploymentTargetUrn: pl.deploymentTargetUrn
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

  const diff = computePlanDiff(resolvedManifest, {
    existingObjects,
    managedRelationships,
    existingRelationships,
    managedSourceMappings,
    managedExecutorBindings,
    managedPlacements
  });
  // Strict create-in-service, IaC path (M12 P5a): reject at plan-compute so the invalid manifest
  // never becomes a stored plan and the human reviews only a valid diff. C1's two guards run at the
  // same point, for the same reason.
  assertComponentsContained(diff);
  assertProjectionsOwned(diff);
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
      // The CYCLE half of the same fix is deliberately NOT duplicated here: it is a subject-free
      // invariant and lives in `graph/objects-repo.ts`'s `updateObject`, which this path writes
      // through — see the comment there for why the repo, not the doors, owns it. The ROOT-
      // REACHABILITY half of the CREATE branch above is subject-free for the same reason and lives
      // in `createObject`, which `executePlanDiff` calls directly.
      const destination = entry.target?.domainId;
      if (entry.action === "update" && destination && destination !== found.domainId) {
        checks.push({ permission: writePermissionFor(entry.typeId), scopeObjectId: destination });
        if (found.domainId && found.domainId !== orgId) {
          checks.push({
            permission: writePermissionFor(entry.typeId),
            scopeObjectId: found.domainId
          });
        }
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
    // bypassing the authority-checked campaign/initiative membership paths
    // (`graph/system-managed-relationships.ts` has the full rationale). Legitimate campaign IaC
    // membership goes exclusively through the authority-checked `campaign.properties.targets`
    // declaration (`assertCampaignTargetsWithinAuthority`, above); initiative IaC membership is not
    // supported (add members via `POST /initiatives/{id}/campaigns` / `scp initiative add-campaign`,
    // which run the both-endpoint authority check).
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
      labels: managedLabels(stackName)
    });
  }

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
    if (entry.action !== "create") continue;
    await createSourceMapping(tx, {
      orgId,
      sourceKind: entry.sourceKind,
      ...(entry.repoPattern !== null ? { repoPattern: entry.repoPattern } : {}),
      ...(entry.pathPattern !== null ? { pathPattern: entry.pathPattern } : {}),
      ...(entry.refPattern !== null ? { refPattern: entry.refPattern } : {}),
      componentIdOrUrn: endpointId(entry.componentUrn),
      type: entry.type,
      ...(entry.classification !== null ? { classification: entry.classification } : {})
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
