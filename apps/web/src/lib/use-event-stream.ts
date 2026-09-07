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

// M26.1 (proposal multi-region-instance-resilience.md §7.1 item 1). See docs/web.md §139.
const RESYNC_EVENT_TYPE = "scp.sse.resync";

// Tiny external store. See docs/web.md §140.

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

/** Opens exactly one live event stream per authenticated session. See docs/web.md §141. */
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

    // M26.1 §7.1 item 1: wholesale invalidation on EVERY. See docs/web.md §142.
    const resync = (): void => void queryClient.invalidateQueries();

    void (async () => {
      try {
        for await (const event of client.events.stream({
          signal: controller.signal,
          onOpen: resync
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
