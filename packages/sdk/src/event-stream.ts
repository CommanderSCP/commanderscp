import type { RelayedEvent } from "@scp/schemas";

/**
 * `GET /events/stream` as a reconnecting async iterator — the SDK-side half of the SSE API-parity
 * work (`apps/server/src/routes/events.ts`).
 *
 * WHY THIS FILE EXISTS AT ALL. The generated operation (`streamEvents`) is a real, contract-derived
 * operation with a real `responseValidator`, and the generated `createSseClient` already parses
 * frames and tracks `Last-Event-ID`. What it does NOT do is what the browser's `EventSource` gave
 * consumers for free: reconnect after the server ends the response CLEANLY. `createSseClient`
 * retries only from its `catch` — a stream that reaches `done` (a graceful close: a rolling
 * restart, an idle proxy hanging up, a `scpd` redeploy) exits its loop and the iterator simply
 * finishes. A UI that migrated off `EventSource` onto the raw generated call would therefore go
 * permanently silent on the first orderly server restart, and nothing would look broken.
 *
 * So the reconnect policy is owned HERE, in one place, instead of half-here and half-inside the
 * generated retry loop: each connection is opened with `sseMaxRetryAttempts: 1` (see
 * `client.ts`), which reduces the generated client to "one attempt, then finish", and this
 * generator decides — for both the error and the clean-close case — whether and when to reopen.
 * One policy, one place, and testable: `event-stream.test.ts` kills connections mid-stream, closes
 * them cleanly, and asserts the resumption in each case.
 *
 * Semantics deliberately match `EventSource`: reconnect forever by default, always wait at least
 * `retryDelayMs` before reopening (so a server that instantly closes cannot be hot-looped),
 * exponentially back off while reconnects keep failing to deliver anything, and resume with
 * `Last-Event-ID` set to the last event actually yielded.
 */

export interface EventStreamOptions {
  /** Ends the stream (and aborts the in-flight connection) when aborted. */
  signal?: AbortSignal;
  /** Base delay before reopening. Also the floor between any two connections. Default 3000ms. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  /**
   * Give up after this many consecutive reconnects that delivered no event, rethrowing the last
   * error. Default: never give up — `EventSource` parity.
   */
  maxConsecutiveFailures?: number;
  /** Called once per dropped connection. The stream reconnects regardless; this is for logging. */
  onError?: (error: unknown) => void;
  /**
   * Called after every successful `open()` call, before any event is read — INCLUDING the first
   * connection, not just reconnects. Distinct from `onError`: this fires on success.
   *
   * M26.1 (proposal multi-region-instance-resilience.md §7.1 item 1): the server-side bridge
   * broadcasts a synthetic `scp.sse.resync` frame to already-connected clients on its own
   * reconnect, but a LOCAL reconnect here can happen without one — a network blip between the
   * browser and its api pod, say, that never touched the bridge's own LISTEN connection. Both
   * signals drive the same query-cache invalidation in `apps/web/src/lib/use-event-stream.ts`;
   * this is the leg the server-pushed frame cannot cover by itself.
   */
  onOpen?: () => void;
  /** Injectable for tests — the production path is `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Opens ONE connection and resolves to its (non-reconnecting) frame iterator. */
export type OpenEventStream = (init: {
  signal: AbortSignal;
  /** Set from the last yielded event's id on every reconnect; absent on the first connection. */
  headers?: Record<string, string>;
  /** Invoked by the underlying client when a connection fails rather than closing cleanly. */
  onError: (error: unknown) => void;
}) => Promise<{ stream: AsyncIterable<RelayedEvent> }>;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function* resilientEventStream(
  open: OpenEventStream,
  options: EventStreamOptions = {}
): AsyncGenerator<RelayedEvent, void, void> {
  const {
    signal,
    retryDelayMs = 3_000,
    maxRetryDelayMs = 30_000,
    maxConsecutiveFailures,
    onError,
    onOpen,
    sleep = defaultSleep
  } = options;

  let lastEventId: string | undefined;
  /** Reconnects since the last connection that actually delivered an event — drives the backoff. */
  let barrenReconnects = 0;

  while (!signal?.aborted) {
    const connection = new AbortController();
    const propagateAbort = (): void => connection.abort();
    signal?.addEventListener("abort", propagateAbort);

    let error: unknown;
    let delivered = false;

    try {
      const { stream } = await open({
        signal: connection.signal,
        headers: lastEventId === undefined ? undefined : { "Last-Event-ID": lastEventId },
        // The generated client reports a failed connection through a callback rather than by
        // throwing (it owns the read loop), so a drop mid-stream arrives here, not in `catch`.
        onError: (e) => {
          error = e;
        }
      });
      onOpen?.();
      for await (const event of stream) {
        delivered = true;
        lastEventId = event.id;
        yield event;
      }
    } catch (e) {
      error = e;
    } finally {
      signal?.removeEventListener("abort", propagateAbort);
      // Also runs when the CONSUMER stops iterating: closing this generator must not leave the
      // underlying HTTP connection open.
      connection.abort();
    }

    if (signal?.aborted) break;

    if (error !== undefined) onError?.(error);
    barrenReconnects = delivered ? 0 : barrenReconnects + 1;

    if (maxConsecutiveFailures !== undefined && barrenReconnects > maxConsecutiveFailures) {
      if (error !== undefined) throw error;
      return;
    }

    // `2 ** 0` on the first reconnect and after any productive connection — i.e. the base delay,
    // never zero.
    await sleep(Math.min(retryDelayMs * 2 ** Math.max(0, barrenReconnects - 1), maxRetryDelayMs));
  }
}
