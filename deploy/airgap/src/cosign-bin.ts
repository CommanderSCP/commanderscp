/**
 * The cosign binary resolver (pin-vs-probe) now lives in the shared @scp/cosign package (M17.3 E2)
 * so the same single keyful/offline cosign implementation can be reused by both the release/bundle
 * path (this package) and — later, in E6 — the server. This file is a thin re-export that keeps
 * every existing @scp/airgap call site (and the install-sh-tamper suite) importing from
 * `./cosign-bin.js` exactly as before; the behavior is unchanged. See
 * `packages/cosign/src/cosign-bin.ts` for the implementation and its full doc comment.
 */
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
