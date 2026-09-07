import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  InstanceScanExclusionAdmissionListResponseSchema,
  InstanceScanExclusionAdmissionTierParamSchema,
  ProblemSchema,
  PutInstanceScanExclusionAdmissionsRequestSchema,
  type InstanceScanExclusionAdmission
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { withOperatorDb } from "./operator-db.js";
import { requireInstanceOperator } from "../auth/operator-auth.js";

/** M22.9 — THE INSTANCE-SCOPED EXCLUSION ADMISSIONS' API SURFACE. See docs/routes.md §255. */

interface AdmissionRow extends Record<string, unknown> {
  tier: string;
  class: string;
  origin: string;
  note: string | null;
  updated_at: Date | string;
}

function toApi(row: AdmissionRow): InstanceScanExclusionAdmission {
  return {
    tier: row.tier as InstanceScanExclusionAdmission["tier"],
    class: row.class as InstanceScanExclusionAdmission["class"],
    origin: row.origin as InstanceScanExclusionAdmission["origin"],
    note: row.note,
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

export function registerInstanceScanExclusionAdmissionRoutes(
  app: FastifyInstance,
  deps: AppDeps
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/v1/instance/scan-exclusion-admissions",
    schema: {
      response: {
        200: InstanceScanExclusionAdmissionListResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "listInstanceScanExclusionAdmissions",
        summary:
          "List the instance-scoped exclusion admissions (platform + trust domain) that gate every scan exclusion beneath them on this deployment (ADR-0033)",
        tags: ["governance"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      // Read inside the tenant transaction, under the table's tenant-read RLS policy — the same path
      // the gate's `readInstanceScanExclusionAdmissions` takes. No privileged connection on a read.
      const rows = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const result = await tx.execute<AdmissionRow>(sql`
          SELECT tier, class, origin, note, updated_at
          FROM scan_exclusion_admissions
          ORDER BY tier, class, origin
        `);
        return result.rows;
      });
      reply.status(200).send({ items: rows.map(toApi) });
    }
  });

  typed.route({
    method: "PUT",
    url: "/api/v1/instance/scan-exclusion-admissions/:tier",
    schema: {
      params: InstanceScanExclusionAdmissionTierParamSchema,
      body: PutInstanceScanExclusionAdmissionsRequestSchema,
      response: {
        200: InstanceScanExclusionAdmissionListResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "putInstanceScanExclusionAdmissions",
        summary:
          "Replace the exclusion classes admitted at one instance tier (operator token required — an admission opens a loosening for every org on the deployment; ADR-0033)",
        tags: ["governance"]
      }
    },
    handler: async (request, reply) => {
      // Operator, not tenant. Authenticate the caller as an ordinary principal too, so the write is
      // still attributable and unauthenticated callers never reach the token comparison.
      await requireAuth(deps, request);
      await requireInstanceOperator(deps, request, "scan-exclusion admissions");

      const { tier } = request.params;
      const body = request.body;
      const classes = [...new Set(body.classes)];
      const origin = body.origin;
      const note = body.note ?? null;

      await withOperatorDb(deps.config, "scan-exclusion admissions", async (client) => {
        try {
          // ONE TRANSACTION, because this is a REPLACE and a gate evaluating between the delete and
          // the insert would read a set the operator never authored — for the two rungs that gate
          // every exclusion beneath them, that window is a moment where every clause on the
          // deployment silently stops applying.
          await client.query("BEGIN");
          await client.query(
            `DELETE FROM scan_exclusion_admissions
              WHERE tier = $1 AND origin = $2 AND NOT (class = ANY($3::text[]))`,
            [tier, origin, classes]
          );
          for (const cls of classes) {
            await client.query(
              `INSERT INTO scan_exclusion_admissions (tier, class, origin, note, updated_at)
               VALUES ($1, $2, $3, $4, now())
               ON CONFLICT (tier, class, origin) DO UPDATE SET
                 note       = EXCLUDED.note,
                 updated_at = now()`,
              [tier, cls, origin, note]
            );
          }
          const result = await client.query<AdmissionRow>(
            `SELECT tier, class, origin, note, updated_at
               FROM scan_exclusion_admissions
              WHERE tier = $1 AND origin = $2
              ORDER BY class`,
            [tier, origin]
          );
          await client.query("COMMIT");
          // The read-back is scoped to the `(tier, origin)` that was authored, so the response is
          // exactly the set this request asserted — never widened by a row of another origin that
          // the operator did not write and cannot see the provenance of from here.
          reply.status(200).send({ items: result.rows.map(toApi) });
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw err;
        }
      });
    }
  });
}
