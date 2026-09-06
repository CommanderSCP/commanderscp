import type { FastifyInstance } from "fastify";
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
import { idempotencyKeyOf, withIdempotency } from "../idempotency.js";
import {
  createRelationship,
  deleteRelationship,
  getRelationship,
  listRelationships
} from "../graph/relationships-repo.js";
import { isSystemManagedRelationshipType } from "../graph/system-managed-relationships.js";
import { assertGovernanceMoveAdmits } from "../governance/move-enforcement.js";

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
      `relationship type '${typeId}' is system-managed (created only by the engine's own authority-checked paths — e.g. approval voting, or campaign membership) and cannot be created or deleted via /relationships`
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
        // THE SECOND, OPT-IN BAR on a `contains` write (proposal §9.2 door (c), owner ruling
        // 2026-08-18). A `contains` edge IS a containment parent — route 2 of the same walk
        // `objects.domain_id` is route 1 of — so creating one MOVES the `to` object into the `from`
        // container, with exactly the governance-reach consequence a `domainId` write has. Only
        // `contains`; every other relationship type is an ordinary edge and reaches nothing.
        if (request.body.typeId === "contains") {
          await assertGovernanceMoveAdmits(tx, {
            orgId: auth.orgId,
            subjectObjectId: auth.subjectObjectId,
            movedObjectId: request.body.toId,
            destinationObjectId: request.body.fromId,
            permissionSetForExplain: "relationship:write"
          });
        }
        return withIdempotency(
          tx,
          {
            orgId: auth.orgId,
            idempotencyKey: idempotencyKeyOf(request),
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
        404: ProblemSchema,
        // THE ADMINISTRATOR FLOOR (`docs/authz/role-binding-door.md` §7). Removing the `member_of` edge
        // that makes an org's last administrative binding reachable is refused with 409 from
        // `graph/relationships-repo.ts`'s `deleteRelationship` — a CHOKE POINT, so this route
        // inherits the refusal and must declare it. Undeclared it would have been serialized as a
        // bare Problem the generated SDK types as impossible. An added response code is additive
        // under the oasdiff gate: `deleteRelationship` previously declared 200/401/403/404.
        409: ProblemSchema
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
        // Deleting a `contains` edge is a MOVE TO THE ORG ROOT: the child stops being contained by
        // `from` and falls back to its `domain_id` route, which every rooted row terminates at. The
        // destination is therefore the org root — and the org root is NOT exempt from this bar
        // (unlike #244's `object:write` pair), because leaving a governed subtree for the top level
        // is precisely the reach reduction `governance:move` gates. See
        // `governance/move-enforcement.ts`.
        if (found.typeId === "contains") {
          await assertGovernanceMoveAdmits(tx, {
            orgId: auth.orgId,
            subjectObjectId: auth.subjectObjectId,
            movedObjectId: found.toId,
            destinationObjectId: null,
            permissionSetForExplain: "relationship:write"
          });
        }
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
