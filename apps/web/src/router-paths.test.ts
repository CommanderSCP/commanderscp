import { describe, expect, it } from "vitest";
import { router } from "./router";
import { ComponentDependenciesPage } from "./routes/component-dependencies";
import { AdminDependenciesPage } from "./routes/admin-dependencies";
import { AdminGovernancePage } from "./routes/admin-governance";
import { AdminDecisionsPage } from "./routes/admin-decisions";
import { AdminAuditPage } from "./routes/admin-audit";

/** THE ROUTE TABLE STILL RESOLVES THE URLS OTHER THINGS DEPEND ON. See docs/web.md §147. */

/** Every registered path pattern, walked from the real tree — not from source text, so a literal
 *  present but never added to `addChildren` does not count as registered. */
function registeredPaths(): string[] {
  const walk = (route: unknown, prefix = ""): string[] => {
    const r = route as { options?: { path?: string }; path?: string; children?: unknown[] };
    const seg = String(r.options?.path ?? r.path ?? "");
    const full = `${prefix}/${seg}`.replace(/\/+/g, "/");
    const kids = Array.isArray(r.children) ? r.children : [];
    return [full, ...kids.flatMap((k) => walk(k, full))];
  };
  return walk(router.routeTree);
}

/** A concrete URL matches a pattern when every segment matches literally or the pattern segment is
 *  a `$param`. Trailing-slash-insensitive, because an index child is spelled `/`. */
function resolves(url: string): boolean {
  const want = url.split("/").filter(Boolean);
  return registeredPaths().some((pattern) => {
    const have = pattern.split("/").filter(Boolean);
    return (
      have.length === want.length && have.every((seg, i) => seg.startsWith("$") || seg === want[i])
    );
  });
}

describe("router: URLs other code depends on still resolve", () => {
  const ID = "019f0000-0000-7000-8000-000000000000";

  it.each([
    [`/services/${ID}/board`, "e2e/service-board-honesty.spec.ts + any bookmark of the old URL"],
    [`/services/${ID}`, "the board as a service's default view"],
    [`/services/${ID}/infrastructure`, "the service Infrastructure tab"],
    [`/services/${ID}/settings`, "the service properties table"],
    [`/components/${ID}`, "e2e/component-settings-tab.spec.ts"],
    [`/components/${ID}/settings`, "the component Settings tab"],
    [`/components/${ID}/infrastructure`, "the component Infrastructure lane"],
    [
      `/components/${ID}/dependencies`,
      "the component Dependencies tab (routes/component-detail.tsx's fourth Link)"
    ],
    [`/graph/${ID}`, "e2e/graph.spec.ts + e2e/seeded-demo.spec.ts"],
    ["/services", "e2e/browse.spec.ts + e2e/seeded-demo.spec.ts"],
    ["/assemblies", "the Assemblies registry (migration 0055)"],
    [`/assemblies/${ID}`, "the assembly link on a service board"],
    ["/connect/argocd", "e2e/connect-argocd.spec.ts + the launch button on /plugins (M19.1)"],
    [
      "/admin/dependencies",
      "the commander nav's Admin › Dependencies entry + the Produces strip's link on a component's Dependencies tab (dependency-subscription-ui.md §12)"
    ],
    [
      "/admin/governance",
      "both nav tables' Admin › Governance entry — the governance:move enforcement lattice (governance-reach-on-containment-move.md §9.4)"
    ],
    [
      "/admin/decisions",
      "both nav tables' Admin › Decisions entry + the object-page 'Decisions about this object' link (registry-detail.tsx)"
    ],
    ["/admin/audit", "both nav tables' Admin › Audit entry — the hash-chained audit log"]
  ])("resolves %s — needed by %s", (url) => {
    expect(resolves(url)).toBe(true);
  });

  it("does NOT resolve an unknown child path — otherwise every case above is vacuous", () => {
    expect(resolves(`/services/${ID}/definitely-not-a-tab`)).toBe(false);
  });

  /** Every registered path with the component it renders — for the "same/right view" pins below. */
  function registeredComponents(): { path: string; component: unknown }[] {
    const kids = (router.routeTree as unknown as { children?: unknown[] }).children ?? [];
    const flat: { path: string; component: unknown }[] = [];
    const walk = (route: unknown, prefix = "") => {
      const r = route as {
        options?: { path?: string; component?: unknown };
        children?: unknown[];
      };
      const full = `${prefix}/${String(r.options?.path ?? "")}`.replace(/\/+/g, "/");
      flat.push({ path: full, component: r.options?.component });
      for (const k of Array.isArray(r.children) ? r.children : []) walk(k, full);
    };
    for (const k of kids) walk(k);
    return flat;
  }

  it("`/services/{id}` and `/services/{id}/board` render the SAME view", () => {
    // The old URL must not merely resolve — it must still show the board. A path that survived while
    // its content moved elsewhere is the same bug as far as anyone following the link is concerned.
    const flat = registeredComponents();

    const index = flat.find((r) => r.path === "/services/$idOrUrn/");
    const legacy = flat.find((r) => r.path === "/services/$idOrUrn/board");
    expect(index?.component, "the index child must exist").toBeDefined();
    expect(legacy?.component, "the legacy /board child must exist").toBeDefined();
    expect(legacy?.component).toBe(index?.component);
  });

  it("`/admin/dependencies` renders AdminDependenciesPage (the URL AND the view)", () => {
    const admin = registeredComponents().find((r) => r.path === "/admin/dependencies");
    expect(admin?.component, "the /admin/dependencies route must exist").toBeDefined();
    expect(admin?.component).toBe(AdminDependenciesPage);
  });

  it("`/admin/governance` renders AdminGovernancePage (the URL AND the view)", () => {
    const governance = registeredComponents().find((r) => r.path === "/admin/governance");
    expect(governance?.component, "the /admin/governance route must exist").toBeDefined();
    expect(governance?.component).toBe(AdminGovernancePage);
  });

  it("`/admin/decisions` renders AdminDecisionsPage (the URL AND the view)", () => {
    const decisions = registeredComponents().find((r) => r.path === "/admin/decisions");
    expect(decisions?.component, "the /admin/decisions route must exist").toBeDefined();
    expect(decisions?.component).toBe(AdminDecisionsPage);
  });

  it("`/admin/audit` renders AdminAuditPage (the URL AND the view)", () => {
    const audit = registeredComponents().find((r) => r.path === "/admin/audit");
    expect(audit?.component, "the /admin/audit route must exist").toBeDefined();
    expect(audit?.component).toBe(AdminAuditPage);
  });

  it("`/components/{id}/dependencies` renders ComponentDependenciesPage (the URL AND the view — a registered path pointed at another page is the same break)", () => {
    const dependencies = registeredComponents().find(
      (r) => r.path === "/components/$idOrUrn/dependencies"
    );
    expect(dependencies?.component, "the /dependencies child must exist").toBeDefined();
    expect(dependencies?.component).toBe(ComponentDependenciesPage);
  });
});
