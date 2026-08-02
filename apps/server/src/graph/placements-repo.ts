import { and, eq, isNull, sql } from "drizzle-orm";
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
import { authorize } from "../authz/resolve.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { badRequest, conflict } from "../errors.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from "../pagination.js";
import { slugify } from "./urn.js";

/**
 * `placement` — one component at one deployment target (ADR-0026 D2/D3/D14, owner decision D17).
 *
 * THIS MODULE IS THE SINGLE WRITER that keeps a placement's two representations in agreement, and
 * that is its whole reason to exist. Migration 0051's header states the shape and why both halves
 * are needed; restated here because this is where it is enforced:
 *
 *   * `properties.componentId` / `properties.deploymentTargetId` are the SOURCE OF TRUTH. Only they
 *     can carry the unique index — nothing in the schema can reference a relationship id, and
 *     uniqueness over a PAIR of relationship rows is not expressible as one index.
 *   * The `places` / `placed_at` edges are DERIVED. Only they are traversable — `traverse`,
 *     blast-radius and the graph explorer walk `relationships`, and a placement whose endpoints
 *     lived only as property UUIDs would be an island in the graph.
 *
 * One fact in two places is a real cost and it is paid deliberately. It is contained by there being
 * exactly ONE local write path: `createPlacement` writes both in one transaction, and the generic
 * `/objects/placement` and overlay doors are refused outright (`graph/pair-bound-types.ts`). The
 * federation path reproduces both halves without this module, because a replicated placement arrives
 * as an `object_upsert` plus its own `relationship_upsert` entries.
 */

/**
 * The URN separator, and why it is `/` (owner decision D17, second addition).
 *
 * ADR-0026 D3 names a placement `<component>@<deployment-target>`, but a NAME is not a URN: `slugify`
 * maps every `[^a-z0-9]+` run to a single `-`, so `keycloak@commercial-prod` and a literal component
 * named `keycloak commercial prod` both derive `keycloak-commercial-prod`. Deriving the URN from the
 * display name would therefore be quietly AMBIGUOUS — and while D8 forbids relying on name-based
 * uniqueness anyway (migration 0051's index is the guarantee), an ambiguous identifier is its own
 * bug: two different placements would race for one URN and the loser would get an unexplainable 409.
 *
 * `/` is the fix and the only clean one available: the URN grammar's slug-path
 * (`UrnSchema` in packages/schemas/src/graph.ts) explicitly admits it, while `slugify` STRIPS it —
 * so a `/` in a placement URN can only ever be the separator this function put there, never a
 * character that leaked out of an endpoint's name. It also reads as what it is: a path from a
 * component to a place. No alphanumeric separator (`-at-`, `_at_`) has that property; each is
 * forgeable by an endpoint whose own name contains it.
 *
 * The DISPLAY name keeps `@` per D3. The two identifiers answer different questions and are allowed
 * to differ.
 */
function derivePlacementUrn(orgSlug: string, componentName: string, targetName: string): string {
  return `urn:scp:${orgSlug}:placement:${slugify(componentName)}/${slugify(targetName)}`;
}

/**
 * The DERIVED edges, as one list so create and withdraw cannot drift apart — adding a third edge
 * type in one place and forgetting the other is precisely the incomplete-call-site shape this
 * repo keeps paying for.
 */
const PLACEMENT_DERIVED_EDGE_TYPES = ["places", "placed_at"] as const;

/**
 * Migration 0051's pair index is the IDENTITY guarantee, not a backstop (see its header) — reached
 * either by a plain duplicate declaration or by two CONCURRENT ones under READ COMMITTED. Says what
 * actually happened, rather than the generic URN-collision 409, which would blame the name.
 */
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
  /** id or URN of the component being placed. */
  componentIdOrUrn: string;
  /** id or URN of the deployment-target it is placed at. */
  deploymentTargetIdOrUrn: string;
}

