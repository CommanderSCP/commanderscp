import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import type { CapturedWorkflowRef, GraphObject } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { changes, decisions, pipelineHookRuns } from "../db/schema.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { getLatestPlanForChange } from "./plan-service.js";
import { upsertExecutorBinding } from "./executor-bindings-repo.js";
import { reconcileOrgTick } from "./reconcile.js";
import {
  createInMemoryFakeHost,
  declaredSchedules,
  withRefusingTrigger
} from "./test-support/fake-plugin-host.js";
import {
  recordAlarmEvidence,
  recordTestRunEvidence,
  upsertHook,
  type PipelineEvidenceSource
} from "./pipeline-hooks-repo.js";
import { describeContinuousHeldTargets, evaluateContinuousHolds } from "./continuous-hold.js";
import type { PipelineHookGateEntry } from "./pipeline-hook-gate.js";

/**
 * INCREMENT 8 ADMISSION, END TO END AGAINST REAL POSTGRES — the wiring that makes the declared
 * hooks actually gate and hold something.
 *
 * ============================================================================================
 * EVERYTHING IS DRIVEN THROUGH `reconcileOrgTick`, NEVER BY CALLING AN ENGINE FUNCTION INLINE
 * ============================================================================================
 * This is not a stylistic preference and it has been paid for once already in this tree. The
 * reconcile loop claims work with `FOR UPDATE SKIP LOCKED`; an inline engine call made beside a
 * running loop is a SILENT NO-OP that returns cleanly, so a test written that way passes while
 * proving nothing about the code that runs in production. Every assertion below is therefore about
 * what a real tick did: what the EXECUTOR was asked to do (`triggered`, the plugin host's own call
 * log), what status the wave and its targets reached, and what Decision rows exist.
 *
 * "Not triggered" is asserted against the executor rather than against a status column, for the
 * same reason `stage-dependency-hold.integration.test.ts` states: a hold that recorded the right
 * row while still firing the release would pass a column assertion and fail the only thing that
 * matters.
 *
 * A FRESH ORG PER CASE. `reconcileOrgTick` sweeps the whole org and `advanceExecutingChanges`
 * serves `ORDER BY reconcile_cursor_at ASC LIMIT BATCH_LIMIT`, so changes an earlier case left
 * `executing` compete for the same slots and "tick(4)" stops meaning four evaluations of MY change.
 * That is the same fixture-rebuilt-starvation the stage-dependency file measured; the note is
 * repeated here rather than cross-referenced because the next person to add a case to this file is
 * the person who needs it.
 *
 * The four MUTATION PROOFS this file's guard tests are for are named on the tests themselves.
 */

/** A valid `CapturedWorkflowRefSchema` value. The evidence rows below are written through the repo
 *  (there is no write door yet — that is a later increment), which stores the payload verbatim, but
 *  a fixture that wrote a shape the contract rejects would be testing a payload production can
 *  never contain. */
const WORKFLOW: CapturedWorkflowRef = {
  repo: "acme/pipelines",
  branch: "main",
  path: "workflows/tests.yaml",
  commitSha: "a".repeat(40),
  bundle: { repository: "acme/tests", digest: `sha256:${"b".repeat(64)}` }
};

/** Mutable — the in-memory host closes over it and the plugin re-reads it on every call. */
const executorConfig: { autoSucceedAfterMs: number; forcePhase: Record<string, string> } = {
  // Long enough that a triggered target sits durably `observing` instead of racing the assertions
  // to completion — several cases need "genuinely still in flight" to be a durable fact.
  autoSucceedAfterMs: 10 * 60_000,
  forcePhase: {}
};

