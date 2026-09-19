import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { ScpApiError, ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { startCliSession, type CliInvocation } from "../test-support/cli-runner.js";

/** THE AUDITED EXIT FOR AN ORPHANED PLACEMENT. See docs/routes.md §304a. */
describe("a placement whose component or deployment-target was tombstoned under it", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "placement-orphan-delete");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });
  afterAll(async () => {
    await server?.close();
  });

  /** Tombstone the object row beneath the API — the ONLY way to manufacture this state, because
   *  orphan-guard routes 3+4 refuse to delete either end while a live placement names it. Same name
   *  the mapping and binding suites use, so one grep finds every site that makes a pre-guard orphan.
   *
   *  `.slice(-8)` and not `.slice(0, 8)`: a uuidv7's LEADING characters are its millisecond
   *  timestamp, so two fixtures built in the same tick collide on a `urn` unique index and the suite
   *  fails in `beforeEach` with a 409 that looks like the code under test. */
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

  async function seedPlacement(
    tag: string,
    client: ScpClient = admin
  ): Promise<{ comp: GraphObject; dt: GraphObject; placement: GraphObject }> {
    const comp = await createTestComponent(client, { name: `c-${tag}` });
    const dt = await client.deploymentTargets.create({ name: `dt-${tag}` });
    const placement = await client.placements.create({
      component: comp.id,
      deploymentTarget: dt.id
    });
    return { comp, dt, placement };
  }

  it("deletes an orphan placement by ID through the ordinary door — the promise the report makes", async () => {
    // THE MEASUREMENT THIS FILE EXISTS FOR. `graph/integrity-repo.ts` has reported `orphanPlacements`
    // for months and `scp graph integrity` printed every one of them `repairable: true`, but no test
    // had ever walked the repair — the same unproven promise route 6 found on the binding door, where
    // it turned out to be FALSE. Here it is TRUE: `DELETE /placements/{idOrUrn}` resolves the
    // PLACEMENT, not its ends, so a dead component does not hide it. Measured, not assumed — and now
    // pinned, so it stays true.
    const { comp, placement } = await seedPlacement(`id-${uuidv7().slice(-8)}`);
    await legacySoftDelete(comp.id);

    const orphan = (await admin.graph.integrity()).orphanPlacements.find(
      (p) => p.id === placement.id
    );
    expect(orphan, "the report is where the operator finds it").toBeDefined();
    expect(orphan!.deadEnd, "which end died, not just that one did").toBe("component");
    expect(orphan!.repairable).toBe(true);
    expect(orphan!.blockedReason).toBeNull();

    const removed = await admin.placements.delete(placement.id);
    expect(
      removed.deletedAt,
      "a placement delete is a SOFT delete — the tombstone is the record"
    ).not.toBeNull();
    expect(
      (await admin.graph.integrity()).orphanPlacements.some((p) => p.id === placement.id),
      "detection and repair agree"
    ).toBe(false);
  });

  it("deletes an orphan placement by its URN, which contains a SLASH", async () => {
    // A placement urn is derived `urn:scp:<org>:placement:<component>/<deploymentTarget>` (ADR-0026
    // D3), so it carries a literal `/` inside one path parameter. The integrity report hands the
    // operator `ownerUrn`, so if the SDK's encoding and Fastify's route matching disagreed about
    // that, every id-addressed test would stay green while the documented cleanup 404'd on all of
    // them. The DEPLOYMENT-TARGET side is used here so the other `deadEnd` branch is exercised too.
    const { dt, placement } = await seedPlacement(`urn-${uuidv7().slice(-8)}`);
    expect(placement.urn, "the fixture is only meaningful if the urn really has a slash").toContain(
      "/"
    );
    await legacySoftDelete(dt.id);

    const orphan = (await admin.graph.integrity()).orphanPlacements.find(
      (p) => p.id === placement.id
    );
    expect(orphan!.deadEnd).toBe("deployment-target");

    const removed = await admin.placements.delete(orphan!.ownerUrn);
    expect(removed.id).toBe(placement.id);
  });

  it("reports `both` when the estate pass took out each end, and still deletes it", async () => {
    const { comp, dt, placement } = await seedPlacement(`both-${uuidv7().slice(-8)}`);
    await legacySoftDelete(comp.id);
    await legacySoftDelete(dt.id);

    const orphan = (await admin.graph.integrity()).orphanPlacements.find(
      (p) => p.id === placement.id
    );
    expect(orphan!.deadEnd).toBe("both");
    expect(orphan!.detail).toContain("component and deployment-target");
    expect((await admin.placements.delete(placement.id)).id).toBe(placement.id);
  });

  it("writes a placement.delete audit event for the orphan, in the same transaction", async () => {
    // Charter principle 6. It matters most here: both ends are already tombstones, so there is no
    // other object whose revision records that the coordination route was withdrawn.
    const { comp, placement } = await seedPlacement(`audit-${uuidv7().slice(-8)}`);
    await legacySoftDelete(comp.id);
    await admin.placements.delete(placement.id);

    const page = await admin.auditEvents.list({ limit: 200 });
    const events = page.items.filter(
      (e) => e.action === "placement.delete" && e.subjectId === placement.id
    );
    expect(events, "removing an orphan is an action, not a cleanup").toHaveLength(1);
  });

  it("a MALFORMED placement is reported rather than skipped — and does not 500 the whole report", async () => {
    // TWO defects in one row, and the second is the dangerous one. The arm used to `continue` past a
    // placement that did not name two ids, so it appeared in NO arm of the report and the estate read
    // as healthy. Worse, the ids it DID find went into an `IN (…)` list against a `uuid` column, so a
    // non-uuid value raised `invalid input syntax for type uuid` and the whole endpoint 500'd — the
    // one endpoint whose job is to find malformed rows, taken out by a malformed row, hiding every
    // OTHER finding in the org at the same time.
    const { comp, placement } = await seedPlacement(`bad-${uuidv7().slice(-8)}`);
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute(
        sql`UPDATE objects SET properties = jsonb_build_object('componentId', 'not-a-uuid'::text, 'deploymentTargetId', ${comp.id}::text) WHERE id = ${placement.id}::uuid AND org_id = ${org.orgId}::uuid`
      )
    );

    const report = await admin.graph.integrity();
    const orphan = report.orphanPlacements.find((p) => p.id === placement.id);
    expect(orphan, "a row nothing can explain is the one most worth showing").toBeDefined();
    expect(orphan!.deadEnd).toBe("malformed");
    expect(orphan!.repairable, "and it still has a door").toBe(true);
    await admin.placements.delete(placement.id);
  });

  it("is NOT repairable while an executor binding names it — route 6 would refuse, so the report says so", async () => {
    // The shape the live estate actually produced: the binding sits on the PLACEMENT. Route 6 refuses
    // to tombstone any object an unmanaged binding targets, so a report that offered this row as
    // repairable would hand `--repair` a guaranteed 409. Both halves are asserted in one test — the
    // claim and the door's real answer — because that is the only arrangement in which they cannot
    // drift apart.
    const tag = `bind-${uuidv7().slice(-8)}`;
    const { comp, placement } = await seedPlacement(tag);
    await admin.executors.putBinding(placement.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${tag}`,
      type: "configuration"
    });
    await legacySoftDelete(comp.id);

    const orphan = (await admin.graph.integrity()).orphanPlacements.find(
      (p) => p.id === placement.id
    );
    expect(orphan!.repairable).toBe(false);
    // The reason must name the command that unblocks it, with BOTH addressing dimensions — `?lane=`
    // defaults to `build`, so a reason without the lane names a row the operator cannot address.
    expect(orphan!.blockedReason).toContain("scp executor unbind");
    expect(orphan!.blockedReason).toContain("--type configuration");
    expect(orphan!.blockedReason).toContain("--lane build");

    await expect(
      admin.placements.delete(placement.id),
      "the report's claim and the door's answer are the same fact"
    ).rejects.toBeInstanceOf(ScpApiError);

    // …and the reason it printed is a working instruction, not a description.
    await admin.executors.deleteBinding(placement.urn, "configuration", "build");
    const after = (await admin.graph.integrity()).orphanPlacements.find(
      (p) => p.id === placement.id
    );
    expect(after!.repairable).toBe(true);
    expect((await admin.placements.delete(placement.id)).id).toBe(placement.id);
  });

  it("a POLICY-MANAGED binding does NOT block it — the report must claim exactly what route 6 refuses", async () => {
    // The carve-out has to be made TWICE, in the guard and in the report, and a report that made it
    // differently would be its own kind of lie: route 6 exempts a policy-managed binding (refusing one
    // would livelock against the reconciler that re-creates it), so a placement whose only binding is
    // managed deletes fine — and calling it blocked would strand it in `--repair` forever with a
    // reason naming an unbind the operator must not perform. Asserted through the door as well as the
    // report, because "they agree" is the claim.
    const tag = `mbind-${uuidv7().slice(-8)}`;
    const { comp, placement } = await seedPlacement(tag);
    await admin.executors.putBinding(placement.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${tag}`,
      type: "configuration"
    });
    // No route sets `managed_by_policy_id` — the reconciler is its only writer — so the fixture writes
    // it the way the reconciler would. The org root serves as the policy id (a plain uuid, no FK).
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute(
        sql`UPDATE executor_bindings SET managed_by_policy_id = ${org.orgId}::uuid WHERE org_id = ${org.orgId}::uuid AND target_object_id = ${placement.id}::uuid`
      )
    );
    await legacySoftDelete(comp.id);

    const orphan = (await admin.graph.integrity()).orphanPlacements.find(
      (p) => p.id === placement.id
    );
    expect(orphan!.repairable, "route 6 would not refuse this, so neither may the report").toBe(
      true
    );
    expect(orphan!.blockedReason).toBeNull();
    expect((await admin.placements.delete(placement.id)).id).toBe(placement.id);
  });

  it("is NOT repairable when the stack owns it — the IaC apply is its reaper, and racing it is churn", async () => {
    // The same carve-out route 6 makes for a policy-managed binding, one table over. `managed_by_stack`
    // means the next `scp iac apply` of that stack re-derives this object from the manifest; a repair
    // run that deleted it by hand would either be undone on the next apply or turn up as a surprise
    // deletion in someone's plan. A row with a reaper is not the operator's job.
    const tag = `stack-${uuidv7().slice(-8)}`;
    const { comp, placement } = await seedPlacement(tag);
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute(
        sql`UPDATE objects SET managed_by_stack = 'platform' WHERE id = ${placement.id}::uuid AND org_id = ${org.orgId}::uuid`
      )
    );
    await legacySoftDelete(comp.id);

    const orphan = (await admin.graph.integrity()).orphanPlacements.find(
      (p) => p.id === placement.id
    );
    expect(orphan!.repairable).toBe(false);
    expect(orphan!.blockedReason).toContain("platform");
    expect(orphan!.blockedReason).toContain("iac apply");
    // NOT "cannot" — the door would take it. The report withholds it from `--repair`; an operator who
    // decides otherwise still has `scp placement withdraw`.
    expect((await admin.placements.delete(placement.id)).id).toBe(placement.id);
  });

  it("is NOT repairable when it is a REPLICA — single-writer authority refuses a local delete", async () => {
    // Exactly the rule the dangling-edge arm has carried since it was written, applied to the arm that
    // never got it. A replica placement's delete is refused by `deleteObject`, so offering it as
    // actionable makes a repair run fail partway through on a row it can never fix.
    const { comp, placement } = await seedPlacement(`replica-${uuidv7().slice(-8)}`);
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute(
        sql`UPDATE objects SET origin_domain_id = gen_random_uuid() WHERE id = ${placement.id}::uuid AND org_id = ${org.orgId}::uuid`
      )
    );
    await legacySoftDelete(comp.id);

    const orphan = (await admin.graph.integrity()).orphanPlacements.find(
      (p) => p.id === placement.id
    );
    expect(orphan, "still REPORTED — the operator must know it is there").toBeDefined();
    expect(orphan!.repairable, "but never offered as actionable").toBe(false);
    expect(orphan!.blockedReason).toContain("read-only replica");

    await expect(admin.placements.delete(placement.id)).rejects.toBeInstanceOf(ScpApiError);
  });

  it("THE OPERATOR LOOP through the real CLI: `graph integrity` -> `--repair` -> clean", async () => {
    // The whole runbook in one test. `--repair` used to delete only edges and print
    // "projection-rows-left (no id-addressed door)" over the placement count — a sentence that was
    // simply false for this arm, since a placement IS id-addressed. Driving it through the CLI binary
    // is the only rung that proves the JSON the server emits and the flags the command takes agree;
    // a `pnpm check` is blind to both.
    const org2 = await createTestOrg(server, `cli-pl-${uuidv7().slice(-6)}`);
    const cli: CliInvocation = await startCliSession(server.baseUrl);
    try {
      await cli.run(["login", "--username", org2.adminUsername, "--password", org2.adminPassword]);
      const admin2 = new ScpClient({ baseUrl: server.baseUrl, token: org2.adminToken });

      const tag = `loop-${uuidv7().slice(-8)}`;
      const comp = await createTestComponent(admin2, { name: `c-${tag}` });
      const dt = await admin2.deploymentTargets.create({ name: `dt-${tag}` });
      const doomed = await admin2.placements.create({
        component: comp.id,
        deploymentTarget: dt.id
      });
      // …and a second one the repair must LEAVE, with its reason printed.
      const comp2 = await createTestComponent(admin2, { name: `c2-${tag}` });
      const dt2 = await admin2.deploymentTargets.create({ name: `dt2-${tag}` });
      const kept = await admin2.placements.create({
        component: comp2.id,
        deploymentTarget: dt2.id
      });
      await admin2.executors.putBinding(kept.id, {
        pluginModule: "fake-executor",
        pluginInstanceId: `inst-${tag}`,
        type: "configuration"
      });
      for (const id of [comp.id, comp2.id]) {
        await withTenantTx(server.deps.db, org2.orgId, (tx) =>
          tx.execute(
            sql`UPDATE objects SET deleted_at = now() WHERE id = ${id}::uuid AND org_id = ${org2.orgId}::uuid`
          )
        );
      }

      type Row = { kind: string; id: string; owner: string; detail: string; repairable: string };
      const report = await cli.runJson<Row[]>(["graph", "integrity"]);
      const doomedRow = report.find((r) => r.kind === "orphan-placement" && r.id === doomed.id);
      const keptRow = report.find((r) => r.kind === "orphan-placement" && r.id === kept.id);
      expect(doomedRow!.owner, "the CLI prints the urn, which is what the door takes").toBe(
        doomed.urn
      );
      expect(keptRow!.detail, "a blocked row explains itself in the report too").toContain(
        "blocked:"
      );

      type Outcome = { outcome: string; count: string };
      const repaired = await cli.runJson<Outcome[]>(["graph", "integrity", "--repair"]);
      // PRINTED, not merely counted: a receipt that says "1 deleted" leaves the operator unable to
      // name which placement is gone, and a placement's urn is the only handle to re-declare it.
      expect(
        repaired.some((o) => o.outcome === `placement-deleted ${doomed.urn} (component dead)`)
      ).toBe(true);
      expect(repaired.some((o) => o.outcome.startsWith(`placement-skipped ${kept.urn}:`))).toBe(
        true
      );
      expect(
        repaired.some((o) => o.outcome.includes("no id-addressed door")),
        "and the only arm left under 'no id-addressed door' is source mappings, which is true of them"
      ).toBe(true);
      expect(
        repaired.some((o) => o.outcome.startsWith("source-mapping-rows-left")),
        "the leftover line now names the ONE arm it is actually true of"
      ).toBe(true);

      const after = await cli.runJson<Row[]>(["graph", "integrity"]);
      expect(after.some((r) => r.id === doomed.id)).toBe(false);
      expect(
        after.some((r) => r.id === kept.id),
        "the blocked row is still there"
      ).toBe(true);
    } finally {
      await cli.cleanup();
    }
  });
});
