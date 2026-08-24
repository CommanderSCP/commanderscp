import { EventEmitter } from "node:events";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startReconnectingListenClient } from "./listen-client.js";

/**
 * A fake `pg.Client` that connects successfully and can be "killed" on demand by emitting `end`.
 * `connect`/`query`/`end` resolve on the microtask queue so `advanceTimersByTimeAsync` flushes them.
 */
class FakeClient extends EventEmitter {
  connect = vi.fn(async () => undefined);
  query = vi.fn(async () => ({ rows: [] }));
  end = vi.fn(async () => undefined);
}

/**
 * SEC-5: the reconnect backoff must NOT reset to its floor on connect — only after the connection
 * has stayed up `stabilityWindowMs`. Otherwise a connection killed immediately after every connect
 * reconnects at the floor forever, and each reconnect fires `onReconnect` (on the SSE bridge, a
 * full unscoped cache-invalidation broadcast). This test flaps the connection inside the stability
 * window and asserts the inter-reconnect delay GROWS instead of pinning at the floor.
 */
describe("listen-client — backoff stability window (SEC-5)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not reset the backoff for a connection that dies inside the stability window", async () => {
    const created: FakeClient[] = [];
    const handle = startReconnectingListenClient({
      connectionString: "postgres://unused",
      channels: ["ch"],
      onNotification: () => undefined,
      onError: () => undefined,
      minBackoffMs: 250,
      maxBackoffMs: 5000,
      stabilityWindowMs: 5000,
      createClient: () => {
        const c = new FakeClient();
        created.push(c);
        return c as unknown as pg.Client;
      }
    });

    // First connection establishes.
    await vi.advanceTimersByTimeAsync(0);
    expect(created).toHaveLength(1);

    // Kill it well inside the 5s stability window — the backoff must NOT have reset.
    created[0]!.emit("end");
    // Reconnect #2 is scheduled at the floor (250ms) for the first retry.
    await vi.advanceTimersByTimeAsync(249);
    expect(created).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(created).toHaveLength(2);

    // Kill #2, again inside the window. THE MUTATION-PROVING STEP: if the backoff had reset on
    // connect, the next retry would again be 250ms. It must instead have grown to 500ms.
    created[1]!.emit("end");
    await vi.advanceTimersByTimeAsync(250);
    expect(created, "reconnect delay must have grown past the floor, not reset on connect").toHaveLength(
      2
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(created).toHaveLength(3);

    await handle.stop();
  });

  it("resets the backoff to the floor once a connection proves stable", async () => {
    const created: FakeClient[] = [];
    const handle = startReconnectingListenClient({
      connectionString: "postgres://unused",
      channels: ["ch"],
      onNotification: () => undefined,
      onError: () => undefined,
      minBackoffMs: 250,
      maxBackoffMs: 5000,
      stabilityWindowMs: 5000,
      createClient: () => {
        const c = new FakeClient();
        created.push(c);
        return c as unknown as pg.Client;
      }
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(created).toHaveLength(1);

    // Let the first connection stay up past the stability window, then kill it: the retry should be
    // back at the floor (250ms), proving a healthy connection's later blip still reconnects fast.
    await vi.advanceTimersByTimeAsync(5000);
    created[0]!.emit("end");
    await vi.advanceTimersByTimeAsync(250);
    expect(created).toHaveLength(2);

    await handle.stop();
  });
});
