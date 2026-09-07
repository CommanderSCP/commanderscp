import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { v7 as uuidv7 } from "uuid";
import {
  ChangeReportRequestSchema,
  ChangeSourceEventParamSchema,
  ChangeSourceWebhookBodySchema,
  CreateSourceMappingRequestSchema,
  DeleteSourceMappingRequestSchema,
  DeleteSourceMappingResponseSchema,
  CreateWebhookSecretRequestSchema,
  ProblemSchema,
  SetSourceMappingEnabledRequestSchema,
  SetSourceMappingScopeRequestSchema,
  SourceMappingIdParamSchema,
  SourceMappingListResponseSchema,
  SourceMappingSchema,
  WebhookIngressResponseSchema,
  WebhookSecretConfiguredResponseSchema
} from "@scp/schemas";
import type { AppDeps } from "../types.js";
import { LARGE_BODY_LIMIT_BYTES } from "../http-limits.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { checkAtOrgRootOrScopes } from "../authz/org-root-arm.js";
import { assertStageDependenciesWithinAuthority } from "../coordination/campaign-scope-authz.js";
import { extractHint } from "../coordination/webhook-processor.js";
import { forbidden, unauthorized } from "../errors.js";
import { changeSourceEvents, changeSourceWebhookSecrets } from "../db/schema.js";
import {
  createSourceMapping,
  deleteSourceMappingsMatching,
  getSourceMapping,
  listSourceMappingsForSource,
  setSourceMappingEnabled,
  setSourceMappingScope
} from "../coordination/source-mappings-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { resolveWebhookSecret, verifierForSourceKind } from "../coordination/webhook-signature.js";
import { putSecret } from "../secrets/secrets-repo.js";
import { and, eq } from "drizzle-orm";

/** Change sources: webhook ingress. See docs/routes.md §31. */
/** The replay and redelivery dedupe key for one delivery. See docs/routes.md §32. */
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

/** Persist ONE source event. See docs/routes.md §33. */
async function persistSourceEvent(
  tx: TenantTx,
  args: {
    orgId: string;
    sourceKind: string;
    signatureVerified: boolean;
    dedupeKey: string;
    headers: Record<string, unknown>;
    payload: unknown;
    /** ADR-0028: the authenticated reporter, kept for the processor — which runs as the system
     *  actor and would otherwise attribute the `depends_on` edges a declaration mints to it. */
    reportedByObjectId: string;
  }
): Promise<string> {
  const id = uuidv7();
  const inserted = await tx
    .insert(changeSourceEvents)
    .values({
      id,
      orgId: args.orgId,
      sourceKind: args.sourceKind,
      signatureVerified: args.signatureVerified,
      dedupeKey: args.dedupeKey,
      headers: args.headers,
      payload: args.payload,
      reportedByObjectId: args.reportedByObjectId
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
        eq(changeSourceEvents.orgId, args.orgId),
        eq(changeSourceEvents.sourceKind, args.sourceKind),
        eq(changeSourceEvents.dedupeKey, args.dedupeKey)
      )
    )
    .limit(1);
  return existing[0]?.id ?? id;
}

