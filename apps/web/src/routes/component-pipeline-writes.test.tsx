import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ComponentPipelineResponse,
  ComponentPipelineStage,
  ComponentPipelineUnplacedStage
} from "@scp/sdk";

/**
 * A1 + B2 (docs/proposals/outpost-ui.md §3/§4) — the two writes this file adds to what was, before
 * this round, a read-only view: source-mapping create/delete, and placement create/delete. Same
 * harness as `component-pipeline-continuous.test.tsx` (plain `renderToStaticMarkup`, no jsdom) and
 * the same `Link` stub — none of the components pinned here use it, but the module-level import in
 * `component-pipeline.tsx` still resolves through this mock when the file loads.
 *
 * Radix's `SelectContent`/`DialogContent` both portal their children, which render nothing under
 * `renderToStaticMarkup` (domain-local.test.tsx's precedent, reconfirmed by
 * `registry-list-nested-domains.test.tsx`'s G2 parent-domain picker). So this file pins two
 * different things depending on what a component actually claims:
 *   - a Select/Dialog TRIGGER's presence, label, and testid — genuinely static, safe to assert;
 *   - the VALUE that reaches a request body — via the pure payload-builder functions, never by
 *     trying to read a portaled option list back out of static HTML.
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

const {
  buildCreateMappingPayload,
  buildDeleteMappingPayload,
  DeleteMappingConfirmBody,
  RemovePlacementConfirmBody,
  SourceMappingForm,
  PlaceAtTargetPicker,
  StageCardForTest,
  UnplacedStageCardForTest
} = await import("./component-pipeline");

function renderWithQueryClient(node: React.JSX.Element): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
  );
}

const MAPPING: ComponentPipelineResponse["sources"][number] = {
  id: "019f0000-0000-7000-8000-0000000000aa",
  sourceKind: "github",
  repoPattern: "jag8765/agentkit-bootstrap",
  pathPattern: null,
  refPattern: null,
  type: "configuration",
  category: "configuration",
  classification: null,
  mirrorOfShared: false,
  enabled: true,
  disabledUntil: null,
  effectivelyEnabled: true,
  url: "https://github.com/jag8765/agentkit-bootstrap",
  scope: null
};

function placedStage(over: Partial<ComponentPipelineStage> = {}): ComponentPipelineStage {
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
    outpost: {
      state: "self",
      id: null,
      name: "commercial",
      trustTier: null,
      peerDomainId: null,
      peerRole: null
    },
    binding: null,
    bindings: [],
    current: null,
    currents: [],
    gate: { policies: [], checks: [] },
    version: null,
    unknownFields: ["version"],
    ...over
  };
}

function unplacedStage(
  over: Partial<ComponentPipelineUnplacedStage> = {}
): ComponentPipelineUnplacedStage {
  return {
    order: 1,
    wave: { index: 1, name: "prod" },
    deploymentTarget: {
      id: "019f0000-0000-7000-8000-00000000dddd",
      name: "prod (DOKS hosted)",
      environment: "prod",
      region: "nyc3",
      substrate: null,
      account: null,
      cluster: null
    },
    stageName: "commercial-nyc3-prod",
    maintainedBy: { domainId: null, name: "commercial", isSelf: true, role: "commander" },
    outpost: {
      state: "self",
      id: null,
      name: "commercial",
      trustTier: null,
      peerDomainId: null,
      peerRole: null
    },
    ...over
  };
}

describe("A1 — source-mapping authoring", () => {
  it("buildCreateMappingPayload passes filled fields through and omits blanks (never sends '')", () => {
    const filled = buildCreateMappingPayload({
      repoPattern: "jag8765/agentkit-bootstrap",
      pathPattern: "deploy/",
      refPattern: "refs/heads/main",
      component: "comp-1",
      type: "image",
      classification: "dev"
    });
    expect(filled).toEqual({
      component: "comp-1",
      repoPattern: "jag8765/agentkit-bootstrap",
      pathPattern: "deploy/",
      refPattern: "refs/heads/main",
      type: "image",
      classification: "dev"
    });

    const blank = buildCreateMappingPayload({
      repoPattern: "  ",
      pathPattern: "",
      refPattern: "",
      component: "comp-1",
      type: "configuration",
      classification: ""
    });
    expect(blank.repoPattern).toBeUndefined();
    expect(blank.pathPattern).toBeUndefined();
    expect(blank.refPattern).toBeUndefined();
    expect(blank.classification).toBeUndefined();
    // The Type is a live choice on this form (A1's whole point), not a value worth omitting —
    // unlike the create-source-mapping wire schema, this builder always states it.
    expect(blank.type).toBe("configuration");
    // mirrorOfShared (outpost-ui.md §9.3a): omitted when unticked — the wire's default is
    // domain-specific, and an unticked box must change NOTHING on the wire (same rule as an empty
    // classification). Present as `true` only when declared.
    expect("mirrorOfShared" in blank).toBe(false);
    expect("mirrorOfShared" in filled).toBe(false);
    const declared = buildCreateMappingPayload({
      repoPattern: "field/shared-asg-mirror",
      pathPattern: "",
      refPattern: "",
      component: "comp-1",
      type: "infrastructure",
      classification: "",
      mirrorOfShared: true
    });
    expect(declared.mirrorOfShared).toBe(true);
  });

  it("SourceMappingForm offers exactly the request schema's operator-facing fields — component is implicit (this page IS the component), nothing else is added or missing", () => {
    const html = renderWithQueryClient(
      <SourceMappingForm
        componentId="comp-1"
        pipelineKey={["pipeline", "comp-1"]}
        onDone={() => {}}
      />
    );
    for (const testid of [
      "mapping-source-kind-select",
      "mapping-type-select",
      "mapping-classification-select",
      "mapping-mirror-of-shared",
      "mapping-repo-input",
      "mapping-path-input",
      "mapping-ref-input",
      "mapping-create-submit"
    ]) {
      expect(html, `missing ${testid}`).toContain(`data-testid="${testid}"`);
    }
    expect(html).toContain("Source kind");
    expect(html).toContain("Repo pattern");
    expect(html).toContain("Path pattern");
    expect(html).toContain("Ref pattern");
    expect(html).toContain("Classification");
    // §9.3a: the declaration is stated as what it is — a mirror of the commander's source — and
    // the help copy names both the case it is for and its inertness.
    expect(html).toContain("mirror of a commander-shared source");
    expect(html).toContain("Declared, never inferred");
    // No operator-facing "component" field — CreateSourceMappingRequestSchema's `component` is
    // filled from the route param, never re-asked.
    expect(html).not.toMatch(/>\s*Component\s*</);
  });

  it("the ref-pattern help text names BOTH halves: empty means any branch, and the amber warning is not a display quirk", () => {
    const html = renderWithQueryClient(
      <SourceMappingForm componentId="comp-1" pipelineKey={["k"]} onDone={() => {}} />
    );
    expect(html).toContain("any branch");
    expect(html).toContain("not a display quirk");
    // A1: there is deliberately no edit endpoint — the form itself says so next to the field most
    // likely to need one (a mapping with no ref filter, ADR-0030 §1).
    expect(html).toContain("no edit");
  });

  it("buildDeleteMappingPayload sends the full identity tuple (component + repo/path/ref/type), never an id", () => {
    const payload = buildDeleteMappingPayload(
      {
        repoPattern: "jag8765/agentkit-bootstrap",
        pathPattern: null,
        refPattern: null,
        type: "configuration"
      },
      "comp-1"
    );
    expect(payload).toEqual({
      component: "comp-1",
      repoPattern: "jag8765/agentkit-bootstrap",
      pathPattern: null,
      refPattern: null,
      type: "configuration"
    });
    expect(payload).not.toHaveProperty("id");
  });

  it("DeleteMappingConfirmBody honestly states ALL byte-identical rows go at once, and that there is no edit", () => {
    const html = renderToStaticMarkup(<DeleteMappingConfirmBody source={MAPPING} />);
    // The server's actual behavior (`DeleteSourceMappingRequestSchema`'s own doc): every row
    // matching the tuple is removed, including duplicates `discovery accept` can leave behind.
    expect(html).toContain("ALL of them go at once");
    expect(html).toContain("This cannot be undone");
    expect(html).toContain("there is no edit");
    expect(html).toContain(MAPPING.sourceKind);
  });
});

describe("B2 — placements", () => {
  it("an unplaced stage offers 'Place at target…' exactly where the dead prose used to be, and the dead prose is gone", () => {
    const withAffordance = renderWithQueryClient(
      <UnplacedStageCardForTest
        detailsExpanded
        stage={unplacedStage()}
        componentId="comp-1"
        pipelineKey={["pipeline", "comp-1"]}
      />
    );
    expect(withAffordance).toContain('data-testid="place-at-target-button"');
    expect(withAffordance).toContain("Place at target");
    // The OLD instruction sentence dies with the affordance that replaces it — it told the
    // operator what to do with no way to do it.
    expect(withAffordance).not.toContain("Declare a placement");
    // The honest FACT (this stage is unreached) survives — only the dead call-to-action is gone.
    expect(withAffordance).toContain("never reach this stage");
  });

  it("without componentId/pipelineKey (the pre-B2 call shape), no affordance renders and the honesty prose is untouched — proves the new props are additive, not a behavior change for old callers", () => {
    const html = renderToStaticMarkup(
      <UnplacedStageCardForTest detailsExpanded stage={unplacedStage()} />
    );
    expect(html).not.toContain("Place at target");
    expect(html).not.toContain('data-testid="place-at-target-button"');
    expect(html).toContain("never reach this stage");
    expect(html).toContain("Not placed");
  });

  it("PlaceAtTargetPicker's default render is closed — just the affordance button, not a live query", () => {
    const html = renderWithQueryClient(
      <PlaceAtTargetPicker componentId="comp-1" pipelineKey={["pipeline", "comp-1"]} />
    );
    expect(html).toContain('data-testid="place-at-target-button"');
    expect(html).not.toContain('data-testid="place-at-target-select"');
  });

  it("a placed stage offers a quiet remove-placement affordance once the page wires pipelineKey through", () => {
    const withAffordance = renderWithQueryClient(
      <StageCardForTest
        detailsExpanded
        stage={placedStage()}
        pipelineKey={["pipeline", "comp-1"]}
      />
    );
    expect(withAffordance).toContain('data-testid="remove-placement-button"');
    expect(withAffordance).toContain("Remove placement");
  });

  it("without pipelineKey (the pre-B2 call shape), the placed-stage card renders with no remove affordance and no query-client dependency", () => {
    // No QueryClientProvider wrapper here at all — this is the exact call
    // `component-pipeline-continuous.test.tsx` makes, and it must still need none.
    const html = renderToStaticMarkup(<StageCardForTest detailsExpanded stage={placedStage()} />);
    expect(html).not.toContain('data-testid="remove-placement-button"');
  });

  it("RemovePlacementConfirmBody names the real consequence — the stage is lost, and nothing is undeployed (coordination, not execution)", () => {
    const html = renderToStaticMarkup(<RemovePlacementConfirmBody stageName="prod" />);
    expect(html).toContain("loses its prod stage");
    expect(html).toContain("Nothing here is undeployed");
    expect(html).toContain("does not run them");
  });
});
