import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import type {
  Logger,
  PluginContext,
  ScopedHttpClient,
  ScopedHttpRequest,
  ScopedHttpResponse
} from "@scp/plugin-api";

/**
 * A REAL (non-stubbed) `ScopedHttpClient` for `@scp/plugin-terraform`'s tests — unlike every
 * other plugin's unit tests in this repo (webhook-control, fake-executor, federation-https),
 * which stub `ctx.http.request` directly with a hand-written function, THIS package's tests exist
 * specifically to exercise the plugin's ACTUAL network code (URL templating incl.
 * `encodeURIComponent`, header construction, response-body JSON parsing) against `nock`-fixtured
 * HTTP, since Mode 1 (DESIGN.md §12) is a genuinely HTTP-calling plugin.
 *
 * Deliberately built on `node:http`/`node:https` `request()`, NOT the global `fetch()`: Node's
 * built-in `fetch` is implemented on top of `undici`, which does its own socket handling and
 * bypasses the `http`/`https` core modules entirely. `nock` (installed here at 13.5.6, see
 * package.json) patches exactly those core modules and has no undici/fetch interception support
 * — empirically confirmed while building this suite: a bare `nock(url).reply(...)` interceptor
 * plus a `fetch()` call against that same URL throws `TypeError: fetch failed`, never reaching
 * the interceptor. This client is the `node:http`-based sibling of
 * apps/server/src/plugin-host/subprocess-entry.ts's `unscopedFetchHttpClient` — same
 * request/response shape and the same "JSON-parse with raw-text fallback" behavior — swapped only
 * for the transport `nock` can actually see. (If a future `nock`/undici upgrade adds native
 * `fetch` support, this file plus `unscopedFetchHttpClient` could converge on one implementation;
 * until then they must stay separate for tests to be able to intercept anything at all.)
 */
function request(req: ScopedHttpRequest): Promise<ScopedHttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(req.url);
    const transport = url.protocol === "https:" ? https : http;
    const bodyText = req.body === undefined ? undefined : JSON.stringify(req.body);
    const headers: Record<string, string> = { ...(req.headers ?? {}) };
    if (bodyText !== undefined) {
      headers["content-length"] = String(Buffer.byteLength(bodyText));
    }

    const clientReq = transport.request(url, { method: req.method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let body: unknown = text;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          // Not JSON — return the raw text, matching subprocess-entry.ts's client behavior.
        }
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === "string") responseHeaders[key] = value;
          else if (Array.isArray(value)) responseHeaders[key] = value.join(", ");
        }
        resolve({ status: res.statusCode ?? 0, headers: responseHeaders, body });
      });
    });
    clientReq.on("error", reject);
    if (bodyText !== undefined) clientReq.write(bodyText);
    clientReq.end();
  });
}

export function realHttpClient(): ScopedHttpClient {
  return { request };
}

const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {}
};

/**
 * Builds a `PluginContext` whose `http` is the real `node:http`-backed client above, so calls the
 * plugin makes actually hit the wire (and therefore whatever `nock` interceptors the test set up)
 * rather than a hand-rolled stub. `secretsGet` defaults to "no secret configured", matching every
 * other plugin's test fixture in this repo (fake-executor, webhook-control, federation-https).
 */
export function realHttpPluginContext(
  config: unknown,
  secretsGet?: (key: string) => Promise<string | undefined>
): PluginContext {
  return {
    orgId: "org-1",
    domainId: "domain-1",
    logger: noopLogger,
    secrets: { get: secretsGet ?? (async () => undefined) },
    http: realHttpClient(),
    config
  };
}
