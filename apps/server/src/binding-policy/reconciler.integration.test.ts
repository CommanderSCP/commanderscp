import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { executorBindings } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject } from "../graph/objects-repo.js";
import { createRelationship } from "../graph/relationships-repo.js";
import {
  resolveLaneBinding,
  upsertExecutorBinding
} from "../coordination/executor-bindings-repo.js";
import { upsertHook } from "../coordination/pipeline-hooks-repo.js";
import { reconcileExecutorBindingsForOrg } from "./reconcile-bindings.js";
import { reconcileOrgTick } from "../coordination/reconcile.js";
import { createInMemoryFakeHost } from "../coordination/test-support/fake-plugin-host.js";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * THE DOMAIN-LOCAL BINDING RECONCILER, END TO END (ADR-0046 section 4).
 *
 * WHAT HAS TO BE TRUE, and none of it is established by "a row appeared":
 *
 *  1. A domain declares its HOW ONCE, as a policy, and the placements a team declared get bound -
 *     without the team naming an execution system, which it cannot see.
 *  2. HAND-AUTHORED BINDINGS ARE NEVER TOUCHED. Provenance is read from the row
 *     (`managed_by_policy_id`), never inferred from what matches now - so the rule cannot delete
 *     the one-offs an operator cared enough to write by hand.
 *  3. PRUNING IS REAL. Remove the placement and the derived row goes; the reconciler owning its
 *     rows is what makes that safe.
 *  4. THE FALLBACK IS NOT MATERIALISED. A test lane covered by the build lane produces no second
 *     row and no gap - `resolveLaneBinding` does it at read time, once.
 *
 * MUTATION LOG - each applied, watched fail, reverted, watched pass (MEASURED)
 * | Mutation | Result |
 * |---|---|
 * | the prune query drops `isNotNull(managedByPolicyId)` | (2) FAILS - the hand-authored one-off is deleted, which is the outcome ADR-0046 section 4 exists to forbid |
 * | the reconciler MATERIALISES a lane fallback (guard removed) | (4) FAILS - a second, duplicate row appears in the test lane. **SURVIVED the first version of (4)**, which declared no test hook: `listHookLanes` then returns `["build"]` only, the resolver never resolves a test lane, and the guard is never reached. The hook is what makes the case exercise the property. |
 * | the prune never removes anything | (3) FAILS - the derived row outlives the placement that explained it |
 * | `resolveLaneBinding` stops falling back | (4) FAILS - a declared test hook has no reachable executor even though the build lane covers it |
 * | **the call is deleted from `reconcileOrgTick`** | (5) FAILS **and the other four stay green** - which is the whole reason (5) exists. Cases (1)-(4) call the reconciler directly, so they cannot tell a wired loop from an unwired one, and "built, tested, called by nobody" is this repo's named dominant failure. |
 */
