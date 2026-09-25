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
  currentRevision?: string;
  updateRevision?: string;
  desiredNumberScheduled?: number;
  numberAvailable?: number;
  updatedNumberScheduled?: number;
}

/**
 * One workload's verdict, from its live object — `kubectl rollout status`'s rules, not a looser
 * paraphrase of them. MEASURED on kind, not assumed: a one-replica Deployment rolling to an image
 * that never pulls keeps its OLD pod available (maxUnavailable rounds to 0), so "available >= 1 and
 * updated >= 1" reads as healthy while the new pod sits in ImagePullBackOff. The rollout is done
 * only when no pod of an older revision remains and every updated pod is available.
 */
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
      (status.updatedNumberScheduled ?? 0) >= want && (status.numberAvailable ?? 0) >= want;
    return {
      ready: ok,
      line: `${name}: ${status.numberAvailable ?? 0}/${want} available, ${status.updatedNumberScheduled ?? 0} updated`
    };
  }
  const spec = (live["spec"] ?? {}) as { replicas?: number };
  const want = spec.replicas ?? 1;
  const updated = status.updatedReplicas ?? 0;
  const total = status.replicas ?? 0;
  if (live.kind === "StatefulSet") {
    const ready = status.readyReplicas ?? 0;
    const sameRevision =
      status.updateRevision === undefined || status.currentRevision === status.updateRevision;
    const ok = ready >= want && updated >= want && sameRevision;
    return { ready: ok, line: `${name}: ${ready}/${want} ready, ${updated} updated` };
  }
  const available = status.availableReplicas ?? 0;
  const ok = updated >= want && total <= updated && available >= updated;
  const old = total > updated ? `, ${total - updated} old pending termination` : "";
  return {
    ready: ok,
    line: `${name}: ${available}/${want} available, ${updated} updated${old}`
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
