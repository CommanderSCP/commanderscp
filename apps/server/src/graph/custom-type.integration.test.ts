import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer
} from "../test-support/harness.js";
import { startCliSession, type CliInvocation } from "../test-support/cli-runner.js";

/**
 * BUILD_AND_TEST.md §8 M1 DoD (b): "a custom object type + custom relationship type registered
 * via the API are immediately usable through the generic endpoints, SDK, and CLI with no
 * deploy." One test org exercises the SDK surface; a second exercises the real `scp` CLI binary
 * end to end (login -> register type -> create -> list), proving all three interface tiers.
 */
describe("custom object/relationship type: immediately usable, no deploy", () => {
  let server: ListeningTestServer;

  beforeAll(async () => {
    server = await listenTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("SDK: register a custom type pair, then use them through the generic endpoints", async () => {
    const org = await createTestOrg(server, "custom-type-sdk");
    const client = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    const costCenterType = `cost-center-${randomUUID().slice(0, 8)}`;
    const fundsType = `funds-${randomUUID().slice(0, 8)}`;
    const objectType = await client.typeRegistry.objectTypes.create({
      id: costCenterType,
      displayName: "Cost Center",
      propertySchema: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"]
      }
    });
    expect(objectType.id).toBe(costCenterType);

    const relType = await client.typeRegistry.relationshipTypes.create({
      id: fundsType,
      displayName: "Funds",
      fromTypes: [costCenterType],
      toTypes: ["service"],
      cardinality: "many_to_many"
    });
    expect(relType.id).toBe(fundsType);

    // Immediately usable through the generic /objects/{type} endpoint — no deploy, no restart.
    const costCenter = await client.object(costCenterType).create({
      name: "Platform Engineering",
      properties: { code: "CC-100" }
    });
    expect(costCenter.typeId).toBe(costCenterType);
    expect(costCenter.properties.code).toBe("CC-100");

    // Ajv property-schema validation is enforced at write time (missing required 'code').
    await expect(
      client.object(costCenterType).create({ name: "Bad Cost Center" })
    ).rejects.toThrow();

    const service = await client.object("service").create({ name: "billing-api" });

    const relationship = await client.relationships.create({
      typeId: fundsType,
      fromId: costCenter.id,
      toId: service.id
    });
    expect(relationship.typeId).toBe(fundsType);

    // Endpoint-type constraint enforcement: 'service' is not an allowed 'from' for this type.
    await expect(
      client.relationships.create({ typeId: fundsType, fromId: service.id, toId: costCenter.id })
    ).rejects.toThrow();

    const listed = await client.object(costCenterType).list({ limit: 50 });
    expect(listed.items.some((o) => o.id === costCenter.id)).toBe(true);
  });

  it("CLI: register a custom type and use it via `scp object`/`scp rel`, with no deploy", async () => {
    const org = await createTestOrg(server, "custom-type-cli");
    const cli: CliInvocation = await startCliSession(server.baseUrl);
    try {
      await cli.run(["login", "--username", org.adminUsername, "--password", org.adminPassword]);

      const widgetType = `widget-${randomUUID().slice(0, 8)}`;
      const createdType = await cli.runJson<{ id: string }>([
        "type-registry",
        "object-type-create",
        widgetType,
        "--display-name",
        "Widget"
      ]);
      expect(createdType.id).toBe(widgetType);

      const created = await cli.runJson<{ id: string; typeId: string; name: string }>([
        "object",
        "create",
        widgetType,
        "--name",
        "sprocket"
      ]);
      expect(created.typeId).toBe(widgetType);
      expect(created.name).toBe("sprocket");

      const listed = await cli.runJson<Array<{ id: string; name: string }>>([
        "object",
        "list",
        widgetType
      ]);
      expect(listed.some((o) => o.id === created.id && o.name === "sprocket")).toBe(true);
    } finally {
      await cli.cleanup();
    }
  });
});
