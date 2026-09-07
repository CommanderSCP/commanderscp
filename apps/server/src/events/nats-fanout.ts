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

/** NATS JetStream fan-out for the outbox relay. See docs/events.md §28. */

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

/** Connects to NATS and ensures the JetStream stream exists. See docs/events.md §29. */
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
