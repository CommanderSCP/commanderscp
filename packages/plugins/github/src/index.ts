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
  assertNoRedirect,
  assertSafeRepoPath,
  createExecutorPluginFromAdapter,
  decodeBoundedBase64,
  encodePathSegments,
  normalizeCorrelation,
  resolveMaxBytes,
  resolveProviderBaseUrl,
  wrapProviderRequestError,
  type GitProviderAdapter,
  type GitProviderEventHint,
  type ReadFileAtRefRequest,
  type ReadFileAtRefResult
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
  apiBaseUrl?: string; // explicit override; default https://api.github.com
  /** Injected by the server when this binding is backed by an execution-system (Mode A — import an
   *  EXISTING GitHub, incl. GitHub Enterprise). Used as the base-URL FALLBACK when `apiBaseUrl` is
   *  not set, so a `kind=github` execution-system's `serverUrl` actually reaches the provider
   *  (M15.3b). Precedence: `apiBaseUrl` → `serverUrl` → `https://api.github.com`. */
  serverUrl?: string;
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
    // Base URL by precedence: explicit apiBaseUrl → injected execution-system serverUrl → the
    // github.com default (M15.3b). `resolveProviderBaseUrl` always returns a value here because a
    // fallback is supplied, so the `?? default` keeps the type non-optional without ever firing.
    apiBaseUrl:
      resolveProviderBaseUrl({
        explicit: c.apiBaseUrl,
        serverUrl: c.serverUrl,
        fallback: "https://api.github.com"
      }) ?? "https://api.github.com",
    serverUrl: c.serverUrl,
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
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const headers = await githubApiHeaders(ctx, config);
  const response = await ctx.http.request({
    method,
    url: `${config.apiBaseUrl}${path}`,
    headers,
    body
  });
  // Response headers are carried through (additively — every pre-M21.2 call site destructures only
  // `{ status, body }` and is unaffected) so the read path can name a redirect's `Location` in its
  // error. See `readGet`'s `assertNoRedirect` call.
  return { status: response.status, body: response.body, headers: response.headers ?? {} };
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

/** One commit as a `push` webhook payload carries it — GitHub splits the changed set across three
 *  sibling arrays rather than one, and all three are changes for correlation purposes. */
interface PushCommit {
  id?: string;
  added?: unknown;
  modified?: unknown;
  removed?: unknown;
}

/** Union of every `added`/`modified`/`removed` entry across `commits`, de-duplicated and stable.
 *  Deliberately tolerant of a malformed member: a push whose payload shape surprises us must still
 *  correlate on whatever paths ARE readable, rather than throwing and wedging the ingress tick. */
function unionCommitPaths(commits: readonly PushCommit[]): string[] {
  const out = new Set<string>();
  for (const commit of commits) {
    for (const bucket of [commit?.added, commit?.modified, commit?.removed]) {
      if (!Array.isArray(bucket)) continue;
      for (const entry of bucket) if (typeof entry === "string" && entry.length > 0) out.add(entry);
    }
  }
  return [...out].sort();
}

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
      const headCommit = p.head_commit as PushCommit | undefined;
      // The changed-file set, unioned across EVERY commit in the push — not just `head_commit`.
      // A push delivers all its commits at once, and a file touched by an earlier commit in the
      // same push is still a file this push changed; reading only the head would silently drop it
      // and route the release by the repo-only fallback instead.
      const commits = Array.isArray(p.commits) ? (p.commits as PushCommit[]) : [];
      const paths = unionCommitPaths(headCommit ? [...commits, headCommit] : commits);
      return {
        repo,
        commitSha: headCommit?.id ?? (p.after as string | undefined),
        // The same `p.ref` the correlation key already carried, now ALSO surfaced under its own
        // name (ADR-0030 §1) — the key is a grouping identity, `ref` is the routing input, and a
        // ref-scoped mapping must read the latter.
        ref: typeof p.ref === "string" ? p.ref : undefined,
        correlationKey: p.ref as string | undefined,
        ...(paths.length > 0 ? { paths } : {})
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
    let fileFetchBudget = MAX_COMMIT_FILE_FETCHES_PER_POLL;
    for (const commit of commits) {
      const occurredAt = commit.commit?.author?.date ?? new Date().toISOString();
      // The commits LIST response carries no `files` (GitHub only returns them on the single-commit
      // resource), so poll-vs-push equivalence for `paths` costs one extra GET per commit. Budgeted
      // rather than unbounded: a repo that lands a large backlog between polls must not turn one
      // observe tick into hundreds of API calls. Commits past the budget still produce an event —
      // just without `paths`, so they route by the repo-only mappings exactly as before.
      const paths =
        fileFetchBudget > 0 ? await fetchCommitPaths(ctx, config, commit.sha) : undefined;
      if (fileFetchBudget > 0) fileFetchBudget -= 1;
      events.push({
        kind: "push",
        occurredAt,
        correlation: normalizeCorrelation({
          repo: `${config.owner}/${config.repo}`,
          commitSha: commit.sha,
          correlationKey: "refs/heads/*",
          ...(paths && paths.length > 0 ? { paths } : {})
        }),
        raw: commit
      });
    }
  }
  return events;
}

