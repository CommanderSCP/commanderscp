import { useEffect, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  CircleUser,
  FileSearch,
  Flag,
  Globe,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Package,
  Puzzle,
  Scale,
  ScrollText,
  Users,
  Waypoints,
  type LucideIcon,
  ShieldCheck
} from "lucide-react";
import { client } from "../../lib/client";
import { useAuth } from "../../lib/auth-context";
import { cn, focusRing } from "../../lib/utils";
import { REGISTRIES } from "../../lib/registries";
import { Button } from "../ui/button";
import { SectionLabel } from "../ui/section-label";
import { BrandMark, applySiteFavicon } from "./BrandMark";
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

/**
 * TWO SITES, ONE BUNDLE (outpost-ui.md §9, owner correction 2026-08-14).
 *
 * The nav is DATA selected by the serving instance's install-time role (`/auth/me`'s
 * `instanceRole`, from `SCP_FEDERATION_ROLE`) — the commander site and the smaller outpost site
 * are two tables rendered by one component, so `app-shell-nav.test.tsx` can pin BOTH shapes and a
 * change to either is a visible diff to a table, not a conditional buried in JSX.
 *
 * What the outpost site does NOT carry, and why (owner decisions):
 *  - Campaigns, Graph — org-wide coordination is the commander's job.
 *  - Outposts, Federation status — managing OTHER outposts is commander-only; the outpost's own
 *    sync status lives under Admin instead.
 * What it keeps: a smaller Dashboard as home (the targets this outpost controls, at the component
 * level), the Catalog (domain-local objects live there), Setup, and Admin.
 *
 * This decides nav + route table ONLY. It authorizes nothing and gates no rendering inside a
 * page — M16.3's offer-the-write rule and ADR-0031's data-keyed domain-local rendering are
 * unchanged. Two sites having different page sets is a deployment fact; a role check inside a
 * shared page would still be the lie those precedents forbid.
 */
export type NavEntry = { to: string; label: string; icon: LucideIcon; exact?: boolean };
export type NavSection = { label: string | null; entries: NavEntry[] };

const CATALOG_SECTION: NavSection = {
  label: "Catalog",
  entries: CATALOG_REGISTRIES.map((r) => ({
    to: `/${r.basePath}`,
    label: r.label,
    icon: r.icon
  }))
};

export const COMMANDER_NAV: NavSection[] = [
  {
    label: null,
    entries: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
      { to: "/campaigns", label: "Campaigns", icon: Flag },
      { to: "/graph", label: "Graph", icon: Waypoints }
    ]
  },
  CATALOG_SECTION,
  {
    // M16.2 phase B (B4) required that "Outposts" be REACHABLE and that the pre-existing
    // `/federation` destination SURVIVE — both still hold, pinned by app-shell-nav.test.tsx.
    // "Federation status" is exact, or it lights up alongside Outposts (prefix match; owner bug
    // report 2026-08-11).
    label: "Federation",
    entries: [
      { to: "/federation/outposts", label: "Outposts", icon: OutpostFort },
      { to: "/federation", label: "Federation status", icon: Globe, exact: true },
      { to: "/setup", label: "Setup", icon: ListChecks }
    ]
  },
  {
    label: "Admin",
    entries: [
      { to: "/identity", label: "Identity", icon: Users },
      { to: "/plugins", label: "Plugins", icon: Puzzle },
      { to: "/pats", label: "Access Tokens", icon: KeyRound },
      // Dependency PRODUCER declarations (dependency-subscription-ui.md §12) — COMMANDER ONLY
      // (owner rule 2026-08-17: dependency automation happens only at the commander), so the
      // OUTPOST table below does not carry it; pinned by app-shell-nav.test.tsx.
      { to: "/admin/dependencies", label: "Dependencies", icon: Package },
      // The governance:move lattice (governance-reach-on-containment-move.md §9.4) — BOTH sites
      // carry this one: enforcement is PER-INSTANCE, and an outpost's own local containment moves
      // are real moves that the lattice can govern just as a commander's can. Pinned in both
      // COMMANDER_NAV and OUTPOST_NAV by app-shell-nav.test.tsx.
      { to: "/admin/governance", label: "Governance", icon: Scale },
      { to: "/admin/access", label: "Access", icon: ShieldCheck },
      // Decisions & Audit explorer (owner-approved 2026-08-23, charter principle 6) — BOTH sites
      // carry these two: every instance persists Decisions and writes the hash-chained audit log,
      // so both are per-instance facts exactly like Governance above. Pinned in both
      // COMMANDER_NAV and OUTPOST_NAV by app-shell-nav.test.tsx.
      { to: "/admin/decisions", label: "Decisions", icon: FileSearch },
      { to: "/admin/audit", label: "Audit", icon: ScrollText }
    ]
  }
];

