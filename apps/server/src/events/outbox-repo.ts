import { v7 as uuidv7 } from "uuid";
import type { TenantTx } from "../db/tenant-tx.js";
import { outbox } from "../db/schema.js";

export interface OutboxEventInput {
  orgId: string;
  /** CloudEvents 1.0 `type`, e.g. `scp.object.created`. */
  type: string;
  /** CloudEvents `source`, e.g. `/objects/service`. */
  source: string;
  /** CloudEvents `subject` — usually the affected object/relationship id. */
  subject?: string | null;
  data: unknown;
}

/**
 * Writes one CloudEvents-shaped row in the caller's transaction (DESIGN.md §8: "every domain
 * mutation writes a CloudEvents-1.0-shaped row to an outbox table in the same transaction").
 * The `outbox_notify_trigger` (drizzle/0002_rls_rbac_seed.sql) fires `pg_notify` after commit;
 * the worker's outbox relay (events/outbox-relay.ts) picks rows up from there.
 */
export async function writeOutboxEvent(tx: TenantTx, input: OutboxEventInput): Promise<void> {
  await tx.insert(outbox).values({
    id: uuidv7(),
    orgId: input.orgId,
    type: input.type,
    source: input.source,
    subject: input.subject ?? null,
    data: input.data as object
  });
}
