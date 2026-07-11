/**
 * cosign signing/verification for the air-gap bundle.
 *
 * ## Why sign-blob, not `cosign sign`
 *
 * `cosign sign` attaches a signature to an image IN A REGISTRY (it pushes a `.sig` artifact next
 * to the manifest). At bundle-BUILD time our images only exist as local OCI-layout directories —
 * there is no registry yet to attach anything to (the registry is the CUSTOMER's, chosen at
 * install time, per-deployment). So this package signs a small **digest file** per image
 * (`sha256:<manifest digest>`, produced by oci-layout.ts) with `cosign sign-blob`, plus the
 * bundle's `CHECKSUMS.txt` for whole-bundle integrity. `cosign sign`/`cosign verify` against the
 * registry image itself becomes available to the OPERATOR after install.sh's retarget-push, as a
 * documented optional extra (see install.sh's own comments) — it's not this package's job to do
 * that on the operator's behalf, since it doesn't control the customer registry's credentials.
 *
 * ## The air-gap-critical flag combination (found empirically on this exact cosign build)
 *
 * `cosign sign-blob` in this environment's cosign (`cosign version` reports a v2-line build)
 * defaults to uploading every signature to the **public** Rekor transparency log
 * (`https://rekor.sigstore.dev`) even for pure local-keypair signing with `--use-signing-config
 * false` — confirmed by pointing HTTP(S)_PROXY at a closed port and watching `sign-blob` fail
 * with `Post "https://rekor.sigstore.dev/api/v1/log/entries": ... connection refused`. That is a
 * hard violation of CLAUDE.md principle #5 ("no runtime network calls to the outside world") and
 * of this milestone's own "NO runtime network calls" requirement — bundle building must never
 * depend on reaching the public internet, let alone leak a customer's private image digests to a
 * public transparency log.
 *
 * The fix is `--tlog-upload=false` — a flag `cosign sign-blob --help` doesn't even list any more
 * (cosign prints "Flag --tlog-upload has been deprecated, prefer using a --signing-config file
 * with no transparency log services" and then honors it exactly as before) — combined with
 * `--new-bundle-format=false --use-signing-config=false --output-signature <file> --yes` to get
 * the legacy detached-signature file this package stores in the bundle, with no bundle-format
 * digest-file requirement and no signing-config lookup. Verified against a broken proxy that this
 * combination makes zero outbound connection attempts. `verifyBlobDetached` mirrors it with
 * `--insecure-ignore-tlog=true` on the verify side (we deliberately never wrote a tlog entry, so
 * asking cosign to check for one would always — correctly, but uselessly — fail).
 *
 * If cosign's flags change again, the empirical test to re-run is: set `HTTPS_PROXY=http://127.0.0.1:1`
 * (a closed local port) and confirm sign/verify still succeed — if either call ever tries the
 * network, it will fail fast with a `connection refused` instead of silently working.
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { run, which } from "./exec.js";

export function cosignAvailable(): boolean {
  return which("cosign");
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

/**
 * Resolve which signing key to use.
 *
 * - CI/production: set `COSIGN_KEY` (path to a cosign-format private key file) and
 *   `COSIGN_PASSWORD` (its password — cosign's own conventional env var name; empty string is a
 *   valid password for an unencrypted key). `COSIGN_PUBLIC_KEY` should also be set to the
 *   matching public key path; if omitted, it's derived on the fly via `cosign public-key`.
 * - Local dev/testing (no `COSIGN_KEY` set): generates a brand-new ephemeral key pair under
 *   `scratchDir` with an empty password, loudly logged as a TEST KEY. This keypair is never
 *   written anywhere under the repo or the bundle output except the public half, which is by
 *   design bundled as `cosign.pub` (a public key is not a secret) — the private half lives only
 *   in `scratchDir`, which callers are responsible for treating as ephemeral (e.g. an os.tmpdir()
 *   subdirectory, as build-bundle.ts does).
 */
export async function resolveSigningKey(scratchDir: string): Promise<SigningKey> {
  const envKey = process.env.COSIGN_KEY;
  if (envKey) {
    const password = process.env.COSIGN_PASSWORD ?? "";
    let pubKeyPath = process.env.COSIGN_PUBLIC_KEY;
    if (!pubKeyPath) {
      pubKeyPath = path.join(scratchDir, "derived-cosign.pub");
      const { stdout } = run("cosign", ["public-key", "--key", envKey], { env: { COSIGN_PASSWORD: password } });
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
  run("cosign", ["generate-key-pair", "--output-key-prefix", prefix], { env: { COSIGN_PASSWORD: "" } });
  return { keyPath: `${prefix}.key`, pubKeyPath: `${prefix}.pub`, password: "", isEphemeral: true };
}

/** Make a fresh temp scratch directory for ephemeral key material / intermediate files. Caller does not need to clean it up (OS temp dir), but may. */
export function makeScratchDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "scp-airgap-"));
}

/**
 * `cosign sign-blob` producing a detached, legacy-format signature file — see the module doc
 * comment above for why these exact flags and why they're required for air-gap correctness.
 */
export function signBlobDetached(filePath: string, sigOutPath: string, key: SigningKey): void {
  run(
    "cosign",
    [
      "sign-blob",
      "--key",
      key.keyPath,
      "--tlog-upload=false",
      "--new-bundle-format=false",
      "--use-signing-config=false",
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
export function verifyBlobDetached(filePath: string, sigPath: string, pubKeyPath: string): VerifyResult {
  try {
    const { stdout, stderr } = run("cosign", [
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

/** Read a bundled public key file's bytes back out (used by verify-bundle.ts to sanity-check the file exists and is non-empty before trusting it). */
export async function readPublicKey(pubKeyPath: string): Promise<string> {
  const content = await readFile(pubKeyPath, "utf8");
  if (!content.includes("PUBLIC KEY")) {
    throw new Error(`${pubKeyPath} does not look like a PEM public key`);
  }
  return content;
}
