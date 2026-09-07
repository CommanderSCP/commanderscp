import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  type ListeningTestServer
} from "../test-support/harness.js";

/** REGRESSION GUARD for a "component built, never installed" defect. See docs/graph.md §146. */
describe("property_schema edits reach a live process (no restart)", () => {
  let server: ListeningTestServer;

  beforeAll(async () => {
    server = await listenTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  /** Applies a `property_schema` rewrite the way a migration does: another process, admin rights. */
  async function migratePropertySchema(
    table: "object_types" | "relationship_types",
    typeId: string,
    schema: unknown
  ): Promise<void> {
    const admin = new pg.Client({ connectionString: testDatabaseUrl() });
    await admin.connect();
    try {
      const result = await admin.query(
        `UPDATE ${table} SET property_schema = $1::jsonb WHERE id = $2`,
        [JSON.stringify(schema), typeId]
      );
      // Guards the fixture itself: a typo'd id would leave the ORIGINAL schema in place, and every
      // assertion below would then pass for the wrong reason (nothing changed, so nothing is
      // stale). The edit must be proven to have landed before its effect can be asserted.
      expect(result.rowCount).toBe(1);
    } finally {
      await admin.end();
    }
  }

  it("object create: a tightened property_schema is enforced without a restart", async () => {
    const org = await createTestOrg(server, "prop-schema-live-create");
    const client = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const typeId = `gadget-${randomUUID().slice(0, 8)}`;
    await client.typeRegistry.objectTypes.create({
      id: typeId,
      displayName: "Gadget",
      propertySchema: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"]
      }
    });

    // STEP 1 — real writes over the real route. These COMPILE AND CACHE a validator for the
    // original schema; without them the process would compile fresh in step 3 and this test could
    // not distinguish a fixed cache from a broken one.
    const first = await client.object(typeId).create({ name: "g1", properties: { code: "A" } });
    expect(first.properties.code).toBe("A");
    await expect(client.object(typeId).create({ name: "g-nocode" })).rejects.toThrow();

    // STEP 2 — the migration lands. Different connection, different privileges, no restart.
    await migratePropertySchema("object_types", typeId, {
      type: "object",
      properties: {
        code: { type: "string" },
        tier: { type: "string", enum: ["gold", "silver"] }
      },
      required: ["code", "tier"]
    });

    // The same live process must enforce the new schema both ways. See docs/graph.md §147.
    await expect(
      client.object(typeId).create({ name: "g2", properties: { code: "B" } })
    ).rejects.toThrow();

    // (b) a write satisfying the NEW schema is accepted.
    const third = await client
      .object(typeId)
      .create({ name: "g3", properties: { code: "C", tier: "gold" } });
    expect(third.properties.tier).toBe("gold");

    // (c) the new constraint is enforced in detail, not merely "some schema is applied" — the
    //     enum arrived with the same edit and must bite too.
    await expect(
      client.object(typeId).create({ name: "g4", properties: { code: "D", tier: "bronze" } })
    ).rejects.toThrow();
  });

  it("object update: the second validate call site honours the edit too", async () => {
    const org = await createTestOrg(server, "prop-schema-live-update");
    const client = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    // `objects-repo.ts` validates in TWO places — `createObject` and `updateObject`. They shared
    // one cache key, so a census that fixed only the create path would leave update stale.
    const typeId = `widget-${randomUUID().slice(0, 8)}`;
    await client.typeRegistry.objectTypes.create({
      id: typeId,
      displayName: "Widget",
      propertySchema: { type: "object", properties: { size: { type: "string" } } }
    });

    const obj = await client.object(typeId).create({ name: "w1", properties: { size: "small" } });
    const updated = await client
      .object(typeId)
      .update(obj.id, { properties: { size: "medium" }, version: obj.version });
    expect(updated.properties.size).toBe("medium");

    await migratePropertySchema("object_types", typeId, {
      type: "object",
      properties: { size: { type: "string", enum: ["small", "large"] } },
      required: ["size"]
    });

    await expect(
      client
        .object(typeId)
        .update(obj.id, { properties: { size: "medium" }, version: updated.version })
    ).rejects.toThrow();

    const relegal = await client
      .object(typeId)
      .update(obj.id, { properties: { size: "large" }, version: updated.version });
    expect(relegal.properties.size).toBe("large");
  });

  it("relationship create: the relationship-type validate call site honours the edit too", async () => {
    const org = await createTestOrg(server, "prop-schema-live-rel");
    const client = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const relTypeId = `funds-${randomUUID().slice(0, 8)}`;
    await client.typeRegistry.relationshipTypes.create({
      id: relTypeId,
      displayName: "Funds",
      cardinality: "many_to_many",
      propertySchema: { type: "object", properties: { budget: { type: "string" } } }
    });

    const from = await client
      .object("service")
      .create({ name: `svc-a-${randomUUID().slice(0, 8)}` });
    const to = await client.object("service").create({ name: `svc-b-${randomUUID().slice(0, 8)}` });

    const rel = await client.relationships.create({
      typeId: relTypeId,
      fromId: from.id,
      toId: to.id,
      properties: { budget: "100" }
    });
    expect(rel.typeId).toBe(relTypeId);

    await migratePropertySchema("relationship_types", relTypeId, {
      type: "object",
      properties: { budget: { type: "string" }, approver: { type: "string" } },
      required: ["approver"]
    });

    await expect(
      client.relationships.create({
        typeId: relTypeId,
        fromId: to.id,
        toId: from.id,
        properties: { budget: "200" }
      })
    ).rejects.toThrow();

    const ok = await client.relationships.create({
      typeId: relTypeId,
      fromId: to.id,
      toId: from.id,
      properties: { budget: "200", approver: "alice" }
    });
    expect(ok.properties.approver).toBe("alice");
  });
});
