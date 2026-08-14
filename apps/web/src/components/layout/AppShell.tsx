import type { ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CircleUser, Flag, Globe, KeyRound, LayoutDashboard, ListChecks, Puzzle, Users, Waypoints, type LucideIcon } from "lucide-react";
import { client } from "../../lib/client";
import { useAuth } from "../../lib/auth-context";
import { cn, focusRing } from "../../lib/utils";
import { REGISTRIES } from "../../lib/registries";
import { Button } from "../ui/button";
import { SectionLabel } from "../ui/section-label";
import { BrandMark } from "./BrandMark";
import { CommanderStar, OutpostFort, RetransMast } from "../icons/federation-roles";
import { useQuery } from "@tanstack/react-query";
import { federationSelfKey } from "../../lib/query-client";

// §3.2 link treatment + the shared focus ring (§2.10). Active gets the army-olive accent — its second
// sanctioned home — and repaints the entry's icon via the descendant selector, since TanStack's
// `activeProps` only reaches the anchor itself.
// DARK-OLIVE SIDEBAR (owner, 2026-08-11 second theme round — "more green undertones in the bars").
// The sidebar is the one chrome surface that can carry the army identity at full strength without
// costing data readability: content cards stay white, the rail goes army-900. Contrast checked:
// army-100 text on army-900 ≈ 9:1; the army-300 section labels ≈ 6:1.
const navLinkClass = cn(
  "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-army-100/90 transition-colors hover:bg-army-800 hover:text-white",
  focusRing
);
const navLinkActiveClass = "bg-army-700 font-medium text-white [&_svg]:text-army-200";
// §3.1: nav icons are size-4 (the nav table overrides §1.6's generic size-5-in-nav); army-300
// against the dark rail, repainted by the active selector above.
const navIconClass = "size-4 shrink-0 text-army-300";

/** One sidebar entry — icon per the §3.1 table, label/href pinned by `app-shell-nav.test.tsx`. */
function NavIcon({ icon: Icon }: { icon: LucideIcon }): React.JSX.Element {
  return <Icon className={navIconClass} strokeWidth={2} aria-hidden="true" />;
}

/**
 * The CATALOG rung of the nav — what this org runs.
 *
 * Derived from `REGISTRIES` by an ALLOW-LIST rather than by filtering the ones we don't want, so a
 * registry added later (a third container level, say) is absent until someone decides where it
 * belongs, instead of silently appearing in the sidebar. The four identity registries live behind
 * `/identity`; `deployment-target` is surfaced inside the pipeline views, where a target is
 * already a wave target. `components` is BOTH a drill-down (from a service or assembly) and a
 * top-level registry — owner decision 2026-08-10, after the first cut demoted it to drill-down
 * only and that lost the flat "every component in the org" list.
 *
 * `domains` is out of the nav (owner decision 2026-08-10). The CONTAINMENT domain still exists and
 * is still the rung policy resolution, RBAC scope expansion, freeze scoping and the scan-requirement
 * tier chain all walk — only its registry page left the sidebar. `/domains` stays routed, so
 * creating one or attaching an owner is still reachable by URL; nothing in the UI linked to it but
 * this nav entry. (It is NOT covered by the Outposts page: federation tables carry no foreign key
 * into `objects`, so an outpost's `peerDomainId` and a containment-domain row are different
 * identifier spaces — see docs/GLOSSARY.md, which separates the six live senses of "domain".)
 */
const CATALOG_BASE_PATHS = ["services", "assemblies", "components"] as const;
const CATALOG_REGISTRIES = CATALOG_BASE_PATHS.map((basePath) => {
  const registry = REGISTRIES.find((r) => r.basePath === basePath);
  if (!registry) throw new Error(`nav: no registry configured for "${basePath}"`);
  return registry;
});

