import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  GovernanceMoveEnforcementSchema,
  GovernanceMoveInstanceRungSchema,
  GovernanceMoveRungListSchema,
  GovernanceMoveRungWriteResponseSchema,
  ProblemSchema,
  PutGovernanceMoveInstanceRungRequestSchema,
  PutGovernanceMoveRungRequestSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { createPool } from "../db/client.js";
import { authorize } from "../authz/resolve.js";
import { operatorTokenMatches } from "./operator-db.js";
import { forbidden, notFound } from "../errors.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import {
  assertRungSubjectType,
  listGovernanceMoveRungs,
  readInstanceMoveRung,
  resolveGovernanceMoveEnforcement
} from "../governance/move-enforcement.js";
import {
  disableGovernanceMoveRungWithEffects,
  enableGovernanceMoveRungWithEffects,
  governanceMoveRungScopeCheck
} from "../governance/move-rung-write.js";

/**
 * THE `governance:move` LATTICE'S API SURFACE (charter principle 3: API → SDK → CLI → IaC → UI).
 * Proposal `governance-reach-on-containment-move.md` §9.2; owner ruling 2026-08-18.
 *
 * Five verbs, and the split between them is an AUTHORITY split, not a convenience one:
 *
 *  - the two READS about an org's own lattice need `object:read` (seeing which of your containers is
 *    governed is reading your graph);
 *  - the two RUNG WRITES need `policy:write` AT-OR-ABOVE the subject — enabling a rung is a
 *    governance-authoring act, held to the same bar as authoring a policy, and `policy:write` is
 *    Administrator/Owner only (drizzle/0010:174);
 *  - the INSTANCE write needs the deployment OPERATOR TOKEN and nothing a tenant can hold, because
 *    the instance rung binds every org on the deployment. Byte-for-byte the
 *    `dependency_subscription_unlock` shape (`routes/dependency-subscriptions.ts`): tenant-readable
 *    `GET`, operator-only `PUT` through a raw admin pool, because `scp_app` has neither a write grant
 *    nor a write RLS policy on that table (drizzle/0083 §2, two independent barriers).
 *
 * THE EXPLAIN READ ANSWERS ABOUT ONE OBJECT'S CHAIN, AND A MOVE HAS TWO ENDS. `enforced: false` here
 * does NOT promise a move of this object is ungoverned — the destination's chain is ORed in at the
 * door. Said on the schema too (`packages/schemas/src/governance-move.ts`), because a consumer that
 * gets this wrong builds a UI that promises a move will succeed and then shows a 403.
 *
 * WHY THE EXPLAIN READ SITS UNDER `/objects/:type/:idOrUrn/` RATHER THAN `/objects/:idOrUrn/`:
 * `routes/objects-generic.ts` already claims `:type` at that position, and find-my-way refuses a
 * second parameter NAME in a position it has already bound — a one-segment form would fail at
 * registration, not at request time. `/objects/:type/:idOrUrn/health` is the existing precedent for
 * a per-object sub-resource and this follows it exactly.
 *
 * EVERY WRITE RECORDS A DECISION AND AN AUDIT EVENT IN THE SAME TRANSACTION (charter principle 6) —
 * and that is now true of a SECOND door, `iac/plans-repo.ts`'s apply (proposal §9.6 Q4), because both
 * go through `governance/move-rung-write.ts` rather than each assembling the act for itself.
 */

const RungParamSchema = z.object({ idOrUrn: z.string().min(1) });
const ObjectEnforcementParamSchema = z.object({
  type: z.string().min(1),
  idOrUrn: z.string().min(1)
});

/** The Decision kind every rung write records. It lives with the WRITE (`governance/move-rung-write
 *  .ts`), which is what makes the claim above true for the IaC door as well as this one; re-exported
 *  here because this route was its first home and `GET /decisions?kind=…` consumers import it from
 *  the surface they read about. */
export { GOVERNANCE_MOVE_DECISION_KIND } from "../governance/move-rung-write.js";

function requireOperator(deps: AppDeps, request: FastifyRequest): void {
  if (!deps.config.operatorToken) {
    throw forbidden(
      "the instance governance:move rung is operator-authored: SCP_OPERATOR_TOKEN is not configured on this deployment, so the write surface is closed"
    );
  }
  if (!operatorTokenMatches(request.headers["x-scp-operator-token"], deps.config.operatorToken)) {
    throw forbidden(
      "setting the instance governance:move rung requires the deployment operator token (x-scp-operator-token) — no tenant role can grant this, because the instance rung activates enforcement for every org on the deployment"
    );
  }
}

