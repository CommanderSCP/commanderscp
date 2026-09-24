import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { OpsRunMaterialSchema, OpsRunRedemptionRequestSchema, ProblemSchema } from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { ProblemError, badRequest, conflict, tooManyRequests, unauthorized } from "../errors.js";
import { PokeRateLimiter } from "../federation/poke-rate-limit.js";
import { redeemOpsRun, type RedemptionRefusal } from "../coordination/ops-run-redemption.js";

/**
 * THE REDEEM DOOR for host ops run by an org's Argo Workflows (M28.2, ADR-0054).
 *
 * MACHINE-TO-MACHINE AND BEARER-LESS, by construction rather than by omission. The caller is a
 * `scp-ops-v1` pod in a cluster SCP does not control; it holds no SCP identity and must not — a PAT
 * in that namespace would be a standing credential readable by the same people this design is
 * trying to keep a host credential away from. The single-use token IS the authentication, and it is
 * bounded to one run's already-derived material (`redeemOpsRun`).
 *
 * WHY THERE IS NO CLI, IaC OR UI SURFACE FOR THIS ROUTE (principle 3's parity, answered): the only
 * legitimate caller is the runner, which speaks HTTP directly because it runs no Node. A CLI verb
 * would be a way for a human to spend a run's token, which is the theft this door exists to make
 * loud; IaC declares desired state and a redemption is not state; the UI's read side is the issuance
 * list and the audit chain, both already surfaced. The SDK carries it (generated, plus the
 * `ScpClient` wrapper) so the contract is exercised through the public API like every other route.
 */

/** Per-caller-address limit. Unattributable guesses (a forged org or run id) write no audit event,
 *  so this is what bounds them; a legitimate pod redeems exactly once. */
export const opsRedemptionRateLimiter = new PokeRateLimiter({
  capacity: 10,
  refillIntervalMs: 6_000
});

function problemFor(refusal: RedemptionRefusal, detail: string): ProblemError {
  switch (refusal) {
    case "malformed":
      return badRequest(detail);
    case "unknown":
    case "bad_secret":
      // One answer for both, so a guesser cannot tell a real run id from a wrong secret.
      return unauthorized("the run token is not valid");
    case "expired":
      return new ProblemError(410, "Gone", { detail });
    case "replayed":
    case "burned":
    case "authority_changed":
      return conflict(detail);
  }
}

export function registerOpsRunRedemptionRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/v1/ops-run-redemptions",
    schema: {
      body: OpsRunRedemptionRequestSchema,
      response: {
        200: OpsRunMaterialSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        409: ProblemSchema,
        410: ProblemSchema,
        429: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "redeemOpsRun",
        summary:
          "Redeem a host-ops run's one-time token (M28.2, ADR-0054). Called by the `scp-ops-v1` runner pod on an org's Argo Workflows, with the token it unsealed and a public key it generated; returns the run's server-derived bound (role, inventory, egress allowlist, principals, role arguments) and a certificate from the domain's CA over that key. Single-use, valid for the certificate's own TTL, bound to one wave target; a second presentation is refused (409) and audited as the stolen-token signal. Authenticated by the token, not a bearer",
        tags: ["infrastructure"]
      }
    },
    handler: async (request, reply) => {
      if (!opsRedemptionRateLimiter.tryConsume(request.ip)) {
        throw tooManyRequests("too many run redemptions from this address");
      }
      const result = await redeemOpsRun(deps.db, {
        token: request.body.token,
        publicKey: request.body.publicKey,
        masterKey: deps.config.secretsMasterKey,
        requestId: request.id,
        remoteAddress: request.ip
      });
      if (!result.ok) throw problemFor(result.refusal, result.detail);
      const m = result.material;
      return reply.code(200).send({
        runId: m.runId,
        opsRole: m.opsRole,
        opsInventory: m.opsInventory,
        opsEgressAllowlist: m.opsEgressAllowlist,
        opsPrincipals: m.opsPrincipals,
        roleArguments: m.roleArguments,
        certificate: m.certificate,
        serial: m.serial,
        keyId: m.keyId,
        expiresAt: m.expiresAt.toISOString(),
        sourceAddress: m.sourceAddress
      });
    }
  });
}
