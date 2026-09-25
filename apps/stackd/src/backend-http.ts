import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * THE CONTROLLER'S CLIENT FOR THE BACKENDS IT JUST INSTALLED (M29.2, ADR-0061) — minting a scoped
 * token needs the backend's own API (Argo CD's session and account-token endpoints, Gitea's token
 * endpoint). Plain node:http(s), no redirects followed, bounded. It is handed ONLY URLs the
 * controller derived from its own render (`wiring.ts` `backendEndpoint`), never one from the API:
 * `controller-inputs.test.ts` holds it to `wiring.ts` as its one caller.
 */

export interface BackendHttpRequest {
  method: "GET" | "POST" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  json?: unknown;
  /** Trust anchor for an https endpoint with a private CA (argo-server's). */
  ca?: string;
}

export interface BackendHttpResponse {
  status: number;
  body: unknown;
}

export interface BackendHttp {
  request(req: BackendHttpRequest): Promise<BackendHttpResponse>;
}

const MAX_BODY_BYTES = 1 << 20;

export function nodeBackendHttp(opts: { timeoutMs?: number } = {}): BackendHttp {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return {
    request(req: BackendHttpRequest): Promise<BackendHttpResponse> {
      const url = new URL(req.url);
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const body = req.json === undefined ? undefined : JSON.stringify(req.json);
      return new Promise<BackendHttpResponse>((resolve, reject) => {
        const r = send(
          {
            hostname: url.hostname,
            port: url.port,
            path: `${url.pathname}${url.search}`,
            method: req.method,
            ...(req.ca ? { ca: req.ca } : {}),
            headers: {
              accept: "application/json",
              ...(req.headers ?? {}),
              ...(body !== undefined
                ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
                : {})
            },
            timeout: timeoutMs
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (c: Buffer) => {
              size += c.length;
              if (size > MAX_BODY_BYTES) {
                r.destroy(new Error(`${req.method} ${url.origin}${url.pathname}: body too large`));
                return;
              }
              chunks.push(c);
            });
            res.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              let parsed: unknown = text;
              try {
                parsed = text ? JSON.parse(text) : undefined;
              } catch {
                /* not JSON: kept as text */
              }
              resolve({ status: res.statusCode ?? 0, body: parsed });
            });
            res.on("error", reject);
          }
        );
        r.on("timeout", () =>
          r.destroy(new Error(`${req.method} ${url.origin}${url.pathname} timed out`))
        );
        r.on("error", reject);
        if (body !== undefined) r.write(body);
        r.end();
      });
    }
  };
}
