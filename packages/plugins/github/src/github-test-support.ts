/**
 * Test-only support code shared by `github.conformance.test.ts` and `index.test.ts`. NOT part of
 * this package's public surface (never re-exported from `index.ts`) — exists purely so this
 * package's own tests can fixture every HTTP call with `nock` and prove the GitHub App auth flow
 * (JWT -> installation token -> API call) works end to end, deterministically, without ever
 * touching a real network (CLAUDE.md: "Tests never touch the internet").
 *
 * IMPORTANT, EMPIRICALLY VERIFIED: `nock@13.5.6` (the version pinned in this repo's
 * `package.json` — NOT the `nock@beta` channel) does **not** intercept the global `fetch`
 * (undici) client. A quick spike (`fetch()` against a `nock`-mocked URL) proved the request
 * sailed straight past `nock` to the real network. `nock` only patches Node's `http`/`https`
 * core modules. So the `ScopedHttpClient` built here uses `node:https`/`node:http` directly
 * (never `fetch`) — that's the mechanism that actually makes `nock` fixtures effective; a
 * fetch-based client would silently defeat every fixture in this package's test suite.
 */
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
import type { GithubConfig } from "./index.js";

// -------------------------------------------------------------------------------------------
// Real (nock-interceptable) ScopedHttpClient
// -------------------------------------------------------------------------------------------

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

// -------------------------------------------------------------------------------------------
// Test RSA keypair (memoized — generated once per test-file process, not per test) + JWT check
// -------------------------------------------------------------------------------------------

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

// -------------------------------------------------------------------------------------------
// Config / ctx builders
// -------------------------------------------------------------------------------------------

/** Fresh appId/installationId by default (unless overridden) — index.ts's installation-token
 *  cache is keyed module-wide by `appId:installationId`, so reusing the SAME identity across
 *  tests in one file would silently serve a cached token and skip the token-exchange HTTP call
 *  the test wants to assert on. Callers that WANT to reuse a cached token across two calls (none
 *  of this package's tests currently do) can pass explicit `appId`/`installationId` overrides.
 *
 *  `defaultWorkflowId` uses `"defaultWorkflowId" in overrides` (property-presence), NOT `??` —
 *  a caller that explicitly passes `{ defaultWorkflowId: undefined }` (to test the "no workflowId
 *  at all" error path) means it, and `??` would silently paper over that with the "ci.yml"
 *  fallback, defeating the whole point of the override. */
export function buildGithubConfig(overrides: Partial<GithubConfig> = {}): GithubConfig {
  const unique = randomUUID().slice(0, 8);
  return {
    appId: overrides.appId ?? `app-${unique}`,
    installationId: overrides.installationId ?? `install-${unique}`,
    owner: overrides.owner ?? "acme",
    repo: overrides.repo ?? "widgets",
    privateKeyPem: overrides.privateKeyPem ?? getTestKeyPair().privateKeyPem,
    defaultWorkflowId: "defaultWorkflowId" in overrides ? overrides.defaultWorkflowId : "ci.yml",
    apiBaseUrl: overrides.apiBaseUrl ?? "https://api.github.com",
    statePath: overrides.statePath
  };
}

/** `config.apiBaseUrl` is optional on the `GithubConfig` interface (defaulted inside index.ts's
 *  own `asConfig`), but `buildGithubConfig` above always sets a concrete value — this just gives
 *  test call sites a non-optional `string` to hand `nock(...)` without repeating the `?? "..."`
 *  fallback everywhere. */
export function apiBase(config: GithubConfig): string {
  return config.apiBaseUrl ?? "https://api.github.com";
}

export function buildTestCtx(
  config: GithubConfig,
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

// -------------------------------------------------------------------------------------------
// Nock fixture helpers
// -------------------------------------------------------------------------------------------

/** The deterministic installation token this helper's token-exchange fixture always issues for a
 *  given config, so callers can assert later API calls carry EXACTLY this token. */
export function installationTokenFor(config: GithubConfig): string {
  return `installation-token-${config.installationId}`;
}

/** Nock-fixtures `POST {apiBaseUrl}/app/installations/{installationId}/access_tokens`, asserting
 *  the request carries a validly-signed App JWT (see `isValidTestAppJwt`) — the concrete proof
 *  that `signAppJwt`/`getInstallationToken` in index.ts are exercised for real. Returns the scope
 *  so callers that want strict single-call assertions can `.done()`/check `isDone()` themselves;
 *  `persist` (default false) allows repeat matches for suites that trigger multiple times against
 *  the SAME identity (e.g. the conformance suite, which calls `factory()` fresh per `it()` but
 *  reuses one fixed config for the whole file). */
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
