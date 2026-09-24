/** The six stable, independently semver'd plugin interfaces. See docs/plugin-api.md §4. */

export * from "./dedup-cache.js";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Read-only; resolves only secrets explicitly scoped to this plugin instance's configuration. */
export interface SecretsAccessor {
  get(key: string): Promise<string | undefined>;
}

export interface ScopedHttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  /** Must be JSON-serializable — the call crosses the host/plugin process boundary. */
  body?: unknown;
  /** Response-body ceiling, enforced while accumulating. See docs/plugin-api.md §5. */
  maxResponseBytes?: number;
}

export interface ScopedHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Egress-controlled, instrumented HTTP — the only network path a plugin is given. */
export interface ScopedHttpClient {
  request(req: ScopedHttpRequest): Promise<ScopedHttpResponse>;
}

// The typed failure `maxResponseBytes` raises, shared by all. See docs/plugin-api.md §6.

/** Thrown by a `ScopedHttpClient.request()` call whose `maxResponseBytes` bound was exceeded. */
export interface ScopedHttpResponseTooLargeError extends Error {
  responseTooLarge: true;
  limitBytes: number;
  url: string;
}

export function isScopedHttpResponseTooLargeError(
  err: unknown
): err is ScopedHttpResponseTooLargeError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { responseTooLarge?: unknown }).responseTooLarge === true
  );
}

/** Builds a {@link ScopedHttpResponseTooLargeError} — the one place the message is worded, so
 *  every `ScopedHttpClient` implementation reports the limit identically. */
export function scopedHttpResponseTooLargeError(
  url: string,
  limitBytes: number
): ScopedHttpResponseTooLargeError {
  return Object.assign(
    new Error(
      `response body for ${url} exceeded the ${limitBytes}-byte response ceiling — the read was ` +
        `aborted mid-stream (cancelled at the transport) before the excess bytes were buffered; ` +
        `this is never a silent truncation`
    ),
    { responseTooLarge: true as const, limitBytes, url }
  );
}

export interface PluginContext {
  orgId: string;
  /** An opaque scope key for plugin-instance isolation. See docs/plugin-api.md §7. */
  scopeKey: string;
  logger: Logger;
  secrets: SecretsAccessor;
  http: ScopedHttpClient;
  /** Validated against the plugin manifest's `configSchema` (JSON Schema) before injection. */
  config: unknown;
}

// ExecutorPlugin (DESIGN.md §11, §12). See docs/plugin-api.md §8.

/** Opaque pagination/watermark token for `observe` — plugins mint and interpret their own shape. */
export interface Cursor {
  token: string;
}

export type ExecutorEventKind =
  "push" | "pull_request" | "workflow_run" | "deployment" | "release" | "sync" | "custom";

/** Correlation hints (DESIGN §9.2) an observed event carries for matching against `source_mappings`. */
export interface ExecutorEventCorrelation {
  repo?: string;
  path?: string;
  /** EVERY path the event touched. See docs/plugin-api.md §9. */
  paths?: string[];
  commitSha?: string;
  artifactDigest?: string;
  /** An opaque provider identity, used only to deduplicate. See docs/plugin-api.md §10. */
  stateRef?: string;
  labels?: Record<string, string>;
  /** The fully-qualified git ref. See docs/plugin-api.md §11. */
  ref?: string;
  correlationKey?: string;
}

export interface ExecutorEvent {
  kind: ExecutorEventKind;
  occurredAt: string;
  correlation: ExecutorEventCorrelation;
  /** The provider-native payload, kept verbatim for audit/debugging — never parsed by the host. */
  raw: unknown;
}

/** What `trigger` may ask: a closed coordination vocabulary. See docs/plugin-api.md §12. */
export interface TriggerIntent {
  kind: "sync" | "workflow_dispatch" | "rollback" | "custom";
  targetRef?: string;
  parameters?: Record<string, unknown>;
  priorStateRef?: unknown;
  /** Stable across retries of the SAME logical trigger attempt. See docs/plugin-api.md §13. */
  idempotencyKey?: string;
}

export interface ExternalRunRef {
  externalId: string;
  url?: string;
}

export type ExecutionPhase = "pending" | "running" | "succeeded" | "failed" | "aborted";

