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
  RegionalExecutorEnvParamSchema,
  RegionalExecutorViewSchema,
  RegistryIdOrUrnParamSchema,
  RunDiscoveryRequestSchema,
  SecretConfiguredResponseSchema,
  SecretKeyListResponseSchema,
  SecretKeyParamSchema,
  ExecutorTypeSchema,
  type ExecutorType
} from "@scp/schemas";
import { BUNDLED_PLUGIN_MANIFESTS, validatePluginConfig } from "../plugin-host/plugin-manifests.js";
import type { AppDeps } from "../types.js";
import type { PluginModule } from "../plugin-host/contract.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { isPairBoundObjectType } from "../graph/pair-bound-types.js";
import { createObject, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { isPeerBoundObjectType } from "../federation/outpost-binding.js";
import { isGovernanceManagedObjectType } from "../governance/governance-managed-types.js";
import { containmentDomainIdFromWire } from "../domain-id-edge.js";
import { createRelationship } from "../graph/relationships-repo.js";
import { isSystemManagedRelationshipType } from "../graph/system-managed-relationships.js";
import {
  upsertExecutorBinding,
  listExecutorBindingsForTarget,
  deleteExecutorBinding,
  setExecutorBindingType,
  isKnownExecutorModule,
  executionSystemBindingIdentity,
  resolveInternalEgress,
  DEFAULT_BINDING_TYPE,
  EXECUTION_SYSTEM_INSTANCE_PREFIX
} from "../coordination/executor-bindings-repo.js";
import { buildRegionalExecutorView } from "../coordination/regional-executors.js";
import { resolveBindingForTarget } from "../coordination/binding-resolution.js";
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
import {
  createSourceMapping,
  backfillSourceMappings
} from "../coordination/source-mappings-repo.js";

/** The `DiscoveryPlugin` modules (`github-discovery`, `gitea-discovery`, `gitlab-discovery`,
 *  `argocd-discovery`) — same allowlist discipline as `executor-bindings-repo.ts`'s
 *  `KNOWN_EXECUTOR_MODULES` (a free-form request field must never reach `host.start()` unchecked). */
const KNOWN_DISCOVERY_MODULES: PluginModule[] = [
  "github-discovery",
  "gitea-discovery",
  "gitlab-discovery",
  "argocd-discovery"
];

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
  const identity = executionSystemBindingIdentity(sys, executionSystemId);
  return upsertExecutorBinding(tx, {
    orgId,
    targetObjectId,
    type,
    ...identity,
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
      reply.status(200).send({ items: BUNDLED_PLUGIN_MANIFESTS });
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
        // Placement-aware (ADR-0026 amendment): this route answers "what will actually drive this
        // target?", so it must agree with reconcile. A component whose binding has moved to its
        // placement would otherwise 404 here while deploying perfectly well — the operator reads
        // "no binding configured" about a target that is bound, which is worse than no answer.
        const resolution = await resolveBindingForTarget(tx, auth.orgId, target.id, type);
        if (resolution.outcome === "ambiguous") {
          const named = resolution.candidates.map((c) => c.placementObjectId).join(", ");
          throw conflict(
            `'${request.params.idOrUrn}' has a '${type}' binding on ${resolution.candidates.length} ` +
              `placements (${named}) — which one applies depends on the place, so ask for the ` +
              `placement rather than the component`
          );
        }
        if (!resolution.binding) {
          throw notFound(
            `no '${type}' executor binding configured for '${request.params.idOrUrn}'`
          );
        }
        return resolution.binding;
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
      response: {
        200: ExecutorBindingListResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
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
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: target.id
        });
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
      response: {
        200: ExecutorBindingSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema
      }
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
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: target.id
        });
        const type = request.query.type ?? DEFAULT_BINDING_TYPE;
        const row = await deleteExecutorBinding(tx, auth.orgId, target.id, type);
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
      response: {
        200: ExecutorBindingSchema,
        401: ProblemSchema,
        403: ProblemSchema,
        404: ProblemSchema,
        409: ProblemSchema
      }
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
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: target.id
        });
        const fromType = request.query.type ?? DEFAULT_BINDING_TYPE;
        const row = await setExecutorBindingType(
          tx,
          auth.orgId,
          target.id,
          fromType,
          request.body.type
        );
        if (!row) {
          throw notFound(
            `no '${fromType}' executor binding configured for '${request.params.idOrUrn}'`
          );
        }
        return row;
      });
      reply.status(200).send(binding);
    }
  });

  // -----------------------------------------------------------------------------------------
  // Multi-region Argo CD config surface (M15.6, ADR-0017 §3) — a READ + VALIDATE view of one prod
  // environment's per-region Argo CD set: `prod env -> {region -> argocd binding}`. Additive; adds
  // no new object type (a region is a `deployment-target` with properties.environment/region, its
  // Argo CD an ordinary per-region binding). The operator still declares each region by binding it
  // via `PUT /executors/:idOrUrn/binding` — this route surfaces the whole set coherently and flags a
  // region with no Argo CD of its own instead of silently deploying it against nothing.
  // -----------------------------------------------------------------------------------------
  typed.route({
    method: "GET",
    url: "/api/v1/environments/:environment/regional-executors",
    schema: {
      params: RegionalExecutorEnvParamSchema,
      // `type` omitted ⇒ 'configuration' (Argo CD is GitOps sync) — the Type each region's binding
      // is resolved at, mirroring the single-binding GET.
      querystring: z.object({ type: ExecutorTypeSchema.optional() }),
      response: { 200: RegionalExecutorViewSchema, 401: ProblemSchema, 403: ProblemSchema }
    },
    config: {
      openapi: {
        operationId: "getRegionalExecutors",
        summary:
          "Read + validate a prod environment's per-region Argo CD set (region -> argocd binding)",
        tags: ["executors"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      const view = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        // The view spans every region deployment-target in the environment, so authorize at the org
        // root — the same org-scoped read bar the secret/plugin-list reads use. Per-target object
        // reads are already gated when the operator binds each region.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        const type = request.query.type ?? DEFAULT_BINDING_TYPE;
        return buildRegionalExecutorView(tx, auth.orgId, request.params.environment, type);
      });
      reply.status(200).send(view);
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
        throw badRequest(
          `unknown or non-notification plugin module '${request.body.pluginModule}'`
        );
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
  // graph, never auto-committed"). `/run` executes discover() live via the in-process PluginHost,
  // which `main.ts` constructs for every role including a pure api process (AppDeps.pluginHost's
  // doc comment records why it used not to); `/accept` is the ONLY path that ever writes what a
  // discovery scan found into the graph.
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
        // Reachable only when `buildApp` was handed deps with no host (tests, `openapi:emit`) —
        // `main.ts` gives every ROLE one, so a deployed process always has it. The old message said
        // "run SCP_ROLE=all", which was both wrong for a split deployment (it would start a SECOND
        // reconcile/watchdog/observe loop set beside the worker's) and unactionable, since api is
        // the only process serving HTTP.
        throw badRequest(
          "this process has no plugin host, so a live discovery scan cannot be dispatched"
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
      // NOT validated here — see the `validatePluginConfig(effectiveConfig, ...)` call below. The
      // config a discovery run actually uses is only known AFTER a named execution-system has been
      // merged in, and validating the raw body made the execution-system-backed path unreachable.
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
        // ==========================================================================================
        // VALIDATE THE EFFECTIVE CONFIG, NOT THE REQUEST BODY.
        //
        // This used to run on `request.body.config` before the block above, which made the
        // execution-system-backed path IMPOSSIBLE TO USE. `argocd-discovery`'s manifest requires
        // `serverUrl`, and the whole point of naming a system is that the caller does NOT supply one
        // — the comment above says so in as many words ("a caller may NAME a system, never supply
        // its serverUrl/token/egress allowance"), and the merge below stamps the persisted value as
        // server-governed. So the documented call was rejected for missing exactly the field the
        // server was about to provide, and the only way through was to send a dummy `serverUrl` that
        // is then overwritten — a required field whose value is ignored.
        //
        // Measured on the live homelab 2026-08-02, immediately after the plugin-host fix (#200) made
        // this route reachable at all: `{executionSystemId}` alone answered 400 "must have required
        // property 'serverUrl'".
        //
        // Validating the EFFECTIVE config is strictly stronger, not weaker. The inline path is
        // unchanged (no system named -> effectiveConfig IS the body). The system-backed path is now
        // checked against what the plugin will actually receive, which is the document that matters —
        // and it still runs BEFORE `host.start`, so nothing is dispatched unvalidated.
        // ==========================================================================================
        validatePluginConfig(request.body.pluginModule, effectiveConfig);

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
            scopeKey: "default",
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

        // M16.2 phase A (E1) — this is a free-form-`typeId` write door checking only `object:write`,
        // so it must not become a way to write commander-authored federation config, whose own routes
        // require `federation:write`. Nothing discovers federation topology (no executor plugin knows
        // about peers), so refusing the type costs nothing real and closes the permission mismatch.
        // The peer BINDING is separately enforced inside `graph/objects-repo.ts` for every door.
        for (const proposedObject of request.body.proposal.objects) {
          if (isPeerBoundObjectType(proposedObject.typeId)) {
            throw forbidden(
              `discovery proposals may not create '${proposedObject.typeId}' objects — commander-authored ` +
                `federation config is written only through /api/v1/federation/outposts ('federation:write')`
            );
          }

          // M21.7 (ADR-0032 §6a census) — THE SAME PERMISSION MISMATCH, ONE TYPE FAMILY OVER, AND IT
          // WAS LIVE. The refusal directly above was written by censusing the PEER-BOUND guard; the
          // census that produced it never asked the same question about the GOVERNANCE-managed types,
          // so this door kept admitting them. MEASURED on the pre-fix tree: an Operator — plain
          // `object:write` at the org root, `policy:write` nowhere — POSTed
          // `{proposal:{objects:[{typeId:"policy", properties:{enforcement:"required", effects:
          // [{requireApprovals:{count:99, fromRole:"Owner", scope:"organization"}}]}}]}}` and got 201.
          // `governance/policy-resolve.ts`'s `listPolicyCandidates` selects EVERY live `policy` row and
          // an unscoped policy matches every target, so that row is a live org-wide `required` policy
          // demanding an unmeetable quorum, authored by exactly the actor the `object:write` /
          // `policy:write` split (`drizzle/0010_governance.sql:174-175` grants `policy:write` to
          // Administrator and Owner only) exists to keep out of governance.
          //
          // A TYPE REFUSAL, not a permission upgrade — and unlike the overlay door
          // (`federation/overlay-repo.ts`, which took a `policy:write` check because DESIGN §13's
          // canonical overlay case IS annotating a distributed policy), nothing here needs `policy` to
          // keep working: no discovery plugin proposes governance documents, and a proposal carries no
          // scope binding for `assertPolicyScopeWithinAuthority` to bind, so there is no author
          // authority to check against even if we wanted a permission check. The refusal therefore
          // holds for EVERY caller, including one who legitimately holds `policy:write`.
          //
          // Uses the SHARED predicate (`governance/governance-managed-types.ts`), the same one
          // `routes/objects-generic.ts`'s `assertNotGovernanceManagedObjectType` calls — a second copy
          // of the type list is how the next governance type gets refused at one door and not the other.
          if (isGovernanceManagedObjectType(proposedObject.typeId)) {
            throw forbidden(
              `discovery proposals may not create '${proposedObject.typeId}' objects — governance ` +
                `documents are authored only through /api/v1/policies and /api/v1/controls, which ` +
                `require 'policy:write' and (for policies) bind the declared scope to the author's ` +
                `own authority; a discovery proposal carries neither`
            );
          }
        }

        // THE SAME QUESTION, ONE TABLE OVER — AND IT HAD NEVER BEEN ASKED.
        //
        // Every refusal above censuses OBJECT types. The loop below this one takes a `typeId` from
        // the request body too, hands it to `createRelationship`, and until now carried NEITHER of
        // the two guards the other two caller-supplied-`typeId` relationship doors carry:
        // `routes/relationships.ts` (generic `POST`/`DELETE`) and `iac/plans-repo.ts`'s apply
        // (`:873`) BOTH refuse the system-managed types AND authorize `relationship:write` at both
        // endpoints. This door did neither, on `object:write` at the org root alone.
        //
        // MEASURED on the pre-fix tree: the org-root Owner POSTed
        // `{proposal:{objects:[],relationships:[{typeId:"annotates",fromUrn:A,toUrn:B}]}}` and got
        // 201 with the row written — the identical edge the generic door refuses that same actor
        // with a 403. `annotates` is the one that hurts most: `federation/overlay-repo.ts`'s
        // `getMergedOverlayView` merges the `from` object's properties into the base for EVERY
        // `annotates` edge it finds, trusting that `createOverlay` — the only path that runs
        // `assertPolicyOverlayOnlyAddsStrictness` — was the thing that wrote it. A forged edge is a
        // silent property rewrite of an object the forger never had write access to, which is
        // precisely the vector `graph/system-managed-relationships.ts` says closing the creation
        // side makes unreachable.
        //
        // A TYPE REFUSAL, holding for every caller including the org Owner, exactly as at the other
        // two doors: no `DiscoveryPlugin` proposes an engine-owned edge, and a proposal carries none
        // of the authority each of those edges is evidence OF (a cast vote, a campaign target check,
        // a strictness-checked overlay). Uses the SHARED predicate rather than a fourth copy of the
        // type list — the next engine-owned type must not be refused at two doors and admitted at
        // the third, which is exactly how this door came to be the odd one out.
        //
        // Refused in this pre-pass, before any object is created, so a proposal carrying one bad
        // edge writes nothing at all rather than relying on the transaction rollback.
        for (const proposedRelationship of request.body.proposal.relationships) {
          if (isSystemManagedRelationshipType(proposedRelationship.typeId)) {
            throw forbidden(
              `discovery proposals may not create '${proposedRelationship.typeId}' relationships — ` +
                `that type is system-managed (created only by the engine's own authority-checked ` +
                `paths: approval voting, campaign/initiative membership, and federation overlays), ` +
                `and a proposal carries none of the authority those edges are evidence of`
            );
          }
        }

        const urnToId = new Map<string, string>();
        const nameToId = new Map<string, string>();
        const createdObjectIds: string[] = [];
        for (const proposedObject of request.body.proposal.objects) {
          // A PAIR-BOUND type cannot be accepted as a raw proposed object.
          //
          // `graph/pair-bound-types.ts` leaves import paths permissive, listing "discovery/accept
          // and federation-journal replay" together. That reasoning holds for REPLAY — it is
          // internal, and a replica arrives with its edges as their own `relationship_upsert`
          // entries, so both halves are reproduced. It does NOT hold here: this route takes the
          // proposal FROM THE REQUEST BODY, so a client can hand-write one that never came from a
          // plugin run. Measured before this guard existed: a hand-written proposal returned 201 and
          // created a placement with no derived edges — the same island the generic route refuses.
          //
          // No discovery plugin proposes a pair-bound object today (they emit components, bindings
          // and source mappings), so this refuses nothing that currently works. If one ever should,
          // it needs a path that can WRITE THE EDGES, which `createObject` alone cannot.
          if (isPairBoundObjectType(proposedObject.typeId)) {
            throw forbidden(
              `discovery proposals cannot create '${proposedObject.typeId}' objects — its identity ` +
                `is a pair of other objects, and accepting it here would store unresolved endpoints ` +
                `with no derived edges. Use /api/v1/${proposedObject.typeId}s.`
            );
          }
          const created = await createObject(tx, {
            orgId: auth.orgId,
            actorObjectId: auth.subjectObjectId,
            requestId: "discovery-accept",
            // WIRE BOUNDARY (ADR-0021 D4) — see src/domain-id-edge.ts.
            domainId: containmentDomainIdFromWire(request.body.domainId) ?? undefined,
            typeId: proposedObject.typeId,
            name: proposedObject.name,
            properties: proposedObject.properties ?? {}
          });
          createdObjectIds.push(created.id);
          urnToId.set(created.urn, created.id);
          nameToId.set(proposedObject.name, created.id); // for proposal bindings (M12 P3b)
        }

        const createdRelationshipIds: string[] = [];
        // A relationship write is a write at TWO places, so it is authorized at both — the check
        // `routes/relationships.ts`'s module doc calls "load-bearing, not pedantry" and
        // `iac/plans-repo.ts` also makes. Memoised per request because an import proposal fans a
        // handful of endpoints across many edges, and re-asking the identical question is the only
        // cost this adds to the batch shape this route exists for.
        const endpointsAuthorized = new Set<string>();
        const authorizeEndpoint = async (objectId: string): Promise<void> => {
          if (endpointsAuthorized.has(objectId)) return;
          await authorize(tx, {
            orgId: auth.orgId,
            subjectObjectId: auth.subjectObjectId,
            permission: "relationship:write",
            scopeObjectId: objectId
          });
          endpointsAuthorized.add(objectId);
        };
        for (const proposedRelationship of request.body.proposal.relationships) {
          // Discovered relationships may reference objects created in THIS same acceptance batch
          // (by their freshly-minted URN) or pre-existing graph objects — resolved either way.
          const fromId =
            urnToId.get(proposedRelationship.fromUrn) ??
            (await getObjectByIdOrUrnAnyType(tx, auth.orgId, proposedRelationship.fromUrn)).id;
          const toId =
            urnToId.get(proposedRelationship.toUrn) ??
            (await getObjectByIdOrUrnAnyType(tx, auth.orgId, proposedRelationship.toUrn)).id;
          // THE SECOND HALF OF THE GAP (see the type refusal above). The door's own entry check is
          // `object:write` at the ORG ROOT — neither the permission nor the scope this write needs:
          //
          //  - PERMISSION. `object:write` and `relationship:write` land on the same built-in roles
          //    today (`0002_rls_rbac_seed.sql:208-222`), so nothing reachable through the current
          //    role table holds one without the other — safety by coincidence between two entries
          //    of one ARRAY literal, undone by a single org-defined role (`roles.org_id`). The
          //    census that closed `POST /federation/hand-fill` recorded exactly this reasoning for
          //    exactly this reason (ADR-0032 §6a).
          //  - SCOPE, and this half was LIVE. `resolveDeclaredContainmentParent`'s module doc puts
          //    it plainly: an edge is authorized at both ends because it decides who else holds
          //    authority. `contains` IS a containment parent (`graph/containment.ts` route 2), so
          //    minting one moves the child under a container whose policies then reach it
          //    (`governance/policy-resolve.ts` matches every scope kind over the containment chain)
          //    and whose role bindings then have authority over it (`authz/resolve.ts`'s
          //    `scopeExpandCte` walks the same edge upward). MEASURED pre-fix: an actor holding an
          //    org-root Operator allow AND an explicit Operator DENY at the container minted the
          //    `contains` edge into it and got 201.
          //
          // `graph/governance-reach.ts`'s recorder already fires on this path — `createRelationship`
          // is one of its five choke points, so the reach change WAS being written to a Decision.
          // That is detection, and detection of a write nobody was authorized to make is not a
          // substitute for refusing it; #249's own module doc says so ("It is DETECTION, not
          // prevention"). The record and the refusal are different halves and this door had only
          // the record.
          await authorizeEndpoint(fromId);
          await authorizeEndpoint(toId);
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
          // NO `refPattern`/`classification` here, and that is deliberate rather than an omission
          // (ADR-0030 §1). A discovery proposal carries neither: an executor tells us which repo and
          // path drive a component, not which BRANCH is the dev one, and it certainly cannot tell us
          // what an operator would classify the pipeline as. Leaving both null means "matches any
          // ref, unclassified" — byte-identical to how every discovery-created mapping behaved
          // before 0057. Inferring a ref from an Argo CD `targetRevision` would be a guess, and a
          // ref is a ROUTING key, so a wrong guess silently sends releases to the wrong pipeline.
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

        return {
          createdObjectIds,
          createdRelationshipIds,
          createdBindingIds,
          createdSourceMappingIds
        };
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
      response: {
        200: BackfillSourceMappingsResponseSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "backfillSourceMappings",
        summary:
          "Backfill source_mappings onto already-imported components (matches a discovery proposal's mappings to existing components by name)",
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