/** The instance rung as the API projects it — read through the SAME "no row means disabled" reader
 *  the doors use, never a SELECT written here (see `readInstanceMoveRung`). */
async function readInstanceForApi(tx: TenantTx): Promise<{
  enabled: boolean;
  updatedAt: string | null;
}> {
  return readInstanceMoveRung(tx);
}

export function registerGovernanceMoveRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // THE EXPLAIN READ — "are moves of this object governed, and by which rung?"
  typed.route({
    method: "GET",
    url: "/api/v1/objects/:type/:idOrUrn/governance-move-enforcement",
    schema: {
      params: ObjectEnforcementParamSchema,
      response: {
        200: GovernanceMoveEnforcementSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getObjectGovernanceMoveEnforcement",
        summary:
          "Explain whether a containment move of this object is governed by the governance:move lattice — the instance rung ORed with every rung on this object's containment chain (the DESTINATION's chain is ORed in at the door, so `enforced: false` here is not a promise about a particular move)",
        tags: ["governance"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const enforcement = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const object = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.params.idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: object.id
        });
        return resolveGovernanceMoveEnforcement(tx, auth.orgId, { objectId: object.id });
      });
      reply.status(200).send(enforcement);
    }
  });

  // THE LIST READ — the whole lattice this org can act on, instance state included.
  //
  // AUTHORIZED AT THE ORG ROOT (`scopeObjectId: auth.orgId`), NOT at each rung's own subject. This
  // is a narrower bar than the explain read's per-object `object:read` above: a domain-scoped
  // Administrator who can enable/disable a rung on their own domain (a `policy:write`-at-that-scope
  // act) may still lack `object:read` at the org root and so cannot list the org's whole lattice,
  // including the rung they themselves just set. That is a server-authorization decision, not a bug
  // this route comment fixes — flagged here so a UI consumer knows the 403 it may see is expected,
  // not a wiring defect, and states the requirement instead of a caller having to infer it from the
  // `authorize()` call below.
  typed.route({
    method: "GET",
    url: "/api/v1/governance/move-enforcement/rungs",
    schema: {
      response: {
        200: GovernanceMoveRungListSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "listGovernanceMoveRungs",
        summary:
          "List the containers where governance:move enforcement is enabled for this org, with the instance rung's state",
        tags: ["governance"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const body = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        const [instance, rungs] = await Promise.all([
          readInstanceMoveRung(tx),
          listGovernanceMoveRungs(tx, auth.orgId)
        ]);
        return { instance: { enabled: instance.enabled }, rungs };
      });
      reply.status(200).send(body);
    }
  });

  // ENABLE a rung. Idempotent (an upsert): re-enabling an enabled rung is a restatement, not a 409.
  typed.route({
    method: "PUT",
    url: "/api/v1/governance/move-enforcement/rungs/:idOrUrn",
    schema: {
      params: RungParamSchema,
      body: PutGovernanceMoveRungRequestSchema,
      response: {
        200: GovernanceMoveRungWriteResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "enableGovernanceMoveRung",
        summary:
          "Enable governance:move enforcement at one container (org root, containment domain, service or assembly) — every containment move under it then requires governance:move at BOTH ends. Requires policy:write at-or-above the subject",
        tags: ["governance"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const body = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // Resolve under the CALLER'S OWN org before anything touches the table — the mitigation the
        // org-unbound `REFERENCES objects(id)` owes (drizzle/0061's header, restated in 0079).
        const subject = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.params.idOrUrn);
        const tier = assertRungSubjectType(subject.typeId, request.params.idOrUrn);
        // A governance-authoring act, at the same bar as authoring a policy. `authorize` expands
        // strictly UPWARD from the scope object, so this IS "at-or-above the subject". The pair is
        // `governance/move-rung-write.ts`'s, imported rather than restated so this door and the IaC
        // apply door cannot come to require different things.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          ...governanceMoveRungScopeCheck(subject.id)
        });
        // THE WHOLE ACT — row + Decision + audit event — through the function the IaC apply door
        // calls too, so neither can perform a fraction of it.
        const { decisionId } = await enableGovernanceMoveRungWithEffects(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          subject: { id: subject.id, name: subject.name },
          tier,
          ...(request.body.note === undefined ? {} : { note: request.body.note })
        });
        return {
          subjectObjectId: subject.id,
          tier,
          enabled: true,
          enforcement: await resolveGovernanceMoveEnforcement(tx, auth.orgId, {
            objectId: subject.id
          }),
          decisionId
        };
      });
      reply.status(200).send(body);
    }
  });

  // DISABLE a rung — 409 while an upper rung (the instance included) is enabled, naming it.
  typed.route({
    method: "DELETE",
    url: "/api/v1/governance/move-enforcement/rungs/:idOrUrn",
    schema: {
      params: RungParamSchema,
      response: {
        200: GovernanceMoveRungWriteResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "disableGovernanceMoveRung",
        summary:
          "Disable governance:move enforcement at one container. Refused 409 while an upper rung (an ancestor's, or the instance rung) is enabled, naming it — an enablement above cannot be undone below. Requires policy:write at-or-above the subject",
        tags: ["governance"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const body = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const subject = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.params.idOrUrn);
        const tier = assertRungSubjectType(subject.typeId, request.params.idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          ...governanceMoveRungScopeCheck(subject.id)
        });
        // 404 before the monotone refusal: "there is no rung here" and "you may not disable this
        // rung" are different answers with different remedies, and collapsing them would send an
        // operator hunting for an upper rung that is not the reason.
        const existing = await listGovernanceMoveRungs(tx, auth.orgId);
        if (!existing.some((rung) => rung.subjectObjectId === subject.id)) {
          throw notFound(
            `governance:move enforcement is not enabled at '${request.params.idOrUrn}' — there is no rung here to disable`
          );
        }
        // The whole act — the monotone 409, the row, the Decision and the audit event — through the
        // function the IaC apply door calls too.
        const { decisionId } = await disableGovernanceMoveRungWithEffects(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          subject: { id: subject.id, name: subject.name },
          tier
        });
        return {
          subjectObjectId: subject.id,
          tier,
          enabled: false,
          enforcement: await resolveGovernanceMoveEnforcement(tx, auth.orgId, {
            objectId: subject.id
          }),
          decisionId
        };
      });
      reply.status(200).send(body);
    }
  });

  // THE INSTANCE RUNG — tenant-readable.
  typed.route({
    method: "GET",
    url: "/api/v1/instance/governance-move-enforcement",
    schema: {
      response: {
        200: GovernanceMoveInstanceRungSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getGovernanceMoveInstanceRung",
        summary:
          "Get the instance (commander) rung of the governance:move lattice. It ACTIVATES: enabled here means every org on this deployment enforces governance:move on containment moves, and no org may disable it",
        tags: ["governance"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const instance = await withTenantTx(deps.db, auth.orgId, readInstanceForApi);
      reply.status(200).send(instance);
    }
  });

  // THE INSTANCE RUNG — operator-only write, through the admin connection (`scp_app` holds neither
  // a write grant nor a write policy on this table — drizzle/0083 §2).
  typed.route({
    method: "PUT",
    url: "/api/v1/instance/governance-move-enforcement",
    schema: {
      body: PutGovernanceMoveInstanceRungRequestSchema,
      response: {
        200: GovernanceMoveInstanceRungSchema,
        // REACHABLE and load-bearing: `enabled` is required, so an omitted flag is a 400 rather than
        // a silent deployment-wide disable.
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "putGovernanceMoveInstanceRung",
        summary:
          "Set the instance (commander) rung of the governance:move lattice (operator token required — it activates enforcement for every org on the deployment, and no org may disable it)",
        tags: ["governance"]
      }
    },
    handler: async (request, reply) => {
      // Operator, not tenant. The caller is still authenticated as an ordinary principal, so the
      // write is attributable and an unauthenticated caller never reaches the token comparison.
      const auth = await requireAuth(deps, request);
      requireOperator(deps, request);

      const pool = createPool(deps.config.databaseUrl, { max: 1 });
      try {
        await pool.query(
          `INSERT INTO governance_move_instance_rung (id, enabled, updated_at)
             VALUES ('default', $1, now())
           ON CONFLICT (id) DO UPDATE SET
             enabled    = EXCLUDED.enabled,
             updated_at = now()`,
          [request.body.enabled]
        );
      } finally {
        await pool.end();
      }
      const instance = await withTenantTx(deps.db, auth.orgId, readInstanceForApi);
      reply.status(200).send(instance);
    }
  });
}
