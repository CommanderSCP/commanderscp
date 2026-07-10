import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DesiredStateManifest, Plan, PlanDiff, PlanStatus } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects, plans, relationships } from "../db/schema.js";
import { conflict, notFound } from "../errors.js";
import type { Permission } from "../authz/resolve.js";
import {
  createObject,
  deleteObject,
  getObjectByIdOrUrn,
  getObjectByIdOrUrnAnyType,
  resolveDomainId,
  updateObject
} from "../graph/objects-repo.js";
import { createRelationship, deleteRelationship, listRelationships } from "../graph/relationships-repo.js";
import { isGovernanceManagedObjectType } from "../governance/governance-managed-types.js";
import { assertPolicyScopeWithinAuthority } from "../governance/policy-scope-authz.js";
import {
  computePlanDiff,
  managedLabels,
  type ExistingObjectSnapshot,
  type ExistingRelationshipTriple,
  type ResolvedManifest,
  type ResolvedManifestObject
} from "./plan-diff.js";

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
    const domainId = await resolveDomainId(tx, orgId, obj.domainId ?? undefined);
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

  const resolvedManifest: ResolvedManifest = {
    stackName: manifest.stackName,
    objects: resolvedObjects,
    relationships: manifest.relationships.map((r) => ({
      typeId: r.typeId,
      fromUrn: r.fromUrn,
      toUrn: r.toUrn
    }))
  };

  return computePlanDiff(resolvedManifest, {
    existingObjects,
    managedRelationships,
    existingRelationships
  });
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
async function lockPlan(tx: TenantTx, orgId: string, id: string): Promise<typeof plans.$inferSelect> {
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
 *  typed `/policies`/`/controls` routes require (security fast-follow after PR #9). */
function writePermissionFor(typeId: string): Permission {
  return isGovernanceManagedObjectType(typeId) ? "policy:write" : "object:write";
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

  for (const entry of diff.objects) {
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
      continue;
    }
    const found = await getObjectByIdOrUrn(tx, orgId, entry.typeId, entry.urn);
    objectResolutions.set(entry.urn, { id: found.id, scopeObjectId: found.id });
    if (entry.action !== "noop") {
      checks.push({ permission: writePermissionFor(entry.typeId), scopeObjectId: found.id });
      if (entry.typeId === "policy" && entry.action === "update") {
        await assertPolicyScopeWithinAuthority(tx, {
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
    const from = await resolveEndpoint(entry.fromUrn);
    const to = await resolveEndpoint(entry.toUrn);
    checks.push({ permission: "relationship:write", scopeObjectId: from.scopeObjectId });
    checks.push({ permission: "relationship:write", scopeObjectId: to.scopeObjectId });
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
 * goal statement). Order matters: object creates/updates first (so relationship creates can
 * resolve freshly-created endpoints), then relationship creates, then relationship deletes, then
 * object deletes last (so a relationship delete never races an already-gone endpoint).
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
      domainId: target.domainId,
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
      domainId: target.domainId,
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

  for (const entry of diff.relationships) {
    if (entry.action !== "delete") continue;
    const id = await findLiveRelationshipId(tx, orgId, {
      fromId: endpointId(entry.fromUrn),
      toId: endpointId(entry.toUrn),
      typeId: entry.typeId
    });
    await deleteRelationship(tx, { orgId, actorObjectId, requestId, id });
  }

  for (const entry of diff.objects) {
    if (entry.action !== "delete") continue;
    await deleteObject(tx, { orgId, typeId: entry.typeId, actorObjectId, requestId, idOrUrn: entry.urn });
  }
}
