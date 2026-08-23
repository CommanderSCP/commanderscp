import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { campaignWaveTargets, changes, decisions } from "../db/schema.js";
import {
  createTestComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { activeFreezesForScopes, createFreeze } from "../governance/freezes-repo.js";
import { freezesByTarget, unionFreezes } from "../governance/freeze-scope.js";
import { containmentScopeIds } from "../graph/containment.js";
import { evaluateGovernanceGate } from "../governance/gate-orchestrator.js";
import { getSharedCelSandbox } from "../governance/cel-sandbox.js";
import { getLatestPlanForChange } from "./plan-service.js";
import { evaluateFreezeHolds } from "./freeze-hold.js";
import { reconcileOrgTick } from "./reconcile.js";
import { createInMemoryFakeHost, withRefusingTrigger } from "./test-support/fake-plugin-host.js";

/**
 * M25.2 — PER-TARGET FREEZE ADMISSION, end to end against real Postgres.
 *
 * The guarantee under test: *a wave target an active freeze covers is not TRIGGERED while the
 * window is open, and its uncovered siblings ship.* "Not triggered" is asserted against the
 * EXECUTOR — the `trigger()` calls the plugin host actually received — never merely against a
 * status column, because a hold that recorded the right row while still firing the release would
 * pass a column assertion and fail the only thing that matters.
 *
 * WHAT WAS TRUE BEFORE THIS FILE. `checkFreeze` unioned every target's containment chain into one
 * scope set and got ONE verdict, so a freeze over one region parked all four; and the wave gate
 * fires exactly once on `pending -> running`, so a freeze declared mid-wave was never seen at all.
 * Both are gone. What is DELIBERATELY kept is the all-frozen whole-wave block (case E) — a totally
 * frozen wave that transitioned to `running` with nothing running, and lost the `gate`/`block`
 * Decision an operator resolves with `scp change explain`, would be a worse trade than one `if`.
 *
 * DRIVES `reconcileOrgTick` DIRECTLY, no pg-boss loop — the same choice
 * `stage-dependency-hold.integration.test.ts` makes and for the same two reasons: "N ticks" then
 * means exactly N, which is what makes the dedup row count a real assertion instead of a race; and
 * a live loop is a COMPETING CONSUMER of the very rows these tests read back (`SKIP LOCKED` makes
 * an inline call a silent no-op).
 *
 * A FRESH ORG PER CASE. `reconcileOrgTick` sweeps the WHOLE org and `advanceExecutingChanges`
 * serves `ORDER BY reconcile_cursor_at ASC LIMIT 25`, so a change an earlier case left in flight
 * competes for those slots with the change the current case is about. Every case here deliberately
 * leaves a HELD target behind — the whole point — so on a shared org "tick(3)" would degrade from
 * "three evaluations of my change" to "three sweeps in which my change may have had a turn". See
 * the stage-dependency file's measured dose-response for what that costs.
 *
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted) — recorded in the PR
 * body rather than here; the standing gate is that deleting the `continue` in `reconcile.ts`'s
 * per-target loop must turn case A red, and deleting the second terminalization line must turn
 * case C red.
 */

/** Mutable — the in-memory fake executor re-reads `ctx.config` on every call, so a case can make a
 *  specific target succeed between ticks without touching a database column by hand. */
const executorConfig: {
  autoSucceedAfterMs: number;
  forcePhase: Record<string, string>;
} = {
  // Long enough that a target which DOES get triggered sits durably in flight rather than racing
  // the assertions to completion. Cases that need a SUCCESS ask for it by `forcePhase`, which is
  // deterministic in a way an elapsed-time threshold is not.
  autoSucceedAfterMs: 10 * 60_000,
  forcePhase: {}
};

describe("freeze admission: per-target holds, whole-wave blocks, and what is exempt (M25.2)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let amer: GraphObject;
  let apac: GraphObject;
  let emea: GraphObject;
  let govcloud: GraphObject;
  let topologyId: string;
  let host: PluginHost;
  let triggered: { targetRef: string }[];

  beforeAll(async () => {
    server = await listenTestServer();
    // `() => false` refuses nothing — the wrapper is used purely for its call log, which is the
    // only way to assert that a held target's executor was never asked to do anything.
    const wrapped = withRefusingTrigger(createInMemoryFakeHost(executorConfig), () => false);
    host = wrapped.host;
    triggered = wrapped.calls;
  });

  beforeEach(async () => {
    executorConfig.forcePhase = {};
    org = await createTestOrg(server, "freezeadmit");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const place = (name: string) =>
      admin.deploymentTargets.create({ name: `${name}-${randomUUID().slice(0, 8)}` });
    amer = await place("amer");
    apac = await place("apac");
    emea = await place("emea");
    govcloud = await place("govcloud");
    const topology = await admin.object("release-topology").create({
      name: `four-regions-${randomUUID().slice(0, 8)}`,
      properties: {
        waves: [
          {
            name: "all-regions",
            mode: "parallel",
            targets: [amer.id, apac.id, emea.id, govcloud.id]
          }
        ]
      }
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

  /** A component placed at each of `places`, with its placement ids to hand — a stage-mode wave
   *  target names the PLACEMENT, which is therefore what the executor sees as `targetRef`. */
  async function componentAt(label: string, places: GraphObject[], service?: string) {
    const component = await createTestComponent(admin, {
      name: `${label}-${randomUUID().slice(0, 8)}`,
      ...(service ? { service } : {})
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

  /** A component placed at all four regions — the fixture cases A, C, E, dedup and D5 share. */
  const fourRegionComponent = (label: string) => componentAt(label, [amer, apac, emea, govcloud]);

  const release = (label: string, targets: string[]) =>
    admin.changes.propose({
      name: `${label}-${randomUUID().slice(0, 8)}`,
      targets,
      topology: topologyId
    });

  const freezeAt = (scopeObjectId: string, name: string) =>
    admin.freezes.create({
      scopeObjectId,
      name,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: `${name}: integration fixture`
    });

  /** An `atomic: true` freeze (owner decision D5, drizzle/0077). Written through the repo rather
   *  than the route DELIBERATELY: M25.2 holds no codegen slot, so `CreateFreezeRequestSchema` is
   *  untouched and `POST /api/v1/freezes` cannot set this column yet. The authoring surface is the
   *  next increment's — see this file's sibling note in the migration header. */
  const atomicFreezeAt = (scopeObjectId: string, name: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      createFreeze(tx, {
        orgId: org.orgId,
        scopeObjectId,
        name,
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 3_600_000),
        reason: `${name}: atomic integration fixture`,
        createdByActorId: org.orgId,
        atomic: true
      })
    );

  const firedFor = (placementId: string) =>
    triggered.filter((call) => call.targetRef === placementId).length;

  const planOf = (changeId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      getLatestPlanForChange(tx, org.orgId, changeId)
    );

  async function waveTarget(changeId: string, placementId: string) {
    const plan = await planOf(changeId);
    const target = plan!.waves
      .flatMap((wave) => wave.targets)
      .find((t) => t.targetObjectId === placementId);
    if (!target) throw new Error(`no wave target for placement ${placementId}`);
    return target;
  }

  const waves = async (changeId: string) => (await planOf(changeId))!.waves;

  const decisionsOfKind = (subjectId: string, kind: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(decisions)
        .where(
          and(
            eq(decisions.orgId, org.orgId),
            eq(decisions.subjectId, subjectId),
            eq(decisions.kind, kind)
          )
        )
        .orderBy(decisions.createdAt, decisions.id)
    );

  // ============================================================================================
  // A — THE ACTUATOR. Delete the `continue` in reconcile's per-target loop and this goes red.
  // ============================================================================================
  it("A: a freeze at ONE deployment-target holds that region and SHIPS the other three", async () => {
    const app = await fourRegionComponent("regions");
    const change = await release("regions", [app.id]);
    await freezeAt(amer.id, "amer-freeze");

    await tick(3);

    // THE OWNER'S ASK, asserted against the executor rather than a column: three regions were
    // handed to their executor, one was not.
    for (const place of [apac, emea, govcloud]) {
      const sibling = await waveTarget(change.id, app.at(place));
      expect(
        sibling.executorRef,
        `the placement at ${place.name} is not covered by a freeze at amer and must ship`
      ).not.toBeNull();
      expect(firedFor(app.at(place))).toBeGreaterThan(0);
    }

    const held = await waveTarget(change.id, app.at(amer));
    expect(firedFor(app.at(amer)), "the frozen region's executor was never called").toBe(0);
    // `pending` is the TRUTHFUL record — no executor was ever handed it.
    expect(held.status).toBe("pending");
    expect(held.executorRef).toBeNull();
    // INVARIANT 2, measured rather than asserted in prose: the skip happens BEFORE
    // `triggerWaveTarget`, so no advisory trigger-claim lock was taken and no attempt was spent.
    // A held target that had reached the trigger path would carry `attempt >= 1`.
    expect(held.attempt, "no trigger claim was taken for a call we are not making").toBe(0);

    // The gate ALLOWED — this is a partial freeze, so the wave is genuinely mid-flight.
    expect((await waves(change.id)).map((w) => w.status)).toEqual(["running"]);

    // ...and the hold is explained (charter principle 6).
    const holds = await decisionsOfKind(change.id, "freeze_admission");
    expect(holds).toHaveLength(1);
    expect(holds[0]!.verdict).toBe("hold");
    const context = holds[0]!.inputContext as {
      held: {
        targetObjectId: string;
        deploymentTargetObjectId: string | null;
        freezes: unknown[];
      }[];
    };
    expect(context.held).toHaveLength(1);
    expect(context.held[0]!.targetObjectId).toBe(app.at(amer));
    expect(context.held[0]!.deploymentTargetObjectId).toBe(amer.id);
  });

  // ============================================================================================
  // C — THE TERMINALIZATION. Drop `if (heldCount > 0 && !anyFailed) return;` and this goes red
  // with the wave marked `succeeded` while a target has never been deployed.
  // ============================================================================================
  it("C: the wave does NOT terminalize once the unfrozen siblings have all succeeded", async () => {
    const app = await fourRegionComponent("terminal");
    const change = await release("terminal", [app.id]);
    await freezeAt(amer.id, "amer-freeze-terminal");

    await tick(2);
    // Make exactly the three shipped regions report success on their next poll.
    for (const place of [apac, emea, govcloud]) {
      executorConfig.forcePhase[app.at(place)] = "succeeded";
    }
    await tick(3);

    for (const place of [apac, emea, govcloud]) {
      expect((await waveTarget(change.id, app.at(place))).status).toBe("succeeded");
    }
    expect((await waveTarget(change.id, app.at(amer))).status).toBe("pending");

    // THE ASSERTION. A wave whose only remaining target is frozen is NOT complete, and a change
    // that reported a clean release for a target that never ran is silent-success masking — the
    // class ADR-0006 exists to prevent.
    expect(
      (await waves(change.id)).map((w) => w.status),
      "the wave must stay open while a frozen target has never been deployed"
    ).toEqual(["running"]);

    // And the change is HELD, not PARKED: a parked change stops being served and nothing would
    // resume it when the window closes.
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, change.id)))
    );
    expect(row!.state).toBe("executing");
    expect(row!.reconcileBlockedAt).toBeNull();
  });

  // ============================================================================================
  // E — ALL-FROZEN IS STILL A WHOLE-WAVE BLOCK, deliberately kept.
  // ============================================================================================
  it("E: when EVERY target is frozen the wave is blocked at the gate, exactly as before", async () => {
    const app = await fourRegionComponent("allfrozen");
    const change = await release("allfrozen", [app.id]);
    // Component-scoped: containment route 3 puts the component on every one of its placements'
    // chains, so all four targets are covered by this single freeze.
    await freezeAt(app.id, "component-wide-freeze");

    await tick(3);

    for (const place of [amer, apac, emea, govcloud]) {
      expect(firedFor(app.at(place))).toBe(0);
    }
    const [wave] = await waves(change.id);
    expect(wave!.status, "the wave never leaves `pending` — nothing is running").toBe("pending");
    expect(wave!.startedAt, "`started_at` must stay null: the wave never started").toBeNull();

    // Today's Decision, unchanged — the surface an operator resolves with `scp change explain`.
    const gateBlocks = (await decisionsOfKind(change.id, "gate")).filter(
      (d) => d.verdict === "block"
    );
    expect(gateBlocks.length).toBeGreaterThan(0);
    expect(gateBlocks[0]!.inputContext).toMatchObject({ freeze: { scopeObjectId: app.id } });

    // And NO per-target hold Decision: nothing reached the actuator, so nothing should claim to
    // have been held there. Two records of one refusal is how an operator learns to trust neither.
    expect(await decisionsOfKind(change.id, "freeze_admission")).toHaveLength(0);
  });

  // ============================================================================================
  // D5 — `atomic: true` restores the union. The escape hatch for coupled targets.
  // ============================================================================================
  it("D5: an `atomic` freeze over ONE region still parks every sibling", async () => {
    const app = await fourRegionComponent("atomic");
    const change = await release("atomic", [app.id]);
    await atomicFreezeAt(amer.id, "amer-atomic-freeze");

    await tick(3);

    // The identical fixture as case A, one boolean apart, and the opposite outcome.
    for (const place of [amer, apac, emea, govcloud]) {
      expect(
        firedFor(app.at(place)),
        `an atomic freeze is all-or-nothing: ${place.name} must not ship either`
      ).toBe(0);
    }
    const [wave] = await waves(change.id);
    expect(wave!.status).toBe("pending");
    expect(wave!.startedAt).toBeNull();
  });

  it("D5 control: the SAME freeze without `atomic` admits the three unfrozen regions", async () => {
    // The paired direction, so the case above cannot pass vacuously against a fixture where
    // nothing would have shipped anyway.
    const app = await fourRegionComponent("nonatomic");
    const change = await release("nonatomic", [app.id]);
    await freezeAt(amer.id, "amer-nonatomic-freeze");

    await tick(3);

    expect(firedFor(app.at(amer))).toBe(0);
    for (const place of [apac, emea, govcloud]) {
      expect(firedFor(app.at(place))).toBeGreaterThan(0);
    }
    expect((await waves(change.id)).map((w) => w.status)).toEqual(["running"]);
  });

  // ============================================================================================
  // DEDUP — the anti-1.44 GB/day gate. Adding `now` to the Decision, or dropping either sort,
  // fails this.
  // ============================================================================================
  it("dedup: a standing hold writes EXACTLY ONE `freeze_admission` row across 30 further ticks", async () => {
    const app = await fourRegionComponent("dedup");
    const change = await release("dedup", [app.id]);
    await freezeAt(amer.id, "amer-dedup-freeze");

    await tick(3);
    expect(await decisionsOfKind(change.id, "freeze_admission")).toHaveLength(1);

    await tick(30);

    // Row count is O(distinct freeze configurations over the change's life), not O(ticks). A
    // three-week freeze over a held change is one row, not 1.8 million.
    expect(
      await decisionsOfKind(change.id, "freeze_admission"),
      "the hold is re-EVALUATED every tick and re-WRITTEN never — `endsAt` is in the context, `now` is not"
    ).toHaveLength(1);
    // Still held on the 33rd tick — otherwise "one row" would be true for the boring reason.
    expect(firedFor(app.at(amer))).toBe(0);
  });

  // ============================================================================================
  // SET EQUALITY — the property `checkFreeze`'s swap rests on, against real containment walks.
  // ============================================================================================
  it("set equality: unionFreezes(freezesByTarget(T)) is the same set as activeFreezesForScopes(containmentScopeIds(T))", async () => {
    // `gate-orchestrator.ts` replaced the second expression with the first, and its comment claims
    // they are equal BY CONSTRUCTION — `containmentScopeIds` IS the union of the per-target
    // `containmentChain` walks, and exact-set membership distributes over that union. "By
    // construction" is a claim about two functions that can be edited independently, so it is
    // pinned here, over a fixture whose freezes sit at THREE different rungs of the chain
    // (deployment-target, component, service) reached by three different containment routes.
    const svc = await admin.services.create({ name: `equal-svc-${randomUUID().slice(0, 8)}` });
    const app = await componentAt("equal", [amer, apac, emea, govcloud], svc.id);
    const other = await componentAt("equal-other", [amer]);
    await freezeAt(amer.id, "equal-region-freeze"); // route 4
    await freezeAt(other.id, "equal-component-freeze"); // route 3
    await freezeAt(svc.id, "equal-service-freeze"); // routes 3 then 2

    const targets = [
      ...[amer, apac, emea, govcloud].map((p) => app.at(p)),
      other.at(amer),
      // A NON-placement target too: a component-shaped (legacy) wave target must resolve
      // identically through both expressions, or the equality holds only for the shape that
      // happens to be common today.
      other.id
    ];

    const { perTarget, whole } = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const now = new Date();
      const byTarget = await freezesByTarget(tx, org.orgId, targets, now);
      const scopeIds = await containmentScopeIds(tx, org.orgId, targets);
      return {
        perTarget: unionFreezes(byTarget).map((f) => f.id),
        whole: (await activeFreezesForScopes(tx, org.orgId, scopeIds, now)).map((f) => f.id)
      };
    });

    // Non-empty first, so the equality cannot hold vacuously between two empty sets.
    expect(perTarget.length).toBe(3);
    expect(new Set(perTarget)).toEqual(new Set(whole));
  });

  // ============================================================================================
  // INERTNESS — the hottest path on the instance. Measured against a real database, by counting
  // the queries the predicate issues rather than by reading its code.
  // ============================================================================================
  it("inertness: with no active freeze in the org, evaluating holds walks ZERO containment chains", async () => {
    const app = await fourRegionComponent("inert");
    const placements = [amer, apac, emea, govcloud].map((p) => app.at(p));

    const counted = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      let executes = 0;
      // A Proxy over the REAL transaction: every read below actually runs, against the actual
      // schema and the actual index. Only `execute` — which is how `containmentChain` issues its
      // recursive CTE, and the only thing in this path that uses it — is counted.
      const counting = new Proxy(tx as object, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop !== "execute") return typeof value === "function" ? value.bind(target) : value;
          return (...args: unknown[]) => {
            executes++;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
      }) as TenantTx;

      const holds = await evaluateFreezeHolds(counting, {
        orgId: org.orgId,
        targetObjectIds: placements
      });
      return { executes, size: holds.size };
    });

    expect(counted.size, "nothing is frozen, so nothing is held").toBe(0);
    expect(
      counted.executes,
      "one indexed window read answers the whole org; a containment walk per target on the 1s tick is the cost this property exists to refuse"
    ).toBe(0);

    // THE CONTROL, so the assertion above cannot pass against a function that never walks at all.
    await freezeAt(amer.id, "amer-inertness-control");
    const withFreeze = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      let executes = 0;
      const counting = new Proxy(tx as object, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop !== "execute") return typeof value === "function" ? value.bind(target) : value;
          return (...args: unknown[]) => {
            executes++;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
      }) as TenantTx;
      const holds = await evaluateFreezeHolds(counting, {
        orgId: org.orgId,
        targetObjectIds: placements
      });
      return { executes, size: holds.size };
    });
    expect(withFreeze.size).toBe(1);
    expect(withFreeze.executes).toBeGreaterThanOrEqual(placements.length);
  });

  // ============================================================================================
  // D7 — ROLLBACKS ARE EXEMPT, in BOTH directions. A change that newly PERMITS.
  // ============================================================================================
  it("D7: a rollback triggers into an active freeze, and the same wave non-rollback is held", async () => {
    const app = await componentAt("rollback", [amer]);
    // A topology naming ONLY amer, so the rollback's wave has exactly one target and every target
    // of it is frozen — the ALL-frozen shape, which is where D7 actually bites. A partial freeze
    // would have been admitted by the ordinary per-target path and proved nothing about rollbacks.
    const soloTopology = await admin.object("release-topology").create({
      name: `amer-only-${randomUUID().slice(0, 8)}`,
      properties: { waves: [{ name: "amer", mode: "parallel", targets: [amer.id] }] }
    });
    const original = await admin.changes.propose({
      name: `rollback-original-${randomUUID().slice(0, 8)}`,
      targets: [app.id],
      topology: soloTopology.id
    });

    // Drive the original to `validating` and accept it — that edge is deliberately human-only
    // (DESIGN §9.1's chain stops there for `scp change accept`), so the loop cannot finish it.
    // All of this happens BEFORE the freeze exists, so nothing here is under test.
    executorConfig.forcePhase[app.at(amer)] = "succeeded";
    const originalState = async () => {
      const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx
          .select()
          .from(changes)
          .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, original.id)))
      );
      return row!.state;
    };
    await tick(8);
    expect(await originalState()).toBe("validating");
    await admin.changes.accept(original.id);
    expect(await originalState()).toBe("accepted");

    // NOW the freeze — declared after the original shipped, exactly as an incident freeze is.
    await freezeAt(amer.id, "amer-freeze-vs-rollback");

    const firedBefore = firedFor(app.at(amer));
    const rollback = await admin.changes.rollback(original.id, "integration: the release is bad");
    await tick(8);

    // DIRECTION ONE — the rollback got through. Holding it would pin the broken release in place
    // for the whole window, with `scp change rollback` documented as the exit and the exit closed.
    const rollbackTarget = await waveTarget(rollback.id, app.at(amer));
    expect(
      rollbackTarget.executorRef,
      "a rollback is exempt from freezes at the wave boundary (D7) — the gate must not block it and the per-target hold must not withhold it"
    ).not.toBeNull();
    expect(firedFor(app.at(amer))).toBeGreaterThan(firedBefore);
    expect(await decisionsOfKind(rollback.id, "freeze_admission")).toHaveLength(0);

    // DIRECTION TWO — the exemption is about ROLLBACKS, not about this freeze being toothless. An
    // ordinary change over the very same placement, under the very same freeze, is refused.
    const ordinary = await admin.changes.propose({
      name: `rollback-control-${randomUUID().slice(0, 8)}`,
      targets: [app.id],
      topology: soloTopology.id
    });
    const firedBeforeOrdinary = firedFor(app.at(amer));
    await tick(4);
    expect(
      firedFor(app.at(amer)),
      "the same freeze must still stop a non-rollback change at the same place"
    ).toBe(firedBeforeOrdinary);
    const [ordinaryWave] = await waves(ordinary.id);
    expect(ordinaryWave!.status).toBe("pending");
    expect(ordinaryWave!.startedAt).toBeNull();
  });

  // ============================================================================================
  // H — CRITICAL #2 PRESERVED. Replace `unionFreezes(byTarget)` with `byTarget[0].freezes` and the
  // first assertion goes red: the freeze covers only the SECOND target.
  // ============================================================================================
  it("H: every active freeze must be overridden AT ITS OWN SCOPE, even one covering only target 2", async () => {
    // Services created explicitly so the freeze's scope is a known id rather than one read back
    // out of the graph — the point of this case is WHICH scope was frozen.
    const svc = async (label: string) =>
      admin.services.create({ name: `${label}-${randomUUID().slice(0, 8)}` });
    const firstService = (await svc("crit2-first-svc")).id;
    const secondService = (await svc("crit2-second-svc")).id;
    const first = await componentAt("crit2-first", [amer], firstService);
    const second = await componentAt("crit2-second", [amer], secondService);
    // Declared at the SECOND component's service, so it reaches target 2's placement through
    // containment routes 3 then 2, and reaches target 1 not at all.
    const frozen = await freezeAt(secondService, "second-service-freeze");

    const change = await admin.changes.propose({
      name: `crit2-${randomUUID().slice(0, 8)}`,
      targets: [first.id, second.id]
    });
    const targets = [first.at(amer), second.at(amer)];

    /** The LIFECYCLE edge deliberately: `lifecycle_edge` keeps any-target-frozen => block (there is
     *  no such thing as accepting three quarters of a change), which is the only path on which the
     *  override loop is reachable — `EvaluateWaveGateContext` carries no `overrideFreeze` field. */
    const gate = (actorObjectId: string, overrideFreeze?: { reason: string }) =>
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        evaluateGovernanceGate(tx, getSharedCelSandbox(), null, {
          orgId: org.orgId,
          changeObjectId: change.id,
          targetObjectIds: targets,
          actorObjectId,
          emergency: false,
          gateKind: "lifecycle_edge",
          gateRef: { fromState: "validating", toState: "accepted" },
          overrideFreeze
        })
      );

    // (a) THE FREEZE IS FOUND AT ALL. It covers target 2 and not target 1, so a resolver that
    // consulted only the first target's chain would report nothing frozen and allow.
    const noOverride = await gate(org.orgId);
    expect(noOverride.verdict).toBe("block");
    expect(noOverride.inputContext.freeze).toMatchObject({
      id: frozen.id,
      scopeObjectId: secondService
    });

    // (b) AUTHORITY AT THE WRONG SCOPE IS NOT AUTHORITY. `freeze:override` at the FIRST service
    // says nothing about a freeze declared at the second — that is exactly the escalation checking
    // only `active[0]` used to permit.
    const wrongScope = await createTestUser(server, org, [{ role: "Owner", scope: firstService }]);
    const rejected = await gate(wrongScope.objectId, { reason: "let me through" });
    expect(rejected.verdict).toBe("block");
    expect(rejected.inputContext.overrideRejected).toEqual(expect.stringContaining(secondService));

    // (c) AUTHORITY AT THE FREEZE'S OWN SCOPE IS. Same actor shape, same reason, one scope apart.
    const rightScope = await createTestUser(server, org, [{ role: "Owner", scope: secondService }]);
    const allowed = await gate(rightScope.objectId, { reason: "incident bridge approved" });
    expect(
      allowed.verdict,
      "an override held at THAT freeze's own scope, with a reason, is what CRITICAL #2 requires and permits"
    ).toBe("allow");
    expect(allowed.freezeOverrides).toEqual([
      { freezeId: frozen.id, reason: "incident bridge approved", scopeObjectId: secondService }
    ]);
  });

  // ============================================================================================
  // F — THE SECOND ACTUATOR: campaign fan-out.
  // ============================================================================================
  it("F: a component-scoped freeze holds that campaign target's fan-out and mints the sibling's change", async () => {
    const held = await createTestComponent(admin, {
      name: `camp-held-${randomUUID().slice(0, 8)}`
    });
    const free = await createTestComponent(admin, {
      name: `camp-free-${randomUUID().slice(0, 8)}`
    });
    await freezeAt(held.id, "campaign-component-freeze");

    const campaign = await admin.campaigns.propose({
      name: `campaign-${randomUUID().slice(0, 8)}`,
      targets: [held.id, free.id]
    });

    await tick(3);

    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.select().from(campaignWaveTargets).where(eq(campaignWaveTargets.orgId, org.orgId))
    );
    const heldRow = rows.find((r) => r.targetObjectId === held.id)!;
    const freeRow = rows.find((r) => r.targetObjectId === free.id)!;

    // EXACTLY ONE member Change was minted, and it is the unfrozen target's.
    expect(freeRow.memberChangeObjectId).not.toBeNull();
    expect(freeRow.status).toBe("change_proposed");
    expect(
      heldRow.memberChangeObjectId,
      "a frozen campaign target must not mint a Change that would only be held one layer down while tripping the watchdog's stall SLA for the length of the window"
    ).toBeNull();
    expect(heldRow.status).toBe("pending");

    const minted = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM changes WHERE org_id = ${org.orgId}`
      )
    );
    expect(Number(minted.rows[0]!.count)).toBe(1);

    // Explained on the CAMPAIGN, one row for the campaign rather than one per target.
    const campaignHolds = await decisionsOfKind(campaign.id, "freeze_admission");
    expect(campaignHolds).toHaveLength(1);
    expect(campaignHolds[0]!.verdict).toBe("hold");
    expect(
      (campaignHolds[0]!.inputContext as { held: { targetObjectId: string }[] }).held.map(
        (h) => h.targetObjectId
      )
    ).toEqual([held.id]);
  });
});
