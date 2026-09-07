import { createFileBackedJsonCache } from "@scp/plugin-api";
import type {
  ScheduleSpec,
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

/** The Argo Workflows executor plugin. See docs/plugins.md §3. */

export interface ArgoWorkflowsConfig {
  serverUrl: string;
  /** Every endpoint this plugin calls is namespaced (assumption #1-3, #9) — one plugin instance
   *  addresses exactly one namespace, mirroring how one `@scp/plugin-argocd` instance addresses
   *  one ArgoCD server. */
  namespace: string;
  /** `SecretsAccessor` key holding the Argo Workflows bearer token — never embedded directly in
   *  config. */
  tokenSecretKey?: string;
  /** Fallback for tests/fixtures only — a plaintext token in config. Real deployments must use
   *  `tokenSecretKey`. */
  token?: string;
  statePath?: string;
  /** Optional `listOptions.labelSelector` scoping `observe()`'s list call (assumption #3). Unset
   *  lists every Workflow in the namespace. */
  labelSelector?: string;
}

interface DedupState {
  targets: Record<string, { idempotencyKey?: string; externalId: string }>;
  /** Workflow NAMES this plugin instance itself called `terminate` on (assumption #4) — the only
   *  local signal distinguishing "aborted" from "failed" once Argo settles the workflow, since the
   *  real API reports both as the same terminal phase. Keyed by name (unique per submission,
   *  including Argo's own generated-name suffixing), not by the full externalId. */
  abortedNames: Record<string, true>;
}

const REF_DELIMITER = "::";

/** The label a submitting caller may set to carry the commit this run is for (assumption #8). Read
 *  only — this plugin never writes it. */
const COMMIT_SHA_LABEL_KEY = "commanderscp.io/commit-sha";

function asConfig(config: unknown): ArgoWorkflowsConfig {
  const c = config as Partial<ArgoWorkflowsConfig> | undefined;
  if (!c?.serverUrl) {
    throw new Error("argo-workflows: config.serverUrl is required");
  }
  if (!c.namespace) {
    throw new Error("argo-workflows: config.namespace is required");
  }
  return {
    serverUrl: c.serverUrl.replace(/\/$/, ""),
    namespace: c.namespace,
    tokenSecretKey: c.tokenSecretKey,
    token: c.token,
    statePath: c.statePath,
    labelSelector: c.labelSelector
  };
}

async function resolveToken(
  ctx: PluginContext,
  config: ArgoWorkflowsConfig
): Promise<string | undefined> {
  if (config.token) return config.token;
  if (config.tokenSecretKey) return ctx.secrets.get(config.tokenSecretKey);
  return undefined;
}

// Dedup + abort-tracking cache. See docs/plugins.md §4.

const dedupCache = createFileBackedJsonCache<DedupState>(
  () => ({ targets: {}, abortedNames: {} }),
  (parsed) => {
    const p = parsed as Partial<DedupState>;
    return { targets: p.targets ?? {}, abortedNames: p.abortedNames ?? {} };
  }
);
const loadState = dedupCache.load;
const saveState = dedupCache.save;

function mintExternalId(name: string, uid: string): string {
  return `${name}${REF_DELIMITER}${uid}`;
}

function parseWorkflowName(externalId: string): string {
  const idx = externalId.indexOf(REF_DELIMITER);
  return idx === -1 ? externalId : externalId.slice(0, idx);
}

// -----------------------------------------------------------------------------------------
// Argo Workflows REST shapes (ASSUMED — see module doc checklist above). Only the fields this
// plugin reads/sends.
// -----------------------------------------------------------------------------------------

interface ArgoWorkflowMetadata {
  name: string;
  uid?: string;
  creationTimestamp?: string;
  labels?: Record<string, string>;
}

interface ArgoWorkflowStatus {
  phase?: string; // Pending|Running|Succeeded|Failed|Error (assumption #5)
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  progress?: string; // "N/M" (assumption #6)
}

interface ArgoWorkflow {
  metadata: ArgoWorkflowMetadata;
  status?: ArgoWorkflowStatus;
}

interface ArgoWorkflowList {
  items?: ArgoWorkflow[];
}

// Assumption #9 — typed for a future live-verification pass, DELIBERATELY UNUSED by every verb in
// this increment. See the module doc's checklist item 9 before wiring this up. Exported (rather
// than left package-private) so nothing about "unused" needs a lint suppression — a genuinely dead
// private type would be the smell; a reserved, documented, publicly-typed shape is not one.
export interface ArgoCronWorkflow {
  metadata: { name: string; labels?: Record<string, string> };
  status?: { lastScheduledTime?: string };
}
export interface ArgoCronWorkflowList {
  items?: ArgoCronWorkflow[];
}

async function apiRequest(
  ctx: PluginContext,
  config: ArgoWorkflowsConfig,
  method: "GET" | "POST" | "PUT" | "DELETE",
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

/** Assumption #5 — the phase-mapping table. See docs/plugins.md §5. */
function mapWorkflowPhase(rawPhase: string | undefined, ctx: PluginContext): ExecutionPhase {
  switch (rawPhase) {
    case undefined:
    case "":
    case "Pending":
      return "pending";
    case "Running":
      return "running";
    case "Succeeded":
      return "succeeded";
    case "Failed":
    case "Error":
      return "failed";
    default:
      ctx.logger.warn("argo-workflows: unknown status.phase — treating as still running", {
        phase: rawPhase
      });
      return "running";
  }
}

/** Assumption #6 — "N/M" parsed to a 0..1 fraction; falls back to a phase-based estimate. */
function computeProgress(progress: string | undefined, phase: ExecutionPhase): number {
  const m = progress ? /^(\d+)\/(\d+)$/.exec(progress) : null;
  if (m) {
    const done = Number(m[1]);
    const total = Number(m[2]);
    if (total > 0) return Math.min(1, Math.max(0, done / total));
  }
  if (phase === "pending") return 0;
  if (phase === "running") return 0.5;
  return 1;
}

async function trigger(ctx: PluginContext, intent: TriggerIntent): Promise<ExternalRunRef> {
  const config = asConfig(ctx.config);
  const templateName = intent.targetRef;
  if (!templateName) {
    throw new Error("argo-workflows trigger: intent.targetRef (WorkflowTemplate name) is required");
  }

  const state = await loadState(config.statePath);
  const existing = state.targets[templateName];
  if (intent.idempotencyKey && existing?.idempotencyKey === intent.idempotencyKey) {
    const name = parseWorkflowName(existing.externalId);
    return {
      externalId: existing.externalId,
      url: `${config.serverUrl}/workflows/${config.namespace}/${name}`
    };
  }

  const parameters = Object.entries(intent.parameters ?? {}).map(
    ([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`
  );

  const { status, body } = await apiRequest(
    ctx,
    config,
    "POST",
    `/api/v1/workflows/${config.namespace}/submit`,
    {
      resourceKind: "WorkflowTemplate",
      resourceName: templateName,
      ...(parameters.length > 0 ? { submitOptions: { parameters } } : {})
    }
  );
  if (status < 200 || status >= 300) {
    throw new Error(`argo-workflows trigger: submit returned HTTP ${status}`);
  }

  const submitted = body as ArgoWorkflow;
  if (!submitted?.metadata?.name || !submitted.metadata.uid) {
    throw new Error(
      "argo-workflows trigger: submit response missing metadata.name/metadata.uid (assumption #1)"
    );
  }

  const externalId = mintExternalId(submitted.metadata.name, submitted.metadata.uid);
  state.targets[templateName] = { idempotencyKey: intent.idempotencyKey, externalId };
  await saveState(config.statePath, state);

  ctx.logger.info("argo-workflows: workflow submitted", {
    templateName,
    workflowName: submitted.metadata.name
  });
  return {
    externalId,
    url: `${config.serverUrl}/workflows/${config.namespace}/${submitted.metadata.name}`
  };
}

async function status(ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus> {
  const config = asConfig(ctx.config);
  const name = parseWorkflowName(ref.externalId);
  const { status: httpStatus, body } = await apiRequest(
    ctx,
    config,
    "GET",
    `/api/v1/workflows/${config.namespace}/${encodeURIComponent(name)}`
  );
  if (httpStatus === 404) {
    return { phase: "pending", detail: `argo-workflows: workflow '${name}' not found (yet)` };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new Error(`argo-workflows status: server returned HTTP ${httpStatus}`);
  }

  const wf = body as ArgoWorkflow;
  const rawPhase = wf.status?.phase;

  // Assumption #4 — the real API has no distinct "terminated" phase, so a workflow THIS plugin
  // instance aborted is recognized from local state, not from any Argo-reported signal.
  const state = await loadState(config.statePath);
  const wasAbortedHere = state.abortedNames[name] === true;
  const phase: ExecutionPhase =
    wasAbortedHere && (rawPhase === "Failed" || rawPhase === "Error")
      ? "aborted"
      : mapWorkflowPhase(rawPhase, ctx);

  return {
    phase,
    detail: wf.status?.message ?? `phase=${rawPhase ?? "unknown"}`,
    progress: computeProgress(wf.status?.progress, phase)
  };
}

async function abort(ctx: PluginContext, ref: ExternalRunRef): Promise<AbortResult> {
  const config = asConfig(ctx.config);
  const name = parseWorkflowName(ref.externalId);

  // MINOR (mirrors @scp/plugin-argocd's abort()) — only terminate when there IS an in-flight
  // workflow, so a settled/absent workflow is never mistaken for something to abort.
  const { status: getStatus, body } = await apiRequest(
    ctx,
    config,
    "GET",
    `/api/v1/workflows/${config.namespace}/${encodeURIComponent(name)}`
  );
  if (getStatus === 404) {
    return {
      aborted: false,
      detail: `argo-workflows: workflow '${name}' not found — nothing to abort`
    };
  }
  if (getStatus < 200 || getStatus >= 300) {
    return {
      aborted: false,
      detail: `argo-workflows abort: could not read workflow (HTTP ${getStatus})`
    };
  }
  const rawPhase = (body as ArgoWorkflow).status?.phase;
  if (rawPhase === "Succeeded" || rawPhase === "Failed" || rawPhase === "Error") {
    return {
      aborted: false,
      detail: `argo-workflows: no in-flight workflow to abort (phase=${rawPhase})`
    };
  }

  const { status: httpStatus } = await apiRequest(
    ctx,
    config,
    "PUT",
    `/api/v1/workflows/${config.namespace}/${encodeURIComponent(name)}/terminate`
  );
  if (httpStatus < 200 || httpStatus >= 300) {
    return { aborted: false, detail: `argo-workflows abort: server returned HTTP ${httpStatus}` };
  }

  const state = await loadState(config.statePath);
  state.abortedNames[name] = true;
  await saveState(config.statePath, state);

  return { aborted: true, detail: "argo-workflows: workflow terminated" };
}

/** `stateRef` = `${uid}${REF_DELIMITER}${phase}`. See docs/plugins.md §6. */
function workflowStateRef(wf: ArgoWorkflow): string | undefined {
  const uid = wf.metadata.uid;
  if (!uid) return undefined;
  return `${uid}${REF_DELIMITER}${wf.status?.phase ?? "unknown"}`;
}

/** Assumption #8 — read only, never fabricated. */
function commitShaFromLabels(labels: Record<string, string> | undefined): string | undefined {
  const value = labels?.[COMMIT_SHA_LABEL_KEY];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function observe(ctx: PluginContext, since?: Cursor): Promise<ExecutorEvent[]> {
  const config = asConfig(ctx.config);
  const sinceTime = since?.token ? new Date(since.token).getTime() : 0;
  const query = config.labelSelector
    ? `?listOptions.labelSelector=${encodeURIComponent(config.labelSelector)}`
    : "";
  const { status: httpStatus, body } = await apiRequest(
    ctx,
    config,
    "GET",
    `/api/v1/workflows/${config.namespace}${query}`
  );
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new Error(`argo-workflows observe: server returned HTTP ${httpStatus}`);
  }

  const list = body as ArgoWorkflowList;
  const events: ExecutorEvent[] = [];
  for (const wf of list.items ?? []) {
    const name = wf.metadata?.name;
    if (!name) continue;
    // The workflow's own most-recently-known transition — finish, else start, else creation. Two
    // DISTINCT occurrences (submission, then completion) each get their own occurredAt, so a
    // long-running workflow's eventual completion is not swallowed by an early `since` watermark.
    const occurredAtRaw =
      wf.status?.finishedAt ?? wf.status?.startedAt ?? wf.metadata?.creationTimestamp;
    if (!occurredAtRaw) continue;
    const occurredAtMs = new Date(occurredAtRaw).getTime();
    if (Number.isNaN(occurredAtMs) || occurredAtMs <= sinceTime) continue;

    const commitSha = commitShaFromLabels(wf.metadata?.labels);
    events.push({
      kind: "workflow_run",
      occurredAt: new Date(occurredAtMs).toISOString(),
      correlation: {
        correlationKey: name,
        stateRef: workflowStateRef(wf),
        ...(commitSha ? { commitSha } : {}),
        ...(wf.metadata?.labels ? { labels: wf.metadata.labels } : {})
      },
      raw: wf
    });
  }
  return events;
}

/** D12's `rollout` capability field is DELIBERATELY OMITTED here. See docs/plugins.md §7. */
function describeCapabilities(): ExecutorCapabilities {
  return {
    supportsObserve: true,
    supportsTrigger: true,
    supportsAbort: true,
    // Declared TRUE because both verbs are implemented below. Absent would read as "no schedule
    // capability", which is what every other executor correctly says.
    supportsSchedules: true,
    triggerKinds: ["workflow_dispatch"]
  };
}

/** ASSUMPTION #10 — CronWorkflow WRITE. See docs/plugins.md §8. */
function cronExpressionFor(cadenceSeconds: number): string {
  // Coarsest expression that fits, and never finer than a minute — Argo's cron has no seconds
  // field, so a sub-minute cadence cannot be expressed and is rounded UP to one minute rather
  // than silently becoming "every second" or failing at the server.
  const minutes = Math.max(1, Math.round(cadenceSeconds / 60));
  if (minutes < 60) return `*/${minutes} * * * *`;
  const hours = Math.max(1, Math.round(minutes / 60));
  if (hours < 24) return `0 */${hours} * * *`;
  return `0 0 */${Math.max(1, Math.round(hours / 24))} * *`;
}

async function ensureSchedule(ctx: PluginContext, spec: ScheduleSpec): Promise<void> {
  const config = asConfig(ctx.config);
  const body = {
    cronWorkflow: {
      metadata: {
        name: spec.scheduleId,
        // The correlation labels the caller asked for, so runs this schedule spawns carry the
        // hook identity back through `observe()`. Never invented here.
        ...(spec.labels ? { labels: spec.labels } : {})
      },
      spec: {
        schedule: cronExpressionFor(spec.cadenceSeconds),
        workflowSpec: { workflowTemplateRef: { name: spec.targetRef } }
      }
    }
  };
  // UPDATE-THEN-CREATE, not create-then-update: `ensureSchedule` is re-declared every tick by the
  // driver, so the steady state is "it already exists" and trying PUT first makes the common path
  // one call instead of two. A 404 means it is not there yet, which is the only case that needs a
  // POST.
  const put = await apiRequest(
    ctx,
    config,
    "PUT",
    `/api/v1/cron-workflows/${config.namespace}/${encodeURIComponent(spec.scheduleId)}`,
    body
  );
  if (put.status >= 200 && put.status < 300) return;
  if (put.status !== 404) {
    throw new Error(`argo-workflows ensureSchedule: server returned HTTP ${put.status}`);
  }
  const post = await apiRequest(
    ctx,
    config,
    "POST",
    `/api/v1/cron-workflows/${config.namespace}`,
    body
  );
  if (post.status < 200 || post.status >= 300) {
    throw new Error(`argo-workflows ensureSchedule: server returned HTTP ${post.status}`);
  }
}

async function removeSchedule(ctx: PluginContext, scheduleId: string): Promise<void> {
  const config = asConfig(ctx.config);
  const { status: httpStatus } = await apiRequest(
    ctx,
    config,
    "DELETE",
    `/api/v1/cron-workflows/${config.namespace}/${encodeURIComponent(scheduleId)}`
  );
  // 404 IS SUCCESS. A retraction for a schedule already gone is ordinary — the commander retracts
  // once and the driver may re-issue it — and treating it as failure would make a clean removal
  // look like a broken executor forever.
  if (httpStatus === 404) return;
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new Error(`argo-workflows removeSchedule: server returned HTTP ${httpStatus}`);
  }
}

export const argoWorkflowsExecutorPlugin: ExecutorPlugin = {
  observe,
  trigger,
  status,
  abort,
  describeCapabilities,
  ensureSchedule,
  removeSchedule
};

export function createArgoWorkflowsExecutorPlugin(): ExecutorPlugin {
  return argoWorkflowsExecutorPlugin;
}

export const manifest: PluginManifest = {
  id: "argo-workflows",
  kind: "executor",
  version: "0.1.0",
  configSchema: {
    type: "object",
    required: ["serverUrl", "namespace"],
    properties: {
      serverUrl: { type: "string", format: "uri" },
      namespace: { type: "string" },
      tokenSecretKey: { type: "string" },
      labelSelector: { type: "string" }
    }
  }
};

export default argoWorkflowsExecutorPlugin;
