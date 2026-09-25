import { describe, expect, it, vi } from "vitest";
import type { PluginContext, ScopedHttpRequest, ScopedHttpResponse } from "@scp/plugin-api";
import {
  BACKEND_VERIFICATION,
  DEFAULT_REVENDOR_FETCH_DEPS,
  assertFixedVendorPaths,
  assertNotDowngrade,
  compareUpstreamTags,
  resolveTagCommitSha,
  type RevendorFetchDeps
} from "./revendor-orchestrator.js";
import type { RepoFile, RepoSession } from "./repo-write.js";

describe("compareUpstreamTags", () => {
  it("orders by numeric semver, not lexically", () => {
    expect(compareUpstreamTags("v3.10.0", "v3.9.0")).toBeGreaterThan(0);
    expect(compareUpstreamTags("v3.9.0", "v3.10.0")).toBeLessThan(0);
    expect(compareUpstreamTags("v3.5.0", "v3.5.0")).toBe(0);
  });

  it("treats a pre-release as OLDER than its own base release (the conservative direction)", () => {
    expect(compareUpstreamTags("v3.5.0-rc1", "v3.5.0")).toBeLessThan(0);
    expect(compareUpstreamTags("v3.5.0", "v3.5.0-rc1")).toBeGreaterThan(0);
  });

  it("refuses a non-comparable tag", () => {
    expect(() => compareUpstreamTags("latest", "v3.5.0")).toThrow(/not a comparable upstream tag/);
  });
});

describe("resolveTagCommitSha", () => {
  function ctxWith(handler: (req: ScopedHttpRequest) => ScopedHttpResponse): PluginContext {
    return {
      orgId: "org",
      scopeKey: "test",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      secrets: { get: async () => undefined },
      http: { request: async (req) => handler(req) },
      config: {}
    };
  }

  it("resolves a tag to its commit sha via GET /repos/{repo}/commits/{tag}", async () => {
    const ctx = ctxWith((req) => {
      expect(req.url).toBe("https://api.github.com/repos/argoproj/argo-cd/commits/v3.5.0");
      return { status: 200, headers: {}, body: { sha: "b".repeat(40) } };
    });
    expect(await resolveTagCommitSha(ctx, "argoproj/argo-cd", "v3.5.0")).toBe("b".repeat(40));
  });

  it("refuses a malformed tag BEFORE building a URL (SSRF/injection hazard, same shape as probe P1)", async () => {
    const ctx = ctxWith(() => {
      throw new Error("ctx.http must never be reached for a malformed tag");
    });
    await expect(resolveTagCommitSha(ctx, "argoproj/argo-cd", "../../evil")).rejects.toThrow(
      /not a well-formed upstream release tag/
    );
  });

  it("refuses a non-200 response", async () => {
    const ctx = ctxWith(() => ({ status: 404, headers: {}, body: {} }));
    await expect(resolveTagCommitSha(ctx, "argoproj/argo-cd", "v3.5.0")).rejects.toThrow(/HTTP 404/);
  });

  /** MUTATION-PROVE: a provider that returns something that is not a well-formed 40-hex sha (a
   *  compromised/misbehaving endpoint, or a future API shape change) must not be trusted as one. */
  it("refuses a response whose sha is not well-formed", async () => {
    const ctx = ctxWith(() => ({ status: 200, headers: {}, body: { sha: "not-a-sha" } }));
    await expect(resolveTagCommitSha(ctx, "argoproj/argo-cd", "v3.5.0")).rejects.toThrow(
      /did not resolve to a well-formed commit sha/
    );
  });
});

function fakeSession(files: Record<string, string>): RepoSession {
  return {
    async readFile(path: string): Promise<RepoFile | undefined> {
      const content = files[path];
      return content === undefined ? undefined : { content, blobSha: "x" };
    },
    publishVendorRefresh: async () => {
      throw new Error("not used");
    },
    publishBump: async () => {
      throw new Error("not used");
    },
    mergeAuthoredBranch: async () => {
      throw new Error("not used");
    }
  };
}

