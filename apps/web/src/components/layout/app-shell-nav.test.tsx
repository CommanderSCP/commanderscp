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

const { AppShell, SiteNav, OUTPOST_NAV, COMMANDER_NAV, navForRole } = await import("./AppShell");
const { BrandMark } = await import("./BrandMark");
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

  /** Admin › Dependencies (dependency-subscription-ui.md §12.2) — the org's dependency PRODUCER
   *  declarations. Under Admin on the COMMANDER table (the outpost half of this pin is below). */
  it("links to Admin › Dependencies (/admin/dependencies), under the Admin section", () => {
    expect(navHrefs(html)).toContain("/admin/dependencies");
    expect(html).toContain(">Dependencies</a>");
    const adminSection = COMMANDER_NAV.find((s) => s.label === "Admin");
    expect(adminSection?.entries.map((e) => e.to)).toContain("/admin/dependencies");
  });

  /** Admin › Governance (governance-reach-on-containment-move.md §9.4) — the governance:move
   *  lattice. Unlike Dependencies, this one is NOT commander-only (the outpost half is pinned
   *  below): enforcement is per-instance, and an outpost's own local moves are real moves. */
  it("links to Admin › Governance (/admin/governance), under the Admin section", () => {
    expect(navHrefs(html)).toContain("/admin/governance");
    expect(html).toContain(">Governance</a>");
    const adminSection = COMMANDER_NAV.find((s) => s.label === "Admin");
    expect(adminSection?.entries.map((e) => e.to)).toContain("/admin/governance");
  });

  /** Admin › Decisions & Admin › Audit (owner-approved 2026-08-23, charter principle 6) — every
   *  Decision record and the hash-chained audit log, both browsable. BOTH sites carry both: every
   *  instance persists Decisions and writes its own audit log, same reasoning as Governance above. */
  it("links to Admin › Decisions (/admin/decisions), under the Admin section", () => {
    expect(navHrefs(html)).toContain("/admin/decisions");
    expect(html).toContain(">Decisions</a>");
    const adminSection = COMMANDER_NAV.find((s) => s.label === "Admin");
    expect(adminSection?.entries.map((e) => e.to)).toContain("/admin/decisions");
  });

  it("links to Admin › Audit (/admin/audit), under the Admin section", () => {
    expect(navHrefs(html)).toContain("/admin/audit");
    expect(html).toContain(">Audit</a>");
    const adminSection = COMMANDER_NAV.find((s) => s.label === "Admin");
    expect(adminSection?.entries.map((e) => e.to)).toContain("/admin/audit");
  });

  /** G5 (outpost-ui.md §4 close) — "Setup" lives under the pre-existing FEDERATION section
   *  (with Outposts and Federation status), not a new heading; both survive alongside it. */
  it("links to the setup landing, under the pre-existing Federation section", () => {
    expect(navHrefs(html)).toContain("/setup");
    expect(html).toContain(">Setup</a>");
    expect(navHrefs(html)).toContain("/federation/outposts");
    expect(navHrefs(html)).toContain("/federation");
  });

  /** The catalog entries are now data (`COMMANDER_NAV`, outpost-ui.md §9) with concrete `to`
   *  paths, so BOTH the label and the href are honest signals — pinned by both, and by count. */
  it("shows exactly the three catalog registries", () => {
    for (const label of ["Services", "Assemblies", "Components"]) {
      expect(html).toContain(`>${label}</a>`);
    }
    const hrefs = navHrefs(html);
    for (const path of ["/services", "/assemblies", "/components"]) {
      expect(hrefs).toContain(path);
    }
    expect(
      hrefs.filter((h) => ["/services", "/assemblies", "/components"].includes(h))
    ).toHaveLength(3);
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

/**
 * THE OUTPOST SITE (outpost-ui.md §9, owner correction 2026-08-14): the same bundle serves a
 * SMALLER site when the instance's install-time role is `outpost`. Pinned as a table diff against
 * the commander site above — the whole point of making the nav data was that this test could say,
 * per entry, which site carries it and which does not.
 */
describe("app nav: the OUTPOST site is the small one (outpost-ui.md §9)", () => {
  const html = renderToStaticMarkup(<SiteNav role="outpost" />);
  const hrefs = navHrefs(html);

  it("keeps home, the catalog, setup, and admin", () => {
    for (const path of [
      "/",
      "/services",
      "/assemblies",
      "/components",
      "/setup",
      "/identity",
      "/plugins",
      "/pats"
    ]) {
      expect(hrefs).toContain(path);
    }
  });

  it("does NOT carry the commander's org-wide areas — Campaigns, Graph, Outposts", () => {
    expect(hrefs).not.toContain("/campaigns");
    expect(hrefs).not.toContain("/graph");
    expect(hrefs).not.toContain("/federation/outposts");
    for (const label of ["Campaigns", "Graph", "Outposts", "Federation status"]) {
      expect(html).not.toContain(`>${label}</a>`);
    }
  });

  /** Dependency automation is COMMANDER-ONLY (owner rule 2026-08-17): the outpost site never
   *  links to the producer declarations page (a direct URL there renders the "managed at the
   *  commander" pointer and issues no reads — routes/admin-dependencies.tsx). */
  it("does NOT carry Admin › Dependencies (commander-only dependency automation)", () => {
    expect(hrefs).not.toContain("/admin/dependencies");
    expect(html).not.toContain(">Dependencies</a>");
    expect(OUTPOST_NAV.flatMap((s) => s.entries.map((e) => e.to))).not.toContain(
      "/admin/dependencies"
    );
  });

  it("keeps the outpost's OWN sync status, relabelled and moved under Admin", () => {
    // Same destination the commander calls "Federation status" — a bookmark survives — but on the
    // outpost it is an admin fact about THIS instance, not a federation-management page.
    expect(hrefs).toContain("/federation");
    expect(html).toContain(">Sync status</a>");
    const adminSection = OUTPOST_NAV.find((s) => s.label === "Admin");
    expect(adminSection?.entries.map((e) => e.to)).toContain("/federation");
  });

  /** Admin › Governance IS carried here, unlike Dependencies — enforcement is per-instance, and
   *  an outpost's own local containment moves are real moves the lattice can govern. */
  it("carries Admin › Governance (enforcement is per-instance, not commander-only)", () => {
    expect(hrefs).toContain("/admin/governance");
    expect(html).toContain(">Governance</a>");
    const adminSection = OUTPOST_NAV.find((s) => s.label === "Admin");
    expect(adminSection?.entries.map((e) => e.to)).toContain("/admin/governance");
  });

  /** Admin › Decisions & Admin › Audit are per-instance facts too (every instance persists its
   *  own Decisions and writes its own audit log), so the outpost site carries both. */
  it("carries Admin › Decisions and Admin › Audit (per-instance facts, not commander-only)", () => {
    expect(hrefs).toContain("/admin/decisions");
    expect(html).toContain(">Decisions</a>");
    expect(hrefs).toContain("/admin/audit");
    expect(html).toContain(">Audit</a>");
    const adminSection = OUTPOST_NAV.find((s) => s.label === "Admin");
    expect(adminSection?.entries.map((e) => e.to)).toEqual(
      expect.arrayContaining(["/admin/decisions", "/admin/audit"])
    );
  });

  it("is a strict SUBSET of the commander site's destinations (plus nothing new)", () => {
    // Every outpost destination exists on the commander site too — the outpost REMOVES, it does
    // not invent. If this fails, someone added an outpost-only route; that needs a decision, not
    // a drive-by.
    const commanderTo = new Set(COMMANDER_NAV.flatMap((s) => s.entries.map((e) => e.to)));
    for (const to of OUTPOST_NAV.flatMap((s) => s.entries.map((e) => e.to))) {
      expect(commanderTo.has(to), `outpost-only destination: ${to}`).toBe(true);
    }
    expect(OUTPOST_NAV.flatMap((s) => s.entries).length).toBeLessThan(
      COMMANDER_NAV.flatMap((s) => s.entries).length
    );
  });

  it("selects by install-time role, and retrans (never served) falls to the small shape", () => {
    expect(navForRole("commander")).toBe(COMMANDER_NAV);
    expect(navForRole(undefined)).toBe(COMMANDER_NAV);
    expect(navForRole("outpost")).toBe(OUTPOST_NAV);
    expect(navForRole("retrans")).toBe(OUTPOST_NAV);
    expect(html).toContain('data-site="outpost"');
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

  it("registers the setup landing the new nav link points at (G5)", () => {
    expect(routePaths()).toContain("/setup");
  });

  it("registers the Admin › Dependencies page the commander nav link points at", () => {
    expect(routePaths()).toContain("/admin/dependencies");
  });

  it("registers the Admin › Decisions and Admin › Audit pages both nav tables link to", () => {
    const paths = routePaths();
    expect(paths).toContain("/admin/decisions");
    expect(paths).toContain("/admin/audit");
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

/**
 * SITE-SHAPED INSIGNIA (outpost-ui.md §9, owner 2026-08-14): the outpost site wears the fort, the
 * commander the star — and the login page ALWAYS wears the star, because the role is post-auth
 * only (topology disclosure). Pinned by the `data-insignia` attribute rather than SVG path text,
 * so a redraw of either icon does not break the test while a swapped role does.
 */
describe("brand mark: one insignia per site, star before auth", () => {
  it("wears the fort on the outpost site and the star on the commander site", () => {
    expect(renderToStaticMarkup(<BrandMark role="outpost" />)).toContain('data-insignia="outpost"');
    expect(renderToStaticMarkup(<BrandMark role="commander" />)).toContain(
      'data-insignia="commander"'
    );
  });

  it("wears the STAR when no role is known — the login page's case — never leaking the role pre-auth", () => {
    // Login renders <BrandMark size="lg" /> with no role: an unauthenticated visitor must not learn
    // this instance is an outpost from its logo. Same rule the role chip has always followed.
    expect(renderToStaticMarkup(<BrandMark size="lg" />)).toContain('data-insignia="commander"');
    expect(renderToStaticMarkup(<BrandMark size="lg" />)).not.toContain('data-insignia="outpost"');
  });
});
