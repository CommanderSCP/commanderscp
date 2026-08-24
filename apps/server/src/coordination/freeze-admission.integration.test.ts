import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import type { Db } from "../db/client.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import {
  auditEvents,
  campaignWaveTargets,
  changes,
  changeWaveTargets,
  decisions,
  freezes,
  roleBindings,
  roles
} from "../db/schema.js";
import {
  createTestComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import type { PluginHost } from "../plugin-host/contract.js";
import {
  activeFreezesForScopes,
  createFreeze,
  updateFreezeWindow
} from "../governance/freezes-repo.js";
import { freezesByTarget, unionFreezes } from "../governance/freeze-scope.js";
import { containmentScopeIds } from "../graph/containment.js";
import { evaluateGovernanceGate } from "../governance/gate-orchestrator.js";
import { evaluateWaveGate } from "./gates.js";

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
const OPERATOR_TOKEN = "m25-3-freeze-admission-operator-token";

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

/**
 * Resolves once some backend in this database is waiting on a lock — the positive signal that
 * replaces a fixed sleep in the overlapping-edit case below. Polls fast (25ms) because the state it
 * is waiting for is local and near-instant; the generous deadline exists only so a pathologically
 * loaded CI box fails with THIS message rather than an inscrutable assertion 20 lines later.
 */
async function waitForBlockedBackend(db: Db, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await db.execute(
      sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' limit 1`
    );
    if (rows.rows.length > 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        "no backend ever blocked on a lock — the overlapping-edit case raced nothing, so its verdict is meaningless"
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

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

  /** Targets whose executor REFUSES the trigger. Empty for every case that only needs the call log
   *  (which is the only way to assert a held target's executor was never asked to do anything); a
   *  case that needs a wave still holding `pending`/`triggering` targets AFTER the gate has run —
   *  the only window in which a freeze can be declared MID-WAVE — puts them in here. */
  const refuseTargets = new Set<string>();

  beforeAll(async () => {
    const wrapped = withRefusingTrigger(createInMemoryFakeHost(executorConfig), (ref) =>
      refuseTargets.has(ref)
    );
    // The operator token is configured so the PLATFORM-tier D7 case below can author its freeze
    // through the SHIPPED operator door rather than by poking `instance_freezes` directly — a
    // fixture that wrote the row by hand would leave the door untested while the case looked healthy.
    server = await listenTestServer({ operatorToken: OPERATOR_TOKEN });
    host = wrapped.host;
    triggered = wrapped.calls;
  });

  beforeEach(async () => {
    executorConfig.forcePhase = {};
    refuseTargets.clear();
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

  /** An `atomic: true` freeze (owner decision D5, drizzle/0084). Written through the repo rather
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

  /** Push every wave target's `updated_at` an hour into the past so reconcile's BACKOFF GATE (which
   *  precedes the freeze seam, deliberately — invariant 5) lets a refused `triggering` target be
   *  retried on the next tick. Deterministic where a real `sleep(2s)` is merely probable. */
  const expireBackoff = () =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(changeWaveTargets)
        .set({ updatedAt: new Date(Date.now() - 3_600_000) })
        .where(eq(changeWaveTargets.orgId, org.orgId))
    );

  /** Close a freeze's window by moving `endsAt` into the past — expiry IS the window predicate and
   *  nothing else (`freezes-repo.ts`), so this is exactly what the passage of time does.
   *
   *  M25.1 MOVED THIS ONTO THE REAL API. It was a raw `UPDATE freezes` because `PATCH
   *  /api/v1/freezes/{id}` had not shipped, with a note naming this as the call site to move onto
   *  it; that has now happened, so the release case below exercises a shipped route rather than a
   *  hand-poked column, and "shortening `endsAt` to a past instant releases a held target" is
   *  covered by the case that was already here. */
  const shortenFreezeToPast = (freezeId: string) =>
    admin.freezes.updateWindow(freezeId, {
      endsAt: new Date(Date.now() - 1_000).toISOString(),
      reason: "integration: the incident is over"
    });

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
  // D7, READ SIDE — the read-time projection (`GET /changes/{id}/explain`) has to agree with the
  // actuator above, or an operator sees a rollback dispatched WHILE `explain` still reports its
  // target held by the very freeze it was exempted from (M25.UI review finding 3).
  // ============================================================================================
  it("D7 read-side: explain does not report the rollback target held by the freeze it was exempted from", async () => {
    const app = await componentAt("rollback-explain", [amer]);
    const soloTopology = await admin.object("release-topology").create({
      name: `amer-only-explain-${randomUUID().slice(0, 8)}`,
      properties: { waves: [{ name: "amer", mode: "parallel", targets: [amer.id] }] }
    });
    const original = await admin.changes.propose({
      name: `rollback-explain-original-${randomUUID().slice(0, 8)}`,
      targets: [app.id],
      topology: soloTopology.id
    });

    // Drive the original to `accepted` — before the freeze exists, exactly as the actuator test
    // above does. `executorConfig.autoSucceedAfterMs` is 10 minutes (this file's `beforeAll`), so
    // the target that gets triggered below stays `triggering` for the whole assertion window
    // instead of racing past it to `succeeded` — the pending/triggering state `explain`'s
    // projection is scoped to.
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
    executorConfig.forcePhase = {};

    // NOW the freeze — an ORG-tier freeze, exactly the tier D7 stands aside for.
    await freezeAt(amer.id, "amer-freeze-vs-rollback-explain");

    // THE EXECUTOR REFUSES the rollback's own trigger attempt (the measured `argocd trigger: sync
    // returned HTTP 400` contention shape `triggerBackoffMs`'s own doc names) — the actuator's
    // `continue` still does not fire (D7 exempts it), so `triggerWaveTarget` genuinely CALLS the
    // executor every tick, and every call is refused. That is exactly the shape finding 3 names:
    // the target sits in `triggering` BACKOFF — never advancing to `triggered`, never falling back
    // to `pending` — for the whole of the assertion window, which is what makes the read-path's
    // `pending`/`triggering` gate actually include it rather than racing past it to a terminal
    // status before `explain` is ever called.
    refuseTargets.add(app.at(amer));
    const rollback = await admin.changes.rollback(original.id, "integration: the release is bad");
    await tick(8);

    // THE ACTUATOR DID ITS PART — the freeze `continue` did not fire (D7), so a REAL trigger
    // attempt reached the executor and was refused. `attempt > 0` is `originalChangeDispatchedTarget`'s
    // own definition of "dispatched" (wave-targets-repo.ts) — a failure here means the fixture
    // drifted rather than that D7 itself broke.
    const rollbackTarget = await waveTarget(rollback.id, app.at(amer));
    expect(rollbackTarget.status, "fixture check: refused every attempt, never advances").toBe(
      "triggering"
    );
    expect(
      rollbackTarget.attempt,
      "fixture check: a real trigger attempt reached the executor"
    ).toBeGreaterThan(0);

    // THE READ SIDE, over the wire. `explain` must not describe this target as held by a freeze
    // reconcile has already let the trigger past — that is the gap between the actuator (above)
    // and the projection (`resolveWaveTargetFreezeHolds`) this test pins shut.
    const explained = await admin.changes.explain(rollback.id);
    const wave = explained.plan!.waves[0]!;
    const target = wave.targets.find((t) => t.targetObjectId === app.at(amer))!;
    expect(
      target.hold,
      "the rollback target was exempted from this freeze (D7) — explain must not say otherwise"
    ).toBeUndefined();
    expect(wave.heldTargetCount ?? 0).toBe(0);
  });

  // ============================================================================================
  // D7 AT THE TIER BOUNDARY (M25.3) — the exemption stops above org, measured at the EXECUTOR.
  // ============================================================================================
  it("D7 does not carry above org: a rollback is NOT triggered into an active PLATFORM freeze, and ships the moment it is lifted", async () => {
    const app = await componentAt("platform-rollback", [amer]);
    const soloTopology = await admin.object("release-topology").create({
      name: `amer-only-platform-${randomUUID().slice(0, 8)}`,
      properties: { waves: [{ name: "amer", mode: "parallel", targets: [amer.id] }] }
    });
    const original = await admin.changes.propose({
      name: `platform-rollback-original-${randomUUID().slice(0, 8)}`,
      targets: [app.id],
      topology: soloTopology.id
    });

    // Drive the original to `accepted` and let it ship — all of it BEFORE any freeze exists.
    executorConfig.forcePhase[app.at(amer)] = "succeeded";
    await tick(8);
    await admin.changes.accept(original.id);

    // DEPLOYMENT-WIDE, because the deployment-targets in this file declare no
    // `properties.environment` — `allEnvironments` is the form that reaches a target with no stage
    // coordinate (`instanceFreezeCovers`). This table has no `org_id`, so the row is live for every
    // later case in this file until it is lifted; it is lifted below, on both paths.
    const key = `platform-vs-rollback-${randomUUID().slice(0, 8)}`;
    await admin.instanceFreezes.put(
      key,
      {
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        reason: "integration: the deployment operator froze the instance",
        match: { allEnvironments: true }
      },
      OPERATOR_TOKEN
    );
    // AN ORG FREEZE OVER THE SAME PLACEMENT, DECLARED NOW AND NEVER LIFTED. It is what makes the
    // release arm at the bottom a CONTROL rather than a tautology: when the platform freeze goes,
    // the target is still covered by a freeze — an ORG one, which D7 does stand aside. Same
    // rollback, same target, same tick loop; the only variable is the tier.
    await freezeAt(amer.id, "amer-org-freeze-beside-the-platform-one");

    let firedBefore = firedFor(app.at(amer));
    const rollback = await admin.changes.rollback(original.id, "integration: the release is bad");
    try {
      await tick(8);

      // THE ASSERTION IS AGAINST THE EXECUTOR, not a status column: the defect this pins DID write
      // right-looking rows and then handed the target to its executor anyway. Before the fix
      // `firedFor` went UP by one here — `POST /v1/changes/{id}/rollback` needs only `object:write`
      // at the org, so this was a cheaper route past the platform freeze than the `freeze:override`
      // the block sentence contrasts it with, and needed no reason and no operator token.
      expect(
        firedFor(app.at(amer)),
        "a platform freeze is never stood aside for a rollback — the operator's remedy is PUT/DELETE /v1/instance/freezes/{key}"
      ).toBe(firedBefore);
      expect((await waveTarget(rollback.id, app.at(amer))).executorRef).toBeNull();
      const [rollbackWave] = await waves(rollback.id);
      expect(rollbackWave!.status, "the wave never started").toBe("pending");

      // AND THE REFUSAL IS EXPLAINED, not silent (charter principle 6). This wave's only target is
      // covered, so it is the ALL-frozen shape and the WAVE GATE owns the refusal — a `gate` block
      // Decision naming the tier, which is what `scp change explain` resolves. (A wave with an
      // admissible sibling would instead be held per-target and recorded as `freeze_admission`;
      // both projections carry `tier`, which is the point of resolving both tiers in one place.)
      const gated = await decisionsOfKind(rollback.id, "gate");
      expect(gated.length).toBeGreaterThan(0);
      expect(JSON.stringify(gated.map((d) => d.inputContext))).toContain('"tier":"platform"');
    } finally {
      await admin.instanceFreezes.lift(key, { reason: "cleanup" }, OPERATOR_TOKEN);
    }

    // THE RELEASE ARM. The platform freeze is gone; the ORG freeze over this very placement is
    // still standing. The same rollback now ships — so the refusal above was the TIER and not the
    // rollback, and D7 is BOUNDED rather than deleted.
    firedBefore = firedFor(app.at(amer));
    await tick(8);
    expect(
      firedFor(app.at(amer)),
      "D7 is unchanged at the org tier — holding a rollback there pins a broken release for the window"
    ).toBeGreaterThan(firedBefore);
    expect((await waveTarget(rollback.id, app.at(amer))).executorRef).not.toBeNull();
  });

  // ============================================================================================
  // D7 AT THE TIER BOUNDARY, PER-TARGET (M25.3) — the seam the case above cannot reach.
  // ============================================================================================
  // The all-frozen case above is refused by the WAVE GATE, which returns before the per-target loop
  // runs at all. So it pins `gate-orchestrator.ts`'s conjunct and NOT `reconcile.ts`'s, and a fix
  // applied to only one of the two seams would leave it green. This case makes the gate stand aside
  // (D5 partial admission) so the per-target `continue` is the only thing left holding anything —
  // revert `rollbackExemptible(frozen.freezes)` in `reconcile.ts` alone and this is the case that
  // goes red.
  it("D7 per-target: a partially-covering PLATFORM freeze withholds its target from a rollback while the sibling ships", async () => {
    const env = `d7pt-env-${randomUUID().slice(0, 8)}`;
    const stage = (properties: Record<string, unknown>) =>
      admin.deploymentTargets.create({
        name: `d7pt-${randomUUID().slice(0, 8)}`,
        properties
      });
    // Two stages that DECLARE where they run (M15.6 / ADR-0017 §3) — the addressing a platform
    // freeze uses. Only the first is in `env`, which is what makes the coverage partial.
    //
    // `region` IS DELIBERATELY OMITTED. Declaring BOTH halves makes a deployment-target a REGION
    // target, and M15.6's no-silent-deploy gate then fail-closed refuses every trigger at it until
    // it has its own Argo CD binding — so nothing would ever fire here and the case would "pass"
    // its withheld-target assertion for entirely the wrong reason. An `environment`-only stage is
    // both a real shape and the one an `environment`-addressed freeze is chiefly about.
    const covered = await stage({ environment: env });
    const uncovered = await stage({ environment: `d7pt-other-${randomUUID().slice(0, 8)}` });

    const app = await componentAt("d7-partial", [covered, uncovered]);
    const pairTopology = await admin.object("release-topology").create({
      name: `d7pt-pair-${randomUUID().slice(0, 8)}`,
      properties: {
        waves: [{ name: "both", mode: "parallel", targets: [covered.id, uncovered.id] }]
      }
    });
    const original = await admin.changes.propose({
      name: `d7pt-original-${randomUUID().slice(0, 8)}`,
      targets: [app.id],
      topology: pairTopology.id
    });

    // BOTH targets must actually have been dispatched by the original, or D7's own qualifier
    // (`rollbackHasSomethingToUndoAt`) would withhold them for a different reason and this case
    // would pass without measuring the tier at all.
    executorConfig.forcePhase[app.at(covered)] = "succeeded";
    executorConfig.forcePhase[app.at(uncovered)] = "succeeded";
    await tick(12);
    // NO EXPLICIT `accept` HERE, unlike the case above: with two targets this org's change reaches
    // `executing` on its own, and `executing` is one of the three states `triggerRollback` accepts.
    // What the rollback actually needs is asserted directly instead of inferred from a state name —
    // both targets were DISPATCHED, so D7's own qualifier (`rollbackHasSomethingToUndoAt`) is
    // satisfied at both and cannot be what withholds one of them below.
    expect(firedFor(app.at(covered))).toBeGreaterThan(0);
    expect(firedFor(app.at(uncovered))).toBeGreaterThan(0);

    const key = `d7pt-platform-${randomUUID().slice(0, 8)}`;
    await admin.instanceFreezes.put(
      key,
      {
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        reason: "integration: one environment frozen at the platform tier",
        match: { environment: env }
      },
      OPERATOR_TOKEN
    );
    try {
      const coveredBefore = firedFor(app.at(covered));
      const uncoveredBefore = firedFor(app.at(uncovered));
      const rollback = await admin.changes.rollback(original.id, "integration: undo it");
      await tick(8);

      // THE SIBLING SHIPS — so the gate really did stand aside (D5), and the per-target loop really
      // did run. Without this the assertion below would pass against a whole-wave block.
      expect(
        firedFor(app.at(uncovered)),
        "nothing covers this stage: partial admission is not tier-specific"
      ).toBeGreaterThan(uncoveredBefore);
      // AND THE COVERED ONE IS WITHHELD BY THE PER-TARGET SEAM, the only thing left that could.
      expect(
        firedFor(app.at(covered)),
        "the per-target `continue` is tier-aware too: a rollback does not walk past a platform freeze here either"
      ).toBe(coveredBefore);

      const held = await decisionsOfKind(rollback.id, "freeze_admission");
      expect(held.length).toBeGreaterThan(0);
      expect(JSON.stringify(held.map((d) => d.inputContext))).toContain('"tier":"platform"');
    } finally {
      await admin.instanceFreezes.lift(key, { reason: "cleanup" }, OPERATOR_TOKEN);
    }
  });

  // ============================================================================================
  // H — CRITICAL #2 PRESERVED. Replace `unionFreezes(byTarget)` with `byTarget[0].freezes` and the
  // first assertion goes red: the freeze covers only the SECOND target.
  // ============================================================================================
  it("H: EVERY active freeze must be overridden at its OWN scope — a universal quantifier, tested with two", async () => {
    // Services created explicitly so the freeze's scope is a known id rather than one read back
    // out of the graph — the point of this case is WHICH scope was frozen.
    const svc = async (label: string) =>
      admin.services.create({ name: `${label}-${randomUUID().slice(0, 8)}` });
    const firstService = (await svc("crit2-first-svc")).id;
    const secondService = (await svc("crit2-second-svc")).id;
    const first = await componentAt("crit2-first", [amer], firstService);
    const second = await componentAt("crit2-second", [amer], secondService);
    // Declared at the SECOND component's service, so it reaches target 2's placement through
    // containment routes 3 then 2, and reaches target 1 not at all. This one alone pins per-target
    // RESOLUTION (replace `unionFreezes(byTarget)` with `byTarget[0].freezes` and arm (a) goes red).
    const frozen = await freezeAt(secondService, "second-service-freeze");
    // TWO freezes, deliberately, and this is the half the case is named after. With one freeze the
    // universal and the existential quantifier coincide, so flipping `checkFreeze`'s `every` to
    // `some` left this case green and only the accept-edge test in `governance.integration.test.ts`
    // noticed. Checking only `active[0]` was a shipped bug; the quantifier is what stops it, and a
    // quantifier tested against a one-element set is not tested.
    const alsoFrozen = await freezeAt(firstService, "first-service-freeze");

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
    expect([frozen.id, alsoFrozen.id], "the block names one of the two active freezes").toContain(
      (noOverride.inputContext.freeze as { id: string }).id
    );

    // (b) AUTHORITY AT THE WRONG SCOPE IS NOT AUTHORITY. `freeze:override` at the FIRST service
    // says nothing about a freeze declared at the second — that is exactly the escalation checking
    // only `active[0]` used to permit.
    const wrongScope = await createTestUser(server, org, [{ role: "Owner", scope: firstService }]);
    const rejected = await gate(wrongScope.objectId, { reason: "let me through" });
    expect(rejected.verdict).toBe("block");
    expect(rejected.inputContext.overrideRejected).toEqual(expect.stringContaining(secondService));

    // (c) THE QUANTIFIER. Authority at the SECOND service overrides the freeze declared there and
    // says nothing about the one at the first — so the change is STILL blocked. Flip `every` to
    // `some` in `checkFreeze`'s loop and this arm goes green: one overridden freeze would be enough
    // and the actor would ship past a freeze they hold no authority over. THIS is the arm the case
    // is named after, and it needs two freezes to exist at all.
    const secondOnly = await createTestUser(server, org, [{ role: "Owner", scope: secondService }]);
    const stillBlocked = await gate(secondOnly.objectId, { reason: "incident bridge approved" });
    expect(
      stillBlocked.verdict,
      "EVERY active freeze must be individually overridden — overriding one of two is not authority over the other"
    ).toBe("block");
    expect(stillBlocked.inputContext.overrideRejected).toEqual(
      expect.stringContaining(firstService)
    );

    // (d) AUTHORITY AT BOTH SCOPES IS. Same actor shape, same reason, one role apart.
    const bothScopes = await createTestUser(server, org, [
      { role: "Owner", scope: firstService },
      { role: "Owner", scope: secondService }
    ]);
    const allowed = await gate(bothScopes.objectId, { reason: "incident bridge approved" });
    expect(
      allowed.verdict,
      "an override held at EVERY active freeze's own scope, with a reason, is what CRITICAL #2 requires and permits"
    ).toBe("allow");
    expect(
      [...(allowed.freezeOverrides ?? [])].map((o) => o.freezeId).sort(),
      "one audited override per freeze, not one for the set"
    ).toEqual([frozen.id, alsoFrozen.id].sort());
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
    // §1.8's third honesty defect, and the only one M25.2 itself CAUSES: a partially frozen
    // campaign wave used to go `blocked` (the gate's whole-wave block verdict). It is now `running`
    // so its unfrozen siblings can proceed, and without a freeze-aware status a 40-component
    // campaign with one held target would read as ordinarily `active` for the length of the window.
    expect(
      (await admin.campaigns.get(campaign.id)).status,
      "the lever works; the signal must not go missing with it"
    ).toBe("blocked");

    const campaignHolds = await decisionsOfKind(campaign.id, "freeze_admission");
    expect(campaignHolds).toHaveLength(1);
    expect(campaignHolds[0]!.verdict).toBe("hold");
    expect(
      (campaignHolds[0]!.inputContext as { held: { targetObjectId: string }[] }).held.map(
        (h) => h.targetObjectId
      )
    ).toEqual([held.id]);
  });

  // ============================================================================================
  // D5 AUTHORING DOOR — the escape hatch has to be REACHABLE, in the same increment as the
  // loosening it mitigates.
  // ============================================================================================
  it("D5 door: `atomic` is settable through POST /api/v1/freezes and readable back", async () => {
    // Owner decision D5 makes per-target admission the DEFAULT and applies it RETROACTIVELY to
    // every freeze already authored. `atomic: true` is the mitigation the decision was taken on the
    // strength of; if the only writer is the repo, an operator who needs all-or-nothing has no API,
    // CLI or IaC expression for it and the loosening ships with its mitigation missing. That is the
    // "component built, never installed" shape, so the door gets a test that exercises the door.
    const app = await fourRegionComponent("door");
    const change = await release("door", [app.id]);
    const created = await admin.freezes.create({
      scopeObjectId: amer.id,
      name: "amer-atomic-via-api",
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: "door: authored the way an operator authors one",
      atomic: true
    });
    expect(created.atomic, "the 201 body must report what was stored").toBe(true);
    expect((await admin.freezes.get(created.id)).atomic).toBe(true);
    expect(
      (await admin.freezes.list()).items.find((f) => f.id === created.id)?.atomic,
      "an operator must be able to SEE which freezes are atomic, not only set them"
    ).toBe(true);

    await tick(3);
    // And it BEHAVES: the freeze covers only `amer`, and every sibling is parked.
    for (const place of [amer, apac, emea, govcloud]) {
      expect(firedFor(app.at(place))).toBe(0);
    }
    expect((await waves(change.id))[0]!.status).toBe("pending");
  });

  it("D5 door control: a freeze authored WITHOUT `atomic` is stored non-atomic", async () => {
    // The paired direction — otherwise the case above passes against a column that is always true.
    const created = await freezeAt(apac.id, "apac-default-atomicity");
    expect(created.atomic).toBe(false);
  });

  // ============================================================================================
  // M25.7 / D6 AUTHORING DOOR — `federate` IS A SECOND, HIGHER GATE, AND IT DEFAULTS OFF
  // ============================================================================================
  // Two properties that fail in opposite directions, so both need a case: the default must change
  // NOTHING (a new reach never defaults on), and the federating form must demand `federation:write`
  // ON TOP of `freeze:write` — declaring a freeze that binds another security domain is not the act
  // of describing your own estate (ADR-0022's line, applied by ADR-0043 §3).
  //
  // THE REFUSAL CASE'S ACTOR IS AN ORG-DEFINED ROLE, NOT A BUILT-IN ONE, and that is load-bearing.
  // `freeze:write` and `federation:write` both land on Administrator and Owner and nowhere else, so
  // nothing reachable through today's role table holds one without the other: against a built-in
  // actor the gate would be satisfied by coincidence between two grant lists in two unrelated
  // migrations, and deleting the check would leave every case green. `roles.org_id` exists for
  // exactly this, and `governance/governance-managed-write-doors.integration.test.ts` builds the
  // mirror-image actor for the mirror-image reason.
  // ============================================================================================

  /** `freeze:write` at the org root and `federation:write` NOWHERE — the actor no built-in role can
   *  express, and the only actor for which the D6 gate is observable at all. */
  async function createFreezeOnlyUser(): Promise<string> {
    // Viewer purely so the harness mints the auth row and a live token; `object:read` grants no
    // write anywhere and is no part of what is under test.
    const user = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const roleId = randomUUID();
      await tx.insert(roles).values({
        id: roleId,
        orgId: org.orgId,
        name: `freeze-only-${randomUUID().slice(0, 8)}`,
        permissions: ["freeze:write"]
      });
      await tx.insert(roleBindings).values({
        id: randomUUID(),
        orgId: org.orgId,
        subjectId: user.objectId,
        roleId,
        scopeObjectId: org.orgId,
        effect: "allow"
      });
    });
    return user.token;
  }

  it("D6 door: `federate` is settable through POST /api/v1/freezes and reports the object it minted", async () => {
    const created = await admin.freezes.create({
      scopeObjectId: emea.id,
      name: "emea-federating-via-api",
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: "d6 door: authored the way a commander authors one",
      federate: true
    });
    // `objectId` is READ from the row, never inferred — it is what tells an operator at a receiving
    // instance that this freeze is not one they can lift.
    expect(created.objectId, "the 201 body must report the object that was minted").not.toBeNull();
    expect((await admin.freezes.get(created.id)).objectId).toBe(created.objectId);
  });

  it("D6 door CONTROL: the default is OFF — an ordinary create mints no object at all", async () => {
    // Without this, "federate works" is satisfied by an implementation that federates EVERY freeze,
    // which would newly publish every freeze on every existing estate to every paired peer.
    const created = await freezeAt(govcloud.id, "govcloud-default-federation");
    expect(created.objectId).toBeNull();
  });

  it("D6 gate: `freeze:write` alone CANNOT author a federating freeze — and the same actor CAN author an ordinary one", async () => {
    const token = await createFreezeOnlyUser();
    const client = new ScpClient({ baseUrl: server.baseUrl, token });
    const body = {
      scopeObjectId: amer.id,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: "d6 gate"
    };

    await expect(
      client.freezes.create({ ...body, name: "gate-refused", federate: true })
    ).rejects.toMatchObject({ status: 403 });
    // NOTHING WAS STORED. A refusal reached only after the row landed is not a refusal: the freeze
    // would then stand, enforced locally, with no object and no record of the refused reach.
    expect(
      (await admin.freezes.list()).items.filter((f) => f.name === "gate-refused")
    ).toHaveLength(0);

    // THE CONTROL, without which the case above is satisfied by a door that is simply broken for
    // this actor: the SAME token authors an ordinary freeze and it lands.
    const ordinary = await client.freezes.create({ ...body, name: "gate-allowed" });
    expect(ordinary.objectId).toBeNull();
  });

  // ============================================================================================
  // D6 GATE, THE OTHER TWO VERBS — `federation:write` IS DEMANDED WHEREVER THE OBJECT IS PUBLISHED
  // ============================================================================================
  // The create gate above is only one of three doors that reach another security domain. Both write
  // verbs call `syncFreezeObject`, which re-snapshots the `freeze` object so the edit rides the next
  // bundle — so gating the create alone left the SAME reach available with strictly less authority:
  //
  //   a `freeze:write`-only actor could take a federating freeze whose window ends in an hour and
  //   PATCH its `endsAt` a year out, extending a release-stopping block across a boundary they hold
  //   no federation authority over; or lift it, retracting a commander's protection at every
  //   downstream instance.
  //
  // Keyed on `objectId !== null` — on whether the publish will actually happen — so a
  // non-federating freeze is untouched, which is what the control half of each case measures. The
  // actor is the same org-defined `freeze:write`-only role the create gate uses, and for the same
  // reason: no built-in role separates these two permissions.
  //
  // MUTATION RUN 2026-08-24, MEASURED. Deleting BOTH `assertMayEditFederatingFreeze(tx, auth, …)`
  // calls from `routes/governance.ts` fails exactly these two cases and nothing else:
  //
  //   × D6 gate: a `freeze:write`-only actor cannot LIFT a federating freeze …
  //     → lifting a federating freeze retracts it downstream — that needs federation:write:
  //       expected 200 to be 403
  //   × D6 gate: a `freeze:write`-only actor cannot EXTEND a federating freeze's window …
  //     → expected 200 to be 403
  //
  // The CREATE gate case stayed green through it, which is the point: the create check could not
  // and did not cover these verbs.
  // ============================================================================================

  it("D6 gate: a `freeze:write`-only actor cannot LIFT a federating freeze — and CAN lift a non-federating one", async () => {
    const token = await createFreezeOnlyUser();
    const client = new ScpClient({ baseUrl: server.baseUrl, token });

    const federating = await admin.freezes.create({
      scopeObjectId: emea.id,
      name: "d6-lift-gate-federating",
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: "d6 lift gate",
      federate: true
    });
    // PREMISE, asserted rather than assumed: the guard is keyed on this field, so a fixture that
    // silently stopped federating would make the refusal below prove nothing.
    expect(federating.objectId, "the fixture must actually be a federating freeze").not.toBeNull();

    expect(
      await statusOf(
        client.freezes.lift(federating.id, { reason: "retracting another domain's block" })
      ),
      "lifting a federating freeze retracts it downstream — that needs federation:write"
    ).toBe(403);
    // A REFUSAL REACHED AFTER THE WRITE IS NOT A REFUSAL: the row must still be standing.
    expect((await freezeRow(federating.id)).liftedAt).toBeNull();

    // THE CONTROL, without which the case is satisfied by a door broken for this actor entirely.
    const ordinary = await freezeAt(apac.id, "d6-lift-gate-ordinary");
    expect(
      ordinary.objectId,
      "the control must NOT federate, or it measures the same thing"
    ).toBeNull();
    const lifted = await client.freezes.lift(ordinary.id, { reason: "mine to lift" });
    expect(lifted.liftedAt).not.toBeNull();
  });

  it("D6 gate: a `freeze:write`-only actor cannot EXTEND a federating freeze's window — and CAN move a non-federating one", async () => {
    // THE SHARPER HALF. A lift is at least visibly a retraction; extending `endsAt` grows a block in
    // another security domain and reads, in an audit log, exactly like ordinary window maintenance.
    const token = await createFreezeOnlyUser();
    const client = new ScpClient({ baseUrl: server.baseUrl, token });

    const federating = await admin.freezes.create({
      scopeObjectId: govcloud.id,
      name: "d6-window-gate-federating",
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      reason: "d6 window gate",
      federate: true
    });
    expect(federating.objectId).not.toBeNull();
    const before = await freezeRow(federating.id);

    expect(
      await statusOf(
        client.freezes.updateWindow(federating.id, {
          endsAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
          reason: "a year of someone else's downtime"
        })
      )
    ).toBe(403);
    expect(
      (await freezeRow(federating.id)).endsAt.toISOString(),
      "the window must be untouched — a refusal that still moved endsAt is not a refusal"
    ).toBe(before.endsAt.toISOString());

    const ordinary = await freezeAt(amer.id, "d6-window-gate-ordinary");
    expect(ordinary.objectId).toBeNull();
    const moved = await client.freezes.updateWindow(ordinary.id, {
      endsAt: new Date(Date.now() + 7_200_000).toISOString(),
      reason: "mine to move"
    });
    expect(moved.endsAt).not.toBe(ordinary.endsAt);
  });

  it("D6: `domainLocal` without `federate` is REFUSED, not ignored — a locality declaration that no-ops is a field that lies", async () => {
    await expect(
      admin.freezes.create({
        scopeObjectId: amer.id,
        name: "local-without-object",
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        reason: "d6: locality needs something to withhold",
        domainLocal: true
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  // ============================================================================================
  // MID-WAVE — the SECOND defect M25.2 claims to fix, and the one no case reached: every other
  // fixture declares its freeze before the wave gate runs, so the gate could have done the work.
  // ============================================================================================
  it("mid-wave: a freeze declared AFTER the wave started still withholds the retry", async () => {
    const app = await fourRegionComponent("midwave");
    // `amer`'s executor refuses, so that target stays `triggering` after the gate has allowed and
    // the wave is `running` — the only window in which "declared mid-wave" is expressible at all.
    refuseTargets.add(app.at(amer));
    const change = await release("midwave", [app.id]);
    await tick(2);
    expect((await waves(change.id))[0]!.status, "the gate saw NO freeze and allowed").toBe(
      "running"
    );
    const firedBefore = firedFor(app.at(amer));
    expect(firedBefore, "the refused target really was dispatched once").toBeGreaterThan(0);

    // NOW the freeze — the wave gate has already fired and will never fire again for this wave.
    await freezeAt(amer.id, "amer-declared-mid-wave");
    await expireBackoff();
    await tick(4);

    expect(
      firedFor(app.at(amer)),
      "a freeze declared mid-wave must withhold the RETRY — the gate cannot, it fires once"
    ).toBe(firedBefore);
    expect(await decisionsOfKind(change.id, "freeze_admission")).toHaveLength(1);
  });

  it("mid-wave `atomic`: an atomic freeze declared mid-wave holds a sibling it does NOT cover", async () => {
    const app = await fourRegionComponent("midatomic");
    // TWO refused targets, so there is still an UNCOVERED `pending`/`triggering` sibling for the
    // atomic union to reach when the freeze arrives. `emea`/`govcloud` ship normally.
    refuseTargets.add(app.at(amer));
    refuseTargets.add(app.at(apac));
    await release("midatomic", [app.id]);
    await tick(2);
    const apacBefore = firedFor(app.at(apac));
    expect(apacBefore).toBeGreaterThan(0);

    // Covers `amer` ONLY. `atomic` means it holds every target of the wave regardless.
    await atomicFreezeAt(amer.id, "amer-atomic-mid-wave");
    await expireBackoff();
    await tick(4);

    expect(
      firedFor(app.at(apac)),
      "`atomic` restores the UNION — and the wave gate fires once, so only the per-tick hold can apply it after the wave started"
    ).toBe(apacBefore);
  });

  it("mid-wave `atomic` control: a NON-atomic freeze declared mid-wave leaves the sibling alone", async () => {
    const app = await fourRegionComponent("midnonatomic");
    refuseTargets.add(app.at(amer));
    refuseTargets.add(app.at(apac));
    await release("midnonatomic", [app.id]);
    await tick(2);
    const apacBefore = firedFor(app.at(apac));

    await freezeAt(amer.id, "amer-nonatomic-mid-wave");
    await expireBackoff();
    await tick(4);

    expect(
      firedFor(app.at(apac)),
      "per-target admission: a freeze at amer says nothing about apac"
    ).toBeGreaterThan(apacBefore);
  });

  // ============================================================================================
  // D7'S QUALIFIER — a rollback is exempt where there is something to roll back, and only there.
  // ============================================================================================
  it("D7 qualifier: a rollback is NOT exempt at a target the original never dispatched", async () => {
    // The composition per-target admission makes reachable for the first time: the freeze holds
    // `amer` and the siblings SHIP, so one of them can fail, so a rollback can be minted over ALL
    // FOUR of the original's targets — including the one the freeze successfully held. A bare
    // `isRollback` exemption dispatches an unattended executor call into the frozen region to undo
    // a release that never happened there.
    const app = await fourRegionComponent("rbqual");
    const original = await release("rbqual", [app.id]);
    await freezeAt(amer.id, "amer-freeze-vs-nothing-to-undo");
    await tick(2);
    expect(firedFor(app.at(amer)), "the freeze held amer: nothing was ever dispatched there").toBe(
      0
    );
    const apacFired = firedFor(app.at(apac));
    expect(apacFired).toBeGreaterThan(0);

    const rollback = await admin.changes.rollback(
      original.id,
      "integration: undo the three that shipped"
    );
    await tick(6);

    // `amer` — nothing to undo, still frozen, still held.
    expect(
      firedFor(app.at(amer)),
      "D7 exempts a rollback so it can undo a broken release; there is no broken release at a target the original never reached"
    ).toBe(0);
    const heldRollback = await decisionsOfKind(rollback.id, "freeze_admission");
    expect(heldRollback).toHaveLength(1);
    expect(
      (heldRollback[0]!.inputContext as { held: { targetObjectId: string }[] }).held.map(
        (h) => h.targetObjectId
      )
    ).toEqual([app.at(amer)]);

    // `apac` — the original DID dispatch there, so the rollback proceeds. Both directions.
    expect(
      firedFor(app.at(apac)),
      "the exemption still applies where the release actually landed — that is the whole of D7"
    ).toBeGreaterThan(apacFired);
  });

  // ============================================================================================
  // HOLD -> RELEASE (§1.5) — the clearing counterpart ADR-0028 does not have.
  // ============================================================================================
  it("release: when the window closes the hold is cleared with an `allow` row, exactly once", async () => {
    const app = await fourRegionComponent("release");
    const change = await release("release", [app.id]);
    const frozen = await freezeAt(amer.id, "amer-release-freeze");

    await tick(3);
    const held = await decisionsOfKind(change.id, "freeze_admission");
    expect(held).toHaveLength(1);
    expect(held[0]!.verdict).toBe("hold");

    await shortenFreezeToPast(frozen.id);
    await tick(3);

    const afterLift = await decisionsOfKind(change.id, "freeze_admission");
    expect(
      afterLift,
      "a hold with no clearing counterpart still says `hold` long after it released — the defect routes/changes.ts already documents against ADR-0028"
    ).toHaveLength(2);
    expect(afterLift[1]!.verdict).toBe("allow");
    expect(afterLift[1]!.inputContext).toMatchObject({ held: [] });
    expect(firedFor(app.at(amer)), "and the target actually shipped").toBeGreaterThan(0);

    // EXACTLY ONCE. The release must not become a per-tick writer of its own — that is ADR-0024
    // rebuilt one verdict over.
    await tick(20);
    expect(await decisionsOfKind(change.id, "freeze_admission")).toHaveLength(2);
  });

  // ============================================================================================
  // DEDUP, WITH ARRAYS LONG ENOUGH FOR THE SORTS TO MATTER. The single-held-target/single-freeze
  // fixture made both sorts operate on 1-element arrays, so deleting them changed nothing.
  // ============================================================================================
  it("dedup (multi): two held targets under two freezes, with BOTH source orders reversed", async () => {
    // THE FIXTURE IS THE TEST. The previous shape (one held target, one covering freeze) made both
    // Decision sorts operate on ONE-ELEMENT arrays, so deleting them changed nothing and the
    // mutation survived while three docblocks and this case's own banner claimed it was covered.
    // Both sorts are now given input whose NATURAL order is the reverse of their sorted order:
    //
    //   * TARGETS. Placements are created govcloud -> emea -> apac -> amer, so their uuidv7 ids
    //     ascend in that order — while the topology's wave lists them amer, apac, emea, govcloud.
    //     `loadWavesWithTargets` orders by `created_at` with no tiebreak and every target of a wave
    //     carries the same transaction timestamp, so the order reconcile sees is the wave's. Sorted
    //     ascending is therefore the exact REVERSE of it.
    //   * FREEZES. The atomic freeze is created FIRST (lowest id) and the plain one SECOND, and the
    //     covering set for `apac` is built as [its own] ++ [the atomic ones] — i.e. highest id
    //     first. Sorted ascending flips it.
    //
    // Delete either sort and the corresponding assertion below goes red. That matters because
    // `restatesDecision` canonicalizes object KEYS only: array element order is significant, so an
    // unsorted array plus a reordered query result is one new Decision row per second, for weeks —
    // ADR-0024's measured 1.44 GB/day rebuilt from parts.
    const app = await componentAt("dedup2", [govcloud, emea, apac, amer]);
    // Both freezes are declared MID-WAVE, which is also the only way an `atomic` freeze can reach
    // the per-target hold at all: declared before the gate, `partiallyFrozen` is false for an atomic
    // freeze and the wave is blocked WHOLE, so no hold Decision is ever written. `amer` and `apac`
    // are refused by their executor so they are still `triggering` when the freezes arrive; `emea`
    // and `govcloud` shipped on the first tick and are past this seam, as they must be — a freeze
    // cannot un-ring a trigger already made.
    refuseTargets.add(app.at(amer));
    refuseTargets.add(app.at(apac));
    const change = await release("dedup2", [app.id]);
    await tick(2);
    expect((await waves(change.id))[0]!.status, "the gate saw no freeze and allowed").toBe(
      "running"
    );

    const atomicFreeze = await atomicFreezeAt(amer.id, "amer-atomic-first");
    const plainFreeze = await freezeAt(apac.id, "apac-plain-second");
    expect(
      atomicFreeze.id < plainFreeze.id,
      "uuidv7 is monotonic: the atomic freeze must carry the LOWER id for the freeze-order assertion to bite"
    ).toBe(true);
    await expireBackoff();

    await tick(3);
    const [only] = await decisionsOfKind(change.id, "freeze_admission");
    expect(only).toBeDefined();
    const heldIn = (
      only!.inputContext as {
        held: { targetObjectId: string; freezes: { id: string }[] }[];
      }
    ).held;

    // `atomic` restores the union, so `amer` (covered) and `apac` (not covered by the atomic
    // freeze, only by its own) are both held — and the array must be in id order, not in the order
    // the wave handed them over.
    const waveOrder = [amer, apac].map((place) => app.at(place));
    expect(heldIn.map((h) => h.targetObjectId)).toEqual([...waveOrder].sort());
    expect(
      heldIn.map((h) => h.targetObjectId),
      "and that really is a different order from the one the loop produced"
    ).not.toEqual(waveOrder);

    const apacEntry = heldIn.find((h) => h.targetObjectId === app.at(apac))!;
    expect(
      apacEntry.freezes.map((f) => f.id),
      "freezes sorted by id — `apac`'s own freeze is found first and carries the HIGHER id"
    ).toEqual([atomicFreeze.id, plainFreeze.id]);

    await tick(30);
    expect(
      await decisionsOfKind(change.id, "freeze_admission"),
      "33 ticks, two held targets, two freezes: still one row"
    ).toHaveLength(1);
  });

  // ============================================================================================
  // A DEAD TARGET IS NOT HELD — terminalizing it is PROGRESS.
  // ============================================================================================
  it("tombstone: a frozen target whose object was deleted terminalizes instead of being held", async () => {
    // FOUR regions, not one: a solo-target wave under a freeze is the ALL-FROZEN case, so the gate
    // blocks it whole and the actuator is never reached at all. The defect lives on the PARTIAL
    // path, which is the one per-target admission created.
    const app = await fourRegionComponent("tombstone");
    const change = await release("tombstone", [app.id]);
    await freezeAt(amer.id, "amer-freeze-over-a-corpse");

    await tick(2);
    expect((await waveTarget(change.id, app.at(amer))).status, "held first").toBe("pending");
    expect(await decisionsOfKind(change.id, "freeze_admission")).toHaveLength(1);

    // A perfectly authorized delete, taken while the change is in flight and the region frozen.
    //
    // The PLACEMENT is deleted, not its component, and that is deliberate on two counts. The wave
    // target IS the placement (`app.at(amer)`), so deleting it is the precise statement of what this
    // test is about — one dead target among three live siblings. And a component that still has
    // placements is a non-empty container: the container-delete guard refuses that with a 409, so a
    // `DELETE /components/{id}` here would stop testing tombstone handling and start testing the
    // guard. Child-first ordering is the rule; this fixture only ever needed the child.
    const res = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/placements/${app.at(amer)}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode, "the placement delete must be accepted, not 409'd").toBeLessThan(300);

    await tick(4);

    // `containmentChain` does not live-filter its BASE row, so the tombstoned placement still
    // resolves a full chain and the freeze still "covers" it. Holding it would park a DEAD row for
    // the length of the window — weeks are expressible — behind a Decision that says a freeze is
    // holding it while the truth is that the object was deleted, and would defer the tombstone's
    // own audit event and block Decision for exactly as long. Terminalizing it is PROGRESS, which
    // is the ordering `campaign-reconcile.ts`'s seam already states for itself.
    expect((await waveTarget(change.id, app.at(amer))).status, "a dead target is not held").toBe(
      "target_deleted"
    );
    expect(firedFor(app.at(amer)), "and nothing was ever dispatched at it").toBe(0);
  });

  // ============================================================================================
  // `GateVerdict.frozenTargets` — the wave-gate passthrough. Delete either line in `gates.ts` and
  // this goes red; without it the field had no reader on either side of that file.
  // ============================================================================================
  it("the wave gate REPORTS which targets are frozen, through `evaluateWaveGate`", async () => {
    const app = await fourRegionComponent("verdict");
    const change = await release("verdict", [app.id]);
    await freezeAt(amer.id, "amer-verdict-freeze");

    const verdict = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      evaluateWaveGate(
        tx,
        {
          orgId: org.orgId,
          changeObjectId: change.id,
          actorObjectId: org.orgId,
          emergency: false,
          topologyObjectId: topologyId,
          waveIndex: 0,
          targetObjectIds: [amer, apac, emea, govcloud].map((place) => app.at(place))
        },
        { sandbox: getSharedCelSandbox(), host: null }
      )
    );

    expect(verdict.verdict, "partial admission: the gate stands aside").toBe("allow");
    const reported = (verdict.frozenTargets ?? []).filter((e) => e.freezes.length > 0);
    expect(
      reported.map((e) => e.targetObjectId),
      "the gate must be able to SAY which targets it stood aside for — an `allow` with no per-target detail explains nothing"
    ).toEqual([app.at(amer)]);
  });

  // ============================================================================================
  // §1.8 HONESTY — the lever works and the signal must not be missing.
  // ============================================================================================
  it("service board: a REGION freeze appears on the rows it actually holds", async () => {
    const service = await admin.services.create({
      name: `board-svc-${randomUUID().slice(0, 8)}`
    });
    const app = await componentAt("boardcomp", [amer, apac], service.id);
    const frozen = await freezeAt(amer.id, "amer-board-freeze");

    const board = await admin.services.board(service.id);
    const row = board.rows.find((r) => r.component.id === app.id);
    expect(
      row?.activeFreeze?.id,
      "a deployment-target-scoped freeze sits on a PLACEMENT's containment chain, never on a component's — an exact-scope map finds it on no row at all"
    ).toBe(frozen.id);

    // And the service tier, through containment rather than exact membership.
    const serviceWide = await freezeAt(service.id, "service-board-freeze");
    const after = await admin.services.board(service.id);
    expect(after.serviceFreeze).not.toBeNull();
    expect(
      after.rows.find((r) => r.component.id === app.id)?.activeFreeze,
      "a service-scoped freeze reaches every component under it"
    ).not.toBeNull();
    expect([frozen.id, serviceWide.id]).toContain(
      after.rows.find((r) => r.component.id === app.id)?.activeFreeze?.id
    );
  });

  it("service board control: with nothing frozen, no row claims a freeze", async () => {
    const service = await admin.services.create({
      name: `board-clean-${randomUUID().slice(0, 8)}`
    });
    const app = await componentAt("boardclean", [amer], service.id);
    const board = await admin.services.board(service.id);
    expect(board.serviceFreeze).toBeNull();
    expect(board.rows.find((r) => r.component.id === app.id)?.activeFreeze).toBeNull();
  });

  // ============================================================================================
  // M25.1 — LIFT AND SHORTEN: the exits `/freezes` shipped without.
  //
  // `/api/v1/freezes` was CREATE / LIST / GET. A freeze could be declared and never retracted,
  // which was survivable only while a freeze parked a WHOLE wave — the operator waited for
  // `endsAt` and the release resumed on its own. Every case above is a demonstration of why that
  // stopped being true: per-target admission means a far-future `endsAt` holds a SUBSET of a
  // wave's targets while the siblings have already shipped, so a mistyped year leaves a fleet
  // split across two versions with no API exit at all.
  //
  // THE STANDING MUTATION GATE FOR THIS BLOCK: delete `isNull(freezes.liftedAt)` from
  // `activeFreezesInWindow` — the ONE liveness filter — and "a lift un-holds a held target" must
  // go red. Recorded in the PR body; run and confirmed KILLED when this block landed.
  // ============================================================================================

  const auditEventsFor = (subjectId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.orgId, org.orgId), eq(auditEvents.subjectId, subjectId)))
        .orderBy(auditEvents.seq)
    );

  const freezeRow = (freezeId: string) =>
    withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const [row] = await tx
        .select()
        .from(freezes)
        .where(and(eq(freezes.orgId, org.orgId), eq(freezes.id, freezeId)));
      return row!;
    });

  /** The status of a rejected SDK call. Asserting the CODE and not merely "it threw" is the point:
   *  a 404 and a 403 are the difference between "no such freeze" and "not yours to lift", and a
   *  test that accepts either would pass against an authorization check that never ran. */
  async function statusOf(call: Promise<unknown>): Promise<number> {
    try {
      await call;
      return 200;
    } catch (err) {
      if (err instanceof ScpApiError) return err.status ?? -1;
      throw err;
    }
  }

  it("M25.1 lift: DELETE un-holds a held target, ships it, and releases the hold Decision", async () => {
    // THE POINT OF THE WHOLE INCREMENT, and the one case the liveness-filter mutation must kill.
    const app = await fourRegionComponent("lift");
    const change = await release("lift", [app.id]);
    const frozen = await freezeAt(amer.id, "amer-lift-freeze");

    await tick(3);
    expect(firedFor(app.at(amer)), "the freeze is doing its job before we lift it").toBe(0);
    const heldBefore = await decisionsOfKind(change.id, "freeze_admission");
    expect(heldBefore).toHaveLength(1);
    expect(heldBefore[0]!.verdict).toBe("hold");

    // `endsAt` is still an hour out — nothing about the WINDOW changes here. Only the retraction.
    const lifted = await admin.freezes.lift(frozen.id, {
      reason: "integration: the deploy that caused the incident was reverted"
    });
    expect(lifted.liftedAt, "the response carries the retraction, not an empty 204").not.toBeNull();
    expect(lifted.endsAt, "and does NOT pretend the declared window moved").toBe(
      (await admin.freezes.get(frozen.id)).endsAt
    );

    await tick(3);

    // THE ASSERTION, against the EXECUTOR rather than a status column.
    expect(
      firedFor(app.at(amer)),
      "a lifted freeze holds nothing: the target that was held must now be handed to its executor"
    ).toBeGreaterThan(0);
    expect((await waveTarget(change.id, app.at(amer))).executorRef).not.toBeNull();

    // ...and the hold is RELEASED through the same `clearFreezeAdmissionHold` path a window
    // closing uses (§1.5). There is no lift-specific code anywhere in reconcile — the predicate is
    // read-time, so a lifted freeze simply stops being returned and the next tick clears.
    const afterLift = await decisionsOfKind(change.id, "freeze_admission");
    expect(afterLift).toHaveLength(2);
    expect(afterLift[1]!.verdict).toBe("allow");
    expect(afterLift[1]!.inputContext).toMatchObject({ held: [] });

    // EXACTLY ONCE — the release must not become a per-tick writer (ADR-0024).
    await tick(10);
    expect(await decisionsOfKind(change.id, "freeze_admission")).toHaveLength(2);
  });

  it("M25.1 extend: pushing `endsAt` FURTHER OUT keeps the target held", async () => {
    // The paired direction. Without it the two release cases could pass against a PATCH that
    // ignored its body and simply retired the freeze whatever instant it was handed.
    const app = await fourRegionComponent("extend");
    const change = await release("extend", [app.id]);
    const frozen = await freezeAt(amer.id, "amer-extend-freeze");

    await tick(3);
    expect(firedFor(app.at(amer))).toBe(0);

    const extended = await admin.freezes.updateWindow(frozen.id, {
      endsAt: new Date(Date.now() + 7 * 24 * 3_600_000).toISOString(),
      reason: "integration: the incident is not over"
    });
    expect(new Date(extended.endsAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3_600_000);

    await tick(3);

    expect(
      firedFor(app.at(amer)),
      "an EXTENSION is a tightening — the held target must stay held"
    ).toBe(0);
    const holds = await decisionsOfKind(change.id, "freeze_admission");
    expect(
      holds.map((d) => d.verdict),
      "NO `allow` row at any point: nothing was released, so nothing should claim to have been"
    ).not.toContain("allow");
    // There IS a second `hold` row, and it is correct rather than write amplification: the hold
    // Decision's `inputContext` records the freeze's `endsAt` (never `now` — ADR-0024), so moving
    // `endsAt` genuinely changes the situation and `insertDecisionIfChanged` restates it ONCE. The
    // restatement is the assertion: the standing explanation now names the NEW deadline, which is
    // what an operator reading `scp change explain` after an extension needs to see.
    const latest = holds[holds.length - 1]!;
    expect(latest.verdict).toBe("hold");
    expect(
      (latest.inputContext as { held: { freezes: { endsAt: string }[] }[] }).held[0]!.freezes[0]!
        .endsAt,
      "the standing hold must name the extended deadline, not the one it was declared with"
    ).toBe(extended.endsAt);
    // The unfrozen siblings shipped throughout, so this case is not passing because nothing moved.
    expect(firedFor(app.at(apac))).toBeGreaterThan(0);
  });

  it("M25.1 authz: `freeze:write` at a service cannot lift the ORG-ROOT freeze — but can lift its own", async () => {
    // THE PROPERTY: authority at a narrow scope is not authority over a broad freeze. It holds
    // because the route authorizes at the FREEZE'S OWN `scopeObjectId` and `hasPermission` expands
    // the checked scope UPWARD — checking at `auth.orgId` instead would make this case green with
    // the property gone, which is why the org-root arm is here and not just the happy path.
    const service = await admin.services.create({
      name: `lift-authz-svc-${randomUUID().slice(0, 8)}`
    });
    const orgWide = await freezeAt(org.orgId, "org-root-freeze");
    const serviceWide = await freezeAt(service.id, "service-freeze");

    const serviceAdmin = await createTestUser(server, org, [
      { role: "Administrator", scope: service.id }
    ]);
    const scoped = new ScpClient({ baseUrl: server.baseUrl, token: serviceAdmin.token });

    expect(
      await statusOf(scoped.freezes.lift(orgWide.id, { reason: "not mine to lift" })),
      "an Administrator scoped to one service must not be able to retract a freeze protecting the whole org"
    ).toBe(403);
    // The freeze is untouched, not merely un-returned.
    expect((await freezeRow(orgWide.id)).liftedAt).toBeNull();

    // PATCH is the same door and must refuse identically — two verbs, one authorization rule.
    expect(
      await statusOf(
        scoped.freezes.updateWindow(orgWide.id, {
          endsAt: new Date(Date.now() - 1_000).toISOString(),
          reason: "nor to shorten"
        })
      ),
      "shortening someone else's freeze into the past is a lift by another name — same scope check"
    ).toBe(403);

    // THE CONTROL. Same actor, same permission, a freeze at their own scope: allowed. Without this
    // arm the case above would pass just as well against a route that refused everyone.
    const ok = await scoped.freezes.lift(serviceWide.id, {
      reason: "integration: this one IS mine"
    });
    expect(ok.liftedAt).not.toBeNull();
    expect(ok.liftedByActorId).toBe(serviceAdmin.objectId);
  });

  it("M25.1 authz: Viewer and Operator hold no `freeze:write` at all", async () => {
    const frozen = await freezeAt(amer.id, "amer-role-freeze");
    for (const role of ["Viewer", "Operator"]) {
      const user = await createTestUser(server, org, [{ role, scope: org.orgId }]);
      const client = new ScpClient({ baseUrl: server.baseUrl, token: user.token });
      expect(
        await statusOf(client.freezes.lift(frozen.id, { reason: `${role} tries to lift` })),
        `${role} does not hold freeze:write (drizzle/0010 grants it to Administrator and Owner only)`
      ).toBe(403);
      expect(
        await statusOf(
          client.freezes.updateWindow(frozen.id, {
            endsAt: new Date(Date.now() + 60_000).toISOString(),
            reason: `${role} tries to shorten`
          })
        )
      ).toBe(403);
    }
    expect((await freezeRow(frozen.id)).liftedAt).toBeNull();
  });

  it("M25.1: a lift REQUIRES a reason — absent and empty are both refused", async () => {
    const frozen = await freezeAt(amer.id, "amer-reason-freeze");
    // Both arms go through `inject`, because the typed SDK will not let a caller express either
    // shape — which is the point: the refusal has to live at the server, not in TypeScript.
    for (const payload of [{}, { reason: "" }, { reason: "   " }]) {
      const rejected = await server.app.inject({
        method: "DELETE",
        url: `/api/v1/freezes/${frozen.id}`,
        headers: { authorization: `Bearer ${org.adminToken}` },
        payload
      });
      expect(
        rejected.statusCode,
        `lifting a freeze with reason=${JSON.stringify(payload)} is a governance loosening with no recorded justification — freeze:override has refused exactly this since M4`
      ).toBe(400);
    }
    // A whitespace-only reason is refused by `liftFreeze`'s own `trim()`, not by the schema's
    // `min(1)`, so the row must still be standing after all three.
    expect((await freezeRow(frozen.id)).liftedAt).toBeNull();

    const shorten = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/freezes/${frozen.id}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { endsAt: new Date(Date.now() + 60_000).toISOString() }
    });
    expect(shorten.statusCode, "and the same on the window edit, in both directions").toBe(400);
  });

  it("M25.1: a lifted freeze is still READABLE by id and by list — but is not active", async () => {
    // WHY SOFT: `gate-orchestrator.ts`'s block Decision carries `inputContext.freeze.id` and
    // `recordFreezeAdmissionHold` carries `inputContext.held[].freezes[].id`, permanently. A hard
    // DELETE would make `scp change explain` name an id that resolves to nothing — the question
    // charter principle 6 exists to keep answerable.
    const app = await fourRegionComponent("readable");
    const change = await release("readable", [app.id]);
    const frozen = await freezeAt(amer.id, "amer-readable-freeze");
    await tick(3);

    const holdDecision = (await decisionsOfKind(change.id, "freeze_admission"))[0]!;
    const citedId = (holdDecision.inputContext as { held: { freezes: { id: string }[] }[] })
      .held[0]!.freezes[0]!.id;
    expect(citedId).toBe(frozen.id);

    await admin.freezes.lift(frozen.id, { reason: "integration: retracted" });

    // (a) THE CITATION STILL RESOLVES.
    const stillThere = await admin.freezes.get(citedId);
    expect(stillThere.id).toBe(frozen.id);
    expect(stillThere.reason, "including WHY it was declared in the first place").toContain(
      "amer-readable-freeze"
    );
    expect(stillThere.liftReason).toBe("integration: retracted");
    // WHO, and it is the bootstrap admin's own subject object — not `org.orgId`. The distinction
    // matters: `createFreeze`'s test fixtures pass `org.orgId` as the actor, and an assertion
    // written against that would have passed against a route that recorded the ORG rather than the
    // person, which is exactly the field this column exists to hold.
    expect(stillThere.liftedByActorId).not.toBeNull();
    expect(stillThere.liftedByActorId).not.toBe(org.orgId);

    // (b) AND IT IS STILL LISTED — lifted is a FIELD, not an absence. An operator reviewing what
    // was in force last Tuesday needs to see it.
    const listed = (await admin.freezes.list()).items.find((f) => f.id === frozen.id);
    expect(listed?.liftedAt).not.toBeNull();

    // (c) BUT IT IS NOT ACTIVE — asserted against a BRAND NEW change, so this cannot pass on the
    // first change's already-cleared state.
    const second = await release("readable2", [app.id]);
    await tick(4);
    expect(
      await decisionsOfKind(second.id, "freeze_admission"),
      "a lifted freeze must hold nothing, including releases proposed after it was lifted"
    ).toHaveLength(0);
    expect((await waves(second.id)).map((w) => w.status)).toEqual(["running"]);
  });

  it("M25.1: both verbs write a Decision carrying the before/after, and an audit event citing it", async () => {
    const frozen = await freezeAt(amer.id, "amer-audit-freeze");
    const originalEndsAt = frozen.endsAt;

    const shortened = await admin.freezes.updateWindow(frozen.id, {
      endsAt: new Date(Date.now() + 60_000).toISOString(),
      reason: "integration: cutting it short"
    });
    const lifted = await admin.freezes.lift(frozen.id, {
      reason: "integration: and retracting it"
    });
    expect(lifted.liftedAt).not.toBeNull();

    const decisions = await decisionsOfKind(frozen.id, "freeze_window");
    expect(decisions).toHaveLength(2);
    // THE OLD VALUE AND THE NEW ONE. `audit_events` has no payload column, so this Decision is the
    // ONLY place the previous `endsAt` survives — without it, "the freeze ends at T" is
    // unfalsifiable after the fact and a three-week window cut to a minute is indistinguishable
    // from one that was always a minute.
    expect(decisions[0]!.inputContext).toMatchObject({
      action: "shortened",
      endsAt: { from: originalEndsAt, to: shortened.endsAt }
    });
    expect(
      (decisions[0]!.reasonTree as { loosening: boolean }).loosening,
      "shortening a freeze is a LOOSENING, recorded as a flag rather than left to be inferred from two timestamps"
    ).toBe(true);
    expect(decisions[1]!.inputContext).toMatchObject({ action: "lift" });

    const events = await auditEventsFor(frozen.id);
    expect(events.map((e) => e.action)).toEqual(["freeze.window.shortened", "freeze.lift"]);
    expect(events.map((e) => e.reason)).toEqual([
      "integration: cutting it short",
      "integration: and retracting it"
    ]);
    // Each event points at ITS OWN Decision — the `freeze.override` shape, so an operator reading
    // the audit log can resolve the structured before/after rather than only free text.
    expect(events.map((e) => e.decisionId)).toEqual(decisions.map((d) => d.id));
  });

  it("M25.1: a PATCH that moves `endsAt` NOWHERE is recorded as `unchanged`, not as an extension", async () => {
    // EQUALITY IS ITS OWN CASE. The comparison shipped as `endsAt < before.endsAt ? "shortened" :
    // "extended"`, which folds "the same instant" into the extension arm — so re-saving a
    // freeze-editing form without touching the field (the ordinary shape of a UI PATCH, and the UI
    // this increment unblocks is the next session's) wrote a HASH-CHAINED audit event claiming an
    // extension that did not happen, alongside a Decision asserting `from === to`. Principle 6 is
    // about a record that reconstructs what occurred; a record of a governance edit that did not
    // occur fails it in the direction that is hardest to notice, because nothing looks broken.
    const frozen = await freezeAt(amer.id, "amer-noop-freeze");

    const same = await admin.freezes.updateWindow(frozen.id, {
      endsAt: frozen.endsAt,
      reason: "integration: saving the form without touching the field"
    });
    expect(same.endsAt, "the window really is where it was").toBe(frozen.endsAt);

    const [decision] = await decisionsOfKind(frozen.id, "freeze_window");
    expect(decision!.inputContext).toMatchObject({
      action: "unchanged",
      endsAt: { from: frozen.endsAt, to: frozen.endsAt }
    });
    expect(
      (decision!.reasonTree as { loosening: boolean }).loosening,
      "nothing was weakened, so nothing may be flagged as a loosening either"
    ).toBe(false);
    expect(
      (await auditEventsFor(frozen.id)).map((e) => e.action),
      "the audit chain names the third case by name rather than rounding it to a tightening"
    ).toEqual(["freeze.window.unchanged"]);
  });

  it("M25.1: two OVERLAPPING window edits — the second is recorded against what the FIRST left, not a stale snapshot", async () => {
    // THE LOST-SNAPSHOT RACE, in its deterministic form, at the repo seam so the interleaving is
    // exact rather than hoped for (the `stampBoundaryBundleChecksum` precedent in
    // `boundary-segment.integration.test.ts`). `updateFreezeWindow` is a read-modify-write whose
    // READ decides two things that end up in a permanent record: `direction` (the audit action, and
    // the `loosening` flag on the Decision) and the Decision's `endsAt.from`.
    //
    // Under READ COMMITTED an UNLOCKED read returns the pre-tx1 committed value no matter when
    // within this window tx2 lands, so the corruption is CERTAIN here, not probabilistic: tx2 would
    // read the original hour, compute SECOND < original => "shortened", and stamp
    // `freeze.window.shortened` on an edit that pushed the live deadline from one minute out to ten
    // — an audit record asserting the OPPOSITE direction of the governance change it describes.
    // `FOR UPDATE` parks tx2 at the READ until tx1 commits, after which it re-reads FIRST.
    const frozen = await freezeAt(amer.id, "amer-race-freeze"); // endsAt: an hour out
    const FIRST = new Date(Date.now() + 60_000); // a big shortening: an hour -> a minute
    const SECOND = new Date(Date.now() + 10 * 60_000); // LONGER than FIRST, SHORTER than the original

    let second!: ReturnType<typeof updateFreezeWindow>;
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await updateFreezeWindow(tx, {
        orgId: org.orgId,
        id: frozen.id,
        endsAt: FIRST,
        reason: "integration: cutting it to a minute",
        actorObjectId: org.orgId
      });
      second = withTenantTx(server.deps.db, org.orgId, (tx2) =>
        updateFreezeWindow(tx2, {
          orgId: org.orgId,
          id: frozen.id,
          endsAt: SECOND,
          reason: "integration: actually give it ten",
          actorObjectId: org.orgId
        })
      );
      // POSITIVE SIGNAL, not a sleep (`test-support/integration-sleep-census.test.ts`): wait until
      // tx2 is DEMONSTRABLY blocked on tx1's row lock, by asking Postgres. A fixed sleep here is
      // wrong in both directions — too short on a loaded box and tx2 has not reached its read, so
      // the test passes vacuously having raced nothing; too long and it is dead time in every run.
      // `pg_stat_activity.wait_event_type = 'Lock'` is exactly the state this test needs to exist:
      // tx2 has issued its `SELECT ... FOR UPDATE` and is parked behind tx1. Polling it makes the
      // wait as long as the lock actually takes and no longer, and — the part that matters — makes
      // it IMPOSSIBLE for this case to be green without the contention it claims to create.
      await waitForBlockedBackend(server.deps.db);
    });
    const result = await second;

    expect(
      result.before.endsAt.toISOString(),
      "the audited `from` must be the window that was actually in force, not the one tx2 first saw"
    ).toBe(FIRST.toISOString());
    expect(
      result.direction,
      "ten minutes is an EXTENSION of a one-minute window; only a stale snapshot calls it a shortening"
    ).toBe("extended");
  }, 60_000);

  it("M25.1: a retraction is final, and a window edit cannot invert the window", async () => {
    const frozen = await freezeAt(amer.id, "amer-final-freeze");

    // `endsAt <= startsAt` is refused by the SAME `assertWindowOrdered` `createFreeze` uses — a
    // PATCH that admitted it would leave a row `POST /freezes` refuses to produce.
    expect(
      await statusOf(
        admin.freezes.updateWindow(frozen.id, {
          endsAt: new Date(Date.now() - 3_600_000).toISOString(),
          reason: "before the freeze even started"
        })
      ),
      "the fixture's startsAt is 60s ago; an endsAt an hour ago inverts the window"
    ).toBe(400);

    await admin.freezes.lift(frozen.id, { reason: "integration: retracted for good" });

    expect(
      await statusOf(admin.freezes.lift(frozen.id, { reason: "again" })),
      "a lift records WHO retracted this and WHY; a second caller must not overwrite that record"
    ).toBe(409);
    expect(
      await statusOf(
        admin.freezes.updateWindow(frozen.id, {
          endsAt: new Date(Date.now() + 3_600_000).toISOString(),
          reason: "re-open it"
        })
      ),
      "extending a lifted freeze would promise protection that `lifted_at` cancels — declare a new freeze instead"
    ).toBe(409);

    // The original lift's record is intact, which is the whole reason both refusals exist.
    const row = await freezeRow(frozen.id);
    expect(row.liftReason).toBe("integration: retracted for good");
  });
});
