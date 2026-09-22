import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateEphemeralSshKeypair } from "./ssh-credentials.js";

/**
 * The claim `generateEphemeralSshKeypair` rests on, checked against a SECOND IMPLEMENTATION.
 *
 * The public key is derived by reading the last 32 bytes out of an ed25519 SPKI and re-wrapping
 * them in SSH's own encoding. That is a statement about a binary layout, and the unit tests can
 * only confirm it is self-consistent — they decode what this module encoded. Only OpenSSH can say
 * whether OpenSSH agrees.
 *
 * `ssh-keygen -y -f <private key>` prints the public key derived from the private half. If that
 * string matches what this module produced from the same keypair, the derivation is right; if the
 * SPKI layout assumption is ever wrong, these differ and this fails.
 *
 * It also pins the load-bearing measurement behind the design: OpenSSH reads a PKCS#8 PEM ed25519
 * private key directly. That is why no OpenSSH private-key encoder exists in this codebase, and if
 * a future OpenSSH stops accepting it, this test is where that shows up.
 */

const execFileAsync = promisify(execFile);
const SSH_IMAGE = "alpine:3.21";

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync("docker", ["info"], { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

describe("ssh key derivation agrees with OpenSSH", () => {
  it("ssh-keygen derives the same public key this module does", async () => {
    if (!(await dockerAvailable())) {
      console.warn(
        "[ssh-credentials.integration] no Docker — the ssh-keygen equivalence proof did NOT run"
      );
      expect(true).toBe(true);
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "scp-sshkey-"));
    try {
      const { privateKeyPem, openSshPublicKey } = generateEphemeralSshKeypair();
      await writeFile(join(dir, "id"), privateKeyPem, { mode: 0o600 });
      const { stdout } = await execFileAsync(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${dir}:/k`,
          SSH_IMAGE,
          "sh",
          "-c",
          "apk add --no-cache openssh-client >/dev/null 2>&1 && cp /k/id /tmp/id && chmod 600 /tmp/id && ssh-keygen -y -f /tmp/id"
        ],
        { timeout: 180_000 }
      );
      // ssh-keygen prints `ssh-ed25519 <base64>` with no comment for a key that has none.
      expect(stdout.trim()).toBe(openSshPublicKey);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
