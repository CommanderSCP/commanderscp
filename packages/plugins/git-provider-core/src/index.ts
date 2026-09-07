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

/** The provider-neutral machinery every git adapter shares. See docs/plugins.md §81. */

// Correlation-hint normalization — a git provider observes activity. See docs/plugins.md §82.

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
  /** The fully-qualified git ref this event is on. See docs/plugins.md §83. */
  ref?: string;
  /** The SOURCE branch of a pull/merge request, fully qualified. See docs/plugins.md §84. */
  headRef?: string;
  correlationKey?: string;
}

// Base-URL resolution, and its provider-neutral precedence. See docs/plugins.md §85.

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

// Idempotency / run-correlation dedup cache. See docs/plugins.md §86.

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

// GitProviderAdapter — the per-provider seam. See docs/plugins.md §87.

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

  /** Read one file's text at a ref, plus the resolved commit. See docs/plugins.md §88. */
  readFileAtRef(ctx: PluginContext, request: ReadFileAtRefRequest): Promise<ReadFileAtRefResult>;

  /** Bounded multi-file/tree read (team-pipeline-iac proposal §12). See docs/plugins.md §89. */
  readFilesAtRef(ctx: PluginContext, request: ReadTreeAtRefRequest): Promise<ReadTreeAtRefResult>;
}

// Factory — assembles the provider-neutral ExecutorPlugin around an adapter.

async function observe(
  adapter: GitProviderAdapter,
  ctx: PluginContext,
  since?: Cursor
): Promise<ExecutorEvent[]> {
  // Observe cursor protocol. See docs/plugins.md §90.
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
    // Own-key lookups, so a prototype name cannot answer. See docs/plugins.md §91.
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

/** Assembles the four-verb `ExecutorPlugin` around an adapter. See docs/plugins.md §92. */
export function createExecutorPluginFromAdapter(adapter: GitProviderAdapter): ExecutorPlugin {
  return {
    observe: (ctx, since) => observe(adapter, ctx, since),
    trigger: (ctx, intent) => trigger(adapter, ctx, intent),
    status: (ctx, ref) => adapter.getStatus(ctx, ref),
    abort: (ctx, ref) => adapter.abortRun(ctx, ref),
    describeCapabilities: () => adapter.capabilities()
  };
}
