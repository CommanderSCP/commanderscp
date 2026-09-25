import { createHash } from "node:crypto";
import { parseAllDocuments } from "yaml";
import type { StackBackend } from "@scp/schemas";

/** One Kubernetes object as rendered. */
export interface KubeObject {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Enough to address an object again — what the inventory stores. */
export interface ObjectRef {
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
}

/** The labels that mark an object as the controller's. Deletion requires BOTH. */
export const MANAGED_BY_LABEL = "stack.commanderscp.io/managed-by";
export const MANAGED_BY_VALUE = "scp-stackd";
export const BACKEND_LABEL = "stack.commanderscp.io/backend";
export const RELEASE_ANNOTATION = "stack.commanderscp.io/release";

export function parseManifests(text: string): KubeObject[] {
  const out: KubeObject[] = [];
  // YAML 1.1, as kubectl reads it (sigs.k8s.io/yaml over go-yaml): a 1.2 parser reads `0755` as
  // seven hundred and fifty-five, and `yes` as a string, and would apply a different object.
  for (const doc of parseAllDocuments(text, { version: "1.1" })) {
    if (doc.errors.length > 0)
      throw new Error(`rendered YAML does not parse: ${doc.errors[0]!.message}`);
    const obj = doc.toJS({ maxAliasCount: -1 }) as unknown;
    if (obj === null || obj === undefined) continue;
    const o = obj as Partial<KubeObject>;
    if (typeof o.apiVersion !== "string" || typeof o.kind !== "string" || !o.metadata?.name) {
      throw new Error(
        `a rendered document has no apiVersion/kind/metadata.name: ${JSON.stringify(obj).slice(0, 200)}`
      );
    }
    out.push(o as KubeObject);
  }
  return out;
}

export function refOf(o: KubeObject | ObjectRef): ObjectRef {
  const r = "metadata" in o ? { name: o.metadata.name, namespace: o.metadata.namespace } : o;
  return {
    apiVersion: o.apiVersion,
    kind: o.kind,
    name: r.name,
    ...(r.namespace ? { namespace: r.namespace } : {})
  };
}

/** Identity across API versions of the same group/kind (an upgrade may move `v1beta1` -> `v1`). */
export function refKey(r: ObjectRef): string {
  const group = r.apiVersion.includes("/") ? r.apiVersion.split("/")[0] : "";
  return `${group}/${r.kind}/${r.namespace ?? ""}/${r.name}`;
}

export const isCrd = (o: ObjectRef | KubeObject): boolean =>
  o.kind === "CustomResourceDefinition" && o.apiVersion.startsWith("apiextensions.k8s.io/");

/** Stamps ownership on the object's own metadata only — never on a pod template, where a label
 *  change would roll every workload and could collide with a selector. */
export function stamp(objs: KubeObject[], backend: StackBackend, release: string): KubeObject[] {
  return objs.map((o) => ({
    ...o,
    metadata: {
      ...o.metadata,
      labels: {
        ...(o.metadata.labels ?? {}),
        [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
        [BACKEND_LABEL]: backend
      },
      annotations: { ...(o.metadata.annotations ?? {}), [RELEASE_ANNOTATION]: release }
    }
  }));
}

export function isOurs(live: unknown, backend: StackBackend): boolean {
  const labels = (live as { metadata?: { labels?: Record<string, string> } } | null)?.metadata
    ?.labels;
  return labels?.[MANAGED_BY_LABEL] === MANAGED_BY_VALUE && labels?.[BACKEND_LABEL] === backend;
}

/** JSON with object keys sorted at every depth, so equal objects always serialise equally. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** A stable identity for a rendered set: sha256 over the canonical JSON of its objects in key order. */
export function fingerprint(objs: KubeObject[]): string {
  const sorted = [...objs].sort((a, b) => refKey(refOf(a)).localeCompare(refKey(refOf(b))));
  return createHash("sha256").update(canonical(sorted)).digest("hex");
}

/** The objects of `before` that `after` no longer contains. */
export function removedRefs(before: ObjectRef[], after: ObjectRef[]): ObjectRef[] {
  const keep = new Set(after.map(refKey));
  return before.filter((r) => !keep.has(refKey(r)));
}

export function unionRefs(a: ObjectRef[], b: ObjectRef[]): ObjectRef[] {
  const seen = new Map<string, ObjectRef>();
  for (const r of [...a, ...b]) seen.set(refKey(r), r);
  return [...seen.values()];
}

// ---- the kinds a backend may consist of ---------------------------------------------------------

/** One kind the controller may apply: `group` is "" for the core group. */
export interface StackKind {
  group: string;
  kind: string;
  /** false: cluster-scoped (any `metadata.namespace` on it is ignored by the API server). */
  namespaced: boolean;
}

/**
 * EVERY KIND A BACKEND MAY BE MADE OF — the kinds `deploy/helm/templates/stackd-rbac.yaml` grants
 * the controller, and nothing else (`manifests.test.ts` holds the two lists together; the image's
 * `--self-test` validates every real render against this one). A namespaced object must be in its
 * backend's own namespace; a Namespace must BE that namespace.
 *
 * Why the controller checks what it applies and deletes (review S1): the same check runs on what
 * it reads BACK — the stored last good set before a fall back, the inventory before a prune — so a
 * stored set that was rewritten can never make the controller apply, or delete, anything outside
 * the backend it belongs to, whatever its RBAC would allow.
 */
export const STACK_KINDS: readonly StackKind[] = [
  { group: "", kind: "Namespace", namespaced: false },
  { group: "", kind: "ConfigMap", namespaced: true },
  { group: "", kind: "Secret", namespaced: true },
  { group: "", kind: "Service", namespaced: true },
  { group: "", kind: "ServiceAccount", namespaced: true },
  { group: "", kind: "PersistentVolumeClaim", namespaced: true },
  { group: "apps", kind: "Deployment", namespaced: true },
  { group: "apps", kind: "StatefulSet", namespaced: true },
  { group: "apps", kind: "DaemonSet", namespaced: true },
  { group: "networking.k8s.io", kind: "NetworkPolicy", namespaced: true },
  { group: "rbac.authorization.k8s.io", kind: "Role", namespaced: true },
  { group: "rbac.authorization.k8s.io", kind: "RoleBinding", namespaced: true },
  { group: "rbac.authorization.k8s.io", kind: "ClusterRole", namespaced: false },
  { group: "rbac.authorization.k8s.io", kind: "ClusterRoleBinding", namespaced: false },
  { group: "apiextensions.k8s.io", kind: "CustomResourceDefinition", namespaced: false },
  { group: "scheduling.k8s.io", kind: "PriorityClass", namespaced: false },
  { group: "argoproj.io", kind: "WorkflowTemplate", namespaced: true }
];

const groupOf = (apiVersion: string): string =>
  apiVersion.includes("/") ? apiVersion.split("/")[0]! : "";

/** Why `ref` may not be part of `namespace`'s backend, or null when it may. */
export function refViolation(
  ref: ObjectRef,
  namespace: string,
  kinds: readonly StackKind[] = STACK_KINDS
): string | null {
  const group = groupOf(ref.apiVersion);
  const k = kinds.find((x) => x.group === group && x.kind === ref.kind);
  const what = `${ref.apiVersion} ${ref.kind} ${ref.namespace ? `${ref.namespace}/` : ""}${ref.name}`;
  if (!k) return `${what}: not a kind a stack backend may contain`;
  if (ref.kind === "Namespace" && group === "" && ref.name !== namespace) {
    return `${what}: a backend's only Namespace is its own (${namespace})`;
  }
  if (k.namespaced && ref.namespace !== namespace) {
    return `${what}: outside the backend's namespace ${namespace}`;
  }
  return null;
}

/** Throws unless every object may belong to `namespace`'s backend. */
export function assertStackSet(
  objs: (KubeObject | ObjectRef)[],
  namespace: string,
  what: string,
  kinds: readonly StackKind[] = STACK_KINDS
): void {
  const bad = objs
    .map((o) => refViolation(refOf(o), namespace, kinds))
    .filter((v): v is string => v !== null);
  if (bad.length > 0) {
    throw new Error(
      `${what} is refused: ${bad.length} object(s) outside what a stack backend may contain — ${bad.slice(0, 3).join("; ")}`
    );
  }
}
