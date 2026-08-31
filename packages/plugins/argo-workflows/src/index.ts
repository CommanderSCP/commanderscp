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

/**
 * `@scp/plugin-argo-workflows` — the Argo Workflows `ExecutorPlugin` (team-pipeline-iac increment
 * 8, sibling of `@scp/plugin-argocd`). Argo Workflows runs TESTS on behalf of a coordinated
 * pipeline; it never performs a rollout, so `describeCapabilities()` deliberately OMITS the
 * `rollout` field (see that function below) rather than declaring an authority this plugin does
 * not have.
 *
 * MODELED ON `@scp/plugin-argocd`, deliberately, not on `pipeline-generic`/`terraform`: Argo
 * Workflows is a typed REST API problem (typed request/response shapes, a real list endpoint, a
 * file-backed idempotency cache), exactly like ArgoCD, not a URL-template escape hatch. Every call
 * goes through `ctx.http` (the host-mediated, egress-controlled client), never a raw fetch.
 *
 * ================================================================================================
 * HONEST COVERAGE NOTE — every shape below is ASSUMED, not verified against a live Argo Workflows
 * instance. This is a known, named risk (the Gitea lesson: an assumed webhook-signature scheme
 * that differed from GitHub's cost a full round to discover and fix). So every assumed shape is
 * typed in ONE place (the "Argo Workflows REST shapes" section below) and every assumption is
 * listed here as a single checklist a live-verification pass can work from:
 *
 *  1. Submit from a template — `POST /api/v1/workflows/{namespace}/submit`, body
 *     `{ resourceKind: "WorkflowTemplate", resourceName, submitOptions?: { parameters?: string[] } }`
 *     → response `{ metadata: { name, uid }, status?: {...} }`. Used by `trigger()`.
 *  2. Get one — `GET /api/v1/workflows/{namespace}/{name}` →
 *     `{ metadata: { name, uid, creationTimestamp, labels? }, status?: { phase?, startedAt?,
 *     finishedAt?, message?, progress? } }`. Used by `status()` and `abort()`.
 *  3. List — `GET /api/v1/workflows/{namespace}` (optionally `?listOptions.labelSelector=`) →
 *     `{ items: Workflow[] }`, same per-item shape as #2. Used by `observe()`.
 *  4. Terminate — `PUT /api/v1/workflows/{namespace}/{name}/terminate`, no body, success = 2xx.
 *     Used by `abort()`. IMPORTANT SUB-ASSUMPTION: the real API has NO distinct terminal phase for
 *     "explicitly terminated" — a terminated workflow settles into `Failed`/`Error` exactly like a
 *     genuine failure, distinguished (if at all) only by free-form `status.message` text this
 *     plugin does not want to pin its behavior on. So this plugin tracks "did *this plugin instance*
 *     call terminate on this workflow" itself, in the SAME file-backed state the idempotency cache
 *     uses (see `DedupState.abortedNames` below), and `status()` reads that local record — not any
 *     Argo-reported phase — to report `aborted` rather than `failed`. That is honest for aborts THIS
 *     plugin issued; a workflow terminated by some other actor (`argo terminate` from the CLI, a
 *     different SCP instance with a different `statePath`) still reports `failed`, which is a
 *     narrower guarantee than a phase-based signal would give, stated rather than assumed away.
 *  5. Workflow `status.phase` — `Pending | Running | Succeeded | Failed | Error` (assumed enum).
 *     Mapped to `ExecutionPhase`: `Pending`→`pending`, `Running`→`running`, `Succeeded`→`succeeded`,
 *     `Failed`/`Error`→`failed` (or `aborted` per #4 above when locally tracked), an UNKNOWN string
 *     →`running` (never silently promoted to a terminal success) with a `ctx.logger.warn`, and an
 *     absent/empty phase (freshly submitted, controller hasn't reconciled it yet) → `pending` — this
 *     last mapping is this plugin's own inference, since the assumed enum names no "not yet set"
 *     value explicitly.
 *  6. `status.progress` — assumed to be a human string of the form `"N/M"` (steps completed / total),
 *     parsed into a `0..1` fraction when it matches; falls back to a phase-based estimate (pending=0,
 *     running=0.5, terminal=1) when absent or unparsable. NOT verified against a live instance.
 *  7. Auth — `Authorization: Bearer <token>` from `ctx.secrets` (or `config.token` for
 *     tests/fixtures only, mirroring `@scp/plugin-argocd`'s `ArgoCdConfig.token`).
 *  8. `commitSha` convention (`observe()` only) — read from the workflow's own
 *     `metadata.labels["commanderscp.io/commit-sha"]` label, ONLY when present. Argo Workflows has
 *     no native notion of "the commit this run is for"; this is a convention a submitting caller
 *     (e.g. a pipeline that sets `submitOptions.labels` on its own trigger) may choose to follow.
 *     Never fabricated — omitted entirely when the label is absent.
 *  9. Cron workflows — `GET /api/v1/cron-workflows/{namespace}` →
 *     `{ items: [{ metadata, status?: { lastScheduledTime? } }] }`. Typed below
 *     (`ArgoCronWorkflow`/`ArgoCronWorkflowList`) for a live-verification pass to have the shape
 *     ready, but DELIBERATELY UNUSED by every verb in this increment — none of observe/trigger/
 *     status/abort's specified behavior calls for it. Reserved for a possible future increment (a
 *     CronWorkflow can spawn, complete, and be pruned by TTL GC between two `observe()` polls,
 *     which the current Workflow-list-only `observe()` would miss entirely) — do not wire it up
 *     without re-confirming this shape against a live instance first.
 * ================================================================================================
 *
 * IDEMPOTENCY (mirrors `@scp/plugin-argocd` exactly): `TriggerIntent.idempotencyKey` must dedup to
 * the SAME `ExternalRunRef` without re-submitting the workflow, and the mapping must survive a
 * subprocess-host restart — so it is kept in a small file-backed cache, write-to-temp-then-rename
 * for crash safety, identical in shape to `@scp/plugin-argocd`'s and `@scp/plugin-fake-executor`'s.
 *
 * EGRESS / IN-CLUSTER REACH: this plugin is a TENANT-CONFIGURABLE executor, not an operator-plane
 * module — it is deliberately absent from `subprocess-entry.ts`'s `OPERATOR_PLANE_MODULES`. An
 * operator who needs to coordinate an in-cluster (private ClusterIP) Argo Workflows server reaches
 * it through ADR-0003's two-layer model instead: the execution-system object's own
 * `allowInternalEgress` declaration, gated by the deployment-wide `SCP_INTERNAL_EGRESS_HOSTS`
 * allowlist — see `docs/adr/0003-internal-egress-for-execution-systems.md`. Adding this module to
 * `OPERATOR_PLANE_MODULES` instead would be a security regression (ADR-0003 alternative 4,
 * rejected): it grants internal egress to the whole module class regardless of a tenant's declared
 * intent.
 */

