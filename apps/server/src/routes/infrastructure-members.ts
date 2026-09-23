import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  InfrastructureMembersViewSchema,
  InfrastructureMembershipDiffSchema,
  ProblemSchema,
  ReportInfrastructureMembersRequestSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { readMembers, replaceMembership } from "../coordination/infrastructure-members-repo.js";

/**
 * THE MEMBERSHIP DOOR (team-pipeline-iac D25(a), M27.6). See docs/routes.md §310.
 *
 * Membership is REPORTED INWARD rather than read outward, and that is a deliberate choice over
 * adding a members verb to the executor interface. `ExecutorPlugin` is observe/trigger/status/abort
 * and nothing else — a fifth verb is a charter-adjacent change — whereas an infrastructure
 * pipeline's apply already knows the truth at the moment it finishes and can push it, exactly as
 * pipeline evidence is pushed.
 *
 * AUTHORIZED AT THE PRODUCT, never at the org root: this data decides which hosts a host-reaching
 * run will connect to, so the bar is the same `object:write` that "who may change this product"
 * sets. The reporter is stamped server-side from the authenticated subject; the body carries no
 * producer field, because a self-declared producer is not provenance.
 */
export function registerInfrastructureMemberRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "PUT",
    url: "/api/v1/infrastructure-products/:idOrUrn/members",
    schema: {
      params: z.object({ idOrUrn: z.string().min(1) }),
      body: ReportInfrastructureMembersRequestSchema,
      response: {
        200: InfrastructureMembershipDiffSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "reportInfrastructureMembers",
        summary:
          "Report an infrastructure product's CURRENT observed membership (team-pipeline-iac D25(a)). PUT, not POST, because the body is the whole truth and the operation is idempotent — a delta protocol would let one dropped message leave a host in the inventory that no longer exists, which for a host-reaching runner means connecting to an address that may since have been reassigned. An empty array is meaningful and accepted: a fleet scaled to zero must stop converging its last known hosts. Authorized with 'object:write' AT THE PRODUCT; the reporter is stamped server-side",
        tags: ["infrastructure"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const diff = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const product = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.params.idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: product.id
        });
        return replaceMembership(tx, {
          orgId: auth.orgId,
          productObjectId: product.id,
          reportedBySubjectId: auth.subjectObjectId,
          members: request.body.members
        });
      });
      return reply.code(200).send(diff);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/infrastructure-products/:idOrUrn/members",
    schema: {
      params: z.object({ idOrUrn: z.string().min(1) }),
      response: {
        200: InfrastructureMembersViewSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getInfrastructureMembers",
        summary:
          "Read an infrastructure product's observed membership — the set a host-reaching run would compile its inventory from. Ordered by member id so the same observation yields the same bytes on every read",
        tags: ["infrastructure"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const view = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const product = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.params.idOrUrn);
        // READ is `object:read` at the product — a narrower bar than the write above, but still at
        // the product: membership names real addresses in someone's estate.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: product.id
        });
        return {
          productObjectId: product.id,
          members: await readMembers(tx, auth.orgId, product.id)
        };
      });
      return reply.code(200).send(view);
    }
  });
}
