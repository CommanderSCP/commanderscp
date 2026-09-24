import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  type KeyObject
} from "node:crypto";

/**
 * M27.4 — SSH credentials for `scp-runner-ops`, requested from an existing authority.
 *
 * ADR-0051 D1: SCP asks an authority the organization already runs (Vault's SSH secrets engine,
 * Teleport, an org CA) for a short-lived certificate per run, and only mints its own where no such
 * authority exists. This module is the REQUESTING half, and ADR-0051 says to build it first —
 * "a fallback built first tends to become the default by inertia".
 *
 * THE KEYPAIR IS EPHEMERAL AND PER-RUN. SCP generates it, has the public half signed, hands both
 * to the single-shot runner, and never persists either. On this path SCP therefore holds no
 * standing credential to any host: compromising the database yields nothing that can log in, which
 * is the property that makes BYO strictly stronger than D3's software-key fallback.
 */

/** An ephemeral keypair, in the two encodings the rest of the flow needs. */
export interface EphemeralSshKeypair {
  /** PKCS#8 PEM. OpenSSH reads this directly for ed25519 — measured with `ssh-keygen -y`, which is
   *  why no OpenSSH private-key encoder exists here. */
  privateKeyPem: string;
  /** `ssh-ed25519 AAAA...` — the form every CA signing endpoint expects. */
  openSshPublicKey: string;
}

/** An SSH wire string: 4-byte big-endian length, then the bytes. */
function sshString(bytes: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

/**
 * ed25519, because the certificate is alive for minutes and the key never leaves the run.
 *
 * The OpenSSH public key is derived from the SPKI DER rather than by shelling out to `ssh-keygen`:
 * the server image carries no OpenSSH client, and adding one to mint a string this short would be
 * a dependency for nothing. An ed25519 SPKI is a fixed-shape 44-byte structure whose last 32 bytes
 * are the raw key — `ssh-keygen-equivalence.test.ts` proves the derivation against real ssh-keygen
 * output rather than trusting that sentence.
 */
export function generateEphemeralSshKeypair(): EphemeralSshKeypair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    openSshPublicKey: openSshPublicKey(publicKey)
  };
}

/** The `ssh-ed25519 AAAA...` form of an ed25519 public key.
 *
 *  Exported so the ssh-keygen equivalence vectors exercise THIS code rather than a copy of it. A
 *  test that re-implements the derivation inline proves the algorithm and nothing about the
 *  module — mutating the module would leave it green. */
export function openSshPublicKey(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(spki.length - 32);
  const blob = Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(raw)]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}

/** The OpenSSH public key that corresponds to a PKCS#8 PEM private key — the same derivation
 *  `ssh-keygen -y` performs. */
export function openSshPublicKeyFromPrivatePem(privateKeyPem: string): string {
  return openSshPublicKey(createPublicKey(createPrivateKey(privateKeyPem)));
}

export interface SshCertificateRequest {
  /** `ssh-ed25519 AAAA...` — the public half to be signed. */
  openSshPublicKey: string;
  /** The login name(s) the certificate authorizes. Scoped per run; never a wildcard. */
  principals: string[];
  /** Minutes, not hours. Bounds a LEAKED CERTIFICATE — explicitly NOT a bound on CA compromise,
   *  which sshd cannot enforce because the validity interval lives inside the certificate an
   *  attacker with the key would mint (ADR-0051, the blast-radius analysis). */
  validForSeconds: number;
  /** The resolved hosts this run may reach, carried for the authority's own policy and for the
   *  audit record. Not a substitute for the network-layer allowlist (M27.6). */
  targetHosts: string[];
  /** REQUESTED key id — the string `sshd` writes to the host's own auth log on every
   *  authentication, and therefore the only field by which a host's records can name what reached
   *  it. Honoured only by authorities that mint the certificate themselves (`ScpCaAuthority`); a
   *  BYO authority chooses its own, which is why `IssuedSshCertificate.keyId` reports what was
   *  ACTUALLY signed rather than echoing this back. */
  keyId?: string;
}

