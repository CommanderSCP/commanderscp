/** cosign signing/verification for the air-gap bundle. See docs/cosign.md §6. */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertPinnedCosignVersion, resolveCosign, type ResolvedCosign } from "./cosign-bin.js";
import { run } from "./exec.js";

/**
 * Is there a usable cosign at all — the vendored/pinned one first, an operator's PATH cosign
 * otherwise? Resolution lives in cosign-bin.ts; this package never hardcodes the binary name.
 */
export function cosignAvailable(): boolean {
  return resolveCosign().source !== "missing";
}

/** Resolve cosign and assert the pin before any invocation. See docs/cosign.md §7. */
function cosign(): ResolvedCosign {
  const resolved = resolveCosign();
  assertPinnedCosignVersion(resolved);
  return resolved;
}

export interface SigningKey {
  /** Path to the private key file (cosign key-pair format). Never copied into the bundle. */
  keyPath: string;
  /** Path to the matching public key file. This DOES get bundled (`cosign.pub`) — verification requires it. */
  pubKeyPath: string;
  /** Password for the private key, if any (cosign reads COSIGN_PASSWORD itself; we still track it to pass through explicitly rather than relying on ambient env). */
  password: string;
  isEphemeral: boolean;
}

/** Resolve which signing key to use. - CI/production. See docs/cosign.md §8. */
export async function resolveSigningKey(scratchDir: string): Promise<SigningKey> {
  const envKey = process.env.COSIGN_KEY;
  if (envKey) {
    const password = process.env.COSIGN_PASSWORD ?? "";
    let pubKeyPath = process.env.COSIGN_PUBLIC_KEY;
    if (!pubKeyPath) {
      pubKeyPath = path.join(scratchDir, "derived-cosign.pub");
      const { stdout } = run(cosign().bin, ["public-key", "--key", envKey], {
        env: { COSIGN_PASSWORD: password }
      });
      await writeFile(pubKeyPath, stdout, "utf8");
    }
    return { keyPath: envKey, pubKeyPath, password, isEphemeral: false };
  }

  process.stderr.write(
    "\n" +
      "=".repeat(78) +
      "\n" +
      "  TEST KEY — generating an ephemeral cosign keypair for this run only.\n" +
      "  This is NOT a real release signature. Do not distribute a bundle signed\n" +
      "  with this key. Set COSIGN_KEY (+ COSIGN_PASSWORD) to sign for real.\n" +
      "=".repeat(78) +
      "\n\n"
  );
  const prefix = path.join(scratchDir, "ephemeral-cosign");
  run(cosign().bin, ["generate-key-pair", "--output-key-prefix", prefix], {
    env: { COSIGN_PASSWORD: "" }
  });
  return { keyPath: `${prefix}.key`, pubKeyPath: `${prefix}.pub`, password: "", isEphemeral: true };
}

/** Make a fresh temp scratch directory for ephemeral key material / intermediate files. Caller does not need to clean it up (OS temp dir), but may. */
export function makeScratchDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "scp-airgap-"));
}

/** Whether the installed cosign advertises `--use-signing-config`. See docs/cosign.md §9. */
let cachedUseSigningConfigSupported: boolean | undefined;

function cosignSupportsUseSigningConfig(bin: string): boolean {
  if (cachedUseSigningConfigSupported === undefined) {
    try {
      const { stdout, stderr } = run(bin, ["sign-blob", "--help"], { log: false });
      cachedUseSigningConfigSupported = (stdout + stderr).includes("use-signing-config");
    } catch {
      // If cosign can't even print help (e.g. not installed), treat the flag as unsupported —
      // the actual sign call below will surface the real error to the caller regardless.
      cachedUseSigningConfigSupported = false;
    }
  }
  return cachedUseSigningConfigSupported;
}

/** The portable sign-blob flags that upload nothing to Rekor. See docs/cosign.md §10. */
export function signBlobFlags(resolved: ResolvedCosign): string[] {
  const flags = ["--tlog-upload=false", "--new-bundle-format=false"];
  if (resolved.pinned) {
    // Pinned path: a static flag set, no `--help` probe when signing. See docs/cosign.md §11.
    flags.push("--use-signing-config=false");
    return flags;
  }
  // UNPINNED path: an operator-supplied cosign of unknown vintage — keep probing, exactly as
  // before. This is not dead weight; it is the only thing that makes BYO-cosign work.
  if (cosignSupportsUseSigningConfig(resolved.bin)) flags.push("--use-signing-config=false");
  return flags;
}

