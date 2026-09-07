import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CreateObjectRequestSchema,
  GraphObjectSchema,
  ObjectIdOrUrnParamSchema,
  ObjectListQuerySchema,
  ObjectListResponseSchema,
  ObjectTypeParamSchema,
  ObjectUrnParamSchema,
  ProblemSchema,
  PublishObjectResponseSchema,
  UpdateObjectRequestSchema,
  UpsertObjectRequestSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize, type PermissionCheck } from "../authz/resolve.js";
import { authorizeListAndScope } from "../authz/list-scope.js";
import { assertMayDeclareDomainLocal } from "../federation/domain-local.js";
import { publishDomainLocalObject } from "../federation/publish-domain-local.js";
import { forbidden } from "../errors.js";
import { idempotencyKeyOf, withIdempotency } from "../idempotency.js";
import {
  createObject,
  deleteObject,
  getObjectByIdOrUrn,
  listObjects,
  updateObject,
  upsertObjectByUrn
} from "../graph/objects-repo.js";
import { resolveDeclaredContainmentParent } from "../graph/containment-parent-authz.js";
import { containmentDomainIdFromWire, listObjectsQueryFromWire } from "../domain-id-edge.js";
import { isGovernanceManagedObjectType } from "../governance/governance-managed-types.js";
import { isCoordinationTargetScopedObjectType } from "../coordination/campaign-scope-authz.js";
import { isServiceMemberObjectType } from "../graph/service-member-types.js";
import { isPeerBoundObjectType } from "../federation/outpost-binding.js";
import { isPairBoundObjectType } from "../graph/pair-bound-types.js";

/** The message names the typed door per type, not one route. See docs/routes.md §265. */
const GOVERNANCE_MANAGED_TYPED_DOOR: Readonly<Record<string, string>> = {
  policy: "/api/v1/policies",
  control: "/api/v1/controls",
  scan_override_grant: "/api/v1/scan-override-grants",
  freeze: "/api/v1/freezes"
};

/** Governance-owned object types. See docs/routes.md §266. */
function assertNotGovernanceManagedObjectType(type: string): void {
  if (isGovernanceManagedObjectType(type)) {
    throw forbidden(
      `object type '${type}' is governance-managed and cannot be created, updated, or deleted via ` +
        `the generic /api/v1/objects/${type} endpoint — use ` +
        `${GOVERNANCE_MANAGED_TYPED_DOOR[type] ?? "its typed route"}, which enforces 'policy:write' ` +
        `(or, for a freeze, 'freeze:write' plus 'federation:write' to federate it) and the ` +
        `scope-authority binding the generic door cannot check`
    );
  }
}

/** A new authority-scoped object type needs its own door. See docs/routes.md §267. */
function assertNotCoordinationTargetScopedObjectType(type: string): void {
  if (isCoordinationTargetScopedObjectType(type)) {
    throw forbidden(
      `object type '${type}' is coordination-managed and cannot be created, updated, or deleted via ` +
        `the generic /api/v1/objects/${type} endpoint — use its typed route (/api/v1/${type}s), which ` +
        `binds every declared target to the actor's own authority`
    );
  }
}

/** M12 P5a (docs/proposals/organize-after.md). See docs/routes.md §268. */
function assertNotServiceMemberObjectType(type: string): void {
  if (isServiceMemberObjectType(type)) {
    throw forbidden(
      `object type '${type}' must belong to a service and cannot be created, updated, or deleted via ` +
        `the generic /api/v1/objects/${type} endpoint — use the strict typed route (/api/v1/${type}s), ` +
        `which requires a service and writes the containment edge atomically`
    );
  }
}

/** The outpost type carries commander-authored config. See docs/routes.md §269. */
function assertNotPeerBoundObjectType(type: string): void {
  if (isPeerBoundObjectType(type)) {
    throw forbidden(
      `object type '${type}' is commander-authored federation config and cannot be created, updated, ` +
        `or deleted via the generic /api/v1/objects/${type} endpoint — use ` +
        `/api/v1/federation/outposts, which enforces 'federation:write' and the peer binding`
    );
  }
}

/** A placement's identity is a pair of other objects. See docs/routes.md §270. */
function assertNotPairBoundObjectType(type: string): void {
  if (isPairBoundObjectType(type)) {
    throw forbidden(
      `object type '${type}' is identified by a pair of objects and cannot be created, updated, or ` +
        `deleted via the generic /api/v1/objects/${type} endpoint — use /api/v1/${type}s, which ` +
        `requires both endpoints and writes the derived edges atomically`
    );
  }
}

