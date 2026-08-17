import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg,
  type TestUser
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects, roleBindings, roles } from "../db/schema.js";
import { GOVERNANCE_MANAGED_OBJECT_TYPE_IDS } from "./governance-managed-types.js";

/**
 * THE `policy:write` DOOR CENSUS — every write door that takes a CALLER-SUPPLIED `typeId`.
 *
 * ================================================================================================
 * THE PROPERTY
 * ================================================================================================
 * `policy:write` is a DELIBERATELY SEPARATE permission from `object:write`: `0010_governance.sql`
 * grants it to Administrator and Owner only, while Operator and Approver hold `object:write` and
 * never `policy:write`. Two checks make that split mean something, and they are a PAIR — every
 * door that installs one must install the other:
 *
 *   (1) the permission itself — a `policy`/`control` write needs `policy:write`, not `object:write`
 *       (`governance/governance-managed-types.ts`'s `isGovernanceManagedObjectType`); and
 *   (2) `governance/policy-scope-authz.ts`'s `assertPolicyScopeWithinAuthority` — a policy's
 *       DECLARED `properties.scope` is bound to the author's own authority, so a component-scoped
 *       author cannot publish an org-wide policy (CRITICAL #1b).
 *
 * Any door that reaches `createObject`/`updateObject`/`upsertObjectByUrn` with a `typeId` the
 * CALLER chose can mint a `policy` — and a `policy` with no `scope` matches everything in the org
 * (`governance/policy-resolve.ts`'s `listPolicyCandidates` selects every live `policy` row and the
 * unscoped ones match every target). So an unguarded door of that shape is an org-wide governance
 * write handed to whoever holds plain `object:write`.
 *
 * ================================================================================================
 * THE FULL CENSUS (M21.7 — filterless, measured not read; recorded in ADR-0032 §6a)
 * ================================================================================================
 * FIVE doors take a `typeId` the caller chose. Three were wrong, and all three for the same reason:
 * their guard sets were assembled by censusing a DIFFERENT sibling (peer-bound config, pair-bound
 * identity, service membership), so the governance guard those censuses were modelled on is the one
 * none of them went looking for.
 *
 *  # DOOR                                    typeId from         BEFORE             AFTER (M21.7)
 *  1 POST /federation/overlays               body.typeId         object:write ONLY  + policy:write @org root
 *  2 POST /discovery/accept                  proposal.objects[]  object:write ONLY  + type refused outright
 *  3 {POST,PATCH,PUT,DELETE} /objects/{type} path param          type refused       unchanged (measured)
 *  4 POST /plans + /plans/{id}/apply         manifest.objects[]  policy:write+scope unchanged (measured)
 *  5 POST /federation/hand-fill              body.typeId         federation:write   + policy:write @org root
 *
 * DOORS 1 AND 2 WERE LIVE. An Operator — plain `object:write` at the org root, `policy:write`
 * nowhere — POSTed `{typeId:"policy", properties:{enforcement:"required", effects:[{requireApprovals:
 * {count:99, fromRole:"Owner", scope:"organization"}}]}}` and got 201 from each: twice over, a live
 * org-wide policy demanding an unmeetable quorum. On the overlay door
 * `assertPolicyOverlayOnlyAddsStrictness` never even ran — it is gated on base AND overlay both being
 * `policy`, and the base was a service.
 *
 * DOOR 5 WAS NOT LIVE, and closing it anyway is the point. `federation:write`
 * (`0012_federation.sql:218-219`) and `policy:write` (`0010_governance.sql:174-175`) both land on
 * Administrator and Owner, so nothing reachable through today's API holds one without the other —
 * safety by coincidence between two grant lists in two unrelated migrations, undone by a single
 * org-defined role. Its case below builds that role rather than trusting the accident.
 *
 * THREE REMEDIES, TWO SHAPES, chosen by whether the type must stay serviceable at that door:
 *   - OVERLAY and HAND-FILL keep serving `policy` and take the PERMISSION. DESIGN §13 makes both
 *     canonical: an overlay locally annotating a commander-distributed global policy, and an
 *     air-gapped outpost keying a commander-origin object in by hand. Refusing the type would delete
 *     the feature and leave `assertPolicyOverlayOnlyAddsStrictness` dead.
 *   - DISCOVERY refuses the TYPE, for every caller including one holding `policy:write`: no plugin
 *     proposes governance documents, and a proposal carries no scope for the binding to bind.
 *
 * Journal replay (`federation/import-repo.ts`) is deliberately NOT a door: `typeId` arrives from a
 * signature- and chain-verified bundle, and its `object_upsert` branch has no try/catch, so one
 * refusal aborts a whole signed bundle (ADR-0032 §6a). A hostile peer is a PAIRING problem.
 *
 * ================================================================================================
 * WHAT THIS FILE ASSERTS
 * ================================================================================================
 *  - EVERY door, including the ones already closed — "listed as closed" is not "measured closed",
 *    and the doors found open here had been listed. Each refusal case asserts the SPECIFIC violation
 *    (status + the named permission or type in the detail) and that NOTHING was written; each door
 *    with a permission remedy also has a control proving the fix did not simply close the door.
 *  - THE PROPERTY over the whole door table at once, and over `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS`
 *    rather than over today's two type names — because per-door cases are precisely how this
 *    survived: DOOR 2's block was censused for the peer-bound guard and never re-asked for this one,
 *    and DOOR 5 was "listed" by a case that only proved an Operator could not reach it.
 *  - THE CENSUS ITSELF, by source scan (second `describe`). Nothing above goes red when a SIXTH door
 *    appears, and a census never re-run is the property behind every finding here.
 */

