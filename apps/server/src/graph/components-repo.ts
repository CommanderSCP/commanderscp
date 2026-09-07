import type { ContainmentDomainId, GraphObject } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { createObject, getObjectByIdOrUrnAnyType } from "./objects-repo.js";
import { isContainerType } from "./containment.js";
import { createRelationship, deleteRelationship, listRelationships } from "./relationships-repo.js";
import { authorize } from "../authz/resolve.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { assertGovernanceMoveAdmits } from "../governance/move-enforcement.js";
import { badRequest } from "../errors.js";

export interface CreateComponentInServiceInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  id?: string;
  urn?: string;
  name: string;
  /** CONTAINMENT sense (ADR-0021 D4). */
  domainId?: ContainmentDomainId | null;
  properties?: Record<string, unknown>;
  labels?: Record<string, unknown>;
  /** id or URN of the service this component must belong to (the `contains` parent). */
  serviceIdOrUrn: string;
  /** M20.1 (ADR-0031 §1) — declare that this component never federates. Threaded to `createObject`,
   *  which is the sole writer of the column; authorization for the declaration is at the route. */
  domainLocal?: boolean;
}

/** Strict component create. See docs/graph.md §15. */
export async function createComponentInService(
  tx: TenantTx,
  input: CreateComponentInServiceInput
): Promise<GraphObject> {
  // Resolve and type-check the service FIRST — a bad or wrong-type ref fails before any write.
  const service = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.serviceIdOrUrn);
  // A component's parent may be a service OR an assembly (migration 0055) — the optional level
  // between them. Routed through `isContainerType` rather than compared here, so adding a level is a
  // change to ONE constant instead of a search for every site that spelled out "service".
  if (!isContainerType(service.typeId)) {
    throw badRequest(
      `'${input.serviceIdOrUrn}' is a '${service.typeId}' — a component must belong to a service or an assembly`
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
    labels: input.labels,
    // M20.5 (ADR-0031 §6a) — THE SECOND CONTAINMENT ROUTE. See docs/graph.md §16.
    domainLocal: input.domainLocal,
    ...(service.domainLocal
      ? { domainLocalInheritedFrom: { id: service.id, urn: service.urn } }
      : {})
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

/** Idempotent atomic assign-or-move of a component into a service. See docs/graph.md §17. */
export async function setComponentService(
  tx: TenantTx,
  input: SetComponentServiceInput
): Promise<SetComponentServiceResult> {
  const component = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.componentIdOrUrn);
  if (component.typeId !== "component") {
    throw badRequest(`'${input.componentIdOrUrn}' is a '${component.typeId}', not a component`);
  }
  const service = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.serviceIdOrUrn);
  // A component's parent may be a service OR an assembly (migration 0055) — the optional level
  // between them. Routed through `isContainerType` rather than compared here, so adding a level is a
  // change to ONE constant instead of a search for every site that spelled out "service".
  if (!isContainerType(service.typeId)) {
    throw badRequest(
      `'${input.serviceIdOrUrn}' is a '${service.typeId}' — a component must belong to a service or an assembly`
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

  // THE SECOND, OPT-IN BAR. See docs/graph.md §18.
  await assertGovernanceMoveAdmits(tx, {
    orgId: input.orgId,
    subjectObjectId: input.actorObjectId,
    movedObjectId: component.id,
    destinationObjectId: service.id,
    permissionSetForExplain: "relationship:write"
  });

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
