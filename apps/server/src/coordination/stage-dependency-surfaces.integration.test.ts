import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { changes, decisions, objects } from "../db/schema.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { reconcileOrgTick } from "./reconcile.js";
import { runWatchdogSweep } from "./watchdog.js";
import { latestDecisionForSubjectKind } from "./decisions-repo.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";

/** The operator surfaces, end to end against real Postgres. See docs/coordination.md §968. */

/** Mutable — the in-memory host closes over it and the plugin re-reads it on every call. */
const executorConfig: {
  autoSucceedAfterMs: number;
  forcePhase: Record<string, string>;
} = {
  // Long enough that a triggered target sits durably in flight rather than racing the assertions.
  autoSucceedAfterMs: 10 * 60_000,
  forcePhase: {}
};

describe("stage dependencies: the operator surfaces (ADR-0028 increment 4)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let gamma: GraphObject;
  let topologyId: string;
  let host: PluginHost;

  beforeAll(async () => {
    server = await listenTestServer();
    host = createInMemoryFakeHost(executorConfig);
  });

  beforeEach(async () => {
    org = await createTestOrg(server, "stagedepsurf");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    gamma = await admin.deploymentTargets.create({ name: `gamma-${randomUUID().slice(0, 8)}` });
    const topology = await admin.object("release-topology").create({
      name: `gamma-only-${randomUUID().slice(0, 8)}`,
      properties: { waves: [{ name: "gamma", mode: "parallel", targets: [gamma.id] }] }
    });
    topologyId = topology.id;
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
      name: component.name,
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

  const stateOf = async (changeId: string) => {
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, changeId)))
    );
    return row!.state;
  };

  it("does not double-count a target that is BOTH freeze-held and dependency-held (M25.UI review finding 1)", async () => {
    // The held count is composed from two independent predicates. See docs/coordination.md §969.
    const dependency = await componentAt("dedup-dep", [gamma]);
    const dependant = await componentAt("dedup-app", [gamma]);
    await admin.freezes.create({
      scopeObjectId: gamma.id,
      name: `gamma-dedup-freeze-${randomUUID().slice(0, 8)}`,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: "dedup: integration fixture"
    });
    const change = await release("dedup-held", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(3);

    const explained = await admin.changes.explain(change.id);
    // Both halves genuinely fired — this is not testing an unreachable configuration.
    expect(explained.stageDependencyStatus?.held).toBe(true);
    const wave = explained.plan!.waves[0]!;
    const target = wave.targets.find((t) => t.targetObjectId === dependant.at(gamma))!;
    expect(target.status).toBe("pending");
    expect(target.hold).toBeTruthy();

    // THE ONE TARGET THIS WAVE HAS IS HELD BY TWO PREDICATES AT ONCE. `heldTargetCount` counts
    // TARGETS held, not holds applied — a 1-target wave must report 1, never 2.
    expect(wave.heldTargetCount).toBe(1);
  }, 60_000);

  it("explain NAMES the held dependency, its branch and the stage — not just a Decision row", async () => {
    const dependency = await componentAt("explain-dep", [gamma]);
    const dependant = await componentAt("explain-app", [gamma]);
    const change = await release("explain-held", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(3);

    const explained = await admin.changes.explain(change.id);
    const status = explained.stageDependencyStatus;
    expect(status).toBeTruthy();
    expect(status!.held).toBe(true);
    expect(status!.unenforced).toBe(false);
    expect(status!.waveIndex).toBe(0);
    expect(status!.targets).toHaveLength(1);

    const target = status!.targets[0]!;
    // THE PLACE, both halves of it. A stage-scoped hold that could not say WHERE would be no more
    // actionable than the `pending` badge it replaces.
    expect(target.targetObjectId).toBe(dependant.at(gamma));
    expect(target.componentObjectId).toBe(dependant.id);
    expect(target.componentName).toBe(dependant.name);
    expect(target.deploymentTargetObjectId).toBe(gamma.id);
    expect(target.deploymentTargetName).toBe(gamma.name);
    expect(target.held).toBe(true);

    // THE DEPENDENCY AND THE BRANCH. `never_deployed` rather than `behind` is the whole point of
    // ADR-0028 decision 4's distinguishable branches: the remedies differ.
    expect(target.dependencies).toHaveLength(1);
    const verdict = target.dependencies[0]!;
    expect(verdict.dependsOn).toBe(dependency.id);
    expect(verdict.dependsOnName).toBe(dependency.name);
    expect(verdict.branch).toBe("never_deployed");
    expect(verdict.satisfied).toBe(false);
    expect(verdict.summary).toContain("has never deployed here");
    // Nothing claimed that was not asked for: no qualifier was declared, so none is echoed.
    expect(verdict.minWeight).toBeUndefined();
    expect(verdict.weightUnreadable).toBeUndefined();
    expect(verdict.source).toBeUndefined();
  }, 60_000);

  it("goes UNHELD the moment the hold clears — while the `hold` Decision is still the latest row", async () => {
    // THE LIVE-READ TEST. Nothing writes a clearing Decision, so a projection sourced from the
    // persisted row reports `held` forever: through the trigger, through `accepted`, permanently.
    // That is the block-verdict trap rebuilt on a read path, and it is invisible to any test that
    // only ever checks a change WHILE it is held.
    const dependency = await componentAt("live-dep", [gamma]);
    const dependant = await componentAt("live-app", [gamma]);

    await release("live-dep-change", [dependency.id]);
    const appChange = await release(
      "live-app-change",
      [dependant.id],
      [{ dependsOn: dependency.id }]
    );
    await tick(2);
    expect((await admin.changes.explain(appChange.id)).stageDependencyStatus!.held).toBe(true);

    executorConfig.forcePhase[dependency.at(gamma)] = "succeeded";
    await tick(3);

    // THE INPUT, asserted rather than assumed: the stale `hold` row is still the newest of its kind.
    // Without this the case below could pass because no Decision was ever written at all.
    const stale = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      latestDecisionForSubjectKind(tx, org.orgId, appChange.id, "stage_dependency")
    );
    expect(stale?.verdict).toBe("hold");

    const status = (await admin.changes.explain(appChange.id)).stageDependencyStatus;
    // Still non-null — the change DID declare a coupling, and saying so is not the same as claiming
    // it is waiting — but nothing is held any more.
    expect(status).toBeTruthy();
    expect(status!.held).toBe(false);
    expect(status!.targets.every((t) => !t.held)).toBe(true);
  }, 60_000);

  it("echoes a declared `minWeight` and WHY it could not be read, on the verdict that fell back", async () => {
    const dependency = await componentAt("weight-dep", [gamma]);
    const dependant = await componentAt("weight-app", [gamma]);

    // The dependency is genuinely in flight at gamma — triggered, observing, and reporting no
    // rollout weight at all (the fake executor produces none, which is the ordinary shape for
    // everything that is not an ArgoCD canary).
    await release("weight-dep-change", [dependency.id]);
    const change = await release(
      "weight-app-change",
      [dependant.id],
      [{ dependsOn: dependency.id, minWeight: 50 }]
    );
    await tick(3);

    const verdict = (await admin.changes.explain(change.id)).stageDependencyStatus!.targets[0]!
      .dependencies[0]!;
    expect(verdict.branch).toBe("weight_unreadable");
    expect(verdict.satisfied).toBe(false);
    expect(verdict.minWeight).toBe(50);
    expect(verdict.weightUnreadable).toBe("no_weight");
    expect(verdict.summary).toContain("50");
  }, 60_000);

  it("stops reporting a hold once the release is CANCELLED — the gate is in the resolver, not at one call site", async () => {
    // THE REGRESSION THIS FILE SHIPPED WITHOUT. See docs/coordination.md §970.
    const dependency = await componentAt("cancel-dep", [gamma]);
    const dependant = await componentAt("cancel-app", [gamma]);
    const change = await release("cancel-held", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(3);

    // THE CONTROL, in the same case: while the change is `executing` this really is held, so the
    // assertion below cannot pass because the surface stopped working altogether.
    const whileExecuting = (await admin.changes.explain(change.id)).stageDependencyStatus;
    expect(whileExecuting!.held).toBe(true);
    expect(whileExecuting!.targets).toHaveLength(1);

    await admin.changes.cancel(change.id, "abandoned while held");
    expect(await stateOf(change.id)).toBe("cancelled");

    const after = (await admin.changes.explain(change.id)).stageDependencyStatus;
    // NOT null. Null is "this change coupled nothing at any stage" and this one plainly did — the
    // CLI prints those two as different sentences. The true statement is that no wave target of it
    // is awaiting a trigger any more.
    expect(after).toBeTruthy();
    expect(after!.held, "a cancelled release is not waiting for anything").toBe(false);
    expect(after!.targets).toHaveLength(0);

    // THE INPUTS, so this cannot pass for the wrong reason: the target really is still sitting at
    // `pending` (it was never triggered, and that record is truthful), and the stale `hold`
    // Decision really is still the newest of its kind. Neither of them is what cleared this.
    const stage = (await admin.components.pipeline(dependant.id)).stages[0]!;
    expect(stage.currents[0]?.targetStatus).toBe("pending");
    const stale = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      latestDecisionForSubjectKind(tx, org.orgId, change.id, "stage_dependency")
    );
    expect(stale?.verdict).toBe("hold");
  }, 60_000);

  it("is NULL for a change that coupled nothing — the field is absent, not an empty claim", async () => {
    const lonely = await componentAt("uncoupled", [gamma]);
    const change = await release("uncoupled-change", [lonely.id]);
    await tick(2);
    expect((await admin.changes.explain(change.id)).stageDependencyStatus).toBeNull();
  }, 60_000);

  it("reports `unenforced` when a declared coupling had NO PLACE to be scoped by", async () => {
    // The live counterpart of the warn, which shipped untested. See docs/coordination.md §971.
    const dependency = await componentAt("unenf-dep", [gamma]);
    const dependant = await componentAt("unenf-app", [gamma]);
    const change = await admin.changes.propose({
      name: `unenf-${randomUUID().slice(0, 8)}`,
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
    await tick(4);

    const status = (await admin.changes.explain(change.id)).stageDependencyStatus;
    expect(status).toBeTruthy();
    // THE FLAG UNDER TEST. Held AND unenforced at once — they are not alternatives, and the two
    // sentences an operator needs here are "you are stuck on entry 2" and "entry 1 is doing
    // nothing".
    expect(status!.unenforced, "a declared coupling that was NOT enforced must not be silent").toBe(
      true
    );
    expect(status!.held).toBe(true);

    const target = status!.targets[0]!;
    // THE INPUT, asserted rather than assumed: this really is the placement-less shape. Both halves
    // of the place are null, and the wave target names the COMPONENT — if a topology ever started
    // resolving for this fixture the case would go green for the wrong reason without it.
    expect(target.targetObjectId).toBe(dependant.id);
    expect(target.componentObjectId).toBeNull();
    expect(target.deploymentTargetObjectId).toBeNull();

    const unscopeable = target.dependencies.find((d) => d.branch === "unscopeable");
    expect(unscopeable).toBeDefined();
    expect(unscopeable!.dependsOn).toBe(dependency.id);
    // `satisfied: true` — the release proceeds past THIS entry — which is exactly why the flag
    // above has to exist: nothing was checked, and the CLI refuses to print "satisfied" for it.
    expect(unscopeable!.satisfied).toBe(true);
    expect(target.dependencies.some((d) => d.branch === "undeclarable" && !d.satisfied)).toBe(true);

    // AND THE PERSISTED COUNTERPART IS THERE TOO, which is what the CLI's footer points an operator
    // at (`scp decision list --kind stage_dependency_unscoped`). The live flag and the durable
    // record must agree; a footer naming a query that returns nothing would be worse than no footer.
    const unscoped = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      latestDecisionForSubjectKind(tx, org.orgId, change.id, "stage_dependency_unscoped")
    );
    expect(unscoped?.verdict).toBe("warn");
  }, 60_000);

  it("SURVIVES a malformed stored entry — an `undeclarable` id is not a uuid, and the name lookup must not choke on it", async () => {
    // Found by the case above, and a different defect. See docs/coordination.md §972.
    const dependency = await componentAt("undecl-dep", [gamma]);
    const dependant = await componentAt("undecl-app", [gamma]);
    const change = await release("undecl", [dependant.id], [{ dependsOn: dependency.id }]);
    const stored = (await admin.changes.get(change.id)).properties as Record<string, unknown>;
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(objects)
        .set({
          properties: {
            ...stored,
            stageDependencies: [{ dependsOn: dependency.id }, { dependsOn: 42 }]
          }
        })
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, change.id)))
    );
    await tick(4);

    // Answers at all — this line WAS the failure, as a 500.
    const status = (await admin.changes.explain(change.id)).stageDependencyStatus;
    expect(status!.held).toBe(true);

    const target = status!.targets[0]!;
    const undeclarable = target.dependencies.find((d) => d.branch === "undeclarable")!;
    expect(undeclarable.satisfied, "a malformed entry is unsatisfiable, never satisfied").toBe(
      false
    );
    // NO NAME — and null rather than the raw entry dressed up as one. There is nothing to resolve.
    expect(undeclarable.dependsOnName).toBeNull();
    expect(undeclarable.dependsOn).toContain("42");

    // ...and the WELL-FORMED sibling beside it still resolved its name, so the fix filtered the one
    // id that could not be looked up rather than giving up on the lookup.
    const wellFormed = target.dependencies.find((d) => d.dependsOn === dependency.id)!;
    expect(wellFormed.dependsOnName).toBe(dependency.name);
  }, 60_000);

  it("the component pipeline marks the STAGE held, and names what by", async () => {
    // The bug in one sentence: a held target's `change_wave_targets.status` is and stays `pending`
    // (the hold `continue`s before `triggerWaveTarget`), and `pending` is also what a stage shows
    // when the wave has simply not reached it — so "waiting on something named" and "nothing is
    // happening here" were the same picture.
    const dependency = await componentAt("cp-dep", [gamma]);
    const dependant = await componentAt("cp-app", [gamma]);
    const change = await release("cp-held", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(3);

    const stage = (await admin.components.pipeline(dependant.id)).stages[0]!;
    // THE INPUT, asserted so the case cannot pass for the wrong reason: the raw column really is
    // still `pending`, so `hold` is carrying information nothing else on this stage does.
    expect(stage.currents[0]?.targetStatus).toBe("pending");

    expect(stage.hold, "a withheld release must not render as an idle stage").toBeTruthy();
    expect(stage.hold!.changeId).toBe(change.id);
    expect(stage.hold!.waveIndex).toBe(0);
    expect(stage.hold!.dependencies).toHaveLength(1);
    const dep = stage.hold!.dependencies[0]!;
    expect(dep.dependsOn).toBe(dependency.id);
    // THE NAME, which is the whole ask: an operator on this page must learn WHAT it is waiting on
    // without going and looking the id up.
    expect(dep.dependsOnName).toBe(dependency.name);
    expect(dep.branch).toBe("never_deployed");
    expect(dep.satisfied).toBe(false);
    expect(dep.summary).toContain("has never deployed here");
  }, 60_000);

  it("clears the stage's hold the moment the dependency lands", async () => {
    // The everyday shape: the dependency deploys, and the stage stops saying it is waiting.
    const dependency = await componentAt("cp-live-dep", [gamma]);
    const dependant = await componentAt("cp-live-app", [gamma]);

    await release("cp-live-dep-change", [dependency.id]);
    const appChange = await release(
      "cp-live-app-change",
      [dependant.id],
      [{ dependsOn: dependency.id }]
    );
    await tick(2);
    expect((await admin.components.pipeline(dependant.id)).stages[0]!.hold).toBeTruthy();

    executorConfig.forcePhase[dependency.at(gamma)] = "succeeded";
    await tick(3);

    const stale = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      latestDecisionForSubjectKind(tx, org.orgId, appChange.id, "stage_dependency")
    );
    expect(stale?.verdict, "the stale `hold` row must still be the newest of its kind").toBe(
      "hold"
    );

    expect(
      (await admin.components.pipeline(dependant.id)).stages[0]!.hold,
      "the wait is over, and the stage must stop claiming otherwise"
    ).toBeNull();
  }, 60_000);

  it("re-reads the predicate LIVE — the stage un-holds while the pinned `hold` Decision still says held, and the target is still `pending`", async () => {
    // The live-read test, and it took two attempts to be one. See docs/coordination.md §973.
    const dependency = await componentAt("cp-stale-dep", [gamma]);
    const dependant = await componentAt("cp-stale-app", [gamma]);
    const appChange = await release(
      "cp-stale-app-change",
      [dependant.id],
      [{ dependsOn: dependency.id }]
    );
    await tick(3);
    expect((await admin.components.pipeline(dependant.id)).stages[0]!.hold).toBeTruthy();

    await admin.placements.delete(dependency.at(gamma));

    // THE THREE INPUTS, all asserted, so this cannot pass because the setup stopped working.
    const stale = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      latestDecisionForSubjectKind(tx, org.orgId, appChange.id, "stage_dependency")
    );
    expect(stale?.verdict, "the stale `hold` row is still the newest of its kind").toBe("hold");
    expect(await stateOf(appChange.id), "and the change is still in flight").toBe("executing");
    const stage = (await admin.components.pipeline(dependant.id)).stages[0]!;
    expect(
      stage.currents[0]?.targetStatus,
      "and the target is still `pending`, so the candidate gate cannot be what clears this"
    ).toBe("pending");

    expect(
      stage.hold,
      "only re-running the predicate can tell that this stage is no longer waiting"
    ).toBeNull();
  }, 60_000);

  it("does NOT call a stage held when the release it belongs to was cancelled", async () => {
    // The live-state gate, and it is not an optimisation. See docs/coordination.md §974.
    const dependency = await componentAt("cp-cancel-dep", [gamma]);
    const dependant = await componentAt("cp-cancel-app", [gamma]);
    const change = await release("cp-cancelled", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(3);
    expect((await admin.components.pipeline(dependant.id)).stages[0]!.hold).toBeTruthy();

    await admin.changes.cancel(change.id, "abandoned while held");
    expect(await stateOf(change.id)).toBe("cancelled");

    const stage = (await admin.components.pipeline(dependant.id)).stages[0]!;
    // The target is STILL `pending` — it was never triggered, and that record is truthful — so the
    // raw status cannot be what distinguishes these two cases. Only the hold can.
    expect(stage.currents[0]?.targetStatus).toBe("pending");
    expect(stage.hold).toBeNull();
  }, 60_000);

  it("carries `hold: null` for an ordinary uncoupled release — not an empty claim", async () => {
    const lonely = await componentAt("cp-uncoupled", [gamma]);
    await release("cp-uncoupled-change", [lonely.id]);
    await tick(3);
    const stage = (await admin.components.pipeline(lonely.id)).stages[0]!;
    expect(stage.currents).not.toHaveLength(0);
    expect(stage.hold).toBeNull();
  }, 60_000);

  it("the watchdog's `executing` warn NAMES the coupling, instead of blaming a silent executor", async () => {
    const dependency = await componentAt("wd-dep", [gamma]);
    const dependant = await componentAt("wd-app", [gamma]);
    const change = await release("wd-held", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(3);
    expect(await stateOf(change.id)).toBe("executing");

    // 31 minutes of no progress — the `executing` SLA is 30. `opts.now` is the established
    // clock-injection seam (coupling.integration.test.ts's `waiting` watchdog case uses the same).
    // `runWatchdogSweep` manages its own per-row short transactions (§7.1 item 3) — no outer
    // `withTenantTx` wraps it any more.
    const flags = await runWatchdogSweep(
      server.deps.db,
      org.orgId,
      host,
      server.deps.config.secretsMasterKey,
      {
        requestId: "stagedep-watchdog-test",
        now: new Date(Date.now() + 31 * 60_000)
      }
    );
    const flagged = flags.find((f) => f.changeObjectId === change.id);
    expect(flagged).toBeDefined();

    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(decisions).where(eq(decisions.id, flagged!.decisionId))
    );
    const waitingOn = (row!.reasonTree as { waitingOn?: string }).waitingOn ?? "";
    // The dependency and the PLACE, by name — an operator woken by this must not have to go and look
    // anything up to know what the change is waiting for.
    expect(waitingOn).toContain(dependency.id);
    expect(waitingOn).toContain(gamma.name);
    // ...and it must no longer blame the executor, which was never handed this target at all.
    expect(waitingOn).not.toContain("executor status to report");

    const held = (row!.inputContext as { heldStageDependencies?: unknown[] }).heldStageDependencies;
    expect(Array.isArray(held)).toBe(true);
    expect(held).toHaveLength(1);

    // IDS, NOT NAMES. See docs/coordination.md §975.
    const serialised = JSON.stringify(held);
    expect(serialised, "a display name in a persisted Decision churns on a rename").not.toContain(
      dependency.name
    );
    expect(serialised).not.toContain(dependant.name);
    expect(serialised).not.toContain(gamma.name);
    // ...and the ids ARE there, so this cannot pass by the enrichment being empty.
    expect(serialised).toContain(dependency.id);
    expect(serialised).toContain(gamma.id);

    // THE PROSE HALF KEEPS THE NAME, deliberately and separately: `waitingOn` is what goes out in
    // the notification, and a human woken by it needs the place by name. Pinned so that "strip the
    // names" is never applied to the sentence as well.
    expect(waitingOn).toContain(gamma.name);
  }, 60_000);

  it("an executing change with NO coupling keeps its plain stall notice and grows no held field", async () => {
    // The boundary. The enrichment must be ABSENT for an uncoupled change, not `[]` — an empty array
    // is a claim ("we looked and there are none") on a change where the resolver never ran.
    const lonely = await componentAt("wd-plain", [gamma]);
    const change = await release("wd-plain-change", [lonely.id]);
    await tick(3);
    expect(await stateOf(change.id)).toBe("executing");

    const flags = await runWatchdogSweep(
      server.deps.db,
      org.orgId,
      host,
      server.deps.config.secretsMasterKey,
      {
        requestId: "stagedep-watchdog-plain",
        now: new Date(Date.now() + 31 * 60_000)
      }
    );
    const flagged = flags.find((f) => f.changeObjectId === change.id);
    expect(flagged).toBeDefined();

    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(decisions).where(eq(decisions.id, flagged!.decisionId))
    );
    expect(
      (row!.inputContext as { heldStageDependencies?: unknown }).heldStageDependencies
    ).toBeUndefined();
    expect((row!.reasonTree as { waitingOn?: string }).waitingOn).toContain(
      "executor status to report"
    );
  }, 60_000);
});
