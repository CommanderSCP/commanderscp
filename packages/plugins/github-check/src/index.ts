/**
 * @scp/plugin-github-check — M10.4's concrete "CI green for digest X" wave-gate control
 * (BUILD_AND_TEST.md §8 M10.4: "a concrete 'CI green for digest X' control (a `github-check`/
 * `webhook-control` binding) evaluable at `evaluateWaveGate`, so CI evidence can gate the
 * infra→app boundary — the composition model's signature move"). A third sibling of
 * `@scp/plugin-webhook-control`/`@scp/plugin-scan-result-control`: same `ControlPlugin` contract,
 * same subprocess plugin host, same PULL intake pattern (GET a verdict via the host-mediated
 * `ctx.http`, map it into a `ControlOutcome`). Bound to a `control` graph object via a
 * `control_binding`, exactly like the other two — no execution-system involved.
 *
 * CHARTER — coordinate, NOT execute (principle 1): this plugin NEVER runs CI. It only *reads*
 * GitHub's own Check Runs API (`GET /repos/{owner}/{repo}/commits/{ref}/check-runs`) for whatever
 * CI system (GitHub Actions or any third party posting Check Runs) already ran against the
 * change's commit.
 *
 * COMMIT BINDING ("nothing slipped in", same discipline as scan-result-control's ADR-0013 digest
 * binding): the target commit comes from `req.context.commitSha` — the change's OWN tracked
 * source commit (`governance/gate-orchestrator.ts`'s `resolveChangeCommitSha`), never an
 * operator-typed value alone — falling back to `config.expectedRef` only when the change tracks
 * none. A verdict is always for THIS change's commit, never a substituted one.
 *
 * AUTH — a plain bearer token (`config.tokenSecretKey`, resolved via the host-mediated
 * `ctx.secrets`), deliberately simpler than `@scp/plugin-github`'s full GitHub App JWT →
 * installation-token flow. A read-only "is CI green" check warrants a narrowly-scoped token
 * (fine-grained PAT with Checks: Read-only), not the App's broader installation credential a
 * trigger/dispatch executor needs — least privilege — and it keeps this package self-contained
 * (no dependency on `@scp/plugin-github`).
 *
 * EGRESS — `apiBaseUrl` may legitimately point at a self-hosted GitHub Enterprise Server on a
 * private address, the same on-prem case `scan-result-control`'s own module doc names for its scan
 * source; `github-check` is therefore in `subprocess-entry.ts`'s `OPERATOR_PLANE_MODULES`
 * (loopback/private egress permitted), same `policy:write`-gated control-binding trust tier as
 * `webhook-control`/`scan-result-control`.
 *
 * STILL-RUNNING CI → `"expired"`, NOT `"fail"`: a wave gate is frequently asked before CI on the
 * target commit has even started or concluded. Returning `"fail"` for an in-flight check would be
 * WRONG — `governance/control-runner.ts`'s `ensureControlRun` treats a produced outcome as a
 * cached, permanent historical fact ("a control result is a historical fact, not continuously
 * re-polled"), so an early `"fail"` would PERMANENTLY deadlock the wave the instant this control
 * was ever asked before CI concluded. `"expired"` is the `ControlOutcomeStatus` reserved for
 * exactly this — `control-runner.ts` re-polls a cached `"expired"` outcome after
 * `EXPIRED_RECHECK_INTERVAL_MS`, so an in-flight check gets re-checked (bounded, never every
 * reconcile tick) until it concludes one way or the other.
 *
 * FAIL-CLOSED: missing config, no target ref, no auth token, an unreachable/unparseable API
 * response, a non-2xx response (other than the "nothing reported yet" 404), or a timeout ALL
 * yield `fail`/`timed_out` — a broken or absent CI signal can never authorize a boundary crossing.
 */
import type { ControlOutcome, ControlPlugin, ControlRequest, PluginContext } from "@scp/plugin-api";

export interface GithubCheckControlConfig {
  owner: string;
  repo: string;
  apiBaseUrl?: string; // explicit override; default https://api.github.com
  /** `SecretsAccessor` key holding a token scoped to read Check Runs (a fine-grained PAT with
   *  "Checks: Read-only", or a classic PAT with `repo` scope for a private repo). */
  tokenSecretKey?: string;
  /** Fallback for tests/fixtures only — a plaintext token in config (never used in production;
   *  real deployments must use `tokenSecretKey`). Mirrors `@scp/plugin-github`'s `privateKeyPem`
   *  fallback. */
  token?: string;
  /** A specific check run NAME required to be green (e.g. `"ci/build"`). Omitted = EVERY check
   *  run reported for the ref must be green — the stricter, "nothing failed anywhere" default. */
  checkName?: string;
  /** The commit SHA to check when not resolvable from `req.context.commitSha` (operator-pinned
   *  fallback, same role as scan-result-control's `config.expectedDigest`). */
  expectedRef?: string;
  /** Wall-clock budget for the GitHub API to respond. Default 10s. Enforced HERE (a
   *  `Promise.race`), same reasoning as webhook-control/scan-result-control: a hang must produce a
   *  `timed_out` OUTCOME, not an RPC failure the caller has to translate. */
  timeoutMs?: number;
}

interface GithubCheckRun {
  name?: unknown;
  status?: unknown; // queued|in_progress|completed
  conclusion?: unknown; // success|failure|neutral|cancelled|skipped|timed_out|action_required|stale|null
  html_url?: unknown;
}

