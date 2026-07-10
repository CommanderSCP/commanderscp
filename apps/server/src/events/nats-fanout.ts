import { connect } from "@nats-io/transport-node";
import { headers as natsHeaders, nanos, type NatsConnection } from "@nats-io/nats-core";
import {
  jetstream,
  jetstreamManager,
  JetStreamApiError,
  JetStreamApiCodes,
  RetentionPolicy,
  StorageType,
  type JetStreamManager
} from "@nats-io/jetstream";
import type { RelayedEvent } from "./sse-hub.js";

/**
 * NATS JetStream fan-out for the outbox relay (DESIGN.md §8 "Scaling insurance" — NATS JetStream
 * `EventBus` implementation built early in MVP, M3). Design decision (see events/event-bus.ts's
 * doc comment for the full rationale): `EventBus.publish()` is UNCHANGED and identical for both
 * backends — it always writes the transactional outbox row, because write-then-publish atomicity
 * is a Postgres-transaction property no broker can join. What "NATS backend" actually means is
 * that `outbox-relay.ts`'s relay loop, after claiming an outbox row, ALSO republishes it to a
 * JetStream stream (in addition to its existing pg-boss + SSE fan-out) — this module is that
 * additional sink.
 *
 * Subject convention: `scp.events.<orgId>.<type>` on stream `SCP_EVENTS` (subjects `scp.events.>`).
 * Consumers can bind to `scp.events.>` for everything, `scp.events.<orgId>.>` for one org, or a
 * literal type suffix to filter further.
 *
 * Idempotency: the outbox row's `id` (a uuidv7, globally unique and monotonic) is passed as
 * `JetStreamPublishOptions.msgID`, which JetStream uses for its own broker-side de-duplication
 * within the stream's `duplicate_window` — belt-and-braces with the same id also traveling in the
 * message body and an `Scp-Event-Id` header, so subscribers can dedupe themselves even outside
 * that window (DESIGN.md §8: "at-least-once delivery; handlers are idempotent, keyed by event id").
 */

/** Exported for events/event-bus.integration.test.ts, which binds a real JetStream consumer to
 *  this stream to observe delivery/de-dup end to end rather than re-deriving the name. */
export const STREAM_NAME = "SCP_EVENTS";
const STREAM_SUBJECTS = ["scp.events.>"];
/** Generous relative to the relay's 1s poll/retry cadence — covers redelivery after a crash mid-batch. */
const DUPLICATE_WINDOW_MS = 2 * 60_000;
/** Informational retention only — the outbox table (not this stream) is the durable source of truth. */
const MAX_AGE_MS = 24 * 60 * 60_000;

export function eventSubject(orgId: string, type: string): string {
  return `scp.events.${orgId}.${type}`;
}

async function ensureEventStream(jsm: JetStreamManager): Promise<void> {
  try {
    await jsm.streams.info(STREAM_NAME);
  } catch (err) {
    const notFound =
      err instanceof JetStreamApiError && err.code === JetStreamApiCodes.StreamNotFound;
    if (!notFound) throw err;
    await jsm.streams.add({
      name: STREAM_NAME,
      subjects: STREAM_SUBJECTS,
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      duplicate_window: nanos(DUPLICATE_WINDOW_MS),
      max_age: nanos(MAX_AGE_MS)
    });
  }
}

export interface NatsFanoutHandle {
  /** Publishes one relayed outbox event to JetStream. Throws on failure — callers (outbox-relay.ts)
   *  must let that propagate so the outbox row stays unprocessed and is retried, exactly like a
   *  pg-boss `send` failure already does. */
  publish(event: RelayedEvent): Promise<void>;
  close(): Promise<void>;
}

/**
 * Connects to NATS and ensures the JetStream stream exists. Called once at boot (main.ts) when
 * `config.eventBus.backend === "nats"`, or per-test in the NATS-backend integration suite.
 * Deliberately fails loudly (throws) on an unreachable/misconfigured server rather than swallowing
 * the error — NATS is fully optional (unset backend never calls this), but once opted into, a
 * broken connection must not silently degrade to "events go nowhere" (task brief / DESIGN §8).
 */
export async function connectNatsFanout(url: string): Promise<NatsFanoutHandle> {
  const nc: NatsConnection = await connect({
    servers: url,
    name: "scp-outbox-relay",
    timeout: 5000
  });
  const jsm = await jetstreamManager(nc);
  await ensureEventStream(jsm);
  const js = jetstream(nc);

  return {
    async publish(event: RelayedEvent): Promise<void> {
      const h = natsHeaders();
      h.set("Scp-Event-Id", event.id);
      h.set("Scp-Event-Type", event.type);
      h.set("Scp-Org-Id", event.orgId);
      await js.publish(eventSubject(event.orgId, event.type), JSON.stringify(event), {
        msgID: event.id,
        headers: h
      });
    },
    async close(): Promise<void> {
      await nc.drain();
    }
  };
}
