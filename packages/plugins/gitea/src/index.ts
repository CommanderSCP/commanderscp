import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  AbortResult,
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
import {
  createExecutorPluginFromAdapter,
  normalizeCorrelation,
  type GitProviderAdapter,
  type GitProviderEventHint
} from "@scp/git-provider-core";

/**
 * `@scp/plugin-gitea` — the Gitea `ExecutorPlugin` (M15.1b, ADR-0014 follow-on to M15.1a's
 * `@scp/git-provider-core` extraction). This package is a **thin Gitea ADAPTER** over the same
 * provider-neutral core the github plugin is built on: everything provider-neutral (the
 * idempotency/dedup cache, the observe cursor protocol, correlation-hint normalization, the
 * dispatch-then-persist trigger dance, the `ExecutorPlugin` assembly) lives in
 * `@scp/git-provider-core`; everything Gitea-wire-specific lives here as a `GitProviderAdapter`.
 * The github adapter (`@scp/plugin-github`'s `githubAdapter`) is the reference implementation.
 *
 * GITEA-SPECIFIC WIRE FACTS (how this differs from github — the whole reason a separate adapter
 * exists rather than reusing githubAdapter):
 *   - AUTH is a Personal Access Token, sent `Authorization: token <PAT>` — NOT github's App-JWT →
 *     installation-token exchange. There is no JWT flow at all here.
 *   - BASE REST URL is `<instanceUrl>/api/v1` (a self-hosted instance host, not a fixed api.github.com).
 *   - Gitea Actions is deliberately GitHub-Actions-COMPATIBLE (`.gitea/workflows/*.yml`,
 *     `workflow_dispatch`), so the trigger(dispatch) → observe(runs) → status-phase logic MIRRORS
 *     github and REUSES the core; only the endpoint paths + auth header differ. See the
 *     LOAD-BEARING ASSUMPTION note below.
 *   - Webhook signatures are a BARE-HEX HMAC-SHA256 in `X-Gitea-Signature` (NO `sha256=` prefix —
 *     the one place neither github's verifier nor the server's generic `sha256=<hex>` verifier
 *     works), so this package ships its own verifier (`verifyGiteaWebhookSignature`).
 *   - Gitea run status is a SINGLE enum (`success`/`failure`/`cancelled`/…) that already encodes
 *     the conclusion, unlike github's split `status` + `conclusion` — so `mapGiteaStatusToPhase`
 *     switches on one field (passing `conclusion = null` through the core's two-arg hook shape).
 *   - observe() additionally surfaces PACKAGE/OCI pushes (Gitea's package registry), emitting
 *     `ExecutorEvent.correlation.artifactDigest` for image pushes — the registry-promotion
 *     correlation key (ADR-0013). github never populated `artifactDigest`; this is new here.
 *
 * LOAD-BEARING ASSUMPTION — CONFIRM WITH A LIVE DRILL (honest coverage note, mirrors the github
 * package's own "nightly live-sandbox proves wire fidelity" split): every request/response shape
 * below is exercised deterministically against `nock` fixtures built from Gitea's PUBLISHED REST
 * API docs (Swagger) — this package never talks to a real Gitea instance in its own suite. The
 * shapes marked `ASSUMED (Gitea Actions)` inline are the ones whose exact field names/paths are
 * version-dependent in Gitea and MUST be confirmed against a real running Gitea before this
 * executor is trusted in production: specifically (1) the workflow-dispatch path returning 204,
 * (2) the runs-list response carrying a `workflow_runs[]` array, and (3) the single-run status GET.
 * The auth header, `/api/v1` base, packages-list shape, and bare-hex webhook signature are NOT
 * assumptions — those are documented and stable. Nothing here is fabricated; where a shape is
 * uncertain it is flagged as an assumption rather than invented.
 */

// -------------------------------------------------------------------------------------------
// Config + auth (Personal Access Token — `Authorization: token <PAT>`)
// -------------------------------------------------------------------------------------------

