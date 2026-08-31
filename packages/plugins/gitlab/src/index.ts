import { randomUUID, timingSafeEqual } from "node:crypto";
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
  assertNonEmptyGlobs,
  assertSafeRef,
  assertSafeRepo,
  assertSafeRepoPath,
  createExecutorPluginFromAdapter,
  createTreeReadAccumulator,
  createTreeScanAccumulator,
  decodeBoundedBase64,
  DEFAULT_API_RESPONSE_MAX_BYTES,
  DEFAULT_TREE_RESPONSE_MAX_BYTES,
  normalizeCorrelation,
  resolveMaxBytes,
  resolveMaxEntriesScanned,
  resolveMaxFiles,
  resolveMaxResponseBytes,
  resolveMaxTotalBytes,
  resolveProviderBaseUrl,
  wrapProviderRequestError,
  type GitProviderAdapter,
  type GitProviderEventHint,
  type ReadFileAtRefRequest,
  type ReadFileAtRefResult,
  type ReadTreeAtRefFile,
  type ReadTreeAtRefRequest,
  type ReadTreeAtRefResult
} from "@scp/git-provider-core";

/**
 * `@scp/plugin-gitlab` — the GitLab `ExecutorPlugin` + `DiscoveryPlugin` (M15.3b, the third git
 * provider after github and gitea). Like both, this is a **thin GitLab ADAPTER** over the same
 * provider-neutral `@scp/git-provider-core`: everything provider-neutral (idempotency/dedup cache,
 * observe cursor protocol, correlation-hint normalization, the `ExecutorPlugin` assembly) lives in
 * the core; everything GitLab-wire-specific lives here as a `GitProviderAdapter`. The gitea adapter
 * (`@scp/plugin-gitea`) is the closest reference — GitLab, like Gitea, is commonly SELF-HOSTED, so
 * it reuses the shared `serverUrl` base-URL fallback so a Mode-A "import an EXISTING GitLab" binding
 * reaches it.
 *
 * GITLAB-SPECIFIC WIRE FACTS (how this differs from github/gitea — the reason a separate adapter
 * exists rather than reusing either):
 *   - AUTH is a Personal Access Token sent `PRIVATE-TOKEN: <PAT>` — NOT github's App-JWT, NOT a
 *     `Bearer`/`token` scheme. (GitLab's own documented header for PAT auth.) The token is resolved
 *     via `ctx.secrets.get(tokenSecretKey)`.
 *   - BASE REST URL is `<instance>/api/v4` (a self-hosted instance host; GitLab.com is just one
 *     such host, `https://gitlab.com`). No fixed default — same as gitea, unlike github.
 *   - PROJECT ADDRESSING keys on a project id: the GitLab REST API accepts the URL-ENCODED project
 *     path (`owner%2Frepo`) as the `:id` path segment. Config accepts either an explicit `projectPath`
 *     or `owner`+`repo` (joined to `owner/repo`); `encodeURIComponent` produces the `:id`.
 *   - triggerCI CREATES A PIPELINE via `POST /projects/:id/pipeline` and — UNLIKE github/gitea's
 *     dispatch-204-then-poll-the-runs-list-to-correlate dance — GitLab returns the created pipeline
 *     object (with its `id`) SYNCHRONOUSLY, so `triggerCI` returns the `ExternalRunRef` DIRECTLY off
 *     that response. The core lets the adapter OWN `triggerCI`, so this simply skips the poll.
 *   - STATUS is a single pipeline `status` enum (`created|waiting_for_resource|preparing|pending|
 *     running|success|failed|canceled|skipped|manual|scheduled`) — `mapGitlabStatusToPhase` folds it
 *     to an `ExecutionPhase`. abort is `POST /projects/:id/pipelines/:pipeline_id/cancel`.
 *   - WEBHOOKS carry `X-Gitlab-Token: <secret>` as a PLAINTEXT shared-secret token — NOT an HMAC
 *     signature (github's `sha256=<hex>`, gitea's bare-hex). So `verifyGitlabWebhookToken` does a
 *     TIMING-SAFE PLAINTEXT EQUALITY compare of the header against the configured secret; it never
 *     hashes the body. The event name arrives in `X-Gitlab-Event` (`Push Hook`|`Merge Request Hook`|
 *     `Pipeline Hook`|`Tag Push Hook`|…) and GitLab payload field paths differ (`object_kind`,
 *     `project.path_with_namespace`, `checkout_sha`, `object_attributes.*`).
 *
 * LOAD-BEARING ASSUMPTIONS — CONFIRM WITH A LIVE DRILL (honest coverage note, same split gitea's
 * package documents): every request/response shape below is exercised deterministically against
 * `nock` fixtures built from GitLab's PUBLISHED REST API docs — this package never talks to a real
 * GitLab in its own suite. The auth header (`PRIVATE-TOKEN`), `/api/v4` base, the URL-encoded
 * `owner%2Frepo` project id, the create-pipeline synchronous-object return, the single pipeline
 * `status` enum, the `X-Gitlab-Token` PLAINTEXT-token webhook scheme, and the `repository/tree` +
 * `repository/commits` + `pipelines` list shapes are all from GitLab's documented, stable API. The
 * shapes marked `ASSUMED (GitLab)` inline are the ones whose exact field NAMES are the most
 * version/edition-dependent and MUST be confirmed against a real running GitLab before this executor
 * is trusted in production — specifically the pipeline-webhook `object_attributes` field names and
 * the merge-request webhook `last_commit`/`iid` paths. Nothing here is fabricated; where a shape is
 * uncertain it is flagged as an assumption rather than invented.
 */

// -------------------------------------------------------------------------------------------
// Config + auth (Personal Access Token — `PRIVATE-TOKEN: <PAT>`)
// -------------------------------------------------------------------------------------------

