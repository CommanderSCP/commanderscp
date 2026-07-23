import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ExportJournalRequestSchema,
  ExportPromotionRequestSchema,
  FederationPeerSchema,
  FederationRoleSchema,
  FederationSelfSchema,
  FederationStatusResponseSchema,
  GraphObjectSchema,
  HandFillRequestSchema,
  ImportBundleRequestSchema,
  ImportResultSchema,
  InitFederationRequestSchema,
  PairPeerRequestSchema,
  ProblemSchema,
  PromotionBundleSchema,
  RelayBuildRequestSchema,
  RelayBuildResponseSchema,
  RelayImportRequestSchema,
  RelayImportResponseSchema,
  SyncBundleSchema
} from "@scp/schemas";
import type { ImportBundleRequest, PromotionBundle } from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { badRequest, conflict } from "../errors.js";
import { initFederationSelf, ensureFederationSelf } from "../federation/self-repo.js";
import { pairPeer, listPeers, getPeerByIdOrName } from "../federation/peers-repo.js";
import {
  dropDeliveryFile,
  requireOutboundDir,
  resolveDeliveryTarget
} from "../federation/delivery-target.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { getInstanceCosignPublicKey } from "../governance/cosign-keys.js";
import { getFederationStatus } from "../federation/status-repo.js";
import { exportSyncBundle } from "../federation/export-repo.js";
import { importSyncBundle } from "../federation/import-repo.js";
import { exportPromotionBundle, importPromotionBundle } from "../federation/promotion-repo.js";
import { createOverlay, getMergedOverlayView } from "../federation/overlay-repo.js";
import { handFillObject } from "../federation/handfill-repo.js";
import {
  buildRelayTarball,
  importRelayTarball,
  relayConfigFromEnv,
  resolveUnderDir
} from "../federation/retrans-relay.js";
import {
  enforceFederationMtls,
  recordImportExporterBindingAdvisory
} from "../federation/mtls-enforcement.js";

/** `z.union` (unlike `z.discriminatedUnion`, which needs a TOP-LEVEL discriminant key — `kind`
 *  here is nested under `header`) doesn't give TypeScript enough to narrow
 *  `request.body.header.kind === "promotion"` through plain control flow, so an explicit type
 *  guard does it instead. */
function isPromotionBundle(body: ImportBundleRequest): body is PromotionBundle {
  return body.header.kind === "promotion";
}

/**
 * `/federation` (DESIGN.md §13, BUILD_AND_TEST.md §8 M6). Every mutating route requires
 * `federation:write`; every read requires `federation:read` (roles seeded in
 * drizzle/0012_federation.sql). Scoped at the org root (`auth.orgId`) rather than per-object —
 * federation identity/peers/journal are org-instance-wide concerns, not containment-scoped.
 */
