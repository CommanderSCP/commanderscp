import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Change, ChangeExplainResponse, ChangePlan } from "@scp/sdk";

/**
 * `ChangeWaveSchema.entry` chips on the change-pipeline connector (D1, 2026-09-16,
 * docs/proposals/pipeline-mockup-data.md §4/§9): BOTH fan-in facts — the build-arm fan-in of one
 * push (`coupled_changes`, arrow into wave 0) and the previous wave's own completion
 * (`previous_wave`, arrow between waves) — render as SEPARATE chips, and an unknown count must
 * never render as a fabricated "0 of 0".
 */

const CHANGE_ID = "3f1a2b3c-4d5e-4f60-9a1b-2c3d4e5f6a7c";
const TARGET_A = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e90";
const TARGET_B = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e91";

const explainData = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

vi.mock("../lib/use-route-params", () => ({ useIdParam: () => CHANGE_ID }));

vi.mock("../lib/client", () => ({ client: {} }));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const data = queryKey[1] === "detail" ? explainData.current : undefined;
    return { data, isLoading: false, isError: false, error: null };
  }
}));

const { ChangePipelinePage } = await import("./change-pipeline");

const change = {
  id: CHANGE_ID,
  urn: `urn:scp:change:${CHANGE_ID}`,
  name: "wave-entry fixture",
  state: "executing",
  emergency: false,
  correlationKey: null,
  sourceKind: null,
  createdAt: "2026-09-16T10:00:00.000Z",
  updatedAt: "2026-09-16T10:00:00.000Z"
} as unknown as Change;

function wave(overrides: Record<string, unknown>) {
  return {
    id: `wave-${overrides.waveIndex}`,
    waveIndex: 0,
    name: null,
    status: "pending",
    requiresFanIn: false,
    startedAt: null,
    completedAt: null,
    targets: [],
    ...overrides
  };
}

function target(targetObjectId: string, status: string) {
  return {
    id: `target-${targetObjectId}`,
    targetObjectId,
    targetName: null,
    targetUrn: null,
    status,
    category: "deploy",
    type: "configuration",
    executorRef: null,
    observed: null
  };
}

function renderPage(
  plan: ChangePlan | null,
  waitStatus: ChangeExplainResponse["waitStatus"] = null
): string {
  explainData.current = {
    change,
    plan,
    decisions: [],
    controlRuns: [],
    waitStatus,
    boundarySegment: null
  } satisfies ChangeExplainResponse;
  return renderToStaticMarkup(<ChangePipelinePage />);
}

describe("change pipeline: ChangeWaveSchema.entry chips", () => {
  it("wave 0's connector shows the coupled_changes chip, live-counted, while parked", () => {
    const plan = {
      id: "plan-1",
      changeObjectId: CHANGE_ID,
      createdAt: "2026-09-16T10:00:00.000Z",
      waves: [wave({ waveIndex: 0, targets: [target(TARGET_A, "pending")], entry: [
        { kind: "coupled_changes", satisfiedCount: 1, requiredCount: 2 }
      ] })]
    } as unknown as ChangePlan;
    const waitStatus: ChangeExplainResponse["waitStatus"] = {
      waiting: true,
      requirements: [
        {
          key: "image",
          at: TARGET_A,
          atName: "image",
          satisfied: true,
          satisfiedByChangeId: "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e92"
        },
        {
          key: "chart",
          at: TARGET_B,
          atName: "chart",
          satisfied: false,
          satisfiedByChangeId: null
        }
      ]
    };
    const html = renderPage(plan, waitStatus);

    expect(html).toContain('data-testid="promotion-chip"');
    expect(html).toContain("fan-in pending · 1 of 2");
  });

  it("wave 0's connector shows NO chip when `entry` is absent — unknown, never a fabricated 0 of 0", () => {
    const plan = {
      id: "plan-1",
      changeObjectId: CHANGE_ID,
      createdAt: "2026-09-16T10:00:00.000Z",
      // `entry` OMITTED — an older server. `waitStatus` still present (requirements exist).
      waves: [wave({ waveIndex: 0, targets: [target(TARGET_A, "pending")] })]
    } as unknown as ChangePlan;
    const waitStatus: ChangeExplainResponse["waitStatus"] = {
      waiting: true,
      requirements: [
        { key: "image", at: TARGET_A, atName: "image", satisfied: false, satisfiedByChangeId: null }
      ]
    };
    const html = renderPage(plan, waitStatus);

    // The label-only rendering survives (pre-existing behaviour)...
    expect(html).toContain("waiting on prerequisite");
    // ...but NO chip, and — the honesty property under test — no fabricated count anywhere.
    expect(html).not.toContain('data-testid="promotion-chip"');
    expect(html).not.toContain("0 of 0");
  });

  it("the connector BETWEEN waves shows the previous_wave chip once the predecessor completes", () => {
    const plan = {
      id: "plan-2",
      changeObjectId: CHANGE_ID,
      createdAt: "2026-09-16T10:00:00.000Z",
      waves: [
        wave({ waveIndex: 0, status: "succeeded", targets: [target(TARGET_A, "succeeded")] }),
        wave({
          waveIndex: 1,
          status: "running",
          targets: [target(TARGET_B, "pending")],
          entry: [{ kind: "previous_wave", satisfiedCount: 1, requiredCount: 1 }]
        })
      ]
    } as unknown as ChangePlan;
    const html = renderPage(plan);

    expect(html).toContain('data-testid="promotion-chip"');
    expect(html).toContain("previous wave satisfied · 1 of 1");
  });

  it("a single-wave plan with no `requires` and no predecessor shows no chip at all", () => {
    const plan = {
      id: "plan-3",
      changeObjectId: CHANGE_ID,
      createdAt: "2026-09-16T10:00:00.000Z",
      waves: [wave({ waveIndex: 0, targets: [target(TARGET_A, "pending")] })]
    } as unknown as ChangePlan;
    const html = renderPage(plan, null);

    expect(html).not.toContain('data-testid="promotion-chip"');
  });
});
