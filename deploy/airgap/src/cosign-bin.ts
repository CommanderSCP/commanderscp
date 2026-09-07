/** The cosign binary resolver. See docs/airgap.md §35. */
export {
  PINNED_COSIGN_VERSION,
  PINNED_COSIGN_IMAGE,
  VENDORED_COSIGN_PATH,
  COSIGN_BIN_ENV,
  resolveCosign,
  cosignReportedVersion,
  assertPinnedCosignVersion,
  type CosignSource,
  type ResolvedCosign
} from "@scp/cosign";
