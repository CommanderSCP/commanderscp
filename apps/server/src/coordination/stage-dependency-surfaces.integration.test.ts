import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { reconcileOrgTick } from "./reconcile.js";
import { runWatchdogSweep } from "./watchdog.js";
import { latestDecisionForSubjectKind } from "./decisions-repo.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";

/**
 * ADR-0028 increment 4 — THE OPERATOR SURFACES, end to end against real Postgres.
 *
 * Increment 3 made the hold correct; nothing made it FINDABLE. A held target rendered as plain
 * `pending`, the watchdog's stall notice said "waiting for executor status" about a target no
 * executor had ever been handed, and the only account of the hold was one undifferentiated row in
 * `explain`'s `decisions[]`. These pin the two server-side surfaces that fix that.
 *
 * THE CENTRAL PROPERTY, and the one every case here is arranged around: the surfaces read the
 * PREDICATE LIVE, never the persisted Decision. `recordStageDependencyHold` writes a `hold` row and
 * nothing anywhere writes a clearing one, so the newest `stage_dependency` row of a change that was
 * held and then released is STILL a `hold` — forever. A surface built on that row would look correct
 * in every "is it held?" test and be wrong in exactly the case an operator cares about, the one where
 * the wait is over. `after the hold releases` below is that test, and it asserts the stale Decision
 * is still sitting there so it cannot pass vacuously.
 *
 * Fixture conventions are `stage-dependency-hold.integration.test.ts`'s, for the reasons its module
 * doc gives at length: `reconcileOrgTick` driven directly (so "N ticks" means exactly N), a FRESH ORG
 * per case (so a `BATCH_LIMIT` queue left by an earlier case cannot starve this one), and the
 * dependency's state moved only through the real poll path.
 */

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

  // -----------------------------------------------------------------------------------------
  // SURFACE 1 — `GET /changes/{id}/explain`
  // -----------------------------------------------------------------------------------------

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

    // The dependency finishes through the real poll path.
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

  it("is NULL for a change that coupled nothing — the field is absent, not an empty claim", async () => {
    const lonely = await componentAt("uncoupled", [gamma]);
    const change = await release("uncoupled-change", [lonely.id]);
    await tick(2);
    expect((await admin.changes.explain(change.id)).stageDependencyStatus).toBeNull();
  }, 60_000);

  // -----------------------------------------------------------------------------------------
  // SURFACE 4 — the watchdog's `executing` arm
  // -----------------------------------------------------------------------------------------

  it("the watchdog's `executing` warn NAMES the coupling, instead of blaming a silent executor", async () => {
    const dependency = await componentAt("wd-dep", [gamma]);
    const dependant = await componentAt("wd-app", [gamma]);
    const change = await release("wd-held", [dependant.id], [{ dependsOn: dependency.id }]);
    await tick(3);
    expect(await stateOf(change.id)).toBe("executing");

    // 31 minutes of no progress — the `executing` SLA is 30. `opts.now` is the established
    // clock-injection seam (coupling.integration.test.ts's `waiting` watchdog case uses the same).
    const flags = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      runWatchdogSweep(tx, org.orgId, host, server.deps.config.secretsMasterKey, {
        requestId: "stagedep-watchdog-test",
        now: new Date(Date.now() + 31 * 60_000)
      })
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

    // The structured half, for `scp decision get`.
    const held = (row!.inputContext as { heldStageDependencies?: unknown[] }).heldStageDependencies;
    expect(Array.isArray(held)).toBe(true);
    expect(held).toHaveLength(1);
  }, 60_000);

  it("an executing change with NO coupling keeps its plain stall notice and grows no held field", async () => {
    // The boundary. The enrichment must be ABSENT for an uncoupled change, not `[]` — an empty array
    // is a claim ("we looked and there are none") on a change where the resolver never ran.
    const lonely = await componentAt("wd-plain", [gamma]);
    const change = await release("wd-plain-change", [lonely.id]);
    await tick(3);
    expect(await stateOf(change.id)).toBe("executing");

    const flags = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      runWatchdogSweep(tx, org.orgId, host, server.deps.config.secretsMasterKey, {
        requestId: "stagedep-watchdog-plain",
        now: new Date(Date.now() + 31 * 60_000)
      })
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
