// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentPipelineResponse } from "@scp/schemas";

/**
 * THE DELETE-THE-WIRING GATE for the correlated-infrastructure section (owner decision,
 * 2026-08-24). `component-pipeline-correlated-infra.test.tsx` proves `CorrelatedInfraSection`
 * renders every claim correctly — by mounting the SECTION directly. That leaves the one line that
 * makes the feature real (`ComponentPipelinePage`'s `showsCorrelatedInfra(lane) ?
 * <CorrelatedInfraSection …>` mount) covered by nothing: the review lens's delete-the-wiring
 * mutation removed it and the whole suite stayed green — the repo's recorded dominant failure
 * class (a component built, tested directly, installed nowhere). This file closes that gate at
 * the PAGE level, through the same mock harness `change-pipeline-hold.test.tsx` established:
 * mock the two hooks and `useQuery`, render the REAL page, and assert on what MOUNTS.
 *
 * MUTATION-PROVEN (re-run when touching the mount): removing the
 * `showsCorrelatedInfra(lane) ? <CorrelatedInfraSection …> : null` lines from
 * `component-pipeline.tsx` reds the first test here by name while the section's own direct tests
 * stay green — which is exactly the gap this file exists to close.
 */
const COMPONENT_ID = "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children?: React.ReactNode; to?: string }) => (
    <a data-to={to}>{children}</a>
  )
}));

vi.mock("../lib/use-route-params", () => ({
  useIdOrUrnParam: () => COMPONENT_ID
}));

vi.mock("../lib/client", () => ({ client: {} }));

// `instanceRole: "commander"` keeps `scopeToSelf` false, so the page issues only the pipeline
// query and the federation-self query stays disabled — one fixture feeds the whole render.
vi.mock("../lib/auth-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/auth-context")>()),
  useAuth: () => ({ user: { instanceRole: "commander" } })
}));

const pipelineData = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({
    data: pipelineData.current,
    isLoading: false,
    isError: false,
    error: null
  })
}));

const { ComponentPipelinePage, LANES } = await import("./component-pipeline");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

const INFRA_LANE = LANES.find((l) => l.key === "infrastructure")!;

/** `useQuery` is mocked above (canned data); the provider exists only for the OTHER react-query
 *  hooks the page's subtree reaches (`useQueryClient` et al.), which the mock spread leaves real. */
function renderPage(lane?: (typeof LANES)[number]): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      {lane ? <ComponentPipelinePage lane={lane} /> : <ComponentPipelinePage />}
    </QueryClientProvider>
  );
}

/** Typed against the REAL response type (the untyped-fixture rule): a schema change that adds a
 *  required field fails HERE at compile time instead of silently drifting. */
function pipelineFixture(): ComponentPipelineResponse {
  return {
    component: {
      id: COMPONENT_ID,
      urn: `urn:scp:component:${COMPONENT_ID}`,
      name: "agentkit-bootstrap",
      maintainedBy: null
    },
    pipeline: null,
    stageSource: "placements",
    sources: [],
    stages: [],
    unplacedStages: [],
    correlatedInfra: {
      changes: [
        {
          changeObjectId: "4e5f6a7b-8c9d-4e0f-8a1b-2c3d4e5f6a7b",
          name: "tf-apply-shared-vpc",
          state: "accepted",
          type: "infrastructure",
          createdAt: "2026-08-24T12:00:00.000Z",
          correlatedVia: {
            route: "placement",
            target: { objectId: "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c", name: "gamma" }
          },
          coupledKey: null
        }
      ]
    },
    unknownFields: []
  } as unknown as ComponentPipelineResponse;
}

describe("the correlated-infrastructure section is WIRED into the page, not merely buildable", () => {
  it("mounts on the infrastructure lane with the response's entries — through the real ComponentPipelinePage", () => {
    pipelineData.current = pipelineFixture();
    const html = renderPage(INFRA_LANE);
    expect(html).toContain('data-testid="pipeline-correlated-infra"');
    expect(html).toContain("tf-apply-shared-vpc");
    expect(html).toContain("infrastructure change on gamma — this component is placed there");
  });

  it("never mounts on the software lane — same data, default lane", () => {
    pipelineData.current = pipelineFixture();
    const html = renderPage();
    expect(html).not.toContain('data-testid="pipeline-correlated-infra"');
  });
});
