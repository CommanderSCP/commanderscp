import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
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

/**
 * `@scp/plugin-argocd` — the ArgoCD `ExecutorPlugin` (DESIGN.md §12, BUILD_AND_TEST.md §8 M7
 * item 2): "Observe: Application get/watch — health + sync status is the actual-state input to
 * reconciliation. Trigger: sync of an Application the org already defined (optionally setting
 * target revision). Abort: terminate operation. Rollback: sync to previous known-good revision."
 *
 * Modeled against ArgoCD's documented REST API (`/api/v1/applications/{name}`, `.../sync`,
 * `.../operation`) — every call goes through `ctx.http` (the host-mediated, egress-controlled
 * client; DESIGN §11), never a raw fetch. HONEST COVERAGE NOTE (mirrors this PR's "deterministic
 * vs. live-sandbox" split): the request/response shapes below are exercised deterministically
 * against `nock` fixtures built from ArgoCD's published API docs, NOT against a live server — the
 * golden-path E2E's "ArgoCD-in-kind" variant and the opt-in nightly live-sandbox job are what
 * actually prove wire-format fidelity against a real ArgoCD instance.
 *
 * Idempotency (coordination/reconcile.ts's crash-safe trigger contract — `idempotencyKey` must
 * dedup to the SAME `ExternalRunRef` without re-firing `sync`): ArgoCD's sync API has no native
 * idempotency-key concept, so this plugin keeps its own small dedup cache, file-backed when
 * `ctx.config.statePath` is set (same write-to-temp+rename pattern `@scp/plugin-fake-executor`
 * uses, for the identical reason: a subprocess-host restart mid-wave must not lose the mapping).
 * HONEST LIMITATION: unlike fake-executor's cache (the only system of record), a REAL ArgoCD sync
 * is itself close to idempotent — syncing an Application already at the target revision is a fast
 * no-op — which bounds the damage if this cache is ever lost (e.g. `statePath` unset, or the state
 * file itself is lost) and a retry re-issues `sync`. Tracked as a documented, narrower guarantee
 * than fake-executor's, not silently assumed equivalent.
 */

export interface ArgoCdConfig {
  /** ArgoCD API server base URL, e.g. `https://argocd.example.com`. */
  serverUrl: string;
  /** `SecretsAccessor` key holding the ArgoCD API token (a project-scoped or admin token, per the
   *  org's own ArgoCD RBAC) — never embedded directly in config. */
  tokenSecretKey?: string;
  /** Fallback for tests/fixtures only — a plaintext token in config. Real deployments must use
   *  `tokenSecretKey`; this field exists so nock-fixture tests don't need a live SecretsAccessor. */
  token?: string;
  statePath?: string;
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
    statePath: c.statePath
  };
}

async function resolveToken(ctx: PluginContext, config: ArgoCdConfig): Promise<string | undefined> {
  if (config.token) return config.token;
  if (config.tokenSecretKey) return ctx.secrets.get(config.tokenSecretKey);
  return undefined;
}

// -----------------------------------------------------------------------------------------
// Dedup cache — see module doc. Mirrors @scp/plugin-fake-executor's persistence shape exactly.
// -----------------------------------------------------------------------------------------

let inMemoryState: DedupState = { targets: {} };

async function loadState(statePath: string | undefined): Promise<DedupState> {
  if (!statePath) return inMemoryState;
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as DedupState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { targets: {} };
    throw err;
  }
}

async function saveState(statePath: string | undefined, state: DedupState): Promise<void> {
  if (!statePath) {
    inMemoryState = state;
    return;
  }
  await mkdir(dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state), "utf8");
  await rename(tmpPath, statePath);
}

function mintExternalId(appName: string): string {
  return `${appName}${REF_DELIMITER}${randomUUID()}`;
}

function parseAppName(externalId: string): string {
  const idx = externalId.lastIndexOf(REF_DELIMITER);
  return idx === -1 ? externalId : externalId.slice(0, idx);
}

/** CRITICAL #2: a rollback with no prior known-good revision must NEVER be turned into a sync (an
 *  empty-revision sync re-applies the CURRENT — i.e. the bad — revision, then reports success). It
 *  fails closed instead: `trigger()` mints a ref with this prefix and does NOT call ArgoCD;
 *  `status()`/`abort()` recognize it and report a terminal `failed`, so the wave target fails
 *  cleanly rather than silently re-deploying the broken revision as a "successful rollback". */
