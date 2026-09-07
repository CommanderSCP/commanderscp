import { and, eq, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { TrustDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { federationUnattachedChangeStatus } from "../db/schema.js";

/** UNATTACHED PEER CHANGE STATUS. See docs/federation.md §559. */

export type UnattachedDropReason = "no_local_replica" | "receiver_scope";

export interface UnattachedChangeStatusRow {
  peerDomainId: TrustDomainId;
  changeObjectId: string;
  urn: string | null;
  name: string | null;
  lastState: string | null;
  dropReason: UnattachedDropReason;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Upsert one dropped `change_status` entry. See docs/federation.md §560. */
export async function recordUnattachedChangeStatus(
  tx: TenantTx,
  input: {
    orgId: string;
    peerDomainId: TrustDomainId;
    changeObjectId: string;
    urn?: string | null;
    name?: string | null;
    lastState?: string | null;
    dropReason: UnattachedDropReason;
  }
): Promise<void> {
  await tx
    .insert(federationUnattachedChangeStatus)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      peerDomainId: input.peerDomainId,
      changeObjectId: input.changeObjectId,
      urn: input.urn ?? null,
      name: input.name ?? null,
      lastState: input.lastState ?? null,
      dropReason: input.dropReason
    })
    .onConflictDoUpdate({
      target: [
        federationUnattachedChangeStatus.orgId,
        federationUnattachedChangeStatus.peerDomainId,
        federationUnattachedChangeStatus.changeObjectId
      ],
      set: {
        urn: sql`coalesce(excluded.urn, ${federationUnattachedChangeStatus.urn})`,
        name: sql`coalesce(excluded.name, ${federationUnattachedChangeStatus.name})`,
        lastState: sql`coalesce(excluded.last_state, ${federationUnattachedChangeStatus.lastState})`,
        dropReason: sql`excluded.drop_reason`,
        lastSeenAt: sql`now()`
      }
    });
}

/** Resolve the evidence for one change. See docs/federation.md §561. */
export async function clearUnattachedChangeStatus(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId,
  changeObjectId: string
): Promise<void> {
  await tx
    .delete(federationUnattachedChangeStatus)
    .where(
      and(
        eq(federationUnattachedChangeStatus.orgId, orgId),
        eq(federationUnattachedChangeStatus.peerDomainId, peerDomainId),
        eq(federationUnattachedChangeStatus.changeObjectId, changeObjectId)
      )
    );
}

/** The board's read. See docs/federation.md §562. */
export async function listUnattachedChangeStatusInStates(
  tx: TenantTx,
  orgId: string,
  states: string[],
  limit = 50
): Promise<UnattachedChangeStatusRow[]> {
  if (states.length === 0) return [];
  const rows = await tx
    .select()
    .from(federationUnattachedChangeStatus)
    .where(
      and(
        eq(federationUnattachedChangeStatus.orgId, orgId),
        inArray(federationUnattachedChangeStatus.lastState, states)
      )
    )
    .limit(limit);
  return rows.map((row) => ({
    peerDomainId: row.peerDomainId,
    changeObjectId: row.changeObjectId,
    urn: row.urn,
    name: row.name,
    lastState: row.lastState,
    dropReason: row.dropReason as UnattachedDropReason,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString()
  }));
}
