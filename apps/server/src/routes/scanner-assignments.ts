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

/** M13.3a — the SCANNER-ASSIGNMENT REGISTRY's API surface. See docs/routes.md §407. */

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
