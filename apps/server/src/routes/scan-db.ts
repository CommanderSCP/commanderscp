import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import pg from "pg";
import {
  LoadScanDbRequestSchema,
  LoadScanDbResponseSchema,
  ProblemSchema,
  PutScanDbStalenessPolicyRequestSchema,
  RefreshScanDbRequestSchema,
  RefreshScanDbResponseSchema,
  ScanDbStalenessPolicySchema,
  ScanDbStatusSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { forbidden, badRequest } from "../errors.js";
import { managedScanServerSettings } from "../coordination/executor-bindings-repo.js";
import {
  loadScanDbBlob,
  readScanDbStalenessPolicy,
  readScanDbStatus,
  refreshScanDbConnected
} from "../governance/scan-db.js";

/**
 * M13.3b-ii — the OFFLINE SCANNER-DB CACHE's API surface (ADR-0020, proposal §13.3b), API-first per
 * charter principle 3 (API -> SDK -> CLI). The DELIBERATE TWIN of `routes/instance-scan-floors.ts`
 * and `routes/scanner-assignments.ts`: same two-audiences / two-credentials shape.
 *
 *  - **READ is tenant-facing** — the DB status + the active staleness policy. A promotion a tenant
 *    cannot explain (blocked because the commander's DB was stale) is not explainable (principle 6),
 *    so the status + thresholds are readable. Neither read exposes per-tenant data (the cache is
 *    instance-wide operational config).
 *
 *  - **WRITE is operator-only** (`SCP_OPERATOR_TOKEN` as `x-scp-operator-token`): the staleness
 *    policy PUT (it binds every org), the connected refresh, and the air-gap operator-load. None is
 *    an RBAC permission — no tenant role may keep the deployment's ONE managed-scan DB. Unset token ⇒
 *    the write surface is CLOSED (403).
 */

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
      "scan-db administration is operator-only: SCP_OPERATOR_TOKEN is not configured on this deployment, so the write surface is closed"
    );
  }
  if (!operatorTokenMatches(request.headers["x-scp-operator-token"], deps.config.operatorToken)) {
    throw forbidden(
      "scan-db administration requires the deployment operator token (x-scp-operator-token) — no tenant role can grant it, because the DB cache binds every org on the deployment"
    );
  }
}

function requireCacheDir(): string {
  const dir = managedScanServerSettings().dbCacheDir;
  if (!dir) {
    throw badRequest(
      "no scan-db cache is configured (SCP_MANAGED_SCAN_DB_CACHE unset) — the runner uses the image-baked DB; enable the cache PVC to refresh/load a DB"
    );
  }
  return dir;
}

