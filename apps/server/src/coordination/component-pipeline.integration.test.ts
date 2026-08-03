import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * A COMPONENT'S PIPELINE IS CONTINUOUS — it exists whether or not anything is releasing.
 *
 * ============================================================================================
 * THE PROPERTY, AND THE BUG IT REPLACES
 * ============================================================================================
 * The pipeline surface was keyed on a CHANGE (`/changes/{id}/pipeline`). The service board's link
 * renders only when a row has a `latestChangeId`, so a component with nothing in flight had NO
 * pipeline to open — a run view wearing a pipeline's name. Owner-reported, 2026-08-03.
 *
 * The model never had that problem: `release-topology`/`releases_via` are durable, and after
 * ADR-0026 a component's STAGES are its placements. So the fix is a view keyed on the component.
 *
 * THE FIRST TEST IS THE WHOLE POINT: a component that has never released still has stages. Every
 * other assertion here could pass on the old change-anchored surface; that one could not.
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | derive stages from wave targets instead of placements | the never-released test FAILS with 0 stages — exactly the old bug |
 * | drop `"version"` from a stage's `unknownFields` | the honesty test FAILS — a null version would read as an observation |
 * | ignore the topology's wave order when sorting | the ordering test FAILS — but ONLY after it was fixed: its first version used targets named "gamma"/"prod", which sort into release order anyway, so the name fallback satisfied it and the mutation left it GREEN. It now uses names that sort the other way round |
 * | resolve the stage name from the LOCAL federation name rather than the target's `origin_domain_id` | the stage-name test still passes here (single domain) — noted, NOT relied on; ADR-0026 D1's cross-domain case needs a federation fixture |
 */
describe("a component's pipeline is continuous", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let gamma: GraphObject;
  let prod: GraphObject;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "component-pipeline");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    gamma = await admin.deploymentTargets.create({
      name: "gamma",
      properties: { environment: "gamma" }
    });
    prod = await admin.deploymentTargets.create({
      name: "prod",
      properties: { environment: "prod", region: "nyc3" }
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function pipelineOf(componentId: string) {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/components/${componentId}/pipeline`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode, "the pipeline route must answer").toBe(200);
    return res.json() as {
      stages: {
        deploymentTarget: { name: string };
        stageName: string | null;
        binding: { externalRef: string | null } | null;
        current: { changeId: string } | null;
        version: string | null;
        unknownFields: string[];
      }[];
      pipeline: { rung: string; attachedToName: string | null } | null;
    };
  }

  it("has stages for a component that has NEVER released — the whole point", async () => {
    const component = await createOrphanComponent(admin, `never-released-${uuidv7()}`);
    await admin.placements.create({ component: component.id, deploymentTarget: gamma.id });
    await admin.placements.create({ component: component.id, deploymentTarget: prod.id });

    const p = await pipelineOf(component.id);

    expect(
      p.stages,
      "the change-anchored surface this replaces could not represent this component at all"
    ).toHaveLength(2);
    expect(
      p.stages.every((s) => s.current === null),
      "nothing has released here yet"
    ).toBe(true);
  });

  it("names each stage from the target's environment, and leaves it null when there is none", async () => {
    const component = await createOrphanComponent(admin, `stage-names-${uuidv7()}`);
    const plain = await admin.deploymentTargets.create({ name: `plain-${uuidv7().slice(0, 8)}` });
    await admin.placements.create({ component: component.id, deploymentTarget: prod.id });
    await admin.placements.create({ component: component.id, deploymentTarget: plain.id });

    const p = await pipelineOf(component.id);
    const prodStage = p.stages.find((s) => s.deploymentTarget.name === "prod");
    const plainStage = p.stages.find((s) => s.deploymentTarget.name === plain.name);

    // `<domain>-[<region>-]<environment>` — region is the optional middle segment (ADR-0026 D1).
    expect(prodStage?.stageName?.endsWith("-nyc3-prod")).toBe(true);
    expect(
      plainStage?.stageName,
      "not every deployment-target is a stage — inventing a name would be a lie (D1)"
    ).toBeNull();
  });

  it("reports the per-stage version as UNKNOWN, never as a confident blank", async () => {
    const component = await createOrphanComponent(admin, `version-honesty-${uuidv7()}`);
    await admin.placements.create({ component: component.id, deploymentTarget: gamma.id });

    const p = await pipelineOf(component.id);

    expect(p.stages[0]!.version, "Phase 4a observe-enrichment is unbuilt").toBeNull();
    expect(
      p.stages[0]!.unknownFields,
      "a null that is NOT listed as unknown reads as an observation — the service board's rule"
    ).toContain("version");
  });

  it("shows what executes at a stage, and says so plainly when nothing does", async () => {
    const component = await createOrphanComponent(admin, `binding-${uuidv7()}`);
    const bound = await admin.placements.create({
      component: component.id,
      deploymentTarget: gamma.id
    });
    await admin.placements.create({ component: component.id, deploymentTarget: prod.id });
    await admin.executors.putBinding(bound.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${uuidv7().slice(0, 8)}`,
      externalRef: "my-argo-app"
    });

    const p = await pipelineOf(component.id);
    const withBinding = p.stages.find((s) => s.binding !== null);
    const without = p.stages.find((s) => s.binding === null);

    expect(withBinding?.binding?.externalRef).toBe("my-argo-app");
    expect(
      without,
      "an UNBOUND placement must be visible — it fake-succeeds under stage-shaped compilation (ADR-0006 case (a))"
    ).toBeDefined();
  });

  it("orders stages by the topology's wave order, and reports which rung supplied it", async () => {
    // The two targets are named so ALPHABETICAL order is the OPPOSITE of release order. Without
    // that, the name fallback happens to produce the right answer and the test proves nothing —
    // which is exactly what the first version of it did ("gamma" sorts before "prod"), and a
    // mutation ignoring the wave order left it green.
    const first = await admin.deploymentTargets.create({
      name: `zz-early-${uuidv7().slice(0, 8)}`,
      properties: { environment: "gamma" }
    });
    const second = await admin.deploymentTargets.create({
      name: `aa-late-${uuidv7().slice(0, 8)}`,
      properties: { environment: "prod" }
    });
    const component = await createOrphanComponent(admin, `ordering-${uuidv7()}`);
    await admin.placements.create({ component: component.id, deploymentTarget: second.id });
    await admin.placements.create({ component: component.id, deploymentTarget: first.id });

    const topo = await admin.object("release-topology").create({
      name: `early-then-late-${uuidv7().slice(0, 8)}`,
      properties: {
        waves: [
          { name: "early", mode: "parallel", targets: [first.id] },
          { name: "late", mode: "parallel", targets: [second.id] }
        ]
      }
    });
    await admin.relationships.create({
      typeId: "releases_via",
      fromId: component.id,
      toId: topo.id
    });

    const p = await pipelineOf(component.id);

    expect(
      p.stages.map((s) => s.deploymentTarget.name),
      "stages must read in RELEASE order — alphabetically these sort the other way round"
    ).toEqual([first.name, second.name]);
    expect(p.pipeline?.rung, "and the view answers 'why this pipeline' (principle 6)").toBe(
      "component"
    );
  });
});
