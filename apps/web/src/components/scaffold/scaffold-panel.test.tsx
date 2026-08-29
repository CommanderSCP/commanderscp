// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DiscoveryProposal, ScaffoldDiscoveryResponse } from "@scp/schemas";
import { ScaffoldPanel } from "./scaffold-panel";
import { flush, render, typeInto } from "../../test-support/render-dom";

/**
 * THE SCAFFOLDER PANEL — what replaced `POST /discovery/accept` in the wizards (ADR-0047).
 *
 * ============================================================================================
 * THE ONE PROPERTY THAT CARRIES THE ADR
 * ============================================================================================
 * "The orphan problem is solved at authoring time, where a human is present." The old path wrote
 * components into the graph with no owning service — the homelab's ~50 orphans — and the wizard then
 * offered a triage screen to repair them one at a time.
 *
 * So the case that matters is NOT that code is emitted. It is that a component nobody grouped is
 * **shown and excluded**, never defaulted into some invented service. A panel that quietly emitted
 * a `Component` under a made-up service name would pass a "does it produce code?" test and
 * reintroduce exactly the defect this replaced.
 *
 * THE DOOR IS A DOUBLE, NOT A MOCK OF `@scp/iac`. The emitter runs server-side (the UI may not
 * import `@scp/iac`), so this stands in for `POST /discovery/scaffold` and applies the SAME rule the
 * server does — a component with no service is reported, never emitted. Testing the panel against a
 * double that defaulted the ungrouped ones would prove the panel renders whatever it is handed,
 * which is true and useless.
 *
 * MUTATION LOG — each applied, watched fail, reverted, watched pass (MEASURED)
 * | Mutation | Result |
 * |---|---|
 * | the ungrouped banner is not rendered | "(2) an ungrouped component is SHOWN" FAILS |
 * | the panel defaults an ungrouped component to a service name instead of excluding it | "(2)" FAILS on the exclusion half — the name appears in the emitted source |
 * | "Apply to all" writes a hidden default instead of filling the per-component fields | "(3)" FAILS — the inputs no longer show what the code uses |
 */
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