/** Conclusions GitHub's own branch-protection UI treats as "did not block" — everything else
 *  (`failure`/`cancelled`/`timed_out`/`action_required`/`stale`) is a genuine failure. */
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

function timeout(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

function fail(detail: string, evidence?: Record<string, unknown>): ControlOutcome {
  return { status: "fail", detail, evidence: evidence ?? {} };
}

function expired(detail: string, evidence: Record<string, unknown>): ControlOutcome {
  return { status: "expired", detail, evidence };
}

/** The commit this control judges: prefer the gate-threaded `context.commitSha` (the change's own
 *  real source commit) and fall back to the operator-pinned `config.expectedRef`. Neither present
 *  ⇒ the control cannot bind to anything ⇒ fail closed (handled by the caller). */
function resolveTargetRef(ctx: PluginContext, req: ControlRequest): string | undefined {
  const fromContext = (req.context as { commitSha?: unknown }).commitSha;
  if (typeof fromContext === "string" && fromContext.length > 0) return fromContext;
  const config = ctx.config as GithubCheckControlConfig;
  if (typeof config.expectedRef === "string" && config.expectedRef.length > 0) return config.expectedRef;
  return undefined;
}

async function resolveToken(ctx: PluginContext, config: GithubCheckControlConfig): Promise<string | undefined> {
  if (config.tokenSecretKey) {
    const resolved = await ctx.secrets.get(config.tokenSecretKey);
    if (resolved) return resolved;
  }
  return config.token;
}

function summarizeRuns(runs: GithubCheckRun[]): Array<{ name: string; status: string; conclusion: string | null }> {
  return runs.map((r) => ({
    name: typeof r.name === "string" ? r.name : "unknown",
    status: typeof r.status === "string" ? r.status : "unknown",
    conclusion: typeof r.conclusion === "string" ? r.conclusion : null
  }));
}

export function createGithubCheckControlPlugin(): ControlPlugin {
  return {
    async evaluate(ctx: PluginContext, req: ControlRequest): Promise<ControlOutcome> {
      const config = ctx.config as GithubCheckControlConfig;
      const timeoutMs = config.timeoutMs ?? 10_000;

      if (!config.owner || !config.repo) {
        return fail("github-check: config.owner and config.repo are required");
      }

      const ref = resolveTargetRef(ctx, req);
      if (!ref) {
        return fail(
          "github-check: no target commit (neither context.commitSha nor config.expectedRef) — cannot bind to the change's commit"
        );
      }

      const token = await resolveToken(ctx, config);
      if (!token) {
        return fail("github-check: no auth token configured (tokenSecretKey resolved nothing)");
      }

      const apiBaseUrl = config.apiBaseUrl ?? "https://api.github.com";
      const url = `${apiBaseUrl}/repos/${config.owner}/${config.repo}/commits/${encodeURIComponent(ref)}/check-runs`;

      const call = ctx.http
        .request({
          method: "GET",
          url,
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }
        })
        .then((response) => ({ kind: "response" as const, response }))
        .catch((err: unknown) => ({ kind: "error" as const, message: err instanceof Error ? err.message : String(err) }));

      const result = await Promise.race([call, timeout(timeoutMs)]);

      if (result === "timeout") {
        return { status: "timed_out", detail: `github-check: no response within ${timeoutMs}ms`, evidence: { url, timeoutMs } };
      }
      if (result.kind === "error") {
        return fail(`github-check: request failed — ${result.message}`, { url });
      }

      const { response } = result;
      if (response.status === 404) {
        // GitHub 404s a ref with no check runs reported at all — honestly "not yet available", not
        // a hard failure (CI may simply not have started).
        return expired(`github-check: no check runs reported yet for ${ref}`, { url, ref });
      }
      if (response.status < 200 || response.status >= 300) {
        return fail(`github-check: GitHub API returned HTTP ${response.status}`, { url, httpStatus: response.status });
      }

      const body = response.body as { check_runs?: unknown } | undefined;
      const allRuns = Array.isArray(body?.check_runs) ? (body!.check_runs as GithubCheckRun[]) : [];
      const relevant = config.checkName ? allRuns.filter((r) => r.name === config.checkName) : allRuns;

      if (relevant.length === 0) {
        return expired(
          `github-check: ${config.checkName ? `check '${config.checkName}'` : "no check runs"} not yet reported for ${ref}`,
          { url, ref, checkName: config.checkName }
        );
      }

      const incomplete = relevant.filter((r) => r.status !== "completed");
      if (incomplete.length > 0) {
        return expired(`github-check: ${incomplete.length}/${relevant.length} check run(s) still running for ${ref}`, {
          url,
          ref,
          checkRuns: summarizeRuns(relevant)
        });
      }

      const failing = relevant.filter((r) => !PASSING_CONCLUSIONS.has(typeof r.conclusion === "string" ? r.conclusion : ""));
      if (failing.length > 0) {
        const detail = summarizeRuns(failing)
          .map((r) => `${r.name}=${r.conclusion ?? "none"}`)
          .join(", ");
        return {
          status: "fail",
          detail: `github-check: ${detail} for ${ref}`,
          evidence: { url, ref, checkRuns: summarizeRuns(relevant) }
        };
      }

      return {
        status: "pass",
        detail: `github-check: ${relevant.length} check run(s) green for ${ref}`,
        evidence: { url, ref, checkRuns: summarizeRuns(relevant) }
      };
    }
  };
}
