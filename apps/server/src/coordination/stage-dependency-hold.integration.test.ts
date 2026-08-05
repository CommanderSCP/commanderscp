import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { changes, decisions } from "../db/schema.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { getLatestPlanForChange } from "./plan-service.js";
import { reconcileOrgTick } from "./reconcile.js";
import { distinctDecisionStatements } from "./test-support/counting-cel-sandbox.js";
import { createInMemoryFakeHost, withRefusingTrigger } from "./test-support/fake-plugin-host.js";

/**
 * ADR-0028 increment 3 — THE HOLD, end to end against real Postgres.
 *
 * The guarantee under test: *A's deploy at stage S is not TRIGGERED until every declared dependency
 * of A that applies at S is satisfied at S.* "Not triggered" is asserted against the EXECUTOR — the
 * `trigger()` calls the plugin host actually received — not merely against a status column, because
 * a hold that recorded the right row while still firing the release would pass a column assertion
 * and fail the only thing that matters.
 *
 * DRIVES `reconcileOrgTick` DIRECTLY, no pg-boss loop (the same choice
 * `decision-write-amplification.integration.test.ts` makes, and for the same reason): "N ticks" then
 * means exactly N, which is what makes the persist-on-change row count a real assertion instead of a
 * race. A live loop would also be a COMPETING CONSUMER of the very rows these tests read back.
 *
 * The dependency's state is moved through the REAL write path — the fake executor's own
 * `forcePhase`/`rolloutByTarget` config, polled by reconcile, landing in `observed_state` via
 * `updateWaveTargetObserved`. Nothing here writes a wave-target column by hand; a fixture that
 * fabricated the observation would prove the predicate and nothing about the plumbing feeding it.
 * `ctx.config` is re-read on every plugin call, so mutating the shared config object between ticks
 * is how a dependency "progresses".
 *
 * `reconcileOrgTick` sweeps the WHOLE org, so leftover changes from earlier cases keep advancing in
 * later ones. Every assertion is therefore scoped to a specific placement id or change id — never to
 * a bare call count (fake-plugin-host.ts's own warning).
 */

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
    org = await createTestOrg(server, "stagedephold");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    gamma = await admin.deploymentTargets.create({ name: `gamma-${randomUUID().slice(0, 8)}` });
    prod = await admin.deploymentTargets.create({ name: `prod-${randomUUID().slice(0, 8)}` });
    const topology = await admin.object("release-topology").create({
      name: `gamma-only-${randomUUID().slice(0, 8)}`,
      properties: { waves: [{ name: "gamma", mode: "parallel", targets: [gamma.id] }] }
    });
    topologyId = topology.id;
    // `() => false` refuses nothing — the wrapper is used purely for its call log, which is the only
    // way to assert that a held target's executor was never asked to do anything.
    const wrapped = withRefusingTrigger(createInMemoryFakeHost(executorConfig), () => false);
    host = wrapped.host;
    triggered = wrapped.calls;
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

  it("HOLDS the trigger — the executor is never called, and the wave never reports complete", async () => {
    const dependency = await componentAt("held-dep", [gamma]);
    const dependant = await componentAt("held-app", [gamma]);

    const change = await release("held", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(3);

    // (a) THE GUARANTEE. Not "the row says pending" — the executor was never asked.
    expect(firedFor(dependant.at(gamma))).toBe(0);
    expect(await waveTargetStatus(change.id, dependant.at(gamma))).toBe("pending");

    // (b) INVARIANT 1, copied verbatim from the backoff gate: `allTerminal = false` is set BEFORE
    // the `continue`. Drop it and the wave below marks itself `succeeded` — a change that reports a
    // clean release for a target that never ran, which is worse than the bug this feature fixes.
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
    // THE BOUNDARY of what ADR-0028 decision 6 moved, and the reason it is a boundary rather than a
    // simplification. The removed compile-time check keyed on edges with BOTH endpoints in the
    // change's target set (`loadDependsOnEdges`), so an edge reaching outside it never ordered
    // anything and must not start now: `graph.dependentIds` is a live CEL policy input, and making
    // every edge in the org a release gate would re-serialise releases that ran in parallel
    // yesterday. Here the change targets ONLY the dependant, so this edge is out of scope — even
    // though it points at a component that has never deployed at gamma and would otherwise hold.
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
    // THE SET THE COMPILE-TIME CHECK COVERED AND THE DECLARATION CHANNEL DOES NOT. `compileStages`
    // used to 400 any plan putting two edge-joined targets in one wave, whatever wrote the edge — a
    // seed, an IaC manifest, an operator, or an EARLIER change's declaration. Keying the hold only
    // on THIS change's `stageDependencies` would have left every one of those ordering nothing at
    // all: the pair would compile into one wave and both targets would fire in parallel, with no
    // hold and no record. Nothing here declares anything; the edge is the whole input.
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
    // The one interaction between the two halves of the dependency set, pinned because the tempting
    // "de-dupe against everything declared" is wrong. A declaration scoped to prod is filtered out
    // at gamma — but the `depends_on` edge it minted is a standing graph fact with both endpoints in
    // this change's target set, which is exactly the input `compileStages` used to refuse outright.
    // Suppressing it here would let a declarer WEAKEN an ordering the graph already asserts, and
    // would ship the parallel deploy that used to be a 400.
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
    // `plan-compiler.ts` used to reject this outright (`topology_violates_dependency` -> 400 ->
    // "auto-cancelled: plan compilation failed"). Increment 2 removed that refusal on the promise
    // that the per-target hold would take the ordering over; this is the test that collects on it.
    // Both components are targets of the SAME change, so both placements sit in the SAME wave — the
    // exact shape the wave gate cannot express, because it issues one verdict for the whole wave.
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
    expect(rows[0]!.verdict).toBe("block");

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

    // THE PROPERTY, stated the way it is actually true: no row is ever a RESTATEMENT of the one
    // before it. Across 14 ticks the hold's explanation legitimately changes — `never_deployed`
    // becomes `behind` the moment the dependency's own release gives it a wave target here — and
    // each of those is a genuinely different answer worth a row. What must never happen is the same
    // answer written twice, which is what "per tick" would look like.
    const all = await holdDecisions(change.id);
    expect(distinctDecisionStatements(all)).toBe(all.length);
    expect(all.length).toBeLessThan(TICKS + MORE_TICKS);
    // Every row explains itself: no branch is left to be inferred from a bare id.
    for (const row of all) {
      const verdicts = (row.inputContext as HeldContext).held.flatMap((h) => h.dependencies);
      expect(verdicts.every((v) => typeof v.branch === "string" && v.branch.length > 0)).toBe(true);
    }
  });

  it("a held change keeps its place in the round-robin — `updated_at` moves every tick", async () => {
    // THE 13-DAY OUTAGE PROPERTY. `listChangeRowsInStates` serves oldest-`updated_at`-first capped
    // at BATCH_LIMIT; a held change whose `updated_at` froze would occupy a batch slot forever and
    // starve every change queued behind it. Measured on the live homelab: 231 changes proposed after
    // the wedge, ZERO ever evaluated once.
    const dependency = await componentAt("starve-dep", [gamma]);
    const dependant = await componentAt("starve-app", [gamma]);

    const change = await release("starve", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(2);
    const first = await changeRow(change.id);
    await tick(2);
    const second = await changeRow(change.id);

    expect(second.updatedAt.getTime()).toBeGreaterThan(first.updatedAt.getTime());
    // `state_entered_at` is deliberately NOT bumped — the watchdog's stall SLA must keep measuring
    // from when the change actually entered `executing`.
    expect(second.stateEnteredAt.getTime()).toBe(first.stateEnteredAt.getTime());
  });
});

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
      minWeight?: number;
      weightUnreadable?: string;
    }[];
  }[];
}
