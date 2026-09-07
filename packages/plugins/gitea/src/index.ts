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
  encodePathSegments,
  gitProviderTreeBoundError,
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

/** `@scp/plugin-gitea` — the Gitea `ExecutorPlugin`. See docs/plugins.md §145. */

// Config + auth (Personal Access Token — `Authorization: token <PAT>`)

export interface GiteaConfig {
  /** The Gitea instance base URL, e.g. `https://gitea.example.com` (NO trailing slash, NO
   *  `/api/v1` — that suffix is appended by `apiBase()`). Explicit per-binding override; when it is
   *  not set, `serverUrl` (injected by an execution-system-backed binding) is used instead. */
  baseUrl?: string;
  /** Injected by the server when this binding is backed by an execution-system (Mode A — import an
   *  EXISTING Gitea): used as the base-URL FALLBACK when `baseUrl` is not set, so a `kind=gitea`
   *  execution-system's `serverUrl` actually reaches the provider (M15.3b). At least ONE of
   *  `baseUrl`/`serverUrl` must be present — `asConfig` throws otherwise. */
  serverUrl?: string;
  owner: string;
  repo: string;
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
  if (!c?.owner || !c.repo) {
    throw new Error("gitea: config.owner and config.repo are required");
  }
  // Base URL by precedence: explicit baseUrl → injected execution-system serverUrl. No default
  // exists for a self-hosted Gitea (unlike github's api.github.com), so neither being set is a
  // hard, clear error — this is what a Mode-A `kind=gitea` binding relies on (M15.3b).
  const baseUrl = resolveProviderBaseUrl({ explicit: c.baseUrl, serverUrl: c.serverUrl });
  if (!baseUrl) {
    throw new Error(
      "gitea: no base URL configured (set config.baseUrl, or back this binding with a kind=gitea execution-system whose serverUrl is injected as config.serverUrl)"
    );
  }
  return {
    baseUrl,
    serverUrl: c.serverUrl,
    owner: c.owner,
    repo: c.repo,
    tokenSecretKey: c.tokenSecretKey,
    tokenPlaintext: c.tokenPlaintext,
    defaultWorkflowId: c.defaultWorkflowId,
    statePath: c.statePath
  };
}

/** REST base for the adapter's own calls: `<instance>/api/v1` (documented, stable). `asConfig` has
 *  already resolved + validated `baseUrl` (explicit or serverUrl fallback), so it is always set. */
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

/** The response ceiling defaults so every call is bounded. See docs/plugins.md §146. */
async function api(
  ctx: PluginContext,
  config: GiteaConfig,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  body?: unknown,
  maxResponseBytes: number = DEFAULT_API_RESPONSE_MAX_BYTES
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const headers = await giteaApiHeaders(ctx, config);
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

// Webhook signature verification (fail-closed) — Gitea's BARE-HEX X-Gitea-Signature.

/** Gitea signs deliveries as a bare hex HMAC of the raw body. See docs/plugins.md §147. */
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

export type GiteaEventHint = GitProviderEventHint;

/** Maps a Gitea webhook event name + payload to a correlation hint. See docs/plugins.md §148. */
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
        // Surfaced under its own name for ref-scoped routing (ADR-0030 §1) — see
        // `GitProviderEventHint.ref` for why this is not parsed back out of `correlationKey`.
        ref: typeof p.ref === "string" ? p.ref : undefined,
        correlationKey: p.ref as string | undefined
      };
    }
    case "pull_request": {
      const pr = p.pull_request as { head?: { sha?: string }; number?: number } | undefined;
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
      const pkg = p.package as { name?: string; version?: string; type?: string } | undefined;
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

/** ASSUMED (Gitea Actions). See docs/plugins.md §149. */
interface GiteaActionRun {
  id: number;
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
  const sinceMs = sinceIso ? new Date(sinceIso).getTime() : undefined;
  // Gitea's /commits does not accept github's `since` param, so the WHOLE window is filtered
  // client-side — which makes reading only the first page worse here than on github, not better:
  // every commit past the page boundary is dropped and the cursor moves on regardless. Paginated
  // (Gitea spells it `page`/`limit`) under the same budget — see MAX_POLL_PAGES.
  let servedPageSize: number | undefined;
  for (let page = 1; page <= MAX_POLL_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(POLL_PAGE_SIZE), page: String(page) });
    const { status, body } = await api(
      ctx,
      config,
      "GET",
      `/repos/${config.owner}/${config.repo}/commits?${query.toString()}`
    );
    if (status < 200 || status >= 300) break;
    const commits = (body as Array<{ sha: string; commit?: { author?: { date?: string } } }>) ?? [];
    if (commits.length === 0) break;
    servedPageSize ??= commits.length;
    for (const commit of commits) {
      const occurredAt = commit.commit?.author?.date ?? new Date().toISOString();
      if (sinceMs !== undefined && new Date(occurredAt).getTime() <= sinceMs) continue;
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
    if (commits.length < servedPageSize) break; // shorter than the SERVED page — the last page.
    if (sinceMs === undefined) break;
    const oldest = commits[commits.length - 1]?.commit?.author?.date;
    if (oldest && new Date(oldest).getTime() <= sinceMs) break;
  }
  return events;
}

