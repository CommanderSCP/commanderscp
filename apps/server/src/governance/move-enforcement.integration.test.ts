import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  testDatabaseUrl,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * `governance:move` — THE OPT-IN SECOND BAR ON A CONTAINMENT MOVE, THROUGH THE REAL DOORS.
 * (docs/proposals/governance-reach-on-containment-move.md §9.2/§9.5; owner ruling 2026-08-18.)
 *
 * Every case goes through HTTP (`server.app.inject`), never a repo function, for the reason
 * `routes/containment-move-authz.integration.test.ts` states: the failure mode this feature exists
 * to prevent is a DOOR that forgot the check, and a repo-level test cannot see a door.
 *
 * ============================================================================================
 * MUTATION LOG — each mutation applied ALONE, run, reverted, restoration verified with `cmp`
 * ============================================================================================
 *  m1  remove the `assertGovernanceMoveAdmits` call in `graph/containment-parent-authz.ts`
 *      → RED: "PATCH /services/{id} …", "PATCH /objects/service/{id} …", "the org root as a
 *        DESTINATION is NOT exempt …", "the INSTANCE rung activates …" (all four reach that door)
 *  m2  remove ONLY the twin in `iac/plans-repo.ts::prepareApplyChecks`
 *      → RED: "POST /plans/{id}/apply …" ALONE — the M24 lesson (a door-only fix ships inert on IaC)
 *  m2b remove ONLY the `contains` call in `prepareApplyChecks`' RELATIONSHIP loop (route 2)
 *      → RED: "POST /plans/{id}/apply — a `contains` RELATIONSHIP entry …" ALONE. Added after
 *        review found the first round had twinned route 1 (`domainId`) and not route 2, leaving an
 *        Operator able to make through apply the move `POST /relationships` refuses them.
 *  m3  remove the call in `graph/components-repo.ts::setComponentService`
 *      → RED: "PUT /components/{idOrUrn}/service …" alone
 *  m4  remove the two `contains` calls in `routes/relationships.ts`
 *      → RED: "POST /relationships (contains) …" and "DELETE /relationships/{id} (contains) …"
 *  m5  make the org root exempt (skip when the destination is `orgId`)
 *      → RED: "the org root as a DESTINATION is NOT exempt …" AND "POST /relationships (contains) …"
 *        — recorded rather than tidied, because the second RED is the point: a `contains` DELETE's
 *        destination IS the org root, so the exemption would silently un-govern the whole
 *        take-it-out-of-the-container verb, not just the explicit move-to-root
 *  m6  drop the instance-rung OR in `resolveGovernanceMoveEnforcement` (`enforced: rungs.length > 0`)
 *      → RED: "the INSTANCE rung activates …" alone
 *  m9  remove the `contains` call in `routes/executors.ts`'s `POST /discovery/accept` loop
 *      → RED: "POST /discovery/accept (contains onto a PRE-EXISTING child) …" alone
 *  m9b drop the `!createdInThisBatch.has(toId)` carve-out at that same door
 *      → RED: the SUCCESS half of that case (a fresh child contained in its own batch) — the case
 *        that keeps "governed" from quietly meaning "discovery is off"
 *
 * ============================================================================================
 * THE INSTANCE RUNG IS AN INSTANCE-GLOBAL FIXTURE
 * ============================================================================================
 * `governance_move_instance_rung` has no `org_id` and the integration suite runs `singleFork`
 * against ONE shared Postgres, so the row is deleted in a `finally` AND at teardown no matter how
 * this file exits — a rung left enabled would enforce `governance:move` for every later file.
 */
