import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CreateRelationshipRequestSchema,
  ProblemSchema,
  RelationshipIdParamSchema,
  RelationshipListQuerySchema,
  RelationshipListResponseSchema,
  RelationshipSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { forbidden } from "../errors.js";
import { withIdempotency } from "../idempotency.js";
import {
  createRelationship,
  deleteRelationship,
  getRelationship,
  listRelationships
} from "../graph/relationships-repo.js";
import { isSystemManagedRelationshipType } from "../graph/system-managed-relationships.js";

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  return typeof header === "string" ? header : undefined;
}

/**
 * The generic `/relationships` write endpoints must never let a client create or delete an
 * engine-owned relationship type directly (adversarial review MAJOR #7 for `approves`; M5 CRITICAL
 * for `coordinates`). The full rationale — and why the dedicated authority-checked paths that
 * legitimately create these edges still work (they call `createRelationship` directly, never this
 * guarded HTTP route) — lives in `graph/system-managed-relationships.ts`. Enforced with 403, at
 * BOTH create and delete.
 */
function assertNotSystemManagedRelationship(typeId: string): void {
  if (isSystemManagedRelationshipType(typeId)) {
    throw forbidden(
      `relationship type '${typeId}' is system-managed (created only by the engine's own authority-checked paths — e.g. approval voting, or campaign/initiative membership) and cannot be created or deleted via /relationships`
    );
  }
}

/**
 * Generic `/relationships` endpoints (DESIGN.md §4.1, §6) enforcing endpoint-type and cardinality
 * constraints from the relationship type registry at write time.
 *
 * Relationship writes (create/delete) require `relationship:write` at BOTH endpoints' scopes
 * (DESIGN.md §7; PR #4 security review, CRITICAL 1). This is load-bearing, not pedantry:
 * `member_of` edges feed RBAC subject expansion (authz/resolve.ts), so a from-side-only check
 * would let any subject with `relationship:write` somewhere add themselves `member_of` an
 * arbitrary team/group and inherit its role bindings. Applied uniformly to every relationship
 * type — a member_of-only carve-out would just invite the next type-specific escalation.
 */
export function registerRelationshipRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/v1/relationships",
    schema: {
      body: CreateRelationshipRequestSchema,
      response: {
        201: RelationshipSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "createRelationship",
        summary: "Create a relationship",
        tags: ["relationships"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // MAJOR #7: refuse to fabricate a system-managed edge (e.g. `approves`) via this endpoint.
        assertNotSystemManagedRelationship(request.body.typeId);
        // BOTH endpoints (see module doc — member_of privilege-escalation guard).
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "relationship:write",
          scopeObjectId: request.body.fromId
        });
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "relationship:write",
          scopeObjectId: request.body.toId
        });
        return withIdempotency(
          tx,
          {
            orgId: auth.orgId,
            idempotencyKey: idempotencyKey(request),
            route: "POST /relationships",
            requestBody: request.body
          },
          async () => ({
            status: 201,
            body: await createRelationship(tx, {
              orgId: auth.orgId,
              actorObjectId: auth.subjectObjectId,
              requestId: request.id,
              id: request.body.id,
              typeId: request.body.typeId,
              fromId: request.body.fromId,
              toId: request.body.toId,
              properties: request.body.properties,
              labels: request.body.labels
            })
          })
        );
      });
      reply.status(result.status as 201).send(result.body);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/relationships",
    schema: {
      querystring: RelationshipListQuerySchema,
      response: { 200: RelationshipListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listRelationships",
        summary: "List relationships",
        tags: ["relationships"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const page = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "relationship:read",
          scopeObjectId: auth.orgId
        });
        return listRelationships(tx, auth.orgId, request.query);
      });
      reply.status(200).send(page);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/relationships/:id",
    schema: {
      params: RelationshipIdParamSchema,
      response: {
        200: RelationshipSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getRelationship",
        summary: "Get a relationship by id",
        tags: ["relationships"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const relationship = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getRelationship(tx, auth.orgId, request.params.id);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "relationship:read",
          scopeObjectId: found.fromId
        });
        return found;
      });
      reply.status(200).send(relationship);
    }
  });

  typed.route({
    method: "DELETE",
    url: "/api/v1/relationships/:id",
    schema: {
      params: RelationshipIdParamSchema,
      response: {
        200: RelationshipSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "deleteRelationship",
        summary: "Soft-delete a relationship",
        tags: ["relationships"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const relationship = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const found = await getRelationship(tx, auth.orgId, request.params.id);
        // MAJOR #7: a system-managed edge (e.g. `approves`) is engine-owned — no hand-deleting
        // approval evidence through the generic endpoint.
        assertNotSystemManagedRelationship(found.typeId);
        // BOTH endpoints (see module doc) — deleting a membership/governance edge is as
        // security-relevant as creating one.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "relationship:write",
          scopeObjectId: found.fromId
        });
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "relationship:write",
          scopeObjectId: found.toId
        });
        await deleteRelationship(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          id: found.id
        });
        return { ...found, deletedAt: new Date().toISOString() };
      });
      reply.status(200).send(relationship);
    }
  });
}
