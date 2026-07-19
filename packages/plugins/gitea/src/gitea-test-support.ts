/**
 * Test-only support shared by `gitea.conformance.test.ts` and `index.test.ts`. NOT part of this
 * package's public surface. Mirrors `@scp/plugin-github`'s `github-test-support.ts` — the same
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
import type { GiteaConfig } from "./index.js";

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
 *  the `Authorization: token <PAT>` header proves `giteaApiHeaders`/`resolveToken` are wired. */
export const TEST_PAT = "gitea-test-pat-abc123";

export function buildGiteaConfig(overrides: Partial<GiteaConfig> = {}): GiteaConfig {
  return {
    baseUrl: overrides.baseUrl ?? "https://gitea.example.com",
    owner: overrides.owner ?? "acme",
    repo: overrides.repo ?? "widgets",
    // property-presence (not `??`): a caller that explicitly passes `{ tokenPlaintext: undefined }`
    // (to force the ctx.secrets resolution path) means it — `??` would silently restore TEST_PAT.
    tokenPlaintext: "tokenPlaintext" in overrides ? overrides.tokenPlaintext : TEST_PAT,
    tokenSecretKey: overrides.tokenSecretKey,
    defaultWorkflowId: "defaultWorkflowId" in overrides ? overrides.defaultWorkflowId : "ci.yml",
    // statePath left undefined by default → in-memory dedup cache; the file-backed test sets it.
    statePath: overrides.statePath
  };
}

/** `<baseUrl>/api/v1` — the concrete host+path prefix test call sites hand `nock(...)`. */
export function apiBase(config: GiteaConfig): string {
  return `${config.baseUrl}/api/v1`;
}

/** The `Authorization` header value every authenticated Gitea call is expected to carry. */
export function authHeaderFor(config: GiteaConfig): string {
  return `token ${config.tokenPlaintext ?? TEST_PAT}`;
}

export function buildTestCtx(
  config: GiteaConfig,
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
