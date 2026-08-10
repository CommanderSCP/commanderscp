import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  Change,
  ChangeExplainResponse,
  ChangePlan,
  ChangeStageDependencyStatus
} from "@scp/sdk";

/**
 * A HELD WAVE TARGET MUST NOT RENDER AS A BARE `pending` — the CHANGE-pipeline page (ADR-0028
 * increment 4).
 *
 * ## The defect this pins, and why it survived the increment
 *
 * A target whose trigger is being withheld by a stage dependency is left at
 * `change_wave_targets.status = 'pending'`: the hold `continue`s in `reconcile.ts` BEFORE
 * `triggerWaveTarget`, so nothing ever writes a different status. `pending` is also what a target
 * shows when its wave has simply not reached it. Those are opposite facts — "waiting on something
 * NAMED, and it will clear itself" versus "nothing is happening here" — and they were the same
 * pixels.
 *
 * The component-pipeline view was fixed for this. THIS page was not, while the ADR and the proposal
 * were flipped to say every surface had shipped. The data was already on the wire and on this very
 * page's `explain` response: `change-pipeline.tsx` destructured the response and left
 * `stageDependencyStatus` behind. So the failure mode was not a missing feature but a discarded
 * value, which is invisible to every test that asserts on the server's response.
 *
 * ## Why at the PAGE and not at `PipelineWaveCard`
 *
 * `holdFor` is optional on the card, deliberately: a caller that has not loaded the status must not
 * thereby assert nothing is held. That makes a card-level test unable to catch the actual bug —
 * the card was always capable of rendering a hold once handed one, and the page was the thing not
 * handing it over. `renderToStaticMarkup(<ChangePipelinePage/>)` is the only altitude at which
 * "the page passes the status down" is a claim. Same seam and same mocking as
 * `change-pipeline-boundary-always-shown.test.tsx`, for the reasons its header sets out.
 */

const CHANGE_ID = "3f1a2b3c-4d5e-4f60-9a1b-2c3d4e5f6a7b";
const TARGET_ID = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f";
const DEPENDENCY_ID = "7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d";

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
  name: "adr-0028 hold fixture",
  state: "executing",
  emergency: false,
  correlationKey: null,
  sourceKind: null,
  createdAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z"
} as unknown as Change;

/** One wave, one target, sitting at `pending` — the status a HELD target really has. The fixture
 *  does NOT invent a "held" status, because no such status exists; that is the entire problem. */
const plan = {
  id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  changeObjectId: CHANGE_ID,
  createdAt: "2026-08-10T10:00:00.000Z",
  waves: [
    {
      id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
      waveIndex: 0,
      name: "gamma",
      status: "running",
      requiresFanIn: false,
      startedAt: "2026-08-10T10:01:00.000Z",
      completedAt: null,
      targets: [
        {
          id: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
          targetObjectId: TARGET_ID,
          targetName: "agentkit-bootstrap @ gamma",
          targetUrn: null,
          status: "pending",
          category: "deploy",
          type: "configuration",
          executorRef: null,
          observed: null
        }
      ]
    }
  ]
} as unknown as ChangePlan;

const heldStatus: ChangeStageDependencyStatus = {
  held: true,
  waveIndex: 0,
  unenforced: false,
  targets: [
    {
      targetObjectId: TARGET_ID,
      targetName: "agentkit-bootstrap @ gamma",
      componentObjectId: "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a",
      componentName: "agentkit-bootstrap",
      deploymentTargetObjectId: "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b",
      deploymentTargetName: "homelab-gamma",
      held: true,
      dependencies: [
        {
          dependsOn: DEPENDENCY_ID,
          dependsOnName: "agentkit-api",
          branch: "never_deployed",
          satisfied: false,
          summary: `'${DEPENDENCY_ID}' is placed here but has never deployed here`
        }
      ]
    }
  ]
};

function renderPage(stageDependencyStatus: ChangeStageDependencyStatus | null | undefined): string {
  explainData.current = {
    change,
    plan,
    decisions: [],
    controlRuns: [],
    waitStatus: null,
    boundarySegment: null,
    ...(stageDependencyStatus === undefined ? {} : { stageDependencyStatus })
  } satisfies ChangeExplainResponse;
  return renderToStaticMarkup(<ChangePipelinePage />);
}

describe("change pipeline page: a held wave target (ADR-0028 increment 4)", () => {
  it("marks the target held and NAMES the dependency", () => {
    const html = renderPage(heldStatus);

    // Premise: the page rendered, and the wave/target rows with it.
    expect(html).toContain('data-testid="pipeline-change-name"');
    expect(html).toContain('data-testid="pipeline-wave-target-row"');

    // THE FIX. Without it this row is `data-held` absent and the only word on it is `pending`.
    expect(html).toContain('data-held="true"');
    expect(html).toContain('data-testid="pipeline-wave-target-held-badge"');

    // NAMED, which is the whole point — a badge saying only "held" moves the operator from "why is
    // this pending?" to "why is this held?" and no further.
    expect(html).toContain('data-testid="pipeline-wave-target-hold"');
    expect(html).toContain("agentkit-api");
    expect(html).toContain("has never deployed here");

    // AND THE RAW COLUMN SURVIVES. The recorded status really is `pending`; the fix adds a fact, it
    // does not overwrite one. If this ever goes red the page has started rewriting stored state.
    expect(html).toContain("pending");
  });

  it("leaves an UNHELD target exactly as it was — the badge is not decoration", () => {
    // The half that makes the case above mean something. Same plan, same `pending` target, and a
    // status whose verdicts are all satisfied: `held: false` must render as it always did.
    const unheld: ChangeStageDependencyStatus = {
      ...heldStatus,
      held: false,
      targets: [
        {
          ...heldStatus.targets[0]!,
          held: false,
          dependencies: [
            {
              ...heldStatus.targets[0]!.dependencies[0]!,
              branch: "succeeded",
              satisfied: true,
              summary: `'${DEPENDENCY_ID}' is satisfied here (succeeded)`
            }
          ]
        }
      ]
    };
    const html = renderPage(unheld);

    expect(html).toContain('data-testid="pipeline-wave-target-row"');
    expect(html).not.toContain('data-held="true"');
    expect(html).not.toContain('data-testid="pipeline-wave-target-hold"');
    // ...and it must not leak the dependency's name onto a target that is not waiting for it.
    expect(html).not.toContain("agentkit-api");
  });

  it("renders unchanged for a change that coupled nothing (null) and for an older server (omitted)", () => {
    // `stageDependencyStatus` is optional/nullable and additive within /v1. `null` is a current
    // server saying "this change coupled nothing at any stage"; an omitted key is a pre-increment-4
    // server saying nothing at all. NEITHER is a hold, and neither may blank the wave card.
    for (const value of [null, undefined] as const) {
      const html = renderPage(value);
      expect(html).toContain('data-testid="pipeline-wave-target-row"');
      expect(html).not.toContain('data-held="true"');
      expect(html).not.toContain('data-testid="pipeline-wave-target-hold"');
    }
  });
});