describe("binding reconciler (ADR-0046 section 4)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "reconciler");
  });

  afterAll(async () => {
    await server.close();
  });

  interface Estate {
    componentId: string;
    targetId: string;
    systemId: string;
  }

  /** A team's WHAT (component, target, placement, releases_via) plus the domain's execution system. */
  async function estate(label: string): Promise<Estate> {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const base = {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: `estate-${label}`
      };
      const service = await createObject(tx, { ...base, typeId: "service", name: `svc-${label}` });
      const component = await createObject(tx, {
        ...base,
        typeId: "component",
        name: `cmp-${label}`
      });
      await createRelationship(tx, {
        ...base,
        typeId: "contains",
        fromId: service.id,
        toId: component.id
      });
      const target = await createObject(tx, {
        ...base,
        typeId: "deployment-target",
        name: `dt-${label}`
      });
      await createObject(tx, {
        ...base,
        typeId: "placement",
        name: `pl-${label}`,
        properties: { componentId: component.id, deploymentTargetId: target.id }
      });
      const topology = await createObject(tx, {
        ...base,
        typeId: "release-topology",
        name: `topo-${label}`,
        properties: { waves: [] }
      });
      // The Type this component releases via - what the reconciler reads to know which binding the
      // placement needs.
      await createRelationship(tx, {
        ...base,
        typeId: "releases_via",
        fromId: component.id,
        toId: topology.id,
        properties: { type: "configuration" }
      });
      const system = await createObject(tx, {
        ...base,
        typeId: "execution-system",
        name: `es-${label}`,
        properties: { kind: "argocd", pluginModule: "argocd" }
      });
      return { componentId: component.id, targetId: target.id, systemId: system.id };
    });
  }

  async function declareHow(e: Estate, label: string): Promise<string> {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const policy = await createObject(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: `how-${label}`,
        typeId: "policy",
        name: `how-${label}`,
        properties: {
          enforcement: "required",
          scope: { objectRef: e.targetId },
          effects: [
            {
              executorBinding: {
                executionSystemUrn: e.systemId,
                type: "configuration"
              }
            }
          ]
        }
      });
      return policy.id;
    });
  }

  function run() {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      reconcileExecutorBindingsForOrg(tx, org.orgId, `test-${randomUUID().slice(0, 8)}`)
    );
  }

  async function rowsFor(targetId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select()
        .from(executorBindings)
        .where(
          and(eq(executorBindings.orgId, org.orgId), eq(executorBindings.targetObjectId, targetId))
        )
    );
  }

  it("(1) one policy line binds a team's placement — the team never names an execution system", async () => {
    const e = await estate(`a-${randomUUID().slice(0, 6)}`);
    // Before the HOW exists, the placement is UNBOUND and said so - the loud half of res 2.
    const before = await run();
    expect(before.gaps.some((g) => g.targetObjectId === e.targetId && g.reason === "unbound")).toBe(
      true
    );
    expect(await rowsFor(e.targetId)).toHaveLength(0);

    const policyId = await declareHow(e, "a");
    const after = await run();
    expect(after.gaps.filter((g) => g.targetObjectId === e.targetId)).toEqual([]);

    const rows = await rowsFor(e.targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "configuration",
      lane: "build",
      executionSystemId: e.systemId,
      // Provenance READ FROM THE ROW - the whole basis of the prune rule below.
      managedByPolicyId: policyId
    });
  });

  it("(2) a hand-authored binding is never updated and never pruned", async () => {
    const e = await estate(`b-${randomUUID().slice(0, 6)}`);
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertExecutorBinding(tx, {
        orgId: org.orgId,
        targetObjectId: e.targetId,
        type: "configuration",
        pluginModule: "fake-executor",
        pluginInstanceId: "hand-authored-one-off",
        actorObjectId: org.orgId,
        requestId: "by-hand"
      })
    );

    // No policy anywhere for this target, so the reconciler wants nothing here - and the row must
    // survive anyway, because NULL provenance means a human wrote it.
    await run();
    const rows = await rowsFor(e.targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pluginInstanceId: "hand-authored-one-off",
      managedByPolicyId: null
    });
  });

  it("(3) removing the placement prunes the derived row, and only the derived one", async () => {
    const e = await estate(`c-${randomUUID().slice(0, 6)}`);
    await declareHow(e, "c");
    await run();
    expect(await rowsFor(e.targetId)).toHaveLength(1);

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx.execute(
        (await import("drizzle-orm")).sql`
          UPDATE objects SET deleted_at = now()
          WHERE org_id = ${org.orgId}::uuid
            AND type_id = 'placement'
            AND properties ->> 'deploymentTargetId' = ${e.targetId}
        `
      );
    });

    const report = await run();
    expect(report.pruned).toBeGreaterThanOrEqual(1);
    expect(await rowsFor(e.targetId)).toHaveLength(0);
  });

  it("(4) the test lane falls back at READ time — no second row, and no spurious gap", async () => {
    const e = await estate(`d-${randomUUID().slice(0, 6)}`);
    await declareHow(e, "d");
    // THE COMPONENT MUST DECLARE A TEST HOOK, or this case does not exercise the fallback at all.
    // Without a hook `listHookLanes` returns `["build"]` only, the resolver never resolves a test
    // lane, and the "do not materialise a fallback" guard is never reached — which is exactly how
    // the first version of this case passed with that guard DELETED. Measured, not reasoned.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      upsertHook(tx, org.orgId, {
        componentObjectId: e.componentId,
        kind: "postDeploy",
        hookId: "integration",
        workflow: { repo: "corp/app", branch: "main", path: ".argo/integration.yaml" }
      })
    );
    await run();

    // Exactly one row, in the build lane. Materialising a fallback would have written two.
    const rows = await rowsFor(e.targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lane).toBe("build");

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const resolved = await resolveLaneBinding(tx, org.orgId, e.targetId, "configuration", "test");
      expect(resolved?.viaLaneFallback).toBe(true);
      expect(resolved?.row.executionSystemId).toBe(e.systemId);
    });
  });

  it("(5) WIRING: the REAL reconcile tick runs it — delete the call from reconcileOrgTick and this dies", async () => {
    // THE ONLY CHECK THAT WORKS FOR "installed" IS DELETING THE WIRING AND WATCHING A TEST FAIL.
    // Every other case in this file calls `reconcileExecutorBindingsForOrg` directly, so all four
    // stay green with the loop wired to nothing — which is this repo's named dominant failure
    // (built, tested, and called by no one). Measured: with the try/catch block removed from
    // `reconcileOrgTick`, this case fails and the other four do not.
    const e = await estate(`e-${randomUUID().slice(0, 6)}`);
    await declareHow(e, "e");
    expect(await rowsFor(e.targetId)).toHaveLength(0);

    await reconcileOrgTick(
      server.deps.db,
      org.orgId,
      createInMemoryFakeHost(),
      server.deps.celSandbox!,
      server.deps.config.secretsMasterKey
    );

    const rows = await rowsFor(e.targetId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.executionSystemId).toBe(e.systemId);
  });
});

