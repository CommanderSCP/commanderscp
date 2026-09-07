import { v7 as uuidv7 } from "uuid";
import type { TenantTx } from "../db/tenant-tx.js";
import { outbox } from "../db/schema.js";

export interface OutboxEventInput {
  orgId: string;
  type: string;
  source: string;
  subject?: string | null;
  data: unknown;
}

/** Writes one CloudEvents-shaped row in the caller's transaction. See docs/events.md §40. */
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
