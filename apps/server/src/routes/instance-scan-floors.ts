import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
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
import { withOperatorDb } from "./operator-db.js";
import { requireInstanceOperator } from "../auth/operator-auth.js";

/** M17.5 — the INSTANCE-SCOPED scan-requirement floors' API surface. See docs/routes.md §256. */

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
    updatedAt:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
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
      await requireInstanceOperator(deps, request, "instance scan floors");

      const body = request.body;
      // `null` explicitly CLEARS a ceiling (that severity stops contributing to the MIN); `undefined`
      // is normalized to null so a PUT is a full replace of the row, never a confusing partial merge.
      const val = (v: number | null | undefined): number | null => (v === undefined ? null : v);

      await withOperatorDb(deps.config, "instance scan floors", async (client) => {
        const result = await client.query<FloorRow>(
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
      });
    }
  });
}
