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
  CreateOutpostConfigRequestSchema,
  FederationResyncRequestSchema,
  FederationResyncResponseSchema,
  FederationResyncResultSchema,
  JournalDivergenceProblemSchema,
  JOURNAL_DIVERGENCE_PROBLEM_TYPE,
  OutpostConfigReconcileResultSchema,
  OutpostConfigSchema,
  OutpostIfClaimantQuerySchema,
  OutpostReconcileStaleProblemSchema,
  parseOutpostClaimantToken,
  PairPeerRequestSchema,
  ProblemSchema,
  UpdateFederationPeerRequestSchema,
  UpdateOutpostConfigRequestSchema,
  PromotionBundleSchema,
  RelayBuildListResponseSchema,
  RelayBuildRequestSchema,
  RelayBuildResponseSchema,
  RelayBuildStatusSchema,
  RelayImportRequestSchema,
  RelayImportResponseSchema,
  SyncBundleSchema
} from "@scp/schemas";
import type { ImportBundleRequest, PromotionBundle } from "@scp/schemas";
import { trustDomainIdFromWire } from "../domain-id-edge.js";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { badRequest, conflict, ProblemError, unauthorized, tooManyRequests } from "../errors.js";
import { initFederationSelf, ensureFederationSelf } from "../federation/self-repo.js";
import {
  pairPeer,
  listPeers,
  getPeerByIdOrName,
  markPokeReceived,
  updatePeerTransport
} from "../federation/peers-repo.js";
import {
  createOutpostConfig,
  getOutpostConfigByPeer,
  listOutpostConfigs,
  reconcileOutpostConfig,
  updateOutpostConfig
} from "../federation/outposts-repo.js";
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
import {
  exportSyncBundle,
  recordExportDivergence,
  JournalDivergenceDetected
} from "../federation/export-repo.js";
import { importSyncBundle } from "../federation/import-repo.js";
import {
  authorizeResyncAndReExport,
  applyResyncBundle,
  signResyncRequest
} from "../federation/resync-repo.js";
import { dialResync, resolveFederationClientMtls } from "../federation/federation-outbound.js";
import { exportPromotionBundle, importPromotionBundle } from "../federation/promotion-repo.js";
import { createOverlay, getMergedOverlayView } from "../federation/overlay-repo.js";
// The overlay doors' SECOND bar is scoped at the base graph object, so they have to resolve it
// before they can scope anything at it — see the block above `POST /api/v1/federation/overlays`.
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
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
import { inboxLoopEnabled, wakeInboxNow } from "../federation/inbox-loop.js";
import { autoRelayEnabled, wakeAutoRelayNow } from "../federation/auto-relay.js";
import { listRelayBuilds, reopenRelayBuild } from "../federation/relay-builds-repo.js";
import { getChangeRow } from "../coordination/changes-repo.js";
import { pokeRateLimiter } from "../federation/poke-rate-limit.js";
import { recordPokeWake } from "../federation/poke-metrics.js";

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
 *
 * ONE ROUTE TAKES MORE (owner ruling D4, 2026-08-25): `POST /federation/peers` — pairing, i.e.
 * declaring whose signature this instance believes — demands `federation:pair` (drizzle/0094) ON TOP
 * OF `federation:write`. Nothing else does, deliberately: operating an established link must keep
 * working for an actor that cannot establish a new one.
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
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "initFederation",
        summary:
          "Designate this domain's federation role (commander|outpost; retrans only on a deployment that declares SCP_FEDERATION_ROLE=retrans)",
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
        // THE RETRANS DOOR (owner decision 2026-08-24). An org declared `retrans` activates relay
        // machinery (inbox loop, auto-relay obligations) and flips that org's dependencyManagement
        // to `managedHere: false` — correct at a CDS boundary, a stray config anywhere else. The
        // deployment is the arbiter: a real retrans box declares `SCP_FEDERATION_ROLE=retrans` at
        // install time (which is also what withholds its SPA — retrans-no-spa.integration.test.ts),
        // so an org-level retrans declaration on any OTHER deployment is refused here, at the sole
        // write door for `federation_self.role` (initFederationSelf has exactly this one non-test
        // caller). Sentence-only 400, no decision_id — a door-level refusal, not an engine verdict.
        // The wire enum deliberately still carries "retrans" (narrowing it is an oasdiff break, and
        // on a retrans-profile deployment this same route accepts it).
        if (request.body.role === "retrans" && deps.config.federationRole !== "retrans") {
          throw badRequest(
            `an org may be declared 'retrans' only on a deployment that itself declares ` +
              `SCP_FEDERATION_ROLE=retrans (this deployment: '${deps.config.federationRole}'). ` +
              `A retrans is a CDS-boundary profile driven via CLI/API; declaring it here would ` +
              `idle relay machinery on a non-boundary box and disable this org's dependency ` +
              `management. Set the deployment profile first, or choose commander|outpost`
          );
        }
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
        403: ProblemSchema,
        // Rail 5 (§7.2): re-pairing to `full` refuses to re-anchor an anchorless cursor while a
        // journal_divergence stands for this peer — resync, don't re-anchor.
        409: JournalDivergenceProblemSchema
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
        // THE SECOND BAR (owner ruling D4, 2026-08-25 — docs/proposals/role-model.md §4.1).
        // ADDED, NEVER SUBSTITUTED: the `federation:write` check above is untouched, so this door
        // only ever got harder. This route is where an operator declares WHOSE SIGNATURE this
        // instance believes — `publicKey` is taken verbatim from the body, and `pairPeer` treats a
        // changed value as a KEY ROTATION that supersedes the current window — and from there
        // `POST /federation/imports` (still `federation:write`) will apply anything signed with it
        // through `applyEntry`'s `object_upsert`, i.e. estate write authority without
        // `object:write`. The import path is deliberately left ungated: a throw there wedges a
        // legitimately paired peer's whole signed bundle, and pairing is the link that can be gated
        // without breaking the contract. See `authz/resolve.ts`'s `federation:pair` note.
        //
        // NO OTHER federation route demands `federation:pair` — not import, export, status,
        // outposts, resync, poke, nor the transport-only peer PATCH — so a paired link keeps working
        // under an actor that cannot establish a new one. (Their own gates are unchanged, which for
        // some is more than `federation:write`: hand-fill also takes `object:write`, a federating
        // freeze also takes `freeze:write`.)
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:pair",
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
        return pairPeer(tx, {
          orgId: auth.orgId,
          ...request.body,
          // WIRE BOUNDARY (ADR-0021 D4) — see src/domain-id-edge.ts: `PairPeerRequestSchema`
          // declares the peer's own federation identity, i.e. the TRUST sense.
          domainId: trustDomainIdFromWire(request.body.domainId)
        });
      });
      reply.status(201).send(peer);
    }
  });

  // -----------------------------------------------------------------------------------------
  // M16.2 phase A (E4) — GET + the NARROW, STRUCTURALLY KEYLESS PATCH for one peer.
  //
  // WHY THESE EXIST. Before this increment the ONLY peer write was `POST /federation/peers`, whose
  // body REQUIRES `publicKey` and treats a different value as a KEY ROTATION that supersedes the
  // current key window and hard-revokes the old key. A Settings form that read a peer, changed a
  // base URL and re-paired would silently rotate that peer's trust anchor the moment it dropped or
  // mangled the key — an entire class of UI-caused trust-anchor rotations. `UpdateFederationPeerRequestSchema`
  // admits NO key material and no `role`, so this route CANNOT rotate, supersede or revoke a key: the
  // capability is absent from the contract, not merely unused by the handler.
  //
  // EVERY PAIR-TIME GUARD IS RE-APPLIED HERE. A new write door that skips the old door's validation
  // is the bypass class this project has hit before (the governance-owned-type invariant). The census
  // and each guard's disposition live on `updatePeerTransport` in `federation/peers-repo.ts`; the two
  // that need route-level work are the delivery-target ALLOWLIST (below, same call as pairing) and the
  // poke/mTLS + re-anchor guards (inside the repo, over the MERGED post-write tuple).
  //
  // ONE PAIR-TIME BAR IS DELIBERATELY NOT RE-APPLIED: `federation:pair` (owner ruling D4). That
  // permission gates re-keying, and this route's structural keylessness is exactly what makes it not
  // a re-key — "may edit peer transport, may NOT rotate a peer's trust anchor" is now enforced at BOTH
  // the schema and the permission layer, which was the point of splitting the permission. If
  // `UpdateFederationPeerRequestSchema` ever gains a field that can carry key material, this route
  // needs `federation:pair` in the same commit.
  // -----------------------------------------------------------------------------------------

  typed.route({
    method: "GET",
    url: "/api/v1/federation/peers/:id",
    schema: {
      params: z.object({ id: z.string().min(1) }),
      response: {
        200: FederationPeerSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getFederationPeer",
        summary: "Read one paired federation peer (by trust-domain id or name)",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const peer = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:read",
          scopeObjectId: auth.orgId
        });
        return getPeerByIdOrName(tx, auth.orgId, request.params.id);
      });
      reply.status(200).send(peer);
    }
  });

  typed.route({
    method: "PATCH",
    url: "/api/v1/federation/peers/:id",
    schema: {
      params: z.object({ id: z.string().min(1) }),
      body: UpdateFederationPeerRequestSchema,
      response: {
        200: FederationPeerSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        // Rail 5 (§7.2): declaring scope `full` refuses to re-anchor an anchorless cursor while a
        // journal_divergence stands for this peer — resync, don't re-anchor.
        409: JournalDivergenceProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "updateFederationPeer",
        summary:
          "Update a peer's transport settings ONLY (name/baseUrl/syncScope/deliveryTarget/pokeMode) — carries no key material and can never rotate a peer key",
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
        // GUARD G4, re-applied verbatim from the pair route: a per-peer deliveryTarget must sit
        // inside the operator-declared allowlists (SCP_DELIVERY_ROOTS / SCP_DELIVERY_S3_ENDPOINTS)
        // or it is never stored. Same call, same fail-closed 400 — a PATCH must not be a way to
        // smuggle in an out-of-root drop directory or an un-allowlisted S3 endpoint.
        assertDeliveryTargetRooted(request.body.deliveryTarget);
        const existing = await getPeerByIdOrName(tx, auth.orgId, request.params.id);
        // THE FIVE TRANSPORT FIELDS, SPREAD EXPLICITLY (review round 4, H9b). This used to be
        // `{ orgId, domainId: existing.id, ...request.body }` — the spread LAST, so a body-supplied
        // `domainId` would have overridden the RESOLVED peer id and the PATCH would land on a different
        // peer. It is safe today only because fastify-type-provider-zod's validatorCompiler replaces
        // `request.body` with a key-stripping parse — a behaviour documented nowhere near this call site
        // and one nobody would think to re-check when swapping validators. Naming the fields makes the
        // safety local and total: there is no key here that could carry an identity.
        return updatePeerTransport(tx, {
          orgId: auth.orgId,
          domainId: existing.id,
          ...(request.body.name !== undefined ? { name: request.body.name } : {}),
          ...(request.body.baseUrl !== undefined ? { baseUrl: request.body.baseUrl } : {}),
          ...(request.body.syncScope !== undefined ? { syncScope: request.body.syncScope } : {}),
          ...(request.body.deliveryTarget !== undefined
            ? { deliveryTarget: request.body.deliveryTarget }
            : {}),
          ...(request.body.pokeMode !== undefined ? { pokeMode: request.body.pokeMode } : {})
        });
      });
      reply.status(200).send(peer);
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
        404: ProblemSchema,
        // Divergence rails 1/2 (§7.2): a pull whose cursor is beyond this domain's own journal tail,
        // or whose anchor hash mismatches, is refused as a detected fork/rollback.
        409: JournalDivergenceProblemSchema
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
      let bundle: Awaited<ReturnType<typeof exportSyncBundle>>;
      let deliverPeer: Awaited<ReturnType<typeof getPeerByIdOrName>> | null;
      try {
        ({ bundle, deliverPeer } = await withTenantTx(deps.db, auth.orgId, async (tx) => {
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
            request.body.sinceSequence,
            request.body.lastAppliedRowHash
          );
          return { bundle, deliverPeer };
        }));
      } catch (err) {
        // Divergence rails 1/2 (§7.2): the detection threw and rolled back this read tx, so persist
        // the standing Decision in a SEPARATE committed tx (persist-on-change — one row per stuck
        // peer, not one per 60s retry), then answer the `journal_divergence` 409 carrying that
        // decision_id and the exporter's own tail for a one-round-trip operator view.
        if (err instanceof JournalDivergenceDetected) {
          const decisionId = await recordExportDivergence(deps.db, {
            orgId: auth.orgId,
            peerIdOrName: request.body.peer,
            divergence: err
          });
          throw new ProblemError(409, "Conflict", {
            type: JOURNAL_DIVERGENCE_PROBLEM_TYPE,
            detail: err.message,
            decisionId,
            extensions: {
              exporterTailSequence: err.exporterTailSequence,
              exporterTailRowHash: err.exporterTailRowHash
            }
          });
        }
        throw err;
      }
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

  // §7.2.6 RESYNC — the EXPORTER's consent endpoint: a peer sends a SIGNED request authorizing a
  // resync of ITS OWN replica; this verifies the signature against that peer's paired key, records a
  // consent Decision, bumps the exporter's generation, and returns a signed full re-export from
  // genesis. mTLS + federation:write gate it exactly like `/exports`.
  typed.route({
    method: "POST",
    url: "/api/v1/federation/resync",
    schema: {
      body: FederationResyncRequestSchema,
      response: {
        200: FederationResyncResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "federationResyncAuthorize",
        summary:
          "Authorize + re-export for a peer's resync (the exporter half of the §7.2.6 handshake)",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      await enforceFederationMtls(deps, request);
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:write",
          scopeObjectId: auth.orgId
        });
        return authorizeResyncAndReExport(tx, auth.orgId, request.body);
      });
      reply.status(200).send(result);
    }
  });

  // §7.2.6 RESYNC — the IMPORTER's operation: `scp federation resync --peer <exporter>`. Signs a
  // request, dials the exporter's `/resync`, verifies + FORCE-imports the re-export, resets its
  // cursor, bumps its generation, and clears the standing divergence (lifting rail 5). This is the
  // sanctioned recovery the no-anchor error message points at instead of a re-anchor.
  typed.route({
    method: "POST",
    url: "/api/v1/federation/peers/:id/resync",
    schema: {
      params: z.object({ id: z.string().min(1) }),
      response: {
        200: FederationResyncResultSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "federationResyncPeer",
        summary:
          "Resync this domain's replica with a peer after a journal divergence (importer half)",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const { exporterBaseUrl, signed } = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:write",
          scopeObjectId: auth.orgId
        });
        const peer = await getPeerByIdOrName(tx, auth.orgId, request.params.id);
        if (!peer.baseUrl) {
          // Resync is a LIVE two-way handshake — an air-gap peer with no dial URL cannot be resynced
          // over HTTP (it recovers via the file/bundle path instead). Refuse rather than crash.
          throw badRequest(
            `peer '${peer.name}' has no dial URL — resync requires a live connection to the exporter`
          );
        }
        const signed = await signResyncRequest(tx, auth.orgId, peer.id);
        return { exporterBaseUrl: peer.baseUrl, signed };
      });

      // Dial the exporter's /resync OUTSIDE the tx (the same bearer/mTLS the sync loop dials with).
      let mtls;
      try {
        mtls = resolveFederationClientMtls(process.env);
      } catch {
        mtls = undefined; // half-configured cert material → let the dial's requireMtls gate decide
      }
      const response = await dialResync({
        baseUrl: exporterBaseUrl,
        body: { peer: signed.importerDomainId, requestSignature: signed.requestSignature },
        bearer: process.env.SCP_FEDERATION_SYNC_BEARER || undefined,
        mtls
      });

      const result = await withTenantTx(deps.db, auth.orgId, (tx) =>
        applyResyncBundle(
          tx,
          auth.orgId,
          request.params.id,
          response.bundle,
          response.exporterGeneration
        )
      );
      reply.status(200).send(result);
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
        ...(deliverPeer ? { onwardPeerDomainId: deliverPeer.id } : {}),
        config
      });
      // FAIL-CLOSED: a failing/tampered/unauthorized/missing artifact refused the whole relay —
      // 409 carrying the persisted block Decision id, like every blocked response (DESIGN §6/§10.4).
      if (outcome.refused) {
        throw conflict(outcome.reason, { decisionId: outcome.decisionId });
      }
      // M13.1b — THIS ROUTE IS THE DOCUMENTED EXIT from the auto-relay's terminal `exhausted` state.
      // An operator who fixes whatever the unattended sweep gave up on and re-drives the hop by hand
      // has, by that act, both delivered the bytes and demonstrated the cause is gone; recording the
      // ledger row `built` is simply the truth, and it is what keeps `exhausted` from being a trap
      // that needs superuser SQL to clear. Upserts, so a manual relay on an instance/change with no
      // ledger row (a promotion imported before this milestone) records its outcome too. Deliberately
      // AFTER the refusal check: a refused manual build clears nothing.
      await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const change = await getChangeRow(tx, auth.orgId, request.body.change);
        const sourceRef = (change.sourceRef ?? {}) as Record<string, unknown>;
        await reopenRelayBuild(tx, {
          orgId: auth.orgId,
          changeObjectId: change.objectId,
          sourceChangeObjectId:
            typeof sourceRef.sourceChangeObjectId === "string"
              ? sourceRef.sourceChangeObjectId
              : null,
          tarballPath: outcome.tarballPath,
          decisionId: outcome.decisionId
        });
      });
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

  // M13.1b — the AUTO-RELAY BUILD LEDGER's OPERATOR READ SURFACE (owner ask): an operator on the
  // retrans box (CLI/API only — a retrans never serves the SPA, M16.3 P3 owner decision) can see
  // queue depth and exhausted rows without DB surgery. Simple `authorize`-in-its-own-tx shape,
  // like GET /federation/status's own permission gate: this handler has no out-of-tx work (no
  // cosign resolution, no subprocess), so there is no reason to split the transaction the way
  // /status and the export/relay routes must.
  //
  // ROLE-AGNOSTIC BY CONSTRUCTION (see relay-builds-repo.ts's `listRelayBuilds` doc): the ledger is
  // populated only on a `role: retrans` instance (seeded at promotion import there); on any other
  // role the table is honestly empty, so this route never 409s on role — an empty `items` array is
  // the truth, matching every other read surface in this codebase.
  typed.route({
    method: "GET",
    url: "/api/v1/federation/relay-builds",
    schema: {
      // No pagination cursor: this is a bounded TRIAGE read (queue depth + exhausted rows), not
      // enumeration — see RelayBuildListResponseSchema's doc for the `{ items }` shape choice. No
      // existing route bounds a plain (non-cursor) `limit`, so the default/cap here are this
      // route's own choice, documented rather than inherited: 100 keeps the common "show me what's
      // stuck" call cheap, 500 is a generous but finite ceiling against an unbounded scan.
      querystring: z.object({
        status: RelayBuildStatusSchema.optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100)
      }),
      response: {
        200: RelayBuildListResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "listFederationRelayBuilds",
        summary:
          "Operator triage: the auto-relay build ledger (queue depth, exhausted rows) — populated on role:retrans instances, honestly empty elsewhere",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const items = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:read",
          scopeObjectId: auth.orgId
        });
        return listRelayBuilds(tx, auth.orgId, {
          ...(request.query.status !== undefined ? { status: request.query.status } : {}),
          limit: request.query.limit
        });
      });
      reply.status(200).send({ items });
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
        // `woken` = "this poke woke SOMETHING" — ANY leg. A pure air-gap outpost runs an inbox
        // loop and no sync queue, so keying `woken` on the sync wake alone under-reported the very
        // leg M14.4 added (an accepted poke that successfully woke the air-gap leg read as
        // `woken:false`). The per-leg booleans are additive and report which one(s) fired.
        202: z.object({
          accepted: z.literal(true),
          woken: z.boolean(),
          wokenSync: z.boolean().optional(),
          wokenInbox: z.boolean().optional(),
          /** M13.1b — the auto-relay leg (a `role: retrans` staging node's onward BYTE hop). */
          wokenRelay: z.boolean().optional()
        }),
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

      // M14.4 (D2 — SELF-PROVING SPARSE): record that a poke from this peer ACTUALLY ARRIVED. The
      // scheduler keeps a pokeMode peer on the FREQUENT cadence until this stamp exists, so an
      // outpost can never go sparse on the strength of its own flag alone (poke-mode is TWO
      // independent flags on TWO instances; the commander's half may never have been enabled).
      // Stamped AFTER the consent + rate-limit gates, so only an HONORED poke counts as proof.
      await withTenantTx(deps.db, auth.orgId, (tx) => markPokeReceived(tx, auth.orgId, peer.id));

      // WAKE — enqueue immediate ticks and return fast. The loops' workers do the actual work; we
      // never pull inline. No queue on this process (pure role=api, or the loops are disabled) →
      // accepted-but-no-op (the sparse safety-net is the reliability floor).
      //
      // THREE loops, THREE independent try/catches (M14.4 S6, extended by M13.1b):
      //   1. the federation-sync loop — the CONNECTED leg (an outpost that dials its commander); the
      //      wake carries `{reason:"poke", orgId}` so the worker runs a FORCED tick that bypasses the
      //      M14.4 due-gate. The orgId is the CALLER'S OWN AUTHENTICATED org, never a request body.
      //   2. the inbox loop — the AIR-GAP leg. An air-gapped outpost has NO role:commander peer with
      //      a baseUrl; its content arrives as a FILE. Without this, the ADR-0009 §38 "required"
      //      high-side-retrans→outpost poke would wake a sweep that resolves to ZERO peers.
      //   3. the auto-relay loop — the BYTE leg at a `role: retrans` staging node (M13.1b). Legs 1
      //      and 2 move METADATA; until this one existed, a poke landing on a retrans woke the
      //      import of the arriving `.scpbundle` and then waited for a human to run the byte hop
      //      (M14.4's honest-scope note, owner decision D3). This is what makes the chain move bytes.
      // Each in its own try/catch so a missing queue on any side still returns accepted:true.
      let wokenSync = false;
      let wokenInbox = false;
      let wokenRelay = false;
      if (deps.boss) {
        try {
          await wakeFederationSyncNow(deps.boss, auth.orgId);
          wokenSync = true;
        } catch (err) {
          request.log.warn(
            { err: err instanceof Error ? err.message : String(err), peer: peer.name },
            "federation poke accepted but could not enqueue a sync tick (sync loop likely not running) " +
              "— no-op-but-accepted; the sparse safety-net pull remains the reliability floor"
          );
        }
        // Only when THIS deployment runs an inbox loop: otherwise the queue does not exist and the
        // send is pure noise. (The flag is a deployment-wide env; the worker replica that created
        // the queue shares it with the api replica serving this request.)
        if (inboxLoopEnabled()) {
          try {
            await wakeInboxNow(deps.boss);
            wokenInbox = true;
          } catch (err) {
            request.log.warn(
              { err: err instanceof Error ? err.message : String(err), peer: peer.name },
              "federation poke accepted but could not enqueue an inbox tick (inbox loop likely not " +
                "running) — no-op-but-accepted; the air-gap leg falls back to the inbox interval"
            );
          }
        }
        // Only when THIS deployment opted into unattended byte egress: otherwise the queue does not
        // exist and the send is pure noise (same gate shape as the inbox leg above).
        if (autoRelayEnabled()) {
          try {
            await wakeAutoRelayNow(deps.boss);
            wokenRelay = true;
          } catch (err) {
            request.log.warn(
              { err: err instanceof Error ? err.message : String(err), peer: peer.name },
              "federation poke accepted but could not enqueue an auto-relay tick (auto-relay loop " +
                "likely not running) — no-op-but-accepted; the byte hop falls back to the auto-relay " +
                "interval"
            );
          }
        }
      }
      const stats = recordPokeWake({ wokenSync, wokenInbox, wokenRelay });
      // ANY leg counts as woken. On a pure air-gap outpost the sync queue does not exist at all
      // (nothing to dial) while the inbox loop is the one that matters — reporting `woken:false`
      // there would have the response contradict the wake that actually happened. Same for a slim
      // `role: retrans` profile whose only woken leg is the byte hop.
      const woken = wokenSync || wokenInbox || wokenRelay;
      if (!woken) {
        // SPLIT-TOPOLOGY HOLE — countable, not a silent one-liner: this poke was accepted and woke
        // NOTHING. One occurrence is benign; a monotonically climbing `notWoken` means poke-mode is
        // effectively off for this instance (pokes are landing on a process with no job queue).
        request.log.warn(
          { peer: peer.name, pokeWakeStats: stats },
          "federation poke accepted but woke NOTHING on this process (no job queue: role=api, or the " +
            "sync/inbox/auto-relay loops are disabled) — no-op-but-accepted; watch pokeWakeStats.notWoken, " +
            "a climbing value means poke-mode is effectively off and only the sparse safety-net is syncing"
        );
      }
      reply.status(202).send({ accepted: true as const, woken, wokenSync, wokenInbox, wokenRelay });
    }
  });

  /**
   * ==============================================================================================
   * THE TWO OVERLAY DOORS ARE NOT FEDERATION DOORS (role-model.md §8.6)
   * ==============================================================================================
   * Every other `authorize()` in this file is correctly pinned at `auth.orgId`: a federation
   * identity, a peer, a journal, an outpost topology and an import/export are org-level concepts,
   * and a binding narrower than the org root holds authority over none of them. These two are the
   * exception, and a census sorted BY FILE sweeps them into that bucket wrongly — what they write
   * and read is an annotation ON a base graph object: a service, a component, a policy.
   *
   * SO EACH GAINS A SECOND CHECK AT THE RESOLVED BASE OBJECT — ADDED, NEVER SUBSTITUTED.
   *
   * WHY THE BASE. `getMergedOverlayView` is a READ-TIME merge (DESIGN §13), so an overlay on a
   * component silently changes what every consumer of that component sees, without touching the
   * component's own row. Authority over the thing being annotated is the bar that was missing.
   *
   * WHY THE ORG-ROOT BAR STAYS. `createOverlay` calls `createObject` with no `domainId`, so an
   * overlay's row always lands at ORG-ROOT containment. That is a STORAGE fact, not an AUTHORITY
   * fact, and it must not be read in either direction: it does not make org-root `object:write` the
   * whole story (see above), and it does not make a base-scoped check a replacement for it.
   * `federation/overlay-repo.ts`'s governance-managed guard demands `policy:write` AT THE ORG ROOT
   * for exactly the storage reason, and its own doc explains why substituting a base-scoped check
   * there would let a component-scoped principal mint overlays outranking a commander-origin
   * object. §8.6 lists that guard among the deliberate escalation bars this increment must not
   * sweep. Keeping the org-root bar first also keeps these doors' 403 for an unbound caller
   * byte-identical to today's, and keeps the base resolution behind an authorization check.
   *
   * ============================================================================================
   * THESE TWO DOORS WERE **TIGHTENED**, NOT RE-SCOPED — SO THE PURE-WIDENING INVARIANT DOES NOT
   * GOVERN THEM (owner-level judgement, 2026-08-26)
   * ============================================================================================
   * Increment 2.5a re-scoped 21 get-by-id doors OFF `scopeObjectId: auth.orgId` and ONTO the object
   * each governs, and that re-scope carries a strict invariant: every request that succeeded before
   * must still succeed. `authz/org-root-arm.ts` exists to make it hold, because `scopeExpandCte`
   * joins every ancestor `deleted_at IS NULL` and so reaches nothing at all from an object whose
   * parents are tombstoned — something an org-root pin could never do to anybody.
   *
   * THESE TWO DOORS ARE NOT IN THAT SET. Nothing was moved off the org root here: BAR 1 is the
   * pre-2.5a check, unchanged, and BAR 2 was ADDED beside it. Adding a bar is a DELIBERATE
   * NARROWING — it is the entire point of the change (§8.6, and the hand-fill/publish precedent from
   * PR #286) — so measuring it against an invariant written for a widening is a category error, and
   * it was made once already on this branch. The right question for a conjunction is "does the new
   * bar refuse the right things", not "does it refuse anyone the old bar admitted"; by construction
   * it does refuse some of them, or it would not be a bar.
   *
   * WHAT BAR 2 REFUSES — TWO CASES, both accepted, neither a defect:
   *
   *   1. an explicit `deny` binding AT THE BASE. The bar's purpose, and pinned by
   *      `federation-overlay-base-authority.integration.test.ts` — a deny is reached only by a check
   *      scoped at the base, which is what makes the added bar observable at all.
   *   2. A BASE WHOSE CONTAINMENT ANCESTORS ARE TOMBSTONED. `scopeExpandCte` joins every ancestor
   *      `deleted_at IS NULL`, so the walk from such a base reaches NOTHING — not even the org root
   *      — and BAR 2 then refuses EVERYONE, an org-root Owner included. Stated plainly, because it
   *      is a real operational state and not a footnote: **an overlay whose base has tombstoned
   *      containment ancestors cannot be created or read by anybody until that base's containment
   *      chain is repaired.** Reachability is narrow but real — `deleteObject`'s orphan guard stops
   *      a LIVE base from having a tombstoned parent locally, and is deliberately skipped on the
   *      federation-import path, which is precisely where a foreign-origin base lives. The remedy is
   *      to repair the chain (re-import or re-parent the base), not to hold an overlay door open
   *      over an object nothing can currently establish authority over.
   *
   * AND THE ORG-ROOT ARM IS DELIBERATELY NOT APPLIED TO BAR 2. `checkAtOrgRootOrScopes` composes
   * "at the org root OR at the governed object", which is the right shape for a re-scope and the
   * wrong shape here: BAR 1 has already established that the caller holds the permission at the org
   * root, so an org-root arm on BAR 2 is satisfied by every principal that reaches it. That does not
   * "fix case 2" — it deletes BAR 2 entirely, case 1 with it, and would leave two mutation-proven
   * tests green over a door with one bar. Distinguishing "explicitly denied" from "nothing reached"
   * is the only fix that would preserve case 1, and that is a new authz primitive and an owner
   * decision, not a comment. Case 2 is therefore a KNOWN, ACCEPTED state, pinned by a test that
   * asserts the 403 so it is discovered here rather than in production.
   *
   * The bar is built now because the increment that gives out bindings below the org root is the
   * one where it starts mattering, and because a later sweep that relaxes the org-root pin here
   * would otherwise leave the door with no bar at all.
   *
   * THE BASE IS RESOLVED BEFORE IT IS SCOPED. `scopeExpandCte` seeds its CTE with the raw uuid and
   * never checks existence, so a check scoped at an unresolved caller-supplied value refuses
   * everybody — including an org-root Owner, who would get a 403 where a 404 is the honest answer.
   *
   * PINNED BY `routes/federation-overlay-base-authority.integration.test.ts` (mutation-proven),
   * with the no-regression half in `governance/governance-managed-write-doors.integration.test.ts`.
   */
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
        // BAR 1 — unchanged: the overlay ROW lands at org-root containment. See the block above.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: auth.orgId
        });
        // BAR 2 — ADDED, at the object being annotated: a deliberate NARROWING, not a re-scope, so
        // it carries no org-root arm (the block above says why one would delete the bar). A base
        // whose ancestors are tombstoned refuses everybody here, by design and pinned by test.
        // `createOverlay` resolves the base again a
        // moment later (it is the choke point every one of its type refusals is written against,
        // and moving the resolution out of it would put those refusals behind a route that could
        // drift); one indexed lookup buys an authorization decision that cannot be made from the
        // caller-supplied string alone, and buys the 404 that scoping at that string would destroy.
        const base = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.body.base);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: base.id
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
        // BAR 1 — unchanged: the overlays this merges all live at org-root containment.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        // BAR 2 — ADDED, at the object being read: the same deliberate narrowing as on the create
        // door, and with the same accepted consequence for a base whose ancestors are tombstoned.
        // The merge is computed FIRST because it is what
        // resolves (and 404s on) the base; it is a pure computed view that writes nothing, and it
        // is already behind BAR 1, so nothing reaches it that today's door would have refused. The
        // response is withheld until authority at the base itself is established.
        const view = await getMergedOverlayView(tx, auth.orgId, request.params.idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: view.base.id
        });
        return view;
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
          // Authorization only — the ROW is still authored by `FEDERATION_IMPORT_ACTOR_ID`, which is
          // what makes a later signed bundle reconcile over it (see `handfill-repo.ts`'s module doc).
          // `handFillObject` deliberately does NOT reuse this for the upsert's own `actorObjectId`
          // (that stays the synthetic import actor, which is what makes the row a shadow copy) — it
          // is the subject the governance-authority, policy-scope and governance-label refusals all
          // resolve.
          actorObjectId: auth.subjectObjectId,
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

  // -----------------------------------------------------------------------------------------
  // M16.2 phase A (E1) — `outpost` GRAPH-OBJECT config: the commander-authored declared config that
  // SYNCS DOWN (nothing written on a `federation_peers` row can, since the journal has no peer-shaped
  // entry kind). Read `federation/outpost-binding.ts` for the authority split between the two halves.
  //
  // GATED ON `federation:write`/`federation:read`, NOT plain `object:write`. That is deliberate and is
  // why the generic `/objects/outpost` door is refused outright (`routes/objects-generic.ts`): a side
  // door with a weaker permission on the same rows is exactly the governance-owned-type bypass this
  // codebase already paid for once.
  // -----------------------------------------------------------------------------------------

  typed.route({
    method: "POST",
    url: "/api/v1/federation/outposts",
    schema: {
      body: CreateOutpostConfigRequestSchema,
      response: {
        201: OutpostConfigSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "createOutpostConfig",
        summary:
          "Declare an already-paired outpost's commander-origin config object (trust tier) — syncs down as a read-only replica",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const config = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:write",
          scopeObjectId: auth.orgId
        });
        return createOutpostConfig(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          peerDomainId: request.body.peerDomainId,
          ...(request.body.name !== undefined ? { name: request.body.name } : {}),
          ...(request.body.trustTier !== undefined ? { trustTier: request.body.trustTier } : {})
        });
      });
      reply.status(201).send(config);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/federation/outposts",
    schema: {
      response: { 200: z.array(OutpostConfigSchema), 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listOutpostConfigs",
        summary: "List every outpost config object (commander-origin declared config)",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const configs = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:read",
          scopeObjectId: auth.orgId
        });
        return listOutpostConfigs(tx, auth.orgId);
      });
      reply.status(200).send(configs);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/federation/outposts/:peerDomainId",
    schema: {
      params: z.object({ peerDomainId: z.string().uuid() }),
      response: {
        200: OutpostConfigSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getOutpostConfig",
        summary: "Read one outpost's config object, resolved through its peer binding",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const config = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:read",
          scopeObjectId: auth.orgId
        });
        return getOutpostConfigByPeer(tx, auth.orgId, request.params.peerDomainId);
      });
      reply.status(200).send(config);
    }
  });

  typed.route({
    method: "PATCH",
    url: "/api/v1/federation/outposts/:peerDomainId",
    schema: {
      params: z.object({ peerDomainId: z.string().uuid() }),
      body: UpdateOutpostConfigRequestSchema,
      response: {
        200: OutpostConfigSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema,
        412: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "updateOutpostConfig",
        summary:
          "Edit an outpost's commander-origin config (absent means preserve) — refused with 409 on an instance holding it as a replica",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const config = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:write",
          scopeObjectId: auth.orgId
        });
        return updateOutpostConfig(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          peerDomainId: request.params.peerDomainId,
          ...(request.body.name !== undefined ? { name: request.body.name } : {}),
          ...(request.body.trustTier !== undefined ? { trustTier: request.body.trustTier } : {}),
          ...(request.body.expectedVersion !== undefined
            ? { expectedVersion: request.body.expectedVersion }
            : {})
        });
      });
      reply.status(200).send(config);
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/federation/outposts/:peerDomainId/reconcile",
    schema: {
      params: z.object({ peerDomainId: z.string().uuid() }),
      /** N9 — a QUERY parameter rather than a body, so the default call is unchanged and needs no
       *  body at all. Names the row that should SURVIVE; absent keeps the most authoritative one.
       *
       *  `ifClaimant` is the OPTIMISTIC-CONCURRENCY PRECONDITION, repeatable, one
       *  `<objectId>:<version>` per claimant the caller previewed. Same wire form as `keep` for the
       *  same reason: the default call stays body-free and unchanged. Absent = proceed unchecked
       *  (additivity forces that default — see `assertClaimantsUnchanged`). */
      querystring: z.object({
        keep: z.string().uuid().optional(),
        ifClaimant: OutpostIfClaimantQuerySchema.optional()
      }),
      response: {
        200: OutpostConfigReconcileResultSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema,
        /** Today the ONLY 412 this route produces is the stale-claimant refusal, so `claimants` is
         *  populated on every 412 this handler actually throws — but the field itself is OPTIONAL
         *  (R1 fix, PR #156 residual): a bare `preconditionFailed` with no extension must still
         *  serialize as 412, not 500, however unreachable that branch is today. Declaring the
         *  schema here is also what lets `claimants` through at all: the zod serializer strips every
         *  member a response schema does not name, extension members included. */
        412: OutpostReconcileStaleProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "reconcileOutpostConfig",
        summary:
          "RECOVERY: restore the 1:1 peer↔config binding for a peer holding duplicate outpost config objects (adopts an unverified hand-filled shadow, removes the rest; ?keep=<objectId> chooses the survivor and may drop a row this domain authored; ?ifClaimant=<objectId>:<version> refuses with 412 if the claimants changed since they were previewed)",
        tags: ["federation"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:write",
          scopeObjectId: auth.orgId
        });
        return reconcileOutpostConfig(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id,
          peerDomainId: request.params.peerDomainId,
          ...(request.query.keep !== undefined ? { keepObjectId: request.query.keep } : {}),
          // ABSENT means unchecked; a present token is always non-empty, because a query parameter
          // repeated zero times IS absence — "I previewed no claimants" is not expressible on this
          // wire, and a peer with no claimants has nothing to reconcile anyway (404).
          ...(request.query.ifClaimant !== undefined
            ? { ifClaimants: request.query.ifClaimant.map(parseOutpostClaimantToken) }
            : {})
        });
      });
      reply.status(200).send(result);
    }
  });
}
