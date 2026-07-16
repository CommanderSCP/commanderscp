import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { listExecutorBindings } from "./executor-bindings-repo.js";

/**
 * M12 P5c — executor-binding primitives (list-for-target / delete / repurpose) and the target-liveness
 * bug fix. Before P5c a binding could be created and read but never DELETED or RELABELLED, and a
 * soft-deleted target's binding was polled by observe() forever (no `executor_bindings.deleted_at`).
 */
describe("executor-binding primitives (M12 P5c)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "binding-primitives");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  const putBinding = (targetId: string, purpose: "infra" | "software") =>
    admin.executors.putBinding(targetId, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${randomUUID().slice(0, 8)}`,
      config: { statePath: "/tmp/x" },
      allowedHosts: [],
      purpose
    });

  it("lists every pipeline bound to a target (both purposes)", async () => {
    const comp = await createTestComponent(admin, { name: `c-${randomUUID().slice(0, 8)}` });
    await putBinding(comp.id, "software");
    await putBinding(comp.id, "infra");

    const items = await admin.executors.listBindings(comp.id);
    expect(items.map((b) => b.purpose).sort()).toEqual(["infra", "software"]);
  });

  it("deletes a binding for one purpose (the detach primitive), leaving the other purpose intact", async () => {
    const comp = await createTestComponent(admin, { name: `c-${randomUUID().slice(0, 8)}` });
    await putBinding(comp.id, "software");
    await putBinding(comp.id, "infra");

    const removed = await admin.executors.deleteBinding(comp.id, "software");
    expect(removed.purpose).toBe("software");

    const items = await admin.executors.listBindings(comp.id);
    expect(items.map((b) => b.purpose)).toEqual(["infra"]);
    await expect(admin.executors.getBinding(comp.id, "software")).rejects.toMatchObject({ status: 404 });
  });

  it("deleting a nonexistent binding is a 404", async () => {
    const comp = await createTestComponent(admin, { name: `c-${randomUUID().slice(0, 8)}` });
    await expect(admin.executors.deleteBinding(comp.id, "infra")).rejects.toMatchObject({ status: 404 });
  });

  it("repurposes a binding (software → infra) — the relabel primitive", async () => {
    const comp = await createTestComponent(admin, { name: `c-${randomUUID().slice(0, 8)}` });
    await putBinding(comp.id, "software");

    const relabelled = await admin.executors.repurposeBinding(comp.id, "infra"); // from defaults to software
    expect(relabelled.purpose).toBe("infra");
    expect((await admin.executors.getBinding(comp.id, "infra")).purpose).toBe("infra");
    await expect(admin.executors.getBinding(comp.id, "software")).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a repurpose that would collide with an existing binding at the target purpose (409)", async () => {
    const comp = await createTestComponent(admin, { name: `c-${randomUUID().slice(0, 8)}` });
    await putBinding(comp.id, "software");
    await putBinding(comp.id, "infra");

    // software → infra would create a 2nd infra binding — UNIQUE(org,target,purpose) forbids it.
    await expect(admin.executors.repurposeBinding(comp.id, "infra", "software")).rejects.toMatchObject({
      status: 409
    });
    // Nothing changed — both purposes still present.
    expect((await admin.executors.listBindings(comp.id)).map((b) => b.purpose).sort()).toEqual([
      "infra",
      "software"
    ]);
  });

  it("LIVENESS FIX: observe's org-wide binding list drops a soft-deleted target's binding (was polled forever)", async () => {
    const comp = await createTestComponent(admin, { name: `c-${randomUUID().slice(0, 8)}` });
    await putBinding(comp.id, "software");
    expect(await admin.executors.listBindings(comp.id)).toHaveLength(1);

    // The binding ROW outlives a soft-deleted target (there is no executor_bindings.deleted_at).
    // Sanity that the observe list DOES include a LIVE target's binding, before deletion.
    const beforeDelete = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listExecutorBindings(tx, org.orgId)
    );
    expect(beforeDelete.some((b) => b.targetObjectId === comp.id)).toBe(true);

    await admin.components.delete(comp.id); // soft-delete

    // The org-wide list is exactly what observe.ts:160 enumerates and polls every tick. Without the
    // liveness filter the gone target's binding would still be here — polled forever. This is THE fix.
    const afterDelete = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      listExecutorBindings(tx, org.orgId)
    );
    expect(afterDelete.some((b) => b.targetObjectId === comp.id)).toBe(false);

    // The target-scoped route 404s outright once its target is soft-deleted (target resolution runs
    // first) — a second, independent reason a gone target surfaces no bindings.
    await expect(admin.executors.listBindings(comp.id)).rejects.toMatchObject({ status: 404 });
  });

  it("delete + repurpose require object:write on the target (a read-only subject is refused)", async () => {
    const comp = await createTestComponent(admin, { name: `c-${randomUUID().slice(0, 8)}` });
    await putBinding(comp.id, "software");

    // Viewer has object:read but not object:write anywhere.
    const viewer = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);
    const client = new ScpClient({ baseUrl: server.baseUrl, token: viewer.token });

    await expect(client.executors.deleteBinding(comp.id, "software")).rejects.toMatchObject({ status: 403 });
    await expect(client.executors.repurposeBinding(comp.id, "infra")).rejects.toMatchObject({ status: 403 });
    // The binding survived both refused writes.
    expect((await admin.executors.listBindings(comp.id)).map((b) => b.purpose)).toEqual(["software"]);
  });
});
