import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScopedHttpRequest, ScopedHttpResponse } from "@scp/plugin-api";
import type { ResolveRunnerLauncher, RunnerSpec } from "@scp/runner-launcher";
import { runSandbox, type FullSandboxInput } from "@scp/vendor-refresh";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  bumpBranchFor,
  createManagedDepExecutorPlugin,
  parseRevendorDescriptor,
  __resetManagedDepOutcomes
} from "./index.js";
import type { RevendorFetchDeps } from "./revendor-orchestrator.js";
import { recordingCtx } from "./write-test-support.js";

/**
 * `re-vendor` — end to end through the REAL managed-dep dispatch path (ADR-0059's SPLIT
 * architecture, owner decision 2026-09-25): the ORCHESTRATOR half runs for real (`ctx.http.request`
 * against a FIXTURE upstream + a FAKE GitHub Git Data API — never the network, never a real
 * repository), and the SANDBOX half runs `@scp/vendor-refresh`'s REAL `runSandbox` — the exact
 * function `apps/runner-dep-vendor`'s entrypoint calls — through a FAKE launcher
 * ({@link fakeSandboxLauncher}) that reads/writes the same `input.json`/`output.json` files a real
 * container would, in-process rather than through Docker (Docker-launch reachability is
 * `apps/runner-dep-vendor`'s own concern — smoke-tested manually against the built image, see the PR
 * body — this suite's job is the DISPATCH wiring, not the container boundary). This is the
 * reachability proof for the whole path: deleting the `action === "re-vendor"` dispatch in
 * `index.ts`'s `trigger()`, the `triggerRevendor` call it makes, or `orchestrateRevendor`'s sandbox
 * launch, turns tests below red (see the PR body's mutation log for the captured red output).
 */

const { generateKeyPairSync } = await import("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

// `orchestrateRevendor` (unlike the old in-process planner) writes real scratch files for the
// sandbox exchange — a REAL, per-file temp dir, explicitly swept in `afterAll` (a leaked
// `/tmp/scp-revendor-test-*` is exactly what `pnpm -w test`'s tmpdir-leak-sweep flags — the OS does
// NOT clean this up on its own).
const WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), "scp-revendor-test-"));
function workspaceRoot(): string {
  return WORKSPACE_ROOT;
}
afterAll(async () => {
  await rm(WORKSPACE_ROOT, { recursive: true, force: true });
});

const REPO = "CommanderSCP/commanderscp";
const BASE_BRANCH = "main";
const CHANGE_ID = "0198f3c1-2222-7000-8000-000000000002";

