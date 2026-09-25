import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApplyPlanResponseSchema,
  CreatePlanRequestSchema,
  PlanIdParamSchema,
  PlanSchema,
  ProblemSchema,
  ReleaseStackOwnershipRequestSchema,
  ReleaseStackOwnershipResponseSchema,
  StackNameParamSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { badRequest, conflict } from "../errors.js";
import { commanderOnlyFederationVerdict } from "../dependencies/commander-only.js";
import { evaluateCliApplyOwnership } from "../config-source/cli-apply-guard.js";
import { findStackConfigSourceBinding } from "../config-source/config-sources-repo.js";
import {
  computeDiffForManifest,
  executePlanDiff,
  getPlanById,
  insertPlan,
  lockPendingPlan,
  markPlanApplied,
  prepareApplyChecks
} from "../coordination-as-code/plans-repo.js";
import {
  releaseStackOwnership,
  stackReleaseAuthorityChecks
} from "../coordination-as-code/stack-release.js";

/** Server-side `@scp/coordination-as-code` plan/apply. See docs/routes.md §310. */
export function registerPlanRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/v1/plans",
    schema: {
      body: CreatePlanRequestSchema,
      response: {
        201: PlanSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "createPlan",
        summary: "Compute a desired-state diff against the graph and persist it as a plan",
        tags: ["plans"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      // `request.body.manifest` is already Zod-validated against `DesiredStateManifestSchema`
      // (fastify-type-provider-zod, wired in app.ts) before this handler ever runs — a malformed
      // manifest 400s here and never reaches `computeDiffForManifest`/the DB (security self-check
      // item 3, goal statement).
      const plan = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        const diff = await computeDiffForManifest(tx, auth.orgId, request.body.manifest);
        return insertPlan(tx, {
          orgId: auth.orgId,
          actorId: auth.subjectObjectId,
          manifest: request.body.manifest,
          diff
        });
      });
      reply.status(201).send(plan);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/plans/:id",
    schema: {
      params: PlanIdParamSchema,
      response: {
        200: PlanSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: { operationId: "getPlan", summary: "Get a plan by id", tags: ["plans"] }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const plan = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        return getPlanById(tx, auth.orgId, request.params.id);
      });
      reply.status(200).send(plan);
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/plans/:id/apply",
    schema: {
      params: PlanIdParamSchema,
      response: {
        200: ApplyPlanResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "applyPlan",
        summary:
          "Apply a pending plan transactionally (create/update/delete objects + relationships)",
        tags: ["plans"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // 404 if missing, 409 if not 'pending' (already applied, or — not reachable today, no
        // background staleness sweep yet — 'stale'). Locks the row for the transaction's
        // duration so two concurrent applies of the same plan can't both succeed.
        const pending = await lockPendingPlan(tx, auth.orgId, request.params.id);

        // D7 SINGLE OWNERSHIP PER STACK. See docs/routes.md §311.
        const ownership = evaluateCliApplyOwnership(
          await findStackConfigSourceBinding(tx, auth.orgId, pending.stackName)
        );
        if (!ownership.allowed) throw conflict(ownership.message);

        // Commander-only, but only for the one collection that is. See docs/routes.md §312.
        if ((pending.diff.producers ?? []).some((entry) => entry.action !== "noop")) {
          const commander = commanderOnlyFederationVerdict(
            deps.config,
            "applying a plan that declares or retracts a dependency-line producer"
          );
          if (!commander.allowed) throw conflict(commander.reason);
        }

        const { checks, objectResolutions } = await prepareApplyChecks(
          tx,
          auth.orgId,
          auth.subjectObjectId,
          pending.diff,
          pending.stackName
        );
        // EVERY affected object/relationship's scope, checked to completion before any mutation
        // (module doc). A denial throws 403 here, which rolls back the whole transaction.
        for (const check of checks) {
          await authorize(tx, {
            orgId: auth.orgId,
            subjectObjectId: auth.subjectObjectId,
            permission: check.permission,
            scopeObjectId: check.scopeObjectId
          });
        }

        await executePlanDiff(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          stackName: pending.stackName,
          diff: pending.diff,
          objectResolutions
        });

        const applied = await markPlanApplied(tx, auth.orgId, pending.id);
        const { summary } = applied.diff;
        // The "Decision-shaped record" for the APPLY action itself (the plan row, persisted at
        // POST /plans time with its diff + per-entry reasons, is that record for the diff
        // computation — module doc / goal statement).
        await appendAuditEvent(tx, {
          orgId: auth.orgId,
          actorId: auth.subjectObjectId,
          action: "plan.apply",
          subjectId: applied.id,
          reason: `creates=${summary.creates} updates=${summary.updates} deletes=${summary.deletes} noops=${summary.noops}`,
          requestId: request.id
        });

        return { plan: applied, summary };
      });
      reply.status(200).send(result);
    }
  });
  typed.route({
    method: "POST",
    url: "/api/v1/stacks/:stackName/release",
    schema: {
      params: StackNameParamSchema,
      body: ReleaseStackOwnershipRequestSchema,
      response: {
        200: ReleaseStackOwnershipResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "releaseStackOwnership",
        summary:
          "Release a coordination-as-code stack's ownership of named objects/relationships, so another stack may adopt them",
        description:
          "Requires the authority that decommissioning the WHOLE stack would: the type's write permission at every " +
          "live object the stack owns and relationship:write at both endpoints of every live edge it owns — not just " +
          "at the rows released (docs/coordination-as-code.md §330). All-or-nothing: a named row the stack does not " +
          "own (unknown, deleted, unmanaged, or another stack's) refuses the whole request with 409. Audited.",
        tags: ["plans"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const urns = request.body.urns ?? [];
      const edges = request.body.relationships ?? [];
      if (urns.length === 0 && edges.length === 0) {
        throw badRequest(
          "a release must name the rows it releases (urns and/or relationships) — there is no 'release everything' form"
        );
      }
      const { stackName } = request.params;
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // The floor every apply already cleared: `POST /plans` requires it.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        // D7, for the reason it guards apply: the repo's next sync would re-adopt what is released.
        const ownership = evaluateCliApplyOwnership(
          await findStackConfigSourceBinding(tx, auth.orgId, stackName)
        );
        if (!ownership.allowed) throw conflict(ownership.message);

        // BEFORE anything reads the named rows, so a caller without the stack's authority learns
        // nothing about which of them it owns. See docs/coordination-as-code.md §330.
        for (const check of await stackReleaseAuthorityChecks(tx, auth.orgId, stackName)) {
          await authorize(tx, {
            orgId: auth.orgId,
            subjectObjectId: auth.subjectObjectId,
            permission: check.permission,
            scopeObjectId: check.scopeObjectId
          });
        }

        return releaseStackOwnership(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          stackName,
          urns,
          relationships: edges
        });
      });
      reply.status(200).send(result);
    }
  });
}