/** An UNSCOPED, `required` policy: org-wide blast radius with an unmeetable approval quorum. */
const ORG_WIDE_POLICY_PROPERTIES = {
  enforcement: "required",
  effects: [{ requireApprovals: { count: 99, fromRole: "Owner", scope: "organization" } }]
} as const;

describe("policy:write door census: a caller-supplied typeId cannot mint governance objects (Testcontainers)", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  /** `object:write` + `relationship:write` at the org root, and NO `policy:write` anywhere. */
  let operator: TestUser;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "gov-doors");
    operator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  /** Live rows of a governance type in this org with this name — "nothing was written". */
  async function governanceRowsByName(typeId: string, name: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: objects.id, properties: objects.properties })
        .from(objects)
        .where(
          and(
            eq(objects.orgId, org.orgId),
            eq(objects.typeId, typeId),
            eq(objects.name, name),
            isNull(objects.deletedAt)
          )
        )
    );
  }

  const policyRowsByName = (name: string) => governanceRowsByName("policy", name);

  async function post(url: string, token: string, payload: unknown) {
    return server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>
    });
  }

  /**
   * A subject holding `federation:write` at the org root and NOT `policy:write` — the actor no
   * BUILT-IN role can express (both permissions land on Administrator and Owner and nowhere else),
   * built here through the org-defined-role mechanism `roles.org_id` exists for. This is the shape
   * that turns DOOR 5's coincidence into the overlay hole, so the guard is tested against it rather
   * than against the role table's current accident.
   */
  async function createFederationOnlyUser(): Promise<TestUser> {
    // Viewer, purely so the harness mints the auth row and a live token; `object:read` is not any
    // part of what is under test and grants no write anywhere.
    const user = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const roleId = randomUUID();
      await tx.insert(roles).values({
        id: roleId,
        orgId: org.orgId,
        name: `federation-only-${randomUUID().slice(0, 8)}`,
        permissions: ["federation:write"]
      });
      await tx.insert(roleBindings).values({
        id: randomUUID(),
        orgId: org.orgId,
        subjectId: user.objectId,
        roleId,
        scopeObjectId: org.orgId,
        effect: "allow"
      });
    });
    return user;
  }

  /** A plain, non-governance base object for an overlay to annotate. */
  async function createBaseService(): Promise<string> {
    const res = await post("/api/v1/objects/service", org.adminToken, {
      name: `gov-doors-base-${randomUUID().slice(0, 8)}`
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }

  // -------------------------------------------------------------------------------------------
  // DOOR 1 — the federation overlay. THE HOLE.
  // -------------------------------------------------------------------------------------------

  it("DOOR 1: an Operator cannot mint an org-wide policy through the overlay route", async () => {
    const base = await createBaseService();
    const name = `overlay-escalation-${randomUUID().slice(0, 8)}`;

    const res = await post("/api/v1/federation/overlays", operator.token, {
      base,
      typeId: "policy",
      name,
      properties: ORG_WIDE_POLICY_PROPERTIES
    });

    expect(res.statusCode, res.body).toBe(403);
    // The SPECIFIC violation: the missing permission, named. Not a count, not the prose.
    expect(res.body).toMatch(/policy:write/);
    expect(
      await policyRowsByName(name),
      "a refusal that still stored the row is not a refusal"
    ).toHaveLength(0);
  });

  it("DOOR 1 (control): an Administrator CAN still overlay a policy — the door did not close", async () => {
    // DESIGN §13's canonical overlay case is annotating a commander-distributed global policy, and
    // `assertPolicyOverlayOnlyAddsStrictness` exists only for policy-over-policy overlays. Without
    // this case, DOOR 1 above is satisfied by an overlay route that refuses `policy` outright.
    const basePolicy = await post("/api/v1/policies", org.adminToken, {
      name: `gov-doors-base-policy-${randomUUID().slice(0, 8)}`,
      properties: { enforcement: "advisory" }
    });
    expect(basePolicy.statusCode, basePolicy.body).toBe(201);
    const name = `overlay-legitimate-${randomUUID().slice(0, 8)}`;

    const res = await post("/api/v1/federation/overlays", org.adminToken, {
      base: (basePolicy.json() as { id: string }).id,
      typeId: "policy",
      name,
      properties: { enforcement: "required" }
    });

    expect(res.statusCode, res.body).toBe(201);
    expect(await policyRowsByName(name)).toHaveLength(1);
  });

  it("DOOR 1 (org-root authority): narrow policy:write does not carry — the guard asks at the ORG ROOT", async () => {
    // ============================================================================================
    // THIS CASE WAS RE-AIMED IN M21.7. It was written as "the overlay route also runs
    // `assertPolicyScopeWithinAuthority`", asserting `/org-wide policy/` — that string belongs to
    // that function — with a narrow Administrator (`Administrator` at one service, nothing at the
    // org root) as the actor. Both halves were wrong, and MEASURED wrong, not argued wrong:
    //
    //  1. That actor never reached either governance guard. The route's PRE-EXISTING org-root
    //     check refuses it first — observed detail: "subject '…' lacks 'object:write' at scope
    //     '<orgId>'". So the case was green-able by code that had no governance guard at all.
    //  2. `assertPolicyScopeWithinAuthority` would be INERT AS AUTHORIZATION on this path anyway,
    //     which is why `federation/overlay-repo.ts` deliberately does not call it. It has exactly
    //     two branches: the `scope.objectRef` branch wants `policy:write` at-or-above that object,
    //     and the broader branch (unscoped / selector / group) wants it at the org root. The
    //     overlay guard already demands org-root `policy:write`, and `authz/resolve.ts`'s
    //     `scope_expand` walks UPWARD from the checked scope — so an org-root grant satisfies a
    //     check at any descendant. Everyone who passes the overlay guard passes both branches.
    //     (Its one non-authorization behaviour, a 400 for a `scope.objectRef` that resolves to
    //     nothing, is not what this case was for; a dangling ref matches no target and fails safe.)
    //
    // What the case is now: the guard's SCOPE, which is the part of it a mutation can silently
    // weaken. Swap `scopeObjectId: input.orgId` in `createOverlay` for the base object's id and the
    // Operator case above stays green while this one goes red. The actor therefore holds
    // `object:write` AT THE ORG ROOT (so it clears the route check and actually reaches the guard)
    // and `policy:write` only at one service — authority to author governance SOMEWHERE, which is
    // not authority to author it at the org-root containment every overlay is created under.
    // ============================================================================================
    const base = await createBaseService();
    const narrowPolicyAuthor = await createTestUser(server, org, [
      { role: "Operator", scope: org.orgId },
      { role: "Administrator", scope: base }
    ]);
    const name = `overlay-narrow-authority-${randomUUID().slice(0, 8)}`;

    const res = await post("/api/v1/federation/overlays", narrowPolicyAuthor.token, {
      base,
      typeId: "policy",
      name,
      properties: ORG_WIDE_POLICY_PROPERTIES
    });

    expect(res.statusCode, res.body).toBe(403);
    // The SPECIFIC violation, and the part that distinguishes this case from the one above: the
    // refusal must name the permission AND that it is wanted at the organization root.
    expect(res.body).toMatch(/policy:write/);
    expect(res.body).toMatch(/organization root/);
    expect(await policyRowsByName(name)).toHaveLength(0);
  });

  it("DOOR 1 (control): a non-governance overlay still needs only object:write", async () => {
    // Without this, DOOR 1 is equally satisfied by an overlay route that demands `policy:write`
    // for EVERY type — which would break the feature for every ordinary annotation.
    const base = await createBaseService();
    const res = await post("/api/v1/federation/overlays", operator.token, {
      base,
      typeId: "service",
      name: `overlay-ordinary-${randomUUID().slice(0, 8)}`
    });
    expect(res.statusCode, res.body).toBe(201);
  });

  // -------------------------------------------------------------------------------------------
  // DOOR 2 — discovery accept. THE SECOND HOLE.
  // -------------------------------------------------------------------------------------------

  it("DOOR 2: an Operator cannot mint an org-wide policy through a hand-written discovery proposal", async () => {
    const name = `discovery-escalation-${randomUUID().slice(0, 8)}`;

    const res = await post("/api/v1/discovery/accept", operator.token, {
      proposal: {
        objects: [{ typeId: "policy", name, properties: ORG_WIDE_POLICY_PROPERTIES }],
        relationships: []
      }
    });

    expect(res.statusCode, res.body).toBe(403);
    // The SPECIFIC violation: the refused type is NAMED, and the reason is the governance gate.
    // `/policies/` alone would also be satisfied by the peer-bound refusal's prose.
    expect(res.body).toMatch(/'policy' objects/);
    expect(res.body).toMatch(/policy:write/);
    expect(await policyRowsByName(name)).toHaveLength(0);
  });

  it("DOOR 2 (control): an ordinary discovery proposal is still accepted", async () => {
    const name = `discovery-ordinary-${randomUUID().slice(0, 8)}`;
    const res = await post("/api/v1/discovery/accept", operator.token, {
      proposal: { objects: [{ typeId: "service", name }], relationships: [] }
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as { createdObjectIds: string[] }).createdObjectIds).toHaveLength(1);
  });

  it("DOOR 2: an ADMIN cannot smuggle one either — the type is refused, not the permission", async () => {
    // Discovery is an IMPORT surface: nothing discovers governance documents, and a proposal
    // carries no scope binding for `assertPolicyScopeWithinAuthority` to bind. So the refusal here
    // is about the TYPE and must hold for every caller, including one who legitimately holds
    // `policy:write`. If it is ever relaxed into a permission check, this case goes red.
    const name = `discovery-admin-${randomUUID().slice(0, 8)}`;
    const res = await post("/api/v1/discovery/accept", org.adminToken, {
      proposal: {
        objects: [{ typeId: "control", name, properties: { category: "security" } }],
        relationships: []
      }
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toMatch(/'control' objects/);
    // Nothing was written for the OTHER governance type either.
    expect(await governanceRowsByName("control", name)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------------------------
  // DOOR 3 — the generic `/objects/{type}` family. Listed as closed; MEASURED closed, all verbs.
  // -------------------------------------------------------------------------------------------

  it("DOOR 3: every write verb of /objects/{type} refuses the governance types", async () => {
    const cases: Array<{ method: "POST" | "PATCH" | "PUT" | "DELETE"; url: string }> = [
      { method: "POST", url: "/api/v1/objects/policy" },
      { method: "PATCH", url: `/api/v1/objects/policy/${randomUUID()}` },
      { method: "PUT", url: "/api/v1/objects/policy/urn:scp:x:policy:y" },
      { method: "DELETE", url: `/api/v1/objects/policy/${randomUUID()}` },
      { method: "POST", url: "/api/v1/objects/control" }
    ];
    for (const c of cases) {
      const res = await server.app.inject({
        method: c.method,
        url: c.url,
        headers: { authorization: `Bearer ${operator.token}` },
        payload: c.method === "DELETE" ? undefined : { name: "generic-door", properties: {} }
      });
      expect(res.statusCode, `${c.method} ${c.url}: ${res.body}`).toBe(403);
      expect(res.body).toMatch(/governance-managed/);
    }
  });

  // -------------------------------------------------------------------------------------------
  // DOOR 4 — IaC plan + apply. Listed as closed; MEASURED closed.
  // -------------------------------------------------------------------------------------------

  it("DOOR 4: IaC apply refuses an Operator's manifest that declares a policy, and writes nothing", async () => {
    const stackName = `gov-doors-${randomUUID().slice(0, 8)}`;
    const name = `iac-escalation-${randomUUID().slice(0, 8)}`;
    // `POST /plans` takes `{manifest: {...}}` (`CreatePlanRequestSchema`, packages/schemas/src/
    // iac.ts). Spelling the manifest fields at the top level made the route answer 400 for the
    // SHAPE, so the case never reached the door it names — red, but for the wrong reason.
    const plan = await post("/api/v1/plans", operator.token, {
      manifest: {
        stackName,
        objects: [
          {
            urn: `urn:scp:${stackName}:policy:smuggled`,
            typeId: "policy",
            name,
            properties: ORG_WIDE_POLICY_PROPERTIES
          }
        ],
        relationships: []
      }
    });
    expect(plan.statusCode, plan.body).toBe(201);

    const apply = await post(
      `/api/v1/plans/${(plan.json() as { id: string }).id}/apply`,
      operator.token,
      {}
    );
    expect(apply.statusCode, apply.body).toBe(403);
    expect(apply.body).toMatch(/policy:write/);
    expect(await policyRowsByName(name)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------------------------
  // DOOR 5 — federation hand-fill.
  // -------------------------------------------------------------------------------------------

  it("DOOR 5: hand-fill is out of an Operator's reach entirely — it needs federation:write", async () => {
    const res = await post("/api/v1/federation/hand-fill", operator.token, {
      peer: randomUUID(),
      typeId: "policy",
      urn: `urn:scp:${org.orgId}:policy:handfill-escalation`,
      name: `handfill-escalation-${randomUUID().slice(0, 8)}`,
      properties: ORG_WIDE_POLICY_PROPERTIES
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toMatch(/federation:write/);
  });

  it("DOOR 5: federation:write is not governance authority — a policy hand-fill still needs policy:write", async () => {
    // ============================================================================================
    // THE DOOR THE CENSUS FOUND OPEN WITHOUT AN ATTACKER TO WALK THROUGH IT (M21.7).
    //
    // The case above only shows an Operator cannot reach hand-fill at all. It says nothing about
    // the actor who CAN, and hand-fill takes a free-form `typeId` and free-form `properties` —
    // the overlay shape exactly. Before the fix it wrote a `policy` for anyone with
    // `federation:write`.
    //
    // No BUILT-IN role can demonstrate that, and the reason is the point: `federation:write` is
    // granted to Administrator and Owner (`0012_federation.sql:218-219`) and `policy:write` to
    // Administrator and Owner (`0010_governance.sql:174-175`) — the same two roles, so every actor
    // reachable through today's API who holds one holds the other. The door was safe by COINCIDENCE
    // between two grant lists in two unrelated migrations, with nothing holding them together;
    // `roles.org_id` exists for org-defined roles, and one of those with `federation:write` and no
    // `policy:write` is all it takes. This case builds exactly that role, so the guard is proven to
    // FIRE rather than merely to be present.
    // ============================================================================================
    const federationOnly = await createFederationOnlyUser();
    for (const typeId of GOVERNANCE_MANAGED_OBJECT_TYPE_IDS) {
      const name = `handfill-${typeId}-${randomUUID().slice(0, 8)}`;
      const res = await post("/api/v1/federation/hand-fill", federationOnly.token, {
        peer: randomUUID(),
        typeId,
        urn: `urn:scp:${org.orgId}:${typeId}:${name}`,
        name,
        properties: ORG_WIDE_POLICY_PROPERTIES
      });
      expect(res.statusCode, `${typeId}: ${res.body}`).toBe(403);
      expect(res.body).toMatch(/policy:write/);
      expect(await governanceRowsByName(typeId, name)).toHaveLength(0);
    }
  });

  it("DOOR 5 (control): an Administrator's policy hand-fill gets PAST the governance check", async () => {
    // Without this, DOOR 5 above is satisfied by refusing `policy` at hand-fill outright — which
    // would delete the feature's reason for existing (DESIGN §13: an air-gapped outpost with no
    // bundle transport keys in a commander-origin object by hand, and a commander-distributed
    // global policy is squarely that). The peer named here does not exist, so an authorized caller
    // must fail on the PEER, after the governance check, never with a 403 about `policy:write`.
    const name = `handfill-authorized-${randomUUID().slice(0, 8)}`;
    const res = await post("/api/v1/federation/hand-fill", org.adminToken, {
      peer: randomUUID(),
      typeId: "policy",
      urn: `urn:scp:${org.orgId}:policy:${name}`,
      name,
      properties: ORG_WIDE_POLICY_PROPERTIES
    });
    expect(res.statusCode, res.body).not.toBe(403);
    expect(res.body).not.toMatch(/policy:write/);
  });

  // -------------------------------------------------------------------------------------------
  // THE PROPERTY, ASSERTED ACROSS EVERY DOOR AT ONCE — not door by door.
  //
  // The cases above are per-door and each names its own reason, which is what makes a failure
  // readable. But per-door cases are exactly how this hole survived: DOOR 2 was censused for the
  // PEER-BOUND guard and never re-asked for the governance one, and DOOR 5 was listed with a case
  // that only proved an Operator could not reach it. So the property gets its own statement, over
  // the door table and over `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS` rather than over the two type
  // names we happen to have today — add a third governance type and this widens by itself.
  // -------------------------------------------------------------------------------------------

  it("PROPERTY: no door with a caller-supplied typeId writes a governance object without policy:write", async () => {
    const federationOnly = await createFederationOnlyUser();

    /** Every door whose `typeId` comes from the request, with the WEAKEST actor that reaches it. */
    const doors: Array<{
      door: string;
      run: (typeId: string, name: string) => Promise<{ statusCode: number; body: string }>;
    }> = [
      {
        door: "POST /api/v1/federation/overlays",
        run: async (typeId, name) =>
          post("/api/v1/federation/overlays", operator.token, {
            base: await createBaseService(),
            typeId,
            name,
            properties: ORG_WIDE_POLICY_PROPERTIES
          })
      },
      {
        door: "POST /api/v1/discovery/accept",
        run: (typeId, name) =>
          post("/api/v1/discovery/accept", operator.token, {
            proposal: {
              objects: [{ typeId, name, properties: ORG_WIDE_POLICY_PROPERTIES }],
              relationships: []
            }
          })
      },
      {
        door: "POST /api/v1/objects/{type}",
        run: (typeId, name) =>
          post(`/api/v1/objects/${typeId}`, operator.token, {
            name,
            properties: ORG_WIDE_POLICY_PROPERTIES
          })
      },
      {
        door: "POST /api/v1/plans + /apply",
        run: async (typeId, name) => {
          const stackName = `gov-prop-${randomUUID().slice(0, 8)}`;
          const plan = await post("/api/v1/plans", operator.token, {
            manifest: {
              stackName,
              objects: [
                {
                  urn: `urn:scp:${stackName}:${typeId}:smuggled`,
                  typeId,
                  name,
                  properties: ORG_WIDE_POLICY_PROPERTIES
                }
              ],
              relationships: []
            }
          });
          expect(plan.statusCode, plan.body).toBe(201);
          return post(
            `/api/v1/plans/${(plan.json() as { id: string }).id}/apply`,
            operator.token,
            {}
          );
        }
      },
      {
        door: "POST /api/v1/federation/hand-fill",
        run: (typeId, name) =>
          post("/api/v1/federation/hand-fill", federationOnly.token, {
            peer: randomUUID(),
            typeId,
            urn: `urn:scp:${org.orgId}:${typeId}:${name}`,
            name,
            properties: ORG_WIDE_POLICY_PROPERTIES
          })
      }
    ];

    for (const { door, run } of doors) {
      for (const typeId of GOVERNANCE_MANAGED_OBJECT_TYPE_IDS) {
        const name = `prop-${randomUUID().slice(0, 8)}`;
        const res = await run(typeId, name);
        expect(res.statusCode, `${door} accepted a '${typeId}': ${res.body}`).toBe(403);
        expect(
          await governanceRowsByName(typeId, name),
          `${door} refused a '${typeId}' and stored it anyway`
        ).toHaveLength(0);
      }
    }
  });
});

/**
 * THE COMPLETENESS HALF OF THE CENSUS — the part that was missing, and the reason the two holes
 * existed at all.
 *
 * Every behavioural case above tests a door someone thought to list. Nothing above goes red when a
 * SIXTH door appears, and "a census written for a sibling guard, never re-run for this one" is
 * precisely how DOOR 1 and DOOR 2 shipped open. So the census itself is machine-checked: scan the
 * server source for every call to `createObject`/`updateObject`/`upsertObjectByUrn` whose `typeId`
 * argument is NOT a string literal — i.e. every site where the type is chosen at runtime — and
 * require the result to equal a REVIEWED table. A new such call site anywhere fails this test with
 * the file and the expression, which forces the governance question to be asked for it.
 *
 * A string literal is exempt because the type is then fixed at the call site: `createObject({typeId:
 * "component"})` can never produce a `policy` no matter what the request says. Everything else is in
 * the table, including the internal and import-channel sites, each with the reason it is safe —
 * "not listed" and "listed as safe" have to be different states or the table is just a filter.
 *
 * Deliberately NOT filtered to `routes/`: three of the five doors (`overlay-repo`, `handfill-repo`,
 * `plans-repo`) live under `federation/` and `iac/`, and a filter is where the next instance hides.
 */
describe("policy:write door census: the CENSUS is complete (source scan, no DB)", () => {
  /** file → the `typeId` expressions it passes to a write, with why that site is accounted for. */
  const REVIEWED_RUNTIME_TYPEID_WRITE_SITES: Record<string, string[]> = {
    // ---- THE FIVE DOORS: `typeId` comes from the request body or path. -----------------------
    // DOOR 1 — `policy:write` at the org root (M21.7).
    "federation/overlay-repo.ts": ["input.overlayTypeId"],
    // DOOR 2 — governance types refused outright (M21.7).
    "routes/executors.ts": ["proposedObject.typeId"],
    // DOOR 3 — governance types refused outright (`assertNotGovernanceManagedObjectType`).
    "routes/objects-generic.ts": ["type"],
    // DOOR 4 — `writePermissionFor` demands `policy:write`, plus the declared-scope binding.
    "iac/plans-repo.ts": ["target.typeId"],
    // DOOR 5 — `policy:write` at the org root (M21.7).
    "federation/handfill-repo.ts": ["input.typeId"],

    // ---- NOT DOORS: the type is runtime-valued but no CALLER chooses it. ---------------------
    // A fixed `typeId` per registry, closed over from `TypedRegistryConfig`; never a route param.
    // The governance registries ARE the legitimate door — they carry `writePermission:
    // 'policy:write'` and, for `policy`, `assertPolicyScopeWithinAuthority`.
    "routes/typed-registries.ts": ["typeId"],
    // The `OUTPOST_OBJECT_TYPE_ID` constant — a literal behind a name.
    "federation/outposts-repo.ts": ["OUTPOST_OBJECT_TYPE_ID"],
    // Journal replay. `typeId` comes from a signature- and chain-verified bundle, not a caller, and
    // `existing.typeId` is re-read from the row being updated. Deliberately exempt from local write
    // guards: `object_upsert` has no try/catch, so one refusal aborts a whole signed bundle
    // (ADR-0032 §6a). A hostile peer is a PAIRING problem, not a permission one.
    "federation/import-repo.ts": ["typeId", "existing.typeId"],
    // The choke point itself plus its internal delegations — this is what the doors call.
    "graph/objects-repo.ts": ["", "input.typeId"]
  };

  it("every runtime-valued typeId write site is one the census accounted for", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const nodePath = await import("node:path");
    const srcRoot = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..");

    const files: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = nodePath.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist") continue;
          // `test-support` mints fixtures, not doors; `.test.ts` is not shipped code.
          if (entry.name === "test-support") continue;
          await walk(full);
        } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
          files.push(full);
        }
      }
    }
    await walk(srcRoot);
    expect(
      files.length,
      "the scan found no source files — it is not scanning anything"
    ).toBeGreaterThan(100);

    const writeCall = /\b(?:createObject|updateObject|upsertObjectByUrn)\s*\(/;
    const found: Record<string, Set<string>> = {};
    for (const file of files) {
      const lines = (await readFile(file, "utf8")).split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const trimmed = lines[i]!.trimStart();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
        if (!writeCall.test(lines[i]!)) continue;
        // Walk the argument object for its `typeId` — shorthand or `typeId: <expr>`.
        let expr = "";
        for (let j = i + 1; j < Math.min(i + 30, lines.length); j += 1) {
          if (/^\s*typeId,\s*$/.test(lines[j]!)) {
            expr = "typeId";
            break;
          }
          const m = /^\s*typeId:\s*(.+?),?\s*$/.exec(lines[j]!);
          if (m) {
            expr = m[1]!;
            break;
          }
          if (/^\s*\}\)/.test(lines[j]!)) break;
        }
        if (/^"[a-z0-9-]+"$/.test(expr)) continue; // a literal type cannot be chosen by a caller
        const rel = nodePath.relative(srcRoot, file);
        (found[rel] ??= new Set()).add(expr);
      }
    }

    const actual = Object.fromEntries(
      Object.entries(found)
        .map(([f, s]) => [f, [...s].sort()] as const)
        .sort(([a], [b]) => a.localeCompare(b))
    );
    const expected = Object.fromEntries(
      Object.entries(REVIEWED_RUNTIME_TYPEID_WRITE_SITES)
        .map(([f, s]) => [f, [...s].sort()] as const)
        .sort(([a], [b]) => a.localeCompare(b))
    );
    // A NEW entry here means a new write door whose type a caller may choose. Do not append it to
    // the table — run the governance question against it first (`isGovernanceManagedObjectType`:
    // refuse the type, or demand `policy:write`), then record the answer above.
    expect(actual).toEqual(expected);
  });
});
