import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { executorBindings } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  getExecutorBinding,
  upsertExecutorBinding
} from "../coordination/executor-bindings-repo.js";
import { createObject } from "../graph/objects-repo.js";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * THE LANE COLUMN AND THE WIDENED IDENTITY (migration 0105; ADR-0046 section 4, resolution 7).
 *
 * WHAT THIS HAS TO PROVE, and why a "the column stores a value" assertion would not:
 *
 *  1. **The widened key permits what the feature needs** - one target, one Type, TWO lanes. Under
 *     the old `UNIQUE (org, target, type)` that write was a constraint violation, so the feature
 *     was unrepresentable rather than merely unimplemented.
 *  2. **The lookup FILTERS on lane.** This is the dangerous half. `getExecutorBinding` was a
 *     `.limit(1)` over `(org, target, type)`; with two lanes present it returns an ARBITRARY row,
 *     so a deploy could be dispatched to the test-lane executor. The bug would be invisible - a
 *     binding IS returned, it is simply the wrong one.
 *  3. **The upsert keys on lane**, or writing the test lane destroys the build lane in place -
 *     the identical failure this repo's own comment records for Type before P3.
 *  4. **Nothing that existed changes.** Every caller that omits a lane means `build`, and every
 *     pre-migration row is in it.
 *
 * MUTATION LOG - each applied, watched fail, reverted, watched pass (MEASURED)
 * | Mutation | Result |
 * |---|---|
 * | `getExecutorBinding` drops its `eq(lane)` filter | 3 FAIL - (1), (2), (3). The unfiltered lookup makes the upsert's existence check wrong too, so the damage is wider than the read path it obviously breaks. |
 * | `upsertExecutorBinding` omits `lane` from its existence lookup | 2 FAIL - (1) and (3). The second lane UPDATES the first row in place instead of inserting: one row where two belong, which is the pre-P3 failure exactly. |
 * | the insert omits `lane`, relying on the column default | 3 FAIL - (1), (2), (3). Both rows land in `build`, so the second collides on the widened key. |
 */
describe("executor binding lanes (migration 0105)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "lanes");
  });

  afterAll(async () => {
    await server.close();
  });

  async function makeTarget(): Promise<string> {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const target = await createObject(tx, {
        orgId: org.orgId,
        typeId: "deployment-target",
        actorObjectId: org.orgId,
        requestId: "lane-test",
        name: `dt-${randomUUID().slice(0, 8)}`
      });
      return target.id;
    });
  }

  it("(1) one target, one Type, TWO lanes - which the old unique key made unrepresentable", async () => {
    const targetId = await makeTarget();
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: targetId,
        type: "configuration",
        pluginModule: "argocd",
        pluginInstanceId: `argo-${randomUUID().slice(0, 8)}`,
        actorObjectId: org.orgId,
        requestId: "lane-build"
      });
      await upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: targetId,
        type: "configuration",
        lane: "test",
        pluginModule: "argo-workflows",
        pluginInstanceId: `wf-${randomUUID().slice(0, 8)}`,
        actorObjectId: org.orgId,
        requestId: "lane-test"
      });
    });

    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(executorBindings)
        .where(
          and(eq(executorBindings.orgId, org.orgId), eq(executorBindings.targetObjectId, targetId))
        )
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.lane).sort()).toEqual(["build", "test"]);
    expect(rows.find((r) => r.lane === "build")?.pluginModule).toBe("argocd");
    expect(rows.find((r) => r.lane === "test")?.pluginModule).toBe("argo-workflows");
  });

  it("(2) the lookup FILTERS on lane - the dispatch path cannot be handed the test executor", async () => {
    const targetId = await makeTarget();
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: targetId,
        type: "configuration",
        lane: "test",
        pluginModule: "argo-workflows",
        pluginInstanceId: `wf-${randomUUID().slice(0, 8)}`,
        actorObjectId: org.orgId,
        requestId: "only-test-lane"
      });
    });

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      // The DEFAULT lane is `build`, and there is no build-lane binding here. An unfiltered
      // `.limit(1)` would return the test-lane row and the deploy would dispatch to it.
      expect(await getExecutorBinding(tx, org.orgId, targetId, "configuration")).toBeUndefined();
      expect(
        await getExecutorBinding(tx, org.orgId, targetId, "configuration", "test")
      ).toMatchObject({ pluginModule: "argo-workflows" });
    });
  });

  it("(3) re-upserting one lane updates THAT lane and leaves the other alone", async () => {
    const targetId = await makeTarget();
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      for (const lane of ["build", "test"] as const) {
        await upsertExecutorBinding(tx, {
          orgId: org.orgId,
          targetObjectId: targetId,
          type: "configuration",
          lane,
          pluginModule: lane === "build" ? "argocd" : "argo-workflows",
          pluginInstanceId: `${lane}-${randomUUID().slice(0, 8)}`,
          actorObjectId: org.orgId,
          requestId: `seed-${lane}`
        });
      }
      await upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: targetId,
        type: "configuration",
        lane: "test",
        pluginModule: "argo-workflows",
        pluginInstanceId: "wf-rebound",
        actorObjectId: org.orgId,
        requestId: "rebind-test"
      });
    });

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      expect(
        await getExecutorBinding(tx, org.orgId, targetId, "configuration", "test")
      ).toMatchObject({ pluginInstanceId: "wf-rebound" });
      // The build lane is untouched - the property the pre-P3 bug violated one dimension over.
      expect(await getExecutorBinding(tx, org.orgId, targetId, "configuration")).toMatchObject({
        pluginModule: "argocd"
      });
    });
  });

  it("(4) a caller that never mentions a lane behaves exactly as before, and provenance defaults to NULL", async () => {
    const targetId = await makeTarget();
    const row = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: targetId,
        type: "configuration",
        pluginModule: "argocd",
        pluginInstanceId: `argo-${randomUUID().slice(0, 8)}`,
        actorObjectId: org.orgId,
        requestId: "no-lane"
      })
    );
    expect(row).toBeDefined();

    const stored = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(executorBindings)
        .where(
          and(eq(executorBindings.orgId, org.orgId), eq(executorBindings.targetObjectId, targetId))
        )
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.lane).toBe("build");
    // NULL provenance is what marks this as HAND-AUTHORED, so the reconciler's prune leaves it be.
    expect(stored[0]?.managedByPolicyId).toBeNull();
  });
});
