import { describe, expect, it } from "vitest";
import { HookFreshnessContextSchema } from "@scp/schemas";
import {
  buildHookFreshnessContext,
  evaluateBakeGate,
  evaluateContinuousHold,
  evaluatePostDeployGate,
  type BakeAlarmReport
} from "./pipeline-hook-verdicts.js";

/**
 * Pure-verdict tests for `packages/schemas/src/pipeline-behaviors.ts`'s four hook mechanisms.
 * `now` is injected throughout, never mocked — the module never reads the clock itself.
 */

const NOW = new Date(Date.UTC(2026, 7, 26, 12, 0, 0));
const iso = (msFromNow: number) => new Date(NOW.getTime() + msFromNow).toISOString();

describe("evaluateContinuousHold — the three-way absence/failure/health split", () => {
  it("holds with no_evidence when nothing has ever reported", () => {
    const verdict = evaluateContinuousHold({ maxAgeSeconds: 60 }, null, NOW);
    expect(verdict).toEqual({
      held: true,
      reason: "no_evidence",
      staleAfter: null,
      lastReportedAt: null
    });
  });

  it("holds with failed when the latest evidence outcome is failed", () => {
    const completedAt = iso(-1_000);
    const verdict = evaluateContinuousHold(
      { maxAgeSeconds: 60 },
      { outcome: "failed", completedAt },
      NOW
    );
    expect(verdict.held).toBe(true);
    expect(verdict.reason).toBe("failed");
    expect(verdict.lastReportedAt).toBe(completedAt);
  });

  it("holds with stale when passed evidence has aged past maxAgeSeconds", () => {
    // completed 120s ago, maxAge 60s -> staleAfter is 60s ago, which is <= now.
    const completedAt = iso(-120_000);
    const verdict = evaluateContinuousHold(
      { maxAgeSeconds: 60 },
      { outcome: "passed", completedAt },
      NOW
    );
    expect(verdict.held).toBe(true);
    expect(verdict.reason).toBe("stale");
    expect(verdict.staleAfter).toBe(new Date(NOW.getTime() - 60_000).toISOString());
  });

  it("does not hold when passed evidence is within maxAgeSeconds", () => {
    const completedAt = iso(-30_000);
    const verdict = evaluateContinuousHold(
      { maxAgeSeconds: 60 },
      { outcome: "passed", completedAt },
      NOW
    );
    expect(verdict.held).toBe(false);
    expect(verdict.reason).toBeUndefined();
  });

  it("stale-passed and failed are DIFFERENT operator actions and must produce different reasons", () => {
    const staleVerdict = evaluateContinuousHold(
      { maxAgeSeconds: 60 },
      { outcome: "passed", completedAt: iso(-120_000) },
      NOW
    );
    const failedVerdict = evaluateContinuousHold(
      { maxAgeSeconds: 60 },
      { outcome: "failed", completedAt: iso(-1_000) },
      NOW
    );
    expect(staleVerdict.reason).not.toBe(failedVerdict.reason);
    expect(staleVerdict.reason).toBe("stale");
    expect(failedVerdict.reason).toBe("failed");
  });
});