/** Per-poll ceiling on single-commit fetches (see `pollCommits`). */
const MAX_COMMIT_FILE_FETCHES_PER_POLL = 20;

/**
 * The changed-file set of ONE commit, via the single-commit resource (the only GitHub endpoint that
 * returns `files`). Best-effort by design: a non-2xx or unexpected shape yields `undefined` rather
 * than throwing, matching `pollCommits`' documented lenient observe posture.
 *
 * **Known limit, and it is a silent one.** GitHub caps this response at 300 files and does not
 * paginate them here, so a commit touching more than 300 files yields a TRUNCATED set. A path-scoped
 * mapping whose directory fell outside the truncation will not match, and the event then routes by
 * whatever repo-only mapping wins — i.e. it degrades to the pre-existing behaviour rather than
 * failing loudly. Acceptable because such commits are rare in a GitOps repo (the case this exists
 * for), but it is a real hole and should not be discovered later as a surprise.
 */
async function fetchCommitPaths(
  ctx: PluginContext,
  config: GithubConfig,
  sha: string
): Promise<string[] | undefined> {
  if (!sha) return undefined;
  try {
    const { status, body } = await api(
      ctx,
      config,
      "GET",
      `/repos/${config.owner}/${config.repo}/commits/${encodeURIComponent(sha)}`
    );
    if (status < 200 || status >= 300) return undefined;
    const files = (body as { files?: unknown }).files;
    if (!Array.isArray(files)) return undefined;
    const out = new Set<string>();
    for (const file of files) {
      const filename = (file as { filename?: unknown }).filename;
      if (typeof filename === "string" && filename.length > 0) out.add(filename);
    }
    return out.size > 0 ? [...out].sort() : undefined;
  } catch {
    // MUST swallow. `api()` THROWS on a transport failure (blocked host, DNS, connection reset) —
    // only a non-2xx comes back as a status. Letting that escape would abort `pollCommits` mid-loop
    // and lose the push events themselves, turning a best-effort enrichment into data loss: the
    // release would never be coordinated at all, rather than merely routing by repo instead of by
    // directory. Degrading to `undefined` is the whole point of this being an enrichment.
    return undefined;
  }
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

// -------------------------------------------------------------------------------------------
// readFileAtRef (M21.2, ADR-0032 §4 / proposal §4.3(a)) — the FIRST time this package reads a file
// BODY out of a repo. `discover()` below calls the same contents endpoint but reads only
// `entry.name`/`entry.type` off a DIRECTORY LISTING (see line ~758 and the marker-file test); it
// never fetches or decodes a blob. This is that missing capability, and nothing more: it reads.
//
// GITHUB WIRE FACTS THIS DEPENDS ON (all from GitHub's published REST docs; like every other shape
// in this file they are proven here only against `nock` fixtures — the nightly live-sandbox job is
// what proves wire fidelity end to end):
//   - `GET /repos/{owner}/{repo}/commits/{ref}` accepts a branch, tag or sha as `{ref}` and returns
//     the commit object whose `sha` is what that ref RESOLVES TO.
//   - `GET /repos/{owner}/{repo}/contents/{path}?ref={ref}` returns, for a blob, an object with
//     `type: "file"`, `encoding: "base64"`, `size`, `content` (base64 WRAPPED AT 60 CHARS WITH
//     EMBEDDED NEWLINES — `base64DecodedByteLength` strips whitespace for exactly this reason) and
//     `sha` (the BLOB sha, NOT a commit sha — hence the separate resolve call above). For a
//     DIRECTORY the same route returns a JSON ARRAY, which is how `not_a_file` is detected.
//   - For a blob between 1 MB and 100 MB the same object comes back with `content: ""` and
//     `encoding: "none"`; `decodeBoundedBase64` maps that to a `too_large` refusal because that is
//     what GitHub means by it.
// -------------------------------------------------------------------------------------------

/** One entry of a GitHub contents response for a FILE path. `sha` here is the blob sha. */
interface GithubContentFile {
  type?: string;
  encoding?: string;
  size?: number;
  content?: string;
  sha?: string;
  path?: string;
}

/**
 * A single authenticated GET on the read path, with the two failure modes the plugin HTTP client
 * makes non-obvious folded in:
 *
 *  - a 3xx that arrives as a STATUS is refused by `assertNoRedirect` with an explanation, rather
 *    than falling through as an anonymous "HTTP 302";
 *  - anything thrown by `ctx.http.request` — including a refused redirect under the production
 *    client (`redirect: "error"`, subprocess-entry.ts:285,295) and an egress-guard denial
 *    (`egressBlocked`, egress-guard.ts:83) — is re-thrown by `wrapProviderRequestError` naming which
 *    of those it was. Neither weakens any control; both make the failure legible.
 */
async function readGet(
  ctx: PluginContext,
  config: GithubConfig,
  path: string
): Promise<{ status: number; body: unknown }> {
  const url = `${config.apiBaseUrl}${path}`;
  try {
    const response = await api(ctx, config, "GET", path);
    assertNoRedirect("github", url, response.status, response.headers.location);
    return response;
  } catch (err) {
    throw wrapProviderRequestError("github", url, err);
  }
}

/** Adapter `readFileAtRef` hook — see `GitProviderAdapter.readFileAtRef` for the contract. */
async function readFileAtRef(
  ctx: PluginContext,
  request: ReadFileAtRefRequest
): Promise<ReadFileAtRefResult> {
  const config = asConfig(ctx.config);
  const repo = request.repo ?? `${config.owner}/${config.repo}`;
  const maxBytes = resolveMaxBytes(request.maxBytes);
  assertSafeRepoPath("github", request.path);

  // STEP 1 — resolve the ref to a commit sha, and STEP 2 reads at that SHA rather than at the ref.
  // The two-call shape is forced (GitHub's contents response carries a blob sha, never a commit
  // sha), but reading at the resolved sha is a deliberate choice on top of it: a branch can move
  // between the two calls, and an inventory row that says "read at commit X" must be true of the
  // bytes actually parsed. Reading at the ref again would make that a claim rather than a fact.
  const resolved = await readGet(
    ctx,
    config,
    `/repos/${repo}/commits/${encodePathSegments(request.ref)}`
  );
  if (resolved.status === 404) {
    // GitHub 404s an unknown ref AND an inaccessible repo identically (it hides private repos
    // behind 404 by design), so this cannot distinguish "no such branch" from "no access" — the
    // detail says so rather than asserting the more flattering one.
    return {
      outcome: "not_found",
      missing: "ref",
      path: request.path,
      requestedRef: request.ref,
      detail: `github: no commit for ref '${request.ref}' in ${repo} (GitHub also returns 404 for a repo the installation cannot see)`
    };
  }
  if (resolved.status < 200 || resolved.status >= 300) {
    throw new Error(`github readFileAtRef: resolving ref returned HTTP ${resolved.status}`);
  }
  const commitSha = (resolved.body as { sha?: unknown } | undefined)?.sha;
  if (typeof commitSha !== "string" || commitSha.length === 0) {
    throw new Error(
      `github readFileAtRef: commit response for ref '${request.ref}' carried no sha — refusing to report a resolved commit this call did not actually resolve`
    );
  }

  // STEP 2 — the blob, pinned to the sha from step 1.
  const contents = await readGet(
    ctx,
    config,
    `/repos/${repo}/contents/${encodePathSegments(request.path)}?ref=${encodeURIComponent(commitSha)}`
  );
  if (contents.status === 404) {
    return {
      outcome: "not_found",
      missing: "path",
      path: request.path,
      requestedRef: request.ref,
      detail: `github: no file at '${request.path}' in ${repo}@${commitSha}`
    };
  }
  if (contents.status < 200 || contents.status >= 300) {
    throw new Error(`github readFileAtRef: contents returned HTTP ${contents.status}`);
  }

  // A directory comes back as an ARRAY from the very same route — the one shape difference that
  // separates "read a file" from the marker-file walk `discover()` does.
  if (Array.isArray(contents.body)) {
    return {
      outcome: "refused",
      reason: "not_a_file",
      detail: `github: '${request.path}' is a directory (contents returned a listing of ${contents.body.length} entries), not a file`,
      path: request.path,
      requestedRef: request.ref
    };
  }

  const entry = (contents.body ?? {}) as GithubContentFile;
  if (entry.type !== "file") {
    // `symlink` and `submodule` are the other two documented `type` values; neither carries bytes
    // this can honestly hand back as the file's content.
    return {
      outcome: "refused",
      reason: "not_a_file",
      detail: `github: '${request.path}' has content type '${entry.type ?? "unknown"}', not 'file'`,
      path: request.path,
      requestedRef: request.ref,
      sizeBytes: entry.size
    };
  }

  return decodeBoundedBase64({
    provider: "github",
    path: request.path,
    requestedRef: request.ref,
    commitSha,
    base64: entry.content ?? "",
    encoding: entry.encoding,
    declaredSizeBytes: entry.size,
    maxBytes,
    blobSha: entry.sha ?? "unknown"
  });
}

/**
 * The GitHub `GitProviderAdapter` — every GitHub-wire-specific hook the provider-neutral
 * `@scp/git-provider-core` needs. The executor factory consumes `resolveStatePath`/`triggerCI`/
 * `pollCommits`/`pollRuns`/`getStatus`/`abortRun`/`capabilities`; `authorize`/`baseUrl` back this
 * adapter's own REST calls (`api()`), `verifyWebhook`/`mapEvent` back the server webhook path,
 * `mapStatusToPhase` backs `getStatus`, and `readFileAtRef` backs ADR-0032's manifest ingestion
 * (adapter-only — the factory never turns it into a fifth executor verb).
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
  mapStatusToPhase: mapConclusionToPhase,
  readFileAtRef
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
    defaultWorkflowId: { type: "string" },
    // Additive (M15.3b): injected by the server for an execution-system-backed (Mode A) binding as
    // the base-URL fallback; declared so a generated config form / inline-binding validation accepts
    // it rather than treating it as unknown.
    serverUrl: { type: "string" }
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
