import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentPipelineCorrelatedInfraChange } from "@scp/schemas";
import {
  CorrelatedInfraSection,
  LANES,
  correlatedInfraSentence,
  showsCorrelatedInfra
} from "./component-pipeline";

/**
 * THE CORRELATED-INFRASTRUCTURE SECTION (owner decision, 2026-08-24) — the rendering half.
 * `component-pipeline-correlated-infra.integration.test.ts` (server) proves the response is
 * computed correctly; this proves the client paints exactly what the response states, keeps
 * absent (older server) distinguishable from empty (evaluated, none), and never mounts the
 * section on the software lane, whose pipeline has nothing this fact is about.
 */
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children?: React.ReactNode; to?: string }) => (
    <a data-to={to}>{children}</a>
  )
}));

const SOFTWARE_LANE = LANES.find((l) => l.key === "software")!;
const INFRA_LANE = LANES.find((l) => l.key === "infrastructure")!;

function entry(
  overrides: Partial<ComponentPipelineCorrelatedInfraChange> = {}
): ComponentPipelineCorrelatedInfraChange {
  return {
    changeObjectId: "11111111-1111-7111-8111-111111111111",
    name: "tf-apply-gamma",
    state: "accepted",
    type: "infrastructure",
    createdAt: "2026-08-24T12:00:00.000Z",
    correlatedVia: {
      route: "placement",
      target: { objectId: "22222222-2222-7222-8222-222222222222", name: "gamma" }
    },
    coupledKey: null,
    ...overrides
  };
}

describe("correlatedInfraSentence — provenance, per route", () => {
  it("a `placement` match names the target and says this component is placed there", () => {
    expect(
      correlatedInfraSentence(
        entry({ correlatedVia: { route: "placement", target: { objectId: "x", name: "gamma" } } })
      )
    ).toBe("infrastructure change on gamma — this component is placed there");
  });

  it("a `hosted_on` match names the target and says hosted on it", () => {
    expect(
      correlatedInfraSentence(
        entry({ correlatedVia: { route: "hosted_on", target: { objectId: "x", name: "prod" } } })
      )
    ).toBe("infrastructure change on prod — hosted on it");
  });

  it("a `coupling` match names no place — it names the key instead", () => {
    expect(
      correlatedInfraSentence(
        entry({
          correlatedVia: { route: "coupling", target: null },
          coupledKey: "feature-a"
        })
      )
    ).toBe("provides feature-a");
  });

  it("`placement` is the PRIMARY route even when a `coupledKey` also rides along", () => {
    // Both arms matched (owner decision: placement/hosted_on wins the sentence, coupledKey is
    // still carried on the wire but does not change what is SAID).
    expect(
      correlatedInfraSentence(
        entry({
          correlatedVia: { route: "placement", target: { objectId: "x", name: "gamma" } },
          coupledKey: "feature-a"
        })
      )
    ).toBe("infrastructure change on gamma — this component is placed there");
  });
});

describe("CorrelatedInfraSection — absent vs empty vs populated", () => {
  it("renders NO section at all when the field is absent (undefined — an older server)", () => {
    const html = renderToStaticMarkup(<CorrelatedInfraSection correlatedInfra={undefined} />);
    expect(html).toBe("");
  });

  it("renders NO section when the field is null", () => {
    const html = renderToStaticMarkup(<CorrelatedInfraSection correlatedInfra={null} />);
    expect(html).toBe("");
  });

  it("renders the section with the quiet line when evaluated and empty", () => {
    const html = renderToStaticMarkup(<CorrelatedInfraSection correlatedInfra={{ changes: [] }} />);
    expect(html).toContain('data-testid="pipeline-correlated-infra"');
    expect(html).toContain('data-testid="pipeline-correlated-infra-empty"');
    expect(html).toContain("No correlated infrastructure changes observed.");
  });

  it("renders one entry per correlated change: name (linked), state badge, and provenance sentence", () => {
    const html = renderToStaticMarkup(
      <CorrelatedInfraSection
        correlatedInfra={{
          changes: [entry({ name: "tf-apply-gamma", state: "accepted", changeObjectId: "chg-1" })]
        }}
      />
    );
    expect(html).toContain('data-testid="pipeline-correlated-infra-entry"');
    expect(html).toContain("tf-apply-gamma");
    expect(html).toContain('data-to="/changes/$id"');
    expect(html).toContain('data-testid="pipeline-correlated-infra-state"');
    expect(html).toContain("accepted");
    expect(html).toContain("infrastructure change on gamma — this component is placed there");
  });

  it("an unnamed change renders the stated placeholder, never a blank", () => {
    const html = renderToStaticMarkup(
      <CorrelatedInfraSection correlatedInfra={{ changes: [entry({ name: null })] }} />
    );
    expect(html).toContain("(unnamed change)");
  });
});

describe("showsCorrelatedInfra — infrastructure lane only", () => {
  it("is true for the infrastructure lane", () => {
    expect(showsCorrelatedInfra(INFRA_LANE)).toBe(true);
  });

  it("is false for the software lane — its pipeline has no infra to correlate against", () => {
    expect(showsCorrelatedInfra(SOFTWARE_LANE)).toBe(false);
  });
});
