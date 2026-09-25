import type pg from "pg";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  CreateInstanceOperatorGrantRequestSchema,
  InstanceAuditEventListSchema,
  InstanceOperatorGrantListSchema,
  InstanceOperatorGrantParamSchema,
  InstanceOperatorGrantSchema,
  InstanceOperatorSelfSchema,
  ProblemSchema,
  type InstanceActor,
  type InstanceOperatorGrant
} from "@scp/schemas";
import type { ServerConfig } from "../config.js";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import {
  appendInstanceAudit,
  readInstanceAudit,
  requireInstanceAuthority,
  sessionHoldsInstanceOperator,
  verifyInstanceAuditChain
} from "../auth/instance-authority.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { conflict, notFound } from "../errors.js";
import { withOperatorDb } from "./operator-db.js";

/**
 * THE INSTANCE-OPERATOR ROLE'S DOORS (owner decision 2026-09-25, ADR-0058): who holds it, grant,
 * revoke, and the instance audit chain. Grant and revoke need instance authority themselves — an
 * operator credential (the FIRST grant: the bootstrap env token or a minted credential, no SQL) or
 * a session already holding the role — and each is audited in the same transaction.
 */

const SURFACE = "instance-operator grants";

/** Runs `fn` in ONE transaction on the operator connection — the act and its audit link commit
 *  together or not at all. */
export async function withOperatorTx<T>(
  config: ServerConfig,
  surface: string,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  return withOperatorDb(config, surface, async (client) => {
    await client.query("BEGIN");
    try {
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  });
}

interface GrantRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  user_id: string;
  granted_by: InstanceActor;
  granted_at: Date | string;
  revoked_at: Date | string | null;
  revoked_by: InstanceActor | null;
}

const iso = (v: Date | string | null): string | null =>
  v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString();

/** A user's name, read in its own org's tenant tx (the operator role cannot read `users`). */
async function usernameOf(deps: AppDeps, orgId: string, userId: string): Promise<string | null> {
  return withTenantTx(deps.db, orgId, async (tx) => {
    const res = await tx.execute<{ username: string }>(
      sql`SELECT username FROM users WHERE id = ${userId} AND org_id = ${orgId}`
    );
    return res.rows[0]?.username ?? null;
  });
}

async function toApi(deps: AppDeps, r: GrantRow): Promise<InstanceOperatorGrant> {
  return {
    id: r.id,
    orgId: r.org_id,
    userId: r.user_id,
    username: (await usernameOf(deps, r.org_id, r.user_id)) ?? "",
    grantedBy: r.granted_by,
    grantedAt: iso(r.granted_at)!,
    revokedAt: iso(r.revoked_at),
    revokedBy: r.revoked_by
  };
}

/** Grants the role inside an operator transaction; `null` when a live grant already exists. */
export async function insertInstanceOperatorGrant(
  client: pg.PoolClient,
  input: { orgId: string; userId: string; actor: InstanceActor; requestId: string }
): Promise<GrantRow | null> {
  const res = await client.query<GrantRow>(
    `INSERT INTO instance_operator_grants (id, org_id, user_id, granted_by)
       VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (org_id, user_id) WHERE revoked_at IS NULL DO NOTHING
     RETURNING id, org_id, user_id, granted_by, granted_at, revoked_at, revoked_by`,
    [uuidv7(), input.orgId, input.userId, JSON.stringify(input.actor)]
  );
  const row = res.rows[0];
  if (!row) return null;
  await appendInstanceAudit(client, {
    action: "instance.operator.grant",
    actor: input.actor,
    subject: row.id,
    detail: { orgId: input.orgId, userId: input.userId },
    requestId: input.requestId
  });
  return row;
}

/**
 * THE M29.1 INSTALLER'S SEAM. With `SCP_BOOTSTRAP_INSTANCE_OPERATOR=1` (chart value
 * `instanceOperator.grantBootstrapAdmin`) the api process grants the role to the bootstrap admin
 * of the bootstrap org — once, only while the deployment has NO live grant at all, audited as
 * `install`. So the first person to log in can operate the stack with no credential and no SQL.
 */
