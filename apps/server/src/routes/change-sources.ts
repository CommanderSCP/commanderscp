import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { v7 as uuidv7 } from "uuid";
import {
  ChangeSourceEventParamSchema,
  ChangeSourceWebhookBodySchema,
  CreateSourceMappingRequestSchema,
  CreateWebhookSecretRequestSchema,
  ProblemSchema,
  SourceMappingListResponseSchema,
  SourceMappingSchema,
  WebhookIngressResponseSchema,
  WebhookSecretConfiguredResponseSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { unauthorized } from "../errors.js";
import { changeSourceEvents, changeSourceWebhookSecrets } from "../db/schema.js";
import {
  createSourceMapping,
  listSourceMappingsForSource
} from "../coordination/source-mappings-repo.js";
import { resolveWebhookSecret, verifierForSourceKind } from "../coordination/webhook-signature.js";
import { putSecret } from "../secrets/secrets-repo.js";
import { and, eq } from "drizzle-orm";

/**
 * Change sources: webhook ingress (persist-then-process, DESIGN.md §8) + `source_mappings` CRUD
 * (DESIGN §9.2 correlation). BUILD_AND_TEST.md §8 M3/M7.
 *
 * **Authentication:** every call still goes through `requireAuth` (Bearer/PAT) — M3's "a
 * source-specific adapter forwards actual provider webhooks here with a configured PAT" posture
 * (a real GitHub App / TFC webhook sender carries no PAT of its own) is UNCHANGED in this
 * milestone; direct, PAT-free provider-to-SCP webhook delivery is documented follow-up work, not
 * this milestone's scope. What M7 DOES add: real, fail-closed HMAC SIGNATURE verification
 * (`coordination/webhook-signature.ts`) layered ON TOP of that PAT auth, for any org+sourceKind
 * pair that has configured a webhook secret (`PUT .../webhook-secret` below). A configured secret
 * makes verification MANDATORY: a missing/invalid signature is REJECTED (401) and the delivery is
 * never persisted at all — no half-measure "persist as unverified and hope". An org/sourceKind
 * with NO secret configured keeps M3's original behavior (`signature_verified: false`, honestly
 * reflecting that no verification happened, never silently defaulted to `true`).
 */
export function registerChangeSourceRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.route({
    method: "POST",
    url: "/api/v1/change-sources/:sourceKind/webhook",
    schema: {
      params: ChangeSourceEventParamSchema,
      body: ChangeSourceWebhookBodySchema,
      response: {
        202: WebhookIngressResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "ingestChangeSourceWebhook",
        summary:
          "Persist a raw source-event payload (persist-then-process — coordination/webhook-processor.ts turns it into a Change on the next reconcile tick)",
        tags: ["change-sources"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const eventId = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: auth.orgId
        });

        // M7 signature verification — see module doc. `secret` is `undefined` when this
        // org+sourceKind has none configured, in which case verification is skipped entirely
        // (M3 behavior, unchanged) rather than treated as a failure.
        const secret = await resolveWebhookSecret(
          tx,
          auth.orgId,
          request.params.sourceKind,
          deps.config.secretsMasterKey
        );
        let signatureVerified = false;
        if (secret !== undefined) {
          const verifier = verifierForSourceKind(request.params.sourceKind);
          const headerValue = request.headers[verifier.headerName] as string | undefined;
          const rawBody = request.rawBody;
          const verified = rawBody !== undefined && verifier.verify(rawBody, headerValue, secret);
          if (!verified) {
            // Fail closed: REJECTED, never persisted (SECURITY-SENSITIVE — "a bad/missing HMAC
            // signature is rejected, never processed"). Thrown from inside withTenantTx rolls the
            // whole transaction back, so nothing about this delivery is ever written.
            throw unauthorized(`invalid or missing '${verifier.headerName}' webhook signature`);
          }
          signatureVerified = true;
        }

        const id = uuidv7();
        await tx.insert(changeSourceEvents).values({
          id,
          orgId: auth.orgId,
          sourceKind: request.params.sourceKind,
          signatureVerified,
          headers: request.headers as Record<string, unknown>,
          payload: request.body
        });
        return id;
      });
      reply.status(202).send({ accepted: true, eventId });
    }
  });

  // -----------------------------------------------------------------------------------------
  // Webhook signing secret configuration (M7) — an org points its GitHub App / TFC / Atlantis /
  // custom-adapter webhook config at whatever HMAC secret it registers here; the secret's
  // PLAINTEXT is encrypted at rest (secrets/crypto.ts) and referenced by key from
  // `change_source_webhook_secrets`, never stored twice.
  // -----------------------------------------------------------------------------------------

  typed.route({
    method: "PUT",
    url: "/api/v1/change-sources/:sourceKind/webhook-secret",
    schema: {
      params: ChangeSourceEventParamSchema,
      body: CreateWebhookSecretRequestSchema,
      response: {
        200: WebhookSecretConfiguredResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "putChangeSourceWebhookSecret",
        summary: "Configure (or rotate) this org+sourceKind's webhook HMAC signing secret",
        tags: ["change-sources"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: auth.orgId
        });
        const secretKey = `change-source-webhook:${request.params.sourceKind}`;
        await putSecret(tx, {
          orgId: auth.orgId,
          key: secretKey,
          value: request.body.secret,
          masterKey: deps.config.secretsMasterKey
        });

        const existing = await tx
          .select({ id: changeSourceWebhookSecrets.id })
          .from(changeSourceWebhookSecrets)
          .where(
            and(
              eq(changeSourceWebhookSecrets.orgId, auth.orgId),
              eq(changeSourceWebhookSecrets.sourceKind, request.params.sourceKind)
            )
          )
          .limit(1);
        if (existing[0]) {
          await tx
            .update(changeSourceWebhookSecrets)
            .set({ secretKey, updatedAt: new Date() })
            .where(eq(changeSourceWebhookSecrets.id, existing[0].id));
        } else {
          await tx.insert(changeSourceWebhookSecrets).values({
            id: uuidv7(),
            orgId: auth.orgId,
            sourceKind: request.params.sourceKind,
            secretKey
          });
        }
      });
      reply.status(200).send({ configured: true, sourceKind: request.params.sourceKind });
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/change-sources/:sourceKind/mappings",
    schema: {
      params: ChangeSourceEventParamSchema,
      body: CreateSourceMappingRequestSchema,
      response: {
        201: SourceMappingSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "createSourceMapping",
        summary:
          "Bind a repo/path pattern for this source kind to a component (DESIGN §9.2 correlation)",
        tags: ["change-sources"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const mapping = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: auth.orgId
        });
        return createSourceMapping(tx, {
          orgId: auth.orgId,
          sourceKind: request.params.sourceKind,
          repoPattern: request.body.repoPattern,
          pathPattern: request.body.pathPattern,
          componentIdOrUrn: request.body.component
        });
      });
      reply.status(201).send(mapping);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/change-sources/:sourceKind/mappings",
    schema: {
      params: ChangeSourceEventParamSchema,
      response: { 200: SourceMappingListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listSourceMappings",
        summary: "List source_mappings for one source kind",
        tags: ["change-sources"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const items = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        return listSourceMappingsForSource(tx, auth.orgId, request.params.sourceKind);
      });
      reply.status(200).send({ items, nextCursor: null });
    }
  });
}
