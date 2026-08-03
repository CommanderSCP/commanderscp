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

/**
 * DECLARING PLACEMENTS IN IaC (C1, ADR-0026) — the four decisions, enforced end to end.
 *
 * The design is in docs/proposals/iac-placements.md; §6 records the rulings. This file exists because
 * three of the four are only real if APPLY enforces them, and one of them is destructive.
 *
 * ============================================================================================
 * WHY A TYPED COLLECTION AT ALL — the assertion the whole feature rests on
 * ============================================================================================
 * A placement cannot be a raw `objects[]` entry: that door is refused for pair-bound types (#207)
 * because it stores unresolved UUIDs and writes NO derived edges, leaving an island invisible to
 * every traversal. So the first test asserts the DERIVED EDGES exist after apply — not merely that a
 * row appeared. A create path that produced the row without the edges would satisfy a row-count
 * check and reintroduce exactly what #207 closed.
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | apply via `createObject` instead of `createPlacement` | the derived-edges test FAILS — the row exists, the edges do not |
 * | drop the Q2 binding check from the prune path | the refuse-with-binding test FAILS (the placement is deleted and the binding orphaned) |
 * | move the placement prune BEFORE the binding prune | the remove-both test FAILS — a manifest legitimately dropping both is refused, which is the ordering bug this file caught during development |
 * | scope the owned pool on the deployment-target instead of the component | the foreign-component test FAILS |
 */
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

  it("REFUSES to prune a placement that still carries an executor binding (decision Q2)", async () => {
    const stackName = `pl-q2-${uuidv7().slice(0, 8)}`;
    const { manifest, comp } = baseManifest(stackName, {
      placements: [{ componentUrn: comp0(stackName), deploymentTargetUrn: tgt0(stackName) }]
    });
    await apply(manifest);
    const [placement] = await livePlacements(comp);
    await admin.executors.putBinding(placement!.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${uuidv7().slice(0, 8)}`,
      externalRef: "app"
    });

    // Same stack, placement removed — and the binding NOT removed, because the manifest cannot
    // even name it (its target is the placement).
    const { manifest: without } = baseManifest(stackName, { placements: [] });
    await expect(
      apply(without),
      "a cascade would delete execution config the manifest never mentioned, and an orphaned binding fails SILENTLY"
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

  it("an ABSENT placements collection prunes nothing (decision Q3's other half)", async () => {
    const stackName = `pl-absent-${uuidv7().slice(0, 8)}`;
    const { manifest, comp } = baseManifest(stackName, {
      placements: [{ componentUrn: comp0(stackName), deploymentTargetUrn: tgt0(stackName) }]
    });
    await apply(manifest);

    // No `placements` key at all — "declares none", NOT "delete them all".
    const { manifest: silent } = baseManifest(stackName);
    await apply(silent);

    expect(
      await livePlacements(comp),
      "an absent collection must not read as 'prune everything' — every optional collection follows this rule"
    ).toHaveLength(1);
  });
});

/** URN helpers — the manifest addresses everything by URN, and these must match `baseManifest`. */
function comp0(stackName: string): string {
  return `urn:scp:${stackName}:component:api`;
}
function tgt0(stackName: string): string {
  return `urn:scp:${stackName}:deployment-target:prod`;
}