describe("pipeline hooks: wave-boundary gate and per-target hold (increment 8)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let gamma: GraphObject;
  let prod: GraphObject;
  let amer: GraphObject;
  let host: PluginHost;
  let triggered: { targetRef: string }[];

  beforeAll(async () => {
    server = await listenTestServer();
    // `() => false` refuses nothing — the wrapper is used purely for its call log, which is the only
    // way to assert that a held target's executor was never asked to do anything.
    const wrapped = withRefusingTrigger(createInMemoryFakeHost(executorConfig), () => false);
    host = wrapped.host;
    triggered = wrapped.calls;
  });

  beforeEach(async () => {
    org = await createTestOrg(server, "pipehooks");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    gamma = await admin.deploymentTargets.create({ name: `gamma-${randomUUID().slice(0, 8)}` });
    prod = await admin.deploymentTargets.create({ name: `prod-${randomUUID().slice(0, 8)}` });
    amer = await admin.deploymentTargets.create({ name: `amer-${randomUUID().slice(0, 8)}` });
    executorConfig.forcePhase = {};
  });

  afterAll(async () => {
    await server?.close();
  });

  const tick = async (times = 1) => {
    for (let i = 0; i < times; i++) {
      await reconcileOrgTick(
        server.deps.db,
        org.orgId,
        host,
        server.deps.celSandbox!,
        server.deps.config.secretsMasterKey
      );
    }
  };

  /** A topology whose waves are one place each, in order — the two-wave shape a `postDeploy` /
   *  `bakeAlarms` gate is actually about (wave N's exit IS wave N+1's entry). */
  const sequentialTopology = async (places: GraphObject[]) =>
    (
      await admin.object("release-topology").create({
        name: `seq-${randomUUID().slice(0, 8)}`,
        properties: {
          waves: places.map((p) => ({ name: p.name, mode: "parallel", targets: [p.id] }))
        }
      })
    ).id;

  /** ONE wave holding every place — the shape the per-target hold is about, where "siblings
   *  proceed" is a statement about targets of the SAME wave. */
  const oneWaveTopology = async (places: GraphObject[]) =>
    (
      await admin.object("release-topology").create({
        name: `flat-${randomUUID().slice(0, 8)}`,
        properties: {
          waves: [{ name: "all", mode: "parallel", targets: places.map((p) => p.id) }]
        }
      })
    ).id;

  async function componentAt(label: string, places: GraphObject[]) {
    const component = await createTestComponent(admin, {
      name: `${label}-${randomUUID().slice(0, 8)}`
    });
    const placementByPlace = new Map<string, string>();
    for (const place of places) {
      const placement = await admin.placements.create({
        component: component.id,
        deploymentTarget: place.id
      });
      placementByPlace.set(place.id, placement.id);
    }
    return { id: component.id, at: (place: GraphObject) => placementByPlace.get(place.id)! };
  }

  const release = (label: string, targets: string[], topology: string) =>
    admin.changes.propose({
      name: `${label}-${randomUUID().slice(0, 8)}`,
      targets,
      topology
    });

  const firedFor = (placementId: string) =>
    triggered.filter((call) => call.targetRef === placementId).length;

  const declareHook = (input: Parameters<typeof upsertHook>[2]) =>
    withTenantTx(server.deps.db, org.orgId, (tx) => upsertHook(tx, org.orgId, input));

  const recordRun = (input: {
    componentObjectId: string;
    targetObjectId: string;
    hookId: string;
    hook: "postMerge" | "postDeploy" | "continuous";
    outcome: "passed" | "failed";
    completedAt: Date;
    source?: PipelineEvidenceSource;
  }) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordTestRunEvidence(tx, org.orgId, {
        componentObjectId: input.componentObjectId,
        targetObjectId: input.targetObjectId,
        hookId: input.hookId,
        source: input.source ?? "executor_observed",
        evidence: {
          kind: "testRun",
          hook: input.hook,
          hookId: input.hookId,
          workflow: WORKFLOW,
          runId: `run-${randomUUID().slice(0, 8)}`,
          outcome: input.outcome,
          startedAt: new Date(input.completedAt.getTime() - 30_000).toISOString(),
          completedAt: input.completedAt.toISOString()
        }
      })
    );

  const recordAlarms = (input: {
    componentObjectId: string;
    targetObjectId: string;
    hookId: string;
    windowStart: Date;
    windowEnd: Date;
    alarms?: { name: string; severity: "warning" | "critical"; firedAt: string }[];
  }) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      recordAlarmEvidence(tx, org.orgId, {
        componentObjectId: input.componentObjectId,
        targetObjectId: input.targetObjectId,
        hookId: input.hookId,
        source: "pushed",
        evidence: {
          kind: "alarmState",
          hookId: input.hookId,
          windowStart: input.windowStart.toISOString(),
          windowEnd: input.windowEnd.toISOString(),
          alarms: input.alarms ?? []
        }
      })
    );

  const plan = (changeId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestPlanForChange(tx, org.orgId, changeId)
    );

  const waveStatuses = async (changeId: string) =>
    (await plan(changeId))!.waves.map((w) => w.status);

  const waveTargetStatus = async (changeId: string, placementId: string) => {
    const target = (await plan(changeId))!.waves
      .flatMap((w) => w.targets)
      .find((t) => t.targetObjectId === placementId);
    if (!target) throw new Error(`no wave target for placement ${placementId}`);
    return target.status;
  };

  const changeRow = async (changeId: string) => {
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, changeId)))
    );
    return row!;
  };

  const decisionsOfKind = (changeId: string, kind: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, changeId),
            eq(decisions.kind, kind)
          )
        )
        .orderBy(decisions.createdAt, decisions.id)
    );

  /** The hook entries the LATEST `gate` Decision recorded — the only surface the reason a declared
   *  hook blocked a wave reaches an operator through today (`GateVerdict.pipelineHooks`'s doc: the
   *  API projection is a deliberate follow-up, so the Decision is where it lands). */
  const gateHookEntries = async (changeId: string): Promise<PipelineHookGateEntry[]> => {
    const rows = await decisionsOfKind(changeId, "gate");
    const latest = rows[rows.length - 1];
    return ((latest?.inputContext as { pipelineHooks?: PipelineHookGateEntry[] })?.pipelineHooks ??
      []) as PipelineHookGateEntry[];
  };

  /** Drive the change until its FIRST wave has deployed and terminalized, so the next wave's
   *  admission is the thing under test. Returns nothing; every case asserts for itself. */
  async function deployFirstWave(changeId: string, firstPlacement: string) {
    await tick(3);
    expect(
      firedFor(firstPlacement),
      "the first wave must actually deploy — otherwise the next wave's gate is never reached and every assertion below is vacuous"
    ).toBe(1);
    executorConfig.forcePhase[firstPlacement] = "succeeded";
    await tick(3);
    expect(await waveTargetStatus(changeId, firstPlacement)).toBe("succeeded");
  }

  // -------------------------------------------------------------------------------------------
  // PART 2 — the per-target `continuous` hold
  // -------------------------------------------------------------------------------------------

  it("property 1: a STALE continuous probe HOLDS the target, and fresh green RELEASES it", async () => {
    const topology = await oneWaveTopology([gamma]);
    const app = await componentAt("stale", [gamma]);
    await declareHook({
      componentObjectId: app.id,
      kind: "continuous",
      hookId: "canary",
      everySeconds: 30,
      maxAgeSeconds: 60
    });
    // PASSED, but two minutes old against a sixty-second window. Stale-green is ABSENT — not pass,
    // not fail — which is the entire reason the hook exists.
    const completedAt = new Date(Date.now() - 120_000);
    await recordRun({
      componentObjectId: app.id,
      targetObjectId: app.at(gamma),
      hookId: "canary",
      hook: "continuous",
      outcome: "passed",
      completedAt
    });

    const change = await release("stale", [app.id], topology);
    await tick(4);

    // (a) THE GUARANTEE — the executor was never asked, not merely "the row says pending".
    expect(firedFor(app.at(gamma))).toBe(0);
    expect(await waveTargetStatus(change.id, app.at(gamma))).toBe("pending");
    // (b) The counting invariant: a held target is still in flight, so the wave must NOT complete.
    expect(await waveStatuses(change.id)).toEqual(["running"]);
    const row = await changeRow(change.id);
    expect(row.state).toBe("executing");
    expect(
      row.reconcileBlockedAt,
      "held, not PARKED — a parked change stops being served"
    ).toBeNull();

    // (c) THE FRESHNESS BOUNDARY IS VISIBLE IN THE DECISION, as data, with no clock in it.
    const held = await decisionsOfKind(change.id, "continuous_test");
    expect(held).toHaveLength(1);
    expect(held[0]!.verdict).toBe("hold");
    const ctx = held[0]!.inputContext as {
      held: {
        targetObjectId: string;
        holds: {
          reason: string;
          staleAfter: string | null;
          freshness: {
            maxAgeSeconds: number;
            staleAfter: string | null;
            latestEvidence: { completedAt: string; outcome: string } | null;
          };
        }[];
      }[];
    };
    expect(ctx.held).toHaveLength(1);
    expect(ctx.held[0]!.targetObjectId).toBe(app.at(gamma));
    const hold = ctx.held[0]!.holds[0]!;
    expect(hold.reason).toBe("stale");
    expect(hold.freshness.maxAgeSeconds).toBe(60);
    expect(hold.freshness.latestEvidence?.completedAt).toBe(completedAt.toISOString());
    expect(hold.freshness.latestEvidence?.outcome).toBe("passed");
    expect(
      hold.freshness.staleAfter,
      "the boundary is completedAt + maxAgeSeconds — arithmetic on stored data, never a clock read"
    ).toBe(new Date(completedAt.getTime() + 60_000).toISOString());
    expect(JSON.stringify(held[0]!.inputContext)).not.toContain('"now"');

    // (d) RELEASE. Fresh green evidence lands; the very next tick the target reaches its executor.
    await recordRun({
      componentObjectId: app.id,
      targetObjectId: app.at(gamma),
      hookId: "canary",
      hook: "continuous",
      outcome: "passed",
      completedAt: new Date()
    });
    await tick(2);
    expect(firedFor(app.at(gamma))).toBe(1);
    const afterRelease = await decisionsOfKind(change.id, "continuous_test");
    expect(afterRelease.map((d) => d.verdict)).toEqual(["hold", "allow"]);
  });

  it("property 2: a FAILED probe holds for a DIFFERENT recorded reason than a stale one", async () => {
    const topology = await oneWaveTopology([gamma]);
    const app = await componentAt("sick", [gamma]);
    await declareHook({
      componentObjectId: app.id,
      kind: "continuous",
      hookId: "canary",
      everySeconds: 30,
      maxAgeSeconds: 3600
    });
    // FRESH — well inside the window — and FAILED. If `failed` were collapsed into staleness this
    // would be indistinguishable from a dead prober, which is a different operator action: `failed`
    // says check the TARGET, `stale`/`no_evidence` say check the PROBER.
    await recordRun({
      componentObjectId: app.id,
      targetObjectId: app.at(gamma),
      hookId: "canary",
      hook: "continuous",
      outcome: "failed",
      completedAt: new Date()
    });

    const change = await release("sick", [app.id], topology);
    await tick(4);

    expect(firedFor(app.at(gamma))).toBe(0);
    const held = await decisionsOfKind(change.id, "continuous_test");
    expect(held).toHaveLength(1);
    const ctx = held[0]!.inputContext as {
      held: { holds: { reason: string; summary: string }[] }[];
    };
    expect(ctx.held[0]!.holds[0]!.reason).toBe("failed");
    expect(ctx.held[0]!.holds[0]!.reason).not.toBe("stale");
    expect(
      ctx.held[0]!.holds[0]!.summary,
      "the operator-facing sentence must say the TARGET is sick, not that nobody looked"
    ).toContain("check the target");
  });

  it("property 3: SIBLINGS PROCEED — a stale probe on target A does not block target B", async () => {
    // THE PROPERTY THAT DISTINGUISHES A HOLD FROM A GATE, and the whole reason `continuous` is not
    // a wave gate: "a stale canary probe on target A says nothing about target B, so blocking B
    // would be a lie about what is known" (`pipeline-behaviors.ts`'s mechanism table).
    const topology = await oneWaveTopology([gamma, prod]);
    const app = await componentAt("siblings", [gamma, prod]);
    await declareHook({
      componentObjectId: app.id,
      kind: "continuous",
      hookId: "canary",
      everySeconds: 30,
      maxAgeSeconds: 60
    });
    await recordRun({
      componentObjectId: app.id,
      targetObjectId: app.at(gamma),
      hookId: "canary",
      hook: "continuous",
      outcome: "passed",
      completedAt: new Date(Date.now() - 120_000) // stale
    });
    await recordRun({
      componentObjectId: app.id,
      targetObjectId: app.at(prod),
      hookId: "canary",
      hook: "continuous",
      outcome: "passed",
      completedAt: new Date() // fresh
    });

    const change = await release("siblings", [app.id], topology);
    await tick(4);

    expect(firedFor(app.at(gamma)), "the stale target is held").toBe(0);
    expect(firedFor(app.at(prod)), "its sibling ships anyway — this is the whole point").toBe(1);
    expect(await waveTargetStatus(change.id, app.at(gamma))).toBe("pending");
    expect(await waveTargetStatus(change.id, app.at(prod))).not.toBe("pending");

    const ctx = (await decisionsOfKind(change.id, "continuous_test"))[0]!.inputContext as {
      held: { targetObjectId: string }[];
    };
    expect(ctx.held.map((h) => h.targetObjectId)).toEqual([app.at(gamma)]);
  });

  // -------------------------------------------------------------------------------------------
  // PART 1 — the wave-boundary gate contributor
  // -------------------------------------------------------------------------------------------

  it("property 4: a FAILED postDeploy result blocks the wave's exit — the next wave stays `pending`", async () => {
    const topology = await sequentialTopology([gamma, prod]);
    const app = await componentAt("postdeploy-fail", [gamma, prod]);
    // NO `stage` — the DEFAULT form, which gates EVERY wave. Adding a stage would REMOVE gates.
    await declareHook({
      componentObjectId: app.id,
      kind: "postDeploy",
      hookId: "integration",
      workflow: { repo: "acme/pipelines", branch: "main", path: "w.yaml" }
    });

    const change = await release("postdeploy-fail", [app.id], topology);
    await deployFirstWave(change.id, app.at(gamma));

    await recordRun({
      componentObjectId: app.id,
      targetObjectId: app.at(gamma),
      hookId: "integration",
      hook: "postDeploy",
      outcome: "failed",
      completedAt: new Date()
    });
    await tick(3);

    expect(await waveStatuses(change.id)).toEqual(["succeeded", "pending"]);
    expect(firedFor(app.at(prod)), "the widening is stopped, not merely explained").toBe(0);

    const entries = await gateHookEntries(change.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("postDeploy");
    expect(entries[0]!.outcome).toBe("fail");
    expect(entries[0]!.satisfied).toBe(false);
    expect(
      entries[0]!.gatedWaveIndex,
      "the gate is on wave 0's EXIT, which is wave 1's entry"
    ).toBe(0);
    expect(entries[0]!.stage, "absent stage is the default form and gates every wave").toBeNull();
  });

  it("property 5: an IN-FLIGHT (awaiting) postDeploy blocks without failing the change, and is re-decided later", async () => {
    const topology = await sequentialTopology([gamma, prod]);
    const app = await componentAt("postdeploy-awaiting", [gamma, prod]);
    await declareHook({
      componentObjectId: app.id,
      kind: "postDeploy",
      hookId: "integration",
      workflow: { repo: "acme/pipelines", branch: "main", path: "w.yaml" }
    });

    const change = await release("postdeploy-awaiting", [app.id], topology);
    await deployFirstWave(change.id, app.at(gamma));

    // NO evidence at all — the suite is still running. `TestRunEvidenceSchema` has no `running`
    // member on purpose: an in-flight run is expressed by the ABSENCE of evidence.
    await tick(4);

    expect(await waveStatuses(change.id)).toEqual(["succeeded", "pending"]);
    expect(firedFor(app.at(prod))).toBe(0);
    const blocked = await changeRow(change.id);
    expect(
      blocked.state,
      "an in-flight test is NOT a failed test — mapping awaiting to fail would fail a change on a suite that has not finished running"
    ).toBe("executing");
    expect(blocked.reconcileBlockedAt).toBeNull();
    expect((await gateHookEntries(change.id))[0]!.outcome).toBe("awaiting");

    // MUTATION TARGET (c): the suite finishes green and the wave is re-decided on a LATER tick. A
    // gate that blocked permanently rather than re-deciding would leave this half red.
    await recordRun({
      componentObjectId: app.id,
      targetObjectId: app.at(gamma),
      hookId: "integration",
      hook: "postDeploy",
      outcome: "passed",
      completedAt: new Date()
    });
    await tick(3);
    expect(await waveStatuses(change.id)).toEqual(["succeeded", "running"]);
    expect(firedFor(app.at(prod))).toBe(1);
  });

  it("property 5b: THE GATE'S AWAITING TUPLE IS ACTUALLY DISPATCHED — a hook run row exists", async () => {
    // WHAT THIS CLOSES, and why it is the load-bearing case in this file. `ensureHookRunTriggered`
    // was fully built, unit- and integration-tested, and had NO PRODUCTION CALLER: nothing wrote
    // `pipeline_hook_runs`, so `pollNonTerminalHookRuns` polled an always-empty table and a declared
    // `postDeploy` hook blocked its wave FOREVER with a correct-looking `awaiting`. Property 5 above
    // passed throughout, because "blocks and is re-decided when evidence arrives" is true of a gate
    // whose run was never triggered — the evidence simply had to come from somewhere else.
    //
    // So this asserts the ROW, not the verdict. The verdict was never the thing that was broken.
    const topology = await sequentialTopology([gamma, prod]);
    const app = await componentAt("postdeploy-dispatch", [gamma, prod]);
    await declareHook({
      componentObjectId: app.id,
      kind: "postDeploy",
      hookId: "integration",
      workflow: { repo: "acme/pipelines", branch: "main", path: "w.yaml" }
    });

    // AN EXECUTOR BINDING ON THE CARRIER, which the other properties in this file do not need and
    // this one does. A hook run resolves its executor from the wave target itself (the PLACEMENT,
    // here) and `ensureHookRunTriggered` REFUSES to claim a run it could not dispatch (§14 res 2,
    // loud-unbound) rather than recording one that fake-succeeds. Every other property asserts a
    // gate VERDICT, which needs no executor at all — this is the first that asserts a dispatch, so
    // it is the first that has to look like an estate where one can happen.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: app.at(gamma),
        pluginModule: "fake-executor",
        pluginInstanceId: `fake-hook-${randomUUID().slice(0, 8)}`,
        // The PLACEMENT ID as the external ref, matching what this harness's fake host keys on
        // (`firedFor` filters `call.targetRef`). A different ref here silently stops the DEPLOY
        // being counted, which surfaces as "the first wave never deployed" — measured.
        externalRef: app.at(gamma),
        config: {},
        actorObjectId: org.orgId,
        requestId: "postdeploy-dispatch-binding"
      })
    );

    const change = await release("postdeploy-dispatch", [app.id], topology);
    await deployFirstWave(change.id, app.at(gamma));
    await tick(4);

    // Still blocked on the hook — unchanged from property 5, and stated so a reader can see the
    // dispatch does not release the gate. Evidence releases it; dispatch only makes evidence
    // POSSIBLE.
    expect(await waveStatuses(change.id)).toEqual(["succeeded", "pending"]);
    expect((await gateHookEntries(change.id))[0]!.outcome).toBe("awaiting");

    const runs = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(pipelineHookRuns).where(eq(pipelineHookRuns.changeObjectId, change.id))
    );
    expect(runs, "the gate is awaiting a run nothing ever created").toHaveLength(1);
    expect(runs[0]!.hookId).toBe("integration");
    expect(runs[0]!.kind).toBe("postDeploy");
    // The run is bound to the target that DEPLOYED, and to the wave whose exit it gates — the two
    // fields the later poll and the gate both re-derive. A run keyed on the wrong wave would be
    // invisible to the gate that is waiting for it.
    expect(runs[0]!.targetObjectId).toBe(app.at(gamma));
    expect(runs[0]!.waveIndex).toBe(0);
    // Dispatched, not merely claimed: an external ref means the executor was actually called.
    expect(runs[0]!.pluginInstanceId).toBeTruthy();

    // IDEMPOTENT ACROSS TICKS. The gate re-emits this tuple every tick while it blocks, and
    // `claimHookRun`'s `onConflictDoNothing` is what keeps that from dispatching a second run —
    // asserted rather than assumed, because a duplicate here would be one run per tick forever.
    await tick(3);
    const after = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(pipelineHookRuns).where(eq(pipelineHookRuns.changeObjectId, change.id))
    );
    expect(
      after,
      "re-emitting an awaiting tuple must be a no-op claim, not a second dispatch"
    ).toHaveLength(1);
  });

  it("property 5c: a CONTINUOUS hook's schedule is DECLARED to the executor that will run it", async () => {
    // OUTPOST-RUN PROBES. The commander declares WHAT to probe and the domain holds the schedule;
    // this is the domain half — the tick hands the executor a cadence and the executor's own
    // scheduler runs it. SCP never fires the probe, which is why this asserts a DECLARATION and not
    // a run: `everySeconds` is descriptive in three places, all unchanged.
    //
    // Asserted on the recorded spec, not on "the call did not throw": the driver gates on the
    // optional `ensureSchedule` being present, so an executor without it is skipped silently — and
    // a test that only checked for absence of an error would pass against a driver that skipped
    // everything.
    const subject = await componentAt("probe-scheduled", [gamma]);
    // The probe resolves its executor from the TARGET (the placement), exactly as a hook run does,
    // so this needs a binding for the same reason property 5b did — it asserts a dispatch, not a
    // verdict. Without one `resolveExecutorPluginInstance` returns undefined and the driver skips
    // silently, which is how this case first failed.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: subject.at(gamma),
        pluginModule: "fake-executor",
        pluginInstanceId: `fake-probe-${randomUUID().slice(0, 8)}`,
        externalRef: subject.at(gamma),
        config: {},
        actorObjectId: org.orgId,
        requestId: "probe-scheduled-binding"
      })
    );
    await declareHook({
      componentObjectId: subject.id,
      kind: "continuous",
      hookId: "canary",
      workflow: { repo: "acme/pipelines", branch: "main", path: "probes/canary.yaml" },
      everySeconds: 300,
      maxAgeSeconds: 900
    });

    await tick(1);

    const spec = declaredSchedules.find((d) => d.labels?.["commanderscp.io/hook-id"] === "canary");
    expect(spec, "the domain was never told what to run").toBeTruthy();
    // The cadence the hook declared reaches the executor as a cadence, not a fired run.
    expect(spec!.cadenceSeconds).toBe(300);
    expect(spec!.targetRef).toBe("probes/canary.yaml");
    // CORRELATION LABELS, so a run this schedule spawns maps back to the hook that asked for it.
    // Without them a result is an orphan workflow and the hold can never clear.
    expect(spec!.labels?.["commanderscp.io/component"]).toBe(subject.id);
    expect(spec!.labels?.["commanderscp.io/target"]).toBeTruthy();

    // IDEMPOTENT ID across ticks — a re-declaration must UPDATE the schedule, not create a second
    // one beside it. Same id on every tick is what makes `ensureSchedule` safe to call forever.
    const before = spec!.scheduleId;
    await tick(1);
    const again = declaredSchedules.filter(
      (d) => d.labels?.["commanderscp.io/hook-id"] === "canary"
    );
    expect(again.length).toBeGreaterThan(1);
    expect(new Set(again.map((d) => d.scheduleId))).toEqual(new Set([before]));
  });

  it("property 6: a bake gate with NO reporting source blocks with `no_source`, distinct from `window_not_covered`", async () => {
    const topology = await sequentialTopology([gamma, prod]);
    const silent = await componentAt("bake-silent", [gamma, prod]);
    const partial = await componentAt("bake-partial", [gamma, prod]);
    for (const component of [silent, partial]) {
      await declareHook({
        componentObjectId: component.id,
        kind: "bakeAlarms",
        hookId: "bake",
        quietWindowSeconds: 600
      });
    }

    const silentChange = await release("bake-silent", [silent.id], topology);
    const partialChange = await release("bake-partial", [partial.id], topology);
    await tick(3);
    executorConfig.forcePhase[silent.at(gamma)] = "succeeded";
    executorConfig.forcePhase[partial.at(gamma)] = "succeeded";
    await tick(3);

    // The partially-covered change gets a report that looks like coverage and is not: it asserts a
    // one-minute window against a declared ten-minute one. A shorter window is a SHORTER LOOK.
    const deployedAt = new Date(
      (await plan(partialChange.id))!.waves[0]!.targets[0]!.lastObservedAt!
    );
    await recordAlarms({
      componentObjectId: partial.id,
      targetObjectId: partial.at(gamma),
      hookId: "bake",
      windowStart: deployedAt,
      windowEnd: new Date(deployedAt.getTime() + 60_000)
    });
    await tick(3);

    const silentEntry = (await gateHookEntries(silentChange.id))[0]!;
    expect(silentEntry.kind).toBe("bakeAlarms");
    expect(
      silentEntry.outcome,
      "a declared bake gate with no evidence source must be LOUD, not a mystery hang"
    ).toBe("no_source");
    expect(silentEntry.satisfied).toBe(false);
    expect(silentEntry.coveredBy).toEqual([]);
    expect(silentEntry.window?.start).toBe(
      new Date((await plan(silentChange.id))!.waves[0]!.targets[0]!.lastObservedAt!).toISOString()
    );

    const partialEntry = (await gateHookEntries(partialChange.id))[0]!;
    expect(
      partialEntry.outcome,
      "reports that leave a gap are a DIFFERENT fact from no reports at all, and demand a different operator action"
    ).toBe("window_not_covered");
    expect(partialEntry.outcome).not.toBe(silentEntry.outcome);

    for (const [change, component] of [
      [silentChange, silent],
      [partialChange, partial]
    ] as const) {
      expect(await waveStatuses(change.id)).toEqual(["succeeded", "pending"]);
      expect(firedFor(component.at(prod))).toBe(0);
    }
  });

  // -------------------------------------------------------------------------------------------
  // The terminalization arithmetic
  // -------------------------------------------------------------------------------------------

  it("property 7: an ALREADY-FAILED wave whose only remaining targets are held still terminalizes — and does not terminalize while a sibling is genuinely in flight", async () => {
    // TWO ASSERTIONS, ONE FIXTURE, because they are the two halves of the same arithmetic and the
    // second is the one that catches a missing `nonTerminalTargets++`:
    //
    //   * with a failed target, a held target AND a genuinely OBSERVING one, the wave must stay
    //     `running` — miss the count and `nonTerminalTargets - heldCount` reaches 0, the first
    //     guard falls through, and the wave terminalizes with a live target (MUTATION TARGET (a));
    //   * once the observing target finishes, the wave must terminalize `failed` even though a held
    //     target remains — holding a dependant on a doomed wave buys nothing, and not terminalizing
    //     leaves the change occupying a BATCH_LIMIT slot forever with no failure ever recorded.
    const topology = await oneWaveTopology([gamma, prod, amer]);
    const app = await componentAt("terminalize", [gamma, prod, amer]);
    await declareHook({
      componentObjectId: app.id,
      kind: "continuous",
      hookId: "canary",
      everySeconds: 30,
      maxAgeSeconds: 60
    });
    for (const place of [gamma, prod]) {
      await recordRun({
        componentObjectId: app.id,
        targetObjectId: app.at(place),
        hookId: "canary",
        hook: "continuous",
        outcome: "passed",
        completedAt: new Date()
      });
    }
    await recordRun({
      componentObjectId: app.id,
      targetObjectId: app.at(amer),
      hookId: "canary",
      hook: "continuous",
      outcome: "passed",
      completedAt: new Date(Date.now() - 120_000) // stale — held for the whole case
    });

    const change = await release("terminalize", [app.id], topology);
    executorConfig.forcePhase[app.at(gamma)] = "failed";
    await tick(4);

    expect(await waveTargetStatus(change.id, app.at(gamma))).toBe("failed");
    expect(await waveTargetStatus(change.id, app.at(prod))).toBe("observing");
    expect(await waveTargetStatus(change.id, app.at(amer))).toBe("pending");
    expect(
      await waveStatuses(change.id),
      "a failed target plus a HELD one plus a genuinely in-flight one is still a running wave"
    ).toEqual(["running"]);

    // The in-flight sibling finishes. Now the only non-terminal target is the held one.
    executorConfig.forcePhase[app.at(prod)] = "succeeded";
    await tick(3);

    expect(await waveTargetStatus(change.id, app.at(amer))).toBe("pending");
    expect(
      await waveStatuses(change.id),
      "the hold must stop keeping a doomed wave open — its verdict is already decided"
    ).toEqual(["failed"]);
    expect(firedFor(app.at(amer)), "and the held target is NEVER triggered on the way there").toBe(
      0
    );
  });

  // -------------------------------------------------------------------------------------------
  // Persist-on-change
  // -------------------------------------------------------------------------------------------

  it("property 8: two consecutive evaluations against unchanged evidence produce a byte-identical `inputContext`", async () => {
    // ADR-0024's contract, asserted TWICE and in two different ways, because the failure is silent:
    // a clock in `inputContext` writes a new row every tick, which is the measured 1.44 GB/day
    // incident. MUTATION TARGET (d).
    const topology = await oneWaveTopology([gamma]);
    const app = await componentAt("stable", [gamma]);
    await declareHook({
      componentObjectId: app.id,
      kind: "continuous",
      hookId: "canary",
      everySeconds: 30,
      maxAgeSeconds: 60
    });
    await recordRun({
      componentObjectId: app.id,
      targetObjectId: app.at(gamma),
      hookId: "canary",
      hook: "continuous",
      outcome: "passed",
      completedAt: new Date(Date.now() - 120_000)
    });

    const change = await release("stable", [app.id], topology);
    await tick(8);

    // (a) THE PREDICATE, DIRECTLY, at two different clocks — asserted FIRST, and the order is
    // deliberate: it must be able to fail on its own. When the end-to-end row count below runs
    // first it fails for the same mutation, and a `now` reaching only the predicate would then be
    // reported by an assertion that never executed. (Measured: with a clock injected into the
    // predicate's record this assertion is what goes red.) The record must be byte-identical for
    // the same evidence read a minute apart.
    const at = async (now: Date) =>
      JSON.stringify(
        describeContinuousHeldTargets([
          ...(
            await withTenantTx(server.deps.db, org.orgId, (tx) =>
              evaluateContinuousHolds(tx, {
                orgId: org.orgId,
                targetObjectIds: [app.at(gamma)],
                now
              })
            )
          ).values()
        ])
      );
    const first = await at(new Date());
    const second = await at(new Date(Date.now() + 60_000));
    expect(second).toBe(first);
    expect(first).not.toContain('"now"');

    // (b) THROUGH THE REAL PATH. Eight ticks, one hold, ONE row — `insertDecisionIfChanged`
    // suppresses a restatement only when the candidate is byte-identical, so a row count of one IS
    // the byte-identity assertion made against the engine rather than against a helper.
    const rows = await decisionsOfKind(change.id, "continuous_test");
    expect(rows).toHaveLength(1);
  });

  // -------------------------------------------------------------------------------------------
  // Ordering — the disjointness the terminalization arithmetic depends on
  // -------------------------------------------------------------------------------------------

  it("ORDERING: a target that is both frozen and probe-held records the FREEZE, not the probe", async () => {
    // MUTATION TARGET (b). Only one `continue` can fire per target, so the three hold sets are
    // DISJOINT BY CONSTRUCTION — a property of the ORDERING, not of the data, which is why it needs
    // its own test. The continuous `continue` is placed LAST; move it above the freeze one and the
    // frozen target starts recording a `continuous_test` hold instead, which names the wrong reason
    // and spends a hook read per tick on a target no evidence could release.
    //
    // TWO PLACES, and that is a fixture requirement rather than decoration: an ALL-frozen wave is
    // blocked by `evaluateWaveGate` itself (`gate-orchestrator.ts`'s `partiallyFrozen` keeps that
    // case a whole-wave block), so the per-target loop this test is about is never reached. Freezing
    // ONE of two targets is what makes the wave run and the loop decide per target.
    const topology = await oneWaveTopology([gamma, prod]);
    const app = await componentAt("both", [gamma, prod]);
    await declareHook({
      componentObjectId: app.id,
      kind: "continuous",
      hookId: "canary",
      everySeconds: 30,
      maxAgeSeconds: 60
    });
    // gamma: stale AND frozen. prod: fresh and unfrozen, so it ships and the wave is only partially
    // frozen.
    await recordRun({
      componentObjectId: app.id,
      targetObjectId: app.at(gamma),
      hookId: "canary",
      hook: "continuous",
      outcome: "passed",
      completedAt: new Date(Date.now() - 120_000)
    });
    await recordRun({
      componentObjectId: app.id,
      targetObjectId: app.at(prod),
      hookId: "canary",
      hook: "continuous",
      outcome: "passed",
      completedAt: new Date()
    });
    await admin.freezes.create({
      scopeObjectId: gamma.id,
      name: `both-${randomUUID().slice(0, 8)}`,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: "ordering fixture"
    });

    const change = await release("both", [app.id], topology);
    await tick(4);

    expect(firedFor(app.at(gamma))).toBe(0);
    expect(
      firedFor(app.at(prod)),
      "the unfrozen sibling ships — this is a PARTIALLY frozen wave"
    ).toBe(1);
    expect(
      await decisionsOfKind(change.id, "freeze_admission"),
      "the freeze `continue` fires first, so the freeze is what is recorded"
    ).toHaveLength(1);
    expect(
      await decisionsOfKind(change.id, "continuous_test"),
      "and the probe hold records NOTHING this tick — the two sets are disjoint by construction"
    ).toHaveLength(0);
  });
});
