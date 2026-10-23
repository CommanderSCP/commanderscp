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
  "state-integrity",
  /** M29.2: the backend is healthy but its wiring into SCP (scoped token, TLS trust, egress,
   *  registration) did not complete; the message says which step and why. */
  "wiring"
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
  purgeGeneration: z.number().int().min(0),
  /** M29.2: bumped by `POST /instance/stack/backends/{b}/rotate`. The controller re-mints the
   *  backend's scoped token (and argo-server's certificate) when this exceeds the generation the
   *  recorded wiring satisfied. */
  rotateGeneration: z.number().int().min(0)
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

/** M29.2: what scpd holds of a backend's wiring, as the controller may see it — a hash and a
 *  counter, never the endpoint or the token. The controller compares `factsSha256` with the hash of
 *  the facts it derives from its own render; a mismatch (or a rotation request) re-wires. */
export const StackBackendWiringSpecSchema = z.object({
  backend: StackBackendSchema,
  factsSha256: Sha256HexSchema.nullable(),
  rotationGeneration: z.number().int().min(0).nullable()
});
export type StackBackendWiringSpec = z.infer<typeof StackBackendWiringSpecSchema>;

/** M29.3: what scpd holds of the canary authoring hand-off, as the controller may see it — a hash,
 *  never the revision or the cluster names. */
export const StackAuthoringSpecSchema = z.object({
  factsSha256: Sha256HexSchema.nullable()
});
export type StackAuthoringSpec = z.infer<typeof StackAuthoringSpecSchema>;

export const StackSpecDocumentSchema = z.object({
  settings: StackSettingsSchema,
  backends: z.array(StackBackendSpecSchema),
  integrity: z.array(StackBackendIntegritySchema),
  wiring: z.array(StackBackendWiringSpecSchema),
  /** M29.3 — absent from a pre-M29.3 scpd. */
  authoring: StackAuthoringSpecSchema.optional()
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

// ---- WIRING (controller-written, M29.2) ---------------------------------------------------------

/** The backends the controller wires into SCP. Argo Rollouts is not an executor (ADR-0008 §3):
 *  SCP reads rollout state through Argo CD and never speaks to it, so there is nothing to wire. */
export const StackWireableBackendSchema = z.enum([
  "argocd",
  "argo-workflows",
  "argo-events",
  "gitea"
]);
export type StackWireableBackend = z.infer<typeof StackWireableBackendSchema>;

/** An in-cluster Service URL, the only endpoint shape a wiring may name: http(s), a
 *  `<service>.<namespace>.svc[.cluster.local]` host, an optional port, no path, no credentials. */
export const STACK_WIRING_URL_PATTERN =
  /^https?:\/\/[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\.svc(\.cluster\.local)?(:[0-9]{1,5})?$/;

/**
 * WHERE EACH CALLED BACKEND'S API IS — its Service and namespace in the bundled chart
 * (deploy/helm-bundled; the namespaces are the chart's own defaults, not operator values). scpd
 * refuses a wiring naming any other host, so even the controller's credential cannot point a
 * registration at a different Service; the controller derives its endpoint from the same pin and
 * fails if its render disagrees.
 */
export const STACK_BACKEND_SERVICES = {
  argocd: { service: "argocd-server", namespace: "scp-argocd", scheme: "http" },
  "argo-workflows": { service: "argo-server", namespace: "scp-argo-workflows", scheme: "https" },
  gitea: { service: "scp-gitea-http", namespace: "scp-gitea", scheme: "http" }
} as const;

/**
 * The controller's hand-off after a backend is healthy (`PUT /instance/stack/backends/{b}/wiring`,
 * the controller's credential ONLY). Every value is one the controller derived from ITS OWN render
 * and the backend it just installed — the endpoint, the CA the endpoint's certificate chains to, the
 * scoped account — plus the token it just minted there, handed over once and never read back.
 * scpd persists the token encrypted at the instance tier, registers the execution system in every
 * org the stack serves, and opens the application egress for exactly that system.
 */
export const PutStackWiringRequestSchema = z.strictObject({
  /** Null for a backend SCP does not call (Argo Events). */
  serverUrl: z.string().max(300).regex(STACK_WIRING_URL_PATTERN).nullable(),
  /** argo-workflows: the namespace its workflows run in (every API path names it). */
  namespace: z
    .string()
    .regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/)
    .nullable(),
  /** PEM of the CA the endpoint's certificate chains to, when it is not publicly trusted. */
  caPem: z.string().min(1).max(16_384).nullable(),
  /** The scoped, non-admin account the token belongs to. */
  account: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/)
    .nullable(),
  token: z.string().min(1).max(16_384).nullable(),
  /** sha256 of the facts above (not the token) and the backend instance's identity — what the
   *  controller compares next tick. */
  factsSha256: Sha256HexSchema,
  /** The rotate generation this hand-off satisfies. */
  rotationGeneration: z.number().int().min(0)
});
export type PutStackWiringRequest = z.infer<typeof PutStackWiringRequestSchema>;

// ---- CANARY AUTHORING (controller-written, M29.3) -----------------------------------------------

/**
 * WHERE SCP-AUTHORED DEPLOYMENTS COME FROM WHEN THE STANDARD STACK SERVES THEM (M29.3, ADR-0062).
 * Every value is FIXED BY THE RELEASE — none is an operator value, none a tenant's: the carrier
 * chart is pushed by the stack controller into a Gitea repository only it writes, the two Argo CD
 * projects are the controller's, and the one namespace authored deployments land in is created by
 * the main chart. scpd derives the whole `authoring` document from these and from the controller's
 * hand-off (the carrier's COMMIT and the clusters Rollouts is installed in) — so nothing a tenant
 * writes chooses the carrier repository, the project, the destination clusters or the namespaces
 * (the M28 class). Pinned equal to the chart and the controller by tests.
 */
export const STACK_AUTHORING = {
  /** The AppProject every SCP-authored Application is created in (ADR-0055 D10's shape). */
  project: "scp-authored",
  /** The controller's own AppProject: the Rollouts install it authors into each target cluster. */
  stackProject: "scp-stack",
  /** The Gitea organization and repository the controller pushes the carrier into. */
  giteaOrg: "scp-stack",
  giteaRepo: "scp-authored-manifests",
  /** The carrier chart's directory in that repository. */
  carrierPath: "scp-authored-manifests",
  /** The Rollouts controller manifests, per target cluster, in that repository. */
  rolloutsPath: "argo-rollouts",
  /** The one namespace an authored deployment lands in, on every target cluster. */
  namespace: "scp-apps"
} as const;

/** An Argo CD cluster NAME as Argo CD's own API reports it: an RFC 1123 subdomain, bounded. */
export const StackClusterNameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/);

