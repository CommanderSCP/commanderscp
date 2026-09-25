import type { ScopedHttpRequest, ScopedHttpResponse } from "@scp/plugin-api";
import type { VendorRefreshIO } from "@scp/vendor-refresh";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bumpBranchFor,
  createManagedDepExecutorPlugin,
  parseRevendorDescriptor,
  __resetManagedDepOutcomes
} from "./index.js";
import { recordingCtx } from "./write-test-support.js";

/**
 * `re-vendor` — end to end through the REAL managed-dep dispatch path (ADR-0058), against a FIXTURE
 * upstream (never the network) and a FAKE GitHub Git Data API (never a real repository). This is the
 * reachability proof for `@scp/vendor-refresh`'s `planVendorRefresh`/`planArgoprojBackend`: deleting
 * the `action === "re-vendor"` dispatch in `index.ts`'s `trigger()`, or the `triggerRevendor` call it
 * makes, turns EVERY test below red (see the PR body's mutation log for the captured red output).
 */

const { generateKeyPairSync } = await import("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

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

const OLD_VALUES_YAML = "image: quay.io/argoproj/argocd:v3.4.5 # Argo CD (Apache-2.0)\n";
const OLD_BUNDLE_IMAGES_TS = '{ name: "argocd", defaultRef: "quay.io/argoproj/argocd:v3.4.5" }\n';
const OLD_IMAGES_LIST = "# no argocd line today\n";

const FIXTURE_DIGEST = `sha256:${"7".repeat(64)}`;

function fakeVendorRefreshIO(): VendorRefreshIO {
  return {
    fetchText: async () => FIXTURE_MANIFEST,
    resolveImageDigest: async () => FIXTURE_DIGEST,
    runHelmTemplate: async () => {
      throw new Error("not used by the argocd backend");
    }
  };
}

// `deploy/helm-bundled/vendor/argocd/install.yaml` is deliberately ABSENT here: `planVendorRefresh`
// gets that backend's own vendored content from `io.fetchText` (the upstream fetch), never from a
// repo read — `readRepoFile` below is called only for the three shared downstream files.
const REPO_FILES: Record<string, string> = {
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

/** A fake GitHub Git Data API — blobs/trees/commits/refs — plus the Contents GET this run's
 *  `readRepoFile` uses. Path-aware (unlike `write-test-support.ts`'s `githubHandler`, which answers
 *  every `contents/` GET with the same single fixture): this run reads THREE distinct files. */
function revendorGithubHandler(
  files: Record<string, string>
): (req: ScopedHttpRequest) => ScopedHttpResponse {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  let blobCounter = 0;
  return (req: ScopedHttpRequest): ScopedHttpResponse => {
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
        workspaceRoot: "/nonexistent-workspace-that-must-never-be-touched",
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

  it("plans, patches values.yaml/bundle-images.ts, commits all files in ONE pull request, and launches no container", async () => {
    const { ctx, calls } = revendorCtx();
    const plugin = createManagedDepExecutorPlugin(undefined, fakeVendorRefreshIO());
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
    const plugin = createManagedDepExecutorPlugin(undefined, fakeVendorRefreshIO());
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

  it("REFUSES a malformed re-vendor intent as a failed run, without reaching the provider", async () => {
    const { ctx, calls } = revendorCtx();
    const plugin = createManagedDepExecutorPlugin(undefined, fakeVendorRefreshIO());
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