const ROLLBACK_UNAVAILABLE_PREFIX = `argocd-rollback-unavailable${REF_DELIMITER}`;

// -----------------------------------------------------------------------------------------
// ArgoCD REST shapes (subset — only the fields this plugin reads/sends)
// -----------------------------------------------------------------------------------------

interface ArgoApplication {
  metadata: { name: string; resourceVersion?: string };
  status?: {
    sync?: { status?: string; revision?: string };
    health?: { status?: string };
    operationState?: {
      phase?: string; // Running|Succeeded|Failed|Error|Terminating
      message?: string;
      finishedAt?: string;
      startedAt?: string;
      syncResult?: { revision?: string };
    };
    reconciledAt?: string;
  };
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

/**
 * MAJOR #3 — health -> phase AFTER a sync operation has finished (`operationState.phase` is
 * "Succeeded", or absent-but-"Synced"). The bug this fixes: ArgoCD does NOT clear
 * `operationState` after a sync, so if the app degrades post-sync the old code returned "running"
 * FOREVER and the reconciler waited on a dead deployment indefinitely. A finished sync that left
 * the app Degraded/Missing is a TERMINAL failure. Progressing is still legitimately rolling out
 * (keep polling); Unknown is genuinely ambiguous (keep polling — the stuck-change watchdog is the
 * backstop, not perpetual silence here); Suspended is a valid stable state (succeeded).
 */
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
  return {
    phase,
    detail: `sync=${syncStatus ?? "unknown"} health=${healthStatus ?? "unknown"} op=${opPhase ?? "none"}`,
    stateRef: app?.status?.sync?.revision,
    progress: settled ? 1 : 0.5
  };
}

// -----------------------------------------------------------------------------------------
// ExecutorPlugin
// -----------------------------------------------------------------------------------------

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
  return mapArgoPhase(body as ArgoApplication);
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
  // MINOR — only terminate if there IS an in-flight operation, and don't blindly DELETE an
  // operation that may be a NEWER one than the run this ref was minted for. ArgoCD's terminate
  // endpoint targets "the current operation" (there is no per-operation id to scope to), so the
  // best available guard is: GET the app first, and only issue the terminate when an operation is
  // actually Running/Terminating. A settled/absent operation → nothing to abort (avoids
  // terminating a subsequent, unrelated sync).
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

// -------------------------------------------------------------------------------------------
// DiscoveryPlugin (M12 P3, docs/proposals/import-existing-executors.md) — "import my existing
// Argo CD": enumerate its Applications (the SAME `GET /api/v1/applications` observe() already
// uses) and PROPOSE one `component` per Application, recording the Application NAME on
// `properties.argocdApplication` so a subsequent execution-system binding's `externalRef` (M12 P2)
// coordinates the right app. NEVER auto-commits — `POST /discovery/accept` materializes the
// proposal. Same one-npm-package-two-plugins shape as @scp/plugin-github (executor + discovery).
// -------------------------------------------------------------------------------------------
interface ArgoAppForDiscovery {
  metadata: { name: string };
  spec?: { project?: string; destination?: { namespace?: string; server?: string } };
}

async function discover(ctx: PluginContext): Promise<DiscoveryProposal> {
  const config = asConfig(ctx.config);
  const { status, body } = await apiRequest(ctx, config, "GET", "/api/v1/applications");
  if (status < 200 || status >= 300) {
    throw new Error(`argocd discovery: server returned HTTP ${status}`);
  }
  const list = body as { items?: ArgoAppForDiscovery[] };
  const objects: DiscoveryProposal["objects"] = [];
  for (const app of list.items ?? []) {
    const name = app.metadata?.name;
    if (!name) continue;
    objects.push({
      typeId: "component",
      name,
      properties: {
        // The exact Argo CD Application name — an execution-system binding's `externalRef` points
        // here so `trigger()`/`observe()` address the right app (M12 P1/P2).
        argocdApplication: name,
        discoveredFrom: `argocd:${config.serverUrl}`,
        ...(app.spec?.project ? { argocdProject: app.spec.project } : {}),
        ...(app.spec?.destination?.namespace ? { namespace: app.spec.destination.namespace } : {})
      }
    });
  }
  return { objects, relationships: [] };
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
