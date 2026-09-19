import { v7 as uuidv7 } from "uuid";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { deleteObject } from "./objects-repo.js";
import { ensureFederationSelf } from "../federation/self-repo.js";

/** Deleting a container that still has children is refused. See docs/graph.md §19. */
describe("container delete guard (proposal §9.3, all three dependent routes)", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "container-delete");
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  const uniq = (p: string): string => `${p}-${uuidv7().slice(0, 8)}`;

  interface Response {
    status: number;
    body: string;
    json: () => Record<string, unknown>;
  }

  async function call(
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: Record<string, unknown>
  ): Promise<Response> {
    const res = await server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${org.adminToken}` },
      ...(payload === undefined ? {} : { payload })
    });
    return { status: res.statusCode, body: res.body, json: () => res.json() };
  }

  const detailOf = (res: Response): string => String((res.json() as { detail?: string }).detail);

  async function makeService(label: string): Promise<{ id: string; componentId: string }> {
    const service = await call("POST", "/api/v1/services", { name: uniq(label) });
    expect(service.status, service.body).toBe(201);
    const component = await call("POST", "/api/v1/components", {
      name: uniq(`${label}-comp`),
      service: service.json().id as string
    });
    expect(component.status, component.body).toBe(201);
    return { id: service.json().id as string, componentId: component.json().id as string };
  }

  // The widening (m7)

  it("refuses deleting a service with components, NAMING them and the route", async () => {
    const { id, componentId } = await makeService("svc-with-comps");
    const refused = await call("DELETE", `/api/v1/services/${id}`);
    expect(refused.status, refused.body).toBe(409);
    expect(detailOf(refused)).toContain("contained by it");
    expect(detailOf(refused)).toContain("contains");
    expect(detailOf(refused)).toContain("component");
    // The remedy is IN the refusal — a guard an operator cannot act on is a wall.
    expect(detailOf(refused)).toContain("/service");

    // The component is untouched, and the delete lands once it is gone.
    const stillThere = await call("GET", `/api/v1/components/${componentId}`);
    expect(stillThere.status, stillThere.body).toBe(200);
    expect((await call("DELETE", `/api/v1/components/${componentId}`)).status).toBe(200);
    expect((await call("DELETE", `/api/v1/services/${id}`)).status).toBe(200);
  });

  it("refuses deleting an assembly with components — the container level between service and component", async () => {
    // An `assembly` is a plain typed registry (no bespoke route): the level is expressed by
    // `contains` edges, and `isContainerType` is what lets a component name one as its parent.
    const assembly = await call("POST", "/api/v1/assemblies", { name: uniq("asm") });
    expect(assembly.status, assembly.body).toBe(201);
    const component = await call("POST", "/api/v1/components", {
      name: uniq("asm-comp"),
      service: assembly.json().id as string
    });
    expect(component.status, component.body).toBe(201);

    const refused = await call("DELETE", `/api/v1/assemblies/${assembly.json().id as string}`);
    expect(refused.status, refused.body).toBe(409);
    expect(detailOf(refused)).toContain("contained by it");
  });

  it("refuses deleting a component that still has a live PLACEMENT — the gap that used to dangle", async () => {
    // BEFORE this ruling: the delete answered 200 and the placement stayed live, naming a tombstoned
    // component by JSON property — invisible to the edge cascade, which only tombstones edges. The
    // owner chose refusal over cascade (§9.6 Q3-A), so a placement is removed explicitly or not at
    // all.
    const { componentId } = await makeService("placement-comp");
    const target = await call("POST", "/api/v1/deployment-targets", { name: uniq("pl-target") });
    expect(target.status, target.body).toBe(201);
    const placement = await call("POST", "/api/v1/placements", {
      component: componentId,
      deploymentTarget: target.json().id as string
    });
    expect(placement.status, placement.body).toBe(201);

    const refused = await call("DELETE", `/api/v1/components/${componentId}`);
    expect(refused.status, refused.body).toBe(409);
    expect(detailOf(refused)).toContain("placement");
    expect(detailOf(refused)).toContain("/placements/");

    expect(
      (await call("DELETE", `/api/v1/placements/${placement.json().id as string}`)).status
    ).toBe(200);
    expect((await call("DELETE", `/api/v1/components/${componentId}`)).status).toBe(200);
  });

  it("refuses deleting a deployment-target that still has a live PLACEMENT — the pair's OTHER end", async () => {
    const { componentId } = await makeService("target-side");
    const target = await call("POST", "/api/v1/deployment-targets", { name: uniq("tgt-target") });
    expect(target.status, target.body).toBe(201);
    const targetId = target.json().id as string;
    const placement = await call("POST", "/api/v1/placements", {
      component: componentId,
      deploymentTarget: targetId
    });
    expect(placement.status, placement.body).toBe(201);

    const refused = await call("DELETE", `/api/v1/deployment-targets/${targetId}`);
    expect(refused.status, refused.body).toBe(409);
    expect(detailOf(refused)).toContain("placement");

    expect(
      (await call("DELETE", `/api/v1/placements/${placement.json().id as string}`)).status
    ).toBe(200);
    expect((await call("DELETE", `/api/v1/deployment-targets/${targetId}`)).status).toBe(200);
  });

  it("refuses deleting a component that still has a SOURCE MAPPING — route 5 (docs/graph.md §125a)", async () => {
    // The same property as the placement arm above, on a table the cascade cannot see either:
    // `source_mappings.component_object_id` is a plain column with no FK and no `deleted_at`. Before
    // this arm the delete answered 200, and the mapping stayed enabled and pointing at a tombstone —
    // 38 such rows on the live homelab, 2026-09-17.
    const { componentId } = await makeService("mapping-comp");
    const sourceKind = uniq("push");
    const repo = `acme/${uniq("repo")}`;
    const created = await call("POST", `/api/v1/change-sources/${sourceKind}/mappings`, {
      sourceKind,
      component: componentId,
      repoPattern: repo,
      pathPattern: "chart/**",
      type: "configuration"
    });
    expect(created.status, created.body).toBe(201);

    const refused = await call("DELETE", `/api/v1/components/${componentId}`);
    expect(refused.status, refused.body).toBe(409);
    expect(detailOf(refused)).toContain("source mapping");
    // The remedy IS the refusal, and it names the tuple the delete door addresses rows by.
    expect(detailOf(refused)).toContain("/change-sources/");
    expect(detailOf(refused)).toContain(sourceKind);
    expect(detailOf(refused)).toContain(repo);
    expect(detailOf(refused)).toContain("chart/**");

    // Nothing half-applied: the component is still live and still reachable.
    expect((await call("GET", `/api/v1/components/${componentId}`)).status).toBe(200);

    // …and the delete lands once the mapping is gone.
    const removed = await call("DELETE", `/api/v1/change-sources/${sourceKind}/mappings`, {
      component: componentId,
      repoPattern: repo,
      pathPattern: "chart/**",
      type: "configuration"
    });
    expect(removed.status, removed.body).toBe(200);
    expect((await call("DELETE", `/api/v1/components/${componentId}`)).status).toBe(200);
  });

  it("refuses deleting a PLACEMENT that still has an EXECUTOR BINDING — route 6 (docs/graph.md §125b)", async () => {
    // MEASURED on the live homelab 2026-09-19: 19 `executor_bindings` rows name placements that
    // `placement.delete` tombstoned on 2026-09-11. The binding table is the third table with the
    // property routes 4 and 5 cover — the owner is named in a plain column, there is no FK to
    // `objects` and no `deleted_at` of its own, so the edge cascade cannot see it.
    //
    // Deliberately driven at a PLACEMENT rather than a component: the placement is the object the
    // estate actually stranded, the ONE delete door with no binding check of its own (the IaC prune
    // at `coordination-as-code/plans-repo.ts` has had one all along — the N-doors shape this guard's
    // choke point exists to end), and the target shape `resolveBindingForTarget`'s direct rung reads
    // without any liveness filter.
    const { componentId } = await makeService("binding-comp");
    const target = await call("POST", "/api/v1/deployment-targets", { name: uniq("eb-target") });
    expect(target.status, target.body).toBe(201);
    const placement = await call("POST", "/api/v1/placements", {
      component: componentId,
      deploymentTarget: target.json().id as string
    });
    expect(placement.status, placement.body).toBe(201);
    const placementId = placement.json().id as string;

    const bound = await call("PUT", `/api/v1/executors/${placementId}/binding`, {
      pluginModule: "fake-executor",
      pluginInstanceId: uniq("inst"),
      type: "configuration"
    });
    expect(bound.status, bound.body).toBe(200);

    const refused = await call("DELETE", `/api/v1/placements/${placementId}`);
    expect(refused.status, refused.body).toBe(409);
    expect(detailOf(refused)).toContain("executor binding");
    // The remedy IS the refusal, and it names BOTH halves of the key the door takes — a message
    // naming only the type would send the operator to a `?lane=build` default that cannot reach a
    // `test`-lane row.
    expect(detailOf(refused)).toContain("/executors/");
    expect(detailOf(refused)).toContain("type=configuration");
    expect(detailOf(refused)).toContain("lane=build");

    // Nothing half-applied.
    expect((await call("GET", `/api/v1/placements/${placementId}`)).status).toBe(200);

    // …and the delete lands once the binding is gone, through the door the refusal named.
    const unbound = await call(
      "DELETE",
      `/api/v1/executors/${placementId}/binding?type=configuration&lane=build`
    );
    expect(unbound.status, unbound.body).toBe(200);
    expect((await call("DELETE", `/api/v1/placements/${placementId}`)).status).toBe(200);
  });

  it("a POLICY-MANAGED binding does NOT refuse — refusing one would livelock, so the reaper owns it", async () => {
    // The carve-out, and the reason it is not laziness: `binding-policy/reconcile-bindings.ts` runs
    // every reconcile tick, derives the wanted set from LIVE placements, and writes back whatever is
    // missing. Refuse on a managed row and the operator unbinds, the next tick re-creates it (the
    // target is still live, so it is still wanted), and the delete refuses again — forever. The same
    // tick's `pruneUnwanted` deletes it once the target IS a tombstone, through
    // `deleteExecutorBinding`, so the cleanup is audited exactly like a manual one.
    //
    // Driven beneath the API because no route sets `managed_by_policy_id` — the reconciler is its
    // only writer, and a fixture that could not produce the column would prove nothing.
    const { componentId } = await makeService("managed-binding");
    const target = await call("POST", "/api/v1/deployment-targets", { name: uniq("mb-target") });
    const placement = await call("POST", "/api/v1/placements", {
      component: componentId,
      deploymentTarget: target.json().id as string
    });
    expect(placement.status, placement.body).toBe(201);
    const placementId = placement.json().id as string;

    const bound = await call("PUT", `/api/v1/executors/${placementId}/binding`, {
      pluginModule: "fake-executor",
      pluginInstanceId: uniq("inst"),
      type: "configuration"
    });
    expect(bound.status, bound.body).toBe(200);

    // A policy object id is a plain uuid column with no FK, so the org root serves as the owner.
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const updated = await tx.execute(sql`
        UPDATE executor_bindings SET managed_by_policy_id = ${org.orgId}::uuid
        WHERE org_id = ${org.orgId}::uuid AND target_object_id = ${placementId}::uuid
        RETURNING id
      `);
      expect(
        (updated as unknown as { rows?: unknown[] }).rows,
        "fixture: the row must actually have been marked policy-managed"
      ).toHaveLength(1);
    });

    const deleted = await call("DELETE", `/api/v1/placements/${placementId}`);
    expect(deleted.status, deleted.body).toBe(200);
  });

  it("an EMPTY container still deletes — the guard names blockers, it is not a ban", async () => {
    const empty = await call("POST", "/api/v1/services", { name: uniq("empty-svc") });
    expect(empty.status, empty.body).toBe(201);
    const deleted = await call("DELETE", `/api/v1/services/${empty.json().id as string}`);
    expect(deleted.status, deleted.body).toBe(200);
  });

  // THE CARVE-OUTS (m8) — what the suite protects now that the asymmetry is gone

  it("a federation IMPORT delete with children still lands — refusing it would wedge a peer's bundle", async () => {
    // The authoritative domain already deleted this object; a receiver that refuses the journal
    // entry diverges permanently from the authority that owns the row. Driven at the repo because
    // no HTTP door carries a `federationImport` context — the importer is the only caller.
    const { id } = await makeService("fed-import");
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const self = await ensureFederationSelf(tx, org.orgId);
      await deleteObject(tx, {
        orgId: org.orgId,
        typeId: "service",
        actorObjectId: org.orgId,
        requestId: "container-delete-guard-import",
        idOrUrn: id,
        federationImport: { originDomainId: self.domainId, revision: 9_999 }
      });
    });
    const gone = await call("GET", `/api/v1/services/${id}`);
    expect(gone.status, gone.body).toBe(404);
  });

  it("removing a foreign SHADOW row with children still lands — local cleanup this domain never authored", async () => {
    const { id } = await makeService("shadow");
    // Make the row a FOREIGN shadow: an origin domain that is not this deployment's, provenance
    // `manual` — the exact pair `deleteObject`'s `unverifiedShadowOverride` branch requires.
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx.execute(sql`
        UPDATE objects
        SET origin_domain_id = ${uuidv7()}::uuid, provenance = 'manual'
        WHERE id = ${id}::uuid AND org_id = ${org.orgId}
      `);
      await deleteObject(tx, {
        orgId: org.orgId,
        typeId: "service",
        actorObjectId: org.orgId,
        requestId: "container-delete-guard-shadow",
        idOrUrn: id,
        unverifiedShadowOverride: true
      });
    });
    const gone = await call("GET", `/api/v1/services/${id}`);
    expect(gone.status, gone.body).toBe(404);
  });
});
