import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { withTenantTx } from "../db/tenant-tx.js";
import { relationships } from "../db/schema.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * ADR-0028 increment 2 — declared stage dependencies become `depends_on` edges.
 *
 * This is the "derive the dependency charts instead of guessing" half of the owner's ask, and it is
 * the only half there can be: nothing SCP observes carries inter-component dependency data (decision
 * 7), so the CI declaration IS the chart's source. What is proved here is the part that cannot be
 * read off the code — that the SAME declaration arriving on every push converges rather than
 * accumulating or erroring, that a declaration never DELETES anything, and that `consumes` edges are
 * left where they were.
 *
 * No reconcile loop: every assertion is about what `proposeChange` writes, and a running loop would
 * only add unrelated contention.
 */
describe("stage dependencies: the depends_on edges (ADR-0028 increment 2)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "stagedepedges");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server.close();
  });

  /** Live `depends_on` rows from -> to, read straight from the table so no API filter can mask a
   *  duplicate the unique index would otherwise be the only thing complaining about. */
  const edgesBetween = (fromId: string, toId: string) =>
    withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(relationships)
        .where(
          and(
            eq(relationships.orgId, org.orgId),
            eq(relationships.typeId, "depends_on"),
            eq(relationships.fromId, fromId),
            eq(relationships.toId, toId),
            isNull(relationships.deletedAt)
          )
        )
    );

  it("a declared dependency materialises as ONE depends_on edge, component -> component", async () => {
    const b = await createTestComponent(admin, { name: `edge-b-${randomUUID().slice(0, 8)}` });
    const a = await createTestComponent(admin, { name: `edge-a-${randomUUID().slice(0, 8)}` });

    expect(await edgesBetween(a.id, b.id)).toHaveLength(0);

    await admin.changes.propose({
      name: "declares a dependency",
      targets: [a.id],
      stageDependencies: [{ dependsOn: b.urn }]
    });

    const edges = await edgesBetween(a.id, b.id);
    expect(edges).toHaveLength(1);
    // The direction is the declaration's direction: the DECLARING component depends on the named
    // one. Reversed, impact analysis would answer every "what breaks if B changes" backwards.
    expect(await edgesBetween(b.id, a.id)).toHaveLength(0);
    // No per-dependency semantics ride on the edge — relationship `properties` are discarded on four
    // legs of the way in and relationships have no update path, so anything stored here would be a
    // value nobody could ever change. `properties.stageDependencies` on the change stays the
    // authority for what the hold reads.
    expect(edges[0]!.properties).toEqual({});
  });

  it("the SAME declaration on a second push is a no-op: still one edge, no error", async () => {
    // The headline idempotence claim. A microservice's CI declares the same dependency on EVERY
    // push, so a second identical propose must converge silently — and it must do so without
    // relying on catching the unique-violation 409, which arrives only after postgres has already
    // aborted the transaction propose is still writing into.
    const b = await createTestComponent(admin, { name: `idem-b-${randomUUID().slice(0, 8)}` });
    const a = await createTestComponent(admin, { name: `idem-a-${randomUUID().slice(0, 8)}` });

    await admin.changes.propose({
      name: "idempotence push 1",
      targets: [a.id],
      stageDependencies: [{ dependsOn: b.id }]
    });
    // Second push, re-declared with a DIFFERENT qualifier — the edge does not carry qualifiers, so
    // this must still collapse onto the one edge rather than being treated as a new fact.
    const second = await admin.changes.propose({
      name: "idempotence push 2",
      targets: [a.id],
      stageDependencies: [{ dependsOn: b.id, minWeight: 50 }]
    });

    expect(await edgesBetween(a.id, b.id)).toHaveLength(1);
    // The change itself still records what its own author declared, qualifier and all.
    expect((await admin.changes.get(second.id)).properties.stageDependencies).toEqual([
      { dependsOn: b.id, minWeight: 50 }
    ]);
  });

  it("two entries naming the same dependency in ONE declaration produce one edge", async () => {
    // Within a single propose nothing is COMMITTED yet, so this pins that the pre-check reads its
    // own transaction's uncommitted inserts. If it ever stopped doing so — a stray autocommit
    // connection, a read moved outside the tx — the second insert would hit the unique index and
    // take the whole propose down with it.
    const b = await createTestComponent(admin, { name: `dup-b-${randomUUID().slice(0, 8)}` });
    const a = await createTestComponent(admin, { name: `dup-a-${randomUUID().slice(0, 8)}` });
    const gamma = await admin.object("deployment-target").create({
      name: `gamma-${randomUUID().slice(0, 8)}`,
      properties: { environment: "gamma" }
    });

    await admin.changes.propose({
      name: "declares the same dependency twice, scoped differently",
      targets: [a.id],
      stageDependencies: [{ dependsOn: b.id }, { dependsOn: b.id, atTargets: [gamma.id] }]
    });

    expect(await edgesBetween(a.id, b.id)).toHaveLength(1);
  });

  it("a multi-target change declares from EVERY target it releases", async () => {
    const c = await createTestComponent(admin, { name: `multi-c-${randomUUID().slice(0, 8)}` });
    const a1 = await createTestComponent(admin, { name: `multi-a1-${randomUUID().slice(0, 8)}` });
    const a2 = await createTestComponent(admin, { name: `multi-a2-${randomUUID().slice(0, 8)}` });

    await admin.changes.propose({
      name: "two components, one shared dependency",
      targets: [a1.id, a2.id],
      stageDependencies: [{ dependsOn: c.id }]
    });

    expect(await edgesBetween(a1.id, c.id)).toHaveLength(1);
    expect(await edgesBetween(a2.id, c.id)).toHaveLength(1);
  });

  it("a component declaring ITSELF is dropped, not refused and not written", async () => {
    // Both compiler paths already ignore `from === to`, so the graph layer's 400 would be the only
    // consequence of a declaration that means nothing either way.
    const a = await createTestComponent(admin, { name: `self-${randomUUID().slice(0, 8)}` });
    const change = await admin.changes.propose({
      name: "declares itself",
      targets: [a.id],
      stageDependencies: [{ dependsOn: a.id }]
    });
    expect(await edgesBetween(a.id, a.id)).toHaveLength(0);
    // Dropped from the GRAPH only — the change still stores what its author wrote.
    expect((await admin.changes.get(change.id)).properties.stageDependencies).toEqual([
      { dependsOn: a.id }
    ]);
  });

  it("an existing `consumes` edge between the same pair is left exactly as it was", async () => {
    // ADR-0028 decision 6: impact analysis reads `depends_on` AND `consumes`, so the estate's
    // existing component->component `consumes` edges lose nothing by not being converged — and
    // converging them would rewrite data this feature never authored. Named in a test so the next
    // reader does not "fix" one into the other.
    const b = await createTestComponent(admin, { name: `mixed-b-${randomUUID().slice(0, 8)}` });
    const a = await createTestComponent(admin, { name: `mixed-a-${randomUUID().slice(0, 8)}` });
    const consumes = await admin.relationships.create({
      typeId: "consumes",
      fromId: a.id,
      toId: b.id
    });

    await admin.changes.propose({
      name: "declares a dependency over an existing consumes edge",
      targets: [a.id],
      stageDependencies: [{ dependsOn: b.id }]
    });

    expect(await edgesBetween(a.id, b.id)).toHaveLength(1);
    const stillThere = await admin.relationships.get(consumes.id);
    expect(stillThere.deletedAt).toBeNull();
  });

  it("declaring nothing writes no edge at all", async () => {
    const b = await createTestComponent(admin, { name: `none-b-${randomUUID().slice(0, 8)}` });
    const a = await createTestComponent(admin, { name: `none-a-${randomUUID().slice(0, 8)}` });
    await admin.changes.propose({ name: "no declaration", targets: [a.id] });
    expect(await edgesBetween(a.id, b.id)).toHaveLength(0);
  });

  it("a DELETED edge is not re-created, and the re-declaring push still succeeds", async () => {
    // `relationships_org_type_from_to_key` is a plain UNIQUE and deletes are SOFT, so a tombstoned
    // edge permanently occupies the key — no create can ever replace it. The behaviour that matters
    // is therefore not "the edge comes back" (it cannot) but "the release is not collateral damage":
    // an operator's one-off deletion must not turn every subsequent push of that microservice into a
    // 409. The coupling itself is unaffected either way — the hold reads the change's properties.
    const b = await createTestComponent(admin, { name: `tomb-b-${randomUUID().slice(0, 8)}` });
    const a = await createTestComponent(admin, { name: `tomb-a-${randomUUID().slice(0, 8)}` });

    await admin.changes.propose({
      name: "tombstone push 1",
      targets: [a.id],
      stageDependencies: [{ dependsOn: b.id }]
    });
    const [edge] = await edgesBetween(a.id, b.id);
    await admin.relationships.delete(edge!.id);
    expect(await edgesBetween(a.id, b.id)).toHaveLength(0);

    const second = await admin.changes.propose({
      name: "tombstone push 2 after the edge was deleted",
      targets: [a.id],
      stageDependencies: [{ dependsOn: b.id }]
    });
    expect((await admin.changes.get(second.id)).properties.stageDependencies).toEqual([
      { dependsOn: b.id }
    ]);
    expect(await edgesBetween(a.id, b.id)).toHaveLength(0);
  });

  it("a dependency naming something that cannot HOLD a dependency is refused at propose time", async () => {
    // `depends_on` accepts service/component on both ends. A declaration naming a deployment-target
    // resolves (it is a real object) but can never become an edge — refused where it was authored,
    // on the same principle as the unresolvable-ref 404, rather than discovered later as a coupling
    // that silently applies to nothing.
    const a = await createTestComponent(admin, { name: `badend-a-${randomUUID().slice(0, 8)}` });
    const place = await admin.object("deployment-target").create({
      name: `place-${randomUUID().slice(0, 8)}`,
      properties: { environment: "gamma" }
    });

    await expect(
      admin.changes.propose({
        name: "depends on a place",
        targets: [a.id],
        stageDependencies: [{ dependsOn: place.id }]
      })
    ).rejects.toMatchObject({ status: 400 });
    // And nothing was half-written: the whole propose rolls back with the transaction.
    expect(await edgesBetween(a.id, place.id)).toHaveLength(0);
  });
});