export interface ExecutionStatus {
  phase: ExecutionPhase;
  detail?: string;
  /** Opaque executor state, bounded before it is ever stored. See docs/plugin-api.md §14. */
  stateRef?: unknown;
  /** A structured snapshot of what the executor has deployed. See docs/plugin-api.md §15. */
  observed?: {
    images?: string[];
    rollout?: {
      phase?: string;
      step?: number;
      weight?: number;
      message?: string;
      /** THE TOTAL STEP COUNT (M), read from the SAME manifest fetch that already produces `step`
       *  (`currentStepIndex`) — never a second call. Absent when the executor has no notion of a
       *  step total (a blue-green Rollout, an older Rollouts version, a non-ArgoCD executor) or the
       *  manifest fetch failed. NEVER 0 and never guessed: pipeline-mockup-data.md §5.1. */
      stepCount?: number;
    };
    /** managed-iac's structured plan tally (pipeline-mockup-data.md §6) — counted from `tofu show
     *  -json`'s `resource_changes[].change.actions` (`apps/runner-iac/run.sh`'s `plan.json`), NEVER
     *  from human stdout. `ref` is the plan file's own content hash, so a re-poll of the same
     *  evidence reports the same identity. Absent means "not reported" (a parse miss, an executor
     *  with no structured plan, or an action whose evidence is not a plan document — e.g.
     *  `rollback`'s state-format `plan.json`) — NEVER a zeroed summary. */
    plan?: {
      ref?: string;
      add?: number;
      change?: number;
      destroy?: number;
    };
  };
  /** Best-effort 0..1; heartbeat input for the stuck-change watchdog (DESIGN §9.4). */
  progress?: number;
}

/**
 * A trigger the executor REFUSED on its own evidence — not a transient failure (M28.4, ADR-0055).
 *
 * A plain throw from `trigger()` is retried with backoff, which is right for a timeout or a 503 and
 * wrong for a verdict: a refusal the plugin reaches on the document itself (an authored Application
 * outside the operator's declaration, a name another target owns) will refuse identically on every
 * retry, so the target sat in `triggering` forever with no Decision. Throwing THIS marks it terminal:
 * the host carries it across the process boundary as `TRIGGER_REFUSED_RPC_CODE`, and the server
 * records a Decision and an audit event instead of retrying.
 *
 * The message is persisted on the Decision: it must name the refused property, never another
 * tenant's identifiers.
 */
export class TriggerRefused extends Error {
  readonly refused = true;
  constructor(message: string) {
    super(message);
    this.name = "TriggerRefused";
  }
}

/** The JSON-RPC error code a `TriggerRefused` travels under (the generic plugin error is -32000). */
export const TRIGGER_REFUSED_RPC_CODE = -32010;

/** Structural check — survives module duplication, where `instanceof` would not. */
export function isTriggerRefused(err: unknown): err is TriggerRefused {
  return err instanceof Error && err.name === "TriggerRefused";
}

/** The refusal carried by a host error, or `undefined` for an ordinary (retryable) failure.
 *
 *  Decided on the JSON-RPC CODE the host carries as data (`rpcCode`), NEVER on message text: the
 *  host's message embeds the instance id, and an earlier text-marker version let a tenant-chosen id
 *  containing the marker turn a DNS failure into a terminal verdict with a tenant-written reason
 *  (review probe F). Only the subprocess entry sets the code, and only for a `TriggerRefused`. */
export function triggerRefusalOf(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const { rpcCode, rpcMessage } = err as Error & { rpcCode?: unknown; rpcMessage?: unknown };
  if (rpcCode !== TRIGGER_REFUSED_RPC_CODE) return undefined;
  return typeof rpcMessage === "string" ? rpcMessage : err.message;
}

/**
 * THE HOST-OPS TEMPLATE READ-BACK REFUSED (M28.2, ADR-0054 D9(d)) — a `TriggerRefused` with its OWN
 * JSON-RPC code, so the server can record it as an ops-material refusal (with the lane's own status
 * and reason) rather than a generic executor verdict.
 *
 * Decided on the CODE, like `triggerRefusalOf`: the first version matched a text marker in the
 * message, and #413's instance-id charset admits every character of it, so an instance named after
 * the marker could make a DNS failure read as a template verdict (#414 final re-verification).
 */
export class OpsTemplateRefused extends TriggerRefused {
  constructor(message: string) {
    super(message);
    this.name = "OpsTemplateRefused";
  }
}

/** The JSON-RPC code an `OpsTemplateRefused` travels under. */
export const OPS_TEMPLATE_REFUSED_RPC_CODE = -32011;

/** Structural check — survives module duplication, where `instanceof` would not. */
export function isOpsTemplateRefused(err: unknown): err is OpsTemplateRefused {
  return err instanceof Error && err.name === "OpsTemplateRefused";
}

