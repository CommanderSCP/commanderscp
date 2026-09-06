import pg from "pg";

const { Client } = pg;

export interface ListenNotification {
  channel: string;
  payload: string | undefined;
}

export interface ReconnectingListenClientOptions {
  connectionString: string;
  /** Channels this client subscribes to on every (re)connection. Static constants only — these
   *  are interpolated directly into `LISTEN <channel>`, which does not accept a bind parameter. */
  channels: string[];
  /** Fired for every NOTIFY delivered on any subscribed channel. */
  onNotification: (notification: ListenNotification) => void;
  /**
   * Fired after every successful (re)connection has re-issued every `LISTEN`, INCLUDING the very
   * first connection. A caller with nothing to catch up on (the outbox relay's wake listener —
   * its 1s poll fallback already covers a missed NOTIFY) can leave this unset; the SSE bridge
   * (proposal §7.1 item 1) uses it to broadcast a resync to locally-connected clients, since a gap
   * in this LISTEN connection is exactly a gap in what `sseHub` could have received.
   */
  onReconnect?: () => void;
  /** Logged, never thrown. Covers both a failed connection attempt and a runtime error on an
   *  already-established one. */
  onError?: (err: unknown) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * How long a connection must STAY up before the backoff is reset to its floor. Default 5000ms.
   * Without this, a connection that dies immediately after every connect (an on-path attacker
   * RST-ing the socket, review finding SEC-5) reset the backoff to the floor on each connect and
   * reconnected every `minBackoffMs` — each reconnect firing `onReconnect`, which on the SSE bridge
   * is a full unscoped cache-invalidation broadcast. Resetting only after the connection has proven
   * stable makes a flapping connection back off toward `maxBackoffMs` instead.
   */
  stabilityWindowMs?: number;
  /** Injectable for tests. Production default constructs a real `pg.Client`. */
  createClient?: (connectionString: string) => pg.Client;
}

export interface ListenClientHandle {
  /** Ends the current connection (if any), cancels any pending reconnect, and returns once both
   *  are done — deterministic the same way outbox-relay.ts's `stop()` is: a caller that tears down
   *  a dependent resource (e.g. the pool this client shares a connection string with)
   *  immediately afterward cannot race a reconnect attempt still in flight. */
  stop(): Promise<void>;
}

/**
 * A reusable reconnecting `LISTEN` client (proposal multi-region-instance-resilience.md §7.1 item
 * 1, fixing §4-A5): wraps one dedicated `pg.Client`. On a connection error OR an unexpected clean
 * end (`pg_terminate_backend` closes without necessarily emitting `error` first — both paths must
 * reconnect, which is why this listens for both events, not just `error`), it reconnects with
 * capped exponential backoff, re-issues every `LISTEN`, and calls `onReconnect`.
 *
 * BUG A5, restated: the old outbox relay held a raw `pg.Client` whose `on('error')` only logged
 * (events/outbox-relay.ts, pre-M26.1). Any Postgres blip — a restart, a failover, a load
 * balancer idle-timeout — silently and permanently demoted that process to its 1s poll fallback,
 * with nothing in the logs saying so was now the *only* thing driving it. This client is the fix,
 * shared by the relay's own wake listener and the new SSE bridge (events/sse-bridge.ts) rather
 * than fixed in one place and left broken in the other.
 */
export function startReconnectingListenClient(
  opts: ReconnectingListenClientOptions
): ListenClientHandle {
  const {
    connectionString,
    channels,
    onNotification,
    onReconnect,
    onError = (err) => console.error("[listen-client] error", err),
    minBackoffMs = 250,
    maxBackoffMs = 5_000,
    stabilityWindowMs = 5_000,
    createClient = (cs) => new Client({ connectionString: cs })
  } = opts;

  let stopped = false;
  let client: pg.Client | undefined;
  let backoffMs = minBackoffMs;
  let reconnectTimer: NodeJS.Timeout | undefined;
  // Set on a successful connect; fires once the connection has stayed up `stabilityWindowMs` and
  // resets the backoff to its floor. Cleared on disconnect BEFORE it fires, so a connection that
  // dies inside the window never gets the reset — its backoff keeps growing (SEC-5).
  let stabilityTimer: NodeJS.Timeout | undefined;
  // The in-flight connect() attempt, so `stop()` can await it — mirrors outbox-relay.ts's
  // `inFlight` discipline for the same reason: a caller that stops this and immediately tears
  // down something the connect attempt still touches (e.g. logging into a closed test harness)
  // must not race it.
  let connecting: Promise<void> = Promise.resolve();

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connecting = connect();
    }, delay);
  }

  /** Detaches every listener from `c` and ends it, then schedules a reconnect — but only if `c` is
   *  still the CURRENT client. Both `error` and `end` can fire for the same dead connection (a
   *  `pg_terminate_backend` has been observed to raise both), and without this guard the second
   *  firing would schedule a second, redundant reconnect on top of the first. */
  function onDisconnect(c: pg.Client): void {
    if (stopped || client !== c) return;
    client = undefined;
    if (stabilityTimer) {
      // Died before proving stable — do NOT reset the backoff; let it keep growing so a flapping
      // connection backs off toward the ceiling instead of hot-reconnecting (SEC-5).
      clearTimeout(stabilityTimer);
      stabilityTimer = undefined;
    }
    c.removeAllListeners();
    c.end().catch(() => undefined);
    scheduleReconnect();
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    const c = createClient(connectionString);
    client = c;
    c.on("error", (err) => {
      onError(err);
      onDisconnect(c);
    });
    c.on("end", () => onDisconnect(c));

    try {
      await c.connect();
      for (const channel of channels) {
        await c.query(`LISTEN ${channel}`);
      }
      c.on("notification", (msg) => {
        onNotification({ channel: msg.channel, payload: msg.payload });
      });
      // Reset the backoff only after the connection PROVES stable (SEC-5), not on connect itself —
      // otherwise a kill-immediately-after-connect loop pins reconnects (and their onReconnect
      // side effects) at the floor. A connection that dies inside the window clears this in
      // onDisconnect, so its backoff keeps growing toward the ceiling.
      stabilityTimer = setTimeout(() => {
        stabilityTimer = undefined;
        backoffMs = minBackoffMs;
      }, stabilityWindowMs);
      onReconnect?.();
    } catch (err) {
      onError(err);
      onDisconnect(c);
    }
  }

  connecting = connect();

  return {
    async stop() {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      if (stabilityTimer) {
        clearTimeout(stabilityTimer);
        stabilityTimer = undefined;
      }
      await connecting.catch(() => undefined);
      if (client) {
        const c = client;
        client = undefined;
        c.removeAllListeners();
        await c.end().catch(() => undefined);
      }
    }
  };
}
