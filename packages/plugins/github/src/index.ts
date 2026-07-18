import { createHmac, createSign, randomUUID, timingSafeEqual } from "node:crypto";
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
 * `@scp/plugin-github` — the GitHub App `ExecutorPlugin` + `DiscoveryPlugin` (DESIGN.md §12,
 * BUILD_AND_TEST.md §8 M7 item 1): "the primary Discovery source... Auth: GitHub App, org-
 * installable, fine-grained permissions. Observe (push): webhooks. Observe (pull): polling
 * fallback. Trigger: workflow_dispatch/repository_dispatch of the org's OWN workflows. Status:
 * check runs + workflow conclusions. Discovery: repo/topology scan."
 *
 * ARCHITECTURE (M15.1a, ADR-0014): this package is a **thin GitHub ADAPTER** over the provider-
 * neutral `@scp/git-provider-core`. Everything provider-neutral (the idempotency/dedup cache, the
 * observe cursor protocol, correlation-hint normalization, the dispatch-then-persist trigger dance,
 * the `ExecutorPlugin` assembly) lives in the core; everything GitHub-specific (App-JWT→installation
 * -token auth, the base URL + REST wrapper, workflow_dispatch/repository_dispatch, X-Hub-Signature-
 * 256 webhook verification, GitHub event→hint mapping, the status/conclusion→phase map, the
 * `"github"` source_kind) lives here as a `GitProviderAdapter`. This package's EXTERNAL contract is
 * unchanged by the extraction: same `github`/`github-discovery` modules, same config schema, same
 * verbs, same observable behavior — proven by this package's unchanged `nock` suite.
 *
 * HONEST COVERAGE NOTE: every request/response shape below is exercised deterministically against
 * `nock` fixtures built from GitHub's published REST API docs — this package never talks to a
 * real github.com in its own test suite. The opt-in nightly live-sandbox job (a real GitHub App
 * installed against a real org) is what proves wire-format fidelity end to end; this PR's body
 * states that split explicitly.
 *
 * GITHUB API LIMITATION, DOCUMENTED (shapes this file's idempotency design):
 * `workflow_dispatch`/`repository_dispatch` return **204 No Content** — GitHub's API gives no run
 * id back synchronously, and a dispatched run carries no server-assigned field this plugin could
 * later use to prove "this run came from THIS dispatch call" (the workflow's own `client_payload`/
 * `inputs` aren't queryable via the runs-list API). This plugin's `trigger()` therefore: (1) dedups
 * on `idempotencyKey` FIRST, against its own persisted cache — so a retry never even calls GitHub
 * twice; (2) only for a genuinely NEW key, dispatches, then polls the workflow-runs list for the
 * newest run created after the dispatch call and adopts it as the correlated run. Under
 * concurrent dispatches of the SAME workflow this correlation step has a real, small race window —
 * a known, honest limitation of GitHub's public API surface, not something this plugin can close
 * unilaterally. The idempotency cache (file-backed when `ctx.config.statePath` is set, same
 * write-to-temp+rename pattern as `@scp/plugin-fake-executor`/`@scp/plugin-argocd`) is what makes
 * step (1) — the part `coordination/reconcile.ts`'s crash-safe retry actually depends on — solid
 * regardless.
 */

// -------------------------------------------------------------------------------------------
// Config + auth (GitHub App JWT -> installation access token)
// -------------------------------------------------------------------------------------------

export interface GithubConfig {
  appId: string;
  installationId: string;
  owner: string;
  repo: string;
  /** `SecretsAccessor` key holding the App's PEM-encoded RSA private key. */
  privateKeySecretKey?: string;
  /** Fallback for tests/fixtures only — a plaintext PEM key in config (never used in production;
   *  real deployments must use `privateKeySecretKey`). */
  privateKeyPem?: string;
  /** Default workflow file name (e.g. `deploy.yml`) used when a `TriggerIntent` doesn't specify
   *  `parameters.workflowId`. */
  defaultWorkflowId?: string;
  apiBaseUrl?: string; // override for tests; default https://api.github.com
  statePath?: string;
}

function asConfig(config: unknown): GithubConfig {
  const c = config as Partial<GithubConfig> | undefined;
  if (!c?.appId || !c.installationId || !c.owner || !c.repo) {
    throw new Error(
      "github: config.appId, config.installationId, config.owner, and config.repo are required"
    );
  }
  return {
    appId: c.appId,
    installationId: c.installationId,
    owner: c.owner,
    repo: c.repo,
    privateKeySecretKey: c.privateKeySecretKey,
    privateKeyPem: c.privateKeyPem,
    defaultWorkflowId: c.defaultWorkflowId,
    apiBaseUrl: (c.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, ""),
    statePath: c.statePath
  };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Hand-rolled RS256 JWT (no external JWT dependency — three base64url segments, one RSA-SHA256
 *  signature over `header.payload`; RFC 7519 needs nothing more than this for a GitHub App's App
 *  JWT). `iat`/`exp` are kept inside GitHub's documented ±60s clock-skew tolerance / 10-minute max
 *  lifetime. */
function signAppJwt(appId: string, privateKeyPem: string, now: () => number = Date.now): string {
  const nowSec = Math.floor(now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

interface InstallationTokenCacheEntry {
  token: string;
  expiresAtMs: number;
}

/** Module-level cache (per Node process = per subprocess plugin instance) keyed by
 *  `appId:installationId` — GitHub installation tokens are valid ~1 hour; refreshing on every API
 *  call would be both slow and needlessly noisy against GitHub's rate limits. */
const installationTokenCache = new Map<string, InstallationTokenCacheEntry>();

async function resolvePrivateKey(ctx: PluginContext, config: GithubConfig): Promise<string> {
  if (config.privateKeyPem) return config.privateKeyPem;
  if (config.privateKeySecretKey) {
    const key = await ctx.secrets.get(config.privateKeySecretKey);
    if (key) return key;
  }
  throw new Error(
    "github: no private key configured (config.privateKeySecretKey resolved nothing)"
  );
}

async function getInstallationToken(ctx: PluginContext, config: GithubConfig): Promise<string> {
  const cacheKey = `${config.appId}:${config.installationId}`;
  const cached = installationTokenCache.get(cacheKey);
  // Refresh a little before actual expiry so a call in flight never races token expiration.
  if (cached && cached.expiresAtMs - 60_000 > Date.now()) return cached.token;

  const privateKeyPem = await resolvePrivateKey(ctx, config);
  const jwt = signAppJwt(config.appId, privateKeyPem);
  const response = await ctx.http.request({
    method: "POST",
    url: `${config.apiBaseUrl}/app/installations/${config.installationId}/access_tokens`,
    headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json" }
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`github: installation token request returned HTTP ${response.status}`);
  }
  const body = response.body as { token: string; expires_at: string };
  installationTokenCache.set(cacheKey, {
    token: body.token,
    expiresAtMs: new Date(body.expires_at).getTime()
  });
  return body.token;
}

/** Adapter `authorize` hook: the request headers every authenticated GitHub REST call carries —
 *  the resolved installation-token bearer plus GitHub's `accept`/`content-type`. This is exactly
 *  what `api()` sends, so `GitProviderAdapter.authorize` faithfully describes the wire auth. */
async function githubApiHeaders(
  ctx: PluginContext,
  config: GithubConfig
): Promise<Record<string, string>> {
  const token = await getInstallationToken(ctx, config);
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json"
  };
}

async function api(
  ctx: PluginContext,
  config: GithubConfig,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  body?: unknown
): Promise<{ status: number; body: unknown }> {
  const headers = await githubApiHeaders(ctx, config);
  const response = await ctx.http.request({
    method,
    url: `${config.apiBaseUrl}${path}`,
    headers,
    body
  });
  return { status: response.status, body: response.body };
}

// -------------------------------------------------------------------------------------------
// Webhook signature verification (fail-closed) + push/poll-equivalent event mapping — exported so
// apps/server's change-sources webhook route can verify+parse GitHub deliveries with this exact
// package, and so `observe()`'s polling fallback produces STRUCTURALLY equivalent ExecutorEvents
// to what the webhook path produces for the same underlying activity (BUILD_AND_TEST.md §8 M7
// DoD: "poll-vs-push equivalence").
// -------------------------------------------------------------------------------------------

/** GitHub signs webhook deliveries as `sha256=<hex hmac>` over the RAW request body
 *  (`X-Hub-Signature-256`). Verification MUST run against the raw bytes, not a re-serialized
 *  JSON.parse/stringify round trip (whitespace/key-order differences would break the HMAC) — the
 *  caller (routes/change-sources.ts) is responsible for capturing the raw body before Fastify's
 *  JSON parser touches it. `timingSafeEqual` throws if the two buffers differ in length, which we
 *  treat the same as "signature mismatch" rather than letting it escape as an unhandled error —
 *  fail-closed either way. */
export function verifyGithubWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;
  try {
    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

/** GitHub's populated shape of the provider-neutral `GitProviderEventHint` (same fields; kept as a
 *  named export for back-compat with existing importers). */
export type GithubEventHint = GitProviderEventHint;

/** Shared by the webhook route AND `observe()`'s polling fallback (see module doc). Only the four
 *  event kinds DESIGN §12 names for GitHub (`push`, `pull_request`, `workflow_run`, `deployment`,
 *  `release`) are recognized; anything else yields `null` (ignored, not an error — GitHub sends
 *  many event types no `source_mappings` correlation cares about). */
export function mapGithubWebhookEventToHint(
  eventName: string,
  payload: unknown
): GithubEventHint | null {
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
      const pr = p.pull_request as { head?: { sha?: string }; number?: number } | undefined;
      return {
        repo,
        commitSha: pr?.head?.sha,
        correlationKey: pr?.number !== undefined ? `pr-${pr.number}` : undefined
      };
    }
    case "workflow_run": {
      const run = p.workflow_run as { head_sha?: string; id?: number } | undefined;
      return {
        repo,
        commitSha: run?.head_sha,
        correlationKey: run?.id !== undefined ? `run-${run.id}` : undefined
      };
    }
    case "deployment": {
      const deployment = p.deployment as { sha?: string; environment?: string } | undefined;
      return { repo, commitSha: deployment?.sha, correlationKey: deployment?.environment };
    }
    case "release": {
      const release = p.release as { tag_name?: string; target_commitish?: string } | undefined;
      return { repo, correlationKey: release?.tag_name, path: release?.target_commitish };
    }
    default:
      return null;
  }
}

// -------------------------------------------------------------------------------------------
// ExecutorPlugin — GitHub-specific hooks; the dedup cache, cursor protocol, correlation
// normalization, and verb assembly are provided by `@scp/git-provider-core` (see module doc).
// -------------------------------------------------------------------------------------------

interface WorkflowRun {
  id: number;
  status: string; // queued|in_progress|completed
  conclusion: string | null; // success|failure|cancelled|skipped|timed_out|action_required|neutral|stale|null
  html_url: string;
  head_sha?: string;
  created_at?: string;
  workflow_id?: number;
}

/** Adapter `pollCommits` hook: recent commits (approximates `push` webhook activity for the
 *  polling fallback). Silently skips (rather than throws for) a non-2xx resource — the documented,
 *  more-lenient observe posture. */
async function pollCommits(ctx: PluginContext, sinceIso?: string): Promise<ExecutorEvent[]> {
  const config = asConfig(ctx.config);
  const events: ExecutorEvent[] = [];
  const commitsPath = `/repos/${config.owner}/${config.repo}/commits${sinceIso ? `?since=${encodeURIComponent(sinceIso)}` : ""}`;
  const { status: commitsStatus, body: commitsBody } = await api(ctx, config, "GET", commitsPath);
  if (commitsStatus >= 200 && commitsStatus < 300) {
    const commits = commitsBody as Array<{ sha: string; commit?: { author?: { date?: string } } }>;
    for (const commit of commits) {
      const occurredAt = commit.commit?.author?.date ?? new Date().toISOString();
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

/** Adapter `pollRuns` hook: recent workflow runs (approximates `workflow_run` webhook activity). */
async function pollRuns(ctx: PluginContext, sinceIso?: string): Promise<ExecutorEvent[]> {
  const config = asConfig(ctx.config);
  const events: ExecutorEvent[] = [];
  const runsPath = `/repos/${config.owner}/${config.repo}/actions/runs`;
  const { status: runsStatus, body: runsBody } = await api(ctx, config, "GET", runsPath);
  if (runsStatus >= 200 && runsStatus < 300) {
    const runs = (runsBody as { workflow_runs?: WorkflowRun[] }).workflow_runs ?? [];
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

/** Polls the runs list for the newest run of `workflowId` created at/after `dispatchedAtMs` — the
 *  correlation step the module doc's GitHub API limitation note describes. Bounded retries (not
 *  an unbounded poll loop): GitHub typically materializes a run within a couple seconds of
 *  dispatch, and `coordination/reconcile.ts`'s own `status()` polling will keep checking on later
 *  reconcile ticks regardless — this only needs to succeed EVENTUALLY, not synchronously within
 *  `trigger()`'s own call budget, so a modest bounded attempt count here is a latency optimization,
 *  not a correctness requirement (a `trigger()` that returns with `externalId` still "pending
 *  correlation" is handled by returning a synthetic ref keyed on the idempotencyKey itself when
 *  correlation hasn't resolved yet — `status()` then re-attempts correlation on the next poll). */
async function correlateDispatchedRun(
  ctx: PluginContext,
  config: GithubConfig,
  workflowId: string,
  dispatchedAtMs: number
): Promise<WorkflowRun | undefined> {
  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const { status: httpStatus, body } = await api(
      ctx,
      config,
      "GET",
      `/repos/${config.owner}/${config.repo}/actions/workflows/${encodeURIComponent(workflowId)}/runs?event=workflow_dispatch&per_page=5`
    );
    if (httpStatus >= 200 && httpStatus < 300) {
      const runs = (body as { workflow_runs?: WorkflowRun[] }).workflow_runs ?? [];
      const match = runs.find(
        (r) => r.created_at && new Date(r.created_at).getTime() >= dispatchedAtMs - 5_000
      );
      if (match) return match;
    }
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return undefined;
}

/** Adapter `triggerCI` hook — fires GitHub's own automation and returns a run ref, INCLUDING the
 *  GitHub-specific correlation step (dispatch returns 204 with no run id, so poll the runs list for
 *  the newest matching run). The idempotency dedup + persistence that wraps this call lives in
 *  `@scp/git-provider-core`; this hook is only ever called for a genuinely new key, so it never
 *  reads/writes the dedup cache itself. `markerKey` is the opaque suffix for an uncorrelated ref
 *  (repository_dispatch, or a workflow_dispatch whose run hasn't materialized yet) — derived from
 *  the same `idempotencyKey` the core dedups on when one is present. */
async function triggerCI(ctx: PluginContext, intent: TriggerIntent): Promise<ExternalRunRef> {
  const config = asConfig(ctx.config);
  const markerKey = intent.idempotencyKey ?? randomUUID();

  const workflowId =
    (intent.parameters?.workflowId as string | undefined) ?? config.defaultWorkflowId;

  if (intent.kind === "custom" && intent.parameters?.eventType) {
    // repository_dispatch — no run correlation possible at all (it doesn't even map to a single
    // workflow); the externalId is a locally-minted marker, and status() for this ref always
    // reports "pending" (honest: repository_dispatch has no run-level status endpoint).
    const { status: httpStatus } = await api(
      ctx,
      config,
      "POST",
      `/repos/${config.owner}/${config.repo}/dispatches`,
      {
        event_type: intent.parameters.eventType,
        client_payload: intent.parameters.clientPayload ?? {}
      }
    );
    if (httpStatus < 200 || httpStatus >= 300) {
      throw new Error(`github trigger: repository_dispatch returned HTTP ${httpStatus}`);
    }
    return { externalId: `repository_dispatch::${markerKey}` };
  }

  if (!workflowId) {
    throw new Error(
      "github trigger: no workflowId (intent.parameters.workflowId or config.defaultWorkflowId)"
    );
  }
  const ref = (intent.parameters?.ref as string | undefined) ?? "main";
  const dispatchedAtMs = Date.now();
  const { status: httpStatus } = await api(
    ctx,
    config,
    "POST",
    `/repos/${config.owner}/${config.repo}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
    { ref, inputs: intent.parameters?.inputs ?? {} }
  );
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new Error(`github trigger: workflow_dispatch returned HTTP ${httpStatus}`);
  }

  const run = await correlateDispatchedRun(ctx, config, workflowId, dispatchedAtMs);
  const externalId = run ? `workflow_run::${run.id}` : `workflow_dispatch::${markerKey}`;
  const url = run?.html_url;
  ctx.logger.info("github: workflow_dispatch triggered", {
    workflowId,
    ref,
    correlatedRunId: run?.id
  });
  return { externalId, url };
}

function mapConclusionToPhase(status: string, conclusion: string | null): ExecutionPhase {
  if (status !== "completed") return "running";
  switch (conclusion) {
    case "success":
      return "succeeded";
    case "cancelled":
      return "aborted";
    default:
      return "failed"; // failure|timed_out|action_required|stale|neutral|null
  }
}

/** Adapter `getStatus` hook. */
async function getStatus(ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus> {
  const config = asConfig(ctx.config);
  if (!ref.externalId.startsWith("workflow_run::")) {
    // Uncorrelated dispatch (correlation hasn't resolved yet, or a repository_dispatch that never
    // correlates at all) — honestly "pending", never a hard error.
    return { phase: "pending", detail: "github: run not yet correlated to a workflow run" };
  }
  const runId = ref.externalId.slice("workflow_run::".length);
  const { status: httpStatus, body } = await api(
    ctx,
    config,
    "GET",
    `/repos/${config.owner}/${config.repo}/actions/runs/${runId}`
  );
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new Error(`github status: server returned HTTP ${httpStatus}`);
  }
  const run = body as WorkflowRun;
  const phase = mapConclusionToPhase(run.status, run.conclusion);
  return {
    phase,
    detail: `status=${run.status} conclusion=${run.conclusion ?? "none"}`,
    stateRef: run.head_sha,
    progress: phase === "running" ? 0.5 : 1
  };
}

/** Adapter `abortRun` hook. */
async function abortRun(ctx: PluginContext, ref: ExternalRunRef): Promise<AbortResult> {
  const config = asConfig(ctx.config);
  if (!ref.externalId.startsWith("workflow_run::")) {
    return { aborted: false, detail: "github: no correlated run to cancel" };
  }
  const runId = ref.externalId.slice("workflow_run::".length);
  const { status: httpStatus } = await api(
    ctx,
    config,
    "POST",
    `/repos/${config.owner}/${config.repo}/actions/runs/${runId}/cancel`
  );
  return httpStatus >= 200 && httpStatus < 300
    ? { aborted: true }
    : { aborted: false, detail: `github abort: server returned HTTP ${httpStatus}` };
}

function githubCapabilities(): ExecutorCapabilities {
  return {
    supportsObserve: true,
    supportsTrigger: true,
    supportsAbort: true,
    triggerKinds: ["workflow_dispatch", "custom"]
  };
}

/**
 * The GitHub `GitProviderAdapter` — every GitHub-wire-specific hook the provider-neutral
 * `@scp/git-provider-core` needs. The executor factory consumes `resolveStatePath`/`triggerCI`/
 * `pollCommits`/`pollRuns`/`getStatus`/`abortRun`/`capabilities`; `authorize`/`baseUrl` back this
 * adapter's own REST calls (`api()`), `verifyWebhook`/`mapEvent` back the server webhook path, and
 * `mapStatusToPhase` backs `getStatus`.
 */
export const githubAdapter: GitProviderAdapter = {
  sourceKind: "github",
  authorize: (ctx) => githubApiHeaders(ctx, asConfig(ctx.config)),
  baseUrl: (ctx) => asConfig(ctx.config).apiBaseUrl ?? "https://api.github.com",
  resolveStatePath: (ctx) => asConfig(ctx.config).statePath,
  triggerCI,
  pollCommits,
  pollRuns,
  getStatus,
  abortRun,
  capabilities: githubCapabilities,
  verifyWebhook: verifyGithubWebhookSignature,
  mapEvent: mapGithubWebhookEventToHint,
  mapStatusToPhase: mapConclusionToPhase
};

export const githubExecutorPlugin: ExecutorPlugin = createExecutorPluginFromAdapter(githubAdapter);

export function createGithubExecutorPlugin(): ExecutorPlugin {
  return githubExecutorPlugin;
}

// -------------------------------------------------------------------------------------------
// Status reporting (DESIGN §12: "SCP posts a commit status/check so repos can make SCP
// coordination a branch-protection gate"). Not part of the ExecutorPlugin verb set (there is no
// generic "report back" verb — DESIGN §11's four verbs are it) — exposed as a plain function any
// server-side caller with a github plugin instance's `ctx` can invoke directly. NOT YET WIRED into
// `governance/gate-orchestrator.ts`'s decision path in this milestone (flagged, same "deferred but
// present and tested" posture as federation-https's mTLS cert injection in M6) — the function
// itself is implemented and unit-tested against nock fixtures; threading it into every gate
// verdict generically (across every executor, not just github) is left as documented follow-up.
// -------------------------------------------------------------------------------------------

export interface CommitStatusInput {
  sha: string;
  state: "error" | "failure" | "pending" | "success";
  context?: string;
  description?: string;
  targetUrl?: string;
}

export async function postCommitStatus(
  ctx: PluginContext,
  input: CommitStatusInput
): Promise<void> {
  const config = asConfig(ctx.config);
  const { status: httpStatus } = await api(
    ctx,
    config,
    "POST",
    `/repos/${config.owner}/${config.repo}/statuses/${input.sha}`,
    {
      state: input.state,
      context: input.context ?? "commanderscp/coordination",
      description: input.description,
      target_url: input.targetUrl
    }
  );
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new Error(`github postCommitStatus: server returned HTTP ${httpStatus}`);
  }
}

// -------------------------------------------------------------------------------------------
// DiscoveryPlugin (DESIGN §11/§12 — "repo/topology scan proposing Service/Component objects and
// source_mappings"; NEVER auto-commits, only proposes). `DiscoveryProposal` (plugin-api) carries
// objects+relationships; a `component` object's `properties.sourceMapping` carries the
// {repoPattern, pathPattern} the server-side "discovery accept" route turns into a real
// `source_mappings` row ONLY on explicit operator acceptance (routes/discovery.ts, server-side).
// -------------------------------------------------------------------------------------------

interface RepoContentEntry {
  name: string;
  path: string;
  type: "file" | "dir";
}

/** Heuristic component detection: a top-level directory containing one of these marker files is
 *  proposed as a Component; the repo root itself is always proposed as one Service. Deliberately
 *  simple (v1) — real topology detection (multi-language monorepos, nested markers, ownership
 *  inference) is exactly the kind of thing a human reviews before accepting a proposal for. */
const COMPONENT_MARKER_FILES = ["package.json", "Dockerfile", "pom.xml", "go.mod", "Cargo.toml"];

async function discover(ctx: PluginContext): Promise<DiscoveryProposal> {
  const config = asConfig(ctx.config);
  const serviceUrn = `urn:scp:service:github:${config.owner}/${config.repo}`;
  const objects: DiscoveryProposal["objects"] = [
    {
      typeId: "service",
      name: config.repo,
      properties: { discoveredFrom: `github:${config.owner}/${config.repo}` }
    }
  ];
  const relationships: DiscoveryProposal["relationships"] = [];

  const { status: httpStatus, body } = await api(
    ctx,
    config,
    "GET",
    `/repos/${config.owner}/${config.repo}/contents/`
  );
  if (httpStatus >= 200 && httpStatus < 300) {
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

      const componentUrn = `urn:scp:component:github:${config.owner}/${config.repo}/${entry.path}`;
      objects.push({
        typeId: "component",
        name: entry.name,
        properties: {
          discoveredFrom: `github:${config.owner}/${config.repo}`,
          sourceMapping: {
            sourceKind: "github",
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

export const githubDiscoveryPlugin: DiscoveryPlugin = { discover };

export function createGithubDiscoveryPlugin(): DiscoveryPlugin {
  return githubDiscoveryPlugin;
}

// -------------------------------------------------------------------------------------------
// Manifests
// -------------------------------------------------------------------------------------------

const githubConfigSchema = {
  type: "object",
  required: ["appId", "installationId", "owner", "repo"],
  properties: {
    appId: { type: "string" },
    installationId: { type: "string" },
    owner: { type: "string" },
    repo: { type: "string" },
    privateKeySecretKey: { type: "string" },
    defaultWorkflowId: { type: "string" }
  }
};

export const executorManifest: PluginManifest = {
  id: "github",
  kind: "executor",
  version: "0.1.0",
  configSchema: githubConfigSchema
};

export const discoveryManifest: PluginManifest = {
  id: "github-discovery",
  kind: "discovery",
  version: "0.1.0",
  configSchema: githubConfigSchema
};

/** Back-compat single `manifest` export (matches every other M7 plugin's shape) — describes the
 *  executor half; `discoveryManifest` covers the discovery half since one npm package here
 *  provides two distinct plugin-host modules (`github`, `github-discovery` — contract.ts's
 *  `PluginModule` doc comment explains why). */
export const manifest = executorManifest;

export default githubExecutorPlugin;
