import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AcceptDiscoveryRequestSchema,
  AcceptDiscoveryResponseSchema,
  BackfillSourceMappingsRequestSchema,
  BackfillSourceMappingsResponseSchema,
  CreateExecutorBindingRequestSchema,
  CreateNotificationBindingRequestSchema,
  DiscoveryProposalSchema,
  ExecutorBindingSchema,
  ExecutorBindingListResponseSchema,
  RepurposeExecutorBindingRequestSchema,
  NotificationBindingListResponseSchema,
  NotificationBindingSchema,
  NotificationInstanceParamSchema,
  PluginManifestListResponseSchema,
  ProblemSchema,
  PutSecretRequestSchema,
  RegistryIdOrUrnParamSchema,
  RunDiscoveryRequestSchema,
  SecretConfiguredResponseSchema,
  SecretKeyListResponseSchema,
  SecretKeyParamSchema,
  ExecutorTypeSchema,
  type ExecutorType
} from "@scp/schemas";
import {
  manifest as githubExecutorManifest,
  discoveryManifest as githubDiscoveryManifest
} from "@scp/plugin-github";
import {
  manifest as argocdManifest,
  discoveryManifest as argocdDiscoveryManifest
} from "@scp/plugin-argocd";
import { manifest as terraformManifest } from "@scp/plugin-terraform";
import { manifest as managedIacManifest } from "@scp/plugin-managed-iac";
import { manifest as webhookNotifyManifest } from "@scp/plugin-webhook-notify";
import { manifest as smtpNotifyManifest } from "@scp/plugin-smtp-notify";
import type { AppDeps } from "../types.js";
import type { PluginModule } from "../plugin-host/contract.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { badRequest, notFound } from "../errors.js";
import { validateProperties } from "../graph/property-validation.js";
import { createObject, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { createRelationship } from "../graph/relationships-repo.js";
import {
  upsertExecutorBinding,
  getExecutorBinding,
  listExecutorBindingsForTarget,
  deleteExecutorBinding,
  setExecutorBindingType,
  isKnownExecutorModule,
  executionSystemInstanceId,
  resolveInternalEgress,
  DEFAULT_BINDING_TYPE,
  EXECUTION_SYSTEM_INSTANCE_PREFIX
} from "../coordination/executor-bindings-repo.js";
import {
  upsertNotificationBinding,
  listNotificationBindings,
  deleteNotificationBinding,
  isKnownNotificationModule
} from "../notify/notification-bindings-repo.js";
import {
  putSecret,
  deleteSecret,
  listSecretKeys,
  resolveSecretRefs
} from "../secrets/secrets-repo.js";
import { createSourceMapping, backfillSourceMappings } from "../coordination/source-mappings-repo.js";

/** Only `github-discovery` is a real `DiscoveryPlugin` module today — same allowlist discipline
 *  as `executor-bindings-repo.ts`'s `KNOWN_EXECUTOR_MODULES` (a free-form request field must never
 *  reach `host.start()` unchecked). */
const KNOWN_DISCOVERY_MODULES: PluginModule[] = ["github-discovery", "argocd-discovery"];

/** Every bundled plugin's manifest, keyed by the module name a binding references. Used to
 *  validate a binding's tenant-supplied `config` against the plugin's declared `configSchema`
 *  BEFORE it's ever stored/provisioned (adversarial-review CRITICAL #1 item 5) — in particular,
 *  managed-iac's schema is `additionalProperties: false` with no runnerImage/networkMode/workspace,
 *  so a tenant attempt to set those server-governed fields is rejected here with a 400. */
const MANIFEST_BY_MODULE: Record<string, { configSchema: unknown }> = {
  github: githubExecutorManifest,
  "github-discovery": githubDiscoveryManifest,
  argocd: argocdManifest,
  "argocd-discovery": argocdDiscoveryManifest,
  terraform: terraformManifest,
  "managed-iac": managedIacManifest,
  "webhook-notify": webhookNotifyManifest,
  "smtp-notify": smtpNotifyManifest
};

/** Throws `badRequest` if `config` doesn't satisfy `module`'s declared `configSchema`. An unknown
 *  module has no schema to validate against — that's caught separately (the module allowlist in
 *  `executor-bindings-repo.ts`/`notification-bindings-repo.ts`), so here we simply skip. */
function validatePluginConfig(module: string, config: unknown): void {
  const manifest = MANIFEST_BY_MODULE[module];
  if (!manifest) return;
  validateProperties(manifest.configSchema, config ?? {}, `plugin-config:${module}`);
}

/**
 * Bind a target object to a registered `execution-system` (Mode A). Loads the system, derives the
 * plugin module from its `kind` (allowlist-checked) + a shared instance id, and upserts the binding
 * — serverUrl/token are resolved from the system at dispatch, never stored on the binding. Shared by
 * `PUT /binding` (executionSystemId path) and `POST /discovery/accept` (proposal bindings, M12 P3b).
 */
async function bindTargetToExecutionSystem(
  tx: TenantTx,
  orgId: string,
  subjectObjectId: string,
  targetObjectId: string,
  executionSystemId: string,
  externalRef?: string,
  type?: ExecutorType
) {
  const sys = await getObjectByIdOrUrnAnyType(tx, orgId, executionSystemId);
  // Authorize FIRST — before the typeId check below — so an unauthorized caller can't use the
  // "'x' is a 'y', not an execution-system" error as a type/existence oracle for objects they may
  // not read.
  //
  // `object:WRITE`, not object:read: referencing a system makes SCP dispatch with that system's
  // DECRYPTED token (and, if both egress layers agree, its internal-egress reach) — a use-of-
  // credentials capability, not a read. object:read would be no bar at all: the built-in Viewer role
  // (auto-assigned at org root to every first-time login) holds object:read, and authz walks
  // containment to the org root, so every org member would pass. object:write matches the bar this
  // same route already requires on the binding TARGET.
  //
  // Known trade (ADR-0003): a system shared by many teams must grant them object:write on it, which
  // also lets them modify its serverUrl. A distinct "use" capability would be the finer answer, but
  // that means new RBAC; revisit if shared-system delegation becomes real.
  await authorize(tx, {
    orgId,
    subjectObjectId,
    permission: "object:write",
    scopeObjectId: sys.id
  });
  if (sys.typeId !== "execution-system") {
    throw badRequest(`'${executionSystemId}' is a '${sys.typeId}', not an execution-system`);
  }
  const props = sys.properties as { kind?: string; serverUrl?: string };
  if (!props.serverUrl) {
    throw badRequest(`execution-system '${sys.id}' is missing a 'serverUrl' property`);
  }
  const module = (props.kind ?? "").trim();
  if (!isKnownExecutorModule(module)) {
    throw badRequest(`execution-system kind '${module}' is not a known executor module`);
  }
  return upsertExecutorBinding(tx, {
    orgId,
    targetObjectId,
    type,
    pluginModule: module,
    pluginInstanceId: executionSystemInstanceId(sys.id),
    executionSystemId: sys.id,
    externalRef
  });
}

/**
 * M7 plugin-configuration surface (BUILD_AND_TEST.md §8 M7 item 5: "plugin config schemas
 * surfaced as validated config forms in UI/CLI"): executor/notification bindings, encrypted
 * secrets (write-only), the static plugin-manifest catalog a config form is generated FROM, and
 * `DiscoveryPlugin` run/accept (never auto-commits — DESIGN §11).
 */
export function registerExecutorRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // -----------------------------------------------------------------------------------------
  // Plugin manifests (static catalog — no runtime hot-loading, DESIGN §11)
  // -----------------------------------------------------------------------------------------

  typed.route({
    method: "GET",
    url: "/api/v1/plugins/manifests",
    schema: { response: { 200: PluginManifestListResponseSchema, 401: ProblemSchema } },
    config: {
      openapi: {
        operationId: "listPluginManifests",
        summary:
          "Every bundled plugin's {id, kind, version, configSchema} — the source a config form is generated from",
        tags: ["plugins"]
      }
    },
    handler: async (request, reply) => {
      await requireAuth(deps, request);
      reply.status(200).send({
        items: [
          githubExecutorManifest,
          githubDiscoveryManifest,
          argocdManifest,
          argocdDiscoveryManifest,
          terraformManifest,
          managedIacManifest,
          webhookNotifyManifest,
          smtpNotifyManifest
        ]
      });
    }
  });

  // -----------------------------------------------------------------------------------------
  // Secrets (write-only — encrypted at rest, secrets/crypto.ts; never readable back)
  // -----------------------------------------------------------------------------------------

  typed.route({
    method: "PUT",
    url: "/api/v1/secrets/:key",
    schema: {
      params: SecretKeyParamSchema,
      body: PutSecretRequestSchema,
      response: { 200: SecretConfiguredResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "putSecret",
        summary: "Store (or rotate) an encrypted secret value by key",
        tags: ["secrets"]
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
        await putSecret(tx, {
          orgId: auth.orgId,
          key: request.params.key,
          value: request.body.value,
          masterKey: deps.config.secretsMasterKey
        });
      });
      reply.status(200).send({ configured: true, key: request.params.key });
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/secrets",
    schema: {
      response: { 200: SecretKeyListResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listSecretKeys",
        summary: "List configured secret KEYS for this org (never values)",
        tags: ["secrets"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const keys = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        return listSecretKeys(tx, auth.orgId);
      });
      reply.status(200).send({ keys });
    }
  });

  typed.route({
    method: "DELETE",
    url: "/api/v1/secrets/:key",
    schema: {
      params: SecretKeyParamSchema,
      response: { 204: z.undefined(), 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: { operationId: "deleteSecret", summary: "Delete a secret by key", tags: ["secrets"] }
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
        await deleteSecret(tx, auth.orgId, request.params.key);
      });
      reply.status(204).send();
    }
  });

  // -----------------------------------------------------------------------------------------
  // Executor bindings (DESIGN §12 — a Component/DeploymentTarget bound to a plugin instance)
  // -----------------------------------------------------------------------------------------

  typed.route({
    method: "PUT",
    url: "/api/v1/executors/:idOrUrn/binding",
    schema: {
      params: RegistryIdOrUrnParamSchema,
      body: CreateExecutorBindingRequestSchema,
      response: {
        200: ExecutorBindingSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "putExecutorBinding",
        summary: "Bind a Component/DeploymentTarget to a configured ExecutorPlugin instance",
        tags: ["executors"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const body = request.body;
      // INLINE bindings validate the module + config up front (outside the tx). System-backed
      // bindings derive both from the referenced execution-system object, validated inside the tx.
      if (!body.executionSystemId) {
        // M8 hardening (BUILD_AND_TEST.md §8 M8 item 6, "create-time module allowlist"): reject an
        // unknown/wrong-kind/operator-plane `pluginModule` HERE, at WRITE time (defense in depth vs.
        // `resolveExecutorPluginInstance`).
        if (!isKnownExecutorModule(body.pluginModule!)) {
          throw badRequest(`unknown or non-executor plugin module '${body.pluginModule}'`);
        }
        // An inline binding may not squat the reserved `execution-system:<id>` instance-id namespace —
        // the plugin-host keyspace is flat and start() skips an already-registered id, so squatting it
        // would silently re-point a real system's coordination traffic at tenant-controlled config.
        if (body.pluginInstanceId?.startsWith(EXECUTION_SYSTEM_INSTANCE_PREFIX)) {
          throw badRequest(
            `pluginInstanceId may not start with the reserved '${EXECUTION_SYSTEM_INSTANCE_PREFIX}' namespace — ` +
              `use --execution-system to bind via a registered system`
          );
        }
        // Reject e.g. a managed-iac binding that tries to set server-governed fields (CRITICAL #1).
        validatePluginConfig(body.pluginModule!, body.config);
      }
      const binding = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const target = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.params.idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: target.id
        });

        if (body.executionSystemId) {
          // Mode A: module + shared instance id + serverUrl/token all resolve from the system.
          return bindTargetToExecutionSystem(
            tx,
            auth.orgId,
            auth.subjectObjectId,
            target.id,
            body.executionSystemId,
            body.externalRef,
            body.type
          );
        }

        return upsertExecutorBinding(tx, {
          orgId: auth.orgId,
          targetObjectId: target.id,
          pluginModule: body.pluginModule!,
          type: body.type,
          pluginInstanceId: body.pluginInstanceId!,
          config: body.config,
          secretRefs: body.secretRefs,
          allowedHosts: body.allowedHosts,
          externalRef: body.externalRef
        });
      });
      reply.status(200).send(binding);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/executors/:idOrUrn/binding",
    schema: {
      params: RegistryIdOrUrnParamSchema,
      // A target may hold one binding PER TYPE (M12 P3 / ADR-0007), so "the" binding no longer
      // exists. Optional + defaulting to 'configuration' keeps a bare read pointed at the common
      // case, while making any Type readable by naming it.
      querystring: z.object({ type: ExecutorTypeSchema.optional() }),
      response: {
        200: ExecutorBindingSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "getExecutorBinding",
        summary: "Get a target's configured executor binding for one type (default: configuration)",
        tags: ["executors"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const binding = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const target = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.params.idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: target.id
        });
        const type = request.query.type ?? DEFAULT_BINDING_TYPE;
        const row = await getExecutorBinding(tx, auth.orgId, target.id, type);
        if (!row) {
          throw notFound(
            `no '${type}' executor binding configured for '${request.params.idOrUrn}'`
          );
        }
        return row;
      });
      reply.status(200).send(binding);
    }
  });

  // GET all of a target's bindings (all Types) — M12 P5c. The single-binding GET above needs a Type;
  // this lists every pipeline bound to the target (and excludes a soft-deleted target's).
  typed.route({
    method: "GET",
    url: "/api/v1/executors/:idOrUrn/bindings",
    schema: {
      params: RegistryIdOrUrnParamSchema,
      response: { 200: ExecutorBindingListResponseSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "listExecutorBindings",
        summary: "List every executor binding (all types) configured for a target",
        tags: ["executors"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const items = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const target = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.params.idOrUrn);
        await authorize(tx, { orgId: auth.orgId, subjectObjectId: auth.subjectObjectId, permission: "object:read", scopeObjectId: target.id });
        return listExecutorBindingsForTarget(tx, auth.orgId, target.id);
      });
      reply.status(200).send({ items });
    }
  });

  // DELETE a target's binding for one Type — M12 P5c (the missing detach primitive). object:write
  // on the target, mirroring PUT. Hard delete (no soft-delete column); returns the removed binding.
  typed.route({
    method: "DELETE",
    url: "/api/v1/executors/:idOrUrn/binding",
    schema: {
      params: RegistryIdOrUrnParamSchema,
      querystring: z.object({ type: ExecutorTypeSchema.optional() }),
      response: { 200: ExecutorBindingSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "deleteExecutorBinding",
        summary: "Delete a target's executor binding for one type (default: configuration)",
        tags: ["executors"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const binding = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const target = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.params.idOrUrn);
        await authorize(tx, { orgId: auth.orgId, subjectObjectId: auth.subjectObjectId, permission: "object:write", scopeObjectId: target.id });
        const type = request.query.type ?? DEFAULT_BINDING_TYPE;
        const row = await deleteExecutorBinding(tx, auth.orgId, target.id, type);
        if (!row) {
          throw notFound(`no '${type}' executor binding configured for '${request.params.idOrUrn}'`);
        }
        return row;
      });
      reply.status(200).send(binding);
    }
  });

  // PATCH: relabel which pipeline a target's binding drives — M12 P5c. `?type=` names the CURRENT
  // Type (default configuration); the body carries the NEW one. This is the merge-collision
  // resolution (owner Q1: relabel one binding before merging), and fixing a mis-imported Type.
  typed.route({
    method: "PATCH",
    url: "/api/v1/executors/:idOrUrn/binding",
    schema: {
      params: RegistryIdOrUrnParamSchema,
      querystring: z.object({ type: ExecutorTypeSchema.optional() }),
      body: RepurposeExecutorBindingRequestSchema,
      response: { 200: ExecutorBindingSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema, 409: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "repurposeExecutorBinding",
        summary: "Relabel which pipeline (routing type) a target's executor binding drives",
        tags: ["executors"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const binding = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const target = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.params.idOrUrn);
        await authorize(tx, { orgId: auth.orgId, subjectObjectId: auth.subjectObjectId, permission: "object:write", scopeObjectId: target.id });
        const fromType = request.query.type ?? DEFAULT_BINDING_TYPE;
        const row = await setExecutorBindingType(tx, auth.orgId, target.id, fromType, request.body.type);
        if (!row) {
          throw notFound(`no '${fromType}' executor binding configured for '${request.params.idOrUrn}'`);
        }
        return row;
      });
      reply.status(200).send(binding);
    }
  });

  // -----------------------------------------------------------------------------------------
  // Notification bindings (DESIGN §11 — an org's configured notification channels; keyed by a
  // caller-chosen `instanceId`, not a graph object).
  // -----------------------------------------------------------------------------------------

  typed.route({
    method: "PUT",
    url: "/api/v1/notifications/bindings/:instanceId",
    schema: {
      params: NotificationInstanceParamSchema,
      body: CreateNotificationBindingRequestSchema,
      response: { 200: NotificationBindingSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "putNotificationBinding",
        summary:
          "Configure (or update) a notification channel — an org may configure more than one",
        tags: ["notifications"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      // M8 hardening — same write-time allowlist as the executor-binding route above.
      if (!isKnownNotificationModule(request.body.pluginModule)) {
        throw badRequest(`unknown or non-notification plugin module '${request.body.pluginModule}'`);
      }
      validatePluginConfig(request.body.pluginModule, request.body.config);
      const binding = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: auth.orgId
        });
        return upsertNotificationBinding(tx, {
          orgId: auth.orgId,
          pluginModule: request.body.pluginModule,
          pluginInstanceId: request.params.instanceId,
          config: request.body.config,
          secretRefs: request.body.secretRefs,
          allowedHosts: request.body.allowedHosts,
          minSeverity: request.body.minSeverity
        });
      });
      reply.status(200).send(binding);
    }
  });

  typed.route({
    method: "GET",
    url: "/api/v1/notifications/bindings",
    schema: {
      response: {
        200: NotificationBindingListResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "listNotificationBindings",
        summary: "List this org's configured notification channels",
        tags: ["notifications"]
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
        return listNotificationBindings(tx, auth.orgId);
      });
      reply.status(200).send({ items, nextCursor: null });
    }
  });

  typed.route({
    method: "DELETE",
    url: "/api/v1/notifications/bindings/:instanceId",
    schema: {
      params: NotificationInstanceParamSchema,
      response: { 204: z.undefined(), 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "deleteNotificationBinding",
        summary: "Remove a notification channel",
        tags: ["notifications"]
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
        await deleteNotificationBinding(tx, auth.orgId, request.params.instanceId);
      });
      reply.status(204).send();
    }
  });

  // -----------------------------------------------------------------------------------------
  // Discovery (DESIGN §11 — "proposed objects + relationships, reviewed/accepted into the
  // graph, never auto-committed"). `/run` executes discover() live via the in-process PluginHost
  // (present only on role=all|worker — AppDeps.pluginHost's doc comment); `/accept` is the ONLY
  // path that ever writes what a discovery scan found into the graph.
  // -----------------------------------------------------------------------------------------

  typed.route({
    method: "POST",
    url: "/api/v1/discovery/run",
    schema: {
      body: RunDiscoveryRequestSchema,
      response: {
        200: DiscoveryProposalSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "runDiscovery",
        summary:
          "Run a DiscoveryPlugin scan — returns a PROPOSAL only, nothing is written to the graph",
        tags: ["discovery"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const host = deps.pluginHost;
      if (!host) {
        throw badRequest(
          "discovery requires a worker-capable process (SCP_ROLE=all or worker) — this process is API-only"
        );
      }
      if (!(KNOWN_DISCOVERY_MODULES as string[]).includes(request.body.pluginModule)) {
        throw badRequest(`unknown discovery plugin module '${request.body.pluginModule}'`);
      }
      // Same reserved-namespace guard as the inline-binding path: a discovery run registers a plugin
      // instance under a caller-chosen id, so it must not be able to squat `execution-system:<id>`.
      if (request.body.pluginInstanceId.startsWith(EXECUTION_SYSTEM_INSTANCE_PREFIX)) {
        throw badRequest(
          `pluginInstanceId may not start with the reserved '${EXECUTION_SYSTEM_INSTANCE_PREFIX}' namespace`
        );
      }
      validatePluginConfig(request.body.pluginModule, request.body.config);
      const proposal = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        // Execution-system-backed discovery (e.g. argocd-discovery names its system in
        // `config.executionSystemId`): the PERSISTED system — not the request — is the source of truth
        // for where this plugin may talk, with what token, and whether internal egress is permitted.
        // Mirrors executor-bindings-repo.ts's resolveExecutorPluginInstance discipline ("tenant config
        // first, server-governed fields LAST — they win", CRITICAL #1 / MAJOR #4): a caller may NAME a
        // system, never supply its serverUrl/token/egress allowance. Without this, an internal-egress
        // grant on system X would authorize egress to an arbitrary caller-supplied `config.serverUrl` in
        // the SAME request — a tenant-controlled SSRF into loopback/RFC1918 (egress-guard.ts, MAJOR #6).
        let allowInternalEgress = false;
        let effectiveConfig = request.body.config;
        let effectiveAllowedHosts = request.body.allowedHosts;
        let effectiveSecretRefs = request.body.secretRefs ?? {};
        const execSysRef = (request.body.config as Record<string, unknown> | undefined)
          ?.executionSystemId;
        if (typeof execSysRef === "string" && execSysRef.length > 0) {
          const sys = await getObjectByIdOrUrnAnyType(tx, auth.orgId, execSysRef);
          // Authorize at the REFERENCED SYSTEM's own scope (and BEFORE the typeId check, so the error
          // isn't a type oracle). object:WRITE for the same reason as bindTargetToExecutionSystem:
          // naming a system here dispatches a plugin with its decrypted token, and the handler's
          // org-root object:read above is satisfied by every org member (the Viewer role holds
          // object:read), so an object:read check here would be effectively no gate at all.
          await authorize(tx, {
            orgId: auth.orgId,
            subjectObjectId: auth.subjectObjectId,
            permission: "object:write",
            scopeObjectId: sys.id
          });
          if (sys.typeId !== "execution-system") {
            throw badRequest(`'${execSysRef}' is a '${sys.typeId}', not an execution-system`);
          }
          const props = sys.properties as {
            serverUrl?: string;
            tokenSecretKey?: string;
            allowInternalEgress?: boolean;
          };
          if (!props.serverUrl) {
            throw badRequest(`execution-system '${sys.id}' is missing a 'serverUrl' property`);
          }
          let systemHost: string;
          try {
            systemHost = new URL(props.serverUrl).hostname;
          } catch {
            throw badRequest(`execution-system '${sys.id}' has an unparseable 'serverUrl'`);
          }
          // Two-layer (ADR-0003): the system's declared intent AND the operator's
          // SCP_INTERNAL_EGRESS_HOSTS allowlist must both permit — same resolver as the binding path.
          allowInternalEgress = resolveInternalEgress(
            props.serverUrl,
            props.allowInternalEgress === true
          );
          effectiveConfig = {
            ...((request.body.config as Record<string, unknown>) ?? {}),
            // Server-governed — these WIN over anything the caller sent.
            serverUrl: props.serverUrl,
            ...(props.tokenSecretKey ? { tokenSecretKey: props.tokenSecretKey } : {})
          };
          effectiveSecretRefs = props.tokenSecretKey
            ? { [props.tokenSecretKey]: props.tokenSecretKey }
            : {};
          // Pin egress to the registered system's OWN host, so the allowance can never be aimed
          // anywhere else — this, not the permission gate, is what makes the grant narrow.
          effectiveAllowedHosts = [systemHost];
        }
        const resolvedSecrets = await resolveSecretRefs(
          tx,
          auth.orgId,
          effectiveSecretRefs,
          deps.config.secretsMasterKey
        );
        await host.start([
          {
            id: request.body.pluginInstanceId,
            module: request.body.pluginModule as PluginModule,
            orgId: auth.orgId,
            domainId: "default",
            config: effectiveConfig,
            secrets: resolvedSecrets,
            allowedHosts: effectiveAllowedHosts,
            allowInternalEgress
          }
        ]);
        return host.discovery(request.body.pluginInstanceId).discover();
      });
      reply.status(200).send(proposal);
    }
  });

  typed.route({
    method: "POST",
    url: "/api/v1/discovery/accept",
    schema: {
      body: AcceptDiscoveryRequestSchema,
      response: {
        201: AcceptDiscoveryResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "acceptDiscoveryProposal",
        summary:
          "EXPLICITLY accept a discovery proposal — the only path that commits discovered objects/relationships",
        tags: ["discovery"]
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

        const urnToId = new Map<string, string>();
        const nameToId = new Map<string, string>();
        const createdObjectIds: string[] = [];
        for (const proposedObject of request.body.proposal.objects) {
          const created = await createObject(tx, {
            orgId: auth.orgId,
            actorObjectId: auth.subjectObjectId,
            requestId: "discovery-accept",
            domainId: request.body.domainId ?? undefined,
            typeId: proposedObject.typeId,
            name: proposedObject.name,
            properties: proposedObject.properties ?? {}
          });
          createdObjectIds.push(created.id);
          urnToId.set(created.urn, created.id);
          nameToId.set(proposedObject.name, created.id); // for proposal bindings (M12 P3b)
        }

        const createdRelationshipIds: string[] = [];
        for (const proposedRelationship of request.body.proposal.relationships) {
          // Discovered relationships may reference objects created in THIS same acceptance batch
          // (by their freshly-minted URN) or pre-existing graph objects — resolved either way.
          const fromId =
            urnToId.get(proposedRelationship.fromUrn) ??
            (await getObjectByIdOrUrnAnyType(tx, auth.orgId, proposedRelationship.fromUrn)).id;
          const toId =
            urnToId.get(proposedRelationship.toUrn) ??
            (await getObjectByIdOrUrnAnyType(tx, auth.orgId, proposedRelationship.toUrn)).id;
          const created = await createRelationship(tx, {
            orgId: auth.orgId,
            actorObjectId: auth.subjectObjectId,
            requestId: "discovery-accept",
            typeId: proposedRelationship.typeId,
            fromId,
            toId
          });
          createdRelationshipIds.push(created.id);
        }

        // M12 P3b: wire imported objects to an execution-system in the SAME accept — so
        // import→coordinate is one command. Each proposal binding references an object BY NAME
        // (created in this batch) or by id/URN (a pre-existing object).
        const createdBindingIds: string[] = [];
        for (const proposedBinding of request.body.proposal.bindings ?? []) {
          const targetId =
            nameToId.get(proposedBinding.objectName) ??
            (await getObjectByIdOrUrnAnyType(tx, auth.orgId, proposedBinding.objectName)).id;
          const created = await bindTargetToExecutionSystem(
            tx,
            auth.orgId,
            auth.subjectObjectId,
            targetId,
            proposedBinding.executionSystemId,
            proposedBinding.externalRef
          );
          createdBindingIds.push(created.id);
        }

        // M12 P5 (owner Q3): create a source_mapping per imported component so it SELF-REPORTS
        // releases via observe()/webhooks — not just being triggerable. For an argocd import the
        // discover step fills github + repoURL (its own events carry no repo; the underlying git repo
        // is where releases correlate). References the component BY NAME, like a proposal binding.
        const createdSourceMappingIds: string[] = [];
        for (const proposedMapping of request.body.proposal.sourceMappings ?? []) {
          const componentId =
            nameToId.get(proposedMapping.objectName) ??
            (await getObjectByIdOrUrnAnyType(tx, auth.orgId, proposedMapping.objectName)).id;
          const created = await createSourceMapping(tx, {
            orgId: auth.orgId,
            sourceKind: proposedMapping.sourceKind,
            repoPattern: proposedMapping.repoPattern,
            pathPattern: proposedMapping.pathPattern,
            componentIdOrUrn: componentId,
            type: proposedMapping.type
          });
          createdSourceMappingIds.push(created.id);
        }

        return { createdObjectIds, createdRelationshipIds, createdBindingIds, createdSourceMappingIds };
      });
      reply.status(201).send(result);
    }
  });

  // POST /discovery/backfill-source-mappings — the AUTOMATED backfill (M12 P5 follow-up): create
  // source_mappings onto ALREADY-imported components (the 50 argocd orphans imported before discovery
  // emitted mappings). Feed a fresh `discovery run` proposal; matches its sourceMappings to existing
  // components BY NAME and creates them, creating NO objects. Idempotent — reports every skip.
  typed.route({
    method: "POST",
    url: "/api/v1/discovery/backfill-source-mappings",
    schema: {
      body: BackfillSourceMappingsRequestSchema,
      response: { 200: BackfillSourceMappingsResponseSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "backfillSourceMappings",
        summary: "Backfill source_mappings onto already-imported components (matches a discovery proposal's mappings to existing components by name)",
        tags: ["discovery"]
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
        return backfillSourceMappings(tx, {
          orgId: auth.orgId,
          mappings: request.body.proposal.sourceMappings ?? []
        });
      });
      reply.status(200).send(result);
    }
  });
}