export const OUTPOST_NAV: NavSection[] = [
  {
    label: null,
    entries: [{ to: "/", label: "Dashboard", icon: LayoutDashboard, exact: true }]
  },
  CATALOG_SECTION,
  {
    label: "Domain",
    entries: [{ to: "/setup", label: "Setup", icon: ListChecks }]
  },
  {
    label: "Admin",
    entries: [
      // The outpost's OWN sync status — an admin fact (am I current with my commander?), not a
      // federation-management destination. Same route the commander calls "Federation status";
      // the outpost names it for what it is here.
      { to: "/federation", label: "Sync status", icon: Globe, exact: true },
      { to: "/identity", label: "Identity", icon: Users },
      { to: "/plugins", label: "Plugins", icon: Puzzle },
      { to: "/pats", label: "Access Tokens", icon: KeyRound },
      // Same rule as the commander table above: enforcement is per-instance, so the outpost
      // carries this too — its own local moves are real moves the lattice can govern.
      { to: "/admin/governance", label: "Governance", icon: Scale },
      { to: "/admin/access", label: "Access", icon: ShieldCheck },
      // Same rule as the commander table above: Decisions and the audit log are per-instance
      // facts, not federation-management, so the outpost carries both too.
      { to: "/admin/decisions", label: "Decisions", icon: FileSearch },
      { to: "/admin/audit", label: "Audit", icon: ScrollText }
    ]
  }
];

export function navForRole(role: "commander" | "outpost" | "retrans" | undefined): NavSection[] {
  // retrans never serves the SPA (app.ts withholds it), so it can't reach here; if it ever did,
  // the outpost shape is the safer default — nothing org-wide.
  return role === "outpost" || role === "retrans" ? OUTPOST_NAV : COMMANDER_NAV;
}

/** The sidebar nav rendered from a role's table — one renderer, two shapes. */
export function SiteNav({
  role
}: {
  role: "commander" | "outpost" | "retrans" | undefined;
}): React.JSX.Element {
  return (
    <nav className="flex flex-col gap-1" data-testid="site-nav" data-site={role ?? "commander"}>
      {navForRole(role).map((section, i) => (
        <div key={section.label ?? `top-${i}`} className="flex flex-col gap-1">
          {section.label && (
            <SectionLabel className="mb-1 mt-5 px-2 text-army-300">{section.label}</SectionLabel>
          )}
          {section.entries.map((entry) => (
            <Link
              key={entry.to}
              to={entry.to}
              className={navLinkClass}
              activeProps={{ className: navLinkActiveClass }}
              {...(entry.exact ? { activeOptions: { exact: true } } : {})}
            >
              <NavIcon icon={entry.icon} />
              {entry.label}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );
}

/** Left-nav app chrome wrapping every authenticated page (DESIGN.md §14). */
export function AppShell({ children }: { children: ReactNode }): React.JSX.Element {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Site-shaped browser-tab icon (outpost-ui.md §9): once the install-time role is known — i.e.
  // post-auth, inside the shell — the tab wears the outpost fort on an outpost. Never before auth
  // (the login page keeps the static commander default), never from federation_self.role.
  useEffect(() => {
    applySiteFavicon(user?.instanceRole);
  }, [user?.instanceRole]);

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
          <BrandMark role={user?.instanceRole} />
          CommanderSCP
        </Link>
        <InstanceRoleChip />
        <SiteNav role={user?.instanceRole ?? "commander"} />
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
          <span
            className="flex items-center gap-2 text-sm text-slate-500"
            data-testid="current-org"
          >
            {user ? (
              <>
                <CircleUser
                  className="size-4 shrink-0 text-slate-400"
                  strokeWidth={2}
                  aria-hidden="true"
                />
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
  const Icon =
    role === "commander" ? CommanderStar : role === "outpost" ? OutpostFort : RetransMast;
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
