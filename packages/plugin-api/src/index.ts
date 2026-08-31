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

export * from "./dedup-cache.js";

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
  /**
   * Optional hard ceiling on the response BODY size in bytes, enforced by every conforming
   * `ScopedHttpClient` implementation DURING accumulation — never after the full body already
   * sits in memory (M21.2 review MAJOR 5: a cap checked post-buffer is not a cap). Exceeding it
   * aborts the read mid-stream (the implementation cancels the underlying transport read rather
   * than letting it run to completion) and the call REJECTS with a
   * {@link ScopedHttpResponseTooLargeError} — never a silently truncated body.
   *
   * OPT-IN, not a default: `undefined` preserves the pre-existing unbounded-accumulation
   * behavior for any call site that has not been migrated to set it yet — adding this field does
   * not, by itself, change what an existing caller experiences. `@scp/git-provider-core`'s
   * `readFileAtRef`/`api()` helpers are the first callers to set it on every request they make.
   */
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

// -------------------------------------------------------------------------------------------
// ScopedHttpResponseTooLargeError — the typed, loud failure `maxResponseBytes` produces. Lives
// here (not in a single implementation) because every conforming `ScopedHttpClient` — the
// production fetch-backed one (`apps/server/src/plugin-host/subprocess-entry.ts`) AND every
// package's own `node:http`/`node:https`-backed test client (`*-test-support.ts`, needed because
// `nock` does not intercept `fetch` — see those files' module docs) — throws the SAME shape, so a
// consumer like `@scp/git-provider-core`'s `wrapProviderRequestError` can recognize it by
// property regardless of which transport produced it.
// -------------------------------------------------------------------------------------------

