import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { v7 as uuidv7 } from "uuid";
import {
  InstanceFreezeKeyParamSchema,
  InstanceFreezeListResponseSchema,
  InstanceFreezeSchema,
  LiftInstanceFreezeRequestSchema,
  ProblemSchema,
  PutInstanceFreezeRequestSchema,
  type InstanceFreeze
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { conflict, forbidden, notFound } from "../errors.js";
import { assertWindowOrdered } from "../governance/freezes-repo.js";
import { operatorTokenMatches, withOperatorDb } from "./operator-db.js";

/**
 * M25.3 — THE INSTANCE-SCOPED (PLATFORM) FREEZE TIER'S API SURFACE (drizzle/0086,
 * docs/proposals/campaigns-rework.md §2, owner decision D1), API-first per charter principle 3.
 *
 * THE DELIBERATE TWIN of `routes/instance-scan-floors.ts` and
 * `routes/instance-scan-exclusion-admissions.ts` — same instance scope, same DESIGN §4.2 `org_id`
 * exception, same two audiences and two credentials:
 *
 *  - **READ is tenant-facing.** Any authenticated tenant principal may see the freezes that bind
 *    them. This is not a convenience: a platform freeze is the one freeze a tenant CANNOT author
 *    and (by default) CANNOT override, so a tenant that cannot read it cannot be told why its
 *    release stopped — charter principle 6, and the reason `instance_freezes` carries a
 *    `tenant_read` RLS policy at all. The read runs inside the ordinary tenant transaction under
 *    that policy, the same path gate evaluation takes, so no request path needs the privileged
 *    connection to evaluate a gate (ADR-0016 §3). It leaks nothing across tenants because the
 *    table holds NO per-tenant rows.
 *
 *  - **WRITE is operator-only, and deliberately NOT an RBAC permission.** A platform freeze stops
 *    releases for EVERY org on the deployment; a tenant admin — however privileged inside their
 *    own org — must never author, extend or retract one, and the whole authority argument for the
 *    tier collapses if they can. So no role can grant it: the write requires the deployment-level
 *    `SCP_OPERATOR_TOKEN` presented as `x-scp-operator-token`, and executes over the
 *    `scp_operator` connection (`withOperatorDb`) because `scp_app` holds SELECT only on the table
 *    and has no write RLS policy in any verb (drizzle/0086 — two independent barriers). Unset
 *    token => the surface is CLOSED (403), never a fallback to a tenant credential.
 *
 *    `freeze:write` IS NOT ADDED AT THIS TIER AND NO ROLE, INCLUDING Owner, CAN AUTHOR AN INSTANCE
 *    FREEZE — verbatim the `instance-scan-floors.ts` posture. The `Permission` union is unchanged
 *    by this increment.
 *
 * ============================================================================================
 * NO IaC, AND NO WRITE CONTROL IN THE UI — THE SAME AS ITS TWO SIBLINGS, AND THAT IS THE DECISION
 * ============================================================================================
 * M22.9's commit message states it for the admissions door and it applies here for the same
 * reason: `scp-iac` plans and applies TENANT graph state under a tenant credential, and the UI is
 * a tenant surface. An instance-scoped resource authored with a deployment-level secret belongs to
 * neither — putting it in an IaC file would put a deployment secret into a tenant's plan, and a
 * PRESSABLE WRITE button in the UI would advertise one no tenant principal can ever use. The
 * distribution path for a multi-site operator is the same deployment tooling (Ansible/Helm) that
 * distributes `SCP_OPERATOR_TOKEN`, PUTting the same freeze to each instance — a platform freeze
 * does not and cannot federate (0086's header).
 *
 * A READ-ONLY CARD DOES EXIST (M25.UI increment 3, `apps/web/src/routes/setup.tsx`'s "Platform
 * freezes" card) — the rationale above is about the WRITE side only, unchanged since M25.3: READ
 * is tenant-facing (this file's own doc, above) precisely so a tenant blocked by one is not left
 * to guess, and a browser session is exactly where that tenant is looking. The card renders every
 * field and points at the operator's real door (the raw route + `x-scp-operator-token`) rather
 * than a button it cannot make work.
 *
 * ============================================================================================
 * NO DECISION AND NO AUDIT EVENT ARE WRITTEN HERE, AND THAT IS NOT AN OVERSIGHT
 * ============================================================================================
 * `insertDecision` and `appendAuditEvent` are both `org_id NOT NULL`, and the audit chain is
 * hash-chained PER ORG. An instance freeze belongs to no org. Attributing it to the org of
 * whichever tenant principal happened to hold the operator token would write a false record into
 * one tenant's chain about an act that binds all of them; fanning it across every org would forge
 * N records for one act. The honest record is the row itself — `updated_at`, `lifted_at`,
 * `lift_reason` — plus the block Decisions the freeze causes, which ARE org-scoped and DO name it
 * (`inputContext.freeze.tier = "platform"`, `id`, `match`). The same is true of all three
 * operator doors that came before this one; none writes an audit event either.
 */

interface InstanceFreezeDbRow extends Record<string, unknown> {
  id: string;
  key: string;
  name: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
  reason: string;
  match_all_environments: boolean;
  match_environment: string | null;
  match_region: string | null;
  atomic: boolean;
  overridable: boolean;
  note: string | null;
  lifted_at: Date | string | null;
  lift_reason: string | null;
  updated_at: Date | string;
}

const iso = (v: Date | string): string =>
  v instanceof Date ? v.toISOString() : new Date(v).toISOString();

function toApi(row: InstanceFreezeDbRow): InstanceFreeze {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    reason: row.reason,
    match: {
      allEnvironments: row.match_all_environments,
      environment: row.match_environment,
      region: row.match_region
    },
    atomic: row.atomic,
    overridable: row.overridable,
    note: row.note,
    liftedAt: row.lifted_at === null ? null : iso(row.lifted_at),
    liftReason: row.lift_reason,
    updatedAt: iso(row.updated_at)
  };
}

