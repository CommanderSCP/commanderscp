import { describe, expect, it } from "vitest";
import { Component, DeploymentTarget, Service, Stack } from "./construct.js";
import { Cluster, Database, InstanceGroup } from "./infra.js";
import {
  ConfigurationPipeline,
  ImagePipeline,
  InfrastructurePipeline,
  NpmPipeline,
  RpmPipeline
} from "./pipeline.js";

/**
 * D24's COMPILE rung, proved the way this repo already proves compile-time guards (per this
 * increment's build instructions): `// @ts-expect-error` lines that fail the BUILD — `tsc --noEmit`,
 * the package's `typecheck` script, `tsconfig.json`'s `include: ["src"]` sweeps this file in — the
 * moment the error they name stops occurring. A RUNTIME-ONLY test proves nothing about a compile-
 * time guard; the proof here is the presence of this file passing `pnpm --filter @scp/iac
 * typecheck`, not the `it()` block below (which exists only so this is also a normal, green vitest
 * module and so the "legal pairings" section has a runtime assertion of its own).
 *
 * MUTATION-PROVED (restored before commit): commenting out any ONE `@ts-expect-error` line below and
 * running `pnpm --filter @scp/iac typecheck` makes tsc report "Unused '@ts-expect-error' directive"
 * — RED — for every line whose error stopped firing; re-adding it goes back GREEN. That is what
 * confirms each directive is load-bearing rather than decorative.
 */
describe("@scp/iac: placeAt is kind-checked at compile time (D24)", () => {
  it("legal pairings type-check and return `this` for chaining", () => {
    const stack = new Stack("placeat-typecheck");
    const svc = new Service(stack, "svc", { name: "svc" });
    const api = new Component(stack, "api", { name: "api", service: svc });
    const infra = new InfrastructurePipeline(api, { repo: "x/y", waves: [] });
    const withinTarget = new DeploymentTarget(stack, "target", { name: "target" });
    const cluster = new Cluster(infra, "a-cluster", { name: "a-cluster", within: withinTarget });
    const instanceGroup = new InstanceGroup(infra, "an-ig", {
      name: "an-ig",
      within: withinTarget
    });

    const image = new ImagePipeline(api, { repo: "x/y", waves: [] });
    const rpm = new RpmPipeline(api, "rpm-pipeline", { repo: "x/y", waves: [] });
    const config = new ConfigurationPipeline(api, { repo: "x/y", waves: [] });

    expect(image.placeAt(cluster)).toBe(image);
    expect(rpm.placeAt(instanceGroup)).toBe(rpm);
    expect(config.placeAt(cluster)).toBe(config);
    expect(config.placeAt(instanceGroup)).toBe(config);
  });
});

// -- illegal pairings — each MUST fail to type-check, or `pnpm --filter @scp/iac typecheck` fails --
const stack2 = new Stack("placeat-typecheck-illegal");
const svc2 = new Service(stack2, "svc", { name: "svc" });
const api2 = new Component(stack2, "api", { name: "api", service: svc2 });
const infra2 = new InfrastructurePipeline(api2, { repo: "x/y", waves: [] });
const withinTarget2 = new DeploymentTarget(stack2, "target", { name: "target" });
const cluster2 = new Cluster(infra2, "a-cluster", { name: "a-cluster", within: withinTarget2 });
const instanceGroup2 = new InstanceGroup(infra2, "an-ig", { name: "an-ig", within: withinTarget2 });
const database2 = new Database(infra2, "a-db", { name: "a-db", within: withinTarget2 });

const image2 = new ImagePipeline(api2, "image2", { repo: "x/y", waves: [] });
const rpm2 = new RpmPipeline(api2, "rpm2", { repo: "x/y", waves: [] });
const npm2 = new NpmPipeline(api2, "npm2", { repo: "x/y", waves: [] });

// @ts-expect-error — an RPM cannot be placed on a cluster: RpmPipeline.placeAt takes IInstanceGroup only (D24)
rpm2.placeAt(cluster2);
// @ts-expect-error — an image cannot be placed on an instance group: ImagePipeline.placeAt takes ICluster only (D24)
image2.placeAt(instanceGroup2);
// @ts-expect-error — a Database is never a deploy target for any artifact (D24)
image2.placeAt(database2);
// @ts-expect-error — npm publishes and is never placed: PlaceableTarget<"npm"> is `never` (D24)
npm2.placeAt(cluster2);
// @ts-expect-error — an InfrastructurePipeline produces infra products, it is never itself placed (D24)
infra2.placeAt(cluster2);
