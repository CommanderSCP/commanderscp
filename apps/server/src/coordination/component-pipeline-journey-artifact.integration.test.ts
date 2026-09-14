import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { ScpClient } from "@scp/sdk";
import type { ComponentPipelineResponse, GraphObject } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { compileAndPersistPlan } from "./plan-service.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/** THE CORRELATION KEY ON THE PIPELINE WIRE (journey-view §8.11). See docs/coordination.md §317.
 *
 *  Path A is TWO changes — an `image` change that ends at the registry and the `configuration`
 *  change that deploys it — so at a stage the artifact legitimately belongs to a change the stage is
 *  not showing. Path B's chart bump looks identical on the wire except for one fact: its artifact's
 *  change shares no event with it. `artifact.changeId` alone cannot separate those, and the routing
 *  Type cannot either (both deploy-stage changes are `configuration`), so this file pins the ONE
 *  field that can — projected per change, from `changes.correlation_key`, on both sides of the
 *  comparison the view makes (`artifactRelationToStage`). */
describe("component pipeline: the correlation key that separates the two release paths", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let gamma: GraphObject;

  const uniq = (p: string) => `${p}-${uuidv7()}`;
  const digestOf = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "pipeline-journey-artifact");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    gamma = await admin.deploymentTargets.create({
      name: uniq("gamma"),
      properties: { environment: "gamma" }
    });
  });

  afterAll(async () => {
    await server?.close();
  });

  async function pipelineOf(componentId: string): Promise<ComponentPipelineResponse> {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/components/${componentId}/pipeline`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode, "the pipeline route must answer").toBe(200);
    return res.json();
  }

  /** A component placed at gamma with a one-wave topology, so a compiled plan gives it a `current`. */
  async function placedComponent(label: string): Promise<{ id: string; topologyId: string }> {
    const component = await createOrphanComponent(server, org, uniq(label));
    await admin.placements.create({ component: component.id, deploymentTarget: gamma.id });
    const topo = await admin.object("release-topology").create({
      name: uniq("topo"),
      properties: { waves: [{ name: "gamma", mode: "parallel", targets: [gamma.id] }] }
    });
    await admin.relationships.create({
      typeId: "releases_via",
      fromId: component.id,
      toId: topo.id
    });
    return { id: component.id, topologyId: topo.id };
  }

  async function compile(componentId: string, changeId: string, topologyId: string) {
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      compileAndPersistPlan(tx, {
        orgId: org.orgId,
        changeObjectId: changeId,
        targetObjectIds: [componentId],
        topologyObjectId: topologyId,
        topologyVersion: null
      })
    );
  }

  it("Path A — the two arms of one push carry the SAME key, so the stage and the artifact it shows agree", async () => {
    const component = await placedComponent("path-a");
    // The synthesised shape `webhook-processor.ts` writes for a fan-out, verbatim.
    const correlationKey = `change-source-event:${uuidv7()}`;
    const digest = digestOf("a");

    // Arm 1: the `image` release. It carries the digest and is never deployed anywhere.
    const imageChange = await admin.changes.propose({
      name: uniq("image-arm"),
      targets: [component.id],
      type: "image",
      correlationKey,
      sourceRef: { artifactDigest: digest }
    });
    // Arm 2: the `configuration` release — the gitops bump that actually deploys it.
    const configChange = await admin.changes.propose({
      name: uniq("config-arm"),
      targets: [component.id],
      type: "configuration",
      correlationKey
    });
    await compile(component.id, configChange.id, component.topologyId);

    const p = await pipelineOf(component.id);
    const current = p.stages[0]!.currents.find((c) => c.category === "configuration");
    expect(current?.changeId, "precondition: the stage shows the CONFIG arm").toBe(configChange.id);
    // The pick falls back past the config arm (it carries no digest) to the image arm — which is
    // exactly the case `changeId` alone reads as "someone else's artifact".
    expect(p.artifact!.changeId, "precondition: the artifact is the OTHER arm's").toBe(
      imageChange.id
    );

    expect(current!.correlationKey, "the stage's release names the push").toBe(correlationKey);
    expect(p.artifact!.correlationKey, "and so does the artifact's change").toBe(correlationKey);
  });

  it("Path B — a bare config release shares no key with the older artifact it rolls forward", async () => {
    const component = await placedComponent("path-b");
    const imageChange = await admin.changes.propose({
      name: uniq("earlier-image"),
      targets: [component.id],
      type: "image",
      correlationKey: `change-source-event:${uuidv7()}`,
      sourceRef: { artifactDigest: digestOf("b") }
    });
    // The chart bump: its own event, its own key — NOT the image's.
    const chartChange = await admin.changes.propose({
      name: uniq("chart-bump"),
      targets: [component.id],
      type: "configuration",
      correlationKey: `change-source-event:${uuidv7()}`
    });
    await compile(component.id, chartChange.id, component.topologyId);

    const p = await pipelineOf(component.id);
    const current = p.stages[0]!.currents.find((c) => c.category === "configuration");
    expect(current?.changeId).toBe(chartChange.id);
    expect(p.artifact!.changeId).toBe(imageChange.id);
    expect(typeof current!.correlationKey).toBe("string");
    expect(typeof p.artifact!.correlationKey).toBe("string");
    expect(
      current!.correlationKey,
      "two different pushes — the keys must NOT collide, or Path B reads as Path A"
    ).not.toBe(p.artifact!.correlationKey);
  });

  it("a change naming no event projects `null`, not an omitted field — the estate's own shape today", async () => {
    // `webhook-processor.ts` synthesises a key ONLY on a fan-out, so a single-Type push leaves the
    // column NULL. The field must therefore be EMITTED as null: absent means "this server does not
    // project it", which the view reads as "not known" and would render as an unanswered question.
    const component = await placedComponent("no-key");
    const imageChange = await admin.changes.propose({
      name: uniq("keyless-image"),
      targets: [component.id],
      type: "image",
      sourceRef: { artifactDigest: digestOf("c") }
    });
    const configChange = await admin.changes.propose({
      name: uniq("keyless-config"),
      targets: [component.id],
      type: "configuration"
    });
    await compile(component.id, configChange.id, component.topologyId);

    const p = await pipelineOf(component.id);
    const current = p.stages[0]!.currents.find((c) => c.category === "configuration");
    expect(current?.changeId).toBe(configChange.id);
    expect(p.artifact!.changeId).toBe(imageChange.id);
    expect(current, "emitted").toHaveProperty("correlationKey");
    expect(p.artifact, "emitted").toHaveProperty("correlationKey");
    expect(current!.correlationKey).toBeNull();
    expect(p.artifact!.correlationKey).toBeNull();
  });

  it("the key is per CHANGE, not per component — one component's two releases can differ", async () => {
    // The projection reads `changes.correlation_key` on each row it returns. A per-component read
    // (or a single read reused for both halves) would pass every case above while making the two
    // sides equal by construction — the defect §8.2 describes, one field over.
    const component = await placedComponent("per-change");
    const key = `change-source-event:${uuidv7()}`;
    await admin.changes.propose({
      name: uniq("keyed-image"),
      targets: [component.id],
      type: "image",
      correlationKey: key,
      sourceRef: { artifactDigest: digestOf("d") }
    });
    const configChange = await admin.changes.propose({
      name: uniq("keyless-config"),
      targets: [component.id],
      type: "configuration"
    });
    await compile(component.id, configChange.id, component.topologyId);

    const p = await pipelineOf(component.id);
    const current = p.stages[0]!.currents.find((c) => c.category === "configuration");
    expect(current!.correlationKey, "the config arm named no event").toBeNull();
    expect(p.artifact!.correlationKey, "the image arm did").toBe(key);
  });
});