/**
 * `cosign sign-blob` producing a detached, legacy-format signature file — see the module doc
 * comment above for why these exact flags and why they're required for air-gap correctness.
 */
export function signBlobDetached(filePath: string, sigOutPath: string, key: SigningKey): void {
  const resolved = cosign();
  run(
    resolved.bin,
    [
      "sign-blob",
      "--key",
      key.keyPath,
      ...signBlobFlags(resolved),
      "--output-signature",
      sigOutPath,
      "--yes",
      filePath
    ],
    { env: { COSIGN_PASSWORD: key.password } }
  );
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
}

/** `cosign verify-blob` against a detached signature file. Never throws — a verification failure is a normal, expected outcome for a tampered bundle, reported as `{ ok: false }`, not an exception. */
export function verifyBlobDetached(
  filePath: string,
  sigPath: string,
  pubKeyPath: string
): VerifyResult {
  try {
    const { stdout, stderr } = run(cosign().bin, [
      "verify-blob",
      "--key",
      pubKeyPath,
      "--signature",
      sigPath,
      "--insecure-ignore-tlog=true",
      filePath
    ]);
    return { ok: true, detail: (stdout + stderr).trim() || "Verified OK" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: message };
  }
}

/** Sign an in-memory blob with in-memory key material. See docs/cosign.md §12. */
export async function signBlob(blob: string | Buffer, privateKeyPem: string): Promise<string> {
  const dir = await makeScratchDir();
  try {
    const keyPath = path.join(dir, "cosign.key");
    const blobPath = path.join(dir, "blob.bin");
    const sigPath = path.join(dir, "blob.sig");
    await writeFile(keyPath, privateKeyPem, "utf8");
    await writeFile(blobPath, blob);
    signBlobDetached(blobPath, sigPath, {
      keyPath,
      pubKeyPath: "",
      password: "",
      isEphemeral: true
    });
    const sig = await readFile(sigPath, "utf8");
    return sig.trim();
  } finally {
    // Best-effort scrub of the scratch dir (private key file included) regardless of outcome.
    await rm(dir, { recursive: true, force: true });
  }
}

