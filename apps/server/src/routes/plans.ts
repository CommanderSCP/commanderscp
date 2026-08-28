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
import { conflict } from "../errors.js";
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
} from "../iac/plans-repo.js";

/**
 * Server-side `@scp/iac` plan/apply (BUILD_AND_TEST.md §8 M2 item 4, DESIGN.md §15): the diff
 * engine lives once here and is identical for the CLI (`scp plan`/`scp apply`), the SDK, and (in
 * later milestones) federation import and drift detection — "Kubernetes-apply semantics, not
 * client-side Terraform semantics" (DESIGN.md §15).
 *
 * **Routing note (documented deviation):** DESIGN.md's `{id}:verb` syntax (e.g.
 * `/changes/{id}:accept`) does NOT survive Fastify's router (find-my-way) the way it reads —
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
 *    `prepareApplyChecks` doc comment has the full story). "The exact same gates" is a claim this
 *    file cannot keep on its own, and M21.3 briefly made it FALSE: ADR-0032 §6a's refusal was added
 *    to the typed route's `validateWrite` and to nothing else, so a manifest declaring a group-scoped
 *    dependency-subscription opt-out applied cleanly through here and the object read back. That
 *    refusal now lives at `graph/objects-repo.ts`'s `createObject`/`updateObject` — which apply calls
 *    directly — so parity holds by construction rather than by two lists happening to agree.
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

        // D7 SINGLE OWNERSHIP PER STACK (ADR-0046 §3, team-pipeline-iac §4/§5). A stack bound to a
        // config source is repo-owned: its state is delivered by that repo's sync, and a direct
        // apply against it would be reverted by the very next sync — silently, and with the CLI
        // caller having been told it succeeded. Refused with a 409 naming the owning config source,
        // which is the thing the caller has to change to get their push back.
        //
        // AT APPLY, NOT AT `POST /plans`, for the reason the commander-only check below it is:
        // computing a diff writes nothing, and seeing what a push WOULD do to a repo-owned stack is
        // a legitimate — and, for a PR dry-run, the intended — thing to ask.
        //
        // The predicate is `config-source/cli-apply-guard.ts`, which is also what makes "not bound"
        // mean exactly what it does today: every stack no config source claims returns
        // `{ allowed: true }` unconditionally, so this is one new refusal and not a new gate on the
        // existing path.
        const ownership = evaluateCliApplyOwnership(
          await findStackConfigSourceBinding(tx, auth.orgId, pending.stackName)
        );
        if (!ownership.allowed) throw conflict(ownership.message);

        // COMMANDER-ONLY, BUT ONLY FOR THE ONE COLLECTION THAT IS (ADR-0032 §7d, §7e). A plan that
        // touches no producer declarations applies anywhere, as it always has; a plan that writes
        // one is refused on a field outpost exactly as `POST /dependencies/producers` is. IaC apply
        // is a SECOND DOOR into `dependency_line_producers`, and a commander-only capability guarded
        // at one door is not guarded — the row would land where no dependency job runs and no
        // inventory exists to act on it, which is the "true elsewhere, inert here" shape
        // `dependencyManagement` exists to close.
        //
        // The FEDERATION axis only, never the process axis: every HTTP request lands on an
        // `SCP_ROLE=api` process in the split topology, so a route carrying the process axis would
        // refuse every caller on a correct commander (`commander-only.ts`'s "a route does not get
        // both"). Checked at APPLY and not at `POST /plans`: computing a diff writes nothing, and
        // the plan an outpost operator computes is a legitimate way to see what the commander would
        // do.
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
}
