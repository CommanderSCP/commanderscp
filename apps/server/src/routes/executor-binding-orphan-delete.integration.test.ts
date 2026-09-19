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
import { startCliSession, type CliInvocation } from "../test-support/cli-runner.js";

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

  it("addresses the target by its URN — and a PLACEMENT urn contains a SLASH, which is all 19", async () => {
    // Not a hypothetical encoding worry. `graph/integrity-repo.ts` hands the operator `ownerUrn` and
    // the BINDING's row id; it does not return the target's object id, so the cleanup command has no
    // choice but to address the door by URN. Every one of the 19 live orphans is a placement, and a
    // placement's urn is derived as `<component>/<deploymentTarget>` — a literal `/` inside a single
    // path parameter. If the SDK's `encodeURIComponent` and Fastify's route matching disagreed about
    // that, the documented cleanup would 404 on all 19 while every id-addressed test stayed green.
    const comp = await createTestComponent(admin, { name: `urn-${uuidv7().slice(0, 8)}` });
    const target = await admin.deploymentTargets.create({ name: `dt-${uuidv7().slice(0, 8)}` });
    const placement = await admin.placements.create({
      component: comp.id,
      deploymentTarget: target.id
    });
    expect(placement.urn, "the fixture is only meaningful if the urn really has a slash").toContain(
      "/"
    );
    await admin.executors.putBinding(placement.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${uuidv7().slice(0, 8)}`,
      type: "configuration"
    });
    await legacySoftDelete(placement.id);

    const orphan = (await admin.graph.integrity()).orphanExecutorBindings.find(
      (b) => b.ownerUrn === placement.urn
    );
    expect(orphan, "the report is where the operator gets the urn from").toBeDefined();

    // Addressed exactly as the cleanup runbook does: by the urn the report printed.
    const removed = await admin.executors.deleteBinding(orphan!.ownerUrn, "configuration", "build");
    expect(removed.targetObjectId).toBe(placement.id);
  });

  it("THE OPERATOR LOOP, end to end through the CLI: `graph integrity` -> `executor unbind` -> clean", async () => {
    // The whole runbook in one test, because every rung of it was individually plausible and the
    // JOIN between them was the broken part: `scp graph integrity` printed the dead object's NAME,
    // while `scp executor unbind` takes an id-or-URN — so the report could not be piped into its own
    // remedy and the cleanup had to leave the CLI for raw curl. `owner` now carries the urn.
    // Asserting the pair here is the only arrangement in which the report's output and the door's
    // input cannot drift apart again (charter principle 3: the CLI rung has to actually reach it).
    const org2 = await createTestOrg(server, `cli-orphan-${uuidv7().slice(0, 6)}`);
    const cli: CliInvocation = await startCliSession(server.baseUrl);
    try {
      await cli.run(["login", "--username", org2.adminUsername, "--password", org2.adminPassword]);
      const admin2 = new ScpClient({ baseUrl: server.baseUrl, token: org2.adminToken });
      const comp = await createTestComponent(admin2, { name: `cli-${uuidv7().slice(0, 8)}` });
      await admin2.executors.putBinding(comp.id, {
        pluginModule: "fake-executor",
        pluginInstanceId: `inst-${uuidv7().slice(0, 8)}`,
        type: "configuration"
      });
      await withTenantTx(server.deps.db, org2.orgId, (tx) =>
        tx.execute(
          sql`UPDATE objects SET deleted_at = now() WHERE id = ${comp.id}::uuid AND org_id = ${org2.orgId}::uuid`
        )
      );

      type Row = { kind: string; id: string; owner: string; detail: string };
      const report = await cli.runJson<Row[]>(["graph", "integrity"]);
      const orphan = report.find(
        (r) => r.kind === "orphan-executor-binding" && r.owner === comp.urn
      );
      expect(orphan, "the CLI must name the OWNER, which is what the door takes").toBeDefined();
      // `type/lane` is in the detail for the same reason: the door needs both, and the default
      // reaches only `build`.
      expect(orphan!.detail).toContain("configuration/build");

      await cli.run([
        "executor",
        "unbind",
        orphan!.owner,
        "--type",
        "configuration",
        "--lane",
        "build"
      ]);

      const after = await cli.runJson<Row[]>(["graph", "integrity"]);
      expect(
        after.some((r) => r.kind === "orphan-executor-binding" && r.owner === comp.urn),
        "the report the operator verifies with agrees with the door they used"
      ).toBe(false);
    } finally {
      await cli.cleanup();
    }
  });

  /** A fresh org per `--repair` arm. `--repair` is org-scoped and destructive by design, so sharing
   *  the file's org between arms would let one arm's repair consume another's fixture and every
   *  assertion would still pass — the vacuous-green shape. */
  async function repairFixture(tag: string): Promise<{
    cli: CliInvocation;
    admin2: ScpClient;
    orgId: string;
  }> {
    const o = await createTestOrg(server, `repair-${tag}-${uuidv7().slice(0, 6)}`);
    const cli = await startCliSession(server.baseUrl);
    await cli.run(["login", "--username", o.adminUsername, "--password", o.adminPassword]);
    return {
      cli,
      admin2: new ScpClient({ baseUrl: server.baseUrl, token: o.adminToken }),
      orgId: o.orgId
    };
  }

  type Outcome = { outcome: string; count: number };

  it("--repair DELETES an orphaned executor binding and writes its audit event (owner decision 2026-09-19)", async () => {
    // The owner chose FULL repair over the edges-only recommendation, with no prompt and no
    // confirmation flag. What that makes load-bearing is the audited path: `--repair` must go through
    // `executors.deleteBinding` — the same door `scp executor unbind` uses — so the removal is
    // indistinguishable in the audit log from an operator typing the verb. A bulk delete would be a
    // second, unaudited way to destroy execution routes, which is what principle 6 forbids.
    const { cli, admin2, orgId } = await repairFixture("deletes");
    try {
      const comp = await createTestComponent(admin2, { name: `r-${uuidv7().slice(0, 8)}` });
      await admin2.executors.putBinding(comp.id, {
        pluginModule: "fake-executor",
        pluginInstanceId: `inst-${uuidv7().slice(0, 8)}`,
        type: "configuration"
      });
      await withTenantTx(server.deps.db, orgId, (tx) =>
        tx.execute(
          sql`UPDATE objects SET deleted_at = now() WHERE id = ${comp.id}::uuid AND org_id = ${orgId}::uuid`
        )
      );

      const out = await cli.runJson<Outcome[]>(["graph", "integrity", "--repair"]);
      const deletedRow = out.find((r) => r.outcome.startsWith("executor-bindings-deleted"));
      expect(deletedRow?.count, "the route was removed").toBe(1);

      // THE RECORD IS THE MITIGATION, since there is no prompt: a count cannot answer "which
      // pipeline did this detach?". One line per removed route, naming the urn, type and lane.
      const named = out.find((r) => r.outcome.includes("deleted executor binding"));
      expect(named, "a repair run must be reconstructable from its own output").toBeDefined();
      expect(named!.outcome).toContain("configuration/build");
      expect(named!.outcome).toContain(comp.urn);

      // …and the second, independent record: the hash-chained audit log.
      const page = await admin2.auditEvents.list({ limit: 200 });
      expect(
        page.items.filter((e) => e.action === "executor.binding.delete" && e.subjectId === comp.id),
        "one per row, through the ordinary door — never a bulk unaudited delete"
      ).toHaveLength(1);

      expect(
        (await admin2.graph.integrity()).orphanExecutorBindings.some((b) => b.ownerUrn === comp.urn)
      ).toBe(false);
    } finally {
      await cli.cleanup();
    }
  });

  it("--repair SKIPS a policy-managed orphan and says why — repairing one would only race the reconciler", async () => {
    // Kept from the guard's own carve-out, for the same measured reason: the binding reconciler
    // re-derives a managed row every tick from the live placements and `pruneUnwanted` reaps it once
    // the target is a tombstone. Deleting it here is at best redundant and at worst a race, so it is
    // reported and skipped — the shape `DanglingRelationship.repairable: false` already establishes
    // for a replica edge.
    const { cli, admin2, orgId } = await repairFixture("skips");
    try {
      const comp = await createTestComponent(admin2, { name: `m-${uuidv7().slice(0, 8)}` });
      await admin2.executors.putBinding(comp.id, {
        pluginModule: "fake-executor",
        pluginInstanceId: `inst-${uuidv7().slice(0, 8)}`,
        type: "configuration"
      });
      await withTenantTx(server.deps.db, orgId, (tx) =>
        tx.execute(
          sql`UPDATE executor_bindings SET managed_by_policy_id = ${orgId}::uuid
              WHERE org_id = ${orgId}::uuid AND target_object_id = ${comp.id}::uuid`
        )
      );
      await withTenantTx(server.deps.db, orgId, (tx) =>
        tx.execute(
          sql`UPDATE objects SET deleted_at = now() WHERE id = ${comp.id}::uuid AND org_id = ${orgId}::uuid`
        )
      );

      // The report must SAY it is managed, as a structured field — `--repair` reads that, never the
      // detail text, and `targetType`/`lane` come from the same place for the same reason.
      const listed = (await admin2.graph.integrity()).orphanExecutorBindings.find(
        (b) => b.ownerUrn === comp.urn
      );
      expect(listed?.policyManaged, "read off managed_by_policy_id, never inferred").toBe(true);
      expect(listed?.targetType).toBe("configuration");
      expect(listed?.lane).toBe("build");

      const out = await cli.runJson<Outcome[]>(["graph", "integrity", "--repair"]);
      expect(out.find((r) => r.outcome.startsWith("executor-bindings-deleted"))?.count).toBe(0);
      const skipped = out.find((r) => r.outcome.startsWith("policy-managed-bindings-skipped"));
      expect(skipped?.count, "reported, never attempted").toBe(1);
      expect(skipped!.outcome, "and the output states the reason, not just the count").toContain(
        "reconciler"
      );

      // Still there, and still reported — a skip is not a silent drop.
      expect(
        (await admin2.graph.integrity()).orphanExecutorBindings.some((b) => b.ownerUrn === comp.urn)
      ).toBe(true);
    } finally {
      await cli.cleanup();
    }
  });

  it("--repair leaves a LIVE target's binding untouched — the blast radius is structural, not advisory", async () => {
    // The guarantee that makes an unprompted `--repair` tolerable: the loop iterates the REPORT, and
    // a row is only in the report when its target object is already soft-deleted. So no reachable
    // input to this command can name a live pipeline. Asserted directly rather than reasoned about,
    // because "it only touches orphans" is exactly the kind of claim that stays true by accident.
    const { cli, admin2, orgId } = await repairFixture("untouched");
    try {
      const live = await createTestComponent(admin2, { name: `live-${uuidv7().slice(0, 8)}` });
      await admin2.executors.putBinding(live.id, {
        pluginModule: "fake-executor",
        pluginInstanceId: `inst-${uuidv7().slice(0, 8)}`,
        type: "configuration"
      });
      // A SECOND, orphaned binding in the same org, so the run genuinely does work — a repair that
      // deleted nothing at all would pass this test for the wrong reason.
      const dead = await createTestComponent(admin2, { name: `dead-${uuidv7().slice(0, 8)}` });
      await admin2.executors.putBinding(dead.id, {
        pluginModule: "fake-executor",
        pluginInstanceId: `inst-${uuidv7().slice(0, 8)}`,
        type: "configuration"
      });
      await withTenantTx(server.deps.db, orgId, (tx) =>
        tx.execute(
          sql`UPDATE objects SET deleted_at = now() WHERE id = ${dead.id}::uuid AND org_id = ${orgId}::uuid`
        )
      );

      const out = await cli.runJson<Outcome[]>(["graph", "integrity", "--repair"]);
      expect(
        out.find((r) => r.outcome.startsWith("executor-bindings-deleted"))?.count,
        "the orphan went, so the run was not a no-op"
      ).toBe(1);

      const stillBound = await admin2.executors.getBinding(live.id, "configuration");
      expect(stillBound.targetObjectId, "the live pipeline is still bound").toBe(live.id);
      const page = await admin2.auditEvents.list({ limit: 200 });
      expect(
        page.items.filter((e) => e.action === "executor.binding.delete" && e.subjectId === live.id),
        "and nothing was even attempted against it"
      ).toHaveLength(0);
    } finally {
      await cli.cleanup();
    }
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
