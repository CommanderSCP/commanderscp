import type { TenantTx } from "../db/tenant-tx.js";
import { writeOutboxEvent, type OutboxEventInput } from "./outbox-repo.js";

/** Internal event-bus abstraction (DESIGN.md §8). See docs/events.md §16. */
export interface EventBus {
  /** Publishes within the caller's transaction — write-then-publish atomicity is the point. */
  publish(tx: TenantTx, event: OutboxEventInput): Promise<void>;
}

class PostgresEventBus implements EventBus {
  async publish(tx: TenantTx, event: OutboxEventInput): Promise<void> {
    await writeOutboxEvent(tx, event);
  }
}

/** The one and only `EventBus`. See docs/events.md §17. */
export const eventBus: EventBus = new PostgresEventBus();
