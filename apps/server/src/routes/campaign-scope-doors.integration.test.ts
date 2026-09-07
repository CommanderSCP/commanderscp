import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer,
  type TestUser
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";

/** The campaign get-by-id doors scope at the campaign. See docs/routes.md §8. */
describe("campaign get-by-id doors are scoped at the campaign (role-model §8.7 step 2.5a)", () => {
  let server: TestServer;
  let org: TestOrg;
  /** A campaign authored INSIDE `serviceA`, and one authored inside `serviceB`. */
  let insideCampaignId: string;
  let outsideCampaignId: string;
  /** `Viewer` at `serviceA` — `object:read` and nothing else, bound below the org root. */
  let serviceReader: TestUser;
  /** `Administrator` at `serviceA` — carries `object:write`, for the rollback door. */
  let serviceWriter: TestUser;
  let componentAId: string;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "campaign-scope-doors");

    const serviceA = await post("/api/v1/services", org.adminToken, { name: `svc-a-${suffix()}` });
    const serviceB = await post("/api/v1/services", org.adminToken, { name: `svc-b-${suffix()}` });
    const componentA = await post("/api/v1/components", org.adminToken, {
      name: `comp-a-${suffix()}`,
      service: serviceA.id
    });
    const componentB = await post("/api/v1/components", org.adminToken, {
      name: `comp-b-${suffix()}`,
      service: serviceB.id
    });

    // `domainId` is what puts the campaign INSIDE the service — see the doc comment above. Authored
    // by the org-root admin, so the per-target `object:write` check inside `proposeCampaign` is not
    // what these cases are measuring.
    insideCampaignId = (
      await post("/api/v1/campaigns", org.adminToken, {
        name: `camp-inside-${suffix()}`,
        domainId: serviceA.id,
        targets: [componentA.id]
      })
    ).id as string;
    outsideCampaignId = (
      await post("/api/v1/campaigns", org.adminToken, {
        name: `camp-outside-${suffix()}`,
        domainId: serviceB.id,
        targets: [componentB.id]
      })
    ).id as string;

    componentAId = componentA.id as string;

    serviceReader = await createTestUser(server, org, [
      { role: "Viewer", scope: serviceA.id as string }
    ]);
    serviceWriter = await createTestUser(server, org, [
      { role: "Administrator", scope: serviceA.id as string }
    ]);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  const suffix = () => randomUUID().slice(0, 8);

  async function post(
    url: string,
    token: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const res = await server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload
    });
    if (res.statusCode >= 300) throw new Error(`POST ${url} -> ${res.statusCode} ${res.body}`);
    return res.json() as Record<string, unknown>;
  }

  const get = (url: string, token: string) =>
    server.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });

  const del = (url: string, token: string) =>
    server.app.inject({ method: "DELETE", url, headers: { authorization: `Bearer ${token}` } });

  const rollback = (campaignId: string, token: string) =>
    server.app.inject({
      method: "POST",
      url: `/api/v1/campaigns/${campaignId}/rollback`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: "scope-door test" }
    });

  /** The three `object:read` get-by-id doors, by the URL suffix each adds to `/campaigns/{id}`. */
  const READ_DOORS = ["", "/explain", "/adoption"] as const;

  it("a service-bound reader reaches every get-by-id door for a campaign in their own subtree", async () => {
    for (const suffixPath of READ_DOORS) {
      const res = await get(
        `/api/v1/campaigns/${insideCampaignId}${suffixPath}`,
        serviceReader.token
      );
      expect(res.statusCode, `GET /api/v1/campaigns/{id}${suffixPath}: ${res.body}`).toBe(200);
    }
  });

  it("...and is refused on a campaign OUTSIDE it — the containment walk is what admits, not the login", async () => {
    // The half that stops the re-scope from being satisfiable by deleting the check. `Viewer` at
    // `serviceA` holds `object:read`, so a 403 here can only come from the SCOPE.
    for (const suffixPath of READ_DOORS) {
      const res = await get(
        `/api/v1/campaigns/${outsideCampaignId}${suffixPath}`,
        serviceReader.token
      );
      expect(res.statusCode, `GET /api/v1/campaigns/{id}${suffixPath}: ${res.body}`).toBe(403);
      expect(res.body).toMatch(/object:read/);
    }
  });

  it("the org-root Owner still reads every door, identically — the re-scope is a pure widening", async () => {
    // `scopeExpandCte` walks UPWARD, so an org-root binding satisfies a check at any object below
    // it WHOSE CHAIN IS INTACT. This is the case that would go red if the re-scope had picked a
    // scope the org root does not contain; the tombstoned-parent case at the bottom of this file is
    // the one that goes red when the chain is NOT intact, which is why both are needed.
    for (const suffixPath of READ_DOORS) {
      const res = await get(`/api/v1/campaigns/${insideCampaignId}${suffixPath}`, org.adminToken);
      expect(res.statusCode, `GET /api/v1/campaigns/{id}${suffixPath}: ${res.body}`).toBe(200);
    }
  });

  it("a service-bound writer can roll back a campaign in their own subtree, and not one outside it", async () => {
    const inside = await rollback(insideCampaignId, serviceWriter.token);
    expect(inside.statusCode, inside.body).toBe(200);
    // No plan has been compiled (no reconcile tick), so there are no member Changes to revert. The
    // assertion is the DOOR, not the effect: `triggerCampaignRollback` keeps its own per-member
    // `object:write` check at each target (`coordination/campaign-rollback.ts`), which is what stops
    // a campaign-scoped writer reverting into targets they have no standing on.
    expect(inside.json()).toMatchObject({ rolledBack: [], skipped: [] });

    const outside = await rollback(outsideCampaignId, serviceWriter.token);
    expect(outside.statusCode, outside.body).toBe(403);
    expect(outside.body).toMatch(/object:write/);
  });

  it("a nonexistent campaign id is 404, never 403, for an org-root Owner (§8.7's resolve-first trap)", async () => {
    // THE CASE THE INCREMENT WOULD HAVE SHIPPED WITHOUT. A uuid that names nothing expands to a
    // one-row scope set matching no binding, so authorizing at the path param BEFORE resolving it
    // turns this 404 into a 403 for every caller — including the org-root Owner, who by definition
    // is not being refused anything.
    const ghost = randomUUID();
    for (const suffixPath of READ_DOORS) {
      const res = await get(`/api/v1/campaigns/${ghost}${suffixPath}`, org.adminToken);
      expect(res.statusCode, `GET /api/v1/campaigns/{id}${suffixPath}: ${res.body}`).toBe(404);
    }
    const rolled = await rollback(ghost, org.adminToken);
    expect(rolled.statusCode, rolled.body).toBe(404);
  });

  it("a NON-campaign id is 404 on every door — the campaign bar is never RUN at another object", async () => {
    // Two doors cannot get their campaign from the repo in time. See docs/routes.md §9.
    const ghost = randomUUID();
    const unbound = await createTestUser(server, org, []);

    for (const suffixPath of READ_DOORS) {
      const res = await get(`/api/v1/campaigns/${componentAId}${suffixPath}`, org.adminToken);
      expect(res.statusCode, `GET {component}${suffixPath}: ${res.body}`).toBe(404);
    }
    const rolled = await rollback(componentAId, org.adminToken);
    expect(rolled.statusCode, rolled.body).toBe(404);

    // THE ORACLE, probed as the principal it would matter to: identical status AND identical
    // detail for "a live object that is not a campaign" and "no such object at all".
    const details = new Set<string>();
    for (const id of [componentAId, ghost]) {
      for (const suffixPath of READ_DOORS) {
        const res = await get(`/api/v1/campaigns/${id}${suffixPath}`, unbound.token);
        expect(res.statusCode, `unbound GET {${id}}${suffixPath}: ${res.body}`).toBe(404);
      }
      const roll = await rollback(id, unbound.token);
      expect(roll.statusCode, roll.body).toBe(404);
      details.add(((roll.json() as { detail?: string }).detail ?? "").replace(id, "<id>"));
    }
    expect([...details]).toEqual(["campaign '<id>' not found"]);
  });

  it("the org-root Owner still reaches a campaign whose containment parent is TOMBSTONED", async () => {
    // Why the re-scope is a disjunction here too. See docs/routes.md §10.
    const tombService = await post("/api/v1/services", org.adminToken, {
      name: `svc-tomb-${suffix()}`
    });
    const tombComponent = await post("/api/v1/components", org.adminToken, {
      name: `comp-tomb-${suffix()}`,
      service: tombService.id
    });
    const strandedId = (
      await post("/api/v1/campaigns", org.adminToken, {
        name: `camp-stranded-${suffix()}`,
        domainId: tombService.id,
        targets: [tombComponent.id]
      })
    ).id as string;

    // Sanity BEFORE the tombstone, so a failure below cannot be blamed on the fixture.
    expect((await get(`/api/v1/campaigns/${strandedId}`, org.adminToken)).statusCode).toBe(200);

    // GUARD 1 — there is no API that soft-deletes a campaign, so the campaign cannot be the seed
    // the way the source-mapping and change families' equivalent cases make their seed.
    const noCampaignDelete = await del(`/api/v1/objects/campaign/${strandedId}`, org.adminToken);
    expect(noCampaignDelete.statusCode, noCampaignDelete.body).toBe(403);
    expect(noCampaignDelete.body).toMatch(/coordination-managed/);

    // GUARD 2 — and the orphan guard refuses to tombstone the campaign's containment parent while
    // the campaign is live, which is the other jaw of the pincer. Together these two are why the
    // `deleted_at` below is written directly instead of through a DELETE.
    const noParentDelete = await del(
      `/api/v1/objects/service/${tombService.id as string}`,
      org.adminToken
    );
    expect(noParentDelete.statusCode, noParentDelete.body).toBe(409);
    expect(noParentDelete.body).toMatch(/orphan/);

    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx
        .update(objects)
        .set({ deletedAt: new Date() })
        .where(and(eq(objects.orgId, org.orgId), eq(objects.id, tombService.id as string)));
    });

    for (const suffixPath of READ_DOORS) {
      const res = await get(`/api/v1/campaigns/${strandedId}${suffixPath}`, org.adminToken);
      expect(res.statusCode, `GET /api/v1/campaigns/{id}${suffixPath}: ${res.body}`).toBe(200);
    }
    const rolledBack = await rollback(strandedId, org.adminToken);
    expect(rolledBack.statusCode, rolledBack.body).toBe(200);

    // The widening did not leak the other way. See docs/routes.md §11.
    const stranger = await get(`/api/v1/campaigns/${strandedId}`, serviceReader.token);
    expect(stranger.statusCode, stranger.body).toBe(403);
  });
});