/**
 * Declares a placement: the object, its two derived edges, and a Decision, in ONE transaction.
 *
 * Placements are DECLARED, never inferred (D8) — nothing here pairs objects by name, and nothing
 * may. The proposal's own §1.2 data is the reason: `agentkit-bootstrap` / `agentkit-db-bootstrap-prod`
 * and `agentkit-selfhost` / `agentkit-hosted` look like pairs and are different Argo CD applications.
 * An undeclared pair stays undeclared until a human says otherwise.
 */
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

  // Both-endpoint authority — the security check `createRelationship` alone does NOT do (it validates
  // endpoint TYPES and cardinality, never authority). A placement grants the component reach into
  // that deployment-target, and an executor binding attaches to the result, so the actor must hold
  // `relationship:write` over BOTH ends. Modelled on `components-repo.ts`'s service check, one
  // endpoint further: neither end here is the actor's own fresh object.
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

  // WITHDRAW-THEN-RE-DECLARE. `objects_org_id_urn_key` is a PLAIN unique constraint — unlike every
  // partial index in this schema it does NOT filter `deleted_at IS NULL` — so a withdrawn placement
  // holds its URN forever. Migration 0051's pair index deliberately frees the PAIR on withdrawal,
  // and D8 makes withdraw-then-re-declare the only way to change a placement (there is no PATCH),
  // so without this the documented lifecycle would 409 on its second step and 0051's header would
  // describe something that does not work.
  //
  // Checked UP FRONT rather than caught: a unique violation aborts the whole Postgres transaction,
  // so a retry inside the same `tx` cannot work without a savepoint, and this create writes two
  // edges and a Decision after the object — all of which would be lost.
  //
  // The suffix is the new object's own id, following `webhook-processor.ts`'s precedent for the same
  // collision, and appears ONLY on a re-declaration: the first declaration of any pair keeps the
  // clean `<component>/<target>` URN. A caller-supplied `urn` is never rewritten — that is the
  // caller asserting an identity, and silently altering it would be worse than the 409.
  //
  // A lost race here (two re-declarations of the same withdrawn pair at once) still cannot produce a
  // duplicate: the pair index catches it and raises the 409 below. This only chooses a URN.
  let id = input.id;
  let urn = baseUrn;
  if (!input.urn && (await urnIsTaken(tx, input.orgId, baseUrn))) {
    id = input.id ?? uuidv7();
    urn = `${baseUrn}-${id}`;
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

/**
 * Withdraws a placement: BOTH derived edges and the object, soft-deleted in ONE transaction.
 *
 * This exists because `deleteObject` does not touch relationships — nothing in the graph cascades —
 * so a placement removed through the plain object delete would leave its `places` / `placed_at`
 * edges LIVE, pointing out of a dead object. That is not a tidiness issue, it is the exact failure
 * the properties-are-truth/edges-are-derived split has to defend against, and it would surface as a
 * traversal or blast-radius result naming a placement that no longer exists.
 *
 * It is also reachable, not hypothetical: migration 0051's unique index filters `deleted_at IS NULL`
 * on the OBJECT, so withdrawing frees the pair to be re-declared — and the re-declaration writes a
 * second pair of edges. Without this, one component would accumulate an edge per withdrawal, all
 * live, and the graph would report it placed at the same target N times.
 *
 * Edges first, then the object, so no intermediate state has a live edge out of a dead object.
 */
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
  /** Already-resolved deployment-target object id. */
  deploymentTargetId?: string | undefined;
}

/**
 * Lists placements, optionally filtered by either end of the pair.
 *
 * Filters read the PROPERTIES, not the edges — the source of truth, and the half the unique index
 * covers. Reading the edges instead would answer subtly differently the moment the two ever
 * disagreed, and a query that silently disagrees with the constraint is worse than no query.
 */
export async function listPlacements(
  tx: TenantTx,
  orgId: string,
  query: ListPlacementsQuery
): Promise<{ items: GraphObject[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conditions = [eq(objects.orgId, orgId), eq(objects.typeId, "placement")];
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
