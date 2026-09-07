/** The cosign wrapper now lives in the shared package. See docs/airgap.md §36. */
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
