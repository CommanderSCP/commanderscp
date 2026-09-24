import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ArgoOpsPinRequestSchema,
  ArgoOpsPinSchema,
  EnrolTrustDomainRequestSchema,
  ProblemSchema,
  ReconcileSshSerialsRequestSchema,
  SshCertificateIssuanceListSchema,
  SshSerialReconciliationSchema,
  TrustDomainEnrolmentSchema,
  asTrustDomainId
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import {
  activeAuthorityForDomain,
  enrolDomain,
  enrolmentForDomain,
  listIssuances,
  reconcileSerials
} from "../coordination/ssh-ca-repo.js";
import { trustedUserCaKeysFile } from "../coordination/ops-host-enrolment.js";
import {
  ArgoOpsPinInvalid,
  argoOpsPinForDomain,
  putArgoOpsPin
} from "../coordination/ops-argo-pin.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { badRequest, conflict, notFound } from "../errors.js";

/**
 * THE ENROLMENT DOOR and ADR-0051 D5's EVIDENCE SURFACE (M27.9). See docs/routes.md §311.
 *
 * M27.8 built `enrolDomain` and the reconciliation, and M27.9's census found both at zero
 * production callers: no domain could be enrolled through any public surface, so the CA-holding
 * path existed only in tests, and the detective control that is the ONLY bound on CA compromise
 * could never be invoked by anyone. These are those doors.
 *
 * `secret:write` AT THE ORG ROOT for enrolment, matching `change-sources.ts` and `executors.ts`:
 * enrolling MINTS a signing key into the encrypted store, which is a credential operation and not
 * an edit to a graph object. `audit:read` for the evidence surface — it is the detective half of a
 * hash-chained record, and it names real addresses in someone's estate.
 */
