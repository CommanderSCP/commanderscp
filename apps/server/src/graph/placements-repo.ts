import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { ContainmentDomainId, GraphObject } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import {
  createObject,
  deleteObject,
  getObjectByIdOrUrn,
  getObjectByIdOrUrnAnyType,
  toGraphObject
} from "./objects-repo.js";
import { createRelationship, deleteRelationship, listRelationships } from "./relationships-repo.js";
import { assertContainmentDepthAdmits, containmentParentChainForDoor } from "./containment.js";
import { authorize } from "../authz/resolve.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { badRequest, conflict } from "../errors.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from "../pagination.js";
import { slugify } from "./urn.js";

/** `placement` — one component at one deployment target. See docs/graph.md §132. */

/** The URN separator, and why it is `/`. See docs/graph.md §133. */
function derivePlacementUrn(orgSlug: string, componentName: string, targetName: string): string {
  return `urn:scp:${orgSlug}:placement:${slugify(componentName)}/${slugify(targetName)}`;
}

/** The derived edges as one list, so create and withdraw agree. See docs/graph.md §134. */
const PLACEMENT_DERIVED_EDGE_TYPES = ["places", "placed_at"] as const;

/** The pair index is the identity guarantee, not a backstop. See docs/graph.md §135. */
function pairConflict(componentId: string, deploymentTargetId: string) {
  return conflict(
    `component '${componentId}' already has a placement at deployment-target '${deploymentTargetId}'`
  );
}

/**
 * Is this URN already spoken for — INCLUDING by a soft-deleted object? `deleted_at` is deliberately
 * NOT filtered: the whole point is that `objects_org_id_urn_key` does not filter it either.
 */
async function urnIsTaken(tx: TenantTx, orgId: string, urn: string): Promise<boolean> {
  const row = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp }) => andOp(eqOp(t.orgId, orgId), eqOp(t.urn, urn))
  });
  return row !== undefined;
}

/** ADR-0026 D3's display name. */
function derivePlacementName(componentName: string, targetName: string): string {
  return `${componentName}@${targetName}`;
}

export interface CreatePlacementInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  id?: string | undefined;
  urn?: string | undefined;
  name?: string | undefined;
  /** CONTAINMENT sense (ADR-0021 D4). */
  domainId?: ContainmentDomainId | null | undefined;
  labels?: Record<string, unknown> | undefined;
  componentIdOrUrn: string;
  /** id or URN of the deployment-target it is placed at. */
  deploymentTargetIdOrUrn: string;
}

/** Declares a placement. See docs/graph.md §136. */
export async function createPlacement(
  tx: TenantTx,
  input: CreatePlacementInput
): Promise<GraphObject> {
  // Resolve and TYPE-CHECK both endpoints before any write. This is the check migration 0051's
  // `required` cannot make: two well-formed UUIDs pointing at the wrong types satisfy the property
  // schema perfectly, and a placement whose "component" is a service is silently meaningless.
  const component = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.componentIdOrUrn);
  if (component.typeId !== "component") {
    throw badRequest(
      `'${input.componentIdOrUrn}' is a '${component.typeId}', not a component — a placement places a component at a deployment-target`
    );
  }
  const target = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.deploymentTargetIdOrUrn);
  if (target.typeId !== "deployment-target") {
    throw badRequest(
      `'${input.deploymentTargetIdOrUrn}' is a '${target.typeId}', not a deployment-target — a placement places a component at a deployment-target`
    );
  }

  // Both-endpoint authority, which edge creation does not check. See docs/graph.md §137.
  await authorize(tx, {
    orgId: input.orgId,
    subjectObjectId: input.actorObjectId,
    permission: "relationship:write",
    scopeObjectId: component.id
  });
  await authorize(tx, {
    orgId: input.orgId,
    subjectObjectId: input.actorObjectId,
    permission: "relationship:write",
    scopeObjectId: target.id
  });

  const name = input.name ?? derivePlacementName(component.name, target.name);
  const baseUrn = input.urn ?? derivePlacementUrn(input.orgId, component.name, target.name);

  // Withdraw then re-declare, against a full unique constraint. See docs/graph.md §138.
  const id = input.id ?? uuidv7();
  let urn = baseUrn;
  if (!input.urn && (await urnIsTaken(tx, input.orgId, baseUrn))) {
    urn = `${baseUrn}-${id}`;
  }

  // CONTAINMENT ROUTES 3 AND 4. See docs/graph.md §139.
  for (const endpoint of [component, target]) {
    const { hops } = await containmentParentChainForDoor(tx, input.orgId, id, endpoint.id);
    await assertContainmentDepthAdmits(tx, {
      orgId: input.orgId,
      childId: id,
      parentId: endpoint.id,
      hops,
      childIsNew: true
    });
  }

  let object: GraphObject;
  try {
    object = await createObject(tx, {
      orgId: input.orgId,
      typeId: "placement",
      actorObjectId: input.actorObjectId,
      requestId: input.requestId,
      id,
      urn,
      name,
      domainId: input.domainId,
      properties: { componentId: component.id, deploymentTargetId: target.id },
      labels: input.labels
    });
  } catch (err) {
    if (isUniqueViolation(err, "objects_placement_one_per_component_target")) {
      throw pairConflict(component.id, target.id);
    }
    throw err;
  }

  // The DERIVED half. Same transaction, so the two representations cannot diverge: if either edge
  // fails, the object write rolls back with it.
  const edgeEndpoints: Record<(typeof PLACEMENT_DERIVED_EDGE_TYPES)[number], string> = {
    places: component.id,
    placed_at: target.id
  };
  for (const typeId of PLACEMENT_DERIVED_EDGE_TYPES) {
    await createRelationship(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      requestId: input.requestId,
      typeId,
      fromId: object.id,
      toId: edgeEndpoints[typeId]
    });
  }

  await insertDecision(tx, {
    orgId: input.orgId,
    kind: "transition",
    subjectId: object.id,
    verdict: "allow",
    inputContext: {
      trigger: "placement-declare",
      actorId: input.actorObjectId,
      componentId: component.id,
      deploymentTargetId: target.id
    },
    reasonTree: {
      summary: `placement declared: component ${component.id} at deployment-target ${target.id}`
    }
  });

  return object;
}

