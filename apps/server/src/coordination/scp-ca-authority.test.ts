import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ScpCaAuthority } from "./scp-ca-authority.js";
import { generateEphemeralSshKeypair } from "./ssh-credentials.js";
import type { TrustDomainId } from "@scp/schemas";

const ca = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});

function authority(sourceAddress?: string) {
  return new ScpCaAuthority({
    domainId: "11111111-1111-4111-8111-111111111111" as TrustDomainId,
    authorityId: "22222222-2222-4222-8222-222222222222",
    caPrivateKeyPem: ca.privateKey,
    sourceAddress
  });
}

const request = {
  openSshPublicKey: generateEphemeralSshKeypair().openSshPublicKey,
  principals: ["scp-ops"],
  validForSeconds: 300,
  targetHosts: ["10.0.0.7"]
};

describe("ScpCaAuthority", () => {
  it("issues a certificate that names the requested principals and expires when asked", async () => {
    const before = Date.now();
    const issued = await authority().issue(request);
    expect(issued.authority).toBe("scp-ca");
    expect(issued.certificate.startsWith("ssh-ed25519-cert-v01@openssh.com ")).toBe(true);
    expect(issued.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 300_000);
    expect(issued.expiresAt.getTime()).toBeLessThan(before + 300_000 + 5_000);
  });

  it("never repeats a serial, and never issues a sequential one", async () => {
    // Sequential serials leak issuance volume, and — worse for ADR-0051 D5 — let a forger choose a
    // plausible unused value. Two issuances differing is a weak check on its own, so this also
    // asserts they are not adjacent, which a counter would make them.
    const a = await authority().issue(request);
    const b = await authority().issue(request);
    expect(a.serial).not.toBe(b.serial);
    const delta = BigInt(a.serial) - BigInt(b.serial);
    expect(delta === 1n || delta === -1n).toBe(false);
  });

  it("stays inside the signed 64-bit range", async () => {
    // The certificate field is uint64; a value with the top bit set would still encode, but
    // round-tripping it through anything that reads it as signed (including `BigInt` consumers in
    // evidence tooling) would report a negative serial.
    for (let i = 0; i < 25; i++) {
      const { serial } = await authority().issue(request);
      expect(BigInt(serial)).toBeGreaterThanOrEqual(0n);
      expect(BigInt(serial)).toBeLessThanOrEqual(0x7fff_ffff_ffff_ffffn);
    }
  });

  it("binds the certificate to a source address when the caller supplies one", async () => {
    const withAddress = await authority("10.0.0.0/8").issue(request);
    const without = await authority().issue(request);
    // Decoded rather than string-matched: `source-address` appears inside the base64 certificate
    // body, and a substring check on the whole blob would also pass if it landed in the key id.
    const body = Buffer.from(withAddress.certificate.split(" ")[1]!, "base64");
    expect(body.includes(Buffer.from("source-address"))).toBe(true);
    const plain = Buffer.from(without.certificate.split(" ")[1]!, "base64");
    expect(plain.includes(Buffer.from("source-address"))).toBe(false);
  });

  it("carries the run's principals in the key id, which is what sshd logs", async () => {
    const issued = await authority().issue(request);
    const body = Buffer.from(issued.certificate.split(" ")[1]!, "base64");
    expect(body.includes(Buffer.from("scp-ops"))).toBe(true);
    expect(body.includes(Buffer.from(issued.serial))).toBe(true);
  });
});
