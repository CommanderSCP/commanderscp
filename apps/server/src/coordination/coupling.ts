import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";

/**
 * Coupled-pipeline prerequisites (M12 P4B — docs/proposals/coupled-pipelines.md). A change declares
 * `properties.requires: {key, at}[]`; it may not execute until, for EACH requirement, some OTHER
 * change is in `validating` or `promoted` and `provides` that `key` at that `at` object.
 *
 * The predicate is EXISTENTIAL over a CONDITION, not a pointer to a specific prerequisite row: a
 * failed/cancelled prerequisite is simply not in {validating, promoted}, so the waiter keeps
 * waiting; the operator fixes it and re-pushes, a NEW change reaches `validating` with the same
 * key, and the waiter releases — nothing to re-point. That is what makes "wait forever" (the owner's
 * choice) coherent rather than stubborn.
 *
 * State choice `validating|promoted`, NOT `promoted` alone (owner ruling: "run successfully, not a
 * human gate"): a forward change never auto-promotes (`reconcile.ts` completeExecution returns for
 * non-rollback changes — promotion is a human `scp change promote`), so a `promoted` predicate would
 * deadlock every automated coupled release. `validating` is the state the engine writes once every
 * wave succeeded — the executor ran, the bucket exists.
 */
export interface Requirement {
  key: string;
  /** Object id (resolved at propose time) the key must be provided at. */
  at: string;
}

/**
 * The subset of `requires` NOT yet satisfied. Empty ⇒ the change is free to execute. Also drives the
 * `waiting` Decision's reason, so an operator can see exactly which prerequisites are outstanding.
 *
 * One jsonb-containment probe per requirement, served by the `obj_props` GIN index
 * (`drizzle/0001:170`, `jsonb_path_ops`) — `properties @> {"provides":[key],"targets":[at]}` is true
 * iff the provider's `provides` array contains `key` AND its `targets` array contains `at`. No new
 * index, no new column: `provides`/`targets` already live in `objects.properties`.
 */
export async function unsatisfiedRequirements(
  tx: TenantTx,
  orgId: string,
  selfChangeObjectId: string,
  requires: Requirement[]
): Promise<Requirement[]> {
  const unmet: Requirement[] = [];
  for (const req of requires) {
    const probe = JSON.stringify({ provides: [req.key], targets: [req.at] });
    const result = await tx.execute<{ ok: number }>(sql`
      SELECT 1 AS ok
      FROM changes c
      JOIN objects o ON o.id = c.object_id AND o.org_id = c.org_id
      WHERE c.org_id = ${orgId}::uuid
        AND c.state IN ('validating', 'promoted')
        AND o.id <> ${selfChangeObjectId}::uuid
        AND o.deleted_at IS NULL
        AND o.properties @> ${probe}::jsonb
      LIMIT 1
    `);
    if (result.rows.length === 0) unmet.push(req);
  }
  return unmet;
}

/** True iff every requirement is satisfied (or there are none). */
export async function requirementsSatisfied(
  tx: TenantTx,
  orgId: string,
  selfChangeObjectId: string,
  requires: Requirement[]
): Promise<boolean> {
  if (requires.length === 0) return true;
  return (await unsatisfiedRequirements(tx, orgId, selfChangeObjectId, requires)).length === 0;
}

/** Renders a requirement list for a Decision reason, e.g. `feature-a@<uuid>, bucket@<uuid>`. */
export function describeRequirements(requires: Requirement[]): string {
  return requires.map((r) => `${r.key}@${r.at}`).join(", ");
}
