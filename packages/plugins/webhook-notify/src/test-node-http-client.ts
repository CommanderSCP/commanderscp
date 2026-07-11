import http from "node:http";
import https from "node:https";
import type { ScopedHttpClient, ScopedHttpRequest, ScopedHttpResponse } from "@scp/plugin-api";

/**
 * Test-only `ScopedHttpClient` backed by `node:http`/`node:https` — NOT `fetch`. Same reasoning
 * as `@scp/plugin-argocd`'s/`@scp/plugin-terraform`'s identical helper (verified empirically
 * while writing those suites: `nock@13.5.x`, pinned here too, does not intercept Node's native
 * `fetch`/undici — only the `http`/`https` core modules it patches). Exercises this package's
 * real `ctx.http.request()` wire path exactly as production does; only the transport differs.
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
              // Not JSON — return the raw text.
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
