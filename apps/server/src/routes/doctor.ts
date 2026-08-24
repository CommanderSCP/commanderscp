import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { DoctorReportSchema, ProblemSchema, type DoctorCheck } from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { forbidden, unauthorized } from "../errors.js";
import {
  describeFederationSelfOriginFinding,
  inspectFederationSelfOrigin
} from "../federation/self-origin-check.js";

/** Operator-token gate (the `x-scp-operator-token` pattern governance-move/scan-db use): the instance
 *  doctor answers to the DEPLOYMENT operator, not a tenant bearer — its checks are instance-wide
 *  facts (DSN, recovery state, delivery config) no org owns. Unset token = closed (503-style refuse). */
function requireOperatorToken(deps: AppDeps, request: FastifyRequest): void {
  const configured = deps.config.operatorToken;
  if (!configured) {
    throw forbidden(
      "instance doctor requires the deployment operator token (x-scp-operator-token), which is not " +
        "configured on this instance"
    );
  }
  const presented = request.headers["x-scp-operator-token"];
  const a = Buffer.from(typeof presented === "string" ? presented : "");
  const b = Buffer.from(configured);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw unauthorized("invalid or missing operator token (x-scp-operator-token)");
  }
}

/**
 * `GET /api/v1/doctor` — operational self-checks for the CALLER'S OWN org (`scp doctor`).
 *
 * READ-ONLY, and there is deliberately no companion repair endpoint: see `packages/schemas/doctor.ts`
 * and `graph/integrity-repo.ts` for the same argument. Tenant-scoped like every other report, so one
 * org's operator can never inspect another's. The INSTANCE-wide form of the same checks runs once at
 * boot (`main.ts` -> `federation/self-origin-check.ts::warnOnFederationSelfOriginDivergence`) —
 * that one can span orgs because it answers to the operator of the instance, not to a bearer token.
 *
 * Nothing here may be added to the reconcile hot path. These checks exist BECAUSE a per-tick probe
 * was rejected: it costs a query on a one-second loop and floods the log for a legitimately idle org.
 */
