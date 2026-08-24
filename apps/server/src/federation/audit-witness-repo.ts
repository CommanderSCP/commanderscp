import { and, asc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { TrustDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { federationAuditWitness } from "../db/schema.js";

/**
 * FEDERATION AUDIT WITNESS (multi-region-instance-resilience.md §7.2.7). Records that this domain
 * SAW a peer's audit-chain entry at a given origin sequence, from the `audit_segment` journal entries
 * that importers used to discard. INFORMATIONAL — a witness NEVER blocks an import (import-repo.ts
 * calls this from inside the apply loop but treats a witness as enrichment, not a gate).
 *
 * Idempotent by `(org, origin, sequence)`: re-importing the same segment (an idempotent re-delivery)
 * updates nothing and re-records nothing new. The content hash is asserted UNCHANGED on conflict —
 * a peer that presented a DIFFERENT hash at a sequence it once witnessed would be a fork, but that is
 * rail 4's job on the live path; here the witness is a passive detector the runbook reads later, so a
 * conflicting re-witness simply keeps the first (earliest) observation rather than silently rewriting
 * history.
 */
export async function recordAuditWitness(
  tx: TenantTx,
  input: {
    orgId: string;
    peerDomainId: TrustDomainId;
    originDomainId: TrustDomainId;
    sequence: number;
    auditEventId: string;
    contentHash: string;
  }
): Promise<void> {
  await tx
    .insert(federationAuditWitness)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      peerDomainId: input.peerDomainId,
      originDomainId: input.originDomainId,
      sequence: input.sequence,
      auditEventId: input.auditEventId,
      contentHash: input.contentHash
    })
    .onConflictDoNothing({
      target: [
        federationAuditWitness.orgId,
        federationAuditWitness.originDomainId,
        federationAuditWitness.sequence
      ]
    });
}

export interface AuditWitnessRow {
  originDomainId: TrustDomainId;
  sequence: number;
  auditEventId: string;
  contentHash: string;
  witnessedAt: Date;
}

/** All witnesses this domain holds of one ORIGIN's audit chain, in chain order — what the
 *  post-failover runbook compares against the origin's restored `scp audit verify` head to detect a
 *  truncation. */
export async function listAuditWitnessesForOrigin(
  tx: TenantTx,
  orgId: string,
  originDomainId: TrustDomainId
): Promise<AuditWitnessRow[]> {
  const rows = await tx
    .select({
      originDomainId: federationAuditWitness.originDomainId,
      sequence: federationAuditWitness.sequence,
      auditEventId: federationAuditWitness.auditEventId,
      contentHash: federationAuditWitness.contentHash,
      witnessedAt: federationAuditWitness.witnessedAt
    })
    .from(federationAuditWitness)
    .where(
      and(
        eq(federationAuditWitness.orgId, orgId),
        eq(federationAuditWitness.originDomainId, originDomainId)
      )
    )
    .orderBy(asc(federationAuditWitness.sequence));
  return rows;
}
