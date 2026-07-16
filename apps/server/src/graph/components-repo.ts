import type { GraphObject } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { createObject, getObjectByIdOrUrnAnyType } from "./objects-repo.js";
import { createRelationship } from "./relationships-repo.js";
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
