import { describe, expect, it } from "vitest";
import { router } from "./router";

/**
 * THE ROUTE TABLE STILL RESOLVES THE URLS OTHER THINGS DEPEND ON.
 *
 * ============================================================================================
 * WHY THIS FILE EXISTS — A REAL REGRESSION THAT PASSED EVERY REQUIRED PR CHECK
 * ============================================================================================
 * The service release board lived at `/services/{id}/board`. Making it the INDEX child of a new
 * `/services/$idOrUrn` tabbed layout removed that path, and NOTHING failed: a route table is data,
 * so typecheck has no opinion about which paths exist; the unit and integration suites never
 * navigate; and the one thing that did navigate there — `e2e/service-board-honesty.spec.ts` — is
 * Playwright. Every E2E job in `.github/workflows/ci.yml` carries `if: github.event_name == 'push'
 * && github.ref == 'refs/heads/main'`, so it is SKIPPED on pull requests. The break merged green and
 * would have surfaced only on `main`. That workflow's §6 comment predicts this precise hole.
 *
 * So the guard belongs where it runs on EVERY PR: over the real route tree, in the "4. Unit tests"
 * job, with no browser and no server. It does not replace the E2E specs — they prove the page
 * renders against real authz and the real SDK. It proves the URL still exists, the cheap half that
 * was missing.
 *
 * WHEN THIS FAILS: restore the path, or — if the removal is deliberate — change it here AND in every
 * consumer named beside it, as one edit. The annotations exist so "who else uses this URL" cannot be
 * skipped.
 *
 * MUTATION LOG (each applied alone, then reverted):
 *
 * | Mutation | Result |
 * |---|---|
 * | remove `serviceBoardLegacyRoute` from the tree (the merged regression itself) | `/services/{id}/board` FAILS |
 * | `path: "/board"` -> `"/boards"` | same FAILS — the literal is pinned, not merely "some child exists" |
 * | remove `componentSettingsRoute` | the component-settings case FAILS |
 * | make the walk return every path as `/` | the anti-vacuity test FAILS (an unknown path would "resolve") |
 * | point `serviceBoardLegacyRoute` at a different component | "the SAME view" FAILS — the path surviving while its content moved is the same bug from outside |
 */

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
    [`/graph/${ID}`, "e2e/graph.spec.ts + e2e/seeded-demo.spec.ts"],
    ["/services", "e2e/browse.spec.ts + e2e/seeded-demo.spec.ts"],
    ["/assemblies", "the Assemblies registry (migration 0055)"],
    [`/assemblies/${ID}`, "the assembly link on a service board"]
  ])("resolves %s — needed by %s", (url) => {
    expect(resolves(url)).toBe(true);
  });

  it("does NOT resolve an unknown child path — otherwise every case above is vacuous", () => {
    expect(resolves(`/services/${ID}/definitely-not-a-tab`)).toBe(false);
  });

  it("`/services/{id}` and `/services/{id}/board` render the SAME view", () => {
    // The old URL must not merely resolve — it must still show the board. A path that survived while
    // its content moved elsewhere is the same bug as far as anyone following the link is concerned.
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

    const index = flat.find((r) => r.path === "/services/$idOrUrn/");
    const legacy = flat.find((r) => r.path === "/services/$idOrUrn/board");
    expect(index?.component, "the index child must exist").toBeDefined();
    expect(legacy?.component, "the legacy /board child must exist").toBeDefined();
    expect(legacy?.component).toBe(index?.component);
  });
});
