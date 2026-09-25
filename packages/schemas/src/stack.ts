import { z } from "zod";

/**
 * THE STANDARD STACK'S DESIRED STATE AND STATUS (M29.4, ADR-0058, charter "Managed Standard Stack").
 *
 * The stack controller (`apps/stackd`) holds near-cluster-admin rights. Everything it acts on comes
 * from the documents below, so every field of the SPEC half is an enum, a boolean or an integer:
 * there is no string an operator (let alone a tenant) can type that the controller will render into
 * a manifest. `stack-spec-census.test.ts` walks `StackSpecDocumentSchema` and fails on any other
 * leaf, so widening this file is a reviewed decision rather than an edit.
 *
 * The STATUS half is written by the controller and is free text where it has to be (an error
 * message), bounded in length and count, and flows the other way: controller -> scpd -> readers.
 */

/** The backends the controller can install. Kebab-case, the same names `scripts/scp-bundled.sh`
 *  uses; the controller maps each to its `deploy/helm-bundled` values key. */
export const StackBackendSchema = z.enum([
  "argocd",
  "argo-workflows",
  "argo-rollouts",
  "argo-events",
  "gitea"
]);
export type StackBackend = z.infer<typeof StackBackendSchema>;

/** Sizing, as a tier rather than numbers: the controller derives every container's requests and
 *  limits from the chart's own defaults (small = the defaults, medium = x2, large = x4). */
export const StackSizeTierSchema = z.enum(["small", "medium", "large"]);
export type StackSizeTier = z.infer<typeof StackSizeTierSchema>;

/** Whether a new SCP release's stack versions roll out on their own (charter "Automatic by
 *  Default") or wait for `POST /instance/stack/upgrade`. */
export const StackUpdatePolicySchema = z.enum(["automatic", "manual"]);
export type StackUpdatePolicy = z.infer<typeof StackUpdatePolicySchema>;

export const StackBackendPhaseSchema = z.enum([
  "installing",
  "ready",
  "degraded",
  "upgrading",
  "failed",
  "removing",
  "disabled"
]);
export type StackBackendPhase = z.infer<typeof StackBackendPhaseSchema>;

/** Why an enabled backend is not everything it could be. A code the UI can key on, plus the
 *  sentence to show. */
export const StackNeedCodeSchema = z.enum([
  "infra-state-backend",
  "infra-runner-image",
  "rpm-builder-image",
  "upgrade-approval",
  "upgrade-rolled-back",
  /** A disabled backend's volumes and generate-once secrets are kept until a purge. */
  "data-retained",
  /** The controller's stored state did not match scpd's record of it, and was not used. */
  "state-integrity"
]);
export type StackNeedCode = z.infer<typeof StackNeedCodeSchema>;

export const StackNeedSchema = z.object({
  code: StackNeedCodeSchema,
  message: z.string().min(1).max(500)
});
export type StackNeed = z.infer<typeof StackNeedSchema>;

/** A release identifier as the controller reports it (`1.0.0-rc.0`, `dev`, `sha-abc123`). */
export const StackReleaseSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/, "a release identifier: [A-Za-z0-9._+-], <=128");

// ---- SPEC (operator-written) --------------------------------------------------------------------

export const StackBackendSpecSchema = z.object({
  backend: StackBackendSchema,
  enabled: z.boolean(),
  sizeTier: StackSizeTierSchema,
  /** Bumped by `POST /instance/stack/backends/{b}/purge`. A DISABLED backend keeps its data (its
   *  volumes and generate-once secrets) until this exceeds what the controller last purged. */
  purgeGeneration: z.number().int().min(0)
});
export type StackBackendSpec = z.infer<typeof StackBackendSpecSchema>;

export const StackSettingsSchema = z.object({
  updatePolicy: StackUpdatePolicySchema,
  /** Bumped by every `POST /instance/stack/upgrade`. The controller retries a rolled-back upgrade,
   *  or applies a held one under `manual`, only when this exceeds what it last observed. */
  upgradeGeneration: z.number().int().min(0)
});
export type StackSettings = z.infer<typeof StackSettingsSchema>;

