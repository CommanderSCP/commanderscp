import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import type { KubeObject, ObjectRef } from "./manifests.js";

/**
 * A MINIMAL KUBERNETES CLIENT — plain HTTPS and a bearer token, no client library, the same
 * posture `@scp/runner-launcher`'s adapter takes. Five verbs: discover, server-side apply, get,
 * delete, list pods. Server-side apply is under ONE field manager, `scp-stackd`, with `force`, so
 * the controller takes ownership of every field it renders even from a prior `kubectl apply`.
 */

export const FIELD_MANAGER = "scp-stackd";

export interface KubeRequest {
  /** POST: only the kind suite's access reviews; the controller itself never creates by POST. */
  method: "GET" | "PATCH" | "DELETE" | "POST";
  path: string;
  body?: string;
  contentType?: string;
}

export interface KubeResponse {
  status: number;
  body: string;
}

export interface KubeTransport {
  request(req: KubeRequest): Promise<KubeResponse>;
}

export class KubeError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "KubeError";
  }
}

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/** The in-cluster transport: the projected token is re-read on every request (it rotates). */
export async function inClusterTransport(): Promise<KubeTransport> {
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
  if (!host) throw new Error("not running in a cluster: KUBERNETES_SERVICE_HOST is unset");
  const ca = await readFile(`${SA_DIR}/ca.crt`);
  return httpsTransport({
    apiBase: `https://${host.includes(":") ? `[${host}]` : host}:${port}`,
    ca,
    readToken: async () => (await readFile(`${SA_DIR}/token`, "utf8")).trim()
  });
}

export function httpsTransport(opts: {
  apiBase: string;
  ca?: Buffer;
  readToken: () => Promise<string>;
  timeoutMs?: number;
}): KubeTransport {
  const base = new URL(opts.apiBase);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return {
    async request(req: KubeRequest): Promise<KubeResponse> {
      const token = await opts.readToken();
      const target = new URL(req.path, base);
      const send = target.protocol === "http:" ? httpRequest : httpsRequest;
      return new Promise<KubeResponse>((resolve, reject) => {
        const r = send(
          {
            hostname: target.hostname,
            port: target.port,
            path: `${target.pathname}${target.search}`,
            method: req.method,
            ...(opts.ca ? { ca: opts.ca } : {}),
            headers: {
              authorization: `Bearer ${token}`,
              accept: "application/json",
              ...(req.body !== undefined
                ? {
                    "content-type": req.contentType ?? "application/json",
                    "content-length": Buffer.byteLength(req.body)
                  }
                : {})
            },
            timeout: timeoutMs
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })
            );
            res.on("error", reject);
          }
        );
        r.on("timeout", () =>
          r.destroy(new Error(`kubernetes ${req.method} ${req.path} timed out`))
        );
        r.on("error", reject);
        if (req.body !== undefined) r.write(req.body);
        r.end();
      });
    }
  };
}

interface ApiResource {
  name: string;
  namespaced: boolean;
  kind: string;
}

/** The message a Kubernetes Status body carries, bounded. */
function statusMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string };
    if (parsed.message) return parsed.message.slice(0, 500);
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500);
}

export class KubeClient {
  private readonly discovery = new Map<string, ApiResource[]>();

  constructor(private readonly transport: KubeTransport) {}

  private async call(req: KubeRequest, allow: number[] = []): Promise<KubeResponse> {
    const res = await this.transport.request(req);
    if ((res.status >= 200 && res.status < 300) || allow.includes(res.status)) return res;
    throw new KubeError(
      res.status,
      `${req.method} ${req.path}: ${res.status} ${statusMessage(res.body)}`
    );
  }

  /** Forgets one group-version's resources, so kinds a just-applied CRD defines become visible. */
  invalidate(apiVersion: string): void {
    this.discovery.delete(apiVersion);
  }

  private async resources(apiVersion: string): Promise<ApiResource[]> {
    const cached = this.discovery.get(apiVersion);
    if (cached) return cached;
    const path = apiVersion.includes("/") ? `/apis/${apiVersion}` : `/api/${apiVersion}`;
    const res = await this.call({ method: "GET", path }, [404]);
    const list =
      res.status === 404
        ? []
        : ((JSON.parse(res.body) as { resources?: ApiResource[] }).resources ?? []).filter(
            (r) => !r.name.includes("/")
          );
    if (list.length > 0) this.discovery.set(apiVersion, list);
    return list;
  }

  async pathFor(ref: ObjectRef, opts: { collection?: boolean } = {}): Promise<string> {
    const resource = (await this.resources(ref.apiVersion)).find((r) => r.kind === ref.kind);
    if (!resource) {
      throw new KubeError(404, `the API server serves no ${ref.kind} in ${ref.apiVersion}`);
    }
    const prefix = ref.apiVersion.includes("/")
      ? `/apis/${ref.apiVersion}`
      : `/api/${ref.apiVersion}`;
    const ns = resource.namespaced
      ? `/namespaces/${encodeURIComponent(ref.namespace ?? "default")}`
      : "";
    const base = `${prefix}${ns}/${resource.name}`;
    return opts.collection ? base : `${base}/${encodeURIComponent(ref.name)}`;
  }

  /** Server-side apply. JSON is YAML, so the apply-patch content type takes it as-is. */
  async apply(obj: KubeObject): Promise<void> {
    const path = await this.pathFor({
      apiVersion: obj.apiVersion,
      kind: obj.kind,
      name: obj.metadata.name,
      ...(obj.metadata.namespace ? { namespace: obj.metadata.namespace } : {})
    });
    await this.call({
      method: "PATCH",
      path: `${path}?fieldManager=${FIELD_MANAGER}&force=true`,
      body: JSON.stringify(obj),
      contentType: "application/apply-patch+yaml"
    });
  }

  /** A JSON merge patch — only for the one field the controller sets outside a render (the
   *  rotation annotation that rolls argo-server onto a new certificate, `wiring.ts`). */
  async mergePatch(ref: ObjectRef, patch: Record<string, unknown>): Promise<void> {
    const path = await this.pathFor(ref);
    await this.call({
      method: "PATCH",
      path: `${path}?fieldManager=${FIELD_MANAGER}-rotation`,
      body: JSON.stringify(patch),
      contentType: "application/merge-patch+json"
    });
  }

  async get(ref: ObjectRef): Promise<KubeObject | null> {
    let path: string;
    try {
      path = await this.pathFor(ref);
    } catch (err) {
      // The kind itself is gone (its CRD was removed): so is every object of it.
      if (err instanceof KubeError && err.status === 404) return null;
      throw err;
    }
    const res = await this.call({ method: "GET", path }, [404]);
    return res.status === 404 ? null : (JSON.parse(res.body) as KubeObject);
  }

  async delete(ref: ObjectRef): Promise<"deleted" | "absent"> {
    let path: string;
    try {
      path = await this.pathFor(ref);
    } catch (err) {
      if (err instanceof KubeError && err.status === 404) return "absent";
      throw err;
    }
    const res = await this.call(
      {
        method: "DELETE",
        path,
        body: JSON.stringify({
          kind: "DeleteOptions",
          apiVersion: "v1",
          propagationPolicy: "Background"
        })
      },
      [404]
    );
    return res.status === 404 ? "absent" : "deleted";
  }

  async listPods(namespace: string): Promise<KubeObject[]> {
    const res = await this.call({
      method: "GET",
      path: `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`
    });
    return (JSON.parse(res.body) as { items?: KubeObject[] }).items ?? [];
  }
}
