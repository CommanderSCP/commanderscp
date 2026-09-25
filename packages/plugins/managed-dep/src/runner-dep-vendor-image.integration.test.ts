import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveRunnerImage } from "@scp/plugin-testkit";
import type { FullSandboxInput, SandboxOutput } from "@scp/vendor-refresh";
import { beforeAll, describe, expect, it } from "vitest";

/** `apps/runner-dep-vendor`, as BUILT — real `docker build`/`docker run --network none`, never the
 *  in-process `runSandbox` `revendor.test.ts`'s fake launcher calls. That suite proves the DISPATCH
 *  wiring; this one proves the CONTAINER — the pinned helm binary actually runs `helm template`
 *  offline against a local chart dir, the entrypoint actually reads `/work/in/input.json` and
 *  writes `/work/out/output.json`, and neither needs the network `--network none` denies. */

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");
const RUNNER_IMAGE_TAG = "scp-runner-dep-vendor:m29-8a-integration-test";
const DOCKERFILE = resolve(REPO_ROOT, "apps/runner-dep-vendor/Dockerfile");
const FIXTURE_CHART = resolve(
  REPO_ROOT,
  "tools/vendor-refresh/src/test-support/fixtures/gitea-chart"
);

let runnerImageRef = RUNNER_IMAGE_TAG;
let dockerReady = false;

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  dockerReady = await dockerAvailable();
  if (!dockerReady) return;
  runnerImageRef = await resolveRunnerImage({
    refEnvVar: "SCP_RUNNER_DEP_VENDOR_IMAGE_REF",
    localTag: RUNNER_IMAGE_TAG,
    // THE REPO ROOT, not apps/runner-dep-vendor — see the Dockerfile's own header for why.
    context: REPO_ROOT,
    dockerfile: DOCKERFILE
  });
}, 600_000);

/** `docker run --network none`, feeding `input.json` (and, for gitea, the chart directory — COPIED
 *  onto the host scratch tree first, never a second nested mount: `docker create`+`docker cp` is
 *  what production actually uses, and a nested bind mount under an already-READ-ONLY parent mount
 *  cannot even create its own mountpoint, which is a property of bind mounts, not of anything this
 *  image does) via a bind-mounted `/work/in`, and reading `output.json` back from a bind-mounted
 *  `/work/out` — equivalent to `revendor-orchestrator.ts`'s `runVendorSandbox`'s `docker cp` for a
 *  test that only cares about the bytes exchanged, and needs no `RunnerLauncher`. */
async function runSandboxContainer(
  input: FullSandboxInput,
  copyIntoIn: ReadonlyMap<string, string> = new Map()
): Promise<SandboxOutput> {
  const scratch = await mkdtemp(join(tmpdir(), "scp-runner-dep-vendor-it-"));
  const inDir = join(scratch, "in");
  const outDir = join(scratch, "out");
  await execFileAsync("mkdir", ["-p", inDir, outDir]);
  for (const [destRelPath, srcPath] of copyIntoIn) {
    const dest = join(inDir, destRelPath);
    await execFileAsync("mkdir", ["-p", dirname(dest)]);
    await execFileAsync("cp", ["-r", srcPath, dest]);
  }
  await writeFile(join(inDir, "input.json"), JSON.stringify(input), "utf8");
  try {
    await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${inDir}:/work/in:ro`,
        "-v",
        `${outDir}:/work/out`,
        runnerImageRef
      ],
      { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }
    );
    const raw = await readFile(join(outDir, "output.json"), "utf8");
    return JSON.parse(raw) as SandboxOutput;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

describe("scp-runner-dep-vendor, as built (real container, --network none)", () => {
  const ARGOCD_MANIFEST = [
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
    "        image: quay.io/argoproj/argocd:v3.5.0",
    ""
  ].join("\n");

  it("plans an argocd re-vendor (raw-tree fetch shape) with zero network access", async () => {
    if (!dockerReady) return expectSkipped();
    const input: FullSandboxInput = {
      backend: "argocd",
      toTag: "v3.5.0",
      manifestText: ARGOCD_MANIFEST,
      resolvedDigests: { "quay.io/argoproj/argocd:v3.5.0": `sha256:${"9".repeat(64)}` },
      currentVendoredFiles: {
        "deploy/helm-bundled/vendor/argocd/install.yaml": ARGOCD_MANIFEST.replace(
          "v3.5.0",
          "v3.4.5"
        )
      },
      valuesYaml: "image: quay.io/argoproj/argocd:v3.4.5 # Argo CD (Apache-2.0)\n",
      bundleImagesTs: '{ name: "argocd", defaultRef: "quay.io/argoproj/argocd:v3.4.5" }\n',
      imagesList: "# no argocd line today\n"
    };
    const output = await runSandboxContainer(input);
    expect(output.classification).toEqual({ class: "image-only", reasons: [] });
    const byPath = new Map(output.plan.files.map((f) => [f.path, f.content]));
    expect(byPath.get("deploy/helm-bundled/vendor/argocd/install.yaml")).toBe(ARGOCD_MANIFEST);
    expect(byPath.get("deploy/helm-bundled/values.yaml")).toContain("v3.5.0");
  }, 180_000);

  it("renders gitea via the pinned helm binary against a LOCAL chart dir, offline", async () => {
    if (!dockerReady) return expectSkipped();
    const input: FullSandboxInput = {
      backend: "gitea",
      toTag: "12.6.0-fixture",
      chartDir: "/work/in/chart",
      resolvedDigests: {
        "docker.gitea.com/gitea:1.26.1-fixture-rootless": `sha256:${"d".repeat(64)}`
      },
      currentVendoredFiles: {},
      valuesYaml: "gitea:\n  image: docker.gitea.com/gitea:1.26.0-fixture-rootless\n",
      bundleImagesTs:
        '{ name: "gitea", defaultRef: "docker.gitea.com/gitea:1.26.0-fixture-rootless" }\n',
      imagesList: ""
    };
    const output = await runSandboxContainer(input, new Map([["chart", FIXTURE_CHART]]));
    expect(output.plan.trackedImages).toEqual([
      {
        bundleImageName: "gitea",
        tagRef: "docker.gitea.com/gitea:1.26.1-fixture-rootless",
        resolvedRef: `docker.gitea.com/gitea:1.26.1-fixture-rootless@sha256:${"d".repeat(64)}`
      }
    ]);
    const manifest = output.plan.files.find(
      (f) => f.path === "deploy/helm-bundled/vendor/gitea/install-no-secrets.yaml"
    );
    expect(manifest?.content).not.toMatch(/kind:\s*Secret/);
  }, 180_000);
});

function expectSkipped(): void {
  console.warn(
    "[runner-dep-vendor-image.integration] no reachable Docker daemon — the built-artifact proof did NOT run"
  );
  expect(dockerReady).toBe(false);
}
