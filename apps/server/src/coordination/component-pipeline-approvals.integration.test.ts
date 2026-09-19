import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import {
  createTestComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  waitUntil,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * `ComponentPipelineGateSchema.approvals` (D2, 2026-09-16, docs/proposals/pipeline-mockup-data.md
 * §4/§9): the LIVE approval_requests/votes tally for a stage's current change, placed where the
 * engine actually gates (validating->accepted, `gates.ts:74`) rather than a new per-wave gate.
 * `component-pipeline.integration.test.ts`'s "reports WHAT MUST PASS" test already covers the
 * STATIC declared requirement (`gate.policies[].requireApprovals`); this file covers the LIVE half,
 * which needs a real change driven through the reconcile loop for `approval_requests` to
 * materialize (`governance/gate-orchestrator.ts`'s `materializeApprovalRequest`) — the manual
 * `compileAndPersistPlan` shortcut the sibling file uses never fires a governance gate at all.
 */
describe("component pipeline: the live approval tally sits on the gate, not a new per-wave gate", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let gamma: GraphObject;

  beforeAll(async () => {
    server = await listenTestServer({
      withEventRelay: true,
      withReconcileLoop: true,
      pluginHostOptions: {
        callTimeoutMs: 8_000,
        restartBackoffBaseMs: 50,
        maxRestartBackoffMs: 300
      }
    });
    org = await createTestOrg(server, "component-pipeline-approvals");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    gamma = await admin.deploymentTargets.create({
      name: "gamma",
      properties: { environment: "gamma" }
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function attachTopology(componentId: string, targetId: string) {
    const topo = await admin.object("release-topology").create({
      name: `topo-${uuidv7()}`,
      properties: { waves: [{ name: "gamma", mode: "parallel", targets: [targetId] }] }
    });
    await admin.relationships.create({
      typeId: "releases_via",
      fromId: componentId,
      toId: topo.id
    });
    return topo;
  }

  it("reports the live requestId/voteCount/status for the placement's current change, once cast", async () => {
    const component = await createTestComponent(admin, { name: `gate-approval-${uuidv7()}` });
    const placement = await admin.placements.create({
      component: component.id,
      deploymentTarget: gamma.id
    });
    await attachTopology(component.id, gamma.id);

    const approver = await createTestUser(server, org, [{ role: "Approver", scope: org.orgId }]);
    const approverClient = new ScpClient({ baseUrl: server.baseUrl, token: approver.token });

    await admin.policies.create({
      name: `live-approval-${uuidv7()}`,
      urn: `urn:scp:${org.orgId}:policy:live-approval-${uuidv7()}`,
      properties: {
        scope: { objectRef: placement.id },
        enforcement: "required",
        effects: [{ requireApprovals: { count: 1, fromRole: "Approver", scope: org.orgId } }]
      }
    });

    const change = await admin.changes.propose({
      name: "gated release",
      targets: [component.id]
    });

    const approvalRequest = await waitUntil(
      async () => (await admin.approvals.list({ changeId: change.id, limit: 20 })).items[0],
      { describe: `approval request materialized for change ${change.id}`, timeoutMs: 20_000 }
    );

    const pending = await admin.components.pipeline(component.id);
    const gatedStage = pending.stages.find((s) => s.placement.id === placement.id)!;
    expect(
      gatedStage.gate.approvals,
      "the live count, not just the static requirement already covered elsewhere"
    ).toEqual([
      {
        requestId: approvalRequest.id,
        changeId: change.id,
        fromRole: "Approver",
        requiredCount: 1,
        voteCount: 0,
        status: "pending"
      }
    ]);

    await approverClient.approvals.vote(approvalRequest.id);

    const votedPipeline = await waitUntil(
      async () => {
        const p = await admin.components.pipeline(component.id);
        const stage = p.stages.find((s) => s.placement.id === placement.id)!;
        return stage.gate.approvals?.[0]?.status === "satisfied" ? p : undefined;
      },
      { describe: "the gate's live approval reflects the cast vote", timeoutMs: 20_000 }
    );
    const votedStage = votedPipeline.stages.find((s) => s.placement.id === placement.id)!;
    expect(votedStage.gate.approvals).toEqual([
      {
        requestId: approvalRequest.id,
        changeId: change.id,
        fromRole: "Approver",
        requiredCount: 1,
        voteCount: 1,
        status: "satisfied"
      }
    ]);
  });

  it("a change with no approval policy reports an EMPTY approvals array — a real 'nothing required' fact, never an omission", async () => {
    const component = await createTestComponent(admin, { name: `gate-no-approval-${uuidv7()}` });
    const placement = await admin.placements.create({
      component: component.id,
      deploymentTarget: gamma.id
    });
    await attachTopology(component.id, gamma.id);

    const change = await admin.changes.propose({
      name: "ungated release",
      targets: [component.id]
    });

    const pipeline = await waitUntil(
      async () => {
        const p = await admin.components.pipeline(component.id);
        const stage = p.stages.find((s) => s.placement.id === placement.id);
        return stage?.currents.some((c) => c.changeId === change.id) ? p : undefined;
      },
      { describe: `the ungated placement's current shows change ${change.id}`, timeoutMs: 20_000 }
    );
    const stage = pipeline.stages.find((s) => s.placement.id === placement.id)!;
    expect(stage.gate.policies).toEqual([]);
    expect(stage.gate.approvals).toEqual([]);
  });
});
