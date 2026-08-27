import { describe, expect, it } from "vitest";
import { DesiredStateManifestSchema, type DesiredStateManifest } from "@scp/schemas";
import { Component, DeploymentTarget, Service, Stack } from "./index.js";
import {
  ChartPipeline,
  ConfigurationPipeline,
  ExecutionSystem,
  GoPipeline,
  ImagePipeline,
  InfrastructurePipeline,
  NpmPipeline,
  PIPELINE_KINDS,
  repos
} from "./pipeline.js";

describe("@scp/iac: pipeline-kind classes (D17) — closed-vocabulary exhaustiveness", () => {
  it("PIPELINE_KINDS is exactly ExecutorTypeSchema's 11 members", () => {
    expect(PIPELINE_KINDS.slice().sort()).toEqual(
      [
        "image",
        "rpm",
        "deb",
        "npm",
        "maven",
        "python",
        "go",
        "chart",
        "vm-image",
        "infrastructure",
        "configuration"
      ].sort()
    );
  });

  it("every generated class carries its own kind on `.kind`", () => {
    const stack = new Stack("kind-check");
    const svc = new Service(stack, "svc", { name: "svc" });
    const image = new ImagePipeline("api-repo-image", { service: svc, repo: "x/y", waves: [] });
    const chart = new ChartPipeline(image.stack.stackName + "-chart", {
      service: svc,
      repo: "x/z",
      waves: []
    });
    const npm = new NpmPipeline("npm-pkg", { service: svc, repo: "x/w", waves: [] });
    const go = new GoPipeline("go-mod", { service: svc, repo: "x/v", waves: [] });
    const infra = new InfrastructurePipeline("infra-only", {
      service: svc,
      repo: "x/u",
      waves: []
    });
    const config = new ConfigurationPipeline("config-only", {
      service: svc,
      repo: "x/t",
      waves: []
    });
    expect([image.kind, chart.kind, npm.kind, go.kind, infra.kind, config.kind]).toEqual([
      "image",
      "chart",
      "npm",
      "go",
      "infrastructure",
      "configuration"
    ]);
  });
});

describe("@scp/iac: repos() (D18)", () => {
  it("keeps a repo string to exactly what it was given — the org-relative part", () => {
    expect(repos("payments/payments-api")).toBe("payments/payments-api");
  });
});

describe("@scp/iac: Component root form (D15a/D17 — 'a multi-pipeline repo roots at Component')", () => {
  it("`new Component(name, props)` auto-creates its own Stack, same as the 3-arg form would", () => {
    const svc = { urn: "urn:scp:named-ref:service:payments", typeId: "service" as const };
    const api = new Component("payments-api", { name: "payments-api", service: svc });
    expect(api.urn).toBe("urn:scp:payments-api:component:payments-api");
    expect(api.service).toEqual(svc);
    const manifest = api.stack.synth();
    expect(manifest.stackName).toBe("payments-api");
    expect(manifest.objects).toEqual([
      { urn: api.urn, typeId: "component", name: "payments-api", properties: {}, labels: {} }
    ]);
    expect(manifest.relationships).toEqual([
      { typeId: "contains", fromUrn: svc.urn, toUrn: api.urn }
    ]);
  });
});

