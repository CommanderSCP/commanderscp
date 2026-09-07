import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
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
import { conflict, notFound } from "../errors.js";
import { assertWindowOrdered } from "../governance/freezes-repo.js";
import { withOperatorDb } from "./operator-db.js";
import { requireInstanceOperator } from "../auth/operator-auth.js";

/** M25.3 — THE INSTANCE-SCOPED. See docs/routes.md §251. */

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
      await requireInstanceOperator(deps, request, "instance freezes");

      const body = request.body;
      const startsAt = new Date(body.startsAt);
      const endsAt = new Date(body.endsAt);
      // The same function the org tier calls, not a third copy. See docs/routes.md §252.
      assertWindowOrdered(startsAt, endsAt);
      const allEnvironments = body.match.allEnvironments === true;

      await withOperatorDb(deps.config, "instance freezes", async (client) => {
        // ON CONFLICT (key). See docs/routes.md §253.
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
      await requireInstanceOperator(deps, request, "instance freezes");

      await withOperatorDb(deps.config, "instance freezes", async (client) => {
        // A SOFT retraction (drizzle/0086), 0085's ruling one tier up. See docs/routes.md §254.
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
