import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { changeWaveTargets, changes, decisions, objects } from "../db/schema.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { getLatestPlanForChange } from "./plan-service.js";
import { findLatestWaveTargetForObject } from "./wave-targets-repo.js";
import { latestBlockDecisionForSubject } from "./decisions-repo.js";
import { reconcileOrgTick } from "./reconcile.js";
import { distinctDecisionStatements } from "./test-support/counting-cel-sandbox.js";
import { createInMemoryFakeHost, withRefusingTrigger } from "./test-support/fake-plugin-host.js";

/** The hold, end to end against real Postgres. See docs/coordination.md §930. */

interface RolloutSnapshot {
  phase?: string;
  step?: number;
  weight?: number;
  message?: string;
}

/** Mutable — the in-memory host closes over it and the plugin re-reads it on every call. */
const executorConfig: {
  autoSucceedAfterMs: number;
  forcePhase: Record<string, string>;
  rolloutByTarget: Record<string, RolloutSnapshot>;
} = {
  // Long enough that a target which DOES get triggered sits durably in flight instead of racing the
  // assertions to completion — a dependency must stay "not finished" for the minWeight case to mean
  // anything at all.
  autoSucceedAfterMs: 10 * 60_000,
  forcePhase: {},
  rolloutByTarget: {}
};