/**
 * b5-perf: `gatherContributions` batched to ONE `matchPoliciesForTargets` call per org-tick instead
 * of one per target (`governance/policy-resolve.ts`'s `matchPoliciesForTargetsByTarget`).
 *
 * A dedicated org and describe block, not a case tacked onto the suite above: an ORG-WIDE
 * (unscoped) policy is declared here on purpose, and every existing target in a shared org would
 * pick up a second contribution from it — this isolates that blast radius from the suite whose
 * assertions above depend on a target having EXACTLY the contribution its own test declared.
 */
describe("binding reconciler — per-target attribution survives batching (b5-perf)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "reconciler-attr");
  });

  afterAll(async () => {
    await server.close();
  });

  /** A bare component+target+placement+`releases_via` — no policy of its own. */
  async function bareTarget(label: string) {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const base = { orgId: org.orgId, actorObjectId: org.orgId, requestId: `attr-${label}` };
      const service = await createObject(tx, { ...base, typeId: "service", name: `svc-${label}` });
      const component = await createObject(tx, {
        ...base,
        typeId: "component",
        name: `cmp-${label}`
      });
      await createRelationship(tx, {
        ...base,
        typeId: "contains",
        fromId: service.id,
        toId: component.id
      });
      const target = await createObject(tx, {
        ...base,
        typeId: "deployment-target",
        name: `dt-${label}`
      });
      await createObject(tx, {
        ...base,
        typeId: "placement",
        name: `pl-${label}`,
        properties: { componentId: component.id, deploymentTargetId: target.id }
      });
      const topology = await createObject(tx, {
        ...base,
        typeId: "release-topology",
        name: `topo-${label}`,
        properties: { waves: [] }
      });
      await createRelationship(tx, {
        ...base,
        typeId: "releases_via",
        fromId: component.id,
        toId: topology.id,
        properties: { type: "configuration" }
      });
      return { componentId: component.id, targetId: target.id };
    });
  }

  it("two targets that share the org root both bind from ONE unscoped policy in a single pass", async () => {
    const t1 = await bareTarget("attr1");
    const t2 = await bareTarget("attr2");
    const system = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createObject(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "attr-system",
        typeId: "execution-system",
        name: "es-attr",
        properties: { kind: "argocd", pluginModule: "argocd" }
      })
    );

    // UNSCOPED — matches at every target's org root, so t1's and t2's chains resolve to the SAME
    // matched-ancestor object id (the org root). A shared, cross-target dedup key
    // (`${policyId}::${matchedAncestorObjectId}`) would keep only ONE of the two contributions,
    // silently unbinding whichever target lost the race — this is the exact hazard
    // `matchPoliciesForTargetsByTarget`'s per-target dedup exists to close.
    const policy = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createObject(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "attr-policy",
        typeId: "policy",
        name: "org-wide-configuration-binding",
        properties: {
          enforcement: "required",
          effects: [{ executorBinding: { executionSystemUrn: system.id, type: "configuration" } }]
        }
      })
    );

    const report = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      reconcileExecutorBindingsForOrg(tx, org.orgId, `attr-${randomUUID().slice(0, 8)}`)
    );
    expect(report.gaps).toEqual([]);

    const rowsFor = (targetId: string) =>
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx
          .select()
          .from(executorBindings)
          .where(
            and(
              eq(executorBindings.orgId, org.orgId),
              eq(executorBindings.targetObjectId, targetId)
            )
          )
      );

    for (const t of [t1, t2]) {
      const rows = await rowsFor(t.targetId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        executionSystemId: system.id,
        managedByPolicyId: policy.id
      });
    }
  });
});