/** Page size and per-poll page ceiling for the polls. See docs/plugins.md §150. */
const POLL_PAGE_SIZE = 100;
const MAX_POLL_PAGES = 5;

/** Adapter `pollRuns` hook: recent Gitea Actions runs (approximates a `workflow_run` webhook).
 *  ASSUMED (Gitea Actions): the runs-list endpoint + `workflow_runs[]` response shape — see the
 *  `GiteaActionRun` note. */
async function pollRuns(ctx: PluginContext, sinceIso?: string): Promise<ExecutorEvent[]> {
  const config = asConfig(ctx.config);
  const events: ExecutorEvent[] = [];
  const sinceMs = sinceIso ? new Date(sinceIso).getTime() : undefined;
  let servedPageSize: number | undefined;
  for (let page = 1; page <= MAX_POLL_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(POLL_PAGE_SIZE), page: String(page) });
    const { status, body } = await api(
      ctx,
      config,
      "GET",
      `/repos/${config.owner}/${config.repo}/actions/runs?${query.toString()}`
    );
    if (status < 200 || status >= 300) break;
    const runs = (body as { workflow_runs?: GiteaActionRun[] }).workflow_runs ?? [];
    if (runs.length === 0) break;
    servedPageSize ??= runs.length;
    for (const run of runs) {
      if (sinceMs !== undefined && run.created_at && new Date(run.created_at).getTime() <= sinceMs)
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
    if (runs.length < servedPageSize) break; // shorter than the SERVED page — the last page.
    if (sinceMs === undefined) break;
    const oldest = runs[runs.length - 1]?.created_at;
    if (oldest && new Date(oldest).getTime() <= sinceMs) break;
  }
  return events;
}

/** ASSUMED shape is minimal here. See docs/plugins.md §151. */
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
  ctx.logger.info("gitea: workflow_dispatch triggered", {
    workflowId,
    ref,
    correlatedRunId: run?.id
  });
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
    `/repos/${config.owner}/${config.repo}/actions/runs/${encodeURIComponent(runId)}`
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
    `/repos/${config.owner}/${config.repo}/actions/runs/${encodeURIComponent(runId)}/cancel`
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

// readFileAtRef (M21.2, ADR-0032 §4 / proposal §4.3(a)). See docs/plugins.md §152.

/** A Gitea `ContentsResponse` for a FILE path — GitHub-compatible field names; `sha` is the blob. */
interface GiteaContentFile {
  type?: string;
  encoding?: string;
  size?: number;
  content?: string;
  sha?: string;
  path?: string;
}

/** A single authenticated GET on the read path. See docs/plugins.md §153. */
async function readGet(
  ctx: PluginContext,
  config: GiteaConfig,
  path: string,
  maxResponseBytes: number = DEFAULT_API_RESPONSE_MAX_BYTES
): Promise<{ status: number; body: unknown }> {
  const url = `${apiBase(config)}${path}`;
  try {
    const response = await api(ctx, config, "GET", path, undefined, maxResponseBytes);
    assertNoRedirect("gitea", url, response.status, response.headers.location);
    return response;
  } catch (err) {
    throw wrapProviderRequestError("gitea", url, err);
  }
}