/** A tiny, well-formed argocd install.yaml fixture — the UPSTREAM this run fetches. */
const FIXTURE_MANIFEST = [
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

const OLD_MANIFEST = FIXTURE_MANIFEST.replace("v3.5.0", "v3.4.5");
const OLD_VALUES_YAML = "image: quay.io/argoproj/argocd:v3.4.5 # Argo CD (Apache-2.0)\n";
const OLD_BUNDLE_IMAGES_TS = '{ name: "argocd", defaultRef: "quay.io/argoproj/argocd:v3.4.5" }\n';
const OLD_IMAGES_LIST = "# no argocd line today\n";

const FIXTURE_DIGEST = `sha256:${"7".repeat(64)}`;
const FIXTURE_SHA = "a".repeat(40);

const __dirname = dirname(fileURLToPath(import.meta.url));
/** The SAME fixture chart `@scp/vendor-refresh`'s own `gitea-plan.test.ts`/`sandbox-main.test.ts`
 *  use — real `Chart.yaml` (`appVersion: "1.26.1-fixture"`), real templates, rendered with the real
 *  `helm` binary. Used for finding 4's "test a real gitea bump end to end against a fixture." */
const FIXTURE_GITEA_CHART = resolve(
  __dirname,
  "../../../../tools/vendor-refresh/src/test-support/fixtures/gitea-chart"
);

/** {@link RevendorFetchDeps} — the orchestrator's injectable network/subprocess seam. `resolveImageDigest`
 *  and `verifyKeylessSignature` stand in for skopeo/cosign; the manifest FETCH itself goes through
 *  `ctx.http` (faked by {@link revendorGithubHandler} below), not this object — matching the real
 *  split (`resolveTagCommitSha`/`fetchArgoprojManifest` are `ctx.http` calls; only digest resolution
 *  and cosign verification are subprocess-shaped, same as every other skopeo/cosign call in this
 *  codebase). `fetchGiteaChart` copies the REAL fixture chart to `destDir/gitea`, matching
 *  `fetchGiteaChartOverHelm`'s own `helm pull --untar --untardir <destDir>` convention (which
 *  extracts to `<destDir>/<chartName>`) — so gitea's orchestrator-side `Chart.yaml` read (finding 4)
 *  exercises the real file, not a stub. */
function fakeRevendorFetchDeps(): RevendorFetchDeps {
  return {
    resolveImageDigest: async () => FIXTURE_DIGEST,
    verifyKeylessSignature: () => ({ status: "verified", detail: "fixture: always verified" }),
    fetchGiteaChart: async (_chartVersion: string, destDir: string) => {
      const dest = join(destDir, "gitea");
      await mkdir(destDir, { recursive: true });
      await cp(FIXTURE_GITEA_CHART, dest, { recursive: true });
      return dest;
    }
  };
}

/** Runs `@scp/vendor-refresh`'s REAL `runSandbox` in-process against the `input.json`/`output.json`
 *  files a real `apps/runner-dep-vendor` container would exchange via `docker cp` — see this file's
 *  module doc for why this is the right substitute for a real container launch in a unit suite. */
function fakeSandboxLauncher(): ResolveRunnerLauncher {
  return () => ({
    async run(spec: RunnerSpec) {
      const inDir = spec.copyIn[0]!.hostDir;
      const containerPath = spec.copyIn[0]!.containerPath; // "/work/in", by convention
      const raw = await readFile(join(inDir, "input.json"), "utf8");
      const input = JSON.parse(raw) as FullSandboxInput;
      // `chartDir` (gitea only) names a CONTAINER path (`/work/in/chart-src/gitea`) — a real
      // container resolves it via the SAME `docker cp` that put `input.json` there; this fake
      // launcher has no container, so it maps the container path back to the host path `docker cp`
      // would have used, the one place a real container and this in-process stand-in actually
      // differ.
      if (input.chartDir !== undefined && input.chartDir.startsWith(containerPath)) {
        input.chartDir = join(inDir, input.chartDir.slice(containerPath.length));
      }
      const output = await runSandbox(input);
      if (spec.copyOut) {
        await mkdir(spec.copyOut.hostDir, { recursive: true });
        await writeFile(join(spec.copyOut.hostDir, "output.json"), JSON.stringify(output), "utf8");
      }
      return { succeeded: true, stdout: "", stderr: "" };
    },
    async reap() {
      return [];
    }
  });
}

const REPO_FILES: Record<string, string> = {
  "deploy/helm-bundled/vendor/argocd/install.yaml": OLD_MANIFEST,
  "deploy/helm-bundled/values.yaml": OLD_VALUES_YAML,
  "deploy/airgap/src/bundle-images.ts": OLD_BUNDLE_IMAGES_TS,
  "tools/ci-mirror/images.list": OLD_IMAGES_LIST
};

const DECLARED_MANIFEST_PATHS = [
  "deploy/helm-bundled/vendor/argocd/install.yaml",
  "deploy/helm-bundled/values.yaml",
  "deploy/airgap/src/bundle-images.ts"
];

const revendorParams = {
  action: "re-vendor" as const,
  backend: "argocd",
  fromTag: "v3.4.5",
  toTag: "v3.5.0",
  repo: REPO,
  baseBranch: BASE_BRANCH,
  changeObjectId: CHANGE_ID,
  delivery: "pull_request" as const,
  declaredManifestPaths: DECLARED_MANIFEST_PATHS
};

/** A fake GitHub Git Data API — blobs/trees/commits/refs — plus the Contents GET the orchestrator's
 *  downgrade check/`currentVendoredFiles` read use, AND the two unauthenticated public-upstream
 *  fetches (tag->sha resolution, the manifest itself). Path-aware (unlike `write-test-support.ts`'s
 *  `githubHandler`, which answers every `contents/` GET with the same single fixture): this run
 *  reads four distinct repo-relative paths plus the two upstream URLs. */
function revendorGithubHandler(
  files: Record<string, string>
): (req: ScopedHttpRequest) => ScopedHttpResponse {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  let blobCounter = 0;
  return (req: ScopedHttpRequest): ScopedHttpResponse => {
    // THE ORCHESTRATOR'S OWN FETCHES (ADR-0059) — resolve argoproj/argo-cd@v3.5.0 to a commit sha,
    // then fetch the manifest AT that sha. Neither carries an Authorization header (unlike every
    // GitHub-App-credentialed call below): these are unauthenticated, public-upstream reads.
    if (req.url === "https://api.github.com/repos/argoproj/argo-cd/commits/v3.5.0") {
      return { status: 200, headers: {}, body: { sha: FIXTURE_SHA } };
    }
    if (
      req.url ===
      `https://raw.githubusercontent.com/argoproj/argo-cd/${FIXTURE_SHA}/manifests/install.yaml`
    ) {
      return { status: 200, headers: {}, body: FIXTURE_MANIFEST };
    }
    if (req.url.endsWith("/access_tokens")) {
      return {
        status: 201,
        headers: {},
        body: { token: "ghs_run_scoped", expires_at: "2026-08-15T12:00:00Z" }
      };
    }
    if (req.url.includes("/git/ref/heads/")) {
      return { status: 200, headers: {}, body: { object: { sha: "basesha" } } };
    }
    if (req.method === "GET" && req.url.includes("/git/commits/basesha")) {
      return { status: 200, headers: {}, body: { tree: { sha: "basetreesha" } } };
    }
    if (req.method === "GET" && req.url.includes("/contents/")) {
      const path = decodeURIComponent(req.url.split("/contents/")[1]!.split("?")[0]!);
      const content = files[path];
      if (content === undefined) return { status: 404, headers: {}, body: {} };
      return {
        status: 200,
        headers: {},
        body: { content: b64(content), encoding: "base64", sha: `blobsha-${path}` }
      };
    }
    if (req.method === "POST" && req.url.endsWith("/git/blobs")) {
      blobCounter += 1;
      return { status: 201, headers: {}, body: { sha: `newblob-${blobCounter}` } };
    }
    if (req.method === "POST" && req.url.endsWith("/git/trees")) {
      return { status: 201, headers: {}, body: { sha: "newtreesha" } };
    }
    if (req.method === "POST" && req.url.endsWith("/git/commits")) {
      return { status: 201, headers: {}, body: { sha: "newcommitsha" } };
    }
    if (req.method === "POST" && req.url.endsWith("/git/refs")) {
      return { status: 201, headers: {}, body: {} };
    }
    if (req.method === "POST" && req.url.endsWith("/pulls")) {
      return { status: 201, headers: {}, body: { number: 42, html_url: "https://x/pull/42" } };
    }
    if (req.method === "DELETE" && req.url.endsWith("/installation/token")) {
      return { status: 204, headers: {}, body: undefined };
    }
    return { status: 404, headers: {}, body: {} };
  };
}

function revendorCtx(files: Record<string, string> = REPO_FILES) {
  const { ctx, calls } = recordingCtx(revendorGithubHandler(files));
  return {
    calls,
    ctx: {
      ...ctx,
      config: {
        runnerImage: "scp-runner-dep:test",
        revendorRunnerImage: "scp-runner-dep-vendor:test",
        scpRepo: REPO,
        workspaceRoot: workspaceRoot(),
        provider: "github",
        appId: "12345",
        installationId: "67890",
        privateKeyPem
      }
    }
  };
}

describe("parseRevendorDescriptor", () => {
  it("accepts a well-formed re-vendor descriptor", () => {
    const d = parseRevendorDescriptor({ kind: "custom", parameters: revendorParams });
    expect(d.backend).toBe("argocd");
    expect(d.fromTag).toBe("v3.4.5");
    expect(d.toTag).toBe("v3.5.0");
    expect(d.headBranch).toBe(bumpBranchFor(CHANGE_ID));
  });

  it("refuses an unknown backend", () => {
    expect(() =>
      parseRevendorDescriptor({
        kind: "custom",
        parameters: { ...revendorParams, backend: "not-a-backend" }
      })
    ).toThrow(/unknown backend/);
  });

  it("refuses fromTag === toTag (no-op)", () => {
    expect(() =>
      parseRevendorDescriptor({
        kind: "custom",
        parameters: { ...revendorParams, toTag: "v3.4.5" }
      })
    ).toThrow(/there is no re-vendor to author/);
  });

  it("refuses a tag containing a control character", () => {
    expect(() =>
      parseRevendorDescriptor({
        kind: "custom",
        parameters: { ...revendorParams, toTag: "v3.5.0\nrm -rf" }
      })
    ).toThrow(/control character/);
  });

  it("refuses content-bearing keys, same as a bump intent", () => {
    expect(() =>
      parseRevendorDescriptor({
        kind: "custom",
        parameters: { ...revendorParams, files: [{ path: "x", content: "y" }] }
      })
    ).toThrow(/could hold authored file content/);
  });

  it("refuses an empty declaredManifestPaths", () => {
    expect(() =>
      parseRevendorDescriptor({
        kind: "custom",
        parameters: { ...revendorParams, declaredManifestPaths: [] }
      })
    ).toThrow(/declaredManifestPaths is required/);
  });

  it("refuses auto_merge with no expectedHeadCommit", () => {
    expect(() =>
      parseRevendorDescriptor({
        kind: "custom",
        parameters: { ...revendorParams, delivery: "auto_merge" }
      })
    ).toThrow(/expectedHeadCommit/);
  });
});

describe("trigger() dispatches 're-vendor' through the real managed-dep path (E2E, fixture upstream)", () => {
  beforeEach(() => __resetManagedDepOutcomes());

  it("plans (via the sandbox), patches values.yaml/bundle-images.ts, and commits all files in ONE pull request", async () => {
    const { ctx, calls } = revendorCtx();
    const plugin = createManagedDepExecutorPlugin(fakeSandboxLauncher(), fakeRevendorFetchDeps());
    const ref = await plugin.trigger(ctx, {
      kind: "custom",
      idempotencyKey: `${CHANGE_ID}:re-vendor`,
      parameters: revendorParams
    });
    const status = await plugin.status(ctx, ref);
    expect(status.detail).not.toMatch(/REFUSED/);
    expect(status.phase).toBe("succeeded");
    expect(status.detail).toMatch(/re-vendor argocd v3\.4\.5 -> v3\.5\.0 opened as/);

    // ONE tree, carrying all three files' new blobs.
    const tree = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/trees"));
    expect(tree).toBeDefined();
    const treeEntries = (tree!.body as { tree: Array<{ path: string }> }).tree;
    expect(treeEntries.map((e) => e.path).sort()).toEqual(
      [
        "deploy/helm-bundled/vendor/argocd/install.yaml",
        "deploy/helm-bundled/values.yaml",
        "deploy/airgap/src/bundle-images.ts"
      ].sort()
    );
    expect((tree!.body as { base_tree: string }).base_tree).toBe("basetreesha");

    // ONE commit, ONE pull request.
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/git/commits"))).toHaveLength(
      1
    );
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/pulls"))).toHaveLength(1);

    // NEVER the single-file Contents API PUT (that is `publishBump`'s door, not this one's).
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/contents/"))).toBe(false);

    // The blobs actually carry the NEW content.
    const blobs = calls.filter((c) => c.method === "POST" && c.url.endsWith("/git/blobs"));
    expect(blobs).toHaveLength(3);
    const decoded = blobs.map((b) =>
      Buffer.from((b.body as { content: string }).content, "base64").toString("utf8")
    );
    expect(decoded).toContain(FIXTURE_MANIFEST);
    expect(decoded.some((c) => c.includes("quay.io/argoproj/argocd:v3.5.0"))).toBe(true);
    expect(decoded.some((c) => c === OLD_VALUES_YAML)).toBe(false);
  });

  /**
   * PROBE D1 (2026-09-25 third re-review) — MADE PERMANENT, end to end. A fake launcher stands in
   * for a COMPROMISED (or merely buggy) sandbox container: instead of running the real `runSandbox`,
   * it writes a CRAFTED `output.json` directly, with `values.yaml` rewritten to a completely
   * different, malicious image — the tracked coordinate present ONLY as a trailing comment, exactly
   * the shape the old line-heuristic accepted. Proves the STRUCTURAL fix (2026-09-25 third
   * re-review, point 1): the committed content is the ORCHESTRATOR's own computed substitution,
   * never whatever the sandbox claims — this run's blobs must carry the TRUSTED content, never the
   * attacker's, and the disagreement itself must force requires-review (pull_request, never merged).
   */
  it("PROBE D1 (permanent, E2E): a malicious sandbox's values.yaml rewrite is IGNORED — the orchestrator's own computed content is what gets committed", async () => {
    const maliciousLauncher: ResolveRunnerLauncher = () => ({
      async run(spec: RunnerSpec) {
        const craftedOutput = {
          plan: {
            backend: "argocd",
            tag: "v3.5.0",
            files: [
              { path: "deploy/helm-bundled/vendor/argocd/install.yaml", content: FIXTURE_MANIFEST },
              {
                path: "deploy/helm-bundled/values.yaml",
                // The exact D1 shape: an entirely different image, the tracked coordinate present
                // only as a trailing comment.
                content: "image: evil.example/pwn:v1 # quay.io/argoproj/argocd\n"
              },
              {
                path: "deploy/airgap/src/bundle-images.ts",
                content: OLD_BUNDLE_IMAGES_TS.replace("v3.4.5", "v3.5.0")
              }
            ],
            trackedImages: [
              {
                bundleImageName: "argocd",
                tagRef: "quay.io/argoproj/argocd:v3.5.0",
                resolvedRef: `quay.io/argoproj/argocd:v3.5.0@${FIXTURE_DIGEST}`
              }
            ],
            summary: "malicious plan"
          },
          classification: { class: "image-only", reasons: [] }
        };
        if (spec.copyOut) {
          await mkdir(spec.copyOut.hostDir, { recursive: true });
          await writeFile(
            join(spec.copyOut.hostDir, "output.json"),
            JSON.stringify(craftedOutput),
            "utf8"
          );
        }
        return { succeeded: true, stdout: "", stderr: "" };
      },
      async reap() {
        return [];
      }
    });

    const { ctx, calls } = revendorCtx();
    const plugin = createManagedDepExecutorPlugin(maliciousLauncher, fakeRevendorFetchDeps());
    const ref = await plugin.trigger(ctx, {
      kind: "custom",
      idempotencyKey: `${CHANGE_ID}:re-vendor:probe-d1`,
      // auto_merge requested WITH a valid expectedHeadCommit — proves the mismatch downgrades
      // delivery too, not merely the committed bytes.
      parameters: {
        ...revendorParams,
        delivery: "auto_merge" as const,
        expectedHeadCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
      }
    });
    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("succeeded");
    expect(status.detail).toMatch(/opened as/);
    expect(status.detail).not.toMatch(/merged as/); // the mismatch forced requires-review

    const blobs = calls.filter((c) => c.method === "POST" && c.url.endsWith("/git/blobs"));
    const decoded = blobs.map((b) =>
      Buffer.from((b.body as { content: string }).content, "base64").toString("utf8")
    );
    // The MALICIOUS content never reached a blob at all.
    expect(decoded.some((c) => c.includes("evil.example"))).toBe(false);
    // What DID get committed for values.yaml is the orchestrator's own trusted substitution.
    expect(decoded).toContain("image: quay.io/argoproj/argocd:v3.5.0 # Argo CD (Apache-2.0)\n");
  });

  /** PROBE D2 (2026-09-25 third re-review) — MADE PERMANENT, end to end. A crafted `output.json`
   *  names the SAME path twice in `plan.files`, with different content — the shape that let a git
   *  tree carry two blobs at one path while the verification code checked only the first. Refused
   *  outright, at shape-validation time, before any blob is created. */
  it("PROBE D2 (permanent, E2E): a duplicate path in plan.files REFUSES the whole run before any write", async () => {
    const duplicatePathLauncher: ResolveRunnerLauncher = () => ({
      async run(spec: RunnerSpec) {
        const craftedOutput = {
          plan: {
            backend: "argocd",
            tag: "v3.5.0",
            files: [
              { path: "deploy/helm-bundled/vendor/argocd/install.yaml", content: FIXTURE_MANIFEST },
              {
                path: "deploy/helm-bundled/vendor/argocd/install.yaml",
                content: "malicious-second-copy"
              }
            ],
            trackedImages: [
              {
                bundleImageName: "argocd",
                tagRef: "quay.io/argoproj/argocd:v3.5.0",
                resolvedRef: `quay.io/argoproj/argocd:v3.5.0@${FIXTURE_DIGEST}`
              }
            ],
            summary: "duplicate-path plan"
          },
          classification: { class: "image-only", reasons: [] }
        };
        if (spec.copyOut) {
          await mkdir(spec.copyOut.hostDir, { recursive: true });
          await writeFile(
            join(spec.copyOut.hostDir, "output.json"),
            JSON.stringify(craftedOutput),
            "utf8"
          );
        }
        return { succeeded: true, stdout: "", stderr: "" };
      },
      async reap() {
        return [];
      }
    });

    const { ctx, calls } = revendorCtx();
    const plugin = createManagedDepExecutorPlugin(duplicatePathLauncher, fakeRevendorFetchDeps());
    const ref = await plugin.trigger(ctx, {
      kind: "custom",
      idempotencyKey: `${CHANGE_ID}:re-vendor:probe-d2`,
      parameters: revendorParams
    });
    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toMatch(/untrusted_output_shape/);
    expect(status.detail).toMatch(/names the same path more than once/);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/git/blobs"))).toBe(false);
  });

  it("REFUSES (before any write) when the plan proposes a path outside declaredManifestPaths", async () => {
    const { ctx, calls } = revendorCtx();
    const plugin = createManagedDepExecutorPlugin(fakeSandboxLauncher(), fakeRevendorFetchDeps());
    const narrowParams = {
      ...revendorParams,
      // Missing bundle-images.ts — the plan will still try to patch it, and must be refused rather
      // than silently widening its own scope.
      declaredManifestPaths: [
        "deploy/helm-bundled/vendor/argocd/install.yaml",
        "deploy/helm-bundled/values.yaml"
      ]
    };
    const ref = await plugin.trigger(ctx, {
      kind: "custom",
      idempotencyKey: `${CHANGE_ID}:re-vendor:narrow`,
      parameters: narrowParams
    });
    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toMatch(/undeclared_paths/);
    expect(status.detail).toContain("bundle-images.ts");
    // NOTHING was sent to the provider's write surface.
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/git/blobs"))).toBe(false);
  });

  /** MUTATION-PROVE (finding 1): a manifest that smuggles authority alongside a real bump forces
   *  `pull_request` delivery even when `auto_merge` was requested and evidenced — the classification
   *  downgrade in `triggerRevendor` must not be bypassable by the descriptor's own delivery field. */
  it("classification requires-review forces pull_request delivery even when auto_merge was requested", async () => {
    const manifestWithBinding =
      FIXTURE_MANIFEST +
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
    const handler = (req: ScopedHttpRequest): ScopedHttpResponse => {
      if (
        req.url ===
        `https://raw.githubusercontent.com/argoproj/argo-cd/${FIXTURE_SHA}/manifests/install.yaml`
      ) {
        return { status: 200, headers: {}, body: manifestWithBinding };
      }
      return revendorGithubHandler(REPO_FILES)(req);
    };
    const { ctx, calls } = recordingCtx(handler);
    ctx.config = {
      runnerImage: "scp-runner-dep:test",
      revendorRunnerImage: "scp-runner-dep-vendor:test",
      scpRepo: REPO,
      workspaceRoot: workspaceRoot(),
      provider: "github",
      appId: "12345",
      installationId: "67890",
      privateKeyPem
    };
    const plugin = createManagedDepExecutorPlugin(fakeSandboxLauncher(), fakeRevendorFetchDeps());
    const ref = await plugin.trigger(ctx, {
      kind: "custom",
      idempotencyKey: `${CHANGE_ID}:re-vendor:requires-review`,
      parameters: {
        ...revendorParams,
        delivery: "auto_merge" as const,
        expectedHeadCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
      }
    });
    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("succeeded");
    // NEVER merged, despite auto_merge being requested and an expectedHeadCommit supplied — the PR
    // exists (opened) and stands for a human.
    expect(status.detail).toMatch(/opened as/);
    expect(status.detail).not.toMatch(/merged as/);
    expect(
      calls.some((c) => c.method === "PUT" && c.url.includes("/pulls/") && c.url.endsWith("/merge"))
    ).toBe(false);
  });
});

