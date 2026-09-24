import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A RECORDING ARGO CD STAND-IN — and the structural half of ADR-0008 §3 (M28.4, ADR-0055).
 *
 * It speaks the subset of Argo CD's REST API `@scp/plugin-argocd` calls, with Argo CD's own
 * response shapes, and it plays Argo CD's CONTROLLER on sync: the manifests in an Application's
 * `spec.source.helm.valuesObject.manifests` (the carrier chart's pass-through) are "applied" into
 * an in-memory cluster, which is how an SCP-authored Rollout comes to exist. That is the one
 * sanctioned door: SCP writes Argo CD's desired state, Argo CD writes the cluster.
 *
 * EVERY OTHER WRITE THAT COULD REACH A ROLLOUT IS RECORDED AS A VIOLATION and refused with 403 —
 * not by matching a list of forbidden verbs, which is where the next one hides, but by allowing
 * only four write shapes and recording everything else:
 *
 *   POST   /api/v1/applications                 create (the authoring door)
 *   POST   /api/v1/applications?upsert=true     update an SCP-authored one (the authoring door)
 *   POST   /api/v1/applications/{name}/sync     trigger
 *   DELETE /api/v1/applications/{name}/operation abort
 *
 * So `resource/actions` (Argo CD's route to Rollouts' promote / abort / retry / restart / pause /
 * resume / setWeight actions), `PATCH`/`POST`/`DELETE .../resource` (patching or deleting a managed
 * resource — a Rollout's spec or status), deleting the Application (which cascades to its Rollout),
 * `PUT` on anything, and any Kubernetes-API-shaped path all land in `violations`. A test asserts it
 * empty; adding a promote call anywhere in the plugin turns that test red.
 */

export interface StandInRequest {
  method: string;
  /** Path including query string, exactly as received. */
  path: string;
  body: unknown;
}

export interface StandInApplication {
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  spec?: {
    project?: string;
    destination?: Record<string, unknown>;
    source?: {
      repoURL?: string;
      targetRevision?: string;
      path?: string;
      chart?: string;
      helm?: { valuesObject?: { manifests?: unknown[] } };
    };
  };
  status?: Record<string, unknown>;
}

export interface ArgoCdStandIn {
  url: string;
  /** Every request received, in order. */
  requests: StandInRequest[];
  /** Every write that did NOT go through one of the four allowed shapes. Must stay empty. */
  violations: StandInRequest[];
  applications: Map<string, StandInApplication>;
  /** What Argo CD's controller has applied, keyed `Kind/namespace/name`. */
  cluster: Map<string, Record<string, unknown>>;
  /** Pre-seed an Application someone else authored (the import case). */
  seed(app: StandInApplication): void;
  close(): Promise<void>;
}

const ALLOWED_WRITES: readonly { method: string; pattern: RegExp }[] = [
  { method: "POST", pattern: /^\/api\/v1\/applications(\?upsert=true)?$/ },
  { method: "POST", pattern: /^\/api\/v1\/applications\/[^/?]+\/sync$/ },
  { method: "DELETE", pattern: /^\/api\/v1\/applications\/[^/?]+\/operation$/ }
];

function isAllowedWrite(method: string, path: string): boolean {
  return ALLOWED_WRITES.some((w) => w.method === method && w.pattern.test(path));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function manifestsOf(app: StandInApplication): Record<string, unknown>[] {
  const list = app.spec?.source?.helm?.valuesObject?.manifests;
  return Array.isArray(list)
    ? list.filter((m): m is Record<string, unknown> => typeof m === "object" && m !== null)
    : [];
}

function keyOf(m: Record<string, unknown>): string {
  const meta = (m.metadata ?? {}) as { name?: string; namespace?: string };
  return `${String(m.kind)}/${meta.namespace ?? ""}/${meta.name ?? ""}`;
}

/** Argo Rollouts' own status for a fully-progressed canary: the step index past the last step. */
function progressedStatus(rollout: Record<string, unknown>): Record<string, unknown> {
  const steps = (rollout.spec as { strategy?: { canary?: { steps?: unknown[] } } } | undefined)
    ?.strategy?.canary?.steps;
  return {
    phase: "Healthy",
    message: "",
    ...(Array.isArray(steps) ? { currentStepIndex: steps.length } : {}),
    canary: { weights: { canary: { weight: 100 } } }
  };
}

export async function startArgoCdStandIn(): Promise<ArgoCdStandIn> {
  const requests: StandInRequest[] = [];
  const violations: StandInRequest[] = [];
  const applications = new Map<string, StandInApplication>();
  const cluster = new Map<string, Record<string, unknown>>();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const path = req.url ?? "/";
      const body = await readBody(req);
      const record: StandInRequest = { method, path, body };
      requests.push(record);
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (method !== "GET" && !isAllowedWrite(method, path)) {
        violations.push(record);
        return send(403, { message: `stand-in: write refused (${method} ${path})` });
      }

      const url = new URL(path, "http://stand-in");
      const appMatch = url.pathname.match(/^\/api\/v1\/applications\/([^/]+)(\/.*)?$/);

      if (url.pathname === "/api/v1/applications") {
        if (method === "GET") return send(200, { items: [...applications.values()] });
        const app = body as StandInApplication;
        const name = app?.metadata?.name;
        if (!name) return send(400, { message: "application name is required" });
        const exists = applications.has(name);
        if (exists && url.searchParams.get("upsert") !== "true") {
          return send(400, {
            message: "existing application spec is different, use upsert flag to force update"
          });
        }
        const prior = applications.get(name);
        applications.set(name, { ...app, status: prior?.status ?? {} });
        return send(200, applications.get(name));
      }

      if (appMatch) {
        const name = decodeURIComponent(appMatch[1]!);
        const sub = appMatch[2] ?? "";
        const app = applications.get(name);
        if (!app) return send(404, { message: `applications.argoproj.io "${name}" not found` });

        if (sub === "" && method === "GET") return send(200, app);

        if (sub === "/sync" && method === "POST") {
          // ARGO CD'S CONTROLLER: apply what the carrier chart renders.
          const manifests = manifestsOf(app);
          const resources: Record<string, unknown>[] = [];
          const images: string[] = [];
          for (const m of manifests) {
            const applied = {
              ...m,
              ...(m.kind === "Rollout" ? { status: progressedStatus(m) } : {})
            };
            cluster.set(keyOf(m), applied);
            const meta = (m.metadata ?? {}) as { name?: string; namespace?: string };
            const [group, version] = String(m.apiVersion ?? "").split("/");
            resources.push({
              group,
              version,
              kind: m.kind,
              namespace: meta.namespace,
              name: meta.name,
              status: "Synced",
              health: { status: "Healthy" }
            });
            const containers = (
              m.spec as { template?: { spec?: { containers?: { image?: string }[] } } } | undefined
            )?.template?.spec?.containers;
            for (const c of containers ?? []) if (c.image) images.push(c.image);
          }
          const revision = app.spec?.source?.targetRevision ?? "HEAD";
          app.status = {
            sync: { status: "Synced", revision },
            health: { status: "Healthy" },
            operationState: { phase: "Succeeded", syncResult: { revision } },
            summary: { images },
            resources,
            reconciledAt: new Date().toISOString()
          };
          return send(200, app);
        }

        if (sub === "/resource" && method === "GET") {
          const kind = url.searchParams.get("kind");
          const ns = url.searchParams.get("namespace") ?? "";
          const resourceName = url.searchParams.get("resourceName") ?? "";
          const live = cluster.get(`${kind}/${ns}/${resourceName}`);
          if (!live) return send(404, { message: "resource not found" });
          return send(200, { manifest: JSON.stringify(live) });
        }

        if (sub === "/operation" && method === "DELETE") return send(200, {});
      }

      return send(404, { message: `stand-in: no route for ${method} ${path}` });
    })().catch((err: unknown) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    violations,
    applications,
    cluster,
    seed(app) {
      applications.set(app.metadata.name, app);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}