/**
 * The controller's canary-authoring hand-off (`PUT /instance/stack/authoring`, its credential
 * ONLY). Sent once Argo CD, Gitea and Argo Rollouts are all ready and wired, the carrier is pushed
 * and both projects exist. Only two facts travel: the COMMIT the carrier was pushed at (Argo CD is
 * pinned to it — a later push to the repository changes nothing it renders) and the registered
 * clusters OTHER than in-cluster whose Rollouts install is healthy (a place naming any other cluster
 * is refused, never rolled out where no Rollouts controller runs).
 */
export const PutStackAuthoringRequestSchema = z.strictObject({
  carrierRevision: z.string().regex(/^[0-9a-f]{40}$/),
  clusters: z.array(StackClusterNameSchema).max(64),
  factsSha256: Sha256HexSchema
});
export type PutStackAuthoringRequest = z.infer<typeof PutStackAuthoringRequestSchema>;

/** Canary authoring as anyone who can read the stack may see it. */
export const StackAuthoringViewSchema = z.object({
  configured: z.boolean(),
  project: z.string(),
  namespace: z.string(),
  carrierRevision: z.string().nullable(),
  /** Registered clusters besides in-cluster that Rollouts is installed in. */
  clusters: z.array(z.string()),
  configuredAt: z.string().nullable()
});
export type StackAuthoringView = z.infer<typeof StackAuthoringViewSchema>;

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

/** M29.2: how a backend is wired into SCP, as anyone who can read the stack may see it. */
export const StackBackendWiringViewSchema = z.object({
  wired: z.boolean(),
  serverUrl: z.string().nullable(),
  /** sha256 of the CA scpd trusts for this endpoint (the PEM itself is on the diagnostics read). */
  caSha256: Sha256HexSchema.nullable(),
  account: z.string().nullable(),
  wiredAt: z.string().nullable(),
  /** The rotate generation the current token satisfies (null when unwired). */
  rotationGeneration: z.number().int().min(0).nullable()
});
export type StackBackendWiringView = z.infer<typeof StackBackendWiringViewSchema>;

export const StackBackendViewSchema = z.object({
  backend: StackBackendSchema,
  enabled: z.boolean(),
  sizeTier: StackSizeTierSchema,
  purgeGeneration: z.number().int().min(0),
  /** Null until the controller has reported this backend. */
  status: StackBackendStatusSchema.nullable(),
  /** M29.2: bumped by the rotate door. */
  rotateGeneration: z.number().int().min(0),
  /** M29.2: null for a backend SCP never wires (Argo Rollouts). */
  wiring: StackBackendWiringViewSchema.nullable()
});
export type StackBackendView = z.infer<typeof StackBackendViewSchema>;

export const StackViewSchema = z.object({
  settings: StackSettingsSchema,
  controller: StackControllerViewSchema,
  backends: z.array(StackBackendViewSchema),
  /** M29.2: whether the Standard Stack serves the CALLER's organization — its wired backends are
   *  registered there as execution systems. Null on a response to a machine credential. */
  servesThisOrg: z.boolean().nullable(),
  /** M29.3: canary authoring through the bundled Argo CD, Gitea and Argo Rollouts. */
  authoring: StackAuthoringViewSchema
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

// ---- THE ORGANIZATIONS THE STACK SERVES (M29.2) ------------------------------------------------

/** One organization the Standard Stack serves: its wired backends are registered there. The
 *  deployment's bootstrap organization is served from the first wiring on; every other one is an
 *  instance operator's decision, because every served org drives the SAME scoped accounts. */
export const StackServedOrgSchema = z.object({
  orgId: z.string().uuid(),
  orgName: z.string(),
  attachedAt: z.string(),
  attachedBy: InstanceActorSchema
});
export type StackServedOrg = z.infer<typeof StackServedOrgSchema>;

export const StackServedOrgListSchema = z.object({ items: z.array(StackServedOrgSchema) });
export type StackServedOrgList = z.infer<typeof StackServedOrgListSchema>;

export const StackOrgParamSchema = z.object({ orgId: z.string().uuid() });

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