export interface IssuedSshCertificate {
  /** The signed certificate, OpenSSH `-cert-v01@openssh.com` form. */
  certificate: string;
  /** Recorded in the hash-chained audit log at issuance (ADR-0051 D5), so a certificate a host
   *  accepted that SCP never issued is detectable as forgery. Authorities that do not return one
   *  get a locally-generated identifier — see `VaultSshAuthority`. */
  serial: string;
  /** Absolute expiry, derived from `validForSeconds` at issue time. */
  expiresAt: Date;
  /** Which authority issued it. Distinguishes BYO from the SCP-CA fallback in evidence. */
  authority: string;
  /** The key id ACTUALLY inside the certificate, when the authority knows it. Reported rather than
   *  assumed: the value recorded in `ssh_certificate_issuances` and the value a host logs must be
   *  the same string, and a caller that formatted its own copy would be comparing its guess against
   *  the host's record. `undefined` from a BYO authority that does not disclose it. */
  keyId?: string;
}

export interface SshCredentialAuthority {
  readonly name: string;
  issue(request: SshCertificateRequest): Promise<IssuedSshCertificate>;
}

export interface VaultSshAuthorityConfig {
  /** e.g. `https://vault.internal:8200`. */
  baseUrl: string;
  /** The mount path of the SSH secrets engine, e.g. `ssh-client-signer`. */
  mountPath: string;
  /** The Vault role that constrains principals and TTL on Vault's side. SCP asking for something
   *  the role forbids is refused THERE, which is the point of delegating: the organization's
   *  policy stays the organization's. */
  role: string;
  /** Resolved from the secret store by the caller — never read from process.env here, so this
   *  module has no ambient authority of its own. */
  token: string;
  /** Injected so the caller can supply an egress-guarded implementation (ADR-0003). Defaults to
   *  global fetch only to keep the unit tests free of a network stub they do not need. */
  fetchImpl?: typeof fetch;
}

/**
 * HashiCorp Vault's SSH secrets engine, `POST /v1/{mount}/sign/{role}`.
 *
 * SCP sends a public key and gets a certificate. It never sees the signing key, which is the whole
 * value of this path: the fleet-wide crown jewel stays where the organization already protects it,
 * and ADR-0002's HSM/KMS precondition is satisfied by Vault's own custody rather than by SCP's.
 */
export class VaultSshAuthority implements SshCredentialAuthority {
  readonly name = "vault-ssh";

  constructor(private readonly config: VaultSshAuthorityConfig) {}

  async issue(request: SshCertificateRequest): Promise<IssuedSshCertificate> {
    const doFetch = this.config.fetchImpl ?? fetch;
    const url =
      `${this.config.baseUrl.replace(/\/+$/, "")}` +
      `/v1/${encodeURIComponent(this.config.mountPath)}/sign/${encodeURIComponent(this.config.role)}`;
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        "X-Vault-Token": this.config.token,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        public_key: request.openSshPublicKey,
        // Vault's own role policy may narrow these further and refuse; that refusal is the
        // organization's policy winning, and is surfaced rather than worked around.
        valid_principals: request.principals.join(","),
        ttl: `${request.validForSeconds}s`,
        cert_type: "user"
      })
    });

    if (!response.ok) {
      // The body carries Vault's `errors` array, which names the policy that refused. Truncated
      // because it is operator-facing text of unbounded length, and included because "issuance
      // failed" with no reason sends an operator to Vault's logs for something SCP was told.
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new Error(
        `vault-ssh: certificate request refused (HTTP ${response.status})${detail ? `: ${detail}` : ""}`
      );
    }

    const body = (await response.json()) as {
      data?: { signed_key?: string; serial_number?: string };
    };
    const certificate = body.data?.signed_key;
    if (!certificate) {
      throw new Error("vault-ssh: response contained no signed_key");
    }

    return {
      certificate,
      // Vault returns a serial for some mounts and not others. A locally-generated identifier keeps
      // D5's reconciliation possible either way — it is recorded at issuance and correlated by the
      // audit row, so a certificate SCP never issued still has no matching record. Prefixed so the
      // two origins are never confused when reading evidence.
      serial: body.data?.serial_number ?? `scp-local:${randomUUID()}`,
      expiresAt: new Date(Date.now() + request.validForSeconds * 1000),
      authority: this.name
    };
  }
}
