import type { FastifyInstance } from "fastify";
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
import { withOperatorDb } from "./operator-db.js";
import { authorize } from "../authz/resolve.js";
import { notFound } from "../errors.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import {
  assertRungSubjectType,
  listGovernanceMoveRungs,
  readInstanceMoveRung,
  resolveGovernanceMoveEnforcement
} from "../governance/move-enforcement.js";
import { requireInstanceOperator } from "../auth/operator-auth.js";
import {
  disableGovernanceMoveRungWithEffects,
  enableGovernanceMoveRungWithEffects,
  governanceMoveRungScopeCheck
} from "../governance/move-rung-write.js";

/** THE `governance:move` LATTICE'S API SURFACE. See docs/routes.md §221. */

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

  // THE LIST READ. See docs/routes.md §222.
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
      await requireInstanceOperator(deps, request, "the instance governance:move rung");

      // An operator connection, never an inline pool. See docs/routes.md §223.
      await withOperatorDb(deps.config, "the governance:move instance rung", async (client) => {
        await client.query(
          `INSERT INTO governance_move_instance_rung (id, enabled, updated_at)
             VALUES ('default', $1, now())
           ON CONFLICT (id) DO UPDATE SET
             enabled    = EXCLUDED.enabled,
             updated_at = now()`,
          [request.body.enabled]
        );
      });
      const instance = await withTenantTx(deps.db, auth.orgId, readInstanceForApi);
      reply.status(200).send(instance);
    }
  });
}
