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
import { authorize, type Permission } from "../authz/resolve.js";
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
  /**
   * PLURAL PascalCase for the list operationId, when `resourceName + "s"` is wrong.
   *
   * Every resource through `Domain`..`ServiceAccount` pluralises by appending `s`, so this was never
   * needed. `Assembly` does not — the naive form is `listAssemblys`. That matters more than it looks:
   * the operationId is the generated SDK method name and `/v1` is additive-only, so a misspelling
   * shipped once is a misspelling forever (renaming an operationId is an oasdiff break — see
   * OASDIFF-EXCEPTIONS.md, where two such renames each cost an exception).
   */
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

/**
 * The 8 typed convenience resources this milestone adds (BUILD_AND_TEST.md §8 M2 item 1),
 * invoked once each via `registerTypedRegistryRoutes` from app.ts. `typeId` matches the
 * pre-seeded `object_types.id` exactly (drizzle/0002_rls_rbac_seed.sql §5).
 */
export const TYPED_REGISTRY_RESOURCES: TypedRegistryConfig[] = [
  { typeId: "domain", basePath: "domains", resourceName: "Domain" },
  { typeId: "service", basePath: "services", resourceName: "Service" },
  // The OPTIONAL level between a service and its components (migration 0055,
  // `intermediate-grouping.md` D5). A plain typed registry like `service` — it needs no bespoke
  // route, because the level is expressed by `contains` edges rather than by columns of its own.
  // NOT listed in `components-repo.ts`'s parent check: that routes through `isContainerType`
  // (containment.ts), which is the single definition of "may contain components".
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

/**
 * M4 governance resources (BUILD_AND_TEST.md §8 M4 item 1/2): Policy and Control documents are
 * graph objects of the pre-seeded `policy`/`control` types (0002_rls_rbac_seed.sql §5), managed
 * through this exact same typed-registry machinery — versioned via `objects.version` (bumped on
 * every update, pinned into Decisions — DESIGN §10.1/§10.4), scope/enforcement/condition/effects
 * validated at write time by the Ajv property-schema path (drizzle/0010_governance.sql §5). The
 * only difference from `TYPED_REGISTRY_RESOURCES` above: writes require 'policy:write' rather
 * than the generic 'object:write' (DESIGN §7's example role bindings name it explicitly).
 */
export const GOVERNANCE_TYPED_REGISTRY_RESOURCES: TypedRegistryConfig[] = [
  {
    typeId: "policy",
    basePath: "policies",
    resourceName: "Policy",
    writePermission: "policy:write",
    // CRITICAL #1b — bind the policy's DECLARED scope to the author's own authority. All three
    // write paths (POST / PATCH-with-properties / PUT) call `validateWrite`, so declaring it at the
    // config covers every door THIS FILE opens.
    //
    // "Every door this file opens" is the limit of what a route-level hook can claim, and it is why
    // ADR-0032 §6a's sibling refusal is NOT here. That one shipped in this exact spot, and the census
    // of where `assertPolicyScopeWithinAuthority` is ALSO installed — `iac/plans-repo.ts:733` and
    // `:758` — is what showed the spot to be the wrong altitude: `POST /plans` + `/plans/{id}/apply`,
    // `POST /federation/hand-fill` and `POST /federation/overlays` all reach `createObject` without
    // passing through here. It now lives at `graph/objects-repo.ts`'s `createObject`/`updateObject`,
    // the one choke point every local write door funnels through, and this route inherits it there.
    //
    // This check has NOT moved with it, and that is a distinction rather than an omission — it is
    // `federation/domain-local.ts`'s "authorization at the door, invariant at the repo" split.
    // ADR-0032 §6a's refusal is an INVARIANT: it reads only the document, needs no subject, and is
    // the same answer for every caller, so the repo is where it belongs. This one is AUTHORIZATION:
    // it resolves the author's `policy:write` at the DECLARED scope. Pushing it down would make it
    // run for the federation importer and every internal caller too, whose `actorObjectId` is a
    // SYNTHETIC subject (`FEDERATION_IMPORT_ACTOR_ID`) — which is precisely how an authorization
    // check quietly becomes a no-op. It stays at the doors, and its own three-site census
    // (here + `iac/plans-repo.ts`'s create and update branches) is what keeps it honest.
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

/**
 * M2 typed convenience endpoints: thin, friendlier-path layers over the exact same generic graph
 * substrate `routes/objects-generic.ts` uses — same graph/objects-repo.ts functions, same
 * auth/authorize/idempotency structure, same RBAC scope semantics. The only differences are
 * ergonomic: a fixed path (`/api/v1/domains` instead of `/api/v1/objects/domain`), a hardcoded
 * `typeId` (never a route param, never client-suppliable), and distinct OpenAPI
 * operationId/tags per resource for SDK/CLI method naming. No new top-level tables, no new
 * authz/audit code paths: objects created here are the exact same `objects` rows the generic
 * `/objects/{type}` endpoint sees, and vice versa (proven by
 * typed-registries.integration.test.ts).
 *
 * Called once per entry in `TYPED_REGISTRY_RESOURCES` (app.ts) rather than hand-copied 8 times.
 *
 * Scope decision: identical to objects-generic.ts (see that file's module doc) — list checks
 * `object:read` at org-root scope; every other operation checks at the object's own scope
 * (existing objects) or its resolved containing domain (new objects).
 */
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
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: readPermission,
          scopeObjectId: auth.orgId
        });
        return listObjects(tx, auth.orgId, typeId, listObjectsQueryFromWire(request.query));
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
        404: ProblemSchema
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