export function registerFederationRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/v1/federation/init",
    schema: {
      body: InitFederationRequestSchema,
      response: {
        200: z.object({
          domainId: z.string().uuid(),
          name: z.string(),
          role: FederationRoleSchema
        }),
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "initFederation",
        summary: "Designate this domain's federation role (commander|outpost|retrans)",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const self = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:write",
          scopeObjectId: auth.orgId
        });
        return initFederationSelf(tx, {
          orgId: auth.orgId,
          name: request.body.name,
          role: request.body.role
        });
      });
      reply.status(200).send(self);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/federation/self",
    schema: {
      response: { 200: FederationSelfSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "getFederationSelf",
        summary: "This domain's own federation identity + public key (for out-of-band pairing)",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:read",
          scopeObjectId: auth.orgId
        });
        const self = await ensureFederationSelf(tx, auth.orgId);
        const key = await ensureInstanceKey(tx, auth.orgId);
        return {
          domainId: self.domainId,
          name: self.name,
          role: self.role,
          publicKey: key.publicKey
        };
      });
      // M17.3 (E5) — surface the LOCAL cosign verification public key for out-of-band pairing. Resolved
      // OUTSIDE the tx above: `getInstanceCosignPublicKey` provisions the keypair lazily via a cosign
      // subprocess, which must never run while a tx (and its pooled connection) is held open. Only the
      // PUBLIC half is returned — the accessor's type structurally omits the private key.
      const cosign = await getInstanceCosignPublicKey(deps.db, auth.orgId);
      reply.status(200).send({ ...result, cosignPublicKey: cosign.publicKey });
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/federation/peers",
    schema: {
      body: PairPeerRequestSchema,
      response: {
        201: FederationPeerSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "pairPeer",
        summary: "Pair (or update) a federation peer domain — always initiated from this side",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const peer = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:write",
          scopeObjectId: auth.orgId
        });
        const self = await ensureFederationSelf(tx, auth.orgId);
        if (request.body.domainId === self.domainId) {
          throw badRequest("cannot pair this domain with itself");
        }
        return pairPeer(tx, { orgId: auth.orgId, ...request.body });
      });
      reply.status(201).send(peer);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/federation/peers",
    schema: {
      response: { 200: z.array(FederationPeerSchema), 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listFederationPeers",
        summary: "List paired federation peers",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const peers = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:read",
          scopeObjectId: auth.orgId
        });
        return listPeers(tx, auth.orgId);
      });
      reply.status(200).send(peers);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/federation/status",
    schema: {
      response: { 200: FederationStatusResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "getFederationStatus",
        summary:
          "Cross-domain status: every peer, this side's sync freshness, bundle-transfer history",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      // M17.3 (E5) — authorize FIRST, in its own tx, so the cosign public-key resolution below is
      // GATED behind the permission check: `getInstanceCosignPublicKey` LAZILY PROVISIONS this org's
      // keypair (via a cosign subprocess) on first call, and an authenticated-but-unauthorized caller
      // (no `federation:read`) must never trigger that provisioning just by hitting this route.
      // Mirrors /exports/promotion's ordering (authorize in its own tx, then the out-of-tx work).
      await withTenantTx(deps.db, auth.orgId, (tx) =>
        authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:read",
          scopeObjectId: auth.orgId
        })
      );
      // Only NOW resolve the LOCAL cosign public key — OUTSIDE any tx: its lazy provisioning runs a
      // cosign subprocess, which must never execute while a tx holds a pooled connection. Only the
      // public half is ever returned.
      const cosign = await getInstanceCosignPublicKey(deps.db, auth.orgId);
      const status = await withTenantTx(deps.db, auth.orgId, (tx) =>
        getFederationStatus(tx, auth.orgId, cosign.publicKey)
      );
      reply.status(200).send(status);
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/federation/exports",
    schema: {
      body: ExportJournalRequestSchema,
      response: {
        200: SyncBundleSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "exportSyncBundle",
        summary:
          "Export a signed .scpbundle of journal entries since a cursor (scp federation export)",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      // M9.3 (ADR-0001) — a transport-identity gate ADDITIONAL to (never replacing) the
      // requireAuth+authorize below; no-op when `federationServerMtls` is unset. See
      // federation/mtls-enforcement.ts's module doc for why this runs as a plain function call
      // here rather than a Fastify `onRequest` hook.
      await enforceFederationMtls(deps, request);
      const auth = await requireAuth(deps, request);
      const { bundle, deliverPeer } = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:write",
          scopeObjectId: auth.orgId
        });
        // M13.2a (§13.2): `deliver` resolves the peer row FIRST — a delivery with no resolvable
        // drop directory refuses fail-closed BEFORE the export does any work.
        const deliverPeer = request.body.deliver
          ? await getPeerByIdOrName(tx, auth.orgId, request.body.peer)
          : null;
        if (deliverPeer) requireOutboundDir(resolveDeliveryTarget(deliverPeer));
        const bundle = await exportSyncBundle(
          tx,
          auth.orgId,
          request.body.peer,
          request.body.sinceSequence
        );
        return { bundle, deliverPeer };
      });
      if (request.body.deliver && deliverPeer) {
        // The server-side leg of the CDS walk (§13.2 write seam): the SAME bytes the CLI's --out
        // writes (`JSON.stringify(bundle, null, 2)`), dropped through the peer's DeliveryTarget
        // (per-peer config, else the SCP_RELAY_OUT_DIR instance fallback — today's behavior).
        await dropDeliveryFile(
          resolveDeliveryTarget(deliverPeer),
          `scp-sync-${bundle.header.exporterDomainId}-${bundle.header.throughSequence}.scpbundle`,
          JSON.stringify(bundle, null, 2)
        );
      }
      reply.status(200).send(bundle);
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/federation/exports/promotion",
    schema: {
      body: ExportPromotionRequestSchema,
      response: {
        200: PromotionBundleSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "exportPromotionBundle",
        summary: "Export a Promotion Bundle for a Change (change + evidence + attestations)",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      // M9.3 (ADR-0001) — see the /exports route above for what this does and doesn't change.
      await enforceFederationMtls(deps, request);
      const auth = await requireAuth(deps, request);
      // Authorize in its own tx — `exportPromotionBundle` manages its OWN transaction phases around
      // an out-of-tx cosign subprocess (it takes `deps.db`, not this tx), so authz runs first here.
      await withTenantTx(deps.db, auth.orgId, (tx) =>
        authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:write",
          scopeObjectId: auth.orgId
        })
      );
      // M13.2a (§13.2): `deliver` resolves the peer's DeliveryTarget FIRST — a delivery with no
      // resolvable drop directory refuses fail-closed (named per-gap problem) BEFORE the export
      // gates run, so a refused delivery never leaves a signed bundle with nowhere to go.
      const deliverPeer = request.body.deliver
        ? await withTenantTx(deps.db, auth.orgId, (tx) =>
            getPeerByIdOrName(tx, auth.orgId, request.body.peer)
          )
        : null;
      if (deliverPeer) requireOutboundDir(resolveDeliveryTarget(deliverPeer));
      const outcome = await exportPromotionBundle(deps.db, {
        orgId: auth.orgId,
        peerIdOrName: request.body.peer,
        changeIdOrUrn: request.body.change,
        actorObjectId: auth.subjectObjectId
      });
      // M17.3 (E6) HARD-GATE: a promotion lacking a passing, digest-bound scan for every substantive
      // artifact is REFUSED — surfaced as a 409 carrying the audited `decision_id`, like every other
      // blocked response (DESIGN.md §6/§10.4). The Decision was already persisted by the export.
      if (outcome.refused) {
        throw conflict(outcome.reason, { decisionId: outcome.decisionId });
      }
      if (deliverPeer) {
        // The server-side leg of the CDS walk (§13.2 write seam): the SAME bytes the CLI's --out
        // writes, dropped through the peer's DeliveryTarget (per-peer config, else the
        // SCP_RELAY_OUT_DIR instance fallback — today's behavior, byte-identical).
        await dropDeliveryFile(
          resolveDeliveryTarget(deliverPeer),
          `scp-promotion-${outcome.bundle.header.sourceChangeObjectId}.scpbundle`,
          JSON.stringify(outcome.bundle, null, 2)
        );
      }
      reply.status(200).send(outcome.bundle);
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/federation/imports",
    schema: {
      body: ImportBundleRequestSchema,
      response: {
        200: ImportResultSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "importBundle",
        summary:
          "Verify + apply a .scpbundle (sync or promotion) — fail-closed on any signature/chain check",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      // M9.3 (ADR-0001) — see the /exports route above for what this does and doesn't change.
      await enforceFederationMtls(deps, request);
      const auth = await requireAuth(deps, request);
      // Authorize + record the mTLS advisory in their OWN tx. A PROMOTION import cannot run inside a
      // single held tx — M17.4(a)'s manifest verification runs a cosign `verify-blob` SUBPROCESS and
      // `importPromotionBundle` manages its own transaction phases around it (it takes `deps.db`, not
      // this tx), exactly like `exportPromotionBundle`.
      const body = request.body;
      await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:write",
          scopeObjectId: auth.orgId
        });
        // M9.3 (ADR-0001 §5) — the mTLS transport-peer-vs-bundle-exporter SHOULD binding: advisory
        // only (never rejects), recorded as a Decision on mismatch. No-op when mTLS isn't enforced
        // on this request (`request.mtlsPeerDomainId` unset — see mtls-enforcement.ts).
        await recordImportExporterBindingAdvisory(
          tx,
          {
            orgId: auth.orgId,
            mtlsPeerDomainId: request.mtlsPeerDomainId,
            exporterDomainId: body.header.exporterDomainId
          },
          request.log
        );
      });
      if (isPromotionBundle(body)) {
        const imported = await importPromotionBundle(deps.db, auth.orgId, body);
        reply.status(200).send({ kind: "promotion" as const, ...imported });
        return;
      }
      const imported = await withTenantTx(deps.db, auth.orgId, (tx) =>
        importSyncBundle(tx, auth.orgId, body)
      );
      reply.status(200).send({ kind: "sync" as const, ...imported });
    }
  });

  // M15.5(c) — the retrans validate-then-relay (ADR-0019 §2). SOURCE side: build the signed byte
  // tarball for an imported, M17.4(a)-verified promotion. Only a `role: retrans` instance may run
  // it (the repo function enforces the role, 409 otherwise). The tarball lands in the
  // operator-configured SCP_RELAY_OUT_DIR drop directory — the CDS crossing itself is out-of-band,
  // the same boundary the `.scpbundle` walk draws.
  typed.route({
    method: "POST",
    url: "/api/v1/federation/relay",
    schema: {
      body: RelayBuildRequestSchema,
      response: {
        200: RelayBuildResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "buildRelayTarball",
        summary:
          "Retrans validate-then-relay: pull + validate the authorized artifact bytes and build the signed relay tarball (role: retrans)",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      await enforceFederationMtls(deps, request);
      const auth = await requireAuth(deps, request);
      // Authorize in its own tx — `buildRelayTarball` manages its OWN transaction phases around
      // skopeo/cosign subprocesses (it takes `deps.db`), like export/importPromotionBundle.
      await withTenantTx(deps.db, auth.orgId, (tx) =>
        authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:write",
          scopeObjectId: auth.orgId
        })
      );
      const config = relayConfigFromEnv();
      // M13.2a (§13.2) — the outbound drop resolves through the DESTINATION peer's DeliveryTarget
      // when the request names one; absent a peer, through the instance env (`SCP_RELAY_OUT_DIR`)
      // exactly as before — byte-identical. NEITHER resolvable → fail-closed 400 carrying the
      // named per-gap problem (never a silent default path).
      const deliverPeer = request.body.peer
        ? await withTenantTx(deps.db, auth.orgId, (tx) =>
            getPeerByIdOrName(tx, auth.orgId, request.body.peer as string)
          )
        : null;
      const outDir = requireOutboundDir(resolveDeliveryTarget(deliverPeer, config));
      const outcome = await buildRelayTarball(deps.db, {
        orgId: auth.orgId,
        changeIdOrUrn: request.body.change,
        masterKey: deps.config.secretsMasterKey,
        outDir,
        config
      });
      // FAIL-CLOSED: a failing/tampered/unauthorized/missing artifact refused the whole relay —
      // 409 carrying the persisted block Decision id, like every blocked response (DESIGN §6/§10.4).
      if (outcome.refused) {
        throw conflict(outcome.reason, { decisionId: outcome.decisionId });
      }
      reply.status(200).send(outcome);
    }
  });

  // M15.5(c) — DESTINATION side: verify a relay tarball (signature + checksums + local-authorized
  // cross-check) and push its artifacts into the outpost's local registry by digest + re-inspect
  // (the install.sh pattern). The receiving M17.4(a)+(b) gates run unchanged afterwards — the
  // relay is granted ZERO TRUST.
  typed.route({
    method: "POST",
    url: "/api/v1/federation/relay/import",
    schema: {
      body: RelayImportRequestSchema,
      response: {
        200: RelayImportResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "importRelayTarball",
        summary:
          "Destination side of the retrans relay: verify the signed tarball and push its artifacts into the local registry by digest (+ re-inspect)",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      await enforceFederationMtls(deps, request);
      const auth = await requireAuth(deps, request);
      await withTenantTx(deps.db, auth.orgId, (tx) =>
        authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:write",
          scopeObjectId: auth.orgId
        })
      );
      const config = relayConfigFromEnv();
      if (!config.inDir) {
        throw badRequest(
          "SCP_RELAY_IN_DIR is not configured — the operator must set the relay tarball intake directory"
        );
      }
      // The API names a file INSIDE the operator-configured intake directory only — never an
      // arbitrary server path (traversal refused).
      const tarballPath = resolveUnderDir(config.inDir, request.body.file);
      const outcome = await importRelayTarball(deps.db, {
        orgId: auth.orgId,
        changeIdOrUrn: request.body.change,
        tarballPath,
        relayCosignPublicKeyPem: request.body.relayCosignPublicKey,
        masterKey: deps.config.secretsMasterKey,
        config
      });
      if (outcome.refused) {
        throw conflict(outcome.reason, { decisionId: outcome.decisionId });
      }
      reply.status(200).send(outcome);
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/federation/overlays",
    schema: {
      body: z.object({
        base: z.string().min(1),
        typeId: z.string().min(1),
        name: z.string().min(1),
        urn: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        labels: z.record(z.string(), z.unknown()).optional()
      }),
      response: {
        201: GraphObjectSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "createOverlay",
        summary: "Create a local overlay annotating a (possibly foreign-origin) base object",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: auth.orgId
        });
        return createOverlay(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          baseIdOrUrn: request.body.base,
          overlayTypeId: request.body.typeId,
          overlayName: request.body.name,
          overlayUrn: request.body.urn,
          overlayProperties: request.body.properties,
          overlayLabels: request.body.labels
        });
      });
      reply.status(201).send(result.overlay);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/federation/overlays/:idOrUrn",
    schema: {
      params: z.object({ idOrUrn: z.string().min(1) }),
      response: {
        200: z.object({
          base: GraphObjectSchema,
          overlays: z.array(GraphObjectSchema),
          merged: z.record(z.string(), z.unknown())
        }),
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getMergedOverlayView",
        summary: "Read-time merge of a base object with its local overlays",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        return getMergedOverlayView(tx, auth.orgId, request.params.idOrUrn);
      });
      reply.status(200).send(result);
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/federation/hand-fill",
    schema: {
      body: HandFillRequestSchema,
      response: {
        201: GraphObjectSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "handFillObject",
        summary:
          "Manually enter a commander-origin object as an unverified shadow copy (air-gapped, no bundle transport)",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const object = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:write",
          scopeObjectId: auth.orgId
        });
        return handFillObject(tx, {
          orgId: auth.orgId,
          peerIdOrName: request.body.peer,
          typeId: request.body.typeId,
          urn: request.body.urn,
          name: request.body.name,
          properties: request.body.properties,
          labels: request.body.labels
        });
      });
      reply.status(201).send(object);
    }
  });
}