/** Everything the controller reads — and the ONLY thing it reads from the API. One entry per
 *  backend, always all of them (an absent row is `enabled: false, sizeTier: small`). */
/** A sha256, lowercase hex. The only string the controller's input carries: it can only be
 *  COMPARED against bytes the controller holds, never rendered into anything. */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** The hashes of the controller's own state as it last reported them — kept on the scpd side so a
 *  last-good set or an inventory rewritten in the cluster is refused rather than applied or pruned. */
export const StackBackendIntegritySchema = z.object({
  backend: StackBackendSchema,
  lastGoodSha256: Sha256HexSchema.nullable(),
  inventorySha256: Sha256HexSchema.nullable()
});
export type StackBackendIntegrity = z.infer<typeof StackBackendIntegritySchema>;

export const StackSpecDocumentSchema = z.object({
  settings: StackSettingsSchema,
  backends: z.array(StackBackendSpecSchema),
  integrity: z.array(StackBackendIntegritySchema)
});
export type StackSpecDocument = z.infer<typeof StackSpecDocumentSchema>;

export const PutStackBackendRequestSchema = z.strictObject({
  enabled: z.boolean(),
  /** Omitted keeps the current tier (small for a backend never configured). */
  sizeTier: StackSizeTierSchema.optional()
});
export type PutStackBackendRequest = z.infer<typeof PutStackBackendRequestSchema>;

export const PutStackSettingsRequestSchema = z.strictObject({
  updatePolicy: StackUpdatePolicySchema
});
export type PutStackSettingsRequest = z.infer<typeof PutStackSettingsRequestSchema>;

export const StackBackendParamSchema = z.object({ backend: StackBackendSchema });

// ---- STATUS (controller-written) ----------------------------------------------------------------

export const StackBackendStatusSchema = z.object({
  phase: StackBackendPhaseSchema,
  /** The release whose manifests are applied and healthy, or null before the first success. */
  runningVersion: StackReleaseSchema.nullable(),
  /** The release the controller carries and is converging on. */
  targetVersion: StackReleaseSchema.nullable(),
  lastError: z.string().max(2000).nullable(),
  needs: z.array(StackNeedSchema).max(20),
  /** When the controller last wrote this backend's status. */
  observedAt: z.string()
});
export type StackBackendStatus = z.infer<typeof StackBackendStatusSchema>;

/** One backend in a status report. `detail` is the controller's evidence (unready workloads, pod
 *  waiting reasons, the step that failed) — served only by the operator-gated diagnostics read. */
export const StackBackendStatusReportSchema = z.strictObject({
  backend: StackBackendSchema,
  phase: StackBackendPhaseSchema,
  runningVersion: StackReleaseSchema.nullable(),
  targetVersion: StackReleaseSchema.nullable(),
  lastError: z.string().max(2000).nullable(),
  needs: z.array(StackNeedSchema).max(20),
  detail: z.array(z.string().max(500)).max(50),
  /** sha256 of the stored last good set and of the inventory, as this report leaves them. */
  lastGoodSha256: Sha256HexSchema.nullable(),
  inventorySha256: Sha256HexSchema.nullable()
});
export type StackBackendStatusReport = z.infer<typeof StackBackendStatusReportSchema>;

export const PutStackStatusRequestSchema = z.strictObject({
  /** The release this controller image carries (E4). */
  release: StackReleaseSchema,
  /** The `upgradeGeneration` this report reflects having acted on. */
  observedUpgradeGeneration: z.number().int().min(0),
  backends: z.array(StackBackendStatusReportSchema).max(16)
});
export type PutStackStatusRequest = z.infer<typeof PutStackStatusRequestSchema>;

// ---- THE READ MODEL -----------------------------------------------------------------------------

export const StackControllerViewSchema = z.object({
  release: StackReleaseSchema.nullable(),
  lastSeenAt: z.string().nullable(),
  /** False when the controller has never reported, or has not reported within the staleness
   *  window — the page must not present a stale `ready` as current. */
  reporting: z.boolean(),
  observedUpgradeGeneration: z.number().int().min(0).nullable()
});
export type StackControllerView = z.infer<typeof StackControllerViewSchema>;

