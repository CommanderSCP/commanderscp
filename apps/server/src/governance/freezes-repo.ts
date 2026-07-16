import { and, eq, gt, lte } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { TenantTx } from "../db/tenant-tx.js";
import { freezes } from "../db/schema.js";
import { notFound } from "../errors.js";

/**
 * Freeze windows (DESIGN §10.3): "a built-in policy effect with time windows and scope
 * (org/domain/service/component)." A dedicated projection table (db/schema.ts's doc comment) —
 * `governance/gate-orchestrator.ts`'s `checkFreeze` queries this directly rather than folding
 * freezes into the policy-document model, since a freeze's scope/window semantics ("does this
 * window cover this object, right now") don't need CEL at all — a freeze either covers the target
 * or it doesn't. (`coordination/gates.ts` is the thin adapter above that orchestrator; it does not
 * touch this file.)
 */

export interface FreezeRow {
  id: string;
  orgId: string;
  scopeObjectId: string;
  name: string | null;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  createdByActorId: string;
  createdAt: Date;
}

export interface CreateFreezeInput {
  orgId: string;
  scopeObjectId: string;
  name?: string | undefined;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  createdByActorId: string;
}

export async function createFreeze(tx: TenantTx, input: CreateFreezeInput): Promise<FreezeRow> {
  if (input.endsAt <= input.startsAt) {
    throw notFound("freeze endsAt must be after startsAt"); // validated again at the route/schema layer; defensive here
  }
  const [row] = await tx
    .insert(freezes)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      scopeObjectId: input.scopeObjectId,
      name: input.name ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      reason: input.reason,
      createdByActorId: input.createdByActorId
    })
    .returning();
  return row as FreezeRow;
}

export async function getFreeze(tx: TenantTx, orgId: string, id: string): Promise<FreezeRow> {
  const rows = await tx
    .select()
    .from(freezes)
    .where(and(eq(freezes.orgId, orgId), eq(freezes.id, id)))
    .limit(1);
  if (!rows[0]) throw notFound(`freeze '${id}' not found`);
  return rows[0] as FreezeRow;
}

export async function listFreezes(tx: TenantTx, orgId: string): Promise<FreezeRow[]> {
  const rows = await tx.select().from(freezes).where(eq(freezes.orgId, orgId));
  return rows as FreezeRow[];
}

/** Freezes active RIGHT NOW (`at`) whose scope is one of `scopeObjectIds` — the caller passes the
 *  target's full containment chain (org/domain/service/component ids) so a freeze declared at any
 *  containment level is found regardless of which exact object the gate check is evaluating.
 *
 *  That contract is EXACT-SET MEMBERSHIP, not containment: this function does no walking of its own,
 *  so any id the caller omits is a freeze that silently does not block. The sole caller
 *  (`gate-orchestrator.ts`'s `checkFreeze`) must build `scopeObjectIds` with
 *  `graph/containment.ts`'s `containmentScopeIds`, which walks both routes. It previously hand-rolled
 *  a domain_id-only walk, omitting the target's SERVICE — so a service-scoped freeze failed OPEN.
 *  If you give this function ids from anywhere else, walk both routes first. */
export async function activeFreezesForScopes(
  tx: TenantTx,
  orgId: string,
  scopeObjectIds: string[],
  at: Date
): Promise<FreezeRow[]> {
  if (scopeObjectIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(freezes)
    .where(and(eq(freezes.orgId, orgId), lte(freezes.startsAt, at), gt(freezes.endsAt, at)));
  return (rows as FreezeRow[]).filter((f) => scopeObjectIds.includes(f.scopeObjectId));
}
