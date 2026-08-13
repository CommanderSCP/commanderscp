import { useSyncExternalStore } from "react";
import { ArrowRight, Check, CircleAlert, type LucideIcon } from "lucide-react";
import { getActivityEventsSnapshot, subscribeActivityEvents } from "../lib/use-event-stream";

const EVENT_LABELS: Record<string, string> = {
  "scp.object.created": "created",
  "scp.object.updated": "updated",
  "scp.object.deleted": "deleted"
};

/** Icon + tint per event kind (design spec §4A/§1.6) — created reads as an addition, updated as a
 *  change in place, deleted as the one kind worth a second look. Unrecognised event types (the
 *  stream carries more than `scp.object.*`, see use-event-stream.ts) fall back to the "updated"
 *  treatment rather than guessing. */
const EVENT_ICONS: Record<string, { icon: LucideIcon; className: string }> = {
  "scp.object.created": { icon: Check, className: "bg-emerald-100 text-emerald-600" },
  "scp.object.updated": { icon: ArrowRight, className: "bg-blue-100 text-blue-600" },
  "scp.object.deleted": { icon: CircleAlert, className: "bg-red-100 text-red-600" }
};
const DEFAULT_EVENT_ICON = EVENT_ICONS["scp.object.updated"]!;

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
    <ul className="divide-y divide-slate-100">
      {events.map((event) => {
        const { icon: Icon, className } = EVENT_ICONS[event.type] ?? DEFAULT_EVENT_ICON;
        return (
          <li key={event.id} className="flex items-center gap-3 py-2.5">
            <span
              className={`flex size-6 shrink-0 items-center justify-center rounded-full ${className}`}
            >
              <Icon className="size-3.5" strokeWidth={2} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">
              <span className="font-medium text-slate-900">
                {EVENT_LABELS[event.type] ?? event.type}
              </span>{" "}
              <span className="font-mono text-xs text-slate-500">{event.subject ?? ""}</span>
            </span>
            <span className="shrink-0 text-xs text-slate-500">
              {new Date(event.createdAt).toLocaleTimeString()}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
