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
 * STEP 2.5b — THE LIST DOORS FILTER ROWS INSTEAD OF REFUSING THE PAGE (`/placements`, `/campaigns`)
 * ================================================================================================
 *
 * THE GUARANTEE UNDER TEST, in one sentence: *a principal bound below the org root lists exactly the
 * placements and campaigns their binding reaches — while every request that worked against the
 * org-root pin still works, byte for byte, and a principal with no allow binding anywhere still gets
 * the same 403.*
 *
 * ## Why these cases are at the DOOR and not at the filter
 *
 * `authz/readable-scope.integration.test.ts` already proves the downward walk itself, including
 * §8.3's inverse invariant (`hasPermission(o)` iff `o ∈ readableSet`) over every live object of a
 * four-route fixture. What it cannot prove is that anything CALLS it. Until this file existed the
 * filter had exactly one caller — that test — which is this repo's dominant failure mode: built,
 * tested, wired nowhere. So every case below goes through `app.inject` at the real URL, and the
 * mutation log records the filter being deleted from each repo and the named case going red.
 *
 * ## Why the page is filtered in SQL and not in the handler
 *
 * role-model.md §8.2, measured: both repos are keyset-paginated with `.limit(limit + 1)` and take
 * `nextCursor` from the last row SELECTED, so a handler-side filter shrinks the page after the
 * LIMIT — one readable row on page 1 and zero on pages 6 through 185, each advertising more. These
 * fixtures are far too small to show that, which is exactly why it must not be re-litigated per
 * door: the shape is settled, and what this file pins is that the condition reaches `conditions`.
 *
 * ## The `?scopeObjectId=` cases carry three separate traps
 *
 *  1. **404 must not become 403.** `scopeExpandCte` seeds its walk with the raw uuid and never
 *     checks existence, so authorizing at an unresolved query parameter refuses everybody,
 *     org-root Owner included (§8.7).
 *  2. **The hint must be resolved AFTER the gate.** Resolving first would let a caller who holds
 *     nothing distinguish "id exists" (403 at the hint) from "id does not" (404) — the
 *     pre-authorization existence oracle `resolveCampaignForScope` was written to close.
 *  3. **The hint may only ever NARROW.** It is authorized before it is used, so its rows are always
 *     a subset of the caller's own.
 *
 * ================================================================================================
 * MUTATIONS RUN (2026-08-26). Baseline: 18 passed. MEASURED, not predicted — messages verbatim.
 * ================================================================================================
 * THE FILTER — deleted from each repo in turn, which is the "built, never installed" check: if the
 * condition never reaches `conditions`, these cases must go red.
 *
 *  M-1  `graph/placements-repo.ts`: the `conditions.push(sql`${objects.id} IN …`)` line deleted
 *       => 8 FAILED. "a SERVICE-bound reader lists only the placements and campaigns in their own
 *       subtree": `expected Set{ …(3) } to deeply equal Set{ '…' }` — all three placements came
 *       back. "the list agrees with get-by-id, object by object" also failed, and its message is
 *       the one worth reading: `get-by-id said 403 for <id>; the list said true` — §8.3's
 *       disagreement, caught as data rather than as a status code.
 *  M-2  `coordination/campaign-repo.ts`: the same line deleted => 5 FAILED, incl. "a COMPONENT-
 *       bound reader … and no campaigns at all": `expected Set{ …(3) } to deeply equal Set{}`.
 *
 * THE HINT — `authz/list-door-scope.ts`:
 *
 *  M-3  the authorization at the resolved hint disabled (`if (false && !atHint)`) =>
 *       "?scopeObjectId= 403s when the caller lacks authority AT THE HINT" FAILED, `expected 200 to
 *       be 403`, the body carrying `comp-b1…@target…` — i.e. the hint had become a WIDENING,
 *       handing a `serviceA`-bound reader the rows under `serviceB`. "a hint pointing at a live
 *       object OUTSIDE the caller's reach never leaks its rows" failed with it.
 *  M-6  the gate skipped whenever a hint is present (`if (!atOrgRoot && scopeObjectRef ===
 *       undefined)`) — VERBATIM the first draft of this module, which authorized at the hint and
 *       never consulted the subject's own roots => "the GATE runs BEFORE the hint is resolved — no
 *       pre-authorization existence oracle" FAILED: the stranger's refusal became `lacks
 *       'object:read' at the org root and at scope '<serviceA>'` instead of the org-root wording,
 *       so a real id and a ghost id answer differently. This case was written before the module
 *       and it caught the defect on the first run.
 *
 * THE GATE — `authz/list-door-scope.ts`, the half that must NOT widen:
 *
 *  M-7  the `allowRoots.length === 0` refusal deleted => "a subject with NO allow binding anywhere
 *       still gets today's 403, worded identically" FAILED: `{"items":[],"nextCursor":null}:
 *       expected 200 to be 403`. An empty page instead of a refusal — the widening §8.2 step 5
 *       forbids.
 *  M-4  the `unhintedFilter === null` refusal deleted => "an allow AND a deny at the ORG ROOT is a
 *       403, never the whole org" FAILED: `expected 200 to be 403`, body listing ALL THREE
 *       placements. This is the sharpest one. `readableObjectFilterSql` short-circuits an org-root
 *       ALLOW to `null` = NO FILTER without consulting the deny set, so a subject the org root
 *       explicitly DENIES has an allow root of `orgId` and would be handed the entire org.
 *  M-5  the subject's deny roots replaced with `[]` in the un-hinted filter => "a DENY below an
 *       allow subtracts its subtree from the page, and only its subtree" FAILED: `expected
 *       Set{ …(2) } to deeply equal Set{ '<placeC1>' }` — the denied subtree reappeared, a deny
 *       failing OPEN on the list while still refusing on get-by-id.
 */
describe("list doors filter rows by readable scope (role-model §8.2, step 2.5b)", () => {
  let server: TestServer;
  let org: TestOrg;

  /** Every fixture id, named. `Record<string, string>` indexes as `string | undefined` under
   *  `noUncheckedIndexedAccess` and would bury every assertion in `!`. */
  interface Fixture {
    domainA: string;
    domainB: string;
    /** Under `domainA`. Holds `compA1`, whose placement is `placeA1`. */
    serviceA: string;
    /** Under `domainA`, BESIDE `serviceA` — the row a deny at `serviceA` must leave alone. */
    serviceC: string;
    /** Under `domainB`. */
    serviceB: string;
    compA1: string;
    compC1: string;
    compB1: string;
    placeA1: string;
    placeC1: string;
    placeB1: string;
    /** Withdrawn through the real DELETE door, for the `includeDeleted` interaction. */
    placeDeleted: string;
    campA: string;
    campC: string;
    campB: string;
  }
  let ids: Fixture;

  /** `Owner` at the org root — the principal every one of these doors admitted before 2.5b. */
  let orgRootToken: string;
  /** `Viewer` at `serviceA`: reaches `compA1`, `placeA1` and `campA`, and nothing else. */
  let serviceAReader: TestUser;
  /** `Viewer` at `compB1`: reaches `placeB1` only — the narrowest rung that still has a placement. */
  let componentBReader: TestUser;
  /** `Viewer` ALLOW at `domainA` **and** DENY at `serviceA`: the deny-subtracts case. */
  let denyBelowAllowReader: TestUser;
  /** No bindings at all — must still get today's 403, unchanged. */
  let stranger: TestUser;
  /** `Viewer` ALLOW **and** DENY, both at the ORG ROOT: `hasPermission` refuses (deny wins), and
   *  the allow root is the org root, whose short-circuit would otherwise mean NO FILTER. */
  let deniedAtOrgRoot: TestUser;

  const uniq = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "list-door-scope");
    orgRootToken = org.adminToken;

    const domainA = await create("/api/v1/domains", { name: uniq("domain-a") });
    const domainB = await create("/api/v1/domains", { name: uniq("domain-b") });
    const serviceA = await create("/api/v1/services", { name: uniq("svc-a"), domainId: domainA });
    const serviceC = await create("/api/v1/services", { name: uniq("svc-c"), domainId: domainA });
    const serviceB = await create("/api/v1/services", { name: uniq("svc-b"), domainId: domainB });

    const compA1 = await create("/api/v1/components", { name: uniq("comp-a1"), service: serviceA });
    const compC1 = await create("/api/v1/components", { name: uniq("comp-c1"), service: serviceC });
    const compB1 = await create("/api/v1/components", { name: uniq("comp-b1"), service: serviceB });
    const compA2 = await create("/api/v1/components", { name: uniq("comp-a2"), service: serviceA });

    const target = await create("/api/v1/deployment-targets", { name: uniq("target") });
    const placeA1 = await create("/api/v1/placements", {
      component: compA1,
      deploymentTarget: target
    });
    const placeC1 = await create("/api/v1/placements", {
      component: compC1,
      deploymentTarget: target
    });
    const placeB1 = await create("/api/v1/placements", {
      component: compB1,
      deploymentTarget: target
    });

    // Withdrawn through the real door, so the row is a genuine tombstone rather than a hand-written
    // one. `includeDeleted=true` still returns it to an unfiltered caller.
    const placeDeleted = await create("/api/v1/placements", {
      component: compA2,
      deploymentTarget: target
    });
    const withdrawn = await inject("DELETE", `/api/v1/placements/${placeDeleted}`, orgRootToken);
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);

    // `domainId` is what puts a campaign INSIDE a service: `POST /campaigns` resolves it through
    // `resolveDeclaredContainmentParent`, so route 1 of the containment walk runs
    // campaign -> service -> domain -> org root, and its inverse finds the campaign from any of them.
    const campA = await create("/api/v1/campaigns", {
      name: uniq("camp-a"),
      domainId: serviceA,
      targets: [compA1]
    });
    const campC = await create("/api/v1/campaigns", {
      name: uniq("camp-c"),
      domainId: serviceC,
      targets: [compC1]
    });
    const campB = await create("/api/v1/campaigns", {
      name: uniq("camp-b"),
      domainId: serviceB,
      targets: [compB1]
    });

    ids = {
      domainA,
      domainB,
      serviceA,
      serviceC,
      serviceB,
      compA1,
      compC1,
      compB1,
      placeA1,
      placeC1,
      placeB1,
      placeDeleted,
      campA,
      campC,
      campB
    };

    serviceAReader = await createTestUser(server, org, [{ role: "Viewer", scope: serviceA }]);
    componentBReader = await createTestUser(server, org, [{ role: "Viewer", scope: compB1 }]);
    denyBelowAllowReader = await createTestUser(server, org, [
      { role: "Viewer", scope: domainA },
      { role: "Viewer", scope: serviceA, effect: "deny" }
    ]);
    stranger = await createTestUser(server, org, []);
    deniedAtOrgRoot = await createTestUser(server, org, [
      { role: "Viewer", scope: org.orgId },
      { role: "Viewer", scope: org.orgId, effect: "deny" }
    ]);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  function inject(
    method: "GET" | "POST" | "DELETE",
    url: string,
    token: string,
    payload?: Record<string, unknown>
  ) {
    const headers = { authorization: `Bearer ${token}` };
    return payload === undefined
      ? server.app.inject({ method, url, headers })
      : server.app.inject({ method, url, headers, payload });
  }

  async function create(url: string, payload: Record<string, unknown>): Promise<string> {
    const res = await inject("POST", url, orgRootToken, payload);
    if (res.statusCode >= 300) throw new Error(`POST ${url} -> ${res.statusCode} ${res.body}`);
    return (res.json() as { id: string }).id;
  }

  /** The ids on a 200 page, as a Set. Asserts the status so a 403 never reads as "no rows". */
  async function listedIds(url: string, token: string): Promise<Set<string>> {
    const res = await inject("GET", url, token);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { items: { id: string }[] };
    return new Set(body.items.map((i) => i.id));
  }

  const placements = (token: string, query = "") =>
    listedIds(`/api/v1/placements?limit=100${query}`, token);
  const campaigns = (token: string, query = "") =>
    listedIds(`/api/v1/campaigns?limit=100${query}`, token);

  const problem = (res: { body: string }) => JSON.parse(res.body) as { detail?: string };

  // ---------------------------------------------------------------------------------------------
  // (a) The row filter
  // ---------------------------------------------------------------------------------------------

  it("the org-root principal's page is unchanged — every row, no filter", async () => {
    expect(await placements(orgRootToken)).toEqual(
      new Set([ids.placeA1, ids.placeC1, ids.placeB1])
    );
    expect(await campaigns(orgRootToken)).toEqual(new Set([ids.campA, ids.campC, ids.campB]));
  });

  it("a SERVICE-bound reader lists only the placements and campaigns in their own subtree", async () => {
    expect(await placements(serviceAReader.token)).toEqual(new Set([ids.placeA1]));
    expect(await campaigns(serviceAReader.token)).toEqual(new Set([ids.campA]));
  });

  it("a COMPONENT-bound reader lists that component's placements — and no campaigns at all", async () => {
    expect(await placements(componentBReader.token)).toEqual(new Set([ids.placeB1]));
    // `campB` hangs off `serviceB`, one rung ABOVE this binding, so the downward walk never reaches
    // it. An empty page, not a 403: the door opened, and there was nothing inside it.
    expect(await campaigns(componentBReader.token)).toEqual(new Set());
  });

  it("a DENY below an allow subtracts its subtree from the page, and only its subtree", async () => {
    // Allow at `domainA`, deny at `serviceA`. `serviceC` sits beside `serviceA` under the same
    // allowed domain and must survive.
    expect(await placements(denyBelowAllowReader.token)).toEqual(new Set([ids.placeC1]));
    expect(await campaigns(denyBelowAllowReader.token)).toEqual(new Set([ids.campC]));
  });

  it("a subject with NO allow binding anywhere still gets today's 403, worded identically", async () => {
    for (const url of ["/api/v1/placements", "/api/v1/campaigns"]) {
      const res = await inject("GET", url, stranger.token);
      expect(res.statusCode, res.body).toBe(403);
      expect(problem(res).detail).toBe(
        `subject '${stranger.objectId}' lacks 'object:read' at scope '${org.orgId}'`
      );
    }
  });

  it("an allow AND a deny at the ORG ROOT is a 403, never the whole org", async () => {
    // The trap this pins: the subject's allow roots contain the org root, and
    // `readableObjectFilterSql` short-circuits an org-root allow to `null` = NO FILTER. Returning
    // that here would hand the entire org to the one principal the org root explicitly denies.
    for (const url of ["/api/v1/placements", "/api/v1/campaigns"]) {
      const res = await inject("GET", url, deniedAtOrgRoot.token);
      expect(res.statusCode, res.body).toBe(403);
      expect(problem(res).detail).toBe(
        `subject '${deniedAtOrgRoot.objectId}' lacks 'object:read' at scope '${org.orgId}'`
      );
    }
  });

  it("the list agrees with get-by-id, object by object (§8.3's invariant, at the DOOR)", async () => {
    // The failure this detects is the one that reads as a cache bug: an object `authorize()` admits
    // at its own id, absent from the list that should contain it. Measured over every placement in
    // the fixture, in both directions, for a scoped principal.
    const listed = await placements(serviceAReader.token);
    for (const id of [ids.placeA1, ids.placeC1, ids.placeB1]) {
      const res = await inject("GET", `/api/v1/placements/${id}`, serviceAReader.token);
      const readableByGetById = res.statusCode === 200;
      expect(
        [id, readableByGetById],
        `get-by-id said ${res.statusCode} for ${id}; the list said ${listed.has(id)}`
      ).toEqual([id, listed.has(id)]);
    }
  });

  // ---------------------------------------------------------------------------------------------
  // (b) `?scopeObjectId=` — the optional narrowing
  // ---------------------------------------------------------------------------------------------

  it("?scopeObjectId= narrows an ORG-ROOT principal's own results to one subtree", async () => {
    expect(await placements(orgRootToken, `&scopeObjectId=${ids.serviceA}`)).toEqual(
      new Set([ids.placeA1])
    );
    expect(await campaigns(orgRootToken, `&scopeObjectId=${ids.serviceA}`)).toEqual(
      new Set([ids.campA])
    );
    // A rung lower: the component reaches its placement and no campaign.
    expect(await placements(orgRootToken, `&scopeObjectId=${ids.compC1}`)).toEqual(
      new Set([ids.placeC1])
    );
  });

  it("?scopeObjectId= at the ORG ROOT is the un-narrowed query, not a special case", async () => {
    expect(await placements(orgRootToken, `&scopeObjectId=${org.orgId}`)).toEqual(
      await placements(orgRootToken)
    );
    expect(await campaigns(orgRootToken, `&scopeObjectId=${org.orgId}`)).toEqual(
      await campaigns(orgRootToken)
    );
  });

  it("?scopeObjectId= narrows a SCOPED principal too, within what they already reach", async () => {
    expect(await placements(serviceAReader.token, `&scopeObjectId=${ids.compA1}`)).toEqual(
      new Set([ids.placeA1])
    );
  });

  it("?scopeObjectId= 403s when the caller lacks authority AT THE HINT", async () => {
    for (const [url, hint] of [
      ["/api/v1/placements", ids.serviceB],
      ["/api/v1/campaigns", ids.serviceB]
    ] as const) {
      const res = await inject("GET", `${url}?scopeObjectId=${hint}`, serviceAReader.token);
      expect(res.statusCode, res.body).toBe(403);
      expect(problem(res).detail).toBe(
        `subject '${serviceAReader.objectId}' lacks 'object:read' at the org root and at scope '${hint}'`
      );
    }
  });

  it("a hint pointing at a live object OUTSIDE the caller's reach never leaks its rows", async () => {
    // The 403 above is the refusal; this is the same claim stated as data, so that a future change
    // making the hint a widening (seeding the descend before authorizing) fails on rows, not only
    // on a status code.
    const res = await inject(
      "GET",
      `/api/v1/placements?limit=100&scopeObjectId=${ids.domainB}`,
      componentBReader.token
    );
    expect(res.statusCode, res.body).toBe(403);
  });

  it("a NONEXISTENT hint is 404, never 403 — for an org-root Owner and for a scoped reader", async () => {
    const ghost = randomUUID();
    for (const token of [orgRootToken, serviceAReader.token]) {
      for (const url of ["/api/v1/placements", "/api/v1/campaigns"]) {
        const res = await inject("GET", `${url}?scopeObjectId=${ghost}`, token);
        expect(res.statusCode, res.body).toBe(404);
      }
    }
  });

  it("a MALFORMED hint is 400 at the schema, before any authorization runs", async () => {
    for (const url of ["/api/v1/placements", "/api/v1/campaigns"]) {
      const res = await inject("GET", `${url}?scopeObjectId=not-a-uuid`, orgRootToken);
      expect(res.statusCode, res.body).toBe(400);
    }
  });

  it("the GATE runs BEFORE the hint is resolved — no pre-authorization existence oracle", async () => {
    // A caller with no standing must not be able to tell a real id from a ghost one. Both answers
    // are the same 403; if the hint were resolved first they would be 403 and 404.
    const ghost = randomUUID();
    for (const hint of [ids.serviceA, ghost]) {
      const res = await inject("GET", `/api/v1/placements?scopeObjectId=${hint}`, stranger.token);
      expect(res.statusCode, res.body).toBe(403);
      expect(problem(res).detail).toBe(
        `subject '${stranger.objectId}' lacks 'object:read' at scope '${org.orgId}'`
      );
    }
  });

  // ---------------------------------------------------------------------------------------------
  // The documented interaction, pinned rather than left to be discovered
  // ---------------------------------------------------------------------------------------------

  it("includeDeleted and a narrowed scope do not compose — the descend walks LIVE rows only", async () => {
    // Unfiltered, the tombstone comes back.
    expect(await placements(orgRootToken, "&includeDeleted=true")).toContain(ids.placeDeleted);
    // Narrowed, it does not: `containmentChildrenSql` joins every child `deleted_at IS NULL`,
    // exactly as the upward walk joins every ancestor live, so a tombstoned row is below nothing.
    // Stated here so the behaviour is a decision on record instead of a support ticket.
    expect(
      await placements(orgRootToken, `&includeDeleted=true&scopeObjectId=${ids.serviceA}`)
    ).not.toContain(ids.placeDeleted);
  });

  it("the pair filters still apply, and compose with the scope filter", async () => {
    // `?component=` is resolved and applied as before; the readable filter is an extra condition,
    // not a replacement, so the two intersect.
    expect(await placements(serviceAReader.token, `&component=${ids.compA1}`)).toEqual(
      new Set([ids.placeA1])
    );
    expect(await placements(serviceAReader.token, `&component=${ids.compC1}`)).toEqual(new Set());
  });

  it("?status= still filters campaigns, unchanged, alongside the scope filter", async () => {
    // Every fixture campaign is planless, so `?status=proposed` returns the same set the scope
    // filter allows. The point is that the two conditions coexist rather than one shadowing the
    // other.
    expect(await campaigns(serviceAReader.token, "&status=proposed")).toEqual(new Set([ids.campA]));
  });
});
