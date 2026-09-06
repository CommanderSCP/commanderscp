import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";
import { containmentChain } from "../graph/containment.js";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * THE TWO WAYS A CONTAINMENT MOVE STILL BROKE THE ORG-ROOT CHAIN AFTER `containment-parent-authz.ts`
 * BECAME THE CHOKE POINT.
 *
 * That module closed two defects — a move authorized only at the object, and a wire `null` written
 * through as a detach. Both are instances of ONE property: *a write that leaves a row whose
 * authority chain does not terminate at the org root, or that hands custody of a row to someone who
 * did not have it*. The choke point closed the two values that had been observed. Two more values
 * reach the same property through the same door, and this file pins both:
 *
 *  - **C1 — a CYCLE is a detach with no `null` in it.** The refusal was `destination === current.id`
 *    only: a depth-1 self-parent. Move X under its own child C and neither hop trips it, yet
 *    `X -> C -> X` has no org-root ancestor at all. `authz/resolve.ts`'s scope expansion walks
 *    UPWARD and terminates inside the loop, so no binding above the cycle — the org root Owner's
 *    included — reaches either row again. They cannot be read, edited, moved back or deleted, by
 *    anyone, ever. That is byte-for-byte the outcome `domain_id IS NULL` produced.
 *
 *  - **C2 — a move was authorized at the DESTINATION and never at the SOURCE.** Authority expands
 *    strictly upward, so holding it AT an object implies nothing about the container the object
 *    currently sits in. An actor bound narrowly at X could therefore yank X out of a container they
 *    hold nothing at — the mirror image of the defect the module exists to close, and the exact
 *    shape `graph/components-repo.ts`'s `setComponentService` already refuses ("the OLD service too
 *    on a move (it loses a child)").
 *
 * Both are pinned on the HTTP door AND on the IaC apply door, because apply is a second, independent
 * copy of the same decision (`iac/plans-repo.ts` calls itself "the apply-path twin of
 * `graph/containment-parent-authz.ts`") and a twin is where the next instance hides.
 *
 * ------------------------------------------------------------------------------------------------
 * RE-RUNNING THIS, AND THE THREE SUITES A CHANGE HERE MUST NOT BREAK
 * ------------------------------------------------------------------------------------------------
 * With FULL PATHS, because the commit that added this file (`16e836c`) named those suites by bare
 * filename — and a bare filename is a NO-OP here. vitest given a path it cannot resolve runs nothing
 * and EXITS 0; `apps/server`'s `test:integration` script passes `--passWithNoTests`, so that empty
 * run reports success. "Green" then means "never executed". The DEFAULT vitest config additionally
 * EXCLUDES `*.integration.test.ts`, so `--config` is not optional either. From `apps/server`
 * (the `DOCKER_HOST` line is for a local colima socket; CI provides its own Docker):
 *
 *   DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_RYUK_DISABLED=true \
 *     npx vitest run --config vitest.integration.config.ts \
 *       src/routes/containment-move-cycle-and-source-authz.integration.test.ts \
 *       src/routes/containment-move-authz.integration.test.ts \
 *       src/governance/governance-managed-write-doors.integration.test.ts \
 *       src/dependencies/subscription-authoring-guard.integration.test.ts
 *
 * Then READ THE FILE LIST vitest echoes back and confirm all four are in it before believing the
 * result — that check is the only thing separating a pass from a silent no-op.
 */
describe("a containment move may not build a cycle, and is authorized at both ends", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  async function post(
    token: string,
    url: string,
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: string; json: () => Record<string, unknown> }> {
    const res = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload
    });
    return { status: res.statusCode, body: res.body, json: () => res.json() };
  }

  async function patchService(
    token: string,
    id: string,
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: string }> {
    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/services/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload
    });
    return { status: res.statusCode, body: res.body };
  }

  async function getService(
    token: string,
    id: string
  ): Promise<{ status: number; body: string; json: () => Record<string, unknown> }> {
    const res = await server.app.inject({
      method: "GET",
      url: `/api/v1/services/${id}`,
      headers: { authorization: `Bearer ${token}` }
    });
    return { status: res.statusCode, body: res.body, json: () => res.json() };
  }

  async function makeService(org: TestOrg, name: string, domainId?: string): Promise<string> {
    const created = await post(org.adminToken, "/api/v1/services", {
      name,
      ...(domainId === undefined ? {} : { domainId })
    });
    expect(created.status, created.body).toBe(201);
    return created.json().id as string;
  }

  it("moving an object under its own CHILD is refused — a two-hop cycle detaches both rows", async () => {
    const org = await createTestOrg(server, "cycle-one-hop");
    const parent = await makeService(org, "cycle-parent");
    const child = await makeService(org, "cycle-child", parent);
    // THE FIXTURE ITSELF, asserted: if `domainId` were ignored at create, `child` would hang off the
    // org root, there would be no loop to close, and every assertion below would pass for the wrong
    // reason.
    expect(
      (await getService(org.adminToken, child)).json() as { domainId: string | null }
    ).toMatchObject({ domainId: parent });

    const res = await patchService(org.adminToken, parent, { domainId: child });
    expect(res.status, res.body).toBe(400);
    // Names BOTH rows of the loop: an operator has to be able to see which pair is involved.
    expect(res.body).toContain(parent);
    expect(res.body).toContain(child);

    // THE CONSEQUENCE, asserted rather than described. When the move lands, `X -> C -> X` has no
    // org-root ancestor, so the ORG-ROOT ADMIN's own binding stops reaching either row: this next
    // read and this next edit are what answered 403, permanently, before the refusal existed.
    expect((await getService(org.adminToken, parent)).status).toBe(200);
    expect((await getService(org.adminToken, child)).status).toBe(200);
    expect((await patchService(org.adminToken, parent, { name: "still-governable" })).status).toBe(
      200
    );

    const after = await getService(org.adminToken, parent);
    expect((after.json() as { domainId: string | null }).domainId).toBe(org.orgId);
  });

  it("the cycle refusal is not depth-1 — moving an object under a GRANDCHILD is refused too", async () => {
    const org = await createTestOrg(server, "cycle-two-hop");
    const top = await makeService(org, "cycle-top");
    const middle = await makeService(org, "cycle-middle", top);
    const bottom = await makeService(org, "cycle-bottom", middle);

    const res = await patchService(org.adminToken, top, { domainId: bottom });
    expect(res.status, res.body).toBe(400);
    expect(res.body).toContain(top);

    expect((await getService(org.adminToken, top)).status).toBe(200);
    expect((await getService(org.adminToken, middle)).status).toBe(200);
    expect((await getService(org.adminToken, bottom)).status).toBe(200);
  });

  it("the `contains` containment route counts too — a service may not move under its own component's placement chain", async () => {
    const org = await createTestOrg(server, "cycle-contains");
    const serviceId = await makeService(org, "cycle-contains-svc");
    // `contains` is the SECOND containment route (`graph/containment.ts` route 2, migration 0021):
    // the component's chain reaches the service through the edge, not through `domain_id`. A cycle
    // check that walked only `domain_id` would miss this and write `service -> component -> service`.
    const component = await post(org.adminToken, "/api/v1/components", {
      name: "cycle-contains-cmp",
      service: serviceId
    });
    expect(component.status, component.body).toBe(201);

    const res = await patchService(org.adminToken, serviceId, {
      domainId: component.json().id as string
    });
    expect(res.status, res.body).toBe(400);
    expect(res.body).toContain(serviceId);

    expect((await getService(org.adminToken, serviceId)).status).toBe(200);
  });

  it("a container whose OWN chain is broken is refused — it has no org-root route to lend", async () => {
    const org = await createTestOrg(server, "unrooted-parent");
    const doomed = await post(org.adminToken, "/api/v1/domains", { name: "unrooted-doomed" });
    expect(doomed.status, doomed.body).toBe(201);
    const doomedId = doomed.json().id as string;
    // Live itself, but its ONLY route to the org root runs through the domain about to die.
    const stranded = await makeService(org, "unrooted-stranded", doomedId);
    const movable = await makeService(org, "unrooted-movable");

    // THE API WILL NOT STRAND `stranded` FOR US: `deleteObject`'s route-1 orphan guard (M20, the
    // ui-review branch) refuses to tombstone a domain that live children still name — 409, blockers
    // named — precisely so this shape cannot be produced through a door. Pinned here as the
    // negative control, because if that guard ever went quiet this fixture would silently start
    // testing a state the API can produce.
    const deleted = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/domains/${doomedId}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(deleted.statusCode, deleted.body).toBe(409);
    expect(deleted.body).toContain("still name it as their domain");

    // So the broken chain is PLANTED the way the refusal's own doc says such rows arise — "a legacy
    // row, or one planted before the doors were closed": the tombstone is written straight onto the
    // row, below every door. That is exactly the population refusal 3 exists for.
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(objects)
        .set({ deletedAt: new Date() })
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, doomedId)))
    );

    // `stranded` passes the soft-delete filter — IT is live — so the refusal added for a tombstoned
    // parent (`resolveContainmentParent`) does not fire. The chain walk is what catches it: every
    // containment route refuses to pass through a tombstone, exactly as `scopeExpandCte` does, so
    // `stranded` has no org root on its chain and cannot lend one to anything placed inside it.
    const res = await patchService(org.adminToken, movable, { domainId: stranded });
    expect(res.status, res.body).toBe(400);
    expect(res.body).toContain("org root");

    const after = await getService(org.adminToken, movable);
    expect((after.json() as { domainId: string | null }).domainId).toBe(org.orgId);
  });

  it("a walk PAST THE BOUND fails closed — the destination reaches the org root, and the cycle sits beyond the bound", async () => {
    const org = await createTestOrg(server, "deep-parent");

    // The shape that makes the depth bound load-bearing rather than decorative, and the only shape
    // that isolates it. The destination is a DAG with two routes up:
    //
    //   destination --domain_id--> org root                      (1 hop: the root IS on the chain)
    //   destination --contains---> deepService -...-> movable     (10 hops; the root behind it at 11)
    //
    // So `the org root is missing` does not fire, and yet the move WOULD close a real cycle whose
    // proof lies at the edge of the bound. Under ADR-0037 the walk does not truncate silently: it
    // probes one level PAST the bound and REFUSES when anything is there — and the containment-
    // parent door turns that refusal into its own 400 (`containmentParentChainForDoor`'s conversion
    // branch: "a row under it would sit past the bound on that route"). Delete that conversion —
    // or let the door read a shortened chain — and this case is the one that goes red (measured
    // 2026-08-18: `throw error` in place of the conversion, in CODE, turned exactly this case red
    // while `containment-depth-doors` stayed green — the two files pin two different properties).
    //
    // WHY THIS BRANCH IS STILL LOAD-BEARING when no door can build the shape any more: the depth
    // invariant is a WRITE door, so rows planted before 2026-08-18, or arrived under the
    // federation-import carve-out, are untouched by it. Whether an estate actually holds one is a
    // measurable fact, not a guess — `scripts/containment-depth-census.sql` asks each database.
    // Review pair, 2026-08-18: zero rows past the bound (deepest live route 5 on the commander, 6
    // on the outpost); production not measured from a laptop. So today this is defence-in-depth
    // against a state no current door can create, and the comment says so rather than implying a
    // live population.
    //
    // Nine levels under `movable`: `deep-9`'s own chain is exactly ten hops — the ceiling, complete
    // and readable — so a row under it would sit at hop ELEVEN. Since the owner ruling of 2026-08-18
    // (ADR-0037 Consequences; `graph/containment-depth-doors.integration.test.ts`) NO door will
    // write that row: `POST /components {service: deep-9}` — the way this fixture used to be built —
    // now answers 400 from the `contains` door. The hop-eleven shape is therefore PLANTED below the
    // doors, exactly as the refusal-3 case above plants its tombstone: the component is created
    // legitimately under a root-level service, and its `contains` edge is then re-pointed at
    // `deep-9` by a direct UPDATE. That is the population this conversion branch exists for — a
    // legacy row, or one that arrived under the federation-import carve-out — and it is labelled as
    // such rather than dressed up as something a door can produce.
    const movable = await makeService(org, "deep-movable");
    let deepService = movable;
    for (let i = 1; i <= 9; i += 1) {
      deepService = await makeService(org, `deep-${i}`, deepService);
    }
    // THE DOOR IS CLOSED — pinned here as the negative control, so that if it ever went quiet this
    // fixture would silently start testing a state the API can produce.
    const throughTheDoor = await post(org.adminToken, "/api/v1/components", {
      name: "deep-destination-refused",
      service: deepService,
      domainId: null
    });
    expect(throughTheDoor.status, throughTheDoor.body).toBe(400);
    expect(throughTheDoor.body).toContain("would exceed the supported containment depth");

    const anchor = await makeService(org, "deep-anchor");
    const destination = await post(org.adminToken, "/api/v1/components", {
      name: "deep-destination",
      service: anchor,
      // Explicit: the org root, so the SHORT route exists and the root-reachability refusal cannot
      // be what answers.
      domainId: null
    });
    expect(destination.status, destination.body).toBe(201);
    const destinationId = destination.json().id as string;
    // The legacy/imported shape: re-point the component's `contains` edge at the ten-hop service,
    // below every door. `content_hash` is left stale on purpose — no walk reads it.
    const planted = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(relationships)
        .set({ fromId: deepService })
        .where(
          and(
            eq(relationships.orgId, org.orgId),
            eq(relationships.typeId, "contains"),
            eq(relationships.toId, destinationId),
            isNull(relationships.deletedAt)
          )
        )
        .returning({ id: relationships.id })
    );
    expect(planted, "the fixture's contains edge must exist to be re-pointed").toHaveLength(1);
    // The fixture, asserted: the walk itself now refuses `destination` — this is the 409 the door
    // below converts. Without this the case could pass against a shape the walk still accepts.
    await expect(
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        containmentChain(tx, org.orgId, destinationId)
      )
    ).rejects.toMatchObject({ status: 409 });

    const res = await patchService(org.adminToken, movable, { domainId: destinationId });
    expect(res.status, res.body).toBe(400);
    // The door's OWN sentence, carrying the walk's: the depth bound and the ADR are named, so an
    // operator meets one story from either side (ADR-0037 pins the phrase; M22 pins the status).
    // This is the ONE door refusal that carries the WALK's phrase — every other depth refusal at a
    // door says "would exceed" (see `containment.ts` CONTAINMENT_DEPTH_DOOR_PHRASE).
    expect(res.body).toContain("exceeds the supported containment depth");
    expect(res.body).toContain("a row under it would sit past the bound on that route");
    // ...and NOT the cycle rationale: this branch also serves the CREATE doors, where the cycle
    // question is deliberately not asked, so its sentence names its own condition only.
    expect(res.body).not.toContain("free of a cycle");

    const after = await getService(org.adminToken, movable);
    expect((after.json() as { domainId: string | null }).domainId).toBe(org.orgId);
    // The consequence the refusal bought: both ends of the would-be loop are still reachable — the
    // deep end at exactly the ceiling, by the org admin (a ceiling, not a ban).
    expect((await getService(org.adminToken, movable)).status).toBe(200);
    expect((await getService(org.adminToken, deepService)).status).toBe(200);

    // The bound is a CEILING, not a ban on nesting: a subtree-less service takes a move under a
    // shallow container. Without this the case above would also pass if the check refused
    // everything. (`movable` itself cannot take that move any more — it carries a nine-deep
    // subtree, and the door counts it: `graph/containment-depth-doors.integration.test.ts`.)
    const shallow = await makeService(org, "deep-shallow-0");
    const shallower = await makeService(org, "deep-shallow-1", shallow);
    const control = await makeService(org, "deep-control");
    const ok = await patchService(org.adminToken, control, { domainId: shallower });
    expect(ok.status, ok.body).toBe(200);
  });

  it("a move to an unrelated container is untouched by the cycle check — it is a check, not a ban", async () => {
    const org = await createTestOrg(server, "cycle-control");
    const movable = await makeService(org, "cycle-control-movable");
    const elsewhere = await post(org.adminToken, "/api/v1/domains", { name: "cycle-control-dst" });
    expect(elsewhere.status, elsewhere.body).toBe(201);

    const res = await patchService(org.adminToken, movable, {
      domainId: elsewhere.json().id as string
    });
    expect(res.status, res.body).toBe(200);
    const after = await getService(org.adminToken, movable);
    expect((after.json() as { domainId: string | null }).domainId).toBe(
      elsewhere.json().id as string
    );
  });

  it("POST /plans/{id}/apply — the apply-path twin — refuses the same cycle", async () => {
    const org = await createTestOrg(server, "cycle-iac");
    const parent = await makeService(org, "iac-cycle-parent");
    const child = await makeService(org, "iac-cycle-child", parent);
    const parentUrn = (await getService(org.adminToken, parent)).json().urn as string;

    const plan = await post(org.adminToken, "/api/v1/plans", {
      manifest: {
        stackName: `iac-cycle-${parent.slice(0, 8)}`,
        objects: [{ urn: parentUrn, typeId: "service", name: "iac-cycle-parent", domainId: child }],
        relationships: []
      }
    });
    expect(plan.status, plan.body).toBe(201);

    const applied = await server.app.inject({
      method: "POST",
      url: `/api/v1/plans/${plan.json().id as string}/apply`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(applied.statusCode, applied.body).toBe(400);

    expect((await getService(org.adminToken, parent)).status).toBe(200);
    const after = await getService(org.adminToken, parent);
    expect((after.json() as { domainId: string | null }).domainId).toBe(org.orgId);
  });

  // C2 — the SOURCE container is the other end of a move

  interface SourceFixture {
    org: TestOrg;
    sourceDomainId: string;
    destinationDomainId: string;
    movableId: string;
    movableUrn: string;
    /** Bound at the OBJECT and at the DESTINATION — deliberately not at the source. */
    moverToken: string;
  }

  async function makeSourceFixture(label: string): Promise<SourceFixture> {
    const org = await createTestOrg(server, label);
    const source = await post(org.adminToken, "/api/v1/domains", { name: `${label}-source` });
    const destination = await post(org.adminToken, "/api/v1/domains", { name: `${label}-dest` });
    expect(source.status, source.body).toBe(201);
    expect(destination.status, destination.body).toBe(201);
    const sourceDomainId = source.json().id as string;
    const destinationDomainId = destination.json().id as string;

    const movable = await post(org.adminToken, "/api/v1/services", {
      name: `${label}-movable`,
      domainId: sourceDomainId
    });
    expect(movable.status, movable.body).toBe(201);
    const movableId = movable.json().id as string;

    // Genuine, legitimate authority over the object itself AND over where it is going — and
    // nothing whatsoever over the container it is being taken OUT of.
    const mover = await createTestUser(server, org, [
      { role: "Administrator", scope: movableId },
      { role: "Administrator", scope: destinationDomainId }
    ]);

    return {
      org,
      sourceDomainId,
      destinationDomainId,
      movableId,
      movableUrn: movable.json().urn as string,
      moverToken: mover.token
    };
  }

  it("PATCH /services/{id} refuses a move OUT of a container the actor holds nothing at", async () => {
    const f = await makeSourceFixture("source-patch");

    const res = await patchService(f.moverToken, f.movableId, { domainId: f.destinationDomainId });
    expect(res.status, res.body).toBe(403);
    // Names the SOURCE: the actor holds the destination, so a message naming the destination would
    // send them to fix a permission they already have.
    expect(res.body).toContain(f.sourceDomainId);

    const after = await getService(f.org.adminToken, f.movableId);
    expect((after.json() as { domainId: string | null }).domainId).toBe(f.sourceDomainId);
  });

  it("PUT /services/{urn} — the upsert door's update branch — refuses the same move", async () => {
    const f = await makeSourceFixture("source-put");

    const res = await server.app.inject({
      method: "PUT",
      url: `/api/v1/services/${encodeURIComponent(f.movableUrn)}`,
      headers: { authorization: `Bearer ${f.moverToken}` },
      payload: { name: "renamed-by-mover", domainId: f.destinationDomainId }
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain(f.sourceDomainId);

    const after = await getService(f.org.adminToken, f.movableId);
    expect((after.json() as { domainId: string | null }).domainId).toBe(f.sourceDomainId);
  });

  it("holding BOTH ends lets the move through — the source check is a check, not a ban", async () => {
    const org = await createTestOrg(server, "source-allowed");
    const source = await post(org.adminToken, "/api/v1/domains", { name: "allowed-source" });
    const destination = await post(org.adminToken, "/api/v1/domains", { name: "allowed-dest" });
    expect(source.status, source.body).toBe(201);
    expect(destination.status, destination.body).toBe(201);
    const sourceDomainId = source.json().id as string;
    const destinationDomainId = destination.json().id as string;
    const movableId = await makeService(org, "allowed-movable", sourceDomainId);

    const mover = await createTestUser(server, org, [
      { role: "Administrator", scope: movableId },
      { role: "Administrator", scope: sourceDomainId },
      { role: "Administrator", scope: destinationDomainId }
    ]);

    const res = await patchService(mover.token, movableId, { domainId: destinationDomainId });
    expect(res.status, res.body).toBe(200);
    const after = await getService(org.adminToken, movableId);
    expect((after.json() as { domainId: string | null }).domainId).toBe(destinationDomainId);
  });

  it("POST /plans/{id}/apply — the apply-path twin — refuses the move out of an unheld source", async () => {
    const f = await makeSourceFixture("source-iac");

    // Authored by someone who holds `object:read` at the org root; the only question is who APPLIES.
    const plan = await post(f.org.adminToken, "/api/v1/plans", {
      manifest: {
        stackName: `iac-source-${f.movableId.slice(0, 8)}`,
        objects: [
          {
            urn: f.movableUrn,
            typeId: "service",
            name: "source-iac-movable",
            domainId: f.destinationDomainId
          }
        ],
        relationships: []
      }
    });
    expect(plan.status, plan.body).toBe(201);

    const applied = await server.app.inject({
      method: "POST",
      url: `/api/v1/plans/${plan.json().id as string}/apply`,
      headers: { authorization: `Bearer ${f.moverToken}` }
    });
    expect(applied.statusCode, applied.body).toBe(403);
    expect(applied.body).toContain(f.sourceDomainId);

    const after = await getService(f.org.adminToken, f.movableId);
    expect((after.json() as { domainId: string | null }).domainId).toBe(f.sourceDomainId);
  });
});
