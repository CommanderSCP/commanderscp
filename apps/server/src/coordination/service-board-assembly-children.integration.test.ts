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

/**
 * THE BOARD OVER AN ASSEMBLY CHILD (migration 0055, `intermediate-grouping.md` D3).
 *
 * The board's child list was `typeId === "component"`. The moment `contains` admitted
 * `service → assembly`, that filter made an assembly child — and therefore every component under it —
 * SILENTLY ABSENT from its parent's board: a service could hold most of its estate behind an assembly
 * and render as if it held nothing there. The board still looked correct, which is the whole hazard.
 *
 * D3 chose DIRECT children plus a per-child summary over flattening every descendant, so the fix is
 * NOT "walk deeper". This test pins both halves of that choice at once, because either one failing
 * alone is a wrong board:
 *   1. the assembly APPEARS, with a count of its own components;
 *   2. the assembly's components do NOT appear as `rows` — `rows` stays per-component-of-THIS-service.
 *
 * The count is asserted as a NUMBER OTHER THAN ZERO AND OTHER THAN the direct-child count, so a
 * hardcoded 0, a `?? 0` that never fills, or a count that accidentally reports the service's own
 * children all fail rather than coincide.
 *
 * MUTATION LOG (each applied alone, then reverted):
 *
 * | Mutation | Result |
 * |---|---|
 * | drop the `assemblyObjects` filter + `childAssemblies` (i.e. restore the pre-0055 board) | "the assembly child appears" FAILS — this is the regression being fixed |
 * | `componentCount: assemblyCounts.get(a.id) ?? 0` -> `componentCount: 0` | "with a count of its own components" FAILS (expects 2) |
 * | count query's `inArray(fromId, assemblies)` -> `inArray(toId, assemblies)` | count comes back 0 -> FAILS; the edge direction is load-bearing |
 * | `maxDepth: 1` -> `maxDepth: 2` in the traverse | "the assembly's components are NOT rows" FAILS — 2 extra rows appear, which is the flattening D3 rejected |
 */
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
    // ONE component directly under the service...
    const direct = await createOrphanComponent(admin, "gateway");
    await contains(service.id, direct.id);

    // ...and TWO under an assembly, so the assembly's count (2) can never be confused with the
    // service's own direct-child count (1).
    const assembly = await admin.assemblies.create({ name: "control-plane" });
    await contains(service.id, assembly.id);
    const nested = [
      await createOrphanComponent(admin, "scheduler"),
      await createOrphanComponent(admin, "reconciler")
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
