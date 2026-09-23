import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { VaultSshAuthority, generateEphemeralSshKeypair } from "./ssh-credentials.js";

/**
 * M27.4's DoD — a run against a REAL Vault SSH secrets engine (ADR-0051 D1).
 *
 * WHY THIS EXISTS WHEN UNIT TESTS ALREADY COVER THE CLIENT. Those inject `fetch`, so they prove we
 * send what we think we send — and nothing about whether Vault accepts it, whether the role policy
 * shape is right, or whether what comes back is a usable certificate. The BYO path is ADR-0051's
 * DOCUMENTED DEFAULT, so it earns the stronger proof: on this path SCP holds no signing key at all,
 * and that claim is only worth anything if the path actually works.
 *
 * The image is mirrored into GHCR (tools/ci-mirror/images.list) because CI blackholes egress —
 * "tests never touch the internet", charter principle 5.
 */

const VAULT_IMAGE = "hashicorp/vault:1.20";
const ROOT_TOKEN = "root-test-token";
const MOUNT = "ssh-client-signer";
const ROLE = "scp-ops";

describe("VaultSshAuthority against a real Vault (Testcontainers)", () => {
  let vault: StartedTestContainer;
  let baseUrl: string;

  async function vaultApi(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/v1/${path}`, {
      method: "POST",
      headers: { "X-Vault-Token": ROOT_TOKEN, "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  beforeAll(async () => {
    vault = await new GenericContainer(VAULT_IMAGE)
      // Dev mode: in-memory, unsealed, one known root token. Appropriate here precisely because the
      // subject under test is SCP's REQUEST, not Vault's storage or seal behaviour.
      .withEnvironment({
        VAULT_DEV_ROOT_TOKEN_ID: ROOT_TOKEN,
        VAULT_DEV_LISTEN_ADDRESS: "0.0.0.0:8200"
      })
      .withExposedPorts(8200)
      .start();
    baseUrl = `http://${vault.getHost()}:${vault.getMappedPort(8200)}`;

    // The operator-side setup an organization would already have done. SCP performs NONE of this —
    // it never creates the mount, the CA or the role, which is the whole point of the BYO path.
    expect((await vaultApi(`sys/mounts/${MOUNT}`, { type: "ssh" })).ok).toBe(true);
    expect((await vaultApi(`${MOUNT}/config/ca`, { generate_signing_key: true })).ok).toBe(true);
    const role = await vaultApi(`${MOUNT}/roles/${ROLE}`, {
      key_type: "ca",
      allow_user_certificates: true,
      allowed_users: "scp-ops",
      // Deliberately NO default_extensions: the certificate should grant no pty, no agent
      // forwarding, no user-rc — the same posture ssh-certificate.ts takes on the SCP-CA path.
      default_extensions: {},
      ttl: "5m",
      max_ttl: "10m"
    });
    expect(role.ok).toBe(true);
  }, 300_000);

  afterAll(async () => {
    await vault?.stop();
  });

  function authority() {
    return new VaultSshAuthority({
      baseUrl,
      mountPath: MOUNT,
      role: ROLE,
      token: ROOT_TOKEN
    });
  }

  it("obtains a real, usable certificate for a per-run ephemeral keypair", async () => {
    const keypair = generateEphemeralSshKeypair();
    const issued = await authority().issue({
      openSshPublicKey: keypair.openSshPublicKey,
      principals: ["scp-ops"],
      validForSeconds: 300,
      targetHosts: ["10.0.0.7"]
    });

    // A CERTIFICATE, not an echo of the public key — the distinction a fake `fetch` cannot make.
    expect(issued.certificate).toContain("ssh-ed25519-cert-v01@openssh.com");
    expect(issued.certificate).not.toBe(keypair.openSshPublicKey);
    expect(issued.authority).toBe("vault-ssh");
    // Every issuance is recordable (ADR-0051 D5), whether or not Vault returned a serial.
    expect(issued.serial.length).toBeGreaterThan(0);
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
  }, 120_000);

  it("SURFACES VAULT'S OWN REFUSAL when the role forbids the principal", async () => {
    // The point of delegating: the organization's policy stays the organization's, and SCP reports
    // the refusal rather than working around it. `allowed_users` is `scp-ops` only.
    await expect(
      authority().issue({
        openSshPublicKey: generateEphemeralSshKeypair().openSshPublicKey,
        principals: ["root"],
        validForSeconds: 300,
        targetHosts: ["10.0.0.7"]
      })
    ).rejects.toThrow(/vault-ssh: certificate request refused/);
  }, 120_000);

  it("refuses a bad token rather than proceeding without a credential", async () => {
    const bad = new VaultSshAuthority({
      baseUrl,
      mountPath: MOUNT,
      role: ROLE,
      token: "not-a-real-token"
    });
    await expect(
      bad.issue({
        openSshPublicKey: generateEphemeralSshKeypair().openSshPublicKey,
        principals: ["scp-ops"],
        validForSeconds: 300,
        targetHosts: ["10.0.0.7"]
      })
    ).rejects.toThrow(/refused/);
  }, 120_000);

  it("SCP holds no signing key on this path — asserted by its absence", async () => {
    // ADR-0051 D1's actual claim, and what makes BYO stronger than the D3 fallback: compromising
    // SCP's database yields nothing that can log in, because the signing key never leaves Vault.
    const issued = await authority().issue({
      openSshPublicKey: generateEphemeralSshKeypair().openSshPublicKey,
      principals: ["scp-ops"],
      validForSeconds: 300,
      targetHosts: ["10.0.0.7"]
    });
    expect(JSON.stringify(issued)).not.toContain("BEGIN");
    expect(JSON.stringify(issued)).not.toContain("PRIVATE");
  }, 120_000);
});
