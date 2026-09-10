import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { buildEstateManifest } from "@scp/coordination-as-code";
import { readServiceExportSpec } from "@scp/cli";
import { objects } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** THE ESTATE MIGRATION, END TO END. See docs/coordination-as-code.md §1. */
describe("estate migration: export an unmanaged estate, apply it, adopt it", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "migration");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server.close();
  });

  async function liveCount(typeId: string): Promise<number> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: objects.id })
        .from(objects)
        .where(
          and(eq(objects.orgId, org.orgId), eq(objects.typeId, typeId), isNull(objects.deletedAt))
        )
    );
    return rows.length;
  }

  async function ownerOf(urn: string): Promise<string | null> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ managedByStack: objects.managedByStack })
        .from(objects)
        .where(and(eq(objects.orgId, org.orgId), eq(objects.urn, urn)))
    );
    return rows[0]?.managedByStack ?? null;
  }

  async function applyManifest(manifest: unknown) {
    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/plans",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { manifest } as never
    });
    expect(created.statusCode, created.body).toBe(201);
    const plan = created.json() as { id: string; diff: Record<string, unknown> };
    const applied = await server.app.inject({
      method: "POST",
      url: `/api/v1/plans/${plan.id}/apply`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(applied.statusCode, applied.body).toBe(200);
    return plan;
  }

  it("exports a live unmanaged estate, applies it, and adopts every object without duplicating one", async () => {
    // ---------------------------------------------------------------------------------------
    // 1. AN ESTATE THAT EXISTS AND NO STACK MANAGES — built through the ordinary typed routes,
    //    which is how every pre-IaC org's graph got there.
    // ---------------------------------------------------------------------------------------
    const suffix = randomUUID().slice(0, 8);
    const service = await admin.services.create({ name: `payments-${suffix}` });
    const component = await admin.components.create({
      name: `api-${suffix}`,
      service: service.id
    });
    const target = await admin.deploymentTargets.create({ name: `staging-${suffix}` });
    await admin.placements.create({ component: component.id, deploymentTarget: target.id });
    // A RELEASE TOPOLOGY AND ITS `releases_via` EDGE. See docs/coordination-as-code.md §2.
    const topology = await admin.object("release-topology").create({
      name: `topo-${suffix}`,
      // `mode` is REQUIRED by the registered schema (drizzle/0007); wave targets carry URNs,
      // which is what an IaC-authored topology stores and what the export reader re-emits.
      properties: { waves: [{ name: "staging", mode: "sequential", targets: [target.urn] }] }
    });
    await admin.relationships.create({
      typeId: "releases_via",
      fromId: component.id,
      toId: topology.id,
      properties: { type: "configuration" }
    });

    expect(await ownerOf(service.urn)).toBeNull();
    expect(await ownerOf(component.urn)).toBeNull();

    const before = {
      services: await liveCount("service"),
      components: await liveCount("component"),
      placements: await liveCount("placement"),
      topologies: await liveCount("release-topology")
    };

    // ---------------------------------------------------------------------------------------
    // 2. EXPORT IT — the same reader `scp iac export` uses, against the real API.
    // ---------------------------------------------------------------------------------------
    const spec = await readServiceExportSpec(admin, service.urn);
    expect(spec.serviceUrn).toBe(service.urn);
    expect(spec.components).toHaveLength(1);

    const built = buildEstateManifest(spec);
    const plan = await applyManifest(built.manifest);

    // ---------------------------------------------------------------------------------------
    // 4. EVERY OBJECT IS ADOPTED — and the plan SAID so, which is what a reviewer sees.
    // ---------------------------------------------------------------------------------------
    const objectEntries = (plan.diff as { objects: { urn: string; adopted?: boolean }[] }).objects;
    const adoptedUrns = objectEntries.filter((e) => e.adopted).map((e) => e.urn);
    expect(adoptedUrns).toContain(component.urn);

    expect(await ownerOf(component.urn)).toBe(spec.stackName);

    // ---------------------------------------------------------------------------------------
    // 5. NOTHING WAS DUPLICATED. Counted, not inferred — the live-topology duplication defect
    //    produced a plan that read as clean creates, so only the row count catches it.
    // ---------------------------------------------------------------------------------------
    expect({
      services: await liveCount("service"),
      components: await liveCount("component"),
      placements: await liveCount("placement")
    }).toEqual({
      services: before.services,
      components: before.components,
      placements: before.placements
    });

    // THE TOPOLOGY COUNT IS UNCHANGED — this is the assertion the duplication defect would break.
    // The exported program carries `adoptTopologyUrn`, so apply matches the LIVE topology instead
    // of minting a second one and orphaning it. Counted, never inferred: the defect's plan read as
    // a clean set of creates, so only the row count tells the truth.
    expect(await liveCount("release-topology")).toBe(before.topologies);
    expect(await ownerOf(topology.urn)).toBe(spec.stackName);
  });

  it("re-applying the SAME exported manifest is a no-op — the migration is idempotent", async () => {
    const suffix = randomUUID().slice(0, 8);
    const service = await admin.services.create({ name: `billing-${suffix}` });
    await admin.components.create({ name: `worker-${suffix}`, service: service.id });

    const spec = await readServiceExportSpec(admin, service.urn);
    const built = buildEstateManifest(spec);

    await applyManifest(built.manifest);
    const counts = {
      services: await liveCount("service"),
      components: await liveCount("component"),
      topologies: await liveCount("release-topology")
    };

    // SECOND apply of the identical manifest. An org converting its estate does not get one
    // attempt: it runs the same stack again on the next push, and a migration that duplicates on
    // the second run is worse than one that fails on the first.
    const second = await applyManifest(built.manifest);
    const summary = (second.diff as { summary: { creates: number; deletes: number } }).summary;
    expect(summary.creates).toBe(0);
    expect(summary.deletes).toBe(0);

    expect({
      services: await liveCount("service"),
      components: await liveCount("component"),
      topologies: await liveCount("release-topology")
    }).toEqual(counts);
  });
});
