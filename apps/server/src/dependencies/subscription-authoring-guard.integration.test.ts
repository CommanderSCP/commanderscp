import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * THE GUARD IS WIRED — proven through the real HTTP routes, not by calling the function.
 *
 * `subscription-authoring-guard.test.ts` proves the guard DECIDES correctly. It cannot prove the
 * guard RUNS: it calls `assertEnforceableDependencySubscriptionScope` directly, so deleting its
 * installation leaves that whole suite green. Measured, not assumed — that mutation was applied and
 * the unit suite stayed at 649 passed (the count before this round's cases were added).
 *
 * That is this repo's documented "green for the wrong reason" class in its most ordinary form: a
 * correct component and an unpinned installation look identical from the component's own tests. So
 * this file exercises the policy routes themselves.
 *
 * THREE THINGS IT PINS, and each exists because it caught something:
 *
 *  1. ALL THREE VERBS. `typed-registries.ts` reaches the write path from POST, from
 *     PATCH-with-properties and from PUT. The first cut of this file used POST for all four cases,
 *     so a guard installed on only one of the three would have looked fully covered.
 *
 *  2. THE NARROWING. A policy carrying `group` AND `objectRef` is PERMITTED, because
 *     `matchPoliciesForTargets` records the `objectRef` match independently of the group branch —
 *     the policy contributes for every caller and the hazard is absent. The first cut refused it,
 *     which is a 400 telling the author to do exactly what they had already done.
 *
 *  3. THE OTHER COMPOSED CHECK, PROVEN BY A REFUSAL. `validateWrite` still runs
 *     `assertPolicyScopeWithinAuthority`. The first cut "proved" that by asserting a policy write
 *     SUCCEEDS — which cannot distinguish "the check ran and passed" from "the check was deleted",
 *     while this header claimed it proved the latter. It now asserts a refusal ONLY that check can
 *     produce (a service-scoped author declaring an org-wide scope → 403), which fails the moment
 *     the check is removed.
 *
 * The refusal itself no longer lives in the route — it moved to `graph/objects-repo.ts`'s
 * `createObject`/`updateObject` choke point; see `subscription-guard-write-doors.integration.test.ts`
 * for the three other doors that exposed why. This file stays route-level on purpose: the typed
 * `/policies` routes are the surface an author actually types at, and "the refusal reaches the wire
 * with its remedy intact" is a property of the whole stack, not of a repo function.
 */
describe("group-scoped dependency-subscription opt-outs are refused by the policy routes", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await buildTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  const groupOptOut = {
    scope: { group: "team-platform" },
    enforcement: "required",
    effects: [{ dependencySubscription: { enabled: false, coordinate: "acme-lib" } }]
  };

  async function postPolicy(org: TestOrg, name: string, properties: Record<string, unknown>) {
    return server.app.inject({
      method: "POST",
      url: "/api/v1/policies",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name, properties }
    });
  }

  /** Creates an ordinary, permitted policy and returns its id + urn, so PATCH/PUT have a subject. */
  async function seedPolicy(org: TestOrg, name: string): Promise<{ id: string; urn: string }> {
    const res = await postPolicy(org, name, {
      enforcement: "required",
      effects: [{ requireApprovals: { count: 1, fromRole: "Owner", scope: "organization" } }]
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { id: string; urn: string };
    return { id: body.id, urn: body.urn };
  }

  it("POST: REFUSES a group-scoped opt-out with 400, naming the remedy", async () => {
    const org = await createTestOrg(server, "dep-sub-guard-refuse");

    const res = await postPolicy(org, "group-scoped-opt-out", groupOptOut);

    expect(res.statusCode, res.body).toBe(400);
    // The remedy must reach the WIRE, not just the thrown object: the serializer drops anything the
    // route's response schema does not declare, so asserting on the body is what proves an author
    // actually sees it.
    expect(res.body).toMatch(/objectRef/);
  });

  it("PATCH: REFUSES the same document — a second verb reaches the same write path", async () => {
    const org = await createTestOrg(server, "dep-sub-guard-patch");
    const seeded = await seedPolicy(org, "patch-target");

    const res = await server.app.inject({
      method: "PATCH",
      url: `/api/v1/policies/${seeded.id}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { properties: groupOptOut }
    });

    // A PATCH that replaces `properties` is a full document write — `updateObject` replaces
    // wholesale — so an author blocked at POST could otherwise create an ordinary policy and edit
    // it into the refused shape one request later.
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toMatch(/objectRef/);
  });

  it("PUT: REFUSES the same document on the idempotent upsert-by-URN verb", async () => {
    const org = await createTestOrg(server, "dep-sub-guard-put");
    const seeded = await seedPolicy(org, "put-target");

    const res = await server.app.inject({
      method: "PUT",
      url: `/api/v1/policies/${encodeURIComponent(seeded.urn)}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "put-target", properties: groupOptOut }
    });

    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toMatch(/objectRef/);
  });

  it("PUT: REFUSES it on the CREATE branch too — no existing row to update", async () => {
    const org = await createTestOrg(server, "dep-sub-guard-put-create");

    // `upsertObjectByUrn` forks to `createObject` when no row holds the urn and to `updateObject`
    // when one does. Both forks are covered, because a guard installed on only one of them would
    // leave a door open that a single request can choose.
    const res = await server.app.inject({
      method: "PUT",
      url: `/api/v1/policies/${encodeURIComponent(`urn:scp:${org.orgId}:policy:never-seen`)}`,
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "never-seen", properties: groupOptOut }
    });

    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toMatch(/objectRef/);
  });

  it("PERMITS a group-scoped ENABLE — the negative control that keeps the guard narrow", async () => {
    const org = await createTestOrg(server, "dep-sub-guard-enable");

    const res = await postPolicy(org, "group-scoped-enable", {
      scope: { group: "team-platform" },
      enforcement: "required",
      effects: [{ dependencySubscription: { enabled: true, granularity: "patch" } }]
    });

    // Failing to match leaves it not-enabled, which is the safe direction — so there is nothing to
    // refuse. Without this case the refusal above is satisfied by a route that rejects every
    // group-scoped policy, or every dependencySubscription effect.
    expect(res.statusCode, res.body).toBe(201);
  });

  it("PERMITS the same opt-out at objectRef scope — the remedy the refusal advertises actually works", async () => {
    const org = await createTestOrg(server, "dep-sub-guard-objectref");

    const service = await server.app.inject({
      method: "POST",
      url: "/api/v1/services",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "svc-guard" }
    });
    expect(service.statusCode, service.body).toBe(201);

    const res = await postPolicy(org, "objectref-scoped-opt-out", {
      scope: { objectRef: service.json().id as string },
      enforcement: "required",
      effects: [{ dependencySubscription: { enabled: false, coordinate: "acme-lib" } }]
    });

    // If this failed, the error message would be advising authors toward a shape the server also
    // rejects — a remedy nobody can take is worse than no remedy.
    expect(res.statusCode, res.body).toBe(201);
  });

  it("PERMITS a group scope ALONGSIDE an objectRef — the over-broad refusal, fixed", async () => {
    const org = await createTestOrg(server, "dep-sub-guard-both-scopes");

    const service = await server.app.inject({
      method: "POST",
      url: "/api/v1/services",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "svc-both-scopes" }
    });
    expect(service.statusCode, service.body).toBe(201);

    const res = await postPolicy(org, "group-and-objectref-opt-out", {
      scope: { group: "team-platform", objectRef: service.json().id as string },
      enforcement: "required",
      effects: [{ dependencySubscription: { enabled: false, coordinate: "acme-lib" } }]
    });

    // `policy-resolve.ts` evaluates the scope kinds INDEPENDENTLY: the objectRef branch (:161-169)
    // records its match before the actor-dependent group branch (:183-193) is reached, so this
    // policy contributes for every caller regardless of membership. The hazard the refusal exists
    // for is absent, and refusing here told the author to add an objectRef they had already added.
    expect(res.statusCode, res.body).toBe(201);
  });

  it("still runs the OTHER composed check — a service-scoped author cannot declare an org-wide scope", async () => {
    const org = await createTestOrg(server, "dep-sub-guard-authority");

    const service = await server.app.inject({
      method: "POST",
      url: "/api/v1/services",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: "svc-narrow-authority" }
    });
    expect(service.statusCode, service.body).toBe(201);
    const serviceId = service.json().id as string;

    // `policy:write` at ONE service and nowhere else. Administrator is the built-in role that
    // carries `policy:write` (drizzle/0010 §6), bound at the service rather than at the org root.
    const narrow = await createTestUser(server, org, [{ role: "Administrator", scope: serviceId }]);

    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/policies",
      headers: { authorization: `Bearer ${narrow.token}` },
      payload: {
        name: "org-wide-from-a-narrow-author",
        // Written INSIDE the service, so the route's own `writePermission` check at the object's
        // resolved containment PASSES and the only thing left to refuse the request is the scope
        // binding. Without this the case would be satisfied by the ordinary RBAC check.
        domainId: serviceId,
        properties: {
          // Group scope = org-wide blast radius, so `assertPolicyScopeWithinAuthority` requires
          // `policy:write` AT THE ORG ROOT, which this author does not hold.
          scope: { group: "team-platform" },
          enforcement: "required",
          // Deliberately NO dependencySubscription effect: this case must be refusable ONLY by the
          // authority check. If it carried an opt-out, the failure could not be told apart from the
          // dependency guard firing, and the case would prove nothing about the composition.
          effects: [{ requireApprovals: { count: 1, fromRole: "Owner", scope: "organization" } }]
        }
      }
    });

    // ASSERTS A REFUSAL, NOT A SUCCESS. The previous version of this case asserted 201 and claimed
    // to prove the authority check still fires — but a deleted check produces 201 too, so it was
    // green for the wrong reason by construction. Deleting `assertPolicyScopeWithinAuthority` from
    // the composed `validateWrite` now turns this red.
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toMatch(/org-wide policy/);
  });

  it("leaves an ordinary group-scoped policy carrying no dependencySubscription effect alone", async () => {
    const org = await createTestOrg(server, "dep-sub-guard-unaffected");

    const res = await postPolicy(org, "ordinary-policy", {
      scope: { group: "team-platform" },
      enforcement: "required",
      effects: [{ requireApprovals: { count: 1, fromRole: "Owner", scope: "organization" } }]
    });

    expect(res.statusCode, res.body).toBe(201);
  });
});
