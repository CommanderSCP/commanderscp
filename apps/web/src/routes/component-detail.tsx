import { Link, Outlet } from "@tanstack/react-router";
import { useIdOrUrnParam } from "../lib/use-route-params";
import { cn, focusRing } from "../lib/utils";

/**
 * The chrome shared by every view of ONE component — today Pipeline and Settings.
 *
 * ============================================================================================
 * WHY THIS EXISTS: `RegistryDetailPage` WAS ORPHANED FOR COMPONENTS
 * ============================================================================================
 * `/components/$idOrUrn` is a STATIC route (the pipeline, which is what a component is
 * operationally), and a static segment out-ranks the dynamic `/$basePath/$idOrUrn` that renders the
 * generic registry detail. So from the moment the pipeline shipped, the generic detail page was
 * unreachable for components — and with it its labels, owners, "Move to service", executor-binding
 * repurpose and component-merge cards, ~570 lines that quietly became dead for the one registry
 * whose users need them most.
 *
 * The fix is a parent route, not a second copy of that page: `/components/$idOrUrn` becomes a layout
 * with an index child (the pipeline) and a `settings` child that mounts `RegistryDetailPage`
 * unchanged. `useBasePathParam` falls back to the pathname's first segment, which is what lets the
 * generic page resolve `components` on a route that has no `$basePath` param.
 *
 * Every tab is a real URL — deep-linkable, and the back button moves between them — rather than
 * component state, which is the only form of "tab" that survives being shared in a ticket.
 *
 * WHY INFRASTRUCTURE AND SOFTWARE ARE SEPARATE TABS, not two columns of one page (owner,
 * 2026-08-03): they are two independent pipelines, with their own repos, executors and release
 * histories (docs/GLOSSARY.md "pipeline"). Side by side they compete for the width each one's node
 * chain needs, and they read as halves of one thing. `/components/$id` stays the SOFTWARE pipeline
 * so every existing link keeps landing on a component's usual view.
 */

// Every interactive element carries the shared focus ring (design spec §2.10).
const TAB_BASE = cn(
  "border-b-2 px-3 py-2 text-sm font-medium transition-colors hover:text-army-800",
  focusRing
);

export function ComponentDetailLayout(): React.JSX.Element {
  const idOrUrn = useIdOrUrnParam();
  if (!idOrUrn) return <p className="text-sm text-red-600">Not found.</p>;

  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-1 border-b border-army-200" data-testid="component-tabs">
        <Link
          to="/components/$idOrUrn/infrastructure"
          params={{ idOrUrn }}
          className={`${TAB_BASE} border-transparent text-slate-500`}
          activeProps={{ className: `${TAB_BASE} border-army-700 text-army-800` }}
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
          className={`${TAB_BASE} border-transparent text-slate-500`}
          activeProps={{ className: `${TAB_BASE} border-army-700 text-army-800` }}
          data-testid="component-tab-software"
        >
          {/* "Delivery", not "Software": this journey carries BOTH the build (application
              artifact) and configuration pipelines, and calling helm values/k8s manifests
              "software" is the Category error ADR-0007 exists to prevent. The testid keeps its
              historical name — it is a machine id, not copy. Owner taxonomy ruling 2026-08-11. */}
          Delivery
        </Link>
        <Link
          to="/components/$idOrUrn/settings"
          params={{ idOrUrn }}
          className={`${TAB_BASE} border-transparent text-slate-500`}
          activeProps={{ className: `${TAB_BASE} border-army-700 text-army-800` }}
          data-testid="component-tab-settings"
        >
          Settings
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}
