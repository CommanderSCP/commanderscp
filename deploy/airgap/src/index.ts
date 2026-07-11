/**
 * @scp/airgap — air-gap bundle builder/verifier (DESIGN.md §16, BUILD_AND_TEST.md §8 M8).
 *
 * This module re-exports the package's pure-logic/wrapper surface for programmatic use; the
 * actual CLI entrypoints are `build-bundle.ts`/`verify-bundle.ts` (run via the `bundle`/`verify`
 * pnpm scripts — see README.md), not this file.
 */
export * from "./types.js";
export * as checksums from "./checksums.js";
export * as ociLayout from "./oci-layout.js";
export * as skopeo from "./skopeo.js";
export * as cosign from "./cosign.js";
export * as manifest from "./manifest.js";
export * as composeRetarget from "./compose-retarget.js";
export * as repoPaths from "./repo-paths.js";
