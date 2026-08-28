import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import { componentConvergence, componentRollouts } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * ROLLOUTS AND CONVERGENCE SURVIVE APPLY (D12, D25(b); migration 0106).
 *
 * ============================================================================================
 * THE DEFECT THIS CLOSES, AND WHY A SHAPE ASSERTION WOULD NOT HAVE CAUGHT IT
 * ============================================================================================
 * `@scp/iac` has emitted both collections since the L1 doors and the `CanaryRollout` /
 * `RollingRollout` constructs shipped. `plans-repo.ts` projected NEITHER — its own comment said so
 * ("not projected at all yet") — so a team could declare a canary, watch `scp plan` return a clean
 * diff, apply it, and have the server discard it without a word. Every existing test still passed,
 * because nothing asked what happened to the collection AFTER apply.
 *
 * So the assertions here are on the DATABASE, through the real `POST /plans` + apply route.
 *
 * MUTATION LOG — each applied, watched fail, reverted, watched pass (MEASURED)
 * | Mutation | Result |
 * |---|---|
 * | remove the `rollouts` apply writer | 2 FAIL — (1) and (2). The plan still shows a create and the row is absent: the pre-0106 behaviour exactly, and note the PLAN was never wrong, only the write. |
 * | remove the `convergence` apply writer | 2 FAIL — (3) and (4) |
 * | the snapshot never reads the rollout pool | (2) FAILS — with an empty pool every apply reads as a `create` and no retraction prunes |
 * | `converge: false` is stored as `true` | (4) FAILS — the opt-out is silently inverted |
 */
