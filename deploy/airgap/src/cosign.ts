/**
 * The keyful/offline cosign signing/verification wrapper now lives in the shared @scp/cosign
 * package (M17.3 E2) so the same single implementation — the air-gap-critical flag set and the E1
 * pinned-vs-probe resolver — can be reused by both the release/bundle path (this package) and,
 * later in E6, the server. This file is a thin re-export that keeps every existing @scp/airgap
 * call site (build-bundle.ts, verify-bundle.ts, the install-sh-tamper suite) importing from
 * `./cosign.js` exactly as before; signing behavior is unchanged. See
 * `packages/cosign/src/cosign.ts` for the implementation and the full flag rationale.
 */
export {
  cosignAvailable,
  resolveSigningKey,
  makeScratchDir,
  signBlobDetached,
  verifyBlobDetached,
  readPublicKey,
  type SigningKey,
  type VerifyResult
} from "@scp/cosign";
