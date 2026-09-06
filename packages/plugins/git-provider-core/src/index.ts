import { randomUUID } from "node:crypto";
import { createFileBackedJsonCache } from "@scp/plugin-api";
import type {
  AbortResult,
  Cursor,
  ExecutionPhase,
  ExecutionStatus,
  ExecutorCapabilities,
  ExecutorEvent,
  ExecutorEventCorrelation,
  ExecutorPlugin,
  ExternalRunRef,
  PluginContext,
  TriggerIntent
} from "@scp/plugin-api";
import type { ReadFileAtRefRequest, ReadFileAtRefResult } from "./read-file.js";
import type { ReadTreeAtRefRequest, ReadTreeAtRefResult } from "./read-tree.js";

/** The read-a-file-at-a-ref capability (M21.2, ADR-0032 §4) — its vocabulary, decode bound and
 *  failure classifiers live in `read-file.ts` and are re-exported here so `@scp/git-provider-core`
 *  keeps a single entry point (`package.json` main = `dist/index.js`). */
export * from "./read-file.js";

/** The bounded multi-file/tree read capability (team-pipeline-iac proposal §12) — its vocabulary,
 *  bounds and typed bound-exceeded error live in `read-tree.ts`, re-exported here for the same
 *  single-entry-point reason. */
export * from "./read-tree.js";

/**
 * `@scp/git-provider-core` — the **provider-neutral** machinery shared by every git-provider
 * `ExecutorPlugin` (GitHub today, Gitea next — M15.1a, ADR-0014). This is an internal library, NOT
 * a loadable plugin module: it exposes the `GitProviderAdapter` interface plus a factory that
 * assembles a full `ExecutorPlugin` (observe/trigger/status/abort/describeCapabilities) from a
 * given adapter. Everything wire-format-specific to a provider (auth, base URL + REST wrapper, the
 * CI-trigger calls, webhook signature verification, event-name→hint mapping, the status/conclusion
 * →phase map, the `source_kind` literal) lives in the per-provider adapter; everything provider-
 * neutral (the idempotency/dedup cache, correlation-hint normalization, the observe cursor
 * protocol, the dispatch-then-persist trigger dance, the ExecutorPlugin assembly) lives here.
 *
 * The idempotency design this core owns is the one the GitHub plugin documented and
 * `coordination/reconcile.ts`'s crash-safe retry depends on: `trigger()` dedups on the
 * `idempotencyKey` FIRST, against its own persisted cache — so a retry of the SAME logical attempt
 * never fires the provider automation twice — and only a genuinely NEW key delegates to the
 * adapter's `triggerCI` (which does the provider's own dispatch + any provider-specific run
 * correlation). The cache is file-backed when `adapter.resolveStatePath(ctx)` returns a path (same
 * write-to-temp+rename pattern as the fake/argocd executors) and process-in-memory otherwise.
 */

// -------------------------------------------------------------------------------------------
// Correlation-hint normalization — a git provider observes activity (push/PR/run/deploy/release)
// and emits a small, uniform `hint`; this turns that hint into the `ExecutorEventCorrelation` the
// host matches against `source_mappings` (DESIGN §9.2). Provider-neutral: the hint SHAPE is shared;
// only how each provider POPULATES it (event-name mapping) is provider-specific (adapter.mapEvent).
// -------------------------------------------------------------------------------------------

