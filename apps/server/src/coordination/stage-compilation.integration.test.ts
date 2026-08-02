import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { compileAndPersistPlan } from "./plan-service.js";
import {
  createTestComponent,
  createTestOrg,
  listenTestServer,
  testDatabaseUrl,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * Stage-shaped compilation end to end, plus the silent hazards §1.5/§11 named.
 *
 * `compileAndPersistPlan` is called directly rather than driven through the reconcile loop: the
 * loop's job (locking, state transitions) is covered elsewhere, and calling the compiler service
 * lets each case assert the PERSISTED plan — which is the artifact that matters, and the one where
 * an empty wave being emitted-vs-omitted is observable.
 *
 * **Mutation log** (each applied alone, then reverted):
 *
 * | Mutation | Result |
 * |---|---|
 * | persist a skipped wave as `pending` | "born skipped" fails |
 * | `resolveStagePlacements` returns undefined (never classify as stage) | the two-wave and skipped tests fail |
 * | drop the mixed-shape refusal | "REFUSES a topology mixing places and non-places" fails |
 * | `parseTopologyWaves`: restore `return undefined` for a non-array | "a malformed document is refused" fails |
 * | `parseTopologyWaves`: allow `waves: []` | "an empty waves array is refused" fails |
 * | `parseTopologyWaves`: drop the unknown-key check | "an unknown wave key is refused" fails |
 * | `parseTopologyWaves`: drop the per-wave mode/targets checks | "a wave with a bad mode" fails |
 */
describe("stage-shaped compilation + malformed-topology loudness", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let gamma: GraphObject;
  let prod: GraphObject;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "stage-compile");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    gamma = await admin.deploymentTargets.create({ name: "gamma (self-host canary)" });
    prod = await admin.deploymentTargets.create({ name: "prod (DOKS hosted)" });
  });

  afterAll(async () => {
    await server?.close();
  });

  const topology = (name: string, waves: unknown) =>
    admin.object("release-topology").create({ name, properties: { waves } });

  const gammaThenProdDoc = () => [
    { name: "gamma", mode: "parallel", targets: [gamma.id] },
    { name: "prod", mode: "parallel", targets: [prod.id] }
  ];

  async function compile(
    change: { id: string },
    targets: string[],
    topologyObjectId: string | null
  ) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      compileAndPersistPlan(tx, {
        orgId: org.orgId,
        changeObjectId: change.id,
        targetObjectIds: targets,
        topologyObjectId,
        topologyVersion: null
      })
    );
  }

  async function componentWithPlacements(label: string, places: GraphObject[]) {
    const component = await createTestComponent(admin, { name: `${label}-comp` });
    for (const p of places) {
      await admin.placements.create({ component: component.id, deploymentTarget: p.id });
    }
    return component;
  }

  const proposeFor = (name: string, targets: string[]) => admin.changes.propose({ name, targets });

  /** Privileged fixture surgery — writes a `properties` document the API's Ajv would refuse. */
  async function writeRawProperties(objectId: string, properties: unknown) {
    const surgeon = new pg.Client({ connectionString: testDatabaseUrl() });
    await surgeon.connect();
    try {
      await surgeon.query("UPDATE objects SET properties = $2::jsonb WHERE id = $1", [
        objectId,
        JSON.stringify(properties)
      ]);
    } finally {
      await surgeon.end();
    }
  }

  it("a SINGLE-target change yields a real multi-wave plan — the gap this closes", () => {
    // 276 of 280 plans on the estate have no topology and 276 of 284 waves have an empty name: the
    // single anonymous wave a toposort emits for a one-component change. This is the whole point.
    return (async () => {
      const component = await componentWithPlacements("single", [gamma, prod]);
      const topo = await topology("single-gamma-then-prod", gammaThenProdDoc());
      const change = await proposeFor("single-target-change", [component.id]);

      const plan = await compile(change, [component.id], topo.id);

      expect(plan.waves).toHaveLength(2);
      expect(plan.waves.map((w) => w.name)).toEqual(["gamma", "prod"]);
      // Each wave's target is a PLACEMENT, not the component — that is what gives the per-row
      // executor_ref / observed_state / status columns a durable subject.
      const placements = await admin.placements.list({ component: component.id });
      const byTarget = new Map(
        placements.items.map((p) => [p.properties.deploymentTargetId as string, p.id])
      );
      expect(plan.waves[0]!.targets.map((t) => t.targetObjectId)).toEqual([byTarget.get(gamma.id)]);
      expect(plan.waves[1]!.targets.map((t) => t.targetObjectId)).toEqual([byTarget.get(prod.id)]);
      expect(plan.waves[0]!.status).toBe("pending");
    })();
  });

  it("a prod-only component's gamma wave is PERSISTED and born `skipped`", async () => {
    // The `agentkit-umami-prod` case. `skipped` is a status both reconcilers already honour when
    // choosing the active wave — nothing produced it until now.
    const component = await componentWithPlacements("prodonly", [prod]);
    const topo = await topology("prodonly-gamma-then-prod", gammaThenProdDoc());
    const change = await proposeFor("prod-only-change", [component.id]);

    const plan = await compile(change, [component.id], topo.id);

    expect(plan.waves).toHaveLength(2);
    expect(plan.waves[0]!.name).toBe("gamma");
    expect(plan.waves[0]!.status).toBe("skipped");
    expect(plan.waves[0]!.targets).toHaveLength(0);
    // Index alignment is the load-bearing half: omitting the wave would renumber prod to 0 and
    // flip its fan-in flag, and nothing in the UI would say gamma had been declared at all.
    expect(plan.waves[1]!.waveIndex).toBe(1);
    expect(plan.waves[1]!.status).toBe("pending");
    expect(plan.waves[1]!.requiresFanIn).toBe(true);
  });

  it("REFUSES to compile a change whose target is placed nowhere the topology names", async () => {
    const dev = await admin.deploymentTargets.create({ name: "dev-only-place" });
    const component = await componentWithPlacements("stranded", [dev]);
    const topo = await topology("stranded-gamma-then-prod", gammaThenProdDoc());
    const change = await proposeFor("stranded-change", [component.id]);

    await expect(compile(change, [component.id], topo.id)).rejects.toThrow();
  });

  it("REFUSES a topology mixing deployment-targets with non-places", async () => {
    const component = await componentWithPlacements("mixed", [gamma, prod]);
    const topo = await topology("mixed-shape", [
      { name: "gamma", mode: "parallel", targets: [gamma.id] },
      { name: "odd", mode: "parallel", targets: [component.id] }
    ]);
    const change = await proposeFor("mixed-change", [component.id]);

    await expect(compile(change, [component.id], topo.id)).rejects.toThrow();
  });

  it("a LEGACY topology naming the change's own targets still compiles", async () => {
    // Both shapes exist in real data — the estate has one topology of each. Stage mode must not
    // break the other, and D6 forbids backfilling.
    const component = await createTestComponent(admin, { name: "legacy-comp" });
    const topo = await topology("legacy-shape", [
      { name: "only", mode: "parallel", targets: [component.id] }
    ]);
    const change = await proposeFor("legacy-change", [component.id]);

    const plan = await compile(change, [component.id], topo.id);
    expect(plan.waves).toHaveLength(1);
    expect(plan.waves[0]!.targets.map((t) => t.targetObjectId)).toEqual([component.id]);
  });

  // -------------------------------------------------------------------------------------------
  // §1.5 / §11 — the malformed-topology property, all three instances
  // -------------------------------------------------------------------------------------------

  it("REFUSES a malformed `waves` (not an array) instead of silently compiling one wave", async () => {
    // Written by SURGERY, not the API, and that is the honest reachability story: the registered
    // JSON Schema already rejects a non-array `waves` and a bad `mode` at the write door, so the
    // API is not how a document like this arrives. What reaches `parseTopologyWaves` unvalidated is
    // a document from another path — a federated `object_upsert` applied against a DIFFERENT
    // schema version, a row predating a schema tightening, or the `topology_document` SNAPSHOT,
    // which is copied into `change_plans` at compile time and which Ajv never re-validates.
    // Before the fix every one of those compiled silently to a single anonymous wave.
    const component = await createTestComponent(admin, { name: "malformed-comp" });
    const topo = await topology("malformed-not-array", []);
    await writeRawProperties(topo.id, { waves: { oops: true } });
    const change = await proposeFor("malformed-change", [component.id]);

    await expect(compile(change, [component.id], topo.id)).rejects.toThrow();
  });

  it("REFUSES an EMPTY `waves` array — the second instance of the same property", async () => {
    // `compilePlan`'s `length === 0` branch falls back to toposort, so this compiled to exactly the
    // same single anonymous wave as having no topology at all. Attaching it did nothing, visibly.
    const component = await createTestComponent(admin, { name: "emptywaves-comp" });
    const topo = await topology("malformed-empty", []);
    const change = await proposeFor("emptywaves-change", [component.id]);

    await expect(compile(change, [component.id], topo.id)).rejects.toThrow();
  });

  it("REFUSES an unknown wave key (D16's intent, enforced at the point of use)", async () => {
    const component = await componentWithPlacements("unknownkey", [gamma, prod]);
    const topo = await topology("malformed-unknown-key", [
      { name: "gamma", mode: "parallel", targets: [gamma.id], stages: ["commercial-gamma"] }
    ]);
    const change = await proposeFor("unknownkey-change", [component.id]);

    await expect(compile(change, [component.id], topo.id)).rejects.toThrow();
  });

  it("REFUSES a wave with a bad mode or no targets — the unchecked cast, third instance", async () => {
    // Also by surgery, same reasoning as above: `waves as TopologyWaveSpec[]` was a cast with no
    // validation behind it, so any document reaching it from a non-API path was trusted whole.
    const component = await componentWithPlacements("badwave", [gamma, prod]);
    const badMode = await topology("malformed-mode", []);
    await writeRawProperties(badMode.id, {
      waves: [{ name: "gamma", mode: "paralel", targets: [gamma.id] }]
    });
    const noTargets = await topology("malformed-targets", []);
    await writeRawProperties(noTargets.id, { waves: [{ name: "gamma", mode: "parallel" }] });
    const change = await proposeFor("badwave-change", [component.id]);

    await expect(compile(change, [component.id], badMode.id)).rejects.toThrow();
    await expect(compile(change, [component.id], noTargets.id)).rejects.toThrow();
  });

  it("a topology with NO `waves` key at all is still fine — absent is not malformed", async () => {
    // The registered schema permits it and it means "no explicit ordering". Refusing this would
    // break every topology-less change, which is 276 of 280 plans on the estate.
    const component = await createTestComponent(admin, { name: "nowaves-comp" });
    const topo = await admin.object("release-topology").create({ name: "no-waves-key" });
    const change = await proposeFor("nowaves-change", [component.id]);

    const plan = await compile(change, [component.id], topo.id);
    expect(plan.waves).toHaveLength(1);
  });
});