/** GITEA END TO END (finding 4, 2026-09-25 re-review): "the downgrade guard compares the chart
 *  version against the image tag, which lets 12.6.0->12.5.0 through" and "the digest is resolved
 *  for docker.gitea.com/gitea:<chart version>, so every real gitea re-vendor fails closed." Both
 *  bugs meant gitea's `re-vendor` had never actually been exercised end to end against anything
 *  that looks like a real bump — this suite is that exercise, against the REAL fixture chart
 *  `@scp/vendor-refresh`'s own tests already use (real `Chart.yaml`, real `helm template`). */
describe("trigger() dispatches 're-vendor' for gitea, end to end (finding 4)", () => {
  beforeEach(() => __resetManagedDepOutcomes());

  const GITEA_VENDORED_PATH = "deploy/helm-bundled/vendor/gitea/install-no-secrets.yaml";
  const giteaManifestWithChartVersion = (chartVersion: string): string =>
    [
      `#   helm template scp-gitea gitea-charts/gitea --version ${chartVersion} --namespace scp-gitea \\`,
      "#     --set postgresql.enabled=false",
      "apiVersion: v1",
      "kind: Namespace",
      "metadata:",
      "  name: scp-gitea",
      ""
    ].join("\n");
  const GITEA_VALUES_YAML = "gitea:\n  image: docker.gitea.com/gitea:1.26.0-fixture-rootless\n";
  const GITEA_BUNDLE_IMAGES_TS =
    '{ name: "gitea", defaultRef: "docker.gitea.com/gitea:1.26.0-fixture-rootless" }\n';

  const GITEA_DECLARED_MANIFEST_PATHS = [
    GITEA_VENDORED_PATH,
    "deploy/helm-bundled/vendor/gitea/config/config_environment.sh",
    "deploy/helm-bundled/vendor/gitea/init/configure_gpg_environment.sh",
    "deploy/helm-bundled/vendor/gitea/init/init_directory_structure.sh",
    "deploy/helm-bundled/vendor/gitea/init/configure_gitea.sh",
    "deploy/helm-bundled/values.yaml",
    "deploy/airgap/src/bundle-images.ts"
  ];

  function giteaRepoFiles(currentChartVersion: string): Record<string, string> {
    return {
      [GITEA_VENDORED_PATH]: giteaManifestWithChartVersion(currentChartVersion),
      "deploy/helm-bundled/values.yaml": GITEA_VALUES_YAML,
      "deploy/airgap/src/bundle-images.ts": GITEA_BUNDLE_IMAGES_TS,
      "tools/ci-mirror/images.list": ""
    };
  }

  function giteaCtx(currentChartVersion: string) {
    const { ctx, calls } = recordingCtx(revendorGithubHandler(giteaRepoFiles(currentChartVersion)));
    return {
      calls,
      ctx: {
        ...ctx,
        config: {
          runnerImage: "scp-runner-dep:test",
          revendorRunnerImage: "scp-runner-dep-vendor:test",
          scpRepo: REPO,
          workspaceRoot: workspaceRoot(),
          provider: "github",
          appId: "12345",
          installationId: "67890",
          privateKeyPem
        }
      }
    };
  }

  const giteaParams = {
    action: "re-vendor" as const,
    backend: "gitea",
    fromTag: "12.5.0-fixture",
    toTag: "12.6.0-fixture",
    repo: REPO,
    baseBranch: BASE_BRANCH,
    changeObjectId: "0198f3c1-2222-7000-8000-000000000003",
    // Deliberately requested even though gitea can never actually merge (finding 3: no confirmed
    // signature check) — proves the downgrade of `auto_merge` to `pull_request` for an UNSIGNED
    // backend, not just for a suspicious diff.
    delivery: "auto_merge" as const,
    expectedHeadCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    declaredManifestPaths: GITEA_DECLARED_MANIFEST_PATHS
  };

  it("plans a real gitea bump against the fixture chart, opens a pull request, and never merges (no signature check)", async () => {
    const { ctx, calls } = giteaCtx("12.5.0-fixture"); // current chart is OLDER than toTag — a real forward bump
    const plugin = createManagedDepExecutorPlugin(fakeSandboxLauncher(), fakeRevendorFetchDeps());
    const ref = await plugin.trigger(ctx, {
      kind: "custom",
      idempotencyKey: "gitea-e2e:re-vendor",
      parameters: giteaParams
    });
    const status = await plugin.status(ctx, ref);
    expect(status.detail).not.toMatch(/REFUSED/);
    expect(status.phase).toBe("succeeded");
    // auto_merge was requested with a valid expectedHeadCommit, but gitea has NO confirmed image
    // signature check (BACKEND_VERIFICATION) — always requires-review, always delivered as a pull
    // request, never merged (finding 3).
    expect(status.detail).toMatch(/opened as/);
    expect(status.detail).not.toMatch(/merged as/);
    expect(
      calls.some((c) => c.method === "PUT" && c.url.includes("/pulls/") && c.url.endsWith("/merge"))
    ).toBe(false);

    // BEFORE THE FIX: this run would have thrown resolving a digest for
    // 'docker.gitea.com/gitea:12.6.0-fixture' (the CHART version fed to resolveImageDigest as if it
    // were the image tag) — it never got this far. Now it resolves the REAL app image tag
    // (1.26.1-fixture-rootless, read from the pulled chart's own Chart.yaml) and commits for real.
    const tree = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/trees"));
    expect(tree).toBeDefined();
    const treeEntries = (tree!.body as { tree: Array<{ path: string }> }).tree;
    expect(treeEntries.some((e) => e.path === GITEA_VENDORED_PATH)).toBe(true);
  });

  /** MUTATION-PROVE (finding 4): the OLD code compared `toTag` (a chart version) against
   *  `values.yaml`'s stored IMAGE tag — an axis mismatch that let a CHART downgrade through as long
   *  as the (unrelated) image tag string still looked like an increase. This manifest's image tag
   *  is UNCHANGED between the two repo states below; only the CHART version in the header moves
   *  backwards, and that alone must refuse. */
  it("REFUSES a chart-version downgrade, on the chart axis, even though the stored image tag says nothing about it", async () => {
    const { ctx, calls } = giteaCtx("12.6.0-fixture"); // current chart is NEWER than the requested toTag
    const plugin = createManagedDepExecutorPlugin(fakeSandboxLauncher(), fakeRevendorFetchDeps());
    const ref = await plugin.trigger(ctx, {
      kind: "custom",
      idempotencyKey: "gitea-e2e:downgrade",
      parameters: { ...giteaParams, fromTag: "12.6.0-fixture", toTag: "12.5.0-fixture" }
    });
    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toMatch(/REFUSED \(downgrade\)/);
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/git/blobs"))).toBe(false);
  });
});

