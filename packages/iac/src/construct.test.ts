import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DesiredStateManifestSchema } from "@scp/schemas";
import { App, Campaign, Component, Initiative, ReleaseTopology, Service, Stack, Team, synthToFile } from "./index.js";
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
      expect(raw.trimEnd()).toBe('{"objects":[{"labels":{},"name":"Svc","properties":{"a":1,"b":2},"typeId":"service","urn":"urn:scp:file-stack:service:svc"}],"relationships":[],"stackName":"file-stack"}');
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

    const campaign = new Campaign(stack, "bare-campaign", { name: "Bare Campaign", targets: [api] });

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
    expect(
      (initiative as unknown as { coordinates?: unknown }).coordinates
    ).toBeUndefined();

    const manifest = stack.synth();
    // No `coordinates` edge is synthesizable — the manifest carries only the objects and any
    // NON-system-managed edges (none here).
    expect(manifest.relationships.filter((r) => r.typeId === "coordinates")).toEqual([]);
    const initiativeObject = manifest.objects.find((o) => o.urn === initiative.urn);
    expect(initiativeObject?.properties).toEqual({ description: "Multi-year modernization effort" });
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
