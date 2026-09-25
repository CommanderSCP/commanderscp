import { describe, expect, it } from "vitest";
import {
  ARGOPROJ_BACKENDS,
  argoprojManifestUrl,
  argoprojManifestUrlBySha,
  isValidCommitSha,
  isValidUpstreamTag
} from "./argoproj-backends.js";

/**
 * REGRESSION, measured against the real network 2026-09-25 (see the PR body for the full smoke
 * test): a first version of this tool assumed every argoproj project publishes its pinned release
 * manifest at `raw.githubusercontent.com/<repo>/<tag>/manifests/install.yaml`. That is TRUE for Argo
 * CD and Argo Events (their source tree at the tag already carries the release's own image tag), and
 * FALSE for Argo Workflows (404 — no such path at all) and Argo Rollouts (200, but the file still
 * says `image: quay.io/argoproj/argo-rollouts:latest`, a confidently wrong answer that fetches
 * successfully). Both of the latter publish the real, pinned artifact only as a GitHub Release
 * asset. This test pins the per-backend choice so a future "helpful" simplification back to one URL
 * shape cannot reintroduce the bug silently.
 */
describe("argoprojManifestUrl", () => {
  it("argocd and argo-events read the raw source tree (confirmed byte-identical to upstream)", () => {
    expect(argoprojManifestUrl(ARGOPROJ_BACKENDS.argocd, "v3.4.5")).toBe(
      "https://raw.githubusercontent.com/argoproj/argo-cd/v3.4.5/manifests/install.yaml"
    );
    expect(argoprojManifestUrl(ARGOPROJ_BACKENDS["argo-events"], "v1.9.10")).toBe(
      "https://raw.githubusercontent.com/argoproj/argo-events/v1.9.10/manifests/install.yaml"
    );
  });

  it("argo-workflows and argo-rollouts read the GitHub Release asset, NOT the source tree", () => {
    expect(argoprojManifestUrl(ARGOPROJ_BACKENDS["argo-workflows"], "v4.0.7")).toBe(
      "https://github.com/argoproj/argo-workflows/releases/download/v4.0.7/install.yaml"
    );
    expect(argoprojManifestUrl(ARGOPROJ_BACKENDS["argo-rollouts"], "v1.10.0")).toBe(
      "https://github.com/argoproj/argo-rollouts/releases/download/v1.10.0/install.yaml"
    );
  });

  it("SECURITY (probe P1, 2026-09-25 review): refuses a path-traversal tag rather than building a URL from it", () => {
    // Each of these resolved, via `new URL()`'s own path normalisation, to a completely different
    // repository/path than the one intended — the exact attacker-controlled-fetch shape the review
    // measured. All four are refused by the same tag grammar, before a URL is ever built.
    const malicious = [
      "../../../attacker/evil/main",
      "v1.0.0/../../../../attacker/evil/main",
      "%2e%2e/%2e%2e/%2e%2e/attacker/evil/main",
      "../../../attacker/evil/releases/download/v1"
    ];
    for (const tag of malicious) {
      expect(isValidUpstreamTag(tag), `'${tag}' must be rejected`).toBe(false);
      expect(() => argoprojManifestUrl(ARGOPROJ_BACKENDS.argocd, tag)).toThrow(
        /not a well-formed upstream release tag/
      );
      expect(() => argoprojManifestUrl(ARGOPROJ_BACKENDS["argo-workflows"], tag)).toThrow(
        /not a well-formed upstream release tag/
      );
    }
  });

  it("isValidUpstreamTag accepts real upstream tag shapes and rejects lookalikes", () => {
    for (const good of ["v3.4.5", "3.4.5", "v4.0.7", "v1.10.0-rc1", "v1.10.0-rc.1"]) {
      expect(isValidUpstreamTag(good), good).toBe(true);
    }
    for (const bad of ["", "latest", "v3.4", "v3.4.5 ", " v3.4.5", "v3.4.5/../x", "v3.4.5\n"]) {
      expect(isValidUpstreamTag(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("argoprojManifestUrlBySha fetches raw-tree backends by commit sha (ADR-0059 finding 1)", () => {
    const sha = "a".repeat(40);
    expect(argoprojManifestUrlBySha(ARGOPROJ_BACKENDS.argocd, sha)).toBe(
      `https://raw.githubusercontent.com/argoproj/argo-cd/${sha}/manifests/install.yaml`
    );
  });

  it("argoprojManifestUrlBySha refuses a release-asset backend — it has no sha-addressed form", () => {
    expect(() =>
      argoprojManifestUrlBySha(ARGOPROJ_BACKENDS["argo-workflows"], "a".repeat(40))
    ).toThrow(/no commit-sha-addressed form/);
  });

  it("argoprojManifestUrlBySha refuses a malformed sha (same P1 hazard, sha-shaped)", () => {
    for (const bad of ["", "not-hex", "a".repeat(39), "a".repeat(41), "A".repeat(40), "../../etc/passwd"]) {
      expect(isValidCommitSha(bad), JSON.stringify(bad)).toBe(false);
      expect(() => argoprojManifestUrlBySha(ARGOPROJ_BACKENDS.argocd, bad)).toThrow(
        /not a well-formed 40-hex-character commit sha/
      );
    }
  });

  it("every backend declares a urlKind consistent with its URL fields (no half-filled spec)", () => {
    for (const [name, spec] of Object.entries(ARGOPROJ_BACKENDS)) {
      if (spec.urlKind === "raw-tree") {
        expect(spec.manifestPath, `${name}: raw-tree needs manifestPath`).not.toBe("");
        expect(spec.releaseAssetName, `${name}: raw-tree should not set releaseAssetName`).toBe("");
      } else {
        expect(spec.releaseAssetName, `${name}: release-asset needs releaseAssetName`).not.toBe("");
        expect(spec.manifestPath, `${name}: release-asset should not set manifestPath`).toBe("");
      }
    }
  });
});
