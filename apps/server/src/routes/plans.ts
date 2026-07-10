import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ApplyPlanResponseSchema,
  CreatePlanRequestSchema,
  PlanIdParamSchema,
  PlanSchema,
  ProblemSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import {
  computeDiffForManifest,
  executePlanDiff,
  getPlanById,
  insertPlan,
  lockPendingPlan,
  markPlanApplied,
  prepareApplyChecks
} from "../iac/plans-repo.js";

/**
 * Server-side `@scp/iac` plan/apply (BUILD_AND_TEST.md §8 M2 item 4, DESIGN.md §15): the diff
 * engine lives once here and is identical for the CLI (`scp plan`/`scp apply`), the SDK, and (in
 * later milestones) federation import and drift detection — "Kubernetes-apply semantics, not
 * client-side Terraform semantics" (DESIGN.md §15).
 *
 * **Routing note (documented deviation):** DESIGN.md's `{id}:verb` syntax (e.g.
 * `/changes/{id}:promote`) does NOT survive Fastify's router (find-my-way) the way it reads —
 * verified empirically: registering `/plans/:id:apply` does not parse as param `id` + literal
 * suffix `:apply`; find-my-way instead treats the whole `id:apply` token as ONE parameter name
 * (`request.params["id:apply"]`), so `/plans/abc` and `/plans/abc:apply` collapse onto the same
 * route and can't be told apart. No `:verb`-style route exists anywhere else in the codebase yet
 * to be consistent with (M3 introduces the first ones), so this module falls back to the
 * conventional REST subpath `POST /plans/{id}/apply` instead — a deliberate, isolated deviation,
 * not a precedent-breaking one.
 *
 * **Scope decisions (documented):**
 *  - `POST /plans` (diff computation) is read-only against the graph and can touch objects across
 *    many scopes, so it checks `object:read` at the org-root scope — mirrors
 *    `objects-generic.ts`'s list-scope decision. The write-permission gate that actually matters
 *    is per-affected-object at apply time (`prepareApplyChecks`, `iac/plans-repo.ts`), not here.
 *  - `POST /plans/{id}/apply` checks `object:write`/`relationship:write` at EVERY individual
 *    affected object/relationship's own scope, not one coarse check at the org root — the parent
 *    task's explicit instruction, mirroring the M1 security review's "relationship writes require
 *    write permission at both endpoints' scopes" (CRITICAL 1). Every check runs to completion
 *    BEFORE any mutation executes, in the same transaction, so a single denial rolls back the
 *    entire apply (fails fully closed — see `plans.integration.test.ts`'s partial-denial test).
 *  - A `policy`/`control` object in the manifest is checked against `policy:write` instead of
 *    `object:write`, and a `policy` create/update additionally runs
 *    `assertPolicyScopeWithinAuthority` — the exact same governance gates the typed `/policies`/
 *    `/controls` routes enforce (security fast-follow after PR #9: `iac/plans-repo.ts`'s
 *    `prepareApplyChecks` doc comment has the full story).
 */
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
        summary: "Apply a pending plan transactionally (create/update/delete objects + relationships)",
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

        const { checks, objectResolutions } = await prepareApplyChecks(
          tx,
          auth.orgId,
          auth.subjectObjectId,
          pending.diff
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
}
