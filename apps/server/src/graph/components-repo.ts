import type { GraphObject } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { createObject, getObjectByIdOrUrnAnyType } from "./objects-repo.js";
import { createRelationship, deleteRelationship, listRelationships } from "./relationships-repo.js";
import { authorize } from "../authz/resolve.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { badRequest } from "../errors.js";

export interface CreateComponentInServiceInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  id?: string;
  urn?: string;
  name: string;
  domainId?: string | null;
  properties?: Record<string, unknown>;
  labels?: Record<string, unknown>;
  /** id or URN of the service this component must belong to (the `contains` parent). */
  serviceIdOrUrn: string;
}

/**
 * Strict component create (M12 P5a, docs/proposals/organize-after.md): the component object AND its
 * `service --contains--> component` edge, written in ONE transaction, so a component created
 * DIRECTLY always belongs to a service (owner ruling). Imports (discovery/accept, federation,
 * overlay) call `createObject` directly and never reach this path, so they stay permissive by
 * construction.
 *
 * Modeled on `coordination/initiative-repo.ts`'s `proposeInitiative` — the same object +
 * both-endpoint authz + edge + Decision shape (NOT campaign/change, which store targets as a
 * properties array). The `contains` cardinality (one_to_many) plus migration 0022's partial unique
 * index enforce one-service-per-component for free, and `createRelationship`'s endpoint-type check
 * rejects a `service` ref that isn't a service.
 */
export async function createComponentInService(
  tx: TenantTx,
  input: CreateComponentInServiceInput
): Promise<GraphObject> {
  // Resolve and type-check the service FIRST — a bad or wrong-type ref fails before any write.
  const service = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.serviceIdOrUrn);
  if (service.typeId !== "service") {
    throw badRequest(
      `'${input.serviceIdOrUrn}' is a '${service.typeId}', not a service — a component must belong to a service`
    );
  }
  // Both-endpoint authority (the security check `createRelationship` alone does NOT do): the actor
  // must hold `relationship:write` over the SERVICE they are attaching a child to. Authority over
  // the new component is implicit — the route's `object:write` check gates creating it, and it is
  // the actor's own fresh object.
  await authorize(tx, {
    orgId: input.orgId,
    subjectObjectId: input.actorObjectId,
    permission: "relationship:write",
    scopeObjectId: service.id
  });

  const object = await createObject(tx, {
    orgId: input.orgId,
    typeId: "component",
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    id: input.id,
    urn: input.urn,
    name: input.name,
    domainId: input.domainId,
    properties: input.properties ?? {},
    labels: input.labels
  });

  await createRelationship(tx, {
    orgId: input.orgId,
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    typeId: "contains",
    fromId: service.id,
    toId: object.id
  });

  await insertDecision(tx, {
    orgId: input.orgId,
    kind: "transition",
    subjectId: object.id,
    verdict: "allow",
    inputContext: { trigger: "create-strict", actorId: input.actorObjectId, serviceId: service.id },
    reasonTree: { summary: `component created strictly in service ${service.id}` }
  });

  return object;
}

export interface SetComponentServiceInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  /** id or URN of the component to (re)assign. */
  componentIdOrUrn: string;
  /** id or URN of the service the component should belong to after this call. */
  serviceIdOrUrn: string;
}

export interface SetComponentServiceResult {
  component: GraphObject;
  /** `assigned` — the component had no service; `moved` — re-parented from another service;
   *  `noop` — already in this service (no write, no Decision). */
  outcome: "assigned" | "moved" | "noop";
}

