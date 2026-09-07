import { Link, Outlet } from "@tanstack/react-router";
import { useAuth } from "../lib/auth-context";
import { useIdOrUrnParam } from "../lib/use-route-params";
import { cn, focusRing } from "../lib/utils";

/** The chrome shared by every view of ONE component. See docs/web.md §225. */

// Every interactive element carries the shared focus ring. See docs/web.md §226.
const TAB_BASE = cn("rounded-t-md px-3 py-2 text-sm font-medium transition-colors", focusRing);
const TAB_INACTIVE = `${TAB_BASE} text-slate-500 hover:bg-army-50 hover:text-army-800`;
const TAB_ACTIVE = `${TAB_BASE} bg-army-700 text-white shadow-sm`;

export function ComponentDetailLayout(): React.JSX.Element {
  const idOrUrn = useIdOrUrnParam();
  const { user } = useAuth();
  // Dependency automation happens only at the commander. See docs/web.md §227.
  const showDependencies = user?.instanceRole === "commander";
  if (!idOrUrn) return <p className="text-sm text-red-600">Not found.</p>;

  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-1 border-b-2 border-army-700/30" data-testid="component-tabs">
        <Link
          to="/components/$idOrUrn/infrastructure"
          params={{ idOrUrn }}
          className={TAB_INACTIVE}
          activeProps={{ className: TAB_ACTIVE }}
          data-testid="component-tab-infrastructure"
        >
          Infrastructure
        </Link>
        <Link
          to="/components/$idOrUrn"
          params={{ idOrUrn }}
          // `activeOptions.exact` matters: without it this tab stays "active" while a child route is
          // showing, since its path is a prefix of every child's.
          activeOptions={{ exact: true }}
          className={TAB_INACTIVE}
          activeProps={{ className: TAB_ACTIVE }}
          data-testid="component-tab-software"
        >
          {/* "Delivery", not "Software": this journey carries BOTH the build (application
              artifact) and configuration pipelines, and calling helm values/k8s manifests
              "software" is the Category error ADR-0007 exists to prevent. The testid keeps its
              historical name — it is a machine id, not copy. Owner taxonomy ruling 2026-08-11. */}
          Delivery
        </Link>
        {showDependencies ? (
          <Link
            to="/components/$idOrUrn/dependencies"
            params={{ idOrUrn }}
            className={TAB_INACTIVE}
            activeProps={{ className: TAB_ACTIVE }}
            data-testid="component-tab-dependencies"
          >
            Dependencies
          </Link>
        ) : null}
        <Link
          to="/components/$idOrUrn/settings"
          params={{ idOrUrn }}
          className={TAB_INACTIVE}
          activeProps={{ className: TAB_ACTIVE }}
          data-testid="component-tab-settings"
        >
          Settings
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}
