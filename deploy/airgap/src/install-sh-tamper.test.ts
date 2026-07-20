import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeChecksums, formatChecksums } from "./checksums.js";
import { assertPinnedCosignVersion, resolveCosign } from "./cosign-bin.js";
import { signBlobDetached, type SigningKey } from "./cosign.js";
import { CommandError, run, which } from "./exec.js";

/**
 * install.sh checks for `skopeo`/`cosign`/(`helm`|`docker`) on PATH unconditionally, even under
 * `--dry-run` — before it ever verifies a signature. Gating on all three (like
 * `scripts/airgap-drill.sh`/`deploy-drills.yml` already do for the same reason) means this suite
 * exercises the REAL script wherever these documented prerequisites (BUILD_AND_TEST.md §1) are
 * installed, and skips cleanly — never a false failure — where they aren't.
 *
 * `which("cosign")` is checked DIRECTLY and deliberately, not via the pinned resolution in
 * cosign-bin.ts: install.sh's whole trust model is that the operator supplies cosign
 * EXTERNALLY, on PATH. A cosign that exists only at the vendored in-image path would not
 * satisfy install.sh, so it must not un-skip this suite either. (CI does put the pinned binary
 * on PATH — scripts/install-pinned-cosign.sh — so these assertions really run there.)
 */
function installShToolingAvailable(): boolean {
  return which("cosign") && which("skopeo") && which("helm");
}

/**
 * A fresh, ephemeral cosign keypair — deliberately NOT `resolveSigningKey` from `./cosign.js`,
 * which honors an ambient `COSIGN_KEY` env var: if that happened to be set in the environment
 * this suite runs in, two calls would resolve to the SAME real key, silently defeating the
 * "legit key vs. attacker key are DIFFERENT keys" premise this suite depends on. This always
 * generates a brand-new keypair, independent of any ambient cosign env var.
 */
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

/**
 * install.sh's trust-root regression suite (adversarial review of PR #15, CRITICAL #1): a
 * previous version of `install.sh` cosign-verified everything against the `cosign.pub` file
 * SHIPPED INSIDE the bundle it was verifying — self-referential, so an attacker who substitutes
 * the whole bundle can simply re-sign everything with their own key and ship their own matching
 * `cosign.pub` alongside it; `install.sh` would verify cleanly. `deploy/airgap/src/verify-bundle.ts`
 * already required an external `--pubkey` with no in-bundle fallback (see its own module doc);
 * this suite proves `install.sh` (the bash script, exercised as a real subprocess — not just the
 * TypeScript verifier) now has the same property.
 *
 * This is genuinely exercising the install.sh SCRIPT (spawned as `bash install.sh ...`), not a
 * reimplementation of its logic — the exact class of gap a purely-TypeScript test suite could
 * miss (README.md's own "Testing" section, before this fix, said the install.sh mechanics were
 * "exercised manually end-to-end", never as a permanent automated regression test).
 */

const INSTALL_SH = fileURLToPath(new URL("../assets/install.sh", import.meta.url));

async function makeTempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "scp-airgap-install-tamper-"));
}

/**
 * Runs install.sh and returns {ok, stdout, stderr, exitCode} instead of throwing, whichever way
 * it exits. install.sh `cd`s to ITS OWN location before doing anything (`SCRIPT_DIR="$(cd
 * "$(dirname "${BASH_SOURCE[0]}")" && pwd)"` — see its header comment: real usage always runs it
 * FROM INSIDE an extracted bundle directory, e.g. `./scp-bundle-<version>/install.sh`), so this
 * copies the real script INTO the fixture bundle dir first — running it from its source location
 * in this repo would have it look for CHECKSUMS.txt etc. next to the SOURCE file, not the fixture.
 */
async function runInstallSh(
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv }
): Promise<
  { ok: true; stdout: string; stderr: string } | { ok: false; stdout: string; stderr: string; exitCode: number | null }
> {
  const copiedScript = path.join(opts.cwd, "install.sh");
  await copyFile(INSTALL_SH, copiedScript);
  try {
    const result = run("bash", [copiedScript, ...args], { cwd: opts.cwd, env: opts.env, log: false });
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
      const result = await runInstallSh(["--registry", "example.com/scp", "--mode", "compose", "--dry-run"], {
        cwd: dir,
        // Strip SCP_COSIGN_PUBKEY in case the ambient test environment happens to have it set.
        env: { ...process.env, SCP_COSIGN_PUBKEY: "" }
      });
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
          ["--registry", "example.com/scp", "--pubkey", legitKey.pubKeyPath, "--mode", "helm", "--dry-run"],
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

        // THE ATTACK (adversarial review's exact scenario): substitute the whole bundle —
        // tamper with the payload, generate a BRAND NEW keypair the attacker controls, and
        // re-sign the (now-tampered) CHECKSUMS.txt with it. Pre-fix, install.sh would have
        // trusted whatever `cosign.pub` the attacker also shipped inside the bundle — this test
        // never even writes an in-bundle cosign.pub, because the fix means it must never be read.
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
          ["--registry", "example.com/scp", "--pubkey", legitKey.pubKeyPath, "--mode", "helm", "--dry-run"],
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