/** The ops read-back refusal carried by an error, or `undefined`.
 *
 *  Over the subprocess host: the RPC CODE only (`rpcCode`, set by the host as data, never parsed out
 *  of text). In-process (no host between, so no `rpcCode` and no host-written message): the error's
 *  own NAME, which the plugin sets and which no tenant string reaches. Never the message text. */
export function opsTemplateRefusalOf(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const { rpcCode, rpcMessage } = err as Error & { rpcCode?: unknown; rpcMessage?: unknown };
  if (rpcCode !== undefined) {
    if (rpcCode !== OPS_TEMPLATE_REFUSED_RPC_CODE) return undefined;
    return typeof rpcMessage === "string" ? rpcMessage : err.message;
  }
  return isOpsTemplateRefused(err) ? err.message : undefined;
}

export interface AbortResult {
  aborted: boolean;
  detail?: string;
}

/** D12's rollout authority split. See docs/plugin-api.md §16. */
export type RolloutAuthority = "authoritative" | "triggerParams" | "verified";

/** Must stay identical to the schemas' rollout target class. See docs/plugin-api.md §17. */
export type RolloutTargetClass = "cluster" | "instanceGroup";

export interface RolloutCapability {
  authority: RolloutAuthority;
  /** The target classes this executor can roll out to. An executor bound to a target whose class is
   *  not listed does not "fall back" — the binding is loud-unbound (§14 resolution 2: no silent
   *  defaults), because a misrouted rollout is worse than an absent one. */
  targetClasses: RolloutTargetClass[];
}

export interface ExecutorCapabilities {
  supportsObserve: boolean;
  supportsTrigger: boolean;
  supportsAbort: boolean;
  triggerKinds: TriggerIntent["kind"][];
  /** D12. OPTIONAL and additive: an executor that has no notion of a progressive rollout omits it,
   *  and every plugin that predates this field keeps its existing meaning — which is "declares no
   *  rollout authority", NOT "authoritative by default". Absent must never read as a claim. */
  rollout?: RolloutCapability;
  /** Whether this executor can hold a RECURRING declaration (`ensureSchedule`/`removeSchedule`).
   *  OPTIONAL and additive, exactly like `rollout` above: absent means "declares no schedule
   *  capability", never "capable by default". Absent must not read as a claim. */
  supportsSchedules?: boolean;
}

/** A recurring probe the executor holds until retracted. See docs/plugin-api.md §18. */
export interface ScheduleSpec {
  /** Stable identity for the schedule, so a re-declaration UPDATES rather than duplicates. */
  scheduleId: string;
  /** The automation to run — the executor's own, named. Never a command SCP composes. */
  targetRef: string;
  cadenceSeconds: number;
  /** Correlation the executor should stamp on runs it spawns, so results map back to the hook. */
  labels?: Record<string, string>;
}

