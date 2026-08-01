import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

/**
 * `@scp/plugin-pipeline-generic` — M10.6's generic pipeline executor (BUILD_AND_TEST.md §8 M10.6:
 * "extract `@scp/plugin-pipeline-generic` from the terraform Mode-1 shape (Mode 1 becomes a
 * preset)"), extracted verbatim from `@scp/plugin-terraform`'s Mode-1 implementation (DESIGN.md
 * §12's "the org's pipeline remains the executor... Trigger: kick the org's pipeline"). Covers the
 * entire CI/CD/IaC long tail — any pipeline that can POST a JSON body and answer a JSON status —
 * at zero marginal engineering per system, air-gap-friendly via the pull-side CLI/webhook report
 * path (`POST /change-sources/{sourceKind}/report`, ADR-0002 §7).
 *
 * `@scp/plugin-terraform` is now a PRESET of this package (same defaults, own manifest `id`) —
 * see that package's module doc. A future GitLab-CI-generic/Jenkins-generic preset follows the
 * exact same pattern: a thin config-defaults wrapper around `createPipelineGenericExecutorPlugin`.
 *
 * `trigger()`/`status()`/`abort()` are configured URL templates (the same escape-hatch shape
 * `@scp/plugin-webhook-control` established for "POST somewhere, interpret the response") rather
 * than hardcoded against one vendor's API. The default `statusField`/`succeededValues`/
 * `failedValues` vocabulary matches Terraform Cloud's own `Run` status enum (the most structured
 * of Mode 1's three original targets — TFC, Atlantis, a GitHub Actions workflow wrapping tofu); a
 * preset for a pipeline with a different vocabulary overrides those fields in its own config.
 *
 * `observe()` is intentionally a no-op ([]): this executor's actual observe path is INBOUND, not
 * polled — either `scp change report --plan-json` (packages/cli) or a native webhook, both landing
 * through the SAME `POST /change-sources/{sourceKind}/report`/webhook ingress every other source
 * kind uses (routes/change-sources.ts). The DISCIPLINE that separates this from a "call any URL"
 * bus is that inbound path's REQUIRED structured-evidence schema
 * (`ChangeReportRequestSchema`/`SbomRefSchema`, `additionalProperties:false` as of M10.6) — see
 * `packages/schemas/src/executors.ts` — never this plugin, which has no evidence-shape opinion of
 * its own.
 */

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
  abortUrl?: string; // same `{externalId}` templating
  runIdField?: string; // default "id" — the field in trigger()'s response body holding the run id
  statusField?: string; // default "status" — the field in status()'s response body
  succeededValues?: string[]; // default: Terraform Cloud's terminal-success values
  failedValues?: string[]; // default: Terraform Cloud's terminal-failure values
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

let inMemoryState: DedupState = { keys: {} };

async function loadState(statePath: string | undefined): Promise<DedupState> {
  if (!statePath) return inMemoryState;
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as DedupState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { keys: {} };
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

export const pipelineGenericConfigSchema: Record<string, unknown> = {
  type: "object",
  required: ["triggerUrl"],
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
