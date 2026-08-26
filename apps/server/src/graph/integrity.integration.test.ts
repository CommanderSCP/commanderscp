import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { and, eq, sql } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";

/**
 * GRAPH INTEGRITY REPORT + repair through the ordinary doors.
 *
 * ============================================================================================
 * THE FIXTURE HAS TO FORGE LEGACY DATA, AND THAT IS THE POINT
 * ============================================================================================
 * `deleteObject` now CASCADES, so the normal door can no longer produce a dangling edge — which is
 * exactly why the backlog needs a report rather than a guard. To test the report at all, the
 * fixture must soft-delete an object the way the pre-cascade code did: an UPDATE of `deleted_at`
 * alone, leaving the edges live.
 *
 * That write happens AFTER the creating requests have committed, and the row is read back to prove
 * it took effect. A fixture that silently updates nothing would leave this suite measuring an
 * intact graph and passing for the wrong reason.
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | report only `from`-side deaths | the `to`-side test FAILS (`owns` edges on the live estate are all to-side) |
 * | mark replica edges `repairable: true` | the replica test FAILS — repair would attempt a row `deleteRelationship` refuses |
 * | drop the `deleted_at is not null` filter on orphan mappings | the orphan-mapping test FAILS. It did NOT fail before that test existed — the first pass of this file had no mapping coverage at all, and the mutation exposed the hole rather than the code |
 */
