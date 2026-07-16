import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { App, Component, Service, Stack, Team } from "@scp/iac";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer
} from "../test-support/harness.js";

/**
 * `@scp/iac` server-side plan/apply — full round trip via the SDK (BUILD_AND_TEST.md §8 M2 item
 * 4). DoD (b): "an `@scp/iac` stack applied twice is a no-op the second time (plan shows zero
 * actions)". `plans-cli.integration.test.ts` covers the same core property driven through the
 * real `scp` binary instead of the SDK directly.
 */
describe("plans: @scp/iac server-side plan/apply", () => {
  let server: ListeningTestServer;

  beforeAll(async () => {
    server = await listenTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it("SDK round trip: synth (2 services, a team owning one, a depends_on edge), plan, apply, re-plan is all-noop", async () => {
    const org = await createTestOrg(server, "plans-sdk");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const stackName = `stack-${randomUUID().slice(0, 8)}`;

    function buildManifest() {
      const app = new App();
      const stack = new Stack(app, stackName);
      const svcA = new Service(stack, "svc-a", { name: "Service A", properties: { tier: "high" } });
      const svcB = new Service(stack, "svc-b", { name: "Service B" });
      const team = new Team(stack, "team", { name: "Team" });
      team.owns(svcA);
      svcB.dependsOn(svcA);
      return stack.synth();
    }

    const manifest = buildManifest();

    const plan = await admin.plans.create(manifest);
    expect(plan.status).toBe("pending");
    // 3 object creates + 2 relationship creates (owns, depends_on).
    expect(plan.diff.summary).toEqual({ creates: 5, updates: 0, deletes: 0, noops: 0 });

    const { plan: applied, summary } = await admin.plans.apply(plan.id);
    expect(applied.status).toBe("applied");
    expect(summary).toEqual({ creates: 5, updates: 0, deletes: 0, noops: 0 });

    // Objects/relationships now exist in the graph via the existing generic endpoints, and carry
    // the scp:managed-by/scp:stack labels.
    const svcAObj = await admin.object("service").get(`urn:scp:${stackName}:service:svc-a`);
    expect(svcAObj.properties).toEqual({ tier: "high" });
    expect(svcAObj.labels).toMatchObject({ "scp:managed-by": "iac", "scp:stack": stackName });

    const svcBObj = await admin.object("service").get(`urn:scp:${stackName}:service:svc-b`);
    const teamObj = await admin.object("team").get(`urn:scp:${stackName}:team:team`);
    expect(teamObj.labels).toMatchObject({ "scp:managed-by": "iac", "scp:stack": stackName });

    const ownsRel = await admin.relationships.list({
      fromId: teamObj.id,
      toId: svcAObj.id,
      typeId: "owns"
    });
    expect(ownsRel.items).toHaveLength(1);
    expect(ownsRel.items[0]?.labels).toMatchObject({
      "scp:managed-by": "iac",
      "scp:stack": stackName
    });

    const dependsOnRel = await admin.relationships.list({
      fromId: svcBObj.id,
      toId: svcAObj.id,
      typeId: "depends_on"
    });
    expect(dependsOnRel.items).toHaveLength(1);

    // Re-plan with the IDENTICAL manifest — DoD (b) core property: all noop, zero actions.
    const plan2 = await admin.plans.create(manifest);
    expect(plan2.diff.summary).toEqual({ creates: 0, updates: 0, deletes: 0, noops: 5 });
    expect(plan2.diff.objects.every((o) => o.action === "noop")).toBe(true);
    expect(plan2.diff.relationships.every((r) => r.action === "noop")).toBe(true);

    // Applying the all-noop plan is a legal, harmless no-op.
    const { summary: summary2 } = await admin.plans.apply(plan2.id);
    expect(summary2).toEqual({ creates: 0, updates: 0, deletes: 0, noops: 5 });
  });

  it("a property change between two plans produces exactly one update entry, the rest noop", async () => {
    const org = await createTestOrg(server, "plans-update");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const stackName = `stack-${randomUUID().slice(0, 8)}`;

    function build(tier: string) {
      const app = new App();
      const stack = new Stack(app, stackName);
      new Service(stack, "svc", { name: "Svc", properties: { tier } });
      return stack.synth();
    }

    const plan1 = await admin.plans.create(build("low"));
    await admin.plans.apply(plan1.id);

    const plan2 = await admin.plans.create(build("high"));
    expect(plan2.diff.summary).toEqual({ creates: 0, updates: 1, deletes: 0, noops: 0 });
    expect(plan2.diff.objects[0]).toMatchObject({ action: "update", reason: "properties changed" });

    await admin.plans.apply(plan2.id);
    const updated = await admin.object("service").get(`urn:scp:${stackName}:service:svc`);
    expect(updated.properties).toEqual({ tier: "high" });

    const plan3 = await admin.plans.create(build("high"));
    expect(plan3.diff.summary).toEqual({ creates: 0, updates: 0, deletes: 0, noops: 1 });
  });

  it("removing a service from the manifest prunes it scoped to this stack; an unrelated unmanaged object is untouched", async () => {
    const org = await createTestOrg(server, "plans-prune");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const stackName = `stack-${randomUUID().slice(0, 8)}`;

    // Same-ish URN/name pattern, but never managed by this stack's plans — proves prune scoping.
    const unrelated = await admin.object("service").create({
      name: "svc-b lookalike",
      urn: `urn:scp:${stackName}:service:svc-b`.replace("svc-b", "svc-b-lookalike")
    });

    function buildTwo() {
      const app = new App();
      const stack = new Stack(app, stackName);
      new Service(stack, "svc-a", { name: "Svc A" });
      new Service(stack, "svc-b", { name: "Svc B" });
      return stack.synth();
    }
    function buildOne() {
      const app = new App();
      const stack = new Stack(app, stackName);
      new Service(stack, "svc-a", { name: "Svc A" });
      return stack.synth();
    }

    const plan1 = await admin.plans.create(buildTwo());
    await admin.plans.apply(plan1.id);

    const plan2 = await admin.plans.create(buildOne());
    expect(plan2.diff.summary).toEqual({ creates: 0, updates: 0, deletes: 1, noops: 1 });
    const deleteEntry = plan2.diff.objects.find((o) => o.action === "delete");
    expect(deleteEntry?.urn).toBe(`urn:scp:${stackName}:service:svc-b`);

    await admin.plans.apply(plan2.id);

    await expect(
      admin.object("service").get(`urn:scp:${stackName}:service:svc-b`)
    ).rejects.toMatchObject({ status: 404 });

    // The unrelated, never-managed-by-this-stack object survives pruning untouched.
    const stillThere = await admin.object("service").get(unrelated.id);
    expect(stillThere.deletedAt).toBeNull();
  });

  it("apply requires object:write at EVERY affected object's scope — partial rights → 403, nothing applied", async () => {
    const org = await createTestOrg(server, "plans-authz");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const stackName = `stack-${randomUUID().slice(0, 8)}`;

    const domainA = await admin.domains.create({ name: `domain-a-${randomUUID().slice(0, 8)}` });
    const domainB = await admin.domains.create({ name: `domain-b-${randomUUID().slice(0, 8)}` });

    const app = new App();
    const stack = new Stack(app, stackName);
    new Service(stack, "svc-a", { name: "Svc A", domainId: domainA.id });
    new Service(stack, "svc-b", { name: "Svc B", domainId: domainB.id });
    const manifest = stack.synth();

    const plan = await admin.plans.create(manifest);
    expect(plan.diff.summary.creates).toBe(2);

    // Write rights at domainA only — the plan touches domainA AND domainB.
    const limited = await createTestUser(server, org, [{ role: "Operator", scope: domainA.id }]);
    const limitedClient = new ScpClient({ baseUrl: server.baseUrl, token: limited.token });

    await expect(limitedClient.plans.apply(plan.id)).rejects.toMatchObject({ status: 403 });

    // Nothing partially applied — re-fetching proves it, not just the 403 status code.
    await expect(
      admin.object("service").get(`urn:scp:${stackName}:service:svc-a`)
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      admin.object("service").get(`urn:scp:${stackName}:service:svc-b`)
    ).rejects.toMatchObject({ status: 404 });

    // The plan itself stays 'pending' — a failed apply didn't mark it applied.
    const refetched = await admin.plans.get(plan.id);
    expect(refetched.status).toBe("pending");

    // With rights at BOTH domains, the same plan applies cleanly.
    const privileged = await createTestUser(server, org, [
      { role: "Operator", scope: domainA.id },
      { role: "Operator", scope: domainB.id }
    ]);
    const privilegedClient = new ScpClient({ baseUrl: server.baseUrl, token: privileged.token });
    const { summary } = await privilegedClient.plans.apply(plan.id);
    expect(summary).toEqual({ creates: 2, updates: 0, deletes: 0, noops: 0 });
  });

  it("re-applying an already-applied plan is rejected with 409, not silently re-run", async () => {
    const org = await createTestOrg(server, "plans-reapply");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const stackName = `stack-${randomUUID().slice(0, 8)}`;

    const app = new App();
    const stack = new Stack(app, stackName);
    new Service(stack, "svc", { name: "Svc" });
    const plan = await admin.plans.create(stack.synth());

    await admin.plans.apply(plan.id);
    await expect(admin.plans.apply(plan.id)).rejects.toMatchObject({ status: 409 });
  });

  it("malformed manifests are rejected with 400 before touching the DB", async () => {
    const org = await createTestOrg(server, "plans-malformed");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });

    await expect(
      admin.plans.create({
        // Missing required fields / wrong shapes entirely.
        stackName: "",
        objects: "not-an-array",
        relationships: []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
    ).rejects.toMatchObject({ status: 400 });
  });

  it("strict create-in-service: a Component-with-service manifest plans, applies, and writes the contains edge (M12 P5a)", async () => {
    const org = await createTestOrg(server, "plans-strict-ok");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const stackName = `stack-${randomUUID().slice(0, 8)}`;

    const app = new App();
    const stack = new Stack(app, stackName);
    const checkout = new Service(stack, "checkout", { name: "Checkout" });
    new Component(stack, "api", { name: "checkout-api", service: checkout });
    const manifest = stack.synth();

    const plan = await admin.plans.create(manifest);
    // 1 service create + 1 component create + 1 contains create.
    expect(plan.diff.summary).toEqual({ creates: 3, updates: 0, deletes: 0, noops: 0 });

    const { plan: applied } = await admin.plans.apply(plan.id);
    expect(applied.status).toBe("applied");

    // The component exists AND is contained by its service — the invariant strictness protects.
    const comp = await admin.components.get(`urn:scp:${stackName}:component:api`);
    const svc = await admin.services.get(`urn:scp:${stackName}:service:checkout`);
    const edges = await admin.relationships.list({ typeId: "contains", toId: comp.id });
    expect(edges.items).toHaveLength(1);
    expect(edges.items[0]!.fromId).toBe(svc.id);
  });

  it("strict create-in-service: a raw manifest minting a component with NO owning service is rejected 400 at plan time", async () => {
    const org = await createTestOrg(server, "plans-strict-reject");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const stackName = `stack-${randomUUID().slice(0, 8)}`;

    // A HAND-AUTHORED manifest (bypassing the `Component` construct, which would emit the edge) —
    // the server is the real authority: no `contains` edge lands on the component, so the plan is
    // rejected before any row is written. No plan is stored to later apply.
    await expect(
      admin.plans.create({
        stackName,
        objects: [
          {
            urn: `urn:scp:${stackName}:component:orphan`,
            typeId: "component",
            name: "orphan",
            properties: {},
            labels: {}
          }
        ],
        relationships: []
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("declarative move: changing a component's service across two applies re-parents it in one apply (M12 P5b)", async () => {
    const org = await createTestOrg(server, "plans-declarative-move");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const stackName = `stack-${randomUUID().slice(0, 8)}`;

    // Both services in both manifests (so neither is pruned) — only the component's service changes.
    function manifest(componentService: "a" | "b") {
      const app = new App();
      const stack = new Stack(app, stackName);
      const svcA = new Service(stack, "svc-a", { name: "Service A" });
      const svcB = new Service(stack, "svc-b", { name: "Service B" });
      new Component(stack, "api", { name: "api", service: componentService === "a" ? svcA : svcB });
      return stack.synth();
    }

    const first = await admin.plans.create(manifest("a"));
    await admin.plans.apply(first.id);

    // Re-parent: svc-b now contains the component; svc-a's edge is pruned. The plan is a
    // contains CREATE (svc-b) + a contains DELETE (svc-a). Apply must NOT 409 on the 0022 index
    // (deletes-before-creates) and must converge to exactly one live edge, from svc-b.
    const move = await admin.plans.create(manifest("b"));
    expect(move.diff.summary).toMatchObject({ creates: 1, deletes: 1 });
    const { plan: applied } = await admin.plans.apply(move.id);
    expect(applied.status).toBe("applied");

    const comp = await admin.components.get(`urn:scp:${stackName}:component:api`);
    const svcB = await admin.services.get(`urn:scp:${stackName}:service:svc-b`);
    const edges = await admin.relationships.list({ typeId: "contains", toId: comp.id });
    expect(edges.items).toHaveLength(1);
    expect(edges.items[0]!.fromId).toBe(svcB.id);
  });

  it("apply on a nonexistent plan id is a 404", async () => {
    const org = await createTestOrg(server, "plans-404");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    await expect(
      admin.plans.apply("0198f2a0-0000-7000-8000-0000000000ff")
    ).rejects.toMatchObject({ status: 404 });
  });
});
