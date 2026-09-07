import { randomUUID } from "node:crypto";
import { createFileBackedJsonCache } from "@scp/plugin-api";
import type {
  AbortResult,
  Cursor,
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

/** The generic pipeline executor plugin. See docs/plugins.md §513. */

export interface PipelineGenericConfig {
  /** URL to POST to kick the pipeline — a run-creation call, a generic webhook, or a
   *  `workflow_dispatch`-wrapping URL. */
  triggerUrl: string;
  tokenSecretKey?: string;
  /** URL TEMPLATE polled by `status()` — `{externalId}` is substituted with the run id `trigger()`
   *  returned (from the trigger response's `runIdField`, default `"id"`). Omit to make `status()`
   *  always report "pending" (a pipeline relying purely on inbound `scp change report`/webhooks
   *  for completion, with no pollable run-status API, sets no `statusUrl`). */
  statusUrl?: string;
  abortUrl?: string;
  runIdField?: string; // default "id" — the field in trigger()'s response body holding the run id
  statusField?: string; // default "status" — the field in status()'s response body
  succeededValues?: string[];
  failedValues?: string[];
  statePath?: string;
}

const DEFAULT_SUCCEEDED = ["applied", "planned_and_finished"];
const DEFAULT_FAILED = ["errored", "discarded", "canceled", "force_canceled", "policy_soft_failed"];

function asConfig(config: unknown): PipelineGenericConfig {
  const c = config as Partial<PipelineGenericConfig> | undefined;
  if (!c?.triggerUrl) {
    throw new Error("pipeline-generic: config.triggerUrl is required");
  }
  return {
    triggerUrl: c.triggerUrl,
    tokenSecretKey: c.tokenSecretKey,
    statusUrl: c.statusUrl,
    abortUrl: c.abortUrl,
    runIdField: c.runIdField ?? "id",
    statusField: c.statusField ?? "status",
    succeededValues: c.succeededValues ?? DEFAULT_SUCCEEDED,
    failedValues: c.failedValues ?? DEFAULT_FAILED,
    statePath: c.statePath
  };
}

async function authHeader(
  ctx: PluginContext,
  config: PipelineGenericConfig
): Promise<Record<string, string>> {
  if (!config.tokenSecretKey) return {};
  const token = await ctx.secrets.get(config.tokenSecretKey);
  return token ? { authorization: `Bearer ${token}` } : {};
}

// -----------------------------------------------------------------------------------------
// Dedup cache — identical shape to @scp/plugin-argocd's (see that package's module doc for the
// full rationale); "the org's pipeline" has no universal idempotency-key concept either.
// -----------------------------------------------------------------------------------------

interface DedupState {
  keys: Record<string, { externalId: string; url?: string }>;
}

/** THE LEDGER IS BOUNDED. See docs/plugins.md §514. */
const DEDUP_CACHE_MAX_KEYS = 200;

function pruneDedupState(state: DedupState): void {
  const keys = Object.keys(state.keys);
  if (keys.length <= DEDUP_CACHE_MAX_KEYS) return;
  // Insertion order, which for these keys (UUID-shaped, never integer-like) is what
  // `Object.keys` returns — so the oldest entries are the ones dropped.
  for (const key of keys.slice(0, keys.length - DEDUP_CACHE_MAX_KEYS)) delete state.keys[key];
}

const dedupCache = createFileBackedJsonCache<DedupState>(() => ({ keys: {} }));
const loadState = dedupCache.load;
const saveState = dedupCache.save;

async function observe(_ctx: PluginContext, _since?: Cursor): Promise<ExecutorEvent[]> {
  return []; // see module doc — this executor's observe path is inbound (webhook/CLI report), not polled.
}

async function trigger(ctx: PluginContext, intent: TriggerIntent): Promise<ExternalRunRef> {
  const config = asConfig(ctx.config);
  const cacheKey = intent.idempotencyKey ?? randomUUID();
  const state = await loadState(config.statePath);
  const existing = state.keys[cacheKey];
  if (existing) return { externalId: existing.externalId, url: existing.url };

  const response = await ctx.http.request({
    method: "POST",
    url: config.triggerUrl,
    headers: { "content-type": "application/json", ...(await authHeader(ctx, config)) },
    body: {
      kind: intent.kind,
      targetRef: intent.targetRef,
      parameters: intent.parameters ?? {},
      priorStateRef: intent.kind === "rollback" ? intent.priorStateRef : undefined,
      idempotencyKey: intent.idempotencyKey
    }
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`pipeline-generic trigger: pipeline endpoint returned HTTP ${response.status}`);
  }
  const body = (response.body ?? {}) as Record<string, unknown>;
  const runId = body[config.runIdField ?? "id"];
  const externalId =
    typeof runId === "string" ? runId : typeof runId === "number" ? String(runId) : cacheKey;
  const url = typeof body.url === "string" ? body.url : undefined;

  state.keys[cacheKey] = { externalId, url };
  pruneDedupState(state);
  await saveState(config.statePath, state);
  ctx.logger.info("pipeline-generic: pipeline triggered", { kind: intent.kind, externalId });
  return { externalId, url };
}

function mapStatus(value: unknown, config: PipelineGenericConfig): ExecutionPhase {
  const status = String(value ?? "").toLowerCase();
  if ((config.succeededValues ?? DEFAULT_SUCCEEDED).map((v) => v.toLowerCase()).includes(status))
    return "succeeded";
  if ((config.failedValues ?? DEFAULT_FAILED).map((v) => v.toLowerCase()).includes(status))
    return "failed";
  return "running";
}

async function status(ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus> {
  const config = asConfig(ctx.config);
  if (!config.statusUrl) {
    return {
      phase: "pending",
      detail: "pipeline-generic: no statusUrl configured — awaiting inbound report/webhook"
    };
  }
  const url = config.statusUrl.replace("{externalId}", encodeURIComponent(ref.externalId));
  const response = await ctx.http.request({
    method: "GET",
    url,
    headers: await authHeader(ctx, config)
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`pipeline-generic status: pipeline endpoint returned HTTP ${response.status}`);
  }
  const body = (response.body ?? {}) as Record<string, unknown>;
  const raw = body[config.statusField ?? "status"];
  const phase = mapStatus(raw, config);
  return { phase, detail: `status=${String(raw)}`, progress: phase === "running" ? 0.5 : 1 };
}

async function abort(ctx: PluginContext, ref: ExternalRunRef): Promise<AbortResult> {
  const config = asConfig(ctx.config);
  if (!config.abortUrl) {
    return { aborted: false, detail: "pipeline-generic: no abortUrl configured" };
  }
  const url = config.abortUrl.replace("{externalId}", encodeURIComponent(ref.externalId));
  const response = await ctx.http.request({
    method: "POST",
    url,
    headers: { "content-type": "application/json", ...(await authHeader(ctx, config)) }
  });
  return response.status >= 200 && response.status < 300
    ? { aborted: true }
    : {
        aborted: false,
        detail: `pipeline-generic abort: pipeline endpoint returned HTTP ${response.status}`
      };
}

function describeCapabilities(): ExecutorCapabilities {
  return {
    supportsObserve: true,
    supportsTrigger: true,
    supportsAbort: true,
    triggerKinds: ["sync", "rollback", "custom"]
  };
}

const pipelineGenericExecutorPlugin: ExecutorPlugin = {
  observe,
  trigger,
  status,
  abort,
  describeCapabilities
};

/** Factory (not a shared singleton export) so a preset package can wrap it without every preset
 *  sharing one module-namespace identity — mirrors every other `create*Plugin()` in this repo. */
export function createPipelineGenericExecutorPlugin(): ExecutorPlugin {
  return pipelineGenericExecutorPlugin;
}

/** The tenant-facing config surface, shared by every preset. See docs/plugins.md §515. */
export const pipelineGenericConfigSchema: Record<string, unknown> = {
  type: "object",
  required: ["triggerUrl"],
  additionalProperties: false,
  properties: {
    triggerUrl: { type: "string", format: "uri" },
    tokenSecretKey: { type: "string" },
    statusUrl: { type: "string" },
    abortUrl: { type: "string" },
    runIdField: { type: "string", default: "id" },
    statusField: { type: "string", default: "status" },
    succeededValues: { type: "array", items: { type: "string" } },
    failedValues: { type: "array", items: { type: "string" } }
  }
};

export const manifest: PluginManifest = {
  id: "pipeline-generic",
  kind: "executor",
  version: "0.1.0",
  configSchema: pipelineGenericConfigSchema
};

export default pipelineGenericExecutorPlugin;
