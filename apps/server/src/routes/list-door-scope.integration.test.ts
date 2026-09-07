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

/** The list doors filter rows instead of refusing the page. See docs/routes.md §257. */
describe("list doors filter rows by readable scope (role-model §8.2, step 2.5b)", () => {
  let server: TestServer;
  let org: TestOrg;

  /** Every fixture id, named. `Record<string, string>` indexes as `string | undefined` under
   *  `noUncheckedIndexedAccess` and would bury every assertion in `!`. */
  interface Fixture {
    domainA: string;
    domainB: string;
    serviceA: string;
    /** Under `domainA`, BESIDE `serviceA` — the row a deny at `serviceA` must leave alone. */
    serviceC: string;
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

  // The documented interaction, pinned rather than left to be discovered

  it("includeDeleted and a narrowed scope do not compose — the descend walks LIVE rows only", async () => {
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
