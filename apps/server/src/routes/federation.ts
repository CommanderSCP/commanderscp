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
import { badRequest, conflict, unauthorized, tooManyRequests } from "../errors.js";
import { initFederationSelf, ensureFederationSelf } from "../federation/self-repo.js";
import { pairPeer, listPeers, getPeerByIdOrName } from "../federation/peers-repo.js";
import {
  assertDeliveryTargetRooted,
  assertOutboundDeliverable,
  dropDeliveryFile,
  requireOutboundDir,
  resolveDeliveryTarget,
  type DeliveryTargetPeerRef,
  type ResolvedDeliveryTarget
} from "../federation/delivery-target.js";
import type { S3DeliveryCredentials } from "../federation/delivery-s3.js";
import { getSecretValue } from "../secrets/secrets-repo.js";
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
  deliveryTargetSecretKey,
  importRelayTarball,
  parseDeliveryS3Credential,
  relayConfigFromEnv,
  resolveUnderDir
} from "../federation/retrans-relay.js";
import {
  enforceFederationMtls,
  recordImportExporterBindingAdvisory
} from "../federation/mtls-enforcement.js";
import { wakeFederationSyncNow } from "../federation/federation-sync.js";
import { pokeRateLimiter } from "../federation/poke-rate-limit.js";

/** `z.union` (unlike `z.discriminatedUnion`, which needs a TOP-LEVEL discriminant key — `kind`
 *  here is nested under `header`) doesn't give TypeScript enough to narrow
 *  `request.body.header.kind === "promotion"` through plain control flow, so an explicit type
 *  guard does it instead. */
function isPromotionBundle(body: ImportBundleRequest): body is PromotionBundle {
  return body.header.kind === "promotion";
}

/**
 * M13.2b (§13.2) — resolve a peer's OUTBOUND delivery for a `.scpbundle` drop, PROVIDER-AWARE and
 * fail-closed BEFORE the export does any work:
 *   - asserts the outbound location resolves (filesystem dir OR allowlisted s3 endpoint), else 400;
 *   - for an s3 target, ALSO resolves the WRITE-scoped vault credential (`delivery/<peer>/out`) up
 *     front — a missing/malformed secret refuses here, so a refused delivery never leaves a signed
 *     bundle with nowhere to go. Credentials are resolved at use and passed to `dropDeliveryFile`;
 *     never argv/logs/Decisions (ADR-0019 §3).
 */
