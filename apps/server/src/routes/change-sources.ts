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
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { assertStageDependenciesWithinAuthority } from "../coordination/campaign-scope-authz.js";
import { extractHint } from "../coordination/webhook-processor.js";
import { unauthorized } from "../errors.js";
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

/**
 * Persist ONE source event (persist-then-process), shared by the raw `/webhook` ingress and the
 * typed `/report` ingress so the dedupe + conflict-resolution lives in exactly one place. The unique
 * index on (org_id, source_kind, dedupe_key) makes a redelivery of the same key a no-op that returns
 * the FIRST event's id, so a replay never creates a second Change (MAJOR #5). Both callers do their
 * own auth/authorization BEFORE this; this function only writes.
 */
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

        // ADR-0028 — the SECOND door to a materialised `depends_on` edge, and the one a census by
        // route name misses: `webhook-processor.ts`'s `genericHint` lifts a top-level
        // `stageDependencies` straight off this raw body and threads it into `proposeChange`. The
        // processor itself runs as SYSTEM_ACTOR_ID, so the check cannot live there and be anything
        // other than vacuous — the reporting PRINCIPAL only exists HERE. Checked against exactly
        // what the processor will lift (same `extractHint`, same headers, same payload), so the two
        // cannot drift. The edge's `from` endpoint is deliberately NOT passed: it is chosen at
        // correlation time from an operator-configured `source_mappings` row, not by this caller.
        //
        // This is not vacuous just because `object:write` at the org root is already required above:
        // that is a DIFFERENT permission, and a custom role granting `object:write` without
        // `relationship:write` would otherwise mint edges here that `POST /relationships` refuses.
        await assertStageDependenciesWithinAuthority(tx, {
          orgId: auth.orgId,
          actorObjectId: auth.subjectObjectId,
          stageDependencies: extractHint(request.params.sourceKind, request.headers, request.body)
            .stageDependencies
        });

        // MAJOR #5 — dedupe redeliveries/replays. Prefer the provider's own delivery identifier
        // (GitHub `X-GitHub-Delivery`, or a generic `X-SCP-Delivery` an adapter can set), which is
        // stable across a redelivery of the SAME event; fall back to a hash of the raw body when no
        // delivery header exists. The unique index on (org_id, source_kind, dedupe_key) makes a
        // second delivery of the same key a no-op (returns the FIRST event's id), so a replayed —
        // even validly-signed — webhook never creates a second Change / fires a second real trigger.
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

  // -----------------------------------------------------------------------------------------
  // Typed first-party report ingress (DESIGN §12 Mode 1). `scp change-source report <sourceKind>`
  // — a one-line CI step that reports a plan/apply result — POSTs a TYPED body here instead of the
  // raw `/webhook` shape. Two reasons this is its own route, not the webhook with a schema:
  //   1. Contract (charter principle 3): the webhook body is `z.record` by necessity (it accepts
  //      arbitrary provider payloads), so it cannot carry a typed SDK. A report is first-party and
  //      CAN, so the SDK/CLI get a real generated contract instead of a hand-cast `Record`.
  //   2. Auth model: the webhook does HMAC verification when the org+sourceKind has a secret
  //      configured — which would REJECT a report (it carries no HMAC signature), so an org that set
  //      a `terraform` webhook secret could not `scp change-source report terraform` at all. A report
  //      is authenticated by its PAT (`requireAuth`), the same trusted-first-party stance
  //      `observe.ts` takes, so it skips HMAC and sets `signatureVerified: true`.
  // Same persist-then-process path otherwise: it writes a `change_source_events` row that the next
  // reconcile tick correlates (repo/path/correlationKey are read from the top-level payload by
  // `webhook-processor.ts`'s `genericHint`).
  // -----------------------------------------------------------------------------------------
  typed.route({
    method: "POST",
    url: "/api/v1/change-sources/:sourceKind/report",
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

  /**
   * PATCH a source_mapping's ONE mutable field — the pause switch (migration 0063, owner ask
   * 2026-08-14: "each [source] should have its own arrow so I can enable and disable each as
   * needed"). Addressed by id, unlike POST/DELETE above which use the identity tuple: this is a
   * genuine in-place update of one specific row, so an id is both correct and necessary — the
   * identity tuple can be shared by several byte-identical rows, and toggling one must never touch
   * its siblings. Same auth/tenant-tx idiom as the routes above.
   */
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
        // READ THE ROW, THEN SCOPE THE CHECK AT ITS COMPONENT. A source mapping has no containment
        // scope of its own — the authority that governs it is authority over the component it binds
        // a repo/path pattern to, which is only knowable once the row is loaded. Reading first is
        // also what keeps an unknown id answering 404 (`getSourceMapping` throws it) instead of the
        // 403 that scoping at an id naming nothing would produce for every caller including the org
        // root Owner. A WIDENING, never a narrowing: an org-root binding still satisfies a check at
        // any object below it, so everything that worked before this works identically.
        // `component_object_id` is immutable (the setter below writes `enabled`/`disabled_until`
        // only), so there is nothing for the second statement to have moved out from under.
        const existing = await getSourceMapping(
          tx,
          auth.orgId,
          request.params.sourceKind,
          request.params.id
        );
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: existing.componentObjectId
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

  /**
   * PATCH a source_mapping's declared SCOPE (migration 0066, §10.6) — a SIBLING of the pause switch
   * above rather than a field on it, so `setSourceMappingEnabled`'s contract stays byte-identical
   * and a caller labelling a mapping never has to restate (and never clobbers) its pause state. Same
   * by-id addressing (one row, never its byte-identical siblings), same auth/tenant-tx idiom. A
   * label only: nothing here changes what a push correlates to.
   */
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
        // Same read-then-scope shape, and the same reasons, as the pause switch above: the row's
        // component is the object that carries the authority, and resolving it first is what keeps
        // an unknown id a 404. `component_object_id` is not writable by this setter either.
        const existing = await getSourceMapping(
          tx,
          auth.orgId,
          request.params.sourceKind,
          request.params.id
        );
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: existing.componentObjectId
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

  /**
   * DELETE a source_mapping. The first operator-facing delete this table has had — before it, the
   * only way to remove a mapping was an IaC apply's prune, so a mapping created by
   * `discovery accept` or by hand could never be taken back through the API.
   *
   * That gap has a cost beyond inconvenience. An ADR-0026 pair merge soft-deletes the absorbed
   * component and STRANDS its mappings; they are neutralised at read time (they no longer match a
   * dead component) but they stay in the table, keep appearing in `GET /mappings`, and cannot be
   * cleaned. On the live homelab that is 5 rows from three merges.
   *
   * Matches the full IDENTITY TUPLE rather than an id — see `DeleteSourceMappingRequestSchema` for
   * why (duplicates exist; deleting one leaves the survivor correlating). Reports the row COUNT so
   * a no-op is visible instead of looking like success.
   */
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
        // Resolved with `includeDeleted`: the mappings most in need of deleting belong to a
        // SOFT-DELETED component (a merged-away pair half), and refusing to resolve it would make
        // exactly those rows undeletable — the gap this route exists to close.
        //
        // RESOLVED BEFORE THE CHECK, AND THE CHECK IS SCOPED AT IT. This door addresses rows by the
        // identity tuple, whose component is the object that carries the authority over every row
        // the tuple can reach — so that component, not the org root, is the scope. Resolving first
        // also keeps an unresolvable `component` a 404 rather than the 403 that scoping at a
        // caller-supplied string would produce for everyone. Still a widening: an org-root binding
        // satisfies a check at any object below it. A soft-deleted component keeps its `domain_id`,
        // and `scopeExpandCte` reads the seed row's `domain_id` without a liveness filter, so the
        // org-root chain of a merged-away component still expands — the stranded-mapping case that
        // motivated this route is unaffected.
        const component = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.body.component, {
          includeDeleted: true
        });
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: component.id
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
