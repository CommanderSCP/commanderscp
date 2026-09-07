// @vitest-environment happy-dom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { RelayedEvent } from "@scp/sdk";
import { render } from "../test-support/render-dom";

/** The event stream's reconnect behaviour, as the hook sees. See docs/web.md §136. */

const OWN_DOMAIN_USER = {
  userId: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  orgName: "acme",
  username: "admin",
  subjectObjectId: "33333333-3333-4333-8333-333333333333",
  instanceRole: "commander" as const
};

/** A push-controlled async iterator standing in for one real SSE connection. */
class ControllableStream {
  private readonly queue: RelayedEvent[] = [];
  private waiters: ((result: IteratorResult<RelayedEvent>) => void)[] = [];

  push(event: RelayedEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  [Symbol.asyncIterator](): AsyncIterator<RelayedEvent> {
    return {
      next: (): Promise<IteratorResult<RelayedEvent>> => {
        const queued = this.queue.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        return new Promise((resolve) => this.waiters.push(resolve));
      }
    };
  }
}

let streams: ControllableStream[] = [];
let onOpenCalls = 0;

vi.mock("./client", () => ({
  client: {
    // AuthProvider's own dependency — resolved immediately so `useEventStream`'s `if (!user)
    // return` guard clears without a real login.
    auth: { me: async () => OWN_DOMAIN_USER },
    events: {
      stream: (options: { onOpen?: () => void }) => {
        const s = new ControllableStream();
        streams.push(s);
        // Mirrors packages/sdk/src/event-stream.ts's `resilientEventStream`: `onOpen` fires on
        // every successful `open()`, BEFORE any event is read — including the very first
        // connection this mock ever makes.
        onOpenCalls++;
        options.onOpen?.();
        return (async function* () {
          for await (const event of s) yield event;
        })();
      }
    }
  }
}));

const { AuthProvider } = await import("./auth-context");
const { useEventStream } = await import("./use-event-stream");

function resyncEvent(): RelayedEvent {
  return {
    id: "resync-probe",
    orgId: OWN_DOMAIN_USER.orgId,
    type: "scp.sse.resync",
    source: "scp",
    subject: null,
    data: {},
    createdAt: new Date().toISOString()
  };
}

function Host(): null {
  useEventStream();
  return null;
}

/** One flush of pending microtasks/timers inside `act`, mirroring the idiom every other `apps/web`
 *  DOM test in this tree uses (e.g. routes/outpost-configuration-precondition.test.tsx). */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
}

async function waitUntil(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function renderHost(queryClient: QueryClient) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Host />
      </AuthProvider>
    </QueryClientProvider>
  );
  await waitUntil(() => streams.length > 0, "useEventStream to open a connection");
  return view;
}

describe("useEventStream: cache invalidation on the two catch-up triggers (M26.1)", () => {
  it("invalidates the ENTIRE query cache when a scp.sse.resync frame arrives on the stream", async () => {
    streams = [];
    onOpenCalls = 0;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["probe"], "fresh");

    const view = await renderHost(queryClient);
    // The mount's own `onOpen`. See docs/web.md §137.
    await waitUntil(
      () => queryClient.getQueryState(["probe"])?.isInvalidated === true,
      "the initial onOpen invalidation to land, before it is reset below"
    );
    queryClient.setQueryData(["probe"], "fresh-again");
    expect(queryClient.getQueryState(["probe"])?.isInvalidated).toBe(false);

    act(() => {
      streams[0]!.push(resyncEvent());
    });

    await waitUntil(
      () => queryClient.getQueryState(["probe"])?.isInvalidated === true,
      "the probe query to be invalidated by the scp.sse.resync frame"
    );

    view.unmount();
  });

  it("invalidates the query cache on stream (re)establishment ITSELF, with no event ever delivered", async () => {
    streams = [];
    onOpenCalls = 0;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["probe"], "fresh");

    const view = await renderHost(queryClient);

    // The mock's open callback already fired synchronously. See docs/web.md §138.
    expect(onOpenCalls).toBe(1);
    await waitUntil(
      () => queryClient.getQueryState(["probe"])?.isInvalidated === true,
      "the probe query to be invalidated by the stream's own (re)establishment"
    );

    view.unmount();
  });
});
