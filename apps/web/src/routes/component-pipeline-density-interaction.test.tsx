// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { ComponentPipelineResponse, ComponentPipelineStage } from "@scp/sdk";
import { fire, render } from "../test-support/render-dom";

/**
 * TILE DENSITY (pipeline-substrate-registry-scan.md §10.3) — the BEHAVIOURAL half.
 *
 * `component-pipeline-density.test.tsx` pins WHAT the compact and expanded markup hold. This file
 * pins that the controls actually MOVE between them, which a string render cannot show (see
 * `test-support/render-dom.tsx` for why a real DOM was taken on):
 *
 *   - a tile's chevron toggles ITS region, and only its;
 *   - the page-level control flips EVERY tile — Expand all, then Collapse all;
 *   - a tile's own chevron OVERRIDES the page-level state locally, until the next page-level flip,
 *     which wins again (the `version` in the context is what makes the override expire).
 *
 * The tiles render under the SAME `TileDetailsScope` the page mounts, so what is clicked here is
 * what the operator clicks.
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | `TileDetailsScope` does not bump `version` on a flip | the "override expires on the next page flip" test FAILS — the locally-shut tile stays shut after Expand all |
 * | `useTileDetails` ignores `local` (always follows the scope) | the chevron test FAILS — a click changes nothing |
 * | `useTileDetails` ignores the scope once a local override exists (no version check) | the expiry test FAILS |
 * | the page control flips only `expandedAll` on the FIRST click and never back | the Collapse-all half FAILS |
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const { StageCardForTest, RegistryNodeForTest, ScanSignNodeForTest, TileDetailsScope } =
  await import("./component-pipeline");

function stage(over: Partial<ComponentPipelineStage> = {}): ComponentPipelineStage {
  return {
    placement: { id: "019f0000-0000-7000-8000-00000000aaaa", urn: "urn:scp:o:placement:x/y" },
    order: 0,
    wave: { index: 0, name: "prod" },
    deploymentTarget: {
      id: "019f0000-0000-7000-8000-00000000bbbb",
      name: "prod",
      environment: "prod",
      region: "nyc3",
      substrate: null,
      account: null,
      cluster: null
    },
    stageName: "commercial-nyc3-prod",
    maintainedBy: { domainId: null, name: "commercial", isSelf: true, role: "commander" },
    outpost: { state: "self", id: null, name: "commercial", trustTier: null, peerDomainId: null },
    binding: null,
    bindings: [
      {
        externalRef: "my-app",
        type: "configuration",
        category: "configuration",
        url: null,
        executionSystemId: null,
        executionSystemName: "argocd-prod"
      }
    ],
    current: null,
    currents: [],
    gate: { policies: [], checks: [] },
    version: null,
    unknownFields: ["version"],
    ...over
  };
}

const ARTIFACT: NonNullable<ComponentPipelineResponse["artifact"]> = {
  changeId: "019f0000-0000-7000-8000-00000000c4a6",
  changeName: "checkout-api@1.4.2",
  changeCreatedAt: "2026-08-15T09:00:00.000Z",
  digests: ["sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
  sbom: null,
  scans: [],
  exportGate: "not_run",
  signing: { promotionExports: [], originSignatureRefs: [] },
  unknownFields: []
};

const REGISTRY: NonNullable<ComponentPipelineResponse["registry"]> = {
  state: "declared",
  executionSystemId: "019f0000-0000-7000-8000-00000000fff0",
  name: "hq-registry",
  kind: "gitea",
  url: null,
  repository: "acme/checkout-api",
  edgeCount: 1
};

/** Three tiles of three kinds under one page-level scope — the flip must reach every KIND, not
 *  just the target cards. */
function page(): React.JSX.Element {
  return (
    <TileDetailsScope>
      <StageCardForTest stage={stage()} />
      <StageCardForTest
        stage={stage({
          placement: { id: "019f0000-0000-7000-8000-00000000aaab", urn: "urn:scp:o:placement:x/z" },
          stageName: "commercial-nyc3-gamma"
        })}
      />
      <RegistryNodeForTest registry={REGISTRY} artifact={ARTIFACT} />
      <ScanSignNodeForTest artifact={ARTIFACT} />
    </TileDetailsScope>
  );
}

function toggles(container: HTMLElement): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>('[data-testid="tile-details-toggle"]')];
}
function regions(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="tile-details"]')];
}
function states(container: HTMLElement): string[] {
  return toggles(container).map((t) => t.getAttribute("aria-expanded") ?? "?");
}
/** A real bubbling click on a SPECIFIC node (several tiles share the toggle testid), flushed
 *  through `act` by `fire`. */
function click(el: HTMLElement): void {
  fire(el, new MouseEvent("click", { bubbles: true, cancelable: true }));
}

