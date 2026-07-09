import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

// Derived from `Db["transaction"]` (rather than reaching into drizzle-orm's internal generic
// types) so this stays correct across drizzle-orm versions.
type TxCallback = Parameters<Db["transaction"]>[0];
export type TenantTx = Parameters<TxCallback>[0];

/**
 * Every tenant-scoped read/write runs inside this wrapper (DESIGN.md §4.2). Two things happen,
 * both `LOCAL` to the transaction so they can never leak onto a pooled connection reused by an
 * unrelated request:
 *
 *  1. `SET LOCAL ROLE scp_app` — drops from the migration-time admin role to the least-
 *     privileged app role (no BYPASSRLS), so RLS is enforced even if application code forgets an
 *     org filter.
 *  2. `SET LOCAL app.current_org_id` — the value every `org_isolation` RLS policy compares
 *     against. Uses `set_config(..., true)` (parameterized) rather than string-interpolated SQL.
 *
 * Fails closed: a transaction that never calls this (or an adversarial raw connection that never
 * sets the GUC) sees `current_setting('app.current_org_id', true)` as NULL, and `org_id = NULL`
 * is never true under RLS — BUILD_AND_TEST.md §8 M1 DoD (a).
 */
export async function withTenantTx<T>(
  db: Db,
  orgId: string,
  fn: (tx: TenantTx) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE scp_app`);
    await tx.execute(sql`SELECT set_config('app.current_org_id', ${orgId}, true)`);
    return fn(tx);
  });
}
