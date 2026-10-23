import type { KubeRequest, KubeResponse, KubeTransport } from "../kube.js";
import type { KubeObject } from "../manifests.js";

/**
 * AN IN-MEMORY KUBERNETES API for the unit suite — discovery, server-side apply, get, delete and
 * pod lists, over the same `KubeTransport` port the real client uses. It is not a substitute for
 * the kind suite (apps/server `stack-controller.kind.test.ts`), which runs the same controller
 * against a real API server; it is what lets every branch of the reconcile be driven in
 * milliseconds.
 *
 * Workload status is computed by `readyWhen` from the applied object, so a test decides what
 * "healthy" means (e.g. "any image but one containing `broken`").
 */

interface Resource {
  name: string;
  kind: string;
  namespaced: boolean;
}

const BUILTIN: Record<string, Resource[]> = {
  v1: [
    { name: "namespaces", kind: "Namespace", namespaced: false },
    { name: "secrets", kind: "Secret", namespaced: true },
    { name: "configmaps", kind: "ConfigMap", namespaced: true },
    { name: "serviceaccounts", kind: "ServiceAccount", namespaced: true },
    { name: "services", kind: "Service", namespaced: true },
    { name: "persistentvolumeclaims", kind: "PersistentVolumeClaim", namespaced: true },
    { name: "pods", kind: "Pod", namespaced: true }
  ],
  "apps/v1": [
    { name: "deployments", kind: "Deployment", namespaced: true },
    { name: "statefulsets", kind: "StatefulSet", namespaced: true }
  ],
  "apiextensions.k8s.io/v1": [
    { name: "customresourcedefinitions", kind: "CustomResourceDefinition", namespaced: false }
  ],
  "networking.k8s.io/v1": [{ name: "networkpolicies", kind: "NetworkPolicy", namespaced: true }],
  "rbac.authorization.k8s.io/v1": [
    { name: "clusterroles", kind: "ClusterRole", namespaced: false },
    { name: "roles", kind: "Role", namespaced: true }
  ]
};

export interface RecordedCall {
  method: string;
  kind: string;
  name: string;
  namespace?: string;
}

export class FakeKube implements KubeTransport {
  readonly objects = new Map<string, KubeObject>();
  readonly calls: RecordedCall[] = [];
  /** Requests whose `METHOD kind` or `METHOD kind/name` is listed here get a 403. */
  forbidden = new Set<string>();

  constructor(private readonly readyWhen: (o: KubeObject) => boolean = () => true) {}

  private discovery(): Record<string, Resource[]> {
    const out: Record<string, Resource[]> = { ...BUILTIN };
    for (const o of this.objects.values()) {
      if (o.kind !== "CustomResourceDefinition") continue;
      const spec = o["spec"] as {
        group: string;
        scope: string;
        names: { plural: string; kind: string };
        versions: { name: string }[];
      };
      for (const v of spec.versions) {
        const gv = `${spec.group}/${v.name}`;
        out[gv] = [
          ...(out[gv] ?? []),
          {
            name: spec.names.plural,
            kind: spec.names.kind,
            namespaced: spec.scope === "Namespaced"
          }
        ];
      }
    }
    return out;
  }

  private parse(
    path: string
  ): { gv: string; namespace?: string; resource: string; name?: string } | { discovery: string } {
    const url = new URL(path, "https://fake");
    const parts = url.pathname.split("/").filter(Boolean);
    let gv: string;
    let rest: string[];
    if (parts[0] === "api") {
      gv = parts[1]!;
      rest = parts.slice(2);
    } else {
      gv = `${parts[1]}/${parts[2]}`;
      rest = parts.slice(3);
    }
    if (rest.length === 0) return { discovery: gv };
    let namespace: string | undefined;
    if (rest[0] === "namespaces" && rest.length >= 3) {
      namespace = rest[1];
      rest = rest.slice(2);
    }
    return {
      gv,
      ...(namespace ? { namespace } : {}),
      resource: rest[0]!,
      ...(rest[1] ? { name: rest[1] } : {})
    };
  }

  key(apiVersion: string, kind: string, name: string, namespace?: string): string {
    const group = apiVersion.includes("/") ? apiVersion.split("/")[0] : "";
    return `${group}/${kind}/${namespace ?? ""}/${name}`;
  }

  find(kind: string, name: string, namespace?: string): KubeObject | undefined {
    for (const o of this.objects.values()) {
      if (
        o.kind === kind &&
        o.metadata.name === name &&
        (o.metadata.namespace ?? undefined) === namespace
      )
        return o;
    }
    return undefined;
  }

  private withStatus(o: KubeObject): KubeObject {
    const gen = Number((o.metadata as { generation?: number }).generation ?? 1);
    if (o.kind === "CustomResourceDefinition") {
      return { ...o, status: { conditions: [{ type: "Established", status: "True" }] } };
    }
    if (o.kind === "Deployment" || o.kind === "StatefulSet") {
      const want = (o["spec"] as { replicas?: number } | undefined)?.replicas ?? 1;
      const key = this.key(o.apiVersion, o.kind, o.metadata.name, o.metadata.namespace);
      if (this.readyWhen(o)) {
        this.everReady.add(key);
        return {
          ...o,
          status: {
            observedGeneration: gen,
            replicas: want,
            updatedReplicas: want,
            readyReplicas: want,
            availableReplicas: want
          }
        };
      }
      // A STALLED ROLLING UPDATE, the way the API server reports one (measured on kind): the new
      // pods exist and are not available, and — if a previous revision ever ran — the OLD pods are
      // still there and still available. A readiness check that only counts `available` passes it.
      const stalledOverOld = this.everReady.has(key);
      return {
        ...o,
        status: {
          observedGeneration: gen,
          replicas: stalledOverOld ? want * 2 : want,
          updatedReplicas: want,
          readyReplicas: stalledOverOld ? want : 0,
          availableReplicas: stalledOverOld ? want : 0,
          ...(o.kind === "StatefulSet" ? { currentRevision: "old", updateRevision: "new" } : {})
        }
      };
    }
    return o;
  }

