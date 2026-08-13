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
  PublishObjectResponseSchema,
  UpdateObjectRequestSchema,
  UpsertObjectRequestSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { assertMayDeclareDomainLocal } from "../federation/domain-local.js";
import { publishDomainLocalObject } from "../federation/publish-domain-local.js";
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
import { containmentDomainIdFromWire, listObjectsQueryFromWire } from "../domain-id-edge.js";
import { isGovernanceManagedObjectType } from "../governance/governance-managed-types.js";
import { isCoordinationTargetScopedObjectType } from "../coordination/campaign-scope-authz.js";
import { isServiceMemberObjectType } from "../graph/service-member-types.js";
import { isPeerBoundObjectType } from "../federation/outpost-binding.js";
import { isPairBoundObjectType } from "../graph/pair-bound-types.js";

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
 * M12 P5a (docs/proposals/organize-after.md): `component` binds its MEMBERSHIP — a directly-created
 * component must belong to a service. That invariant can only be enforced by a create path that
 * takes the service inline and writes the `contains` edge atomically, so `component` is refused on
 * the generic route (all write verbs), forcing creates through the strict `POST /components`
 * (`graph/components-repo.ts`'s `createComponentInService`).
 *
 * A SEPARATE set from `COORDINATION_TARGET_SCOPED_OBJECT_TYPE_IDS` ON PURPOSE — that set's meaning is
 * target-AUTHORITY binding; a component's reason is service-MEMBERSHIP. Conflating them would be
 * exactly the kind of comment-that-lies this codebase already has too many of. The true IMPORT paths
 * (discovery/accept, federation-journal replay) call `createObject` directly and never touch a create
 * ROUTE, so they stay permissive by construction — the owner ruling. The `SERVICE_MEMBER_OBJECT_TYPE_IDS`
 * set now lives in `graph/service-member-types.ts` so this guard and the federation OVERLAY route
 * (`federation/overlay-repo.ts`) — a user-facing create surface, NOT an import path — agree (owner
 * ruling 2026-07-16: overlay refuses component too).
 */
function assertNotServiceMemberObjectType(type: string): void {
  if (isServiceMemberObjectType(type)) {
    throw forbidden(
      `object type '${type}' must belong to a service and cannot be created, updated, or deleted via ` +
        `the generic /api/v1/objects/${type} endpoint — use the strict typed route (/api/v1/${type}s), ` +
        `which requires a service and writes the containment edge atomically`
    );
  }
}

/**
 * M16.2 phase A (E1): the `outpost` type carries COMMANDER-AUTHORED federation config, so its writes
 * are gated on `federation:write`, not plain `object:write`. This endpoint checks only the latter —
 * the same permission-mismatch shape that let a bare-`object:write` actor publish governance objects
 * through here (see `assertNotGovernanceManagedObjectType`) — so the type is refused outright and
 * callers go through `/api/v1/federation/outposts`.
 *
 * The 1:1 peer BINDING is NOT enforced by this refusal: it is enforced inside `graph/objects-repo.ts`
 * for every local write door at once (`federation/outpost-binding.ts` explains why one choke point
 * rather than N route guards). This block is purely about the permission gate.
 */
function assertNotPeerBoundObjectType(type: string): void {
  if (isPeerBoundObjectType(type)) {
    throw forbidden(
      `object type '${type}' is commander-authored federation config and cannot be created, updated, ` +
        `or deleted via the generic /api/v1/objects/${type} endpoint — use ` +
        `/api/v1/federation/outposts, which enforces 'federation:write' and the peer binding`
    );
  }
}

/**
 * ADR-0026 D2/D3 (owner decision D17): a `placement`'s identity IS a pair of other objects, so it
 * cannot be created through a door that takes free-form `properties`. This route would store two
 * UUIDs without resolving them, without checking they name a `component` and a `deployment-target`,
 * and — decisively — without writing the two derived edges that make the pair traversable, leaving
 * an island invisible to every impact query. Refused outright; callers go through
 * `/api/v1/placements`. See `graph/pair-bound-types.ts` for why this is a separate set from the
 * service-membership one rather than a merged "special types" list.
 */
function assertNotPairBoundObjectType(type: string): void {
  if (isPairBoundObjectType(type)) {
    throw forbidden(
      `object type '${type}' is identified by a pair of objects and cannot be created, updated, or ` +
        `deleted via the generic /api/v1/objects/${type} endpoint — use /api/v1/${type}s, which ` +
        `requires both endpoints and writes the derived edges atomically`
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
      assertNotServiceMemberObjectType(type);
      assertNotPeerBoundObjectType(type);
      assertNotPairBoundObjectType(type);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const scopeObjectId = await resolveDomainId(
          tx,
          auth.orgId,
          // WIRE BOUNDARY (ADR-0021 D4) — see src/domain-id-edge.ts.
          containmentDomainIdFromWire(request.body.domainId) ?? undefined
        );
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
              domainId: containmentDomainIdFromWire(request.body.domainId) ?? undefined,
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
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        return listObjects(tx, auth.orgId, type, listObjectsQueryFromWire(request.query));
      });
      reply.status(200).send(page);
    }
  });

  /**
   * M20.4 (ADR-0031 §6) — publish a domain-local object.
   *
   * A VERB, not a `PATCH` of `domainLocal`, and the distinction is deliberate: this re-journals the
   * object's current full state and sweeps its edges, so it is an action with an effect rather than a
   * field edit that quietly emits a stream of entries. `PATCH` still cannot express locality at all,
   * which is what keeps the column immutable everywhere except here.
   *
   * ONE-WAY. There is no un-publish route and there will not be one — federation has no un-send.
   */
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
        return updateObject(tx, {
          orgId: auth.orgId,
          typeId: type,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          idOrUrn,
          name: request.body.name,
          domainId: containmentDomainIdFromWire(request.body.domainId),
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
        const scopeObjectId = existing
          ? existing.id
          : ((await resolveDomainId(
              tx,
              auth.orgId,
              containmentDomainIdFromWire(request.body.domainId) ?? undefined
            )) ?? auth.orgId);
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
          domainId: containmentDomainIdFromWire(request.body.domainId),
          properties: request.body.properties,
          labels: request.body.labels,
          domainLocal: request.body.domainLocal
        });
      });
      reply.status(created ? 201 : 200).send(object);
    }
  });
}
