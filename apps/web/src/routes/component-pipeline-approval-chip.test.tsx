import { describe, expect, it } from "vitest";
import type { ComponentPipelineStage } from "@scp/sdk";

/**
 * The component-pipeline connector's LIVE approval count (D2, 2026-09-16,
 * docs/proposals/pipeline-mockup-data.md §4/§9): `gate.approvals` — placed where the engine
 * actually gates (validating->accepted, `gates.ts:74`), never a new per-wave gate. PR #365 left
 * this chip's structure in place (`arrowInto`'s "approval" `PromotionState`, from
 * `changeState === "waiting"`) but with no live count; this file proves the count is now read, and
 * that an unknown count renders as unknown rather than a fabricated "0 of 0".
 */

const { arrowInto, buildJourney, LANES } = await import("./component-pipeline");

const SOFTWARE_LANE = LANES.find((l) => l.key === "software")!;

const CHANGE_ID = "019f0000-0000-7000-8000-0000000e0a01";

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

/** The `current` that makes `stateOf` report `approval` — `changeState: "waiting"`, matching
 *  `arrowInto`'s existing trigger (this file does not change WHEN the chip shows, only WHAT it
 *  says once it does). */
function waitingCurrent(changeId = CHANGE_ID) {
  return {
    changeId,
    changeName: "needs approval",
    changeState: "waiting" as const,
    waveName: "prod",
    targetStatus: "pending",
    type: "configuration" as const,
    category: "configuration" as const
  };
}

describe("component pipeline connector: the live approval chip (D2)", () => {
  it("reads the live requestId/voteCount/requiredCount/fromRole for the triggering stage's own current change", () => {
    const awaiting = stage({
      current: waitingCurrent(),
      currents: [waitingCurrent()],
      gate: {
        policies: [],
        checks: [],
        approvals: [
          {
            requestId: "019f0000-0000-7000-8000-0000000e0b01",
            changeId: CHANGE_ID,
            fromRole: "Owner",
            requiredCount: 2,
            voteCount: 1,
            status: "pending"
          }
        ]
      }
    });
    const [wave0] = buildJourney({ stages: [awaiting], unplacedStages: [] });

    const arrow = arrowInto(wave0!, SOFTWARE_LANE);
    expect(arrow.state).toBe("approval");
    expect(arrow.detail).toBe("1/2 · Owner");
  });

  it("an EMPTY approvals array (checked, nothing found for this change) renders NO count — never 0 of 0", () => {
    const awaiting = stage({
      current: waitingCurrent(),
      currents: [waitingCurrent()],
      gate: { policies: [], checks: [], approvals: [] }
    });
    const [wave0] = buildJourney({ stages: [awaiting], unplacedStages: [] });

    const arrow = arrowInto(wave0!, SOFTWARE_LANE);
    expect(arrow.state).toBe("approval");
    expect(arrow.label).toBe("awaiting approval");
    expect(arrow.detail).toBeUndefined();
  });

  it("`approvals` ABSENT (an older server) renders no count either — absent and empty are both honestly 'no count', never fabricated", () => {
    const awaiting = stage({
      current: waitingCurrent(),
      currents: [waitingCurrent()],
      gate: { policies: [], checks: [] }
    });
    const [wave0] = buildJourney({ stages: [awaiting], unplacedStages: [] });

    const arrow = arrowInto(wave0!, SOFTWARE_LANE);
    expect(arrow.state).toBe("approval");
    expect(arrow.detail).toBeUndefined();
  });

  it("an approvals entry for a DIFFERENT change (not this stage's current) is not attributed here", () => {
    const awaiting = stage({
      current: waitingCurrent(),
      currents: [waitingCurrent()],
      gate: {
        policies: [],
        checks: [],
        approvals: [
          {
            requestId: "019f0000-0000-7000-8000-0000000e0b02",
            changeId: "019f0000-0000-7000-8000-0000000e0a99",
            fromRole: "Owner",
            requiredCount: 1,
            voteCount: 1,
            status: "satisfied"
          }
        ]
      }
    });
    const [wave0] = buildJourney({ stages: [awaiting], unplacedStages: [] });

    const arrow = arrowInto(wave0!, SOFTWARE_LANE);
    expect(arrow.detail).toBeUndefined();
  });
});
