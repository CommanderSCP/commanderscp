import type { FastifyInstance } from "fastify";
import { groupDiscoveryProposal, renderEstateProgram } from "@scp/coordination-as-code";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
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
  ScaffoldDiscoveryRequestSchema,
  ScaffoldDiscoveryResponseSchema,
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
import { badRequest, conflict, notFound } from "../errors.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
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

/** The `DiscoveryPlugin` modules (`github-discovery`, `gitea-discovery`, `gitlab-discovery`,
 *  `argocd-discovery`) — same allowlist discipline as `executor-bindings-repo.ts`'s
 *  `KNOWN_EXECUTOR_MODULES` (a free-form request field must never reach `host.start()` unchecked). */
const KNOWN_DISCOVERY_MODULES: PluginModule[] = [
  "github-discovery",
  "gitea-discovery",
  "gitlab-discovery",
  "argocd-discovery"
];

/** Bind a target object to a registered `execution-system`. See docs/routes.md §170. */
async function bindTargetToExecutionSystem(
  tx: TenantTx,
  orgId: string,
  subjectObjectId: string,
  requestId: string,
  targetObjectId: string,
  executionSystemId: string,
  externalRef?: string,
  type?: ExecutorType
) {
  const sys = await getObjectByIdOrUrnAnyType(tx, orgId, executionSystemId);
  // Authorize first, so an unauthorized caller learns nothing. See docs/routes.md §171.
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
    externalRef,
    actorObjectId: subjectObjectId,
    requestId
  });
}

/** M7 plugin-configuration surface. See docs/routes.md §172. */
export function registerExecutorRoutes(app: FastifyInstance, deps: AppDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // Plugin manifests (static catalog — no runtime hot-loading, DESIGN §11)

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

  // Secrets (write-only — encrypted at rest, secrets/crypto.ts; never readable back)

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
        // `secret:write` at the org root, NOT `object:write`. See docs/routes.md §173.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "secret:write",
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
        // The same substitution the write above takes. See docs/routes.md §174.
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "secret:write",
          scopeObjectId: auth.orgId
        });
        await deleteSecret(tx, auth.orgId, request.params.key);
      });
      reply.status(204).send();
    }
  });

  // Executor bindings (DESIGN §12 — a Component/DeploymentTarget bound to a plugin instance)

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
            request.id,
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
          externalRef: body.externalRef,
          actorObjectId: auth.subjectObjectId,
          requestId: request.id
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
        const row = await deleteExecutorBinding(
          tx,
          auth.orgId,
          target.id,
          type,
          auth.subjectObjectId,
          request.id
        );
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
          request.body.type,
          auth.subjectObjectId,
          request.id
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

  // Multi-region Argo CD config surface (M15.6, ADR-0017 §3). See docs/routes.md §175.
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

  // Discovery: proposed objects and relationships, reviewed. See docs/routes.md §176.

  /** `POST /discovery/scaffold` (ADR-0047). See docs/routes.md §177. */
  typed.route({
    method: "POST",
    url: "/api/v1/discovery/scaffold",
    schema: {
      body: ScaffoldDiscoveryRequestSchema,
      response: {
        200: ScaffoldDiscoveryResponseSchema,
        400: ProblemSchema,
        401: ProblemSchema,
        403: ProblemSchema
      }
    },
    config: {
      openapi: {
        operationId: "scaffoldDiscoveryProposal",
        summary:
          "Render a discovery proposal as @scp/coordination-as-code source — writes nothing to the graph",
        tags: ["discovery"]
      }
    },
    handler: async (request, reply) => {
      const auth = await requireAuth(deps, request);
      await withTenantTx(deps.db, auth.orgId, (tx) =>
        authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        })
      );

      // THE SAME FUNCTIONS `scp iac scaffold` CALLS. Not a second implementation: one definition of
      // "which components are ungrouped" (ADR-0047's whole point is that the set is surfaced), and
      // one emitter, so the wizard and the CLI cannot produce different code from one proposal.
      const { specs, ungrouped } = groupDiscoveryProposal(
        request.body.proposal,
        request.body.group
      );
      reply.status(200).send({
        stacks: specs.map((spec) => {
          const rendered = renderEstateProgram(spec);
          return {
            stackName: spec.stackName,
            serviceName: spec.serviceName,
            source: rendered.source,
            placeholderCount: rendered.placeholderCount
          };
        }),
        ungrouped
      });
    }
  });

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
        // Reachable only when `buildApp` was handed deps with no host. See docs/routes.md §178.
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
        // Execution-system-backed discovery names its own system. See docs/routes.md §179.
        let allowInternalEgress = false;
        let effectiveConfig = request.body.config;
        let effectiveAllowedHosts = request.body.allowedHosts;
        let effectiveSecretRefs = request.body.secretRefs ?? {};
        const execSysRef = (request.body.config as Record<string, unknown> | undefined)
          ?.executionSystemId;
        if (typeof execSysRef === "string" && execSysRef.length > 0) {
          const sys = await getObjectByIdOrUrnAnyType(tx, auth.orgId, execSysRef);
          // Authorize at the REFERENCED SYSTEM's own scope. See docs/routes.md §180.
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
        // VALIDATE THE EFFECTIVE CONFIG, NOT THE REQUEST BODY. See docs/routes.md §181.
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

  /* `POST /discovery/backfill-source-mappings` IS GONE, following `accept` exactly as
   * team-pipeline-iac section 13 said it would ("survives until the estate migration completes, then
   * is removed the same way"). Increment 7 shipped that migration.
   *
   * It created source_mappings onto components imported BEFORE discovery emitted them. Nothing can
   * add to that population any more — `discovery/accept` was the only door that made a mapping-less
   * component, and ADR-0047 removed it. A component that predates the change is repaired by adopting
   * it into a stack and declaring the source in the manifest, which apply reconciles through the
   * ordinary `sourceMappings` collection.
   *
   * The org-root reasoning this door carried is not lost: it was about a door consuming the output of
   * a credentialed dial, and `POST /discovery/run` — which still exists — is where that argument now
   * lives in full (`org-root-scope-census.test.ts` keeps its entry).
   */
}
