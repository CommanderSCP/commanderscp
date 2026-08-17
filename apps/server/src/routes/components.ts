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
  ComponentPipelineResponseSchema,
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
import { assertMayDeclareDomainLocal } from "../federation/domain-local.js";
import { getComponentPipeline } from "../coordination/component-pipeline.js";
import { badRequest } from "../errors.js";
import { withIdempotency } from "../idempotency.js";
import {
  deleteObject,
  getObjectByIdOrUrn,
  listObjects,
  updateObject,
  upsertObjectByUrn
} from "../graph/objects-repo.js";
import { containmentDomainIdFromWire, listObjectsQueryFromWire } from "../domain-id-edge.js";
import { resolveDeclaredContainmentParent } from "../graph/containment-parent-authz.js";
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

  // GET /components/:idOrUrn/pipeline — THE COMPONENT'S PIPELINE (coordination-ui-views.md §2, as
  // corrected 2026-08-03). One projection of the component's STAGES — its placements — with what
  // executes at each and what last released there.
  //
  // The point of the correction: this is well-defined for a component with nothing in flight. The
  // surface it replaces was keyed on a change, so a stable component had no pipeline at all. An
  // extra `/pipeline` segment, so it never collides with the registry's `/:idOrUrn` detail route —
  // same shape as `/services/:idOrUrn/board`.
  typed.route({
    method: "GET",
    url: "/api/v1/components/:idOrUrn/pipeline",
    schema: {
      params: RegistryIdOrUrnParamSchema,
      response: {
        200: ComponentPipelineResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getComponentPipeline",
        summary:
          "The component's pipeline — its stages (placements), what executes at each, and what last released there",
        tags: ["components"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const pipeline = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const component = await getObjectByIdOrUrn(
          tx,
          auth.orgId,
          "component",
          request.params.idOrUrn
        );
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: component.id
        });
        return getComponentPipeline(tx, auth.orgId, component, auth.subjectObjectId);
      });
      reply.status(200).send(pipeline);
    }
  });
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
      response: {
        201: GraphObjectSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "createComponent",
        summary:
          "Create a component in a service (strict — the component and its containment edge are written atomically)",
        tags: ["components"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // object:write at the target domain gates creating the component; createComponentInService
        // additionally requires relationship:write over the service (the containment parent).
        // The declared parent is resolved ONCE here (`graph/containment-parent-authz.ts`) and used
        // for both the scope and the write — a wire `null` means the org root, never "detach".
        const declaredParent = await resolveDeclaredContainmentParent(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          declared: containmentDomainIdFromWire(request.body.domainId),
          current: undefined
        });
        const scopeObjectId = declaredParent ?? auth.orgId;
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId
        });
        // ADR-0031 — this door inherits `domainLocal` because CreateComponentRequestSchema EXTENDS
        // CreateObjectRequestSchema. Threading it here (rather than letting it be silently dropped)
        // is the reason the census covers all six doors and not just the generic two.
        await assertMayDeclareDomainLocal(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          scopeObjectId,
          requested: request.body.domainLocal
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
              domainId: declaredParent,
              properties: request.body.properties,
              labels: request.body.labels,
              serviceIdOrUrn: request.body.service,
              domainLocal: request.body.domainLocal
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
    schema: {
      querystring: ObjectListQuerySchema,
      response: { 200: ObjectListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listComponents",
        summary: "List component objects",
        tags: ["components"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const page = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        return listObjects(tx, auth.orgId, "component", listObjectsQueryFromWire(request.query));
      });
      reply.status(200).send(page);
    }
  });

  typed.route({
    method: "GET",
    url: `${base}/:idOrUrn`,
    schema: {
      params: RegistryIdOrUrnParamSchema,
      response: {
        200: GraphObjectSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getComponent",
        summary: "Get a component by id or URN",
        tags: ["components"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const object = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getObjectByIdOrUrn(tx, auth.orgId, "component", request.params.idOrUrn);
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
    url: `${base}/:idOrUrn`,
    schema: {
      params: RegistryIdOrUrnParamSchema,
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
        operationId: "updateComponent",
        summary: "Partially update a component",
        tags: ["components"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const object = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getObjectByIdOrUrn(tx, auth.orgId, "component", request.params.idOrUrn);
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
          typeId: "component",
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          idOrUrn: request.params.idOrUrn,
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
    url: `${base}/:idOrUrn`,
    schema: {
      params: RegistryIdOrUrnParamSchema,
      response: {
        200: GraphObjectSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "deleteComponent",
        summary: "Soft-delete a component",
        tags: ["components"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const object = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getObjectByIdOrUrn(tx, auth.orgId, "component", request.params.idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: found.id
        });
        await deleteObject(tx, {
          orgId: auth.orgId,
          typeId: "component",
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          idOrUrn: request.params.idOrUrn
        });
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
    schema: {
      params: RegistryUrnParamSchema,
      body: UpsertComponentRequestSchema,
      response: {
        200: GraphObjectSchema,
        201: GraphObjectSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "upsertComponentByUrn",
        summary: "Idempotent upsert-by-URN for a component (create branch requires a service)",
        tags: ["components"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { urn } = request.params;
      const { object, status } = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const existing = await tx.query.objects.findFirst({
          where: (t, { eq, and }) => and(eq(t.orgId, auth.orgId), eq(t.urn, urn))
        });
        // Both branches, one resolution (`graph/containment-parent-authz.ts`): on the CREATE branch
        // the declared parent is the only scope there is, and on the UPDATE branch it is separately
        // authorized as a move. A wire `null` means the org root either way, never "detach".
        const declaredParent = await resolveDeclaredContainmentParent(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          declared: containmentDomainIdFromWire(request.body.domainId),
          current: existing
        });
        if (!existing) {
          // Create branch — strict: a service is required.
          if (!request.body.service) {
            throw badRequest(
              `creating component '${urn}' requires a service — a component must belong to a service`
            );
          }
          const scopeObjectId = declaredParent ?? auth.orgId;
          await authorize(tx, {
            orgId: auth.orgId,
            subjectObjectId: auth.subjectObjectId,
            permission: "object:write",
            scopeObjectId
          });
          // ADR-0031 — the CREATE branch: a real declaration, so it needs `federation:write`.
          await assertMayDeclareDomainLocal(tx, {
            orgId: auth.orgId,
            subjectObjectId: auth.subjectObjectId,
            scopeObjectId,
            requested: request.body.domainLocal
          });
          const created = await createComponentInService(tx, {
            orgId: auth.orgId,
            actorObjectId: auth.subjectObjectId,
            requestId: request.id,
            urn,
            id: request.body.id,
            name: request.body.name,
            domainId: declaredParent,
            properties: request.body.properties,
            labels: request.body.labels,
            serviceIdOrUrn: request.body.service,
            domainLocal: request.body.domainLocal
          });
          return { object: created, status: 201 as const };
        }
        // Update branch — field-only; the `service` field (if any) is ignored (P5b handles re-assign).
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: existing.id
        });
        // ADR-0031 — the UPDATE branch: `domainLocal` is a precondition here, never a write
        // (`assertDomainLocalUnchanged`). Authorized on the DECLARED value all the same, so an
        // unauthorized caller gets 403 rather than learning the row's locality from a 409's shape.
        await assertMayDeclareDomainLocal(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          scopeObjectId: existing.id,
          requested: request.body.domainLocal
        });
        const { object: updated } = await upsertObjectByUrn(tx, {
          orgId: auth.orgId,
          typeId: "component",
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
      response: {
        200: GraphObjectSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "setComponentService",
        summary:
          "Assign or move a component into a service (idempotent; atomic move — the old and new containment edges swap in one transaction)",
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
      response: {
        200: MergeComponentsResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "mergeComponents",
        summary:
          "Merge another (freshly-imported, binding-only) component into this one — moves its executor bindings here and soft-deletes it",
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
