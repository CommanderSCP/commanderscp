import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CreateComponentRequestSchema,
  GraphObjectSchema,
  ObjectListQuerySchema,
  ObjectListResponseSchema,
  MergeComponentsRequestSchema,
  MergeComponentsResponseSchema,
  ProblemSchema,
  RegistryIdOrUrnParamSchema,
  RegistryUrnParamSchema,
  SetComponentServiceRequestSchema,
  UpdateObjectRequestSchema,
  UpsertComponentRequestSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { badRequest } from "../errors.js";
import { withIdempotency } from "../idempotency.js";
import {
  deleteObject,
  getObjectByIdOrUrn,
  listObjects,
  updateObject,
  upsertObjectByUrn
} from "../graph/objects-repo.js";
import { createComponentInService, setComponentService } from "../graph/components-repo.js";
import { mergeComponents } from "../coordination/component-merge-repo.js";

/**
 * Strict `component` routes (M12 P5a, docs/proposals/organize-after.md). `component` is deliberately
 * NOT a `TYPED_REGISTRY_RESOURCES` entry (the shared template's `POST`/`PUT` cannot require a service
 * and write the `contains` edge atomically) and is refused on the generic `/objects/component` route
 * (`objects-generic.ts`'s `assertNotServiceMemberObjectType`). So this is the ONLY route by which a
 * component is created directly, and it requires a service.
 *
 * `POST`/create-branch of `PUT` are strict; `GET`/list/`PATCH`/`DELETE` are byte-for-byte the shared
 * template's behaviour (updating/reading/deleting a component needs no service — re-assignment is
 * P5b's `move` verb). Imports (discovery/accept, federation, overlay) call `createObject` directly,
 * never these routes, so they stay permissive.
 */
