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
  useQueryClient: () => ({ clear: () => {} }),
  // The instance-role chip reads federation.self through useQuery; the LINK SET under test does
  // not depend on it, so it resolves to "still loading" — the chip renders nothing, exactly as it
  // does before the fetch lands in the real app.
  useQuery: () => ({ data: undefined, isLoading: true, isError: false })
}));

const { AppShell } = await import("./AppShell");
const { router } = await import("../../router");

/** Every path the code-based route tree can serve. The router's ids carry the PATHLESS layout
 *  route's id as a prefix (`/authenticated/...`), which is chrome, not URL — stripping it gives the
 *  path a browser actually visits. */
function routePaths(): string[] {
  return Object.keys(router.routesById).map((id) => id.replace(/^\/authenticated/, "") || "/");
}

/** Every `href` the sidebar renders, EXACTLY — not by substring.
 *
 *  `expect(html).toContain('href="/federation"')` was the previous form and is satisfied by the
 *  Outposts link alone, since `href="/federation/outposts"` contains it: the "Federation survives"
 *  assertion could not have failed while Outposts existed. Exact hrefs close that. */
function navHrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
}

describe("app nav: destinations survive the 2026-08-10 regrouping", () => {
  const html = renderToStaticMarkup(
    <AppShell>
      <div />
    </AppShell>
  );

  it("links to the Outposts overview", () => {
    expect(navHrefs(html)).toContain("/federation/outposts");
    expect(html).toContain(">Outposts</a>");
  });

  /** The M16.2 guarantee was about the DESTINATION, not the wording: `/federation` ships and may be
   *  bookmarked. Its label became "Federation status" when Outposts stopped being nested under it,
   *  so this pins the href and merely requires SOME label — pinning the exact string is what made
   *  the old assertion break on a rename that changed no destination at all. */
  it("keeps the pre-existing /federation destination reachable, under whatever label", () => {
    expect(navHrefs(html)).toContain("/federation");
    // The anchor carries a `class` between href and `>`, so this must not assume they are
    // adjacent — and since the §3.1 restyle every nav entry leads with an inline lucide `<svg>`
    // before its text label, so the label is matched after an optional icon, not as the anchor's
    // only content.
    expect(html).toMatch(/href="\/federation"[^>]*>(?:<svg[^]*?<\/svg>)?[^<]+<\/a>/);
  });

  it("reaches the static admin destinations", () => {
    const hrefs = navHrefs(html);
    for (const path of ["/", "/campaigns", "/graph", "/identity", "/plugins", "/pats"]) {
      expect(hrefs).toContain(path);
    }
  });

  /** The registry links go through `Link params={{basePath}}`, and the router mock at the top of
   *  this file renders `to` verbatim — so every one of them serializes to `href="/$basePath"` and
   *  the href tells us NOTHING about which registries are in the nav. Asserting hrefs here would
   *  pass with Teams and Components still in the sidebar. The rendered LABEL is the honest signal,
   *  so the catalog set is pinned by label and by count. */
  it("shows exactly the three catalog registries", () => {
    for (const label of ["Services", "Assemblies", "Components"]) {
      expect(html).toContain(`>${label}</a>`);
    }
    expect(navHrefs(html).filter((h) => h === "/$basePath")).toHaveLength(3);
  });

  /** Removed from the nav on purpose. `/changes` no longer has a LIST route at all, so a link to it
   *  would be a 404; the others keep their routes and are reached in context. A nav entry creeping
   *  back is a regression against a decision, which is why it is asserted rather than assumed. */
  it("does not link to the destinations this regrouping removed", () => {
    expect(navHrefs(html)).not.toContain("/changes");
    expect(navHrefs(html)).not.toContain("/initiatives");
    for (const label of [
      "Changes",
      "Initiatives",
      "Domains",
      "Deployment Targets",
      "Teams",
      "Groups",
      "Users",
      "Service Accounts"
    ]) {
      expect(html).not.toContain(`>${label}</a>`);
    }
  });
});

describe("app router: every nav destination this milestone adds actually resolves", () => {
  it("registers the outposts list, the per-outpost detail, and the pre-existing status route", () => {
    const paths = routePaths();
    expect(paths).toContain("/federation");
    expect(paths).toContain("/federation/outposts");
    expect(paths).toContain("/federation/outposts/$peerDomainId");
  });

  it("registers the assembly and identity routes the new nav points at", () => {
    const paths = routePaths();
    expect(paths).toContain("/assemblies/$idOrUrn");
    expect(paths).toContain("/assemblies/$idOrUrn/settings");
    expect(paths).toContain("/identity");
  });

  /** The Changes LIST route is gone; the DETAIL route must not have gone with it — it holds the
   *  wave plan, the gate verdicts and the `decision_id` every "Why?" link resolves (principle 6). */
  it("drops the changes list route but keeps change detail", () => {
    const paths = routePaths();
    expect(paths).not.toContain("/changes");
    expect(paths).toContain("/changes/$id");
    expect(paths).not.toContain("/initiatives");
  });

  it("PREMISE: the flattening really reads the tree (a made-up path is absent)", () => {
    expect(routePaths()).not.toContain("/federation/outposts/does-not-exist");
  });
});
