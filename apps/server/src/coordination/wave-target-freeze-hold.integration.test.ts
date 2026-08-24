import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
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

  // ============================================================================================
  // NOT COVERED BY THIS FILE (stated rather than left to be discovered):
  //   * `heldTargetCount` merging the STAGE-DEPENDENCY half in with the freeze half — that union
  //     is asserted in `stage-dependency-surfaces.integration.test.ts`'s siblings and this file's
  //     freeze-only cases are deliberately kept orthogonal to ADR-0028's coupling machinery.
  //   * The `atomic` freeze case (a target held only because a SIBLING is covered) — the wire
  //     shape is identical to the direct-coverage case exercised here (`describeFreezeForWaveTarget`
  //     has no branch on `atomic` beyond the trailing clause, already covered by
  //     `freeze-admission.integration.test.ts`'s D5 case at the Decision layer).
  //   * `service-board.ts` and `campaigns.ts`'s own `getLatestCampaignPlan`/`CampaignWaveTarget`
  //     projection — a structurally separate schema (`CampaignWaveTargetSchema`), out of this
  //     increment's stated scope (`ChangeWaveTargetSchema` only).
  // ============================================================================================
});
