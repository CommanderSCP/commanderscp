/** Test-only support, not part of this package's surface. See docs/plugins.md §165. */
import { generateKeyPairSync, createVerify, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import nock from "nock";
import type {
  PluginContext,
  ScopedHttpClient,
  ScopedHttpRequest,
  ScopedHttpResponse
} from "@scp/plugin-api";
import { scopedHttpResponseTooLargeError } from "@scp/plugin-api";
import type { GithubConfig } from "./index.js";

/** An HTTP client backed by Node's core modules. See docs/plugins.md §166. */
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
          let total = 0;
          let settled = false;
          res.on("data", (chunk: Buffer) => {
            if (settled) return;
            total += chunk.length;
            if (req.maxResponseBytes !== undefined && total > req.maxResponseBytes) {
              settled = true;
              res.destroy();
              reject(scopedHttpResponseTooLargeError(req.url, req.maxResponseBytes));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            if (settled) return;
            settled = true;
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
          res.on("error", (err) => {
            if (settled) return;
            settled = true;
            reject(err);
          });
        });
        clientReq.on("error", reject);
        if (bodyText !== undefined) clientReq.write(bodyText);
        clientReq.end();
      });
    }
  };
}

// Test RSA keypair (memoized — generated once per test-file process, not per test) + JWT check

let cachedKeyPair: { privateKeyPem: string; publicKeyPem: string } | undefined;

/** A real RSA keypair (not a fixture string) so `signAppJwt`'s `createSign("RSA-SHA256")` in
 *  index.ts produces a JWT this helper can independently verify with the matching public key —
 *  proving the App-JWT signing path is exercised for real, not just "some string got sent". */
export function getTestKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  if (!cachedKeyPair) {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" }
    });
    cachedKeyPair = { privateKeyPem: privateKey, publicKeyPem: publicKey };
  }
  return cachedKeyPair;
}

function base64urlDecode(segment: string): Buffer {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

/** Verifies an `authorization: Bearer <jwt>` header is a well-formed RS256 App JWT signed by the
 *  test private key, with the expected `iss` (appId) claim — used as a nock `.matchHeader`
 *  predicate so the installation-token-exchange fixture only matches a genuinely valid JWT,
 *  proving `signAppJwt` in index.ts is actually wired (not merely "some Authorization header"). */
export function isValidTestAppJwt(headerValue: string | undefined, expectedAppId: string): boolean {
  if (!headerValue || !headerValue.startsWith("Bearer ")) return false;
  const jwt = headerValue.slice("Bearer ".length);
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  try {
    const header = JSON.parse(base64urlDecode(headerB64).toString("utf8")) as { alg?: string };
    if (header.alg !== "RS256") return false;
    const payload = JSON.parse(base64urlDecode(payloadB64).toString("utf8")) as {
      iss?: string;
      iat?: number;
      exp?: number;
    };
    if (payload.iss !== expectedAppId) return false;
    const verifier = createVerify("RSA-SHA256").update(`${headerB64}.${payloadB64}`);
    return verifier.verify(getTestKeyPair().publicKeyPem, base64urlDecode(sigB64));
  } catch {
    return false;
  }
}

/** Fresh appId/installationId by default (unless overridden). See docs/plugins.md §167. */
export function buildGithubConfig(overrides: Partial<GithubConfig> = {}): GithubConfig {
  const unique = randomUUID().slice(0, 8);
  return {
    appId: overrides.appId ?? `app-${unique}`,
    installationId: overrides.installationId ?? `install-${unique}`,
    owner: overrides.owner ?? "acme",
    repo: overrides.repo ?? "widgets",
    privateKeyPem: overrides.privateKeyPem ?? getTestKeyPair().privateKeyPem,
    defaultWorkflowId: "defaultWorkflowId" in overrides ? overrides.defaultWorkflowId : "ci.yml",
    // Property-presence (not `??`) for BOTH URL fields (M15.3b): a serverUrl-fallback test wants to
    // pass `{ apiBaseUrl: undefined, serverUrl: "..." }` and have that stick — a `??` default would
    // silently re-fill apiBaseUrl and defeat the very precedence the test asserts.
    apiBaseUrl: "apiBaseUrl" in overrides ? overrides.apiBaseUrl : "https://api.github.com",
    serverUrl: "serverUrl" in overrides ? overrides.serverUrl : undefined,
    statePath: overrides.statePath
  };
}

/** Resolves the base URL a test's `nock(...)` should intercept, mirroring index.ts's `asConfig`
 *  precedence: explicit `apiBaseUrl` → injected `serverUrl` (Mode A) → the github.com default
 *  (M15.3b). Gives call sites a non-optional `string` without repeating the `?? "..."` fallback. */
export function apiBase(config: GithubConfig): string {
  return config.apiBaseUrl ?? config.serverUrl ?? "https://api.github.com";
}

export function buildTestCtx(
  config: GithubConfig,
  opts?: { secrets?: Record<string, string> }
): PluginContext {
  return {
    orgId: "org-1",
    scopeKey: "domain-1",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async (key: string) => opts?.secrets?.[key] },
    http: createRealHttpClient(),
    config
  };
}

/** The deterministic installation token this helper's token-exchange fixture always issues for a
 *  given config, so callers can assert later API calls carry EXACTLY this token. */
export function installationTokenFor(config: GithubConfig): string {
  return `installation-token-${config.installationId}`;
}

/** Fixtures the installation access-token exchange. See docs/plugins.md §168. */
export function nockInstallationToken(
  config: GithubConfig,
  opts: { persist?: boolean; expiresInMs?: number } = {}
): nock.Scope {
  const scope = nock(apiBase(config))
    .matchHeader("authorization", (value: string) => isValidTestAppJwt(value, config.appId))
    .post(`/app/installations/${config.installationId}/access_tokens`)
    .reply(200, {
      token: installationTokenFor(config),
      expires_at: new Date(Date.now() + (opts.expiresInMs ?? 3_600_000)).toISOString()
    });
  return opts.persist ? scope.persist() : scope;
}