export function registerComponentRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const base = "/api/v1/components";
  const idempotencyKey = (request: FastifyRequest): string | undefined => {
    const header = request.headers["idempotency-key"];
    return typeof header === "string" ? header : undefined;
  };

  // POST — strict create: object + `contains` edge + Decision in one tx (createComponentInService).
  typed.route({
    method: "POST",
    url: base,
    schema: {
      body: CreateComponentRequestSchema,
      response: { 201: GraphObjectSchema, 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema, 409: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "createComponent",
        summary: "Create a component in a service (strict — the component and its containment edge are written atomically)",
        tags: ["components"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // object:write at the target domain gates creating the component; createComponentInService
        // additionally requires relationship:write over the service (the containment parent).
        const scopeObjectId = request.body.domainId ?? auth.orgId;
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId
        });
        return withIdempotency(
          tx,
          {
            orgId: auth.orgId,
            idempotencyKey: idempotencyKey(request),
            route: `POST ${base}`,
            requestBody: request.body
          },
          async () => ({
            status: 201 as const,
            body: await createComponentInService(tx, {
              orgId: auth.orgId,
              actorObjectId: auth.subjectObjectId,
              requestId: request.id,
              id: request.body.id,
              urn: request.body.urn,
              name: request.body.name,
              domainId: request.body.domainId,
              properties: request.body.properties,
              labels: request.body.labels,
              serviceIdOrUrn: request.body.service
            })
          })
        );
      });
      reply.status(result.status as 201).send(result.body);
    }
  });

  typed.route({
    method: "GET",
    url: base,
    schema: { querystring: ObjectListQuerySchema, response: { 200: ObjectListResponseSchema, 401: ProblemSchema, 403: ProblemSchema } },
    config: { openapi: { operationId: "listComponents", summary: "List component objects", tags: ["components"] } },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const page = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, { orgId: auth.orgId, subjectObjectId: auth.subjectObjectId, permission: "object:read", scopeObjectId: auth.orgId });
        return listObjects(tx, auth.orgId, "component", request.query);
      });
      reply.status(200).send(page);
    }
  });

  typed.route({
    method: "GET",
    url: `${base}/:idOrUrn`,
    schema: { params: RegistryIdOrUrnParamSchema, response: { 200: GraphObjectSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema } },
    config: { openapi: { operationId: "getComponent", summary: "Get a component by id or URN", tags: ["components"] } },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const object = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getObjectByIdOrUrn(tx, auth.orgId, "component", request.params.idOrUrn);
        await authorize(tx, { orgId: auth.orgId, subjectObjectId: auth.subjectObjectId, permission: "object:read", scopeObjectId: found.id });
        return found;
      });
      reply.status(200).send(object);
    }
  });

  typed.route({
    method: "PATCH",
    url: `${base}/:idOrUrn`,
    schema: { params: RegistryIdOrUrnParamSchema, body: UpdateObjectRequestSchema, response: { 200: GraphObjectSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema, 412: ProblemSchema } },
    config: { openapi: { operationId: "updateComponent", summary: "Partially update a component", tags: ["components"] } },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const object = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getObjectByIdOrUrn(tx, auth.orgId, "component", request.params.idOrUrn);
        await authorize(tx, { orgId: auth.orgId, subjectObjectId: auth.subjectObjectId, permission: "object:write", scopeObjectId: found.id });
        return updateObject(tx, {
          orgId: auth.orgId,
          typeId: "component",
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          idOrUrn: request.params.idOrUrn,
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
    url: `${base}/:idOrUrn`,
    schema: { params: RegistryIdOrUrnParamSchema, response: { 200: GraphObjectSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema } },
    config: { openapi: { operationId: "deleteComponent", summary: "Soft-delete a component", tags: ["components"] } },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const object = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getObjectByIdOrUrn(tx, auth.orgId, "component", request.params.idOrUrn);
        await authorize(tx, { orgId: auth.orgId, subjectObjectId: auth.subjectObjectId, permission: "object:write", scopeObjectId: found.id });
        await deleteObject(tx, { orgId: auth.orgId, typeId: "component", actorObjectId: auth.subjectObjectId, requestId: request.id, idOrUrn: request.params.idOrUrn });
        return getObjectByIdOrUrn(tx, auth.orgId, "component", found.id, { includeDeleted: true });
      });
      reply.status(200).send(object);
    }
  });

  // PUT — strict upsert-by-URN. Create branch requires a service (and writes the edge); update
  // branch is field-only (service optional, ignored — re-assignment is P5b's move verb).
  typed.route({
    method: "PUT",
    url: `${base}/:urn`,
    schema: { params: RegistryUrnParamSchema, body: UpsertComponentRequestSchema, response: { 200: GraphObjectSchema, 201: GraphObjectSchema, 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema, 409: ProblemSchema } },
    config: { openapi: { operationId: "upsertComponentByUrn", summary: "Idempotent upsert-by-URN for a component (create branch requires a service)", tags: ["components"] } },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { urn } = request.params;
      const { object, status } = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const existing = await tx.query.objects.findFirst({
          where: (t, { eq, and }) => and(eq(t.orgId, auth.orgId), eq(t.urn, urn))
        });
        if (!existing) {
          // Create branch — strict: a service is required.
          if (!request.body.service) {
            throw badRequest(`creating component '${urn}' requires a service — a component must belong to a service`);
          }
          const scopeObjectId = request.body.domainId ?? auth.orgId;
          await authorize(tx, { orgId: auth.orgId, subjectObjectId: auth.subjectObjectId, permission: "object:write", scopeObjectId });
          const created = await createComponentInService(tx, {
            orgId: auth.orgId,
            actorObjectId: auth.subjectObjectId,
            requestId: request.id,
            urn,
            id: request.body.id,
            name: request.body.name,
            domainId: request.body.domainId,
            properties: request.body.properties,
            labels: request.body.labels,
            serviceIdOrUrn: request.body.service
          });
          return { object: created, status: 201 as const };
        }
        // Update branch — field-only; the `service` field (if any) is ignored (P5b handles re-assign).
        await authorize(tx, { orgId: auth.orgId, subjectObjectId: auth.subjectObjectId, permission: "object:write", scopeObjectId: existing.id });
        const { object: updated } = await upsertObjectByUrn(tx, {
          orgId: auth.orgId,
          typeId: "component",
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          urn,
          id: request.body.id,
          name: request.body.name,
          domainId: request.body.domainId,
          properties: request.body.properties,
          labels: request.body.labels
        });
        return { object: updated, status: 200 as const };
      });
      reply.status(status).send(object);
    }
  });

  // PUT /components/:idOrUrn/service — idempotent atomic assign-or-move (M12 P5b). Sets the
  // component's sole `contains` parent: assign (no current service), atomic move (different), or
  // no-op (same). `setComponentService` does the both/three-endpoint authz and single-tx swap.
  typed.route({
    method: "PUT",
    url: `${base}/:idOrUrn/service`,
    schema: {
      params: RegistryIdOrUrnParamSchema,
      body: SetComponentServiceRequestSchema,
      response: { 200: GraphObjectSchema, 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema, 409: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "setComponentService",
        summary: "Assign or move a component into a service (idempotent; atomic move — the old and new containment edges swap in one transaction)",
        tags: ["components"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) =>
        setComponentService(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          componentIdOrUrn: request.params.idOrUrn,
          serviceIdOrUrn: request.body.service
        })
      );
      reply.status(200).send(result.component);
    }
  });

  // POST /components/:idOrUrn/merge — driving-case merge (M12 P5d): fold `loser` into this component
  // (the survivor). Moves the loser's executor bindings here and soft-deletes it. `mergeComponents`
  // does the both-endpoint authz, the edge-free / no-in-flight-change guards, and the Q1 binding-
  // type-collision REJECT.
  typed.route({
    method: "POST",
    url: `${base}/:idOrUrn/merge`,
    schema: {
      params: RegistryIdOrUrnParamSchema,
      body: MergeComponentsRequestSchema,
      response: { 200: MergeComponentsResponseSchema, 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema, 409: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "mergeComponents",
        summary: "Merge another (freshly-imported, binding-only) component into this one — moves its executor bindings here and soft-deletes it",
        tags: ["components"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) =>
        mergeComponents(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          survivorIdOrUrn: request.params.idOrUrn,
          loserIdOrUrn: request.body.loser
        })
      );
      reply.status(200).send(result);
    }
  });
}