export interface GitProviderEventHint {
  repo?: string;
  path?: string;
  /** Every path the event touched — see `ExecutorEventCorrelation.paths` (`@scp/plugin-api`) for
   *  why the singular `path` cannot carry a commit's changed-file set, and what depends on this. */
  paths?: string[];
  commitSha?: string;
  /** OCI/package artifact digest (e.g. `sha256:…`) for a package/image-push event — the correlation
   *  key the registry story matches a promoted artifact on (ADR-0013). Optional and additive: the
   *  github adapter never populates it (github's observe surfaces commits + workflow runs only); the
   *  gitea adapter's package-push observe path is the first to set it (M15.1b). */
  artifactDigest?: string;
  /**
   * The fully-qualified git REF this event is on (`refs/heads/dev`) — what a `refPattern` source
   * mapping matches against (ADR-0030 §1), and the field that makes "the dev branch drives the dev
   * pipeline" expressible.
   *
   * Carried EXPLICITLY rather than parsed back out of `correlationKey`, even though a push event's
   * correlation key is usually the ref today. The key is a grouping identity whose composition is
   * the host's business — a package push folds the artifact digest into it, so reading a ref out of
   * it would be right for some events and quietly wrong for others. An adapter that knows the ref
   * sets this; one that doesn't leaves it undefined and no ref-scoped mapping can match its events.
   */
  ref?: string;
  /**
   * The SOURCE branch of a pull/merge request, fully qualified (`refs/heads/scp/dep-bump/<id>`) —
   * deliberately SEPARATE from {@link ref} and deliberately not used for source-mapping routing.
   *
   * A pull request is an event about a PROPOSAL to move code between two branches; the ref the
   * routing question is about is its BASE, and the field a `refPattern` mapping matches is
   * {@link ref}, which a pull-request event correctly leaves unset. But "which branch is this pull
   * request FROM?" is a real fact the payload carries, and one consumer needs it: M21.5's
   * provenance loop, which recognises a bump CommanderSCP authored by the branch it is on and then
   * requires SCP's own record to name that same branch and repository (ADR-0032 §9).
   *
   * Without it, a `pull_request` action=opened delivery processed BEFORE the authored push (the
   * ordering is the provider's, not ours) named no branch and no yet-recorded commit, matched the
   * component's ordinary source mapping, and minted the second unrelated change §9 exists to
   * prevent.
   *
   * Adding it to {@link ref} instead would have been the smaller diff and the wrong one: every
   * ref-scoped source mapping in every existing deployment would have started matching pull-request
   * events by their head branch, silently re-routing releases.
   */
  headRef?: string;
  correlationKey?: string;
}

// -------------------------------------------------------------------------------------------
// Base-URL resolution — provider-neutral precedence for an adapter's REST base URL (M15.3b). A
// git-provider adapter's base URL can come from three places, in order: (1) the adapter's OWN
// explicit config field (github's `apiBaseUrl`, gitea's `baseUrl`) — a deliberate per-binding
// override; (2) the execution-system's injected `config.serverUrl` — how a Mode-A "import an
// EXISTING provider" binding tells the adapter where that provider lives (executor-bindings-repo
// injects it; discovery/run injects it too); (3) a provider default (github's `api.github.com`;
// gitea has none). This helper owns ONLY the precedence + trailing-slash trim; each adapter keeps
// its own field names and its own "neither was set" error message (gitea throws, github defaults),
// so the provider-neutral core gains no provider-specific knowledge.
// -------------------------------------------------------------------------------------------

export interface ResolveBaseUrlInput {
  /** The adapter's own explicit base-URL config field, if the binding set it (highest precedence). */
  explicit?: string;
  /** The execution-system's injected base URL (`config.serverUrl`) — the Mode-A import path. */
  serverUrl?: string;
  /** Provider default used only when neither of the above is set (github: api.github.com; gitea: none). */
  fallback?: string;
}

/** Resolves an adapter REST base URL by precedence (explicit → serverUrl → fallback) and trims a
 *  trailing slash. Returns `undefined` when none of the three is set — the caller decides whether
 *  that is an error (gitea: throw) or impossible (github: always passes a fallback). */
export function resolveProviderBaseUrl(input: ResolveBaseUrlInput): string | undefined {
  const resolved = input.explicit ?? input.serverUrl ?? input.fallback;
  return resolved ? resolved.replace(/\/$/, "") : undefined;
}

export function normalizeCorrelation(hint: GitProviderEventHint): ExecutorEventCorrelation {
  return {
    repo: hint.repo,
    path: hint.path,
    paths: hint.paths,
    commitSha: hint.commitSha,
    artifactDigest: hint.artifactDigest,
    // This one line is what gives ref-scoped routing poll-vs-push equivalence (DESIGN §12): the
    // adapter's `mapEvent` backs BOTH the server's webhook ingest and the plugin's own polling
    // `observe()`, and this function is the observe half. Dropping `ref` here would leave a
    // ref-scoped mapping working for delivered webhooks and silently inert for polled ones.
    ref: hint.ref,
    correlationKey: hint.correlationKey
  };
}