/**
 * Idempotent atomic assign-or-move of a component into a service (M12 P5b, docs/proposals/
 * organize-after.md) — the one verb behind `PUT /components/{idOrUrn}/service`. It sets the
 * component's sole `contains` parent to `serviceIdOrUrn` whether the component currently has NO
 * service (ASSIGN — the 50-orphan homelab case), a DIFFERENT one (MOVE — re-parent), or the SAME
 * one (NOOP). Idempotent-set (not a create-only "assign") is deliberate: bulk-organizing orphans
 * must be safely re-runnable, and the generic `POST /relationships` already covers create-only-409.
 *
 * MOVE is atomic (owner ruling Q6): the old `contains` edge is soft-deleted and the new one created
 * in the SAME transaction, so the RBAC/policy/freeze walks that traverse `contains`
 * (authz/resolve.ts, governance/policy-resolve.ts, graph/containment.ts) never observe the component
 * orphaned — and the migration-0022 partial unique index (which filters `deleted_at IS NULL`)
 * permits the new edge only because the old one is already soft-deleted within this tx. A two-request
 * delete-then-create would momentarily strip the component from every scope; this closes that window.
 *
 * Both-endpoint authority, but WIDER than create-strict: the component PRE-EXISTS (unlike
 * `createComponentInService`'s fresh object), so the actor needs `relationship:write` over the
 * COMPONENT and the NEW service, PLUS the OLD service on a move (it loses a child). Cloning
 * create-strict's service-only check would under-authorize — assign needs 2 scopes, move needs 3.
 * A component whose current `contains` edge is a federation replica cannot be moved locally:
 * `deleteRelationship` refuses to mutate a read-only replicated edge (409), surfaced here unchanged.
 */
export async function setComponentService(
  tx: TenantTx,
  input: SetComponentServiceInput
): Promise<SetComponentServiceResult> {
  const component = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.componentIdOrUrn);
  if (component.typeId !== "component") {
    throw badRequest(`'${input.componentIdOrUrn}' is a '${component.typeId}', not a component`);
  }
  const service = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.serviceIdOrUrn);
  if (service.typeId !== "service") {
    throw badRequest(
      `'${input.serviceIdOrUrn}' is a '${service.typeId}', not a service — a component must belong to a service`
    );
  }

  // The component's current (sole) service edge, if any — the 0022 index guarantees at most one live.
  const current = await listRelationships(tx, input.orgId, {
    typeId: "contains",
    toId: component.id,
    limit: 1
  });
  const currentEdge = current.items[0];

  // Idempotent: already in the target service → no write, no Decision/audit churn.
  if (currentEdge && currentEdge.fromId === service.id) {
    return { component, outcome: "noop" };
  }

  // Both-endpoint authority, checked BEFORE any mutation (fail-closed): the component and the NEW
  // service always; the OLD service too on a move (it loses a child). A Set de-dups if two coincide.
  const scopes = new Set<string>([component.id, service.id]);
  if (currentEdge) scopes.add(currentEdge.fromId);
  for (const scopeObjectId of scopes) {
    await authorize(tx, {
      orgId: input.orgId,
      subjectObjectId: input.actorObjectId,
      permission: "relationship:write",
      scopeObjectId
    });
  }

  // MOVE: soft-delete the old edge FIRST so the new create clears both `assertCardinality` and the
  // 0022 index within this tx (a federation-replica old edge 409s here — correct: it's authoritative
  // elsewhere).
  if (currentEdge) {
    await deleteRelationship(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      requestId: input.requestId,
      id: currentEdge.id
    });
  }

  await createRelationship(tx, {
    orgId: input.orgId,
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    typeId: "contains",
    fromId: service.id,
    toId: component.id
  });

  const outcome: "assigned" | "moved" = currentEdge ? "moved" : "assigned";
  await insertDecision(tx, {
    orgId: input.orgId,
    kind: "transition",
    subjectId: component.id,
    verdict: "allow",
    inputContext: {
      trigger: outcome,
      actorId: input.actorObjectId,
      serviceId: service.id,
      ...(currentEdge ? { fromServiceId: currentEdge.fromId } : {})
    },
    reasonTree: {
      summary: currentEdge
        ? `component ${component.id} moved from service ${currentEdge.fromId} to ${service.id}`
        : `component ${component.id} assigned to service ${service.id}`
    }
  });

  return { component, outcome };
}
