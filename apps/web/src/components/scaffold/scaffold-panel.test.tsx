// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DiscoveryProposal, ScaffoldDiscoveryResponse } from "@scp/schemas";
import { ScaffoldPanel } from "./scaffold-panel";
import { flush, render, typeInto } from "../../test-support/render-dom";

/** THE SCAFFOLDER PANEL. See docs/web.md §103. */
describe("ScaffoldPanel", () => {
  function proposal(names: string[]): DiscoveryProposal {
    return {
      objects: names.map((name) => ({ typeId: "component", name })),
      relationships: []
    } as DiscoveryProposal;
  }

  /** Stands in for `POST /discovery/scaffold`, applying the server's rule: grouped components are
   *  emitted, ungrouped ones are reported and left out. */
  function scaffoldDouble(p: DiscoveryProposal, group: Record<string, string>) {
    const componentNames = p.objects.filter((o) => o.typeId === "component").map((o) => o.name);
    const grouped = componentNames.filter((n) => (group[n] ?? "").trim() !== "");
    const ungrouped = componentNames.filter((n) => (group[n] ?? "").trim() === "");
    const byService = new Map<string, string[]>();
    for (const name of grouped) {
      const svc = group[name]!;
      byService.set(svc, [...(byService.get(svc) ?? []), name]);
    }
    return Promise.resolve({
      stacks: [...byService.entries()].map(([serviceName, names]) => ({
        stackName: serviceName,
        serviceName,
        source: names.map((n) => `new ImagePipeline("${n}", { /* ... */ });`).join("\n"),
        placeholderCount: 0
      })),
      ungrouped: ungrouped.map((name) => ({ name, typeId: "component" }))
    } satisfies ScaffoldDiscoveryResponse);
  }

  /** react-query needs more than one microtask to refetch and re-render after the grouping
   *  changes; `flush()` alone is a single tick. Loops rather than sleeping so the test is not
   *  timing-dependent. */
  async function settle(view: { html(): string }, testId: string): Promise<void> {
    for (let i = 0; i < 20; i++) {
      if (view.html().includes(testId)) return;
      await flush();
    }
  }

  function panel(names: string[]) {
    return (
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ScaffoldPanel proposal={proposal(names)} scaffold={scaffoldDouble} />
      </QueryClientProvider>
    );
  }

  it("(1) emits nothing until a component is grouped, and says it writes nothing", () => {
    const view = render(panel(["api"]));
    // The panel is explicit that it does not write — the wizard's whole contract changed, and a
    // user who remembers the old flow needs telling.
    expect(view.byTestId("scaffold-no-write-notice").textContent).toContain("written to the graph");
    expect(view.html()).not.toContain("scaffold-source");
    view.unmount();
  });

  it("(2) an ungrouped component is SHOWN and EXCLUDED — never defaulted into a service", async () => {
    const view = render(panel(["api", "worker"]));

    const inputs = Array.from(
      view.container.querySelectorAll<HTMLInputElement>('[data-testid="scaffold-service-input"]')
    );
    typeInto(inputs[0]!, "payments");
    await flush();
    await settle(view, "scaffold-source");

    // The one that WAS grouped is in the code.
    expect(view.byTestId("scaffold-source").textContent).toContain("api");
    // The one that was NOT is named in the warning…
    const ungrouped = view.byTestId("scaffold-ungrouped").textContent ?? "";
    expect(ungrouped).toContain("worker");
    // …and is ABSENT from the emitted code. This is the half that matters: a panel that defaulted
    // it into a service would still show a banner and would still be wrong.
    expect(view.byTestId("scaffold-source").textContent).not.toContain("worker");
    // Real pluralization (copy rule 6, "component(s)" is banned): exactly one leftover reads as
    // singular, verb agreement included — never "1 component(s) have".
    expect(ungrouped).toContain("1 component has no service");
    expect(ungrouped).not.toMatch(/component\(s\)/);
    view.unmount();
  });

  it("(2b) two ungrouped components read as plural, not '2 component(s) have'", async () => {
    const view = render(panel(["api", "worker", "queue"]));

    const inputs = Array.from(
      view.container.querySelectorAll<HTMLInputElement>('[data-testid="scaffold-service-input"]')
    );
    typeInto(inputs[0]!, "payments");
    await flush();
    await settle(view, "scaffold-source");

    const ungrouped = view.byTestId("scaffold-ungrouped").textContent ?? "";
    expect(ungrouped).toContain("2 components have no service");
    expect(ungrouped).not.toMatch(/component\(s\)/);
    view.unmount();
  });

  it("(3) `Apply to all` fills the visible fields — what you see is what the code uses", async () => {
    const view = render(panel(["api", "worker"]));
    typeInto(view.byTestId("scaffold-bulk-input") as HTMLInputElement, "payments");
    await flush();
    view.click("scaffold-apply-all");
    await flush();

    const inputs = Array.from(
      view.container.querySelectorAll<HTMLInputElement>('[data-testid="scaffold-service-input"]')
    );
    // REAL per-component values, not a hidden default: the operator can see and change each one,
    // and no component is grouped by a rule they cannot inspect.
    expect(inputs.map((i) => i.value)).toEqual(["payments", "payments"]);
    expect(view.html()).not.toContain("scaffold-ungrouped");
    view.unmount();
  });
});
