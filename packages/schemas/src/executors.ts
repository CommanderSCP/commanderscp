import { z } from "zod";
import { cursorPageResponseSchema } from "./common.js";

/**
 * M7 Real Executor Integrations wire contract (DESIGN.md §11/§12, BUILD_AND_TEST.md §8 M7).
 * `executor_bindings`/`notification_bindings` are projection tables (like M4's `control_bindings`)
 * — no graph-object equivalent exists for "which plugin instance backs this target/channel".
 */

// -------------------------------------------------------------------------------------------
// Executor bindings (DESIGN §12 — a Component/DeploymentTarget bound to a configured
// ExecutorPlugin instance).
// -------------------------------------------------------------------------------------------

export const CreateExecutorBindingRequestSchema = z.object({
  pluginModule: z.string().min(1),
  pluginInstanceId: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
  /** `{ configFieldName: secretKey }` — `secretKey` must already exist (`PUT /secrets/{key}`);
   *  the plaintext value is resolved server-side and never appears in this request/response. */
  secretRefs: z.record(z.string(), z.string()).optional(),
  /** Egress allowlist (hostnames) for this instance's `ctx.http` — empty/omitted means the
   *  plugin's own manifest defaults apply. */
  allowedHosts: z.array(z.string()).optional()
});
export type CreateExecutorBindingRequest = z.infer<typeof CreateExecutorBindingRequestSchema>;

export const ExecutorBindingSchema = z.object({
  id: z.string().uuid(),
  targetObjectId: z.string().uuid(),
  pluginModule: z.string(),
  pluginInstanceId: z.string(),
  config: z.unknown(),
  secretRefs: z.record(z.string(), z.string()),
  allowedHosts: z.array(z.string())
});
export type ExecutorBinding = z.infer<typeof ExecutorBindingSchema>;

// -------------------------------------------------------------------------------------------
// Notification bindings (DESIGN §11 NotificationPlugin — an org's configured channels).
// -------------------------------------------------------------------------------------------

export const NotificationSeveritySchema = z.enum(["info", "warning", "critical"]);
export type NotificationSeverity = z.infer<typeof NotificationSeveritySchema>;

export const CreateNotificationBindingRequestSchema = z.object({
  pluginModule: z.string().min(1),
  pluginInstanceId: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
  secretRefs: z.record(z.string(), z.string()).optional(),
  allowedHosts: z.array(z.string()).optional(),
  minSeverity: NotificationSeveritySchema.optional()
});
export type CreateNotificationBindingRequest = z.infer<
  typeof CreateNotificationBindingRequestSchema
>;

export const NotificationBindingSchema = z.object({
  id: z.string().uuid(),
  pluginModule: z.string(),
  pluginInstanceId: z.string(),
  config: z.unknown(),
  secretRefs: z.record(z.string(), z.string()),
  allowedHosts: z.array(z.string()),
  minSeverity: NotificationSeveritySchema
});
export type NotificationBinding = z.infer<typeof NotificationBindingSchema>;
export const NotificationBindingListResponseSchema =
  cursorPageResponseSchema(NotificationBindingSchema);
export type NotificationBindingListResponse = z.infer<typeof NotificationBindingListResponseSchema>;

// -------------------------------------------------------------------------------------------
// Secrets (write-only — a value is never readable back through the API once stored).
// -------------------------------------------------------------------------------------------

export const PutSecretRequestSchema = z.object({ value: z.string().min(1) });
export type PutSecretRequest = z.infer<typeof PutSecretRequestSchema>;

export const SecretKeyParamSchema = z.object({ key: z.string().min(1) });

/** Notification bindings are keyed by a caller-chosen `pluginInstanceId`, not a graph object —
 *  distinct from `RegistryIdOrUrnParamSchema` (registries.ts) on purpose. */
export const NotificationInstanceParamSchema = z.object({ instanceId: z.string().min(1) });

export const SecretConfiguredResponseSchema = z.object({
  configured: z.literal(true),
  key: z.string()
});
export type SecretConfiguredResponse = z.infer<typeof SecretConfiguredResponseSchema>;

