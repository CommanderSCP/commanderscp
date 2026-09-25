/** The four argoproj-family backends: one `install.yaml` fetched from GitHub at a release tag,
 *  vendored unmodified (see `deploy/helm-bundled/README.md` and each backend's own vendoring commit
 *  — `58f72b75` for Argo CD, `0546d466` for Workflows/Events, `8b4ed887` for Rollouts). Gitea is NOT
 *  here — it is vendored from a Helm chart, not a raw manifest, and lives in `gitea-plan.ts`. WHERE
 *  that `install.yaml` actually lives differs per project — see {@link ArgoprojUrlKind}. */

/** One image this backend's vendored manifest declares that SCP separately tracks (retargets in the
 *  chart, pins in `bundle-images.ts`, and sometimes mirrors in `tools/ci-mirror/images.list`). The
 *  COORDINATE (no tag) is matched against what `@scp/dependency-manifests`'s `parseKubernetesImages`
 *  finds in the fetched manifest — never a line-by-line re-parse of our own. */
export interface TrackedImageSpec {
  /** The image coordinate exactly as the vendored manifest declares it (registry + repository, no
   *  tag) — e.g. `quay.io/argoproj/argocd`. */
  coordinate: string;
  /** The `deploy/airgap/src/bundle-images.ts` `BUNDLE_IMAGE_SPECS[].name` this maps to. */
  bundleImageName: string;
}

/**
 * WHERE the pinned, final manifest actually lives — measured per project (2026-09), not assumed:
 *
 *   - `raw-tree`: `raw.githubusercontent.com/<repo>/<tag>/manifests/install.yaml` already carries the
 *     release's own image tag baked in. Confirmed byte-for-byte against both the file already
 *     vendored in this repo AND the sha256 recorded in its original vendoring commit — Argo CD
 *     (`58f72b75`, `cdf6758b…`) and Argo Events (this tool's own smoke test, 2026-09-25).
 *   - `release-asset`: the SOURCE TREE at that tag is NOT the release artifact — it still says
 *     `image: quay.io/argoproj/<name>:latest` (a build-time substitution happens only when the
 *     release is cut) — so the raw-tree path is confidently WRONG for these two, byte-different but
 *     not obviously broken (it fetches successfully; it is just the wrong bytes). The real artifact
 *     is the GitHub Release's uploaded asset,
 *     `github.com/<repo>/releases/download/<tag>/install.yaml`. Confirmed byte-for-byte against the
 *     vendored files for both Argo Rollouts (`ca8a1785…`, `8b4ed887`) and Argo Workflows
 *     (`4e7112cd…`, `0546d466`) — see this tool's own smoke test, 2026-09-25.
 *
 * This is exactly the trap CLAUDE.md's census discipline warns about: "argoproj publishes at
 * `manifests/install.yaml`" reads as one convention across a family of sibling projects and is false
 * for half of them. A future fifth argoproj backend must have ITS OWN `urlKind` measured, never
 * assumed from this table.
 */
export type ArgoprojUrlKind = "raw-tree" | "release-asset";

export interface ArgoprojBackendSpec {
  /** `owner/repo` on GitHub — the upstream this backend is vendored from. */
  upstreamRepo: string;
  /** The path within the release tag's tree this backend's manifest lives at, for `raw-tree` only. */
  manifestPath: string;
  /** The asset filename for `release-asset` only, e.g. `install.yaml`. */
  releaseAssetName: string;
  urlKind: ArgoprojUrlKind;
  /** `deploy/helm-bundled/vendor/<vendorDir>/...` */
  vendorDir: string;
  /** Argo Workflows alone needs the 4-way split (M11.3; `install.yaml` is ~11 MB). */
  split: boolean;
  trackedImages: readonly TrackedImageSpec[];
}

export const ARGOPROJ_BACKENDS: Record<
  "argocd" | "argo-workflows" | "argo-rollouts" | "argo-events",
  ArgoprojBackendSpec
> = {
  argocd: {
    upstreamRepo: "argoproj/argo-cd",
    manifestPath: "manifests/install.yaml",
    releaseAssetName: "",
    urlKind: "raw-tree",
    vendorDir: "argocd",
    split: false,
    trackedImages: [{ coordinate: "quay.io/argoproj/argocd", bundleImageName: "argocd" }]
    // NOT tracked, deliberately named rather than silently dropped: `public.ecr.aws/docker/library/
    // redis` (argocd.yaml retargets this to bundledExecutor.argocd.valkeyImage, an OWNED deviation —
    // never upstream's own version, so there is nothing for vendor-refresh to resolve against
    // upstream here) and `ghcr.io/dexidp/dex` (genuinely untracked today — see the tool's README).
  },
  "argo-workflows": {
    upstreamRepo: "argoproj/argo-workflows",
    manifestPath: "",
    releaseAssetName: "install.yaml",
    urlKind: "release-asset",
    vendorDir: "argo-workflows",
    split: true,
    trackedImages: [
      { coordinate: "quay.io/argoproj/argocli", bundleImageName: "argo-workflows-cli" },
      {
        coordinate: "quay.io/argoproj/workflow-controller",
        bundleImageName: "argo-workflows-controller"
      }
    ]
  },
  "argo-rollouts": {
    upstreamRepo: "argoproj/argo-rollouts",
    manifestPath: "",
    releaseAssetName: "install.yaml",
    urlKind: "release-asset",
    vendorDir: "argo-rollouts",
    split: false,
    trackedImages: [
      { coordinate: "quay.io/argoproj/argo-rollouts", bundleImageName: "argo-rollouts" }
    ]
  },
  "argo-events": {
    upstreamRepo: "argoproj/argo-events",
    manifestPath: "manifests/install.yaml",
    releaseAssetName: "",
    urlKind: "raw-tree",
    vendorDir: "argo-events",
    split: false,
    trackedImages: [{ coordinate: "quay.io/argoproj/argo-events", bundleImageName: "argo-events" }]
  }
};

export function argoprojManifestUrl(spec: ArgoprojBackendSpec, tag: string): string {
  if (spec.urlKind === "release-asset") {
    return `https://github.com/${spec.upstreamRepo}/releases/download/${tag}/${spec.releaseAssetName}`;
  }
  return `https://raw.githubusercontent.com/${spec.upstreamRepo}/${tag}/${spec.manifestPath}`;
}
