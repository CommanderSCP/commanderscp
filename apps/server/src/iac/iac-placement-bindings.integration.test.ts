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
import { objects, executorBindings } from "../db/schema.js";

/**
 * DECLARING AN EXECUTOR BINDING ON A PLACEMENT.
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 * C1 (#215) let a manifest declare `placements`, but not the bindings that hang off them — the
 * pool of "bindings this stack manages" was keyed on owned OBJECTS, and a placement is not in
 * `manifest.objects` (#207 refuses pair-bound types at that door). So `POST /plans` refused every
 * such declaration as "on object(s) this stack does not manage", and its suggested remedy
 * ("declare that object in this stack's manifest") was unavailable by construction.
 *
 * That mattered beyond IaC completeness: on the live estate 61 of 66 executor bindings hang off
 * placements, so the collection was silently unable to express the majority of real bindings.
 *
 * ============================================================================================
 * ADDRESSING IS THE PAIR, NEVER THE URN
 * ============================================================================================
 * A placement's URN is DERIVED (ADR-0026 D3) from the org id plus both endpoints' *display names*
 * — `urn:scp:<orgId>:placement:<component>/<deployment-target>`. An author cannot write that, and
 * it changes under a rename.
 *
 * So a placement is addressed as `targetUrn` (the COMPONENT) narrowed by `deploymentTargetUrn`.
 * The first shape tried was a separate `targetPlacement` pair replacing `targetUrn`, and it failed
 * the oasdiff /v1 additive-only gate: making `targetUrn` optional is a breaking change for every
 * response that echoes a plan's manifest and diff. Expressing the placement as a QUALIFIER keeps
 * `targetUrn` required, and collapses ownership back to one unconditional rule — the stack must own
 * `targetUrn`, which for a placement IS its component (decision Q4).
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | revert the pool to `ownedIdList` (objects only) | FOUR fail: adopt, prune, the cross-stack update, and "removes BOTH" in the placements suite |
 * | drop the "pair must be declared" check | the undeclared-pair test FAILS (asserted on the offender TEXT, so the other branch cannot satisfy it) |
 * | drop `resolveEndpoint` from the BINDING loop | only the noop-placement test fails |
 * | drop `resolveEndpoint` from the PLACEMENTS loop | only the no-binding test fails |
 * | drop the Q2 surviving-binding check | only the TOCTOU test in the placements suite fails |
 *
 * The two `resolveEndpoint` rows are why this file has nine tests rather than seven. With the
 * original seven, each call was individually redundant — every single-drop mutation stayed green
 * because the other covered it, and only removing BOTH failed anything. Two lines each "covered"
 * only by the other are not covered at all, so the cases that separate them were added: a placement
 * whose pair is `noop` (the placements loop skips those) and a placement with no binding at all.
 *
 * An earlier version of the foreign-component test asserted only a 400, which the PLACEMENT guard
 * could satisfy on its own — green under a mutation that broke the binding guard entirely. It now
 * asserts the offender text and uses a stack declaring no placements, so only the binding guard can
 * answer.
 */
