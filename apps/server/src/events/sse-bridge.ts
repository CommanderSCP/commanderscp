import { randomUUID } from "node:crypto";
import type pg from "pg";
import { RelayedEventSchema, type RelayedEvent } from "@scp/schemas";
import { sseHub } from "./sse-hub.js";
import { startReconnectingListenClient, type ListenClientHandle } from "./listen-client.js";

/** Must match outbox-relay.ts's publish channel — the two are never imported from each other
 *  (they can run in different processes) so this is the shared literal, not a shared constant. */
const SSE_NOTIFY_CHANNEL = "scp_sse_events";

/** Fed to `sseHub` on every LISTEN (re)connection so a locally-connected client resyncs through
 *  its query cache (ADR-0025 D4) — the stated catch-up mechanism for a gap this bridge cannot know
 *  the size of. `apps/web/src/lib/use-event-stream.ts` invalidates on this type. */
export const SSE_RESYNC_EVENT_TYPE = "scp.sse.resync";

interface OutboxRow {
  id: string;
  org_id: string;
  type: string;
  source: string;
  subject: string | null;
  data: unknown;
  created_at: Date;
}

interface OversizedMarker {
  id: string;
  orgId: string;
  oversized: true;
}

function isOversizedMarker(value: unknown): value is OversizedMarker {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.oversized === true && typeof v.id === "string" && typeof v.orgId === "string";
}

/** A schema-valid `RelayedEvent` (ADR-0023's per-frame validation must pass unchanged) carrying no
 *  real payload — just the signal "something may have happened while you weren't listening". */
function makeResyncEvent(orgId: string): RelayedEvent {
  return {
    id: randomUUID(),
    orgId,
    type: SSE_RESYNC_EVENT_TYPE,
    source: "scp",
    subject: null,
    data: {},
    createdAt: new Date().toISOString()
  };
}

/**
 * Fetches one oversized outbox row by id, under the SAME narrowly-scoped `SET LOCAL ROLE
 * scp_relay` escalation the outbox relay itself uses (events/outbox-relay.ts's module doc — PR #4
 * security review, CRITICAL 3). Extending that reviewed escalation to every SSE-serving process is
 * deliberate, not incidental (proposal §7.1 item 1): `scp_relay` is NOBYPASSRLS and granted ONLY
 * SELECT+UPDATE on `outbox` (drizzle/0003_runtime_roles.sql), so a process running this gains
 * nothing beyond re-reading a row it could already have received whole over the same NOTIFY
 * channel had it merely been small enough — the escalation's blast radius does not widen.
 */
async function fetchOversizedEvent(pool: pg.Pool, id: string): Promise<RelayedEvent | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE scp_relay");
    const result = await client.query<OutboxRow>(
      `SELECT id, org_id, type, source, subject, data, created_at FROM outbox WHERE id = $1`,
      [id]
    );
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      orgId: row.org_id,
      type: row.type,
      source: row.source,
      subject: row.subject,
      data: row.data,
      createdAt: row.created_at.toISOString()
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export interface SseBridgeHandle {
  stop(): Promise<void>;
}

/**
 * Bridges the outbox relay's `scp_sse_events` NOTIFY channel into THIS process's local `sseHub`
 * (proposal multi-region-instance-resilience.md §7.1 item 1, closing §4-A1). Start one of these in
 * every process that serves `GET /events/stream` — main.ts does, unconditionally, because
 * `app.listen()` is itself unconditional (every role serves the route; see main.ts's comment).
 *
 * Postgres NOTIFY is transactional (delivered on COMMIT, atomic with the relay's batch), so a
 * subscriber here sees exactly the events the relay actually committed, in commit order per
 * channel — but it is still best-effort with no replay (ADR-0025 D4): a NOTIFY delivered while
 * this process's LISTEN connection is down is simply gone. That is why every (re)connection,
 * INCLUDING the first, broadcasts a resync event to every org this process currently has a
 * connected SSE client for (`sseHub.activeOrgIds()`) — the query-cache invalidation it triggers
 * (apps/web/src/lib/use-event-stream.ts) is the actual catch-up mechanism, not this bridge.
 */
export function startSseBridge(pool: pg.Pool, listenConnectionString: string): SseBridgeHandle {
  async function handleNotification(payload: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (err) {
      console.error("[sse-bridge] NOTIFY payload was not valid JSON — dropped", err);
      return;
    }

    if (isOversizedMarker(parsed)) {
      try {
        const event = await fetchOversizedEvent(pool, parsed.id);
        if (!event) {
          // Best-effort, no retry (ADR-0025's contract is "no replay" — the resync/cache-
          // invalidation path is what actually recovers a miss like this one).
          console.warn(`[sse-bridge] oversized outbox row ${parsed.id} not found — dropped`);
          return;
        }
        sseHub.publish(event);
      } catch (err) {
        console.error(`[sse-bridge] failed to fetch oversized outbox row ${parsed.id}`, err);
      }
      return;
    }

    const result = RelayedEventSchema.safeParse(parsed);
    if (!result.success) {
      console.error(
        "[sse-bridge] NOTIFY payload failed RelayedEventSchema validation — dropped",
        result.error
      );
      return;
    }
    sseHub.publish(result.data);
  }

  const listenClient: ListenClientHandle = startReconnectingListenClient({
    connectionString: listenConnectionString,
    channels: [SSE_NOTIFY_CHANNEL],
    onError: (err) => console.error("[sse-bridge] LISTEN connection error", err),
    onNotification: (notification) => {
      if (notification.channel !== SSE_NOTIFY_CHANNEL || notification.payload === undefined) {
        return;
      }
      void handleNotification(notification.payload);
    },
    // Fires on the FIRST successful connection too. At boot `activeOrgIds()` is normally empty
    // (no client has connected yet), so this is a genuine no-op then; it starts doing real work
    // only once a reconnection follows a gap that may have dropped a NOTIFY.
    onReconnect: () => {
      for (const orgId of sseHub.activeOrgIds()) {
        sseHub.publish(makeResyncEvent(orgId));
      }
    }
  });

  return {
    async stop() {
      await listenClient.stop();
    }
  };
}