describe("IaC: rollouts and convergence reach the database", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "rollouts");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server.close();
  });

  const CANARY = {
    strategy: "canary" as const,
    steps: [{ weightPercent: 10, pauseSeconds: 60 }, { weightPercent: 50 }]
  };

  interface Fixture {
    stackName: string;
    componentUrn: string;
    componentId: string;
    productUrn: string;
    productId: string;
  }

  /** A component this stack owns, plus an infrastructure product to converge onto. */
  async function fixture(label: string): Promise<Fixture> {
    const stackName = `stack-${label}-${randomUUID().slice(0, 8)}`;
    const suffix = randomUUID().slice(0, 8);
    const service = await admin.object("service").create({ name: `svc-${label}-${suffix}` });
    const product = await admin.deploymentTargets.create({ name: `prod-${label}-${suffix}` });
    // THE COMPONENT MUST BE DECLARED BY THIS STACK, not created beside it. The diff's pool is
    // "rows on components this stack owns" (`managed_by_stack`), so a component created through the
    // typed route is invisible to matching AND pruning — every apply then reads as a `create` and
    // no retraction ever prunes. Measured: the first version of this fixture used
    // `components.create` and case (2) failed with `create` where `update` belonged, which is the
    // ownership rule announcing itself rather than a bug in the diff.
    const componentName = `cmp-${label}-${suffix}`;
    const componentUrn = `urn:scp:${stackName}:component:${componentName}`;
    await applyManifest({
      stackName,
      objects: [{ urn: componentUrn, typeId: "component", name: componentName, properties: {} }],
      relationships: [{ typeId: "contains", fromUrn: service.urn, toUrn: componentUrn }]
    });
    const component = await admin.object("component").get(componentUrn);
    return {
      stackName,
      componentUrn,
      componentId: component.id,
      productUrn: product.urn,
      productId: product.id
    };
  }

  /** Through the REAL route, via inject rather than the SDK: the generated client's typed body was
   *  arriving empty for a hand-built manifest, and the point of this file is the server's behaviour,
   *  not the client's serialisation. */
  async function applyManifest(manifest: Record<string, unknown>) {
    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/plans",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { manifest } as never
    });
    if (created.statusCode !== 201) {
      throw new Error(`plan rejected: ${created.body}`);
    }
    const plan = created.json() as { id: string; diff: Record<string, unknown> };
    const applied = await server.app.inject({
      method: "POST",
      url: `/api/v1/plans/${plan.id}/apply`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    if (applied.statusCode !== 200) {
      throw new Error(`apply rejected: ${applied.body}`);
    }
    return { plan, applied: applied.json() as Record<string, unknown> };
  }

  /** The component this stack owns, re-declared in every manifest — dropping it would prune the
   *  component itself, and the collections hang off it. */
  function componentObject(f: Fixture) {
    return {
      urn: f.componentUrn,
      typeId: "component",
      name: f.componentUrn.split(":").pop(),
      properties: {}
    };
  }

  async function rolloutRows(componentId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(componentRollouts)
        .where(
          and(
            eq(componentRollouts.orgId, org.orgId),
            eq(componentRollouts.componentObjectId, componentId)
          )
        )
    );
  }

  async function convergenceRows(componentId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(componentConvergence)
        .where(
          and(
            eq(componentConvergence.orgId, org.orgId),
            eq(componentConvergence.componentObjectId, componentId)
          )
        )
    );
  }

  it("(1) a declared rollout LANDS — the plan shows a create and the row exists afterwards", async () => {
    const f = await fixture("a");
    const { plan } = await applyManifest({
      stackName: f.stackName,
      objects: [componentObject(f)],
      relationships: [],
      rollouts: [{ componentUrn: f.componentUrn, targetClass: "cluster", rollout: CANARY }]
    });

    expect((plan.diff as { rollouts?: unknown[] }).rollouts).toEqual([
      expect.objectContaining({ kind: "rollout", action: "create", targetClass: "cluster" })
    ]);

    const rows = await rolloutRows(f.componentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.targetClass).toBe("cluster");
    expect(rows[0]?.rollout).toEqual(CANARY);
  });

  it("(2) a changed strategy is an UPDATE in place, and retracting it prunes", async () => {
    const f = await fixture("b");
    const base = {
      stackName: f.stackName,
      objects: [componentObject(f)],
      relationships: []
    };
    await applyManifest({
      ...base,
      rollouts: [{ componentUrn: f.componentUrn, targetClass: "cluster", rollout: CANARY }]
    });

    const changed = { strategy: "rolling" as const, batchPercent: 25 };
    const { plan } = await applyManifest({
      ...base,
      rollouts: [{ componentUrn: f.componentUrn, targetClass: "cluster", rollout: changed }]
    });
    // UPDATE, not delete+create: the identity is (component, targetClass) and the strategy is its
    // value, so showing a deletion would imply a window with no strategy at all.
    expect((plan.diff as { rollouts?: { action: string }[] }).rollouts?.[0]?.action).toBe("update");
    expect((await rolloutRows(f.componentId))[0]?.rollout).toEqual(changed);

    // ORDINARY PRUNE RULE: dropping the collection retracts it (unlike pipelineHooks, where absent
    // means UNMANAGED precisely so a forgotten key cannot disarm a gate).
    await applyManifest({ ...base, rollouts: [] });
    expect(await rolloutRows(f.componentId)).toHaveLength(0);
  });

  it("(3) a convergence declaration lands with both endpoints resolved", async () => {
    const f = await fixture("c");
    await applyManifest({
      stackName: f.stackName,
      objects: [componentObject(f)],
      relationships: [],
      convergence: [
        {
          componentUrn: f.componentUrn,
          targetUrn: f.productUrn,
          converge: true,
          scope: "changedSubset"
        }
      ]
    });

    const rows = await convergenceRows(f.componentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetObjectId: f.productId,
      converge: true,
      scope: "changedSubset"
    });
  });

  it("(4) `converge: false` is STORED as false — an opt-out is not an absence", async () => {
    const f = await fixture("d");
    await applyManifest({
      stackName: f.stackName,
      objects: [componentObject(f)],
      relationships: [],
      convergence: [
        {
          componentUrn: f.componentUrn,
          targetUrn: f.productUrn,
          converge: false,
          scope: "changedSubset"
        }
      ]
    });

    const rows = await convergenceRows(f.componentId);
    // D8's rule made concrete: the manifest says WHICH, so a deliberate opt-out is a row saying
    // `false`, distinguishable from a fleet nobody ever declared convergence for.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.converge).toBe(false);
  });
});
