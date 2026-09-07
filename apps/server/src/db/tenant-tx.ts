import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

// Derived from `Db["transaction"]` (rather than reaching into drizzle-orm's internal generic
// types) so this stays correct across drizzle-orm versions.
type TxCallback = Parameters<Db["transaction"]>[0];
export type TenantTx = Parameters<TxCallback>[0];

/** Every tenant-scoped read/write runs inside this wrapper. See docs/db.md §156. */
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
