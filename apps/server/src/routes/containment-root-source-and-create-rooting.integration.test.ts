import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, and } from "drizzle-orm";
import { objects } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/** The two edges that guard was installed on only half of. See docs/routes.md §96. */
describe("the containment-parent invariant at the org root, and on the create path", () => {
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

  async function applyPlan(
    token: string,
    planId: string
  ): Promise<{ status: number; body: string }> {
    const res = await server.app.inject({
      method: "POST",
      url: `/api/v1/plans/${planId}/apply`,
      headers: { authorization: `Bearer ${token}` }
    });
    return { status: res.statusCode, body: res.body };
  }

  // R1 — the org root is not a source container that can lose custody

  interface RootSourceFixture {
    org: TestOrg;
    destinationDomainId: string;
    movableId: string;
    movableUrn: string;
    /** Bound at the OBJECT and at the DESTINATION. Deliberately holds NOTHING at the org root. */
    moverToken: string;
  }

  async function makeRootSourceFixture(label: string): Promise<RootSourceFixture> {
    const org = await createTestOrg(server, label);
    const destination = await post(org.adminToken, "/api/v1/domains", { name: `${label}-dest` });
    expect(destination.status, destination.body).toBe(201);
    const destinationDomainId = destination.json().id as string;

    // No `domainId` — the ordinary create, which lands the row at the org root.
    const movable = await post(org.adminToken, "/api/v1/services", { name: `${label}-movable` });
    expect(movable.status, movable.body).toBe(201);
    const movableId = movable.json().id as string;

    // THE FIXTURE ITSELF, ASSERTED. If a default create ever stopped landing at the org root, this
    // whole section would be exercising some other source container and would pass for the wrong
    // reason. It also states the fact R1 turns on: a root-parented row's source is the org root
    // OBJECT (`domainId === orgId`), not `null` — `null` is reserved for the org root itself.
    expect((await getService(org.adminToken, movableId)).json()).toMatchObject({
      domainId: org.orgId
    });

    const mover = await createTestUser(server, org, [
      { role: "Administrator", scope: movableId },
      { role: "Administrator", scope: destinationDomainId }
    ]);

    return {
      org,
      destinationDomainId,
      movableId,
      movableUrn: movable.json().urn as string,
      moverToken: mover.token
    };
  }

  it("PATCH /services/{id} lets a ROOT-PARENTED object move into a container the actor owns outright", async () => {
    const f = await makeRootSourceFixture("root-source-patch");

    const res = await patchService(f.moverToken, f.movableId, { domainId: f.destinationDomainId });
    // Before the fix this answered 403 naming the ORG ROOT as an unheld source — demanding org-root
    // authority for a reorganisation entirely inside a subtree the actor owns.
    expect(res.status, res.body).toBe(200);

    const after = await getService(f.org.adminToken, f.movableId);
    expect((after.json() as { domainId: string | null }).domainId).toBe(f.destinationDomainId);

    // THE PROPERTY THAT MAKES THE EXEMPTION SOUND, asserted rather than argued: the org root's own
    // holders did NOT lose custody, because the destination is inside the org root's subtree.
    expect((await getService(f.org.adminToken, f.movableId)).status).toBe(200);
    expect(
      (await patchService(f.org.adminToken, f.movableId, { name: "still-owned" })).status
    ).toBe(200);
  });

  it("PUT /services/{urn} — the upsert door's update branch — allows the same root-parented move", async () => {
    const f = await makeRootSourceFixture("root-source-put");

    const res = await server.app.inject({
      method: "PUT",
      url: `/api/v1/services/${encodeURIComponent(f.movableUrn)}`,
      headers: { authorization: `Bearer ${f.moverToken}` },
      payload: { name: "root-source-put-movable", domainId: f.destinationDomainId }
    });
    expect(res.statusCode, res.body).toBe(200);

    const after = await getService(f.org.adminToken, f.movableId);
    expect((after.json() as { domainId: string | null }).domainId).toBe(f.destinationDomainId);
  });

  it("POST /plans/{id}/apply — the apply-path twin, which carried the same over-broad refusal — allows it too", async () => {
    const f = await makeRootSourceFixture("root-source-iac");

    const plan = await post(f.org.adminToken, "/api/v1/plans", {
      manifest: {
        stackName: `iac-root-source-${f.movableId.slice(0, 8)}`,
        objects: [
          {
            urn: f.movableUrn,
            typeId: "service",
            name: "root-source-iac-movable",
            domainId: f.destinationDomainId
          }
        ],
        relationships: []
      }
    });
    expect(plan.status, plan.body).toBe(201);

    const applied = await applyPlan(f.moverToken, plan.json().id as string);
    expect(applied.status, applied.body).toBe(200);

    const after = await getService(f.org.adminToken, f.movableId);
    expect((after.json() as { domainId: string | null }).domainId).toBe(f.destinationDomainId);
  });

  it("the exemption is the ORG ROOT and nothing else — a move out of an unheld ordinary container is still refused", async () => {
    // The control for the three cases above. Widen the exemption from "the org root" to "any source"
    // and this is the case that goes red — together they say the guard is a check, not a ban, and
    // not a no-op either.
    const org = await createTestOrg(server, "root-source-control");
    const source = await post(org.adminToken, "/api/v1/domains", { name: "control-source" });
    const destination = await post(org.adminToken, "/api/v1/domains", { name: "control-dest" });
    expect(source.status, source.body).toBe(201);
    expect(destination.status, destination.body).toBe(201);
    const sourceDomainId = source.json().id as string;
    const destinationDomainId = destination.json().id as string;

    const movable = await post(org.adminToken, "/api/v1/services", {
      name: "control-movable",
      domainId: sourceDomainId
    });
    expect(movable.status, movable.body).toBe(201);
    const movableId = movable.json().id as string;

    const mover = await createTestUser(server, org, [
      { role: "Administrator", scope: movableId },
      { role: "Administrator", scope: destinationDomainId }
    ]);

    const res = await patchService(mover.token, movableId, { domainId: destinationDomainId });
    expect(res.status, res.body).toBe(403);
    expect(res.body).toContain(sourceDomainId);

    const after = await getService(org.adminToken, movableId);
    expect((after.json() as { domainId: string | null }).domainId).toBe(sourceDomainId);
  });

  // R2 — a CREATE under an unrooted parent is the same unreachable row, through a different verb

  interface UnrootedFixture {
    org: TestOrg;
    /** Live, but its only route to the org root ran through a domain that is now a tombstone. */
    strandedId: string;
    /** Administrator AT `stranded` — the only principal that can still reach it at all. */
    insiderToken: string;
  }

  async function makeUnrootedFixture(label: string): Promise<UnrootedFixture> {
    const org = await createTestOrg(server, label);
    const doomed = await post(org.adminToken, "/api/v1/domains", { name: `${label}-doomed` });
    expect(doomed.status, doomed.body).toBe(201);
    const doomedId = doomed.json().id as string;

    const stranded = await post(org.adminToken, "/api/v1/services", {
      name: `${label}-stranded`,
      domainId: doomedId
    });
    expect(stranded.status, stranded.body).toBe(201);
    const strandedId = stranded.json().id as string;

    const insider = await createTestUser(server, org, [
      { role: "Administrator", scope: strandedId }
    ]);

    // THE API WILL NOT STRAND `stranded` FOR US. See docs/routes.md §97.
    const deleted = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/domains/${doomedId}`,
      headers: { authorization: `Bearer ${org.adminToken}` }
    });
    expect(deleted.statusCode, deleted.body).toBe(409);
    expect(deleted.body).toContain("still name it as their domain");
    await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .update(objects)
        .set({ deletedAt: new Date() })
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, doomedId)))
    );

    // THE FIXTURE ITSELF, ASSERTED. See docs/routes.md §98.
    expect((await getService(org.adminToken, strandedId)).status).toBe(403);
    expect((await getService(insider.token, strandedId)).status).toBe(200);

    return { org, strandedId, insiderToken: insider.token };
  }

  async function objectRowByName(
    org: TestOrg,
    name: string
  ): Promise<{ id: string; domainId: string | null } | undefined> {
    return withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const row = await tx.query.objects.findFirst({
        where: and(eq(objects.orgId, org.orgId), eq(objects.name, name))
      });
      return row ? { id: row.id, domainId: row.domainId } : undefined;
    });
  }

  it("POST /services refuses a CREATE under a container whose own chain is broken", async () => {
    const f = await makeUnrootedFixture("create-unrooted-post");

    const res = await post(f.insiderToken, "/api/v1/services", {
      name: "create-unrooted-child",
      domainId: f.strandedId
    });
    // Before the fix this answered 201 and wrote a row NOBODY can recover: its chain is
    // `child -> stranded -> <tombstone>`, so the org Owner cannot read, edit, move or delete it, and
    // the insider who created it holds nothing at any destination to move it to.
    expect(res.status, res.body).toBe(400);
    expect(res.body).toContain("org root");
    expect(res.body).toContain(f.strandedId);

    // Asserted against the DATABASE, not against a read API — an unreachable row is precisely one
    // that a read API would hide, so "the GET 404s" would pass whether or not the row exists.
    expect(await objectRowByName(f.org, "create-unrooted-child")).toBeUndefined();
  });

  it("POST /plans/{id}/apply — the create branch, which never calls the door helper — is refused too", async () => {
    const f = await makeUnrootedFixture("create-unrooted-iac");

    // Authored by the org admin (plan compute needs org-wide read); the question is what happens when
    // the insider APPLIES it. `executePlanDiff` calls `createObject` directly, so a fix installed at
    // the door helper alone would ship inert on exactly this path.
    const plan = await post(f.org.adminToken, "/api/v1/plans", {
      manifest: {
        stackName: `iac-create-unrooted-${f.strandedId.slice(0, 8)}`,
        objects: [
          {
            urn: `urn:scp:${f.org.orgName}:service:iac-create-unrooted-child`,
            typeId: "service",
            name: "iac-create-unrooted-child",
            domainId: f.strandedId
          }
        ],
        relationships: []
      }
    });
    expect(plan.status, plan.body).toBe(201);

    const applied = await applyPlan(f.insiderToken, plan.json().id as string);
    expect(applied.status, applied.body).toBe(400);
    expect(applied.body).toContain("org root");

    expect(await objectRowByName(f.org, "iac-create-unrooted-child")).toBeUndefined();
  });

  it("a create under a HEALTHY container still succeeds — the create invariant is a check, not a ban", async () => {
    // Without this, a create-path assert that refused everything would leave both cases above green.
    const org = await createTestOrg(server, "create-rooted-control");
    const domain = await post(org.adminToken, "/api/v1/domains", { name: "rooted-control-domain" });
    expect(domain.status, domain.body).toBe(201);

    const created = await post(org.adminToken, "/api/v1/services", {
      name: "rooted-control-child",
      domainId: domain.json().id as string
    });
    expect(created.status, created.body).toBe(201);

    const row = await objectRowByName(org, "rooted-control-child");
    expect(row?.domainId).toBe(domain.json().id as string);

    // And the DEFAULT create — no `domainId` at all, the overwhelmingly common shape — is untouched.
    const defaulted = await post(org.adminToken, "/api/v1/services", {
      name: "rooted-control-default"
    });
    expect(defaulted.status, defaulted.body).toBe(201);
    expect((await objectRowByName(org, "rooted-control-default"))?.domainId).toBe(org.orgId);
  });
});
