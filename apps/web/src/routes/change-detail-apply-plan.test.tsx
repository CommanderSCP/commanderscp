// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { ChangeExplainResponse } from "@scp/sdk";
import { flush, render } from "../test-support/render-dom";

/** M28.3 (ADR-0056) — the UI half of plan → approve → apply. The plan's evidence already renders
 *  (the plan chip, `PipelineWaveCard`); approving it is the existing Accept button. What this adds
 *  is the APPLY: on an accepted plan change, one button that proposes the change the server's apply
 *  gate reads — and these tests click it and check WHAT IS SENT, not what the button says. */

const PLAN_CHANGE_ID = "3f1a2b3c-4d5e-4f60-9a1b-2c3d4e5f6a7b";
const PLANNED_TARGET = "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b";
const UNPLANNED_TARGET = "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c";
const APPLY_CHANGE_ID = "6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d";

const explainData = vi.hoisted(() => ({ current: undefined as unknown }));
const propose = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => navigate
}));
vi.mock("../lib/use-route-params", () => ({ useIdParam: () => PLAN_CHANGE_ID }));
vi.mock("../lib/client", () => ({ client: { changes: { propose } } }));
vi.mock("../lib/use-object-names", () => ({ useObjectNames: () => new Map() }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const data = queryKey[1] === "detail" ? explainData.current : undefined;
    return { data, isLoading: false, isError: false, error: null };
  }
}));

const { ChangeDetailPage } = await import("./change-detail");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

function target(id: string, observed: unknown, pluginModule = "argo-workflows") {
  return {
    id: `${id.slice(0, 8)}-0000-4000-8000-000000000000`,
    waveId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
    targetObjectId: id,
    status: "succeeded",
    category: "infrastructure",
    type: "infrastructure",
    executorPluginId: "argo-workflows:1",
    executor: { basis: "triggered", pluginModule },
    executorRef: { externalId: "wf::uid" },
    observed,
    attempt: 1,
    lastObservedAt: null,
    createdAt: "2026-09-23T10:00:00.000Z",
    updatedAt: "2026-09-23T10:00:00.000Z"
  };
}

function explain(overrides: Record<string, unknown> = {}): ChangeExplainResponse {
  return {
    change: {
      id: PLAN_CHANGE_ID,
      urn: `urn:scp:change:${PLAN_CHANGE_ID}`,
      name: "prod-us-east-1 network",
      state: "accepted",
      emergency: false,
      correlationKey: null,
      sourceKind: null,
      rollbackOfObjectId: null,
      properties: {},
      domainLocal: false,
      createdAt: "2026-09-23T10:00:00.000Z",
      updatedAt: "2026-09-23T10:00:00.000Z",
      ...overrides
    },
    plan: {
      id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      status: "completed",
      waves: [
        {
          id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
          waveIndex: 0,
          name: null,
          status: "succeeded",
          requiresFanIn: true,
          startedAt: null,
          completedAt: null,
          targets: [
            target(PLANNED_TARGET, {
              plan: { ref: "a".repeat(64), add: 1, change: 0, destroy: 0 }
            }),
            target(UNPLANNED_TARGET, null)
          ]
        }
      ]
    },
    decisions: [],
    controlRuns: [],
    waitStatus: null,
    boundarySegment: null
  } as unknown as ChangeExplainResponse;
}

function renderPage(data: ChangeExplainResponse) {
  explainData.current = data;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ChangeDetailPage />
    </QueryClientProvider>
  );
}

describe("change detail: Apply this plan", () => {
  it("on an ACCEPTED plan change, proposes the apply the server's gate reads — only the planned targets", async () => {
    propose.mockReset();
    navigate.mockReset();
    propose.mockResolvedValue({ id: APPLY_CHANGE_ID });
    const view = renderPage(explain());
    // Premise: the evidence the approver accepted is on the page.
    expect(view.html()).toContain("observed-plan");

    view.click("apply-plan-button");
    await flush();

    expect(propose).toHaveBeenCalledTimes(1);
    expect(propose).toHaveBeenCalledWith({
      name: "apply: prod-us-east-1 network",
      targets: [PLANNED_TARGET],
      type: "infrastructure",
      properties: { infrastructure: { applyPlan: PLAN_CHANGE_ID } }
    });
    await flush();
    expect(navigate).toHaveBeenCalledWith({ to: "/changes/$id", params: { id: APPLY_CHANGE_ID } });
    view.unmount();
  });

  it("is ABSENT before the plan is accepted — Accept is the approval, and it comes first", () => {
    const view = renderPage(explain({ state: "validating" }));
    expect(view.html()).not.toContain('data-testid="apply-plan-button"');
    expect(view.html()).toContain('data-testid="accept-change-button"');
    view.unmount();
  });

  it("is ABSENT on an apply change, which instead names the plan it applies", () => {
    const view = renderPage(
      explain({
        properties: { infrastructure: { applyPlan: "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e" } }
      })
    );
    expect(view.html()).not.toContain('data-testid="apply-plan-button"');
    expect(view.byTestId("applies-plan").textContent).toContain(
      "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e"
    );
    view.unmount();
  });

  it("is ABSENT for a plan the Argo lane did not run — managed-iac's evidence has no apply gate yet", () => {
    const data = explain();
    const wave = (data.plan as unknown as { waves: { targets: unknown[] }[] }).waves[0]!;
    wave.targets = [
      target(
        PLANNED_TARGET,
        { plan: { ref: "b".repeat(64), add: 1, change: 0, destroy: 0 } },
        "managed-iac"
      )
    ];
    const view = renderPage(data);
    expect(view.html()).toContain("observed-plan");
    expect(view.html()).not.toContain('data-testid="apply-plan-button"');
    view.unmount();
  });

  it("is ABSENT on an accepted change with no plan evidence (an ordinary deploy)", () => {
    const data = explain();
    const wave = (data.plan as unknown as { waves: { targets: { observed: unknown }[] }[] })
      .waves[0]!;
    for (const t of wave.targets) t.observed = null;
    const view = renderPage(data);
    expect(view.html()).not.toContain('data-testid="apply-plan-button"');
    view.unmount();
  });
});