export interface ExecutorPlugin {
  /** Pull/poll detection since `since` (omitted = "from the beginning" / provider default). */
  observe(ctx: PluginContext, since?: Cursor): Promise<ExecutorEvent[]>;
  /** Invoke the executor's own defined automation. NEVER an execute/deploy primitive. */
  trigger(ctx: PluginContext, intent: TriggerIntent): Promise<ExternalRunRef>;
  status(ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus>;
  abort(ctx: PluginContext, ref: ExternalRunRef): Promise<AbortResult>;
  describeCapabilities(): ExecutorCapabilities;
  /** Declare a recurring automation: additive, not a core verb. See docs/plugin-api.md §19. */
  ensureSchedule?(ctx: PluginContext, spec: ScheduleSpec): Promise<void>;
  /** Retract a schedule declared by `ensureSchedule`. A no-op for an id that is not there — a
   *  retraction for a schedule already gone is ordinary, not an error. */
  removeSchedule?(ctx: PluginContext, scheduleId: string): Promise<void>;
}

// ControlPlugin (DESIGN.md §10.2) — M4 implements; contract shape fixed now.

export interface ControlRequest {
  changeId: string;
  controlId: string;
  context: Record<string, unknown>;
}

export type ControlOutcomeStatus =
  "pass" | "fail" | "warning" | "skipped" | "timed_out" | "expired";

export interface ControlOutcome {
  status: ControlOutcomeStatus;
  evidence?: Record<string, unknown>;
  detail?: string;
}

export interface ControlPlugin {
  evaluate(ctx: PluginContext, req: ControlRequest): Promise<ControlOutcome>;
}

// -------------------------------------------------------------------------------------------
// IdentityPlugin (DESIGN.md §7) — M0/M2 implement local-auth/OIDC directly today; formalized
// under this interface as the identity plugin surface stabilizes.
// -------------------------------------------------------------------------------------------

export interface AuthInput {
  kind: string;
  credentials: Record<string, unknown>;
}

export interface AuthResult {
  subjectId: string;
  displayName?: string;
  claims?: Record<string, unknown>;
}

export interface SubjectProfile {
  subjectId: string;
  displayName?: string;
  email?: string;
}

export interface IdentityPlugin {
  authenticate(ctx: PluginContext, credentials: AuthInput): Promise<AuthResult>;
  resolveSubject(ctx: PluginContext, subjectId: string): Promise<SubjectProfile>;
}

// -------------------------------------------------------------------------------------------
// NotificationPlugin (DESIGN.md §11) — M3's watchdog escalation seam calls into this shape (no
// shipped implementation until M7's smtp-notify/webhook-notify).
// -------------------------------------------------------------------------------------------

export interface NotificationMessage {
  subject: string;
  body: string;
  severity: "info" | "warning" | "critical";
  context?: Record<string, unknown>;
}

export interface DeliveryResult {
  delivered: boolean;
  detail?: string;
}

export interface NotificationPlugin {
  send(ctx: PluginContext, msg: NotificationMessage): Promise<DeliveryResult>;
}

// FederationTransportPlugin (DESIGN.md §13) — M6 implements.

export interface JournalSegment {
  originDomainId: string;
  sequence: number;
  contentHash: string;
  signature: string;
  entries: unknown[];
}

export interface DomainCursor {
  domainId: string;
  sequence: number;
}

export interface ExportOptions {
  peer: string;
  sinceSequence?: number;
}

export interface BundleRef {
  path: string;
  checksum: string;
}

export interface ImportReport {
  appliedSegments: number;
  lastSequence: number;
}

export interface FederationTransportPlugin {
  push(ctx: PluginContext, segment: JournalSegment): Promise<void>;
  pull(ctx: PluginContext, cursor: DomainCursor): Promise<JournalSegment[]>;
  exportBundle(ctx: PluginContext, opts: ExportOptions): Promise<BundleRef>;
  importBundle(ctx: PluginContext, bundle: BundleRef): Promise<ImportReport>;
}

// DiscoveryPlugin (DESIGN.md §11) — M7 implements (GitHub repo/topology scan).

/** A discovery plugin emits `contains`, service to component. See docs/plugin-api.md §20. */
export interface DiscoveryProposal {
  objects: Array<{
    typeId: string;
    name: string;
    properties?: Record<string, unknown>;
    /** Proposal-local alias this object is referenced by in `relationships[].fromUrn`/`toUrn`.
     *  Required in practice for any edge between two PROPOSED objects: accept mints the stored URN
     *  from the org id and a server-side slug rule, so a plugin cannot name its own objects without
     *  it. See `@scp/schemas`'s `DiscoveryProposalObjectSchema.urn`. */
    urn?: string;
  }>;
  relationships: Array<{ typeId: string; fromUrn: string; toUrn: string }>;
  /** Optional executor bindings to create at accept (M12 P3b) — `objectName` references one of
   *  `objects` by name, so an imported object can be wired to an execution-system in one step. */
  bindings?: Array<{ objectName: string; executionSystemId: string; externalRef?: string }>;
  /** Optional source_mappings to create at accept (M12 P5, owner Q3) — so an imported component
   *  self-reports releases via observe()/webhooks, not just being triggerable. `objectName`
   *  references one of `objects` by name; `sourceKind`+`repoPattern`/`pathPattern` are how a
   *  correlated event finds the component (e.g. github + the app's git repoURL for an argocd import). */
  sourceMappings?: Array<{
    objectName: string;
    sourceKind: string;
    repoPattern?: string;
    pathPattern?: string;
    /** The routing Type (ADR-0007). Closed set. See docs/plugin-api.md §21. */
    type?:
      | "image"
      | "rpm"
      | "deb"
      | "npm"
      | "maven"
      | "python"
      | "go"
      | "chart"
      | "vm-image"
      | "infrastructure"
      | "configuration";
  }>;
}

export interface DiscoveryPlugin {
  discover(ctx: PluginContext): Promise<DiscoveryProposal>;
}

// DependencyIndexPlugin: resolution behind the egress guard. See docs/plugin-api.md §22.

/** Must stay identical to the schemas' dependency ecosystem. See docs/plugin-api.md §23. */
export type DependencyIndexEcosystem = "npm" | "go" | "maven" | "python" | "oci";

export interface DependencyIndexQuery {
  ecosystem: DependencyIndexEcosystem;
  /** The coordinate in the ecosystem's OWN spelling, VERBATIM — `@acme/lib`,
   *  `github.com/Masterminds/semver/v3`, `com.acme:lib`, `ghcr.io/acme/base`. Never slugified: SCP's
   *  URN slug collapses `@acme/lib`, `acme/lib` and `acme-lib` into one identity (ADR-0032 Context
   *  2), which is why the inventory keys on this string and why it must cross this seam unchanged. */
  coordinate: string;
  /** The major line as the ECOSYSTEM spells it (`3`, `v2`, `1.2`) — a HINT, not a filter contract.
   *  A plugin uses it only where the index protocol demands it; the line membership test itself is
   *  the server's, so two plugins can never disagree about what "on the line" means. */
  majorLine: string;
  /** `oci` only — the variant suffix this line follows (`-alpine`). Image tags are not semver and
   *  `latest`/`1.2`/date stamps coexist in one repository (ADR-0032 §7). */
  tagPattern?: string;
}

/** One version as the index spells it. `version` is verbatim index text; nothing normalises it. */
export interface DependencyIndexVersion {
  version: string;
  /** Present only where the index reports content identity alongside the label — see
   *  `resolveDigest`, and `DependencyIndexCapabilities.reportsDigest`. */
  digest?: string;
}

/** Why `unavailable` exists: unreachable is not empty. See docs/plugin-api.md §24. */
export type DependencyIndexUnavailableReason =
  /** No index is configured for this ecosystem on this deployment — the air-gap default. */
  | "not_configured"
  /** The index answered, but does not know this coordinate (a 404 for the package itself). */
  | "unknown_coordinate"
  /** The request never completed: DNS, connect, TLS, timeout — INCLUDING a chart-deployed
   *  instance's default-deny egress NetworkPolicy, which surfaces here as a connect failure. */
  | "unreachable"
  /** The index answered 3xx. Redirects are HARD-DISABLED on the plugin HTTP client
   *  (`plugin-host/subprocess-entry.ts`, `redirect: "error"`) because a 3xx can re-point a request
   *  at an internal host AFTER the pre-flight egress check — and public registries redirect
   *  routinely. Its OWN reason so an operator reads "point me at the final URL", not "unreachable". */
  | "redirected"
  /** 401/403 — the index requires a credential this instance was not given. */
  | "unauthorized"
  /** 2xx, but the body is not the document this index is documented to return. */
  | "malformed_response"
  /** `resolveDigest` only: this index has no notion of content digest (every language ecosystem). */
  | "no_digest";

export type DependencyIndexResult =
  | { status: "available"; versions: DependencyIndexVersion[] }
  | {
      status: "unavailable";
      reason: DependencyIndexUnavailableReason;
      /** Human-readable, never parsed — what an operator reads to fix the deployment. */
      detail: string;
    };

export type DependencyIndexDigestResult =
  | { status: "available"; digest: string }
  | { status: "unavailable"; reason: DependencyIndexUnavailableReason; detail: string };

export interface DependencyIndexCapabilities {
  ecosystem: DependencyIndexEcosystem;
  /** True only for indexes whose `resolveDigest` can ever succeed (`oci`). A MUTABLE TAG IS NOT AN
   *  IDENTITY (ADR-0032 §7): an image line records the digest its tag resolved to, so this is what
   *  tells the caller whether "the line is on 3.19" is a statement about bytes or about a pointer. */
  reportsDigest: boolean;
}

export interface DependencyIndexPlugin {
  /** Every version the index reports for `coordinate`. Reports, never ranks — see the section doc. */
  listVersions(ctx: PluginContext, query: DependencyIndexQuery): Promise<DependencyIndexResult>;
  /** The content digest `version` currently resolves to. `no_digest` for every language ecosystem. */
  resolveDigest(
    ctx: PluginContext,
    ref: { ecosystem: DependencyIndexEcosystem; coordinate: string; version: string }
  ): Promise<DependencyIndexDigestResult>;
  describeIndex(): DependencyIndexCapabilities;
}

// Plugin manifest (DESIGN.md §11). See docs/plugin-api.md §25.

/** ADDITIVE ONLY. M21.4 adds `dependency-index` (ADR-0032 §7) as a seventh kind; the six before it
 *  are unchanged, and nothing that switches on this union may have its existing arms altered. */
export type PluginKind =
  | "executor"
  | "control"
  | "identity"
  | "notification"
  | "federation-transport"
  | "discovery"
  | "dependency-index";

export interface PluginManifest {
  id: string;
  kind: PluginKind;
  version: string;
  configSchema: Record<string, unknown>;
  requiredCapabilities?: string[];
}
