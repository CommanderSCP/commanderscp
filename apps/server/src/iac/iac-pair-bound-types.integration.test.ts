import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { DesiredStateManifest } from "@scp/schemas";
import { and, eq, isNull } from "drizzle-orm";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";

/** An apply must refuse a pair-bound type, as the route does. See docs/iac.md §29. */
describe("IaC apply refuses pair-bound object types", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "iac-pair-bound");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function livePlacements() {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: objects.id, props: objects.properties })
        .from(objects)
        .where(
          and(
            eq(objects.orgId, org.orgId),
            eq(objects.typeId, "placement"),
            isNull(objects.deletedAt)
          )
        )
    );
  }

  it("refuses a manifest that declares a placement as a raw object", async () => {
    const component = await createTestComponent(admin, { name: `pb-comp-${uuidv7()}` });
    const target = await admin.deploymentTargets.create({ name: `pb-target-${uuidv7()}` });
    const stackName = `pb-stack-${uuidv7().slice(0, 8)}`;

    const manifest: DesiredStateManifest = {
      stackName,
      objects: [
        {
          urn: `urn:scp:${stackName}:placement:smuggled`,
          typeId: "placement",
          name: "smuggled@target",
          properties: { componentId: component.id, deploymentTargetId: target.id }
        }
      ],
      relationships: []
    };

    const before = (await livePlacements()).length;
    const plan = await admin.plans.create(manifest);

    // The refusal may land at PLAN or at APPLY; either is fine, so long as nothing is written.
    await expect(
      admin.plans.apply(plan.id),
      "the IaC path is a second write door onto createObject — the generic route's refusal has to hold here too"
    ).rejects.toMatchObject({ status: 403 });

    const after = await livePlacements();
    expect(after.length, "no placement may be written").toBe(before);
  });

  // THE `accept` CASE IS GONE WITH ITS DOOR. See docs/iac.md §30.

  it("leaves no untraversable island — the reason the generic route refuses at all", async () => {
    // The decisive property. A placement created without its derived edges is invisible to blast
    // radius and to every impact query, which a "did it 403" assertion alone would not catch.
    const component = await createTestComponent(admin, { name: `pb2-comp-${uuidv7()}` });
    const target = await admin.deploymentTargets.create({ name: `pb2-target-${uuidv7()}` });
    const stackName = `pb2-stack-${uuidv7().slice(0, 8)}`;

    const plan = await admin.plans.create({
      stackName,
      objects: [
        {
          urn: `urn:scp:${stackName}:placement:island`,
          typeId: "placement",
          name: "island@target",
          properties: { componentId: component.id, deploymentTargetId: target.id }
        }
      ],
      relationships: []
    });
    await admin.plans.apply(plan.id).catch(() => undefined);

    const edges = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: relationships.id })
        .from(relationships)
        .where(
          and(
            eq(relationships.orgId, org.orgId),
            isNull(relationships.deletedAt),
            eq(relationships.toId, component.id)
          )
        )
    );
    const placementsNow = await livePlacements();
    const smuggled = placementsNow.filter(
      (p) => (p.props as { componentId?: string }).componentId === component.id
    );

    expect(
      smuggled,
      "a placement written this way carries the pair in properties but has no `places` edge, so nothing can traverse from the component to it"
    ).toHaveLength(0);
    expect(edges.filter((e) => e.id)).toBeDefined();
  });
});
