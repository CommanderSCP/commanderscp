import { describe, expect, it } from "vitest";
import vectors from "./ssh-keygen-vectors.json" with { type: "json" };
import {
  VaultSshAuthority,
  generateEphemeralSshKeypair,
  openSshPublicKeyFromPrivatePem,
  type SshCertificateRequest
} from "./ssh-credentials.js";

const REQUEST: SshCertificateRequest = {
  openSshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaceholder",
  principals: ["scp-ops"],
  validForSeconds: 300,
  targetHosts: ["10.0.0.7"]
};

describe("generateEphemeralSshKeypair", () => {
  it("emits a PKCS#8 PEM private key and an ssh-ed25519 public key", () => {
    const { privateKeyPem, openSshPublicKey } = generateEphemeralSshKeypair();
    expect(privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(openSshPublicKey.startsWith("ssh-ed25519 ")).toBe(true);
  });

  it("encodes the public key as a well-formed SSH blob", () => {
    // Decoded structurally rather than compared to a golden string: the algorithm name appears
    // INSIDE the base64 blob as a length-prefixed SSH string, and a blob that merely starts with
    // the right prefix can still be malformed past it.
    const { openSshPublicKey } = generateEphemeralSshKeypair();
    const blob = Buffer.from(openSshPublicKey.split(" ")[1]!, "base64");
    const algLen = blob.readUInt32BE(0);
    expect(blob.subarray(4, 4 + algLen).toString()).toBe("ssh-ed25519");
    const keyLen = blob.readUInt32BE(4 + algLen);
    expect(keyLen).toBe(32); // ed25519 public keys are exactly 32 bytes
    expect(blob.length).toBe(4 + algLen + 4 + keyLen);
  });

  it("never repeats a key", () => {
    const a = generateEphemeralSshKeypair();
    const b = generateEphemeralSshKeypair();
    expect(a.openSshPublicKey).not.toBe(b.openSshPublicKey);
    expect(a.privateKeyPem).not.toBe(b.privateKeyPem);
  });
});

describe("the public-key derivation agrees with OpenSSH", () => {
  /**
   * THE CLAIM THIS MODULE RESTS ON, checked against a SECOND IMPLEMENTATION.
   *
   * The public key is derived by reading the last 32 bytes out of an ed25519 SPKI and re-wrapping
   * them in SSH's encoding. That is an assertion about a binary layout, and the tests above can
   * only show it is SELF-consistent — they decode what this module encoded. Only OpenSSH can say
   * whether OpenSSH agrees.
   *
   * `ssh-keygen-vectors.json` holds real `ssh-keygen -y` output for three PKCS#8 PEM keys. The
   * fixture is FROZEN rather than generated at test time on purpose: an earlier version ran
   * `ssh-keygen` in a container, which needed `apk add openssh-client` and therefore the internet
   * — and CI blackholes egress ("tests never touch the internet"), so it failed there while
   * passing locally. Recording OpenSSH's answer once keeps the cross-check and costs no network.
   *
   * These vectors also pin the measurement the whole design depends on: OpenSSH reads a PKCS#8 PEM
   * ed25519 private key directly, which is why this codebase has no OpenSSH private-key encoder.
   */
  it.each(vectors.map((v, i) => [i, v] as const))(
    "vector %i: derives exactly what ssh-keygen -y printed",
    (_i, vector) => {
      // Calls the MODULE, not a copy of its algorithm — so a change to the derivation fails here.
      expect(openSshPublicKeyFromPrivatePem(vector.privateKeyPem)).toBe(vector.sshKeygenPublicKey);
    }
  );
});

describe("VaultSshAuthority", () => {
  function authority(handler: typeof fetch) {
    return new VaultSshAuthority({
      baseUrl: "https://vault.internal:8200/",
      mountPath: "ssh-client-signer",
      role: "scp-ops",
      token: "s.token",
      fetchImpl: handler
    });
  }

  it("signs against the mount and role, and carries the request Vault needs", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    let seenToken = "";
    const issued = await authority((async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init.body));
      seenToken = (init.headers as Record<string, string>)["X-Vault-Token"]!;
      return new Response(
        JSON.stringify({ data: { signed_key: "ssh-ed25519-cert...", serial_number: "42" } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch).issue(REQUEST);

    // The trailing slash on baseUrl must not produce a double slash — a real Vault 404s on it.
    expect(seenUrl).toBe("https://vault.internal:8200/v1/ssh-client-signer/sign/scp-ops");
    expect(seenToken).toBe("s.token");
    expect(seenBody["public_key"]).toBe(REQUEST.openSshPublicKey);
    expect(seenBody["valid_principals"]).toBe("scp-ops");
    expect(seenBody["ttl"]).toBe("300s");
    // A HOST certificate would let SCP impersonate hosts; the runner authenticates TO hosts, so
    // this must always be a user certificate (ADR-0051 corrects the docs on exactly this point).
    expect(seenBody["cert_type"]).toBe("user");
    expect(issued.certificate).toBe("ssh-ed25519-cert...");
    expect(issued.serial).toBe("42");
    expect(issued.authority).toBe("vault-ssh");
  });

  it("generates a serial when Vault returns none, so issuance is always recordable", async () => {
    const issued = await authority(
      (async () =>
        new Response(JSON.stringify({ data: { signed_key: "cert" } }), {
          status: 200
        })) as unknown as typeof fetch
    ).issue(REQUEST);
    // ADR-0051 D5's reconciliation needs an identifier for EVERY issuance; without one, a
    // certificate with no matching record would be indistinguishable from a forgery.
    expect(issued.serial.startsWith("scp-local:")).toBe(true);
  });

  it("expiry is derived from the requested TTL", async () => {
    const before = Date.now();
    const issued = await authority(
      (async () =>
        new Response(JSON.stringify({ data: { signed_key: "cert" } }), {
          status: 200
        })) as unknown as typeof fetch
    ).issue(REQUEST);
    expect(issued.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 300_000);
    expect(issued.expiresAt.getTime()).toBeLessThan(before + 300_000 + 5_000);
  });

  it("surfaces Vault's own refusal, with its reason", async () => {
    await expect(
      authority(
        (async () =>
          new Response('{"errors":["role scp-ops does not allow principal root"]}', {
            status: 400
          })) as unknown as typeof fetch
      ).issue(REQUEST)
    ).rejects.toThrow(/does not allow principal root/);
  });

  it("refuses a 200 that carries no signed_key rather than returning an empty certificate", async () => {
    // A truthy-but-empty response would otherwise flow onward and fail at ssh time, far from here.
    await expect(
      authority((async () => new Response("{}", { status: 200 })) as unknown as typeof fetch).issue(
        REQUEST
      )
    ).rejects.toThrow(/no signed_key/);
  });
});