export const StackBackendViewSchema = z.object({
  backend: StackBackendSchema,
  enabled: z.boolean(),
  sizeTier: StackSizeTierSchema,
  purgeGeneration: z.number().int().min(0),
  /** Null until the controller has reported this backend. */
  status: StackBackendStatusSchema.nullable()
});
export type StackBackendView = z.infer<typeof StackBackendViewSchema>;

export const StackViewSchema = z.object({
  settings: StackSettingsSchema,
  controller: StackControllerViewSchema,
  backends: z.array(StackBackendViewSchema)
});
export type StackView = z.infer<typeof StackViewSchema>;

export const StackDiagnosticsBackendSchema = z.object({
  backend: StackBackendSchema,
  detail: z.array(z.string())
});

/** The downloadable support bundle: the whole read model plus the controller's evidence. */
export const StackDiagnosticsSchema = z.object({
  generatedAt: z.string(),
  stack: StackViewSchema,
  backends: z.array(StackDiagnosticsBackendSchema)
});
export type StackDiagnostics = z.infer<typeof StackDiagnosticsSchema>;

// ---- INSTANCE OPERATORS (owner decision 2026-09-25: a role granted to a user) -------------------

/** Who performed an instance-level act. */
export const InstanceActorSchema = z.object({
  /** `session-role`: a logged-in user holding the instance-operator role. `credential` /
   *  `bootstrap-env-token`: a machine or CLI presenting an operator credential. `install`: the
   *  install-time bootstrap grant. */
  mechanism: z.enum(["session-role", "credential", "bootstrap-env-token", "install"]),
  orgId: z.string().uuid().nullable(),
  userId: z.string().uuid().nullable(),
  username: z.string().nullable(),
  credentialId: z.string().uuid().nullable()
});
export type InstanceActor = z.infer<typeof InstanceActorSchema>;

export const InstanceOperatorGrantSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  userId: z.string().uuid(),
  username: z.string(),
  grantedBy: InstanceActorSchema,
  grantedAt: z.string(),
  revokedAt: z.string().nullable(),
  revokedBy: InstanceActorSchema.nullable()
});
export type InstanceOperatorGrant = z.infer<typeof InstanceOperatorGrantSchema>;

export const InstanceOperatorGrantListSchema = z.object({
  items: z.array(InstanceOperatorGrantSchema),
  /** Whether the CALLER holds the role — what a page asks before offering a switch. */
  callerHoldsRole: z.boolean()
});
export type InstanceOperatorGrantList = z.infer<typeof InstanceOperatorGrantListSchema>;

export const CreateInstanceOperatorGrantRequestSchema = z.strictObject({
  orgId: z.string().uuid(),
  userId: z.string().uuid()
});
export type CreateInstanceOperatorGrantRequest = z.infer<
  typeof CreateInstanceOperatorGrantRequestSchema
>;

export const InstanceOperatorGrantParamSchema = z.object({ grantId: z.string().uuid() });

/** Whether the caller's own session holds the instance-operator role (any session may ask). */
export const InstanceOperatorSelfSchema = z.object({ holdsRole: z.boolean() });
export type InstanceOperatorSelf = z.infer<typeof InstanceOperatorSelfSchema>;

/** One link of the INSTANCE audit chain (hash-chained like an org's, DESIGN §4.3). */
export const InstanceAuditEventSchema = z.object({
  id: z.string().uuid(),
  seq: z.number().int(),
  action: z.string(),
  actor: InstanceActorSchema,
  subject: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()),
  requestId: z.string(),
  occurredAt: z.string(),
  prevHash: z.string(),
  rowHash: z.string()
});
export type InstanceAuditEvent = z.infer<typeof InstanceAuditEventSchema>;

export const InstanceAuditEventListSchema = z.object({
  items: z.array(InstanceAuditEventSchema),
  /** The server re-walked the whole chain; false names the first broken link. */
  chainValid: z.boolean(),
  brokenAt: z.string().nullable()
});
export type InstanceAuditEventList = z.infer<typeof InstanceAuditEventListSchema>;

/** How long a controller report stays "current". Three missed 30s reconcile ticks, rounded up. */
export const STACK_CONTROLLER_STALE_AFTER_MS = 120_000;
