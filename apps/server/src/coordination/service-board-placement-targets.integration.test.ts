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

/** THE SERVICE BOARD OVER A STAGE-SHAPED PLAN. See docs/coordination.md §858. */
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
    const component = await createOrphanComponent(server, org, name);
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
