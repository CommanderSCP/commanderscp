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
 * In-process fan-out to this process's connected `/events/stream` SSE clients (DESIGN.md §8
 * "SSE — grafted: live UI/CLI updates"). One event listener per connected org (`EventEmitter`
 * channel keyed by `orgId`), so a client only ever receives its own org's events.
 *
 * THAT IS THE TENANCY BOUNDARY AND ONLY THE TENANCY BOUNDARY. This hub knows nothing about RBAC:
 * an `orgId` channel does not distinguish an org-root Owner from a principal with zero role
 * bindings, and it never did. The RBAC boundary immediately below it — `object:read` at each
 * event's `subject`, so a Viewer bound at one service sees that subtree and not the org — is
 * enforced per frame, per connection, at fan-out in routes/events.ts. Read that file's module doc
 * before changing anything here: the sentence above used to be the only statement of what this
 * channel key buys, and it was read as evidence that the stream was authorized when it was merely
 * tenant-scoped.
 *
 * A publisher into this hub must therefore assume its event reaches every connected client of the
 * org and rely on the route's gate to withhold it — `publish` is not a delivery decision.
 *
 * SINCE M26.1 (proposal multi-region-instance-resilience.md §7.1 item 1, closing §4-A1): the only
 * publisher into this is events/sse-bridge.ts, in THIS process, fed by a Postgres NOTIFY the
 * outbox relay issues from wherever IT happens to be running. The relay itself no longer calls
 * `publish` directly — under the default chart topology (api and worker are separate pods) that
 * direct call could never have reached the SSE-serving process's hub anyway; NOTIFY is what
 * crosses the process boundary.
 */
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
