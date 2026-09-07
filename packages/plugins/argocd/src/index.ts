import { randomUUID } from "node:crypto";
import { createFileBackedJsonCache } from "@scp/plugin-api";
import type {
  AbortResult,
  Cursor,
  DiscoveryPlugin,
  DiscoveryProposal,
  ExecutionPhase,
  ExecutionStatus,
  ExecutorCapabilities,
  ExecutorEvent,
  ExecutorPlugin,
  ExternalRunRef,
  PluginContext,
  PluginManifest,
  TriggerIntent
} from "@scp/plugin-api";

/** `@scp/plugin-argocd` — the ArgoCD `ExecutorPlugin`. See docs/plugins.md §21. */

export interface ArgoCdConfig {
  serverUrl: string;
  /** `SecretsAccessor` key holding the ArgoCD API token (a project-scoped or admin token, per the
   *  org's own ArgoCD RBAC) — never embedded directly in config. */
  tokenSecretKey?: string;
  /** Fallback for tests/fixtures only — a plaintext token in config. Real deployments must use
   *  `tokenSecretKey`; this field exists so nock-fixture tests don't need a live SecretsAccessor. */
  token?: string;
  statePath?: string;
  /** DISCOVERY only (M12 P3b): when set, `discover()` also proposes a binding of each imported
   *  component to this execution-system, so `discovery accept` coordinates them in one step. */
  executionSystemId?: string;
}

interface DedupState {
  targets: Record<string, { idempotencyKey?: string; externalId: string }>;
}

const REF_DELIMITER = "::";

function asConfig(config: unknown): ArgoCdConfig {
  const c = config as Partial<ArgoCdConfig> | undefined;
  if (!c?.serverUrl) {
    throw new Error("argocd: config.serverUrl is required");
  }
  return {
    serverUrl: c.serverUrl.replace(/\/$/, ""),
    tokenSecretKey: c.tokenSecretKey,
    token: c.token,
    statePath: c.statePath,
    executionSystemId: c.executionSystemId
  };
}

async function resolveToken(ctx: PluginContext, config: ArgoCdConfig): Promise<string | undefined> {
  if (config.token) return config.token;
  if (config.tokenSecretKey) return ctx.secrets.get(config.tokenSecretKey);
  return undefined;
}

// -----------------------------------------------------------------------------------------
// Dedup cache — see module doc. Mirrors @scp/plugin-fake-executor's persistence shape exactly
// (both call @scp/plugin-api's createFileBackedJsonCache, the shared write-to-temp+rename triad).
// -----------------------------------------------------------------------------------------

const dedupCache = createFileBackedJsonCache<DedupState>(() => ({ targets: {} }));
const loadState = dedupCache.load;
const saveState = dedupCache.save;

function mintExternalId(appName: string): string {
  return `${appName}${REF_DELIMITER}${randomUUID()}`;
}

function parseAppName(externalId: string): string {
  const idx = externalId.lastIndexOf(REF_DELIMITER);
  return idx === -1 ? externalId : externalId.slice(0, idx);
}

/** A rollback with no prior good revision must never sync. See docs/plugins.md §22. */
const ROLLBACK_UNAVAILABLE_PREFIX = `argocd-rollback-unavailable${REF_DELIMITER}`;

// ArgoCD REST shapes (subset — only the fields this plugin reads/sends)

// One managed-resource entry in the application's status. See docs/plugins.md §23.
interface ArgoResourceStatus {
  group?: string;
  version?: string;
  kind?: string;
  namespace?: string;
  name?: string;
  status?: string;
  health?: { status?: string; message?: string };
}

