import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { compileAndPersistPlan } from "./plan-service.js";
import { buildServiceBoard } from "./service-board.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * THE SERVICE BOARD OVER A STAGE-SHAPED PLAN (ADR-0026).
 *
 * `latestChangeByComponent`'s arm 1 read `t.target_object_id AS component_id` and filtered it
 * against the service's component ids. Under stage-shaped compilation a wave target is a PLACEMENT,
 * so that filter matched nothing, arm 1 returned zero rows for every component, and the board fell
 * through to arm 2 for the whole service.
 *
 * THAT IS NOT A SMALLER ANSWER, IT IS A DIFFERENT KIND OF ANSWER, and it inverts the property the
 * two-arm shape exists to guarantee. Arm 1 is the local OBSERVATION and is authoritative; arm 2 is
 * the declared-targets fallback, an UNKNOWN, whose ordering key is fabricated for a replica. The
 * board's own header records the regression that produced the strict fallback: an honest unknown
 * displacing a real observation, dropping an outpost's `blocked` count to zero. With arm 1 dead,
 * every component is decided by arm 2 again — silently, because the board still renders.
 *
 * This test pins the PRECEDENCE, not the SQL: a component with an older PLANNED change and a newer
 * plan-less one must report the planned change, because that is the one this domain actually
 * observed. Arm 2 alone would report the newer one. So the assertion fails the moment arm 1 stops
 * covering stage-shaped plans — which is exactly the failure being fixed.
 *
 * MUTATION LOG (applied alone, then reverted):
 *
 * | Mutation | Result |
 * |---|---|
 * | arm 1 back to `t.target_object_id AS component_id` + `sqlIn("t.target_object_id", ...)` | "the PLANNED change wins" FAILS — the board reports the newer plan-less change, i.e. arm 2 answering for a component arm 1 must own |
 * | `COALESCE(pl.parent_id, t.target_object_id)` -> `pl.parent_id` alone | the LEGACY-shape test FAILS — a component wave target stops being covered, so the hop must be additive, not a replacement |
 */
describe("service board arm 1 over stage-shaped (placement) wave targets", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let service: GraphObject;
  let place: GraphObject;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "board-placement");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    service = await admin.object("service").create({ name: "agentkit" });
    place = await admin.deploymentTargets.create({ name: "prod (DOKS hosted)" });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function componentOfService(name: string) {
    const component = await createOrphanComponent(admin, name);
    await admin.relationships.create({
      typeId: "contains",
      fromId: service.id,
      toId: component.id
    });
    return component;
  }

  const compile = (changeId: string, targets: string[], topologyObjectId: string | null) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      compileAndPersistPlan(tx, {
        orgId: org.orgId,
        changeObjectId: changeId,
        targetObjectIds: targets,
        topologyObjectId,
        topologyVersion: null
      })
    );

  const board = () =>
    withTenantTx(server.deps.db, org.orgId, async (tx) =>
      buildServiceBoard(tx, org.orgId, await getObjectByIdOrUrnAnyType(tx, org.orgId, service.id))
    );

  it("the PLANNED change wins for a component whose plan is stage-shaped — arm 1 still owns it", async () => {
    const component = await componentOfService("keycloak");
    await admin.placements.create({ component: component.id, deploymentTarget: place.id });
    const topology = await admin.object("release-topology").create({
      name: "prod-only",
      properties: { waves: [{ name: "prod", mode: "parallel", targets: [place.id] }] }
    });

    // OLDER: compiled, stage-shaped. Its wave targets are placements, not this component.
    const planned = await admin.changes.propose({
      name: "planned-release",
      targets: [component.id]
    });
    const plan = await compile(planned.id, [component.id], topology.id);
    expect(
      plan.waves.flatMap((w) => w.targets).map((t) => t.targetObjectId),
      "precondition: the plan really is stage-shaped, so no wave target is the component itself"
    ).not.toContain(component.id);

    // NEWER: no plan at all — an arm-2 candidate that outranks nothing, because arm 1 covers this
    // component and arm 1 is authoritative.
    const declaredOnly = await admin.changes.propose({
      name: "unplanned-later-change",
      targets: [component.id]
    });

    const row = (await board()).rows.find((r) => r.component.id === component.id);
    expect(
      row?.latestChangeId,
      "arm 1 is the local observation and must keep answering for a component whose plan is stage-shaped — falling through to arm 2 lets an unknown displace it"
    ).toBe(planned.id);
    expect(row?.latestChangeId).not.toBe(declaredOnly.id);
    // And the observation is a real one: the wave detail arm 1 exists to surface is present.
    expect(row?.waves.length).toBeGreaterThan(0);
  });

  it("still covers a LEGACY-shaped plan, whose wave targets ARE the component", async () => {
    const component = await componentOfService("umami");

    const planned = await admin.changes.propose({
      name: "legacy-planned-release",
      targets: [component.id]
    });
    const plan = await compile(planned.id, [component.id], null);
    expect(
      plan.waves.flatMap((w) => w.targets).map((t) => t.targetObjectId),
      "precondition: no topology, so this compiles legacy and the wave target IS the component"
    ).toContain(component.id);

    await admin.changes.propose({ name: "legacy-unplanned-later", targets: [component.id] });

    const row = (await board()).rows.find((r) => r.component.id === component.id);
    expect(
      row?.latestChangeId,
      "the placement hop must be additive — the legacy shape reads exactly as it always did"
    ).toBe(planned.id);
  });
});