/** Thrown by a `ScopedHttpClient.request()` call whose `maxResponseBytes` bound was exceeded. */
export interface ScopedHttpResponseTooLargeError extends Error {
  responseTooLarge: true;
  /** The bound that was exceeded (echoes `ScopedHttpRequest.maxResponseBytes`). */
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
  /**
   * An opaque, host-supplied **scope key** for plugin-instance isolation: the label the host
   * stamps on a plugin invocation so logs, secret lookups and egress accounting can be
   * partitioned per plugin instance. Treat it as a partition label, never as an identifier you
   * can resolve, join on, or dereference.
   *
   * **This is not a domain id in either SCP sense.** It is neither a `TrustDomainId` (the
   * federation/security-domain identity of a deployment) nor a `ContainmentDomainId` (the id of a
   * `domain` graph object) — see `@scp/schemas`'s `domain-ids.ts` and
   * [ADR-0021](../../../docs/adr/0021-terminology.md) D4, which brands those two so they can never
   * be confused. In practice this value is not a uuid at all: every in-tree host populates it with
   * a literal (`"default"`, `"commander"`, `"shared"`, `"domain-1"`).
   *
   * It stays a plain, deliberately **unbranded** `string` for exactly that reason — branding it
   * would either force a bogus brand onto `"default"` or fail to compile against values that were
   * never ids.
   *
   * Until 2026-07-24 this field was named `domainId`, which made it look like a third sense of
   * "domain id". ADR-0021 D4 records the owner decision to rename it to `scopeKey` — a **breaking
   * change to a public plugin contract**: an out-of-tree plugin reading `ctx.domainId` must be
   * updated. The wire form crossing the host/subprocess seam changed with it (the plugin host's
   * `SCP_PLUGIN_DOMAIN_ID` env var is now `SCP_PLUGIN_SCOPE_KEY`), so host and plugin runtime move
   * together.
   */
  scopeKey: string;
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
  "push" | "pull_request" | "workflow_run" | "deployment" | "release" | "sync" | "custom";

/** Correlation hints (DESIGN §9.2) an observed event carries for matching against `source_mappings`. */
export interface ExecutorEventCorrelation {
  repo?: string;
  path?: string;
  /**
   * EVERY path the event touched — the changed-file set of a push, not a single location.
   *
   * `path` (singular) is a *location* hint some providers carry natively (a release's target
   * commitish, a package path). It cannot express a commit, because one commit touches many files,
   * and a `source_mappings` row with a `pathPattern` is SKIPPED outright when the event carries no
   * path it can test (`coordination/correlation.ts`). That is why a repo-only mapping set on a
   * monorepo collapses to exactly ONE live route — the most-constrained-then-oldest winner — and
   * every other mapping on that repo silently never fires.
   *
   * A pattern matches when it matches `path` OR **any** entry here, so populating this is what lets
   * one repo fan out to per-directory components. Additive and optional: a provider that cannot
   * determine the changed set leaves it undefined and behaves exactly as before.
   */
  paths?: string[];
  commitSha?: string;
  artifactDigest?: string;
  /**
   * An OPAQUE provider-side identity for the state this event reports — used only to deduplicate
   * repeated observations of an unchanged thing. Never parsed, never matched against
   * `source_mappings`; the host treats it as a bag of bytes.
   *
   * It exists because not every provider's "what state is this in" is a single commit or digest.
   * A multi-source Argo CD Application is synced to a TUPLE of revisions (`status.sync.revisions`),
   * one per source, and none of them alone identifies the deployment — so neither `commitSha` nor
   * `artifactDigest` can honestly carry it, and stuffing a joined list into a field named "commit
   * SHA" would lie to every consumer that reads one.
   *
   * Set this whenever an event would otherwise fall back to `occurredAt` for its identity and the
   * provider's timestamp advances on its own schedule — Argo CD rewrites `reconciledAt` every few
   * minutes whether or not anything changed, so without a state ref every idle reconcile is a new
   * row forever.
   */
  stateRef?: string;
  labels?: Record<string, string>;
  /**
   * The fully-qualified git ref (`refs/heads/dev`) this event is on — the input a `refPattern`
   * source mapping routes on (ADR-0030 §1). Kept distinct from `correlationKey`, which is a
   * GROUPING identity whose composition varies by event kind; see `GitProviderEventHint.ref`.
   *
   * Poll-vs-push equivalence (DESIGN §12) depends on this being set here as well as on the webhook
   * path: a git provider's `observe()` and its webhook adapter run the SAME `mapEvent`, so a
   * ref-scoped mapping must route a POLLED push exactly as it routes a delivered one. Undefined for
   * any event with no ref.
   */
  ref?: string;
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
  /** Opaque snapshot of executor-side state at this point in time — what a later rollback restores.
   *
   *  BOUNDED BEFORE IT IS STORED (M23.1f), on BOTH routes it takes: `change_wave_targets.observed_state`
   *  as `revision`, and `prior_state_ref` via `markWaveTargetTriggered`. A snapshot that renders to
   *  more than the column policy comes back shortened, so an executor that needs a rollback to
   *  address it must keep it SMALL — a hash or a handle, not a serialised world. The rollback path
   *  is exercised end to end against a real bound in
   *  `apps/server/src/coordination/executor-ref-prior-state-bound.integration.test.ts`. */
  stateRef?: unknown;
  /**
   * Structured, machine-readable snapshot of what the executor currently has deployed (ADR-0008
   * decision 2) — distinct from the free-form `detail` string and the rollback-reserved `stateRef`.
   * Optional and additive: executors that expose no such signal simply omit it. It carries the
   * deployed image refs (tag/digest, e.g. `ghcr.io/x/y:1.2.3` or `...@sha256:...`) and, for
   * progressive-delivery executors (Argo Rollouts), an OBSERVE-ONLY `rollout` sub-state (ADR-0008
   * signal / P4D increment 4).
   *
   * `rollout` mirrors a canary/blue-green rollout's progress as the executor reports it — it does
   * NOT let CommanderSCP DRIVE the rollout (charter principle 1: coordinate, not execute; ADR-0008
   * "rollout state is OBSERVED, NOT DRIVEN"). No verb here promotes/pauses/aborts/re-weights a
   * rollout. EVERY field is optional because only `phase`/`message` are near-free from the parent
   * Application body; structured `step`/`weight` require the executor to expose the live Rollout
   * manifest and are version-dependent — omitted (never fabricated) when the executor does not
   * report them.
   */
  observed?: {
    images?: string[];
    rollout?: { phase?: string; step?: number; weight?: number; message?: string };
  };
  /** Best-effort 0..1; heartbeat input for the stuck-change watchdog (DESIGN §9.4). */
  progress?: number;
}

export interface AbortResult {
  aborted: boolean;
  detail?: string;
}

/**
 * D12's rollout authority split — WHO OWNS THE ROLLOUT, DECLARED BY THE PLUGIN.
 *
 *   authoritative — the plugin performs the rollout to SCP's declaration (the `scp-runner-*`
 *                   managed classes, where SCP is the executor).
 *   triggerParams — the executor runs its own automation and accepts SCP's declaration as trigger
 *                   parameters.
 *   verified      — the executor owns the rollout entirely; SCP compares DECLARED against the
 *                   OBSERVED state it already reads (`ExecutionStatus.observed.rollout`, ADR-0008)
 *                   and surfaces divergence LOUDLY. It never re-weights anything: no verb here
 *                   promotes, pauses, aborts or re-weights a rollout, and none may be added
 *                   (charter principle 1; ADR-0008 "rollout state is OBSERVED, NOT DRIVEN").
 *
 * The point of putting this on the CAPABILITY DECLARATION rather than in a server-side table keyed
 * by executor kind is D12's own rule: the authority split is READ FROM THE BINDING, never assumed
 * per executor kind. Two Argo CD instances can be bound with different rollout arrangements, and a
 * hardcoded "argocd means verified" would be wrong for one of them with no way to say so.
 */
export type RolloutAuthority = "authoritative" | "triggerParams" | "verified";

/**
 * MUST stay identical to `RolloutTargetClassSchema` in `@scp/schemas/pipeline-behaviors` — which is
 * itself now a DERIVED NARROWING of `InfraKindSchema` (D24), not a hand-written list; this copy
 * stays hand-written string literals regardless, for the reason below.
 *
 * Kept as a self-contained string union here for the same reason `DependencyIndexEcosystem` and
 * `DiscoveryProposal.sourceMappings[].type` are: `@scp/plugin-api` stays free of a `@scp/schemas`
 * dependency, and that boundary is worth more than enum non-duplication. But read the warning on
 * `DependencyIndexEcosystem` before treating a third copy as harmless — the first two copies of the
 * ecosystem vocabulary DID drift (`image` vs `oci`), precisely because no test crossed the
 * boundary. So this copy is pinned against the Zod enum at runtime by a total-`Record` test whose
 * keys this union generates, exactly as that one is: a value added on one side and not the other is
 * then a compile error rather than a silently misrouted rollout.
 *
 * RENAMED `"kubernetes"` → `"cluster"` (team-pipeline-IaC D24, this session): the canonical
 * `InfraKindSchema` names this member after the product KIND (matching `instanceGroup`/`database`/
 * `bucket`/`queue`), not the technology backing it. See `InfraKindSchema`'s doc comment in
 * `@scp/schemas/pipeline-behaviors` for the full reconciliation between D24's `Cluster` prose name
 * and this repo's `kubernetes` precedent.
 */
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

/**
 * A recurring probe the executor should hold until told otherwise (team-pipeline-iac D11, owner
 * decision 2026-08-28: outposts run the probes).
 *
 * `cadenceSeconds` is the SCHEDULE THE EXECUTOR OWNS. SCP does not tick it — the three places that
 * say so (`ManifestContinuousHookSchema`, `pipelineHooks.everySeconds`, migration 0096) are
 * unchanged by this: SCP declares the cadence once and the executor's own scheduler runs it. That
 * is the difference between this and `trigger`, which invokes exactly one run.
 */
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
  /**
   * Declare a RECURRING automation the executor holds until retracted. OPTIONAL — the four verbs
   * above stay the closed set every executor implements (ADR-0032 §9); this is additive, so every
   * existing plugin is unchanged and simply declares no schedule capability.
   *
   * STILL COORDINATION, NOT EXECUTION. It hands the executor a declaration naming the executor's
   * OWN automation and the cadence to run it at — the same shape `trigger` uses, differing only in
   * "once" versus "until told otherwise". It composes no command, supplies no script, and cannot
   * make the executor do anything it was not already able to do.
   *
   * IDEMPOTENT BY `scheduleId`: re-declaring the same id updates in place. The driver re-declares
   * every tick, so a schedule an operator deleted out-of-band is restored rather than silently
   * absent — which is what "until they hear otherwise" has to mean to be worth anything.
   */
  ensureSchedule?(ctx: PluginContext, spec: ScheduleSpec): Promise<void>;
  /** Retract a schedule declared by `ensureSchedule`. A no-op for an id that is not there — a
   *  retraction for a schedule already gone is ordinary, not an error. */
  removeSchedule?(ctx: PluginContext, scheduleId: string): Promise<void>;
}

