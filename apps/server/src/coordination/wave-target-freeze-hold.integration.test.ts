import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { changes } from "../db/schema.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { reconcileOrgTick } from "./reconcile.js";
import { createInMemoryFakeHost } from "./test-support/fake-plugin-host.js";
import { createFreeze } from "../governance/freezes-repo.js";
import * as freezeHoldModule from "./freeze-hold.js";

/**
 * M25.UI — THE WAVE-TARGET FREEZE-HOLD PROJECTION, end to end against `GET /changes/{id}/explain`.
 *
 * `ChangeWaveTargetSchema.hold` (packages/schemas/src/changes.ts) and `ChangeWaveSchema.
 * heldTargetCount` are new, additive, read-time-composed fields — see those schemas' doc comments
 * for the four properties campaigns-rework.md's closing section fixes for `hold`. This file pins
 * the read side: `evaluateFreezeHolds` (the SAME predicate `reconcile.ts`'s engine loop consults)
 * re-evaluated fresh on every `explain`, never sourced from the `freeze_admission` Decision (which
 * has no clearing counterpart and would therefore say "held" forever — the exact permanent-marker
 * trap `stage-dependency-status.ts`'s own module doc names at length).
 *
 * ENTERS AT THE HTTP LAYER, via `ScpClient` against a real `listenTestServer()` — the same idiom
 * every sibling freeze/stage-dependency integration file in this directory uses; `admin.changes.
 * explain(id)` is a genuine `fetch()` over the wire, not a repo-direct call.
 */
