import { Link, Outlet } from "@tanstack/react-router";
import { useIdOrUrnParam } from "../lib/use-route-params";
import { cn, focusRing } from "../lib/utils";

/**
 * The chrome shared by every view of ONE service — Board, Infrastructure and Settings.
 *
 * WHY THE BOARD IS THE DEFAULT (owner, 2026-08-10): `/services/{id}` fell through to the generic
 * `RegistryDetailPage`, so the operational view of a service — what is releasing, what is blocked,
 * which pipelines are bound — lived at a URL nothing linked to except one button on the properties
 * page. That is the same orphaning `/components/{id}` had, and it gets the same fix: the board IS
 * what a service is operationally, so it is what the route lands on, and the properties table moves
 * to a tab.
 *
 * The param is `$idOrUrn`, not `$id`, so `RegistryDetailPage` can mount unchanged under `settings`
 * — it reads `useIdOrUrnParam`, and a differently-named param would hand it undefined.
 */

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