/** Generic `/objects/{type}` endpoints over the full graph model. See docs/routes.md §271. */
export function registerObjectRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/v1/objects/:type",
    schema: {
      params: ObjectTypeParamSchema,
      body: CreateObjectRequestSchema,
      response: {
        201: GraphObjectSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: { operationId: "createObject", summary: "Create a graph object", tags: ["objects"] }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { type } = request.params;
      assertNotGovernanceManagedObjectType(type);
      assertNotCoordinationTargetScopedObjectType(type);
      assertNotServiceMemberObjectType(type);
      assertNotPeerBoundObjectType(type);
      assertNotPairBoundObjectType(type);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // The declared parent, resolved ONCE and used for both the permission scope and the write
        // (`graph/containment-parent-authz.ts` — a wire `null` means the org root, never "detach").
        const declaredParent = await resolveDeclaredContainmentParent(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          // WIRE BOUNDARY (ADR-0021 D4) — see src/domain-id-edge.ts.
          declared: containmentDomainIdFromWire(request.body.domainId),
          current: undefined
        });
        const scopeObjectId = declaredParent;
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: scopeObjectId ?? auth.orgId
        });
        // ADR-0031 — declaring an object domain-local additionally needs `federation:write`.
        await assertMayDeclareDomainLocal(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          scopeObjectId: scopeObjectId ?? auth.orgId,
          requested: request.body.domainLocal
        });
        return withIdempotency(
          tx,
          {
            orgId: auth.orgId,
            idempotencyKey: idempotencyKeyOf(request),
            route: `POST /objects/${type}`,
            requestBody: request.body
          },
          async () => ({
            status: 201,
            body: await createObject(tx, {
              orgId: auth.orgId,
              typeId: type,
              actorObjectId: auth.subjectObjectId,
              requestId: request.id,
              id: request.body.id,
              urn: request.body.urn,
              name: request.body.name,
              domainId: declaredParent,
              properties: request.body.properties,
              labels: request.body.labels,
              domainLocal: request.body.domainLocal
            })
          })
        );
      });
      // `withIdempotency` stores/replays a generic `number` status; this route only ever
      // produces 201 (create), so the literal narrowing here is always accurate.
      reply.status(result.status as 201).send(result.body);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/objects/:type",
    schema: {
      params: ObjectTypeParamSchema,
      querystring: ObjectListQuerySchema,
      response: { 200: ObjectListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listObjects",
        summary: "List graph objects of a type",
        tags: ["objects"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { type } = request.params;
      const page = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // ONE check object for BOTH the gate and the row filter. See docs/routes.md §272.
        const check: PermissionCheck = {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        };
        const readable = await authorizeListAndScope(tx, check);
        return listObjects(tx, auth.orgId, type, listObjectsQueryFromWire(request.query), readable);
      });
      reply.status(200).send(page);
    }
  });

  /** M20.4 (ADR-0031 §6) — publish a domain-local object. See docs/routes.md §273. */
  typed.route({
    method: "POST",
    url: "/api/v1/objects/:type/:idOrUrn/publish",
    schema: {
      params: ObjectIdOrUrnParamSchema,
      response: {
        200: PublishObjectResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "publishDomainLocalObject",
        summary: "Publish a domain-local object so it federates from now on (one-way)",
        tags: ["objects"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { type, idOrUrn } = request.params;
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const existing = await getObjectByIdOrUrn(tx, auth.orgId, type, idOrUrn);
        // ADDED, NEVER SUBSTITUTED. See docs/routes.md §274.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: existing.id
        });
        // `federation:write`, matching the permission that DECLARED locality in the first place
        // (ADR-0031 §1) — undoing a boundary decision cannot be cheaper than making it. Scoped to
        // the object itself, like every other operation on an existing object in this router.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:write",
          scopeObjectId: existing.id
        });
        return publishDomainLocalObject(tx, {
          orgId: auth.orgId,
          typeId: type,
          idOrUrn,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id
        });
      });
      reply.status(200).send(result);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/objects/:type/:idOrUrn",
    schema: {
      params: ObjectIdOrUrnParamSchema,
      response: {
        200: GraphObjectSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getObject",
        summary: "Get a graph object by id or URN",
        tags: ["objects"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { type, idOrUrn } = request.params;
      const object = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getObjectByIdOrUrn(tx, auth.orgId, type, idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: found.id
        });
        return found;
      });
      reply.status(200).send(object);
    }
  });

  typed.route({
    method: "PATCH",
    url: "/api/v1/objects/:type/:idOrUrn",
    schema: {
      params: ObjectIdOrUrnParamSchema,
      body: UpdateObjectRequestSchema,
      response: {
        200: GraphObjectSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        412: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "updateObject",
        summary: "Partially update a graph object",
        tags: ["objects"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { type, idOrUrn } = request.params;
      assertNotGovernanceManagedObjectType(type);
      assertNotCoordinationTargetScopedObjectType(type);
      assertNotServiceMemberObjectType(type);
      assertNotPeerBoundObjectType(type);
      assertNotPairBoundObjectType(type);
      const object = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getObjectByIdOrUrn(tx, auth.orgId, type, idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: found.id
        });
        // A MOVE is a write at two places — the check above covered the object, this one covers
        // where it is going (`graph/containment-parent-authz.ts`).
        const declaredParent = await resolveDeclaredContainmentParent(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          declared: containmentDomainIdFromWire(request.body.domainId),
          current: found
        });
        return updateObject(tx, {
          orgId: auth.orgId,
          typeId: type,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          idOrUrn,
          name: request.body.name,
          domainId: declaredParent,
          properties: request.body.properties,
          labels: request.body.labels,
          expectedVersion: request.body.version
        });
      });
      reply.status(200).send(object);
    }
  });

  typed.route({
    method: "DELETE",
    url: "/api/v1/objects/:type/:idOrUrn",
    schema: {
      params: ObjectIdOrUrnParamSchema,
      response: {
        200: GraphObjectSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        // THE ADMINISTRATOR FLOOR. See docs/routes.md §275.
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "deleteObject",
        summary: "Soft-delete a graph object",
        tags: ["objects"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { type, idOrUrn } = request.params;
      assertNotGovernanceManagedObjectType(type);
      assertNotCoordinationTargetScopedObjectType(type);
      assertNotServiceMemberObjectType(type);
      assertNotPeerBoundObjectType(type);
      assertNotPairBoundObjectType(type);
      const object = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getObjectByIdOrUrn(tx, auth.orgId, type, idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: found.id
        });
        await deleteObject(tx, {
          orgId: auth.orgId,
          typeId: type,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          idOrUrn
        });
        return getObjectByIdOrUrn(tx, auth.orgId, type, found.id, { includeDeleted: true });
      });
      reply.status(200).send(object);
    }
  });

  typed.route({
    method: "PUT",
    url: "/api/v1/objects/:type/:urn",
    schema: {
      params: ObjectUrnParamSchema,
      body: UpsertObjectRequestSchema,
      response: {
        200: GraphObjectSchema,
        201: GraphObjectSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "upsertObjectByUrn",
        summary: "Idempotent upsert-by-URN",
        tags: ["objects"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { type, urn } = request.params;
      assertNotGovernanceManagedObjectType(type);
      assertNotCoordinationTargetScopedObjectType(type);
      assertNotServiceMemberObjectType(type);
      assertNotPeerBoundObjectType(type);
      assertNotPairBoundObjectType(type);
      const { object, created } = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const existing = await tx.query.objects.findFirst({
          where: (t, { eq, and }) => and(eq(t.orgId, auth.orgId), eq(t.urn, urn))
        });
        // On the CREATE branch the declared parent is the only scope there is; on the UPDATE branch
        // the object is the scope and the declared parent is separately authorized as a move
        // (`graph/containment-parent-authz.ts`).
        const declaredParent = await resolveDeclaredContainmentParent(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          declared: containmentDomainIdFromWire(request.body.domainId),
          current: existing
        });
        const scopeObjectId = existing ? existing.id : (declaredParent ?? auth.orgId);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId
        });
        // ADR-0031 — gated on the DECLARED value, so it fires on the create branch (a real
        // declaration) and equally on an update branch that would be refused as a locality flip;
        // an unauthorized caller learns "forbidden" rather than probing the row's locality via the
        // shape of a 409.
        await assertMayDeclareDomainLocal(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          scopeObjectId,
          requested: request.body.domainLocal
        });
        return upsertObjectByUrn(tx, {
          orgId: auth.orgId,
          typeId: type,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          urn,
          id: request.body.id,
          name: request.body.name,
          domainId: declaredParent,
          properties: request.body.properties,
          labels: request.body.labels,
          domainLocal: request.body.domainLocal
        });
      });
      reply.status(created ? 201 : 200).send(object);
    }
  });
}
