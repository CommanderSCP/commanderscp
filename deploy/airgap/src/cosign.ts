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
 * ## The air-gap-critical flag combination (portable across a range of cosign versions)
 *
 * `cosign sign-blob` defaults to uploading every signature to the **public** Rekor transparency
 * log (`https://rekor.sigstore.dev`) even for pure local-keypair signing — confirmed by pointing
 * HTTP(S)_PROXY at a closed port and watching `sign-blob` fail with `Post
 * "https://rekor.sigstore.dev/api/v1/log/entries": ... connection refused`. That is a hard
 * violation of CLAUDE.md principle #5 ("no runtime network calls to the outside world") and of
 * this milestone's own "NO runtime network calls" requirement — bundle building must never depend
 * on reaching the public internet, let alone leak a customer's private image digests to a public
 * transparency log.
 *
 * The essential, long-stable fix is **`--tlog-upload=false`** — the flag that disables the Rekor
 * upload. It is present (deprecated but honored) across cosign 2.x and 3.x and is the ONE flag
 * that actually prevents the egress. Alongside it we pass `--new-bundle-format=false
 * --output-signature <file> --yes` to get the legacy detached-signature file this package stores
 * in the bundle (the format `verifyBlobDetached` and install.sh's `cosign verify-blob --signature`
 * both consume).
 *
 * `--use-signing-config=false` is **version-conditional** (see signBlobFlags() below), because
 * its handling differs sharply across cosign versions and this is an air-gap product where
 * operators may bring their OWN cosign:
 *   - NEWER cosign (advertises `--use-signing-config`, ~2.5+/3.x — e.g. the v3.1.1 dev build this
 *     was authored against): `--use-signing-config` DEFAULTS to `true`, and cosign then REJECTS
 *     `--tlog-upload=false` with "`--tlog-upload=false is not supported with --signing-config or
 *     --use-signing-config`". So on these builds we MUST also pass `--use-signing-config=false`.
 *   - OLDER cosign (does NOT have the flag — e.g. the v2.x that `sigstore/cosign-installer@v3`
 *     installs by default in CI): passing `--use-signing-config=false` fails with "`unknown flag:
 *     --use-signing-config`" (exactly the CI red this replaced), and it isn't needed anyway —
 *     `--tlog-upload=false` alone prevents the upload. So we OMIT it there.
 * We detect the flag from `cosign sign-blob --help` (it's listed on versions that have it) and add
 * `--use-signing-config=false` only when present. This keeps signing working across a range of
 * cosign versions — no fixed version pin required — while STILL uploading nothing.
 *
 * `verifyBlobDetached` mirrors the sign side with `--insecure-ignore-tlog=true` (a stable flag
 * present across versions) — we deliberately never wrote a tlog entry, so asking cosign to check
 * for one would always — correctly, but uselessly — fail.
 *
 * Egress verified against a closed proxy on cosign v3.1.1: with the full flag set, `sign-blob`
 * succeeds behind `HTTPS_PROXY=http://127.0.0.1:1` and the sig verifies — zero outbound connection
 * attempts. If cosign's flags change again, re-run exactly that: set `HTTPS_PROXY=http://127.0.0.1:1`
 * (a closed local port) and confirm sign/verify still succeed; if either ever tries the network it
 * fails fast with `connection refused` instead of silently working. CI deliberately does NOT pin a
 * cosign release (see .github/workflows/ci.yml) — `sigstore/cosign-installer@v3`'s default install
 * is what reliably downloads, and this adaptive flag logic (not a brittle version pin) carries the
 * portability. Air-gap operators can bring any cosign in the supported range.
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
 * Whether the installed cosign advertises `--use-signing-config` (a newer flag, ~cosign 2.5+/3.x).
 * Probed once from `cosign sign-blob --help` (the flag is listed there on versions that have it)
 * and cached for the rest of the process. See the module doc comment for why this matters and
 * signBlobFlags() for how it's used.
 */
let cachedUseSigningConfigSupported: boolean | undefined;

function cosignSupportsUseSigningConfig(): boolean {
  if (cachedUseSigningConfigSupported === undefined) {
    try {
      const { stdout, stderr } = run("cosign", ["sign-blob", "--help"], { log: false });
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
function signBlobFlags(): string[] {
  const flags = ["--tlog-upload=false", "--new-bundle-format=false"];
  if (cosignSupportsUseSigningConfig()) flags.push("--use-signing-config=false");
  return flags;
}

/**
 * `cosign sign-blob` producing a detached, legacy-format signature file — see the module doc
 * comment above for why these exact flags and why they're required for air-gap correctness.
 */
export function signBlobDetached(filePath: string, sigOutPath: string, key: SigningKey): void {
  run(
    "cosign",
    ["sign-blob", "--key", key.keyPath, ...signBlobFlags(), "--output-signature", sigOutPath, "--yes", filePath],
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
