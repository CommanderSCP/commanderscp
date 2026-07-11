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
  SyncBundleSchema
} from "@scp/schemas";
import type { ImportBundleRequest, PromotionBundle } from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { badRequest } from "../errors.js";
import { initFederationSelf, ensureFederationSelf } from "../federation/self-repo.js";
import { pairPeer, listPeers } from "../federation/peers-repo.js";
import { ensureInstanceKey } from "../governance/attestation.js";
import { getFederationStatus } from "../federation/status-repo.js";
import { exportSyncBundle } from "../federation/export-repo.js";
import { importSyncBundle } from "../federation/import-repo.js";
import { exportPromotionBundle, importPromotionBundle } from "../federation/promotion-repo.js";
import { createOverlay, getMergedOverlayView } from "../federation/overlay-repo.js";
import { handFillObject } from "../federation/handfill-repo.js";

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
        summary: "Designate this domain's federation role (parent|child)",
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
      reply.status(200).send(result);
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
      const status = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:read",
          scopeObjectId: auth.orgId
        });
        return getFederationStatus(tx, auth.orgId);
      });
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
      const auth = await requireAuth(deps, request);
      const bundle = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:write",
          scopeObjectId: auth.orgId
        });
        return exportSyncBundle(tx, auth.orgId, request.body.peer, request.body.sinceSequence);
      });
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
      const auth = await requireAuth(deps, request);
      const bundle = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:write",
          scopeObjectId: auth.orgId
        });
        return exportPromotionBundle(tx, {
          orgId: auth.orgId,
          peerIdOrName: request.body.peer,
          changeIdOrUrn: request.body.change
        });
      });
      reply.status(200).send(bundle);
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
      const auth = await requireAuth(deps, request);
      const result = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "federation:write",
          scopeObjectId: auth.orgId
        });
        if (isPromotionBundle(request.body)) {
          const imported = await importPromotionBundle(tx, auth.orgId, request.body);
          return { kind: "promotion" as const, ...imported };
        }
        const imported = await importSyncBundle(tx, auth.orgId, request.body);
        return { kind: "sync" as const, ...imported };
      });
      reply.status(200).send(result);
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
          "Manually enter a parent-origin object as an unverified shadow copy (air-gapped, no bundle transport)",
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
