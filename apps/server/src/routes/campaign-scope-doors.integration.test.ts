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
 *
 * THE ORG-ROOT ARM (added 2026-08-26 with `authz/org-root-arm.ts`, baseline 6 passed). Scoping at
 * the campaign ALONE is not a pure widening: `scopeExpandCte` joins every ANCESTOR
 * `deleted_at IS NULL`, so a campaign whose containment parent is tombstoned expands to the seed
 * alone and matches NO binding, org-root Owner included. All four doors now take the permission at
 * the ORG ROOT **or** at the campaign, through one shared definition.
 *
 *  M-9  `checkAtOrgRootOrScopes`'s org-root arm disabled (`if (false && atOrgRoot)`) => "the
 *       org-root Owner still reaches a campaign whose containment parent is TOMBSTONED" FAILED on
 *       the plain GET: `"lacks 'object:read' at the org root and at campaign '<id>'"`, expected 403
 *       to be 200. The other FIVE cases stayed green — every one of them sits on a campaign whose
 *       service is alive, which is exactly why nothing here caught this before.
 *
 * THE TYPE CONSTRAINT (added 2026-08-26, baseline 7 passed). `:adoption` and `:rollback` resolved
 * their campaign with an ANY-TYPE lookup, so the bar named "campaign" ran at whatever object the
 * caller named, and a live non-campaign id was distinguishable from a ghost one before any
 * authorization ran.
 *
 *  M-10 `resolveCampaignForScope` reverted to `getObjectByIdOrUrnAnyType` on both doors => "a
 *       NON-campaign id is 404 on every door" FAILED on the rollback leg: `'<component id>' is not
 *       a campaign`, expected 400 to be 404 — `triggerCampaignRollback`'s own refusal, reached only
 *       because the campaign bar had already been cleared at a component.
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
    // ============================================================================================
    // `:adoption` and `:rollback` cannot get their campaign from their repo in time to scope on, so
    // they resolve one themselves — and they used to do it with `getObjectByIdOrUrnAnyType`, which
    // resolves ANY type. Two consequences, both closed by `resolveCampaignForScope`:
    //
    //   1. `assertCampaignAuthority` ran at whatever object the caller named. A principal bound at
    //      a COMPONENT cleared a bar whose message says "campaign", and only the repo behind it
    //      said no. The bar in the code was not the bar being run.
    //   2. An EXISTENCE ORACLE, opened before any authorization: a live non-campaign id refused
    //      with 403 while a ghost uuid answered 404, so a caller holding nothing anywhere could
    //      tell "some object exists here" from "nothing does". The two now answer identically.
    //
    // `:rollback`'s answer for a non-campaign moves from `triggerCampaignRollback`'s 400 to the
    // same 404 the other three doors give — deliberate, and it is what makes case 2 hold.
    // ============================================================================================
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
    // ============================================================================================
    // WHY THE RE-SCOPE IS A DISJUNCTION HERE TOO, and why "an org-root binding satisfies a check at
    // any object below it" is not the whole rule. `scopeExpandCte` joins every ANCESTOR
    // `deleted_at IS NULL`, so a campaign whose containment parent is a tombstone expands to the
    // SEED ALONE and matches no binding — the org-root Owner's included. Without
    // `authz/org-root-arm.ts`'s org-root arm all four doors below are a 403 for a principal with
    // authority over the entire deployment.
    //
    // WHY THE PARENT IS TOMBSTONED HERE WITH AN UPDATE RATHER THAN A `DELETE` CALL — and why the
    // two API refusals that force it are EXERCISED below rather than described.
    //
    // The house rule is to build test state through the real API. The source-mapping family's
    // equivalent case does exactly that (`change-source-mapping-authz.integration.test.ts`: delete
    // the component, then its service, then its domain) and so does the change family's
    // (`change-target-scope.integration.test.ts`) — both work because the SEED of the walk is
    // soft-deleted FIRST, and `scopeExpandCte` seeds liveness-blind, so the seed survives its own
    // tombstone while its parents' tombstones cut the chain.
    //
    // A CAMPAIGN CANNOT BE THE SEED THAT WAY, because the doors under test 404 a tombstoned
    // campaign (`fetchCampaignObject` filters `deleted_at IS NULL`) — the campaign has to stay
    // LIVE. That leaves only "tombstone an ancestor while the campaign lives", and two shipped
    // guards make it unreachable through local API calls, in a pincer:
    //
    //   1. there is no DELETE for a campaign at all — `campaign` is one of
    //      `COORDINATION_TARGET_SCOPED_OBJECT_TYPE_IDS`, refused on every write verb of the generic
    //      object route, and it has no typed delete;
    //   2. `deleteObject`'s orphan guard refuses to delete a row that still has live containment
    //      children (all three routes since the 2026-08-18 widening), and a live campaign is one.
    //
    // Both are asserted below, so this justification is a MEASUREMENT rather than a claim, and so
    // that if either guard ever changes this test says so instead of the comment quietly going
    // stale. The state IS reachable in production: `deleteObject` skips the orphan guard on the
    // FEDERATION-IMPORT path and when removing a foreign shadow, and its own header records the
    // consequence verbatim — "A local child naming a foreign replica as its parent therefore CAN
    // still be orphaned by that authority's delete; recorded as a cost." A campaign declared under
    // a replica service that its authoritative domain later deletes is that sentence. The ROW those
    // paths leave behind is identical to the one written here — `deleted_at` set on the parent,
    // child untouched — and that column is all `scopeExpandCte` reads.
    // ============================================================================================
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

    // The widening did not leak the other way. A cut chain reaches NO binding, so a check that had
    // simply stopped refusing would look identical to the fix from the Owner's side alone; this
    // probe is what tells the two apart.
    //
    // WHAT THIS PROBE IS, PRECISELY: `serviceReader` is bound at `serviceA` (the beforeAll fixture),
    // which is unrelated to this case and was never deleted — NOT at `tombService`, the row this
    // test tombstones. So it is an ordinary no-standing-in-this-chain principal, and its 403 shows
    // the org-root arm did not open the door generally. It is deliberately NOT the sharper probe (a
    // principal bound at the tombstoned row itself); that case belongs with whoever pins what a
    // binding below a cut chain should mean, which is an open question, not a settled one.
    const stranger = await get(`/api/v1/campaigns/${strandedId}`, serviceReader.token);
    expect(stranger.statusCode, stranger.body).toBe(403);
  });
});