export interface ArgoWorkflowsConfig {
  /** Argo Workflows API server base URL, e.g. `https://argo-workflows.example.com`. */
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

// -----------------------------------------------------------------------------------------
// Dedup + abort-tracking cache — see module doc assumptions #4/#7. Same write-to-temp+rename
// persistence shape as `@scp/plugin-argocd`/`@scp/plugin-fake-executor`, for the identical reason:
// a subprocess-host restart mid-wave must not lose the mapping. `normalize` backfills
// `abortedNames` for a state file written before that field existed.
// -----------------------------------------------------------------------------------------

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

/**
 * Assumption #5 — the phase-mapping table. An UNKNOWN phase string must NEVER silently become
 * `succeeded`: it maps to `running` (still in flight, as far as this plugin honestly knows) and is
 * logged so an operator can see a real API drift rather than a silently-wrong verdict. An absent
 * phase (a workflow this plugin's own `trigger()` just submitted, before Argo's controller has
 * reconciled it) maps to `pending` — this plugin's own inference, not part of the assumed enum.
 */
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

// -----------------------------------------------------------------------------------------
// ExecutorPlugin
// -----------------------------------------------------------------------------------------

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

/**
 * `stateRef` = `${uid}${REF_DELIMITER}${phase}` — the workflow's own identity plus its CURRENT
 * phase (assumption #5). This is what lets an idle re-list of an unchanged workflow (same uid, same
 * phase, polled again with the object's `startedAt`/`finishedAt` unchanged) collapse to one event
 * downstream instead of minting a new row every poll — the exact property `@scp/plugin-argocd`'s
 * `syncStateRef` documents (measured 26k spurious rows/day without it on a 61-application ArgoCD
 * instance). A workflow whose phase genuinely changes (Running -> Succeeded) gets a DIFFERENT
 * `stateRef`, so a genuine transition still produces a distinguishable event.
 */
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

/**
 * D12's `rollout` capability field is DELIBERATELY OMITTED here — never set it, even to
 * `{ authority: "verified", targetClasses: [] }`. Argo Workflows runs TESTS on behalf of a
 * coordinated pipeline; it has no notion of a progressive rollout at all, so declaring ANY
 * `RolloutCapability` (even a nominally empty one) would misrepresent this executor as having an
 * opinion on rollout authority it structurally cannot have. `ExecutorCapabilities.rollout`'s own
 * doc comment in `@scp/plugin-api` is explicit: absent means "declares no rollout authority" and
 * must never read as a claim. If a future increment adds progressive-delivery awareness to Argo
 * Workflows itself, that is a deliberate, reviewed addition — not a default this field should ever
 * silently acquire by someone "completing" the capability list.
 */
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

/**
 * ASSUMPTION #10 — CronWorkflow WRITE. `POST /api/v1/cron-workflows/{namespace}` creates and
 * `PUT /api/v1/cron-workflows/{namespace}/{name}` updates, body `{ cronWorkflow: {...} }`;
 * `DELETE .../{name}` removes. Cadence is a cron EXPRESSION (`spec.schedule`), so a seconds
 * cadence is rendered to the coarsest expression that fits.
 *
 * WIRED AGAINST AN ASSUMED SHAPE, KNOWINGLY. Assumption #9 above says not to wire the cron
 * endpoints without re-confirming against a live instance; that check has not been possible here
 * (this suite never touches the network) and the owner accepted the risk deliberately, so it is
 * recorded rather than implied. The mitigation is that the assumed request shape is PINNED BY
 * TESTS: a real API drift fails them loudly instead of silently declaring a probe nobody runs.
 * Re-confirm against a live instance before trusting this in an estate that matters.
 */
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
