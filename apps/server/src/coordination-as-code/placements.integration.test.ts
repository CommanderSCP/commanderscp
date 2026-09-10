import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { and, eq, isNull } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import type { DesiredStateManifest } from "@scp/schemas";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";

/** DECLARING PLACEMENTS IN IaC (C1, ADR-0026). See docs/coordination-as-code.md §43. */
describe("IaC placements (C1)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "iac-placements");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  /** A stack declaring one service, one component in it, and one deployment-target. */
  function baseManifest(stackName: string, extra: Partial<DesiredStateManifest> = {}) {
    const svc = `urn:scp:${stackName}:service:svc`;
    const comp = `urn:scp:${stackName}:component:api`;
    const tgt = `urn:scp:${stackName}:deployment-target:prod`;
    const manifest: DesiredStateManifest = {
      stackName,
      objects: [
        { urn: svc, typeId: "service", name: `svc-${stackName}` },
        { urn: comp, typeId: "component", name: `api-${stackName}` },
        { urn: tgt, typeId: "deployment-target", name: `prod-${stackName}` }
      ],
      relationships: [{ typeId: "contains", fromUrn: svc, toUrn: comp }],
      ...extra
    };
    return { manifest, svc, comp, tgt };
  }

  async function apply(manifest: DesiredStateManifest) {
    const plan = await admin.plans.create(manifest);
    return admin.plans.apply(plan.id);
  }

  /** Live placements of the component named by `componentUrn`, read from `properties` — the source
   *  of truth for the pair (ADR-0026 D17). */
  async function livePlacements(componentUrn: string) {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const comp = await tx.query.objects.findFirst({
        where: (t, { eq: e, and: a }) => a(e(t.orgId, org.orgId), e(t.urn, componentUrn))
      });
      if (!comp) return [];
      const all = await tx
        .select({ id: objects.id, properties: objects.properties })
        .from(objects)
        .where(
          and(
            eq(objects.orgId, org.orgId),
            eq(objects.typeId, "placement"),
            isNull(objects.deletedAt)
          )
        );
      return all.filter((p) => (p.properties as { componentId?: string }).componentId === comp.id);
    });
  }

  it("creates the placement WITH its derived edges — the reason it is a typed collection", async () => {
    const stackName = `pl-create-${uuidv7().slice(0, 8)}`;
    const { manifest, comp, tgt } = baseManifest(stackName, {
      placements: [{ componentUrn: comp0(stackName), deploymentTargetUrn: tgt0(stackName) }]
    });
    await apply(manifest);

    const placements = await livePlacements(comp);
    expect(placements, "one placement for the declared pair").toHaveLength(1);

    const edges = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ typeId: relationships.typeId })
        .from(relationships)
        .where(
          and(
            eq(relationships.orgId, org.orgId),
            isNull(relationships.deletedAt),
            eq(relationships.fromId, placements[0]!.id)
          )
        )
    );
    expect(
      edges.map((e) => e.typeId).sort(),
      "a placement written WITHOUT its derived edges is an island invisible to every traversal — exactly what #207 refuses on the generic door"
    ).toContain("places");
    expect(tgt).toBeTruthy();
  });

  it("applying the same manifest twice is a no-op — it ADOPTS rather than duplicating", async () => {
    const stackName = `pl-idem-${uuidv7().slice(0, 8)}`;
    const { manifest, comp } = baseManifest(stackName, {
      placements: [{ componentUrn: comp0(stackName), deploymentTargetUrn: tgt0(stackName) }]
    });
    await apply(manifest);
    const second = await apply(manifest);

    expect(
      await livePlacements(comp),
      "the unique index would reject a duplicate anyway"
    ).toHaveLength(1);
    expect(second.summary.creates, "the second apply must create nothing").toBe(0);
  });

  it("removes BOTH when the manifest declares neither the placement nor its binding", async () => {
    // This replaces the original case, and the change is deliberate. See docs/coordination-as-code.md §44.
    const stackName = `pl-q2-both-${uuidv7().slice(0, 8)}`;
    const { manifest, comp } = baseManifest(stackName, {
      placements: [{ componentUrn: comp0(stackName), deploymentTargetUrn: tgt0(stackName) }],
      executorBindings: [
        {
          targetUrn: comp0(stackName),
          deploymentTargetUrn: tgt0(stackName),
          pluginModule: "fake-executor",
          pluginInstanceId: `inst-${stackName}`,
          externalRef: "app"
        }
      ]
    });
    await apply(manifest);
    expect(await livePlacements(comp)).toHaveLength(1);

    const { manifest: without } = baseManifest(stackName, { placements: [] });
    await apply(without);

    expect(
      await livePlacements(comp),
      "binding-prune runs before placement-prune, so declaring neither removes both"
    ).toHaveLength(0);
  });

  it("REFUSES at apply when a binding appeared AFTER the plan was computed (Q2's surviving reach)", async () => {
    // What Q2 still protects, now that the ordinary case is expressible. The plan is computed while
    // the placement carries nothing, so its diff contains no binding-delete; the binding is written
    // in the gap before apply. Nothing in the stored diff knows about it, and a cascade here would
    // destroy execution configuration no human ever reviewed.
    const stackName = `pl-q2-toctou-${uuidv7().slice(0, 8)}`;
    const { manifest, comp } = baseManifest(stackName, {
      placements: [{ componentUrn: comp0(stackName), deploymentTargetUrn: tgt0(stackName) }]
    });
    await apply(manifest);
    const [placement] = await livePlacements(comp);

    const { manifest: without } = baseManifest(stackName, { placements: [] });
    const plan = await admin.plans.create(without);

    await admin.executors.putBinding(placement!.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${uuidv7().slice(0, 8)}`,
      externalRef: "app"
    });

    await expect(
      admin.plans.apply(plan.id),
      "an orphaned binding fails SILENTLY, so refusing beats cascading"
    ).rejects.toMatchObject({ status: 409 });

    expect(await livePlacements(comp), "and nothing may be destroyed by the refusal").toHaveLength(
      1
    );
  });

  it("prunes the placement once nothing is bound to it", async () => {
    // The other half of Q2: the refusal must not make placements undeletable.
    const stackName = `pl-prune-${uuidv7().slice(0, 8)}`;
    const { manifest, comp } = baseManifest(stackName, {
      placements: [{ componentUrn: comp0(stackName), deploymentTargetUrn: tgt0(stackName) }]
    });
    await apply(manifest);
    expect(await livePlacements(comp)).toHaveLength(1);

    const { manifest: without } = baseManifest(stackName, { placements: [] });
    await apply(without);

    expect(await livePlacements(comp), "declaring none must remove it (decision Q3)").toHaveLength(
      0
    );
  });

  it("an ABSENT placements collection prunes the same as an empty one — they are the same thing", async () => {
    // NOT a quirk, and I got this backwards first. See docs/coordination-as-code.md §45.
    const stackName = `pl-absent-${uuidv7().slice(0, 8)}`;
    const { manifest, comp } = baseManifest(stackName, {
      placements: [{ componentUrn: comp0(stackName), deploymentTargetUrn: tgt0(stackName) }]
    });
    await apply(manifest);
    expect(await livePlacements(comp)).toHaveLength(1);

    const { manifest: silent } = baseManifest(stackName);
    await apply(silent);

    expect(
      await livePlacements(comp),
      "absent == empty == 'I declare none', so the row is pruned — consistent with sourceMappings and executorBindings"
    ).toHaveLength(0);
  });
});

/** URN helpers — the manifest addresses everything by URN, and these must match `baseManifest`. */
function comp0(stackName: string): string {
  return `urn:scp:${stackName}:component:api`;
}
function tgt0(stackName: string): string {
  return `urn:scp:${stackName}:deployment-target:prod`;
}
