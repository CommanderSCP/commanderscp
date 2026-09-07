import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { buildServiceBoard } from "./service-board.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** THE BOARD OVER AN ASSEMBLY CHILD. See docs/coordination.md §848. */
describe("service board with an assembly child", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let service: GraphObject;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "board-assembly");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    service = await admin.object("service").create({ name: "agentkit" });
  });

  afterAll(async () => {
    await server?.close();
  });

  const contains = (fromId: string, toId: string) =>
    admin.relationships.create({ typeId: "contains", fromId, toId });

  const board = () =>
    withTenantTx(server.deps.db, org.orgId, async (tx) =>
      buildServiceBoard(tx, org.orgId, await getObjectByIdOrUrnAnyType(tx, org.orgId, service.id))
    );

  it("reports the assembly child with its own component count, and keeps rows per-component", async () => {
    const direct = await createOrphanComponent(server, org, "gateway");
    await contains(service.id, direct.id);

    // ...and TWO under an assembly, so the assembly's count (2) can never be confused with the
    // service's own direct-child count (1).
    const assembly = await admin.assemblies.create({ name: "control-plane" });
    await contains(service.id, assembly.id);
    const nested = [
      await createOrphanComponent(server, org, "scheduler"),
      await createOrphanComponent(server, org, "reconciler")
    ];
    for (const c of nested) await contains(assembly.id, c.id);

    const result = await board();

    expect(
      result.childAssemblies.map((a) => a.name),
      "the assembly child appears on its parent's board"
    ).toEqual(["control-plane"]);
    expect(
      result.childAssemblies[0]?.componentCount,
      "with a count of its own components, not the service's"
    ).toBe(2);

    expect(
      result.rows.map((r) => r.component.name),
      "rows are the service's OWN components: the assembly is not a row, and its components are not flattened in"
    ).toEqual(["gateway"]);
  });
});
