import { createHash } from "node:crypto";
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
/**
 * MAJOR #5 — the replay/redelivery dedupe key for one webhook delivery. Provider delivery
 * identifiers (stable across a redelivery of the SAME event, distinct for genuinely different
 * events) are strongly preferred; the raw-body hash is the fallback for sources that send no such
 * header (it dedupes byte-identical payloads, which is the best available signal absent a delivery
 * id). Hashing the RAW bytes (`request.rawBody`, captured pre-JSON-parse by app.ts) — not a
 * re-serialized `JSON.stringify(body)` — keeps the fallback stable against key-order/whitespace.
 */
function computeDedupeKey(
  headers: Record<string, unknown>,
  rawBody: Buffer | undefined,
  body: unknown
): string {
  const deliveryHeader = headers["x-github-delivery"] ?? headers["x-scp-delivery"];
  if (typeof deliveryHeader === "string" && deliveryHeader.length > 0) {
    return `delivery:${deliveryHeader}`;
  }
  const bytes = rawBody ?? Buffer.from(JSON.stringify(body ?? null), "utf8");
  return `payload-sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

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

        // MAJOR #5 — dedupe redeliveries/replays. Prefer the provider's own delivery identifier
        // (GitHub `X-GitHub-Delivery`, or a generic `X-SCP-Delivery` an adapter can set), which is
        // stable across a redelivery of the SAME event; fall back to a hash of the raw body when no
        // delivery header exists. The unique index on (org_id, source_kind, dedupe_key) makes a
        // second delivery of the same key a no-op (returns the FIRST event's id), so a replayed —
        // even validly-signed — webhook never creates a second Change / fires a second real trigger.
        const dedupeKey = computeDedupeKey(request.headers, request.rawBody, request.body);
        const id = uuidv7();
        const inserted = await tx
          .insert(changeSourceEvents)
          .values({
            id,
            orgId: auth.orgId,
            sourceKind: request.params.sourceKind,
            signatureVerified,
            dedupeKey,
            headers: request.headers as Record<string, unknown>,
            payload: request.body
          })
          .onConflictDoNothing({
            target: [
              changeSourceEvents.orgId,
              changeSourceEvents.sourceKind,
              changeSourceEvents.dedupeKey
            ]
          })
          .returning({ id: changeSourceEvents.id });
        if (inserted[0]) return inserted[0].id;
        // Conflict: this exact delivery was already ingested — return the original event's id.
        const existing = await tx
          .select({ id: changeSourceEvents.id })
          .from(changeSourceEvents)
          .where(
            and(
              eq(changeSourceEvents.orgId, auth.orgId),
              eq(changeSourceEvents.sourceKind, request.params.sourceKind),
              eq(changeSourceEvents.dedupeKey, dedupeKey)
            )
          )
          .limit(1);
        return existing[0]?.id ?? id;
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
          componentIdOrUrn: request.body.component,
          purpose: request.body.purpose
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
