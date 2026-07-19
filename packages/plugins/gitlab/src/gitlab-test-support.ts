/**
 * Test-only support shared by `gitlab.conformance.test.ts` and `index.test.ts`. NOT part of this
 * package's public surface. Mirrors `@scp/plugin-gitea`'s `gitea-test-support.ts` — the same
 * empirically-verified reason applies: `nock@13` does NOT intercept the global `fetch`/undici
 * client, only Node's `http`/`https` core modules, so the `ScopedHttpClient` built here uses
 * `node:https`/`node:http` directly (never `fetch`) — otherwise every `nock` fixture in this
 * package's suite would be silently defeated (CLAUDE.md: "Tests never touch the internet").
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type {
  PluginContext,
  ScopedHttpClient,
  ScopedHttpRequest,
  ScopedHttpResponse
} from "@scp/plugin-api";
import type { GitlabConfig } from "./index.js";

/** Builds a `ScopedHttpClient` backed by Node's `http`/`https` core modules — see module doc for
 *  why this, and not `fetch`, is what makes `nock` fixtures actually apply. */
export function createRealHttpClient(): ScopedHttpClient {
  return {
    request(req: ScopedHttpRequest): Promise<ScopedHttpResponse> {
      return new Promise((resolve, reject) => {
        const url = new URL(req.url);
        const requestFn = url.protocol === "http:" ? httpRequest : httpsRequest;
        const bodyText = req.body === undefined ? undefined : JSON.stringify(req.body);
        const headers: Record<string, string> = { ...(req.headers ?? {}) };
        if (bodyText !== undefined) {
          headers["content-length"] = Buffer.byteLength(bodyText).toString();
        }
        const clientReq = requestFn(url, { method: req.method, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsedBody: unknown;
            if (raw.length === 0) {
              parsedBody = undefined;
            } else {
              try {
                parsedBody = JSON.parse(raw);
              } catch {
                parsedBody = raw;
              }
            }
            const responseHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              if (typeof value === "string") responseHeaders[key] = value;
              else if (Array.isArray(value)) responseHeaders[key] = value.join(", ");
            }
            resolve({ status: res.statusCode ?? 0, headers: responseHeaders, body: parsedBody });
          });
        });
        clientReq.on("error", reject);
        if (bodyText !== undefined) clientReq.write(bodyText);
        clientReq.end();
      });
    }
  };
}

/** The deterministic PAT the test fixtures use — asserting downstream calls carry EXACTLY this in
 *  the `PRIVATE-TOKEN: <PAT>` header proves `gitlabApiHeaders`/`resolveToken` are wired. */
export const TEST_PAT = "gitlab-test-pat-abc123";

export function buildGitlabConfig(overrides: Partial<GitlabConfig> = {}): GitlabConfig {
  return {
    // property-presence (not `??`) for BOTH URL fields (M15.3b): a serverUrl-fallback test passes
    // `{ baseUrl: undefined, serverUrl: "..." }` and needs that to stick — a `??` default would
    // silently restore baseUrl and defeat the precedence the test asserts.
    baseUrl: "baseUrl" in overrides ? overrides.baseUrl : "https://gitlab.example.com",
    serverUrl: "serverUrl" in overrides ? overrides.serverUrl : undefined,
    projectPath: "projectPath" in overrides ? overrides.projectPath : "acme/widgets",
    owner: overrides.owner,
    repo: overrides.repo,
    // property-presence (not `??`): a caller that explicitly passes `{ tokenPlaintext: undefined }`
    // (to force the ctx.secrets resolution path) means it — `??` would silently restore TEST_PAT.
    tokenPlaintext: "tokenPlaintext" in overrides ? overrides.tokenPlaintext : TEST_PAT,
    tokenSecretKey: overrides.tokenSecretKey,
    defaultRef: "defaultRef" in overrides ? overrides.defaultRef : "main",
    // statePath left undefined by default → in-memory dedup cache; the file-backed test sets it.
    statePath: overrides.statePath
  };
}

/** The effective `owner/repo` project path a config addresses (mirrors index.ts's precedence:
 *  explicit `projectPath` → `owner/repo`). */
export function projectPathOf(config: GitlabConfig): string {
  return config.projectPath ?? `${config.owner}/${config.repo}`;
}

/** The URL-encoded project id GitLab REST paths key on (`owner/repo` → `owner%2Frepo`). */
export function projectIdOf(config: GitlabConfig): string {
  return encodeURIComponent(projectPathOf(config));
}

/** `<baseUrl>/api/v4` — the concrete host+path prefix test call sites hand `nock(...)`. Mirrors
 *  index.ts's base-URL precedence: explicit `baseUrl` → injected `serverUrl` (Mode A) — M15.3b. */
export function apiBase(config: GitlabConfig): string {
  return `${config.baseUrl ?? config.serverUrl}/api/v4`;
}

/** The `PRIVATE-TOKEN` header value every authenticated GitLab call is expected to carry. */
export function tokenHeaderFor(config: GitlabConfig): string {
  return config.tokenPlaintext ?? TEST_PAT;
}

export function buildTestCtx(
  config: GitlabConfig,
  opts?: { secrets?: Record<string, string> }
): PluginContext {
  return {
    orgId: "org-1",
    domainId: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async (key: string) => opts?.secrets?.[key] },
    http: createRealHttpClient(),
    config
  };
}