describe("§10.3 — the Details controls actually move the tiles", () => {
  it("mounts four tiles, all collapsed, and one page-level control reading `Expand all`", () => {
    const r = render(page());
    expect(toggles(r.container)).toHaveLength(4);
    expect(states(r.container)).toEqual(["false", "false", "false", "false"]);
    for (const region of regions(r.container)) {
      expect(region.hidden).toBe(true);
      expect(region.childElementCount, "a shut region mounts NOTHING").toBe(0);
    }
    const all = r.byTestId("pipeline-details-toggle-all");
    expect(all.textContent).toContain("Expand all");
    expect(all.getAttribute("data-expanded-all")).toBe("unset");
    r.unmount();
  });

  it("a tile's chevron opens ITS region (and only its), reveals the detail rows, and closes it again", () => {
    const r = render(page());
    const [first] = toggles(r.container);
    if (!first) throw new Error("no toggle rendered");
    click(first);
    expect(states(r.container)).toEqual(["true", "false", "false", "false"]);
    const [region] = regions(r.container);
    expect(region?.hidden).toBe(false);
    expect(region?.getAttribute("data-state")).toBe("open");
    expect(region?.querySelector('[data-testid="stage-maintainer"]')).not.toBeNull();
    expect(region?.querySelector('[data-testid="stage-current"]')).not.toBeNull();
    // aria-controls names exactly this region.
    expect(first.getAttribute("aria-controls")).toBe(region?.id);
    click(first);
    expect(states(r.container)).toEqual(["false", "false", "false", "false"]);
    expect(region?.childElementCount).toBe(0);
    r.unmount();
  });

  it("Expand all opens EVERY tile of every kind; Collapse all shuts them all", () => {
    const r = render(page());
    r.click("pipeline-details-toggle-all");
    expect(states(r.container)).toEqual(["true", "true", "true", "true"]);
    const all = r.byTestId("pipeline-details-toggle-all");
    expect(all.textContent).toContain("Collapse all");
    expect(all.getAttribute("data-expanded-all")).toBe("true");
    // Each KIND's detail content is really there.
    expect(r.container.querySelectorAll('[data-testid="stage-maintainer"]')).toHaveLength(2);
    expect(
      r.container.querySelector('[data-testid="pipeline-registry-provenance"]')
    ).not.toBeNull();
    expect(r.container.querySelector('[data-testid="pipeline-origin-signature"]')).not.toBeNull();

    r.click("pipeline-details-toggle-all");
    expect(states(r.container)).toEqual(["false", "false", "false", "false"]);
    expect(r.byTestId("pipeline-details-toggle-all").textContent).toContain("Expand all");
    expect(r.container.querySelectorAll('[data-testid="stage-maintainer"]')).toHaveLength(0);
    r.unmount();
  });

  it("a tile's own chevron overrides the page-level state locally — until the next page-level flip, which wins again", () => {
    const r = render(page());
    // Expand all, then shut ONE tile by hand: three open, one shut.
    r.click("pipeline-details-toggle-all");
    const [, second] = toggles(r.container);
    if (!second) throw new Error("no second toggle");
    click(second);
    expect(states(r.container)).toEqual(["true", "false", "true", "true"]);
    // The page-level control still reads as "all expanded" — it reports ITS ask, not a tally.
    expect(r.byTestId("pipeline-details-toggle-all").textContent).toContain("Collapse all");

    // Collapse all: everything shuts, the override included.
    r.click("pipeline-details-toggle-all");
    expect(states(r.container)).toEqual(["false", "false", "false", "false"]);
    // Open ONE by hand under "all collapsed"…
    click(second);
    expect(states(r.container)).toEqual(["false", "true", "false", "false"]);
    // …then Expand all: the hand-opened tile stays open (it agrees), the rest open too.
    r.click("pipeline-details-toggle-all");
    expect(states(r.container)).toEqual(["true", "true", "true", "true"]);
    // Shut it by hand, Collapse all, Expand all: the stale "shut" override has EXPIRED — the
    // version bumped twice — so it opens with the rest instead of remembering the hand-shut.
    click(second);
    expect(states(r.container)).toEqual(["true", "false", "true", "true"]);
    r.click("pipeline-details-toggle-all");
    r.click("pipeline-details-toggle-all");
    expect(states(r.container)).toEqual(["true", "true", "true", "true"]);
    r.unmount();
  });

  it("nothing is persisted — a fresh mount is collapsed again whatever the last mount did", () => {
    const r1 = render(page());
    r1.click("pipeline-details-toggle-all");
    expect(states(r1.container)).toEqual(["true", "true", "true", "true"]);
    r1.unmount();
    const r2 = render(page());
    expect(states(r2.container)).toEqual(["false", "false", "false", "false"]);
    if (typeof globalThis.localStorage !== "undefined") {
      expect(globalThis.localStorage.length, "no localStorage — per-tile state is page-local").toBe(
        0
      );
    }
    r2.unmount();
  });
});
