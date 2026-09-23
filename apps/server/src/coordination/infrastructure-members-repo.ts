import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { infrastructureMembers } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";

/**
 * The observed membership of an infrastructure product (D25(a), M27.6).
 *
 * This is what `scp-runner-ops` compiles its inventory from — the reason a tenant cannot name the
 * hosts a run reaches.
 */

export interface ObservedMember {
  memberId: string;
  address: string;
}

export interface MembershipDiff {
  added: ObservedMember[];
  removed: ObservedMember[];
  /** Same member id, different address — a replacement in place. Reported separately from
   *  added/removed because convergence treats it as one host to re-apply to, not as one leaving
   *  and an unrelated one arriving. */
  readdressed: { memberId: string; from: string; to: string }[];
}

/** Current membership, ordered so an inventory file is byte-stable between runs that observed the
 *  same set — an inventory that reorders on every read makes every diff of a run look meaningful. */
export async function readMembers(
  tx: TenantTx,
  orgId: string,
  productObjectId: string
): Promise<ObservedMember[]> {
  const rows = await tx
    .select({
      memberId: infrastructureMembers.memberId,
      address: infrastructureMembers.address
    })
    .from(infrastructureMembers)
    .where(
      and(
        eq(infrastructureMembers.orgId, orgId),
        eq(infrastructureMembers.productObjectId, productObjectId)
      )
    );
  return rows.sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
}

export interface ReplaceMembershipInput {
  orgId: string;
  productObjectId: string;
  reportedBySubjectId: string;
  members: ObservedMember[];
}

/**
 * Replace a product's observed membership with the reported snapshot, returning what changed.
 *
 * The DIFF is the point, not a convenience: D25(b) converges "scoped by default to the changed
 * instances", so the caller needs to know which hosts are new. Computed here, inside the same
 * transaction as the write, because computing it from a separate read would race another report.
 */
export async function replaceMembership(
  tx: TenantTx,
  input: ReplaceMembershipInput
): Promise<MembershipDiff> {
  const before = await readMembers(tx, input.orgId, input.productObjectId);
  const beforeById = new Map(before.map((m) => [m.memberId, m]));
  const afterById = new Map(input.members.map((m) => [m.memberId, m]));

  const added = input.members.filter((m) => !beforeById.has(m.memberId));
  const removed = before.filter((m) => !afterById.has(m.memberId));
  const readdressed = input.members
    .filter((m) => {
      const prior = beforeById.get(m.memberId);
      return prior !== undefined && prior.address !== m.address;
    })
    .map((m) => ({
      memberId: m.memberId,
      from: beforeById.get(m.memberId)!.address,
      to: m.address
    }));

  // Delete-then-insert rather than a merge: the report IS the truth, and reconciling row by row
  // would leave a member behind on any path the merge did not anticipate.
  await tx
    .delete(infrastructureMembers)
    .where(
      and(
        eq(infrastructureMembers.orgId, input.orgId),
        eq(infrastructureMembers.productObjectId, input.productObjectId)
      )
    );
  if (input.members.length > 0) {
    await tx.insert(infrastructureMembers).values(
      input.members.map((m) => ({
        id: randomUUID(),
        orgId: input.orgId,
        productObjectId: input.productObjectId,
        memberId: m.memberId,
        address: m.address,
        reportedBySubjectId: input.reportedBySubjectId
      }))
    );
  }

  return { added, removed, readdressed };
}
