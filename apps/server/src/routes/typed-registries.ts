import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  CreateObjectRequestSchema,
  GraphObjectSchema,
  ObjectListQuerySchema,
  ObjectListResponseSchema,
  ProblemSchema,
  RegistryIdOrUrnParamSchema,
  RegistryUrnParamSchema,
  UpdateObjectRequestSchema,
  UpsertObjectRequestSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize, type Permission, type PermissionCheck } from "../authz/resolve.js";
import { authorizeListAndScope } from "../authz/list-scope.js";
import { assertMayDeclareDomainLocal } from "../federation/domain-local.js";
import { withIdempotency } from "../idempotency.js";
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
import { assertPolicyScopeWithinAuthority } from "../governance/policy-scope-authz.js";

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  return typeof header === "string" ? header : undefined;
}

export interface TypedRegistryConfig {
  /** Fixed `object_types.id` this resource maps to (e.g. 'domain', 'service-account'). */
  typeId: string;
  /** Mount path segment, e.g. 'domains' -> `/api/v1/domains`. */
  basePath: string;
  /** Singular PascalCase resource name driving operationIds, e.g. 'Domain', 'ServiceAccount'. */
  resourceName: string;
  /** Plural naming for the list operation, when adding s fails. See docs/routes.md §417. */
  pluralResourceName?: string;
  /** M4: policies/controls gate writes behind their own permission ('policy:write') rather than
   *  the generic 'object:write' every other typed resource uses (DESIGN §7's example role
   *  bindings name 'policy:write' explicitly) — defaults to 'object:write'/'object:read' so every
   *  pre-M4 resource is unaffected. */
  writePermission?: Permission;
  readPermission?: Permission;
  /** Extra write-time validation beyond the generic `writePermission` check (adversarial review
   *  CRITICAL #1b): for `policy`, binds the DECLARED `properties.scope` to the actor's own
   *  authority so a component-scoped author can't publish an org-wide policy. Called inside the
   *  write tx (POST/PATCH-with-properties/PUT) after the permission check; throws to reject. */
  validateWrite?: (
    tx: TenantTx,
    args: { orgId: string; actorObjectId: string; properties: Record<string, unknown> | undefined }
  ) => Promise<void>;
}

/** The 8 typed convenience resources this milestone adds. See docs/routes.md §418. */
export const TYPED_REGISTRY_RESOURCES: TypedRegistryConfig[] = [
  { typeId: "domain", basePath: "domains", resourceName: "Domain" },
  { typeId: "service", basePath: "services", resourceName: "Service" },
  // The OPTIONAL level between a service and its components. See docs/routes.md §419.
  {
    typeId: "assembly",
    basePath: "assemblies",
    resourceName: "Assembly",
    pluralResourceName: "Assemblies"
  },
  { typeId: "deployment-target", basePath: "deployment-targets", resourceName: "DeploymentTarget" },
  { typeId: "team", basePath: "teams", resourceName: "Team" },
  { typeId: "group", basePath: "groups", resourceName: "Group" },
  { typeId: "user", basePath: "users", resourceName: "User" },
  { typeId: "service-account", basePath: "service-accounts", resourceName: "ServiceAccount" }
];

/** M4 governance resources (BUILD_AND_TEST.md §8 M4 item 1/2). See docs/routes.md §420. */
export const GOVERNANCE_TYPED_REGISTRY_RESOURCES: TypedRegistryConfig[] = [
  {
    typeId: "policy",
    basePath: "policies",
    resourceName: "Policy",
    writePermission: "policy:write",
    // Bind the policy's declared scope to the author's authority. See docs/routes.md §421.
    validateWrite: async (tx, args) => {
      await assertPolicyScopeWithinAuthority(tx, args);
    }
  },
  {
    typeId: "control",
    basePath: "controls",
    resourceName: "Control",
    writePermission: "policy:write"
  }
];

