import { randomBytes } from "node:crypto";
import type { TrustDomainId } from "@scp/schemas";
import { signSshCertificate } from "./ssh-certificate.js";
import type {
  IssuedSshCertificate,
  SshCertificateRequest,
  SshCredentialAuthority
} from "./ssh-credentials.js";

/**
 * ADR-0051's FALLBACK path — SCP mints, because this domain has no authority of its own.
 *
 * D1 makes this second by design, and the ordering matters: BYO holds no signing key at all, so
 * an estate that can use it should. This exists for the case Mode C was created to serve — an org
 * with nothing — and it is where ADR-0002's HSM/KMS precondition was deliberately relaxed (D3),
 * with the cost written down rather than implied.
 */

/** Serials are 64-bit unsigned in the certificate format. Random rather than sequential: a
 *  sequential serial leaks how many certificates a domain has issued, and — worse for D5 — lets a
 *  forger pick a plausible unused one. Random over 2^63 makes a collision-by-guess useless, and
 *  the unique index on (org, serial) catches the astronomically unlikely genuine collision as a
 *  write failure rather than silently merging two issuances into one record. */
function randomSerial(): bigint {
  return randomBytes(8).readBigUInt64BE(0) & 0x7fff_ffff_ffff_ffffn;
}

export interface ScpCaAuthorityConfig {
  /** The domain whose CA this is — never fleet-wide (ADR-0051 D2). */
  domainId: TrustDomainId;
  /** The CA row's id, recorded on the issuance so evidence names WHICH CA minted. */
  authorityId: string;
  /** Resolved from the encrypted secret store by the caller. Passed in rather than read here, so
   *  this class has no ambient access to key material and is trivially testable. */
  caPrivateKeyPem: string;
  /** Bound the runner to the addresses the certificate may be used from, when the caller knows
   *  them. Defence in depth beside the network-layer allowlist (M27.6), not a replacement. */
  sourceAddress?: string;
}

export class ScpCaAuthority implements SshCredentialAuthority {
  readonly name = "scp-ca";

  constructor(private readonly config: ScpCaAuthorityConfig) {}

  get authorityId(): string {
    return this.config.authorityId;
  }

  async issue(request: SshCertificateRequest): Promise<IssuedSshCertificate> {
    const serial = randomSerial();
    const validAfter = new Date();
    const validBefore = new Date(validAfter.getTime() + request.validForSeconds * 1000);

    // The key id is what sshd logs, so it is where the RUN belongs. The default below names only
    // the principals and the serial — which is what this comment used to claim carried the run and
    // did not. A caller that knows the change supplies `request.keyId`; the serial is appended here
    // either way so the log line is unique per certificate even for repeated runs of one change.
    const keyId = `${request.keyId ?? `scp-ops:${request.principals.join(",")}`}:${serial}`;
    const certificate = signSshCertificate({
      openSshPublicKey: request.openSshPublicKey,
      caPrivateKeyPem: this.config.caPrivateKeyPem,
      serial,
      keyId,
      principals: request.principals,
      validAfter,
      validBefore,
      criticalOptions: this.config.sourceAddress
        ? [["source-address", this.config.sourceAddress]]
        : [],
      // NONE. See ssh-certificate.ts — Ansible's transport execs a command and needs no pty,
      // agent forwarding or user-rc, so this certificate grants none of them.
      extensions: []
    });

    return {
      certificate,
      serial: serial.toString(),
      expiresAt: validBefore,
      authority: this.name,
      keyId
    };
  }
}