describe("IaC executor bindings on placements", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "iac-pl-bind");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });
  afterAll(async () => {
    await server?.close();
  });

  function urns(stackName: string) {
    return {
      svc: `urn:scp:${stackName}:service:svc`,
      comp: `urn:scp:${stackName}:component:api`,
      tgt: `urn:scp:${stackName}:deployment-target:prod`
    };
  }

  /** A stack with one service, one component, one deployment-target, and the pair placed. */
  function baseManifest(stackName: string, extra: Partial<DesiredStateManifest> = {}) {
    const { svc, comp, tgt } = urns(stackName);
    const manifest: DesiredStateManifest = {
      stackName,
      objects: [
        { urn: svc, typeId: "service", name: `svc-${stackName}` },
        { urn: comp, typeId: "component", name: `api-${stackName}` },
        { urn: tgt, typeId: "deployment-target", name: `prod-${stackName}` }
      ],
      relationships: [{ typeId: "contains", fromUrn: svc, toUrn: comp }],
      placements: [{ componentUrn: comp, deploymentTargetUrn: tgt }],
      ...extra
    };
    return manifest;
  }

  function binding(stackName: string, externalRef = "app") {
    const { comp, tgt } = urns(stackName);
    return {
      targetUrn: comp,
      deploymentTargetUrn: tgt,
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${stackName}`,
      externalRef
    };
  }

  async function apply(manifest: DesiredStateManifest) {
    const plan = await admin.plans.create(manifest);
    return admin.plans.apply(plan.id);
  }

  /** `POST /plans` raw, because a 400's OFFENDER TEXT is the only thing that distinguishes the two
   *  refusal branches — the SDK error surfaces the status alone, so asserting on it cannot tell
   *  "you do not own this component" from "you did not declare this pair". A test that cannot tell
   *  them apart passes when either fires, which is how it stays green under the wrong mutation. */
  async function planRaw(manifest: DesiredStateManifest) {
    const res = await fetch(`${server.baseUrl}/plans`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${org.adminToken}` },
      body: JSON.stringify({ manifest })
    });
    return {
      status: res.status,
      detail: String(((await res.json()) as { detail?: unknown }).detail ?? "")
    };
  }

  /** The live binding rows whose target is the placement of `componentUrn`. */
  async function bindingsOnPlacementOf(componentUrn: string) {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const comp = await tx.query.objects.findFirst({
        where: (t, { eq: e, and: a }) => a(e(t.orgId, org.orgId), e(t.urn, componentUrn))
      });
      if (!comp) return [];
      const placements = await tx
        .select({ id: objects.id, properties: objects.properties })
        .from(objects)
        .where(
          and(
            eq(objects.orgId, org.orgId),
            eq(objects.typeId, "placement"),
            isNull(objects.deletedAt)
          )
        );
      const mine = placements.filter(
        (p) => (p.properties as { componentId?: string }).componentId === comp.id
      );
      if (mine.length === 0) return [];
      const rows = await tx
        .select({
          targetObjectId: executorBindings.targetObjectId,
          externalRef: executorBindings.externalRef
        })
        .from(executorBindings)
        .where(eq(executorBindings.orgId, org.orgId));
      return rows.filter((r) => mine.some((p) => p.id === r.targetObjectId));
    });
  }

  it("creates the binding ON THE PLACEMENT, not on either endpoint", async () => {
    const s = `pb-create-${uuidv7().slice(0, 8)}`;
    const { comp } = urns(s);
    await apply(baseManifest(s, { executorBindings: [binding(s)] }));

    const rows = await bindingsOnPlacementOf(comp);
    expect(rows, "one binding, and its target_object_id is the placement row").toHaveLength(1);
    expect(rows[0]!.externalRef).toBe("app");
  });

  it("ADOPTS on re-apply — the pool must see a binding whose target is a placement", async () => {
    // The mutation that matters: with the pool keyed on owned OBJECTS only, this binding is
    // invisible to the diff, so every re-plan proposes it again and DoD (b) is false.
    const s = `pb-idem-${uuidv7().slice(0, 8)}`;
    const m = baseManifest(s, { executorBindings: [binding(s)] });
    await apply(m);
    const second = await apply(m);

    expect(second.summary.creates, "the second apply must create nothing").toBe(0);
    expect(second.summary.updates, "and update nothing").toBe(0);
    expect(await bindingsOnPlacementOf(urns(s).comp)).toHaveLength(1);
  });

  it("prunes the binding when the manifest stops declaring it", async () => {
    // The other half of adoption: a pool that can see the row must also be able to remove it,
    // otherwise a binding on a placement is write-once forever.
    const s = `pb-prune-${uuidv7().slice(0, 8)}`;
    await apply(baseManifest(s, { executorBindings: [binding(s)] }));
    expect(await bindingsOnPlacementOf(urns(s).comp)).toHaveLength(1);

    await apply(baseManifest(s));
    expect(
      await bindingsOnPlacementOf(urns(s).comp),
      "absent == 'I declare none' == prune, exactly as for an object-targeted binding"
    ).toHaveLength(0);
  });

  it("apply-time create AND prune each write their own audit event — IaC is a binding write door too (2026-08-25 census)", async () => {
    // Same repo function (`upsertExecutorBinding`/`deleteExecutorBinding`) the typed routes call —
    // this pins that `executePlanDiff` (apply) reaches it too, not only `PUT`/`DELETE /binding`.
    const s = `pb-audit-${uuidv7().slice(0, 8)}`;
    const { comp } = urns(s);
    await apply(baseManifest(s, { executorBindings: [binding(s)] }));
    const placementRows = await bindingsOnPlacementOf(comp);
    const placementId = placementRows[0]!.targetObjectId;

    await apply(baseManifest(s));

    const page = await admin.auditEvents.list({ limit: 200 });
    const putEvents = page.items.filter(
      (e) => e.action === "executor.binding.put" && e.subjectId === placementId
    );
    const deleteEvents = page.items.filter(
      (e) => e.action === "executor.binding.delete" && e.subjectId === placementId
    );
    expect(putEvents).toHaveLength(1);
    expect(putEvents[0]!.reason).toContain("fake-executor");
    expect(deleteEvents).toHaveLength(1);
    expect(deleteEvents[0]!.reason).toContain("fake-executor");
  });

  it("REFUSES a binding on a pair the manifest does not declare as a placement", async () => {
    // Without this, apply order destroys itself: binding-prune, placement-prune (removes the pair),
    // placement-create (does not, it was not declared), binding-create (resolves nothing) — dying
    // mid-apply after earlier writes have landed.
    const s = `pb-undeclared-${uuidv7().slice(0, 8)}`;
    const m = baseManifest(s, { executorBindings: [binding(s)] });
    delete (m as { placements?: unknown }).placements;

    const { status, detail } = await planRaw(m);
    expect(status).toBe(400);
    expect(detail, "and it must be THIS branch, not the ownership one").toContain(
      "whose pair this manifest does not declare in placements"
    );
  });

  it("REFUSES a binding on a placement whose COMPONENT belongs to another stack (Q4)", async () => {
    const owner = `pb-owner-${uuidv7().slice(0, 8)}`;
    await apply(baseManifest(owner));

    // This stack declares NO placements of its own and does not declare the foreign pair either —
    // so the placements guard has nothing to object to and only the BINDING guard can refuse. That
    // isolation is the point: an earlier version of this test also declared the foreign placement,
    // and stayed green under a mutation that broke the binding guard entirely, because the
    // placement guard was answering for it.
    const other = `pb-other-${uuidv7().slice(0, 8)}`;
    const foreign: DesiredStateManifest = {
      stackName: other,
      objects: [{ urn: `urn:scp:${other}:service:svc`, typeId: "service", name: `svc-${other}` }],
      relationships: [],
      executorBindings: [binding(owner)]
    };

    const { status, detail } = await planRaw(foreign);
    expect(status, "ownership follows the COMPONENT, so this stack may not write onto it").toBe(
      400
    );
    expect(detail).toContain("executorBinding -> placement");
    expect(detail, "the ownership branch, not the undeclared-pair branch").not.toContain(
      "whose pair this manifest does not declare"
    );
  });

  it("binds a placement whose DEPLOYMENT-TARGET belongs to another stack", async () => {
    // The permissive half of Q4, and the regression that `resolveEndpoint(deploymentTargetUrn)`
    // exists for: the target is never declared by this stack, so apply must still resolve it.
    const platform = `pb-plat-${uuidv7().slice(0, 8)}`;
    const platformTarget = `urn:scp:${platform}:deployment-target:shared`;
    await apply({
      stackName: platform,
      objects: [{ urn: platformTarget, typeId: "deployment-target", name: `shared-${platform}` }],
      relationships: []
    });

    const app = `pb-app-${uuidv7().slice(0, 8)}`;
    const appSvc = `urn:scp:${app}:service:svc`;
    const appComp = `urn:scp:${app}:component:api`;
    await apply({
      stackName: app,
      objects: [
        { urn: appSvc, typeId: "service", name: `svc-${app}` },
        { urn: appComp, typeId: "component", name: `api-${app}` }
      ],
      relationships: [{ typeId: "contains", fromUrn: appSvc, toUrn: appComp }],
      placements: [{ componentUrn: appComp, deploymentTargetUrn: platformTarget }],
      executorBindings: [
        {
          targetUrn: appComp,
          deploymentTargetUrn: platformTarget,
          pluginModule: "fake-executor",
          pluginInstanceId: `inst-${app}`,
          externalRef: "cross"
        }
      ]
    });

    const rows = await bindingsOnPlacementOf(appComp);
    expect(
      rows,
      "a platform team owning the target must not block the app team's binding"
    ).toHaveLength(1);
    expect(rows[0]!.externalRef).toBe("cross");
  });

  it("places a component at ANOTHER stack's deployment-target with no binding at all", async () => {
    // A pre-existing C1 (#215) gap, not something this change introduced. `ManifestPlacementSchema`
    // says the deployment-target "may belong to another stack", but `prepareApplyChecks` resolved
    // only the COMPONENT — so `endpointId(deploymentTargetUrn)` threw "internal: could not resolve
    // object id" at apply for exactly the case the schema advertises. It never bit the live estate
    // because every stack there happens to declare its own targets.
    const platform = `pb-plat3-${uuidv7().slice(0, 8)}`;
    const platformTarget = `urn:scp:${platform}:deployment-target:shared`;
    await apply({
      stackName: platform,
      objects: [{ urn: platformTarget, typeId: "deployment-target", name: `shared-${platform}` }],
      relationships: []
    });

    const app = `pb-app3-${uuidv7().slice(0, 8)}`;
    const appSvc = `urn:scp:${app}:service:svc`;
    const appComp = `urn:scp:${app}:component:api`;
    await apply({
      stackName: app,
      objects: [
        { urn: appSvc, typeId: "service", name: `svc-${app}` },
        { urn: appComp, typeId: "component", name: `api-${app}` }
      ],
      relationships: [{ typeId: "contains", fromUrn: appSvc, toUrn: appComp }],
      placements: [{ componentUrn: appComp, deploymentTargetUrn: platformTarget }]
    });

    const placed = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const comp = await tx.query.objects.findFirst({
        where: (t, { eq: e, and: a }) => a(e(t.orgId, org.orgId), e(t.urn, appComp))
      });
      const all = await tx
        .select({ properties: objects.properties })
        .from(objects)
        .where(
          and(
            eq(objects.orgId, org.orgId),
            eq(objects.typeId, "placement"),
            isNull(objects.deletedAt)
          )
        );
      return all.filter(
        (pl) => (pl.properties as { componentId?: string }).componentId === comp!.id
      );
    });
    expect(
      placed,
      "the placement lands even though this stack owns neither end of the target"
    ).toHaveLength(1);
  });

  it("UPDATES a cross-stack binding when the placement itself is unchanged", async () => {
    // The case the two `resolveEndpoint(deploymentTargetUrn)` calls exist for, and the only one
    // that distinguishes them. The placements loop SKIPS `noop` entries, so on a re-apply where the
    // pair is unchanged but the binding changed, the placement no longer resolves the foreign
    // deployment-target — only the binding loop does. Drop that one line and this fails with
    // "internal: could not resolve object id" while every other test here stays green.
    const platform = `pb-plat2-${uuidv7().slice(0, 8)}`;
    const platformTarget = `urn:scp:${platform}:deployment-target:shared`;
    await apply({
      stackName: platform,
      objects: [{ urn: platformTarget, typeId: "deployment-target", name: `shared-${platform}` }],
      relationships: []
    });

    const app = `pb-app2-${uuidv7().slice(0, 8)}`;
    const appSvc = `urn:scp:${app}:service:svc`;
    const appComp = `urn:scp:${app}:component:api`;
    const build = (externalRef: string): DesiredStateManifest => ({
      stackName: app,
      objects: [
        { urn: appSvc, typeId: "service", name: `svc-${app}` },
        { urn: appComp, typeId: "component", name: `api-${app}` }
      ],
      relationships: [{ typeId: "contains", fromUrn: appSvc, toUrn: appComp }],
      placements: [{ componentUrn: appComp, deploymentTargetUrn: platformTarget }],
      executorBindings: [
        {
          targetUrn: appComp,
          deploymentTargetUrn: platformTarget,
          pluginModule: "fake-executor",
          pluginInstanceId: `inst-${app}`,
          externalRef
        }
      ]
    });

    await apply(build("before"));
    const second = await apply(build("after"));

    expect(second.summary.updates, "the binding changed and nothing else did").toBe(1);
    const rows = await bindingsOnPlacementOf(appComp);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.externalRef).toBe("after");
  });

  it("REFUSES a binding that names no target at all", async () => {
    // Note what is NOT tested here, because it can no longer happen: there is no "named both
    // addressings" failure mode. A placement is `targetUrn` NARROWED by `deploymentTargetUrn`, not
    // an alternative to it, so the two cannot conflict — which is also why `targetUrn` stayed
    // REQUIRED in the response schemas and this change breaks no API consumer.
    const s = `pb-neither-${uuidv7().slice(0, 8)}`;
    const neither = baseManifest(s, {
      executorBindings: [
        { pluginModule: "fake-executor", pluginInstanceId: "inst", externalRef: "x" } as never
      ]
    });
    await expect(admin.plans.create(neither)).rejects.toMatchObject({ status: 400 });
  });
});