export interface WithdrawPlacementInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  idOrUrn: string;
}

/** Withdraws a placement. See docs/graph.md §140. */
export async function withdrawPlacement(
  tx: TenantTx,
  input: WithdrawPlacementInput
): Promise<GraphObject> {
  const placement = await getObjectByIdOrUrn(tx, input.orgId, "placement", input.idOrUrn);

  for (const typeId of PLACEMENT_DERIVED_EDGE_TYPES) {
    const edges = await listRelationships(tx, input.orgId, {
      limit: 100,
      fromId: placement.id,
      typeId
    });
    for (const edge of edges.items) {
      await deleteRelationship(tx, {
        orgId: input.orgId,
        actorObjectId: input.actorObjectId,
        requestId: input.requestId,
        id: edge.id
      });
    }
  }

  await deleteObject(tx, {
    orgId: input.orgId,
    typeId: "placement",
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    idOrUrn: input.idOrUrn
  });

  return getObjectByIdOrUrn(tx, input.orgId, "placement", placement.id, { includeDeleted: true });
}

export interface ListPlacementsQuery {
  cursor?: string | undefined;
  limit: number;
  domainId?: ContainmentDomainId | undefined;
  includeDeleted?: boolean | undefined;
  /** Already-resolved component object id (the route resolves the id-or-URN ref). */
  componentId?: string | undefined;
  deploymentTargetId?: string | undefined;
  /** The rows this caller's authority reaches, as a subquery. See docs/graph.md §141. */
  readableFilter?: SQL | null | undefined;
}

/** Lists placements, optionally filtered by either end of the pair. See docs/graph.md §142. */
export async function listPlacements(
  tx: TenantTx,
  orgId: string,
  query: ListPlacementsQuery
): Promise<{ items: GraphObject[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conditions = [eq(objects.orgId, orgId), eq(objects.typeId, "placement")];
  if (query.readableFilter) conditions.push(sql`${objects.id} IN ${query.readableFilter}`);
  if (!query.includeDeleted) conditions.push(isNull(objects.deletedAt));
  if (query.domainId) conditions.push(eq(objects.domainId, query.domainId));
  if (query.componentId) {
    conditions.push(sql`${objects.properties} ->> 'componentId' = ${query.componentId}`);
  }
  if (query.deploymentTargetId) {
    conditions.push(
      sql`${objects.properties} ->> 'deploymentTargetId' = ${query.deploymentTargetId}`
    );
  }
  if (cursor) conditions.push(keysetAfter(objects.createdAt, objects.id, cursor));

  const rows = await tx
    .select()
    .from(objects)
    .where(and(...conditions))
    .orderBy(...keysetOrderBy(objects.createdAt, objects.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toGraphObject),
    nextCursor: hasMore && last ? encodeCursor(last) : null
  };
}

/** Live placements whose COMPONENT is one of `componentObjectIds`. See docs/graph.md §143. */
export async function listPlacementsForComponents(
  tx: TenantTx,
  orgId: string,
  componentObjectIds: string[]
): Promise<{ componentObjectId: string; deploymentTargetObjectId: string; placementId: string }[]> {
  if (componentObjectIds.length === 0) return [];
  const rows = await tx
    .select({ id: objects.id, properties: objects.properties })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, "placement"),
        isNull(objects.deletedAt),
        inArray(sql`${objects.properties} ->> 'componentId'`, componentObjectIds)
      )
    );
  const out: {
    componentObjectId: string;
    deploymentTargetObjectId: string;
    placementId: string;
  }[] = [];
  for (const row of rows) {
    const props = row.properties as { componentId?: unknown; deploymentTargetId?: unknown };
    if (typeof props.componentId !== "string" || typeof props.deploymentTargetId !== "string") {
      // A malformed pair cannot be diffed against a manifest entry (which always carries both), and
      // silently treating it as absent would make the plan propose a duplicate. Skipping leaves it
      // invisible to BOTH create-matching and prune, which is the conservative half.
      continue;
    }
    out.push({
      componentObjectId: props.componentId,
      deploymentTargetObjectId: props.deploymentTargetId,
      placementId: row.id
    });
  }
  return out;
}

/** The live placement for one exact pair, or null. The apply path needs the ID to withdraw, and the
 *  pair is the only address a manifest can give (ADR-0026 D3 — the URN is derived, not declared). */
export async function findLivePlacement(
  tx: TenantTx,
  orgId: string,
  componentObjectId: string,
  deploymentTargetObjectId: string
): Promise<{ id: string } | null> {
  const rows = await tx
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, "placement"),
        isNull(objects.deletedAt),
        sql`${objects.properties} ->> 'componentId' = ${componentObjectId}`,
        sql`${objects.properties} ->> 'deploymentTargetId' = ${deploymentTargetObjectId}`
      )
    )
    .limit(1);
  return rows[0] ?? null;
}
