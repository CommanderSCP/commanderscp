import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import { asTrustDomainId, type TestRunEvidence } from "@scp/schemas";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { changeWaveTargets, objects, pipelineHookRuns } from "../db/schema.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import {
  PEER_OBSERVATION_FRESHNESS_MS,
  recordPeerObservation
} from "../federation/peer-observations-repo.js";
import { compileAndPersistPlan } from "./plan-service.js";
import { recordAlarmEvidence, recordTestRunEvidence, upsertHook } from "./pipeline-hooks-repo.js";

/** docs/proposals/pipeline-mockup-data.md §3 (increment 3): `ChangeWaveTargetSchema.checks` — the
 *  per-target checks rail. Every assertion enters at the real route (`GET /changes/{id}:explain`),
 *  which is what actually exercises `resolveWaveTargetChecks`.
 *
 *  THE PROPERTY UNDER TEST throughout: the six absences the wire distinguishes stay six. A test
 *  that asserted only "the field is there" would pass just as happily against a projection that
 *  painted every one of them `not_run`. */
describe("pipeline-mockup-data increment 3: the checks rail", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "wave-target-checks");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  /** A component placed at its own fresh deployment target, wired into a one-wave topology whose
   *  wave NAME is the stage a stage-narrowed hook is matched against. */
  async function stageFixture(slug: string, stage = "gamma") {
    const deploymentTarget = await admin.deploymentTargets.create({
      name: `${slug}-dt-${randomUUID()}`
    });
    const topology = await admin.object("release-topology").create({
      name: `${slug}-topo-${randomUUID()}`,
      properties: {
        waves: [{ name: stage, mode: "parallel", targets: [deploymentTarget.id] }]
      }
    });
    const component = await createTestComponent(admin, { name: `${slug}-${randomUUID()}` });
    const placement = await admin.placements.create({
      component: component.id,
      deploymentTarget: deploymentTarget.id
    });
    const change = await admin.changes.propose({
      name: `${slug}-chg-${randomUUID()}`,
      targets: [component.id]
    });
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      compileAndPersistPlan(tx, {
        orgId: org.orgId,
        changeObjectId: change.id,
        targetObjectIds: [component.id],
        topologyObjectId: topology.id,
        topologyVersion: null
      })
    );
    return { component, placement, change, stage, deploymentTarget };
  }

  async function waveTargetRowFor(tx: TenantTx, targetObjectId: string) {
    const rows = await tx
      .select()
      .from(changeWaveTargets)
      .where(eq(changeWaveTargets.targetObjectId, targetObjectId))
      .orderBy(desc(changeWaveTargets.createdAt))
      .limit(1);
    const row = rows[0];
    if (!row || row.orgId !== org.orgId)
      throw new Error(`no wave target row for ${targetObjectId}`);
    return row;
  }

  /** The rail as the ROUTE returns it, keyed by kind for readable assertions. */
  async function railFor(changeId: string, targetObjectId: string) {
    const explained = await admin.changes.explain(changeId);
    const target = explained
      .plan!.waves.flatMap((w) => w.targets)
      .find((t) => t.targetObjectId === targetObjectId);
    if (!target) throw new Error(`no wave target for ${targetObjectId}`);
    return target.checks;
  }

  function slotsOf(checks: Awaited<ReturnType<typeof railFor>>) {
    if (!checks || checks.basis !== "resolved") {
      throw new Error(`expected a resolved rail, got ${JSON.stringify(checks)}`);
    }
    return new Map(checks.slots.map((s) => [s.kind, s]));
  }

  function evidence(
    hook: TestRunEvidence["hook"],
    hookId: string,
    patch: Partial<TestRunEvidence>
  ) {
    const completedAt = new Date().toISOString();
    return {
      kind: "testRun",
      hook,
      hookId,
      workflow: {
        repo: "git@example.invalid:org/pipelines.git",
        branch: "main",
        path: "workflows/probe.yaml",
        commitSha: "0".repeat(40),
        bundle: { repository: "registry.invalid/tests", digest: `sha256:${"a".repeat(64)}` }
      },
      runId: `run-${randomUUID()}`,
      outcome: "passed",
      startedAt: completedAt,
      completedAt,
      ...patch
    } satisfies TestRunEvidence;
  }

  /** Plants a `pipeline_hook_runs` row directly. The trigger path is a plugin dispatch with an
   *  executor binding behind it; this test is about the READ projection, and a direct insert is the
   *  only way to pin a specific recorded `status` (including `aborted`) deterministically. */
  async function plantRun(
    tx: TenantTx,
    input: {
      componentObjectId: string;
      targetObjectId: string | null;
      changeObjectId: string;
      hookId: string;
      kind: string;
      waveIndex: number | null;
      status: string;
      externalUrl?: string | null;
      lastObservedAt?: Date | null;
    }
  ) {
    await tx.insert(pipelineHookRuns).values({
      id: uuidv7(),
      orgId: org.orgId,
      componentObjectId: input.componentObjectId,
      targetObjectId: input.targetObjectId,
      changeObjectId: input.changeObjectId,
      hookId: input.hookId,
      kind: input.kind,
      waveIndex: input.waveIndex,
      status: input.status,
      pluginInstanceId: "test-instance",
      externalUrl: input.externalUrl ?? null,
      lastObservedAt: input.lastObservedAt ?? null
    });
  }

  // -------------------------------------------------------------------------------------------
  // NOT BOUND — the absence that must never be painted like a promised check going quiet
  // -------------------------------------------------------------------------------------------

  it("a component declaring NOTHING still gets all four slots, in pipeline order, each with an EMPTY hooks array", async () => {
    const { change, placement } = await stageFixture("none");

    const checks = await railFor(change.id, placement.id);
    expect(checks?.basis).toBe("resolved");
    const slots = (checks as { slots: { kind: string; grain: string; hooks: unknown[] }[] }).slots;

    // FIXED ORDER, ALWAYS FOUR. A projection that emitted only the declared kinds would make
    // "nothing is watching this" invisible, which is the entire reason the rail exists.
    expect(slots.map((s) => s.kind)).toEqual([
      "postMerge",
      "postDeploy",
      "continuous",
      "bakeAlarms"
    ]);
    // EMPTY = NOT DECLARED. Never a `not_run` entry, which would claim something promised it.
    expect(slots.every((s) => s.hooks.length === 0)).toBe(true);
    // GRAIN IS STATED so the UI cannot imply per-target evidence where none exists (§3.4).
    expect(slots.map((s) => s.grain)).toEqual([
      "per_change",
      "per_wave",
      "per_target",
      "per_target"
    ]);
  });

  // -------------------------------------------------------------------------------------------
  // postMerge / postDeploy — the run-backed kinds
  // -------------------------------------------------------------------------------------------

  it("a declared postMerge hook with NO run row reads `not_run` — bound and not reached, never an empty slot", async () => {
    const { change, placement, component } = await stageFixture("pm-notrun");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertHook(tx, org.orgId, {
        componentObjectId: component.id,
        kind: "postMerge",
        hookId: "unit"
      })
    );

    const slots = slotsOf(await railFor(change.id, placement.id));
    expect(slots.get("postMerge")!.hooks).toEqual([{ state: "not_run", hookId: "unit" }]);
    // THE DISTINCTION THAT MATTERS: the kinds nobody declared stay empty in the same response.
    expect(slots.get("postDeploy")!.hooks).toEqual([]);
  });

  it("postMerge run states: pending/running -> `running` with the recorded word, succeeded -> `passed`, aborted -> `failed` keeping `aborted`", async () => {
    for (const [status, expected] of [
      ["pending", "running"],
      ["running", "running"],
      ["succeeded", "passed"],
      ["failed", "failed"],
      ["aborted", "failed"]
    ] as const) {
      const { change, placement, component } = await stageFixture(`pm-${status}`);
      await withTenantTx(server.deps.db, org.orgId, async (tx) => {
        await upsertHook(tx, org.orgId, {
          componentObjectId: component.id,
          kind: "postMerge",
          hookId: "unit"
        });
        await plantRun(tx, {
          componentObjectId: component.id,
          // `postMerge` is not target-specific and belongs to no wave — both nulls, the identity
          // `HookRunIdentity` documents.
          targetObjectId: null,
          changeObjectId: change.id,
          hookId: "unit",
          kind: "postMerge",
          waveIndex: null,
          status,
          externalUrl: "https://ci.invalid/run/1",
          lastObservedAt: new Date("2026-09-19T10:00:00.000Z")
        });
      });

      const state = slotsOf(await railFor(change.id, placement.id)).get("postMerge")!.hooks[0]!;
      expect(state.state).toBe(expected);
      if (expected === "running") {
        // ONE STATE, TWO RECORDED WORDS: `pending` (dispatched) and `running` (started) are
        // different operator situations and the recorded word travels rather than being flattened.
        expect((state as { runStatus: string }).runStatus).toBe(status);
      }
      if (expected === "failed") {
        // ABORTED IS NOT SILENTLY RENAMED "failed".
        expect((state as { runStatus: string }).runStatus).toBe(status);
      }
      if (expected === "passed") {
        expect((state as { concludedAt: string }).concludedAt).toBe("2026-09-19T10:00:00.000Z");
      }
    }
  });

  it("a postDeploy run is read at THIS WAVE's index — a run at another wave index is not this wave's evidence", async () => {
    const { change, placement, component } = await stageFixture("pd-wave");
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await upsertHook(tx, org.orgId, {
        componentObjectId: component.id,
        kind: "postDeploy",
        hookId: "e2e"
      });
      // Wave 0 is the only wave here. A run recorded against wave 1 must NOT be shown on it.
      await plantRun(tx, {
        componentObjectId: component.id,
        targetObjectId: placement.id,
        changeObjectId: change.id,
        hookId: "e2e",
        kind: "postDeploy",
        waveIndex: 1,
        status: "succeeded"
      });
    });

    const slots = slotsOf(await railFor(change.id, placement.id));
    expect(slots.get("postDeploy")!.hooks[0]!.state).toBe("not_run");

    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      plantRun(tx, {
        componentObjectId: component.id,
        targetObjectId: placement.id,
        changeObjectId: change.id,
        hookId: "e2e",
        kind: "postDeploy",
        waveIndex: 0,
        status: "succeeded"
      })
    );
    const after = slotsOf(await railFor(change.id, placement.id));
    expect(after.get("postDeploy")!.hooks[0]!.state).toBe("passed");
  });

  // A run still `pending`/`running` when its CHANGE reaches a terminal state (cancelled/rolled
  // back) is closed by `closePipelineHookRunsForChange` (`coordination/transition.ts`, the SAME
  // property PR #373 closed for `approval_requests`). The rail must render that frozen run as
  // `running` (its `status` never moves — closing does not touch it) with `closedAt`/`closedReason`
  // populated, and MUST NOT render it as `failed`: the run never ran to a bad outcome, the change it
  // gated simply stopped mattering.
  it("a postDeploy run frozen by its change's cancellation stays `running` with closedAt/closedReason set — never `failed`", async () => {
    const { change, placement, component } = await stageFixture("pd-closed");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertHook(tx, org.orgId, {
        componentObjectId: component.id,
        kind: "postDeploy",
        hookId: "close-me"
      })
    );
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      plantRun(tx, {
        componentObjectId: component.id,
        targetObjectId: placement.id,
        changeObjectId: change.id,
        hookId: "close-me",
        kind: "postDeploy",
        waveIndex: 0,
        status: "running"
      })
    );

    const before = slotsOf(await railFor(change.id, placement.id)).get("postDeploy")!.hooks[0]!;
    expect(before.state).toBe("running");
    expect((before as { closedAt: string | null }).closedAt).toBeNull();

    const cancelled = await admin.changes.cancel(change.id, "closed-run render test");
    expect(cancelled.state).toBe("cancelled");

    const after = slotsOf(await railFor(change.id, placement.id)).get("postDeploy")!.hooks[0]!;
    // NOT "failed" — the whole point. Still `running`, because `status` is untouched by closure.
    expect(after.state).toBe("running");
    expect((after as { runStatus: string }).runStatus).toBe("running");
    expect((after as { closedAt: string | null }).closedAt).toBeTruthy();
    expect((after as { closedReason: string | null }).closedReason).toBe("cancelled");
  });

  it("a postDeploy hook narrowed to ANOTHER stage is `not_applicable`, with the server's own reason — never `not_run`", async () => {
    const { change, placement, component } = await stageFixture("pd-stage", "gamma");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertHook(tx, org.orgId, {
        componentObjectId: component.id,
        kind: "postDeploy",
        hookId: "prod-only",
        stage: "prod"
      })
    );

    const state = slotsOf(await railFor(change.id, placement.id)).get("postDeploy")!.hooks[0]!;
    expect(state.state).toBe("not_applicable");
    // `not_run` would say "this is waiting for something"; it will never run here.
    expect((state as { reason: string }).reason).toContain("stage 'prod'");
    expect((state as { reason: string }).reason).toContain("gamma");
  });

  it("a postMerge hook carrying a stage is `not_applicable` — the post-merge gate runs before any wave has one", async () => {
    const { change, placement, component } = await stageFixture("pm-stage");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertHook(tx, org.orgId, {
        componentObjectId: component.id,
        kind: "postMerge",
        hookId: "unit",
        stage: "gamma"
      })
    );

    const state = slotsOf(await railFor(change.id, placement.id)).get("postMerge")!.hooks[0]!;
    // THE SILENT-AUTHORING-MISTAKE CASE: the gate matches this against `stage: null` and skips it
    // forever. Rendering it `not_run` would hide a hook that can never fire.
    expect(state.state).toBe("not_applicable");
    expect((state as { reason: string }).reason).toContain("before any wave has a stage");
  });

  // -------------------------------------------------------------------------------------------
  // continuous — the four evidence verdicts
  // -------------------------------------------------------------------------------------------

  it("a declared continuous probe that has NEVER reported is `no_evidence` — not a pass, and not an empty slot", async () => {
    const { change, placement, component } = await stageFixture("cont-none");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertHook(tx, org.orgId, {
        componentObjectId: component.id,
        kind: "continuous",
        hookId: "smoke",
        maxAgeSeconds: 300
      })
    );

    const slots = slotsOf(await railFor(change.id, placement.id));
    expect(slots.get("continuous")!.hooks).toEqual([
      { state: "no_evidence", hookId: "smoke", maxAgeSeconds: 300 }
    ]);
    // THE HONESTY PAIR, in one response: the undeclared kinds are empty; this one is not. A
    // projection that collapsed them would satisfy neither assertion.
    expect(slots.get("bakeAlarms")!.hooks).toEqual([]);
  });

  it("fresh passing evidence is `passed`; evidence older than maxAgeSeconds is `stale` — ABSENT, never a stale pass", async () => {
    const { change, placement, component } = await stageFixture("cont-fresh");
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await upsertHook(tx, org.orgId, {
        componentObjectId: component.id,
        kind: "continuous",
        hookId: "smoke",
        maxAgeSeconds: 300
      });
      await recordTestRunEvidence(tx, org.orgId, {
        componentObjectId: component.id,
        targetObjectId: placement.id,
        hookId: "smoke",
        source: "pushed",
        evidence: evidence("continuous", "smoke", {})
      });
    });

    const fresh = slotsOf(await railFor(change.id, placement.id)).get("continuous")!.hooks[0]!;
    expect(fresh.state).toBe("passed");

    // The SAME probe, the SAME outcome, one older report: `passed` must become `stale`, because
    // `maxAgeSeconds`'s own contract says evidence older than it is ABSENT.
    const longAgo = new Date(Date.now() - 3600_000).toISOString();
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordTestRunEvidence(tx, org.orgId, {
        componentObjectId: component.id,
        targetObjectId: placement.id,
        hookId: "smoke",
        source: "pushed",
        evidence: evidence("continuous", "smoke", { completedAt: longAgo, startedAt: longAgo })
      })
    );

    const stale = slotsOf(await railFor(change.id, placement.id)).get("continuous")!.hooks[0]!;
    expect(stale.state).toBe("stale");
    const asStale = stale as {
      newestEvidenceAt: string;
      staleAfter: string;
      maxAgeSeconds: number;
    };
    expect(asStale.newestEvidenceAt).toBe(longAgo);
    expect(asStale.maxAgeSeconds).toBe(300);
    // The boundary is carried as DATA (`completedAt + maxAgeSeconds`); `now` never crosses the seam.
    expect(Date.parse(asStale.staleAfter)).toBe(Date.parse(longAgo) + 300_000);
  });

  it("failing evidence is `failed` — a claim about the TARGET, distinct from the two absences", async () => {
    const { change, placement, component } = await stageFixture("cont-fail");
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await upsertHook(tx, org.orgId, {
        componentObjectId: component.id,
        kind: "continuous",
        hookId: "smoke",
        maxAgeSeconds: 300
      });
      await recordTestRunEvidence(tx, org.orgId, {
        componentObjectId: component.id,
        targetObjectId: placement.id,
        hookId: "smoke",
        source: "pushed",
        evidence: evidence("continuous", "smoke", { outcome: "failed" })
      });
    });

    const state = slotsOf(await railFor(change.id, placement.id)).get("continuous")!.hooks[0]!;
    expect(state.state).toBe("failed");
    // No run row behind evidence — `null`, never an invented status word.
    expect((state as { runStatus: string | null }).runStatus).toBeNull();
  });

  it("a continuous row with no maxAgeSeconds declares no rule and is `not_applicable`, never defaulted to a window nobody wrote", async () => {
    const { change, placement, component } = await stageFixture("cont-norule");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertHook(tx, org.orgId, {
        componentObjectId: component.id,
        kind: "continuous",
        hookId: "smoke"
      })
    );

    const state = slotsOf(await railFor(change.id, placement.id)).get("continuous")!.hooks[0]!;
    expect(state.state).toBe("not_applicable");
    expect((state as { reason: string }).reason).toContain("no maxAgeSeconds");
  });

  // -------------------------------------------------------------------------------------------
  // bakeAlarms — including the state that reaches the wire from nowhere else
  // -------------------------------------------------------------------------------------------

  it("DECLARED BUT NOT STARTED: a bake hook on a target that has not deployed is `bake_not_started`, the state the GATE records nowhere", async () => {
    const { change, placement, component } = await stageFixture("bake-notstarted");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertHook(tx, org.orgId, {
        componentObjectId: component.id,
        kind: "bakeAlarms",
        hookId: "sev1",
        quietWindowSeconds: 600
      })
    );

    const slots = slotsOf(await railFor(change.id, placement.id));
    // The wave target is `pending` — `waveTargetDeployedAt` is null, so the window has not opened.
    // `pipeline-hook-gate.ts`'s `bakeEntry` returns null for exactly this case and writes nothing.
    expect(slots.get("bakeAlarms")!.hooks).toEqual([
      { state: "bake_not_started", hookId: "sev1", quietWindowSeconds: 600 }
    ]);
    // AND IT IS NOT THE UNDECLARED SLOT. Something promised this window.
    expect(slots.get("continuous")!.hooks).toEqual([]);
  });

  it("a deployed target with an OPEN window is `baking`; the same window with no source once it has elapsed is `no_source`", async () => {
    const { change, placement, component } = await stageFixture("bake-open");
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await upsertHook(tx, org.orgId, {
        componentObjectId: component.id,
        kind: "bakeAlarms",
        hookId: "sev1",
        quietWindowSeconds: 600
      });
      const row = await waveTargetRowFor(tx, placement.id);
      await tx
        .update(changeWaveTargets)
        .set({ status: "succeeded", lastObservedAt: new Date(), updatedAt: new Date() })
        .where(eq(changeWaveTargets.id, row.id));
    });

    const baking = slotsOf(await railFor(change.id, placement.id)).get("bakeAlarms")!.hooks[0]!;
    // NOTHING IS ESTABLISHED YET. Reporting `no_source` here would blame a producer that still has
    // ten minutes to report.
    expect(baking.state).toBe("baking");

    // Move the deploy instant into the past so the same window has now ELAPSED with no report.
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const row = await waveTargetRowFor(tx, placement.id);
      await tx
        .update(changeWaveTargets)
        .set({ lastObservedAt: new Date(Date.now() - 3600_000) })
        .where(eq(changeWaveTargets.id, row.id));
    });

    const elapsed = slotsOf(await railFor(change.id, placement.id)).get("bakeAlarms")!.hooks[0]!;
    expect(elapsed.state).toBe("no_source");
  });

  it("a covered window is `quiet` and names its sources; a firing alarm is `alarm_firing` with the EARLIEST firedAt", async () => {
    const { change, placement, component } = await stageFixture("bake-quiet");
    const deployedAt = new Date(Date.now() - 3600_000);
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await upsertHook(tx, org.orgId, {
        componentObjectId: component.id,
        kind: "bakeAlarms",
        hookId: "sev1",
        quietWindowSeconds: 600
      });
      const row = await waveTargetRowFor(tx, placement.id);
      await tx
        .update(changeWaveTargets)
        .set({ status: "succeeded", lastObservedAt: deployedAt, updatedAt: new Date() })
        .where(eq(changeWaveTargets.id, row.id));
      await recordAlarmEvidence(tx, org.orgId, {
        componentObjectId: component.id,
        targetObjectId: placement.id,
        hookId: "sev1",
        source: "pushed",
        evidence: {
          kind: "alarmState",
          hookId: "sev1",
          windowStart: new Date(deployedAt.getTime() - 1000).toISOString(),
          windowEnd: new Date(deployedAt.getTime() + 700_000).toISOString(),
          // EMPTY = an affirmative "nothing fired". Absent evidence is not this.
          alarms: []
        }
      });
    });

    const quiet = slotsOf(await railFor(change.id, placement.id)).get("bakeAlarms")!.hooks[0]!;
    expect(quiet.state).toBe("quiet");
    expect((quiet as { coveredBy: string[] }).coveredBy).toEqual(["pushed"]);

    // One firing alarm from ANY source wins outright — the gate is fail-safe on firing, and the
    // rail must not keep saying "clear" because another source covered the window.
    const firstFire = new Date(deployedAt.getTime() + 60_000).toISOString();
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordAlarmEvidence(tx, org.orgId, {
        componentObjectId: component.id,
        targetObjectId: placement.id,
        hookId: "sev1",
        source: "rollout_analysis",
        evidence: {
          kind: "alarmState",
          hookId: "sev1",
          windowStart: deployedAt.toISOString(),
          windowEnd: new Date(deployedAt.getTime() + 700_000).toISOString(),
          alarms: [
            {
              name: "error-rate",
              severity: "critical",
              firedAt: new Date(deployedAt.getTime() + 120_000).toISOString()
            },
            { name: "latency", severity: "warning", firedAt: firstFire }
          ]
        }
      })
    );

    const firing = slotsOf(await railFor(change.id, placement.id)).get("bakeAlarms")!.hooks[0]!;
    expect(firing.state).toBe("alarm_firing");
    expect((firing as { since: string }).since).toBe(firstFire);
  });

  it("a bakeAlarms row with no quietWindowSeconds declares no window and is `not_applicable`", async () => {
    const { change, placement, component } = await stageFixture("bake-nowindow");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertHook(tx, org.orgId, {
        componentObjectId: component.id,
        kind: "bakeAlarms",
        hookId: "sev1"
      })
    );

    const state = slotsOf(await railFor(change.id, placement.id)).get("bakeAlarms")!.hooks[0]!;
    expect(state.state).toBe("not_applicable");
    expect((state as { reason: string }).reason).toContain("no quietWindowSeconds");
  });

  // -------------------------------------------------------------------------------------------
  // All four at once, plus the unresolvable case
  // -------------------------------------------------------------------------------------------

  it("all four kinds declared at once each report their own state, and hooks within a slot are sorted by hookId", async () => {
    const { change, placement, component } = await stageFixture("all-four");
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      for (const hookId of ["zeta", "alpha"]) {
        await upsertHook(tx, org.orgId, {
          componentObjectId: component.id,
          kind: "postMerge",
          hookId
        });
      }
      await upsertHook(tx, org.orgId, {
        componentObjectId: component.id,
        kind: "postDeploy",
        hookId: "e2e"
      });
      await upsertHook(tx, org.orgId, {
        componentObjectId: component.id,
        kind: "continuous",
        hookId: "smoke",
        maxAgeSeconds: 300
      });
      await upsertHook(tx, org.orgId, {
        componentObjectId: component.id,
        kind: "bakeAlarms",
        hookId: "sev1",
        quietWindowSeconds: 600
      });
      await plantRun(tx, {
        componentObjectId: component.id,
        targetObjectId: null,
        changeObjectId: change.id,
        hookId: "alpha",
        kind: "postMerge",
        waveIndex: null,
        status: "succeeded"
      });
    });

    const slots = slotsOf(await railFor(change.id, placement.id));
    // SORTED BY hookId, so a reordered query result can never change the response.
    expect(slots.get("postMerge")!.hooks.map((h) => h.hookId)).toEqual(["alpha", "zeta"]);
    expect(slots.get("postMerge")!.hooks.map((h) => h.state)).toEqual(["passed", "not_run"]);
    // FOUR KINDS, FOUR DIFFERENT ANSWERS, in one response — the shape the mockup's rail draws.
    expect(slots.get("postDeploy")!.hooks[0]!.state).toBe("not_run");
    expect(slots.get("continuous")!.hooks[0]!.state).toBe("no_evidence");
    expect(slots.get("bakeAlarms")!.hooks[0]!.state).toBe("bake_not_started");
  });

  it("a wave target whose object has been deleted reports `unresolvable`, never four empty slots", async () => {
    const { change, placement, component } = await stageFixture("gone");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertHook(tx, org.orgId, {
        componentObjectId: component.id,
        kind: "continuous",
        hookId: "smoke",
        maxAgeSeconds: 300
      })
    );
    // Sanity: it resolves while the placement is alive.
    expect((await railFor(change.id, placement.id))?.basis).toBe("resolved");

    await admin.placements.delete(placement.id);

    const checks = await railFor(change.id, placement.id);
    // FOUR EMPTY SLOTS WOULD BE A LIE: they would claim nothing is declared, and a `continuous`
    // hook demonstrably is. The honest answer is that the subject could not be resolved.
    expect(checks?.basis).toBe("unresolvable");
    expect((checks as { reason: string }).reason).toContain("could not be resolved to a component");
  });

  // -------------------------------------------------------------------------------------------
  // evidenceOrigin — the seventh, honesty case (owner decision 2026-09-20): a target driven at
  // ANOTHER domain gets an additive marker, never an eighth `PipelineHookState` member. See
  // `docs/proposals/pipeline-mockup-data.md` §3.3/§5.3 and `resolveWaveTargetOriginDomains`
  // (`wave-targets-repo.ts`) — the SAME domain check `observedFreshness` already uses.
  // -------------------------------------------------------------------------------------------
  describe("evidenceOrigin: this target executes at another domain", () => {
    /** `stageFixture`, with its deployment target's `originDomainId` surgically moved to a foreign
     *  domain AFTER creation — the shape a replicated outpost deployment target has at the
     *  commander (same technique as `foreign-origin-campaign.integration.test.ts`). */
    async function elsewhereFixture(slug: string) {
      const fixture = await stageFixture(slug);
      const foreign = asTrustDomainId(randomUUID());
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx
          .update(objects)
          .set({ originDomainId: foreign })
          .where(and(eq(objects.orgId, org.orgId), eq(objects.id, fixture.deploymentTarget.id)))
      );
      return { ...fixture, foreign };
    }

    it("a locally-driven target carries NO evidenceOrigin at all — the six existing states are untouched", async () => {
      const { change, placement, component } = await stageFixture("local-marker");
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        upsertHook(tx, org.orgId, {
          componentObjectId: component.id,
          kind: "continuous",
          hookId: "smoke",
          maxAgeSeconds: 300
        })
      );
      const checks = await railFor(change.id, placement.id);
      expect(checks?.basis).toBe("resolved");
      expect((checks as { evidenceOrigin?: unknown }).evidenceOrigin).toBeUndefined();
    });

    it("a target driven elsewhere, with NO wave_target_observed arrived, reports evidenceOrigin `not_reported` — not a failed or silent prober", async () => {
      const { change, placement, component } = await elsewhereFixture("elsewhere-none");
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        upsertHook(tx, org.orgId, {
          componentObjectId: component.id,
          kind: "continuous",
          hookId: "smoke",
          maxAgeSeconds: 300
        })
      );

      const checks = await railFor(change.id, placement.id);
      expect(checks?.basis).toBe("resolved");
      expect((checks as { evidenceOrigin?: unknown }).evidenceOrigin).toEqual({
        state: "not_reported"
      });
      // The per-hook slot state is UNCHANGED by this marker — still the local, evidence-based
      // verdict. The marker is what lets a caller soften "nobody is looking" into "not reported to
      // this commander" without inventing an eighth `PipelineHookState`.
      const slots = slotsOf(checks);
      expect(slots.get("continuous")!.hooks[0]!.state).toBe("no_evidence");
    });

    it("a target driven elsewhere, with a FRESH wave_target_observed hook_run, reports evidenceOrigin `fresh` with its age", async () => {
      const { change, placement, component } = await elsewhereFixture("elsewhere-fresh");
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        upsertHook(tx, org.orgId, {
          componentObjectId: component.id,
          kind: "postDeploy",
          hookId: "e2e"
        })
      );
      const observedAt = new Date();
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        recordPeerObservation(tx, {
          orgId: org.orgId,
          peerDomainId: asTrustDomainId(randomUUID()),
          payload: {
            subject: "hook_run",
            changeObjectId: change.id,
            componentObjectId: component.id,
            targetObjectId: placement.id,
            hookId: "e2e",
            kind: "postDeploy",
            waveIndex: 0,
            status: "succeeded",
            attempt: 1,
            externalUrl: null,
            startedAt: observedAt.toISOString(),
            observedAt: observedAt.toISOString()
          }
        })
      );

      const checks = await railFor(change.id, placement.id);
      expect(checks?.basis).toBe("resolved");
      const origin = (checks as { evidenceOrigin?: { state: string; ageSeconds?: number } })
        .evidenceOrigin;
      expect(origin?.state).toBe("fresh");
      expect(typeof origin?.ageSeconds).toBe("number");
      expect(origin?.ageSeconds).toBeLessThan(60);
    });

    it("a target driven elsewhere, with a STALE wave_target_observed hook_run, reports evidenceOrigin `stale` with its freshness bound", async () => {
      const { change, placement, component } = await elsewhereFixture("elsewhere-stale");
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        upsertHook(tx, org.orgId, {
          componentObjectId: component.id,
          kind: "postDeploy",
          hookId: "e2e"
        })
      );
      const staleObservedAt = new Date(Date.now() - (PEER_OBSERVATION_FRESHNESS_MS + 60_000));
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        recordPeerObservation(tx, {
          orgId: org.orgId,
          peerDomainId: asTrustDomainId(randomUUID()),
          payload: {
            subject: "hook_run",
            changeObjectId: change.id,
            componentObjectId: component.id,
            targetObjectId: placement.id,
            hookId: "e2e",
            kind: "postDeploy",
            waveIndex: 0,
            status: "succeeded",
            attempt: 1,
            externalUrl: null,
            startedAt: staleObservedAt.toISOString(),
            observedAt: staleObservedAt.toISOString()
          }
        })
      );

      const checks = await railFor(change.id, placement.id);
      const origin = (
        checks as {
          evidenceOrigin?: { state: string; ageSeconds?: number; staleAfterSeconds?: number };
        }
      ).evidenceOrigin;
      expect(origin?.state).toBe("stale");
      expect(typeof origin?.ageSeconds).toBe("number");
      expect(typeof origin?.staleAfterSeconds).toBe("number");
    });

    it("a target driven elsewhere still reports `unresolvable` when its object cannot be resolved — the domain check never overrides it", async () => {
      const { change, placement, component } = await elsewhereFixture("elsewhere-gone");
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        upsertHook(tx, org.orgId, {
          componentObjectId: component.id,
          kind: "continuous",
          hookId: "smoke",
          maxAgeSeconds: 300
        })
      );
      await admin.placements.delete(placement.id);

      const checks = await railFor(change.id, placement.id);
      expect(checks?.basis).toBe("unresolvable");
    });
  });
});