export interface GitlabConfig {
  /** The GitLab instance base URL, e.g. `https://gitlab.example.com` (NO trailing slash, NO
   *  `/api/v4` — appended by `apiBase()`). Explicit per-binding override; when unset, `serverUrl`
   *  (injected by an execution-system-backed binding) is used instead. */
  baseUrl?: string;
  /** Injected by the server when this binding is backed by an execution-system (Mode A — import an
   *  EXISTING GitLab): used as the base-URL FALLBACK when `baseUrl` is not set, so a `kind=gitlab`
   *  execution-system's `serverUrl` actually reaches the provider (M15.3b). At least ONE of
   *  `baseUrl`/`serverUrl` must be present — `asConfig` throws otherwise. */
  serverUrl?: string;
  /** The project's full path (`owner/repo` or `group/subgroup/repo`). Either this OR `owner`+`repo`
   *  must be present; when both are given, `projectPath` wins. URL-encoded to the REST `:id`. */
  projectPath?: string;
  /** Convenience alternative to `projectPath`, joined as `owner/repo`. */
  owner?: string;
  repo?: string;
  /** `SecretsAccessor` key holding the Personal Access Token. */
  tokenSecretKey?: string;
  /** Fallback for tests/fixtures only — a plaintext PAT in config (never used in production; real
   *  deployments must use `tokenSecretKey`). */
  tokenPlaintext?: string;
  /** Default git ref (branch/tag) a pipeline is created on when a `TriggerIntent` doesn't specify
   *  `parameters.ref`. Defaults to `main`. */
  defaultRef?: string;
  statePath?: string;
}

/** The effective project path (`projectPath`, else `owner/repo`) — the value URL-encoded into the
 *  REST `:id`. Throws a clear error when neither addressing form is configured. */
function projectPathOf(config: GitlabConfig): string {
  if (config.projectPath) return config.projectPath;
  if (config.owner && config.repo) return `${config.owner}/${config.repo}`;
  throw new Error("gitlab: config.projectPath (or config.owner + config.repo) is required");
}

/** The URL-encoded project id GitLab REST paths key on: `owner/repo` → `owner%2Frepo`. */
function projectId(config: GitlabConfig): string {
  return encodeURIComponent(projectPathOf(config));
}

function asConfig(config: unknown): GitlabConfig {
  const c = config as Partial<GitlabConfig> | undefined;
  if (!c?.projectPath && !(c?.owner && c?.repo)) {
    throw new Error("gitlab: config.projectPath (or config.owner + config.repo) is required");
  }
  // Base URL by precedence: explicit baseUrl → injected execution-system serverUrl. No default
  // exists for a self-hosted GitLab (GitLab.com is just one host), so neither being set is a hard,
  // clear error — this is what a Mode-A `kind=gitlab` binding relies on (M15.3b).
  const baseUrl = resolveProviderBaseUrl({ explicit: c.baseUrl, serverUrl: c.serverUrl });
  if (!baseUrl) {
    throw new Error(
      "gitlab: no base URL configured (set config.baseUrl, or back this binding with a kind=gitlab execution-system whose serverUrl is injected as config.serverUrl)"
    );
  }
  return {
    baseUrl,
    serverUrl: c.serverUrl,
    projectPath: c.projectPath,
    owner: c.owner,
    repo: c.repo,
    tokenSecretKey: c.tokenSecretKey,
    tokenPlaintext: c.tokenPlaintext,
    defaultRef: c.defaultRef,
    statePath: c.statePath
  };
}

/** REST base for the adapter's own calls: `<instance>/api/v4` (documented, stable). `asConfig` has
 *  already resolved + validated `baseUrl` (explicit or serverUrl fallback), so it is always set. */
function apiBase(config: GitlabConfig): string {
  return `${config.baseUrl}/api/v4`;
}

async function resolveToken(ctx: PluginContext, config: GitlabConfig): Promise<string> {
  if (config.tokenPlaintext) return config.tokenPlaintext;
  if (config.tokenSecretKey) {
    const token = await ctx.secrets.get(config.tokenSecretKey);
    if (token) return token;
  }
  throw new Error("gitlab: no token configured (config.tokenSecretKey resolved nothing)");
}

/** Adapter `authorize` hook: the headers every authenticated GitLab REST call carries — the
 *  `PRIVATE-TOKEN: <PAT>` scheme GitLab uses (NOT `Bearer`, NOT `token`), plus JSON accept/content. */
async function gitlabApiHeaders(
  ctx: PluginContext,
  config: GitlabConfig
): Promise<Record<string, string>> {
  const token = await resolveToken(ctx, config);
  return {
    "private-token": token,
    accept: "application/json",
    "content-type": "application/json"
  };
}

/**
 * `maxResponseBytes` defaults to {@link DEFAULT_API_RESPONSE_MAX_BYTES} — bounding EVERY call
 * through this function, not just `readFileAtRef`'s (M21.2 review MAJOR 5's fix, applied to the
 * one funnel every GitLab REST call in this adapter goes through). `readGet`'s file fetch
 * overrides it with the tighter, decode-bound-derived ceiling from `resolveMaxResponseBytes`.
 */
async function api(
  ctx: PluginContext,
  config: GitlabConfig,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  body?: unknown,
  maxResponseBytes: number = DEFAULT_API_RESPONSE_MAX_BYTES
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const headers = await gitlabApiHeaders(ctx, config);
  const response = await ctx.http.request({
    method,
    url: `${apiBase(config)}${path}`,
    headers,
    body,
    maxResponseBytes
  });
  // Response headers are carried through (additively — every pre-M21.2 call site destructures only
  // `{ status, body }` and is unaffected) so the read path can name a redirect's `Location` in its
  // error. See `readGet`'s `assertNoRedirect` call.
  return { status: response.status, body: response.body, headers: response.headers ?? {} };
}

// -------------------------------------------------------------------------------------------
// Webhook verification (fail-closed) — GitLab's PLAINTEXT X-Gitlab-Token shared secret.
// -------------------------------------------------------------------------------------------

