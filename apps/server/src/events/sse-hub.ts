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

/**
 * In-process fan-out from the worker's outbox relay to connected `/events/stream` SSE clients
 * (DESIGN.md §8 "SSE — grafted: live UI/CLI updates"). One event listener per connected org
 * (`EventEmitter` channel keyed by `orgId`), so a client only ever receives its own org's events
 * even though the relay itself processes every org's outbox rows.
 */
class SseHub extends EventEmitter {
  publish(event: RelayedEvent): void {
    this.emit(event.orgId, event);
  }
}

export const sseHub = new SseHub();
sseHub.setMaxListeners(0); // unbounded concurrent SSE connections
