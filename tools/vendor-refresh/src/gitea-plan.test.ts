import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { planGitea } from "./gitea-plan.js";
import type { VendorRefreshIO } from "./types.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_CHART = resolve(__dirname, "test-support/fixtures/gitea-chart");

/** The REAL `helm` binary against a LOCAL fixture chart — no network, no real gitea-charts repo.
 *  `which helm` must resolve on the machine this test runs on; every CI/dev image in this repo
 *  already has `helm` (deploy/helm-bundled's own gate uses it), so no new tool dependency is added. */
function ioAgainstFixtureChart(digest: string): VendorRefreshIO {
  return {
    fetchText: async () => {
      throw new Error("not used by the gitea plan");
    },
    resolveImageDigest: async () => digest,
    runHelmTemplate: async (args) => {
      const { stdout } = await execFileAsync("helm", [...args], { maxBuffer: 64 * 1024 * 1024 });
      return stdout;
    }
  };
}

describe("planGitea", () => {
  it("strips every Secret and the helm-test pod, extracts the 4 scripts, tracks the image", async () => {
    const digest = `sha256:${"d".repeat(64)}`;
    const io = ioAgainstFixtureChart(digest);
    const plan = await planGitea(FIXTURE_CHART, "12.6.0-fixture", io);

    const byPath = new Map(plan.files.map((f) => [f.path, f.content]));
    const manifest = byPath.get("deploy/helm-bundled/vendor/gitea/install-no-secrets.yaml");
    expect(manifest).toBeDefined();
    // No Secret survives.
    expect(manifest).not.toMatch(/kind:\s*Secret/);
    // No helm-test pod survives.
    expect(manifest).not.toMatch(/test-connection/);
    // No `# Source:` comment survives.
    expect(manifest).not.toMatch(/# Source:/);
    // The real, non-secret resources DO survive.
    expect(manifest).toMatch(/kind: Deployment/);
    expect(manifest).toMatch(/kind: PersistentVolumeClaim/);
    expect(manifest).toMatch(/kind: Service/);

    expect(byPath.get("deploy/helm-bundled/vendor/gitea/config/config_environment.sh")).toBe(
      '#!/usr/bin/env bash\necho "fixture config_environment.sh for 1.26.1-fixture"\n'
    );
    expect(byPath.get("deploy/helm-bundled/vendor/gitea/init/configure_gpg_environment.sh")).toBe(
      '#!/usr/bin/env bash\necho "fixture configure_gpg_environment.sh"\n'
    );
    expect(byPath.get("deploy/helm-bundled/vendor/gitea/init/init_directory_structure.sh")).toBe(
      '#!/usr/bin/env bash\necho "fixture init_directory_structure.sh"\n'
    );
    expect(byPath.get("deploy/helm-bundled/vendor/gitea/init/configure_gitea.sh")).toBe(
      '#!/usr/bin/env bash\necho "fixture configure_gitea.sh"\n'
    );

    expect(plan.trackedImages).toEqual([
      {
        bundleImageName: "gitea",
        tagRef: "docker.gitea.com/gitea:1.26.1-fixture-rootless",
        resolvedRef: `docker.gitea.com/gitea:1.26.1-fixture-rootless@${digest}`
      }
    ]);
  });

  it("is deterministic: planning the same chart version twice produces byte-identical files", async () => {
    const io = ioAgainstFixtureChart(`sha256:${"e".repeat(64)}`);
    const first = await planGitea(FIXTURE_CHART, "12.6.0-fixture", io);
    const second = await planGitea(FIXTURE_CHART, "12.6.0-fixture", io);
    expect(second.files).toEqual(first.files);
    expect(second.trackedImages).toEqual(first.trackedImages);
  });
});