describe("trigger() dispatches 're-vendor' — remaining refusal paths", () => {
  beforeEach(() => __resetManagedDepOutcomes());

  /** MUTATION-PROVE (owner decision, "the target repository is the one CommanderSCP is configured
   *  to vendor its own stack into, which is never tenant-configurable"): a descriptor naming a
   *  DIFFERENT repository than the configured `scpRepo` must be refused BEFORE a credential is
   *  minted, regardless of how well-formed the rest of the descriptor is. */
  it("REFUSES a descriptor whose repo does not match the configured scpRepo", async () => {
    const { ctx, calls } = revendorCtx();
    ctx.config = { ...ctx.config, scpRepo: "someone-else/other-repo" };
    const plugin = createManagedDepExecutorPlugin(fakeSandboxLauncher(), fakeRevendorFetchDeps());
    const ref = await plugin.trigger(ctx, {
      kind: "custom",
      idempotencyKey: `${CHANGE_ID}:re-vendor:wrong-repo`,
      parameters: revendorParams
    });
    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toMatch(/REFUSED \(repo_not_scp_repo\)/);
    expect(calls).toHaveLength(0);
  });

  it("REFUSES a malformed re-vendor intent as a failed run, without reaching the provider", async () => {
    const { ctx, calls } = revendorCtx();
    const plugin = createManagedDepExecutorPlugin(fakeSandboxLauncher(), fakeRevendorFetchDeps());
    const ref = await plugin.trigger(ctx, {
      kind: "custom",
      idempotencyKey: `${CHANGE_ID}:re-vendor:bad`,
      parameters: { ...revendorParams, backend: "not-a-backend" }
    });
    const status = await plugin.status(ctx, ref);
    expect(status.phase).toBe("failed");
    expect(status.detail).toMatch(/unknown backend/);
    expect(calls).toHaveLength(0);
  });
});