/** Verify a detached signature; a bad one is a false, not a throw. See docs/cosign.md §13. */
export async function verifyBlob(
  blob: string | Buffer,
  signature: string,
  publicKeyPem: string
): Promise<boolean> {
  const dir = await makeScratchDir();
  try {
    const pubPath = path.join(dir, "cosign.pub");
    const blobPath = path.join(dir, "blob.bin");
    const sigPath = path.join(dir, "blob.sig");
    await writeFile(pubPath, publicKeyPem, "utf8");
    await writeFile(blobPath, blob);
    await writeFile(sigPath, signature, "utf8");
    return verifyBlobDetached(blobPath, sigPath, pubPath).ok;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface VerifyImageOptions {
  /** Allow HTTP / self-signed-TLS registries. See docs/cosign.md §14. */
  allowInsecureRegistry?: boolean;
  /** Per-invocation environment: never mutate `process.env`. See docs/cosign.md §15. */
  env?: NodeJS.ProcessEnv;
}

/** Verify an image's registry signature, keyful and offline. See docs/cosign.md §16. */
export function verifyImage(
  imageRef: string,
  pubKeyPath: string,
  options: VerifyImageOptions = {}
): VerifyResult {
  const args = ["verify", "--key", pubKeyPath, "--insecure-ignore-tlog=true"];
  if (options.allowInsecureRegistry) args.push("--allow-insecure-registry");
  args.push(imageRef);
  try {
    const { stdout, stderr } = run(cosign().bin, args, { log: false, env: options.env });
    return { ok: true, detail: (stdout + stderr).trim() || "Verified OK" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: message };
  }
}

/** Verify a pinned image against an in-memory public key. See docs/cosign.md §17. */
export async function verifyImageSignature(
  imageRef: string,
  publicKeyPem: string,
  options: VerifyImageOptions = {}
): Promise<boolean> {
  const dir = await makeScratchDir();
  try {
    const pubPath = path.join(dir, "cosign.pub");
    await writeFile(pubPath, publicKeyPem, "utf8");
    return verifyImage(imageRef, pubPath, options).ok;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * KEYLESS (identity-based) image signature verification — `cosign verify <ref>
 * --certificate-identity-regexp <pattern> --certificate-oidc-issuer <issuer>`, the standard
 * Sigstore invocation for "was this signed by CI running as this workflow, without a key either
 * side manages" (ADR-0059, M29.8a: verifying an upstream Standard Stack image's signature against
 * its expected publishing identity before pinning its digest).
 *
 * THE HONEST LIMIT OF WHAT THIS CAN BE TESTED FOR OFFLINE: real keyless verification checks a
 * Fulcio-issued certificate chain and (unless `--insecure-ignore-tlog` is set) a Rekor transparency
 * log entry — both are network operations this repo's own conventions refuse to exercise in a test
 * ("tests never touch the internet"). `createKeylessImageVerifier`'s injected `runFn` seam (mirroring
 * `createSkopeoDigestResolver`'s) lets a test prove the INVOCATION CONTRACT — the exact argv this
 * builds, and how it interprets cosign's exit code and stdout — without asserting anything about
 * Sigstore's actual cryptography, exactly as `verifyImage`'s own (untested) keyful path already does
 * for a real registry call. A `VerificationStatus` of `"unavailable"` is a DISTINCT, non-blocking
 * outcome from `"unverified"` (cosign is reachable but reports no matching signature) precisely so a
 * caller can choose to fail-open-with-a-loud-record rather than treat "I could not check" as "it
 * passed" — see `docs/adr/0059-revendor-bump-strategy-network-split.md`'s own "Consequences" section
 * for why this repo does not yet claim universal upstream-image-signing coverage.
 */
export interface KeylessImageVerifyResult {
  status: "verified" | "unverified" | "unavailable";
  detail: string;
}

export interface KeylessIdentity {
  /** A regex `cosign --certificate-identity-regexp` matches against the signing workflow's subject
   *  (e.g. `^https://github\\.com/argoproj/argo-cd/`). */
  identityRegexp: string;
  /** The OIDC issuer the certificate must have been issued against (e.g.
   *  `https://token.actions.githubusercontent.com` for GitHub Actions-signed releases). */
  oidcIssuer: string;
}

/** Build a keyless verifier. `runFn` is injectable ONLY for tests — real callers take the default,
 *  which shells out to the pinned cosign binary. */
export function createKeylessImageVerifier(
  runFn: (bin: string, args: string[]) => { stdout: string; stderr: string } = (bin, args) =>
    run(bin, args, { log: false })
): (imageRef: string, identity: KeylessIdentity) => KeylessImageVerifyResult {
  return (imageRef, identity) => {
    const resolved = resolveCosign();
    if (resolved.source === "missing") {
      return {
        status: "unavailable",
        detail:
          "no cosign binary is available (checked SCP_COSIGN_BIN, the vendored path, and PATH)"
      };
    }
    const args = [
      "verify",
      "--certificate-identity-regexp",
      identity.identityRegexp,
      "--certificate-oidc-issuer",
      identity.oidcIssuer,
      imageRef
    ];
    try {
      const { stdout, stderr } = runFn(resolved.bin, args);
      return { status: "verified", detail: (stdout + stderr).trim() || "Verified OK" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // cosign's own distinction: "no matching signatures" is an ANSWER (this image is not signed
      // the way expected), never a transport/tooling failure — both are reported as `unverified`
      // here because this caller's only decision is "may I pin this digest", and the reason is kept
      // in `detail` either way rather than collapsed into a boolean.
      return { status: "unverified", detail: message };
    }
  };
}

/** Read a bundled public key file's bytes back out (used by verify-bundle.ts to sanity-check the file exists and is non-empty before trusting it). */
export async function readPublicKey(pubKeyPath: string): Promise<string> {
  const content = await readFile(pubKeyPath, "utf8");
  if (!content.includes("PUBLIC KEY")) {
    throw new Error(`${pubKeyPath} does not look like a PEM public key`);
  }
  return content;
}
