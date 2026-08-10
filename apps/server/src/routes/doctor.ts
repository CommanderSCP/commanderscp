import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { DoctorReportSchema, ProblemSchema, type DoctorCheck } from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import {
  describeFederationSelfOriginFinding,
  inspectFederationSelfOrigin
} from "../federation/self-origin-check.js";

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
}
