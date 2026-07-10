import type { TenantTx } from "../db/tenant-tx.js";
import { writeOutboxEvent, type OutboxEventInput } from "./outbox-repo.js";

/**
 * Internal event-bus abstraction (DESIGN.md §8): "the internal `EventBus` interface is
 * broker-agnostic".
 *
 * M3 design decision (BUILD_AND_TEST.md M3 item 8, DESIGN.md §8 "Scaling insurance"): adding the
 * NATS JetStream backend did NOT require a second `EventBus` implementation or any change to this
 * interface. `publish()` runs *inside* the caller's Postgres transaction — there is no way to
 * atomically "publish to NATS" as part of a Postgres COMMIT (two different systems, no
 * distributed transaction), so write-then-publish atomicity can only ever be bought by writing
 * the outbox row, exactly as `PostgresEventBus` already does. That holds identically whether the
 * configured backend is `postgres` or `nats`.
 *
 * What actually differs per backend is where the outbox RELAY (events/outbox-relay.ts) fans
 * relayed rows out to: pg-boss + SSE always; additionally NATS JetStream
 * (events/nats-fanout.ts) when `config.eventBus.backend === "nats"`. That selection is wired up
 * once at boot (main.ts) / per-test (test-support/harness.ts) by conditionally passing a
 * `NatsFanoutHandle` into `startOutboxRelay` — `eventBus` itself stays this same
 * `PostgresEventBus` singleton for every caller (graph/objects-repo.ts,
 * graph/relationships-repo.ts, ...) regardless of backend, so none of those call sites needed to
 * change.
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

/**
 * The one and only `EventBus` — every mutation publishes through this instance regardless of
 * `config.eventBus.backend`. See the interface doc comment above for why the NATS backend never
 * needed a second implementation here.
 */
export const eventBus: EventBus = new PostgresEventBus();
