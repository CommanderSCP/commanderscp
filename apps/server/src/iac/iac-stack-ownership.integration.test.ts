import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DesiredStateManifest, Plan, PlanDiff } from "@scp/schemas";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * REPRODUCTION (temporary — becomes the regression suite once the guard lands).
 *
 * The property: a governance decision whose match key is writable by its own subject, at a weaker
 * permission than the one that authored the constraint. Here the decision is the IaC PRUNE POOL —
 * which live objects an apply DELETES — and the match key is the `scp:managed-by`/`scp:stack` pair
 * in the object's own tenant-writable `labels` map.
 */
describe("REPRO: IaC stack ownership lives in tenant-writable labels", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "iac-stack-own");
  });

  afterAll(async () => {
    await server.close();
  });

  async function call(
    token: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    payload?: unknown
  ) {
    const res = await server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload })
    });
    return res;
  }

  async function applyManifest(manifest: DesiredStateManifest): Promise<PlanDiff> {
    const planRes = await call(org.adminToken, "POST", "/api/v1/plans", { manifest });
    expect(planRes.statusCode).toBe(201);
    const plan = planRes.json() as Plan;
    const applyRes = await call(org.adminToken, "POST", `/api/v1/plans/${plan.id}/apply`, {});
    expect(applyRes.statusCode).toBe(200);
    return plan.diff;
  }

  async function planOnly(manifest: DesiredStateManifest): Promise<PlanDiff> {
    const planRes = await call(org.adminToken, "POST", "/api/v1/plans", { manifest });
    expect(planRes.statusCode).toBe(201);
    return (planRes.json() as Plan).diff;
  }

  it("R1 ENROLMENT: `object:write` at one object drags it into another stack's prune pool, and the apply deletes it", async () => {
    const stackName = `stack-${randomUUID().slice(0, 8)}`;
    const declaredUrn = `urn:scp:${stackName}:service:declared`;
    const victimUrn = `urn:scp:${stackName}-victim:service:victim`;

    // The stack's real desired state — it names ONE object and never mentions the victim.
    const manifest: DesiredStateManifest = {
      stackName,
      objects: [
        {
          urn: declaredUrn,
          typeId: "service",
          name: "Declared",
          properties: {},
          labels: {}
        }
      ],
      relationships: []
    };
    const firstDiff = await applyManifest(manifest);
    expect(firstDiff.summary).toEqual({ creates: 1, updates: 0, deletes: 0, noops: 0 });

    // A victim object created OUTSIDE the stack, by someone else.
    const created = await call(org.adminToken, "PUT", `/api/v1/objects/service/${victimUrn}`, {
      name: "Victim"
    });
    expect(created.statusCode).toBe(201);
    const victim = created.json() as { id: string; labels: Record<string, unknown> };
    expect(victim.labels).toEqual({});

    // The attacker: an Operator bound at the VICTIM object only — `object:write` there and
    // nowhere else. No IaC authority, no manifest, no plan permission.
    const attacker = await createTestUser(server, org, [{ role: "Operator", scope: victim.id }]);

    // A plan re-computed right now proposes nothing.
    const cleanDiff = await planOnly(manifest);
    expect(cleanDiff.summary).toEqual({ creates: 0, updates: 0, deletes: 0, noops: 1 });

    // THE WRITE. One PATCH of `labels` through the ordinary generic object door.
    const relabel = await call(attacker.token, "PATCH", `/api/v1/objects/service/${victim.id}`, {
      labels: { "scp:managed-by": "iac", "scp:stack": stackName }
    });
    // eslint-disable-next-line no-console
    console.log("R1 relabel status:", relabel.statusCode, relabel.body.slice(0, 300));
    expect(relabel.statusCode).toBe(200);

    // The stack's UNCHANGED manifest now proposes deleting an object it never managed.
    const poisonedDiff = await planOnly(manifest);
    // eslint-disable-next-line no-console
    console.log("R1 poisoned diff:", JSON.stringify(poisonedDiff.objects, null, 2));
    const deleteEntry = poisonedDiff.objects.find((o) => o.action === "delete");
    expect(deleteEntry?.urn).toBe(victimUrn);
    expect(poisonedDiff.summary.deletes).toBe(1);

    // And the apply executes it.
    await applyManifest(manifest);
    const after = await call(org.adminToken, "GET", `/api/v1/objects/service/${victim.id}`);
    // eslint-disable-next-line no-console
    console.log("R1 victim after apply:", after.statusCode, after.body.slice(0, 200));
    expect(after.statusCode).toBe(404);
  });

  it("R2 ESCAPE: removing the labels orphans the object — a later prune is silently NOT proposed", async () => {
    const stackName = `stack-${randomUUID().slice(0, 8)}`;
    const keptUrn = `urn:scp:${stackName}:service:kept`;
    const escaperUrn = `urn:scp:${stackName}:service:escaper`;

    const full: DesiredStateManifest = {
      stackName,
      objects: [
        { urn: keptUrn, typeId: "service", name: "Kept", properties: {}, labels: {} },
        { urn: escaperUrn, typeId: "service", name: "Escaper", properties: {}, labels: {} }
      ],
      relationships: []
    };
    await applyManifest(full);

    const escaperRes = await call(org.adminToken, "GET", `/api/v1/objects/service/${escaperUrn}`);
    const escaper = escaperRes.json() as { id: string; labels: Record<string, unknown> };
    expect(escaper.labels).toMatchObject({ "scp:managed-by": "iac", "scp:stack": stackName });

    const attacker = await createTestUser(server, org, [{ role: "Operator", scope: escaper.id }]);

    // THE WRITE — a full-replacement `labels: {}` through PATCH.
    const strip = await call(attacker.token, "PATCH", `/api/v1/objects/service/${escaper.id}`, {
      labels: {}
    });
    // eslint-disable-next-line no-console
    console.log("R2 strip status:", strip.statusCode, strip.body.slice(0, 300));
    expect(strip.statusCode).toBe(200);

    // The stack author now DECOMMISSIONS the object by removing it from the manifest.
    const shrunk: DesiredStateManifest = {
      stackName,
      objects: [{ urn: keptUrn, typeId: "service", name: "Kept", properties: {}, labels: {} }],
      relationships: []
    };
    const diff = await planOnly(shrunk);
    // eslint-disable-next-line no-console
    console.log("R2 decommission diff:", JSON.stringify(diff.summary), JSON.stringify(diff.objects));
    // FAIL-OPEN: no delete is proposed. The object silently survives its own decommission.
    expect(diff.summary.deletes).toBe(0);

    await applyManifest(shrunk);
    const stillThere = await call(org.adminToken, "GET", `/api/v1/objects/service/${escaperUrn}`);
    expect(stillThere.statusCode).toBe(200);
  });

  it("R3 FAIL DIRECTION: an object with NO markers at all is never a delete candidate", async () => {
    const stackName = `stack-${randomUUID().slice(0, 8)}`;
    const declaredUrn = `urn:scp:${stackName}:service:declared`;
    const bystanderUrn = `urn:scp:${stackName}-by:service:bystander`;

    const manifest: DesiredStateManifest = {
      stackName,
      objects: [
        { urn: declaredUrn, typeId: "service", name: "Declared", properties: {}, labels: {} }
      ],
      relationships: []
    };
    await applyManifest(manifest);

    const created = await call(org.adminToken, "PUT", `/api/v1/objects/service/${bystanderUrn}`, {
      name: "Bystander"
    });
    expect(created.statusCode).toBe(201);

    const diff = await planOnly(manifest);
    expect(diff.summary.deletes).toBe(0);
  });
});
