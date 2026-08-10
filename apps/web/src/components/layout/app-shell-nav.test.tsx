import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * M16.2 phase B (B4) — THE NAV GUARANTEE, on every PR.
 *
 * The E2E spec (`apps/web/e2e/outposts-no-bypass.spec.ts`) walks nav → list → detail against the
 * real router. When this was written every E2E job was `main`-only and SKIPPED on pull requests; they
 * now run on PRs and 5z requires them. These two properties stay pinned here regardless, because a
 * nav guarantee is worth a check that costs milliseconds:
 *
 *   1. "Outposts" is REACHABLE from the nav at all (a page nothing links to is a page nobody finds);
 *   2. the pre-existing `/federation` entry SURVIVES. It ships today and may be bookmarked; adding a
 *      section is not a licence to rename an existing destination out from under one.
 *
 * …plus the route tree itself, asserted against the real `router` object: a nav link to a path with
 * no route is a 404 that no unit test of the sidebar alone would catch.
 *
 * The three hooks `AppShell` calls (`useAuth`, `useNavigate`, `useQueryClient`) all require
 * providers this file deliberately does not stand up — the sidebar's link set is what is under test,
 * not the auth session — so they are stubbed. `Link` renders a real `<a href>` so the assertions are
 * about destinations rather than about component identity.
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    to,
    children,
    className
  }: {
    to?: string;
    children?: React.ReactNode;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useNavigate: () => async () => {}
}));

vi.mock("../../lib/auth-context", () => ({
  useAuth: () => ({ user: { orgName: "acme", username: "admin" }, refresh: async () => {} })
}));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({ clear: () => {} })
}));

const { AppShell } = await import("./AppShell");
const { router } = await import("../../router");

/** Every path the code-based route tree can serve. The router's ids carry the PATHLESS layout
 *  route's id as a prefix (`/authenticated/...`), which is chrome, not URL — stripping it gives the
 *  path a browser actually visits. */
function routePaths(): string[] {
  return Object.keys(router.routesById).map((id) => id.replace(/^\/authenticated/, "") || "/");
}

describe("app nav: the Outposts entry is added, and Federation is not renamed away", () => {
  const html = renderToStaticMarkup(
    <AppShell>
      <div />
    </AppShell>
  );

  it("links to the Outposts overview", () => {
    expect(html).toContain('href="/federation/outposts"');
    expect(html).toContain(">Outposts</a>");
  });

  it("keeps the pre-existing Federation entry pointing at /federation", () => {
    expect(html).toContain('href="/federation"');
    expect(html).toContain(">Federation</a>");
  });
});

describe("app router: every nav destination this milestone adds actually resolves", () => {
  it("registers the outposts list, the per-outpost detail, and the pre-existing status route", () => {
    const paths = routePaths();
    expect(paths).toContain("/federation");
    expect(paths).toContain("/federation/outposts");
    expect(paths).toContain("/federation/outposts/$peerDomainId");
  });

  it("PREMISE: the flattening really reads the tree (a made-up path is absent)", () => {
    expect(routePaths()).not.toContain("/federation/outposts/does-not-exist");
  });
});