export async function grantBootstrapInstanceOperator(
  deps: AppDeps,
  input: { orgId: string; username: string },
  env: NodeJS.ProcessEnv = process.env
): Promise<"granted" | "exists" | "skipped"> {
  if (env.SCP_BOOTSTRAP_INSTANCE_OPERATOR !== "1") return "skipped";
  const userId = await withTenantTx(deps.db, input.orgId, async (tx) => {
    const res = await tx.execute<{ id: string }>(
      sql`SELECT id FROM users WHERE org_id = ${input.orgId} AND username = ${input.username}`
    );
    return res.rows[0]?.id ?? null;
  });
  if (!userId) return "skipped";
  return withOperatorTx(deps.config, SURFACE, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('scp-bootstrap-instance-operator'))");
    const live = await client.query(
      "SELECT 1 FROM instance_operator_grants WHERE revoked_at IS NULL LIMIT 1"
    );
    if (live.rows.length > 0) return "exists";
    await insertInstanceOperatorGrant(client, {
      orgId: input.orgId,
      userId,
      actor: {
        mechanism: "install",
        orgId: input.orgId,
        userId,
        username: input.username,
        credentialId: null
      },
      requestId: "install"
    });
    return "granted";
  });
}

export function registerInstanceOperatorRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/v1/instance/operators/self",
    schema: { response: { 200: InstanceOperatorSelfSchema, 401: ProblemSchema } },
    config: {
      openapi: {
        operationId: "getInstanceOperatorSelf",
        summary: "Whether the caller's own session holds the instance-operator role",
        tags: ["instance"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      reply.status(200).send({ holdsRole: await sessionHoldsInstanceOperator(deps, auth) });
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/instance/operators",
    schema: {
      response: { 200: InstanceOperatorGrantListSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listInstanceOperators",
        summary: "Every instance-operator grant, live and revoked (instance authority required)",
        tags: ["instance"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireInstanceAuthority(deps, request, SURFACE);
      const rows = await withOperatorDb(
        deps.config,
        SURFACE,
        async (client) =>
          (
            await client.query<GrantRow>(
              `SELECT id, org_id, user_id, granted_by, granted_at, revoked_at, revoked_by
               FROM instance_operator_grants ORDER BY granted_at`
            )
          ).rows
      );
      const items = await Promise.all(rows.map((r) => toApi(deps, r)));
      reply.status(200).send({ items, callerHoldsRole: actor.mechanism === "session-role" });
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/instance/operators",
    schema: {
      body: CreateInstanceOperatorGrantRequestSchema,
      response: {
        201: InstanceOperatorGrantSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "grantInstanceOperator",
        summary:
          "Grant the instance-operator role to a user — the authority to change the Standard Stack for every org (instance authority required; audited)",
        tags: ["instance"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireInstanceAuthority(deps, request, SURFACE);
      const { orgId, userId } = request.body;
      if ((await usernameOf(deps, orgId, userId)) === null) {
        throw notFound(`no user ${userId} in org ${orgId}`);
      }
      const row = await withOperatorTx(deps.config, SURFACE, (client) =>
        insertInstanceOperatorGrant(client, { orgId, userId, actor, requestId: request.id })
      );
      if (!row) throw conflict("that user already holds the instance-operator role");
      reply.status(201).send(await toApi(deps, row));
    }
  });

  typed.route({
    method: "DELETE",
    url: "/api/v1/instance/operators/:grantId",
    schema: {
      params: InstanceOperatorGrantParamSchema,
      response: {
        200: InstanceOperatorGrantSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "revokeInstanceOperator",
        summary:
          "Revoke an instance-operator grant (stamps revoked_at; the row and its history remain; audited)",
        tags: ["instance"]
      }
    },
    handler: async (request, reply) => {
      const actor = await requireInstanceAuthority(deps, request, SURFACE);
      const row = await withOperatorTx(deps.config, SURFACE, async (client) => {
        const res = await client.query<GrantRow>(
          `UPDATE instance_operator_grants SET revoked_at = now(), revoked_by = $2::jsonb
            WHERE id = $1 AND revoked_at IS NULL
            RETURNING id, org_id, user_id, granted_by, granted_at, revoked_at, revoked_by`,
          [request.params.grantId, JSON.stringify(actor)]
        );
        const r = res.rows[0];
        if (r) {
          await appendInstanceAudit(client, {
            action: "instance.operator.revoke",
            actor,
            subject: r.id,
            detail: { orgId: r.org_id, userId: r.user_id },
            requestId: request.id
          });
        }
        return r ?? null;
      });
      if (!row) throw notFound("no live instance-operator grant with that id");
      reply.status(200).send(await toApi(deps, row));
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/instance/audit-events",
    schema: {
      response: { 200: InstanceAuditEventListSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listInstanceAuditEvents",
        summary:
          "The instance audit chain (stack changes, operator grants), re-verified end to end (instance authority required)",
        tags: ["instance"]
      }
    },
    handler: async (request, reply) => {
      await requireInstanceAuthority(deps, request, "the instance audit log");
      const items = await withOperatorDb(deps.config, "the instance audit log", readInstanceAudit);
      const v = verifyInstanceAuditChain(items);
      reply.status(200).send({ items, chainValid: v.valid, brokenAt: v.brokenAt });
    }
  });
}
