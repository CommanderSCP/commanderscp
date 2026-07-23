import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import pg from "pg";
import {
  ProblemSchema,
  PutScannerAssignmentRequestSchema,
  ScannerAssignmentListResponseSchema,
  ScannerAssignmentSchema,
  ScanMethodSchema,
  type ScanMethod,
  type ScannerAssignment
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { forbidden } from "../errors.js";

/**
 * M13.3a — the SCANNER-ASSIGNMENT REGISTRY's API surface (ADR-0020 §2, proposal §13.3), API-first
 * per charter principle 3 (API -> SDK -> CLI). This is the DELIBERATE TWIN of
 * `routes/instance-scan-floors.ts`: same two-audiences / two-credentials shape, same operator-write
 * mechanics, because scanner assignments are instance-scoped config exactly as scan floors are.
 *
 *  - **READ is tenant-facing.** Any authenticated tenant principal may see the assignments — a scan
 *    step / gate a tenant cannot inspect is not explainable (charter principle 6). The read runs
 *    inside the ordinary tenant transaction under the table's tenant-read RLS policy (drizzle/0035),
 *    the same path `resolveScannersForType` takes; it leaks nothing across tenants because the table
 *    holds NO per-tenant rows — it is instance-wide configuration.
 *
 *  - **WRITE is operator-only, and deliberately NOT an RBAC permission.** These assignments bind
 *    EVERY org on the deployment; a tenant admin must never author them. So no role can grant it: the
 *    write requires the deployment-level `SCP_OPERATOR_TOKEN` (config.operatorToken), presented as
 *    `x-scp-operator-token`, and executes over the ADMIN connection because the request-serving
 *    `scp_app` role holds no write grant on the table and no write RLS policy exists for it
 *    (drizzle/0035 — two independent barriers, mirrored from 0029). Unset token ⇒ the surface is
 *    CLOSED (403), never a fallback to a tenant credential.
 */

interface AssignmentRow extends Record<string, unknown> {
  executor_type: string;
  methods: unknown;
  updated_at: Date | string;
}

function parseMethods(raw: unknown): ScanMethod[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<ScanMethod>();
  for (const entry of raw) {
    const parsed = ScanMethodSchema.safeParse(entry);
    if (parsed.success) seen.add(parsed.data);
  }
  return [...seen];
}

function toApi(row: AssignmentRow): ScannerAssignment {
  return {
    executorType: row.executor_type as ScannerAssignment["executorType"],
    methods: parseMethods(row.methods),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

/** Constant-time comparison of the presented operator token against the configured one — a
 *  length-leaking `===` on a shared secret is exactly what a security review flags. Identical to the
 *  instance-scan-floors check on purpose (same secret, same posture). */
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
      "scanner assignments are operator-authored: SCP_OPERATOR_TOKEN is not configured on this deployment, so the write surface is closed"
    );
  }
  if (!operatorTokenMatches(request.headers["x-scp-operator-token"], deps.config.operatorToken)) {
    throw forbidden(
      "scanner assignments require the deployment operator token (x-scp-operator-token) — no tenant role can grant this, because these assignments bind every org on the deployment"
    );
  }
}

export function registerScannerAssignmentRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/v1/instance/scanner-assignments",
    schema: {
      response: {
        200: ScannerAssignmentListResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "listScannerAssignments",
        summary:
          "List the instance-scoped scanner assignments (executor Type -> managed scan methods) that bind every org on this deployment (ADR-0020)",
        tags: ["governance"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      // Read inside the tenant transaction, under the table's tenant-read RLS policy — the same path
      // `resolveScannersForType` takes. No privileged connection anywhere on a tenant read.
      const rows = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const result = await tx.execute<AssignmentRow>(sql`
          SELECT executor_type, methods, updated_at
          FROM scanner_assignments
          ORDER BY executor_type
        `);
        return result.rows;
      });
      reply.status(200).send({ items: rows.map(toApi) });
    }
  });

  typed.route({
    method: "PUT",
    url: "/api/v1/instance/scanner-assignments",
    schema: {
      body: PutScannerAssignmentRequestSchema,
      response: { 200: ScannerAssignmentSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "putScannerAssignment",
        summary:
          "Assign managed scan methods to an executor Type (operator token required — these bind every org on the deployment; ADR-0020)",
        tags: ["governance"]
      }
    },
    handler: async (request, reply) => {
      // Operator, not tenant. Authenticate the caller as an ordinary principal too, so the write is
      // still attributable and unauthenticated callers never reach the token comparison.
      await requireAuth(deps, request);
      requireOperator(deps, request);

      const body = request.body;
      // De-duplicate while preserving that Zod already proved every element is a valid ScanMethod.
      const methods = [...new Set(body.methods)];

      const pool = new pg.Pool({ connectionString: deps.config.databaseUrl, max: 1 });
      try {
        const result = await pool.query<AssignmentRow>(
          `INSERT INTO scanner_assignments (executor_type, methods, updated_at)
           VALUES ($1, $2::jsonb, now())
           ON CONFLICT (executor_type) DO UPDATE SET
             methods    = EXCLUDED.methods,
             updated_at = now()
           RETURNING executor_type, methods, updated_at`,
          [body.executorType, JSON.stringify(methods)]
        );
        reply.status(200).send(toApi(result.rows[0]!));
      } finally {
        await pool.end();
      }
    }
  });
}
