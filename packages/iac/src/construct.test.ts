import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DesiredStateManifestSchema } from "@scp/schemas";
import {
  App,
  Campaign,
  Component,
  DeploymentTarget,
  Initiative,
  Placement,
  ReleaseTopology,
  Service,
  Stack,
  Team,
  synthToFile
} from "./index.js";
import { canonicalJson } from "./canonical.js";

/**
 * Example-based synth test for a realistic small stack (goal statement): two services, a team
 * owning both, one `depends_on` the other. The fast-check property test
 * (`construct.determinism.test.ts`) covers the general determinism guarantee; this test pins down
 * the EXACT expected manifest shape for one concrete, readable case.
 */
describe("@scp/iac: example stack synth", () => {
  it("two services + a team owning both + one depends_on the other", () => {
    const app = new App();
    const stack = new Stack(app, "billing-platform");

    const billingApi = new Service(stack, "billing-api", {
      name: "Billing API",
      properties: { tier: "critical" }
    });
    const billingWorker = new Service(stack, "billing-worker", { name: "Billing Worker" });
    const team = new Team(stack, "billing-team", { name: "Billing Team" });

    team.owns(billingApi);
    team.owns(billingWorker);
    billingWorker.dependsOn(billingApi);

    const manifest = stack.synth();

    const billingApiUrn = "urn:scp:billing-platform:service:billing-api";
    const billingWorkerUrn = "urn:scp:billing-platform:service:billing-worker";
    const teamUrn = "urn:scp:billing-platform:team:billing-team";

    expect(manifest).toEqual({
      stackName: "billing-platform",
      objects: [
        {
          urn: billingApiUrn,
          typeId: "service",
          name: "Billing API",
          properties: { tier: "critical" },
          labels: {}
        },
        {
          urn: billingWorkerUrn,
          typeId: "service",
          name: "Billing Worker",
          properties: {},
          labels: {}
        },
        { urn: teamUrn, typeId: "team", name: "Billing Team", properties: {}, labels: {} }
      ],
      relationships: [
        { typeId: "depends_on", fromUrn: billingWorkerUrn, toUrn: billingApiUrn },
        { typeId: "owns", fromUrn: teamUrn, toUrn: billingApiUrn },
        { typeId: "owns", fromUrn: teamUrn, toUrn: billingWorkerUrn }
      ]
    });

    // The manifest is valid input for `POST /plans` — the interchange point with the server.
    expect(DesiredStateManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("an external URN string target (outside this stack) is a valid relationship endpoint", () => {
    const app = new App();
    const stack = new Stack(app, "consumer-stack");
    const service = new Service(stack, "checkout", { name: "Checkout" });
    service.consumes("urn:scp:other-stack:service:payments");

    const manifest = stack.synth();
    expect(manifest.relationships).toEqual([
      {
        typeId: "consumes",
        fromUrn: "urn:scp:consumer-stack:service:checkout",
        toUrn: "urn:scp:other-stack:service:payments"
      }
    ]);
  });

  it("a Component emits a `contains` edge from its service (strict create-in-service, M12 P5a)", () => {
    const app = new App();
    const stack = new Stack(app, "checkout-stack");
    const checkout = new Service(stack, "checkout", { name: "Checkout" });
    const api = new Component(stack, "api", { name: "checkout-api", service: checkout });

    const manifest = stack.synth();
    // The component object AND its containment edge both synth — so `POST /plans` sees an owning
    // service and the strict apply check (`uncontainedComponentCreates`) passes.
    expect(manifest.objects.map((o) => ({ typeId: o.typeId, urn: o.urn }))).toEqual([
      { typeId: "component", urn: api.urn },
      { typeId: "service", urn: checkout.urn }
    ]);
    expect(manifest.relationships).toEqual([
      { typeId: "contains", fromUrn: checkout.urn, toUrn: api.urn }
    ]);
    expect(DesiredStateManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("a Component may belong to an EXTERNAL service by URN string (not just a construct)", () => {
    const app = new App();
    const stack = new Stack(app, "worker-stack");
    const worker = new Component(stack, "worker", {
      name: "checkout-worker",
      service: "urn:scp:platform-stack:service:checkout"
    });

    // `from` is the external service URN verbatim — the component is attached to a service this
    // stack doesn't own (the server resolves + type/cardinality-checks the edge at apply).
    expect(stack.synth().relationships).toEqual([
      { typeId: "contains", fromUrn: "urn:scp:platform-stack:service:checkout", toUrn: worker.urn }
    ]);
  });

  it("an explicit urn prop overrides the derived one", () => {
    const app = new App();
    const stack = new Stack(app, "explicit-urn-stack");
    const svc = new Service(stack, "svc", { name: "Svc", urn: "urn:scp:custom:service:my-svc" });
    expect(svc.urn).toBe("urn:scp:custom:service:my-svc");
    expect(stack.synth().objects[0]?.urn).toBe("urn:scp:custom:service:my-svc");
  });

  it("re-synthesizing the same tree twice is byte-identical (pure synth)", () => {
    const app = new App();
    const stack = new Stack(app, "idempotent-stack");
    new Service(stack, "svc", { name: "Svc", properties: { tier: "high" } });

    expect(canonicalJson(stack.synth())).toBe(canonicalJson(stack.synth()));
  });

  it("App.synth() returns every stack's manifest, sorted by stack name", () => {
    const app = new App();
    const stackB = new Stack(app, "zzz-stack");
    new Service(stackB, "svc-b", { name: "Svc B" });
    const stackA = new Stack(app, "aaa-stack");
    new Service(stackA, "svc-a", { name: "Svc A" });

    const manifests = app.synth();
    expect(manifests.map((m) => m.stackName)).toEqual(["aaa-stack", "zzz-stack"]);
  });

  it("synthToFile writes canonical JSON that round-trips through DesiredStateManifestSchema", async () => {
    const app = new App();
    const stack = new Stack(app, "file-stack");
    new Service(stack, "svc", { name: "Svc", properties: { b: 2, a: 1 } });

    const dir = await mkdtemp(path.join(os.tmpdir(), "scp-iac-test-"));
    try {
      const filePath = path.join(dir, "nested", "manifest.json");
      await synthToFile(stack, filePath);
      const raw = await readFile(filePath, "utf8");
      const parsed = DesiredStateManifestSchema.parse(JSON.parse(raw));
      expect(parsed.stackName).toBe("file-stack");
      // Canonical (sorted-key) JSON — property keys come back alphabetically, regardless of the
      // insertion order the caller used when constructing `properties`.
      expect(raw.trimEnd()).toBe(
        '{"objects":[{"labels":{},"name":"Svc","properties":{"a":1,"b":2},"typeId":"service","urn":"urn:scp:file-stack:service:svc"}],"relationships":[],"stackName":"file-stack"}'
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("synthToFile rejects a multi-stack App (ambiguous which manifest to write)", async () => {
    const app = new App();
    const stackA = new Stack(app, "stack-a");
    new Service(stackA, "svc", { name: "Svc" });
    new Stack(app, "stack-b");

    const dir = await mkdtemp(path.join(os.tmpdir(), "scp-iac-test-"));
    try {
      await expect(synthToFile(app, path.join(dir, "manifest.json"))).rejects.toThrow(
        /exactly one stack/
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an empty stack name", () => {
    const app = new App();
    expect(() => new Stack(app, "")).toThrow();
    expect(() => new Stack(app, "   ")).toThrow();
  });
});

/**
 * M5 constructs (Campaign, Initiative, ReleaseTopology) — same example-based style as above: the
 * fast-check property test in `construct.determinism.test.ts` covers the general determinism
 * guarantee, this file pins down the exact expected manifest shape.
 */
describe("@scp/iac: campaign/initiative/release-topology synth", () => {
  it("a ReleaseTopology with a parallel wave and a sequential wave resolves construct-reference targets to URN strings", () => {
    const app = new App();
    const stack = new Stack(app, "release-platform");

    const api = new Service(stack, "api", { name: "API" });
    const worker = new Service(stack, "worker", { name: "Worker" });
    // A component always belongs to a service (M12 P5a) — it emits a `contains` edge, which this
    // test doesn't assert on (it checks only the topology's wave targets below).
    const cache = new Component(stack, "cache", { name: "Cache", service: api });

    const topology = new ReleaseTopology(stack, "rollout-topology", {
      name: "Rollout Topology",
      waves: [
        { mode: "parallel", targets: [api, worker], requiresFanIn: false },
        { name: "cache-flush", mode: "sequential", targets: [cache] }
      ]
    });

    const manifest = stack.synth();
    const topologyObject = manifest.objects.find((o) => o.urn === topology.urn);

    expect(topologyObject?.properties).toEqual({
      waves: [
        { mode: "parallel", targets: [api.urn, worker.urn], requiresFanIn: false },
        { name: "cache-flush", mode: "sequential", targets: [cache.urn] }
      ]
    });
  });

  it("a Campaign resolves construct-reference targets to URNs and carries description/topology", () => {
    const app = new App();
    const stack = new Stack(app, "release-platform-2");

    const api = new Service(stack, "api", { name: "API" });
    const worker = new Service(stack, "worker", { name: "Worker" });

    const campaign = new Campaign(stack, "q3-rollout", {
      name: "Q3 Rollout",
      targets: [api, worker],
      description: "Roll out the Q3 release",
      topology: "already-known-topology-object-id"
    });

    const manifest = stack.synth();
    const campaignObject = manifest.objects.find((o) => o.urn === campaign.urn);

    expect(campaignObject).toMatchObject({
      typeId: "campaign",
      name: "Q3 Rollout",
      properties: {
        targets: [api.urn, worker.urn],
        description: "Roll out the Q3 release",
        topologyObjectId: "already-known-topology-object-id"
      }
    });
  });

  it("a Campaign resolves a ReleaseTopology CONSTRUCT REFERENCE for `topology` to its URN, not just a raw string", () => {
    const app = new App();
    const stack = new Stack(app, "release-platform-3");

    const api = new Service(stack, "api", { name: "API" });
    const topology = new ReleaseTopology(stack, "canary-topology", {
      name: "Canary",
      waves: [{ mode: "parallel", targets: [api] }]
    });
    const campaign = new Campaign(stack, "q4-rollout", {
      name: "Q4 Rollout",
      targets: [api],
      topology
    });

    const manifest = stack.synth();
    const campaignObject = manifest.objects.find((o) => o.urn === campaign.urn);
    expect(campaignObject?.properties).toMatchObject({ topologyObjectId: topology.urn });
  });

  it("a Campaign with no description/topology synthesizes only targets", () => {
    const app = new App();
    const stack = new Stack(app, "release-platform-3");
    const api = new Service(stack, "api", { name: "API" });

    const campaign = new Campaign(stack, "bare-campaign", {
      name: "Bare Campaign",
      targets: [api]
    });

    const manifest = stack.synth();
    expect(manifest.objects.find((o) => o.urn === campaign.urn)?.properties).toEqual({
      targets: [api.urn]
    });
  });

  it("an Initiative construct exposes NO membership-edge method — `coordinates` is system-managed (M5 CRITICAL)", () => {
    const app = new App();
    const stack = new Stack(app, "modernization-platform");

    const svcA = new Service(stack, "svc-a", { name: "Svc A" });
    const campaignA = new Campaign(stack, "campaign-a", { name: "Campaign A", targets: [svcA] });
    const initiative = new Initiative(stack, "modernization", {
      name: "Cloud Modernization",
      description: "Multi-year modernization effort"
    });

    // `coordinates` is a system-managed relationship the server refuses on the IaC apply path
    // (apps/server/src/graph/system-managed-relationships.ts) — so there is deliberately no
    // `.coordinates()` synth method to declare initiative membership in IaC (it would only ever
    // produce a manifest that 403s at apply). Initiative membership is added via the
    // authority-checked `POST /initiatives/{id}/campaigns` API instead.
    expect((initiative as unknown as { coordinates?: unknown }).coordinates).toBeUndefined();

    const manifest = stack.synth();
    // No `coordinates` edge is synthesizable — the manifest carries only the objects and any
    // NON-system-managed edges (none here).
    expect(manifest.relationships.filter((r) => r.typeId === "coordinates")).toEqual([]);
    const initiativeObject = manifest.objects.find((o) => o.urn === initiative.urn);
    expect(initiativeObject?.properties).toEqual({
      description: "Multi-year modernization effort"
    });
    expect(campaignA.urn).toBeTruthy(); // campaign is still a valid standalone construct
    expect(DesiredStateManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("an Initiative with no description synthesizes empty properties", () => {
    const app = new App();
    const stack = new Stack(app, "modernization-platform-2");
    new Initiative(stack, "bare-initiative", { name: "Bare Initiative" });
    expect(stack.synth().objects[0]?.properties).toEqual({});
  });
});

/**
 * C1 (docs/proposals/post-import-configuration.md §8) — `source_mappings` and `executor_bindings`
 * are the two configurations that had no manifest representation, breaking principle 3's
 * API → SDK → CLI → IaC → UI parity for exactly what an operator must reproduce offline.
 */
describe("@scp/iac constructs: executor bindings on a placement", () => {
  /** Local to this block: the placements suite below defines its own, and reaching across describe
   *  scopes for a helper is how a shared fixture quietly acquires a second set of requirements. */
  function fixture(stackName: string) {
    const app = new App();
    const stack = new Stack(app, stackName);
    const service = new Service(stack, "billing", { name: "Billing" });
    const component = new Component(stack, "api", { name: "API", service });
    const gamma = new DeploymentTarget(stack, "gamma", { name: "gamma" });
    const prod = new DeploymentTarget(stack, "prod", { name: "prod" });
    return { stack, component, gamma, prod };
  }

  it("addresses the placement as its component NARROWED by the deployment-target", () => {
    const { stack, component, prod } = fixture("pl-bind");
    component.placeAt(prod).bindsExecutor({ pluginModule: "argocd", pluginInstanceId: "a1" });
    const manifest = stack.synth();

    expect(manifest.placements).toHaveLength(1);
    expect(manifest.executorBindings?.[0]).toEqual({
      targetUrn: component.urn,
      deploymentTargetUrn: prod.urn,
      pluginModule: "argocd",
      pluginInstanceId: "a1"
    });
  });

  it("synthesizes identically through the sugar and the stack-level door", () => {
    const a = fixture("pl-bind-sugar");
    a.component.placeAt(a.prod).bindsExecutor({ pluginModule: "argocd", pluginInstanceId: "a1" });
    const b = fixture("pl-bind-sugar");
    b.stack.addPlacement(b.component, b.prod);
    b.stack.addPlacementExecutorBinding(b.component, b.prod, {
      pluginModule: "argocd",
      pluginInstanceId: "a1"
    });
    expect(JSON.stringify(a.stack.synth())).toBe(JSON.stringify(b.stack.synth()));
  });

  it("binds the same component at two targets as two distinct rows", () => {
    const { stack, component, prod, gamma } = fixture("pl-bind-two");
    component.placeAt(prod).bindsExecutor({ pluginModule: "argocd", pluginInstanceId: "p" });
    component.placeAt(gamma).bindsExecutor({ pluginModule: "argocd", pluginInstanceId: "g" });
    const manifest = stack.synth();
    expect(manifest.executorBindings).toHaveLength(2);
    expect(manifest.executorBindings?.map((b) => b.deploymentTargetUrn).sort()).toEqual(
      [gamma.urn, prod.urn].sort()
    );
  });
});

describe("@scp/iac constructs: sourceMappings / executorBindings (C1)", () => {
  function stackWithComponent(name: string) {
    const app = new App();
    const stack = new Stack(app, name);
    const service = new Service(stack, "billing", { name: "Billing" });
    const component = new Component(stack, "api", { name: "API", service });
    return { stack, service, component };
  }

  it("a stack declaring neither collection synthesizes the pre-C1 manifest byte-for-byte", () => {
    // The interchange format must stay stable for every program written before C1 — an absent key
    // already means "declares none" server-side, so emitting `[]` would churn every manifest on
    // disk for no gain.
    const { stack } = stackWithComponent("no-projections");
    const manifest = stack.synth();
    expect(manifest.sourceMappings).toBeUndefined();
    expect(manifest.executorBindings).toBeUndefined();
    expect(manifest.placements).toBeUndefined();
    expect(Object.keys(manifest).sort()).toEqual(["objects", "relationships", "stackName"]);
  });

  it("component.mapsSource + target.bindsExecutor land in the manifest and survive schema validation", () => {
    const { stack, component } = stackWithComponent("billing-platform-c1");
    component.mapsSource({ sourceKind: "github", repoPattern: "acme/billing-api", type: "image" });
    component.bindsExecutor({
      pluginModule: "argocd",
      pluginInstanceId: "argocd-prod",
      config: { serverUrl: "https://argocd.internal" },
      secretRefs: { token: "argocd-token" },
      externalRef: "billing-api"
    });

    const manifest = stack.synth();
    expect(DesiredStateManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.sourceMappings).toEqual([
      {
        componentUrn: component.urn,
        sourceKind: "github",
        repoPattern: "acme/billing-api",
        type: "image"
      }
    ]);
    expect(manifest.executorBindings).toEqual([
      {
        targetUrn: component.urn,
        pluginModule: "argocd",
        pluginInstanceId: "argocd-prod",
        config: { serverUrl: "https://argocd.internal" },
        secretRefs: { token: "argocd-token" },
        externalRef: "billing-api"
      }
    ]);
  });

  it("an execution-system-backed binding carries only the system reference (Mode A)", () => {
    const { stack, component } = stackWithComponent("mode-a");
    component.bindsExecutor({
      executionSystem: "urn:scp:mode-a:execution-system:homelab-argocd",
      externalRef: "billing-api"
    });
    const manifest = stack.synth();
    expect(DesiredStateManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.executorBindings?.[0]).toEqual({
      targetUrn: component.urn,
      executionSystemId: "urn:scp:mode-a:execution-system:homelab-argocd",
      externalRef: "billing-api"
    });
  });

  it("REJECTS a system-backed binding that also declares config the server would silently ignore", () => {
    const { stack, component } = stackWithComponent("mode-a-conflict");
    component.bindsExecutor({
      executionSystem: "urn:scp:x:execution-system:argocd",
      config: { serverUrl: "https://attacker.example" }
    });
    // Caught at synth (the schema parse inside `Stack.synth()`), not silently dropped — a declared
    // value the server ignores is the "silently-preferred key" failure mode proposal §11 names.
    expect(() => stack.synth()).toThrow();
  });

  it("REJECTS a binding that is neither inline nor system-backed", () => {
    const { stack, component } = stackWithComponent("neither");
    component.bindsExecutor({ externalRef: "orphan" });
    expect(() => stack.synth()).toThrow();
  });

  it("declaration ORDER never changes the synthesized manifest — only content does", () => {
    function build(order: "forward" | "reverse") {
      const { stack, component } = stackWithComponent("determinism-c1");
      const decls: Array<() => void> = [
        () => component.mapsSource({ sourceKind: "github", repoPattern: "acme/z", type: "image" }),
        () => component.mapsSource({ sourceKind: "github", repoPattern: "acme/a" }),
        () =>
          component.bindsExecutor({
            type: "image",
            pluginModule: "github",
            pluginInstanceId: "gh-1"
          }),
        () => component.bindsExecutor({ pluginModule: "argocd", pluginInstanceId: "argocd-1" })
      ];
      for (const declare of order === "forward" ? decls : [...decls].reverse()) declare();
      return canonicalJson(stack.synth());
    }
    expect(build("forward")).toBe(build("reverse"));
  });

  it("stack.addSourceMapping / addExecutorBinding accept a bare URN for a component outside this program", () => {
    const app = new App();
    const stack = new Stack(app, "external-refs");
    const external = "urn:scp:other-program:component:legacy";
    stack.addSourceMapping(external, { sourceKind: "gitea", repoPattern: "ops/legacy" });
    stack.addExecutorBinding(external, { pluginModule: "terraform", pluginInstanceId: "tf-1" });
    const manifest = stack.synth();
    expect(manifest.sourceMappings?.[0]?.componentUrn).toBe(external);
    expect(manifest.executorBindings?.[0]?.targetUrn).toBe(external);
  });
});

describe("@scp/iac constructs: placements (C1, ADR-0026)", () => {
  /**
   * A placement is one component at one deployment-target. It is NOT emitted into `objects` — a
   * pair-bound type cannot be created through a door taking free-form properties (PR #207), so it
   * rides its own collection like a source mapping does.
   *
   * | Mutation | Result |
   * |---|---|
   * | emit `placements: []` instead of omitting it when empty | the pre-C1 shape test FAILS |
   * | sort placements by declaration order instead of the pair | the determinism test FAILS |
   * | have `placeAt` push a decl directly instead of constructing `Placement` | no test fails — the two forms are required to converge, so this is asserted by BOTH producing the identical manifest |
   */
  function fixture(stackName: string) {
    const app = new App();
    const stack = new Stack(app, stackName);
    const service = new Service(stack, "billing", { name: "Billing" });
    const component = new Component(stack, "api", { name: "API", service });
    const gamma = new DeploymentTarget(stack, "gamma", { name: "gamma" });
    const prod = new DeploymentTarget(stack, "prod", { name: "prod" });
    return { stack, component, gamma, prod };
  }

  it("declares a placement from the component sugar", () => {
    const { stack, component, prod } = fixture("sugar");
    component.placeAt(prod);
    expect(stack.synth().placements).toEqual([
      { componentUrn: component.urn, deploymentTargetUrn: prod.urn }
    ]);
  });

  it("the sugar and the standalone construct produce the IDENTICAL manifest", () => {
    // Decision Q1 shipped BOTH forms, on the condition that the sugar CONSTRUCTS the standalone one
    // rather than duplicating logic. This is the assertion that holds that condition — if `placeAt`
    // ever grows its own behaviour, these two diverge.
    const a = fixture("via-sugar");
    a.component.placeAt(a.prod);
    const b = fixture("via-sugar"); // same stack name, so the URNs match
    new Placement(b.stack, b.component, b.prod);
    expect(a.stack.synth()).toEqual(b.stack.synth());
  });

  it("accepts a component referenced by URN, for one outside this program", () => {
    const { stack, prod } = fixture("external");
    const external = "urn:scp:other-stack:component:legacy";
    stack.addPlacement(external, prod);
    expect(stack.synth().placements?.[0]?.componentUrn).toBe(external);
  });

  it("sorts on the PAIR, so declaration order never changes the bytes", () => {
    const one = fixture("order");
    one.component.placeAt(one.prod);
    one.component.placeAt(one.gamma);
    const two = fixture("order");
    two.component.placeAt(two.gamma);
    two.component.placeAt(two.prod);
    expect(
      JSON.stringify(one.stack.synth()),
      "two synths of the same content must be identical"
    ).toBe(JSON.stringify(two.stack.synth()));
  });

  it("keeps a placement OUT of `objects` — it is a side-table declaration, not a graph object", () => {
    const { stack, component, prod } = fixture("not-an-object");
    component.placeAt(prod);
    const manifest = stack.synth();
    expect(
      manifest.objects.some((o) => o.typeId === "placement"),
      "declaring it as an object would hit the pair-bound refusal (#207) and write no derived edges"
    ).toBe(false);
  });
});