describe("@scp/iac: root-form pipeline (single-pipeline repo, D15a/D17)", () => {
  it("synthesizes component + release-topology + releases_via + sourceMapping + inferred placements + publishes_to (default registry)", () => {
    const svc = Service.fromName("payments");
    const stage = DeploymentTarget.fromName("commercial-amer-staging");

    const image = new ImagePipeline("payments-api", {
      service: svc,
      repo: "payments/payments-api",
      branch: "main",
      waves: [{ name: "staging", targets: [stage] }]
    });

    const manifest = image.stack.synth();

    const componentUrn = "urn:scp:payments-api:component:payments-api";
    const topologyUrn = "urn:scp:payments-api:release-topology:image-topology";
    const registryUrn = "urn:scp:named-ref:execution-system:org-registry";

    expect(manifest.objects).toEqual([
      { urn: componentUrn, typeId: "component", name: "payments-api", properties: {}, labels: {} },
      {
        urn: topologyUrn,
        typeId: "release-topology",
        name: "payments-api-image-pipeline",
        properties: {
          waves: [{ name: "staging", mode: "parallel", targets: [stage.urn] }]
        },
        labels: {}
      }
    ]);

    expect(manifest.relationships).toEqual(
      expect.arrayContaining([
        { typeId: "contains", fromUrn: svc.urn, toUrn: componentUrn },
        {
          typeId: "releases_via",
          fromUrn: componentUrn,
          toUrn: topologyUrn,
          properties: { type: "image" }
        },
        {
          typeId: "publishes_to",
          fromUrn: componentUrn,
          toUrn: registryUrn,
          properties: { repository: "payments/payments-api" }
        }
      ])
    );

    expect(manifest.sourceMappings).toEqual([
      {
        componentUrn,
        sourceKind: "gitea",
        repoPattern: "payments/payments-api",
        refPattern: "refs/heads/main",
        type: "image"
      }
    ]);

    expect(manifest.placements).toEqual([{ componentUrn, deploymentTargetUrn: stage.urn }]);

    expect(DesiredStateManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("`publishesTo`/`repository` override the D18 defaults", () => {
    const svc = Service.fromName("payments");
    const registry = ExecutionSystem.fromName("field-registry");
    const image = new ImagePipeline("payments-worker", {
      service: svc,
      repo: "payments/payments-worker",
      waves: [],
      publishesTo: registry,
      repository: "custom/path"
    });
    const manifest = image.stack.synth();
    expect(manifest.relationships).toEqual(
      expect.arrayContaining([
        {
          typeId: "publishes_to",
          fromUrn: "urn:scp:payments-worker:component:payments-worker",
          toUrn: registry.urn,
          properties: { repository: "custom/path" }
        }
      ])
    );
  });

  it("a publish-only kind (npm) still gets a publishes_to edge — 'publish and never placed' is about placeAt, not publishing", () => {
    const svc = Service.fromName("payments");
    const pkg = new NpmPipeline("payments-sdk", {
      service: svc,
      repo: "payments/payments-sdk",
      waves: []
    });
    const manifest = pkg.stack.synth();
    expect(manifest.relationships.some((r) => r.typeId === "publishes_to")).toBe(true);
  });

  it("Infrastructure/Configuration pipelines never emit a publishes_to edge", () => {
    const svc = Service.fromName("payments");
    const infra = new InfrastructurePipeline("payments-infra", {
      service: svc,
      repo: "payments/payments-infra",
      waves: []
    });
    const manifest = infra.stack.synth();
    expect(manifest.relationships.some((r) => r.typeId === "publishes_to")).toBe(false);
  });
});

describe("@scp/iac: repo is required (D18) — mutation-proved guard", () => {
  it("refuses a root-form pipeline with an empty repo", () => {
    const svc = Service.fromName("payments");
    expect(
      () =>
        new ImagePipeline("bad-repo", {
          service: svc,
          repo: "",
          waves: []
        })
    ).toThrow(/repo/i);
  });

  it("refuses a nested-form pipeline with an empty repo", () => {
    const stack = new Stack("nested-bad-repo");
    const svc = new Service(stack, "svc", { name: "svc" });
    const api = new Component(stack, "api", { name: "api", service: svc });
    expect(() => new ImagePipeline(api, { repo: "   ", waves: [] })).toThrow(/repo/i);
  });

  // MUTATION-PROVED (restored before commit): temporarily removing the `if (!resolved.props.repo...)`
  // guard in `pipeline.ts`'s `PipelineBase` constructor makes both cases above pass silently (no
  // throw) instead of failing this test — confirming the guard, and this test, are both live.
});

describe("@scp/iac: nested pipelines under a Component (multi-pipeline repo, D17)", () => {
  it("two pipeline kinds on one component get distinct default ids and distinct topologies", () => {
    const stack = new Stack("payments-api");
    const svc = new Service(stack, "payments", { name: "Payments" });
    const api = new Component(stack, "payments-api", { name: "payments-api", service: svc });

    const image = new ImagePipeline(api, { repo: "payments/payments-api", waves: [] });
    const infra = new InfrastructurePipeline(api, {
      repo: "payments/payments-api",
      path: "infra/**",
      waves: []
    });

    expect(image.id).toBe("image");
    expect(infra.id).toBe("infrastructure");

    const manifest = stack.synth();
    const topologies = manifest.objects.filter((o) => o.typeId === "release-topology");
    expect(topologies.map((t) => t.urn).sort()).toEqual(
      [
        "urn:scp:payments-api:release-topology:image-topology",
        "urn:scp:payments-api:release-topology:infrastructure-topology"
      ].sort()
    );

    const releasesVia = manifest.relationships.filter((r) => r.typeId === "releases_via");
    expect(releasesVia).toHaveLength(2);
    expect(releasesVia.map((r) => (r.properties as { type: string }).type).sort()).toEqual(
      ["image", "infrastructure"].sort()
    );

    const sourceMappings = manifest.sourceMappings ?? [];
    expect(sourceMappings).toHaveLength(2);
    expect(sourceMappings.find((m) => m.type === "infrastructure")?.pathPattern).toBe("infra/**");
  });

  it("two same-kind pipelines on one component require an explicit id", () => {
    const stack = new Stack("multi-image");
    const svc = new Service(stack, "payments", { name: "Payments" });
    const api = new Component(stack, "payments-api", { name: "payments-api", service: svc });
    const a = new ImagePipeline(api, "image-a", { repo: "payments/a", waves: [] });
    const b = new ImagePipeline(api, "image-b", { repo: "payments/b", waves: [] });
    expect(a.id).toBe("image-a");
    expect(b.id).toBe("image-b");
    const manifest = stack.synth();
    expect(manifest.objects.filter((o) => o.typeId === "release-topology")).toHaveLength(2);
  });
});

describe("@scp/iac: shared-rung pipeline (D8's deliberate exception — scoped to a Service)", () => {
  it("attaches releases_via from the SERVICE, and emits no sourceMapping/placements (no component to name)", () => {
    const stack = new Stack("payments-team");
    const svc = new Service(stack, "payments", { name: "Payments" });
    const stage = DeploymentTarget.fromName("commercial-amer-staging");

    const shared = new ImagePipeline(svc, "payments-release", {
      repo: "payments/payments-api",
      waves: [[stage]]
    });

    expect(shared.attachedTo).toBe(svc);

    const manifest = stack.synth();
    const releasesVia = manifest.relationships.filter((r) => r.typeId === "releases_via");
    expect(releasesVia).toEqual([
      {
        typeId: "releases_via",
        fromUrn: svc.urn,
        toUrn: "urn:scp:payments-team:release-topology:payments-release-topology",
        properties: { type: "image" }
      }
    ]);
    expect(manifest.sourceMappings ?? []).toEqual([]);
    expect(manifest.placements ?? []).toEqual([]);
    expect(DesiredStateManifestSchema.safeParse(manifest).success).toBe(true);
  });
});

describe("@scp/iac: placement inference from waves (D8)", () => {
  it("infers one placement per unique stage a pipeline's waves name", () => {
    const stack = new Stack("infer-placements");
    const svc = new Service(stack, "payments", { name: "Payments" });
    const api = new Component(stack, "api", { name: "api", service: svc });
    const staging = DeploymentTarget.fromName("commercial-amer-staging");
    const prod = DeploymentTarget.fromName("commercial-amer-production");

    new ImagePipeline(api, {
      repo: "payments/api",
      waves: [{ name: "staging", targets: [staging] }, [prod]]
    });

    const manifest = stack.synth();
    expect((manifest.placements ?? []).map((p) => p.deploymentTargetUrn).sort()).toEqual(
      [staging.urn, prod.urn].sort()
    );
  });

  it("an explicit placement declared before the pipeline is NOT duplicated by wave inference (D8 override)", () => {
    const stack = new Stack("explicit-wins");
    const svc = new Service(stack, "payments", { name: "Payments" });
    const api = new Component(stack, "api", { name: "api", service: svc });
    const staging = DeploymentTarget.fromName("commercial-amer-staging");

    api.placeAt(staging); // explicit, BEFORE the pipeline that also names this stage in its waves
    new ImagePipeline(api, { repo: "payments/api", waves: [[staging]] });

    const manifest = stack.synth();
    expect(manifest.placements).toEqual([
      { componentUrn: api.urn, deploymentTargetUrn: staging.urn }
    ]);
  });

  it("removing a stage from the waves removes it from the synthesized placements (visible prune, D8/§12)", () => {
    const buildManifest = (targets: string[]): DesiredStateManifest => {
      const stack = new Stack("prune-check");
      const svc = new Service(stack, "payments", { name: "Payments" });
      const api = new Component(stack, "api", { name: "api", service: svc });
      new ImagePipeline(api, {
        repo: "payments/api",
        waves: [targets.map((t) => DeploymentTarget.fromName(t))]
      });
      return stack.synth();
    };
    const before = buildManifest(["commercial-amer-staging", "commercial-amer-production"]);
    const after = buildManifest(["commercial-amer-staging"]);
    expect(before.placements).toHaveLength(2);
    expect(after.placements).toHaveLength(1);
  });
});

describe("@scp/iac: placeAt (D19/D20/D24) — 'deploys_to', never a placements entry", () => {
  it("records a deploys_to relationship from the component to the infra product", () => {
    const stack = new Stack("place-at");
    const svc = new Service(stack, "payments", { name: "Payments" });
    const api = new Component(stack, "api", { name: "api", service: svc });
    const image = new ImagePipeline(api, { repo: "payments/api", waves: [] });

    const payBlue = { urn: "urn:scp:payments-infra:cluster:pay-blue", typeId: "cluster" as const };
    image.placeAt(payBlue);

    const manifest = stack.synth();
    expect(manifest.relationships).toEqual(
      expect.arrayContaining([{ typeId: "deploys_to", fromUrn: api.urn, toUrn: payBlue.urn }])
    );
    // Never written into `placements` — see `PipelineBase.placeAt`'s doc for why.
    expect((manifest.placements ?? []).some((p) => p.deploymentTargetUrn === payBlue.urn)).toBe(
      false
    );
  });
});

describe("@scp/iac: dependsOn sugar on a pipeline", () => {
  it("declares a depends_on edge from the pipeline's component", () => {
    const stack = new Stack("depends-on");
    const svc = new Service(stack, "payments", { name: "Payments" });
    const api = new Component(stack, "api", { name: "api", service: svc });
    const image = new ImagePipeline(api, { repo: "payments/api", waves: [] });
    image.dependsOn("urn:scp:other-stack:component:ledger-core");

    const manifest = stack.synth();
    expect(manifest.relationships).toEqual(
      expect.arrayContaining([
        {
          typeId: "depends_on",
          fromUrn: api.urn,
          toUrn: "urn:scp:other-stack:component:ledger-core"
        }
      ])
    );
  });
});
