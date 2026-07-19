import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
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
  commitSha?: string;
  /** OCI/package artifact digest (e.g. `sha256:…`) for a package/image-push event — the correlation
   *  key the registry story matches a promoted artifact on (ADR-0013). Optional and additive: the
   *  github adapter never populates it (github's observe surfaces commits + workflow runs only); the
   *  gitea adapter's package-push observe path is the first to set it (M15.1b). */
  artifactDigest?: string;
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
    commitSha: hint.commitSha,
    artifactDigest: hint.artifactDigest,
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

let inMemoryState: DedupState = { keys: {} };

export async function loadDedupState(statePath: string | undefined): Promise<DedupState> {
  if (!statePath) return inMemoryState;
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as DedupState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { keys: {} };
    throw err;
  }
}

export async function saveDedupState(
  statePath: string | undefined,
  state: DedupState
): Promise<void> {
  if (!statePath) {
    inMemoryState = state;
    return;
  }
  await mkdir(dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state), "utf8");
  await rename(tmpPath, statePath);
}

/** Test-only: reset the process-wide in-memory dedup map so a unit test never sees another test's
 *  cached keys. The GitHub plugin's own suite never needs this (it uses fresh idempotencyKeys /
 *  file-backed state per test); it exists for the core's own unit tests. */
export function __resetInMemoryDedupState(): void {
  inMemoryState = { keys: {} };
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
// `authorize`, `baseUrl`, `verifyWebhook`, `mapEvent`, `mapStatusToPhase`) are the rest of the
// provider contract: `authorize`/`baseUrl` back the adapter's own REST calls; `verifyWebhook`/
// `mapEvent` back the server-side webhook ingest path; `mapStatusToPhase` backs `getStatus`;
// `sourceKind` is the provider identity used in discovery/source-mapping. They live on one cohesive
// adapter object so a new provider (Gitea) is a single, self-contained implementation.
// -------------------------------------------------------------------------------------------

export interface GitProviderAdapter {
  /** Provider identity literal (e.g. `"github"`, `"gitea"`) — the `source_kind` a discovered
   *  source mapping carries. */
  readonly sourceKind: string;

  /** Request headers (typically a bearer token + accept/content-type) for the adapter's own
   *  authenticated REST calls. */
  authorize(ctx: PluginContext): Promise<Record<string, string>>;

  /** Base REST URL for the adapter's own calls. */
  baseUrl(ctx: PluginContext): string;

  /** Where the dedup cache persists for this instance (undefined = process-in-memory). */
  resolveStatePath(ctx: PluginContext): string | undefined;

  /** Fire the provider's OWN defined automation (never an execute/deploy primitive) and return a
   *  run ref — INCLUDING any provider-specific run-correlation step (e.g. GitHub's dispatch-returns-
   *  204-then-poll-the-runs-list dance). Only ever called for a genuinely new idempotency key. */
  triggerCI(ctx: PluginContext, intent: TriggerIntent): Promise<ExternalRunRef>;

  /** Poll recent commits (push-equivalent) since `sinceIso`, as `ExecutorEvent[]`. */
  pollCommits(ctx: PluginContext, sinceIso?: string): Promise<ExecutorEvent[]>;

  /** Poll recent CI runs since `sinceIso`, as `ExecutorEvent[]`. */
  pollRuns(ctx: PluginContext, sinceIso?: string): Promise<ExecutorEvent[]>;

  /** Status of a previously-triggered run ref. */
  getStatus(ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus>;

  /** Abort a previously-triggered run ref. */
  abortRun(ctx: PluginContext, ref: ExternalRunRef): Promise<AbortResult>;

  /** Executor capabilities (incl. the provider's `triggerKinds`). */
  capabilities(): ExecutorCapabilities;

  /** Verify a webhook delivery's signature against the raw request body (fail-closed). */
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean;

  /** Map a provider webhook event name + payload to a correlation hint (null = ignore). */
  mapEvent(eventName: string, payload: unknown): GitProviderEventHint | null;

  /** Map the provider's native run status/conclusion to a normalized `ExecutionPhase`. */
  mapStatusToPhase(status: string, conclusion: string | null): ExecutionPhase;
}

// -------------------------------------------------------------------------------------------
// Factory — assembles the provider-neutral ExecutorPlugin around an adapter.
// -------------------------------------------------------------------------------------------

async function observe(
  adapter: GitProviderAdapter,
  ctx: PluginContext,
  since?: Cursor
): Promise<ExecutorEvent[]> {
  // Observe cursor protocol: an opaque ISO-8601 watermark in `since.token`. The core owns the
  // protocol; the adapter interprets the watermark for each resource it polls.
  const sinceIso = since?.token;
  const commits = await adapter.pollCommits(ctx, sinceIso);
  const runs = await adapter.pollRuns(ctx, sinceIso);
  return [...commits, ...runs];
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

export function createExecutorPluginFromAdapter(adapter: GitProviderAdapter): ExecutorPlugin {
  return {
    observe: (ctx, since) => observe(adapter, ctx, since),
    trigger: (ctx, intent) => trigger(adapter, ctx, intent),
    status: (ctx, ref) => adapter.getStatus(ctx, ref),
    abort: (ctx, ref) => adapter.abortRun(ctx, ref),
    describeCapabilities: () => adapter.capabilities()
  };
}
