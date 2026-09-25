import { describe, expect, it, vi } from "vitest";
import { buildSandboxIO, type SandboxInput } from "./sandbox-io.js";

const BASE_INPUT: SandboxInput = {
  backend: "argocd",
  toTag: "v3.5.0",
  manifestText: "kind: Namespace\n",
  resolvedDigests: { "quay.io/argoproj/argocd:v3.5.0": `sha256:${"a".repeat(64)}` }
};

describe("buildSandboxIO — fetchText", () => {
  it("returns the pre-fetched manifestText regardless of the URL asked for", async () => {
    const io = buildSandboxIO(BASE_INPUT);
    expect(await io.fetchText("https://anything.example/whatever")).toBe(BASE_INPUT.manifestText);
  });

  it("throws when no manifestText was supplied — never returns undefined/empty silently", async () => {
    const io = buildSandboxIO({ ...BASE_INPUT, manifestText: undefined });
    await expect(io.fetchText("https://x")).rejects.toThrow(/no manifestText was supplied/);
  });
});

describe("buildSandboxIO — resolveImageDigest (the tag=toTag enforcement)", () => {
  it("resolves a digest for the exact pre-verified coordinate:tag key", async () => {
    const io = buildSandboxIO(BASE_INPUT);
    expect(await io.resolveImageDigest("quay.io/argoproj/argocd:v3.5.0")).toBe(
      `sha256:${"a".repeat(64)}`
    );
  });

  /** MUTATION-PROVE: this is the whole enforcement that a re-vendored manifest's own declared image
   *  tag equals `toTag` — see sandbox-io.ts's module doc. Asking for a DIFFERENT tag (as
   *  `planArgoprojBackend` would if the fetched manifest actually declared some other version) must
   *  refuse, not silently resolve something plausible. */
  it("REFUSES a coordinate:tag the orchestrator did not pre-resolve — e.g. the manifest declaring a tag other than toTag", async () => {
    const io = buildSandboxIO(BASE_INPUT);
    await expect(io.resolveImageDigest("quay.io/argoproj/argocd:v3.4.5")).rejects.toThrow(
      /no pre-resolved digest/
    );
  });

  it("refuses an entirely untracked coordinate", async () => {
    const io = buildSandboxIO(BASE_INPUT);
    await expect(io.resolveImageDigest("ghcr.io/dexidp/dex:v2.38.0")).rejects.toThrow(
      /no pre-resolved digest/
    );
  });
});

describe("buildSandboxIO — runHelmTemplate", () => {
  it("passes args through UNCHANGED for a repo-qualified chart ref (the human/test shape)", async () => {
    const execFn = vi.fn().mockReturnValue("rendered");
    const io = buildSandboxIO(BASE_INPUT, execFn);
    const args = [
      "template",
      "scp-gitea",
      "gitea-charts/gitea",
      "--version",
      "12.7.0",
      "--namespace",
      "scp-gitea"
    ];
    const out = await io.runHelmTemplate(args);
    expect(out).toBe("rendered");
    expect(execFn).toHaveBeenCalledWith("helm", args);
  });

  it("STRIPS --version and its value for a local chart directory (the sandbox shape)", async () => {
    const execFn = vi.fn().mockReturnValue("rendered");
    const io = buildSandboxIO(BASE_INPUT, execFn);
    const args = [
      "template",
      "scp-gitea",
      "/work/in/chart",
      "--version",
      "12.7.0",
      "--namespace",
      "scp-gitea",
      "--set",
      "replicaCount=1"
    ];
    await io.runHelmTemplate(args);
    expect(execFn).toHaveBeenCalledWith("helm", [
      "template",
      "scp-gitea",
      "/work/in/chart",
      "--namespace",
      "scp-gitea",
      "--set",
      "replicaCount=1"
    ]);
  });

  /** MUTATION-PROVE: without the local-path branch, this call would send `--version 12.7.0` to helm
   *  against a local directory chart ref — which is meaningless for a chart that IS already exactly
   *  one version, and (measured against real helm in `sandbox-main.test.ts`'s gitea case) is where a
   *  real render would refuse. This test pins the STRIPPING behaviour in isolation (fast, no real
   *  helm needed); the gitea case in `sandbox-main.test.ts` is what proves the stripped args are what
   *  `planGitea` actually needs. */
  it("strips --version even when it is not adjacent to other flags", async () => {
    const execFn = vi.fn().mockReturnValue("rendered");
    const io = buildSandboxIO(BASE_INPUT, execFn);
    await io.runHelmTemplate(["template", "r", "/a/b/c", "--set", "x=1", "--version", "9.9.9"]);
    expect(execFn).toHaveBeenCalledWith("helm", ["template", "r", "/a/b/c", "--set", "x=1"]);
  });
});