// -------------------------------------------------------------------------------------------
// ControlPlugin (DESIGN.md §10.2) — M4 implements; contract shape fixed now.
// -------------------------------------------------------------------------------------------

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

/**
 * THE MEMBERSHIP EDGE A DISCOVERY PLUGIN EMITS IS `contains`, POINTING SERVICE -> COMPONENT.
 *
 * Read this before writing `part_of` — it is the intuitive spelling, all three in-tree git plugins
 * shipped it, and it has never once landed a row.
 *
 * `docs/proposals/service-component-model.md` §2 considered `component --part_of--> service` and
 * REJECTED it; the owner accepted `contains` (decision 1), and it landed as migration `0021`.
 * `part_of` is registered by no migration, so `POST /discovery/accept` answered every proposal
 * carrying one with `404 relationship type 'part_of' is not registered` — the whole discovery
 * relationship channel, dead from the day it was written, behind a green suite (every end-to-end
 * discovery test sent `relationships: []` at the accept step).
 *
 * The direction is FORCED, not stylistic. Cardinality `one_to_many` constrains the *to* side to one
 * live incoming edge, which is exactly "each component has at most one service"; migration 0022's
 * partial unique index on `(org_id, to_id)` enforces the same thing at the database. Reverse the
 * edge and both mean the opposite. And `contains` is what the engine actually walks —
 * `graph/containment.ts` route 2 walks it BACKWARDS to reach a component's service, which is what
 * puts a service on the containment chain that policy scope, RBAC scope expansion, domain
 * inheritance and pipeline resolution are all derived from. An edge of any other name is a row no
 * consumer reads: an import that returns 201 and leaves the component governed by nothing.
 *
 * `service -> assembly -> component` is legal too (migration `0055`): `contains` accepts
 * `{service, assembly} -> {assembly, component}`, so a plugin that learns to propose the middle rung
 * needs no new edge type.
 */
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
    /** The routing Type (ADR-0007). Closed set: image|rpm|deb|npm|maven|python|go|chart|vm-image|
     *  infrastructure|configuration (the build family grew by 5 members — D13/D24, team-pipeline-IaC
     *  rework). Omitted ⇒ the server default ('configuration'). Kept as a self-contained string-union
     *  here so `@scp/plugin-api` stays free of a `@scp/schemas` dependency — MUST stay identical to
     *  `ExecutorTypeSchema` in `@scp/schemas/executors`, same discipline as `RolloutTargetClass`
     *  above, though (unlike that one) this copy has no cross-package pinning test today. */
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

