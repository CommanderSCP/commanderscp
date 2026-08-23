import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
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
 * A COMPONENT'S PIPELINE IS CONTINUOUS — it exists whether or not anything is releasing — AND IT IS
 * THE WHOLE JOURNEY, including the stages this component never reaches.
 *
 * ============================================================================================
 * THE TWO PROPERTIES, AND THE TWO BUGS THEY REPLACE
 * ============================================================================================
 * BUG 1 (2026-08-03). The pipeline surface was keyed on a CHANGE (`/changes/{id}/pipeline`). The
 * service board's link renders only when a row has a `latestChangeId`, so a component with nothing
 * in flight had NO pipeline to open — a run view wearing a pipeline's name.
 *
 * BUG 2 (owner-reported the same day, against the fix for bug 1). The replacement derived its stages
 * from the component's PLACEMENTS, so a stage the component is NOT placed at did not exist in the
 * view. Measured on the live estate: topology `commercial-gamma-then-prod` declares gamma then prod,
 * `agentkit-bootstrap` holds ONE placement (gamma), and prod rendered NOWHERE. A pipeline's job is
 * the JOURNEY — where a release goes next and where it stops — and placements can only ever show
 * where the component already IS, so the most operationally important fact about the component
 * ("it never reaches prod") was the one fact the view structurally could not state.
 *
 * TWO TESTS ARE THE WHOLE POINT, one per bug: "has stages for a component that has NEVER released"
 * (no other assertion here could fail on the old change-anchored surface) and "shows a declared stage
 * the component is NOT placed at" (none could fail on the placement-derived one).
 *
 * ============================================================================================
 * MUTATION LOG (each applied ALONE against a passing suite, then reverted)
 * ============================================================================================
 * | Mutation | Result |
 * |---|---|
 * | seed stages from placements only (drop the wave seeds) | the unplaced-stage AND interleaving tests FAIL — `unplacedStages` empty; this is bug 2 exactly |
 * | drop the off-topology placements from the seed list | 6 tests FAIL, the off-topology one by name — the mirror-image bug, real state hidden by a document's omission |
 * | `stageSource: "topology"` whenever a topology resolved (ignoring the shape check) | the legacy-shape test FAILS — a client would read an empty `unplacedStages` as "reaches every stage" when it means "unknowable" |
 * | assign `order` per-array (`unplacedStages.length`) instead of across the union | the interleaving test FAILS — but ONLY after it was strengthened. Its first version had ONE placed and ONE unplaced stage, where per-array numbering coincidentally equals the union index, and the mutation left it GREEN. It now uses three waves with only the first placed, so the two disagree (0,0,1 vs 0,1,2) |
 * | `bindings[0]` instead of every binding at a stage | the every-pipeline test FAILS — a stage's build/infra/config pipelines collapse to one, which is how the owner experienced "missing the infra pipeline" |
 * | `DISTINCT ON (placement)` instead of `(placement, type)` for `currents` | the per-pipeline-release test FAILS — but ONLY after that test was WRITTEN; the mutation survived the first run of this suite entirely, because nothing covered per-pipeline history at all |
 * | resolve the gate to `{policies: []}` without calling the policy resolver | the gate test FAILS — the prod approval, and the 282 pending requests behind it, render as nothing |
 * | report `not_started` for a check whether or not a release is at the gate | the check-status test FAILS — "nothing to run against" and "here and unanswered" collapse into one grey state |
 * | derive stages from wave targets instead of placements | the never-released test FAILS with 0 stages — exactly bug 1 |
 * | drop `"version"` from a stage's `unknownFields` | the honesty test FAILS — a null version would read as an observation |
 * | ignore the topology's wave order when sorting | the ordering test FAILS — but ONLY after it was fixed: its first version used targets named "gamma"/"prod", which sort into release order anyway, so the name fallback satisfied it and the mutation left it GREEN. It now uses names that sort the other way round |
 * | make `maintainerOf` return `isSelf: true` for every domain | NOT CAUGHT HERE, and recorded as a gap rather than hidden: this org is single-domain with 0 federation peers, so the peer and unknown-domain branches are exercised only by the CLIENT test ("shows an UNRECOGNISED domain as unknown"). The server-side branches need a two-domain federation fixture — the same caveat as the stage-name row below |
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
        placement: { id: string };
        maintainedBy: {
          domainId: string | null;
          name: string | null;
          isSelf: boolean;
          role: string | null;
        };
        order: number;
        wave: { index: number; name: string | null } | null;
        deploymentTarget: { name: string };
        stageName: string | null;
        binding: { externalRef: string | null; type: string } | null;
        bindings: { externalRef: string | null; type: string; category: string }[];
        current: { changeId: string } | null;
        currents: { changeId: string; type: string; category: string }[];
        gate: {
          checks: {
            controlId: string;
            name: string | null;
            status: string;
            changeId: string | null;
          }[];
          policies: {
            name: string;
            enforcement: string;
            requireControls: string[];
            requireApprovals: { count: number; fromRole: string; scope: string }[];
          }[];
        };
        version: string | null;
        unknownFields: string[];
      }[];
      unplacedStages: {
        order: number;
        wave: { index: number; name: string | null };
        deploymentTarget: { name: string };
        stageName: string | null;
      }[];
      stageSource: string;
      sources: {
        sourceKind: string;
        repoPattern: string | null;
        pathPattern: string | null;
        type: string;
        category: string;
      }[];
      pipeline: { rung: string; attachedToName: string | null } | null;
    };
  }

  /** A topology whose waves name `targets` in order, attached to `componentId`'s own rung. */
  async function attachTopology(componentId: string, waves: { name: string; target: string }[]) {
    const topo = await admin.object("release-topology").create({
      // FULL uuid, not `.slice(0, 8)` — those first 8 hex chars are the top 32 bits of uuidv7's
      // millisecond timestamp, so they only change every ~65s and every topology in one run collides.
      name: `topo-${uuidv7()}`,
      properties: {
        waves: waves.map((w) => ({ name: w.name, mode: "parallel", targets: [w.target] }))
      }
    });
    await admin.relationships.create({
      typeId: "releases_via",
      fromId: componentId,
      toId: topo.id
    });
    return topo;
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

  it("shows a declared stage the component is NOT placed at — the second whole point", async () => {
    // The live shape that reported this: a two-wave topology, ONE placement. Before the fix the
    // response held a single stage and the prod wave appeared nowhere at all.
    const component = await createOrphanComponent(admin, `unplaced-${uuidv7()}`);
    await admin.placements.create({ component: component.id, deploymentTarget: gamma.id });
    await attachTopology(component.id, [
      { name: "gamma", target: gamma.id },
      { name: "prod", target: prod.id }
    ]);

    const p = await pipelineOf(component.id);

    expect(p.stageSource, "the journey came from the topology, so its gaps are meaningful").toBe(
      "topology"
    );
    expect(p.stages.map((s) => s.deploymentTarget.name)).toEqual(["gamma"]);
    expect(
      p.unplacedStages.map((s) => s.deploymentTarget.name),
      "'this component never reaches prod' is the fact the placement-derived view could not state"
    ).toEqual(["prod"]);
    expect(p.unplacedStages[0]!.wave.name, "and it says WHICH declared wave it misses").toBe(
      "prod"
    );
    // The name is a property of the PLACE, so an unplaced stage is named exactly like a placed one —
    // a client renders "not placed" against a real stage name, not against an id.
    expect(p.unplacedStages[0]!.stageName?.endsWith("-nyc3-prod")).toBe(true);
  });

  it("interleaves placed and unplaced stages into ONE contiguous journey order", async () => {
    // THREE waves, only the FIRST placed. Two placed/unplaced stages is not enough to catch
    // per-array numbering: with one of each, `stages.length` and `unplacedStages.length` happen to
    // equal the union index, and the mutation stays green (it did — see the mutation log). This
    // shape makes them disagree: correct is 0,1,2; per-array is 0,0,1.
    const staging = await admin.deploymentTargets.create({
      name: `staging-${uuidv7()}`,
      properties: { environment: "staging" }
    });
    const component = await createOrphanComponent(admin, `interleave-${uuidv7()}`);
    await admin.placements.create({ component: component.id, deploymentTarget: gamma.id });
    await attachTopology(component.id, [
      { name: "gamma", target: gamma.id },
      { name: "staging", target: staging.id },
      { name: "prod", target: prod.id }
    ]);

    const p = await pipelineOf(component.id);

    const journey = [...p.stages, ...p.unplacedStages].sort((a, b) => a.order - b.order);
    expect(
      journey.map((s) => s.deploymentTarget.name),
      "concatenate both arrays, sort by `order`, and the pipeline reads in release order"
    ).toEqual([gamma.name, staging.name, prod.name]);
    expect(
      journey.map((s) => s.order),
      "`order` is contiguous from 0 ACROSS the union — per-array numbering would collide on 0"
    ).toEqual([0, 1, 2]);
  });

  it("keeps a placement at a target NO wave names — the mirror-image bug", async () => {
    // Hiding real state because a document omits it would be the same class of bug as bug 2, just
    // pointing the other way: this component genuinely deploys to `extra`, whatever the topology says.
    const extra = await admin.deploymentTargets.create({
      name: `extra-${uuidv7().slice(0, 8)}`,
      properties: { environment: "sandbox" }
    });
    const component = await createOrphanComponent(admin, `off-topology-${uuidv7()}`);
    await admin.placements.create({ component: component.id, deploymentTarget: gamma.id });
    await admin.placements.create({ component: component.id, deploymentTarget: extra.id });
    await attachTopology(component.id, [{ name: "gamma", target: gamma.id }]);

    const p = await pipelineOf(component.id);

    const offTopology = p.stages.find((s) => s.deploymentTarget.name === extra.name);
    expect(offTopology, "a place this component really deploys to must not vanish").toBeDefined();
    expect(
      offTopology!.wave,
      "but it is honestly marked as declared by no wave, rather than given an invented position"
    ).toBeNull();
    expect(
      offTopology!.order,
      "and it sorts AFTER the declared journey, which is the part with a defined order"
    ).toBe(1);
  });

  it("says the journey is UNKNOWN, not complete, when no stage-shaped topology resolves", async () => {
    // A LEGACY-shaped topology: its waves name the change's own targets (components), not places.
    // `plan-service.ts` classifies the same two shapes the same way, from what the ids ARE.
    const component = await createOrphanComponent(admin, `legacy-shape-${uuidv7()}`);
    await admin.placements.create({ component: component.id, deploymentTarget: gamma.id });
    await attachTopology(component.id, [{ name: "only", target: component.id }]);

    const p = await pipelineOf(component.id);

    expect(p.stages).toHaveLength(1);
    expect(
      p.stageSource,
      "no journey is declared over PLACES, so an empty `unplacedStages` here means unknowable — a client reading it as 'reaches every stage' would be inventing an observation"
    ).toBe("placements");
    expect(p.unplacedStages).toEqual([]);
    expect(p.stages[0]!.wave, "and no stage claims a wave that does not describe it").toBeNull();
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

  it("shows EVERY pipeline bound at a stage, not just the first", async () => {
    // A component runs several pipelines at one place: an `image` BUILD, an `infrastructure`
    // plan/apply, a `configuration` sync. `UNIQUE(org_id, target_object_id, type)` is what makes
    // that legal (ADR-0007 — Type is the routing key), and both live deployment-targets already
    // carry `image` + `configuration`. The first version of this projection read `bindings[0]` and
    // rendered it alone, so a stage's build pipeline or its infra pipeline simply vanished with no
    // sign it existed — owner-reported ("the component pipeline is missing the infra pipeline / the
    // software pipeline", 2026-08-03).
    const component = await createOrphanComponent(admin, `multi-pipeline-${uuidv7()}`);
    const placement = await admin.placements.create({
      component: component.id,
      deploymentTarget: gamma.id
    });
    await admin.executors.putBinding(placement.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${uuidv7()}`,
      externalRef: "deploy-app",
      type: "configuration"
    });
    await admin.executors.putBinding(placement.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${uuidv7()}`,
      externalRef: "build-app",
      type: "image"
    });

    const p = await pipelineOf(component.id);

    expect(
      p.stages[0]!.bindings.map((b) => b.type),
      "both pipelines must be present — and ordered by Type, so `binding` is a defined choice"
    ).toEqual(["configuration", "image"]);
    expect(p.stages[0]!.bindings.map((b) => b.externalRef)).toEqual(["deploy-app", "build-app"]);
    expect(
      p.stages[0]!.binding?.type,
      "the compat field stays the FIRST entry of that array, never something else"
    ).toBe("configuration");
  });

  it("resolves a COMPONENT-rung binding into the stage — the projection uses the engine's ladder", async () => {
    // The owner's own-infra case (2026-08-12): checkout-api carried an `infrastructure` binding on
    // the COMPONENT while running on a shared cluster — the engine's ladder (ADR-0027/0029,
    // binding-resolution.ts) resolves it for every wave target, but the projection listed
    // placement-rung rows only, so the journey said "No executor" / "no infrastructure pipeline is
    // bound" about a pipeline that would in fact trigger. The projection must answer what the
    // ENGINE would do, and say where the answer came from (resolvedVia, read off the resolver's
    // own provenance — never inferred).
    const component = await createOrphanComponent(admin, `component-rung-${uuidv7()}`);
    await admin.placements.create({ component: component.id, deploymentTarget: gamma.id });
    await admin.executors.putBinding(component.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${uuidv7()}`,
      externalRef: "own-bucket-iac",
      type: "infrastructure"
    });

    const p = await pipelineOf(component.id);
    const infra = p.stages[0]!.bindings.find((b) => b.type === "infrastructure");
    expect(
      infra,
      "the component-rung infrastructure binding must surface at the stage"
    ).toBeDefined();
    expect(infra!.externalRef).toBe("own-bucket-iac");
    expect(
      (infra as { resolvedVia?: string }).resolvedVia,
      "provenance is the resolver's own label for the rung that answered"
    ).toBe("component");
  });

  it("labels a binding on the stage's own placement as resolvedVia 'placement'", async () => {
    const component = await createOrphanComponent(admin, `placement-rung-${uuidv7()}`);
    const placement = await admin.placements.create({
      component: component.id,
      deploymentTarget: gamma.id
    });
    await admin.executors.putBinding(placement.id, {
      pluginModule: "fake-executor",
      pluginInstanceId: `inst-${uuidv7()}`,
      externalRef: "deploy-here",
      type: "configuration"
    });

    const p = await pipelineOf(component.id);
    const config = p.stages[0]!.bindings.find((b) => b.type === "configuration");
    expect((config as { resolvedVia?: string })?.resolvedVia).toBe("placement");
  });

  it("carries the SOURCE RULES that feed the component — the head of its journey", async () => {
    // Owner, 2026-08-03: "Still not seeing any repos." A `source_mappings` row is the durable answer
    // to "does a push there affect this?", so it renders for a component that has never released —
    // the same property the stages have, on the other end of the journey.
    const component = await createOrphanComponent(admin, `sources-${uuidv7()}`);
    await admin.changeSources.createMapping("github", {
      repoPattern: "AgentKitProject/agentkit",
      pathPattern: "services/market/**",
      component: component.id,
      type: "image"
    });
    // No `pathPattern` — the whole-repo rule, which is the live-estate shape worth surfacing.
    await admin.changeSources.createMapping("github", {
      repoPattern: "jag8765-personal/homelab-gitops",
      component: component.id,
      type: "configuration"
    });

    const p = await pipelineOf(component.id);

    expect(p.sources).toHaveLength(2);
    const image = p.sources.find((s) => s.type === "image");
    expect(image?.repoPattern).toBe("AgentKitProject/agentkit");
    expect(image?.pathPattern).toBe("services/market/**");
    expect(
      image?.category,
      "the Category rides the wire so a client groups pipelines into lanes without its own copy of the ADR-0007 map"
    ).toBe("build");

    const wholeRepo = p.sources.find((s) => s.type === "configuration");
    expect(
      wholeRepo?.pathPattern,
      "a NULL path matches every file in the repo — a far broader rule than a blank cell suggests, and it must reach the client as null rather than as an empty string"
    ).toBeNull();
  });

  it("has NO sources when nothing maps to it, which is a real and worth-saying state", async () => {
    const component = await createOrphanComponent(admin, `no-sources-${uuidv7()}`);
    const p = await pipelineOf(component.id);
    expect(
      p.sources,
      "no push to any repo can release this component — the source-side twin of an unplaced stage"
    ).toEqual([]);
  });

  it("reports the last release PER PIPELINE, never the newest across all of them", async () => {
    // A stage's pipelines release independently. One "last release" per stage credits whichever ran
    // most recently to ALL of them, so a pipeline that has never run reads as up to date — the same
    // collapse as `bindings[0]`, one field over. `change_wave_targets.type` is what makes the split
    // a direct read rather than an inference.
    const component = await createOrphanComponent(admin, `per-pipeline-current-${uuidv7()}`);
    const placement = await admin.placements.create({
      component: component.id,
      deploymentTarget: gamma.id
    });
    for (const type of ["configuration", "image"] as const) {
      await admin.executors.putBinding(placement.id, {
        pluginModule: "fake-executor",
        pluginInstanceId: `inst-${uuidv7()}`,
        externalRef: `${type}-ref`,
        type
      });
    }
    // Stage-shaped: the topology names the PLACE, so each change's wave target is the placement.
    const topo = await attachTopology(component.id, [{ name: "gamma", target: gamma.id }]);

    // The plan is compiled directly rather than waited for from the reconcile loop — the loop's job
    // (locking, state transitions) is covered elsewhere, and `stage-compilation.integration.test.ts`
    // takes the same shortcut for the same reason. Compilation is what writes the `change_wave_targets`
    // rows this projection reads, and it snapshots each target's Type from the change.
    const compile = (change: { id: string }) =>
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        compileAndPersistPlan(tx, {
          orgId: org.orgId,
          changeObjectId: change.id,
          targetObjectIds: [component.id],
          topologyObjectId: topo.id,
          topologyVersion: null
        })
      );

    const configChange = await admin.changes.propose({
      name: `cfg-${uuidv7()}`,
      targets: [component.id],
      type: "configuration"
    });
    await compile(configChange);
    const imageChange = await admin.changes.propose({
      name: `img-${uuidv7()}`,
      targets: [component.id],
      type: "image"
    });
    await compile(imageChange);

    const p = await pipelineOf(component.id);
    const currents = p.stages[0]!.currents;

    expect(
      currents.map((c) => c.category).sort(),
      "both pipelines have a release history here, and each must keep its own"
    ).toEqual(["build", "configuration"]);
    expect(currents.find((c) => c.category === "configuration")?.changeId).toBe(configChange.id);
    expect(currents.find((c) => c.category === "build")?.changeId).toBe(imageChange.id);
    expect(
      p.stages[0]!.current?.changeId,
      "the compat field is the NEWEST across pipelines — which is exactly why a lane must not read it"
    ).toBe(imageChange.id);
  });

  it("reports WHAT MUST PASS before a release moves into a stage", async () => {
    // The live estate's actual gate: 12 `prod-gate` policies, each requiring ONE Owner approval
    // before prod, with **282 approval requests pending** against them — and none of it appeared
    // anywhere in this view, so a release stopped at a gate looked exactly like one nobody started.
    const component = await createOrphanComponent(admin, `gated-${uuidv7()}`);
    const openPlacement = await admin.placements.create({
      component: component.id,
      deploymentTarget: gamma.id
    });
    const gatedPlacement = await admin.placements.create({
      component: component.id,
      deploymentTarget: prod.id
    });
    // Via the real typed-registry API (`admin.policies`, as governance.integration.test.ts does), so
    // the Ajv property validation for `policy` documents is exercised rather than bypassed.
    const policyName = `prod-gate-${uuidv7()}`;
    await admin.policies.create({
      name: policyName,
      urn: `urn:scp:${org.orgId}:policy:${policyName}`,
      properties: {
        scope: { objectRef: gatedPlacement.id },
        enforcement: "required",
        effects: [{ requireApprovals: { count: 1, fromRole: "Owner", scope: "organization" } }]
      }
    });

    const p = await pipelineOf(component.id);
    const gated = p.stages.find((s) => s.placement.id === gatedPlacement.id)!;
    const open = p.stages.find((s) => s.placement.id === openPlacement.id)!;

    expect(gated.gate.policies).toHaveLength(1);
    expect(gated.gate.policies[0]!.enforcement).toBe("required");
    expect(gated.gate.policies[0]!.requireApprovals).toEqual([
      { count: 1, fromRole: "Owner", scope: "organization" }
    ]);
    expect(
      gated.gate.policies[0]!.requireControls,
      "and it asks for NO automated check — every live policy is like this, and the view must say so rather than imply a test exists"
    ).toEqual([]);
    expect(
      open.gate.policies,
      "an ungated stage reports an EMPTY gate, which is a real state and not the same as 'we did not look'"
    ).toEqual([]);
  });

  it("reports each required CHECK, and separates 'nothing here' from 'here and unanswered'", async () => {
    // Owner, 2026-08-04: "not started, in progress, check marks and failed marks for tests". A
    // `control_run` belongs to a CHANGE, so a stage with nothing at it has no outcome to report and
    // must say `not_started` — a different fact from `pending`, which means a release IS here and
    // the control has not answered. Collapsing the two is the bug this test exists to prevent.
    const controlSuffix = uuidv7();
    const control = await admin.controls.create({
      name: `trivy-${controlSuffix}`,
      urn: `urn:scp:${org.orgId}:control:${controlSuffix}`,
      properties: { category: "security" }
    });
    const component = await createOrphanComponent(admin, `checks-${uuidv7()}`);
    const placement = await admin.placements.create({
      component: component.id,
      deploymentTarget: gamma.id
    });
    const policyName = `scan-gate-${uuidv7()}`;
    await admin.policies.create({
      name: policyName,
      urn: `urn:scp:${org.orgId}:policy:${policyName}`,
      properties: {
        scope: { objectRef: placement.id },
        enforcement: "required",
        effects: [{ requireControls: [control.id] }]
      }
    });

    const idle = await pipelineOf(component.id);
    expect(idle.stages[0]!.gate.checks).toHaveLength(1);
    expect(idle.stages[0]!.gate.checks[0]!.name, "the control is NAMED, not just an id").toBe(
      control.name
    );
    expect(
      idle.stages[0]!.gate.checks[0]!.status,
      "nothing is at this gate, so there is nothing for the control to have run against"
    ).toBe("not_started");
    expect(idle.stages[0]!.gate.checks[0]!.changeId).toBeNull();

    // Now put a release at the stage. The control still has no run — but that is now the OTHER
    // absence: it is the thing being waited on.
    const topo = await attachTopology(component.id, [{ name: "gamma", target: gamma.id }]);
    const change = await admin.changes.propose({
      name: `cfg-${uuidv7()}`,
      targets: [component.id],
      type: "configuration"
    });
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      compileAndPersistPlan(tx, {
        orgId: org.orgId,
        changeObjectId: change.id,
        targetObjectIds: [component.id],
        topologyObjectId: topo.id,
        topologyVersion: null
      })
    );

    const inFlight = await pipelineOf(component.id);
    const check = inFlight.stages[0]!.gate.checks[0]!;
    expect(check.status, "a release is here and the control has not reported").toBe("pending");
    expect(
      check.changeId,
      "and the status says WHICH release it is as of — 'passed' is never a standing property of a place"
    ).toBe(change.id);
  });

  it("says WHICH DOMAIN maintains each place — the commander coordinates, the outpost runs", async () => {
    // Owner, 2026-08-04. ADR-0017 §2 devolves execution to the originating outpost and leaves the
    // commander owning only the cross-boundary gate; ADR-0011 has the receiving outpost validate
    // every deploy inside its own domain. Resolved from the TARGET's own `origin_domain_id`, never
    // from this instance's identity — the same rule ADR-0026 D1 applies to stage names, so a
    // replicated target reads the same at the commander and at the outpost.
    const component = await createOrphanComponent(admin, `maintainer-${uuidv7()}`);
    await admin.placements.create({ component: component.id, deploymentTarget: gamma.id });

    const p = await pipelineOf(component.id);
    const maintainer = p.stages[0]!.maintainedBy;

    expect(maintainer.isSelf, "this org's own targets are maintained by this domain").toBe(true);
    // NOT asserted against `org.orgName`: `ensureFederationSelf` seeds `name` from the domain id
    // until an operator names the domain, so pinning the org name here would pin a default rather
    // than the behaviour. What matters is that a domain is identified at all.
    expect(maintainer.name, "a stage must never render as belonging to nobody").not.toBeNull();
    expect(maintainer.domainId).not.toBeNull();
    expect(maintainer.role, "and its federation role is carried through").not.toBeNull();
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