describe("assertNotDowngrade", () => {
  const VALUES_YAML_PATH = "deploy/helm-bundled/values.yaml";

  it("allows a real forward bump", async () => {
    const session = fakeSession({
      [VALUES_YAML_PATH]: "image: quay.io/argoproj/argocd:v3.4.5 # Argo CD (Apache-2.0)\n"
    });
    await expect(assertNotDowngrade(session, "argocd", "main", "v3.5.0")).resolves.toBeUndefined();
  });

  /** MUTATION-PROVE (finding 1): a downgrade — or a re-ask of the SAME tag — must be refused, and
   *  refused against what the REPOSITORY currently says, never the caller-supplied `fromTag` alone
   *  (this test supplies no `fromTag` at all — `assertNotDowngrade` never takes one). */
  it("REFUSES a downgrade", async () => {
    const session = fakeSession({
      [VALUES_YAML_PATH]: "image: quay.io/argoproj/argocd:v3.5.0 # Argo CD (Apache-2.0)\n"
    });
    await expect(assertNotDowngrade(session, "argocd", "main", "v3.4.5")).rejects.toThrow(
      /REFUSED \(downgrade\)/
    );
  });

  it("REFUSES re-vendoring to the SAME tag already vendored", async () => {
    const session = fakeSession({
      [VALUES_YAML_PATH]: "image: quay.io/argoproj/argocd:v3.5.0 # Argo CD (Apache-2.0)\n"
    });
    await expect(assertNotDowngrade(session, "argocd", "main", "v3.5.0")).rejects.toThrow(
      /REFUSED \(downgrade\)/
    );
  });

  it("refuses when values.yaml declares no reference to the tracked coordinate at all", async () => {
    const session = fakeSession({ [VALUES_YAML_PATH]: "nothing about argocd here\n" });
    await expect(assertNotDowngrade(session, "argocd", "main", "v3.5.0")).rejects.toThrow(
      /declares no reference/
    );
  });
});

describe("assertFixedVendorPaths — declaredManifestPaths must be the fixed vendored set", () => {
  it("accepts the shared downstream files and this backend's own vendor-dir paths", () => {
    expect(() =>
      assertFixedVendorPaths("argocd", [
        "deploy/helm-bundled/vendor/argocd/install.yaml",
        "deploy/helm-bundled/values.yaml",
        "deploy/airgap/src/bundle-images.ts",
        "tools/ci-mirror/images.list"
      ])
    ).not.toThrow();
  });

  it("accepts an arbitrary NUMBER of argo-workflows split parts (a prefix rule, not an enumerated list)", () => {
    expect(() =>
      assertFixedVendorPaths("argo-workflows", [
        "deploy/helm-bundled/vendor/argo-workflows/install-part-1.yaml",
        "deploy/helm-bundled/vendor/argo-workflows/install-part-2.yaml",
        "deploy/helm-bundled/vendor/argo-workflows/install-part-3.yaml",
        "deploy/helm-bundled/vendor/argo-workflows/install-part-4.yaml",
        "deploy/helm-bundled/vendor/argo-workflows/install-part-5.yaml"
      ])
    ).not.toThrow();
  });

  /** MUTATION-PROVE: a path pointed at a DIFFERENT backend's vendor directory, or anywhere outside
   *  the vendored set entirely, must be refused — this is the "declaredManifestPaths must be the
   *  fixed vendored set" half of the owner decision, and it must not be satisfiable by a caller just
   *  naming whatever it wants. */
  it("REFUSES a path outside this backend's own vendor directory", () => {
    expect(() =>
      assertFixedVendorPaths("argocd", ["deploy/helm-bundled/vendor/gitea/install-no-secrets.yaml"])
    ).toThrow(/REFUSED \(fixed_vendor_paths\)/);
  });

  it("REFUSES a path with no relationship to the vendored set at all", () => {
    expect(() => assertFixedVendorPaths("argocd", [".github/workflows/ci.yml"])).toThrow(
      /REFUSED \(fixed_vendor_paths\)/
    );
  });
});

