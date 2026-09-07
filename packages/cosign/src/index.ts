/** The one keyful, offline cosign wrapper, shared by both paths. See docs/cosign.md §19. */

// Thin child_process wrapper (argv-array execFileSync, no shell) shared by cosign.ts/skopeo-bin.ts
// and, since this consolidation, `deploy/airgap`'s skopeo/build-bundle/verify-bundle callers too.
export { run, which, CommandError, type RunResult, type RunOptions } from "./exec.js";

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
} from "./cosign-bin.js";

// Skopeo binary resolution + provenance assertion (M15.5 c1) — the same pinned-vs-probe pattern
// applied to the vendored skopeo. Resolution only; no product behavior (the c2 relay is the
// first consumer). The release/bundle path's operator-PATH skopeo does NOT go through this.
export {
  PINNED_SKOPEO_VERSION,
  PINNED_SKOPEO_IMAGE,
  VENDORED_SKOPEO_PATH,
  SKOPEO_BIN_ENV,
  resolveSkopeo,
  skopeoReportedVersion,
  assertPinnedSkopeoVersion,
  type SkopeoSource,
  type ResolvedSkopeo
} from "./skopeo-bin.js";

export {
  cosignAvailable,
  resolveSigningKey,
  makeScratchDir,
  signBlobFlags,
  signBlobDetached,
  verifyBlobDetached,
  verifyImage,
  verifyImageSignature,
  signBlob,
  verifyBlob,
  readPublicKey,
  type SigningKey,
  type VerifyResult,
  type VerifyImageOptions
} from "./cosign.js";

// Non-interactive keypair generation (M17.3 E4) — returns PEM STRINGS for the server to persist,
// leaving no key file on disk. The first apps/server consumer of this package.
export { generateKeyPair, type GeneratedKeyPair } from "./keygen.js";