/**
 * GitLab authenticates webhook deliveries with a PLAINTEXT shared-secret TOKEN carried verbatim in
 * the `X-Gitlab-Token` header — NOT an HMAC signature over the body (github's `sha256=<hex>`, gitea's
 * bare-hex). So verification is a TIMING-SAFE PLAINTEXT EQUALITY compare of the header against the
 * configured secret; the raw body is NOT hashed and plays no part (it is accepted only to satisfy the
 * shared `verifyWebhook(rawBody, header, secret)` adapter shape). `timingSafeEqual` throws on a length
 * mismatch, which we guard against and treat as "no match" — fail-closed either way. A missing header
 * is rejected.
 */
export function verifyGitlabWebhookToken(
  _rawBody: Buffer,
  tokenHeader: string | undefined,
  secret: string
): boolean {
  if (!tokenHeader) return false;
  const providedBuf = Buffer.from(tokenHeader, "utf8");
  const expectedBuf = Buffer.from(secret, "utf8");
  if (providedBuf.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

/** GitLab's populated shape of the provider-neutral `GitProviderEventHint`. */
export type GitlabEventHint = GitProviderEventHint;

/**
 * Maps a GitLab webhook event name (the `X-Gitlab-Event` header value) + payload to a correlation
 * hint (null = ignore). GitLab payload paths differ from github/gitea: the project's full path is
 * `project.path_with_namespace`, a push carries `checkout_sha` + `ref`, and MR/pipeline events nest
 * their fields under `object_attributes`. Only the events a `source_mappings` correlation cares about
 * are recognized; anything else yields `null` (ignored, not an error).
 */
export function mapGitlabWebhookEventToHint(
  eventName: string,
  payload: unknown
): GitlabEventHint | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  const project = p.project as { path_with_namespace?: string } | undefined;
  const repo = project?.path_with_namespace;

  switch (eventName) {
    case "Push Hook":
    case "Tag Push Hook": {
      return {
        repo,
        commitSha: (p.checkout_sha as string | undefined) ?? (p.after as string | undefined),
        // Surfaced under its own name for ref-scoped routing (ADR-0030 §1) — see
        // `GitProviderEventHint.ref` for why this is not parsed back out of `correlationKey`.
        ref: typeof p.ref === "string" ? p.ref : undefined,
        correlationKey: p.ref as string | undefined
      };
    }
    case "Merge Request Hook": {
      // ASSUMED (GitLab): the MR object nests its own iid + last_commit sha under object_attributes.
      const attrs = p.object_attributes as
        { iid?: number; last_commit?: { id?: string } } | undefined;
      return {
        repo,
        commitSha: attrs?.last_commit?.id,
        correlationKey: attrs?.iid !== undefined ? `mr-${attrs.iid}` : undefined
      };
    }
    case "Pipeline Hook": {
      // ASSUMED (GitLab): pipeline id/sha/ref under object_attributes.
      const attrs = p.object_attributes as { id?: number; sha?: string; ref?: string } | undefined;
      return {
        repo,
        commitSha: attrs?.sha,
        correlationKey: attrs?.id !== undefined ? `pipeline-${attrs.id}` : attrs?.ref
      };
    }
    default:
      return null;
  }
}

// -------------------------------------------------------------------------------------------
// ExecutorPlugin — GitLab-specific hooks. The dedup cache, cursor protocol, correlation
// normalization, and verb assembly are provided by `@scp/git-provider-core`.
// -------------------------------------------------------------------------------------------

/**
 * A GitLab pipeline as returned by create-pipeline / single-pipeline / pipelines-list. The
 * load-bearing fields this adapter reads are `id`, `status`, `sha`, `ref`, `web_url`, and a
 * timestamp (`created_at`/`updated_at`). GitLab's pipeline `status` is a SINGLE enum (no separate
 * conclusion), documented + stable.
 */
interface GitlabPipeline {
  id: number;
  status: string;
  sha?: string;
  ref?: string;
  web_url?: string;
  created_at?: string;
  updated_at?: string;
}

/** Adapter `triggerCI` hook — CREATES a GitLab pipeline and returns its run ref DIRECTLY. Unlike
 *  github/gitea, GitLab returns the created pipeline object (with its `id`) synchronously, so there
 *  is NO dispatch-then-poll-to-correlate step. The idempotency dedup + persistence wrapping this
 *  lives in `@scp/git-provider-core`; this hook only ever runs for a genuinely new key. */
async function triggerCI(ctx: PluginContext, intent: TriggerIntent): Promise<ExternalRunRef> {
  const config = asConfig(ctx.config);
  const ref = (intent.parameters?.ref as string | undefined) ?? config.defaultRef ?? "main";
  // GitLab expects pipeline variables as an array of { key, value }; accept a caller-friendly
  // Record and normalize. Never fabricated — an absent `variables` sends none.
  const rawVars = intent.parameters?.variables as Record<string, string> | undefined;
  const variables = rawVars
    ? Object.entries(rawVars).map(([key, value]) => ({ key, value: String(value) }))
    : undefined;
  const { status, body } = await api(
    ctx,
    config,
    "POST",
    `/projects/${projectId(config)}/pipeline`,
    variables ? { ref, variables } : { ref }
  );
  if (status < 200 || status >= 300) {
    throw new Error(`gitlab trigger: create pipeline returned HTTP ${status}`);
  }
  const pipeline = body as GitlabPipeline;
  if (typeof pipeline?.id !== "number") {
    // GitLab always returns the pipeline id synchronously; a missing id is an unexpected shape, not
    // a silently-swallowed success. Fall back to a marker key so a retry dedups rather than re-firing.
    const markerKey = intent.idempotencyKey ?? randomUUID();
    ctx.logger.warn("gitlab: create pipeline returned no id", { ref });
    return { externalId: `pipeline_dispatch::${markerKey}` };
  }
  ctx.logger.info("gitlab: pipeline created", { pipelineId: pipeline.id, ref });
  return { externalId: `pipeline::${pipeline.id}`, url: pipeline.web_url };
}

/** GitLab's SINGLE pipeline-status enum → normalized phase. `conclusion` is unused (GitLab folds it
 *  into `status`), kept for the core's two-arg `mapStatusToPhase` shape. NOTE: `skipped` maps to
 *  `failed` — a skipped pipeline is a terminal non-success; there is no dedicated "skipped" phase,
 *  and reporting `succeeded` would be misleading. */
function mapGitlabStatusToPhase(status: string, _conclusion: string | null): ExecutionPhase {
  switch (status) {
    case "success":
      return "succeeded";
    case "failed":
    case "skipped":
      return "failed";
    case "canceled":
      return "aborted";
    case "running":
      return "running";
    case "created":
    case "waiting_for_resource":
    case "preparing":
    case "pending":
    case "manual":
    case "scheduled":
      return "pending";
    default:
      return "running"; // unknown / not-yet-reported: honestly "running", never a crash
  }
}

/** Adapter `getStatus` hook — reads a single pipeline's status. */
async function getStatus(ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus> {
  const config = asConfig(ctx.config);
  if (!ref.externalId.startsWith("pipeline::")) {
    return { phase: "pending", detail: "gitlab: run not yet correlated to a pipeline" };
  }
  const pipelineId = ref.externalId.slice("pipeline::".length);
  const { status: httpStatus, body } = await api(
    ctx,
    config,
    "GET",
    `/projects/${projectId(config)}/pipelines/${encodeURIComponent(pipelineId)}`
  );
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new Error(`gitlab status: server returned HTTP ${httpStatus}`);
  }
  const pipeline = body as GitlabPipeline;
  const phase = mapGitlabStatusToPhase(pipeline.status, null);
  return {
    phase,
    detail: `status=${pipeline.status}`,
    stateRef: pipeline.sha,
    progress: phase === "running" ? 0.5 : phase === "pending" ? 0 : 1
  };
}

/** Adapter `abortRun` hook — cancels a pipeline. */
async function abortRun(ctx: PluginContext, ref: ExternalRunRef): Promise<AbortResult> {
  const config = asConfig(ctx.config);
  if (!ref.externalId.startsWith("pipeline::")) {
    return { aborted: false, detail: "gitlab: no correlated pipeline to cancel" };
  }
  const pipelineId = ref.externalId.slice("pipeline::".length);
  const { status } = await api(
    ctx,
    config,
    "POST",
    `/projects/${projectId(config)}/pipelines/${encodeURIComponent(pipelineId)}/cancel`
  );
  return status >= 200 && status < 300
    ? { aborted: true }
    : { aborted: false, detail: `gitlab abort: server returned HTTP ${status}` };
}

/** ASSUMED (GitLab): a repository commit list item — `id` is the sha, `created_at`/`committed_date`
 *  the timestamp. `GET /projects/:id/repository/commits` is documented + stable. */
interface GitlabCommit {
  id: string;
  created_at?: string;
  committed_date?: string;
}

/** Adapter `pollCommits` hook: recent commits (approximates a `push` webhook for the polling
 *  fallback). GitLab's commits endpoint accepts a `since` ISO param; we still filter client-side by
 *  the commit's own timestamp against the watermark (belt-and-suspenders). Silently skips a non-2xx
 *  resource (the lenient observe posture, same as github/gitea). */
async function pollCommits(ctx: PluginContext, sinceIso?: string): Promise<ExecutorEvent[]> {
  const config = asConfig(ctx.config);
  const events: ExecutorEvent[] = [];
  const repo = projectPathOf(config);
  const sinceMs = sinceIso ? new Date(sinceIso).getTime() : undefined;
  let servedPageSize: number | undefined; // learned from page 1 — see POLL_PAGE_SIZE.
  for (let page = 1; page <= MAX_POLL_PAGES; page += 1) {
    const query = new URLSearchParams({ per_page: String(POLL_PAGE_SIZE), page: String(page) });
    if (sinceIso) query.set("since", sinceIso);
    const { status, body } = await api(
      ctx,
      config,
      "GET",
      `/projects/${projectId(config)}/repository/commits?${query.toString()}`
    );
    if (status < 200 || status >= 300) break;
    const commits = (body as GitlabCommit[]) ?? [];
    if (commits.length === 0) break;
    servedPageSize ??= commits.length;
    for (const commit of commits) {
      const occurredAt = commit.created_at ?? commit.committed_date ?? new Date().toISOString();
      if (sinceMs !== undefined && new Date(occurredAt).getTime() <= sinceMs) continue;
      events.push({
        kind: "push",
        occurredAt,
        correlation: normalizeCorrelation({
          repo,
          commitSha: commit.id,
          correlationKey: "refs/heads/*"
        }),
        raw: commit
      });
    }
    if (commits.length < servedPageSize) break; // shorter than the SERVED page — the last page.
    if (sinceMs === undefined) break; // cold start reads one page — see MAX_POLL_PAGES.
    const last = commits[commits.length - 1];
    const oldest = last?.created_at ?? last?.committed_date;
    if (oldest && new Date(oldest).getTime() <= sinceMs) break;
  }
  return events;
}

/**
 * Page size and per-poll page ceiling for the list resources `observe()` polls, mirroring the
 * github adapter's constants of the same name (the defect and its bound are identical; each adapter
 * keeps its own copy because the query parameter NAMES differ per provider).
 *
 * POLL_PAGE_SIZE is what we ASK for, never what we get: GitLab clamps every list to the instance's
 * `max_page_size` application setting, so a hardened instance answers `per_page=100` with fewer.
 * Ending on a page shorter than the REQUESTED size would then stop on page 1 and silently drop the
 * rest — the defect pagination was added to close — so each loop learns the SERVED page size from
 * page 1 and ends on a page shorter than that (or empty, or at the budget).
 */
const POLL_PAGE_SIZE = 100;
const MAX_POLL_PAGES = 5;

/** Adapter `pollRuns` hook: recent pipelines (approximates a `Pipeline Hook` webhook). GitLab's
 *  pipelines list accepts `updated_after` (ISO); we also filter client-side. */
async function pollRuns(ctx: PluginContext, sinceIso?: string): Promise<ExecutorEvent[]> {
  const config = asConfig(ctx.config);
  const events: ExecutorEvent[] = [];
  const repo = projectPathOf(config);
  const sinceMs = sinceIso ? new Date(sinceIso).getTime() : undefined;
  let servedPageSize: number | undefined; // learned from page 1 — see POLL_PAGE_SIZE.
  for (let page = 1; page <= MAX_POLL_PAGES; page += 1) {
    const query = new URLSearchParams({ per_page: String(POLL_PAGE_SIZE), page: String(page) });
    if (sinceIso) query.set("updated_after", sinceIso);
    const { status, body } = await api(
      ctx,
      config,
      "GET",
      `/projects/${projectId(config)}/pipelines?${query.toString()}`
    );
    if (status < 200 || status >= 300) break;
    const pipelines = (body as GitlabPipeline[]) ?? [];
    if (pipelines.length === 0) break;
    servedPageSize ??= pipelines.length;
    for (const pipeline of pipelines) {
      const occurredAt = pipeline.updated_at ?? pipeline.created_at ?? new Date().toISOString();
      if (sinceMs !== undefined && new Date(occurredAt).getTime() <= sinceMs) continue;
      events.push({
        kind: "workflow_run",
        occurredAt,
        correlation: normalizeCorrelation({
          repo,
          commitSha: pipeline.sha,
          correlationKey: `pipeline-${pipeline.id}`
        }),
        raw: pipeline
      });
    }
    if (pipelines.length < servedPageSize) break; // shorter than the SERVED page — the last page.
    if (sinceMs === undefined) break;
    const last = pipelines[pipelines.length - 1];
    const oldest = last?.updated_at ?? last?.created_at;
    if (oldest && new Date(oldest).getTime() <= sinceMs) break;
  }
  return events;
}

function gitlabCapabilities(): ExecutorCapabilities {
  return {
    supportsObserve: true,
    supportsTrigger: true,
    supportsAbort: true,
    triggerKinds: ["workflow_dispatch"]
  };
}

// -------------------------------------------------------------------------------------------
// readFileAtRef (M21.2, ADR-0032 §4 / proposal §4.3(a)) — reading a file BODY. `discover()` below
// walks `repository/tree` and reads only `name`/`type`; it never fetches a blob.
//
// GITLAB IS THE ONE THAT IS *NOT* GITHUB-COMPATIBLE HERE. Three concrete differences, each of which
// would be a bug if this had been copied from the github/gitea adapters:
//
//  1. DIFFERENT ENDPOINT. There is no `contents/` route. The file lives at
//     `GET /api/v4/projects/:id/repository/files/:file_path?ref=:ref`, returning
//     `{ file_name, file_path, size, encoding: "base64", content, content_sha256, ref, blob_id,
//        commit_id, last_commit_id, execute_filemode }`.
//  2. DIFFERENT PATH ENCODING. `:file_path` is a SINGLE route parameter, so it must be encoded
//     WHOLE with slashes turned into `%2F` (`encodeURIComponent`) — NOT per-segment like github's
//     and gitea's routes. This is why the core's `encodePathSegments` is deliberately unused here;
//     using it would produce `repository/files/svc/api/go.mod`, which GitLab reads as a different
//     (non-existent) route rather than as a nested file.
//  3. ONE CALL, NOT TWO. `commit_id` in that same response IS the commit the ref resolved to, so
//     GitLab needs no separate resolve step — and, unlike the two-call providers, there is no
//     branch-moves-between-calls window to close at all.
//
// One consequence of (3) is that a 404 covers both "no such file" and "no such ref/project", and
// GitLab distinguishes them ONLY in a human-readable `message` ("404 File Not Found" vs "404 Commit
// Not Found"). That message is not a structured discriminator, and a label derived from prose goes
// false the moment the prose changes — the provenance-label lesson — so this reports
// `missing: "unknown"` and carries GitLab's own message through in `detail` rather than inferring.
// -------------------------------------------------------------------------------------------

/** GitLab's repository-file response (documented, stable field names). `blob_id` is the blob sha;
 *  `commit_id` is the commit the requested ref resolved to; `last_commit_id` is the last commit that
 *  touched this file (a DIFFERENT fact, deliberately not used as `commitSha`). */
interface GitlabRepositoryFile {
  file_path?: string;
  size?: number;
  encoding?: string;
  content?: string;
  blob_id?: string;
  commit_id?: string;
  last_commit_id?: string;
}

/** A single authenticated GET on the read path, with the same two folded-in failure modes as the
 *  github/gitea adapters: a 3xx arriving as a STATUS is refused with an explanation by
 *  `assertNoRedirect`, and anything thrown by `ctx.http.request` is re-thrown by
 *  `wrapProviderRequestError` naming whether it was a refused redirect (`redirect: "error"`,
 *  subprocess-entry.ts:285,295) or an egress-guard denial. As with gitea, the egress case is the
 *  live one — a self-hosted GitLab at a private address is blocked for every tenant-configurable
 *  plugin (subprocess-entry.ts:210-215) and this only explains that, never relaxes it. */
async function readGet(
  ctx: PluginContext,
  config: GitlabConfig,
  path: string,
  maxResponseBytes: number = DEFAULT_API_RESPONSE_MAX_BYTES
): Promise<{ status: number; body: unknown }> {
  const url = `${apiBase(config)}${path}`;
  try {
    const response = await api(ctx, config, "GET", path, undefined, maxResponseBytes);
    assertNoRedirect("gitlab", url, response.status, response.headers.location);
    return response;
  } catch (err) {
    throw wrapProviderRequestError("gitlab", url, err);
  }
}

/**
 * The single-call read shared by `readFileAtRef` (`refQuery` = the caller's own `ref`) and
 * `readFilesAtRef` (`refQuery` = an already-resolved commit sha, `requestedRef` = the ORIGINAL
 * `ref` the caller asked for — see `resolveGitlabRefToCommit` for why the batch path resolves
 * once and pins every file read to that one commit, the same discipline github/gitea's two-step
 * flow already has and gitlab's own single-call `readFileAtRef` does not need for ONE file).
 */
async function readGitlabFileAt(
  ctx: PluginContext,
  config: GitlabConfig,
  pid: string,
  path: string,
  refQuery: string,
  requestedRef: string,
  maxBytes: number,
  maxResponseBytes: number
): Promise<ReadFileAtRefResult> {
  // See difference (2) in the module comment above: WHOLE-string encoding, slashes included. Not
  // `encodePathSegments`.
  const filePath = encodeURIComponent(path);
  const response = await readGet(
    ctx,
    config,
    `/projects/${pid}/repository/files/${filePath}?ref=${encodeURIComponent(refQuery)}`,
    maxResponseBytes
  );

  if (response.status === 404) {
    const message = (response.body as { message?: unknown } | undefined)?.message;
    return {
      outcome: "not_found",
      // "unknown", not a guess: GitLab returns 404 for a missing file, a missing ref and a missing/
      // invisible project alike, and separates them only in `message`. See the section comment.
      missing: "unknown",
      path,
      requestedRef,
      detail: typeof message === "string" ? `gitlab: ${message}` : "gitlab: HTTP 404"
    };
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`gitlab readFileAtRef: repository file returned HTTP ${response.status}`);
  }

  const file = (response.body ?? {}) as GitlabRepositoryFile;
  const commitSha = file.commit_id;
  if (typeof commitSha !== "string" || commitSha.length === 0) {
    throw new Error(
      `gitlab readFileAtRef: repository-file response for '${path}' carried no commit_id — refusing to report a resolved commit this call did not actually resolve`
    );
  }

  // No directory case to detect: unlike github/gitea, GitLab's files endpoint does not serve
  // directories at all — a directory path simply 404s there (it is `repository/tree` that lists
  // one). So `not_a_file` is unreachable for this provider, and there is nothing to fake.
  return decodeBoundedBase64({
    provider: "gitlab",
    path,
    requestedRef,
    commitSha,
    base64: file.content ?? "",
    encoding: file.encoding,
    declaredSizeBytes: file.size,
    maxBytes,
    blobSha: file.blob_id
  });
}

