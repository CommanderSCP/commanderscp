/** Test-only support, deliberately not re-exported. See docs/plugins.md §54. */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type {
  PluginContext,
  ScopedHttpClient,
  ScopedHttpRequest,
  ScopedHttpResponse
} from "@scp/plugin-api";

export function createRealHttpClient(): ScopedHttpClient {
  return {
    request(req: ScopedHttpRequest): Promise<ScopedHttpResponse> {
      return new Promise((resolve, reject) => {
        const url = new URL(req.url);
        const requestFn = url.protocol === "http:" ? httpRequest : httpsRequest;
        const clientReq = requestFn(
          url,
          { method: req.method, headers: { ...(req.headers ?? {}) } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              const raw = Buffer.concat(chunks).toString("utf8");
              let body: unknown;
              if (raw.length === 0) body = undefined;
              else {
                // Mirrors `plugin-host/subprocess-entry.ts`'s `scopedFetchHttpClient` exactly: JSON
                // when it parses, the raw text otherwise. A fixture that behaved differently here
                // would test a client the production host does not have.
                try {
                  body = JSON.parse(raw);
                } catch {
                  body = raw;
                }
              }
              const headers: Record<string, string> = {};
              for (const [key, value] of Object.entries(res.headers)) {
                if (typeof value === "string") headers[key] = value;
                else if (Array.isArray(value)) headers[key] = value.join(", ");
              }
              resolve({ status: res.statusCode ?? 0, headers, body });
            });
          }
        );
        clientReq.on("error", reject);
        clientReq.end();
      });
    }
  };
}

export function createTestContext(config: unknown): PluginContext {
  return {
    orgId: "org-test",
    scopeKey: "dependency-index",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: createRealHttpClient(),
    config
  };
}