describe("stage dependencies: the trigger hold (ADR-0028 increment 3)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let gamma: GraphObject;
  let prod: GraphObject;
  let topologyId: string;
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

  /** The org, its two places and its stage-shaped topology, REBUILT PER CASE — see the module doc's
   *  `BATCH_LIMIT` note. Everything expensive (the server, the plugin host, its call log) is still
   *  built once; what is rebuilt is only what decides how much work a whole-org sweep has to do. */
  beforeEach(async () => {
    org = await createTestOrg(server, "stagedephold");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    gamma = await admin.deploymentTargets.create({ name: `gamma-${randomUUID().slice(0, 8)}` });
    prod = await admin.deploymentTargets.create({ name: `prod-${randomUUID().slice(0, 8)}` });
    const topology = await admin.object("release-topology").create({
      name: `gamma-only-${randomUUID().slice(0, 8)}`,
      properties: { waves: [{ name: "gamma", mode: "parallel", targets: [gamma.id] }] }
    });
    topologyId = topology.id;
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

  /** A component placed at each of `places`, with its placement ids to hand — the placement is what
   *  a stage-mode wave target actually names, and therefore what the executor sees as `targetRef`. */
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
    return {
      id: component.id,
      at: (place: GraphObject) => placementByPlace.get(place.id)!
    };
  }

  const release = (
    label: string,
    targets: string[],
    stageDependencies?: { dependsOn: string; minWeight?: number; atTargets?: string[] }[]
  ) =>
    admin.changes.propose({
      name: `${label}-${randomUUID().slice(0, 8)}`,
      targets,
      topology: topologyId,
      ...(stageDependencies ? { stageDependencies } : {})
    });

  const firedFor = (placementId: string) =>
    triggered.filter((call) => call.targetRef === placementId).length;

  async function waveTargetStatus(changeId: string, placementId: string): Promise<string> {
    const plan = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestPlanForChange(tx, org.orgId, changeId)
    );
    const target = plan!.waves
      .flatMap((wave) => wave.targets)
      .find((t) => t.targetObjectId === placementId);
    if (!target) throw new Error(`no wave target for placement ${placementId}`);
    return target.status;
  }

  const waveStatuses = async (changeId: string) => {
    const plan = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestPlanForChange(tx, org.orgId, changeId)
    );
    return plan!.waves.map((wave) => wave.status);
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

  /** The epitaph of an auto-cancelled change — the `reason` reconcile attached to the cancelling
   *  transition, which is the only account an operator gets of why the plan never compiled. */
  const cancelReason = async (changeId: string) => {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, changeId),
            eq(decisions.kind, "transition")
          )
        )
    );
    const cancelled = rows.find(
      (row) => (row.inputContext as { toState?: string }).toState === "cancelled"
    );
    return (cancelled?.inputContext as { reason?: string } | undefined)?.reason ?? "";
  };

  const unscopedDecisions = (changeId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, changeId),
            eq(decisions.kind, "stage_dependency_unscoped")
          )
        )
        .orderBy(decisions.createdAt, decisions.id)
    );

  const holdDecisions = (changeId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, changeId),
            eq(decisions.kind, "stage_dependency")
          )
        )
        .orderBy(decisions.createdAt, decisions.id)
    );

  it("a hold is NOT a board-level block — it must not mark the component blocked forever", async () => {
    // The newest block row for a subject, filtered by kind. See docs/coordination.md §931.
    const dependency = await componentAt("blockread-dep", [gamma]);
    const dependant = await componentAt("blockread-app", [gamma]);

    const change = await release("blockread", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(3);

    // The hold is real and recorded — otherwise the assertion below would pass vacuously.
    expect(firedFor(dependant.at(gamma))).toBe(0);
    expect(await holdDecisions(change.id)).toHaveLength(1);

    // ...and the board's block read does not see it.
    const asBlock = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      latestBlockDecisionForSubject(tx, org.orgId, change.id)
    );
    expect(asBlock).toBeUndefined();
  });

  it("HOLDS the trigger — the executor is never called, and the wave never reports complete", async () => {
    const dependency = await componentAt("held-dep", [gamma]);
    const dependant = await componentAt("held-app", [gamma]);

    const change = await release("held", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(3);

    // (a) THE GUARANTEE. Not "the row says pending" — the executor was never asked.
    expect(firedFor(dependant.at(gamma))).toBe(0);
    expect(await waveTargetStatus(change.id, dependant.at(gamma))).toBe("pending");

    // (b) INVARIANT 1, copied verbatim from the backoff gate: the target is counted as in flight
    // BEFORE the `continue`. Drop it and the wave below marks itself `succeeded` — a change that
    // reports a clean release for a target that never ran, which is worse than the bug this feature
    // fixes.
    expect(await waveStatuses(change.id)).toEqual(["running"]);
    const row = await changeRow(change.id);
    expect(row.state).toBe("executing");
    // Held, not PARKED: a parked change stops being served and nothing would ever resume it.
    expect(row.reconcileBlockedAt).toBeNull();

    // (c) The dependency itself is untouched — the hold reads it, it does not drive it.
    expect(firedFor(dependency.at(gamma))).toBe(0);
  });

  it("RELEASES once the dependency's wave target at that stage reaches `succeeded`", async () => {
    const dependency = await componentAt("rel-dep", [gamma]);
    const dependant = await componentAt("rel-app", [gamma]);

    const depChange = await release("rel-dep-change", [dependency.id]);
    const appChange = await release(
      "rel-app-change",
      [dependant.id],
      [{ dependsOn: dependency.id }]
    );
    await tick(2);

    // The dependency is in flight at gamma and the dependant is held behind it.
    expect(await waveTargetStatus(depChange.id, dependency.at(gamma))).toBe("observing");
    expect(firedFor(dependant.at(gamma))).toBe(0);

    // The dependency finishes — through the real poll path, not a hand-written column.
    executorConfig.forcePhase[dependency.at(gamma)] = "succeeded";
    await tick(3);

    expect(await waveTargetStatus(depChange.id, dependency.at(gamma))).toBe("succeeded");
    expect(firedFor(dependant.at(gamma))).toBe(1);
    expect(await waveTargetStatus(appChange.id, dependant.at(gamma))).not.toBe("pending");
  });

  it("an ABANDONED release of the dependency does not wedge the hold forever", async () => {
    // THE PERMANENT DEADLOCK. See docs/coordination.md §932.
    const dependency = await componentAt("abandoned-dep", [gamma]);
    const dependant = await componentAt("abandoned-app", [gamma]);

    const first = await release("abandoned-dep-first", [dependency.id]);
    executorConfig.forcePhase[dependency.at(gamma)] = "succeeded";
    await tick(3);
    expect(await waveTargetStatus(first.id, dependency.at(gamma))).toBe("succeeded");

    // (2) A second release of the dependency starts at the same place, then is abandoned mid-flight.
    delete executorConfig.forcePhase[dependency.at(gamma)];
    const second = await release("abandoned-dep-second", [dependency.id]);
    await tick(2);
    expect(await waveTargetStatus(second.id, dependency.at(gamma))).toBe("observing");
    await admin.changes.cancel(second.id, "abandoned by its author");
    expect((await changeRow(second.id)).state).toBe("cancelled");
    // The frozen row is still there — this is the input, not an artefact of the fixture.
    expect(await waveTargetStatus(second.id, dependency.at(gamma))).toBe("observing");

    // (3) A dependant proposed now must see the SUCCEEDED deploy, not the abandoned one.
    const change = await release("abandoned-app", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(4);

    expect(firedFor(dependant.at(gamma))).toBe(1);
    expect(await holdDecisions(change.id)).toHaveLength(0);
  });

  it("a SOFT-DELETED change's wave target does not wedge the hold either", async () => {
    // The other half of the same property, and the one that makes this read AGREE with
    // `component-pipeline.ts`'s `currentByPlacement` — which has always excluded deleted change
    // objects from the same "what last happened at this stage" question. A hold that believes a row
    // the pipeline view has stopped showing is unexplainable from the UI an operator would reach for.
    const dependency = await componentAt("deleted-dep", [gamma]);
    const dependant = await componentAt("deleted-app", [gamma]);

    const first = await release("deleted-dep-first", [dependency.id]);
    executorConfig.forcePhase[dependency.at(gamma)] = "succeeded";
    await tick(3);
    expect(await waveTargetStatus(first.id, dependency.at(gamma))).toBe("succeeded");

    delete executorConfig.forcePhase[dependency.at(gamma)];
    const second = await release("deleted-dep-second", [dependency.id]);
    await tick(2);
    expect(await waveTargetStatus(second.id, dependency.at(gamma))).toBe("observing");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(objects)
        .set({ deletedAt: new Date() })
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, second.id)))
    );

    const change = await release("deleted-app", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(4);

    expect(firedFor(dependant.at(gamma))).toBe(1);
    expect(await holdDecisions(change.id)).toHaveLength(0);
  });

  it("a FAILED release of the dependency still HOLDS — abandoned and failed are not the same call", async () => {
    // The boundary of the fix above, pinned so the exclusion cannot quietly widen into "any latest
    // target that isn't succeeded is ignorable". A change whose target failed has not been
    // abandoned: it is a live change parked on a real failure, and "do not deploy ahead of a
    // dependency whose own deploy here just failed" is the guarantee working, not a bug.
    const dependency = await componentAt("failed-dep", [gamma]);
    const dependant = await componentAt("failed-app", [gamma]);

    const first = await release("failed-dep-first", [dependency.id]);
    executorConfig.forcePhase[dependency.at(gamma)] = "succeeded";
    await tick(3);
    expect(await waveTargetStatus(first.id, dependency.at(gamma))).toBe("succeeded");

    executorConfig.forcePhase[dependency.at(gamma)] = "failed";
    const second = await release("failed-dep-second", [dependency.id]);
    await tick(3);
    expect(await waveTargetStatus(second.id, dependency.at(gamma))).toBe("failed");
    expect((await changeRow(second.id)).state).not.toBe("cancelled");

    const change = await release("failed-app", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(3);

    expect(firedFor(dependant.at(gamma))).toBe(0);
    const [decision] = await holdDecisions(change.id);
    const verdict = (decision!.inputContext as HeldContext).held[0]!.dependencies[0]!;
    expect(verdict.branch).toBe("behind");
    expect(verdict.dependencyStatus).toBe("failed");
    delete executorConfig.forcePhase[dependency.at(gamma)];
  });

  it("a release PARKED IN `waiting` does not mask the dependency's earlier success", async () => {
    // The same wedge, reached without anyone abandoning anything. See docs/coordination.md §933.
    const dependency = await componentAt("waiting-dep", [gamma]);
    const dependant = await componentAt("waiting-app", [gamma]);

    const first = await release("waiting-dep-first", [dependency.id]);
    executorConfig.forcePhase[dependency.at(gamma)] = "succeeded";
    await tick(3);
    expect(await waveTargetStatus(first.id, dependency.at(gamma))).toBe("succeeded");

    // (2) A second release of the dependency compiles its plan and then parks in `waiting` on a
    //     cross-change prerequisite nothing in this org will ever provide.
    delete executorConfig.forcePhase[dependency.at(gamma)];
    const second = await admin.changes.propose({
      name: `waiting-dep-second-${randomUUID().slice(0, 8)}`,
      targets: [dependency.id],
      topology: topologyId,
      requires: [{ key: "never-provided", at: gamma.id }]
    });
    await tick(3);

    // The inputs, asserted rather than assumed: the change is parked, its gamma row exists, is the
    // NEWEST one at that placement, and no executor has ever seen it.
    expect((await changeRow(second.id)).state).toBe("waiting");
    expect(await waveTargetStatus(second.id, dependency.at(gamma))).toBe("pending");
    expect(firedFor(dependency.at(gamma))).toBe(1);

    // (3) A dependant proposed now must see the SUCCEEDED deploy, not the parked plan.
    const change = await release("waiting-app", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(4);

    expect(firedFor(dependant.at(gamma))).toBe(1);
    expect(await holdDecisions(change.id)).toHaveLength(0);
  });

  it("a `coordinated` release DOES count — the census must not exclude the batch's own backlog", async () => {
    // The boundary on the other side of the parked cases. See docs/coordination.md §934.
    const dependency = await componentAt("coordinated-dep", [gamma]);

    const first = await release("coordinated-dep-first", [dependency.id]);
    executorConfig.forcePhase[dependency.at(gamma)] = "succeeded";
    await tick(3);
    expect(await waveTargetStatus(first.id, dependency.at(gamma))).toBe("succeeded");

    // A second release, put back into the state it occupies. See docs/coordination.md §935.
    delete executorConfig.forcePhase[dependency.at(gamma)];
    const second = await release("coordinated-dep-second", [dependency.id]);
    await tick(2);
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx
        .update(changes)
        .set({ state: "coordinated", reconcileBlockedAt: null })
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, second.id)));
      const plan = await getLatestPlanForChange(tx, org.orgId, second.id);
      for (const wave of plan!.waves) {
        await tx
          .update(changeWaveTargets)
          .set({ status: "pending" })
          .where(
            and(eq(changeWaveTargets.orgId, org.orgId), eq(changeWaveTargets.waveId, wave.id))
          );
      }
    });

    // The inputs, asserted rather than assumed: it really is `coordinated`, unparked, and its gamma
    // row is `pending` and NEWER than the succeeded one.
    const row = await changeRow(second.id);
    expect(row.state).toBe("coordinated");
    expect(row.reconcileBlockedAt).toBeNull();
    expect(await waveTargetStatus(second.id, dependency.at(gamma))).toBe("pending");

    // (3) The census must return the COORDINATED release's pending row — "B is about to deploy v2
    //     here" — not the older success, which would let a dependant through against stale state.
    const latest = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      findLatestWaveTargetForObject(tx, org.orgId, dependency.at(gamma))
    );
    expect(latest?.status).toBe("pending");
  });

  it("a release PARKED by a wave that failed ELSEWHERE does not mask the earlier success either", async () => {
    // The third way in, showing why trusting is not the fix. See docs/coordination.md §936.
    const twoWave = await admin.object("release-topology").create({
      name: `gamma-then-prod-${randomUUID().slice(0, 8)}`,
      properties: {
        waves: [
          { name: "gamma", mode: "parallel", targets: [gamma.id] },
          { name: "prod", mode: "parallel", targets: [prod.id] }
        ]
      }
    });
    const twoWaveRelease = (
      label: string,
      targets: string[],
      stageDependencies?: { dependsOn: string }[]
    ) =>
      admin.changes.propose({
        name: `${label}-${randomUUID().slice(0, 8)}`,
        targets,
        topology: twoWave.id,
        ...(stageDependencies ? { stageDependencies } : {})
      });

    const dependency = await componentAt("parked-dep", [gamma, prod]);
    const dependant = await componentAt("parked-app", [prod]);

    // (1) The dependency rolls both waves and SUCCEEDS at prod.
    executorConfig.forcePhase[dependency.at(gamma)] = "succeeded";
    executorConfig.forcePhase[dependency.at(prod)] = "succeeded";
    const first = await twoWaveRelease("parked-dep-first", [dependency.id]);
    await tick(8);
    expect(await waveTargetStatus(first.id, dependency.at(prod))).toBe("succeeded");

    // (2) A second release of the dependency FAILS at gamma — wave 0 terminalizes `failed` and the
    //     change is parked for an operator, leaving its untouched prod row `pending` forever.
    executorConfig.forcePhase[dependency.at(gamma)] = "failed";
    delete executorConfig.forcePhase[dependency.at(prod)];
    const second = await twoWaveRelease("parked-dep-second", [dependency.id]);
    await tick(5);
    expect((await changeRow(second.id)).reconcileBlockedAt).not.toBeNull();
    expect(await waveTargetStatus(second.id, dependency.at(gamma))).toBe("failed");
    expect(await waveTargetStatus(second.id, dependency.at(prod))).toBe("pending");

    // (3) A dependant at PROD — where nothing failed — must see the succeeded deploy.
    const change = await twoWaveRelease(
      "parked-app",
      [dependant.id],
      [{ dependsOn: dependency.id }]
    );
    await tick(6);

    expect(firedFor(dependant.at(prod))).toBe(1);
    expect(await holdDecisions(change.id)).toHaveLength(0);
    delete executorConfig.forcePhase[dependency.at(gamma)];
  });

  it("a GENUINELY IN-FLIGHT newer release DOES still supersede an older success", async () => {
    // The other side of the property, and who stands behind it. See docs/coordination.md §937.
    const dependency = await componentAt("supersede-dep", [gamma]);
    const dependant = await componentAt("supersede-app", [gamma]);

    const first = await release("supersede-dep-first", [dependency.id]);
    executorConfig.forcePhase[dependency.at(gamma)] = "succeeded";
    await tick(3);
    expect(await waveTargetStatus(first.id, dependency.at(gamma))).toBe("succeeded");

    delete executorConfig.forcePhase[dependency.at(gamma)];
    const second = await release("supersede-dep-second", [dependency.id]);
    await tick(2);
    // Live, not parked, not waiting — the one shape that legitimately outranks a past success.
    expect(await waveTargetStatus(second.id, dependency.at(gamma))).toBe("observing");
    const secondRow = await changeRow(second.id);
    expect(secondRow.state).toBe("executing");
    expect(secondRow.reconcileBlockedAt).toBeNull();

    const change = await release("supersede-app", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(3);

    expect(firedFor(dependant.at(gamma))).toBe(0);
    const [decision] = await holdDecisions(change.id);
    const verdict = (decision!.inputContext as HeldContext).held[0]!.dependencies[0]!;
    expect(verdict.branch).toBe("behind");
    expect(verdict.dependencyStatus).toBe("observing");

    // And v2 finishing releases it — held, not wedged.
    executorConfig.forcePhase[dependency.at(gamma)] = "succeeded";
    await tick(3);
    expect(firedFor(dependant.at(gamma))).toBe(1);
  });

  it("a dependency NOT PLACED at this stage holds nothing — absence is a declared fact", async () => {
    // ADR-0026 D8: a component that is genuinely prod-only is a correct configuration, and
    // `plan-service.ts` already births its gamma wave `skipped`. Failing closed here would hold
    // every release behind a dependency that is never coming.
    const prodOnly = await componentAt("notplaced-dep", [prod]);
    const dependant = await componentAt("notplaced-app", [gamma]);

    const change = await release("notplaced", [dependant.id], [{ dependsOn: prodOnly.id }]);
    await tick(2);

    expect(firedFor(dependant.at(gamma))).toBe(1);
    expect(await holdDecisions(change.id)).toHaveLength(0);
  });

  it("`atTargets` scopes the coupling: a dependency declared only at prod does not hold at gamma", async () => {
    const dependency = await componentAt("scoped-dep", [gamma, prod]);
    const dependant = await componentAt("scoped-app", [gamma]);

    // The dependency IS placed at gamma and has never deployed there — so without the `atTargets`
    // scope this would hold. It is declared only at prod, and this topology only rolls gamma.
    const change = await release(
      "scoped",
      [dependant.id],
      [{ dependsOn: dependency.id, atTargets: [prod.id] }]
    );
    await tick(2);

    expect(firedFor(dependant.at(gamma))).toBe(1);
    expect(await holdDecisions(change.id)).toHaveLength(0);
  });

  it("MINWEIGHT releases at a PARTIAL rollout — the dependency has not finished, and that is the point", async () => {
    const dependency = await componentAt("weight-dep", [gamma]);
    const dependant = await componentAt("weight-app", [gamma]);

    // The dependency's canary is observed at 10% at gamma, still running.
    executorConfig.rolloutByTarget[dependency.at(gamma)] = { phase: "Progressing", weight: 10 };
    const depChange = await release("weight-dep-change", [dependency.id]);
    await tick(2);
    expect(await waveTargetStatus(depChange.id, dependency.at(gamma))).toBe("observing");

    const change = await release(
      "weight-app-change",
      [dependant.id],
      [{ dependsOn: dependency.id, minWeight: 10 }]
    );
    await tick(2);

    // THE OWNER'S HEADLINE REQUIREMENT: "we don't require the full 100% deployment". The dependant
    // released while its dependency is still mid-rollout at this very place.
    expect(firedFor(dependant.at(gamma))).toBe(1);
    expect(await waveTargetStatus(depChange.id, dependency.at(gamma))).not.toBe("succeeded");
    expect(await holdDecisions(change.id)).toHaveLength(0);
  });

  it("MINWEIGHT still holds while the observed weight is BELOW the declared minimum", async () => {
    const dependency = await componentAt("below-dep", [gamma]);
    const dependant = await componentAt("below-app", [gamma]);

    executorConfig.rolloutByTarget[dependency.at(gamma)] = { phase: "Progressing", weight: 10 };
    const depChange = await release("below-dep-change", [dependency.id]);
    // The dependency is triggered AND polled first, so its weight is genuinely on the record before
    // the dependant is ever evaluated. Skipping this would test something else: a just-triggered
    // target has no `observed_state` yet, so its first verdict is legitimately `weight_unreadable`
    // (`no_weight`) and only becomes `behind` once the first poll lands.
    await tick(2);
    expect(await waveTargetStatus(depChange.id, dependency.at(gamma))).toBe("observing");

    const change = await release(
      "below-app-change",
      [dependant.id],
      [{ dependsOn: dependency.id, minWeight: 50 }]
    );
    await tick(3);

    expect(firedFor(dependant.at(gamma))).toBe(0);
    const [decision] = await holdDecisions(change.id);
    const verdict = (decision!.inputContext as HeldContext).held[0]!.dependencies[0]!;
    // `behind`, NOT `weight_unreadable`: the weight was read fine, it is simply not there yet. The
    // two have opposite remedies, and ADR-0028 decision 4 requires them to be told apart.
    expect(verdict.branch).toBe("behind");
    expect(verdict.weightUnreadable).toBeUndefined();

    // And it releases the moment the weight reaches the declared minimum.
    executorConfig.rolloutByTarget[dependency.at(gamma)] = { phase: "Progressing", weight: 50 };
    await tick(3);
    expect(firedFor(dependant.at(gamma))).toBe(1);
  });

  it("an UNREADABLE weight falls back to the `succeeded` test — it never passes on its own", async () => {
    const dependency = await componentAt("unreadable-dep", [gamma]);
    const dependant = await componentAt("unreadable-app", [gamma]);

    // No `rolloutByTarget` entry at all: the ordinary case for most of the estate — a non-ArgoCD
    // executor, or a blue/green Rollout, which populates no canary weight whatsoever.
    const depChange = await release("unreadable-dep-change", [dependency.id]);
    const change = await release(
      "unreadable-app-change",
      [dependant.id],
      [{ dependsOn: dependency.id, minWeight: 1 }]
    );
    await tick(3);

    // A `minWeight` of 1 would be satisfied by ANY weight — including a zero conjured out of the
    // missing reading. It is not satisfied, because the reading is absent rather than zero.
    expect(firedFor(dependant.at(gamma))).toBe(0);
    const [decision] = await holdDecisions(change.id);
    const verdict = (decision!.inputContext as HeldContext).held[0]!.dependencies[0]!;
    expect(verdict.branch).toBe("weight_unreadable");
    expect(verdict.weightUnreadable).toBe("no_weight");

    // The fallback is the universal test, and it works: finishing the dependency releases the hold.
    executorConfig.forcePhase[dependency.at(gamma)] = "succeeded";
    await tick(3);
    expect(await waveTargetStatus(depChange.id, dependency.at(gamma))).toBe("succeeded");
    expect(firedFor(dependant.at(gamma))).toBe(1);
  });

  it("INERTNESS: an edge pointing OUTSIDE the change's own target set orders nothing", async () => {
    // The boundary of what the decision moved, not a single case. See docs/coordination.md §938.
    const dependency = await componentAt("inert-dep", [gamma]);
    const dependant = await componentAt("inert-app", [gamma]);
    await admin.relationships.create({
      typeId: "depends_on",
      fromId: dependant.id,
      toId: dependency.id
    });

    const change = await release("inert", [dependant.id]);
    await tick(2);

    expect(firedFor(dependant.at(gamma))).toBe(1);
    expect(await holdDecisions(change.id)).toHaveLength(0);
  });

  it("a plain `depends_on` EDGE between two targets of ONE change serialises them — no declaration", async () => {
    // The set the compile-time check covered and this does not. See docs/coordination.md §939.
    const dependency = await componentAt("edge-dep", [gamma]);
    const dependant = await componentAt("edge-app", [gamma]);
    await admin.relationships.create({
      typeId: "depends_on",
      fromId: dependant.id,
      toId: dependency.id
    });

    const change = await release("edge", [dependant.id, dependency.id]);
    await tick(3);

    // Serialised, not parallel — asserted against the EXECUTOR, which is the only thing that makes
    // "did not deploy ahead of it" a fact rather than a column.
    expect(firedFor(dependency.at(gamma))).toBe(1);
    expect(firedFor(dependant.at(gamma))).toBe(0);
    expect(await waveTargetStatus(change.id, dependant.at(gamma))).toBe("pending");

    // And it is EXPLAINED as edge-derived: an operator seeing a hold their CI never declared has to
    // be told the remedy is a graph edge, not a pipeline change.
    const [decision] = await holdDecisions(change.id);
    const verdict = (decision!.inputContext as HeldContext).held[0]!.dependencies[0]!;
    expect(verdict.dependsOn).toBe(dependency.id);
    expect(verdict.source).toBe("edge");
    expect(verdict.satisfied).toBe(false);
    expect(JSON.stringify(decision!.reasonTree)).toContain("depends_on");

    executorConfig.forcePhase[dependency.at(gamma)] = "succeeded";
    await tick(3);
    expect(firedFor(dependant.at(gamma))).toBe(1);
  });

  it("`atTargets` narrows the DECLARATION, it does not subtract the pair's edge", async () => {
    // The one interaction between the two halves of the set. See docs/coordination.md §940.
    const dependency = await componentAt("narrow-dep", [gamma, prod]);
    const dependant = await componentAt("narrow-app", [gamma, prod]);

    const change = await release(
      "narrow",
      [dependant.id, dependency.id],
      [{ dependsOn: dependency.id, atTargets: [prod.id] }]
    );
    await tick(3);

    expect(firedFor(dependency.at(gamma))).toBe(1);
    expect(firedFor(dependant.at(gamma))).toBe(0);
    const [decision] = await holdDecisions(change.id);
    const verdicts = (decision!.inputContext as HeldContext).held[0]!.dependencies;
    // ONE verdict, not two: the declaration does not apply here, so the edge speaks for the pair.
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.source).toBe("edge");
    expect(verdicts[0]!.minWeight).toBeUndefined();
  });

  it("`minWeight` does not SUBTRACT the pair's edge either — the strictest constraint wins", async () => {
    // The other half of the corollary, which was missing. See docs/coordination.md §941.
    const dependency = await componentAt("weaken-dep", [gamma]);
    const dependant = await componentAt("weaken-app", [gamma]);
    await admin.relationships.create({
      typeId: "depends_on",
      fromId: dependant.id,
      toId: dependency.id
    });

    // The dependency's canary is pinned at 5% and never finishes — comfortably past a minWeight of
    // 1, and nowhere near `succeeded`.
    executorConfig.rolloutByTarget[dependency.at(gamma)] = { phase: "Progressing", weight: 5 };

    const change = await release(
      "weaken",
      [dependant.id, dependency.id],
      [{ dependsOn: dependency.id, minWeight: 1 }]
    );
    await tick(6);

    expect(firedFor(dependency.at(gamma))).toBe(1);
    expect(firedFor(dependant.at(gamma))).toBe(0);
    expect(await waveTargetStatus(change.id, dependant.at(gamma))).toBe("pending");

    // ONE verdict for the pair, and it says what was asked for AND what was enforced.
    const [decision] = await holdDecisions(change.id);
    const verdicts = (decision!.inputContext as HeldContext).held[0]!.dependencies;
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.branch).toBe("behind");
    expect(verdicts[0]!.minWeight).toBe(1);
    expect(verdicts[0]!.minWeightSupersededByEdge).toBe(true);
    expect(JSON.stringify(decision!.reasonTree)).toContain("cannot weaken it");

    // Stricter, not unsatisfiable: the edge's own test still releases the hold.
    executorConfig.forcePhase[dependency.at(gamma)] = "succeeded";
    await tick(3);
    expect(firedFor(dependant.at(gamma))).toBe(1);
  });

  it("a MUTUAL pair in one change is refused LOUDLY at compile time, naming both components", async () => {
    // The deadlock the removed check used to catch, and the one thing the hold cannot: each target
    // would wait on the other's wave target leaving `pending`, forever, silently. `compileStages`
    // refuses it, `plan-service.ts` turns that into a 400, and reconcile makes it the change's
    // epitaph — the only explanation an operator ever gets for an auto-cancelled change.
    const a = await componentAt("cycle-a", [gamma]);
    const b = await componentAt("cycle-b", [gamma]);
    await admin.relationships.create({ typeId: "depends_on", fromId: a.id, toId: b.id });
    await admin.relationships.create({ typeId: "depends_on", fromId: b.id, toId: a.id });

    const change = await release("cycle", [a.id, b.id]);
    await tick(3);

    const row = await changeRow(change.id);
    expect(row.state).toBe("cancelled");
    // Neither ever ran — a deadlock that fired half a release would be worse than one that fired
    // none.
    expect(firedFor(a.at(gamma))).toBe(0);
    expect(firedFor(b.at(gamma))).toBe(0);

    const reason = await cancelReason(change.id);
    expect(reason).toContain(a.id);
    expect(reason).toContain(b.id);
    expect(reason).toContain(gamma.id);
  });

  it("a dependent pair in ONE wave compiles and then SERIALISES — the check ADR-0028 decision 6 replaced", async () => {
    // `plan-compiler.ts` used to reject this outright. See docs/coordination.md §942.
    const dependency = await componentAt("pair-dep", [gamma]);
    const dependant = await componentAt("pair-app", [gamma]);

    const change = await release(
      "pair",
      [dependant.id, dependency.id],
      [{ dependsOn: dependency.id }]
    );
    await tick(2);

    // One wave, two targets, one running and one held — not both, and not neither.
    const plan = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestPlanForChange(tx, org.orgId, change.id)
    );
    expect(plan!.waves).toHaveLength(1);
    expect(plan!.waves[0]!.targets).toHaveLength(2);
    expect(firedFor(dependency.at(gamma))).toBe(1);
    expect(firedFor(dependant.at(gamma))).toBe(0);
    expect(await waveTargetStatus(change.id, dependant.at(gamma))).toBe("pending");

    executorConfig.forcePhase[dependency.at(gamma)] = "succeeded";
    await tick(3);
    expect(firedFor(dependant.at(gamma))).toBe(1);

    // The hold Decision names the held target only — the dependency running beside it in the same
    // wave was never held, so it must not appear as one.
    const rows = await holdDecisions(change.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const context = row.inputContext as HeldContext;
      expect(context.held.map((h) => h.targetObjectId)).toEqual([dependant.at(gamma)]);
    }
  });

  it("a FAILED target TERMINALIZES the wave even with a held target beside it", async () => {
    // The inverse of the hold's invariant, and its regression. See docs/coordination.md §943.
    const dependency = await componentAt("wedge-dep", [gamma]);
    const dependant = await componentAt("wedge-app", [gamma]);
    executorConfig.forcePhase[dependency.at(gamma)] = "failed";

    const change = await release(
      "wedge",
      [dependant.id, dependency.id],
      [{ dependsOn: dependency.id }]
    );
    await tick(6);

    // (a) The hold's own guarantee is NOT traded away to get the wave unstuck: the dependant was
    // never handed to an executor, on this tick or any other. Asserted against the executor's call
    // log, not a status column.
    expect(firedFor(dependant.at(gamma))).toBe(0);
    // Left `pending` on a terminal wave — the truthful record of a target no executor ever saw.
    expect(await waveTargetStatus(change.id, dependant.at(gamma))).toBe("pending");
    expect(await waveTargetStatus(change.id, dependency.at(gamma))).toBe("failed");

    // (b) THE FIX. The wave reaches a verdict, and the change reaches the failure path every other
    // failed wave takes — parked for the operator (no `autoRollbackOnFailure` policy applies here),
    // which is also what frees the BATCH_LIMIT slot it used to hold forever.
    expect(await waveStatuses(change.id)).toEqual(["failed"]);
    expect((await changeRow(change.id)).reconcileBlockedAt).not.toBeNull();

    // (c) WHY it never ran is still on record beside the failure that ended the wave.
    expect((await holdDecisions(change.id)).length).toBeGreaterThan(0);

    // (d) And terminalizing is not a delayed release: further ticks never fire the held target.
    await tick(3);
    expect(firedFor(dependant.at(gamma))).toBe(0);
    delete executorConfig.forcePhase[dependency.at(gamma)];
  });

  it("the PURE hold still keeps a wave in flight — with nothing failed, nothing terminalizes", async () => {
    // The control for the case above, and the invariant. See docs/coordination.md §944.
    const dependency = await componentAt("inflight-dep", [gamma]);
    const dependant = await componentAt("inflight-app", [gamma]);
    const change = await release(
      "inflight",
      [dependant.id, dependency.id],
      [{ dependsOn: dependency.id }]
    );
    await tick(4);

    expect(await waveTargetStatus(change.id, dependency.at(gamma))).toBe("observing");
    expect(firedFor(dependant.at(gamma))).toBe(0);
    expect(await waveStatuses(change.id)).toEqual(["running"]);
    expect((await changeRow(change.id)).reconcileBlockedAt).toBeNull();

    // SHAPE 2: the held target is the ONLY thing left in flight — nothing else is running, and
    // nothing has failed. This is the pure hold, and it must stay open indefinitely.
    const soloDependency = await componentAt("solo-dep", [gamma]);
    const solo = await componentAt("solo-app", [gamma]);
    const soloChange = await release("solo", [solo.id], [{ dependsOn: soloDependency.id }]);
    await tick(5);

    expect(firedFor(solo.at(gamma))).toBe(0);
    expect(await waveStatuses(soloChange.id)).toEqual(["running"]);
    expect((await changeRow(soloChange.id)).reconcileBlockedAt).toBeNull();
    expect((await changeRow(soloChange.id)).state).toBe("executing");
  });

  it("a declared coupling with NO stage-shaped topology is NOT enforced — and SAYS SO (ADR-0028 decision 4)", async () => {
    // The fail-open, and whether the common CI case lands here. See docs/coordination.md §945.
    const dependency = await componentAt("nostage-dep", [gamma]);
    const dependant = await componentAt("nostage-app", [gamma]);

    // No `topology:` — and no `releases_via` edge on the component, its service, or the org root.
    const change = await admin.changes.propose({
      name: `nostage-${randomUUID().slice(0, 8)}`,
      targets: [dependant.id],
      stageDependencies: [{ dependsOn: dependency.id }]
    });
    await tick(3);

    // (a) THE MEASURED ANSWER: the wave target names the COMPONENT, not its placement at gamma.
    const plan = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestPlanForChange(tx, org.orgId, change.id)
    );
    const targets = plan!.waves.flatMap((w) => w.targets).map((t) => t.targetObjectId);
    expect(targets).toEqual([dependant.id]);
    expect(targets).not.toContain(dependant.at(gamma));

    // (b) The release PROCEEDED — this branch is fail-open by design, and failing closed on a shape
    //     the coupling cannot express would strand every legacy plan behind a dependency it can
    //     never evaluate. The dependency has never deployed anywhere; under a stage-shaped plan
    //     this would have held.
    expect(firedFor(dependant.id)).toBe(1);
    expect(await holdDecisions(change.id)).toHaveLength(0);

    // (c) AND IT IS VISIBLE. `warn`, not `block`: nothing was withheld, but "you declared a coupling
    //     and it was not enforced here" is now a row an operator can find rather than an absence.
    const rows = await unscopedDecisions(change.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verdict).toBe("warn");
    const context = rows[0]!.inputContext as UnscopedContext;
    expect(context.unenforced).toEqual([
      {
        targetObjectId: dependant.id,
        dependencies: [{ dependsOn: dependency.id, branch: "unscopeable", satisfied: true }]
      }
    ]);
    expect(JSON.stringify(rows[0]!.reasonTree)).toContain(dependency.id);
  });

  it("THE CONTROL: the same declaration under a STAGE-shaped topology IS enforced", async () => {
    // Without this arm the case above could mean "the hold never works", not "this shape cannot be
    // scoped". Same components, same declaration, same dependency-never-deployed — the ONLY
    // difference is that this change resolves the stage-shaped topology, so its wave targets are
    // placements and the hold has a place to work at.
    const dependency = await componentAt("control-dep", [gamma]);
    const dependant = await componentAt("control-app", [gamma]);

    const change = await release("control", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(3);

    const plan = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestPlanForChange(tx, org.orgId, change.id)
    );
    expect(plan!.waves.flatMap((w) => w.targets).map((t) => t.targetObjectId)).toEqual([
      dependant.at(gamma)
    ]);
    expect(firedFor(dependant.at(gamma))).toBe(0);
    expect(await holdDecisions(change.id)).toHaveLength(1);
    // And no fail-open record, because nothing failed open.
    expect(await unscopedDecisions(change.id)).toHaveLength(0);
  });

  it("the unenforced-coupling record is written ONCE too — the ADR-0024 property applies to it as well", async () => {
    // A `warn` row is as capable of flooding the table as a `block` one, and this seam is the one
    // that produced 1.44 GB/day. The evaluation still runs every tick a target is pending; only the
    // redundant WRITE is suppressed.
    const dependency = await componentAt("nostage-flood-dep", [gamma]);
    const dependant = await componentAt("nostage-flood-app", [gamma]);

    // A malformed entry alongside, so the target stays pending. See docs/coordination.md §946.
    const change = await admin.changes.propose({
      name: `nostage-flood-${randomUUID().slice(0, 8)}`,
      targets: [dependant.id],
      stageDependencies: [{ dependsOn: dependency.id }]
    });
    const stored = (await admin.changes.get(change.id)).properties as Record<string, unknown>;
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(objects)
        .set({
          properties: {
            ...stored,
            stageDependencies: [{ dependsOn: dependency.id }, "not-a-stage-dependency-at-all"]
          }
        })
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, change.id)))
    );
    await tick(8);

    expect(firedFor(dependant.id)).toBe(0);
    const rows = await unscopedDecisions(change.id);
    expect(rows).toHaveLength(1);
    // Held AND unenforced at the same time — the two are not mutually exclusive, which is why the
    // collection happens before the hold check rather than in an `else`.
    expect((await holdDecisions(change.id)).length).toBeGreaterThan(0);
  });

  it("PINS THE KNOWN LIMITATION: a declaration is change-scoped, so it holds EVERY target of the change", async () => {
    // The non-goals, stated as a test rather than only prose. See docs/coordination.md §947.
    const dependency = await componentAt("changescope-dep", [gamma]);
    const app = await componentAt("changescope-app", [gamma]);
    const sibling = await componentAt("changescope-sibling", [gamma]);

    // No `depends_on` edge between app and sibling, and none from sibling to the dependency — the
    // ONLY input naming the dependency is the change's own declaration.
    const change = await release(
      "changescope",
      [app.id, sibling.id],
      [{ dependsOn: dependency.id }]
    );
    await tick(3);

    expect(firedFor(app.at(gamma))).toBe(0);
    // THE OVER-APPLICATION. Nothing sibling declared, or that the graph asserts about sibling, says
    // it must wait for the dependency — and it waits anyway.
    expect(firedFor(sibling.at(gamma))).toBe(0);

    const [decision] = await holdDecisions(change.id);
    const held = (decision!.inputContext as HeldContext).held;
    expect(held.map((h) => h.targetObjectId).sort()).toEqual(
      [app.at(gamma), sibling.at(gamma)].sort()
    );
    // And the sibling's hold is attributed to a DECLARATION (no `source: "edge"`), which is what
    // makes it over-application rather than the edge-derived half doing its job.
    const siblingHold = held.find((h) => h.targetObjectId === sibling.at(gamma))!;
    expect(siblingHold.dependencies).toEqual([
      { dependsOn: dependency.id, branch: "never_deployed", satisfied: false }
    ]);

    // Both release together once the dependency succeeds — the coupling is over-broad, not broken.
    executorConfig.forcePhase[dependency.at(gamma)] = "succeeded";
    const depChange = await release("changescope-dep-change", [dependency.id]);
    await tick(4);
    expect(await waveTargetStatus(depChange.id, dependency.at(gamma))).toBe("succeeded");
    expect(firedFor(app.at(gamma))).toBe(1);
    expect(firedFor(sibling.at(gamma))).toBe(1);
  });

  it("the Decision is written ONCE across many ticks — the ADR-0024 regression guard", async () => {
    const dependency = await componentAt("flood-dep", [gamma]);
    const dependant = await componentAt("flood-app", [gamma]);

    const change = await release("flood", [dependant.id], [{ dependsOn: dependency.id }]);
    const TICKS = 8;
    await tick(TICKS);

    // Before persist-on-change, this seam would have written one byte-identical row per tick,
    // forever — the shape that reached 1.44 GB/day on the live homelab across 25 parked changes.
    const rows = await holdDecisions(change.id);
    expect(rows).toHaveLength(1);
    // `hold`, not `block` — a hold must not reach the service board's block read. Pinned on its own
    // above ("a hold is NOT a board-level block"); asserted here too so the verdict cannot drift back.
    expect(rows[0]!.verdict).toBe("hold");

    // Explainability (charter principle 6): the dependency, the PLACE, and WHICH branch applied.
    const context = rows[0]!.inputContext as HeldContext;
    expect(context.held).toHaveLength(1);
    const held = context.held[0]!;
    expect(held.targetObjectId).toBe(dependant.at(gamma));
    expect(held.componentObjectId).toBe(dependant.id);
    expect(held.deploymentTargetObjectId).toBe(gamma.id);
    expect(held.dependencies).toEqual([
      { dependsOn: dependency.id, branch: "never_deployed", satisfied: false }
    ]);
    expect(JSON.stringify(rows[0]!.reasonTree)).toContain(dependency.id);

    // The evaluation itself is NOT slowed — only the redundant write is suppressed. If it were
    // cached, this hold would never notice its dependency finishing.
    expect(firedFor(dependant.at(gamma))).toBe(0);
    const depChange = await release("flood-dep-change", [dependency.id]);
    executorConfig.forcePhase[dependency.at(gamma)] = "succeeded";
    const MORE_TICKS = 6;
    await tick(MORE_TICKS);
    expect(await waveTargetStatus(depChange.id, dependency.at(gamma))).toBe("succeeded");
    expect(firedFor(dependant.at(gamma))).toBe(1);

    // THE PROPERTY, stated the way it is actually true. See docs/coordination.md §948.
    const all = await holdDecisions(change.id);
    expect(distinctDecisionStatements(all)).toBe(all.length);
    expect(all.length).toBeLessThan(TICKS + MORE_TICKS);
    // Every row explains itself: no branch is left to be inferred from a bare id.
    for (const row of all) {
      const verdicts = (row.inputContext as HeldContext).held.flatMap((h) => h.dependencies);
      expect(verdicts.every((v) => typeof v.branch === "string" && v.branch.length > 0)).toBe(true);
    }
  });

  it("a held change keeps its place in the round-robin — the cursor moves every tick, and nothing else does", async () => {
    // THE 13-DAY OUTAGE PROPERTY. `listChangeRowsInStates` serves oldest-`reconcile_cursor_at`-first
    // capped at BATCH_LIMIT; a held change whose cursor froze would occupy a batch slot forever and
    // starve every change queued behind it. Measured on the live homelab: 231 changes proposed after
    // the wedge, ZERO ever evaluated once.
    const dependency = await componentAt("starve-dep", [gamma]);
    const dependant = await componentAt("starve-app", [gamma]);

    const change = await release("starve", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(2);
    const first = await changeRow(change.id);
    await tick(2);
    const second = await changeRow(change.id);

    expect(second.reconcileCursorAt.getTime()).toBeGreaterThan(first.reconcileCursorAt.getTime());
    // `state_entered_at` is deliberately NOT bumped — the watchdog's stall SLA must keep measuring
    // from when the change actually entered `executing`.
    expect(second.stateEnteredAt.getTime()).toBe(first.stateEnteredAt.getTime());
    // NOR IS `updated_at`, since migration 0058. Across these four ticks the change was held every
    // time — its targets were deliberately never triggered — so nothing about it changed, and the
    // field an operator reads as "last modified" must say so. This is the assertion that fails if
    // the hold bump is ever moved back onto the shared column.
    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
  });
});

/** The `inputContext` shape `recordStageDependencyUnscoped` writes — the fail-open record. */
interface UnscopedContext {
  unenforced: {
    targetObjectId: string;
    dependencies: { dependsOn: string; branch: string; satisfied: boolean }[];
  }[];
}

/** The `inputContext` shape `recordStageDependencyHold` writes — asserted structurally rather than
 *  by string-matching, so a rename cannot pass by coincidence. */
interface HeldContext {
  held: {
    targetObjectId: string;
    componentObjectId: string | null;
    deploymentTargetObjectId: string | null;
    dependencies: {
      dependsOn: string;
      branch: string;
      satisfied: boolean;
      source?: string;
      dependencyStatus?: string;
      minWeight?: number;
      minWeightSupersededByEdge?: true;
      weightUnreadable?: string;
    }[];
  }[];
}
