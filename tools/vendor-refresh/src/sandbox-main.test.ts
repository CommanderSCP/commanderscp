import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLE_IMAGES_TS_PATH, VALUES_YAML_PATH } from "./plan.js";
import { runSandbox, type FullSandboxInput } from "./sandbox-main.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_CHART = resolve(__dirname, "test-support/fixtures/gitea-chart");

const ARGOCD_MANIFEST = (tag: string) =>
  [
    "apiVersion: v1",
    "kind: Namespace",
    "metadata:",
    "  name: argocd",
    "---",
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    "  name: argocd-server",
    "spec:",
    "  template:",
    "    spec:",
    "      containers:",
    "      - name: argocd-server",
    `        image: quay.io/argoproj/argocd:${tag}`,
    ""
  ].join("\n");

const REPO_FILES = {
  valuesYaml: "image: quay.io/argoproj/argocd:v3.4.5 # Argo CD (Apache-2.0)\n",
  bundleImagesTs: '{ name: "argocd", defaultRef: "quay.io/argoproj/argocd:v3.4.5" }\n',
  imagesList: "# no argocd line today\n"
};

function argocdInput(overrides: Partial<FullSandboxInput> = {}): FullSandboxInput {
  return {
    backend: "argocd",
    toTag: "v3.5.0",
    manifestText: ARGOCD_MANIFEST("v3.5.0"),
    resolvedDigests: { "quay.io/argoproj/argocd:v3.5.0": `sha256:${"9".repeat(64)}` },
    currentVendoredFiles: {
      "deploy/helm-bundled/vendor/argocd/install.yaml": ARGOCD_MANIFEST("v3.4.5")
    },
    ...REPO_FILES,
    ...overrides
  };
}

describe("runSandbox — argocd", () => {
  it("produces the same plan planVendorRefresh would, and classifies a pure tag bump as image-only", async () => {
    const { plan, classification } = await runSandbox(argocdInput());
    const byPath = new Map(plan.files.map((f) => [f.path, f.content]));
    expect(byPath.get("deploy/helm-bundled/vendor/argocd/install.yaml")).toBe(
      ARGOCD_MANIFEST("v3.5.0")
    );
    expect(byPath.get(VALUES_YAML_PATH)).toContain("v3.5.0");
    expect(byPath.get(BUNDLE_IMAGES_TS_PATH)).toContain("v3.5.0");
    expect(classification).toEqual({ class: "image-only", reasons: [] });
  });

  it("classifies requires-review when the new manifest smuggles an authority-kind change alongside the real bump", async () => {
    const withBinding =
      ARGOCD_MANIFEST("v3.5.0") +
      [
        "---",
        "apiVersion: rbac.authorization.k8s.io/v1",
        "kind: ClusterRoleBinding",
        "metadata:",
        "  name: attacker-binding",
        "roleRef:",
        "  kind: ClusterRole",
        "  name: cluster-admin",
        "  apiGroup: rbac.authorization.k8s.io",
        ""
      ].join("\n");
    const { classification } = await runSandbox(argocdInput({ manifestText: withBinding }));
    expect(classification.class).toBe("requires-review");
    expect(classification.reasons.some((r) => r.includes("ClusterRoleBinding"))).toBe(true);
  });

  /** MUTATION-PROVE (finding 1's "manifest's own tags must equal toTag"): if the fetched manifest
   *  actually declares some tag OTHER than toTag — a stale orchestrator fetch, or a tampered
   *  upstream — the plan must fail, not silently vendor the wrong version. The sandbox has no
   *  network of its own to resolve a digest for anything the orchestrator did not already verify, so
   *  this is enforced with no extra code — see sandbox-io.ts's module doc. */
  it("REFUSES when the fetched manifest declares a tag other than toTag", async () => {
    await expect(
      runSandbox(argocdInput({ manifestText: ARGOCD_MANIFEST("v3.4.5") }))
    ).rejects.toThrow(/no pre-resolved digest/);
  });

  it("classifies requires-review when an object present before is missing from the new manifest", async () => {
    const { classification } = await runSandbox(
      argocdInput({
        currentVendoredFiles: {
          "deploy/helm-bundled/vendor/argocd/install.yaml":
            ARGOCD_MANIFEST("v3.4.5") +
            "---\napiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: will-be-removed\n"
        }
      })
    );
    expect(classification.class).toBe("requires-review");
    expect(classification.reasons.some((r) => r.includes("REMOVED"))).toBe(true);
  });
});

describe("runSandbox — gitea (real helm against a LOCAL fixture chart — no network)", () => {
  it("renders via the local chart dir (--version stripped) and produces the same plan planGitea would", async () => {
    const input: FullSandboxInput = {
      backend: "gitea",
      toTag: "12.6.0-fixture",
      chartDir: FIXTURE_CHART,
      resolvedDigests: {
        "docker.gitea.com/gitea:1.26.1-fixture-rootless": `sha256:${"d".repeat(64)}`
      },
      currentVendoredFiles: {},
      valuesYaml: "gitea:\n  image: docker.gitea.com/gitea:1.26.0-fixture-rootless\n",
      bundleImagesTs:
        '{ name: "gitea", defaultRef: "docker.gitea.com/gitea:1.26.0-fixture-rootless" }\n',
      imagesList: ""
    };
    const { plan, classification } = await runSandbox(input);
    const byPath = new Map(plan.files.map((f) => [f.path, f.content]));
    const manifest = byPath.get("deploy/helm-bundled/vendor/gitea/install-no-secrets.yaml");
    expect(manifest).toBeDefined();
    expect(manifest).not.toMatch(/kind:\s*Secret/);
    expect(plan.trackedImages).toEqual([
      {
        bundleImageName: "gitea",
        tagRef: "docker.gitea.com/gitea:1.26.1-fixture-rootless",
        resolvedRef: `docker.gitea.com/gitea:1.26.1-fixture-rootless@sha256:${"d".repeat(64)}`
      }
    ]);
    // No prior vendored file was supplied (currentVendoredFiles: {}) — every object in the new render
    // is "new" relative to nothing, so this is REQUIRES-REVIEW (correctly: there is nothing to
    // classify AS a pure bump against). A real re-vendor always supplies the actual current file.
    expect(classification.class).toBe("requires-review");
  });
});
