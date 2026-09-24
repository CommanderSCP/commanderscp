import { randomUUID } from "node:crypto";
import { TriggerRefused, createFileBackedJsonCache } from "@scp/plugin-api";
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
import { authoredApplicationProblems, readAuthoringConfig } from "./authored-guard.js";

// The ONE validator, exported so the server applies the same rule to everything it authors.
export {
  AUTHORED_MANIFEST_KINDS,
  authoredApplicationProblems,
  readAuthoringConfig,
  type AuthoringConfig
} from "./authored-guard.js";

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
  /** M28.4 (ADR-0055): the execution-system's `properties.authoring` — carrier, project, namespace
   *  allowlist. Absent ⇒ this Argo CD is import-and-coordinate only and every authored Application
   *  is refused. Carried from the execution-system because the manifest declares it. */
  authoring?: unknown;
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
    executionSystemId: c.executionSystemId,
    authoring: c.authoring
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

// The LIVE Rollout manifest's `.spec`, read for the step TOTAL only (`status` above carries the
// current position). Same manifest body `fetchLiveRollout` already fetched — no second call.
interface LiveRolloutSpec {
  strategy?: { canary?: { steps?: unknown[] } };
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

/**
 * M28.4 fix round (ADR-0055 D10) — AN APPLICATION THAT MANAGES A ROLLOUT IS DONE ONLY WHEN THE
 * ROLLOUT IS. Argo CD reports a canary paused between steps as health `Suspended`, which the mapping
 * above calls `succeeded` (right for a suspended CronJob, wrong here): SCP would advance the next
 * wave, and finish the change, while the canary sat at step 1 of 3 — and a later change would then
 * re-author over a live canary. So a finished sync with a Rollout is `succeeded` only when the
 * Rollout is Healthy AND past its last step; Paused/Progressing is `running`; Degraded (which is
 * also what an aborted Rollout reports) is `failed`. Reading, never driving: nothing here asks the
 * Rollout to move.
 */
function gateOnRollout(
  phase: ExecutionPhase,
  node: ArgoResourceStatus,
  live: ObservedRollout | undefined
): ExecutionPhase {
  if (phase !== "succeeded") return phase;
  const nodeHealth = node.health?.status;
  const rolloutPhase =
    live?.phase ??
    (nodeHealth === "Suspended" ? "Paused" : nodeHealth === "Missing" ? "Degraded" : nodeHealth);
  if (rolloutPhase === "Degraded") return "failed";
  if (rolloutPhase !== "Healthy") return "running";
  if (live?.stepCount !== undefined && (live.step ?? 0) < live.stepCount) return "running";
  return "succeeded";
}

type ObservedRollout = {
  phase?: string;
  step?: number;
  weight?: number;
  message?: string;
  /** `spec.strategy.canary.steps.length` off the SAME manifest fetch. Absent (never 0, never
   *  guessed) when the strategy has no canary steps (blue-green) or the fetch failed — see
   *  `rolloutFromManifest`. pipeline-mockup-data.md §5.1. */
  stepCount?: number;
};

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
  let parsed: { status?: LiveRolloutStatus; spec?: LiveRolloutSpec };
  try {
    parsed = JSON.parse(manifestJson) as { status?: LiveRolloutStatus; spec?: LiveRolloutSpec };
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
  // pipeline-mockup-data.md §5.1: M off the SAME fetch, never a second call. `spec.strategy.canary`
  // is absent for a blue-green Rollout, so `steps` is undefined there — never 0, never guessed.
  const steps = parsed.spec?.strategy?.canary?.steps;
  if (Array.isArray(steps) && steps.length > 0) rollout.stepCount = steps.length;
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

/** The label on every Application SCP authors (`@scp/schemas` `SCP_AUTHORED_LABEL_KEY` — this
 *  package takes no `@scp/schemas` dependency, so the literal is duplicated and a server test pins
 *  the two equal). It is the ONLY licence to update an Application: one without it is somebody
 *  else's, and SCP refuses to overwrite it. */
export const SCP_AUTHORED_LABEL_KEY = "commanderscp.io/authored";
const SCP_AUTHORED_LABEL_VALUE = "true";

/** The trigger parameter carrying an SCP-authored Application (ADR-0055). */
export const AUTHORED_APPLICATION_PARAMETER = "scpAuthoredApplication";

function authoredLabelOf(doc: unknown): string | undefined {
  const labels = (doc as { metadata?: { labels?: Record<string, unknown> } } | undefined)?.metadata
    ?.labels;
  const v = labels?.[SCP_AUTHORED_LABEL_KEY];
  return typeof v === "string" ? v : undefined;
}

/**
 * M28.4 — THE CREATE HALF OF IMPORT-OR-CREATE (ADR-0055). Makes the Application SCP authored exist
 * with exactly the spec the server derived, then returns so `trigger` syncs it as it syncs any
 * other. This is a write to ARGO CD's API — its input, the desired state it is asked to sync — and
 * never to the cluster: the Rollout inside reaches Kubernetes only when Argo CD's own controller,
 * holding its own credentials, applies it. After that SCP reads the Rollout and nothing else
 * (ADR-0008 §3): no call in this file names a Rollout resource with a write verb, and the
 * recording stand-in in `@scp/plugin-testkit` fails any test in which one does.
 */
async function ensureAuthoredApplication(
  ctx: PluginContext,
  config: ArgoCdConfig,
  appName: string,
  doc: unknown,
  mode: "forward" | "rollback"
): Promise<void> {
  const d = doc as { kind?: unknown; metadata?: { name?: unknown } } | null;
  if (!d || typeof d !== "object" || d.kind !== "Application" || d.metadata?.name !== appName) {
    throw new TriggerRefused(
      `argocd trigger: the authored Application must be kind Application named '${appName}' (the trigger's targetRef)`
    );
  }
  if (authoredLabelOf(doc) !== SCP_AUTHORED_LABEL_VALUE) {
    throw new TriggerRefused(
      `argocd trigger: an authored Application must carry ${SCP_AUTHORED_LABEL_KEY}=${SCP_AUTHORED_LABEL_VALUE}`
    );
  }
  const identity = identityLabelsOf(doc);
  if (!identity) {
    throw new TriggerRefused(
      `argocd trigger: an authored Application must name its org, component and target (${AUTHORED_IDENTITY_LABELS.join(", ")})`
    );
  }
  // THE SECOND LAYER (ADR-0055 D9): whatever the server sent, it must be a carrier render the
  // operator's own declaration on this Argo CD permits — or nothing is written at all.
  const authoring = readAuthoringConfig(config.authoring);
  if (!authoring) {
    throw new TriggerRefused(
      "argocd trigger: this Argo CD declares no usable `authoring` (carrier, non-default project, " +
        "namespace allowlist), so it is import-and-coordinate only — refusing to author an Application"
    );
  }
  const problems = authoredApplicationProblems(doc, authoring);
  if (problems.length > 0) {
    throw new TriggerRefused(
      `argocd trigger: refusing to author Application '${appName}': ${problems.join("; ")}`
    );
  }
  const path = `/api/v1/applications/${encodeURIComponent(appName)}`;
  const current = await apiRequest(ctx, config, "GET", path);
  if (current.status === 404) {
    const created = await apiRequest(ctx, config, "POST", "/api/v1/applications", doc);
    if (created.status < 200 || created.status >= 300) {
      throw new Error(
        `argocd trigger: creating Application '${appName}' returned HTTP ${created.status}`
      );
    }
    ctx.logger.info("argocd: authored Application created", { appName });
    return;
  }
  if (current.status < 200 || current.status >= 300) {
    throw new Error(
      `argocd trigger: reading Application '${appName}' returned HTTP ${current.status}`
    );
  }
  if (authoredLabelOf(current.body) !== SCP_AUTHORED_LABEL_VALUE) {
    throw new TriggerRefused(
      `argocd trigger: Application '${appName}' already exists and was not authored by CommanderSCP ` +
        `(no ${SCP_AUTHORED_LABEL_KEY} label) — refusing to overwrite it. Import it instead, or name ` +
        `a different Application in the binding's externalRef.`
    );
  }
  // Authored by SCP is not enough: authored for THIS org, component and target. Two names that
  // collide (or a hand-edited externalRef) must never let one deployment overwrite another's.
  const existingIdentity = identityLabelsOf(current.body);
  if (
    !existingIdentity ||
    AUTHORED_IDENTITY_LABELS.some((k) => existingIdentity[k] !== identity[k])
  ) {
    // The message names the property, never the other identity: it is persisted on a Decision in
    // THIS org, and the Application may belong to another.
    throw new TriggerRefused(
      `argocd trigger: Application '${appName}' was authored by CommanderSCP for a different org, ` +
        `component or target — refusing to overwrite it`
    );
  }
  // A forward release WAITS for a canary still in flight: re-authoring now would replace a Rollout
  // Argo Rollouts is part way through with a new one, which is a promote-by-overwrite. Refused here
  // so `reconcile.ts` retries with backoff until the prior Rollout settles. A ROLLBACK does not
  // wait — undoing the in-flight release is its purpose.
  if (mode === "forward") {
    const node = findRolloutResource(current.body as ArgoApplication);
    const health = node?.health?.status;
    if (node && (health === "Suspended" || health === "Progressing")) {
      throw new Error(
        `argocd trigger: Application '${appName}' has a Rollout still in flight (health ${health}); ` +
          `the next release waits for it to settle rather than overwrite a live canary`
      );
    }
  }
  const updated = await apiRequest(ctx, config, "POST", "/api/v1/applications?upsert=true", doc);
  if (updated.status < 200 || updated.status >= 300) {
    throw new Error(
      `argocd trigger: updating Application '${appName}' returned HTTP ${updated.status}`
    );
  }
  ctx.logger.info("argocd: authored Application updated", { appName });
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

  const authored = intent.parameters?.[AUTHORED_APPLICATION_PARAMETER];
  if (authored !== undefined) {
    // A rollback of an authored target carries the PRIOR authored manifest (ADR-0055 D-c) and goes
    // through exactly the same door and the same checks; its revision is the carrier's, so the sync
    // below carries none.
    await ensureAuthoredApplication(
      ctx,
      config,
      appName,
      authored,
      intent.kind === "rollback" ? "rollback" : "forward"
    );
  }

  // CRITICAL #2 — fail closed on a rollback with no valid prior revision. NEVER fall through to an
  // empty-revision sync (which ArgoCD treats as "sync to the current target revision" — a no-op
  // re-apply of the very revision we're rolling back FROM, reported as success). An authored
  // rollback is exempt: it re-authored the prior manifest just above, so the sync applies THAT.
  if (intent.kind === "rollback" && authored === undefined) {
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
    authored !== undefined
      ? undefined
      : intent.kind === "rollback"
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
    result.phase = gateOnRollout(result.phase, rolloutRes, enriched);
    const settled = result.phase !== "pending" && result.phase !== "running";
    result.progress = settled ? 1 : 0.5;
  }
  // ADR-0055 D-c: an SCP-authored Application reports its own manifest as state, so the NEXT
  // trigger records it as `priorStateRef` and a rollback can re-author exactly it. JSON text, not an
  // object: `priorStateRef` is depth-bounded before it is stored, and an Application is deeper.
  if (authoredLabelOf(app) === SCP_AUTHORED_LABEL_VALUE) {
    result.stateRef = {
      revision: typeof result.stateRef === "string" ? result.stateRef : undefined,
      [PRIOR_AUTHORED_APPLICATION_KEY]: JSON.stringify(authoredDocumentOf(app))
    };
  }
  return result;
}

/** The status() `stateRef` key carrying an authored Application's own manifest (JSON text). */
export const PRIOR_AUTHORED_APPLICATION_KEY = "scpAuthoredApplicationJson";

/** The labels that make an authored Application THIS target's (server `AUTHORED_IDENTITY_LABELS`). */
export const AUTHORED_IDENTITY_LABELS = [
  "commanderscp.io/org",
  "commanderscp.io/component",
  "commanderscp.io/target"
] as const;

function identityLabelsOf(doc: unknown): Record<string, string> | undefined {
  const labels = (doc as { metadata?: { labels?: Record<string, unknown> } } | undefined)?.metadata
    ?.labels;
  const out: Record<string, string> = {};
  for (const k of AUTHORED_IDENTITY_LABELS) {
    const v = labels?.[k];
    if (typeof v !== "string" || v.length === 0) return undefined;
    out[k] = v;
  }
  return out;
}

/** What SCP authored, out of what Argo CD returns — Argo CD's own bookkeeping (`status`, uid,
 *  resourceVersion, managedFields, finalizers) is dropped so a re-author sends only SCP's fields. */
function authoredDocumentOf(app: ArgoApplication): Record<string, unknown> {
  const full = app as unknown as {
    apiVersion?: string;
    kind?: string;
    metadata: { name: string; labels?: unknown; annotations?: unknown };
    spec?: unknown;
  };
  return {
    apiVersion: full.apiVersion ?? "argoproj.io/v1alpha1",
    kind: full.kind ?? "Application",
    metadata: {
      name: full.metadata.name,
      ...(full.metadata.labels !== undefined ? { labels: full.metadata.labels } : {}),
      ...(full.metadata.annotations !== undefined ? { annotations: full.metadata.annotations } : {})
    },
    spec: full.spec
  };
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
    triggerKinds: ["sync", "rollback"],
    // D12 / ADR-0055: Argo Rollouts runs the canary and takes SCP's declared steps as trigger
    // parameters — the authored Application's Rollout. Never `authoritative`: SCP drives no step.
    rollout: { authority: "triggerParams", targetClasses: ["cluster"] }
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
      tokenSecretKey: { type: "string" },
      // M28.4 (ADR-0055): declared so a system-backed binding CARRIES the execution-system's
      // `properties.authoring` into this plugin (`executionSystemPluginConfig` copies only declared
      // keys) — the plugin's second layer checks every authored Application against it.
      authoring: { type: "object" }
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
