/** `@scp/vendor-refresh` — public surface. Consumed by `tools/vendor-refresh/src/cli.ts` (the real,
 *  network-reaching maintenance tool) and by `packages/plugins/managed-dep`'s `re-vendor` bump
 *  strategy (the orchestrator calls {@link planVendorRefresh} in-process — see ADR TODO). */
export {
  BACKEND_NAMES,
  isBackendName,
  type BackendName,
  type TrackedImage,
  type VendorFile,
  type VendorRefreshIO,
  type VendorRefreshPlan,
  type FetchText,
  type ResolveImageDigest,
  type RunHelmTemplate
} from "./types.js";
export {
  ARGOPROJ_BACKENDS,
  argoprojManifestUrl,
  type ArgoprojBackendSpec
} from "./argoproj-backends.js";
export { planArgoprojBackend } from "./argoproj-plan.js";
export {
  GITEA_CHART_REF,
  GITEA_BUNDLE_IMAGE_NAME,
  GITEA_IMAGE_COORDINATE,
  giteaHelmTemplateArgs
} from "./gitea-backend.js";
export { planGitea } from "./gitea-plan.js";
export {
  planVendorRefresh,
  VALUES_YAML_PATH,
  BUNDLE_IMAGES_TS_PATH,
  IMAGES_LIST_PATH,
  type ReadRepoFile,
  type PlanVendorRefreshOptions
} from "./plan.js";
export { createSkopeoDigestResolver, SkopeoUnavailableError } from "./digest.js";
export { realVendorRefreshIO } from "./io.js";
export { splitAtDocumentBoundaries, splitIntoNamedParts, MAX_PART_BYTES } from "./split.js";
