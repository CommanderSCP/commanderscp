import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScopedHttpRequest, ScopedHttpResponse } from "@scp/plugin-api";
import type { ResolveRunnerLauncher, RunnerSpec } from "@scp/runner-launcher";
import { runSandbox, type FullSandboxInput } from "@scp/vendor-refresh";
import { beforeEach, describe, expect, it } from "vitest";
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
// sandbox exchange — a REAL, per-test-run temp dir, cleaned up by the OS same as every other
// mkdtemp-under-tmpdir use in this package's tests.
const WORKSPACE_ROOT = await mkdtemp(join(tmpdir(), "scp-revendor-test-"));
function workspaceRoot(): string {
  return WORKSPACE_ROOT;
}

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

/** {@link RevendorFetchDeps} — the orchestrator's injectable network/subprocess seam. `resolveImageDigest`
 *  and `verifyKeylessSignature` stand in for skopeo/cosign; the manifest FETCH itself goes through
 *  `ctx.http` (faked by {@link revendorGithubHandler} below), not this object — matching the real
 *  split (`resolveTagCommitSha`/`fetchArgoprojManifest` are `ctx.http` calls; only digest resolution
 *  and cosign verification are subprocess-shaped, same as every other skopeo/cosign call in this
 *  codebase). */
function fakeRevendorFetchDeps(): RevendorFetchDeps {
  return {
    resolveImageDigest: async () => FIXTURE_DIGEST,
    verifyKeylessSignature: () => ({ status: "verified", detail: "fixture: always verified" }),
    fetchGiteaChart: async () => {
      throw new Error("not used by the argocd backend");
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
      const raw = await readFile(join(inDir, "input.json"), "utf8");
      const input = JSON.parse(raw) as FullSandboxInput;
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
