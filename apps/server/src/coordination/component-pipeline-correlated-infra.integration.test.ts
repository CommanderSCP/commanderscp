import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { ComponentPipelineCorrelatedInfra } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { compileAndPersistPlan } from "./plan-service.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * THE CORRELATED-INFRASTRUCTURE LANE (owner decision, 2026-08-24) — through the real HTTP route.
 * An infrastructure change is CORRELATED to a component when its wave/bound target names a
 * deployment-target one of the component's placements ALSO names, or the component is `hosted_on`
 * it; a `provides`/`requires` coupling additionally correlates, with its own `route`. Each entry
 * states its provenance (`correlatedVia.route` + `target`), read off the server's own matching.
 *
 * ALSO COVERED: a change found via BOTH the placement/hosted_on arm and the coupling arm at once —
 * the merge keeps the placement/hosted_on route (and its named target) and still surfaces
 * `coupledKey`, per `component-pipeline.ts`'s `coupledKeyByChangeId` overlay (~:1131-1207).
 *
 * NOT COVERED here: a federation/cross-domain fixture (no two-domain harness exists for this
 * suite, the same gap `component-pipeline.integration.test.ts`'s own mutation log records for
 * `maintainedBy`).
 */
describe("component pipeline: correlatedInfra (owner decision, 2026-08-24)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  const uniq = (p: string) => `${p}-${uuidv7()}`;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "pipeline-correlated-infra");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function correlatedInfraOf(
    componentId: string
  ): Promise<ComponentPipelineCorrelatedInfra | null | undefined> {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/components/${componentId}/pipeline`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode, "the pipeline route must answer").toBe(200);
    return res.json().correlatedInfra;
  }

  /** Compiles a change's plan directly, the same shortcut `component-pipeline.integration.test.ts`
   *  takes: compilation is what writes the `change_wave_targets` rows this feature reads, and the
   *  reconcile loop's OWN job (locking, state transitions) is covered elsewhere. `topologyObjectId:
   *  null` compiles LEGACY-shaped: the change's own `targets` become the wave target ids verbatim,
   *  which is how an infrastructure change against a deployment-target OBJECT (no component at all)
   *  lands `change_wave_targets.target_object_id` on the deployment-target's own id. */
  async function compile(
    change: { id: string },
    targetObjectIds: string[],
    topologyObjectId: string | null = null
  ) {
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      compileAndPersistPlan(tx, {
        orgId: org.orgId,
        changeObjectId: change.id,
        targetObjectIds,
        topologyObjectId,
        topologyVersion: null
      })
    );
  }

  it("a NEW correlation-target check: an infra change against a shared deployment-target OBJECT appears with route 'placement' and the target's name", async () => {
    const gamma = await admin.deploymentTargets.create({
      name: uniq("gamma"),
      properties: { environment: "gamma" }
    });
    const component = await createOrphanComponent(server, org, uniq("placed-at-gamma"));
    await admin.placements.create({ component: component.id, deploymentTarget: gamma.id });

    // An infrastructure change with NO component in its targets at all — a legitimate shape (a
    // cluster upgrade, say), and the one that keeps `target_object_id` a raw deployment-target id
    // under LEGACY compilation rather than a placement id under stage mode.
    const infraChange = await admin.changes.propose({
      name: uniq("infra-on-gamma"),
      targets: [gamma.id],
      type: "infrastructure"
    });
    await compile(infraChange, [gamma.id]);

    const correlated = await correlatedInfraOf(component.id);
    expect(correlated).not.toBeNull();
    expect(correlated).not.toBeUndefined();
    const entry = correlated!.changes.find((c) => c.changeObjectId === infraChange.id);
    expect(
      entry,
      "the shared deployment-target correlates the infra change to this component"
    ).toBeDefined();
    expect(entry!.name).toBe(infraChange.name);
    expect(entry!.type).toBe("infrastructure");
    expect(entry!.correlatedVia.route).toBe("placement");
    expect(entry!.correlatedVia.target).toEqual({ objectId: gamma.id, name: gamma.name });
    expect(entry!.coupledKey).toBeNull();
  });

  it("the component's OWN infra change is EXCLUDED — the lane it sits beside already renders it", async () => {
    const gamma = await admin.deploymentTargets.create({
      name: uniq("gamma"),
      properties: { environment: "gamma" }
    });
    const component = await createOrphanComponent(server, org, uniq("own-infra"));
    await admin.placements.create({ component: component.id, deploymentTarget: gamma.id });
    const topo = await admin.object("release-topology").create({
      name: uniq("topo"),
      properties: { waves: [{ name: "gamma", mode: "parallel", targets: [gamma.id] }] }
    });
    await admin.relationships.create({
      typeId: "releases_via",
      fromId: component.id,
      toId: topo.id
    });

    // Compiled STAGE-shaped, against the component ITSELF: its wave target is its OWN placement id,
    // which lands squarely in this component's own key set (`placementByTargetId`) — the exact case
    // the `properties.targets` exclusion exists for.
    const ownInfraChange = await admin.changes.propose({
      name: uniq("own-infra-release"),
      targets: [component.id],
      type: "infrastructure"
    });
    await compile(ownInfraChange, [component.id], topo.id);

    const correlated = await correlatedInfraOf(component.id);
    expect(
      correlated!.changes.some((c) => c.changeObjectId === ownInfraChange.id),
      "this component's own release must not appear as though it were someone else's correlated infra"
    ).toBe(false);
  });

  it("a `hosted_on`-ONLY correlation (no placement at the target) appears with route 'hosted_on'", async () => {
    const gamma = await admin.deploymentTargets.create({
      name: uniq("gamma"),
      properties: { environment: "gamma" }
    });
    const component = await createOrphanComponent(server, org, uniq("hosted-on-gamma"));
    // Deliberately NO placement — `hosted_on` is a component-level fact independent of `placement`.
    await admin.relationships.create({
      typeId: "hosted_on",
      fromId: component.id,
      toId: gamma.id
    });

    const infraChange = await admin.changes.propose({
      name: uniq("infra-hosted-on-gamma"),
      targets: [gamma.id],
      type: "infrastructure"
    });
    await compile(infraChange, [gamma.id]);

    const correlated = await correlatedInfraOf(component.id);
    const entry = correlated!.changes.find((c) => c.changeObjectId === infraChange.id);
    expect(entry, "`hosted_on` alone must still correlate the infra change").toBeDefined();
    expect(entry!.correlatedVia.route).toBe("hosted_on");
    expect(entry!.correlatedVia.target).toEqual({ objectId: gamma.id, name: gamma.name });
    expect(entry!.coupledKey).toBeNull();
  });

  it("a COUPLING-only match (no shared place at all) appears with route 'coupling' and the coupled key", async () => {
    const component = await createOrphanComponent(server, org, uniq("requires-feature-a"));
    const elsewhere = await createOrphanComponent(server, org, uniq("unrelated-place"));

    // This component's own recent release REQUIRES a key — no place named that would ever put this
    // component in the infra change's key set.
    await admin.changes.propose({
      name: uniq("own-release-requiring-feature-a"),
      targets: [component.id],
      requires: [{ key: "feature-a", at: elsewhere.id }]
    });

    // An infrastructure change against a wholly unrelated object PROVIDES that same key. It shares
    // no placement, no deployment-target and no `hosted_on` edge with `component` — the coupling
    // arm is the only thing that can find it.
    const providerComponent = await createOrphanComponent(server, org, uniq("provides-feature-a"));
    const providerChange = await admin.changes.propose({
      name: uniq("infra-provides-feature-a"),
      targets: [providerComponent.id],
      type: "infrastructure",
      provides: ["feature-a"]
    });

    const correlated = await correlatedInfraOf(component.id);
    const entry = correlated!.changes.find((c) => c.changeObjectId === providerChange.id);
    expect(entry, "a coupling match needs no shared place at all").toBeDefined();
    expect(entry!.correlatedVia.route).toBe("coupling");
    expect(entry!.correlatedVia.target, "a coupling-only match names no place").toBeNull();
    expect(entry!.coupledKey).toBe("feature-a");
  });

  it("a BOTH-arms match (placement + coupling on the same change) keeps route 'placement', names the target, AND carries coupledKey", async () => {
    const gamma = await admin.deploymentTargets.create({
      name: uniq("gamma"),
      properties: { environment: "gamma" }
    });
    const component = await createOrphanComponent(server, org, uniq("placed-and-coupled"));
    await admin.placements.create({ component: component.id, deploymentTarget: gamma.id });

    // This component's own recent release REQUIRES a key — sets up the coupling arm's key set.
    await admin.changes.propose({
      name: uniq("own-release-requiring-feature-both"),
      targets: [component.id],
      requires: [{ key: "feature-both", at: gamma.id }]
    });

    // ONE infra change that matches BOTH arms: it targets the shared deployment-target (placement
    // arm, via `change_wave_targets.target_object_id`) AND it `provides` the key the component's
    // own change `requires` (coupling arm, via the jsonb-containment probe).
    const bothArmsChange = await admin.changes.propose({
      name: uniq("infra-both-arms"),
      targets: [gamma.id],
      type: "infrastructure",
      provides: ["feature-both"]
    });
    await compile(bothArmsChange, [gamma.id]);

    const correlated = await correlatedInfraOf(component.id);
    const entry = correlated!.changes.find((c) => c.changeObjectId === bothArmsChange.id);
    expect(entry, "a change matched by both arms must still appear exactly once").toBeDefined();
    expect(
      correlated!.changes.filter((c) => c.changeObjectId === bothArmsChange.id),
      "no duplicate entry for the same change"
    ).toHaveLength(1);
    expect(entry!.correlatedVia.route, "placement/hosted_on route wins over coupling").toBe(
      "placement"
    );
    expect(
      entry!.correlatedVia.target,
      "the placement arm's target is still named, not nulled by the coupling merge"
    ).toEqual({ objectId: gamma.id, name: gamma.name });
    expect(
      entry!.coupledKey,
      "the coupling arm's key still surfaces even though the placement route won"
    ).toBe("feature-both");
  });

  it("no correlations at all -> { changes: [] }, never a fabricated entry", async () => {
    const component = await createOrphanComponent(server, org, uniq("no-correlations"));
    const correlated = await correlatedInfraOf(component.id);
    expect(correlated, "evaluated and empty — never absent for a live server").not.toBeNull();
    expect(correlated).not.toBeUndefined();
    expect(correlated!.changes).toEqual([]);
  });
});