export interface GiteaConfig {
  /** The Gitea instance base URL, e.g. `https://gitea.example.com` (NO trailing slash, NO
   *  `/api/v1` — that suffix is appended by `apiBase()`). */
  baseUrl: string;
  owner: string;
  repo: string;
  /** `SecretsAccessor` key holding the Personal Access Token. */
  tokenSecretKey?: string;
  /** Fallback for tests/fixtures only — a plaintext PAT in config (never used in production; real
   *  deployments must use `tokenSecretKey`). */
  tokenPlaintext?: string;
  /** Default workflow file name (e.g. `deploy.yml`, a file under `.gitea/workflows/`) used when a
   *  `TriggerIntent` doesn't specify `parameters.workflowId`. */
  defaultWorkflowId?: string;
  statePath?: string;
}

function asConfig(config: unknown): GiteaConfig {
  const c = config as Partial<GiteaConfig> | undefined;
  if (!c?.baseUrl || !c.owner || !c.repo) {
    throw new Error("gitea: config.baseUrl, config.owner, and config.repo are required");
  }
  return {
    baseUrl: c.baseUrl.replace(/\/$/, ""),
    owner: c.owner,
    repo: c.repo,
    tokenSecretKey: c.tokenSecretKey,
    tokenPlaintext: c.tokenPlaintext,
    defaultWorkflowId: c.defaultWorkflowId,
    statePath: c.statePath
  };
}

/** REST base for the adapter's own calls: `<instance>/api/v1` (documented, stable). */
function apiBase(config: GiteaConfig): string {
  return `${config.baseUrl}/api/v1`;
}

async function resolveToken(ctx: PluginContext, config: GiteaConfig): Promise<string> {
  if (config.tokenPlaintext) return config.tokenPlaintext;
  if (config.tokenSecretKey) {
    const token = await ctx.secrets.get(config.tokenSecretKey);
    if (token) return token;
  }
  throw new Error("gitea: no token configured (config.tokenSecretKey resolved nothing)");
}

/** Adapter `authorize` hook: the headers every authenticated Gitea REST call carries — the
 *  `token <PAT>` scheme Gitea uses (NOT `Bearer`), plus JSON accept/content-type. */
async function giteaApiHeaders(
  ctx: PluginContext,
  config: GiteaConfig
): Promise<Record<string, string>> {
  const token = await resolveToken(ctx, config);
  return {
    authorization: `token ${token}`,
    accept: "application/json",
    "content-type": "application/json"
  };
}

async function api(
  ctx: PluginContext,
  config: GiteaConfig,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const headers = await giteaApiHeaders(ctx, config);
  const response = await ctx.http.request({
    method,
    url: `${apiBase(config)}${path}`,
    headers,
    body
  });
  return { status: response.status, body: response.body };
}

// -------------------------------------------------------------------------------------------
// Webhook signature verification (fail-closed) — Gitea's BARE-HEX X-Gitea-Signature.
// -------------------------------------------------------------------------------------------

/** Gitea signs webhook deliveries as an HMAC-SHA256 of the RAW request body, emitted as a **bare
 *  hex string** in `X-Gitea-Signature` — with NO `sha256=` prefix (this is the concrete reason the
 *  github verifier and the server's generic `sha256=<hex>` verifier both fail against Gitea, and
 *  why this dedicated verifier exists). Verification MUST run against the raw bytes, never a
 *  re-serialized JSON round-trip (whitespace/key-order differences break the HMAC). `timingSafeEqual`
 *  throws on a length mismatch, which we treat as "signature mismatch" — fail-closed either way. */
