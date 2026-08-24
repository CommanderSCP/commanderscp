import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RelayedEvent } from "@scp/sdk";
import { client } from "./client";
import { useAuth } from "./auth-context";
import { changeDetailKey, changeListKey, registryDetailKey, registryListKey } from "./query-client";
import { REGISTRIES } from "./registries";

export type { RelayedEvent };

const OBJECT_EVENT_TYPES = new Set([
  "scp.object.created",
  "scp.object.updated",
  "scp.object.deleted"
]);

// M3: `scp.change.transitioned` (coordination/transition.ts) fires on every guarded state change
// (propose/evaluate/coordinate/execute/validate/accept/cancel/rollback). It does NOT fire for
// intra-wave/target progress within a state (the reconciliation loop updates those rows directly,
// no outbox event) — change-detail.tsx additionally polls via `refetchInterval` to catch that.
const CHANGE_EVENT_TYPES = new Set(["scp.change.transitioned"]);

// M26.1 (proposal multi-region-instance-resilience.md §7.1 item 1): a synthetic frame the
// server-side bridge (apps/server/src/events/sse-bridge.ts) pushes to every already-connected
// client on its own LISTEN (re)connection — the stream is best-effort with no replay (ADR-0025
// D4), so this is the signal that some window of events may have been missed. Carries no useful
// payload; the response is a wholesale cache invalidation, same as a local stream reconnect below.
const RESYNC_EVENT_TYPE = "scp.sse.resync";

// ---------------------------------------------------------------------------------------------
// Tiny external store (React 18 `useSyncExternalStore`) for the dashboard's "last few SSE
// events" activity feed (components/ActivityFeed.tsx, BUILD_AND_TEST.md §8 M2 item 2's "small
// live activity feed"). Colocated here rather than a second subscription, which would violate
// "exactly one event stream per session" — this file already owns the one connection, so it also
// owns the tiny fan-out to whatever wants to render recent events.
// ---------------------------------------------------------------------------------------------

const MAX_ACTIVITY_EVENTS = 20;
let activityEvents: RelayedEvent[] = [];
const activityListeners = new Set<() => void>();

function pushActivityEvent(event: RelayedEvent): void {
  activityEvents = [event, ...activityEvents].slice(0, MAX_ACTIVITY_EVENTS);
  for (const listener of activityListeners) listener();
}

export function subscribeActivityEvents(listener: () => void): () => void {
  activityListeners.add(listener);
  return () => activityListeners.delete(listener);
}

export function getActivityEventsSnapshot(): RelayedEvent[] {
  return activityEvents;
}

/**
 * Opens exactly one live event stream per authenticated session (`GET /events/stream` —
 * routes/events.ts, org-scoped) and invalidates the affected TanStack Query cache keys when a
 * `scp.object.*` event arrives — the live-update mechanism DESIGN.md §14 and
 * BUILD_AND_TEST.md §8 M2 DoD (a) test: "`scp service register` → service visible in UI within
 * one SSE tick", with NO page reload.
 *
 * THROUGH THE SDK, like every other call this app makes. Until the SSE API-parity work this was
 * the app's one hand-built URL and one raw `EventSource` — the single exemption in the no-bypass
 * sweep (`apps/web/e2e/openapi-conformance.ts`) and the single hole named in ADR-0023, where
 * `JSON.parse(event.data) as RelayedEvent` cast raw network bytes to a locally-declared interface.
 * `client.events.stream()` is a generated operation: every frame is validated against the contract
 * schema before it reaches this file, and the reconnect/backoff/`Last-Event-ID` behaviour
 * `EventSource` supplied for free is now explicit and tested (packages/sdk/src/event-stream.ts,
 * event-stream.test.ts). Both exemptions are gone, not relocated.
 *
 * Dispatch is on `event.type` off the parsed envelope rather than per-type listeners, because the
 * stream is one typed async iterator rather than a DOM event target.
 */
export function useEventStream(): void {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!user) return undefined;

    const controller = new AbortController();

    const onObjectEvent = (payload: RelayedEvent): void => {
      // Object type -> registry basePath isn't encoded 1:1 on the wire event, so every registry
      // list is invalidated rather than resolving which one — list queries are cheap/cached, and
      // simplicity is this codebase's #1 decision priority (CLAUDE.md).
      for (const registry of REGISTRIES) {
        void queryClient.invalidateQueries({ queryKey: registryListKey(registry.basePath) });
        if (payload.subject) {
          void queryClient.invalidateQueries({
            queryKey: registryDetailKey(registry.basePath, payload.subject)
          });
        }
      }
    };

    const onChangeEvent = (payload: RelayedEvent): void => {
      void queryClient.invalidateQueries({ queryKey: changeListKey() });
      if (payload.subject) {
        void queryClient.invalidateQueries({ queryKey: changeDetailKey(payload.subject) });
      }
    };

    // M26.1 §7.1 item 1: wholesale invalidation on EVERY (re)connection, local or server-signalled
    // — see `RESYNC_EVENT_TYPE`'s doc comment for why both triggers exist independently. A blanket
    // `invalidateQueries()` rather than resolving which keys might be stale mirrors `onObjectEvent`
    // above: list/detail queries are cheap and cached, and simplicity is CLAUDE.md's #1 decision
    // priority.
    const resync = (): void => void queryClient.invalidateQueries();

    void (async () => {
      try {
        for await (const event of client.events.stream({
          signal: controller.signal,
          onOpen: () => undefined // MUTATION: dropped onOpen: resync
        })) {
          if (event.type === RESYNC_EVENT_TYPE) {
            resync();
            continue;
          }
          if (!OBJECT_EVENT_TYPES.has(event.type) && !CHANGE_EVENT_TYPES.has(event.type)) continue;
          pushActivityEvent(event);
          if (OBJECT_EVENT_TYPES.has(event.type)) onObjectEvent(event);
          else onChangeEvent(event);
        }
      } catch (error) {
        // The stream reconnects on its own; it only ever settles by abort (unmount/logout), so
        // reaching here at all is unexpected and must not take the app down with it.
        if (!controller.signal.aborted) console.error("event stream ended unexpectedly", error);
      }
    })();

    return () => controller.abort();
  }, [user, queryClient]);
}
