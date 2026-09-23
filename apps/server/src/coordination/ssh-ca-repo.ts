import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { sshCertificateAuthorities, sshCertificateIssuances } from "../db/schema.js";
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
