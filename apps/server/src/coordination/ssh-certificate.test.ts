import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signSshCertificate } from "./ssh-certificate.js";
import { generateEphemeralSshKeypair } from "./ssh-credentials.js";
import { FROZEN_CERTIFICATE_VECTOR as VECTOR } from "./ssh-certificate-vectors.js";

/** Decodes an SSH string at `offset`, returning the body and the next offset. */
function readString(buf: Buffer, offset: number): [Buffer, number] {
  const len = buf.readUInt32BE(offset);
  return [buf.subarray(offset + 4, offset + 4 + len), offset + 4 + len];
}

function certBody(certificate: string): Buffer {
  return Buffer.from(certificate.split(" ")[1]!, "base64");
}

describe("signSshCertificate", () => {
  // Both encodings specified so TypeScript resolves the string-returning overload rather than the
  // KeyObject one.
  const ca = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });

  function sign(overrides: Partial<Parameters<typeof signSshCertificate>[0]> = {}) {
    return signSshCertificate({
      openSshPublicKey: generateEphemeralSshKeypair().openSshPublicKey,
      caPrivateKeyPem: ca.privateKey,
      serial: 1n,
      keyId: "run-1",
      principals: ["scp-ops"],
      validAfter: new Date("2026-01-01T00:00:00Z"),
      validBefore: new Date("2026-01-01T00:05:00Z"),
      ...overrides
    });
  }

  it("reproduces a certificate OpenSSH validated, byte for byte", () => {
    // THE CROSS-IMPLEMENTATION CHECK. See the vector file: a real sshd authenticated a session with
    // a certificate from this code path, and `ssh-keygen -L` read every field back.
    const certificate = signSshCertificate({
      openSshPublicKey: VECTOR.userPublicKey,
      caPrivateKeyPem: VECTOR.caPrivateKeyPem,
      serial: 4242n,
      keyId: "scp-run-frozen-vector",
      principals: ["scp-ops"],
      validAfter: new Date("2026-01-01T00:00:00Z"),
      validBefore: new Date("2036-01-01T00:00:00Z"),
      criticalOptions: [["source-address", "10.0.0.0/8"]],
      nonce: Buffer.alloc(32, 7)
    });
    expect(certificate).toBe(VECTOR.cert);
  });

  it("is a user certificate, never a host certificate", () => {
    // ADR-0051 corrects the design docs on exactly this: a compromised USER CA logs in everywhere,
    // a host CA only impersonates. The runner authenticates TO hosts, so type must be 1 (user).
    const buf = certBody(sign());
    let offset = 0;
    [, offset] = readString(buf, offset); // cert algorithm
    [, offset] = readString(buf, offset); // nonce
    [, offset] = readString(buf, offset); // public key
    offset += 8; // serial
    expect(buf.readUInt32BE(offset)).toBe(1);
  });

  it("grants NO extensions by default", () => {
    // `ssh-keygen -s` grants permit-pty, permit-user-rc, agent and port forwarding by default.
    // Ansible's transport execs a command and needs none of it, so this certificate carries none —
    // authority not granted cannot be misused.
    const buf = certBody(sign());
    let offset = 0;
    for (let i = 0; i < 3; i++) [, offset] = readString(buf, offset);
    offset += 8 + 4; // serial + type
    [, offset] = readString(buf, offset); // key id
    [, offset] = readString(buf, offset); // principals
    offset += 16; // validAfter + validBefore
    [, offset] = readString(buf, offset); // critical options
    const [extensions] = readString(buf, offset);
    expect(extensions.length).toBe(0);
  });

  it("refuses a public key that is not ed25519", () => {
    expect(() => sign({ openSshPublicKey: "ssh-rsa AAAAB3Nza" })).toThrow(
      /expected an ssh-ed25519/
    );
  });

  it("randomises the nonce, so two certificates for identical inputs differ", () => {
    // Without this, a re-issue would be byte-identical to the original and indistinguishable in
    // evidence. The frozen vector injects a nonce precisely BECAUSE production does not.
    const args = {
      openSshPublicKey: VECTOR.userPublicKey,
      caPrivateKeyPem: VECTOR.caPrivateKeyPem,
      serial: 7n,
      keyId: "run-7",
      principals: ["scp-ops"],
      validAfter: new Date("2026-01-01T00:00:00Z"),
      validBefore: new Date("2026-01-01T00:05:00Z")
    };
    expect(signSshCertificate(args)).not.toBe(signSshCertificate(args));
  });

  it("orders critical options lexically, as PROTOCOL.certkeys requires", () => {
    // An unordered list is accepted by some implementations and rejected by others — the failure
    // would be a certificate that works in testing and not in the field.
    const certificate = sign({
      criticalOptions: [
        ["source-address", "10.0.0.0/8"],
        ["force-command", "/bin/true"]
      ]
    });
    const buf = certBody(certificate);
    let offset = 0;
    for (let i = 0; i < 3; i++) [, offset] = readString(buf, offset);
    offset += 8 + 4;
    [, offset] = readString(buf, offset);
    [, offset] = readString(buf, offset);
    offset += 16;
    const [options] = readString(buf, offset);
    const [firstName] = readString(options, 0);
    expect(firstName.toString()).toBe("force-command");
  });
});
