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
    // upstream here) and `ghcr.io/dexidp/dex` (retargeted and bundled since M29.2, but on its own
    // tag, which the sandbox cannot resolve; the chart fails the render when it drifts — see the README).
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

/**
 * A strict upstream release-tag grammar — `v`-optional semver, optional `-prerelease`. This is the
 * ONE gate between a caller-influenced tag string and a URL path segment; every `argoprojManifestUrl`
 * call refuses anything else. Found exploitable in review (2026-09-25, probe P1): an unvalidated tag
 * like `../../../attacker/evil/main` or `v1.0.0/../../../../attacker/evil/main` resolves via `new
 * URL()`'s own path normalisation to a DIFFERENT repository/path entirely — `fetchText` would then
 * happily fetch and vendor an attacker-controlled file as if it were upstream's. `%2e%2e/...`
 * (pre-encoded traversal) is refused by the same grammar without needing a decode step, since it
 * simply is not a well-formed tag either.
 */
const UPSTREAM_TAG_PATTERN = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

export function isValidUpstreamTag(tag: string): boolean {
  return UPSTREAM_TAG_PATTERN.test(tag);
}

/** A git commit sha, exactly — 40 lowercase hex characters. Guards the SAME class of hazard
 *  {@link isValidUpstreamTag} guards for a tag: an unvalidated string interpolated into a fetch URL
 *  path segment. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

export function isValidCommitSha(sha: string): boolean {
  return COMMIT_SHA_PATTERN.test(sha);
}

/** Fetch a `raw-tree` backend's manifest BY COMMIT SHA rather than by tag (ADR-0059, finding 1) —
 *  content-addressed against the exact tree GitHub's `/commits/{tag}` resolved, immune to a tag
 *  being force-moved after the orchestrator resolved it. ONLY valid for `urlKind: "raw-tree"`: a
 *  `release-asset` is a GitHub Release upload, not a tree entry, and has no sha-addressed form —
 *  see `revendor-orchestrator.ts` for how that class is fetched (by tag, the one upstream-published
 *  address it has) and ADR-0059 for why that gap is accepted rather than papered over. */
export function argoprojManifestUrlBySha(spec: ArgoprojBackendSpec, sha: string): string {
  if (spec.urlKind !== "raw-tree") {
    throw new Error(
      `vendor-refresh: '${spec.upstreamRepo}' is urlKind '${spec.urlKind}', which has no commit-sha-addressed form — only 'raw-tree' backends can be fetched by sha`
    );
  }
  if (!isValidCommitSha(sha)) {
    throw new Error(`vendor-refresh: '${sha}' is not a well-formed 40-hex-character commit sha`);
  }
  return `https://raw.githubusercontent.com/${spec.upstreamRepo}/${sha}/${spec.manifestPath}`;
}

export function argoprojManifestUrl(spec: ArgoprojBackendSpec, tag: string): string {
  if (!isValidUpstreamTag(tag)) {
    throw new Error(
      `vendor-refresh: '${tag}' is not a well-formed upstream release tag (expected v-optional ` +
        "semver, e.g. v3.5.0 or v3.5.0-rc1) — refusing to build a fetch URL from it"
    );
  }
  // encodeURIComponent even though the grammar above already excludes `/`, `.`/`..` segments and
  // every URL-meaningful character: belt-and-braces so a FUTURE grammar relaxation (e.g. allowing a
  // build-metadata suffix) cannot reopen this by itself — the encoding step does not depend on the
  // grammar staying exactly this strict.
  const safeTag = encodeURIComponent(tag);
  if (spec.urlKind === "release-asset") {
    return `https://github.com/${spec.upstreamRepo}/releases/download/${safeTag}/${spec.releaseAssetName}`;
  }
  return `https://raw.githubusercontent.com/${spec.upstreamRepo}/${safeTag}/${spec.manifestPath}`;
}
