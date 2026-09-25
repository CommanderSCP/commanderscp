import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertStackSet, refViolation, STACK_KINDS } from "./manifests.js";

/**
 * `STACK_KINDS` is what the controller will apply or delete, and `stackd-rbac.yaml` is what the
 * cluster lets it. They are held together here, so neither can widen alone: a kind the controller
 * would accept but has no right to is a render that fails at apply time, and a right the
 * controller has but would refuse to use is a right nobody needs.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** M29.3: granted for `authoring.ts` alone (see the test below). */
const AUTHORING_RESOURCES = new Set(["argoproj.io/applications", "argoproj.io/appprojects"]);
const RBAC = readFileSync(
  path.join(HERE, "../../../deploy/helm/templates/stackd-rbac.yaml"),
  "utf8"
);

/** `group/resource` -> verbs, from the template's `- apiGroups/resources/verbs` rules. */
function grants(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const list = (line: string) =>
    [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]!).filter((x) => x !== undefined);
  const lines = RBAC.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*- apiGroups:/.test(lines[i]!)) continue;
    const groups = list(lines[i]!);
    const resources = list(lines[i + 1]!);
    const verbsLine = lines.slice(i + 2, i + 12).find((l) => /^\s*verbs:/.test(l))!;
    for (const g of groups)
      for (const r of resources) {
        const key = `${g}/${r}`;
        out.set(key, new Set([...(out.get(key) ?? []), ...list(verbsLine)]));
      }
  }
  return out;
}

const plural = (kind: string) => {
  const lower = kind.toLowerCase();
  return lower.endsWith("y")
    ? `${lower.slice(0, -1)}ies`
    : lower.endsWith("s")
      ? `${lower}es`
      : `${lower}s`;
};

describe("the kinds a stack backend may contain", () => {
  it("parses the RBAC template (known-positive control)", () => {
    expect(grants().get("apps/deployments")).toEqual(new Set(["get", "create", "patch", "delete"]));
  });

  it("every allowed kind is one the controller has the right to apply", () => {
    const g = grants();
    for (const k of STACK_KINDS) {
      const verbs = g.get(`${k.group}/${plural(k.kind)}`);
      expect(verbs, `${k.group}/${k.kind} has no grant in stackd-rbac.yaml`).toBeDefined();
      // Namespaces are the main chart's: the controller may only patch the five it names.
      expect(verbs!.has(k.kind === "Namespace" ? "patch" : "create"), k.kind).toBe(true);
    }
  });

  it("every create/patch right the controller holds is for an allowed kind", () => {
    const allowed = new Set(STACK_KINDS.map((k) => `${k.group}/${plural(k.kind)}`));
    for (const [resource, verbs] of grants()) {
      if (!verbs.has("create") && !verbs.has("patch")) continue;
      if (AUTHORING_RESOURCES.has(resource)) continue;
      expect(allowed.has(resource), `${resource} is granted but not in STACK_KINDS`).toBe(true);
    }
  });

  it("M29.3: the Argo CD kinds canary authoring applies are granted ONLY by the authoring Role, in Argo CD's namespace", () => {
    // Not stack-backend kinds (no backend's render contains one; `assertStackSet` still refuses
    // them in a render): `authoring.ts` applies the two AppProjects and the Rollouts-to-target
    // Applications, and nothing else of argoproj.io but a catalog WorkflowTemplate.
    const role = RBAC.slice(RBAC.indexOf("name: {{ $name }}-authoring"));
    const block = role.slice(0, role.indexOf("---"));
    expect(block).toMatch(/namespace: \{\{ \.Values\.stackd\.authoring\.argocdNamespace \}\}/);
    expect(block).toMatch(/resources: \["applications", "appprojects"\]/);
    const elsewhere = RBAC.replace(block, "");
    expect(elsewhere).not.toMatch(/"applications"|"appprojects"/);
    for (const k of STACK_KINDS)
      expect(k.kind === "Application" || k.kind === "AppProject").toBe(false);
  });

  it("refuses a kind outside the list, a namespaced object outside the backend, and another Namespace", () => {
    const ns = "scp-gitea";
    expect(refViolation({ apiVersion: "v1", kind: "Pod", name: "p", namespace: ns }, ns)).toMatch(
      /not a kind/
    );
    expect(
      refViolation({ apiVersion: "batch/v1", kind: "Job", name: "j", namespace: ns }, ns)
    ).toMatch(/not a kind/);
    expect(
      refViolation({ apiVersion: "apps/v1", kind: "Deployment", name: "d", namespace: "scp" }, ns)
    ).toMatch(/outside the backend's namespace/);
    expect(refViolation({ apiVersion: "apps/v1", kind: "Deployment", name: "d" }, ns)).toMatch(
      /outside/
    );
    expect(refViolation({ apiVersion: "v1", kind: "Namespace", name: "kube-system" }, ns)).toMatch(
      /only Namespace is its own/
    );
    expect(refViolation({ apiVersion: "v1", kind: "Namespace", name: ns }, ns)).toBeNull();
    expect(
      refViolation(
        { apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", name: "x" },
        ns
      )
    ).toBeNull();
    expect(() =>
      assertStackSet(
        [{ apiVersion: "v1", kind: "Secret", metadata: { name: "s", namespace: "scp" } }],
        ns,
        "the set"
      )
    ).toThrow(/the set is refused/);
  });
});