/** What resolving a ref costs a caller. See docs/plugins.md §154. */
type RefResolution =
  | { outcome: "resolved"; commitSha: string }
  | { outcome: "not_found"; missing: "ref"; detail: string };

/** STEP 1 — resolve `ref` to a commit sha via the same documented list-commits endpoint
 *  `pollCommits` uses. Reading the blob at that SHA (rather than at the ref again) closes the
 *  window where a branch moves between resolution and content fetch: an inventory row that says
 *  "read at commit X" has to be true of the bytes that were actually parsed. */
async function resolveGiteaRefToCommit(
  ctx: PluginContext,
  config: GiteaConfig,
  repoPath: string,
  repo: string,
  ref: string,
  maxResponseBytes: number
): Promise<RefResolution> {
  const resolved = await readGet(
    ctx,
    config,
    `/repos/${repoPath}/commits?sha=${encodeURIComponent(ref)}&limit=1`,
    maxResponseBytes
  );
  if (resolved.status === 404) {
    return {
      outcome: "not_found",
      missing: "ref",
      detail: `gitea: no commits for ref '${ref}' in ${repo}`
    };
  }
  if (resolved.status < 200 || resolved.status >= 300) {
    throw new Error(`gitea readFileAtRef: resolving ref returned HTTP ${resolved.status}`);
  }
  const commits = Array.isArray(resolved.body)
    ? (resolved.body as Array<{ sha?: unknown }>)
    : undefined;
  const commitSha = commits?.[0]?.sha;
  if (typeof commitSha !== "string" || commitSha.length === 0) {
    // An EMPTY list is a real, non-error answer for a ref that exists nowhere — Gitea 200s the
    // list endpoint for an unknown branch on some versions rather than 404ing, so this arm is the
    // one that actually catches a bad ref most of the time. Reported as not_found, not as a crash.
    return {
      outcome: "not_found",
      missing: "ref",
      detail: `gitea: ref '${ref}' resolved to no commit in ${repo}`
    };
  }
  return { outcome: "resolved", commitSha };
}

/** STEP 2 — the blob, pinned to an already-resolved commit sha. Factored out of `readFileAtRef` so
 *  `readFilesAtRef` can call it once per matched path against the SAME resolved commit, without
 *  re-resolving the ref (and without re-deriving `repoPath`) for every file in a batch. */
async function readGiteaFileAtCommit(
  ctx: PluginContext,
  config: GiteaConfig,
  repoPath: string,
  repo: string,
  commitSha: string,
  path: string,
  requestedRef: string,
  maxBytes: number,
  maxResponseBytes: number
): Promise<ReadFileAtRefResult> {
  const contents = await readGet(
    ctx,
    config,
    `/repos/${repoPath}/contents/${encodePathSegments(path)}?ref=${encodeURIComponent(commitSha)}`,
    maxResponseBytes
  );
  if (contents.status === 404) {
    return {
      outcome: "not_found",
      missing: "path",
      path,
      requestedRef,
      detail: `gitea: no file at '${path}' in ${repo}@${commitSha}`
    };
  }
  if (contents.status < 200 || contents.status >= 300) {
    throw new Error(`gitea readFileAtRef: contents returned HTTP ${contents.status}`);
  }

  if (Array.isArray(contents.body)) {
    return {
      outcome: "refused",
      reason: "not_a_file",
      detail: `gitea: '${path}' is a directory (contents returned a listing of ${contents.body.length} entries), not a file`,
      path,
      requestedRef
    };
  }

  const entry = (contents.body ?? {}) as GiteaContentFile;
  if (entry.type !== "file") {
    // Gitea's other documented `type` values are `dir`, `symlink` and `submodule`; none of them
    // carries bytes this can honestly hand back as the file's content.
    return {
      outcome: "refused",
      reason: "not_a_file",
      detail: `gitea: '${path}' has content type '${entry.type ?? "unknown"}', not 'file'`,
      path,
      requestedRef,
      sizeBytes: entry.size
    };
  }

  return decodeBoundedBase64({
    provider: "gitea",
    path,
    requestedRef,
    commitSha,
    base64: entry.content ?? "",
    encoding: entry.encoding,
    declaredSizeBytes: entry.size,
    maxBytes,
    blobSha: entry.sha
  });
}