/** Adapter `readFileAtRef` hook — see `GitProviderAdapter.readFileAtRef` for the contract. */
async function readFileAtRef(
  ctx: PluginContext,
  request: ReadFileAtRefRequest
): Promise<ReadFileAtRefResult> {
  const config = asConfig(ctx.config);
  const maxBytes = resolveMaxBytes(request.maxBytes);
  // The TRANSPORT ceiling passed to this flow's one HTTP call (M21.2 review MAJOR 5) — see
  // `resolveMaxResponseBytes`'s doc for why it is derived from `maxBytes` rather than a flat
  // constant. GitLab was the provider with the CLEAREST unbounded-buffer exposure: it serves
  // arbitrarily large blobs inline as base64 with no analogue of GitHub's `encoding: "none"` cutoff.
  const maxResponseBytes = resolveMaxResponseBytes(maxBytes);
  assertSafeRepoPath("gitlab", request.path);
  // `ref` is asserted here for the same reason the other two adapters assert it, even though this
  // adapter's whole-string `encodeURIComponent` already makes a `..` inert as a query VALUE: the
  // refusal is the control, the encoding is the belt. Refusing identically across the three keeps
  // one rule instead of three (`assertSafeRef`, `@scp/git-provider-core`).
  assertSafeRef("gitlab", request.ref);
  // An explicit `request.repo` is a full project path (`group/subgroup/repo`) and is encoded to the
  // REST `:id` exactly as `projectId()` does for the binding's own project. No `exactSegments`:
  // a GitLab project path legitimately nests, unlike github's/gitea's fixed `owner/repo`.
  if (request.repo !== undefined) assertSafeRepo("gitlab", request.repo);
  const pid = request.repo ? encodeURIComponent(request.repo) : projectId(config);

  return readGitlabFileAt(
    ctx,
    config,
    pid,
    request.path,
    request.ref,
    request.ref,
    maxBytes,
    maxResponseBytes
  );
}

