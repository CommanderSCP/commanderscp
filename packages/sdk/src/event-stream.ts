import type { RelayedEvent } from "@scp/schemas";

/** `GET /events/stream` as a reconnecting async iterator. See docs/sdk.md §56. */

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
  /** Fires after every successful open, including the first. See docs/sdk.md §57. */
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
