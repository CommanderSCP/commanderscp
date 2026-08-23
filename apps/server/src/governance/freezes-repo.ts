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
  /** M25.2 / owner decision D5 — `true` parks the WHOLE wave (pre-M25.2 behaviour), `false` (the
   *  default) admits the wave's uncovered targets and holds only the covered ones.
   *
   *  READ IN TWO PLACES, AND IT MUST BE BOTH: `gate-orchestrator.ts`'s `partiallyFrozen` predicate
   *  (the wave boundary) and `coordination/freeze-hold.ts`'s `evaluateFreezeHolds` (every tick of
   *  the trigger loop). The gate fires exactly ONCE, on `pending -> running`, so a gate-only reader
   *  makes `atomic` silently degrade to per-target for any freeze that opens after the wave started
   *  — which is the very case M25.2's second half exists to fix. */
  atomic: boolean;
}

export interface CreateFreezeInput {
  orgId: string;
  scopeObjectId: string;
  name?: string | undefined;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  createdByActorId: string;
  /** Defaults to `false` — see `freezes.atomic` (drizzle/0077). Reachable from
   *  `POST /api/v1/freezes` (`CreateFreezeRequestSchema.atomic`, optional) and `scp freeze create
   *  --atomic`, because a loosening whose escape hatch ships one increment later has a window in
   *  which the escape hatch does not exist. */
  atomic?: boolean | undefined;
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
      createdByActorId: input.createdByActorId,
      atomic: input.atomic ?? false
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

/**
 * EVERY freeze in the org whose window covers `at` — no scope filter at all.
 *
 * THE ONLY PLACE THAT KNOWS THE WINDOW PREDICATE (`starts_at <= at < ends_at`), and that is the
 * whole reason it is a function rather than an inlined `where`. `graph/containment.ts`'s header
 * records what a second copy of one idea costs here specifically: three row-returning copies of the
 * containment walk drifted, one of them kept a `domain_id`-only walk, and a service-scoped freeze
 * failed OPEN as a result. A second copy of the *window* predicate is the same hazard one column
 * over — the half-open boundary (`lte` on the start, `gt` on the end) is exactly the kind of detail
 * two copies stop agreeing about, and both directions of that disagreement are silent.
 *
 * Served by the `freezes_org_window` index. Returns [] for an org with no active freeze, which is
 * the overwhelmingly common case and the one `freeze-scope.ts`'s INERTNESS property is built on:
 * this query runs before any containment walk, so an org with nothing frozen pays one indexed read
 * per change per tick and not a single graph traversal.
 *
 * EXPIRY IS THIS PREDICATE AND NOTHING ELSE. There is no sweeper and no status column: the first
 * tick after `ends_at` a freeze simply stops being returned here. See `scan-override-grants.ts`,
 * which followed this file for the same reason.
 */
export async function activeFreezesInWindow(
  tx: TenantTx,
  orgId: string,
  at: Date
): Promise<FreezeRow[]> {
  const rows = await tx
    .select()
    .from(freezes)
    .where(and(eq(freezes.orgId, orgId), lte(freezes.startsAt, at), gt(freezes.endsAt, at)));
  return rows as FreezeRow[];
}

/**
 * THE MEMBERSHIP RULE — pure, no database, unit-testable on its own.
 *
 * EXACT-SET MEMBERSHIP, NOT CONTAINMENT, and that contract is the dangerous half of this file: this
 * function does no walking whatsoever, so any id the caller omits from `scopeObjectIds` is a freeze
 * that silently does not block. Callers must build the set with `graph/containment.ts`'s
 * `containmentScopeIds` (or, per target, `containmentChain`), which walks BOTH containment routes.
 * A caller that hand-rolled a `domain_id`-only walk omitted the target's SERVICE, and a
 * service-scoped freeze failed OPEN — the incident `graph/containment.ts` exists to have ended. If
 * you give this function ids from anywhere else, walk every route first.
 */
export function filterFreezesByScopes(rows: FreezeRow[], scopeObjectIds: string[]): FreezeRow[] {
  if (scopeObjectIds.length === 0) return [];
  const scopes = new Set(scopeObjectIds);
  return rows.filter((f) => scopes.has(f.scopeObjectId));
}

/** Freezes active RIGHT NOW (`at`) whose scope is one of `scopeObjectIds` — the caller passes the
 *  target's full containment chain (org/domain/service/component ids) so a freeze declared at any
 *  containment level is found regardless of which exact object the gate check is evaluating.
 *
 *  THE COMPOSITION of the two functions above, and byte-identical in behaviour to the single
 *  function it replaced: same half-open window, same exact-set membership, same empty-input short
 *  circuit, same order (the window query has no `ORDER BY` and the filter preserves whatever it
 *  returns — `checkFreeze`'s override loop is order-independent by construction and must stay so).
 *  Read `filterFreezesByScopes`'s warning before calling it: this function inherits every word of
 *  it, including that any omitted id is a freeze that silently does not block.
 *
 *  `governance/freeze-scope.ts`'s `freezesByTarget` answers the SAME question per target, and the
 *  two are set-equal by construction because `containmentScopeIds` IS the union of the per-target
 *  chains. That equality is pinned by a test; if you change either, change both. */
export async function activeFreezesForScopes(
  tx: TenantTx,
  orgId: string,
  scopeObjectIds: string[],
  at: Date
): Promise<FreezeRow[]> {
  if (scopeObjectIds.length === 0) return [];
  return filterFreezesByScopes(await activeFreezesInWindow(tx, orgId, at), scopeObjectIds);
}