// -------------------------------------------------------------------------------------------
// readFilesAtRef (team-pipeline-iac proposal §12) — bounded multi-file/tree reads.
//
// GITLAB IS THE ONE PROVIDER THAT GENUINELY PAGINATES HERE. Unlike github/gitea's recursive tree
// call (one response, `truncated: true` past an internal ceiling, no `page` parameter for that
// mode), GitLab's `repository/tree?recursive=true` is standard GitLab REST pagination
// (`per_page`/`page`, a short/empty page means "done") — so this is the one adapter whose
// `maxEntriesScanned` bound is enforced across MULTIPLE round trips, not inside one already-
// arrived response. Each page is still transport-bounded (`DEFAULT_TREE_RESPONSE_MAX_BYTES`), and
// `createTreeScanAccumulator.addPage` is called once per page — a repo whose match set is decided
// long before its last page is never walked to completion, because `addPage` throws the instant
// either bound is exceeded and the loop below never issues the next page's request.
//
// GitLab's tree listing also carries no commit identity (unlike a single `readFileAtRef` call,
// whose ONE response includes `commit_id`), so this resolves `ref` to a commit sha FIRST (the
// same two-step shape github/gitea already have) and reads every matched file at that pinned
// commit sha — ADR-0030's "read at commit X" discipline, extended to the one provider whose
// single-file path did not previously need it.
// -------------------------------------------------------------------------------------------