/** Adapter `readFileAtRef` hook — see `GitProviderAdapter.readFileAtRef` for the contract. */
async function readFileAtRef(
  ctx: PluginContext,
  request: ReadFileAtRefRequest
): Promise<ReadFileAtRefResult> {
  const config = asConfig(ctx.config);
  const repo = request.repo ?? `${config.owner}/${config.repo}`;
  const maxBytes = resolveMaxBytes(request.maxBytes);
  // The TRANSPORT ceiling passed to every HTTP call this flow makes (M21.2 review MAJOR 5) — see
  // `resolveMaxResponseBytes`'s doc for why it is derived from `maxBytes` rather than a flat
  // constant. Applied to the ref-resolution call too, not just the contents fetch: harmless (that
  // response is tiny) and simpler than threading two different bounds through one flow.
  const maxResponseBytes = resolveMaxResponseBytes(maxBytes);
  // All THREE caller-supplied strings that reach a route are asserted before any HTTP happens —
  // the same three asserts the github adapter runs, for the same reason: a raw `repo` of
  // `acme/widgets/../../..` built `.../repos/acme/widgets/../../../commits?sha=main`, and
  // `encodeURIComponent("..")` is `".."` so encoding a ref never closed the traversal either.
  assertSafeRepo("gitea", repo, 2);
  assertSafeRepoPath("gitea", request.path);
  assertSafeRef("gitea", request.ref);
  // `repo` reaches the routes below UNENCODED, deliberately. See docs/plugins.md §155.
  const repoPath = repo;

  const resolution = await resolveGiteaRefToCommit(
    ctx,
    config,
    repoPath,
    repo,
    request.ref,
    maxResponseBytes
  );
  if (resolution.outcome === "not_found") {
    return { ...resolution, path: request.path, requestedRef: request.ref };
  }

  return readGiteaFileAtCommit(
    ctx,
    config,
    repoPath,
    repo,
    resolution.commitSha,
    request.path,
    request.ref,
    maxBytes,
    maxResponseBytes
  );
}

// readFilesAtRef (team-pipeline-iac proposal §12). See docs/plugins.md §156.

interface GiteaTreeEntry {
  path?: string;
  type?: string;
}

interface GiteaTreeResponse {
  tree?: GiteaTreeEntry[];
  truncated?: boolean;
}

