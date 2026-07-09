import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./auth-context";
import { registryDetailKey, registryListKey } from "./query-client";
import { REGISTRIES } from "./registries";

export interface RelayedEvent {
  id: string;
  orgId: string;
  /** CloudEvents `type`, e.g. `scp.object.created` (events/outbox-repo.ts). */
  type: string;
  source: string;
  subject: string | null;
  data: unknown;
  createdAt: string;
}

const OBJECT_EVENT_TYPES = ["scp.object.created", "scp.object.updated", "scp.object.deleted"];

// ---------------------------------------------------------------------------------------------
// Tiny external store (React 18 `useSyncExternalStore`) for the dashboard's "last few SSE
// events" activity feed (components/ActivityFeed.tsx, BUILD_AND_TEST.md §8 M2 item 2's "small
// live activity feed"). Colocated here rather than a second `EventSource` connection, which
// would violate "exactly one EventSource per session" — this file already owns the one
// connection, so it also owns the tiny fan-out to whatever wants to render recent events.
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
 * Opens exactly one `EventSource` per authenticated session (`GET /events/stream` —
 * routes/events.ts, org-scoped) and invalidates the affected TanStack Query cache keys when a
 * `scp.object.*` event arrives — the live-update mechanism DESIGN.md §14 and
 * BUILD_AND_TEST.md §8 M2 DoD (a) test: "`scp service register` → service visible in UI within
 * one SSE tick", with NO page reload.
 *
 * `EventSource` is a raw browser primitive with no request-body/custom-header story other than
 * cookies — which is exactly consistent with this app's same-origin cookie auth (`withCredentials`
 * doesn't change same-origin cookie behavior; it's set for clarity/documentation). This file is
 * the ONE sanctioned exception to "apps/web never touches fetch/XHR/EventSource directly" —
 * eslint.config.mjs's apps/web block bans the `EventSource` global everywhere else, structurally,
 * not just by convention (see that file for why this is the one file it's allowed in).
 */
export function useEventStream(): void {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!user) return undefined;

    const source = new EventSource("/api/v1/events/stream", { withCredentials: true });

    const onObjectEvent = (event: MessageEvent<string>): void => {
      let payload: RelayedEvent | undefined;
      try {
        payload = JSON.parse(event.data) as RelayedEvent;
      } catch {
        return;
      }
      if (payload) pushActivityEvent(payload);

      // Object type -> registry basePath isn't encoded 1:1 on the wire event, so every registry
      // list is invalidated rather than resolving which one — list queries are cheap/cached, and
      // simplicity is this codebase's #1 decision priority (CLAUDE.md).
      for (const registry of REGISTRIES) {
        void queryClient.invalidateQueries({ queryKey: registryListKey(registry.basePath) });
        if (payload?.subject) {
          void queryClient.invalidateQueries({
            queryKey: registryDetailKey(registry.basePath, payload.subject)
          });
        }
      }
    };

    for (const type of OBJECT_EVENT_TYPES) {
      source.addEventListener(type, onObjectEvent);
    }

    return () => {
      for (const type of OBJECT_EVENT_TYPES) {
        source.removeEventListener(type, onObjectEvent);
      }
      source.close();
    };
  }, [user, queryClient]);
}