/** A GitLab repository-tree entry, as `repository/tree` returns it (`type` is `tree`|`blob`). */
interface GitlabRepoTreeEntry {
  path?: string;
  type?: string;
}

/** STEP 1 — resolve `ref` to a commit sha via `GET /projects/:id/repository/commits/:sha_or_ref`,
 *  the documented GitLab endpoint that accepts a branch, tag OR sha and returns that commit's
 *  `id`. Mirrors github/gitea's own ref-resolution step; gitlab's single-file `readFileAtRef`
 *  above does not need this because its ONE response already carries `commit_id`. */
async function resolveGitlabRefToCommit(
  ctx: PluginContext,
  config: GitlabConfig,
  pid: string,
  ref: string,
  maxResponseBytes: number
): Promise<{ outcome: "resolved"; commitSha: string } | { outcome: "not_found"; detail: string }> {
  const resolved = await readGet(
    ctx,
    config,
    `/projects/${pid}/repository/commits/${encodeURIComponent(ref)}`,
    maxResponseBytes
  );
  if (resolved.status === 404) {
    const message = (resolved.body as { message?: unknown } | undefined)?.message;
    return {
      outcome: "not_found",
      detail: typeof message === "string" ? `gitlab: ${message}` : "gitlab: HTTP 404"
    };
  }
  if (resolved.status < 200 || resolved.status >= 300) {
    throw new Error(`gitlab readFilesAtRef: resolving ref returned HTTP ${resolved.status}`);
  }
  const commitSha = (resolved.body as { id?: unknown } | undefined)?.id;
  if (typeof commitSha !== "string" || commitSha.length === 0) {
    throw new Error(
      `gitlab readFilesAtRef: commit response for ref '${ref}' carried no id — refusing to report a resolved commit this call did not actually resolve`
    );
  }
  return { outcome: "resolved", commitSha };
}