export function registerDoctorRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "GET",
    url: "/api/v1/doctor",
    schema: {
      response: { 200: DoctorReportSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "doctorReport",
        summary: "Operational self-checks for this org (read-only; never repairs)",
        tags: ["doctor"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const checks = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // `federation:read` because the only check today compares this org's federation identity
        // against its objects' origins — the same class of data `GET /federation/self` returns, and
        // the finding names peer domain ids. A future check that reads OUTSIDE federation state must
        // widen this deliberately (per-check authorization or the union), not inherit it by accident.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:read",
          scopeObjectId: auth.orgId
        });

        const selfOrigin = await inspectFederationSelfOrigin(tx, auth.orgId);
        const result: DoctorCheck[] = [
          {
            id: "federation-self-origin",
            status: selfOrigin.diverged ? "warn" : "ok",
            summary: selfOrigin.diverged
              ? `coordination for this org is silently doing NOTHING: none of its ${selfOrigin.liveObjectCount} live objects were authored under federation_self.domain_id`
              : `federation identity matches this org's objects (${selfOrigin.selfOriginObjectCount} of ${selfOrigin.liveObjectCount} live objects authored locally)`,
            detail: describeFederationSelfOriginFinding(selfOrigin)
          }
        ];
        return result;
      });
      reply.status(200).send({ checks });
    }
  });

  // §7.3 — INSTANCE-WIDE operational self-checks (`scp doctor instance`), operator-token-gated
  // because these are deployment facts no tenant bearer owns: DSN reachability, whether this process
  // is (wrongly) pointed at a read replica, the S3 delivery allowlist, and — pending M26.3's dial
  // list (D3) — honest "not configured" placeholders for mTLS SAN coverage and XO readiness.
  typed.route({
    method: "GET",
    url: "/api/v1/doctor/instance",
    schema: {
      response: { 200: DoctorReportSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "doctorInstanceReport",
        summary: "Instance-wide operational self-checks (operator-token-gated; read-only)",
        tags: ["doctor"]
      }
    },
    handler: async (request, reply) => {
      requireOperatorToken(deps, request);
      const checks: DoctorCheck[] = [];

      // DSN reachability + recovery state, in one round trip on the runtime pool.
      try {
        const rows = await deps.db.execute<{ in_recovery: boolean }>(
          sql`SELECT pg_is_in_recovery() AS in_recovery`
        );
        // drizzle's node-postgres execute returns a QueryResult-like with `.rows`.
        const inRecovery = Boolean(
          (rows as unknown as { rows?: Array<{ in_recovery?: unknown }> }).rows?.[0]?.in_recovery
        );
        checks.push({
          id: "dsn-reachability",
          status: "ok",
          summary: "the configured database endpoint is reachable and answered a query",
          detail: "the runtime pool answered `SELECT pg_is_in_recovery()`"
        });
        checks.push({
          id: "pg-recovery-state",
          status: inRecovery ? "warn" : "ok",
          summary: inRecovery
            ? "this process is connected to a Postgres in RECOVERY (a read replica) — writes will fail; point SCP_DATABASE_URL at the writable primary/failover endpoint"
            : "connected to the writable primary (pg_is_in_recovery() = false)",
          detail: inRecovery
            ? "Every correctness primitive (advisory locks, SKIP LOCKED, sequence uniqueness) needs the primary. A member cluster must dial the operator's failover-stable primary endpoint, never a replica (§5-I2)."
            : "pg_is_in_recovery() = false — this is the writable primary, as required."
        });
      } catch (err) {
        checks.push({
          id: "dsn-reachability",
          status: "warn",
          summary: "the database endpoint did not answer a probe query",
          detail: err instanceof Error ? err.message : String(err)
        });
      }

      // S3 delivery allowlist consistency (§7.4): the env allowlist every member cluster must set
      // identically. We can only report THIS process's view; cross-cluster equality is a runbook check.
      const s3Endpoints = (process.env.SCP_DELIVERY_S3_ENDPOINTS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      checks.push({
        id: "delivery-s3-endpoints",
        status: "ok",
        summary:
          s3Endpoints.length > 0
            ? `${s3Endpoints.length} S3 delivery endpoint(s) allowlisted on this process`
            : "no S3 delivery endpoints allowlisted (filesystem/RWX delivery only)",
        detail:
          s3Endpoints.length > 0
            ? `SCP_DELIVERY_S3_ENDPOINTS must be IDENTICAL across every member cluster (§7.4) — this process sees: ${s3Endpoints.join(", ")}`
            : "SCP_DELIVERY_S3_ENDPOINTS is unset; only filesystem/RWX delivery targets are usable here."
      });

      // mTLS SAN coverage + XO readiness depend on M26.3's ordered dial-URL list (D3), not yet built.
      // Report honestly rather than assume a feature exists (charter: no fabricated liveness).
      checks.push({
        id: "mtls-san-coverage",
        status: deps.config.federationServerMtls ? "ok" : "warn",
        summary: deps.config.federationServerMtls
          ? "federation server mTLS is configured"
          : "federation server mTLS is not configured (bearer-only federation transport)",
        detail:
          "Automatic SAN coverage of every dial name requires the ordered dial-URL list (D3), which is M26.3 work; until then the runbook (docs/runbooks/resilience.md §5-I3) verifies the cert's SANs cover every dial name by hand."
      });
      checks.push({
        id: "xo-readiness",
        status: "warn",
        summary: "XO (standby member cluster) readiness is not yet checkable",
        detail:
          "The ordered dial-URL list (D3) that names the XO's fallback dial entry is M26.3 work; this check is a placeholder that will verify secrets/mTLS/replica-current/dial-entry once it lands."
      });

      reply.status(200).send({ checks });
    }
  });
}