export function verifyGiteaWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader) return false;
  // Bare hex only — a value carrying github's `sha256=` prefix is NOT a valid Gitea signature and
  // is rejected (defensive: this verifier is Gitea-specific by contract).
  if (!/^[0-9a-f]+$/i.test(signatureHeader)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(signatureHeader, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;
  try {
    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

/** Gitea's populated shape of the provider-neutral `GitProviderEventHint`. */
export type GiteaEventHint = GitProviderEventHint;

/**
 * Maps a Gitea webhook event name + payload to a correlation hint (null = ignore). Gitea's webhook
 * payloads are largely GitHub-shaped for the git events (`push`/`pull_request`/`release`), with its
 * own `package` event for registry pushes. Only the events a `source_mappings` correlation cares
 * about are recognized; anything else yields `null` (ignored, not an error).
 *
 * `package` (Gitea's registry publish event) carries `package.name`/`package.version`/`package.type`;
 * for a container package a `sha256:`-shaped version IS the artifact digest (see `pollPackages`).
 */
export function mapGiteaWebhookEventToHint(
  eventName: string,
  payload: unknown
): GiteaEventHint | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  const repository = p.repository as { full_name?: string } | undefined;
  const repo = repository?.full_name;

  switch (eventName) {
    case "push": {
      const headCommit = p.head_commit as { id?: string } | undefined;
      return {
        repo,
        commitSha: headCommit?.id ?? (p.after as string | undefined),
        correlationKey: p.ref as string | undefined
      };
    }
    case "pull_request": {
      const pr = p.pull_request as
        | { head?: { sha?: string }; number?: number }
        | undefined;
      // Gitea nests the PR number at the top level (`p.number`) as well as inside `pull_request`;
      // prefer the object's own number, falling back to the top-level one.
      const number = pr?.number ?? (p.number as number | undefined);
      return {
        repo,
        commitSha: pr?.head?.sha,
        correlationKey: number !== undefined ? `pr-${number}` : undefined
      };
    }
    case "release": {
      const release = p.release as { tag_name?: string; target_commitish?: string } | undefined;
      return { repo, correlationKey: release?.tag_name, path: release?.target_commitish };
    }
    case "package": {
      const pkg = p.package as
        | { name?: string; version?: string; type?: string }
        | undefined;
      if (!pkg?.name) return null;
      const version = pkg.version;
      const isDigest = typeof version === "string" && version.startsWith("sha256:");
      return {
        repo,
        artifactDigest: isDigest ? version : undefined,
        correlationKey: version ? `${pkg.name}:${version}` : pkg.name
      };
    }
    default:
      return null;
  }
}

// -------------------------------------------------------------------------------------------
// ExecutorPlugin — Gitea-specific hooks. The dedup cache, cursor protocol, correlation
// normalization, and verb assembly are provided by `@scp/git-provider-core`.
// -------------------------------------------------------------------------------------------

/**
 * ASSUMED (Gitea Actions) — a Gitea Actions run as returned by the runs-list / single-run
 * endpoints. Gitea aims for GitHub-Actions compatibility, but the EXACT field set is version-
 * dependent; the load-bearing fields this adapter reads are `id`, `status`, `head_sha`,
 * `html_url`, `created_at`. Gitea's run `status` is a SINGLE enum (no separate `conclusion`).
 */
interface GiteaActionRun {
  id: number;
  /** unknown|waiting|running|success|failure|cancelled|skipped|blocked (Gitea ActionRunStatus). */
  status: string;
  html_url?: string;
  head_sha?: string;
  created_at?: string;
}

/** Adapter `pollCommits` hook: recent commits (approximates a `push` webhook for the polling
 *  fallback). `GET /repos/{owner}/{repo}/commits` is documented + stable in Gitea's API. Silently
 *  skips a non-2xx resource (the lenient observe posture, same as github's adapter). */
async function pollCommits(ctx: PluginContext, sinceIso?: string): Promise<ExecutorEvent[]> {
  const config = asConfig(ctx.config);
  const events: ExecutorEvent[] = [];
  // Gitea's /commits does not accept github's `since` param; we fetch the default page and filter
  // client-side by the commit's own author date against the watermark.
  const { status, body } = await api(
    ctx,
    config,
    "GET",
    `/repos/${config.owner}/${config.repo}/commits`
  );
  if (status >= 200 && status < 300) {
    const commits = (body as Array<{ sha: string; commit?: { author?: { date?: string } } }>) ?? [];
    for (const commit of commits) {
      const occurredAt = commit.commit?.author?.date ?? new Date().toISOString();
      if (sinceIso && new Date(occurredAt).getTime() <= new Date(sinceIso).getTime()) continue;
      events.push({
        kind: "push",
        occurredAt,
        correlation: normalizeCorrelation({
          repo: `${config.owner}/${config.repo}`,
          commitSha: commit.sha,
          correlationKey: "refs/heads/*"
        }),
        raw: commit
      });
    }
  }
  return events;
}

/** Adapter `pollRuns` hook: recent Gitea Actions runs (approximates a `workflow_run` webhook).
 *  ASSUMED (Gitea Actions): the runs-list endpoint + `workflow_runs[]` response shape — see the
 *  `GiteaActionRun` note. */
async function pollRuns(ctx: PluginContext, sinceIso?: string): Promise<ExecutorEvent[]> {
  const config = asConfig(ctx.config);
  const events: ExecutorEvent[] = [];
  const { status, body } = await api(
    ctx,
    config,
    "GET",
    `/repos/${config.owner}/${config.repo}/actions/runs`
  );
  if (status >= 200 && status < 300) {
    const runs = (body as { workflow_runs?: GiteaActionRun[] }).workflow_runs ?? [];
    for (const run of runs) {
      if (
        sinceIso &&
        run.created_at &&
        new Date(run.created_at).getTime() <= new Date(sinceIso).getTime()
      )
        continue;
      events.push({
        kind: "workflow_run",
        occurredAt: run.created_at ?? new Date().toISOString(),
        correlation: normalizeCorrelation({
          repo: `${config.owner}/${config.repo}`,
          commitSha: run.head_sha,
          correlationKey: `run-${run.id}`
        }),
        raw: run
      });
    }
  }
  return events;
}

/**
 * ASSUMED shape is minimal here — a Gitea package (registry) list item. `GET /packages/{owner}` is
 * documented + stable; the fields read (`name`, `version`, `type`, `created_at`, `repository`) are
 * from the published Package model. For a container package a `sha256:`-shaped `version` IS the
 * OCI manifest digest — that (and ONLY that) is surfaced as `artifactDigest`; a tag-shaped version
 * is surfaced as a `correlationKey` and `artifactDigest` is left undefined (never fabricated).
 */
interface GiteaPackage {
  type?: string;
  name?: string;
  version?: string;
  created_at?: string;
  html_url?: string;
  repository?: { full_name?: string } | null;
}

/** observe() extension unique to gitea (github had no equivalent): recent package/OCI pushes from
 *  Gitea's package registry, emitting `correlation.artifactDigest` for digest-versioned pushes —
 *  the registry-promotion correlation key (ADR-0013). Filed as a `custom`-kind event (the closed
 *  `ExecutorEventKind` vocab has no `package` member; `custom` is its designated catch-all). */
async function pollPackages(ctx: PluginContext, sinceIso?: string): Promise<ExecutorEvent[]> {
  const config = asConfig(ctx.config);
  const events: ExecutorEvent[] = [];
  const { status, body } = await api(ctx, config, "GET", `/packages/${config.owner}`);
  if (status >= 200 && status < 300) {
    const packages = (body as GiteaPackage[]) ?? [];
    for (const pkg of packages) {
      if (!pkg.name) continue;
      const occurredAt = pkg.created_at ?? new Date().toISOString();
      if (sinceIso && new Date(occurredAt).getTime() <= new Date(sinceIso).getTime()) continue;
      const version = pkg.version;
      const isDigest = typeof version === "string" && version.startsWith("sha256:");
      events.push({
        kind: "custom",
        occurredAt,
        correlation: normalizeCorrelation({
          repo: pkg.repository?.full_name ?? `${config.owner}/${config.repo}`,
          artifactDigest: isDigest ? version : undefined,
          correlationKey: version ? `${pkg.name}:${version}` : pkg.name
        }),
        raw: pkg
      });
    }
  }
  return events;
}

/** Polls the runs list for the newest run created at/after `dispatchedAtMs` — the correlation step
 *  the workflow-dispatch API needs (dispatch returns 204 with no run id, same as github). Bounded
 *  retries, not an unbounded poll; `status()` re-attempts correlation on later reconcile ticks if
 *  this doesn't resolve synchronously. ASSUMED (Gitea Actions): runs-list shape. */
async function correlateDispatchedRun(
  ctx: PluginContext,
  config: GiteaConfig,
  dispatchedAtMs: number
): Promise<GiteaActionRun | undefined> {
  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { status, body } = await api(
      ctx,
      config,
      "GET",
      `/repos/${config.owner}/${config.repo}/actions/runs`
    );
    if (status >= 200 && status < 300) {
      const runs = (body as { workflow_runs?: GiteaActionRun[] }).workflow_runs ?? [];
      const match = runs.find(
        (r) => r.created_at && new Date(r.created_at).getTime() >= dispatchedAtMs - 5_000
      );
      if (match) return match;
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return undefined;
}

/** Adapter `triggerCI` hook — fires Gitea's workflow_dispatch and returns a run ref, including the
 *  runs-list correlation step (dispatch returns 204 with no run id). The idempotency dedup +
 *  persistence wrapping this lives in `@scp/git-provider-core`; this hook only ever runs for a
 *  genuinely new key. ASSUMED (Gitea Actions): the dispatch endpoint path + 204 response. */
async function triggerCI(ctx: PluginContext, intent: TriggerIntent): Promise<ExternalRunRef> {
  const config = asConfig(ctx.config);
  const markerKey = intent.idempotencyKey ?? randomUUID();
  const workflowId =
    (intent.parameters?.workflowId as string | undefined) ?? config.defaultWorkflowId;
  if (!workflowId) {
    throw new Error(
      "gitea trigger: no workflowId (intent.parameters.workflowId or config.defaultWorkflowId)"
    );
  }
  const ref = (intent.parameters?.ref as string | undefined) ?? "main";
  const dispatchedAtMs = Date.now();
  const { status } = await api(
    ctx,
    config,
    "POST",
    `/repos/${config.owner}/${config.repo}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
    { ref, inputs: intent.parameters?.inputs ?? {} }
  );
  if (status < 200 || status >= 300) {
    throw new Error(`gitea trigger: workflow_dispatch returned HTTP ${status}`);
  }

  const run = await correlateDispatchedRun(ctx, config, dispatchedAtMs);
  const externalId = run ? `action_run::${run.id}` : `workflow_dispatch::${markerKey}`;
  ctx.logger.info("gitea: workflow_dispatch triggered", { workflowId, ref, correlatedRunId: run?.id });
  return { externalId, url: run?.html_url };
}

/** Gitea's SINGLE run-status enum → normalized phase. `conclusion` is unused (github's split model
 *  passes it; Gitea folds it into `status`), kept for the core's two-arg `mapStatusToPhase` shape. */
function mapGiteaStatusToPhase(status: string, _conclusion: string | null): ExecutionPhase {
  switch (status) {
    case "success":
      return "succeeded";
    case "cancelled":
      return "aborted";
    case "failure":
    case "skipped":
      return "failed";
    case "waiting":
    case "running":
    case "blocked":
      return "running";
    default:
      return "running"; // unknown / not-yet-reported: honestly "running", never a crash
  }
}

/** Adapter `getStatus` hook. ASSUMED (Gitea Actions): the single-run GET path + `status` field. */
async function getStatus(ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus> {
  const config = asConfig(ctx.config);
  if (!ref.externalId.startsWith("action_run::")) {
    return { phase: "pending", detail: "gitea: run not yet correlated to an action run" };
  }
  const runId = ref.externalId.slice("action_run::".length);
  const { status: httpStatus, body } = await api(
    ctx,
    config,
    "GET",
    `/repos/${config.owner}/${config.repo}/actions/runs/${runId}`
  );
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new Error(`gitea status: server returned HTTP ${httpStatus}`);
  }
  const run = body as GiteaActionRun;
  const phase = mapGiteaStatusToPhase(run.status, null);
  return {
    phase,
    detail: `status=${run.status}`,
    stateRef: run.head_sha,
    progress: phase === "running" ? 0.5 : 1
  };
}

/** Adapter `abortRun` hook. ASSUMED (Gitea Actions): the run-cancel endpoint path. */
async function abortRun(ctx: PluginContext, ref: ExternalRunRef): Promise<AbortResult> {
  const config = asConfig(ctx.config);
  if (!ref.externalId.startsWith("action_run::")) {
    return { aborted: false, detail: "gitea: no correlated run to cancel" };
  }
  const runId = ref.externalId.slice("action_run::".length);
  const { status } = await api(
    ctx,
    config,
    "POST",
    `/repos/${config.owner}/${config.repo}/actions/runs/${runId}/cancel`
  );
  return status >= 200 && status < 300
    ? { aborted: true }
    : { aborted: false, detail: `gitea abort: server returned HTTP ${status}` };
}

function giteaCapabilities(): ExecutorCapabilities {
  return {
    supportsObserve: true,
    supportsTrigger: true,
    supportsAbort: true,
    triggerKinds: ["workflow_dispatch"]
  };
}

/** observe() for gitea layers package/OCI pushes on top of the core's commits+runs poll — the core
 *  factory's built-in observe only calls `pollCommits`+`pollRuns`, so we assemble the plugin from
 *  the adapter and then WRAP `observe` to also fold in `pollPackages`. Everything else (trigger/
 *  status/abort/describeCapabilities) is the core's assembly untouched. */
export const giteaAdapter: GitProviderAdapter = {
  sourceKind: "gitea",
  authorize: (ctx) => giteaApiHeaders(ctx, asConfig(ctx.config)),
  baseUrl: (ctx) => apiBase(asConfig(ctx.config)),
  resolveStatePath: (ctx) => asConfig(ctx.config).statePath,
  triggerCI,
  pollCommits,
  pollRuns,
  getStatus,
  abortRun,
  capabilities: giteaCapabilities,
  verifyWebhook: verifyGiteaWebhookSignature,
  mapEvent: mapGiteaWebhookEventToHint,
  mapStatusToPhase: mapGiteaStatusToPhase
};

const baseGiteaPlugin: ExecutorPlugin = createExecutorPluginFromAdapter(giteaAdapter);

export const giteaExecutorPlugin: ExecutorPlugin = {
  ...baseGiteaPlugin,
  // Extend the core's commits+runs observe with gitea's package-push poll (the artifactDigest
  // source). The core observe watermark is an ISO-8601 token; pollPackages honors the same one.
  async observe(ctx, since) {
    const [core, packages] = await Promise.all([
      baseGiteaPlugin.observe(ctx, since),
      pollPackages(ctx, since?.token)
    ]);
    return [...core, ...packages];
  }
};

export function createGiteaExecutorPlugin(): ExecutorPlugin {
  return giteaExecutorPlugin;
}

// -------------------------------------------------------------------------------------------
// DiscoveryPlugin (M15.3a — port of github's discover(); DESIGN §11/§12 — "repo/topology scan
// proposing Service/Component objects and source_mappings"; NEVER auto-commits, only proposes).
// Reuses this package's own `GiteaConfig`/`api()` — Gitea's contents API is GitHub-COMPATIBLE at
// `<baseUrl>/api/v1/repos/{owner}/{repo}/contents/{path}` (same response entry shape), so the
// marker-file topology walk is identical to github's; only the `sourceKind` differs. The discovered
// `sourceMapping.sourceKind` is `'gitea'` — matching the gitea EXECUTOR's `source_kind` (the
// `giteaAdapter.sourceKind` above) so an accepted component's `source_mappings` row actually
// correlates observed gitea events (push/run/package). This closes the observe-correlation gap for
// gitea: without a gitea-kinded source_mapping, pulled gitea events correlate against nothing.
//
// NOTE (follow-up): github's discover omits `sourceMapping.type`, so it defaults to `'configuration'`
// server-side; this increment keeps that same default for gitea rather than inferring `'image'` for
// container-registry-backed components. Inferring type from the marker set (e.g. a Dockerfile → an
// image source) is a deliberate LATER increment. Generalizing this walk into `@scp/git-provider-core`
// (a `discover` hook on `GitProviderAdapter`) is also deferred until a second git provider needs it —
// two impls (github + gitea) now exist, so that extraction is the natural next step, but it is NOT
// this PR's scope.
// -------------------------------------------------------------------------------------------

/** A Gitea contents-API entry — GitHub-compatible shape (`name`/`path`/`type`). */
interface RepoContentEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

/** Heuristic component detection (identical to github's): a top-level directory containing one of
 *  these marker files is proposed as a Component; the repo root itself is always proposed as one
 *  Service. Deliberately simple (v1) — real topology detection is exactly what a human reviews
 *  before accepting a proposal. */
const COMPONENT_MARKER_FILES = ["package.json", "Dockerfile", "pom.xml", "go.mod", "Cargo.toml"];

async function discover(ctx: PluginContext): Promise<DiscoveryProposal> {
  const config = asConfig(ctx.config);
  const serviceUrn = `urn:scp:service:gitea:${config.owner}/${config.repo}`;
  const objects: DiscoveryProposal["objects"] = [
    {
      typeId: "service",
      name: config.repo,
      properties: { discoveredFrom: `gitea:${config.owner}/${config.repo}` }
    }
  ];
  const relationships: DiscoveryProposal["relationships"] = [];

  const { status, body } = await api(
    ctx,
    config,
    "GET",
    `/repos/${config.owner}/${config.repo}/contents/`
  );
  if (status >= 200 && status < 300) {
    const entries = body as RepoContentEntry[];
    for (const entry of entries) {
      if (entry.type !== "dir") continue;
      const { status: dirStatus, body: dirBody } = await api(
        ctx,
        config,
        "GET",
        `/repos/${config.owner}/${config.repo}/contents/${encodeURIComponent(entry.path)}`
      );
      if (dirStatus < 200 || dirStatus >= 300) continue;
      const dirEntries = dirBody as RepoContentEntry[];
      const hasMarker = dirEntries.some(
        (e) => e.type === "file" && COMPONENT_MARKER_FILES.includes(e.name)
      );
      if (!hasMarker) continue;

      const componentUrn = `urn:scp:component:gitea:${config.owner}/${config.repo}/${entry.path}`;
      objects.push({
        typeId: "component",
        name: entry.name,
        properties: {
          discoveredFrom: `gitea:${config.owner}/${config.repo}`,
          sourceMapping: {
            // MUST be 'gitea' (matches giteaAdapter.sourceKind) so imported components correlate
            // observed gitea events — the whole point of this discovery half (see section doc).
            sourceKind: "gitea",
            repoPattern: `${config.owner}/${config.repo}`,
            pathPattern: `${entry.path}/**`
          }
        }
      });
      relationships.push({ typeId: "part_of", fromUrn: componentUrn, toUrn: serviceUrn });
    }
  }

  return { objects, relationships };
}

export const giteaDiscoveryPlugin: DiscoveryPlugin = { discover };

export function createGiteaDiscoveryPlugin(): DiscoveryPlugin {
  return giteaDiscoveryPlugin;
}

// -------------------------------------------------------------------------------------------
// Manifest
// -------------------------------------------------------------------------------------------

const giteaConfigSchema = {
  type: "object",
  required: ["baseUrl", "owner", "repo"],
  properties: {
    baseUrl: { type: "string" },
    owner: { type: "string" },
    repo: { type: "string" },
    tokenSecretKey: { type: "string" },
    defaultWorkflowId: { type: "string" }
  }
};

export const executorManifest: PluginManifest = {
  id: "gitea",
  kind: "executor",
  version: "0.1.0",
  configSchema: giteaConfigSchema
};

/** The DiscoveryPlugin half — one npm package here provides two distinct plugin-host modules
 *  (`gitea`, `gitea-discovery`), mirroring github's `github`/`github-discovery` split (contract.ts's
 *  `PluginModule` doc explains why: one subprocess-hosted instance loads exactly one plugin kind). */
export const discoveryManifest: PluginManifest = {
  id: "gitea-discovery",
  kind: "discovery",
  version: "0.1.0",
  configSchema: giteaConfigSchema
};

/** Back-compat single `manifest` export (matches every other plugin's shape) — describes the
 *  executor half; `discoveryManifest` covers the discovery half. */
export const manifest = executorManifest;

export default giteaExecutorPlugin;
