import { EventEmitter } from "node:events";

export interface RelayedEvent {
  id: string;
  orgId: string;
  type: string;
  source: string;
  subject: string | null;
  data: unknown;
  createdAt: string;
}

/** In-process fan-out to this process's connected clients. See docs/events.md §64. */
class SseHub extends EventEmitter {
  publish(event: RelayedEvent): void {
    this.emit(event.orgId, event);
  }

  /** Org ids with at least one connected SSE client on THIS process right now. Used by the SSE
   *  bridge (events/sse-bridge.ts, M26.1) to broadcast a synthetic resync event to every org that
   *  could have missed something while its LISTEN connection to Postgres was down — `eventNames()`
   *  is exactly "the channels something is subscribed to" for an `EventEmitter` keyed this way. */
  activeOrgIds(): string[] {
    return this.eventNames().filter((name): name is string => typeof name === "string");
  }
}

export const sseHub = new SseHub();
sseHub.setMaxListeners(0); // unbounded concurrent SSE connections
