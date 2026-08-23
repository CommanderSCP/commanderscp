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

/**
 * RULING 2 — DELETING A CONTAINER THAT STILL HAS CONTAINMENT CHILDREN IS REFUSED.
 * (docs/proposals/governance-reach-on-containment-move.md §9.3; owner ruling 2026-08-18, Q3-A.)
 *
 * `deleteObject` already COUNTED three dependent routes (`governance/governance-reach.ts`'s
 * `countContainmentDependents`) and used the count only to decide whether to record a reach
 * Decision — it never refused. The guard that DID refuse covered route 1 (`objects.domain_id`
 * children) alone; route 2's children were left live and detached, and placements — which name
 * their endpoints by JSON property rather than by an edge the cascade can see — were left live and
 * DANGLING. The owner retired that asymmetry: all three routes now block, and the dangling-placement
 * gap closes by refusal rather than by cascade.
 *
 * Route 1's own cases stay in `graph/domain-delete-orphan-guard.integration.test.ts` (whose CONTROL
 * for route 2 is inverted there, with the reason written where the old reason was). THIS file covers
 * the widening and — the part that actually needs protecting — THE CARVE-OUTS.
 *
 * ============================================================================================
 * MUTATION LOG — each mutation applied ALONE, run, reverted, restoration verified with `cmp`
 * ============================================================================================
 *  m7  drop the widening (guard only `domainChildren`, as before)
 *      → RED: "a service with components", "an assembly with components", "a component with a live
 *        placement", "a deployment-target with a live placement"
 *  m8  drop the `!removedForeignShadow` / `!input.federationImport` carve-out
 *      → RED: "a federation IMPORT delete with children still lands", "removing a foreign SHADOW
 *        row with children still lands"
 */
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
    method: "GET" | "POST" | "DELETE",
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

  // ---------------------------------------------------------------------------------------------
  // The widening (m7)
  // ---------------------------------------------------------------------------------------------

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

  it("an EMPTY container still deletes — the guard names blockers, it is not a ban", async () => {
    const empty = await call("POST", "/api/v1/services", { name: uniq("empty-svc") });
    expect(empty.status, empty.body).toBe(201);
    const deleted = await call("DELETE", `/api/v1/services/${empty.json().id as string}`);
    expect(deleted.status, deleted.body).toBe(200);
  });

  // ---------------------------------------------------------------------------------------------
  // THE CARVE-OUTS (m8) — what the suite protects now that the asymmetry is gone
  // ---------------------------------------------------------------------------------------------

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
