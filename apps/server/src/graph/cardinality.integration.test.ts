import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ScpClient } from "@scp/sdk";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** `many_to_one` cardinality and the attachment edge. See docs/graph.md §12. */
describe("cardinality: many_to_one and `releases_via`", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "cardinality");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function topology(name: string) {
    return admin.object("release-topology").create({ name, properties: { waves: [] } });
  }

  it("registers `releases_via` with the three inheritance rungs -> release-topology, many_to_one", async () => {
    const types = await admin.typeRegistry.relationshipTypes.list({ limit: 100 });
    const rv = types.items.find((t) => t.id === "releases_via");
    expect(rv, "migration 0049 must register the `releases_via` relationship type").toBeDefined();
    // 0049 registered `component` ALONE on purpose. See docs/graph.md §13.
    expect(rv!.fromTypes).toEqual(["component", "assembly", "service", "organization"]);
    expect(rv!.toTypes).toEqual(["release-topology"]);
    // many_to_one — the FROM side is singular. one_to_many here would constrain the pipeline
    // instead of the component, i.e. exactly backwards.
    expect(rv!.cardinality).toBe("many_to_one");
  });

  it("REFUSES a component a second pipeline — and the FIRST attachment survives", async () => {
    const comp = await createOrphanComponent(server, org, "mto-one-pipeline");
    const first = await topology("mto-first");
    const second = await topology("mto-second");

    await admin.relationships.create({ typeId: "releases_via", fromId: comp.id, toId: first.id });

    await expect(
      admin.relationships.create({ typeId: "releases_via", fromId: comp.id, toId: second.id })
    ).rejects.toThrow(/conflict/i);

    // The load-bearing assertion: behaviour, not the error string. Exactly one live attachment, and
    // it must still be the FIRST one — a rejection that nonetheless wrote the row, or one that
    // replaced the winner, both pass the throw-check above.
    const edges = await admin.relationships.list({ typeId: "releases_via", fromId: comp.id });
    expect(edges.items).toHaveLength(1);
    expect(edges.items[0]!.toId).toBe(first.id);
  });

  it("ALLOWS many components on one pipeline — the 'many' side is not constrained", async () => {
    // The mirror of the test above, and the one that catches a `many_to_one` implemented as
    // `one_to_one`: both edges point AT the same topology, which a to-side check would reject.
    const shared = await topology("mto-shared");
    const a = await createOrphanComponent(server, org, "mto-sharer-a");
    const b = await createOrphanComponent(server, org, "mto-sharer-b");

    await admin.relationships.create({ typeId: "releases_via", fromId: a.id, toId: shared.id });
    await admin.relationships.create({ typeId: "releases_via", fromId: b.id, toId: shared.id });

    const edges = await admin.relationships.list({ typeId: "releases_via", toId: shared.id });
    expect(edges.items.map((e) => e.fromId).sort()).toEqual([a.id, b.id].sort());
  });

  it("frees the component to be re-attached once the edge is soft-deleted", async () => {
    // Both the app check and the 0049 index filter `deleted_at IS NULL`, so detaching a pipeline
    // must let a different one be attached. An index that omitted that filter would pass every test
    // above and permanently freeze the first choice.
    const comp = await createOrphanComponent(server, org, "mto-reattach");
    const oldPipeline = await topology("mto-old");
    const newPipeline = await topology("mto-new");

    const edge = await admin.relationships.create({
      typeId: "releases_via",
      fromId: comp.id,
      toId: oldPipeline.id
    });
    await admin.relationships.delete(edge.id);
    await admin.relationships.create({
      typeId: "releases_via",
      fromId: comp.id,
      toId: newPipeline.id
    });

    const edges = await admin.relationships.list({ typeId: "releases_via", fromId: comp.id });
    expect(edges.items).toHaveLength(1);
    expect(edges.items[0]!.toId).toBe(newPipeline.id);
  });

  it("the DB itself enforces one pipeline per component — not just assertCardinality (race backstop)", async () => {
    // A select-then-insert under READ COMMITTED can double-write. See docs/graph.md §14.
    const comp = await createOrphanComponent(server, org, "mto-race-target");
    const p1 = await topology("mto-race-a");
    const p2 = await topology("mto-race-b");

    const results = await Promise.allSettled([
      admin.relationships.create({ typeId: "releases_via", fromId: comp.id, toId: p1.id }),
      admin.relationships.create({ typeId: "releases_via", fromId: comp.id, toId: p2.id })
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    // The invariant that actually matters: exactly one live pipeline, whoever won.
    const edges = await admin.relationships.list({ typeId: "releases_via", fromId: comp.id });
    expect(edges.items).toHaveLength(1);
  });

  it("FAILS CLOSED on a cardinality with no enforcing branch, instead of falling through", async () => {
    // Privileged fixture surgery: the API cannot mint this type (CardinalitySchema rejects the
    // value), but the COLUMN is plain `text` with no CHECK constraint, so a migration typo or a
    // future value added to the enum without an enforcement branch lands here. Before the fix such a
    // type silently permitted every write while presenting itself in the registry as constrained.
    const surgeon = new pg.Client({ connectionString: testDatabaseUrl() });
    await surgeon.connect();
    try {
      await surgeon.query(
        `INSERT INTO relationship_types (id, org_id, display_name, from_types, to_types, cardinality, is_builtin)
         VALUES ('unenforceable_test_edge', $1, 'Unenforceable', NULL, NULL, 'one_to_seven', false)
         ON CONFLICT (id) DO NOTHING`,
        [org.orgId]
      );
    } finally {
      await surgeon.end();
    }

    const a = await admin.object("service").create({ name: "unenforceable-a" });
    const b = await admin.object("service").create({ name: "unenforceable-b" });

    await expect(
      admin.relationships.create({ typeId: "unenforceable_test_edge", fromId: a.id, toId: b.id })
    ).rejects.toThrow();

    // Behaviour, not the message: NOTHING may be written under a constraint nothing can enforce.
    const edges = await admin.relationships.list({ typeId: "unenforceable_test_edge" });
    expect(edges.items).toHaveLength(0);
  });
});
