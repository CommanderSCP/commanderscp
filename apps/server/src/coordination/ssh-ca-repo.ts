import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  sshCaEnrolments,
  sshCertificateAuthorities,
  sshCertificateIssuances
} from "../db/schema.js";
import type { TrustDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";

/**
 * Storage for ADR-0051's SCP-CA fallback, and for the issuance evidence BOTH credential paths
 * write (D5).
 */

export interface SshCertificateAuthorityRow {
  id: string;
  domainId: TrustDomainId;
  publicKey: string;
  privateKeySecretKey: string;
  status: string;
}

/** The ONE authority currently minting for a domain, or none. */
export async function activeAuthorityForDomain(
  tx: TenantTx,
  orgId: string,
  domainId: TrustDomainId
): Promise<SshCertificateAuthorityRow | undefined> {
  const [row] = await tx
    .select({
      id: sshCertificateAuthorities.id,
      domainId: sshCertificateAuthorities.domainId,
      publicKey: sshCertificateAuthorities.publicKey,
      privateKeySecretKey: sshCertificateAuthorities.privateKeySecretKey,
      status: sshCertificateAuthorities.status
    })
    .from(sshCertificateAuthorities)
    .where(
      and(
        eq(sshCertificateAuthorities.orgId, orgId),
        eq(sshCertificateAuthorities.domainId, domainId),
        eq(sshCertificateAuthorities.status, "active")
      )
    )
    .limit(1);
  return row as SshCertificateAuthorityRow | undefined;
}

export interface CreateAuthorityInput {
  orgId: string;
  domainId: TrustDomainId;
  publicKey: string;
  privateKeySecretKey: string;
}

/** Creates the domain's active CA. The partial unique index refuses a second one, so a race
 *  between two callers ends as a constraint violation rather than two CAs minting at once. */
export async function createAuthority(
  tx: TenantTx,
  input: CreateAuthorityInput
): Promise<{ id: string }> {
  const id = randomUUID();
  await tx.insert(sshCertificateAuthorities).values({
    id,
    orgId: input.orgId,
    domainId: input.domainId,
    publicKey: input.publicKey,
    privateKeySecretKey: input.privateKeySecretKey,
    status: "active"
  });
  return { id };
}

export interface RecordIssuanceInput {
  orgId: string;
  /** NULL on the BYO path — no SCP-held authority minted it. */
  authorityId?: string;
  authorityName: string;
  serial: string;
  keyId: string;
  principals: string[];
  targetHosts: string[];
  expiresAt: Date;
}

/**
 * Writes the issuance record ADR-0051 D5's reconciliation reads.
 *
 * Called in the SAME transaction as the issuance it describes. A certificate that reached a runner
 * without a row here would be indistinguishable from a forgery, so the record must not be able to
 * fail independently of the thing it records.
 */
export async function recordIssuance(
  tx: TenantTx,
  input: RecordIssuanceInput
): Promise<{ id: string }> {
  const id = randomUUID();
  await tx.insert(sshCertificateIssuances).values({
    id,
    orgId: input.orgId,
    authorityId: input.authorityId ?? null,
    authorityName: input.authorityName,
    serial: input.serial,
    keyId: input.keyId,
    principals: input.principals,
    targetHosts: input.targetHosts,
    expiresAt: input.expiresAt
  });
  return { id };
}

export interface ReconciliationVerdict {
  serial: string;
  /** `true` when SCP has no record of issuing this serial — the forgery signal. */
  unrecognised: boolean;
  keyId?: string;
  authorityName?: string;
  issuedAt?: Date;
  expiresAt?: Date;
}

/**
 * ADR-0051 D5 — given serials observed in host sshd logs, say which SCP never issued.
 *
 * Deliberately returns a verdict per INPUT serial rather than a filtered list of matches: the
 * caller needs to distinguish "checked and recognised" from "checked and not recognised", and a
 * list of matches makes those two look identical when the result is empty.
 */
export async function reconcileSerials(
  tx: TenantTx,
  orgId: string,
  serials: string[]
): Promise<ReconciliationVerdict[]> {
  if (serials.length === 0) return [];
  const rows = await tx
    .select({
      serial: sshCertificateIssuances.serial,
      keyId: sshCertificateIssuances.keyId,
      authorityName: sshCertificateIssuances.authorityName,
      issuedAt: sshCertificateIssuances.issuedAt,
      expiresAt: sshCertificateIssuances.expiresAt
    })
    .from(sshCertificateIssuances)
    .where(eq(sshCertificateIssuances.orgId, orgId));

  const known = new Map(rows.map((r) => [r.serial, r]));
  return serials.map((serial) => {
    const hit = known.get(serial);
    return hit
      ? {
          serial,
          unrecognised: false,
          keyId: hit.keyId,
          authorityName: hit.authorityName,
          issuedAt: hit.issuedAt,
          expiresAt: hit.expiresAt
        }
      : { serial, unrecognised: true };
  });
}

export interface EnrolDomainInput {
  orgId: string;
  domainId: TrustDomainId;
  publicKey: string;
  privateKeySecretKey: string;
  /** HOW TO GET IN WITHOUT SCP'S CA (ADR-0051). Non-empty, or the enrolment is refused. */
  breakGlass: string;
  recordedBySubjectId: string;
}

export class BreakGlassRequired extends Error {}

/**
 * Enrol a domain: stand up its CA and record the independent access path, in ONE transaction.
 *
 * The two are inseparable ON PURPOSE. ADR-0051's recovery paragraph is a circularity — an estate
 * whose only route in is SCP's CA cannot recover from that CA being compromised — so the fix is
 * that a CA cannot come into existence without a recorded way in that does not depend on it. Split
 * across two calls, the first could succeed and the second be forgotten, which is exactly the
 * estate the ADR describes.
 *
 * The emptiness check lives HERE as well as in the CHECK constraint, so the caller gets a sentence
 * rather than a constraint-violation string. The constraint is what makes it true; this is what
 * makes it legible.
 */
export async function enrolDomain(
  tx: TenantTx,
  input: EnrolDomainInput
): Promise<{ authorityId: string; enrolmentId: string }> {
  if (input.breakGlass.trim().length === 0) {
    throw new BreakGlassRequired(
      "refusing to enrol this domain: no independent access path was recorded. An estate whose " +
        "only route in is SCP's CA cannot recover from SCP's CA being compromised — revocation is " +
        "a fleet-wide push and the push needs access (ADR-0051). Record how you would reach these " +
        "hosts WITHOUT this CA: an out-of-band console, a jump host outside the trust domain, a " +
        "hardware KVM."
    );
  }
  const { id: authorityId } = await createAuthority(tx, {
    orgId: input.orgId,
    domainId: input.domainId,
    publicKey: input.publicKey,
    privateKeySecretKey: input.privateKeySecretKey
  });
  const enrolmentId = randomUUID();
  await tx.insert(sshCaEnrolments).values({
    id: enrolmentId,
    orgId: input.orgId,
    domainId: input.domainId,
    authorityId,
    breakGlass: input.breakGlass.trim(),
    recordedBySubjectId: input.recordedBySubjectId
  });
  return { authorityId, enrolmentId };
}

export interface EnrolmentRow {
  domainId: TrustDomainId;
  authorityId: string;
  breakGlass: string;
  enrolledAt: Date;
}

/** The recovery story for a domain, or none — which means it is not enrolled. */
export async function enrolmentForDomain(
  tx: TenantTx,
  orgId: string,
  domainId: TrustDomainId
): Promise<EnrolmentRow | undefined> {
  const [row] = await tx
    .select({
      domainId: sshCaEnrolments.domainId,
      authorityId: sshCaEnrolments.authorityId,
      breakGlass: sshCaEnrolments.breakGlass,
      enrolledAt: sshCaEnrolments.enrolledAt
    })
    .from(sshCaEnrolments)
    .where(and(eq(sshCaEnrolments.orgId, orgId), eq(sshCaEnrolments.domainId, domainId)))
    .limit(1);
  return row as EnrolmentRow | undefined;
}
