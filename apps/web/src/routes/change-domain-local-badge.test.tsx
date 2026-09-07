import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BoundarySegment, Change, ChangeExplainResponse } from "@scp/sdk";

/** M20-A3 (ADR-0031 §5, docs/proposals/outpost-ui.md). See docs/web.md §194. */

const { NoBoundarySegment } = await import("../components/pipeline/BoundarySegmentStrip");

const CHANGE_ID = "3f1a2b3c-4d5e-4f60-9a1b-2c3d4e5f6a7b";

describe("NoBoundarySegment: the domain-local branch names the honest reason", () => {
  it("defaults to the generic 'not yet promoted' reading when domainLocal is omitted", () => {
    const html = renderToStaticMarkup(<NoBoundarySegment />);
    expect(html).toContain('data-testid="boundary-segment-absent"');
    expect(html).toContain("has not crossed a domain boundary");
    expect(html).not.toContain("never leaves its domain");
  });

  it("states false explicitly the same way as omitted (both are the ordinary case)", () => {
    const html = renderToStaticMarkup(<NoBoundarySegment domainLocal={false} />);
    expect(html).toContain("has not crossed a domain boundary");
    expect(html).not.toContain("never leaves its domain");
  });

  it("names the domain-local reason instead of the generic one when domainLocal is true", () => {
    const html = renderToStaticMarkup(<NoBoundarySegment domainLocal />);
    expect(html).toContain('data-testid="boundary-segment-absent"');
    expect(html).toContain("never leaves its domain");
    expect(html).toContain("no boundary to cross");
    // The generic reading must not ALSO be present — an operator reading this must get one
    // unambiguous reason, not both glued together.
    expect(html).not.toContain("has not crossed a domain boundary");
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Page-level: ChangePipelinePage wires `change.domainLocal` to the badge and to the copy above.
// ---------------------------------------------------------------------------------------------

const explainData = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

vi.mock("../lib/use-route-params", () => ({
  useIdParam: () => CHANGE_ID
}));

vi.mock("../lib/client", () => ({ client: {} }));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const data = queryKey[1] === "detail" ? explainData.current : undefined;
    return { data, isLoading: false, isError: false, error: null };
  }
}));

const { ChangePipelinePage } = await import("./change-pipeline");

function changeFixture(domainLocal: boolean): Change {
  return {
    id: CHANGE_ID,
    urn: `urn:scp:change:${CHANGE_ID}`,
    name: "m20-a3 badge fixture",
    state: "executing",
    emergency: false,
    correlationKey: null,
    sourceKind: null,
    createdAt: "2026-08-13T10:00:00.000Z",
    updatedAt: "2026-08-13T10:00:00.000Z",
    domainLocal
  } as unknown as Change;
}

function renderPage(domainLocal: boolean, boundarySegment: BoundarySegment | null = null): string {
  explainData.current = {
    change: changeFixture(domainLocal),
    plan: null,
    decisions: [],
    controlRuns: [],
    waitStatus: null,
    boundarySegment
  } satisfies ChangeExplainResponse;
  return renderToStaticMarkup(<ChangePipelinePage />);
}

describe("ChangePipelinePage: the domain-local badge and boundary copy follow change.domainLocal", () => {
  it("renders the domain-local badge next to the change title when domainLocal is true", () => {
    const html = renderPage(true);
    expect(html).toContain('data-testid="pipeline-change-name"');
    expect(html).toContain('data-testid="domain-local-badge"');
  });

  it("renders NO domain-local badge for an ordinary change", () => {
    const html = renderPage(false);
    expect(html).toContain('data-testid="pipeline-change-name"');
    expect(html).not.toContain('data-testid="domain-local-badge"');
  });

  it("the page's absent-boundary copy is the domain-local reason, not the generic one, for a domain-local change", () => {
    const html = renderPage(true, null);
    expect(html).toContain('data-testid="boundary-segment-absent"');
    expect(html).toContain("never leaves its domain");
    expect(html).not.toContain("has not crossed a domain boundary");
  });

  it("the page's absent-boundary copy stays the generic reading for an ordinary un-promoted change", () => {
    const html = renderPage(false, null);
    expect(html).toContain('data-testid="boundary-segment-absent"');
    expect(html).toContain("has not crossed a domain boundary");
    expect(html).not.toContain("never leaves its domain");
  });
});