describe("BACKEND_VERIFICATION — honesty over uniformity", () => {
  it("argocd is the one backend with a confirmed keyless mechanism", () => {
    expect(BACKEND_VERIFICATION.argocd.method).toBe("keyless");
    expect(BACKEND_VERIFICATION.argocd.identity?.oidcIssuer).toBe(
      "https://token.actions.githubusercontent.com"
    );
  });

  it("every other backend is HONESTLY 'none', with a stated reason — never a silent uniform pass", () => {
    for (const backend of ["argo-workflows", "argo-rollouts", "argo-events", "gitea"] as const) {
      expect(BACKEND_VERIFICATION[backend].method, backend).toBe("none");
      expect(BACKEND_VERIFICATION[backend].unverifiedReason, backend).toBeTruthy();
    }
  });
});

describe("DEFAULT_REVENDOR_FETCH_DEPS", () => {
  it("is wired to the real, network/subprocess-reaching implementations (constructed, never invoked here)", () => {
    expect(typeof DEFAULT_REVENDOR_FETCH_DEPS.resolveImageDigest).toBe("function");
    expect(typeof DEFAULT_REVENDOR_FETCH_DEPS.verifyKeylessSignature).toBe("function");
    expect(typeof DEFAULT_REVENDOR_FETCH_DEPS.fetchGiteaChart).toBe("function");
  });
});

/** The keyless-verification fail-closed gate itself, exercised via a minimal fake `ctx`/session — a
 *  smaller, more targeted proof than the full `revendor.test.ts` E2E suite for THIS ONE property:
 *  cosign returning `unverified` must refuse the run, never merely warn. */
describe("resolveAndVerifyTrackedDigests fail-closed (exercised indirectly via orchestrateRevendor)", () => {
  it("a real cosign NEGATIVE (unverified) refuses the run rather than pinning the digest anyway", async () => {
    const { orchestrateRevendor } = await import("./revendor-orchestrator.js");
    const ctx: PluginContext = {
      orgId: "org",
      scopeKey: "test",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      secrets: { get: async () => undefined },
      http: {
        request: async (req: ScopedHttpRequest): Promise<ScopedHttpResponse> => {
          if (req.url.includes("/commits/v3.5.0")) return { status: 200, headers: {}, body: { sha: "c".repeat(40) } };
          if (req.url.includes("raw.githubusercontent.com"))
            return {
              status: 200,
              headers: {},
              body: "kind: Deployment\nmetadata:\n  name: x\nspec:\n  template:\n    spec:\n      containers:\n      - image: quay.io/argoproj/argocd:v3.5.0\n"
            };
          return { status: 404, headers: {}, body: {} };
        }
      },
      config: {}
    };
    const session = fakeSession({
      "deploy/helm-bundled/values.yaml": "image: quay.io/argoproj/argocd:v3.4.5\n",
      "deploy/airgap/src/bundle-images.ts": "x",
      "tools/ci-mirror/images.list": "x"
    });
    const deps: RevendorFetchDeps = {
      resolveImageDigest: async () => `sha256:${"1".repeat(64)}`,
      verifyKeylessSignature: () => ({ status: "unverified", detail: "no matching signatures" }),
      fetchGiteaChart: async () => {
        throw new Error("not used");
      }
    };
    await expect(
      orchestrateRevendor(
        ctx,
        { revendorRunnerImage: "test:image", workspaceRoot: "/tmp" },
        "argocd",
        "v3.5.0",
        "main",
        session,
        ["deploy/helm-bundled/vendor/argocd/install.yaml"],
        () => {
          throw new Error("the sandbox must never launch when verification already refused");
        },
        deps
      )
    ).rejects.toThrow(/cosign could not verify/);
  });
});
