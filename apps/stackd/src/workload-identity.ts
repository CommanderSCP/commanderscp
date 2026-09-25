import { createHash } from "node:crypto";
import {
  STACK_WORKLOAD_IDENTITY_PROVIDERS,
  StackWorkloadIdentitySpecSchema,
  isWorkloadIdentitySlot,
  type StackBackend,
  type StackNeed,
  type StackWorkloadIdentitySpec
} from "@scp/schemas";
import type { KubeObject } from "./manifests.js";

/**
 * WORKLOAD IDENTITY, PREFERRED WHEREVER THE SUBSTRATE PROVIDES IT (M29.5, ADR-0062).
 *
 * A declaration names an enumerated ServiceAccount of a backend and a provider with its
 * pattern-bound identifier. The controller sets the provider's annotation on that ServiceAccount
 * IN ITS OWN RENDER — the object it is about to apply, never through helm values, so an identifier
 * can only ever be an annotation value — and, where the provider's webhook keys on a pod label
 * (Azure), sets that label on every pod template running as it. A pod-template annotation carrying
 * a digest of the declaration rolls those workloads, because the identity is injected at pod
 * creation. Nothing needs entering at all; the cloud side (the role's trust of
 * `system:serviceaccount:<namespace>:<serviceAccount>`) is what actually grants authority.
 */

export const WORKLOAD_IDENTITY_ANNOTATION = "stack.commanderscp.io/workload-identity";

/** The declarations the spec carries, re-validated here: only enumerated slots with a
 *  pattern-bound identifier survive (the spec census proves there is nothing else to carry). */
export function validWorkloadIdentities(raw: unknown): StackWorkloadIdentitySpec[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const parsed = StackWorkloadIdentitySpecSchema.safeParse(r);
    return parsed.success && isWorkloadIdentitySlot(parsed.data.backend, parsed.data.serviceAccount)
      ? [parsed.data]
      : [];
  });
}

type PodSpecHolder = { spec?: Record<string, unknown>; metadata?: Record<string, unknown> };

/** The pod template of a workload, and the object whose labels a pod inherits from it. */
function podTemplates(obj: KubeObject): { sa: unknown; meta: () => Record<string, unknown> }[] {
  const spec = obj["spec"] as Record<string, unknown> | undefined;
  if (!spec) return [];
  if (["Deployment", "StatefulSet", "DaemonSet", "Job"].includes(obj.kind)) {
    const template = (spec["template"] ??= {}) as PodSpecHolder;
    return [
      {
        sa: template.spec?.["serviceAccountName"],
        meta: () => (template.metadata ??= {})
      }
    ];
  }
  if (obj.kind === "WorkflowTemplate") {
    // Argo copies spec.podMetadata onto every pod of the workflow.
    return [
      {
        sa: spec["serviceAccountName"],
        meta: () => (spec["podMetadata"] ??= {}) as Record<string, unknown>
      }
    ];
  }
  return [];
}

const setIn = (o: Record<string, unknown>, field: string, k: string, v: string) => {
  const m = (o[field] ??= {}) as Record<string, string>;
  m[k] = v;
};

/**
 * Applies the declarations for one backend to its rendered objects, in place. Returns a need for
 * each declaration whose ServiceAccount this render does not contain (for example infra
 * plan/apply, which is not installed until a state backend is configured) — declared, not yet in
 * effect, said so rather than silently ignored.
 */
export function applyWorkloadIdentities(
  backend: StackBackend,
  objects: KubeObject[],
  declarations: StackWorkloadIdentitySpec[]
): StackNeed[] {
  const needs: StackNeed[] = [];
  for (const d of declarations.filter((x) => x.backend === backend)) {
    const provider = STACK_WORKLOAD_IDENTITY_PROVIDERS[d.provider];
    const sa = objects.find(
      (o) => o.kind === "ServiceAccount" && o.metadata.name === d.serviceAccount
    );
    if (!sa) {
      needs.push({
        code: "credentials",
        message: `A workload identity (${provider.label}) is declared for ${d.serviceAccount}, but this release does not install that ServiceAccount yet, so it is not in effect.`
      });
      continue;
    }
    setIn(sa.metadata as Record<string, unknown>, "annotations", provider.annotation, d.identifier);
    const digest = createHash("sha256")
      .update(`${d.provider}\u0000${d.identifier}`)
      .digest("hex")
      .slice(0, 16);
    for (const obj of objects) {
      for (const t of podTemplates(obj)) {
        if (t.sa !== d.serviceAccount) continue;
        const meta = t.meta();
        setIn(meta, "annotations", WORKLOAD_IDENTITY_ANNOTATION, digest);
        if (provider.podLabel) setIn(meta, "labels", provider.podLabel, "true");
      }
    }
  }
  return needs;
}