// -------------------------------------------------------------------------------------------
// Idempotency / run-correlation dedup cache — see module doc. File-backed (crash-safe) when a
// state path is given, otherwise a single process-wide in-memory map (identical scoping to what the
// GitHub plugin had before this extraction: one map per Node process = per subprocess plugin
// instance).
// -------------------------------------------------------------------------------------------

export interface DedupRecord {
  externalId: string;
  url?: string;
}

export interface DedupState {
  keys: Record<string, DedupRecord>;
}

const dedupCacheImpl = createFileBackedJsonCache<DedupState>(() => ({ keys: {} }));

export async function loadDedupState(statePath: string | undefined): Promise<DedupState> {
  return dedupCacheImpl.load(statePath);
}

export async function saveDedupState(
  statePath: string | undefined,
  state: DedupState
): Promise<void> {
  return dedupCacheImpl.save(statePath, state);
}

/** Test-only: reset the process-wide in-memory dedup map so a unit test never sees another test's
 *  cached keys. The GitHub plugin's own suite never needs this (it uses fresh idempotencyKeys /
 *  file-backed state per test); it exists for the core's own unit tests. */
export function __resetInMemoryDedupState(): void {
  dedupCacheImpl.reset();
}

export function dedupCacheKey(intent: TriggerIntent): string {
  // Falls back to a fresh random key when the caller omitted one, so two un-keyed calls never
  // collide — matches `@scp/plugin-fake-executor`'s "no key => always a fresh run" semantics.
  return intent.idempotencyKey ?? randomUUID();
}

// -------------------------------------------------------------------------------------------
// GitProviderAdapter — the per-provider seam. Everything below is provider-SPECIFIC and supplied by
// the adapter; the factory (createExecutorPluginFromAdapter) supplies everything provider-NEUTRAL.
//
// Which hooks the executor factory itself calls: `resolveStatePath`, `triggerCI`, `pollCommits`,
// `pollRuns`, `getStatus`, `abortRun`, `capabilities`. The remaining hooks (`sourceKind`,
// `authorize`, `baseUrl`, `verifyWebhook`, `mapEvent`, `mapStatusToPhase`, `readFileAtRef`) are the
// rest of the provider contract: `authorize`/`baseUrl` back the adapter's own REST calls;
// `verifyWebhook`/`mapEvent` back the server-side webhook ingest path; `mapStatusToPhase` backs
// `getStatus`; `sourceKind` is the provider identity used in discovery/source-mapping;
// `readFileAtRef` backs ADR-0032's manifest ingestion. They live on one cohesive adapter object so a
// new provider (Gitea) is a single, self-contained implementation.
// -------------------------------------------------------------------------------------------

export interface GitProviderAdapter {
  /** Provider identity literal (e.g. `"github"`, `"gitea"`) — the `source_kind` a discovered
   *  source mapping carries. */
  readonly sourceKind: string;

  /** Request headers (typically a bearer token + accept/content-type) for the adapter's own
   *  authenticated REST calls. */
  authorize(ctx: PluginContext): Promise<Record<string, string>>;

  baseUrl(ctx: PluginContext): string;

  /** Where the dedup cache persists for this instance (undefined = process-in-memory). */
  resolveStatePath(ctx: PluginContext): string | undefined;

  /** Fire the provider's OWN defined automation (never an execute/deploy primitive) and return a
   *  run ref — INCLUDING any provider-specific run-correlation step (e.g. GitHub's dispatch-returns-
   *  204-then-poll-the-runs-list dance). Only ever called for a genuinely new idempotency key. */
  triggerCI(ctx: PluginContext, intent: TriggerIntent): Promise<ExternalRunRef>;

  pollCommits(ctx: PluginContext, sinceIso?: string): Promise<ExecutorEvent[]>;

