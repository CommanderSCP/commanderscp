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
 * `@scp/plugin-terraform` — Terraform/OpenTofu MODE 1, pipeline-mediated (DESIGN.md §12,
 * BUILD_AND_TEST.md §8 M7 item 3): "the org's pipeline remains the executor... Trigger: kick the
 * org's pipeline (TFC run API, Atlantis, or a GitHub workflow wrapping tofu)." Mode 2
 * (`scp-managed-iac`, SCP performs release management itself) is a SEPARATE package,
 * `@scp/plugin-managed-iac` — the two modes share nothing but the `ExecutorPlugin` interface,
 * exactly as DESIGN §12 frames them as alternatives for orgs with vs. without an existing pipeline.
 *
 * Deliberately generic, not TFC/Atlantis/GitHub-Actions-specific (DESIGN's own wording — "the
 * org's pipeline", any of the three): `trigger()`/`status()`/`abort()` are configured URL
 * templates (same escape-hatch shape `@scp/plugin-webhook-control` already established for "POST
 * somewhere, interpret the response") rather than hardcoded against one vendor's API. The default
 * `statusField`/`succeededValues`/`failedValues` vocabulary matches Terraform Cloud's own `Run`
 * status enum (the most structured of the three) — an Atlantis or GitHub-Actions-wrapping-tofu
 * pipeline configures its OWN vocabulary via the same config fields, since neither exposes a
 * TFC-shaped run-status API natively.
 *
 * `observe()` is intentionally a no-op ([]): Mode 1's actual observe path is INBOUND, not polled —
 * either `scp change report --plan-json` (packages/cli) or a TFC/TFE/Atlantis webhook, both of
 * which land through the SAME `POST /change-sources/terraform/webhook` ingress every other source
 * kind uses (routes/change-sources.ts), never through this plugin's `observe()`. The GATE-VERDICT
 * endpoint the org's apply step consults before applying (DESIGN §12 "the pipeline's apply step
 * asks SCP for a gate verdict... SCP evaluates policies/controls and answers with a Decision") is
 * likewise server-side (`GET /changes/{id}/gate-verdict`, routes/change-sources.ts), reusing M4's
 * existing pure policy-evaluation machinery rather than new engine logic — see that route's doc
 * comment.
 */

export interface TerraformConfig {
  /** URL to POST to kick the org's pipeline — a TFC run-creation call, an Atlantis webhook, or a
   *  GitHub `workflow_dispatch`-wrapping-tofu URL (interchangeable with `@scp/plugin-github`'s own
   *  trigger for that last case; orgs that already have a GitHub Actions tofu pipeline can use
   *  EITHER plugin — this one if they want Mode 1's generic gate-verdict handshake, `github` if
   *  they only need workflow_dispatch). */
  triggerUrl: string;
  tokenSecretKey?: string;
  /** URL TEMPLATE polled by `status()` — `{externalId}` is substituted with the run id `trigger()`
   *  returned (from the trigger response's `runIdField`, default `"id"`). Omit to make `status()`
   *  always report "pending" (an org relying purely on inbound `scp change report`/webhooks for
   *  completion, with no pollable run-status API, sets no `statusUrl`). */
  statusUrl?: string;
  abortUrl?: string; // same `{externalId}` templating
  runIdField?: string; // default "id" — the field in trigger()'s response body holding the run id
  statusField?: string; // default "status" — the field in status()'s response body
  succeededValues?: string[]; // default: TFC's terminal-success values
  failedValues?: string[]; // default: TFC's terminal-failure values
  statePath?: string;
}

const DEFAULT_SUCCEEDED = ["applied", "planned_and_finished"];
const DEFAULT_FAILED = ["errored", "discarded", "canceled", "force_canceled", "policy_soft_failed"];

function asConfig(config: unknown): TerraformConfig {
  const c = config as Partial<TerraformConfig> | undefined;
  if (!c?.triggerUrl) {
    throw new Error("terraform: config.triggerUrl is required");
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
  config: TerraformConfig
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
  return []; // see module doc — Mode 1's observe path is inbound (webhook/CLI report), not polled.
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
    throw new Error(`terraform trigger: pipeline endpoint returned HTTP ${response.status}`);
  }
  const body = (response.body ?? {}) as Record<string, unknown>;
  const runId = body[config.runIdField ?? "id"];
  const externalId =
    typeof runId === "string" ? runId : typeof runId === "number" ? String(runId) : cacheKey;
  const url = typeof body.url === "string" ? body.url : undefined;

  state.keys[cacheKey] = { externalId, url };
  await saveState(config.statePath, state);
  ctx.logger.info("terraform: pipeline triggered", { kind: intent.kind, externalId });
  return { externalId, url };
}

function mapStatus(value: unknown, config: TerraformConfig): ExecutionPhase {
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
      detail: "terraform: no statusUrl configured — awaiting inbound report/webhook"
    };
  }
  const url = config.statusUrl.replace("{externalId}", encodeURIComponent(ref.externalId));
  const response = await ctx.http.request({
    method: "GET",
    url,
    headers: await authHeader(ctx, config)
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`terraform status: pipeline endpoint returned HTTP ${response.status}`);
  }
  const body = (response.body ?? {}) as Record<string, unknown>;
  const raw = body[config.statusField ?? "status"];
  const phase = mapStatus(raw, config);
  return { phase, detail: `status=${String(raw)}`, progress: phase === "running" ? 0.5 : 1 };
}

async function abort(ctx: PluginContext, ref: ExternalRunRef): Promise<AbortResult> {
  const config = asConfig(ctx.config);
  if (!config.abortUrl) {
    return { aborted: false, detail: "terraform: no abortUrl configured" };
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
        detail: `terraform abort: pipeline endpoint returned HTTP ${response.status}`
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

export const terraformExecutorPlugin: ExecutorPlugin = {
  observe,
  trigger,
  status,
  abort,
  describeCapabilities
};

export function createTerraformExecutorPlugin(): ExecutorPlugin {
  return terraformExecutorPlugin;
}

export const manifest: PluginManifest = {
  id: "terraform",
  kind: "executor",
  version: "0.1.0",
  configSchema: {
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
  }
};

export default terraformExecutorPlugin;