/** Adapter `readFilesAtRef` hook — see `GitProviderAdapter.readFilesAtRef` for the contract. */
async function readFilesAtRef(
  ctx: PluginContext,
  request: ReadTreeAtRefRequest
): Promise<ReadTreeAtRefResult> {
  assertNonEmptyGlobs("gitea", request.globs);
  const config = asConfig(ctx.config);
  const repo = request.repo ?? `${config.owner}/${config.repo}`;
  const maxFileBytes = resolveMaxBytes(request.maxFileBytes);
  const maxFiles = resolveMaxFiles(request.maxFiles);
  const maxTotalBytes = resolveMaxTotalBytes(request.maxTotalBytes);
  const maxEntriesScanned = resolveMaxEntriesScanned(request.maxEntriesScanned);
  const maxResponseBytes = resolveMaxResponseBytes(maxFileBytes);
  assertSafeRepo("gitea", repo, 2);
  assertSafeRef("gitea", request.ref);
  const repoPath = repo;

  const resolution = await resolveGiteaRefToCommit(
    ctx,
    config,
    repoPath,
    repo,
    request.ref,
    maxResponseBytes
  );
  if (resolution.outcome === "not_found") {
    return {
      outcome: "not_found",
      missing: resolution.missing,
      requestedRef: request.ref,
      detail: resolution.detail
    };
  }
  const { commitSha } = resolution;

  // ONE call: the recursive tree listing for the whole repo at this commit, transport-bounded so
  // a provider that ignores `recursive`/its own truncation contract cannot hand back an unbounded
  // response (`DEFAULT_TREE_RESPONSE_MAX_BYTES` — the same principle as `resolveMaxResponseBytes`,
  // applied to a listing instead of a blob).
  const listing = await readGet(
    ctx,
    config,
    `/repos/${repoPath}/git/trees/${encodeURIComponent(commitSha)}?recursive=true`,
    DEFAULT_TREE_RESPONSE_MAX_BYTES
  );
  if (listing.status < 200 || listing.status >= 300) {
    throw new Error(`gitea readFilesAtRef: tree listing returned HTTP ${listing.status}`);
  }
  const tree = (listing.body ?? {}) as GiteaTreeResponse;
  const accumulator = createTreeScanAccumulator(
    "gitea",
    request.globs,
    maxFiles,
    maxEntriesScanned
  );
  if (tree.truncated) {
    throw gitProviderTreeBoundError(
      "gitea",
      "maxEntriesScanned",
      maxEntriesScanned,
      `gitea's own tree listing for ${repo}@${commitSha} reported truncated:true — the repo has ` +
        `more entries than gitea will return in one recursive listing, so this call cannot honestly ` +
        `enumerate it to completion`
    );
  }
  accumulator.addPage(
    (tree.tree ?? []).map((entry) => ({
      path: entry.path ?? "",
      // Passed through as-is (not defaulted to "blob"): `RawTreeEntry.type` accepts any string,
      // and `createTreeScanAccumulator` only ever MATCHES `"blob"` — an unrecognized type still
      // counts toward `maxEntriesScanned` but is correctly never mistaken for a file.
      type: entry.type ?? "unknown"
    }))
  );

  const readAccumulator = createTreeReadAccumulator("gitea", maxTotalBytes);
  const files: ReadTreeAtRefFile[] = [];
  for (const path of accumulator.matched) {
    const result = await readGiteaFileAtCommit(
      ctx,
      config,
      repoPath,
      repo,
      commitSha,
      path,
      request.ref,
      maxFileBytes,
      maxResponseBytes
    );
    if (result.outcome === "found") readAccumulator.addFileBytes(result.sizeBytes);
    files.push({ path, result });
  }

  return { outcome: "found", requestedRef: request.ref, commitSha, files };
}

/** Layers package pushes on top of the core commits and runs. See docs/plugins.md §157. */
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
  mapStatusToPhase: mapGiteaStatusToPhase,
  readFileAtRef,
  readFilesAtRef
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

// Discovery: a port of the GitHub adapter's scan. See docs/plugins.md §158.

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
      // The alias the membership edge below names this object by — accept cannot resolve an
      // endpoint to a proposed object without it (see `DiscoveryProposal` in `@scp/plugin-api`).
      urn: serviceUrn,
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
        urn: componentUrn,
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
      // `contains`, SERVICE -> COMPONENT. Not `part_of` and not reversed — see `DiscoveryProposal`
      // in `@scp/plugin-api` for why the name and the direction are both forced.
      relationships.push({ typeId: "contains", fromUrn: serviceUrn, toUrn: componentUrn });
    }
  }

  return { objects, relationships };
}

export const giteaDiscoveryPlugin: DiscoveryPlugin = { discover };

export function createGiteaDiscoveryPlugin(): DiscoveryPlugin {
  return giteaDiscoveryPlugin;
}

// `baseUrl` is intentionally NOT in `required` (M15.3b): a Mode-A `kind=gitea` execution-system
// binding supplies the base URL as the injected `serverUrl` fallback instead. `owner`/`repo` stay
// required; the "at least one of baseUrl/serverUrl" invariant is enforced at resolve time in
// `asConfig` (JSON Schema's `anyOf`-of-required is more than a config form should have to render).
const giteaConfigSchema = {
  type: "object",
  required: ["owner", "repo"],
  properties: {
    baseUrl: { type: "string" },
    // Additive (M15.3b): injected by the server for an execution-system-backed (Mode A) binding as
    // the base-URL fallback; declared so a config form / inline-binding validation accepts it.
    serverUrl: { type: "string" },
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