  pollRuns(ctx: PluginContext, sinceIso?: string): Promise<ExecutorEvent[]>;

  getStatus(ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus>;

  abortRun(ctx: PluginContext, ref: ExternalRunRef): Promise<AbortResult>;

  capabilities(): ExecutorCapabilities;

  /** Verify a webhook delivery's signature against the raw request body (fail-closed). */
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean;

  /** Map a provider webhook event name + payload to a correlation hint (null = ignore). */
  mapEvent(eventName: string, payload: unknown): GitProviderEventHint | null;

  /** Map the provider's native run status/conclusion to a normalized `ExecutionPhase`. */
  mapStatusToPhase(status: string, conclusion: string | null): ExecutionPhase;

  /**
   * Read ONE file's decoded text at a git ref, plus the commit sha that ref resolved to (M21.2,
   * ADR-0032 §4 / proposal §4.3(a) — the declared-manifest ingress the dependency inventory is built
   * from). Returns a `not_found` result for a missing file/ref (routine — most components declare
   * only one or two of the five ecosystems' manifests) and a `refused` result for a file that exists
   * but will not be decoded (too large, not a blob, not text). Genuine failures — auth, 5xx, a
   * refused redirect, an egress-guard denial — THROW, already classified by `read-file.ts`'s
   * `wrapProviderRequestError`/`assertNoRedirect`.
   *
   * An adversarial `repo`/`path`/`ref` also THROWS, before any HTTP happens: every implementer MUST
   * call `assertSafeRepo`/`assertSafeRepoPath`/`assertSafeRef` first. That is a hard requirement,
   * not a suggestion — all three are spliced into a REST route, and percent-encoding does not close
   * a `..` segment (`encodeURIComponent("..") === ".."`), so without the asserts a caller re-targets
   * the request at a different endpoint using the binding's own credentials (M21.2 review). A THROW
   * rather than a `refused` result is deliberate: that is a caller bug, not a fact about the repo.
   *
   * REQUIRED, not optional, on purpose: every implementer lives in this monorepo (github, gitea,
   * gitlab, plus the core's own test fake), so a required hook makes a fourth provider's omission a
   * compile error instead of a silently empty dependency inventory for that provider's components.
   *
   * NOT AN EXECUTOR VERB (ADR-0032 §9, charter principle 1). `createExecutorPluginFromAdapter` does
   * not surface it: `ExecutorPlugin` stays exactly observe/trigger/status/abort, which is what
   * structurally enforces "coordination, not execution". This hook reads; it can never write.
   */
  readFileAtRef(ctx: PluginContext, request: ReadFileAtRefRequest): Promise<ReadFileAtRefResult>;

  /**
   * Bounded multi-file/tree read (team-pipeline-iac proposal §12): given a repo, a ref and one or
   * more path globs, lists matching paths and reads them, bounded on every axis (`read-tree.ts`'s
   * module doc). Same NOT-AN-EXECUTOR-VERB posture as {@link readFileAtRef} — read-only, never
   * surfaced by `createExecutorPluginFromAdapter`.
   *
   * REQUIRED, not optional, for the same reason `readFileAtRef` is required: every implementer
   * lives in this monorepo, so a required hook makes a fourth provider's omission a compile error
   * instead of a silently-unavailable capability for that provider.
   */
  readFilesAtRef(ctx: PluginContext, request: ReadTreeAtRefRequest): Promise<ReadTreeAtRefResult>;
}

// Factory — assembles the provider-neutral ExecutorPlugin around an adapter.

async function observe(
  adapter: GitProviderAdapter,
  ctx: PluginContext,
  since?: Cursor
): Promise<ExecutorEvent[]> {
  // Observe cursor protocol: an ISO-8601 watermark PER EVENT KIND, JSON-encoded in `since.token`
  // (a bare ISO string is the legacy form and applies to every kind). The core owns the protocol;
  // the adapter interprets the watermark for each resource it polls.
  //
  // The two resources below MUST resume from separate watermarks. They have different time bases —
  // a commit is stamped with its author date, a workflow run with its creation time — and a CI run
  // is always created AFTER the commit that triggered it. Sharing one watermark therefore let a run
  // drag the cursor past its own commit, and the next `?since=` query skipped that commit for good.
  // See `apps/server/src/coordination/observe.ts` for the measured case.
  const commits = await adapter.pollCommits(ctx, watermarkForKind(since?.token, "push"));
  const runs = await adapter.pollRuns(ctx, watermarkForKind(since?.token, "workflow_run"));
  return [...commits, ...runs];
}

/** Own-property read — see the comment inside {@link watermarkForKind}. */
function ownKey(source: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

/** The watermark one event kind should resume from: its own, else the legacy scalar, else none. */
export function watermarkForKind(token: string | undefined, kind: string): string | undefined {
  if (!token) return undefined;
  const trimmed = token.trim();
  // Legacy scalar — applies to every kind, but only if it is actually a timestamp. Anything else is
  // corruption and would otherwise reach the provider as a nonsense `?since=` query parameter.
  if (!trimmed.startsWith("{")) {
    return Number.isNaN(new Date(trimmed).getTime()) ? undefined : trimmed;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const marks = parsed as Record<string, unknown>;
    // Own-key lookups. `marks[kind]` for a `kind` of `"__proto__"`, `"constructor"`, `"toString"`,
    // … reads an INHERITED member of `Object.prototype` rather than a watermark. Today the
    // `typeof === "string"` guards below happen to reject every such member, so this is hardening
    // rather than a live bug — but the guard is what makes it safe, not the lookup, and the twin of
    // this function in `apps/server/src/coordination/observe.ts` had no such guard and WAS broken
    // (a `__proto__`-kind event froze its cursor permanently). Same property, so same fix.
    const own = ownKey(marks, kind);
    if (typeof own === "string" && own.length > 0) return own;
    const legacy = ownKey(marks, "_legacy");
    return typeof legacy === "string" && legacy.length > 0 ? legacy : undefined;
  } catch {
    // Unparseable cursor ⇒ poll from the beginning rather than throw. Re-polling is safe: the
    // server's dedupe collapses anything already ingested.
    return undefined;
  }
}

async function trigger(
  adapter: GitProviderAdapter,
  ctx: PluginContext,
  intent: TriggerIntent
): Promise<ExternalRunRef> {
  // Dedup FIRST — a retry of the same logical attempt returns the cached ref without firing the
  // provider automation a second time (the crash-safe-retry guarantee reconcile.ts relies on).
  const cacheKey = dedupCacheKey(intent);
  const statePath = adapter.resolveStatePath(ctx);
  const state = await loadDedupState(statePath);
  const existing = state.keys[cacheKey];
  if (existing) {
    return { externalId: existing.externalId, url: existing.url };
  }

  const ref = await adapter.triggerCI(ctx, intent);
  state.keys[cacheKey] = { externalId: ref.externalId, url: ref.url };
  await saveDedupState(statePath, state);
  return ref;
}

/**
 * Assembles the four-verb `ExecutorPlugin` around an adapter.
 *
 * `adapter.readFileAtRef` is deliberately NOT surfaced here (ADR-0032 §9): the four verbs are the
 * structural enforcement of charter principle 1, and a fifth entry on this object would be a fifth
 * verb in everything downstream that consumes an `ExecutorPlugin`. Callers that need to read a
 * manifest hold the ADAPTER — the same way `apps/server/src/coordination/webhook-adapters.ts`
 * already holds `githubAdapter`/`giteaAdapter`/`gitlabAdapter` for `verifyWebhook`/`mapEvent`.
 */
export function createExecutorPluginFromAdapter(adapter: GitProviderAdapter): ExecutorPlugin {
  return {
    observe: (ctx, since) => observe(adapter, ctx, since),
    trigger: (ctx, intent) => trigger(adapter, ctx, intent),
    status: (ctx, ref) => adapter.getStatus(ctx, ref),
    abort: (ctx, ref) => adapter.abortRun(ctx, ref),
    describeCapabilities: () => adapter.capabilities()
  };
}