export const SecretKeyListResponseSchema = z.object({ keys: z.array(z.string()) });
export type SecretKeyListResponse = z.infer<typeof SecretKeyListResponseSchema>;

// -------------------------------------------------------------------------------------------
// Plugin manifests (DESIGN §11: "config schemas auto-surface as validated config forms in API,
// CLI, and UI") — a static, in-repo catalog of every bundled M7 plugin's `{id, kind, version,
// configSchema}`, surfaced so a config FORM can be generated client-side without hand-authoring
// one per plugin.
// -------------------------------------------------------------------------------------------

export const PluginKindSchema = z.enum([
  "executor",
  "control",
  "identity",
  "notification",
  "federation-transport",
  "discovery"
]);
export type PluginKind = z.infer<typeof PluginKindSchema>;

export const PluginManifestSchema = z.object({
  id: z.string(),
  kind: PluginKindSchema,
  version: z.string(),
  configSchema: z.record(z.string(), z.unknown()),
  requiredCapabilities: z.array(z.string()).optional()
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const PluginManifestListResponseSchema = z.object({ items: z.array(PluginManifestSchema) });
export type PluginManifestListResponse = z.infer<typeof PluginManifestListResponseSchema>;

// -------------------------------------------------------------------------------------------
// Discovery (DESIGN §11 DiscoveryPlugin — "proposed objects + relationships, reviewed/accepted
// into the graph, never auto-committed"). `discover()`'s raw proposal is returned to the caller
// for review; nothing is written to the graph until an explicit `POST .../accept`.
// -------------------------------------------------------------------------------------------

export const DiscoveryProposalObjectSchema = z.object({
  typeId: z.string(),
  name: z.string(),
  properties: z.record(z.string(), z.unknown()).optional()
});
export const DiscoveryProposalRelationshipSchema = z.object({
  typeId: z.string(),
  fromUrn: z.string(),
  toUrn: z.string()
});
export const DiscoveryProposalSchema = z.object({
  objects: z.array(DiscoveryProposalObjectSchema),
  relationships: z.array(DiscoveryProposalRelationshipSchema)
});
export type DiscoveryProposal = z.infer<typeof DiscoveryProposalSchema>;

export const RunDiscoveryRequestSchema = z.object({
  pluginModule: z.string().min(1),
  pluginInstanceId: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
  secretRefs: z.record(z.string(), z.string()).optional(),
  allowedHosts: z.array(z.string()).optional()
});
export type RunDiscoveryRequest = z.infer<typeof RunDiscoveryRequestSchema>;

/** `POST /discovery/accept` — the ONLY path that actually commits discovered objects/relationships
 *  into the graph; the caller re-submits (a possibly operator-edited subset of) a proposal it got
 *  back from `/discovery/run`, making acceptance an explicit, auditable, reviewable act rather
 *  than something discovery could ever do on its own. */
export const AcceptDiscoveryRequestSchema = z.object({
  domainId: z.string().uuid().optional(),
  proposal: DiscoveryProposalSchema
});
export type AcceptDiscoveryRequest = z.infer<typeof AcceptDiscoveryRequestSchema>;

export const AcceptDiscoveryResponseSchema = z.object({
  createdObjectIds: z.array(z.string().uuid()),
  createdRelationshipIds: z.array(z.string().uuid())
});
export type AcceptDiscoveryResponse = z.infer<typeof AcceptDiscoveryResponseSchema>;

// -------------------------------------------------------------------------------------------
// `scp change report --plan-json` (DESIGN §12 Mode 1: "a one-line CLI step... reports plan/apply
// results"). A thin, typed wrapper around the SAME `POST /change-sources/{sourceKind}/webhook`
// ingress every other source kind uses (routes/change-sources.ts) — not a new engine path.
// -------------------------------------------------------------------------------------------

export const ChangeReportRequestSchema = z.object({
  repo: z.string().optional(),
  path: z.string().optional(),
  correlationKey: z.string().optional(),
  workspace: z.string().optional(),
  artifactDigest: z.string().optional(),
  status: z.enum(["planned", "applied", "errored", "discarded"]),
  planJson: z.unknown().optional()
});
export type ChangeReportRequest = z.infer<typeof ChangeReportRequestSchema>;