const SELECT_COLUMNS = `id, key, name, starts_at, ends_at, reason, match_all_environments,
         match_environment, match_region, atomic, overridable, note, lifted_at, lift_reason,
         updated_at`;

function requireOperator(deps: AppDeps, request: FastifyRequest): void {
  if (!deps.config.operatorToken) {
    throw forbidden(
      "instance freezes are operator-authored: SCP_OPERATOR_TOKEN is not configured on this deployment, so the write surface is closed"
    );
  }
  if (!operatorTokenMatches(request.headers["x-scp-operator-token"], deps.config.operatorToken)) {
    throw forbidden(
      "instance freezes require the deployment operator token (x-scp-operator-token) — no tenant role can grant this, because a platform freeze stops releases for every org on the deployment"
    );
  }
}

export function registerInstanceFreezeRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/v1/instance/freezes",
    schema: {
      response: { 200: InstanceFreezeListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listInstanceFreezes",
        summary:
          "List the instance-scoped (platform) freezes that bind every org on this deployment — including retracted ones, which stay readable so a block Decision's freeze id resolves",
        tags: ["freezes"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      // Inside the tenant transaction, under the table's `tenant_read` RLS policy — the same path
      // gate evaluation takes. No privileged connection anywhere on a tenant read.
      const rows = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const result = await tx.execute<InstanceFreezeDbRow>(sql`
          SELECT id, key, name, starts_at, ends_at, reason, match_all_environments,
                 match_environment, match_region, atomic, overridable, note, lifted_at,
                 lift_reason, updated_at
          FROM instance_freezes
          ORDER BY starts_at DESC, key
        `);
        return result.rows;
      });
      reply.status(200).send({ items: rows.map(toApi) });
    }
  });

  typed.route({
    method: "PUT",
    url: "/api/v1/instance/freezes/:key",
    schema: {
      params: InstanceFreezeKeyParamSchema,
      body: PutInstanceFreezeRequestSchema,
      response: {
        200: InstanceFreezeSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "putInstanceFreeze",
        summary:
          "Declare or edit an instance-scoped (platform) freeze (operator token required — it stops releases for every org on the deployment)",
        tags: ["freezes"]
      }
    },
    handler: async (request, reply) => {
      // Operator, not tenant. The caller is authenticated as an ordinary principal too, so the
      // write is still attributable in the request log and unauthenticated callers never reach the
      // token comparison.
      await requireAuth(deps, request);
      requireOperator(deps, request);

      const body = request.body;
      const startsAt = new Date(body.startsAt);
      const endsAt = new Date(body.endsAt);
      // THE SAME FUNCTION the org tier's two write paths call, not a third copy of the comparison
      // — `assertWindowOrdered`'s docblock is explicit that a second copy is the drift
      // `activeFreezesInWindow`'s header is about. A row with `ends_at <= starts_at` reads as
      // permanently inactive to the half-open window predicate with nobody having lifted it, and
      // 0086's `instance_freezes_window_ck` is the second barrier behind this one.
      assertWindowOrdered(startsAt, endsAt);
      const allEnvironments = body.match.allEnvironments === true;

      await withOperatorDb(deps.config, "instance freezes", async (client) => {
        // ON CONFLICT (key) — the key is the addressing identity, and the `id` is deliberately
        // NOT updated on conflict: a Decision recorded weeks ago names that id and must keep
        // naming the row still in force.
        //
        // `WHERE instance_freezes.lifted_at IS NULL` MAKES A LIFT FINAL, race-free, without a
        // read-then-write check — exactly `liftFreeze`'s idiom one tier down and for the same
        // ruling: a retraction is final and a new freeze is one PUT away. Resurrecting a lifted
        // key would leave the rows that cite its id describing a freeze whose window, reason and
        // match have all silently changed underneath them.
        const result = await client.query<InstanceFreezeDbRow>(
          `INSERT INTO instance_freezes
             (id, key, name, starts_at, ends_at, reason, match_all_environments, match_environment,
              match_region, atomic, overridable, note, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
           ON CONFLICT (key) DO UPDATE SET
             name                   = EXCLUDED.name,
             starts_at              = EXCLUDED.starts_at,
             ends_at                = EXCLUDED.ends_at,
             reason                 = EXCLUDED.reason,
             match_all_environments = EXCLUDED.match_all_environments,
             match_environment      = EXCLUDED.match_environment,
             match_region           = EXCLUDED.match_region,
             atomic                 = EXCLUDED.atomic,
             overridable            = EXCLUDED.overridable,
             note                   = EXCLUDED.note,
             updated_at             = now()
           WHERE instance_freezes.lifted_at IS NULL
           RETURNING ${SELECT_COLUMNS}`,
          [
            uuidv7(),
            request.params.key,
            body.name ?? null,
            startsAt,
            endsAt,
            body.reason,
            allEnvironments,
            allEnvironments ? null : (body.match.environment ?? null),
            allEnvironments ? null : (body.match.region ?? null),
            body.atomic ?? false,
            body.overridable ?? false,
            body.note ?? null
          ]
        );
        const row = result.rows[0];
        if (!row) {
          throw conflict(
            `instance freeze '${request.params.key}' was retracted and a retraction is final — declare a new freeze under a different key rather than re-opening this one`
          );
        }
        reply.status(200).send(toApi(row));
      });
    }
  });

  typed.route({
    method: "DELETE",
    url: "/api/v1/instance/freezes/:key",
    schema: {
      params: InstanceFreezeKeyParamSchema,
      // A BODY ON A DELETE, following `LiftFreezeRequestSchema` and the shipped
      // `DeleteSourceMappingRequestSchema` precedent: the reason is MANDATORY and a free-text
      // governance justification does not belong in a query string.
      body: LiftInstanceFreezeRequestSchema,
      response: {
        200: InstanceFreezeSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "liftInstanceFreeze",
        summary:
          "Retract an instance-scoped (platform) freeze — it stops being in force immediately, whatever endsAt says (operator token required)",
        tags: ["freezes"]
      }
    },
    handler: async (request, reply) => {
      await requireAuth(deps, request);
      requireOperator(deps, request);

      await withOperatorDb(deps.config, "instance freezes", async (client) => {
        // A SOFT retraction (drizzle/0086), 0085's ruling one tier up: the row stays and stays
        // readable through `GET /v1/instance/freezes` forever, because the gate's block Decision
        // and the hold Decision both carry this id in `inputContext` permanently and a hard DELETE
        // would make `scp change explain` name an id that resolves to nothing.
        //
        // The conditional `WHERE lifted_at IS NULL` makes a second lift a race-free REFUSAL rather
        // than a read-then-write check: `lifted_at`/`lift_reason` are a single record of when this
        // was retracted and why, and letting a repeat caller overwrite them would replace the
        // reason that was actually given.
        const result = await client.query<InstanceFreezeDbRow>(
          `UPDATE instance_freezes
              SET lifted_at = now(), lift_reason = $2, updated_at = now()
            WHERE key = $1 AND lifted_at IS NULL
            RETURNING ${SELECT_COLUMNS}`,
          [request.params.key, request.body.reason]
        );
        const row = result.rows[0];
        if (!row) {
          // Distinguish "no such key" from "already lifted" — the second is a 409 naming when and
          // why, so the caller learns who got there first instead of being told it never existed.
          const existing = await client.query<InstanceFreezeDbRow>(
            `SELECT ${SELECT_COLUMNS} FROM instance_freezes WHERE key = $1`,
            [request.params.key]
          );
          const before = existing.rows[0];
          if (!before) throw notFound(`instance freeze '${request.params.key}' not found`);
          throw conflict(
            `instance freeze '${request.params.key}' was already lifted at ${iso(before.lifted_at!)} (${before.lift_reason ?? "no reason recorded"}) — a lift records when it was retracted and why, and is not overwritten`
          );
        }
        reply.status(200).send(toApi(row));
      });
    }
  });
}