interface ArgoApplication {
  metadata: { name: string; resourceVersion?: string };
  status?: {
    /** `revision` for a SINGLE-source Application; `revisions` (one per source, positional) for a
     *  MULTI-SOURCE one. Argo CD sets exactly one of the two — never both — so any code reading only
     *  the singular field silently sees nothing on a multi-source app. */
    sync?: { status?: string; revision?: string; revisions?: string[] };
    health?: { status?: string };
    operationState?: {
      phase?: string;
      message?: string;
      finishedAt?: string;
      startedAt?: string;
      syncResult?: { revision?: string };
    };
    // ArgoCD populates this on the Application body it already returns from GET /applications and
    // GET /applications/{name}: the deployed image refs (`ghcr.io/x/y:tag` or `...@sha256:...`).
    // Reading it into ExecutionStatus.observed.images is near-free — no extra API call (ADR-0008
    // signal 1, image half).
    summary?: { images?: string[] };
    // The app's managed resources (near-free — same Application body). Scanned for a Rollout node to
    // surface OBSERVE-ONLY rollout phase/message (ADR-0008 signal / P4D increment 4).
    resources?: ArgoResourceStatus[];
    reconciledAt?: string;
  };
}

// The LIVE Argo Rollout manifest's `.status`, as returned (JSON-stringified) by
// GET /api/v1/applications/{name}/resource. Only the OBSERVE-ONLY progressive-delivery fields this
// plugin surfaces — all optional and version-dependent (`canary.weights` is absent on Argo Rollouts
// older than ~v1.1; `currentStepIndex` is absent for non-canary/blue-green). Never fabricated.
interface LiveRolloutStatus {
  phase?: string;
  message?: string;
  currentStepIndex?: number;
  canary?: { weights?: { canary?: { weight?: number } } };
}

async function apiRequest(
  ctx: PluginContext,
  config: ArgoCdConfig,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const token = await resolveToken(ctx, config);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await ctx.http.request({
    method,
    url: `${config.serverUrl}${path}`,
    headers,
    body
  });
  return { status: response.status, body: response.body };
}

/** MAJOR #3 — health -> phase AFTER a sync operation has finished. See docs/plugins.md §24. */
function phaseAfterFinishedSync(health: string | undefined): ExecutionPhase {
  switch (health) {
    case "Healthy":
    case "Suspended":
    case undefined:
      return "succeeded";
    case "Degraded":
    case "Missing":
      return "failed";
    default:
      return "running"; // "Progressing" (still rolling out) or "Unknown" (ambiguous)
  }
}

type ObservedRollout = { phase?: string; step?: number; weight?: number; message?: string };

// Find the app-managed Argo Rollout node in the Application's `status.resources[]` (near-free — it
// rides the Application body status() already fetches). Argo's group for Rollouts is `argoproj.io`.
function findRolloutResource(app: ArgoApplication | undefined): ArgoResourceStatus | undefined {
  return app?.status?.resources?.find((r) => r.kind === "Rollout" && r.group === "argoproj.io");
}

// Near-free OBSERVE-ONLY rollout snapshot from the Rollout node's Argo health assessment: its
// `health.status` (Healthy|Progressing|Degraded|Suspended|Missing|Unknown) is a real phase-ish
// signal and `health.message` a human detail. No extra API call. Omits absent fields; returns
// undefined when neither is present (never fabricates a phase).
function rolloutFromResource(res: ArgoResourceStatus | undefined): ObservedRollout | undefined {
  if (!res) return undefined;
  const rollout: ObservedRollout = {};
  const phase = res.health?.status;
  if (typeof phase === "string" && phase.length > 0) rollout.phase = phase;
  const message = res.health?.message;
  if (typeof message === "string" && message.length > 0) rollout.message = message;
  return rollout.phase !== undefined || rollout.message !== undefined ? rollout : undefined;
}

// Parse the observe-only rollout fields off a live manifest. See docs/plugins.md §25.
function rolloutFromManifest(manifestJson: string): ObservedRollout | undefined {
  let parsed: { status?: LiveRolloutStatus };
  try {
    parsed = JSON.parse(manifestJson) as { status?: LiveRolloutStatus };
  } catch {
    return undefined;
  }
  const s = parsed.status;
  if (!s) return undefined;
  const rollout: ObservedRollout = {};
  if (typeof s.phase === "string" && s.phase.length > 0) rollout.phase = s.phase;
  if (typeof s.message === "string" && s.message.length > 0) rollout.message = s.message;
  if (typeof s.currentStepIndex === "number") rollout.step = s.currentStepIndex;
  const weight = s.canary?.weights?.canary?.weight;
  if (typeof weight === "number") rollout.weight = weight;
  return Object.keys(rollout).length > 0 ? rollout : undefined;
}