/** The write bar for the three mapping mutation doors. See docs/routes.md §34. */
async function assertSourceMappingWritable(
  tx: TenantTx,
  input: { orgId: string; subjectObjectId: string; componentObjectId: string }
): Promise<void> {
  const verdict = await checkAtOrgRootOrScopes(tx, {
    orgId: input.orgId,
    subjectObjectId: input.subjectObjectId,
    orgRootPermission: "object:write",
    scopedPermission: "object:write",
    quantifier: "any",
    scopeObjectIds: [input.componentObjectId]
  });
  if (verdict.ok) return;
  throw forbidden(
    `subject '${input.subjectObjectId}' lacks 'object:write' at the org root and at source-mapping ` +
      `component '${input.componentObjectId}'`
  );
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

        // The second door to a materialised dependency edge. See docs/routes.md §35.
        await assertStageDependenciesWithinAuthority(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          stageDependencies: extractHint(request.params.sourceKind, request.headers, request.body)
            .stageDependencies
        });

        // MAJOR #5 — dedupe redeliveries/replays. See docs/routes.md §36.
        const dedupeKey = computeDedupeKey(request.headers, request.rawBody, request.body);
        return persistSourceEvent(tx, {
          orgId: auth.orgId,
          sourceKind: request.params.sourceKind,
          signatureVerified,
          dedupeKey,
          headers: request.headers as Record<string, unknown>,
          payload: request.body,
          reportedByObjectId: auth.subjectObjectId
        });
      });
      reply.status(202).send({ accepted: true, eventId });
    }
  });

  // Typed first-party report ingress. See docs/routes.md §37.
  typed.route({
    method: "POST",
    url: "/api/v1/change-sources/:sourceKind/report",
    // Carries an open-ended IaC `planJson` blob (executors.ts) that can run to many MiB; opt up from
    // the modest global ceiling to the large-payload ceiling (http-limits.ts) — still finite.
    bodyLimit: LARGE_BODY_LIMIT_BYTES,
    schema: {
      params: ChangeSourceEventParamSchema,
      body: ChangeReportRequestSchema,
      response: {
        202: WebhookIngressResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "reportChangeSource",
        summary:
          "Report a typed plan/apply result (DESIGN §12 Mode 1) — a first-party, PAT-authenticated, persist-then-process ingress; the typed counterpart to the raw /webhook route",
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
        // ADR-0028 — same check, same reason, on the TYPED half of the same ingress (see the
        // `/webhook` route above). `persistSourceEvent` stores this event with `headers: {}`, so the
        // hint is computed from `{}` here too: what is authorized is byte-for-byte what the
        // processor will read back off the row.
        await assertStageDependenciesWithinAuthority(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          stageDependencies: extractHint(request.params.sourceKind, {}, request.body)
            .stageDependencies
        });
        // Dedupe by the report body hash (no delivery header exists for a first-party report):
        // re-reporting the identical result is an idempotent no-op; a distinct result (a different
        // status/digest/plan) is a distinct event. `signatureVerified: true` — the PAT is the auth.
        const dedupeKey = computeDedupeKey({}, undefined, request.body);
        return persistSourceEvent(tx, {
          orgId: auth.orgId,
          sourceKind: request.params.sourceKind,
          signatureVerified: true,
          dedupeKey,
          headers: {},
          payload: request.body,
          reportedByObjectId: auth.subjectObjectId
        });
      });
      reply.status(202).send({ accepted: true, eventId });
    }
  });

  // Webhook signing secret configuration (M7). See docs/routes.md §38.

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
        // `secret:write` at the org root, NOT `object:write`. See docs/routes.md §39.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "secret:write",
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
          refPattern: request.body.refPattern,
          componentIdOrUrn: request.body.component,
          type: request.body.type,
          classification: request.body.classification,
          mirrorOfShared: request.body.mirrorOfShared,
          enabled: request.body.enabled,
          scope: request.body.scope
        });
      });
      reply.status(201).send(mapping);
    }
  });

  /** PATCH a source_mapping's ONE mutable field. See docs/routes.md §40. */
  typed.route({
    method: "PATCH",
    url: "/api/v1/change-sources/:sourceKind/mappings/:id",
    schema: {
      params: SourceMappingIdParamSchema,
      body: SetSourceMappingEnabledRequestSchema,
      response: {
        200: SourceMappingSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "setSourceMappingEnabled",
        summary:
          "Enable or disable a source_mapping (the pause switch) — a disabled mapping stays declared but routes nothing",
        tags: ["change-sources"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const mapping = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // READ THE ROW, THEN BAR AT ITS COMPONENT. See docs/routes.md §41.
        const existing = await getSourceMapping(
          tx,
          auth.orgId,
          request.params.sourceKind,
          request.params.id
        );
        await assertSourceMappingWritable(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          componentObjectId: existing.componentObjectId
        });
        return setSourceMappingEnabled(
          tx,
          auth.orgId,
          request.params.sourceKind,
          request.params.id,
          request.body.enabled,
          request.body.disabledUntil ? new Date(request.body.disabledUntil) : null
        );
      });
      reply.status(200).send(mapping);
    }
  });

  /** PATCH a source_mapping's declared SCOPE. See docs/routes.md §42. */
  typed.route({
    method: "PATCH",
    url: "/api/v1/change-sources/:sourceKind/mappings/:id/scope",
    schema: {
      params: SourceMappingIdParamSchema,
      body: SetSourceMappingScopeRequestSchema,
      response: {
        200: SourceMappingSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "setSourceMappingScope",
        summary:
          "Set or clear a source_mapping's declared scope (global | domain | null) — a label read by pipelines, IaC and the CLI, never a routing input",
        tags: ["change-sources"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const mapping = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // Same read-then-bar shape, and the same reasons, as the pause switch above: the row's
        // component is the object that carries the authority, and resolving it first is what keeps
        // an unknown id a 404. `component_object_id` is not writable by this setter either.
        const existing = await getSourceMapping(
          tx,
          auth.orgId,
          request.params.sourceKind,
          request.params.id
        );
        await assertSourceMappingWritable(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          componentObjectId: existing.componentObjectId
        });
        return setSourceMappingScope(
          tx,
          auth.orgId,
          request.params.sourceKind,
          request.params.id,
          request.body.scope
        );
      });
      reply.status(200).send(mapping);
    }
  });

  /** DELETE a source_mapping. See docs/routes.md §43. */
  typed.route({
    method: "DELETE",
    url: "/api/v1/change-sources/:sourceKind/mappings",
    schema: {
      params: ChangeSourceEventParamSchema,
      body: DeleteSourceMappingRequestSchema,
      response: {
        200: DeleteSourceMappingResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "deleteSourceMapping",
        summary: "Delete every source_mapping matching this identity tuple",
        tags: ["change-sources"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const deleted = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // Resolved with `includeDeleted`. See docs/routes.md §44.
        const component = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.body.component, {
          includeDeleted: true
        });
        await assertSourceMappingWritable(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          componentObjectId: component.id
        });
        return deleteSourceMappingsMatching(tx, {
          orgId: auth.orgId,
          componentObjectId: component.id,
          sourceKind: request.params.sourceKind,
          repoPattern: request.body.repoPattern,
          pathPattern: request.body.pathPattern,
          // ABSENT is treated as NULL, never as a wildcard (ADR-0030 §1). A caller written before
          // `refPattern` existed therefore deletes only ref-agnostic rows and can never reach a
          // ref-scoped one — it may UNDER-delete (visible immediately in the `deleted` count this
          // response exists to report) but never silently take a dev or production route with it.
          refPattern: request.body.refPattern ?? null,
          type: request.body.type ?? "configuration"
        });
      });
      reply.status(200).send({ deleted });
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
