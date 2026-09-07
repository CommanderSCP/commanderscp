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
  /** Fired after every successful. See docs/events.md §25. */
  onReconnect?: () => void;
  /** Logged, never thrown. Covers both a failed connection attempt and a runtime error on an
   *  already-established one. */
  onError?: (err: unknown) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** How long a connection must stay up before backoff resets. See docs/events.md §26. */
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

/** A reusable reconnecting `LISTEN` client. See docs/events.md §27. */
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
