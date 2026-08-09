import { Link, Outlet } from "@tanstack/react-router";
import { useIdOrUrnParam } from "../lib/use-route-params";

/**
 * The chrome shared by every view of ONE service — Board, Infrastructure and Settings.
 *
 * WHY THE BOARD IS THE DEFAULT (owner, 2026-08-04): `/services/{id}` fell through to the generic
 * `RegistryDetailPage`, so the operational view of a service — what is releasing, what is blocked,
 * which pipelines are bound — lived at a URL nothing linked to except one button on the properties
 * page. That is the same orphaning `/components/{id}` had, and it gets the same fix: the board IS
 * what a service is operationally, so it is what the route lands on, and the properties table moves
 * to a tab.
 *
 * The param is `$idOrUrn`, not `$id`, so `RegistryDetailPage` can mount unchanged under `settings`
 * — it reads `useIdOrUrnParam`, and a differently-named param would hand it undefined.
 */

const TAB_BASE = "border-b-2 px-3 py-2 text-sm font-medium transition-colors hover:text-slate-900";

export function ServiceDetailLayout(): React.JSX.Element {
  const idOrUrn = useIdOrUrnParam();
  if (!idOrUrn) return <p className="text-sm text-red-600">Not found.</p>;

  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-1 border-b border-slate-200" data-testid="service-tabs">
        <Link
          to="/services/$idOrUrn"
          params={{ idOrUrn }}
          activeOptions={{ exact: true }}
          className={`${TAB_BASE} border-transparent text-slate-500`}
          activeProps={{ className: `${TAB_BASE} border-slate-900 text-slate-900` }}
          data-testid="service-tab-board"
        >
          Board
        </Link>
        <Link
          to="/services/$idOrUrn/infrastructure"
          params={{ idOrUrn }}
          className={`${TAB_BASE} border-transparent text-slate-500`}
          activeProps={{ className: `${TAB_BASE} border-slate-900 text-slate-900` }}
          data-testid="service-tab-infrastructure"
        >
          Infrastructure
        </Link>
        <Link
          to="/services/$idOrUrn/settings"
          params={{ idOrUrn }}
          className={`${TAB_BASE} border-transparent text-slate-500`}
          activeProps={{ className: `${TAB_BASE} border-slate-900 text-slate-900` }}
          data-testid="service-tab-settings"
        >
          Settings
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}