// -------------------------------------------------------------------------------------------
// DependencyIndexPlugin (M21.4, ADR-0032 §7) — "a daily self-rescheduling tick resolving versions
// through per-ecosystem INDEX PLUGINS, so the existing egress guard and host allowlist apply".
//
// WHY THIS IS A PLUGIN AT ALL, rather than a `fetch()` in the server. The registry URL an operator
// points this at is CONFIGURABLE (a mirror, an Artifactory/Nexus proxy, an in-cluster Athens), and
// the plugin host is the ONE seam that applies `egress-guard.ts`'s post-DNS internal-IP deny-list
// and the per-instance `allowedHosts` allowlist to such a URL (plugin-host/contract.ts's
// `allowedHosts`/`allowInternalEgress` doc comments). A server-side fetch would reach the same
// registries with none of that, which is the SSRF exposure MAJOR #6 closed for every other
// network-calling plugin.
//
// WHAT AN INDEX PLUGIN MUST NEVER DO (ADR-0032 §7, and the reason `listVersions` returns versions
// rather than a verdict): it does not decide which version is "newest", does not order strings, and
// does not skip or invent anything. It REPORTS what the index says, verbatim, or reports that it
// could not ask. Ranking happens in exactly one place server-side
// (`apps/server/src/dependencies/version-index.ts`), over `@scp/dependency-manifests`'s single
// `parseComparableVersion`/`compareVersions` pair — a rule enforced in five plugins is a rule with
// five places to regress.
// -------------------------------------------------------------------------------------------

/** MUST stay identical to `DependencyEcosystemSchema` in `@scp/schemas/dependencies` and to
 *  `DependencyEcosystem` in `@scp/dependency-manifests`. Kept as a self-contained string union here
 *  for the same reason `DiscoveryProposal.sourceMappings[].type` is: `@scp/plugin-api` stays free of
 *  a `@scp/schemas` dependency. That is a THIRD copy of one vocabulary, and the first two drifted
 *  already (`image` vs `oci`) precisely because no test crossed the boundary — so this copy is
 *  pinned against the Zod enum at runtime by "the ecosystem vocabulary is the same list on all
 *  THREE sides" in `apps/server/src/dependencies/version-index.test.ts`, via the total
 *  `INDEX_MODULE_BY_ECOSYSTEM` record whose keys this type generates. */
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

/**
 * WHY AN EXPLICIT `unavailable` EXISTS AT ALL, and why it is not an empty list.
 *
 * "The index said this coordinate has no versions" and "I could not reach an index" produce
 * identical downstream behaviour — no bump — and mean opposite things. Collapsing them makes an
 * air-gapped deployment (where four of the five ecosystems have no reachable index by design) look
 * exactly like an estate that is fully up to date, which would silently stop every dependency
 * subscription with nothing to read (ADR-0032 §7, charter principle 5). Every failure below is a
 * distinct, operator-legible reason for that state.
 */
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

// -------------------------------------------------------------------------------------------
// Plugin manifest (DESIGN.md §11) — every plugin is an npm package declaring this shape. Config
// schemas auto-surface as validated config forms in API/CLI/UI; distribution is compile-time
// only (bundled into the server image) — no runtime hot-loading, ever.
// -------------------------------------------------------------------------------------------

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
  /** JSON Schema validating this plugin instance's `config`. */
  configSchema: Record<string, unknown>;
  requiredCapabilities?: string[];
}
