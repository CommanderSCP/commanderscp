import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { Component, Service, Stack, Team } from "@scp/iac";
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
      const stack = new Stack(stackName);
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
      const stack = new Stack(stackName);
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
      const stack = new Stack(stackName);
      new Service(stack, "svc-a", { name: "Svc A" });
      new Service(stack, "svc-b", { name: "Svc B" });
      return stack.synth();
    }
    function buildOne() {
      const stack = new Stack(stackName);
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

    const stack = new Stack(stackName);
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

    const stack = new Stack(stackName);
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

    const stack = new Stack(stackName);
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
      const stack = new Stack(stackName);
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
    await expect(admin.plans.apply("0198f2a0-0000-7000-8000-0000000000ff")).rejects.toMatchObject({
      status: 404
    });
  });

  // -----------------------------------------------------------------------------------------
  // C1 — sourceMappings / executorBindings (docs/proposals/post-import-configuration.md §8).
  // These two are PROJECTION TABLES, not graph objects, so nothing here can be inferred from the
  // object/relationship tests above: their ownership, their prune scope and their write path are
  // all separate code.
  // -----------------------------------------------------------------------------------------

  it("C1 round trip: a stack declares a mapping + a binding, they land, and a re-plan is all-noop", async () => {
    const org = await createTestOrg(server, "plans-c1-roundtrip");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const stackName = `stack-${randomUUID().slice(0, 8)}`;

    function build() {
      const stack = new Stack(stackName);
      const service = new Service(stack, "billing", { name: "Billing" });
      const component = new Component(stack, "api", { name: "api", service });
      component.mapsSource({ sourceKind: "github", repoPattern: `acme/${stackName}` });
      component.bindsExecutor({
        pluginModule: "argocd",
        pluginInstanceId: `argocd-${stackName}`,
        config: { serverUrl: "https://argocd.internal" },
        externalRef: "billing-api"
      });
      return stack.synth();
    }

    const plan = await admin.plans.create(build());
    // 2 objects + 1 contains edge + 1 mapping + 1 binding.
    expect(plan.diff.summary).toEqual({ creates: 5, updates: 0, deletes: 0, noops: 0 });
    await admin.plans.apply(plan.id);

    // The rows are real, readable through the SAME public API that writes them by hand — the
    // parity claim, checked rather than asserted.
    const componentUrn = `urn:scp:${stackName}:component:api`;
    const component = await admin.components.get(componentUrn);
    const bindings = await admin.executors.listBindings(componentUrn);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      targetObjectId: component.id,
      type: "configuration",
      pluginModule: "argocd",
      externalRef: "billing-api"
    });

    const mappings = await admin.changeSources.listMappings("github");
    expect(
      mappings.items.filter((m) => m.componentObjectId === component.id).map((m) => m.repoPattern)
    ).toEqual([`acme/${stackName}`]);

    const replan = await admin.plans.create(build());
    expect(replan.diff.summary).toEqual({ creates: 0, updates: 0, deletes: 0, noops: 5 });
  });

  it("C1 drift: a changed binding config is an UPDATE in place; a changed mapping glob is delete+create", async () => {
    const org = await createTestOrg(server, "plans-c1-drift");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const stackName = `stack-${randomUUID().slice(0, 8)}`;

    function build(serverUrl: string, repo: string) {
      const stack = new Stack(stackName);
      const service = new Service(stack, "billing", { name: "Billing" });
      const component = new Component(stack, "api", { name: "api", service });
      component.mapsSource({ sourceKind: "github", repoPattern: repo });
      component.bindsExecutor({
        pluginModule: "argocd",
        pluginInstanceId: `argocd-${stackName}`,
        config: { serverUrl }
      });
      return stack.synth();
    }

    const first = await admin.plans.create(build("https://a.internal", `acme/${stackName}`));
    await admin.plans.apply(first.id);

    const second = await admin.plans.create(build("https://b.internal", `acme/${stackName}-new`));
    expect(second.diff.executorBindings?.map((b) => b.action)).toEqual(["update"]);
    expect(second.diff.sourceMappings?.map((m) => m.action).sort()).toEqual(["create", "delete"]);
    await admin.plans.apply(second.id);

    const componentUrn = `urn:scp:${stackName}:component:api`;
    const component = await admin.components.get(componentUrn);

    // ONE binding still — updated in place, not duplicated.
    const bindings = await admin.executors.listBindings(componentUrn);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.config).toEqual({ serverUrl: "https://b.internal" });

    // Exactly one mapping, carrying the NEW glob: the old one was really removed, not left behind.
    const mappings = await admin.changeSources.listMappings("github");
    expect(
      mappings.items.filter((m) => m.componentObjectId === component.id).map((m) => m.repoPattern)
    ).toEqual([`acme/${stackName}-new`]);

    const third = await admin.plans.create(build("https://b.internal", `acme/${stackName}-new`));
    expect(
      third.diff.summary.creates + third.diff.summary.updates + third.diff.summary.deletes
    ).toBe(0);
  });

  it("§10.6 scope: a create carries it, a changed declaration is an UPDATE in place (every duplicate row converged), an omitted one is left alone, an explicit null clears it", async () => {
    const org = await createTestOrg(server, "plans-c1-scope");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const stackName = `stack-${randomUUID().slice(0, 8)}`;
    const repo = `acme/${stackName}`;

    function build(scope: "global" | "domain" | null | undefined) {
      const stack = new Stack(stackName);
      const service = new Service(stack, "billing", { name: "Billing" });
      const component = new Component(stack, "api", { name: "api", service });
      component.mapsSource({
        sourceKind: "github",
        repoPattern: repo,
        ...(scope !== undefined ? { scope } : {})
      });
      return stack.synth();
    }
    const componentUrn = `urn:scp:${stackName}:component:api`;
    const liveScopes = async () => {
      const component = await admin.components.get(componentUrn);
      return (await admin.changeSources.listMappings("github")).items
        .filter((m) => m.componentObjectId === component.id)
        .map((m) => m.scope);
    };

    // 1. Create carries the declared scope, and the plan entry shows it before apply.
    const first = await admin.plans.create(build("global"));
    expect(first.diff.sourceMappings).toEqual([
      expect.objectContaining({ action: "create", scope: "global" })
    ]);
    await admin.plans.apply(first.id);
    expect(await liveScopes()).toEqual(["global"]);

    // A byte-identical sibling created BY HAND (the table has no unique constraint) — the update
    // below must converge it too, or the next plan proposes the same update forever.
    const component = await admin.components.get(componentUrn);
    await admin.changeSources.createMapping("github", {
      component: component.id,
      repoPattern: repo
    });
    expect((await liveScopes()).sort()).toEqual(["global", null].sort());

    // 2. A differing declaration is an UPDATE — no delete, no create, the route never re-created.
    const second = await admin.plans.create(build("domain"));
    expect(second.diff.sourceMappings).toEqual([
      expect.objectContaining({
        action: "update",
        scope: "domain",
        reason: expect.stringContaining("scope differs")
      })
    ]);
    expect(second.diff.summary).toMatchObject({ updates: 1, deletes: 0 });
    await admin.plans.apply(second.id);
    // BOTH rows converged; the plan settles.
    expect(await liveScopes()).toEqual(["domain", "domain"]);
    const settled = await admin.plans.create(build("domain"));
    expect(settled.diff.sourceMappings?.map((m) => m.action)).toEqual(["noop"]);

    // 3. A manifest that OMITS scope manages nothing: noop, and the live value is reported.
    const omitted = await admin.plans.create(build(undefined));
    expect(omitted.diff.sourceMappings).toEqual([
      expect.objectContaining({ action: "noop", scope: "domain" })
    ]);
    await admin.plans.apply(omitted.id);
    expect(await liveScopes()).toEqual(["domain", "domain"]);

    // 4. An explicit null CLEARS it — an update to "not declared".
    const cleared = await admin.plans.create(build(null));
    expect(cleared.diff.sourceMappings).toEqual([
      expect.objectContaining({ action: "update", scope: null })
    ]);
    await admin.plans.apply(cleared.id);
    expect(await liveScopes()).toEqual([null, null]);
  });

  it("C1 prune is stack-scoped: removing the declarations prunes ONLY this stack's rows", async () => {
    const org = await createTestOrg(server, "plans-c1-prune-scope");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const stackName = `stack-${randomUUID().slice(0, 8)}`;
    const otherStackName = `stack-${randomUUID().slice(0, 8)}`;

    // A SECOND stack with its own component, mapping and binding — never mentioned by the first
    // stack's manifests. Its rows must survive the first stack's prune untouched. This is the
    // property the whole ownership-scoping decision exists for.
    function otherStack() {
      const stack = new Stack(otherStackName);
      const service = new Service(stack, "other", { name: "Other" });
      const component = new Component(stack, "api", { name: "api", service });
      component.mapsSource({ sourceKind: "github", repoPattern: `acme/${otherStackName}` });
      component.bindsExecutor({
        pluginModule: "argocd",
        pluginInstanceId: `argocd-${otherStackName}`,
        config: { serverUrl: "https://argocd.internal" }
      });
      return stack.synth();
    }
    const otherPlan = await admin.plans.create(otherStack());
    await admin.plans.apply(otherPlan.id);

    function build(withProjections: boolean) {
      const stack = new Stack(stackName);
      const service = new Service(stack, "billing", { name: "Billing" });
      const component = new Component(stack, "api", { name: "api", service });
      if (withProjections) {
        component.mapsSource({ sourceKind: "github", repoPattern: `acme/${stackName}` });
        component.bindsExecutor({
          pluginModule: "argocd",
          pluginInstanceId: `argocd-${stackName}`,
          config: { serverUrl: "https://argocd.internal" }
        });
      }
      return stack.synth();
    }

    const first = await admin.plans.create(build(true));
    await admin.plans.apply(first.id);

    const prune = await admin.plans.create(build(false));
    expect(prune.diff.summary.deletes).toBe(2);
    await admin.plans.apply(prune.id);

    // This stack's rows are gone...
    const componentUrn = `urn:scp:${stackName}:component:api`;
    const component = await admin.components.get(componentUrn);
    expect(await admin.executors.listBindings(componentUrn)).toEqual([]);
    const mappings = await admin.changeSources.listMappings("github");
    expect(mappings.items.filter((m) => m.componentObjectId === component.id)).toEqual([]);

    // ...and the OTHER stack's are untouched.
    const otherUrn = `urn:scp:${otherStackName}:component:api`;
    const otherComponent = await admin.components.get(otherUrn);
    expect(await admin.executors.listBindings(otherUrn)).toHaveLength(1);
    expect(mappings.items.filter((m) => m.componentObjectId === otherComponent.id)).toHaveLength(1);

    // And the other stack re-plans as an all-noop: its state was never disturbed.
    const otherReplan = await admin.plans.create(otherStack());
    expect(otherReplan.diff.summary).toMatchObject({ creates: 0, updates: 0, deletes: 0 });
  });

  it("C1 prune ignores a merely-REFERENCED object of another stack — referencing is not owning", async () => {
    const org = await createTestOrg(server, "plans-c1-crossref");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const ownerStack = `stack-${randomUUID().slice(0, 8)}`;
    const consumerStack = `stack-${randomUUID().slice(0, 8)}`;

    // The owner stack's component carries a mapping and a binding.
    const owner = new Stack(ownerStack);
    const ownerService = new Service(owner, "owner", { name: "Owner" });
    const ownerComponent = new Component(owner, "api", { name: "api", service: ownerService });
    ownerComponent.mapsSource({ sourceKind: "github", repoPattern: `acme/${ownerStack}` });
    ownerComponent.bindsExecutor({
      pluginModule: "argocd",
      pluginInstanceId: `argocd-${ownerStack}`,
      config: { serverUrl: "https://argocd.internal" }
    });
    await admin.plans.apply((await admin.plans.create(owner.synth())).id);

    const ownerUrn = `urn:scp:${ownerStack}:component:api`;
    const ownerObject = await admin.components.get(ownerUrn);

    // The consumer stack REFERENCES that component as a dependency — a perfectly ordinary edge, and
    // the realistic way one stack's plan ever sees another stack's object at all. Referencing must
    // not confer ownership: the consumer declares no mappings/bindings, so if the reference pulled
    // the owner's rows into its pool they would be pruned as "not in the desired manifest".
    function consumer() {
      const stack = new Stack(consumerStack);
      const service = new Service(stack, "consumer", { name: "Consumer" });
      const component = new Component(stack, "web", { name: "web", service });
      component.dependsOn(ownerUrn);
      return stack.synth();
    }

    const plan = await admin.plans.create(consumer());
    expect(plan.diff.sourceMappings).toEqual([]);
    expect(plan.diff.executorBindings).toEqual([]);
    await admin.plans.apply(plan.id);

    // The owner's rows are untouched, and its own stack still re-plans as an all-noop.
    expect(await admin.executors.listBindings(ownerUrn)).toHaveLength(1);
    const mappings = await admin.changeSources.listMappings("github");
    expect(mappings.items.filter((m) => m.componentObjectId === ownerObject.id)).toHaveLength(1);
  });

  it("C1 apply order: deleting the OBJECT in the same plan still removes its rows, not orphans them", async () => {
    const org = await createTestOrg(server, "plans-c1-order");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const stackName = `stack-${randomUUID().slice(0, 8)}`;

    // `deleteObject` is a SOFT delete and neither projection table has a `deleted_at`. If the
    // object were deleted first, its mapping/binding rows would survive, be invisible to every list
    // query (they filter on a live target) and outside every future plan's ownership pool (built
    // from LIVE labelled objects) — permanently unreachable garbage nothing could ever remove.
    function build(withComponent: boolean) {
      const stack = new Stack(stackName);
      const service = new Service(stack, "billing", { name: "Billing" });
      if (withComponent) {
        const component = new Component(stack, "api", { name: "api", service });
        component.mapsSource({ sourceKind: "github", repoPattern: `acme/${stackName}` });
        component.bindsExecutor({
          pluginModule: "argocd",
          pluginInstanceId: `argocd-${stackName}`,
          config: { serverUrl: "https://argocd.internal" }
        });
      }
      return stack.synth();
    }

    const first = await admin.plans.create(build(true));
    await admin.plans.apply(first.id);
    const component = await admin.components.get(`urn:scp:${stackName}:component:api`);

    // Dropping the component drops its object, its contains edge, its mapping and its binding.
    const drop = await admin.plans.create(build(false));
    expect(drop.diff.summary.deletes).toBe(4);
    await admin.plans.apply(drop.id);

    // Probing by the component's REAL id, so a live binding row would be found even though the
    // object is gone: the rows are actually gone, not merely hidden behind the soft delete.
    const mappings = await admin.changeSources.listMappings("github");
    expect(mappings.items.filter((m) => m.componentObjectId === component.id)).toEqual([]);

    // Re-declaring the component from scratch reveals any survivor: a leftover binding row would
    // make this a noop instead of a create.
    const recreate = await admin.plans.create(build(true));
    expect(recreate.diff.executorBindings?.map((b) => b.action)).toEqual(["create"]);
    expect(recreate.diff.sourceMappings?.map((m) => m.action)).toEqual(["create"]);
  });

  it("C1 prune removes EVERY duplicate row — source_mappings has no unique constraint", async () => {
    const org = await createTestOrg(server, "plans-c1-dupes");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const stackName = `stack-${randomUUID().slice(0, 8)}`;

    function build(withMapping: boolean) {
      const stack = new Stack(stackName);
      const service = new Service(stack, "billing", { name: "Billing" });
      const component = new Component(stack, "api", { name: "api", service });
      if (withMapping) {
        component.mapsSource({ sourceKind: "github", repoPattern: `acme/${stackName}` });
      }
      return stack.synth();
    }

    await admin.plans.apply((await admin.plans.create(build(false))).id);
    const component = await admin.components.get(`urn:scp:${stackName}:component:api`);

    // Two byte-identical rows, created the way `POST /discovery/accept` creates them (it inserts
    // unconditionally, so a re-run of an import genuinely produces these).
    for (let i = 0; i < 2; i++) {
      await admin.changeSources.createMapping("github", {
        repoPattern: `acme/${stackName}`,
        component: component.id
      });
    }
    const before = await admin.changeSources.listMappings("github");
    expect(before.items.filter((m) => m.componentObjectId === component.id)).toHaveLength(2);

    // The stack owns the component, so it owns both rows: the diff shows ONE delete (identity is
    // the tuple), and applying it must remove BOTH — otherwise the survivor reappears as a prune
    // candidate on every future plan and the manifest never converges.
    const prune = await admin.plans.create(build(false));
    expect(prune.diff.sourceMappings?.map((m) => m.action)).toEqual(["delete"]);
    await admin.plans.apply(prune.id);

    const after = await admin.changeSources.listMappings("github");
    expect(after.items.filter((m) => m.componentObjectId === component.id)).toEqual([]);

    const settled = await admin.plans.create(build(false));
    expect(settled.diff.sourceMappings).toEqual([]);
  });

  it("C1 ownership guard: declaring a binding on another stack's object is rejected 400", async () => {
    const org = await createTestOrg(server, "plans-c1-unowned");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const victimStack = `stack-${randomUUID().slice(0, 8)}`;
    const attackerStack = `stack-${randomUUID().slice(0, 8)}`;

    function victim() {
      const stack = new Stack(victimStack);
      const service = new Service(stack, "victim", { name: "Victim" });
      new Component(stack, "api", { name: "api", service });
      return stack.synth();
    }
    await admin.plans.apply((await admin.plans.create(victim())).id);

    const victimUrn = `urn:scp:${victimStack}:component:api`;

    // The attacker's stack declares NO object of its own for that URN — it just points a binding
    // and a mapping at the victim's component. Without the ownership guard this would write rows
    // the attacker's stack could never see again and the victim's next apply would prune.
    const stack = new Stack(attackerStack);
    const service = new Service(stack, "attacker", { name: "Attacker" });
    new Component(stack, "own", { name: "own", service });
    stack.addExecutorBinding(victimUrn, {
      pluginModule: "argocd",
      pluginInstanceId: `argocd-${attackerStack}`,
      config: { serverUrl: "https://argocd.internal" }
    });
    stack.addSourceMapping(victimUrn, { sourceKind: "github", repoPattern: "acme/victim" });

    await expect(admin.plans.create(stack.synth())).rejects.toMatchObject({ status: 400 });

    // Nothing was written, and the victim's component still has no binding.
    expect(await admin.executors.listBindings(victimUrn)).toEqual([]);
  });

  it("C1: an unknown plugin module is rejected at plan-compute, exactly as the typed binding route rejects it", async () => {
    const org = await createTestOrg(server, "plans-c1-module");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const stackName = `stack-${randomUUID().slice(0, 8)}`;

    const stack = new Stack(stackName);
    const service = new Service(stack, "billing", { name: "Billing" });
    const component = new Component(stack, "api", { name: "api", service });
    component.bindsExecutor({ pluginModule: "webhook-control", pluginInstanceId: "nope" });

    await expect(admin.plans.create(stack.synth())).rejects.toMatchObject({ status: 400 });
  });

  it("C1: a binding config the plugin's own schema forbids is rejected — the managed-iac server-governed fields", async () => {
    const org = await createTestOrg(server, "plans-c1-config");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const stackName = `stack-${randomUUID().slice(0, 8)}`;

    const stack = new Stack(stackName);
    const service = new Service(stack, "billing", { name: "Billing" });
    const component = new Component(stack, "api", { name: "api", service });
    // managed-iac's configSchema is additionalProperties:false with no runnerImage — this is the
    // adversarial-review CRITICAL #1 vector, and IaC apply must be no softer a door than PUT.
    component.bindsExecutor({
      type: "infrastructure",
      pluginModule: "managed-iac",
      pluginInstanceId: `iac-${stackName}`,
      config: { runnerImage: "attacker/evil:latest" }
    });

    await expect(admin.plans.create(stack.synth())).rejects.toMatchObject({ status: 400 });
  });

  it("C1 authz: apply needs object:write at the binding's target, not merely somewhere in the org", async () => {
    const org = await createTestOrg(server, "plans-c1-authz");
    const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    const stackName = `stack-${randomUUID().slice(0, 8)}`;

    const domainA = await admin.domains.create({ name: `domain-a-${randomUUID().slice(0, 8)}` });
    const domainB = await admin.domains.create({ name: `domain-b-${randomUUID().slice(0, 8)}` });

    const stack = new Stack(stackName);
    const service = new Service(stack, "billing", { name: "Billing", domainId: domainB.id });
    const component = new Component(stack, "api", {
      name: "api",
      service,
      domainId: domainB.id
    });
    component.bindsExecutor({
      pluginModule: "argocd",
      pluginInstanceId: `argocd-${stackName}`,
      config: { serverUrl: "https://argocd.internal" }
    });
    const plan = await admin.plans.create(stack.synth());

    const limited = await createTestUser(server, org, [{ role: "Operator", scope: domainA.id }]);
    const limitedClient = new ScpClient({ baseUrl: server.baseUrl, token: limited.token });
    await expect(limitedClient.plans.apply(plan.id)).rejects.toMatchObject({ status: 403 });

    // Nothing partially applied: the binding's target object was never created either.
    await expect(admin.components.get(`urn:scp:${stackName}:component:api`)).rejects.toMatchObject({
      status: 404
    });
  });
});