// Best-effort fetch of the LIVE Rollout manifest for structured step/weight/phase (option B — a
// per-resource call). OBSERVE-ONLY: a GET that reads the executor's own state; it never drives the
// rollout. Failures (non-2xx, missing/garbage manifest, network) return undefined so the near-free
// phase/message still stands and status() never fails over enrichment.
async function fetchLiveRollout(
  ctx: PluginContext,
  config: ArgoCdConfig,
  appName: string,
  res: ArgoResourceStatus
): Promise<ObservedRollout | undefined> {
  if (!res.name) return undefined;
  const params = new URLSearchParams({
    resourceName: res.name,
    ...(res.namespace ? { namespace: res.namespace } : {}),
    group: res.group ?? "argoproj.io",
    version: res.version ?? "v1alpha1",
    kind: "Rollout"
  });
  try {
    const { status, body } = await apiRequest(
      ctx,
      config,
      "GET",
      `/api/v1/applications/${encodeURIComponent(appName)}/resource?${params.toString()}`
    );
    if (status < 200 || status >= 300) return undefined;
    const manifest = (body as { manifest?: unknown })?.manifest;
    if (typeof manifest !== "string") return undefined;
    return rolloutFromManifest(manifest);
  } catch {
    return undefined;
  }
}

function mapArgoPhase(app: ArgoApplication | undefined): ExecutionStatus {
  const opPhase = app?.status?.operationState?.phase;
  const healthStatus = app?.status?.health?.status;
  const syncStatus = app?.status?.sync?.status;

  let phase: ExecutionPhase;
  if (opPhase === "Running" || opPhase === "Terminating") {
    phase = "running";
  } else if (opPhase === "Failed" || opPhase === "Error") {
    phase = "failed";
  } else if (opPhase === "Succeeded") {
    phase = phaseAfterFinishedSync(healthStatus);
  } else if (!opPhase) {
    // No operation has ever run (or ArgoCD already forgot it) — fall back to sync/health status.
    if (syncStatus === "Synced") {
      phase = phaseAfterFinishedSync(healthStatus);
    } else if (healthStatus === "Degraded" || healthStatus === "Missing") {
      phase = "failed";
    } else {
      phase = "pending";
    }
  } else {
    phase = "pending";
  }

  const settled: boolean = phase !== "pending" && phase !== "running";
  // Deployed image refs straight off the Application body ArgoCD already returned — the REAL
  // images, never fabricated. Omitted (undefined) when Argo reports none, so reconcile never nulls
  // a previously-captured value. Filtered to non-empty strings to keep the observed snapshot clean.
  const images = app?.status?.summary?.images?.filter(
    (img): img is string => typeof img === "string" && img.length > 0
  );
  // Near-free OBSERVE-ONLY rollout snapshot (phase/message) off the Rollout node in resources[] — no
  // extra API call. status() may enrich this with structured step/weight from the live manifest.
  const rollout = rolloutFromResource(findRolloutResource(app));
  const observed: { images?: string[]; rollout?: ObservedRollout } = {};
  if (images && images.length > 0) observed.images = images;
  if (rollout) observed.rollout = rollout;
  return {
    phase,
    detail: `sync=${syncStatus ?? "unknown"} health=${healthStatus ?? "unknown"} op=${opPhase ?? "none"}`,
    stateRef: app?.status?.sync?.revision,
    ...(observed.images || observed.rollout ? { observed } : {}),
    progress: settled ? 1 : 0.5
  };
}

/** The synced revisions as one deterministic dedupe identity. See docs/plugins.md §26. */
function syncStateRef(app: ArgoApplication): string | undefined {
  const single = app.status?.sync?.revision;
  if (single) return single;
  const many = app.status?.sync?.revisions;
  if (!Array.isArray(many)) return undefined;
  const present = many.filter((r): r is string => typeof r === "string" && r.length > 0);
  return present.length > 0 ? present.join("+") : undefined;
}

