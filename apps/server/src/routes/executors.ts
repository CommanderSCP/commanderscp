import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  AcceptDiscoveryRequestSchema,
  AcceptDiscoveryResponseSchema,
  CreateExecutorBindingRequestSchema,
  CreateNotificationBindingRequestSchema,
  DiscoveryProposalSchema,
  ExecutorBindingSchema,
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
  SecretKeyParamSchema
} from "@scp/schemas";
import {
  manifest as githubExecutorManifest,
  discoveryManifest as githubDiscoveryManifest
} from "@scp/plugin-github";
import { manifest as argocdManifest } from "@scp/plugin-argocd";
import { manifest as terraformManifest } from "@scp/plugin-terraform";
import { manifest as managedIacManifest } from "@scp/plugin-managed-iac";
import { manifest as webhookNotifyManifest } from "@scp/plugin-webhook-notify";
import { manifest as smtpNotifyManifest } from "@scp/plugin-smtp-notify";
import type { AppDeps } from "../types.js";
import type { PluginModule } from "../plugin-host/contract.js";
import { requireAuth } from "../auth/require-auth.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { authorize } from "../authz/resolve.js";
import { badRequest, notFound } from "../errors.js";
import { validateProperties } from "../graph/property-validation.js";
import { createObject, getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { createRelationship } from "../graph/relationships-repo.js";
import {
  upsertExecutorBinding,
  getExecutorBinding,
  isKnownExecutorModule
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

/** Only `github-discovery` is a real `DiscoveryPlugin` module today — same allowlist discipline
 *  as `executor-bindings-repo.ts`'s `KNOWN_EXECUTOR_MODULES` (a free-form request field must never
 *  reach `host.start()` unchecked). */
const KNOWN_DISCOVERY_MODULES: PluginModule[] = ["github-discovery"];

/** Every bundled plugin's manifest, keyed by the module name a binding references. Used to
 *  validate a binding's tenant-supplied `config` against the plugin's declared `configSchema`
 *  BEFORE it's ever stored/provisioned (adversarial-review CRITICAL #1 item 5) — in particular,
 *  managed-iac's schema is `additionalProperties: false` with no runnerImage/networkMode/workspace,
 *  so a tenant attempt to set those server-governed fields is rejected here with a 400. */
const MANIFEST_BY_MODULE: Record<string, { configSchema: unknown }> = {
  github: githubExecutorManifest,
  "github-discovery": githubDiscoveryManifest,
  argocd: argocdManifest,
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
      // M8 hardening (BUILD_AND_TEST.md §8 M8 item 6, "create-time module allowlist"): reject an
      // unknown/wrong-kind/operator-plane `pluginModule` HERE, at WRITE time — mirroring the
      // discovery-create route's `KNOWN_DISCOVERY_MODULES` check below — rather than only ever
      // discovering it later, confusingly, the first time the coordination engine tries to
      // dispatch to this binding (`executor-bindings-repo.ts`'s `resolveExecutorPluginInstance`
      // already refused it there; this closes the same gap earlier, defense in depth).
      if (!isKnownExecutorModule(request.body.pluginModule)) {
        throw badRequest(`unknown or non-executor plugin module '${request.body.pluginModule}'`);
      }
      // Validate the tenant config against the plugin's declared schema BEFORE storing it —
      // rejects e.g. a managed-iac binding that tries to set the server-governed runnerImage/
      // networkMode/workspace fields (CRITICAL #1 item 5). Outside the tx: pure input validation.
      validatePluginConfig(request.body.pluginModule, request.body.config);
      const binding = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        const target = await getObjectByIdOrUrnAnyType(tx, auth.orgId, request.params.idOrUrn);
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:write",
          scopeObjectId: target.id
        });
        return upsertExecutorBinding(tx, {
          orgId: auth.orgId,
          targetObjectId: target.id,
          pluginModule: request.body.pluginModule,
          pluginInstanceId: request.body.pluginInstanceId,
          config: request.body.config,
          secretRefs: request.body.secretRefs,
          allowedHosts: request.body.allowedHosts
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
        summary: "Get a target's configured executor binding",
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
        const row = await getExecutorBinding(tx, auth.orgId, target.id);
        if (!row) throw notFound(`no executor binding configured for '${request.params.idOrUrn}'`);
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
      validatePluginConfig(request.body.pluginModule, request.body.config);
      const proposal = await withTenantTx(deps.db, auth.orgId, async (tx) => {
        await authorize(tx, {
          orgId: auth.orgId,
          subjectObjectId: auth.subjectObjectId,
          permission: "object:read",
          scopeObjectId: auth.orgId
        });
        const resolvedSecrets = await resolveSecretRefs(
          tx,
          auth.orgId,
          request.body.secretRefs ?? {},
          deps.config.secretsMasterKey
        );
        await host.start([
          {
            id: request.body.pluginInstanceId,
            module: request.body.pluginModule as PluginModule,
            orgId: auth.orgId,
            domainId: "default",
            config: request.body.config,
            secrets: resolvedSecrets,
            allowedHosts: request.body.allowedHosts
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

        return { createdObjectIds, createdRelationshipIds };
      });
      reply.status(201).send(result);
    }
  });
}
