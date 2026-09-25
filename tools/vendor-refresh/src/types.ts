/** `tools/vendor-refresh` — types shared across the tool. See BUILD_AND_TEST.md M29.8(a). */

/** The five bundled Standard Stack backends this tool knows how to re-vendor (proposal §9.1). */
export const BACKEND_NAMES = [
  "argocd",
  "argo-workflows",
  "argo-rollouts",
  "argo-events",
  "gitea"
] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

export function isBackendName(value: string): value is BackendName {
  return (BACKEND_NAMES as readonly string[]).includes(value);
}

/** One file this tool writes or rewrites, relative to the repo root. Content is always the COMPLETE
 *  new byte content — callers never patch in place, so a plan is trivially diffable and trivially
 *  replayable (the determinism test just runs the planner twice and compares this list). */
export interface VendorFile {
  /** Repo-root-relative path, e.g. `deploy/helm-bundled/vendor/argocd/install.yaml`. */
  path: string;
  content: string;
}

/** One image this backend declares that SCP tracks (retargets/pins) outside the vendored manifest
 *  itself — the set `values.yaml`, `bundle-images.ts` and (sometimes) `images.list` must agree on. */
export interface TrackedImage {
  /** The `bundle-images.ts` BUNDLE_IMAGE_SPECS `name` this image corresponds to. */
  bundleImageName: string;
  /** The resolved, digest-pinned reference this backend now declares, e.g.
   *  `quay.io/argoproj/argocd:v3.5.0@sha256:...`. */
  resolvedRef: string;
  /** The upstream ref with just the tag (no digest) — what the vendored manifest itself says (or, for
   *  gitea, what `bundledExecutor.gitea.image` is set to) — `values.yaml`'s default and
   *  `bundle-images.ts`'s `defaultRef` are both written as this, undigested: a digest is pinned at
   *  BUNDLE time (`skopeo copy` in `deploy/airgap`), not baked into the chart's connected default,
   *  matching every other bundled backend already in the tree. */
  tagRef: string;
}

/** The result of planning one backend's re-vendor at one tag: every file it would write, the tracked
 *  images it resolved, and a short human summary (the PR body / commit message material). */
export interface VendorRefreshPlan {
  backend: BackendName;
  tag: string;
  files: readonly VendorFile[];
  trackedImages: readonly TrackedImage[];
  summary: string;
}

/** Fetch arbitrary upstream text. Injected so tests never touch the network — see
 *  `test-support/fixture-server.ts` and `test-support/fixture-fetch.ts`. */
export type FetchText = (url: string) => Promise<string>;

/** Resolve `ref` (a tag-qualified image reference, no digest) to its manifest digest
 *  (`sha256:<hex>`), via the repo's pinned skopeo. Injected for the same reason as {@link FetchText}. */
export type ResolveImageDigest = (ref: string) => Promise<string>;

/** Run `helm template <releaseName> <chartRef> <args...>` and return its stdout. Injected so gitea's
 *  planner can be pointed at a local fixture chart directory instead of a real chart repository. */
export type RunHelmTemplate = (args: readonly string[]) => Promise<string>;

/** Everything a plan needs to reach outside this package. Every real implementation lives in
 *  `io.ts`; every test supplies a fixture-backed one instead. */
export interface VendorRefreshIO {
  fetchText: FetchText;
  resolveImageDigest: ResolveImageDigest;
  runHelmTemplate: RunHelmTemplate;
}
