import type { FastifyInstance, FastifyRequest } from "fastify";
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
  UpdateObjectRequestSchema,
  UpsertObjectRequestSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { forbidden } from "../errors.js";
import { withIdempotency } from "../idempotency.js";
import {
  createObject,
  deleteObject,
  getObjectByIdOrUrn,
  listObjects,
  resolveDomainId,
  updateObject,
  upsertObjectByUrn
} from "../graph/objects-repo.js";
import { isGovernanceManagedObjectType } from "../governance/governance-managed-types.js";
import { isCoordinationTargetScopedObjectType } from "../coordination/campaign-scope-authz.js";

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  return typeof header === "string" ? header : undefined;
}

/**
 * Governance-owned object types (`policy`, `control`) are refused here entirely — mirrors
 * `assertNotSystemManagedRelationship` (routes/relationships.ts) blocking `approves` edges from
 * the generic `/relationships` endpoint. Without this, the generic `/objects/{type}` endpoints
 * created/updated the SAME `policy`/`control` graph objects the typed `/policies`/`/controls`
 * routes do (routes/typed-registries.ts), but checked only generic `object:write` — skipping both
 * the `policy:write` permission gate AND `assertPolicyScopeWithinAuthority`'s binding of a
 * policy's DECLARED scope to the author's own authority (CRITICAL #1b). That gap let a
 * component-scoped Administrator publish an org-wide policy through this endpoint, and let ANY
 * actor holding bare `object:write` (e.g. an Operator with zero `policy:write` anywhere) create an
 * org-wide `required` policy demanding an unreachable approval quorum — a live governance-bypass
 * DoS. Checked before the transaction even opens: no DB round trip is needed to reject a request
 * this endpoint will never legitimately serve.
 */
function assertNotGovernanceManagedObjectType(type: string): void {
  if (isGovernanceManagedObjectType(type)) {
    throw forbidden(
      `object type '${type}' is governance-managed and cannot be created, updated, or deleted via ` +
        `the generic /api/v1/objects/${type} endpoint — use /api/v1/policies or /api/v1/controls, ` +
        `which enforce 'policy:write' and (for policies) the scope-authority binding`
    );
  }
}

/**
 * M5 (BUILD_AND_TEST.md §8 M5 security note — "if a new authority-scoped object type is
 * introduced, it needs the governance-managed-types treatment"): `campaign` binds its DECLARED
 * `properties.targets` to the actor's own authority (`coordination/campaign-scope-authz.ts`),
 * exactly the same class of risk `policy.properties.scope` has — so it gets the exact same
 * generic-endpoint block, forcing every caller through `POST /campaigns`
 * (`coordination/campaign-repo.ts`'s `proposeCampaign`), which performs that check per target.
 * A SEPARATE set from `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS` on purpose: campaign writes still only
 * need plain `object:write`, never `policy:write` — this is a distinct authority model, not the
 * governance subsystem's.
 */
function assertNotCoordinationTargetScopedObjectType(type: string): void {
  if (isCoordinationTargetScopedObjectType(type)) {
    throw forbidden(
      `object type '${type}' is coordination-managed and cannot be created, updated, or deleted via ` +
        `the generic /api/v1/objects/${type} endpoint — use its typed route (/api/v1/${type}s), which ` +
        `binds every declared target to the actor's own authority`
    );
  }
}

/**
 * Generic `/objects/{type}` endpoints over the full graph model (DESIGN.md §4.1, §6) — works for
 * ANY registered object type, built-in or org-defined via the type registry, with no special
 * casing (BUILD_AND_TEST.md §8 M1 DoD (b)) EXCEPT the governance-owned `policy`/`control` types,
 * which every write verb below refuses outright (`assertNotGovernanceManagedObjectType` — security
 * fast-follow after PR #9). `PUT .../{urn}` is the idempotent upsert-by-URN path; every `POST`
 * accepts `Idempotency-Key` for replay-safe retries.
 *
 * Scope decision (documented): list operations check `object:read` at the org-root scope
 * (listing spans arbitrary containment, so a single finer-grained scope isn't meaningful without
 * per-row ReBAC filtering — an M2+ concern); every other operation checks at the specific
 * object's own scope (existing objects) or its resolved containing domain (new objects), so
 * `authz/resolve.ts`'s containment walk is exercised precisely.
 */
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
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const scopeObjectId = await resolveDomainId(
          tx,
          auth.orgId,
          request.body.domainId ?? undefined
        );
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: scopeObjectId ?? auth.orgId
        });
        return withIdempotency(
          tx,
          {
            orgId: auth.orgId,
            idempotencyKey: idempotencyKey(request),
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
              domainId: request.body.domainId ?? undefined,
              properties: request.body.properties,
              labels: request.body.labels
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
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        return listObjects(tx, auth.orgId, type, request.query);
      });
      reply.status(200).send(page);
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
      const object = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getObjectByIdOrUrn(tx, auth.orgId, type, idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: found.id
        });
        return updateObject(tx, {
          orgId: auth.orgId,
          typeId: type,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          idOrUrn,
          name: request.body.name,
          domainId: request.body.domainId,
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
        404: ProblemSchema
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
      const { object, created } = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const existing = await tx.query.objects.findFirst({
          where: (t, { eq, and }) => and(eq(t.orgId, auth.orgId), eq(t.urn, urn))
        });
        const scopeObjectId = existing
          ? existing.id
          : ((await resolveDomainId(tx, auth.orgId, request.body.domainId ?? undefined)) ??
            auth.orgId);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId
        });
        return upsertObjectByUrn(tx, {
          orgId: auth.orgId,
          typeId: type,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          urn,
          id: request.body.id,
          name: request.body.name,
          domainId: request.body.domainId,
          properties: request.body.properties,
          labels: request.body.labels
        });
      });
      reply.status(created ? 201 : 200).send(object);
    }
  });
}