/** Entries per page for the tree listing — GitLab's own documented maximum for this endpoint. */
const TREE_LIST_PER_PAGE = 100;

/** Adapter `readFilesAtRef` hook — see `GitProviderAdapter.readFilesAtRef` for the contract. */
async function readFilesAtRef(
  ctx: PluginContext,
  request: ReadTreeAtRefRequest
): Promise<ReadTreeAtRefResult> {
  assertNonEmptyGlobs("gitlab", request.globs);
  const config = asConfig(ctx.config);
  const maxFileBytes = resolveMaxBytes(request.maxFileBytes);
  const maxFiles = resolveMaxFiles(request.maxFiles);
  const maxTotalBytes = resolveMaxTotalBytes(request.maxTotalBytes);
  const maxEntriesScanned = resolveMaxEntriesScanned(request.maxEntriesScanned);
  const maxResponseBytes = resolveMaxResponseBytes(maxFileBytes);
  assertSafeRef("gitlab", request.ref);
  if (request.repo !== undefined) assertSafeRepo("gitlab", request.repo);
  const pid = request.repo ? encodeURIComponent(request.repo) : projectId(config);

  const resolution = await resolveGitlabRefToCommit(
    ctx,
    config,
    pid,
    request.ref,
    maxResponseBytes
  );
  if (resolution.outcome === "not_found") {
    return {
      outcome: "not_found",
      missing: "unknown",
      requestedRef: request.ref,
      detail: resolution.detail
    };
  }
  const { commitSha } = resolution;

  const accumulator = createTreeScanAccumulator(
    "gitlab",
    request.globs,
    maxFiles,
    maxEntriesScanned
  );
  for (let page = 1; ; page += 1) {
    const listing = await readGet(
      ctx,
      config,
      `/projects/${pid}/repository/tree?recursive=true&ref=${encodeURIComponent(commitSha)}&per_page=${TREE_LIST_PER_PAGE}&page=${page}`,
      DEFAULT_TREE_RESPONSE_MAX_BYTES
    );
    if (listing.status < 200 || listing.status >= 300) {
      throw new Error(`gitlab readFilesAtRef: tree listing returned HTTP ${listing.status}`);
    }
    const entries = Array.isArray(listing.body) ? (listing.body as GitlabRepoTreeEntry[]) : [];
    accumulator.addPage(
      entries.map((entry) => ({ path: entry.path ?? "", type: entry.type ?? "unknown" }))
    );
    if (entries.length < TREE_LIST_PER_PAGE) break; // short page — this was the last one
  }

  const readAccumulator = createTreeReadAccumulator("gitlab", maxTotalBytes);
  const files: ReadTreeAtRefFile[] = [];
  for (const path of accumulator.matched) {
    const result = await readGitlabFileAt(
      ctx,
      config,
      pid,
      path,
      commitSha,
      request.ref,
      maxFileBytes,
      maxResponseBytes
    );
    if (result.outcome === "found") readAccumulator.addFileBytes(result.sizeBytes);
    files.push({ path, result });
  }

  return { outcome: "found", requestedRef: request.ref, commitSha, files };
}

/** The GitLab `GitProviderAdapter`. `readFileAtRef` is an adapter-only hook (ADR-0032 §9) — the
 *  core factory never turns it into a fifth executor verb. */
export const gitlabAdapter: GitProviderAdapter = {
  sourceKind: "gitlab",
  authorize: (ctx) => gitlabApiHeaders(ctx, asConfig(ctx.config)),
  baseUrl: (ctx) => apiBase(asConfig(ctx.config)),
  resolveStatePath: (ctx) => asConfig(ctx.config).statePath,
  triggerCI,
  pollCommits,
  pollRuns,
  getStatus,
  abortRun,
  capabilities: gitlabCapabilities,
  verifyWebhook: verifyGitlabWebhookToken,
  mapEvent: mapGitlabWebhookEventToHint,
  mapStatusToPhase: mapGitlabStatusToPhase,
  readFileAtRef,
  readFilesAtRef
};

export const gitlabExecutorPlugin: ExecutorPlugin = createExecutorPluginFromAdapter(gitlabAdapter);

export function createGitlabExecutorPlugin(): ExecutorPlugin {
  return gitlabExecutorPlugin;
}

