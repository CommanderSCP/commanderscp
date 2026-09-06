// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
// M5 types: @scp/schemas, not @scp/sdk — @scp/sdk's index.ts never added a Campaign re-export
// block (campaign-list.tsx's own note). `campaign-detail.tsx` already imports
// `RollbackCampaignResponse` the same way.
import type { CampaignExplainResponse } from "@scp/schemas";

/**
 * THE CAMPAIGN-LAYER HOLD-PARITY WIRING GATE (M25.UI) — the change-wave layer's freeze-hold
 * projection (`ChangeWaveTargetSchema.hold` / `ChangeWaveSchema.heldTargetCount`,
 * `change-pipeline-hold.test.tsx`) extended to campaign waves
 * (`CampaignWaveTargetSchema.hold` / `CampaignWaveSchema.heldTargetCount`).
 *
 * UNLIKE the change-pipeline hold fix, there is no separate value for `campaign-detail.tsx` to
 * discard: a campaign wave target's `hold` rides the target object itself (mirroring the FREEZE
 * half of `ChangeWaveTargetSchema.hold`, which `PipelineWaveCard` already reads straight off
 * `target.hold` with no side-channel prop), and `campaign-detail.tsx` already passes each
 * `explain()` wave straight into `PipelineWaveCard` unmodified
 * (`<PipelineWaveCard wave={wave} .../>`) — the card's `PipelineWaveLike`/`PipelineWaveTargetLike`
 * props are STRUCTURAL, satisfied by `CampaignWave`/`CampaignWaveTarget` the moment the wire type
 * carries the fields, exactly as that module's own contract states
 * ("campaign-detail.tsx migrates onto it later WITHOUT changes here").
 *
 * The gate this file still closes: nothing here proves the ACTUAL rendered page reflects that —
 * a future refactor of `campaign-detail.tsx` (e.g. mapping `wave` through an intermediate object
 * that drops unfamiliar keys, or hand-rolling a wave card instead of reusing
 * `PipelineWaveCard`) could silently stop passing `hold`/`heldTargetCount` through, and no
 * server-side or schema-side test would ever see it. `renderToStaticMarkup(<CampaignDetailPage/>)`
 * is the only altitude at which "the page renders what `explain()` sent" is a claim at all.
 *
 * MUTATION-PROVEN (re-run when touching the wave-board mount): replacing
 * `<PipelineWaveCard wave={wave} .../>` with a version that strips `hold`/`heldTargetCount` off
 * `wave` before passing it down reds every assertion in the first `it` here while
 * `PipelineWaveCard.test.tsx`'s own direct tests stay green — the same gap class
 * `component-pipeline-correlated-infra-wiring.test.tsx` closes for the component-pipeline page.
 */

const CAMPAIGN_ID = "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a";
const TARGET_ID = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f";
const OTHER_TARGET_ID = "6d7e8f9a-0b1c-4d2e-8f3a-4b5c6d7e8f9a";
const FREEZE_ID = "7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d";
const SCOPE_ID = "8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e";

const explainData = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>
}));

vi.mock("../lib/use-route-params", () => ({ useIdParam: () => CAMPAIGN_ID }));

vi.mock("../lib/client", () => ({ client: {} }));

vi.mock("../lib/use-object-names", () => ({ useObjectNames: () => new Map() }));

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const data = queryKey[1] === "detail" ? explainData.current : undefined;
    return { data, isLoading: false, isError: false, error: null };
  }
}));

const { CampaignDetailPage } = await import("./campaign-detail");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");

function renderPage(explain: CampaignExplainResponse): string {
  explainData.current = explain;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <CampaignDetailPage />
    </QueryClientProvider>
  );
}

/** One wave with TWO targets — one held by an active freeze, one not — so the "held badge only on
 *  the held row" claim and the "wave chip counts exactly the held ones" claim are both live
 *  assertions rather than vacuously true of a single-target fixture. */
