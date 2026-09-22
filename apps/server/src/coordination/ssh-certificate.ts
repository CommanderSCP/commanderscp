import { createPrivateKey, createPublicKey, randomBytes, sign as cryptoSign } from "node:crypto";
import { openSshPublicKey } from "./ssh-credentials.js";

/**
 * OpenSSH certificate signing — the minting half of ADR-0051's SCP-CA fallback (M27.5).
 *
 * Implemented here rather than by shelling out to `ssh-keygen -s`, because the server image
 * carries no OpenSSH client and adding one would put a binary on the critical path of a security
 * control. The format is PROTOCOL.certkeys from the OpenSSH source; the encoding is small and the
 * frozen vectors in `ssh-certificate-vectors.ts` check it against real ssh-keygen output.
 *
 * WHAT THIS DELIBERATELY DOES NOT GRANT. Extensions are EMPTY by default — no `permit-pty`, no
 * agent or port forwarding, no X11, no user-rc. Ansible's default transport execs a command and
 * does not need a pty, so the permissive set every `ssh-keygen -s` invocation grants by default is
 * authority this certificate has no use for. `source-address` is available as a critical option so
 * a certificate can additionally be bound to the runner's own address.
 */

const CERT_TYPE_USER = 1;
const ALGORITHM = "ssh-ed25519";
const CERT_ALGORITHM = "ssh-ed25519-cert-v01@openssh.com";

function sshString(bytes: Buffer | string): Buffer {
  const body = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}

function sshUint32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value, 0);
  return b;
}

function sshUint64(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(value, 0);
  return b;
}

/** A list of SSH strings, itself wrapped as one string — the shape `valid principals` uses. */
function sshStringList(values: string[]): Buffer {
  return sshString(Buffer.concat(values.map((v) => sshString(v))));
}

/** Critical options and extensions are name→data pairs, each datum itself a wrapped string. */
function sshOptions(entries: [string, string][]): Buffer {
  return sshString(
    Buffer.concat(
      // "must be lexically ordered by name" (PROTOCOL.certkeys). Sorted here rather than trusting
      // the caller, because an unordered list is accepted by some implementations and rejected by
      // others — the failure would be a certificate that works in testing and not in the field.
      [...entries]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, data]) =>
          Buffer.concat([
            sshString(name),
            sshString(data === "" ? Buffer.alloc(0) : sshString(data))
          ])
        )
    )
  );
}

export interface SignSshCertificateInput {
  /** The user public key to certify, in `ssh-ed25519 AAAA...` form. */
  openSshPublicKey: string;
  /** The CA's PKCS#8 PEM private key. */
  caPrivateKeyPem: string;
  /** Recorded in the certificate AND in the audit log at issuance (ADR-0051 D5), so a certificate
   *  a host accepted that SCP never issued is detectable. */
  serial: bigint;
  /** Free-form identity shown by `ssh-keygen -L` and logged by sshd — the run this belongs to. */
  keyId: string;
  principals: string[];
  validAfter: Date;
  validBefore: Date;
  /** `source-address` binds the certificate to the addresses it may be used FROM. */
  criticalOptions?: [string, string][];
  /** Empty by default, and that is the point — see the module comment. */
  extensions?: [string, string][];
  /** Injectable ONLY so the frozen vectors can be deterministic; production always randomises. A
   *  fixed nonce in real issuance would make two certificates for the same inputs identical. */
  nonce?: Buffer;
}

/** The signed certificate, in the `ssh-ed25519-cert-v01@openssh.com AAAA...` form sshd expects. */
export function signSshCertificate(input: SignSshCertificateInput): string {
  const [algorithm, base64Key] = input.openSshPublicKey.trim().split(/\s+/);
  if (algorithm !== ALGORITHM || !base64Key) {
    throw new Error(`ssh-certificate: expected an ${ALGORITHM} public key`);
  }
  const userBlob = Buffer.from(base64Key, "base64");
  // The user's raw key sits after two SSH strings: the algorithm name and the key itself.
  const algLen = userBlob.readUInt32BE(0);
  const keyLen = userBlob.readUInt32BE(4 + algLen);
  const userRaw = userBlob.subarray(8 + algLen, 8 + algLen + keyLen);
  if (userRaw.length !== 32) {
    throw new Error("ssh-certificate: malformed ed25519 public key");
  }

  const caPrivate = createPrivateKey(input.caPrivateKeyPem);
  // The CA's own key, as it appears inside the certificate's `signature key` field.
  const caPublicBlob = Buffer.from(
    openSshPublicKey(createPublicKey(caPrivate)).split(" ")[1]!,
    "base64"
  );

  const body = Buffer.concat([
    sshString(input.nonce ?? randomBytes(32)),
    sshString(userRaw),
    sshUint64(input.serial),
    sshUint32(CERT_TYPE_USER),
    sshString(input.keyId),
    sshStringList(input.principals),
    sshUint64(BigInt(Math.floor(input.validAfter.getTime() / 1000))),
    sshUint64(BigInt(Math.floor(input.validBefore.getTime() / 1000))),
    sshOptions(input.criticalOptions ?? []),
    sshOptions(input.extensions ?? []),
    sshString(Buffer.alloc(0)), // reserved, always empty
    sshString(caPublicBlob)
  ]);

  // Everything signed is the certificate algorithm name followed by the body — the same bytes a
  // verifier reconstructs, which is why the signature is appended rather than woven in.
  const signedBytes = Buffer.concat([sshString(CERT_ALGORITHM), body]);
  const signature = cryptoSign(null, signedBytes, caPrivate);
  const signatureBlob = sshString(Buffer.concat([sshString(ALGORITHM), sshString(signature)]));

  const certificate = Buffer.concat([sshString(CERT_ALGORITHM), body, signatureBlob]);
  return `${CERT_ALGORITHM} ${certificate.toString("base64")}`;
}
