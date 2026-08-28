import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
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
import { withOperatorDb } from "./operator-db.js";
import { requireInstanceOperator } from "../auth/operator-auth.js";

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
 *    `x-scp-operator-token`, and executes over the `scp_operator` connection (`withOperatorDb`)
 *    because the request-serving `scp_app` role holds no write grant on the table and no write RLS
 *    policy existed for it at all (drizzle/0035 — two independent barriers, mirrored from 0029;
 *    0076 adds the operator role as the one principal both barriers admit). Unset token ⇒ the
 *    surface is CLOSED (403), never a fallback to a tenant credential.
 *
 *    THAT LINE USED TO READ "the ADMIN connection", AND THE CODE MATCHED IT, AND BOTH WERE WRONG ON
 *    the shape it mattered on: api/worker pods hold no admin credential (the chart gives
 *    `DATABASE_URL` to the migrations Job alone), so the write dialed `config.databaseUrl`'s
 *    `localhost:5432` fallback inside its own pod. `routes/operator-db.ts` has the full account.
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
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
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
      await requireInstanceOperator(deps, request, "scanner assignments");

      const body = request.body;
      // De-duplicate while preserving that Zod already proved every element is a valid ScanMethod.
      const methods = [...new Set(body.methods)];

      await withOperatorDb(deps.config, "scanner assignments", async (client) => {
        const result = await client.query<AssignmentRow>(
          `INSERT INTO scanner_assignments (executor_type, methods, updated_at)
           VALUES ($1, $2::jsonb, now())
           ON CONFLICT (executor_type) DO UPDATE SET
             methods    = EXCLUDED.methods,
             updated_at = now()
           RETURNING executor_type, methods, updated_at`,
          [body.executorType, JSON.stringify(methods)]
        );
        reply.status(200).send(toApi(result.rows[0]!));
      });
    }
  });
}
