import type { KubeClient } from "./kube.js";
import { isCrd, refOf, type KubeObject, type ObjectRef } from "./manifests.js";

/**
 * IS A RENDERED SET HEALTHY? Every Deployment, StatefulSet and DaemonSet in it must have rolled out
 * its CURRENT generation with every replica available — the same test `kubectl rollout status`
 * applies — and every CRD must be Established. When it is not, the evidence (which workload, and
 * why its pods are waiting) is what the Stack page and the diagnostics bundle show.
 */

export interface Readiness {
  ready: boolean;
  detail: string[];
}

const WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet"]);

interface WorkloadStatus {
  observedGeneration?: number;
  replicas?: number;
  readyReplicas?: number;
  updatedReplicas?: number;
  availableReplicas?: number;
  desiredNumberScheduled?: number;
  numberAvailable?: number;
  updatedNumberScheduled?: number;
}

/** One workload's verdict, from its live object. Pure — exported for the unit suite. */
export function workloadVerdict(live: KubeObject): { ready: boolean; line: string } {
  const name = `${live.kind.toLowerCase()} ${live.metadata.namespace ?? ""}/${live.metadata.name}`;
  const generation = Number((live.metadata as { generation?: number }).generation ?? 0);
  const status = (live["status"] ?? {}) as WorkloadStatus;
  if ((status.observedGeneration ?? 0) < generation) {
    return { ready: false, line: `${name}: generation ${generation} not yet observed` };
  }
  if (live.kind === "DaemonSet") {
    const want = status.desiredNumberScheduled ?? 0;
    const ok =
      (status.numberAvailable ?? 0) >= want && (status.updatedNumberScheduled ?? 0) >= want;
    return { ready: ok, line: `${name}: ${status.numberAvailable ?? 0}/${want} available` };
  }
  const spec = (live["spec"] ?? {}) as { replicas?: number };
  const want = spec.replicas ?? 1;
  const available =
    live.kind === "StatefulSet" ? (status.readyReplicas ?? 0) : (status.availableReplicas ?? 0);
  const ok = available >= want && (status.updatedReplicas ?? 0) >= want;
  return {
    ready: ok,
    line: `${name}: ${available}/${want} available, ${status.updatedReplicas ?? 0} updated`
  };
}

export function crdEstablished(live: KubeObject): boolean {
  const conditions = ((live["status"] ?? {}) as { conditions?: { type: string; status: string }[] })
    .conditions;
  return (conditions ?? []).some((c) => c.type === "Established" && c.status === "True");
}

/** Why a namespace's pods are not running — waiting reasons, bounded. */
async function podEvidence(kube: KubeClient, namespace: string): Promise<string[]> {
  const lines: string[] = [];
  for (const pod of await kube.listPods(namespace)) {
    const statuses = [
      ...(((pod["status"] as { initContainerStatuses?: unknown[] } | undefined)
        ?.initContainerStatuses ?? []) as ContainerStatus[]),
      ...(((pod["status"] as { containerStatuses?: unknown[] } | undefined)?.containerStatuses ??
        []) as ContainerStatus[])
    ];
    for (const c of statuses) {
      const waiting = c.state?.waiting;
      if (waiting?.reason) {
        const msg = waiting.message ? `: ${waiting.message.slice(0, 200)}` : "";
        lines.push(
          `pod ${namespace}/${pod.metadata.name} container ${c.name} ${waiting.reason}${msg}`
        );
      }
    }
  }
  return lines.slice(0, 20);
}

interface ContainerStatus {
  name: string;
  state?: { waiting?: { reason?: string; message?: string } };
}

export async function checkReadiness(
  kube: KubeClient,
  objs: (KubeObject | ObjectRef)[]
): Promise<Readiness> {
  const detail: string[] = [];
  let ready = true;
  const unhealthyNamespaces = new Set<string>();
  for (const o of objs) {
    const ref = refOf(o);
    if (isCrd(ref)) {
      const live = await kube.get(ref);
      if (!live || !crdEstablished(live)) {
        ready = false;
        detail.push(`customresourcedefinition ${ref.name}: not Established`);
      }
      continue;
    }
    if (!WORKLOAD_KINDS.has(ref.kind)) continue;
    const live = await kube.get(ref);
    if (!live) {
      ready = false;
      detail.push(`${ref.kind.toLowerCase()} ${ref.namespace ?? ""}/${ref.name}: absent`);
      continue;
    }
    const verdict = workloadVerdict(live);
    detail.push(verdict.line);
    if (!verdict.ready) {
      ready = false;
      if (ref.namespace) unhealthyNamespaces.add(ref.namespace);
    }
  }
  for (const ns of unhealthyNamespaces) detail.push(...(await podEvidence(kube, ns)));
  return { ready, detail: detail.slice(0, 50) };
}
