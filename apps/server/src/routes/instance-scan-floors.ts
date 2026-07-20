import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import pg from "pg";
import {
  InstanceScanFloorListResponseSchema,
  InstanceScanFloorSchema,
  InstanceScanFloorTierParamSchema,
  ProblemSchema,
  PutInstanceScanFloorRequestSchema,
  type InstanceScanFloor
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { forbidden } from "../errors.js";

/**
 * M17.5 — the INSTANCE-SCOPED scan-requirement floors' API surface (ADR-0016 §3), API-first per
 * charter principle 3 (API -> SDK -> CLI).
 *
 * TWO DIFFERENT AUDIENCES, TWO DIFFERENT CREDENTIALS — this is the whole point of the resource:
 *
 *  - **READ is tenant-facing.** Any authenticated tenant principal may see the floors that bind
 *    them, because a gate they cannot inspect is not explainable (charter principle 6). The read
 *    runs inside the ordinary tenant transaction under the table's tenant-read RLS policy — the
 *    same path gate evaluation uses, so no request path needs the privileged connection to evaluate
 *    a gate (ADR-0016 §3). It leaks nothing across tenants because the table holds NO per-tenant
 *    rows at all: it is instance-wide configuration, identical for every org on the deployment.
 *
 *  - **WRITE is operator-only, and deliberately NOT an RBAC permission.** These floors bind EVERY
 *    org on the deployment; a tenant admin — however privileged inside their own org — must never
 *    author or loosen them. So no role can grant it: the write requires the deployment-level
 *    `SCP_OPERATOR_TOKEN` (config.operatorToken), presented as `x-scp-operator-token`, and executes
 *    over the ADMIN connection because the request-serving `scp_app` role holds no write grant on
 *    the table and no write RLS policy exists for it (drizzle/0029 — two independent barriers).
 *    Unset token ⇒ the surface is CLOSED (403), never a fallback to a tenant credential.
 *
 * The write path opening a short-lived admin connection is the deliberate asymmetry ADR-0016 §3
 * settles on: rejected option (b) was routing tenant-request READS through the privileged
 * connection (every read path would then hand-guarantee what RLS guarantees structurally). Operator
 * WRITES are a different thing entirely — they are not tenant requests, they happen rarely
 * (configuration, not traffic), and they are exactly what "operator-write" means.
 */

interface FloorRow extends Record<string, unknown> {
  tier: string;
  origin: string;
  max_critical: number | null;
  max_high: number | null;
  max_medium: number | null;
  max_low: number | null;
  note: string | null;
  updated_at: Date | string;
}

function toApi(row: FloorRow): InstanceScanFloor {
  return {
    tier: row.tier as InstanceScanFloor["tier"],
    origin: row.origin as InstanceScanFloor["origin"],
    maxCritical: row.max_critical,
    maxHigh: row.max_high,
    maxMedium: row.max_medium,
    maxLow: row.max_low,
    note: row.note,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

/** Constant-time comparison of the presented operator token against the configured one — a
 *  length-leaking `===` on a shared secret is exactly the kind of thing a security review flags. */
function operatorTokenMatches(presented: unknown, configured: string | undefined): boolean {
  if (!configured || typeof presented !== "string" || presented.length === 0) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(configured, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function requireOperator(deps: AppDeps, request: FastifyRequest): void {
  if (!deps.config.operatorToken) {
    throw forbidden(
      "instance scan floors are operator-authored: SCP_OPERATOR_TOKEN is not configured on this deployment, so the write surface is closed"
    );
  }
  if (!operatorTokenMatches(request.headers["x-scp-operator-token"], deps.config.operatorToken)) {
    throw forbidden(
      "instance scan floors require the deployment operator token (x-scp-operator-token) — no tenant role can grant this, because these floors bind every org on the deployment"
    );
  }
}

export function registerInstanceScanFloorRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/v1/instance/scan-floors",
    schema: {
      response: { 200: InstanceScanFloorListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listInstanceScanFloors",
        summary:
          "List the instance-scoped scan-requirement floors (platform + trust domain) that bind every org on this deployment (ADR-0016)",
        tags: ["governance"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      // Read inside the tenant transaction, under the table's tenant-read RLS policy — the same
      // path gate evaluation takes. No privileged connection anywhere on a tenant read.
      const rows = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const result = await tx.execute<FloorRow>(sql`
          SELECT tier, origin, max_critical, max_high, max_medium, max_low, note, updated_at
          FROM scan_requirement_floors
          ORDER BY tier, origin
        `);
        return result.rows;
      });
      reply.status(200).send({ items: rows.map(toApi) });
    }
  });

  typed.route({
    method: "PUT",
    url: "/api/v1/instance/scan-floors/:tier",
    schema: {
      params: InstanceScanFloorTierParamSchema,
      body: PutInstanceScanFloorRequestSchema,
      response: { 200: InstanceScanFloorSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "putInstanceScanFloor",
        summary:
          "Author an instance-scoped scan-requirement floor (operator token required — these bind every org on the deployment; ADR-0016)",
        tags: ["governance"]
      }
    },
    handler: async (request, reply) => {
      // Operator, not tenant. Authenticate the caller as an ordinary principal too, so the write is
      // still attributable and unauthenticated callers never reach the token comparison.
      await requireAuth(deps, request);
      requireOperator(deps, request);

      const body = request.body;
      // `null` explicitly CLEARS a ceiling (that severity stops contributing to the MIN); `undefined`
      // is normalized to null so a PUT is a full replace of the row, never a confusing partial merge.
      const val = (v: number | null | undefined): number | null => (v === undefined ? null : v);

      const pool = new pg.Pool({ connectionString: deps.config.databaseUrl, max: 1 });
      try {
        const result = await pool.query<FloorRow>(
          `INSERT INTO scan_requirement_floors
             (tier, origin, max_critical, max_high, max_medium, max_low, note, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (tier, origin) DO UPDATE SET
             max_critical = EXCLUDED.max_critical,
             max_high     = EXCLUDED.max_high,
             max_medium   = EXCLUDED.max_medium,
             max_low      = EXCLUDED.max_low,
             note         = EXCLUDED.note,
             updated_at   = now()
           RETURNING tier, origin, max_critical, max_high, max_medium, max_low, note, updated_at`,
          [
            request.params.tier,
            body.origin,
            val(body.maxCritical),
            val(body.maxHigh),
            val(body.maxMedium),
            val(body.maxLow),
            body.note ?? null
          ]
        );
        reply.status(200).send(toApi(result.rows[0]!));
      } finally {
        await pool.end();
      }
    }
  });
}
