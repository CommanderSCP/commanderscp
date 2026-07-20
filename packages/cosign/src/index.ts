/**
 * @scp/cosign — the single keyful/offline cosign wrapper for CommanderSCP.
 *
 * Lifted verbatim from `deploy/airgap` (M17.3 E2) so one implementation of the air-gap-critical
 * flag set and the E1 pinned-vs-probe binary resolver can be shared by BOTH the release/bundle
 * path (`@scp/airgap`, which re-exports this) and — later, in E6 — the server. This increment is a
 * pure lift: no signing behavior changed. See cosign.ts's module doc for the flag rationale and
 * cosign-bin.ts's for the pinned-vs-operator resolution.
 *
 * Air-gap invariants preserved here verbatim: `--tlog-upload=false` /
 * `--new-bundle-format=false` (sign) and `--insecure-ignore-tlog=true` (verify) are the flags
 * that keep signing off the public Rekor log; Fulcio/Rekor are NEVER contacted.
 */

// Binary resolution + provenance assertion (E1 pinned-vs-probe).
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

// Keyful/offline signing + verification wrapper.
export {
  cosignAvailable,
  resolveSigningKey,
  makeScratchDir,
  signBlobFlags,
  signBlobDetached,
  verifyBlobDetached,
  readPublicKey,
  type SigningKey,
  type VerifyResult
} from "./cosign.js";

// Non-interactive keypair generation (M17.3 E4) — returns PEM STRINGS for the server to persist,
// leaving no key file on disk. The first apps/server consumer of this package.
export { generateKeyPair, type GeneratedKeyPair } from "./keygen.js";