describe("evaluateBakeGate — the safety interlock", () => {
  const hook = { quietWindowSeconds: 3600 };
  const deployedAt = NOW;
  const windowEnd = new Date(deployedAt.getTime() + hook.quietWindowSeconds * 1000);

  function report(
    source: BakeAlarmReport["source"],
    windowStart: Date,
    windowEndArg: Date,
    alarms: BakeAlarmReport["evidence"]["alarms"] = []
  ): BakeAlarmReport {
    return {
      source,
      evidence: {
        windowStart: windowStart.toISOString(),
        windowEnd: windowEndArg.toISOString(),
        alarms
      }
    };
  }

  it("zero reports is no_source, distinct from window_not_covered", () => {
    const verdict = evaluateBakeGate(hook, [], deployedAt, NOW);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toBe("no_source");
  });

  it("a single source fully covering the window with zero alarms satisfies the gate", () => {
    const reports = [report("pushed", deployedAt, windowEnd)];
    const verdict = evaluateBakeGate(hook, reports, deployedAt, NOW);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.reason).toBe("quiet");
    expect(verdict.coveredBy).toEqual(["pushed"]);
  });

  it("air-gap case: a pushed report alone satisfies the gate even when rollout_analysis never reported", () => {
    const reports = [report("pushed", deployedAt, windowEnd)];
    const verdict = evaluateBakeGate(hook, reports, deployedAt, NOW);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.coveredBy).toEqual(["pushed"]);
  });

  it("a report covering only PART of the window does not satisfy", () => {
    const halfway = new Date(deployedAt.getTime() + (hook.quietWindowSeconds * 1000) / 2);
    const reports = [report("pushed", deployedAt, halfway)];
    const verdict = evaluateBakeGate(hook, reports, deployedAt, NOW);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toBe("window_not_covered");
  });

  it("an alarm from pushed alone holds the gate even when rollout_analysis reports quiet", () => {
    const reports = [
      report("rollout_analysis", deployedAt, windowEnd, []),
      report("pushed", deployedAt, windowEnd, [
        { name: "cpu-high", severity: "critical", firedAt: new Date(deployedAt.getTime() + 100).toISOString() }
      ])
    ];
    const verdict = evaluateBakeGate(hook, reports, deployedAt, NOW);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toBe("alarm_firing");
  });

  it("an alarm from rollout_analysis alone holds the gate even when pushed reports quiet", () => {
    const reports = [
      report("pushed", deployedAt, windowEnd, []),
      report("rollout_analysis", deployedAt, windowEnd, [
        { name: "5xx-rate", severity: "warning", firedAt: new Date(deployedAt.getTime() + 100).toISOString() }
      ])
    ];
    const verdict = evaluateBakeGate(hook, reports, deployedAt, NOW);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toBe("alarm_firing");
  });

  it("two reports from ONE source with a GAP between them do NOT cover the window", () => {
    const quarter = hook.quietWindowSeconds * 1000 * 0.25;
    // covers [0, 0.25*W] and [0.75*W, W] — leaves a gap in the middle.
    const reports = [
      report("pushed", deployedAt, new Date(deployedAt.getTime() + quarter)),
      report("pushed", new Date(deployedAt.getTime() + quarter * 3), windowEnd)
    ];
    const verdict = evaluateBakeGate(hook, reports, deployedAt, NOW);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toBe("window_not_covered");
  });

  it("the SAME two reports made contiguous DO cover the window", () => {
    const midpoint = new Date(deployedAt.getTime() + (hook.quietWindowSeconds * 1000) / 2);
    const reports = [
      report("pushed", deployedAt, midpoint),
      report("pushed", midpoint, windowEnd)
    ];
    const verdict = evaluateBakeGate(hook, reports, deployedAt, NOW);
    expect(verdict.satisfied).toBe(true);
    expect(verdict.reason).toBe("quiet");
  });

  it("reports from two DIFFERENT sources that would jointly span the window do NOT satisfy it (coverage is per-source)", () => {
    const midpoint = new Date(deployedAt.getTime() + (hook.quietWindowSeconds * 1000) / 2);
    const reports = [
      report("rollout_analysis", deployedAt, midpoint),
      report("pushed", midpoint, windowEnd)
    ];
    const verdict = evaluateBakeGate(hook, reports, deployedAt, NOW);
    expect(verdict.satisfied).toBe(false);
    expect(verdict.reason).toBe("window_not_covered");
  });
});

describe("evaluatePostDeployGate — awaiting is not failure", () => {
  it("absent evidence is awaiting, never fail", () => {
    const verdict = evaluatePostDeployGate({ hookId: "it" }, null, NOW);
    expect(verdict.outcome).toBe("awaiting");
  });

  it("passed evidence is pass", () => {
    const verdict = evaluatePostDeployGate({ hookId: "it" }, { outcome: "passed" }, NOW);
    expect(verdict.outcome).toBe("pass");
  });

  it("failed evidence is fail", () => {
    const verdict = evaluatePostDeployGate({ hookId: "it" }, { outcome: "failed" }, NOW);
    expect(verdict.outcome).toBe("fail");
  });
});

describe("buildHookFreshnessContext — byte-stable across ticks, no now inside", () => {
  it("parses against HookFreshnessContextSchema and carries no timestamp equal to a `now` used elsewhere", () => {
    const completedAt = iso(-30_000);
    const context = buildHookFreshnessContext(
      { kind: "continuous", hookId: "canary-probe", maxAgeSeconds: 60 },
      {
        evidenceId: "00000000-0000-0000-0000-000000000000",
        outcome: "passed",
        completedAt,
        artifactDigest: null,
        commitSha: null
      }
    );

    const parsed = HookFreshnessContextSchema.parse(context);
    expect(parsed.staleAfter).toBe(new Date(new Date(completedAt).getTime() + 60_000).toISOString());

    // No field in the record equals NOW itself — the record carries only data derived from the
    // evidence's own completedAt and the declared maxAgeSeconds, never the clock it was built at.
    const values = [context.staleAfter, context.latestEvidence?.completedAt ?? null];
    expect(values).not.toContain(NOW.toISOString());
  });

  it("is identical for the same evidence regardless of when it is called (no now parameter exists)", () => {
    const evidence = {
      evidenceId: "00000000-0000-0000-0000-000000000001",
      outcome: "passed" as const,
      completedAt: iso(-500_000),
      artifactDigest: null,
      commitSha: null
    };
    const hook = { kind: "continuous" as const, hookId: "canary-probe", maxAgeSeconds: 300 };
    const first = buildHookFreshnessContext(hook, evidence);
    const second = buildHookFreshnessContext(hook, evidence);
    expect(first).toEqual(second);
  });

  it("staleAfter is null when there is no evidence to age", () => {
    const context = buildHookFreshnessContext(
      { kind: "continuous", hookId: "canary-probe", maxAgeSeconds: 60 },
      null
    );
    expect(context.staleAfter).toBeNull();
    expect(HookFreshnessContextSchema.parse(context).staleAfter).toBeNull();
  });
});