// -------------------------------------------------------------------------------------------
// DiscoveryPlugin (M15.3b — port of gitea's discover(); DESIGN §11/§12 — "repo/topology scan
// proposing Service/Component objects and source_mappings"; NEVER auto-commits, only proposes).
// GitLab's repo tree API is `GET /projects/:id/repository/tree?path=&per_page=` (entries carry
// `name`/`path`/`type` where type is `tree` (dir) | `blob` (file)) — the marker-file topology walk is
// the same shape as github/gitea, only the endpoint + the tree/blob type literals differ. The
// discovered `sourceMapping.sourceKind` is `'gitlab'` — matching the gitlab EXECUTOR's `source_kind`
// (the `gitlabAdapter.sourceKind` above) so an accepted component's `source_mappings` row actually
// correlates observed gitlab events (push/pipeline). Without a gitlab-kinded source_mapping, pulled
// gitlab events correlate against nothing.
//
// NOTE (follow-up): like github/gitea, `sourceMapping.type` is omitted → defaults to `'configuration'`
// server-side; inferring `'image'` from a Dockerfile marker is a deliberate LATER increment.
// -------------------------------------------------------------------------------------------

/** A GitLab repository-tree entry — `type` is `tree` (dir) | `blob` (file). */
interface GitlabTreeEntry {
  name: string;
  path: string;
  type: "tree" | "blob";
}

/** Heuristic component detection (identical to github/gitea): a top-level directory containing one
 *  of these marker files is proposed as a Component; the repo root itself is always proposed as one
 *  Service. Deliberately simple (v1) — real topology detection is exactly what a human reviews
 *  before accepting a proposal. */
const COMPONENT_MARKER_FILES = ["package.json", "Dockerfile", "pom.xml", "go.mod", "Cargo.toml"];

async function listTree(
  ctx: PluginContext,
  config: GitlabConfig,
  path?: string
): Promise<GitlabTreeEntry[] | undefined> {
  const query = `?per_page=100${path ? `&path=${encodeURIComponent(path)}` : ""}`;
  const { status, body } = await api(
    ctx,
    config,
    "GET",
    `/projects/${projectId(config)}/repository/tree${query}`
  );
  if (status < 200 || status >= 300) return undefined;
  return (body as GitlabTreeEntry[]) ?? [];
}

async function discover(ctx: PluginContext): Promise<DiscoveryProposal> {
  const config = asConfig(ctx.config);
  const repo = projectPathOf(config);
  const serviceUrn = `urn:scp:service:gitlab:${repo}`;
  const serviceName = repo.split("/").pop() ?? repo;
  const objects: DiscoveryProposal["objects"] = [
    {
      typeId: "service",
      name: serviceName,
      // The alias the membership edge below names this object by — accept cannot resolve an
      // endpoint to a proposed object without it (see `DiscoveryProposal` in `@scp/plugin-api`).
      urn: serviceUrn,
      properties: { discoveredFrom: `gitlab:${repo}` }
    }
  ];
  const relationships: DiscoveryProposal["relationships"] = [];

  const root = await listTree(ctx, config);
  if (root) {
    for (const entry of root) {
      if (entry.type !== "tree") continue;
      const dirEntries = await listTree(ctx, config, entry.path);
      if (!dirEntries) continue;
      const hasMarker = dirEntries.some(
        (e) => e.type === "blob" && COMPONENT_MARKER_FILES.includes(e.name)
      );
      if (!hasMarker) continue;

      const componentUrn = `urn:scp:component:gitlab:${repo}/${entry.path}`;
      objects.push({
        typeId: "component",
        name: entry.name,
        urn: componentUrn,
        properties: {
          discoveredFrom: `gitlab:${repo}`,
          sourceMapping: {
            // MUST be 'gitlab' (matches gitlabAdapter.sourceKind) so imported components correlate
            // observed gitlab events — the whole point of this discovery half.
            sourceKind: "gitlab",
            repoPattern: repo,
            pathPattern: `${entry.path}/**`
          }
        }
      });
      // `contains`, SERVICE -> COMPONENT. Not `part_of` and not reversed — see `DiscoveryProposal`
      // in `@scp/plugin-api` for why the name and the direction are both forced.
      relationships.push({ typeId: "contains", fromUrn: serviceUrn, toUrn: componentUrn });
    }
  }

  return { objects, relationships };
}

export const gitlabDiscoveryPlugin: DiscoveryPlugin = { discover };

export function createGitlabDiscoveryPlugin(): DiscoveryPlugin {
  return gitlabDiscoveryPlugin;
}

// -------------------------------------------------------------------------------------------
// Manifest
// -------------------------------------------------------------------------------------------

// `baseUrl` is intentionally NOT in `required` (M15.3b): a Mode-A `kind=gitlab` execution-system
// binding supplies the base URL as the injected `serverUrl` fallback instead. Neither `projectPath`
// nor `owner`/`repo` is individually required in the schema (either addressing form is valid); the
// "at least one addressing form + at least one of baseUrl/serverUrl" invariants are enforced at
// resolve time in `asConfig` (a JSON-Schema `anyOf`-of-required is more than a config form should
// have to render).
const gitlabConfigSchema = {
  type: "object",
  properties: {
    baseUrl: { type: "string" },
    // Additive (M15.3b): injected by the server for an execution-system-backed (Mode A) binding as
    // the base-URL fallback; declared so a config form / inline-binding validation accepts it.
    serverUrl: { type: "string" },
    projectPath: { type: "string" },
    owner: { type: "string" },
    repo: { type: "string" },
    tokenSecretKey: { type: "string" },
    defaultRef: { type: "string" }
  }
};

export const executorManifest: PluginManifest = {
  id: "gitlab",
  kind: "executor",
  version: "0.1.0",
  configSchema: gitlabConfigSchema
};

/** The DiscoveryPlugin half — one npm package here provides two distinct plugin-host modules
 *  (`gitlab`, `gitlab-discovery`), mirroring github/gitea's executor/discovery split. */
export const discoveryManifest: PluginManifest = {
  id: "gitlab-discovery",
  kind: "discovery",
  version: "0.1.0",
  configSchema: gitlabConfigSchema
};

/** Back-compat single `manifest` export (matches every other plugin's shape) — describes the
 *  executor half; `discoveryManifest` covers the discovery half. */
export const manifest = executorManifest;

export default gitlabExecutorPlugin;
