import type { TenantTx } from "../db/tenant-tx.js";
import { writeOutboxEvent, type OutboxEventInput } from "./outbox-repo.js";

/**
 * Internal event-bus abstraction (DESIGN.md §8): "the internal `EventBus` interface is
 * broker-agnostic". M1 ships only the PostgreSQL-backed implementation (the transactional
 * outbox); the NATS JetStream backend is a documented M3 deliverable ("built early in MVP")
 * that implements this same interface without any caller (graph/objects-repo.ts,
 * graph/relationships-repo.ts, ...) needing to change.
 */
export interface EventBus {
  /** Publishes within the caller's transaction — write-then-publish atomicity is the point. */
  publish(tx: TenantTx, event: OutboxEventInput): Promise<void>;
}

class PostgresEventBus implements EventBus {
  async publish(tx: TenantTx, event: OutboxEventInput): Promise<void> {
    await writeOutboxEvent(tx, event);
  }
}

/** The default (and, in M1, only) EventBus — every mutation publishes through this instance. */
export const eventBus: EventBus = new PostgresEventBus();
