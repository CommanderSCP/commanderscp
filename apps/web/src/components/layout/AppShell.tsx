import type { ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { client } from "../../lib/client";
import { useAuth } from "../../lib/auth-context";
import { REGISTRIES } from "../../lib/registries";
import { Button } from "../ui/button";

const navLinkClass =
  "block rounded px-2 py-1.5 text-sm text-slate-700 transition-colors hover:bg-slate-100";
const navLinkActiveClass = "bg-slate-100 font-medium text-slate-900";

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
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white p-4">
        <Link to="/" className="mb-6 block text-lg font-semibold text-slate-900">
          CommanderSCP
        </Link>
        <nav className="flex flex-col gap-1">
          <Link to="/" className={navLinkClass} activeProps={{ className: navLinkActiveClass }}>
            Dashboard
          </Link>
          <Link
            to="/changes"
            className={navLinkClass}
            activeProps={{ className: navLinkActiveClass }}
          >
            Changes
          </Link>
          <Link
            to="/campaigns"
            className={navLinkClass}
            activeProps={{ className: navLinkActiveClass }}
          >
            Campaigns
          </Link>
          <Link
            to="/initiatives"
            className={navLinkClass}
            activeProps={{ className: navLinkActiveClass }}
          >
            Initiatives
          </Link>
          <Link
            to="/federation"
            className={navLinkClass}
            activeProps={{ className: navLinkActiveClass }}
          >
            Federation
          </Link>
          <Link to="/plugins" className={navLinkClass} activeProps={{ className: navLinkActiveClass }}>
            Plugins
          </Link>
          <Link to="/graph" className={navLinkClass} activeProps={{ className: navLinkActiveClass }}>
            Graph
          </Link>
          <div className="mt-4 mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Registries
          </div>
          {REGISTRIES.map((registry) => (
            <Link
              key={registry.basePath}
              to="/$basePath"
              params={{ basePath: registry.basePath }}
              className={navLinkClass}
              activeProps={{ className: navLinkActiveClass }}
            >
              {registry.label}
            </Link>
          ))}
          <div className="mt-4 mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
            Account
          </div>
          <Link to="/pats" className={navLinkClass} activeProps={{ className: navLinkActiveClass }}>
            Access Tokens
          </Link>
        </nav>
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <span className="text-sm text-slate-500" data-testid="current-org">
            {user ? `${user.orgName} · ${user.username}` : null}
          </span>
          <Button variant="outline" size="sm" onClick={() => void handleLogout()}>
            Log out
          </Button>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
