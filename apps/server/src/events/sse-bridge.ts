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

/** RFC 4122 shape. Every legitimate pointer id is an `outbox.id` (a `uuid` column), so anything
 *  that is not UUID-shaped cannot back a row and is rejected BEFORE it touches the pool — this
 *  both denies a compromised DB login the cheapest amplification (a malformed id that would still
 *  cost a full connect+BEGIN+SET ROLE+SELECT before failing on `22P02`, review finding SEC-1) and
 *  removes the only untrusted string that ever reached a log line (CRLF log injection, SEC-3). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ceiling on concurrently-in-flight outbox fetches (review finding SEC-1). NOTIFY is not
 *  channel-access-controlled, so a compromised DB login can spam this channel; each frame would
 *  otherwise start an unbounded `pool.connect()` fetch. Past this many in flight, further frames
 *  are dropped — best-effort by ADR-0025's own contract, and a genuine miss is recovered by the
 *  resync/cache-invalidation path, never by unbounded queueing. Comfortably above any legitimate
 *  burst (only frames for a locally-subscribed org get this far). */
const MAX_INFLIGHT_FETCHES = 512;

/** Bounded set of ids already delivered by THIS process's bridge, newest-last (insertion order).
 *  Blunts replay (review finding SEC-2): a compromised `scp_pgboss` login can read real event ids
 *  out of `pgboss.job` and re-`NOTIFY` them to re-inject historical events into a live stream. The
 *  relay emits each outbox row's id exactly once (it selects `WHERE processed_at IS NULL` and
 *  stamps it in the same tx), so a legitimate event is never already in this set when it first
 *  arrives — only a replay is. Coverage is bounded to the most recent `RECENT_DELIVERED_CAP` ids;
 *  a replay of an id older than that window is not caught here (it is still bounded by the
 *  activeOrgIds pre-filter, the UUID gate, and the isolated pool). */
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

/**
 * Fetches one outbox row by id — the ONLY way an event ever enters this bridge (F1: the row is the
 * authority). Outbox rows are retained (ADR-0024: nothing deleted) and committed before the NOTIFY
 * is delivered, so a legitimate pointer always resolves; an id that resolves to no row is a
 * forgery and is dropped. Runs under the SAME narrowly-scoped `SET LOCAL ROLE scp_relay` escalation
 * the outbox relay itself uses (events/outbox-relay.ts's module doc — PR #4 security review,
 * CRITICAL 3). Extending that reviewed escalation to every SSE-serving process is deliberate, not
 * incidental (proposal §7.1 item 1): `scp_relay` is NOBYPASSRLS and granted ONLY SELECT+UPDATE on
 * `outbox` (drizzle/0003_runtime_roles.sql), so a process running this gains nothing beyond
 * reading rows the relay already fans out to it — the escalation's blast radius does not widen.
 */
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

/**
 * Bridges the outbox relay's `scp_sse_events` NOTIFY channel into THIS process's local `sseHub`
 * (proposal multi-region-instance-resilience.md §7.1 item 1, closing §4-A1). Start one of these in
 * every process that serves `GET /events/stream` — main.ts does, unconditionally, because
 * `app.listen()` is itself unconditional (every role serves the route; see main.ts's comment).
 *
 * `pool` should be a SMALL pool dedicated to this bridge, not the request-serving pool (review
 * finding SEC-1): NOTIFY is attacker-reachable, so the fetch load it drives must not be able to
 * starve request handlers or the relay. main.ts wires a `max: 2` pool for exactly this.
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

    // Work gate (SEC-1): if the frame names an org with no locally-connected SSE client, there is
    // nothing to deliver to on this process, so skip the fetch entirely. Safe against the no-replay
    // contract: a client that connects to that org later resyncs via its own stream `onOpen`. The
    // hint is untrusted, but using it ONLY to skip work cannot cause a wrong delivery — routing is
    // still the fetched row's own org. A frame with no usable hint falls through to the fetch.
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
        console.warn(`[sse-bridge] NOTIFY pointer ${pointer.id} resolves to no outbox row — dropped`);
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
    // Fires on the FIRST successful connection too. At boot `activeOrgIds()` is normally empty
    // (no client has connected yet), so this is a genuine no-op then; it starts doing real work
    // only once a reconnection follows a gap that may have dropped a NOTIFY. The reconnect RATE is
    // itself throttled by listen-client.ts's stability window (review finding SEC-5), so a flapping
    // LISTEN connection cannot turn this into a high-frequency cache-invalidation storm.
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
