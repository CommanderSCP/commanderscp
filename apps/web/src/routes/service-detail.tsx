import { Link, Outlet } from "@tanstack/react-router";
import { useIdOrUrnParam } from "../lib/use-route-params";
import { cn, focusRing } from "../lib/utils";

/** The chrome shared by every view of ONE service. See docs/web.md §490. */

// The accent (army olive since 2026-08-11) marks the active tab (spec standing decision — "active nav" is one of the accent's
// four sanctioned homes), consistent with `assembly-detail.tsx`'s identical tab nav.
const TAB_BASE = cn(
  "border-b-2 px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:text-army-800",
  focusRing
);
const TAB_ACTIVE = "border-army-700 text-army-800";
const TAB_INACTIVE = "border-transparent";

export function ServiceDetailLayout(): React.JSX.Element {
  const idOrUrn = useIdOrUrnParam();
  if (!idOrUrn) return <p className="text-sm text-red-600">Not found.</p>;

  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-1 border-b border-army-200" data-testid="service-tabs">
        <Link
          to="/services/$idOrUrn"
          params={{ idOrUrn }}
          activeOptions={{ exact: true }}
          className={cn(TAB_BASE, TAB_INACTIVE)}
          activeProps={{ className: cn(TAB_BASE, TAB_ACTIVE) }}
          data-testid="service-tab-board"
        >
          Board
        </Link>
        <Link
          to="/services/$idOrUrn/infrastructure"
          params={{ idOrUrn }}
          className={cn(TAB_BASE, TAB_INACTIVE)}
          activeProps={{ className: cn(TAB_BASE, TAB_ACTIVE) }}
          data-testid="service-tab-infrastructure"
        >
          Infrastructure
        </Link>
        <Link
          to="/services/$idOrUrn/settings"
          params={{ idOrUrn }}
          className={cn(TAB_BASE, TAB_INACTIVE)}
          activeProps={{ className: cn(TAB_BASE, TAB_ACTIVE) }}
          data-testid="service-tab-settings"
        >
          Settings
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}