describe("graph integrity report", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "graph-integrity");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });
  afterAll(async () => {
    await server?.close();
  });

  /** Soft-delete the PRE-CASCADE way: tombstone the object row only, leaving its edges live. */
  async function legacySoftDelete(objectId: string) {
    const updated = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx
        .update(objects)
        .set({ deletedAt: new Date() })
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, objectId)));
      return tx
        .select({ id: objects.id, deletedAt: objects.deletedAt })
        .from(objects)
        .where(eq(objects.id, objectId));
    });
    // The fixture must be PROVEN to have applied — see the header.
    expect(updated[0]?.deletedAt, "fixture soft-delete must actually have landed").not.toBeNull();
  }

  /** A service containing a component, plus the `contains` edge between them. Uses the TYPED doors
   *  (the only ones the SDK exposes), so the fixture is built exactly as an operator would build it. */
  async function seedPair(tag: string) {
    const svc = await admin.objects.service.create(`svc-${tag}`);
    const comp = await admin.components.create({
      name: `api-${tag}`,
      service: svc.id
    });
    const edge = await admin.relationships.list({ fromId: svc.id, typeId: "contains" });
    const contains = edge.items.find((e) => e.toId === comp.id);
    if (!contains) throw new Error("fixture: the component's `contains` edge was not created");
    return { svc, comp, edge: contains };
  }

  it("reports NOTHING for a healthy org", async () => {
    const { svc } = await seedPair(`gi-clean-${uuidv7().slice(0, 8)}`);
    const report = await admin.graph.integrity();
    const mine = report.danglingRelationships.filter((r) => r.fromUrn === svc.urn);
    expect(mine, "a live service with a live component strands nothing").toHaveLength(0);
  });

  it("finds an edge whose FROM object is dead", async () => {
    const { svc, comp, edge } = await seedPair(`gi-from-${uuidv7().slice(0, 8)}`);
    await legacySoftDelete(svc.id);

    const report = await admin.graph.integrity();
    const found = report.danglingRelationships.find((r) => r.id === edge.id);
    expect(found, "the edge outlived its `from` object").toBeDefined();
    expect(found!.deadEnd).toBe("from");
    expect(found!.toUrn).toBe(comp.urn);
    expect(found!.repairable, "a locally-authored edge is repairable").toBe(true);
  });

  it("finds an edge whose TO object is dead", async () => {
    // Not symmetry for its own sake: on the live estate every stranded `owns` edge is to-side, so a
    // report that only looked at `from` would have missed 10 of the 52 rows and looked complete.
    const { comp, edge } = await seedPair(`gi-to-${uuidv7().slice(0, 8)}`);
    await legacySoftDelete(comp.id);

    const report = await admin.graph.integrity();
    const found = report.danglingRelationships.find((r) => r.id === edge.id);
    expect(found).toBeDefined();
    expect(found!.deadEnd).toBe("to");
  });

  it("reports `both` when the delete took out each end", async () => {
    const { svc, comp, edge } = await seedPair(`gi-both-${uuidv7().slice(0, 8)}`);
    await legacySoftDelete(svc.id);
    await legacySoftDelete(comp.id);

    const report = await admin.graph.integrity();
    expect(report.danglingRelationships.find((r) => r.id === edge.id)!.deadEnd).toBe("both");
  });

  it("marks a REPLICA edge unrepairable rather than offering it up", async () => {
    // `deleteRelationship` refuses a replica (single-writer authority), so a repair run that treated
    // it as actionable would fail partway through on a row it can never fix.
    const { svc, edge } = await seedPair(`gi-replica-${uuidv7().slice(0, 8)}`);
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(relationships)
        .set({ originDomainId: sql`gen_random_uuid()` })
        .where(and(eq(relationships.orgId, org.orgId), eq(relationships.id, edge.id)))
    );
    await legacySoftDelete(svc.id);

    const report = await admin.graph.integrity();
    const found = report.danglingRelationships.find((r) => r.id === edge.id);
    expect(found, "still REPORTED — the operator must know it is there").toBeDefined();
    expect(found!.repairable, "but never offered as actionable").toBe(false);
  });

  it("finds an orphan SOURCE MAPPING, and repairs it through the mappings door", async () => {
    // The 12 rows the post-import-configuration.md §6 pair merges stranded on the live estate are
    // exactly this shape.
    // Detection of them was UNPROVEN until this test existed: dropping the `deleted_at` filter from
    // the mapping query failed nothing, because no case exercised it.
    const tag = `gi-map-${uuidv7().slice(0, 8)}`;
    const { comp } = await seedPair(tag);
    await admin.changeSources.createMapping("github", {
      component: comp.id,
      repoPattern: `AgentKitProject/${tag}`,
      type: "configuration"
    });

    expect(
      (await admin.graph.integrity()).orphanSourceMappings.some((m) => m.ownerUrn === comp.urn),
      "a mapping on a LIVE component is not an orphan"
    ).toBe(false);

    await legacySoftDelete(comp.id);

    const orphans = (await admin.graph.integrity()).orphanSourceMappings.filter(
      (m) => m.ownerUrn === comp.urn
    );
    expect(orphans, "now the component is dead and the mapping outlived it").toHaveLength(1);
    expect(orphans[0]!.detail).toContain(`AgentKitProject/${tag}`);

    // The delete door resolves the component with `includeDeleted: true` precisely so this works.
    const removed = await admin.changeSources.deleteMapping("github", {
      component: comp.id,
      repoPattern: `AgentKitProject/${tag}`,
      pathPattern: null,
      type: "configuration"
    });
    expect(removed.deleted).toBe(1);
    expect(
      (await admin.graph.integrity()).orphanSourceMappings.some((m) => m.ownerUrn === comp.urn),
      "detection and repair agree"
    ).toBe(false);
  });

  it("REPAIRS a dangling edge through the ordinary DELETE door, which is what makes it audited", async () => {
    // The question this answers: `DELETE /relationships/{id}` authorizes at BOTH endpoints, and one
    // of them is deleted. If authorization could not resolve a dead scope object, repair would be
    // impossible through the audited door and the only remaining option would be raw SQL — which
    // writes no audit event and no journal entry.
    const { svc, edge } = await seedPair(`gi-repair-${uuidv7().slice(0, 8)}`);
    await legacySoftDelete(svc.id);

    expect(
      (await admin.graph.integrity()).danglingRelationships.some((r) => r.id === edge.id)
    ).toBe(true);

    await admin.relationships.delete(edge.id);

    expect(
      (await admin.graph.integrity()).danglingRelationships.some((r) => r.id === edge.id),
      "and the report is clean afterwards — detection and repair agree"
    ).toBe(false);
  });
});
