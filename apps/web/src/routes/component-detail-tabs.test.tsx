import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE COMPONENT TAB BAR — the four Links, by testid and label. `router-paths.test.ts` proves the
 * `/dependencies` URL is registered in the real route tree (DELETE-THE-WIRING: drop
 * `componentDependenciesRoute` from `addChildren` and that case dies); this file proves the layout
 * OFFERS the tab (drop the fourth Link and this dies), and that the three pre-existing testids —
 * one of them pinned by `e2e/component-settings-tab.spec.ts` — are still there.
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    to,
    ...rest
  }: {
    children?: React.ReactNode;
    to?: string;
    "data-testid"?: string;
  }) => (
    <a data-testid={rest["data-testid"]} data-to={to}>
      {children}
    </a>
  ),
  Outlet: () => <div data-testid="outlet" />
}));

vi.mock("../lib/use-route-params", () => ({
  useIdOrUrnParam: () => "019f0000-0000-7000-8000-00000000c0de"
}));

const { ComponentDetailLayout } = await import("./component-detail");

describe("the component tab bar", () => {
  const html = renderToStaticMarkup(<ComponentDetailLayout />);

  it("offers Infrastructure · Delivery · Dependencies · Settings, each by its testid", () => {
    for (const [testId, label, to] of [
      ["component-tab-infrastructure", "Infrastructure", "/components/$idOrUrn/infrastructure"],
      ["component-tab-software", "Delivery", "/components/$idOrUrn"],
      ["component-tab-dependencies", "Dependencies", "/components/$idOrUrn/dependencies"],
      ["component-tab-settings", "Settings", "/components/$idOrUrn/settings"]
    ]) {
      const m = html.match(new RegExp(`<a data-testid="${testId}" data-to="([^"]*)">([^<]*)</a>`));
      expect(m, testId).not.toBeNull();
      expect(m![1]).toBe(to);
      expect(m![2]).toBe(label);
    }
    expect(html.match(/data-testid="component-tab-/g)).toHaveLength(4);
  });
});
