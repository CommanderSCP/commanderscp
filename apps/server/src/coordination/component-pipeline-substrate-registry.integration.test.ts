import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { and, eq } from "drizzle-orm";
import { ScpClient } from "@scp/sdk";
import type { GraphObject } from "@scp/schemas";
import { withTenantTx } from "../db/tenant-tx.js";
import { relationships, syncJournal } from "../db/schema.js";
import {
  createOrphanComponent,
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";

/**
 * pipeline-substrate-registry-scan.md §9.1 (the target SUBSTRATE FACET on the wire) and §9.2 (the
 * per-site REGISTRY via `publishes_to`) — through the real HTTP route against real Postgres, with
 * migration 0065 applied by the harness.
 *
 * WHAT EACH TEST PINS, AND WHY IT IS NOT VACUOUS
 *   - facet on a PLACED and an UNPLACED stage: the server builds ONE `deploymentTarget` literal and
 *     pushes it into both arrays; a fix applied to only one array (the census-by-property hazard)
 *     fails whichever half it missed. A target with no facet reads null everywhere — the ABSENCE of a
 *     declaration, never a value inferred from `name` (the fixture name here embeds a fake region on
 *     purpose).
 *   - registry none / declared / ambiguous: three states, each asserted on `state` AND on the
 *     identity fields, so "always declared" or "pick the first of two" both fail.
 *   - a `publishes_to` edge to a `domainLocal:true` execution-system NEVER journals (M20.3, the
 *     construction §9.2 relies on for "one registry per site"), with a CONTROL edge to a shared
 *     system that DOES — so the assertion cannot pass by the journal simply being empty.
 *   - a non-string `properties.repository` yields null, not a crash: the API refuses one (0065's
 *     property schema, Ajv at write) so the row is written underneath — the "row this validator never
 *     saw" case (pre-0065 data, a replica) the typeof guard exists for.
 *
 * MUTATION LOG (each applied ALONE, then reverted)
 * | Mutation | Result |
 * |---|---|
 * | drop `substrate` from the `deploymentTarget` literal (server) | typecheck fails; forcing it through with `null` — the placed AND unplaced facet tests FAIL on `substrate` |
 * | resolve `state: "declared"` from `rows[0]` when >1 edge | the ambiguous test FAILS (`state`, and `name` non-null) |
 * | skip the `domainLocal`-endpoint journal check in relationships-repo | the never-journals test FAILS — a `relationship_upsert` row names the edge |
 * | read `repository` without the string guard | the non-string test FAILS with `repository: 42` on the wire (zod response validation would also refuse it) |
 * | drop `isNull(relationships.deletedAt)` from the `publishes_to` where-clause | the deleted-edge test FAILS (`declared`, edgeCount 1 after the delete) |
 */
describe("component pipeline: the substrate facet (§9.1) and the per-site registry (§9.2)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;

  const uniq = (p: string) => `${p}-${uuidv7()}`;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "pipeline-substrate-registry");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
  });

  afterAll(async () => {
    await server?.close();
  });

  type Facet = {
    substrate: string | null;
    account: string | null;
    region: string | null;
    cluster: string | null;
  };
  type Registry = {
    state: "declared" | "ambiguous" | "none";
    executionSystemId: string | null;
    name: string | null;
    kind: string | null;
    url: string | null;
    repository: string | null;
    edgeCount: number;
  };

  async function pipelineOf(componentId: string) {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/components/${componentId}/pipeline`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(res.statusCode, "the pipeline route must answer").toBe(200);
    return res.json() as {
      stages: { deploymentTarget: { id: string; name: string } & Facet }[];
      unplacedStages: { deploymentTarget: { id: string; name: string } & Facet }[];
      registry: Registry | null | undefined;
    };
  }

  async function attachTopology(componentId: string, waves: { name: string; target: string }[]) {
    const topo = await admin.object("release-topology").create({
      name: uniq("topo"),
      properties: {
        waves: waves.map((w) => ({ name: w.name, mode: "parallel", targets: [w.target] }))
      }
    });
    await admin.relationships.create({
      typeId: "releases_via",
      fromId: componentId,
      toId: topo.id
    });
  }

  async function registrySystem(
    name: string,
    opts: { domainLocal: boolean; webUrl?: string; kind?: unknown }
  ): Promise<GraphObject> {
    return admin.object("execution-system").create({
      name,
      domainLocal: opts.domainLocal,
      properties: {
        kind: opts.kind ?? "gitea",
        serverUrl: "https://registry.hq.invalid/",
        ...(opts.webUrl ? { webUrl: opts.webUrl } : {})
      }
    });
  }

  async function journalRowsNaming(edgeId: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ entryKind: syncJournal.entryKind, payload: syncJournal.payload })
        .from(syncJournal)
        .where(eq(syncJournal.orgId, org.orgId))
    ).then((rows) =>
      rows.filter(
        (r) =>
          r.entryKind === "relationship_upsert" && (r.payload as { id?: unknown }).id === edgeId
      )
    );
  }

  // ------------------------------------------------------------------------------------------
  // §9.1 — the facet
  // ------------------------------------------------------------------------------------------

  it("carries the substrate facet on a PLACED stage and on an UNPLACED stage — read, never inferred", async () => {
    // The facet lives on the target's `properties` (migration 0065 types it as optional strings)
    // and is created through the SDK exactly as an operator would.
    const placedTarget = await admin.deploymentTargets.create({
      name: uniq("us-east-1-prod (k8s)"),
      properties: {
        environment: "prod",
        substrate: "aws",
        account: "210987654321",
        region: "us-east-1",
        cluster: "prod-eks"
      }
    });
    const unplacedTarget = await admin.deploymentTargets.create({
      name: uniq("field-cluster"),
      properties: { substrate: "kubernetes", cluster: "field-eks" }
    });
    const component = await createOrphanComponent(server, org, uniq("facet"));
    await admin.placements.create({ component: component.id, deploymentTarget: placedTarget.id });
    await attachTopology(component.id, [
      { name: "prod", target: placedTarget.id },
      { name: "field", target: unplacedTarget.id }
    ]);

    const p = await pipelineOf(component.id);

    const placed = p.stages.find((s) => s.deploymentTarget.id === placedTarget.id);
    expect(placed, "the placed stage is on the wire").toBeDefined();
    expect(placed!.deploymentTarget).toMatchObject({
      substrate: "aws",
      account: "210987654321",
      region: "us-east-1",
      cluster: "prod-eks"
    });

    const unplaced = p.unplacedStages.find((s) => s.deploymentTarget.id === unplacedTarget.id);
    expect(unplaced, "the unplaced stage is on the wire").toBeDefined();
    expect(
      unplaced!.deploymentTarget,
      "the SAME literal feeds `unplacedStages` — an on-prem cluster with no account reads null there, not a blank string"
    ).toMatchObject({
      substrate: "kubernetes",
      account: null,
      region: null,
      cluster: "field-eks"
    });
  });

  it("reads an ABSENT facet as null on every key — nothing is derived from the target's name", async () => {
    // The name is deliberately parseable-looking. If any facet key were inferred from it, this
    // target would come back with a region it never declared.
    const bare = await admin.deploymentTargets.create({
      name: uniq("eu-west-2-prod (aws)"),
      properties: { environment: "prod" }
    });
    const component = await createOrphanComponent(server, org, uniq("no-facet"));
    await admin.placements.create({ component: component.id, deploymentTarget: bare.id });

    const p = await pipelineOf(component.id);

    expect(p.stages).toHaveLength(1);
    expect(p.stages[0]!.deploymentTarget).toMatchObject({
      substrate: null,
      account: null,
      region: null,
      cluster: null
    });
  });

  it("refuses a non-string facet value at the door — 0065's property schema is live", async () => {
    await expect(
      admin.deploymentTargets.create({
        name: uniq("bad-facet"),
        properties: { substrate: 7 }
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  // ------------------------------------------------------------------------------------------
  // §9.2 — the registry
  // ------------------------------------------------------------------------------------------

  it("registry: `none` when the component has no `publishes_to` edge — every identity field null", async () => {
    const component = await createOrphanComponent(server, org, uniq("no-registry"));

    const p = await pipelineOf(component.id);

    expect(p.registry, "the field is emitted, not omitted — `none` is a value").toEqual({
      state: "none",
      executionSystemId: null,
      name: null,
      kind: null,
      url: null,
      repository: null,
      edgeCount: 0
    });
  });

  it("registry: `declared` from ONE edge — name off the object, kind off `properties.kind`, url = webUrl base, repository off the EDGE", async () => {
    const component = await createOrphanComponent(server, org, uniq("one-registry"));
    const hq = await registrySystem(uniq("hq-registry"), {
      domainLocal: true,
      webUrl: "https://registry.hq.invalid/ui/"
    });
    await admin.relationships.create({
      typeId: "publishes_to",
      fromId: component.id,
      toId: hq.id,
      properties: { repository: "acme/checkout-api" }
    });

    const p = await pipelineOf(component.id);

    expect(p.registry).toEqual({
      state: "declared",
      executionSystemId: hq.id,
      name: hq.name,
      kind: "gitea",
      // `webUrl` wins over `serverUrl`, trailing slash trimmed, NO guessed deep path.
      url: "https://registry.hq.invalid/ui",
      repository: "acme/checkout-api",
      edgeCount: 1
    });
  });

  it("registry: a DELETED `publishes_to` edge no longer counts — `declared` returns to `none` with edgeCount 0 (a tombstone is not a declaration)", async () => {
    const component = await createOrphanComponent(server, org, uniq("deleted-edge"));
    const hq = await registrySystem(uniq("hq-registry"), { domainLocal: true });
    const edge = await admin.relationships.create({
      typeId: "publishes_to",
      fromId: component.id,
      toId: hq.id,
      properties: { repository: "acme/checkout-api" }
    });
    expect((await pipelineOf(component.id)).registry).toMatchObject({
      state: "declared",
      executionSystemId: hq.id,
      edgeCount: 1
    });

    await admin.relationships.delete(edge.id);

    expect((await pipelineOf(component.id)).registry).toEqual({
      state: "none",
      executionSystemId: null,
      name: null,
      kind: null,
      url: null,
      repository: null,
      edgeCount: 0
    });
  });

  it("registry: `ambiguous` with the COUNT and null identity when >1 edge — stated, never picked", async () => {
    const component = await createOrphanComponent(server, org, uniq("two-registries"));
    const a = await registrySystem(uniq("registry-a"), { domainLocal: true });
    const b = await registrySystem(uniq("registry-b"), { domainLocal: true });
    await admin.relationships.create({
      typeId: "publishes_to",
      fromId: component.id,
      toId: a.id,
      properties: { repository: "acme/a" }
    });
    await admin.relationships.create({
      typeId: "publishes_to",
      fromId: component.id,
      toId: b.id,
      properties: { repository: "acme/b" }
    });

    const p = await pipelineOf(component.id);

    expect(p.registry).toEqual({
      state: "ambiguous",
      executionSystemId: null,
      name: null,
      kind: null,
      url: null,
      repository: null,
      edgeCount: 2
    });
  });

  it("registry: falls back to `serverUrl` when there is no `webUrl`, and to null kind when `kind` is not a string", async () => {
    const component = await createOrphanComponent(server, org, uniq("serverurl-registry"));
    const sys = await registrySystem(uniq("kindless-registry"), { domainLocal: true, kind: 42 });
    await admin.relationships.create({
      typeId: "publishes_to",
      fromId: component.id,
      toId: sys.id
    });

    const p = await pipelineOf(component.id);

    expect(p.registry).toMatchObject({
      state: "declared",
      kind: null,
      url: "https://registry.hq.invalid",
      repository: null
    });
  });

  it("a `publishes_to` edge to a domainLocal:true execution-system NEVER journals — and the shared control does", async () => {
    const component = await createOrphanComponent(server, org, uniq("journal"));
    const local = await registrySystem(uniq("local-registry"), { domainLocal: true });
    const shared = await registrySystem(uniq("shared-registry"), { domainLocal: false });

    const localEdge = await admin.relationships.create({
      typeId: "publishes_to",
      fromId: component.id,
      toId: local.id,
      properties: { repository: "acme/local" }
    });
    const sharedEdge = await admin.relationships.create({
      typeId: "publishes_to",
      fromId: component.id,
      toId: shared.id,
      properties: { repository: "acme/shared" }
    });

    expect(
      await journalRowsNaming(localEdge.id),
      "one domain-local endpoint is enough (M20.3): the edge stays home, which is what makes the registry per-site by construction"
    ).toHaveLength(0);
    expect(
      await journalRowsNaming(sharedEdge.id),
      "CONTROL — an all-shared edge journals, so the assertion above is not satisfied by an empty journal"
    ).toHaveLength(1);
  });

  it("a non-string `properties.repository` on the edge reads as null — no crash — and the API refuses to write one", async () => {
    const component = await createOrphanComponent(server, org, uniq("bad-repo"));
    const sys = await registrySystem(uniq("legacy-registry"), { domainLocal: true });

    // The door is closed: 0065's open property schema types `repository` as a string.
    await expect(
      admin.relationships.create({
        typeId: "publishes_to",
        fromId: component.id,
        toId: sys.id,
        properties: { repository: 42 }
      })
    ).rejects.toMatchObject({ status: 400 });

    // So model the row the validator never saw — data written before 0065, or a replica — by
    // writing the bag underneath the API. This is the case the typeof guard exists for.
    const edge = await admin.relationships.create({
      typeId: "publishes_to",
      fromId: component.id,
      toId: sys.id,
      properties: { repository: "acme/ok" }
    });
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(relationships)
        .set({ properties: { repository: 42 } })
        .where(and(eq(relationships.orgId, org.orgId), eq(relationships.id, edge.id)))
    );

    const p = await pipelineOf(component.id);

    expect(p.registry).toMatchObject({
      state: "declared",
      executionSystemId: sys.id,
      repository: null,
      edgeCount: 1
    });
  });
});