function explainFixture(): CampaignExplainResponse {
  return {
    campaign: {
      id: CAMPAIGN_ID,
      orgId: "9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f",
      urn: `urn:scp:campaign:${CAMPAIGN_ID}`,
      name: "q3-rollout",
      description: "Q3 platform rollout",
      targets: [TARGET_ID, OTHER_TARGET_ID],
      topologyObjectId: null,
      topologyVersion: null,
      status: "blocked",
      deadline: null,
      createdAt: "2026-08-24T10:00:00.000Z",
      updatedAt: "2026-08-24T10:00:00.000Z"
    },
    plan: {
      id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      campaignObjectId: CAMPAIGN_ID,
      topologyObjectId: null,
      topologyVersion: null,
      status: "active",
      createdAt: "2026-08-24T10:00:00.000Z",
      waves: [
        {
          id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
          planId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
          waveIndex: 0,
          name: "gamma",
          requiresFanIn: false,
          status: "running",
          createdAt: "2026-08-24T10:00:00.000Z",
          startedAt: "2026-08-24T10:01:00.000Z",
          completedAt: null,
          heldTargetCount: 1,
          targets: [
            {
              id: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
              waveId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
              targetObjectId: TARGET_ID,
              memberChangeObjectId: null,
              hold: {
                freezes: [
                  {
                    freezeId: FREEZE_ID,
                    scope: { objectId: SCOPE_ID, name: "gamma" },
                    summary: "held by an active org-tier freeze (gamma) until 2026-08-25T00:00:00Z",
                    endsAt: "2026-08-25T00:00:00.000Z"
                  }
                ]
              },
              status: "pending",
              createdAt: "2026-08-24T10:00:00.000Z",
              updatedAt: "2026-08-24T10:00:00.000Z"
            },
            {
              id: "3d4e5f6a-7b8c-4d9e-0f0a-1b2c3d4e5f6a",
              waveId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
              targetObjectId: OTHER_TARGET_ID,
              memberChangeObjectId: null,
              status: "pending",
              createdAt: "2026-08-24T10:00:00.000Z",
              updatedAt: "2026-08-24T10:00:00.000Z"
            }
          ]
        }
      ]
    },
    decisions: []
  } as unknown as CampaignExplainResponse;
}

describe("campaign detail page: wave-target freeze hold (M25.UI, campaign-layer parity)", () => {
  it("marks the frozen target held, names the freeze's scope, and the wave chip counts exactly the held ones", () => {
    const html = renderPage(explainFixture());

    // Premise: the page and its wave board actually mounted.
    expect(html).toContain('data-testid="campaign-name"');
    expect(html).toContain('data-testid="campaign-wave-card"');
    expect(html).toContain('data-testid="campaign-wave-target-row"');

    // THE HELD TARGET: badge + freeze line, server-composed summary rendered verbatim.
    expect(html).toContain('data-testid="pipeline-wave-target-held-badge"');
    expect(html).toContain('data-testid="pipeline-wave-target-freeze-hold"');
    expect(html).toContain('data-testid="pipeline-wave-target-freeze-hold-line"');
    expect(html).toContain("held by an active org-tier freeze (gamma) until 2026-08-25T00:00:00Z");

    // THE WAVE-LEVEL CHIP — amber, fed only by the server's own count.
    expect(html).toContain('data-testid="campaign-wave-held-count-badge"');
    expect(html).toContain("1 held");

    // THE RAW STATUS SURVIVES beside the hold, exactly as the change-wave layer's own fix requires.
    expect(html).toContain("pending");
  });

  it("the unheld sibling target in the SAME wave carries no held badge or freeze line", () => {
    const html = renderPage(explainFixture());
    const rows = html.match(/data-testid="campaign-wave-target-row"/g) ?? [];
    expect(rows).toHaveLength(2);
    // ...but only ONE held badge (the frozen target's), not a fixture-wide leak onto its sibling.
    const heldBadges = html.match(/data-testid="pipeline-wave-target-held-badge"/g) ?? [];
    expect(heldBadges).toHaveLength(1);
  });

  it("renders unchanged for a wave/target with neither field — an older server, or a wave admission does not yet govern", () => {
    const fixture = explainFixture();
    // Strip both fields, the way a pre-M25.UI server (or a non-active wave) would respond: never
    // fabricated zeros, simply absent.
    const wave = fixture.plan!.waves[0]!;
    delete (wave as Record<string, unknown>).heldTargetCount;
    delete (wave.targets[0] as Record<string, unknown>).hold;

    const html = renderPage(fixture);
    expect(html).toContain('data-testid="campaign-wave-target-row"');
    expect(html).not.toContain('data-testid="pipeline-wave-target-held-badge"');
    expect(html).not.toContain('data-testid="pipeline-wave-target-freeze-hold"');
    expect(html).not.toContain('data-testid="campaign-wave-held-count-badge"');
  });
});
