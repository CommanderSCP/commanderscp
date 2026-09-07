/** The CI-green-for-this-digest wave-gate control. See docs/plugins.md §162. */
import type { ControlOutcome, ControlPlugin, ControlRequest, PluginContext } from "@scp/plugin-api";

export interface GithubCheckControlConfig {
  owner: string;
  repo: string;
  apiBaseUrl?: string;
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
  status?: unknown;
  conclusion?: unknown;
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
  if (typeof config.expectedRef === "string" && config.expectedRef.length > 0)
    return config.expectedRef;
  return undefined;
}

async function resolveToken(
  ctx: PluginContext,
  config: GithubCheckControlConfig
): Promise<string | undefined> {
  if (config.tokenSecretKey) {
    const resolved = await ctx.secrets.get(config.tokenSecretKey);
    if (resolved) return resolved;
  }
  return config.token;
}

function summarizeRuns(
  runs: GithubCheckRun[]
): Array<{ name: string; status: string; conclusion: string | null }> {
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
        .catch((err: unknown) => ({
          kind: "error" as const,
          message: err instanceof Error ? err.message : String(err)
        }));

      const result = await Promise.race([call, timeout(timeoutMs)]);

      if (result === "timeout") {
        return {
          status: "timed_out",
          detail: `github-check: no response within ${timeoutMs}ms`,
          evidence: { url, timeoutMs }
        };
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
        return fail(`github-check: GitHub API returned HTTP ${response.status}`, {
          url,
          httpStatus: response.status
        });
      }

      const body = response.body as { check_runs?: unknown } | undefined;
      const allRuns = Array.isArray(body?.check_runs) ? (body!.check_runs as GithubCheckRun[]) : [];
      const relevant = config.checkName
        ? allRuns.filter((r) => r.name === config.checkName)
        : allRuns;

      if (relevant.length === 0) {
        return expired(
          `github-check: ${config.checkName ? `check '${config.checkName}'` : "no check runs"} not yet reported for ${ref}`,
          { url, ref, checkName: config.checkName }
        );
      }

      const incomplete = relevant.filter((r) => r.status !== "completed");
      if (incomplete.length > 0) {
        return expired(
          `github-check: ${incomplete.length}/${relevant.length} check run(s) still running for ${ref}`,
          {
            url,
            ref,
            checkRuns: summarizeRuns(relevant)
          }
        );
      }

      const failing = relevant.filter(
        (r) => !PASSING_CONCLUSIONS.has(typeof r.conclusion === "string" ? r.conclusion : "")
      );
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
