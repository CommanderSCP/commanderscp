import type pg from "pg";
import type PgBoss from "pg-boss";
import { DOMAIN_EVENTS_QUEUE } from "./pgboss.js";
import type { NatsFanoutHandle } from "./nats-fanout.js";
import { startReconnectingListenClient, type ListenClientHandle } from "./listen-client.js";

type Pool = pg.Pool;

const POLL_INTERVAL_MS = 1000; // air-gap-proof fallback (DESIGN.md §8) when NOTIFY is missed
const BATCH_SIZE = 100;

/** The channel events/sse-bridge.ts LISTENs on — never imported from each other (they can run in
 *  different processes), so this is the shared literal, not a shared constant. */
const SSE_NOTIFY_CHANNEL = "scp_sse_events";

export interface OutboxRelayHandle {
  stop(): Promise<void>;
}

interface OutboxRow {
  id: string;
  org_id: string;
  type: string;
  source: string;
  subject: string | null;
  data: unknown;
  created_at: Date;
}

/** Worker-side half of the transactional outbox (DESIGN.md §8). See docs/events.md §32. */
export function startOutboxRelay(
  runtimePool: Pool,
  listenConnectionString: string,
  boss: PgBoss,
  opts: {
    eventBusBackend: "postgres" | "nats";
    natsFanout?: NatsFanoutHandle;
    /** A post-commit hook handed the org ids a batch touched. See docs/events.md §33. */
    onEventsRelayed?: (orgIds: string[]) => void;
  }
): OutboxRelayHandle {
  const { eventBusBackend, natsFanout, onEventsRelayed } = opts;
  if (eventBusBackend === "nats" && !natsFanout) {
    throw new Error(
      "startOutboxRelay: eventBusBackend 'nats' requires a connected natsFanout handle — refusing " +
        "to start a relay that could mark NATS-bound events processed without ever publishing them"
    );
  }
  let stopped = false;
  // Tracks every relayOnce() call currently in flight. See docs/events.md §34.
  const inFlight = new Set<Promise<void>>();

  async function relayOnce(): Promise<void> {
    if (stopped) return;
    const client = await runtimePool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE scp_relay");
      const result = await client.query<OutboxRow>(
        `SELECT * FROM outbox WHERE processed_at IS NULL ORDER BY created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE]
      );
      // Defensive guard (see `inFlight` doc comment above). See docs/events.md §35.
      const rows = result?.rows ?? [];
      const relayedOrgIds = new Set<string>();
      for (const row of rows) {
        await boss.send(DOMAIN_EVENTS_QUEUE, {
          id: row.id,
          orgId: row.org_id,
          type: row.type,
          source: row.source,
          subject: row.subject,
          data: row.data
        });
        const relayedEvent = {
          id: row.id,
          orgId: row.org_id,
          type: row.type,
          source: row.source,
          subject: row.subject,
          data: row.data,
          createdAt: row.created_at.toISOString()
        };
        // SSE fan-out (M26.1 §7.1 item 1, revised by review finding F1). See docs/events.md §36.
        await client.query("SELECT pg_notify($1, $2)", [
          SSE_NOTIFY_CHANNEL,
          JSON.stringify({ id: row.id, orgId: row.org_id })
        ]);
        if (eventBusBackend === "nats") {
          // `natsFanout` is guaranteed defined here — asserted at construction above — so this can
          // never silently no-op the way the old `if (natsFanout)` check could.
          await natsFanout!.publish(relayedEvent);
        }
        await client.query(`UPDATE outbox SET processed_at = now() WHERE id = $1`, [row.id]);
        relayedOrgIds.add(row.org_id);
      }
      await client.query("COMMIT");
      // POST-COMMIT, fire-and-forget: notify the poke sender which orgs just produced events. Wrapped
      // so a hook throw can never affect the relay (the batch is already durably committed). Runs
      // OUTSIDE the `scp_relay` tx above — the hook does its own tenant-scoped peer lookups.
      if (onEventsRelayed && relayedOrgIds.size > 0) {
        try {
          onEventsRelayed([...relayedOrgIds]);
        } catch (err) {
          console.error(
            "[outbox-relay] onEventsRelayed hook threw (ignored — batch already committed)",
            err
          );
        }
      }
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.error("[outbox-relay] relay batch failed", err);
    } finally {
      client.release();
    }
  }

  /** Tracks each run so `stop()` can await work in flight. See docs/events.md §37. */
  function trigger(): void {
    if (stopped) return;
    const call = relayOnce().finally(() => {
      inFlight.delete(call);
    });
    inFlight.add(call);
  }

  // The wake LISTEN (§4-A5 fix). See docs/events.md §38.
  const wakeListener: ListenClientHandle = startReconnectingListenClient({
    connectionString: listenConnectionString,
    channels: ["scp_outbox_insert"],
    onNotification: () => trigger(),
    onReconnect: () => trigger(),
    onError: (err) => console.error("[outbox-relay] LISTEN connection error", err)
  });

  const timer = setInterval(() => trigger(), POLL_INTERVAL_MS);
  trigger();

  return {
    /** Stops the relay deterministically. See docs/events.md §39. */
    async stop() {
      stopped = true;
      clearInterval(timer);
      await wakeListener.stop();
      await Promise.allSettled(inFlight);
    }
  };
}