async function resolveOutboundDelivery(
  deps: AppDeps,
  orgId: string,
  peer: DeliveryTargetPeerRef
): Promise<{ resolved: ResolvedDeliveryTarget; s3Credentials?: S3DeliveryCredentials }> {
  const resolved = resolveDeliveryTarget(peer);
  assertOutboundDeliverable(resolved);
  if (resolved.provider !== "s3-compatible") return { resolved };
  const raw = await withTenantTx(deps.db, orgId, (tx) =>
    getSecretValue(
      tx,
      orgId,
      deliveryTargetSecretKey(peer.name, "out"),
      deps.config.secretsMasterKey
    )
  );
  const s3Credentials = parseDeliveryS3Credential(raw);
  if (!s3Credentials) {
    throw badRequest(
      `peer '${peer.name}' s3-compatible outbound drop needs the vault credential ` +
        `'${deliveryTargetSecretKey(peer.name, "out")}' (accessKeyId:secretAccessKey), but it is ` +
        `unset or malformed (fail-closed)`
    );
  }
  return { resolved, s3Credentials };
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
        // M13.2a residual (#110 pattern): a per-peer deliveryTarget dir is honored only inside the
        // operator-declared SCP_DELIVERY_ROOTS — refuse an out-of-root (or unrooted) dir here so it
        // is NEVER stored (the resolution side re-checks fail-closed for anything already in the DB).
        assertDeliveryTargetRooted(request.body.deliveryTarget);
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
        // drop target refuses fail-closed BEFORE the export does any work (provider-agnostic —
        // filesystem dir OR allowlisted s3 endpoint).
        const deliverPeer = request.body.deliver
          ? await getPeerByIdOrName(tx, auth.orgId, request.body.peer)
          : null;
        if (deliverPeer) assertOutboundDeliverable(resolveDeliveryTarget(deliverPeer));
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
        // writes (`JSON.stringify(bundle, null, 2)`), dropped through the peer's DeliveryTarget —
        // PROVIDER-DISPATCHED (filesystem dir or s3 put; s3 creds vault-resolved up front).
        const { resolved, s3Credentials } = await resolveOutboundDelivery(
          deps,
          auth.orgId,
          deliverPeer
        );
        await dropDeliveryFile(
          resolved,
          `scp-sync-${bundle.header.exporterDomainId}-${bundle.header.throughSequence}.scpbundle`,
          JSON.stringify(bundle, null, 2),
          s3Credentials
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
      if (deliverPeer) assertOutboundDeliverable(resolveDeliveryTarget(deliverPeer));
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
        // writes, dropped through the peer's DeliveryTarget — PROVIDER-DISPATCHED (filesystem dir
        // or s3 put; s3 creds vault-resolved up front, never argv/logs).
        const { resolved, s3Credentials } = await resolveOutboundDelivery(
          deps,
          auth.orgId,
          deliverPeer
        );
        await dropDeliveryFile(
          resolved,
          `scp-promotion-${outcome.bundle.header.sourceChangeObjectId}.scpbundle`,
          JSON.stringify(outcome.bundle, null, 2),
          s3Credentials
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
      //
      // M13.2b scope note: `buildRelayTarball` writes the tarball to a LOCAL directory path, so a
      // relay destination configured for s3-compatible delivery fails closed here with a clear
      // provider-mismatch (requireOutboundDir refuses an s3 target). Relaying the multi-GB tarball
      // DIRECTLY to s3 (build-then-lib-storage-upload) is a follow-on to this increment; the s3
      // WRITE seam (dropDeliveryFile) and its multipart path already exist and are exercised by the
      // `.scpbundle` drop + the delivery-target suite. Configure a filesystem SCP_RELAY_OUT_DIR (or
      // a filesystem peer deliveryTarget) for relay builds.
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

  // M14.2 (ADR-0009, docs/proposals/outpost-poke.md) — the INBOUND CONTENTLESS POKE. A commander/
  // upstream calls this to wake THIS instance's pull NOW instead of waiting for the interval. It
  // carries ZERO data (ADR-0009 no-DATA-commander→outpost invariant): the body is IGNORED and no
  // request schema is declared, so nothing in it can ever drive behavior. Structurally this lives on
  // the instance's OWN /v1 API (never inside the client-only `federation-https` plugin, which keeps
  // its "no server half" property) as an mTLS-gated route, exactly like the other transport verbs.
  //
  // FAIL-CLOSED on BOTH transport identity AND receiver-side consent (the crux):
  //   1. `enforceFederationMtls` authenticates the caller by client-cert SAN identity. When
  //      federation-server-mTLS is UNSET it is a no-op and leaves `mtlsPeerDomainId` undefined — so
  //      a bearer-only poke does NOT meet "authenticate the caller as the enrolled commander"
  //      (ADR-0009) and is REFUSED here (401). A poke is honored only from an enrolled client cert.
  //   2. BOTH-SIDES CONSENT (owner refinement 2026-07-24): the poke is honored only if THIS receiving
  //      instance has ITS OWN `pokeMode=true` for the calling peer (set on this side via
  //      `scp federation pair <upstream> --poke-mode`, M14.1). An enrolled peer whose receiver-side
  //      pokeMode is false is rejected (409) — the receiver never opted into pokes from it. An
  //      unknown/non-enrolled caller is already rejected (403) by `enforceFederationMtls` itself.
  // Idempotent + rate-limited: a per-peer token bucket drops excess pokes (429), and the wake is a
  // plain enqueue, so N pokes in a window → at most one pull. The pull runs on the sync loop's
  // worker, never inline here (return fast). Sync loop not running on this process → accepted no-op.
  typed.route({
    method: "POST",
    url: "/api/v1/federation/poke",
    schema: {
      // NO body schema — the poke is contentless; any/empty body is accepted and never read.
      response: {
        202: z.object({ accepted: z.literal(true), woken: z.boolean() }),
        401: ProblemSchema,
        403: ProblemSchema,
        409: ProblemSchema,
        429: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "federationPoke",
        summary:
          "Contentless, mTLS-authenticated wake signal from an enrolled commander/upstream — pull now (poke-mode)",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      // Transport-identity gate FIRST (as in every other federation transport route). This also runs
      // `requireAuth` internally; it sets `request.mtlsPeerDomainId` ONLY when mTLS is active and the
      // client cert resolved to an enrolled peer for the bearer's org.
      await enforceFederationMtls(deps, request);
      // FAIL-CLOSED transport identity: a poke authenticated by bearer-only (mTLS unset → the gate
      // above no-op'd) does not prove the caller is the enrolled commander. Refuse it — the poke is
      // honored only when the caller presented an enrolled client certificate (ADR-0009 §5).
      if (!request.mtlsPeerDomainId) {
        throw unauthorized(
          "federation poke requires mTLS transport identity — refused fail-closed: a poke is honored " +
            "only from a caller presenting an enrolled federation client certificate, never on bearer alone"
        );
      }
      const auth = await requireAuth(deps, request);

      // BOTH-SIDES CONSENT: resolve the calling peer on THIS instance and require this side's OWN
      // pokeMode=true for it. (`mtlsPeerDomainId` is the already-resolved peer id from the gate; an
      // unknown caller never reaches here — the gate 403s it.)
      const peer = await withTenantTx(deps.db, auth.orgId, (tx) =>
        getPeerByIdOrName(tx, auth.orgId, request.mtlsPeerDomainId as string)
      );
      if (!peer.pokeMode) {
        throw conflict(
          `this instance is not configured for poke-mode from peer '${peer.name}' — the receiver has ` +
            `not consented; opt in with 'scp federation pair ${peer.name} --poke-mode' to honor its pokes`
        );
      }

      // Rate limit per peer: excess pokes are dropped (429). The wake is idempotent, so at most one
      // pull results from any burst — no dedupe ledger needed (see poke-rate-limit.ts).
      if (!pokeRateLimiter.tryConsume(`${auth.orgId}:${peer.id}`)) {
        throw tooManyRequests(
          `poke rate limit exceeded for peer '${peer.name}' — dropped (the wake is idempotent; a burst ` +
            "of pokes coalesces to at most one pull)"
        );
      }

      // WAKE THE PULL — enqueue an immediate federation-sync tick and return fast. The loop's worker
      // does the actual pull; we never pull inline. No queue on this process (pure role=api, or the
      // sync loop is disabled) → accepted-but-no-op (the sparse safety-net is the reliability floor).
      let woken = false;
      if (deps.boss) {
        try {
          await wakeFederationSyncNow(deps.boss);
          woken = true;
        } catch (err) {
          request.log.warn(
            { err: err instanceof Error ? err.message : String(err), peer: peer.name },
            "federation poke accepted but could not enqueue a sync tick (sync loop likely not running) " +
              "— no-op-but-accepted; the sparse safety-net pull remains the reliability floor"
          );
        }
      } else {
        request.log.info(
          { peer: peer.name },
          "federation poke accepted but this process has no job queue (role=api or sync loop disabled) " +
            "— no-op-but-accepted"
        );
      }
      reply.status(202).send({ accepted: true as const, woken });
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
