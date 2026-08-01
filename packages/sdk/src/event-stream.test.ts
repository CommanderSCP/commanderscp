import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RelayedEvent } from "@scp/schemas";
import { ScpClient } from "./client.js";
import { resilientEventStream, type OpenEventStream } from "./event-stream.js";

/**
 * The SSE API-parity work's load-bearing risk, tested.
 *
 * Migrating `apps/web` off the browser's `EventSource` onto the generated SDK operation trades away
 * something `EventSource` gave for free: automatic reconnection. The generated `createSseClient`
 * reconnects only from its `catch` — a CLEAN server close (rolling restart, idle proxy hangup)
 * simply ends its iterator, and a UI built on the raw generated call would go silently, permanently
 * dead on the first orderly `scpd` restart with nothing appearing to be broken.
 *
 * So these tests drive the REAL path — real `ScpClient`, real generated `streamEvents`, real
 * `createSseClient`, real `fetch`, against a real loopback HTTP server that speaks the exact frame
 * format `apps/server/src/routes/events.ts` writes — and kill the connection BOTH ways.
 */

interface Connection {
  readonly res: ServerResponse;
  /** What the client sent to resume from, i.e. whether reconnection is contract-correct. */
  readonly lastEventId: string | undefined;
}

function frame(event: RelayedEvent): string {
  // Byte-identical to routes/events.ts's `send`.
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function anEvent(id: string, overrides: Partial<RelayedEvent> = {}): RelayedEvent {
  return {
    id,
    orgId: "org-1",
    type: "scp.object.created",
    source: "scp",
    subject: "11111111-1111-4111-8111-111111111111",
    data: { name: "checkout" },
    createdAt: "2026-08-01T12:00:00Z",
    ...overrides
  };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe("client.events.stream() — the live SSE channel through the generated SDK", () => {
  let server: Server;
  let client: ScpClient;
  let connections: Connection[];
  /** Non-SSE requests, so a test can prove the client did not fall back to a plain GET. */
  let otherRequests: string[];

  beforeEach(async () => {
    connections = [];
    otherRequests = [];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url !== "/api/v1/events/stream") {
        otherRequests.push(`${req.method ?? "?"} ${req.url ?? "?"}`);
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive"
      });
      res.write(": connected\n\n");
      const header = req.headers["last-event-id"];
      connections.push({ res, lastEventId: typeof header === "string" ? header : undefined });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    client = new ScpClient({ baseUrl: `http://127.0.0.1:${port}/api/v1` });
  });

  afterEach(async () => {
    for (const connection of connections) connection.res.socket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** The nth connection the server accepted, failing loudly rather than reading `undefined`. */
  function connectionAt(index: number): Connection {
    const connection = connections[index];
    if (!connection) throw new Error(`expected a connection at index ${index}`);
    return connection;
  }

  /** Starts consuming in the background; returns the collected events and a stop handle. */
  function consume(options: { maxConsecutiveFailures?: number } = {}): {
    received: RelayedEvent[];
    errors: unknown[];
    stop: () => void;
    done: Promise<unknown>;
  } {
    const received: RelayedEvent[] = [];
    const errors: unknown[] = [];
    const controller = new AbortController();
    const done = (async () => {
      for await (const event of client.events.stream({
        signal: controller.signal,
        // Real timers, just short ones — the backoff SCHEDULE is asserted separately, below.
        retryDelayMs: 5,
        maxRetryDelayMs: 20,
        onError: (error) => errors.push(error),
        ...options
      })) {
        received.push(event);
      }
      return "completed";
    })().catch((error: unknown) => error);
    return { received, errors, stop: () => controller.abort(), done };
  }

  it("yields events from the stream", async () => {
    const run = consume();
    await waitFor(() => connections.length === 1, "the first connection");
    connectionAt(0).res.write(frame(anEvent("evt-1")));

    await waitFor(() => run.received.length === 1, "the first event");
    expect(run.received[0]).toMatchObject({ id: "evt-1", type: "scp.object.created" });
    // It really went through the SSE operation, not some fallback request.
    expect(otherRequests).toEqual([]);

    run.stop();
    await run.done;
  });

  it("reconnects after the connection is KILLED mid-stream, resuming from Last-Event-ID", async () => {
    const run = consume();
    await waitFor(() => connections.length === 1, "the first connection");
    connectionAt(0).res.write(frame(anEvent("evt-1")));
    await waitFor(() => run.received.length === 1, "the first event");

    // An abrupt reset — the LB/pod-eviction case.
    connectionAt(0).res.socket?.destroy();

    await waitFor(() => connections.length === 2, "a reconnection after the kill");
    expect(connectionAt(1).lastEventId).toBe("evt-1");
    expect(run.errors.length).toBeGreaterThan(0);

    // And the reconnected stream is live, not a dangling socket.
    connectionAt(1).res.write(frame(anEvent("evt-2")));
    await waitFor(() => run.received.length === 2, "an event on the reconnected stream");
    expect(run.received.map((e) => e.id)).toEqual(["evt-1", "evt-2"]);

    run.stop();
    await run.done;
  });

  it("reconnects after the server closes the stream CLEANLY — what EventSource did for free", async () => {
    // THE REGRESSION THIS WHOLE FILE EXISTS FOR. `createSseClient` treats a graceful end-of-body as
    // "the stream finished" and stops. Consuming it directly would leave the UI permanently silent
    // after any orderly restart, with no error anywhere.
    const run = consume();
    await waitFor(() => connections.length === 1, "the first connection");
    connectionAt(0).res.write(frame(anEvent("evt-1")));
    await waitFor(() => run.received.length === 1, "the first event");

    connectionAt(0).res.end();

    await waitFor(() => connections.length === 2, "a reconnection after the clean close");
    expect(connectionAt(1).lastEventId).toBe("evt-1");

    connectionAt(1).res.write(frame(anEvent("evt-2")));
    await waitFor(() => run.received.length === 2, "an event on the reconnected stream");

    run.stop();
    await run.done;
  });

  it("reconnects even when a connection closes before delivering anything", async () => {
    // The very first connection dying means there is no `Last-Event-ID` yet — a path that a
    // reconnect keyed on "we have resumed state" would skip.
    const run = consume();
    await waitFor(() => connections.length === 1, "the first connection");
    connectionAt(0).res.end();

    await waitFor(() => connections.length === 2, "a reconnection with no prior event");
    expect(connectionAt(1).lastEventId).toBeUndefined();

    connectionAt(1).res.write(frame(anEvent("evt-1")));
    await waitFor(() => run.received.length === 1, "the first event, after the reconnect");

    run.stop();
    await run.done;
  });

  it("stops on abort and does NOT reconnect", async () => {
    const run = consume();
    await waitFor(() => connections.length === 1, "the first connection");
    connectionAt(0).res.write(frame(anEvent("evt-1")));
    await waitFor(() => run.received.length === 1, "the first event");

    run.stop();
    expect(await run.done).toBe("completed");

    // A reconnect loop that ignored the signal would reopen here; give it ample room to misbehave.
    connectionAt(0).res.end();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(connections).toHaveLength(1);
  });

  it("VALIDATES each frame against the contract — a malformed event is never yielded", async () => {
    // Proves the parity claim is real rather than cosmetic: the generated operation carries a
    // `responseValidator` and `createSseClient` awaits it per frame. Before this work the UI cast
    // raw bytes (`JSON.parse(event.data) as RelayedEvent`) — ADR-0023's named hole.
    const run = consume();
    await waitFor(() => connections.length === 1, "the first connection");
    const malformed = { ...anEvent("evt-bad"), id: 42 } as unknown as RelayedEvent;
    connectionAt(0).res.write(frame(malformed));

    await waitFor(() => run.errors.length > 0, "a validation failure");
    expect(run.received).toEqual([]);

    run.stop();
    await run.done;
  });
});

describe("resilientEventStream — the reconnect policy itself", () => {
  /** A fake connection source, so the backoff SCHEDULE can be asserted without real waiting. */
  function fakeOpen(scripts: Array<RelayedEvent[] | Error>): {
    open: OpenEventStream;
    headers: Array<Record<string, string> | undefined>;
  } {
    const headers: Array<Record<string, string> | undefined> = [];
    let call = 0;
    const open: OpenEventStream = async ({ headers: sent, onError }) => {
      headers.push(sent);
      const script = scripts[Math.min(call, scripts.length - 1)] ?? [];
      call++;
      return {
        stream: (async function* () {
          if (script instanceof Error) {
            onError(script);
            return;
          }
          for (const event of script) yield event;
        })()
      };
    };
    return { open, headers };
  }

  function anEventNamed(id: string): RelayedEvent {
    return {
      id,
      orgId: "org-1",
      type: "scp.change.transitioned",
      source: "scp",
      subject: null,
      data: {},
      createdAt: "2026-08-01T12:00:00Z"
    };
  }

  it("backs off exponentially while reconnects deliver nothing, and caps", async () => {
    const delays: number[] = [];
    const { open } = fakeOpen([new Error("boom")]);
    const iterator = resilientEventStream(open, {
      retryDelayMs: 10,
      maxRetryDelayMs: 40,
      maxConsecutiveFailures: 5,
      sleep: async (ms) => {
        delays.push(ms);
      }
    });

    await expect(async () => {
      for await (const _event of iterator) {
        // never reached — every connection fails
      }
    }).rejects.toThrow("boom");

    // 1st reconnect at the base delay, then doubling, then pinned at the ceiling.
    expect(delays).toEqual([10, 20, 40, 40, 40]);
  });

  it("RESETS the backoff after a connection that delivered events", async () => {
    const delays: number[] = [];
    const { open } = fakeOpen([
      new Error("boom"),
      new Error("boom"),
      [anEventNamed("evt-1")],
      new Error("boom")
    ]);
    const received: RelayedEvent[] = [];

    await expect(async () => {
      for await (const event of resilientEventStream(open, {
        retryDelayMs: 10,
        maxRetryDelayMs: 1_000,
        maxConsecutiveFailures: 2,
        sleep: async (ms) => {
          delays.push(ms);
        }
      })) {
        received.push(event);
      }
    }).rejects.toThrow("boom");

    expect(received.map((e) => e.id)).toEqual(["evt-1"]);
    // 10 (1st failure) → 20 (2nd, escalating) → THEN the productive connection, after which the
    // wait drops back to the base 10 and the escalation starts over: 10 → 20 → give up.
    // Without the reset, index 2 would be 40 and a long-lived stream would drift toward the
    // ceiling forever after one bad afternoon.
    expect(delays).toEqual([10, 20, 10, 10, 20]);
  });

  it("resumes with Last-Event-ID from the LAST event actually yielded", async () => {
    const { open, headers } = fakeOpen([
      [anEventNamed("evt-1"), anEventNamed("evt-2")],
      [anEventNamed("evt-3")]
    ]);
    const received: RelayedEvent[] = [];
    for await (const event of resilientEventStream(open, {
      maxConsecutiveFailures: 0,
      sleep: async () => {}
    })) {
      received.push(event);
      if (received.length === 3) break;
    }

    expect(headers[0]).toBeUndefined();
    expect(headers[1]).toEqual({ "Last-Event-ID": "evt-2" });
  });

  it("aborts the in-flight connection when the CONSUMER stops iterating", async () => {
    // A consumer that `break`s (React unmount, route change) must not leave the socket open.
    let connectionSignal: AbortSignal | undefined;
    const open: OpenEventStream = async ({ signal }) => {
      connectionSignal = signal;
      return {
        stream: (async function* () {
          yield anEventNamed("evt-1");
          await new Promise(() => {}); // hangs, like a live stream
        })()
      };
    };

    for await (const _event of resilientEventStream(open, { sleep: async () => {} })) {
      break;
    }

    expect(connectionSignal?.aborted).toBe(true);
  });
});
