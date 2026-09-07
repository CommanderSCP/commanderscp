import { eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { asTrustDomainId, type TrustDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { federationSelf } from "../db/schema.js";

/** This org's own federation domain identity. See docs/federation.md §533. */
export interface FederationSelf {
  orgId: string;
  /** TRUST sense (ADR-0021 D4) — this org's own security-domain identity. */
  domainId: TrustDomainId;
  name: string;
  role: "unset" | "commander" | "outpost" | "retrans";
  /** §7.2.6 — the per-org resync/promotion generation counter (0 until the first resync). */
  generation: number;
}

function toFederationSelf(row: typeof federationSelf.$inferSelect): FederationSelf {
  return {
    orgId: row.orgId,
    domainId: row.domainId,
    name: row.name,
    role: row.role as FederationSelf["role"],
    generation: row.generation
  };
}

/** §7.2.6 — bump this org's monotonic generation counter and return the NEW value, recorded with a
 *  resync (or promotion) Decision so a forensic reading can attribute entries to before/after a
 *  lost-tail event. `ensureFederationSelf` first so the row exists even on a never-federated org. */
export async function bumpFederationGeneration(tx: TenantTx, orgId: string): Promise<number> {
  await ensureFederationSelf(tx, orgId);
  const [row] = await tx
    .update(federationSelf)
    .set({ generation: sql`${federationSelf.generation} + 1` })
    .where(eq(federationSelf.orgId, orgId))
    .returning({ generation: federationSelf.generation });
  if (!row) throw new Error(`bumpFederationGeneration: no federation_self row for org '${orgId}'`);
  return row.generation;
}

/** Race-safe like `governance/attestation.ts`'s `ensureInstanceKey`: a duplicate-insert on
 *  concurrent first-use callers is resolved by re-reading rather than erroring. */
export async function ensureFederationSelf(tx: TenantTx, orgId: string): Promise<FederationSelf> {
  const existing = await tx
    .select()
    .from(federationSelf)
    .where(eq(federationSelf.orgId, orgId))
    .limit(1);
  if (existing[0]) return toFederationSelf(existing[0]);

  // BOUNDARY (ADR-0021 D4): a freshly minted federation identity. `uuidv7()` returns a plain
  // string; this is the one place in the tree where a TrustDomainId is created from nothing.
  const domainId = asTrustDomainId(uuidv7());
  try {
    const [row] = await tx
      .insert(federationSelf)
      .values({ orgId, domainId, name: orgId, role: "unset" })
      .returning();
    if (row) return toFederationSelf(row);
  } catch {
    // Lost a race with a concurrent first-use caller — fall through to re-read.
  }
  const afterRace = await tx
    .select()
    .from(federationSelf)
    .where(eq(federationSelf.orgId, orgId))
    .limit(1);
  if (!afterRace[0])
    throw new Error(`ensureFederationSelf: failed to create or read identity for org '${orgId}'`);
  return toFederationSelf(afterRace[0]);
}

export interface InitFederationInput {
  orgId: string;
  name: string;
  role: "commander" | "outpost" | "retrans";
}

/** `scp federation init`. See docs/federation.md §534. */
export async function initFederationSelf(
  tx: TenantTx,
  input: InitFederationInput
): Promise<FederationSelf> {
  await ensureFederationSelf(tx, input.orgId);
  const [row] = await tx
    .update(federationSelf)
    .set({ name: input.name, role: input.role })
    .where(eq(federationSelf.orgId, input.orgId))
    .returning();
  if (!row)
    throw new Error(`initFederationSelf: failed to update identity for org '${input.orgId}'`);
  return toFederationSelf(row);
}