describe("wave-target hold projection: ChangeWaveTargetSchema.hold / ChangeWaveSchema.heldTargetCount", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let amer: GraphObject;
  let apac: GraphObject;
  let topologyId: string;
  let host: PluginHost;

  const OPERATOR_TOKEN = "wave-target-freeze-hold-operator-token";

  beforeAll(async () => {
    server = await listenTestServer({ operatorToken: OPERATOR_TOKEN });
    host = createInMemoryFakeHost({ autoSucceedAfterMs: 10 * 60_000, forcePhase: {} });
  });

  beforeEach(async () => {
    org = await createTestOrg(server, "wtfreezehold");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    amer = await admin.deploymentTargets.create({ name: `amer-${randomUUID().slice(0, 8)}` });
    apac = await admin.deploymentTargets.create({ name: `apac-${randomUUID().slice(0, 8)}` });
    const topology = await admin.object("release-topology").create({
      name: `two-regions-${randomUUID().slice(0, 8)}`,
      properties: {
        waves: [{ name: "both-regions", mode: "parallel", targets: [amer.id, apac.id] }]
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

  it("carries the covering freeze's summary/scope/endsAt on the held target, leaves its unheld sibling untouched, and counts it on the wave — mixed wave", async () => {
    const app = await componentAt("mixed", [amer, apac]);
    const change = await release("mixed", [app.id]);
    const frozen = await freezeAt(amer.id, "amer-mixed-freeze");

    await tick(3);

    const explained = await admin.changes.explain(change.id);
    const wave = explained.plan!.waves[0]!;
    expect(wave.heldTargetCount).toBe(1);

    const heldTarget = wave.targets.find((t) => t.targetObjectId === app.at(amer))!;
    // THE RAW STATUS STAYS BESIDE THE HOLD — `hold` explains `pending`, it does not replace it.
    expect(heldTarget.status).toBe("pending");
    expect(heldTarget.hold).toBeTruthy();
    expect(heldTarget.hold!.freezes).toHaveLength(1);
    const entry = heldTarget.hold!.freezes[0]!;
    expect(entry.freezeId).toBe(frozen.id);
    // PROPERTY 3 — scope enriched to {objectId, name}, not a bare id.
    expect(entry.scope).toEqual({ objectId: amer.id, name: amer.name });
    // PROPERTY 2 — one server-composed sentence, rendered verbatim.
    expect(entry.summary).toContain("amer-mixed-freeze");
    expect(entry.summary).toContain("until");
    // PROPERTY 4 — endsAt carried, not `now`.
    expect(entry.endsAt).toBe(frozen.endsAt);

    // THE SIBLING SHIPS AND CARRIES NO HOLD AT ALL — a wave target with no covering freeze is
    // absent from the field, never present-with-an-empty-array.
    const sibling = wave.targets.find((t) => t.targetObjectId === app.at(apac))!;
    expect(sibling.hold).toBeUndefined();
    expect(sibling.executorRef).not.toBeNull();
  }, 60_000);

  it("disappears on the very next read once the freeze is lifted — composed live, never from the pinned Decision", async () => {
    const app = await componentAt("lift-read", [amer]);
    const soloTopology = await admin.object("release-topology").create({
      name: `amer-only-${randomUUID().slice(0, 8)}`,
      properties: { waves: [{ name: "amer", mode: "parallel", targets: [amer.id] }] }
    });
    const change = await admin.changes.propose({
      name: `lift-read-${randomUUID().slice(0, 8)}`,
      targets: [app.id],
      topology: soloTopology.id
    });
    const frozen = await freezeAt(amer.id, "amer-lift-read-freeze");

    await tick(3);
    const before = await admin.changes.explain(change.id);
    const heldBefore = before.plan!.waves[0]!.targets.find(
      (t) => t.targetObjectId === app.at(amer)
    )!;
    expect(heldBefore.hold).toBeTruthy();
    expect(before.plan!.waves[0]!.heldTargetCount).toBe(1);

    // LIFT, WITH NO FOLLOW-UP TICK — the whole point: the projection is a live read, not sourced
    // from the `freeze_admission` Decision (which is never cleared) or from any reconcile pass.
    await admin.freezes.lift(frozen.id, { reason: "integration: incident resolved" });

    const after = await admin.changes.explain(change.id);
    const targetAfter = after.plan!.waves[0]!.targets.find(
      (t) => t.targetObjectId === app.at(amer)
    )!;
    expect(targetAfter.hold).toBeUndefined();
    expect(after.plan!.waves[0]!.heldTargetCount).toBe(0);
    // The raw status is untouched by the lift itself — nothing retried until the next tick.
    expect(targetAfter.status).toBe("pending");
  }, 60_000);

  it("reports `scope: null` for a platform-tier freeze — it addresses a stage coordinate, not an object id", async () => {
    const app = await componentAt("platform-scope", [amer]);
    const soloTopology = await admin.object("release-topology").create({
      name: `amer-only-platform-${randomUUID().slice(0, 8)}`,
      properties: { waves: [{ name: "amer", mode: "parallel", targets: [amer.id] }] }
    });
    const change = await admin.changes.propose({
      name: `platform-scope-${randomUUID().slice(0, 8)}`,
      targets: [app.id],
      topology: soloTopology.id
    });
    const key = `platform-scope-freeze-${randomUUID().slice(0, 8)}`;
    await admin.instanceFreezes.put(
      key,
      {
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        reason: "integration: platform-tier freeze",
        match: { allEnvironments: true }
      },
      OPERATOR_TOKEN
    );

    await tick(3);

    const explained = await admin.changes.explain(change.id);
    const target = explained.plan!.waves[0]!.targets.find(
      (t) => t.targetObjectId === app.at(amer)
    )!;
    expect(target.hold).toBeTruthy();
    const entry = target.hold!.freezes[0]!;
    expect(entry.scope).toBeNull();
    expect(entry.summary).toContain("platform tier");

    await admin.instanceFreezes.lift(key, { reason: "cleanup" }, OPERATOR_TOKEN);
  }, 60_000);

  it("an `atomic` freeze covering only an already-succeeded sibling still surfaces on the pending target (M25.UI review finding 2 — atomic drift)", async () => {
    // `reconcile.ts`'s admission asks `evaluateFreezeHolds` about EVERY active-wave target
    // (`activeWave.targets.map((t) => t.targetObjectId)`, `loadFreezeHolds`) — succeeded siblings
    // included — because an `atomic` freeze's union only sees the ids it was asked about. This
    // pins that the READ side (`resolveWaveTargetFreezeHolds`) asks the identical question rather
    // than a narrower one over only the pending subset, which would never even query the succeeded
    // sibling and so could never see the freeze that covers it.
    const fastHost = createInMemoryFakeHost({ autoSucceedAfterMs: 30 });
    const fastTick = async (times = 1) => {
      for (let i = 0; i < times; i++) {
        await reconcileOrgTick(
          server.deps.db,
          org.orgId,
          fastHost,
          server.deps.celSandbox!,
          server.deps.config.secretsMasterKey
        );
      }
    };

    const app = await componentAt("atomic-drift", [amer, apac]);
    // Hold `apac` directly from the first tick, so `amer` — unfrozen — ships and succeeds while
    // `apac` never leaves `pending`.
    const directHold = await freezeAt(apac.id, "apac-atomic-drift-direct-hold");
    const change = await release("atomic-drift", [app.id]);

    await fastTick(2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await fastTick(3);

    const midway = await admin.changes.explain(change.id);
    const amerMid = midway.plan!.waves[0]!.targets.find((t) => t.targetObjectId === app.at(amer))!;
    expect(amerMid.status).toBe("succeeded");
    const apacMid = midway.plan!.waves[0]!.targets.find((t) => t.targetObjectId === app.at(apac))!;
    expect(apacMid.status).toBe("pending");
    expect(apacMid.hold).toBeTruthy();

    // Lift the DIRECT hold on `apac` and declare an ATOMIC freeze over `amer` ONLY — the
    // already-succeeded sibling. `apac` itself is now covered by no freeze directly.
    await admin.freezes.lift(directHold.id, { reason: "integration: replaced by atomic case" });
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createFreeze(tx, {
        orgId: org.orgId,
        scopeObjectId: amer.id,
        name: "amer-atomic-drift",
        startsAt: new Date(Date.now() - 60_000),
        endsAt: new Date(Date.now() + 3_600_000),
        reason: "atomic-drift: integration fixture",
        createdByActorId: org.orgId,
        atomic: true
      })
    );

    await fastTick(3);

    const after = await admin.changes.explain(change.id);
    const wave = after.plan!.waves[0]!;
    const apacAfter = wave.targets.find((t) => t.targetObjectId === app.at(apac))!;
    // THE ATOMIC UNION MUST STILL REACH `apac` — it is held only because `amer`, a target that has
    // ALREADY SUCCEEDED, is covered by an atomic freeze. A read side that asked only about pending
    // targets would never see `amer`'s freeze at all and would report `apac` unheld here.
    expect(apacAfter.hold).toBeTruthy();
    expect(apacAfter.hold!.freezes.some((f) => f.summary.includes("amer-atomic-drift"))).toBe(true);
    // `amer` itself is not reported held — it already succeeded, and a hold cannot act on it.
    const amerAfter = wave.targets.find((t) => t.targetObjectId === app.at(amer))!;
    expect(amerAfter.hold).toBeUndefined();
    expect(wave.heldTargetCount).toBe(1);
  }, 60_000);

  it("evaluates the freeze hold exactly ONCE per tick for one executing change (M25.UI review finding 4 — the laziness invariant)", async () => {
    // `reconcile.ts`'s own doc (`loadFreezeHolds`) claims the freeze hold is resolved LAZILY,
    // inside the trigger branch, so a change with a pending target pays for exactly one
    // evaluation per tick. `advanceExecutingChanges` calls `getLatestPlanForChange`
    // UNCONDITIONALLY before that branch even runs; without `withFreezeHolds: false` there, that
    // call performed a SECOND, full evaluation whose `ChangePlan.hold` shape was thrown away
    // unread — falsifying the very invariant the doc states. Pinned by counting calls to the
    // shared predicate both call sites route through, rather than by reasoning about it.
    // A MIXED (partially-frozen) wave — `amer` frozen, `apac` not — so the wave GATE admits it to
    // `running` (only an ALL-frozen wave is blocked at the gate) and reconcile's per-target trigger
    // branch, and therefore `loadFreezeHolds`, genuinely runs every tick from here on.
    const app = await componentAt("hot-path", [amer, apac]);
    const change = await release("hot-path", [app.id]);
    await freezeAt(amer.id, "amer-hot-path-freeze");

    // Drive the change to `executing`, with the wave already `running`, first — NOT under test —
    // so the spy below counts exactly one tick's worth of work.
    await tick(2);
    const [row] = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ state: changes.state })
        .from(changes)
        .where(and(eq(changes.orgId, org.orgId), eq(changes.objectId, change.id)))
    );
    expect(row!.state, "fixture check: must be executing before the spy is installed").toBe(
      "executing"
    );
    const midway = await admin.changes.explain(change.id);
    expect(
      midway.plan!.waves[0]!.status,
      "fixture check: the wave must be running (mixed, not all-frozen) before the spy is installed"
    ).toBe("running");

    const spy = vi.spyOn(freezeHoldModule, "evaluateFreezeHolds");
    try {
      await tick(1);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  // ============================================================================================
  // NOT COVERED BY THIS FILE (stated rather than left to be discovered):
  //   * `heldTargetCount` merging the STAGE-DEPENDENCY half in with the freeze half — that union
  //     is asserted in `stage-dependency-surfaces.integration.test.ts`'s siblings and this file's
  //     freeze-only cases are deliberately kept orthogonal to ADR-0028's coupling machinery.
  //   * `service-board.ts` and `campaigns.ts`'s own `getLatestCampaignPlan`/`CampaignWaveTarget`
  //     projection — a structurally separate schema (`CampaignWaveTargetSchema`), out of this
  //     increment's stated scope (`ChangeWaveTargetSchema` only).
  // ============================================================================================
});
