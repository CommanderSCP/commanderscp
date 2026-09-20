import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { ScpApiError, ScpClient } from "@scp/sdk";
import { Service, Stack } from "@scp/coordination-as-code";
import { withTenantTx } from "../db/tenant-tx.js";
import { relationships } from "../db/schema.js";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * `relationships.managed_by_stack` AND THE DANGLING-EDGE ARM. See docs/graph.md §125e.
 *
 * THE QUESTION THIS FILE SETTLES. `OrphanPlacementSchema` reports a stack-managed orphan PLACEMENT as
 * `repairable: false`, on the argument that "the stack's next `iac apply` is its reaper, so repairing
 * it by hand races that apply". docs/graph.md §125c then noticed that `relationships` carries the same
 * `managed_by_stack` column, flagged the property as possibly needing the same exemption, and left it.
 *
 * It does NOT need the same exemption, and the reason is measured here rather than argued: for an
 * EDGE the apply is not a reaper at all. Its prune pool cannot see a dangling row — `plans-repo.ts`
 * resolves managed-relationship endpoints through `fetchObjectsByIds`, which filters
 * `deleted_at IS NULL`, so `toTriple` returns `null` and the row is silently dropped before the diff
 * is computed. And it cannot re-create one either, because resolving a tombstoned endpoint fails the
 * apply outright. So there is no reconciler to race; an exemption would strand the row FOREVER behind
 * a reason naming an apply that provably never touches it, which is worse than the dangle.
 *
 * That is the opposite conclusion from the executor-binding carve-out (#375), and the difference is
 * exactly the thing to keep hold of: a policy-managed binding is RE-DERIVED from the live placements
 * every reconcile tick, which is what makes refusing it a livelock. Nothing re-derives an edge to a
 * tombstone.
 */
describe("a stack-managed relationship that outlived its endpoint", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "stack-dangling-edge");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  /** Tombstone the object row beneath the API. The ordinary `DELETE` cascades the edge (docs/graph.md
   *  §128), so this is the only way to reach the state the estate reaches through a FEDERATION IMPORT
   *  of a peer's `object_tombstone` — the one path that skips the cascade by design. Same helper name
   *  every other pre-guard-orphan fixture uses. */
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

  /** A stack with two services and a `depends_on` edge between them, applied — so the edge really
   *  carries `managed_by_stack`, stamped by `stampRelationshipStackOwnership` rather than asserted. */
  function manifest(stackName: string, opts: { declareEdge: boolean; declareB: boolean }) {
    const stack = new Stack(stackName);
    const a = new Service(stack, "a", { name: "A" });
    if (opts.declareB) {
      const b = new Service(stack, "b", { name: "B" });
      if (opts.declareEdge) a.dependsOn(b);
    }
    return stack.synth();
  }

  async function applyStack(m: ReturnType<typeof manifest>): Promise<void> {
    const plan = await admin.plans.create(m);
    await admin.plans.apply(plan.id);
  }

  /** The stack-managed edge's row, read straight from the table — `managed_by_stack` is not on the
   *  wire anywhere (it deliberately does not federate), so there is nothing to read it through. */
  async function edgeRow(fromId: string, toId: string) {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({
          id: relationships.id,
          managedByStack: relationships.managedByStack,
          deletedAt: relationships.deletedAt
        })
        .from(relationships)
        .where(
          and(
            eq(relationships.orgId, org.orgId),
            eq(relationships.fromId, fromId),
            eq(relationships.toId, toId),
            eq(relationships.typeId, "depends_on")
          )
        )
    );
    return rows[0];
  }

  async function seedDanglingStackEdge(): Promise<{
    stackName: string;
    aUrn: string;
    aId: string;
    bUrn: string;
    bId: string;
    edgeId: string;
  }> {
    const stackName = `stack-${randomUUID().slice(0, 8)}`;
    await applyStack(manifest(stackName, { declareEdge: true, declareB: true }));
    const a = await admin.services.get(`urn:scp:${stackName}:service:a`);
    const b = await admin.services.get(`urn:scp:${stackName}:service:b`);

    const before = await edgeRow(a.id, b.id);
    expect(before, "the fixture is only meaningful if the apply created the edge").toBeDefined();
    // ASSERTED, not assumed: the whole question is about rows carrying this column, so a fixture that
    // quietly produced an unmanaged edge would make every test below vacuous.
    expect(before!.managedByStack, "the apply must have stamped stack ownership").toBe(stackName);

    await legacySoftDelete(b.id);
    return { stackName, aUrn: a.urn, aId: a.id, bUrn: b.urn, bId: b.id, edgeId: before!.id };
  }

  it("CAN dangle, and the report offers it as repairable — no stack exemption", async () => {
    const { aUrn, edgeId } = await seedDanglingStackEdge();

    const found = (await admin.graph.integrity()).danglingRelationships.find((r) => r.id === edgeId);
    expect(found, "a live edge to a tombstoned object is exactly this arm's definition").toBeDefined();
    expect(found!.deadEnd).toBe("to");
    expect(found!.fromUrn).toBe(aUrn);
    // THE DECISION. `repairable` for this arm is computed from ORIGIN DOMAIN ALONE — a replica edge is
    // false because `deleteRelationship` refuses it; a locally-authored one is true whether or not a
    // stack manages it. Pinning the `true` here is what stops a future reader from "completing" the
    // placement arm's rule by copying its `managed_by_stack` clause across, which would strand the row.
    expect(
      found!.repairable,
      "stack-managed is NOT a reason to withhold an edge: nothing re-derives it"
    ).toBe(true);
  });

  it("THE APPLY IS NOT ITS REAPER: a prune that no longer declares the edge does not remove it", async () => {
    // The measurement the exemption would have rested on, and it comes back negative. `plans-repo.ts`
    // builds the managed-relationship prune pool by resolving both endpoint ids to URNs through
    // `fetchObjectsByIds`, which filters `deleted_at IS NULL`; `toTriple` then returns `null` and the
    // row is dropped BEFORE the diff. So the plan contains no `delete` entry for it and the apply
    // leaves it exactly where it was — not "later", not "on the next tick": never.
    const { stackName, aId, bUrn, bId, edgeId } = await seedDanglingStackEdge();

    // The manifest still declares A, and no longer declares B or the edge — the ordinary shape of a
    // stack whose author removed a service.
    const dropped = manifest(stackName, { declareEdge: false, declareB: false });
    const plan = await admin.plans.create(dropped);
    expect(
      plan.diff.relationships.filter((e) => e.action === "delete" && e.toUrn === bUrn),
      "the dangling edge is invisible to the prune — this is the whole finding"
    ).toHaveLength(0);
    await admin.plans.apply(plan.id);

    // Read the ROW, not just the report — the report could in principle have changed its mind for
    // some other reason, while `deleted_at IS NULL` on the row itself is the fact under discussion.
    const row = await edgeRow(aId, bId);
    expect(row?.deletedAt, "the apply tombstoned nothing").toBeNull();
    expect(row?.managedByStack, "and it is still this stack's row").toBe(stackName);
    expect(
      (await admin.graph.integrity()).danglingRelationships.some((r) => r.id === edgeId),
      "still dangling after the apply that supposedly reaps it"
    ).toBe(true);
  });

  it("…AND CANNOT RE-CREATE ONE: a manifest that still names the dead endpoint fails the apply", async () => {
    // The other half of "no reconciler to race". If `--repair` removes the row and the manifest still
    // declares the edge, the next apply does NOT quietly re-create it and set up a livelock: it cannot
    // get that far, because a tombstoned URN can be neither created (`objects_org_id_urn_key` is
    // non-partial) nor resolved as an endpoint (`getObjectByIdOrUrnAnyType` is live-only). A refusal
    // an operator can read beats a row that reappears every tick.
    const { stackName, edgeId } = await seedDanglingStackEdge();
    await admin.relationships.delete(edgeId);

    const plan = await admin.plans.create(manifest(stackName, { declareEdge: true, declareB: true }));
    await expect(
      admin.plans.apply(plan.id),
      "the apply refuses rather than re-deriving the edge"
    ).rejects.toBeInstanceOf(ScpApiError);

    expect(
      (await admin.graph.integrity()).danglingRelationships.some((r) => r.id === edgeId),
      "and the repaired row stays repaired"
    ).toBe(false);
  });

  it("`--repair`'s door removes it, which is why leaving `repairable: true` is the right call", async () => {
    // Detection and repair in one test, the arrangement that stops them drifting. `DELETE
    // /relationships/{id}` is the ordinary audited door, so the removal keeps its audit event and its
    // journal entry — and it is the ONLY reaper this row has.
    const { edgeId } = await seedDanglingStackEdge();
    await admin.relationships.delete(edgeId);
    expect(
      (await admin.graph.integrity()).danglingRelationships.some((r) => r.id === edgeId)
    ).toBe(false);
  });
});