export function registerSshCaRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/v1/trust-domains/:domainId/ssh-ca/enrolment",
    schema: {
      params: z.object({ domainId: z.string().uuid() }),
      body: EnrolTrustDomainRequestSchema,
      response: {
        201: TrustDomainEnrolmentSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "enrolTrustDomainSshCa",
        summary:
          "Enrol a trust domain for host-reaching managed execution: mint its per-domain SSH certificate authority and record the independent access path, in ONE transaction. The break-glass path is a PRECONDITION, not metadata — an estate whose only route in is SCP's CA cannot recover from that CA being compromised (ADR-0051), so an empty one is refused. The keypair is minted server-side and never supplied by the caller: a caller-supplied public key could name a private half SCP does not hold. One CA per domain, never fleet-wide (D2); a second enrolment of the same domain is a 409",
        tags: ["infrastructure"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const domainId = asTrustDomainId(request.params.domainId);
      const enrolment = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // `secret:write` at the org root, NOT `object:write`: this mints a signing key.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "secret:write",
          scopeObjectId: auth.orgId
        });
        // CHECKED HERE as well as by the partial unique index, so a second enrolment reads as a
        // sentence rather than a constraint violation. The index is what makes it TRUE.
        const existing = await enrolmentForDomain(tx, auth.orgId, domainId);
        if (existing) {
          // A ProblemError, NOT a plain Error with `statusCode`: the error handler honours `statusCode`
          // only on framework errors, so the old shape answered 500 (verification of #414, probe PX2).
          throw conflict(
            `trust domain ${domainId} is already enrolled. One CA per domain is the bound ` +
              "ADR-0051 D2 sets; re-enrolling would stand up a second authority minting for the " +
              "same hosts."
          );
        }
        const result = await enrolDomain(tx, {
          orgId: auth.orgId,
          domainId,
          breakGlass: request.body.breakGlass,
          masterKey: deps.config.secretsMasterKey,
          recordedBySubjectId: auth.subjectObjectId
        });
        const row = await enrolmentForDomain(tx, auth.orgId, domainId);
        return {
          domainId: String(domainId),
          authorityId: result.authorityId,
          breakGlass: request.body.breakGlass.trim(),
          enrolledAt: (row?.enrolledAt ?? new Date()).toISOString(),
          caPublicKey: result.caPublicKey,
          // RETURNED, not described. An enrolment whose CA public key the operator cannot get hold
          // of has changed nothing on any host.
          trustedUserCaKeysFile: trustedUserCaKeysFile(result.caPublicKey)
        };
      });
      return reply.code(201).send(enrolment);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/trust-domains/:domainId/ssh-ca/enrolment",
    schema: {
      params: z.object({ domainId: z.string().uuid() }),
      response: {
        200: TrustDomainEnrolmentSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getTrustDomainSshCaEnrolment",
        summary:
          "Read a trust domain's enrolment: its CA public key, the TrustedUserCAKeys content to install, and the recorded break-glass path. Returns 404 when the domain is not enrolled, which is also the state in which a host-reaching run is refused",
        tags: ["infrastructure"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const domainId = asTrustDomainId(request.params.domainId);
      const view = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "audit:read",
          scopeObjectId: auth.orgId
        });
        const row = await enrolmentForDomain(tx, auth.orgId, domainId);
        if (!row) {
          // A ProblemError, NOT a plain Error with `statusCode`: the error handler honours `statusCode`
          // only on framework errors, so the old shape answered 500 (verification of #414, probe PX2).
          throw notFound(`trust domain ${domainId} is not enrolled`);
        }
        const authority = await activeAuthorityForDomain(tx, auth.orgId, domainId);
        if (!authority) {
          // Enrolled with no ACTIVE authority means the CA was retired without re-enrolment — the
          // same state `deriveOpsRunMaterial` refuses on, surfaced here rather than only at run time.
          // A ProblemError, NOT a plain Error with `statusCode`: the error handler honours `statusCode`
          // only on framework errors, so the old shape answered 500 (verification of #414, probe PX2).
          throw notFound(
            `trust domain ${domainId} is enrolled but has no ACTIVE certificate authority`
          );
        }
        return {
          domainId: String(domainId),
          authorityId: row.authorityId,
          breakGlass: row.breakGlass,
          enrolledAt: row.enrolledAt.toISOString(),
          caPublicKey: authority.publicKey,
          trustedUserCaKeysFile: trustedUserCaKeysFile(authority.publicKey)
        };
      });
      return reply.code(200).send(view);
    }
  });

  // THE ARGO HOST-OPS PIN (M28.2, ADR-0054 D9). The same door permission as enrolment —
  // `secret:write` at the org root — because what it decides is where this domain's CA-minted
  // certificates can go. #414's adversarial round showed the alternative: with these as binding
  // config, an Operator scoped to one product redirected a run token to their own Argo and key.
  typed.route({
    method: "PUT",
    url: "/api/v1/trust-domains/:domainId/ssh-ca/argo-ops-pin",
    schema: {
      params: z.object({ domainId: z.string().uuid() }),
      body: ArgoOpsPinRequestSchema,
      response: {
        200: ArgoOpsPinSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "putTrustDomainArgoOpsPin",
        summary:
          "Pin where this domain's CA may send an Argo Workflows host-ops run token: the Argo server and namespace, SCP's catalog template ref, the RSA key the token is sealed to, the cluster's egress addresses (every certificate's `source-address`) and the scp-runner-ops digest the template must name. `secret:write` at the org root, like enrolment — a binding editor cannot move it, and an Argo-bound run whose binding does not match it is refused. SCP cannot attest the pod that redeems; this pins what it CAN control (ADR-0054)",
        tags: ["infrastructure"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const domainId = asTrustDomainId(request.params.domainId);
      const view = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "secret:write",
          scopeObjectId: auth.orgId
        });
        if (!(await enrolmentForDomain(tx, auth.orgId, domainId))) {
          // A ProblemError, NOT a plain Error with `statusCode`: the error handler honours `statusCode`
          // only on framework errors, so the old shape answered 500 (verification of #414, probe PX2).
          throw notFound(
            `trust domain ${domainId} is not enrolled — enrol it (and record its break-glass path) ` +
              "before pinning where its certificates may go"
          );
        }
        try {
          await putArgoOpsPin(tx, {
            ...request.body,
            orgId: auth.orgId,
            domainId,
            recordedBySubjectId: auth.subjectObjectId
          });
        } catch (err) {
          if (err instanceof ArgoOpsPinInvalid) throw badRequest(err.message);
          throw err;
        }
        const pin = (await argoOpsPinForDomain(tx, auth.orgId, domainId))!;
        await appendAuditEvent(tx, {
          orgId: auth.orgId,
          actorId: auth.subjectObjectId,
          action: "ssh_ca.argo_ops_pin.put",
          reason:
            `pinned domain ${domainId}'s Argo host-ops endpoint to ${pin.serverUrl} ` +
            `(namespace ${pin.namespace}, template ${pin.templateRef}, runner ` +
            `${pin.runnerImageDigest}, source-address ${pin.sourceAddresses.join(",")})`,
          requestId: request.id
        });
        return { ...pin, domainId: String(pin.domainId), updatedAt: pin.updatedAt.toISOString() };
      });
      return reply.code(200).send(view);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/trust-domains/:domainId/ssh-ca/argo-ops-pin",
    schema: {
      params: z.object({ domainId: z.string().uuid() }),
      response: {
        200: ArgoOpsPinSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getTrustDomainArgoOpsPin",
        summary:
          "Read this domain's Argo host-ops pin. 404 when none is set — the state in which every Argo-bound host-reaching run for the domain is refused",
        tags: ["infrastructure"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const domainId = asTrustDomainId(request.params.domainId);
      const view = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "audit:read",
          scopeObjectId: auth.orgId
        });
        const pin = await argoOpsPinForDomain(tx, auth.orgId, domainId);
        if (!pin) {
          // A ProblemError, NOT a plain Error with `statusCode`: the error handler honours `statusCode`
          // only on framework errors, so the old shape answered 500 (verification of #414, probe PX2).
          throw notFound(`trust domain ${domainId} has no Argo host-ops pin`);
        }
        return { ...pin, domainId: String(pin.domainId), updatedAt: pin.updatedAt.toISOString() };
      });
      return reply.code(200).send(view);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/ssh-certificate-issuances",
    schema: {
      querystring: z.object({ limit: z.coerce.number().int().min(1).max(1000).optional() }),
      response: {
        200: SshCertificateIssuanceListSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "listSshCertificateIssuances",
        summary:
          "Every SSH certificate SCP recorded issuing, newest first (ADR-0051 D5). Both credential paths write here — the BYO authority and the SCP-CA fallback — so this is the complete set SCP claims responsibility for",
        tags: ["infrastructure"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const issuances = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "audit:read",
          scopeObjectId: auth.orgId
        });
        const rows = await listIssuances(tx, auth.orgId, request.query.limit);
        return rows.map((r) => ({
          serial: r.serial,
          keyId: r.keyId,
          authorityName: r.authorityName,
          principals: r.principals,
          targetHosts: r.targetHosts,
          sourceAddress: r.sourceAddress,
          issuedAt: r.issuedAt.toISOString(),
          expiresAt: r.expiresAt.toISOString()
        }));
      });
      return reply.code(200).send({ issuances });
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/ssh-certificate-issuances/reconcile",
    schema: {
      body: ReconcileSshSerialsRequestSchema,
      response: {
        200: SshSerialReconciliationSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "reconcileSshCertificateSerials",
        summary:
          "Given certificate serials observed in a host's own sshd log, report which SCP has no record of issuing. THIS IS THE ONLY CONTROL THAT BOUNDS CA COMPROMISE — short TTLs provably do not, because sshd honours the validity interval inside the certificate, which an attacker holding the signing key chooses (ADR-0051). A POST because the serials are the query and a log's worth of them does not belong in a URL; it writes nothing",
        tags: ["infrastructure"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const verdicts = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "audit:read",
          scopeObjectId: auth.orgId
        });
        return reconcileSerials(tx, auth.orgId, request.body.serials);
      });
      return reply.code(200).send({
        verdicts: verdicts.map((v) => ({
          serial: v.serial,
          unrecognised: v.unrecognised,
          keyId: v.keyId ?? null,
          authorityName: v.authorityName ?? null,
          issuedAt: v.issuedAt?.toISOString() ?? null
        })),
        // Carried so a caller cannot report "reconciled" from a 200 without inspecting the array.
        unrecognisedCount: verdicts.filter((v) => v.unrecognised).length
      });
    }
  });
}
