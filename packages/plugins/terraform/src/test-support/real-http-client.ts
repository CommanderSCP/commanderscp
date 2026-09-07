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

/** A real, non-stubbed HTTP client for this package's tests. See docs/plugins.md §547. */
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

/** A context whose client is the real Node-backed one above. See docs/plugins.md §548. */
export function realHttpPluginContext(
  config: unknown,
  secretsGet?: (key: string) => Promise<string | undefined>
): PluginContext {
  return {
    orgId: "org-1",
    scopeKey: "domain-1",
    logger: noopLogger,
    secrets: { get: secretsGet ?? (async () => undefined) },
    http: realHttpClient(),
    config
  };
}
