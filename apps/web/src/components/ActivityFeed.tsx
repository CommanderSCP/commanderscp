import { useSyncExternalStore } from "react";
import { getActivityEventsSnapshot, subscribeActivityEvents } from "../lib/use-event-stream";

const EVENT_LABELS: Record<string, string> = {
  "scp.object.created": "created",
  "scp.object.updated": "updated",
  "scp.object.deleted": "deleted"
};

/** Dashboard's "last few SSE events" live feed (BUILD_AND_TEST.md §8 M2 item 2). */
export function ActivityFeed(): React.JSX.Element {
  const events = useSyncExternalStore(subscribeActivityEvents, getActivityEventsSnapshot);

  if (events.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No activity yet — register an object (e.g. <code>scp service register</code>) and it will
        appear here live.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-slate-100 text-sm">
      {events.map((event) => (
        <li key={event.id} className="flex items-center justify-between gap-4 py-2">
          <span className="truncate">
            <span className="font-medium text-slate-900">
              {EVENT_LABELS[event.type] ?? event.type}
            </span>{" "}
            <span className="font-mono text-xs text-slate-500">{event.subject ?? ""}</span>
          </span>
          <span className="shrink-0 text-xs text-slate-400">
            {new Date(event.createdAt).toLocaleTimeString()}
          </span>
        </li>
      ))}
    </ul>
  );
}
