import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer,
  type TestUser
} from "../test-support/harness.js";

/**
 * ================================================================================================
 * STEP 2.5a — THE CAMPAIGN GET-BY-ID DOORS ARE SCOPED AT THE CAMPAIGN, NOT AT THE ORG ROOT
 * ================================================================================================
 *
 * THE GUARANTEE UNDER TEST, in one sentence: *an actor bound below the org root can read (and roll
 * back) a campaign that lives inside their own subtree, and cannot read one that does not — while
 * everything an org-root binding could do before still works, identically.*
 *
 * ## Why this file exists at all
 *
 * `docs/proposals/role-model.md` §8.5: all 334 `403` occurrences across `apps/server`'s tests were
 * enumerated and **zero** of them depend on the org-root pin of any door this increment re-scopes.
 * So the four campaign doors below were entirely unpinned — a re-scope could have shipped holding to
 * nothing, and a mistake in either direction (too wide, or 404-turned-403) would have been silent.
 * These cases were written BEFORE the re-scope and watched fail; the failures are recorded in the
 * mutation log at the bottom of this doc comment.
 *
 * ## Why a campaign's OWN id is a real scope, where a change's is not
 *
 * §8.4 measured that re-scoping a *change* door to `change.id` is INERT: no `proposeChange` caller
 * in the tree passes a `domainId`, `scp change propose` has no `--domain` flag, and route 1 of
 * `scopeExpandCte` therefore walks a change straight back to the org root. A CAMPAIGN is the
 * opposite case and that is why these four doors are cheap: `POST /campaigns` takes `domainId` on
 * the wire (`CreateCampaignRequestSchema`), resolves it through `resolveDeclaredContainmentParent`
 * and authorizes `object:write` at it — so a campaign genuinely lives under a service when it is
 * authored under one, and `scopeExpandCte`'s route 1 walks campaign -> service -> org root. The
 * fixtures below author campaigns exactly that way, which is what makes the service-bound cases
 * measure the containment walk rather than a coincidence.
 *
 * ## The 404-vs-403 cases are the ones that would have been missed
 *
 * `scopeExpandCte` seeds its recursive CTE with the raw uuid and never checks that the object
 * exists (`authz/resolve.ts`), so a nonexistent id expands to a one-row set matching no binding —
 * a guaranteed refusal. Scoping at a path param WITHOUT resolving the object first therefore turns
 * every 404 on these routes into a 403, for everybody including an org-root Owner, plus two extra
 * `assertDenyNotTruncated` probe queries per request. Those cases pass before the re-scope too
 * (today's org-root check admits the Owner and the repo 404s afterwards); they exist to pin the
 * ORDER the re-scope has to preserve, and the mutation log shows them going red when it is broken.
 *
 * ================================================================================================
 * MUTATIONS RUN (2026-08-26). Baseline: 5 passed. MEASURED, not predicted — messages are verbatim.
 * ================================================================================================
 * THE WIDENING — each door's `scopeObjectId` reverted to `auth.orgId`, one at a time. All four
 * refusals name the ORG ROOT as the scope, which is the property the re-scope exists to remove:
 *
 *  M-1  GET /campaigns/{id}: `scopeObjectId: found.id` -> `auth.orgId` => "a service-bound reader
 *       reaches every get-by-id door..." FAILED on the plain GET: `"lacks 'object:read' at scope
 *       '<orgId>'"`, expected 403 to be 200.
 *  M-2  GET /campaigns/{id}/explain: `campaign.id` -> `auth.orgId` => the same case FAILED on
 *       `/explain`, same detail, expected 403 to be 200.
 *  M-3  GET /campaigns/{id}/adoption: `campaignObject.id` -> `auth.orgId` => the same case FAILED
 *       on `/adoption`, same detail, expected 403 to be 200.
 *  M-4  POST /campaigns/{id}/rollback: `campaignObject.id` -> `auth.orgId` => "a service-bound
 *       writer can roll back a campaign in their own subtree..." FAILED: `"lacks 'object:write' at
 *       scope '<orgId>'"`, expected 403 to be 200.
 *
 * THE ORDER — each door's `authorize` moved back ABOVE its resolve and scoped at the raw path
 * param, which is what a mechanical re-scope produces. Every one turns an org-root OWNER's 404 into
 * a 403 (the message even names the ghost uuid as the scope, which is the tell):
 *
 *  M-5  GET /campaigns/{id}  => "a nonexistent campaign id is 404, never 403, for an org-root
 *       Owner" FAILED: `"lacks 'object:read' at scope '<ghost uuid>'"`, expected 403 to be 404.
 *  M-6  ...`/explain`        => the same case FAILED on `/explain`, expected 403 to be 404.
 *  M-7  ...`/adoption`       => the same case FAILED on `/adoption`, expected 403 to be 404.
 *  M-8  ...`:rollback`       => the same case FAILED on the rollback leg: `"lacks 'object:write' at
 *       scope '<ghost uuid>'"`, expected 403 to be 404.
 */
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
    // it. This is the case that would go red if the re-scope had picked a scope the org root does
    // not contain.
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
});