export function registerScanDbRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // GET status — tenant-readable.
  typed.route({
    method: "GET",
    url: "/api/v1/instance/scan-db",
    schema: { response: { 200: ScanDbStatusSchema, 401: ProblemSchema, 403: ProblemSchema } },
    config: {
      openapi: {
        operationId: "getScanDbStatus",
        summary:
          "Get the commander's managed-scan vulnerability-DB status — presence, age, source (baked|refreshed|operator-loaded), schema compatibility, staleness, and the active thresholds (ADR-0020)",
        tags: ["governance"]
      }
    },
    handler: async (request, reply) => {
      await requireAuth(deps, request);
      const status = await readScanDbStatus(deps.db, managedScanServerSettings().dbCacheDir);
      reply.status(200).send(status);
    }
  });

  // GET staleness policy — tenant-readable.
  typed.route({
    method: "GET",
    url: "/api/v1/instance/scan-db/staleness-policy",
    schema: { response: { 200: ScanDbStalenessPolicySchema, 401: ProblemSchema, 403: ProblemSchema } },
    config: {
      openapi: {
        operationId: "getScanDbStalenessPolicy",
        summary:
          "Get the instance-scoped scanner-DB staleness policy (soft/hard max age) that binds every org on this deployment (ADR-0020)",
        tags: ["governance"]
      }
    },
    handler: async (request, reply) => {
      await requireAuth(deps, request);
      const policy = await readScanDbStalenessPolicy(deps.db);
      reply.status(200).send(policy);
    }
  });

  // PUT staleness policy — operator-only (admin connection; `scp_app` has no write grant + no write
  // RLS policy on the table — drizzle/0036, two independent barriers).
  typed.route({
    method: "PUT",
    url: "/api/v1/instance/scan-db/staleness-policy",
    schema: {
      body: PutScanDbStalenessPolicyRequestSchema,
      response: { 200: ScanDbStalenessPolicySchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "putScanDbStalenessPolicy",
        summary:
          "Author the instance-scoped scanner-DB staleness policy (operator token required — it binds every org; null resets a bound to the built-in default; ADR-0020)",
        tags: ["governance"]
      }
    },
    handler: async (request, reply) => {
      await requireAuth(deps, request);
      requireOperator(deps, request);
      const body = request.body;
      const val = (v: number | null | undefined): number | null => (v === undefined ? null : v);
      const pool = new pg.Pool({ connectionString: deps.config.databaseUrl, max: 1 });
      try {
        await pool.query(
          `INSERT INTO scan_db_staleness_policy (id, soft_max_age_hours, hard_max_age_hours, note, updated_at)
             VALUES ('default', $1, $2, $3, now())
           ON CONFLICT (id) DO UPDATE SET
             soft_max_age_hours = EXCLUDED.soft_max_age_hours,
             hard_max_age_hours = EXCLUDED.hard_max_age_hours,
             note               = EXCLUDED.note,
             updated_at         = now()`,
          [val(body.softMaxAgeHours), val(body.hardMaxAgeHours), body.note ?? null]
        );
      } finally {
        await pool.end();
      }
      const policy = await readScanDbStalenessPolicy(deps.db);
      reply.status(200).send(policy);
    }
  });

  // POST refresh (connected) — operator-only. skopeo-pull the upstream OCI trivy-db into the cache
  // (atomic swap + schema-compat assertion), under the SCP_ARTIFACT_OCI_REGISTRY_HOSTS allowlist.
  typed.route({
    method: "POST",
    url: "/api/v1/instance/scan-db/refresh",
    schema: {
      body: RefreshScanDbRequestSchema,
      response: { 200: RefreshScanDbResponseSchema, 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "refreshScanDb",
        summary:
          "Refresh the managed-scan vulnerability DB from the upstream OCI registry (connected operator action; allowlisted skopeo pull + atomic swap + schema-compat assertion; ADR-0020)",
        tags: ["governance"]
      }
    },
    handler: async (request, reply) => {
      await requireAuth(deps, request);
      requireOperator(deps, request);
      const cacheDir = requireCacheDir();
      try {
        const meta = await refreshScanDbConnected(cacheDir);
        const status = await readScanDbStatus(deps.db, cacheDir);
        reply.status(200).send({
          refreshed: true,
          status,
          detail: `refreshed to trivy-db schema v${meta.Version}, UpdatedAt ${meta.UpdatedAt}`
        });
      } catch (err) {
        throw badRequest(`scan-db refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  // POST load (air-gap) — operator-only. Verify a cosign-signed DB blob (detached signature + optional
  // digest) then atomically install it into the cache. Paths are SERVER-LOCAL (operator placed the
  // blob after walking it across the CDS) so hundreds of MB never traverse the JSON API.
  typed.route({
    method: "POST",
    url: "/api/v1/instance/scan-db/load",
    schema: {
      body: LoadScanDbRequestSchema,
      response: { 200: LoadScanDbResponseSchema, 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "loadScanDb",
        summary:
          "Load a cosign-signed vulnerability-DB blob into the cache (air-gap operator action; digest-bound + detached-signature verify BEFORE accept, then atomic swap; ADR-0020)",
        tags: ["governance"]
      }
    },
    handler: async (request, reply) => {
      await requireAuth(deps, request);
      requireOperator(deps, request);
      const cacheDir = requireCacheDir();
      const body = request.body;
      try {
        const meta = await loadScanDbBlob({
          cacheDir,
          blobPath: body.blobPath,
          signaturePath: body.signaturePath,
          publicKeyPath: body.publicKeyPath,
          ...(body.expectedDigest ? { expectedDigest: body.expectedDigest } : {})
        });
        const status = await readScanDbStatus(deps.db, cacheDir);
        reply.status(200).send({
          loaded: true,
          status,
          detail: `loaded operator-signed trivy-db schema v${meta.Version}, UpdatedAt ${meta.UpdatedAt}`
        });
      } catch (err) {
        throw badRequest(`scan-db load refused: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
}
