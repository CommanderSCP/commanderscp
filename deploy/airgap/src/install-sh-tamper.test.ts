import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeChecksums, formatChecksums } from "./checksums.js";
import { assertPinnedCosignVersion, resolveCosign } from "./cosign-bin.js";
import { signBlobDetached, type SigningKey } from "./cosign.js";
import { CommandError, run, which } from "@scp/cosign";

/** The installer checks its tools before it verifies anything. See docs/airgap.md §38. */
function installShToolingAvailable(): boolean {
  return which("cosign") && which("skopeo") && which("helm");
}

/** A fresh, ephemeral cosign keypair. See docs/airgap.md §39. */
function generateKeypair(scratchDir: string, label: string): SigningKey {
  const prefix = path.join(scratchDir, label);
  const cosign = resolveCosign();
  assertPinnedCosignVersion(cosign);
  run(cosign.bin, ["generate-key-pair", "--output-key-prefix", prefix], {
    env: { COSIGN_PASSWORD: "" },
    log: false
  });
  return { keyPath: `${prefix}.key`, pubKeyPath: `${prefix}.pub`, password: "", isEphemeral: true };
}

/** install.sh's trust-root regression suite. See docs/airgap.md §40. */

const INSTALL_SH = fileURLToPath(new URL("../assets/install.sh", import.meta.url));

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "scp-airgap-install-tamper-"));
}

/** Runs the installer and returns its outcome instead of throwing. See docs/airgap.md §41. */
async function runInstallSh(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv }
): Promise<
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; stdout: string; stderr: string; exitCode: number | null }
> {
  const copiedScript = path.join(opts.cwd, "install.sh");
  await copyFile(INSTALL_SH, copiedScript);
  try {
    const result = run("bash", [copiedScript, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      log: false
    });
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof CommandError) {
      return { ok: false, stdout: err.stdout, stderr: err.stderr, exitCode: err.exitCode };
    }
    throw err;
  }
}

describe("install.sh: refuses to run without an EXTERNAL pubkey (no in-bundle fallback)", () => {
  it("exits non-zero and never reaches cosign/skopeo when neither --pubkey nor SCP_COSIGN_PUBKEY is set", async () => {
    // Deliberately an EMPTY directory — if this check were ever removed/bypassed, the next thing
    // that would fail is "CHECKSUMS.txt missing", a completely different error. The FIRST thing
    // install.sh must ever say, with zero bundle contents at all, is "no external public key".
    const dir = await makeTempDir();
    try {
      const result = await runInstallSh(
        ["--registry", "example.com/scp", "--mode", "compose", "--dry-run"],
        {
          cwd: dir,
          // Strip SCP_COSIGN_PUBKEY in case the ambient test environment happens to have it set.
          env: { ...process.env, SCP_COSIGN_PUBKEY: "" }
        }
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.stderr).toMatch(/no external public key supplied/i);
      expect(result.stderr).toMatch(/never the cosign\.pub shipped inside/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!installShToolingAvailable())(
  "install.sh: a bundle re-signed with a DIFFERENT keypair is REJECTED (the CRITICAL #1 tamper scenario)",
  () => {
    it("CHECKSUMS.txt genuinely signed by the LEGIT key verifies against --pubkey <legit key> (positive control)", async () => {
      const dir = await makeTempDir();
      const scratch = await makeTempDir();
      try {
        await writeFile(path.join(dir, "payload.txt"), "the real bundle content", "utf8");
        const entries = await computeChecksums(dir);
        await writeFile(path.join(dir, "CHECKSUMS.txt"), formatChecksums(entries), "utf8");

        const legitKey = generateKeypair(scratch, "legit");
        signBlobDetached(
          path.join(dir, "CHECKSUMS.txt"),
          path.join(dir, "CHECKSUMS.txt.sig"),
          legitKey
        );

        const result = await runInstallSh(
          [
            "--registry",
            "example.com/scp",
            "--pubkey",
            legitKey.pubKeyPath,
            "--mode",
            "helm",
            "--dry-run"
          ],
          { cwd: dir }
        );
        // Gets PAST the CHECKSUMS.txt signature gate (the thing this suite is about) — it then
        // fails LATER, on the next fail-closed check ("manifest.sh missing"), because this fixture
        // is a minimal bundle with no images/manifest.sh. That later failure is expected and
        // PROVES the run reached past signature verification rather than never running it.
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.stderr).not.toMatch(/signature does not verify/i);
        expect(result.stderr).toMatch(/manifest\.sh missing/i);
      } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(scratch, { recursive: true, force: true });
      }
    }, 30_000);

    it("CHECKSUMS.txt re-signed by an ATTACKER'S key is REJECTED when verified against the REAL external --pubkey", async () => {
      const dir = await makeTempDir();
      const scratch = await makeTempDir();
      try {
        // The "original, legitimately-signed bundle" — an operator would have obtained
        // legitKey.pubKeyPath out-of-band (e.g. the project's release page).
        await writeFile(path.join(dir, "payload.txt"), "the real bundle content", "utf8");
        const legitKey = generateKeypair(scratch, "legit");

        // THE ATTACK (adversarial review's exact scenario). See docs/airgap.md §42.
        await writeFile(path.join(dir, "payload.txt"), "ATTACKER-SUBSTITUTED content", "utf8");
        const tamperedEntries = await computeChecksums(dir);
        await writeFile(path.join(dir, "CHECKSUMS.txt"), formatChecksums(tamperedEntries), "utf8");
        const attackerKey = generateKeypair(scratch, "attacker");
        signBlobDetached(
          path.join(dir, "CHECKSUMS.txt"),
          path.join(dir, "CHECKSUMS.txt.sig"),
          attackerKey
        );

        // The honest operator runs install.sh with THEIR OWN, out-of-band-obtained pubkey — the
        // legit one, which the attacker's re-signed bundle does NOT match.
        const result = await runInstallSh(
          [
            "--registry",
            "example.com/scp",
            "--pubkey",
            legitKey.pubKeyPath,
            "--mode",
            "helm",
            "--dry-run"
          ],
          { cwd: dir }
        );
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.stderr).toMatch(/CHECKSUMS\.txt signature does not verify against --pubkey/i);
        expect(result.stderr).toMatch(/not authentic or has been tampered with/i);
      } finally {
        await rm(dir, { recursive: true, force: true });
        await rm(scratch, { recursive: true, force: true });
      }
    }, 30_000);
  }
);