/** M2 typed convenience endpoints. See docs/routes.md §422. */
export function registerTypedRegistryRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  config: TypedRegistryConfig
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const { typeId, basePath, resourceName } = config;
  const writePermission: Permission = config.writePermission ?? "object:write";
  const readPermission: Permission = config.readPermission ?? "object:read";
  const base = `/api/v1/${basePath}`;
  const label = basePath.replace(/-/g, " ");

  typed.route({
    method: "POST",
    url: base,
    schema: {
      body: CreateObjectRequestSchema,
      response: {
        201: GraphObjectSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: `create${resourceName}`,
        summary: `Create a ${label} object`,
        tags: [basePath]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // The declared parent, resolved ONCE and used for both the permission scope and the write
        // (`graph/containment-parent-authz.ts` — a wire `null` means the org root, never "detach").
        const declaredParent = await resolveDeclaredContainmentParent(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: writePermission,
          // WIRE BOUNDARY (ADR-0021 D4) — see src/domain-id-edge.ts.
          declared: containmentDomainIdFromWire(request.body.domainId),
          current: undefined
        });
        const scopeObjectId = declaredParent;
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: writePermission,
          scopeObjectId: scopeObjectId ?? auth.orgId
        });
        // ADR-0031 — every typed registry route is generated from this one factory, so a single
        // call here covers all of them (assemblies, domains, services, …) rather than one per type.
        await assertMayDeclareDomainLocal(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          scopeObjectId: scopeObjectId ?? auth.orgId,
          requested: request.body.domainLocal
        });
        await config.validateWrite?.(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          properties: request.body.properties
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
            status: 201,
            body: await createObject(tx, {
              orgId: auth.orgId,
              typeId,
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
    url: base,
    schema: {
      querystring: ObjectListQuerySchema,
      response: { 200: ObjectListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: `list${config.pluralResourceName ?? `${resourceName}s`}`,
        summary: `List ${label} objects`,
        tags: [basePath]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const page = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // The shared factory behind every typed registry. See docs/routes.md §423.
        const check: PermissionCheck = {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: readPermission,
          scopeObjectId: auth.orgId
        };
        const readable = await authorizeListAndScope(tx, check);
        return listObjects(
          tx,
          auth.orgId,
          typeId,
          listObjectsQueryFromWire(request.query),
          readable
        );
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
        operationId: `get${resourceName}`,
        summary: `Get a ${label} object by id or URN`,
        tags: [basePath]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { idOrUrn } = request.params;
      const object = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getObjectByIdOrUrn(tx, auth.orgId, typeId, idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: readPermission,
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
        operationId: `update${resourceName}`,
        summary: `Partially update a ${label} object`,
        tags: [basePath]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { idOrUrn } = request.params;
      const object = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getObjectByIdOrUrn(tx, auth.orgId, typeId, idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: writePermission,
          scopeObjectId: found.id
        });
        // Only re-validate scope authority when this PATCH actually replaces `properties`
        // (updateObject replaces wholesale when provided); a PATCH that omits properties leaves
        // the already-validated scope untouched.
        if (request.body.properties !== undefined) {
          await config.validateWrite?.(tx, {
            orgId: auth.orgId,
            actorObjectId: auth.subjectObjectId,
            properties: request.body.properties
          });
        }
        // A MOVE is a write at two places — the check above covered the object, this one covers
        // where it is going (`graph/containment-parent-authz.ts`).
        const declaredParent = await resolveDeclaredContainmentParent(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: writePermission,
          declared: containmentDomainIdFromWire(request.body.domainId),
          current: found
        });
        return updateObject(tx, {
          orgId: auth.orgId,
          typeId,
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
    url: `${base}/:idOrUrn`,
    schema: {
      params: RegistryIdOrUrnParamSchema,
      response: {
        200: GraphObjectSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        // THE ADMINISTRATOR FLOOR. See docs/routes.md §424.
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: `delete${resourceName}`,
        summary: `Soft-delete a ${label} object`,
        tags: [basePath]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { idOrUrn } = request.params;
      const object = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getObjectByIdOrUrn(tx, auth.orgId, typeId, idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: writePermission,
          scopeObjectId: found.id
        });
        await deleteObject(tx, {
          orgId: auth.orgId,
          typeId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          idOrUrn
        });
        return getObjectByIdOrUrn(tx, auth.orgId, typeId, found.id, { includeDeleted: true });
      });
      reply.status(200).send(object);
    }
  });

  typed.route({
    method: "PUT",
    url: `${base}/:urn`,
    schema: {
      params: RegistryUrnParamSchema,
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
        operationId: `upsert${resourceName}ByUrn`,
        summary: `Idempotent upsert-by-URN for a ${label} object`,
        tags: [basePath]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { urn } = request.params;
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
          permission: writePermission,
          declared: containmentDomainIdFromWire(request.body.domainId),
          current: existing
        });
        const scopeObjectId = existing ? existing.id : (declaredParent ?? auth.orgId);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: writePermission,
          scopeObjectId
        });
        // ADR-0031 — see the POST branch above; on an existing row this authorizes the DECLARED
        // value, which `upsertObjectByUrn` then treats as a precondition rather than a write.
        await assertMayDeclareDomainLocal(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          scopeObjectId,
          requested: request.body.domainLocal
        });
        await config.validateWrite?.(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          properties: request.body.properties
        });
        return upsertObjectByUrn(tx, {
          orgId: auth.orgId,
          typeId,
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
