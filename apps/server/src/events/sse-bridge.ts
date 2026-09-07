import { randomUUID } from "node:crypto";
import type pg from "pg";
import { type RelayedEvent } from "@scp/schemas";
import { sseHub } from "./sse-hub.js";
import { startReconnectingListenClient, type ListenClientHandle } from "./listen-client.js";

/** Must match outbox-relay.ts's publish channel — the two are never imported from each other
 *  (they can run in different processes) so this is the shared literal, not a shared constant. */
const SSE_NOTIFY_CHANNEL = "scp_sse_events";

/** Fed to `sseHub` on every LISTEN (re)connection so a locally-connected client resyncs through
 *  its query cache (ADR-0025 D4) — the stated catch-up mechanism for a gap this bridge cannot know
 *  the size of. `apps/web/src/lib/use-event-stream.ts` invalidates on this type. */
export const SSE_RESYNC_EVENT_TYPE = "scp.sse.resync";

/** RFC 4122 shape. See docs/events.md §57. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ceiling on concurrently-in-flight outbox fetches. See docs/events.md §58. */
const MAX_INFLIGHT_FETCHES = 512;

/** A bounded set of ids this process already delivered. See docs/events.md §59. */
const RECENT_DELIVERED_CAP = 1024;

interface OutboxRow {
  id: string;
  org_id: string;
  type: string;
  source: string;
  subject: string | null;
  data: unknown;
  created_at: Date;
}

export interface NotifyPointer {
  id: string;
  /** Non-authoritative delivery-org HINT (review finding F1). Used ONLY to skip work for orgs with
   *  no local subscriber; never used to route a published event — that comes from the fetched row. */
  orgHint: string | undefined;
}

/** The NOTIFY payload is a POINTER (review finding F1, M26-BUILD-STATUS.md): only `id` is read as
 *  authority, and only to look up the authoritative `outbox` row. `orgId` rides along as an
 *  untrusted hint. Everything is validated here so nothing malformed reaches the pool or a log.
 *  Exported for direct unit testing of the UUID gate (SEC-1 cheap-fetch leg / SEC-3 log injection). */
export function parsePointer(value: unknown): NotifyPointer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== "string" || !UUID_RE.test(id)) return undefined;
  const orgId = record.orgId;
  const orgHint = typeof orgId === "string" && UUID_RE.test(orgId) ? orgId : undefined;
  return { id, orgHint };
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

/** Fetches one outbox row by id. See docs/events.md §60. */
async function fetchOutboxEvent(pool: pg.Pool, id: string): Promise<RelayedEvent | undefined> {
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

/** Bridges the relay's notify channel into this process. See docs/events.md §61. */
export function startSseBridge(pool: pg.Pool, listenConnectionString: string): SseBridgeHandle {
  // Tracks every in-flight handleNotification() so stop() can await them before the caller tears
  // down the pool (review finding SSE-2 — mirrors outbox-relay.ts's `inFlight` discipline), and so
  // a NOTIFY flood cannot start unbounded fetches (SEC-1). A frame arriving past the cap is dropped.
  const inFlight = new Set<Promise<void>>();
  const recentlyDelivered = new Set<string>();

  function rememberDelivered(id: string): void {
    recentlyDelivered.add(id);
    if (recentlyDelivered.size > RECENT_DELIVERED_CAP) {
      const oldest = recentlyDelivered.values().next().value;
      if (oldest !== undefined) recentlyDelivered.delete(oldest);
    }
  }

  async function handleNotification(payload: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch (err) {
      console.error("[sse-bridge] NOTIFY payload was not valid JSON — dropped", err);
      return;
    }

    const pointer = parsePointer(parsed);
    if (!pointer) {
      // No UUID id → cannot back an outbox row. Nothing attacker-controlled is logged (SEC-3).
      console.error("[sse-bridge] NOTIFY payload carried no valid pointer id — dropped");
      return;
    }

    // Replay gate (SEC-2): an id this process already delivered is dropped before any pool work.
    if (recentlyDelivered.has(pointer.id)) return;

    // Work gate (SEC-1). See docs/events.md §62.
    if (pointer.orgHint !== undefined && !sseHub.activeOrgIds().includes(pointer.orgHint)) {
      return;
    }

    try {
      const event = await fetchOutboxEvent(pool, pointer.id);
      if (!event) {
        // Either a forged pointer (no outbox row ever existed — the F1 attack, neutralized here by
        // simply having nothing to deliver) or, in principle, a row this process cannot see. No
        // retry: ADR-0025's contract is "no replay" — the resync/cache-invalidation path recovers
        // a genuine miss. `pointer.id` is UUID-validated, so this interpolation is injection-safe.
        console.warn(
          `[sse-bridge] NOTIFY pointer ${pointer.id} resolves to no outbox row — dropped`
        );
        return;
      }
      // `event` is built exclusively from the fetched row: org routing, type, and body all come
      // from the authoritative outbox, never from the NOTIFY payload (F1).
      rememberDelivered(pointer.id);
      sseHub.publish(event);
    } catch (err) {
      console.error(`[sse-bridge] failed to fetch outbox row ${pointer.id}`, err);
    }
  }

  function dispatch(payload: string): void {
    if (inFlight.size >= MAX_INFLIGHT_FETCHES) {
      // Bounded backpressure under a NOTIFY flood (SEC-1). Dropping is contract-safe (no replay);
      // a resync recovers any legitimate frame caught in the flood.
      console.warn("[sse-bridge] in-flight fetch cap reached — dropping NOTIFY (best-effort)");
      return;
    }
    const call = handleNotification(payload).finally(() => {
      inFlight.delete(call);
    });
    inFlight.add(call);
  }

  const listenClient: ListenClientHandle = startReconnectingListenClient({
    connectionString: listenConnectionString,
    channels: [SSE_NOTIFY_CHANNEL],
    onError: (err) => console.error("[sse-bridge] LISTEN connection error", err),
    onNotification: (notification) => {
      if (notification.channel !== SSE_NOTIFY_CHANNEL || notification.payload === undefined) {
        return;
      }
      dispatch(notification.payload);
    },
    // Fires on the FIRST successful connection too. See docs/events.md §63.
    onReconnect: () => {
      for (const orgId of sseHub.activeOrgIds()) {
        sseHub.publish(makeResyncEvent(orgId));
      }
    }
  });

  return {
    async stop() {
      await listenClient.stop();
      // Await any handleNotification() still mid-fetch so a caller that closes the pool right after
      // stop() resolves cannot race a live query on it (SSE-2).
      await Promise.allSettled([...inFlight]);
    }
  };
}