  private readonly everReady = new Set<string>();

  async request(req: KubeRequest): Promise<KubeResponse> {
    const parsed = this.parse(req.path);
    const disc = this.discovery();
    if ("discovery" in parsed) {
      const resources = disc[parsed.discovery];
      return resources
        ? { status: 200, body: JSON.stringify({ resources }) }
        : { status: 404, body: "{}" };
    }
    const resource = (disc[parsed.gv] ?? []).find((r) => r.name === parsed.resource);
    if (!resource) return { status: 404, body: JSON.stringify({ message: "no such resource" }) };
    const call: RecordedCall = {
      method: req.method,
      kind: resource.kind,
      name: parsed.name ?? "",
      ...(parsed.namespace ? { namespace: parsed.namespace } : {})
    };
    this.calls.push(call);
    if (
      this.forbidden.has(`${req.method} ${resource.kind}`) ||
      this.forbidden.has(`${req.method} ${resource.kind}/${parsed.name ?? ""}`)
    ) {
      return { status: 403, body: JSON.stringify({ message: `${resource.kind} is forbidden` }) };
    }
    if (req.method === "GET" && !parsed.name) {
      const items = [...this.objects.values()].filter(
        (o) => o.kind === resource.kind && o.metadata.namespace === parsed.namespace
      );
      return { status: 200, body: JSON.stringify({ items }) };
    }
    const key = this.key(parsed.gv, resource.kind, parsed.name!, parsed.namespace);
    if (req.method === "GET") {
      const o = this.objects.get(key);
      return o
        ? { status: 200, body: JSON.stringify(this.withStatus(o)) }
        : { status: 404, body: "{}" };
    }
    if (req.method === "DELETE") {
      const existed = this.objects.delete(key);
      return existed ? { status: 200, body: "{}" } : { status: 404, body: "{}" };
    }
    const prev = this.objects.get(key);
    // A JSON merge patch (the rotation annotation): merged into what is stored.
    if (req.contentType === "application/merge-patch+json") {
      if (!prev) return { status: 404, body: "{}" };
      const merged = mergeJson(prev, JSON.parse(req.body ?? "{}")) as KubeObject;
      const gen = Number((prev.metadata as { generation?: number }).generation ?? 1);
      const bumped: KubeObject = {
        ...merged,
        metadata: {
          ...merged.metadata,
          generation:
            JSON.stringify(prev["spec"]) === JSON.stringify(merged["spec"]) ? gen : gen + 1
        }
      };
      this.objects.set(key, bumped);
      this.merges.push({ kind: resource.kind, name: parsed.name!, body: req.body ?? "" });
      return { status: 200, body: JSON.stringify(bumped) };
    }
    // PATCH = server-side apply: the applied object replaces the stored one; generation bumps when
    // the spec changes, the way the API server does.
    const applied = JSON.parse(req.body ?? "{}") as KubeObject;
    // The API server writes a Secret's `stringData` into `data`, base64-encoded.
    if (applied.kind === "Secret" && applied["stringData"]) {
      const stringData = applied["stringData"] as Record<string, string>;
      applied["data"] = {
        ...((applied["data"] as Record<string, string> | undefined) ?? {}),
        ...Object.fromEntries(
          Object.entries(stringData).map(([k, v]) => [k, Buffer.from(v).toString("base64")])
        )
      };
      delete applied["stringData"];
    }
    const prevGen = Number(
      (prev?.metadata as { generation?: number } | undefined)?.generation ?? 0
    );
    const specChanged = JSON.stringify(prev?.["spec"]) !== JSON.stringify(applied["spec"]);
    const stored: KubeObject = {
      // Server-side apply leaves fields another manager owns — a controller's `status` — alone.
      ...(prev?.["status"] !== undefined && applied["status"] === undefined
        ? { status: prev["status"] }
        : {}),
      ...applied,
      metadata: {
        ...applied.metadata,
        // A new object gets a new identity, the way the API server gives it one.
        uid: (prev?.metadata as { uid?: string } | undefined)?.uid ?? `uid-${++this.uids}`,
        generation: prev && !specChanged ? prevGen : prevGen + 1
      }
    };
    this.objects.set(key, stored);
    return { status: 200, body: JSON.stringify(stored) };
  }

  /** Puts an object in place as if someone else created it. */
  seed(o: KubeObject): void {
    this.objects.set(this.key(o.apiVersion, o.kind, o.metadata.name, o.metadata.namespace), o);
  }

  /** Merge patches received, in order. */
  readonly merges: { kind: string; name: string; body: string }[] = [];
  private uids = 0;

  applied(): RecordedCall[] {
    return this.calls.filter((c) => c.method === "PATCH");
  }
}

function mergeJson(base: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> =
    base && typeof base === "object" && !Array.isArray(base)
      ? { ...(base as Record<string, unknown>) }
      : {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) delete out[k];
    else out[k] = mergeJson(out[k], v);
  }
  return out;
}
