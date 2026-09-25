import { describe, expect, it } from "vitest";
import { patchImagesList } from "./patch-images-list.js";
import type { TrackedImage } from "./types.js";

const GITEA: TrackedImage = {
  bundleImageName: "gitea",
  tagRef: "docker.gitea.com/gitea:1.27.0-rootless",
  resolvedRef: `docker.gitea.com/gitea:1.27.0-rootless@sha256:${"f".repeat(64)}`
};

describe("patchImagesList", () => {
  it("bumps the pin AND the alias tag for an image already listed", () => {
    const content = [
      "# a comment",
      "docker.io/library/postgres@sha256:aaaa   postgres:16",
      `docker.gitea.com/gitea@sha256:${"0".repeat(64)}  docker.gitea.com/gitea:1.26.1-rootless`,
      ""
    ].join("\n");
    const { content: patched, updated } = patchImagesList(content, [GITEA]);
    expect(updated).toEqual(["gitea"]);
    expect(patched).toContain(
      `docker.gitea.com/gitea@sha256:${"f".repeat(64)}   docker.gitea.com/gitea:1.27.0-rootless`
    );
    // Untouched lines stay byte-identical.
    expect(patched).toContain("docker.io/library/postgres@sha256:aaaa   postgres:16");
    expect(patched).toContain("# a comment");
  });

  it("leaves the file untouched (no error) when the image is not listed at all — argocd/argo-workflows/argo-events/argo-rollouts today", () => {
    const content = "docker.io/library/postgres@sha256:aaaa   postgres:16\n";
    const ARGOCD: TrackedImage = {
      bundleImageName: "argocd",
      tagRef: "quay.io/argoproj/argocd:v3.5.0",
      resolvedRef: `quay.io/argoproj/argocd:v3.5.0@sha256:${"1".repeat(64)}`
    };
    const { content: patched, updated } = patchImagesList(content, [ARGOCD]);
    expect(patched).toBe(content);
    expect(updated).toEqual([]);
  });

  it("skips comment lines, blank lines, and ${VAR}-templated lines untouched", () => {
    const content = [
      "# comment mentioning docker.gitea.com/gitea:1.26.1-rootless",
      "",
      "${NODE_PINNED_IMAGE}   node:${NODE_PINNED_VERSION}"
    ].join("\n");
    const { content: patched, updated } = patchImagesList(content, [GITEA]);
    expect(patched).toBe(content);
    expect(updated).toEqual([]);
  });

  it("never matches a coordinate that only shares a prefix", () => {
    const content =
      "docker.gitea.com/gitea-extra@sha256:aaaa   docker.gitea.com/gitea-extra:1.0.0\n";
    const { content: patched, updated } = patchImagesList(content, [GITEA]);
    expect(patched).toBe(content);
    expect(updated).toEqual([]);
  });
});
