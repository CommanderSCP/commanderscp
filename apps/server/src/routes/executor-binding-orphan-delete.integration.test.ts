import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { ScpApiError, ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** THE AUDITED EXIT FOR A STRANDED EXECUTOR BINDING. See docs/routes.md §161a. */
describe("deleting an executor binding that outlived its target", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "binding-orphan-delete");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  /** Tombstone the object row beneath the API. The same name `graph/integrity.integration.test.ts`
   *  and the mapping suite use, so one grep finds every site that manufactures a pre-guard orphan —
   *  which is now the ONLY way to make one, because `deleteObject` route 6 refuses it. */
  async function legacySoftDelete(objectId: string): Promise<void> {
    const rows = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx.execute(
        sql`UPDATE objects SET deleted_at = now() WHERE id = ${objectId}::uuid AND org_id = ${org.orgId}::uuid`
      );
      return tx.execute(
        sql`SELECT deleted_at FROM objects WHERE id = ${objectId}::uuid AND org_id = ${org.orgId}::uuid`
      );
    });
    const row = (rows as unknown as { rows: { deleted_at: unknown }[] }).rows[0];
    expect(row?.deleted_at, "fixture soft-delete must actually have landed").not.toBeNull();
  }

  it("deletes a binding STRANDED on a soft-deleted target — the 19 rows this exists for", async () => {
    // MEASURED on the live homelab 2026-09-19: 19 bindings on placements tombstoned by
    // `placement.delete` on 2026-09-11. Route 6 stops new ones; these already exist, and before this
    // change the door answered 404 on every one of them — `getObjectByIdOrUrnAnyType` resolved the
    // target live-only, so the rows most in need of cleanup were exactly the ones nothing could
    // clean. `scp graph integrity` printed them as `repairable: true` the whole time.
    const doomed = await createTestComponent(admin, { name: `stranded-${uuidv7().slice(0, 8)}` });
    await admin.executors.putBinding(doomed.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${uuidv7().slice(0, 8)}`,
      type: "configuration"
    });
    await legacySoftDelete(doomed.id);

    const removed = await admin.executors.deleteBinding(doomed.id, "configuration");
    expect(removed.targetObjectId).toBe(doomed.id);
    expect(
      (await admin.graph.integrity()).orphanExecutorBindings.some((b) => b.id === removed.id),
      "detection and repair agree"
    ).toBe(false);
  });

  it("writes an executor.binding.delete audit event for the stranded row, in the same transaction", async () => {
    // A hard delete of a binding leaves nothing behind — no row, no tombstone, no `deleted_at` — so
    // the audit event is the only surviving record that the route existed and who removed it
    // (charter principle 6). It matters MOST here: the subject is already a tombstone, so there is
    // not even an object revision to read the change off.
    const doomed = await createTestComponent(admin, { name: `audited-${uuidv7().slice(0, 8)}` });
    await admin.executors.putBinding(doomed.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${uuidv7().slice(0, 8)}`,
      type: "configuration"
    });
    await legacySoftDelete(doomed.id);
    await admin.executors.deleteBinding(doomed.id, "configuration");

    const page = await admin.auditEvents.list({ limit: 200 });
    const events = page.items.filter(
      (e) => e.action === "executor.binding.delete" && e.subjectId === doomed.id
    );
    expect(events, "the removal of a stranded row is an action, not a cleanup").toHaveLength(1);
    expect(events[0]!.reason).toContain("fake-executor");
  });

  it("reaches a TEST-lane binding, which `?lane=` was the only way to address", async () => {
    // `executor_bindings` is keyed `(org, target, type, lane)` and the binding-policy reconciler
    // writes `test`-lane rows, but the DELETE handler passed no lane at all, so
    // `deleteExecutorBinding`'s `build` default made every test-lane row undeletable through the
    // API. That was survivable while nothing refused a delete over a binding; with route 6 in place
    // it would have been a WALL — the guard refusing an object whose binding no door could remove.
    const comp = await createTestComponent(admin, { name: `lane-${uuidv7().slice(0, 8)}` });
    await admin.executors.putBinding(comp.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${uuidv7().slice(0, 8)}`,
      type: "configuration"
    });
    // Only the reconciler writes a `test` lane, so the fixture writes it the way the reconciler
    // would rather than pretending a route exists.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute(
        sql`UPDATE executor_bindings SET lane = 'test' WHERE org_id = ${org.orgId}::uuid AND target_object_id = ${comp.id}::uuid`
      )
    );

    await expect(
      admin.executors.deleteBinding(comp.id, "configuration"),
      "the default lane is build, and there is no build row"
    ).rejects.toBeInstanceOf(ScpApiError);

    const removed = await admin.executors.deleteBinding(comp.id, "configuration", "test");
    expect(removed.targetObjectId).toBe(comp.id);
  });

  it("CREATING a binding on a soft-deleted target is still refused — removal reaches further than creation", async () => {
    // The asymmetry is deliberate and is the same one the mapping doors carry. `includeDeleted` went
    // on the DELETE handler alone; a PUT that accepted a tombstone would let an operator mint the
    // very orphan route 6 exists to prevent.
    const doomed = await createTestComponent(admin, { name: `no-mint-${uuidv7().slice(0, 8)}` });
    await legacySoftDelete(doomed.id);

    await expect(
      admin.executors.putBinding(doomed.id, {
        pluginModule: "fake-executor",
        pluginInstanceId: `inst-${uuidv7().slice(0, 8)}`,
        type: "configuration"
      })
    ).rejects.toBeInstanceOf(ScpApiError);
  });
});
