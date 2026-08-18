import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import pg from "pg";
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
import { forbidden } from "../errors.js";

/**
 * M22.9 — THE INSTANCE-SCOPED EXCLUSION ADMISSIONS' API SURFACE (ADR-0033 §1, §7a), API-first per
 * charter principle 3 (API -> SDK -> CLI).
 *
 * WHY THIS ROUTE IS NOT A CONVENIENCE. ADR-0033 §1's admission algebra is a monotone AND *down the
 * tier chain*, and `buildScanExclusionTargetInputs` seeds every target's `representedTiers` with
 * `platform` and `trust_domain` UNCONDITIONALLY. `tierForObjectType` structurally cannot return
 * either rung (it maps graph object types, and `containmentChain` is org-rooted), so NO policy at
 * any tier can contribute those two admissions. Their only source is `scan_exclusion_admissions`
 * (drizzle/0066). Until this route existed that table had no writer outside the integration suite's
 * admin pool — so on a real deployment every clause an operator authored failed the AND at the top
 * rung and M22.2 through M22.7 were inert, invisibly, with a green suite. The feature's mandatory
 * precondition was reachable only by hand-written SQL against the database.
 *
 * THE FIVE ORG-AND-BELOW RUNGS GET NOTHING HERE, and that is the correct answer rather than a gap.
 * `org`, `containment_domain`, `service`, `assembly` and `component` admit a class through the
 * ALREADY-SHIPPED `scanExclusion` policy effect — `{"scanExclusion": {"admit": ["vendor_latest"]}}`
 * on an ordinary policy document, written over the ordinary policy door, validated by 0066's
 * `property_schema` and gathered per target by `buildScanExclusionTargetInputs`'s policy loop.
 * That surface is live and covered. A second admission surface for those tiers would be a second
 * construction of one rule (charter principle 2: new concepts arrive as policy data).
 *
 * THE DELIBERATE TWIN OF `routes/instance-scan-floors.ts` — same instance scope, same DESIGN §4.2
 * `org_id` exception, same two audiences and two credentials:
 *
 *  - **READ is tenant-facing.** Any authenticated tenant principal may see which classes this
 *    deployment admits, because a loosening they cannot author and cannot inspect is not
 *    explainable (charter principle 6) — and the shipped default (nothing admitted, every clause
 *    inert) is exactly the state that is invisible without a read. The read runs inside the
 *    ordinary tenant transaction under the table's tenant-read RLS policy, the same path
 *    `readInstanceScanExclusionAdmissions` takes at the gate, so no request path needs the
 *    privileged connection to evaluate a gate (ADR-0016 §3). It leaks nothing across tenants
 *    because the table holds NO per-tenant rows at all.
 *
 *  - **WRITE is operator-only, and deliberately NOT an RBAC permission.** An admission opens a
 *    loosening for EVERY org on the deployment; a tenant admin — however privileged inside their
 *    own org — must never author one, and D3's whole authority argument collapses if they can. So
 *    no role can grant it: the write requires the deployment-level `SCP_OPERATOR_TOKEN`
 *    (config.operatorToken) presented as `x-scp-operator-token`, and executes over the ADMIN
 *    connection because `scp_app` holds no write grant on the table and no write RLS policy exists
 *    for it (drizzle/0066 — two independent barriers). Unset token => the surface is CLOSED (403),
 *    never a fallback to a tenant credential.
 *
 * THE PUT IS A WHOLE-SET REPLACE for one `(tier, origin)`, not an add. An additive verb makes
 * WITHDRAWAL the harder operation, and this is a loosening: an operator who believes they have
 * narrowed the admitted set, but whose request only ever added, would leave the loosening in force
 * with no error anywhere. `{"classes": []}` is therefore the revocation, which is why there is no
 * DELETE verb — a second verb meaning "replace with nothing" would be a second way to say one
 * thing.
 */

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

/** Constant-time comparison of the presented operator token against the configured one — a
 *  length-leaking `===` on a shared secret is exactly what a security review flags. Byte-for-byte
 *  the `instance-scan-floors.ts` / `scanner-assignments.ts` check on purpose (same secret, same
 *  posture). */
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
      "scan-exclusion admissions are operator-authored: SCP_OPERATOR_TOKEN is not configured on this deployment, so the write surface is closed"
    );
  }
  if (!operatorTokenMatches(request.headers["x-scp-operator-token"], deps.config.operatorToken)) {
    throw forbidden(
      "scan-exclusion admissions require the deployment operator token (x-scp-operator-token) — no tenant role can grant this, because an admission opens a loosening for every org on the deployment"
    );
  }
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
      requireOperator(deps, request);

      const { tier } = request.params;
      const body = request.body;
      const classes = [...new Set(body.classes)];
      const origin = body.origin;
      const note = body.note ?? null;

      const pool = new pg.Pool({ connectionString: deps.config.databaseUrl, max: 1 });
      try {
        const client = await pool.connect();
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
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    }
  });
}
