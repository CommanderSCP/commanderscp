/**
 * @scp/plugin-api — the six stable, independently semver'd plugin interfaces (DESIGN.md §11).
 *
 * M3 (BUILD_AND_TEST.md §8 M3 item 7) is the first real implementation: `ExecutorPlugin` is
 * fully specified and exercised (the in-repo fake executor + the subprocess plugin host +
 * `@scp/plugin-testkit`'s conformance suite). The other five interfaces are specified here to the
 * same contract shape (JSON-serializable args/results only, injected `PluginContext`) so their
 * M4/M6/M7 implementations never need a breaking change to this package, but nothing implements
 * them yet.
 *
 * Every call crosses a host-mediated seam (DESIGN.md §11): JSON-serializable args/results only,
 * an injected scoped `PluginContext`, host-enforced timeouts, and standardized error mapping. In
 * M3 the host is the subprocess plugin host (`apps/server/src/plugin-host/`) — one child process
 * per configured plugin instance, JSON-RPC 2.0 over stdio.
 */

// -------------------------------------------------------------------------------------------
// Shared: PluginContext and its injected accessors
// -------------------------------------------------------------------------------------------

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

export interface PluginContext {
  orgId: string;
  domainId: string;
  logger: Logger;
  secrets: SecretsAccessor;
  http: ScopedHttpClient;
  /** Validated against the plugin manifest's `configSchema` (JSON Schema) before injection. */
  config: unknown;
}

// -------------------------------------------------------------------------------------------
// ExecutorPlugin (DESIGN.md §11, §12) — the coordination boundary is enforced structurally: no
// execute()/deploy() verb exists. `trigger` can only invoke automation the target execution
// system already defines (its own workflow, its own Application sync, its own pipeline).
// -------------------------------------------------------------------------------------------

/** Opaque pagination/watermark token for `observe` — plugins mint and interpret their own shape. */
export interface Cursor {
  token: string;
}

export type ExecutorEventKind =
  | "push"
  | "pull_request"
  | "workflow_run"
  | "deployment"
  | "release"
  | "sync"
  | "custom";

/** Correlation hints (DESIGN §9.2) an observed event carries for matching against `source_mappings`. */
export interface ExecutorEventCorrelation {
  repo?: string;
  path?: string;
  commitSha?: string;
  artifactDigest?: string;
  labels?: Record<string, string>;
  correlationKey?: string;
}

export interface ExecutorEvent {
  kind: ExecutorEventKind;
  /** ISO 8601. */
  occurredAt: string;
  correlation: ExecutorEventCorrelation;
  /** The provider-native payload, kept verbatim for audit/debugging — never parsed by the host. */
  raw: unknown;
}

/**
 * What `trigger` may ask for — deliberately a closed, coordination-shaped vocabulary (invoke
 * automation the org already defined; never "deploy this artifact"). `rollback` carries the
 * `priorStateRef` a prior `status()` call captured, so trigger-a-rollback and trigger-a-forward
 * change are the exact same verb with different intent data (DESIGN §9.4).
 */
export interface TriggerIntent {
  kind: "sync" | "workflow_dispatch" | "rollback" | "custom";
  targetRef?: string;
  parameters?: Record<string, unknown>;
  priorStateRef?: unknown;
  /**
   * Stable across retries of the SAME logical trigger attempt (PR #7 review, CRITICAL #2: the
   * engine derives this deterministically from the wave-target row's own id, so it is IDENTICAL
   * every time coordination/reconcile.ts re-calls `trigger()` for that target — including after a
   * crash/resume where the engine can't tell whether the previous call's side effect actually
   * fired before the process died). A real executor plugin uses this to de-duplicate: the SAME key
   * must return the SAME `ExternalRunRef` without firing the automation a second time; a
   * DIFFERENT key is a genuinely new run. Optional only because `TriggerIntent` predates this
   * field and hand-constructed test intents may omit it — the engine itself always sets it.
   */
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
  /** Opaque snapshot of executor-side state at this point in time — what a later rollback restores. */
  stateRef?: unknown;
  /** Best-effort 0..1; heartbeat input for the stuck-change watchdog (DESIGN §9.4). */
  progress?: number;
}

export interface AbortResult {
  aborted: boolean;
  detail?: string;
}

export interface ExecutorCapabilities {
  supportsObserve: boolean;
  supportsTrigger: boolean;
  supportsAbort: boolean;
  triggerKinds: TriggerIntent["kind"][];
}

export interface ExecutorPlugin {
  /** Pull/poll detection since `since` (omitted = "from the beginning" / provider default). */
  observe(ctx: PluginContext, since?: Cursor): Promise<ExecutorEvent[]>;
  /** Invoke the executor's own defined automation. NEVER an execute/deploy primitive. */
  trigger(ctx: PluginContext, intent: TriggerIntent): Promise<ExternalRunRef>;
  status(ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus>;
  abort(ctx: PluginContext, ref: ExternalRunRef): Promise<AbortResult>;
  describeCapabilities(): ExecutorCapabilities;
}

// -------------------------------------------------------------------------------------------
// ControlPlugin (DESIGN.md §10.2) — M4 implements; contract shape fixed now.
// -------------------------------------------------------------------------------------------

export interface ControlRequest {
  changeId: string;
  controlId: string;
  context: Record<string, unknown>;
}

export type ControlOutcomeStatus = "pass" | "fail" | "warning" | "skipped" | "timed_out" | "expired";

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

// -------------------------------------------------------------------------------------------
// FederationTransportPlugin (DESIGN.md §13) — M6 implements.
// -------------------------------------------------------------------------------------------

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

// -------------------------------------------------------------------------------------------
// DiscoveryPlugin (DESIGN.md §11) — M7 implements (GitHub repo/topology scan).
// -------------------------------------------------------------------------------------------

export interface DiscoveryProposal {
  objects: Array<{ typeId: string; name: string; properties?: Record<string, unknown> }>;
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
    /** The routing Type (ADR-0007). Closed set: image|rpm|deb|npm|infrastructure|configuration.
     *  Omitted ⇒ the server default ('configuration'). Kept as a self-contained string-union here so
     *  `@scp/plugin-api` stays free of a `@scp/schemas` dependency. */
    type?: "image" | "rpm" | "deb" | "npm" | "infrastructure" | "configuration";
  }>;
}

export interface DiscoveryPlugin {
  discover(ctx: PluginContext): Promise<DiscoveryProposal>;
}

// -------------------------------------------------------------------------------------------
// Plugin manifest (DESIGN.md §11) — every plugin is an npm package declaring this shape. Config
// schemas auto-surface as validated config forms in API/CLI/UI; distribution is compile-time
// only (bundled into the server image) — no runtime hot-loading, ever.
// -------------------------------------------------------------------------------------------

export type PluginKind =
  | "executor"
  | "control"
  | "identity"
  | "notification"
  | "federation-transport"
  | "discovery";

export interface PluginManifest {
  id: string;
  kind: PluginKind;
  version: string;
  /** JSON Schema validating this plugin instance's `config`. */
  configSchema: Record<string, unknown>;
  requiredCapabilities?: string[];
}
