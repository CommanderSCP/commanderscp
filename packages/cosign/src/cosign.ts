/** cosign signing/verification for the air-gap bundle. See docs/cosign/cosign.md §1. */
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

/**
 * Resolve cosign and, on the pinned path, assert it really is the pinned release before any
 * call. Every cosign invocation in this module goes through here, so a wrong binary fails
 * closed at the first use rather than producing signatures from an unvetted build.
 */
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

/** Resolve which signing key to use. See docs/cosign/cosign.md §2. */
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

/**
 * Whether the installed cosign advertises `--use-signing-config` (a newer flag, ~cosign 2.5+/3.x).
 * Probed once from `cosign sign-blob --help` (the flag is listed there on versions that have it)
 * and cached for the rest of the process. See the module doc comment for why this matters and
 * signBlobFlags() for how it's used.
 */
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

/**
 * The portable `cosign sign-blob` flag set that produces a legacy detached signature and uploads
 * NOTHING to the Rekor transparency log — see the module doc comment for the full rationale and
 * the per-version behavior. `--tlog-upload=false` is the essential, long-stable egress-prevention
 * flag; `--use-signing-config=false` is added ONLY when the installed cosign has it (newer builds
 * make `--tlog-upload=false` conflict with its default `true`; older builds reject the flag as
 * unknown and don't need it).
 */
export function signBlobFlags(resolved: ResolvedCosign): string[] {
  const flags = ["--tlog-upload=false", "--new-bundle-format=false"];
  if (resolved.pinned) {
    // PINNED path: we know exactly which release this is (asserted fail-closed by cosign()
    // above), so the flag set is a STATIC known-good constant — no `--help` subprocess on a
    // signing hot path to learn something the pin already tells us. Verified against the pinned
    // v3.1.2 binary behind a closed proxy (HTTPS_PROXY=http://127.0.0.1:1): sign-blob +
    // verify-blob both succeed with zero egress.
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

/**
 * Sign an IN-MEMORY blob with IN-MEMORY cosign private-key material, returning the detached
 * signature as a base64 string. The seam the SERVER (M17.3 E6) uses to cosign-sign a promotion
 * MANIFEST with the org's `instance_cosign_keys` private key: it materializes the key + blob to a
 * fresh, private scratch dir, runs the offline/air-gap `sign-blob` (the same `--tlog-upload=false`
 * flag set as every other call here — NOTHING is uploaded to Rekor), reads the detached signature
 * back, and SCRUBS the scratch dir (KEY FILE INCLUDED) before returning. No key material survives
 * the call on disk, in success OR failure — the `finally` runs on both paths.
 *
 * `privateKeyPem` is cosign's empty-password encrypted PEM (`COSIGN_PASSWORD=''`), exactly what
 * `generateKeyPair`/`instance_cosign_keys` produce and store.
 */
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

/**
 * Verify a detached base64 `signature` over an IN-MEMORY blob against an IN-MEMORY cosign PUBLIC
 * key PEM. Materializes all three to a scratch dir, runs `verify-blob`
 * (`--insecure-ignore-tlog=true`, offline), scrubs, and returns a boolean. NEVER throws — a bad
 * signature is a normal, expected outcome (a swapped/forged manifest), reported as `false`.
 */
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
  /** Allow HTTP / self-signed-TLS registries. See docs/cosign/cosign.md §3. */
  allowInsecureRegistry?: boolean;
  /** Extra environment variables overlaid onto `process.env` for THIS cosign subprocess only —
   *  e.g. `DOCKER_CONFIG` pointing at a per-invocation scratch auth dir for a credentialed
   *  registry read. Per-invocation by design: callers must NEVER mutate `process.env` to feed
   *  cosign credentials — a process-global mutation leaks this caller's registry auth into every
   *  CONCURRENT cosign/skopeo subprocess in a multi-tenant server (another org's relay, a
   *  pre-deploy-gate verify), and two concurrent mutators race each other's save/restore. */
  env?: NodeJS.ProcessEnv;
}

/**
 * `cosign verify` a container image / OCI artifact against the REGISTRY-ATTACHED signature, keyful
 * and offline (`--insecure-ignore-tlog=true` — the origin never wrote a Rekor entry we could or would
 * check; `--key` pins the exact public key, so no Fulcio identity is consulted). `imageRef` MUST be
 * digest-pinned (`registry/repo@sha256:…`) so verification binds to exact bytes. cosign READS the
 * registry to fetch the manifest + its `.sig`; it never pushes or pulls image bytes anywhere else.
 *
 * Never throws — a failed verification (tampered/unsigned/absent image, wrong key) is a normal,
 * expected, fail-closed outcome reported as `{ ok: false }`. A MISSING image (bytes not present in
 * the reachable registry) makes cosign's own fetch fail, which surfaces here as `{ ok: false }` too —
 * exactly the fail-closed "absent artifact FAILS" the per-artifact pre-deploy gate requires.
 */
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

/**
 * Verify a digest-pinned OCI `imageRef`'s registry-attached signature against an IN-MEMORY cosign
 * PUBLIC key PEM (the ergonomic seam the SERVER uses — the exporter's distributed cosign key lives in
 * Postgres as a PEM string, not a file). Materializes the key to a private scratch dir, runs
 * {@link verifyImage}, scrubs the dir, and returns a boolean. NEVER throws — a bad/absent signature
 * is a normal, expected, fail-closed outcome reported as `false`.
 */
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

/** Read a bundled public key file's bytes back out (used by verify-bundle.ts to sanity-check the file exists and is non-empty before trusting it). */
export async function readPublicKey(pubKeyPath: string): Promise<string> {
  const content = await readFile(pubKeyPath, "utf8");
  if (!content.includes("PUBLIC KEY")) {
    throw new Error(`${pubKeyPath} does not look like a PEM public key`);
  }
  return content;
}
