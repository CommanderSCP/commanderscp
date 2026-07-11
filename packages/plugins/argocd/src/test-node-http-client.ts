import http from "node:http";
import https from "node:https";
import type { ScopedHttpClient, ScopedHttpRequest, ScopedHttpResponse } from "@scp/plugin-api";

/**
 * Test-only `ScopedHttpClient` backed by `node:http`/`node:https`'s core `request()` API —
 * deliberately NOT `fetch`, even though production (`unscopedFetchHttpClient` in
 * apps/server/src/plugin-host/subprocess-entry.ts) uses `fetch`. Verified empirically while
 * writing this suite: Node's global `fetch` is implemented on `undici`'s own connection pooling,
 * which bypasses the `http`/`https` core modules that `nock` patches, so with the `nock@13.5.x`
 * line pinned in this repo's package.json (fetch interception is only in the still-experimental
 * `nock@beta` line — see nock's README "Notice"), a `fetch()` call sails past every nock
 * interceptor and attempts (and fails) a real DNS lookup instead of matching a fixture. Routing
 * through `http.request`/`https.request` is what actually lets `nock(serverUrl)...` intercept
 * these calls, while still exercising `index.ts`'s real `apiRequest()` wire path (method, URL,
 * headers, JSON body/response) exactly as production does — only the transport differs.
 */
export function createNodeHttpTestClient(): ScopedHttpClient {
  return {
    request(req: ScopedHttpRequest): Promise<ScopedHttpResponse> {
      return new Promise((resolve, reject) => {
        const url = new URL(req.url);
        const transport = url.protocol === "https:" ? https : http;
        const payload = req.body === undefined ? undefined : JSON.stringify(req.body);
        const headers: Record<string, string> = { ...(req.headers ?? {}) };
        if (payload !== undefined) {
          headers["content-length"] = Buffer.byteLength(payload).toString();
        }

        const httpReq = transport.request(url, { method: req.method, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body: unknown = text;
            try {
              body = text ? JSON.parse(text) : undefined;
            } catch {
              // Not JSON — return the raw text, mirroring unscopedFetchHttpClient's fallback.
            }
            const responseHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(res.headers)) {
              if (typeof value === "string") responseHeaders[key] = value;
              else if (Array.isArray(value)) responseHeaders[key] = value.join(", ");
            }
            resolve({ status: res.statusCode ?? 0, headers: responseHeaders, body });
          });
        });
        httpReq.on("error", reject);
        if (payload !== undefined) httpReq.write(payload);
        httpReq.end();
      });
    }
  };
}