describe("governance:move enforcement (proposal §9.2)", () => {
  const OPERATOR_TOKEN = "governance-move-operator-token";

  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer({ operatorToken: OPERATOR_TOKEN });
    await clearInstanceRung();
  }, 120_000);

  afterAll(async () => {
    await clearInstanceRung();
    await server?.close();
  });

  interface Response {
    status: number;
    body: string;
    json: () => Record<string, unknown>;
  }

  async function call(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    token: string,
    url: string,
    payload?: Record<string, unknown>,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    const res = await server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, ...headers },
      ...(payload === undefined ? {} : { payload })
    });
    return { status: res.statusCode, body: res.body, json: () => res.json() };
  }

  const detailOf = (res: Response): string => String((res.json() as { detail?: string }).detail);

  /** Deletes the instance singleton — the deployment's shipped state (no row = disabled). */
  async function clearInstanceRung(): Promise<void> {
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
    try {
      await pool.query(`DELETE FROM governance_move_instance_rung WHERE id = 'default'`);
    } finally {
      await pool.end();
    }
  }

  interface Fixture {
    org: TestOrg;
    /** The container the rung goes on in most cases. */
    domainId: string;
    /** A second domain, the destination of an ordinary move. */
    otherDomainId: string;
    serviceId: string;
    serviceUrn: string;
    otherServiceId: string;
    /** A component contained by `serviceId`. */
    componentId: string;
    /** A component with NO container — the `POST /relationships` (contains) subject. */
    orphanComponentId: string;
    /** …and its stored URN, which the IaC and discovery-accept `contains` cases name it by. */
    orphanComponentUrn: string;
    /** Operator at the org root: holds `object:write` + `relationship:write` EVERYWHERE, and does
     *  NOT hold `governance:move` (drizzle/0079 grants it to Administrator + Owner only). */
    operatorToken: string;
    /** Administrator at the org root: holds `governance:move`. */
    administratorToken: string;
  }

  async function makeFixture(label: string): Promise<Fixture> {
    const org = await createTestOrg(server, label);
    const admin = org.adminToken;

    const domain = await call("POST", admin, "/api/v1/domains", { name: `${label}-domain` });
    expect(domain.status, domain.body).toBe(201);
    const other = await call("POST", admin, "/api/v1/domains", { name: `${label}-other` });
    expect(other.status, other.body).toBe(201);
    const domainId = domain.json().id as string;
    const otherDomainId = other.json().id as string;

    const service = await call("POST", admin, "/api/v1/services", {
      name: `${label}-svc`,
      domainId
    });
    expect(service.status, service.body).toBe(201);
    const otherService = await call("POST", admin, "/api/v1/services", {
      name: `${label}-svc2`,
      domainId
    });
    expect(otherService.status, otherService.body).toBe(201);

    const component = await call("POST", admin, "/api/v1/components", {
      name: `${label}-comp`,
      service: service.json().id as string
    });
    expect(component.status, component.body).toBe(201);

    // A component with NO `contains` edge — the only shape a `POST /relationships` of `contains`
    // can succeed against (the 0022 partial unique index permits exactly one live parent). The
    // generic `/objects/component` route REFUSES an orphan by design (create-strict), so it is made
    // the way the harness's `createOrphanComponent` makes one: through discovery accept, which is
    // import-permissive.
    const orphan = await call("POST", admin, "/api/v1/discovery/accept", {
      proposal: {
        objects: [{ typeId: "component", name: `${label}-orphan`, properties: {} }],
        relationships: [],
        bindings: []
      }
    });
    expect(orphan.status, orphan.body).toBe(201);
    const orphanComponentId = (orphan.json() as { createdObjectIds: string[] })
      .createdObjectIds[0]!;
    const orphanRead = await call("GET", admin, `/api/v1/objects/component/${orphanComponentId}`);
    expect(orphanRead.status, orphanRead.body).toBe(200);
    const orphanComponentUrn = orphanRead.json().urn as string;

    const operator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    const administrator = await createTestUser(server, org, [
      { role: "Administrator", scope: org.orgId }
    ]);

    return {
      org,
      domainId,
      otherDomainId,
      serviceId: service.json().id as string,
      serviceUrn: service.json().urn as string,
      otherServiceId: otherService.json().id as string,
      componentId: component.json().id as string,
      orphanComponentId,
      orphanComponentUrn,
      operatorToken: operator.token,
      administratorToken: administrator.token
    };
  }

  const enableRung = (f: Fixture, subject: string): Promise<Response> =>
    call("PUT", f.org.adminToken, `/api/v1/governance/move-enforcement/rungs/${subject}`, {});

  // ---------------------------------------------------------------------------------------------
  // WIRING + the lattice's own reads
  // ---------------------------------------------------------------------------------------------

  it("WIRING: the explain read is REGISTERED, and answers `enforced: false` on a fresh org", async () => {
    // Delete `registerGovernanceMoveRoutes(app, deps)` from `app.ts` and this 200 becomes a 404 —
    // the standing "built, never installed" gate. Everything below would still pass at the repo, so
    // this is the case that proves the feature is reachable at all.
    const f = await makeFixture("gm-wiring");
    const res = await call(
      "GET",
      f.org.adminToken,
      `/api/v1/objects/service/${f.serviceId}/governance-move-enforcement`
    );
    expect(res.status, res.body).toBe(200);
    expect(res.json()).toMatchObject({ enforced: false, instance: { enabled: false }, rungs: [] });
  });

  it("with NO rung set, an Operator's move is admitted — the switch is off until it is turned on", async () => {
    // The NEGATIVE CONTROL for every refusal below. A suite made of refusals cannot tell a working
    // guard from a broken door, and this is the case that says the daily reorganisation still works
    // everywhere nobody enabled a rung.
    const f = await makeFixture("gm-off");
    const moved = await call("PATCH", f.operatorToken, `/api/v1/services/${f.serviceId}`, {
      domainId: f.otherDomainId
    });
    expect(moved.status, moved.body).toBe(200);
    expect((moved.json() as { domainId: string }).domainId).toBe(f.otherDomainId);
  });

  it("enabling a rung records a Decision and the explain read NAMES the rung", async () => {
    const f = await makeFixture("gm-explain");
    const enabled = await enableRung(f, f.domainId);
    expect(enabled.status, enabled.body).toBe(200);
    expect(enabled.json()).toMatchObject({ tier: "containment_domain", enabled: true });
    expect(typeof enabled.json().decisionId).toBe("string");

    const explain = await call(
      "GET",
      f.org.adminToken,
      `/api/v1/objects/service/${f.serviceId}/governance-move-enforcement`
    );
    expect(explain.status, explain.body).toBe(200);
    const body = explain.json() as {
      enforced: boolean;
      rungs: { tier: string; subjectObjectId: string; name: string }[];
    };
    expect(body.enforced).toBe(true);
    expect(body.rungs.map((r) => r.subjectObjectId)).toContain(f.domainId);
    expect(body.rungs[0]?.name).toContain("gm-explain");

    const list = await call("GET", f.org.adminToken, "/api/v1/governance/move-enforcement/rungs");
    expect(list.status, list.body).toBe(200);
    expect((list.json() as { rungs: { subjectObjectId: string }[] }).rungs).toHaveLength(1);
  });

  it("a rung may only sit on a CONTAINER — a component is refused 400 naming what it is", async () => {
    const f = await makeFixture("gm-subject-type");
    const res = await enableRung(f, f.componentId);
    expect(res.status, res.body).toBe(400);
    expect(detailOf(res)).toContain("component");
    expect(detailOf(res)).toContain("CONTAINER");
  });

  it("enabling a rung is a governance-authoring act — an Operator (no policy:write) is refused 403", async () => {
    const f = await makeFixture("gm-rung-authz");
    const res = await call(
      "PUT",
      f.operatorToken,
      `/api/v1/governance/move-enforcement/rungs/${f.domainId}`,
      {}
    );
    expect(res.status, res.body).toBe(403);
  });

  // ---------------------------------------------------------------------------------------------
  // THE DOORS — an Operator is refused, an Administrator is admitted (m1, m2, m3, m4)
  // ---------------------------------------------------------------------------------------------

  it("PATCH /services/{id} (typed door) refuses an Operator under an enabled rung, and admits an Administrator", async () => {
    const f = await makeFixture("gm-typed-patch");
    expect((await enableRung(f, f.domainId)).status).toBe(200);

    const refused = await call("PATCH", f.operatorToken, `/api/v1/services/${f.serviceId}`, {
      domainId: f.otherDomainId
    });
    expect(refused.status, refused.body).toBe(403);
    expect(detailOf(refused)).toContain("is governed here");
    expect(detailOf(refused)).toContain("governance:move");
    // The refusal NAMES the rung an operator would go and look at.
    expect(detailOf(refused)).toContain("containment_domain");

    // The row did not move.
    const after = await call("GET", f.org.adminToken, `/api/v1/services/${f.serviceId}`);
    expect((after.json() as { domainId: string }).domainId).toBe(f.domainId);

    const admitted = await call("PATCH", f.administratorToken, `/api/v1/services/${f.serviceId}`, {
      domainId: f.otherDomainId
    });
    expect(admitted.status, admitted.body).toBe(200);
  });

  it("PATCH /objects/service/{id} (generic door) refuses the same move", async () => {
    const f = await makeFixture("gm-generic-patch");
    expect((await enableRung(f, f.domainId)).status).toBe(200);
    const refused = await call("PATCH", f.operatorToken, `/api/v1/objects/service/${f.serviceId}`, {
      domainId: f.otherDomainId
    });
    expect(refused.status, refused.body).toBe(403);
    expect(detailOf(refused)).toContain("is governed here");
  });

  it("POST /plans/{id}/apply — the IaC twin, which a door-only fix would leave INERT (m2)", async () => {
    const f = await makeFixture("gm-iac");
    expect((await enableRung(f, f.domainId)).status).toBe(200);

    const manifest = (): Record<string, unknown> => ({
      manifest: {
        stackName: `gm-iac-${f.serviceId.slice(0, 8)}`,
        objects: [
          {
            urn: f.serviceUrn,
            typeId: "service",
            name: "gm-iac-movable",
            domainId: f.otherDomainId
          }
        ],
        relationships: []
      }
    });

    const plan = await call("POST", f.org.adminToken, "/api/v1/plans", manifest());
    expect(plan.status, plan.body).toBe(201);
    const refused = await call(
      "POST",
      f.operatorToken,
      `/api/v1/plans/${plan.json().id as string}/apply`
    );
    expect(refused.status, refused.body).toBe(403);
    expect(detailOf(refused)).toContain("is governed here");

    // The negative control: the SAME plan, applied by a principal that holds `governance:move`.
    const plan2 = await call("POST", f.org.adminToken, "/api/v1/plans", manifest());
    expect(plan2.status, plan2.body).toBe(201);
    const admitted = await call(
      "POST",
      f.administratorToken,
      `/api/v1/plans/${plan2.json().id as string}/apply`
    );
    expect(admitted.status, admitted.body).toBe(200);
  });

  it("POST /plans/{id}/apply — a `contains` RELATIONSHIP entry is the same move, both directions (m2b)", async () => {
    // THE SECOND IaC HOLE, found in review after the first round shipped: the twin had been added
    // to the object loop (route 1, `domainId`) and not to the relationship loop (route 2,
    // `contains`) — so an Operator could perform through apply the exact move `POST /relationships`
    // refuses them, and a manifest's `component.service` change compiles to precisely this pair of
    // entries. Remove ONLY the relationship-loop call and only this case goes red.
    const f = await makeFixture("gm-iac-rel");
    expect((await enableRung(f, f.domainId)).status).toBe(200);
    const stackName = `gm-iac-rel-${f.serviceId.slice(0, 8)}`;
    const manifest = (relationships: Record<string, unknown>[]): Record<string, unknown> => ({
      manifest: { stackName, objects: [], relationships }
    });
    const containsEntry = [
      { typeId: "contains", fromUrn: f.serviceUrn, toUrn: f.orphanComponentUrn }
    ];

    // CREATE — a move INTO the governed subtree.
    const plan = await call("POST", f.org.adminToken, "/api/v1/plans", manifest(containsEntry));
    expect(plan.status, plan.body).toBe(201);
    const refused = await call(
      "POST",
      f.operatorToken,
      `/api/v1/plans/${plan.json().id as string}/apply`
    );
    expect(refused.status, refused.body).toBe(403);
    expect(detailOf(refused)).toContain("is governed here");

    // Nothing applied: the edge is not there.
    const noEdge = await call(
      "GET",
      f.org.adminToken,
      `/api/v1/relationships?toId=${f.orphanComponentId}`
    );
    expect((noEdge.json() as { items: unknown[] }).items).toHaveLength(0);

    const plan2 = await call("POST", f.org.adminToken, "/api/v1/plans", manifest(containsEntry));
    expect(plan2.status, plan2.body).toBe(201);
    const admitted = await call(
      "POST",
      f.administratorToken,
      `/api/v1/plans/${plan2.json().id as string}/apply`
    );
    expect(admitted.status, admitted.body).toBe(200);

    // DELETE — the same stack re-applied WITHOUT the edge prunes it, which is a move OUT to the org
    // root. Equally governed, and the org root is not exempt.
    const prune = await call("POST", f.org.adminToken, "/api/v1/plans", manifest([]));
    expect(prune.status, prune.body).toBe(201);
    const refusedPrune = await call(
      "POST",
      f.operatorToken,
      `/api/v1/plans/${prune.json().id as string}/apply`
    );
    expect(refusedPrune.status, refusedPrune.body).toBe(403);
    expect(detailOf(refusedPrune)).toContain("is governed here");

    const prune2 = await call("POST", f.org.adminToken, "/api/v1/plans", manifest([]));
    expect(prune2.status, prune2.body).toBe(201);
    const prunedOk = await call(
      "POST",
      f.administratorToken,
      `/api/v1/plans/${prune2.json().id as string}/apply`
    );
    expect(prunedOk.status, prunedOk.body).toBe(200);
  });

  it("POST /discovery/accept (contains onto a PRE-EXISTING child) is a move and is refused (m9)", async () => {
    // The third caller-supplied-`typeId` relationship door. It reads like an import and is not one:
    // the proposal comes from the request body under `requireAuth`, and both endpoints resolve to
    // LIVE rows — so this is a move made by a real principal, not a replica following its authority.
    const f = await makeFixture("gm-discovery");
    expect((await enableRung(f, f.domainId)).status).toBe(200);

    const accept = (token: string, body: Record<string, unknown>): Promise<Response> =>
      call("POST", token, "/api/v1/discovery/accept", body);

    const refused = await accept(f.operatorToken, {
      proposal: {
        objects: [],
        relationships: [{ typeId: "contains", fromUrn: f.serviceUrn, toUrn: f.orphanComponentUrn }],
        bindings: []
      }
    });
    expect(refused.status, refused.body).toBe(403);
    expect(detailOf(refused)).toContain("is governed here");

    const admitted = await accept(f.administratorToken, {
      proposal: {
        objects: [],
        relationships: [{ typeId: "contains", fromUrn: f.serviceUrn, toUrn: f.orphanComponentUrn }],
        bindings: []
      }
    });
    expect(admitted.status, admitted.body).toBe(201);

    // THE CARVE-OUT, pinned as a SUCCESS so the refusals above cannot be mistaken for "discovery is
    // off under a rung": a child CREATED IN THIS SAME BATCH has no prior governance reach to leave,
    // so contaning it is a create, not a move — the same rule `createObject`'s rooting follows at
    // the other doors. An ordinary plugin proposal (new objects + their edges) keeps working for an
    // Operator under an enabled rung.
    const fresh = await accept(f.operatorToken, {
      proposal: {
        objects: [
          {
            typeId: "component",
            name: "gm-discovery-fresh",
            properties: {},
            urn: "proposal-local:fresh"
          }
        ],
        relationships: [
          { typeId: "contains", fromUrn: f.serviceUrn, toUrn: "proposal-local:fresh" }
        ],
        bindings: []
      }
    });
    expect(fresh.status, fresh.body).toBe(201);
    expect(
      (fresh.json() as { createdRelationshipIds: string[] }).createdRelationshipIds
    ).toHaveLength(1);
  });

  it("PUT /components/{idOrUrn}/service refuses an Operator under an enabled rung (m3)", async () => {
    const f = await makeFixture("gm-set-service");
    expect((await enableRung(f, f.domainId)).status).toBe(200);

    const refused = await call(
      "PUT",
      f.operatorToken,
      `/api/v1/components/${f.componentId}/service`,
      { service: f.otherServiceId }
    );
    expect(refused.status, refused.body).toBe(403);
    expect(detailOf(refused)).toContain("is governed here");

    const admitted = await call(
      "PUT",
      f.administratorToken,
      `/api/v1/components/${f.componentId}/service`,
      { service: f.otherServiceId }
    );
    expect(admitted.status, admitted.body).toBe(200);
  });

  it("POST /relationships (contains) and DELETE /relationships/{id} (contains) both refuse (m4)", async () => {
    const f = await makeFixture("gm-relationships");
    expect((await enableRung(f, f.domainId)).status).toBe(200);

    // CREATE — the moved object is the `to`, the destination is the `from`.
    const refusedCreate = await call("POST", f.operatorToken, "/api/v1/relationships", {
      typeId: "contains",
      fromId: f.serviceId,
      toId: f.orphanComponentId
    });
    expect(refusedCreate.status, refusedCreate.body).toBe(403);
    expect(detailOf(refusedCreate)).toContain("is governed here");

    const created = await call("POST", f.administratorToken, "/api/v1/relationships", {
      typeId: "contains",
      fromId: f.serviceId,
      toId: f.orphanComponentId
    });
    expect(created.status, created.body).toBe(201);

    // DELETE — the destination is the ORG ROOT (the child falls back to its `domain_id` route), and
    // the org root is NOT exempt here.
    const refusedDelete = await call(
      "DELETE",
      f.operatorToken,
      `/api/v1/relationships/${created.json().id as string}`
    );
    expect(refusedDelete.status, refusedDelete.body).toBe(403);
    expect(detailOf(refusedDelete)).toContain("is governed here");

    const deleted = await call(
      "DELETE",
      f.administratorToken,
      `/api/v1/relationships/${created.json().id as string}`
    );
    expect(deleted.status, deleted.body).toBe(200);
  });

  it("the org root as a DESTINATION is NOT exempt — unlike #244's object:write pair (m5)", async () => {
    // The one place this check deliberately disagrees with `containment-parent-authz.ts`'s two
    // exemptions. Those are proved from CUSTODY (the root's holders already hold every rooted row);
    // `governance:move` is about governance REACH, and moving a row out of a governed subtree up to
    // the org root is exactly the reach reduction it gates. Make the root exempt and only this case
    // goes red.
    const f = await makeFixture("gm-root-dest");
    expect((await enableRung(f, f.domainId)).status).toBe(200);

    const refused = await call("PATCH", f.operatorToken, `/api/v1/services/${f.serviceId}`, {
      domainId: f.org.orgId
    });
    expect(refused.status, refused.body).toBe(403);
    expect(detailOf(refused)).toContain("is governed here");
  });

  // ---------------------------------------------------------------------------------------------
  // THE LATTICE IS MONOTONE
  // ---------------------------------------------------------------------------------------------

  it("disabling a rung under an enabled UPPER rung is refused 409, naming it", async () => {
    const f = await makeFixture("gm-monotone");
    expect((await enableRung(f, f.org.orgId)).status).toBe(200); // the org rung
    expect((await enableRung(f, f.domainId)).status).toBe(200); // and one below it

    const refused = await call(
      "DELETE",
      f.org.adminToken,
      `/api/v1/governance/move-enforcement/rungs/${f.domainId}`
    );
    expect(refused.status, refused.body).toBe(409);
    expect(detailOf(refused)).toContain("above it");
    expect(detailOf(refused)).toContain("org");

    // Disabling at the ENABLING rung is allowed, and then the lower one can go too.
    const topOff = await call(
      "DELETE",
      f.org.adminToken,
      `/api/v1/governance/move-enforcement/rungs/${f.org.orgId}`
    );
    expect(topOff.status, topOff.body).toBe(200);
    const lowOff = await call(
      "DELETE",
      f.org.adminToken,
      `/api/v1/governance/move-enforcement/rungs/${f.domainId}`
    );
    expect(lowOff.status, lowOff.body).toBe(200);

    // …and the move is free again.
    const moved = await call("PATCH", f.operatorToken, `/api/v1/services/${f.serviceId}`, {
      domainId: f.otherDomainId
    });
    expect(moved.status, moved.body).toBe(200);
  });

  it("disabling a rung that was never enabled is a 404, not a monotone 409", async () => {
    const f = await makeFixture("gm-disable-404");
    const res = await call(
      "DELETE",
      f.org.adminToken,
      `/api/v1/governance/move-enforcement/rungs/${f.domainId}`
    );
    expect(res.status, res.body).toBe(404);
  });

  // ---------------------------------------------------------------------------------------------
  // THE INSTANCE RUNG — it ACTIVATES (owner decision Q1-A), and only an operator may set it
  // ---------------------------------------------------------------------------------------------

  it("the INSTANCE rung activates enforcement with NO org rung set, and no org can disable it (m6)", async () => {
    const f = await makeFixture("gm-instance");
    try {
      const set = await call(
        "PUT",
        f.org.adminToken,
        "/api/v1/instance/governance-move-enforcement",
        { enabled: true },
        { "x-scp-operator-token": OPERATOR_TOKEN }
      );
      expect(set.status, set.body).toBe(200);
      expect(set.json()).toMatchObject({ enabled: true });

      // No rung anywhere in this org — and the move is governed anyway. That is "activates", not
      // "permits": the M21 unlock precedent would have left this at 200.
      const refused = await call("PATCH", f.operatorToken, `/api/v1/services/${f.serviceId}`, {
        domainId: f.otherDomainId
      });
      expect(refused.status, refused.body).toBe(403);
      expect(detailOf(refused)).toContain("instance");

      // And an org rung below it cannot be turned off while it is on.
      expect((await enableRung(f, f.domainId)).status).toBe(200);
      const cannotDisable = await call(
        "DELETE",
        f.org.adminToken,
        `/api/v1/governance/move-enforcement/rungs/${f.domainId}`
      );
      expect(cannotDisable.status, cannotDisable.body).toBe(409);
      expect(detailOf(cannotDisable)).toContain("instance");
    } finally {
      await clearInstanceRung();
    }
  });

  it("the instance write is OPERATOR-only — the org's own admin token is refused without the header", async () => {
    // The NEGATIVE CONTROL is the case above: the identical request carrying the deployment operator
    // token succeeds. Without it a 403 would prove only that the route is broken.
    const f = await makeFixture("gm-instance-authz");
    const refused = await call(
      "PUT",
      f.org.adminToken,
      "/api/v1/instance/governance-move-enforcement",
      { enabled: true }
    );
    expect(refused.status, refused.body).toBe(403);

    const read = await call(
      "GET",
      f.org.adminToken,
      "/api/v1/instance/governance-move-enforcement"
    );
    expect(read.status, read.body).toBe(200);
    expect(read.json()).toMatchObject({ enabled: false, updatedAt: null });
  });

  it("RLS: a TENANT connection cannot write the instance table — the second barrier", async () => {
    // Barrier 1 is the missing grant, barrier 2 the missing write policy (drizzle/0079 §2). A
    // `scp_app` connection with the tenant GUC set must fail on INSERT even though it can SELECT.
    const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 1 });
    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE scp_app");
        await client.query("SELECT set_config('app.current_org_id', $1, true)", [
          "00000000-0000-0000-0000-000000000000"
        ]);
        const readable = await client.query(
          "SELECT count(*)::int AS n FROM governance_move_instance_rung"
        );
        expect(typeof readable.rows[0].n).toBe("number");
        await expect(
          client.query(
            "INSERT INTO governance_move_instance_rung (id, enabled) VALUES ('default', true)"
          )
        ).rejects.toThrow();
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    } finally {
      await pool.end();
    }
  });
});