async function observe(ctx: PluginContext, since?: Cursor): Promise<ExecutorEvent[]> {
  const config = asConfig(ctx.config);
  const sinceTime = since?.token ? new Date(since.token).getTime() : 0;
  const { status, body } = await apiRequest(ctx, config, "GET", "/api/v1/applications");
  if (status < 200 || status >= 300) {
    throw new Error(`argocd observe: server returned HTTP ${status}`);
  }
  const list = body as { items?: ArgoApplication[] };
  const events: ExecutorEvent[] = [];
  for (const app of list.items ?? []) {
    const reconciledAt = app.status?.reconciledAt;
    if (!reconciledAt) continue;
    const occurredAtMs = new Date(reconciledAt).getTime();
    if (Number.isNaN(occurredAtMs) || occurredAtMs <= sinceTime) continue;
    events.push({
      kind: "sync",
      occurredAt: new Date(occurredAtMs).toISOString(),
      correlation: {
        correlationKey: app.metadata.name,
        // The synced revision, which is what makes this dedupable. See docs/plugins.md §27.
        commitSha: app.status?.sync?.revision,
        stateRef: syncStateRef(app),
        labels: { application: app.metadata.name }
      },
      raw: app
    });
  }
  return events;
}

async function trigger(ctx: PluginContext, intent: TriggerIntent): Promise<ExternalRunRef> {
  const config = asConfig(ctx.config);
  const appName = intent.targetRef;
  if (!appName) throw new Error("argocd trigger: intent.targetRef (Application name) is required");

  const state = await loadState(config.statePath);
  const existing = state.targets[appName];
  if (intent.idempotencyKey && existing?.idempotencyKey === intent.idempotencyKey) {
    return { externalId: existing.externalId, url: `${config.serverUrl}/applications/${appName}` };
  }

  // CRITICAL #2 — fail closed on a rollback with no valid prior revision. NEVER fall through to an
  // empty-revision sync (which ArgoCD treats as "sync to the current target revision" — a no-op
  // re-apply of the very revision we're rolling back FROM, reported as success).
  if (intent.kind === "rollback") {
    const priorRevision =
      typeof intent.priorStateRef === "string" && intent.priorStateRef.length > 0
        ? intent.priorStateRef
        : undefined;
    if (!priorRevision) {
      const externalId = `${ROLLBACK_UNAVAILABLE_PREFIX}${appName}`;
      state.targets[appName] = { idempotencyKey: intent.idempotencyKey, externalId };
      await saveState(config.statePath, state);
      ctx.logger.warn(
        "argocd: rollback FAILED CLOSED — no prior known-good revision supplied; refusing to re-sync the current revision",
        { appName }
      );
      return { externalId };
    }
  }

  const revision =
    intent.kind === "rollback"
      ? (intent.priorStateRef as string) // guaranteed a non-empty string by the guard above
      : (intent.parameters?.targetRevision as string | undefined);

  const { status, body } = await apiRequest(
    ctx,
    config,
    "POST",
    `/api/v1/applications/${encodeURIComponent(appName)}/sync`,
    {
      ...(revision ? { revision } : {})
    }
  );
  if (status < 200 || status >= 300) {
    throw new Error(`argocd trigger: sync returned HTTP ${status}`);
  }

  const externalId = mintExternalId(appName);
  state.targets[appName] = { idempotencyKey: intent.idempotencyKey, externalId };
  await saveState(config.statePath, state);

  ctx.logger.info("argocd: sync triggered", { appName, kind: intent.kind, revision });
  void body;
  return { externalId, url: `${config.serverUrl}/applications/${appName}` };
}