/** Left-nav app chrome wrapping every authenticated page (DESIGN.md §14). */
export function AppShell({ children }: { children: ReactNode }): React.JSX.Element {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function handleLogout(): Promise<void> {
    try {
      await client.auth.logout();
    } finally {
      queryClient.clear();
      await refresh();
      await navigate({ to: "/login" });
    }
  }

  return (
    <div className="flex min-h-screen">
      {/* §3.2 sticky fix: without sticky+h-screen+overflow-y-auto the sidebar scrolled away on
          tall pages (component journey, change detail with many decisions). */}
      <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col overflow-y-auto border-r border-army-950 bg-army-900 p-4">
        <Link
          to="/"
          className={cn(
            "mb-6 flex items-center gap-2 rounded-md text-lg font-semibold text-white",
            focusRing
          )}
        >
          <BrandMark />
          CommanderSCP
        </Link>
        <InstanceRoleChip />
        <nav className="flex flex-col gap-1">
          <Link to="/" className={navLinkClass} activeProps={{ className: navLinkActiveClass }}>
            <NavIcon icon={LayoutDashboard} />
            Dashboard
          </Link>
          <Link
            to="/campaigns"
            className={navLinkClass}
            activeProps={{ className: navLinkActiveClass }}
          >
            <NavIcon icon={Flag} />
            Campaigns
          </Link>
          <Link
            to="/graph"
            className={navLinkClass}
            activeProps={{ className: navLinkActiveClass }}
          >
            <NavIcon icon={Waypoints} />
            Graph
          </Link>

          <SectionLabel className="mb-1 mt-5 px-2 text-army-300">Catalog</SectionLabel>
          {CATALOG_REGISTRIES.map((registry) => (
            <Link
              key={registry.basePath}
              to="/$basePath"
              params={{ basePath: registry.basePath }}
              className={navLinkClass}
              activeProps={{ className: navLinkActiveClass }}
            >
              <NavIcon icon={registry.icon} />
              {registry.label}
            </Link>
          ))}

          {/* M16.2 phase B (B4) required that "Outposts" be REACHABLE and that the pre-existing
              `/federation` destination SURVIVE — both still hold, and both are still pinned by
              `app-shell-nav.test.tsx`. What changed (2026-08-10) is only the shape: Outposts used
              to be indented UNDER a "Federation" link that was simultaneously a page and a parent,
              which read as though Outposts were part of the status page. They are now two peers
              under a heading, so neither is nested inside the other. No destination was renamed. */}
          <SectionLabel className="mb-1 mt-5 px-2 text-army-300">Federation</SectionLabel>
          <Link
            to="/federation/outposts"
            className={navLinkClass}
            activeProps={{ className: navLinkActiveClass }}
          >
            <NavIcon icon={OutpostFort} />
            Outposts
          </Link>
          <Link
            to="/federation"
            // exact, or this lights up alongside Outposts: TanStack's default active match is
            // prefix-based and /federation/outposts starts with /federation (owner bug report,
            // 2026-08-11).
            activeOptions={{ exact: true }}
            className={navLinkClass}
            activeProps={{ className: navLinkActiveClass }}
          >
            <NavIcon icon={Globe} />
            Federation status
          </Link>
          {/* G5 (outpost-ui.md §4 close) — the setup landing, kept under FEDERATION rather than a
              new section: it is domain-scoped setup work (connect/place/map/freeze), the same
              rung Outposts and Federation status already occupy, not a Catalog or Admin concern. */}
          <Link
            to="/setup"
            className={navLinkClass}
            activeProps={{ className: navLinkActiveClass }}
          >
            <NavIcon icon={ListChecks} />
            Setup
          </Link>

          <SectionLabel className="mb-1 mt-5 px-2 text-army-300">Admin</SectionLabel>
          <Link
            to="/identity"
            className={navLinkClass}
            activeProps={{ className: navLinkActiveClass }}
          >
            <NavIcon icon={Users} />
            Identity
          </Link>
          <Link
            to="/plugins"
            className={navLinkClass}
            activeProps={{ className: navLinkActiveClass }}
          >
            <NavIcon icon={Puzzle} />
            Plugins
          </Link>
          <Link to="/pats" className={navLinkClass} activeProps={{ className: navLinkActiveClass }}>
            <NavIcon icon={KeyRound} />
            Access Tokens
          </Link>
        </nav>
      </aside>
      {/* min-w-0: a row-axis flex item's default min-width is its content's min-content width
          (flexbox automatic minimum size), so without this a wide table's intrinsic width tunnels
          past its own overflow-x-auto wrapper and scrolls the whole PAGE — measured at 1459px doc
          width on a 1152px viewport on /federation/outposts. Owner requirement 2026-08-11: no
          page-level horizontal scroll at sane widths; wide tables scroll INTERNALLY. */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* §3.3: the header bar is the ONLY home of account chrome — `current-org` testid stays on
            the same span it has always been on. */}
        <header className="flex items-center justify-between border-b border-army-200 bg-white px-6 py-3">
          <span className="flex items-center gap-2 text-sm text-slate-500" data-testid="current-org">
            {user ? (
              <>
                <CircleUser className="size-4 shrink-0 text-slate-400" strokeWidth={2} aria-hidden="true" />
                {`${user.orgName} · ${user.username}`}
              </>
            ) : null}
          </span>
          <Button variant="outline" size="sm" onClick={() => void handleLogout()}>
            Log out
          </Button>
        </header>
        <main className="min-w-0 flex-1 bg-slate-50 p-6">{children}</main>
      </div>
    </div>
  );
}

/**
 * The instance's declared federation role, worn under the wordmark (owner follow-up 2026-08-11:
 * role-aware branding). POST-AUTH ONLY, by decision: the login page must not learn the role —
 * telling an unauthenticated visitor "this box is the commander" is topology disclosure a
 * CDS-adjacent deployment should not make, and it would need a new unauthenticated API field.
 * Here the viewer is already inside; `federationSelfKey` shares its cache with the federation
 * pages, so this costs one fetch per session. `unset` renders nothing — an undesignated role has
 * no insignia (same rule as roleBadge).
 */
function InstanceRoleChip(): React.JSX.Element | null {
  const selfQuery = useQuery({
    queryKey: federationSelfKey(),
    queryFn: () => client.federation.self(),
    staleTime: 300_000
  });
  const role = selfQuery.data?.role;
  if (!role || role === "unset") return null;
  const Icon = role === "commander" ? CommanderStar : role === "outpost" ? OutpostFort : RetransMast;
  return (
    <span
      className="mb-4 -mt-4 flex items-center gap-1.5 pl-9 text-xs capitalize text-army-300"
      data-testid="instance-role-chip"
      title={`This instance's declared federation role: ${role}.`}
    >
      <Icon className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
      {role}
    </span>
  );
}