async function status(ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus> {
  if (ref.externalId.startsWith(ROLLBACK_UNAVAILABLE_PREFIX)) {
    // CRITICAL #2 — a fail-closed rollback is a terminal failure, not a pending/succeeded run.
    return {
      phase: "failed",
      detail:
        "argocd: rollback unavailable — no prior known-good revision was supplied; refused to re-sync the current revision",
      progress: 1
    };
  }
  const config = asConfig(ctx.config);
  const appName = parseAppName(ref.externalId);
  const { status: httpStatus, body } = await apiRequest(
    ctx,
    config,
    "GET",
    `/api/v1/applications/${encodeURIComponent(appName)}`
  );
  if (httpStatus === 404) {
    return { phase: "pending", detail: `argocd: application '${appName}' not found (yet)` };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new Error(`argocd status: server returned HTTP ${httpStatus}`);
  }
  const app = body as ArgoApplication;
  const result = mapArgoPhase(app);
  // OBSERVE-ONLY progressive-delivery enrichment (ADR-0008: rollout state is OBSERVED, NOT DRIVEN).
  // When the app manages an Argo Rollout, fetch the LIVE Rollout manifest for structured
  // step/weight/phase and merge it over the near-free phase/message (manifest wins on overlap). This
  // adds NO trigger verb — it is a read; SCP never promotes/pauses/aborts/re-weights the rollout.
  const rolloutRes = findRolloutResource(app);
  if (rolloutRes) {
    const enriched = await fetchLiveRollout(ctx, config, appName, rolloutRes);
    if (enriched) {
      result.observed = {
        ...(result.observed ?? {}),
        rollout: { ...(result.observed?.rollout ?? {}), ...enriched }
      };
    }
  }
  return result;
}

async function abort(ctx: PluginContext, ref: ExternalRunRef): Promise<AbortResult> {
  if (ref.externalId.startsWith(ROLLBACK_UNAVAILABLE_PREFIX)) {
    return {
      aborted: false,
      detail: "argocd: fail-closed rollback has no ArgoCD operation to abort"
    };
  }
  const config = asConfig(ctx.config);
  const appName = parseAppName(ref.externalId);
  // Only terminate when there is an in-flight operation. See docs/plugins.md §28.
  const { status: getStatus, body } = await apiRequest(
    ctx,
    config,
    "GET",
    `/api/v1/applications/${encodeURIComponent(appName)}`
  );
  if (getStatus < 200 || getStatus >= 300) {
    return {
      aborted: false,
      detail: `argocd abort: could not read application (HTTP ${getStatus})`
    };
  }
  const opPhase = (body as ArgoApplication)?.status?.operationState?.phase;
  if (opPhase !== "Running" && opPhase !== "Terminating") {
    return {
      aborted: false,
      detail: `argocd: no in-flight operation to abort (operationState=${opPhase ?? "none"})`
    };
  }
  const { status: httpStatus } = await apiRequest(
    ctx,
    config,
    "DELETE",
    `/api/v1/applications/${encodeURIComponent(appName)}/operation`
  );
  if (httpStatus >= 200 && httpStatus < 300) {
    return { aborted: true, detail: "argocd: operation terminated" };
  }
  return { aborted: false, detail: `argocd abort: server returned HTTP ${httpStatus}` };
}

function describeCapabilities(): ExecutorCapabilities {
  return {
    supportsObserve: true,
    supportsTrigger: true,
    supportsAbort: true,
    triggerKinds: ["sync", "rollback"]
  };
}

export const argoCdExecutorPlugin: ExecutorPlugin = {
  observe,
  trigger,
  status,
  abort,
  describeCapabilities
};

export function createArgoCdExecutorPlugin(): ExecutorPlugin {
  return argoCdExecutorPlugin;
}

export const manifest: PluginManifest = {
  id: "argocd",
  kind: "executor",
  version: "0.1.0",
  configSchema: {
    type: "object",
    required: ["serverUrl"],
    properties: {
      serverUrl: { type: "string", format: "uri" },
      tokenSecretKey: { type: "string" }
    }
  }
};

// Discovery: import an existing Argo CD estate. See docs/plugins.md §29.
interface ArgoAppSource {
  repoURL?: string;
  path?: string;
  targetRevision?: string;
}
interface ArgoAppForDiscovery {
  metadata: { name: string };
  spec?: {
    project?: string;
    destination?: { namespace?: string; server?: string };
    // Single-source (the common shape) and multi-source (spec.sources[]) Applications — the git repo
    // the app deploys FROM, which is where its releases correlate (M12 P5, owner Q3 github path).
    source?: ArgoAppSource;
    sources?: ArgoAppSource[];
  };
}

/** The first source declaring a repoURL — a single-source app's `spec.source`, else the first of
 *  `spec.sources[]`. Returns undefined for an app with no git source (e.g. a Helm-repo-only app). */
function primarySource(spec: ArgoAppForDiscovery["spec"]): ArgoAppSource | undefined {
  if (spec?.source?.repoURL) return spec.source;
  return spec?.sources?.find((s) => s.repoURL);
}

/** Extracts an `owner/repo` slug from a GitHub repo URL. See docs/plugins.md §30. */
export function githubRepoSlug(repoURL: string): string | undefined {
  const m = repoURL.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

async function discover(ctx: PluginContext): Promise<DiscoveryProposal> {
  const config = asConfig(ctx.config);
  const { status, body } = await apiRequest(ctx, config, "GET", "/api/v1/applications");
  if (status < 200 || status >= 300) {
    throw new Error(`argocd discovery: server returned HTTP ${status}`);
  }
  const list = body as { items?: ArgoAppForDiscovery[] };
  const objects: DiscoveryProposal["objects"] = [];
  const bindings: NonNullable<DiscoveryProposal["bindings"]> = [];
  const sourceMappings: NonNullable<DiscoveryProposal["sourceMappings"]> = [];
  for (const app of list.items ?? []) {
    const name = app.metadata?.name;
    if (!name) continue;
    const source = primarySource(app.spec);
    objects.push({
      typeId: "component",
      name,
      properties: {
        // The exact Argo CD Application name — an execution-system binding's `externalRef` points
        // here so `trigger()`/`observe()` address the right app (M12 P1/P2).
        argocdApplication: name,
        discoveredFrom: `argocd:${config.serverUrl}`,
        ...(app.spec?.project ? { argocdProject: app.spec.project } : {}),
        ...(app.spec?.destination?.namespace ? { namespace: app.spec.destination.namespace } : {}),
        // The git source the app deploys from (M12 P5) — carried as metadata AND used to build the
        // source_mapping below, so the imported component self-reports releases from this repo.
        ...(source?.repoURL ? { sourceRepo: source.repoURL } : {}),
        ...(source?.path ? { sourcePath: source.path } : {})
      }
    });
    // P3b: if the run named an execution-system, propose the binding too so `accept` wires
    // coordination in the same step (externalRef = the app name → trigger()/observe() hit it).
    if (config.executionSystemId) {
      bindings.push({
        objectName: name,
        executionSystemId: config.executionSystemId,
        externalRef: name
      });
    }
    // M12 P5 (owner Q3, github-webhook path). See docs/plugins.md §31.
    const gitSources = (app.spec?.sources ?? []).concat(app.spec?.source ? [app.spec.source] : []);
    const seen = new Set<string>();
    for (const src of gitSources) {
      if (!src.repoURL) continue;
      const slug = githubRepoSlug(src.repoURL);
      if (!slug) continue;
      const pathPattern = src.path ? `${src.path.replace(/\/+$/, "")}/**` : undefined;
      // A multi-source app can name the same repo twice (e.g. values + chart); one mapping each.
      const key = `${slug}::${pathPattern ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sourceMappings.push({
        objectName: name,
        sourceKind: "github",
        repoPattern: slug,
        ...(pathPattern ? { pathPattern } : {}),
        // ArgoCD Applications SYNC declarative desired state — routing Type `configuration` (ADR-0007).
        type: "configuration"
      });
    }
  }
  return {
    objects,
    relationships: [],
    ...(bindings.length ? { bindings } : {}),
    ...(sourceMappings.length ? { sourceMappings } : {})
  };
}

export const argoCdDiscoveryPlugin: DiscoveryPlugin = { discover };

export function createArgoCdDiscoveryPlugin(): DiscoveryPlugin {
  return argoCdDiscoveryPlugin;
}

export const discoveryManifest: PluginManifest = {
  id: "argocd-discovery",
  kind: "discovery",
  version: "0.1.0",
  configSchema: {
    type: "object",
    required: ["serverUrl"],
    properties: {
      serverUrl: { type: "string", format: "uri" },
      tokenSecretKey: { type: "string" }
    }
  }
};

export default argoCdExecutorPlugin;
