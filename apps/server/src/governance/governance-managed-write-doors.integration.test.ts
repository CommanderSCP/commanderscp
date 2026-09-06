import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { ScpApiError, ScpClient } from "@scp/sdk";
import {
  createOrphanComponent,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg,
  type TestUser
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { objects, roleBindings, roles } from "../db/schema.js";
import {
  GOVERNANCE_MANAGED_OBJECT_TYPE_IDS,
  PROJECTION_BOUND_OBJECT_TYPE_IDS
} from "./governance-managed-types.js";

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
 *  2 POST /discovery/accept                  REMOVED in increment 6 (ADR-0047) — the door is gone, not merely guarded
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
 *  - THE CENSUS ITSELF, by source scan (second `describe`, in three layers: the choke point's
 *    exported write surface, everything that writes the `objects` table at all, and every
 *    runtime-valued `typeId` handed to that surface). Nothing above goes red when a SIXTH door
 *    appears, and a census never re-run is the property behind every finding here. That describe
 *    also states what it still CANNOT see, because a completeness test that over-claims is worse
 *    than none — it stops the next person looking.
 *  - THE SCAN ITSELF, by a fourth case running the layer-3 walker over synthetic sources. That
 *    exists because round 1's statement of what the scan could not see was PROSE, and the prose was
 *    wrong: it claimed an unreadable call "fails safe by construction", and a one-line call proved
 *    otherwise the next day. What a scan can and cannot see is now a test, not a paragraph.
 *
 * ================================================================================================
 * MUTATIONS RUN (2026-08-18, the grant cases). Baseline: 7 passed. MEASURED, not predicted.
 * ================================================================================================
 * CASE NAMES ARE THE POST-REBASE ONES. These mutations were run against the M22 draft of this file,
 * where the grant cases were numbered DOOR 2b/2c/2d against a three-door scheme; they are named here
 * by the door they actually drive in THIS file's five-door scheme. The mapping is
 * 2b -> 4b, 2c -> 4c, 2d -> DOORS 1+5. Nothing was re-measured for the rename — only relabelled.
 *
 *   W-1  DELETE `assertScanOverrideGrantNotSelfDecided` from `createObject`
 *          -> 2 failed (DOOR 4b, DOORS 1+5). NOTE WHAT SURVIVED: DOOR 4 above stayed green, because
 *             it drives an `object:write`-only actor who is refused on AUTHORITY before the repo
 *             layer is reached. The permission mapping and the field guard are different defences
 *             and only one of them was ever tested.
 *   W-2  DELETE it from `updateObject`
 *          -> 1 failed (DOOR 4c), and only DOOR 4c. The update half is the strictly worse hole — it
 *             flips an already-DENIED grant to `approved` — and it has its own case for that reason.
 *   W-3  DELETE the explicit call in `federation/handfill-repo.ts`
 *          -> 1 failed (DOORS 1+5), and only that case. Hand-fill wears the `federationImport` flag
 *             that exempts the choke point, so it is the one door a choke-point install does NOT
 *             cover.
 *   W-4  the guard checks `status` but ignores the four bare decision fields
 *          -> 1 failed (DOOR 4b). `expiresAt` with no approval is a window nobody opened.
 *   W-5  the APPROVE route stops re-deriving standing (hardcoded `component` tier)
 *          -> 1 failed (DOOR 4b's trailing approve case). The raise route's check cannot cover a
 *             grant that never passed through the raise route.
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
  /**
   * A REAL, PAIRED commander peer for the hand-fill cases — and the fixture is load-bearing.
   *
   * These cases originally passed `peer: randomUUID()`, a peer that does not exist. `handFillObject`
   * runs `assertGovernanceAuthorityForHandFill` BEFORE `getPeerByIdOrName`, so the refusal under test
   * still fired — but the case's "nothing was written" half was VACUOUS: with no such peer the write
   * could not have happened whatever the guard did, and unwiring the guard turned the case red with
   * a 404 about the peer rather than letting the policy row land. Green (and red) for a reason
   * unrelated to what the case claims. With a real peer, the ONLY thing standing between the
   * request and a live org-wide `policy` row is the guard, which is the whole point of the case.
   */
  let handFillPeer: string;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "gov-doors");
    operator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    handFillPeer = await pairCommanderPeer();
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

  /**
   * ============================================================================================
   * M25.7 — THE THIRD ACTOR: EVERY PERMISSION THESE DOORS ASK FOR, EXCEPT `freeze:write`.
   * ============================================================================================
   * The two actors above make this file measure ONE bar for the WHOLE set — `object:write`-only
   * and `federation:write`-only are both refused everywhere, so the loops stay green no matter
   * what the doors do to an actor who clears the governance bar. That is exactly how M25.7's hole
   * survived a green suite: `freeze` was added to `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS`, which at
   * three of the five doors means "demand `policy:write` INSTEAD of `object:write`" — a permission
   * UPGRADE, not a refusal — and `policy:write` is neither of the two permissions a freeze needs.
   * A holder of it walked straight through `POST /plans`+apply, `/federation/overlays` and
   * `/federation/hand-fill` and minted a freeze that federates, blocks at every peer, and can be
   * lifted at neither end.
   *
   * WHY THIS ROLE IS BROADER THAN "`policy:write` AND NOTHING ELSE". An actor holding only
   * `policy:write` is refused at three of these doors by their own FRONT gates — `/overlays` and
   * `/objects/{type}` want `object:write`, `/hand-fill` wants `federation:write` — so a 403 would
   * prove nothing about the governance question, which is the vacuous shape this file exists to
   * avoid (see `handFillPeer`'s note). Permissions are monotone: an actor refused while holding
   * MORE is refused while holding less, so the strongest reachable actor is the sharpest test.
   * The one thing deliberately withheld is `freeze:write` — the permission the typed door demands
   * — plus, for the same reason, this role is bound at the org root where `freeze:write` would
   * have to sit to cover anything.
   *
   * Its non-vacuity control is the `(control)` case beside the property loop: this same actor is
   * still ADMITTED for a type whose bar genuinely IS `policy:write`, so the refusal is measured to
   * be about the TYPE and not about the actor.
   */
  async function createGovernanceNoFreezeUser(): Promise<TestUser> {
    const user = await createTestUser(server, org, [{ role: "Viewer", scope: org.orgId }]);
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const roleId = randomUUID();
      await tx.insert(roles).values({
        id: roleId,
        orgId: org.orgId,
        name: `governance-no-freeze-${randomUUID().slice(0, 8)}`,
        // Everything the five doors ask for at their own front gates, plus the governance bar the
        // three permission-remedy doors apply. NOT `freeze:write`, and NOT `freeze:override`.
        permissions: [
          "object:read",
          "object:write",
          "relationship:write",
          "policy:write",
          "federation:write"
        ]
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

  /** Pairs a `commander` peer, so a hand-fill can actually reach `upsertObjectByUrn`. */
  async function pairCommanderPeer(): Promise<string> {
    const domainId = randomUUID();
    const { publicKey } = generateKeyPairSync("ed25519");
    const res = await post("/api/v1/federation/peers", org.adminToken, {
      domainId,
      name: `gov-doors-cmdr-${domainId.slice(0, 8)}`,
      role: "commander",
      publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64")
    });
    expect(res.statusCode, res.body).toBe(201);
    return domainId;
  }

  /** A plain, non-governance base object for an overlay to annotate. */
  async function createBaseService(): Promise<string> {
    const res = await post("/api/v1/objects/service", org.adminToken, {
      name: `gov-doors-base-${randomUUID().slice(0, 8)}`
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }

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
  // DOOR 2 IS GONE — `POST /discovery/accept` was REMOVED in increment 6 (ADR-0047).
  //
  // Its three cases went with it. They proved that the import surface refused governance-managed
  // types outright rather than checking a permission, and they were the second of the two holes
  // this file was written for. That hole is now closed the strongest way available: THE DOOR DOES
  // NOT EXIST. Discovery proposes, and its output becomes IaC code a human commits — there is no
  // longer an observation-driven write path to smuggle a `policy` through.
  //
  // The remaining doors below still carry the invariant, and the enumeration further down (which
  // drives every governance-managed type against every door) lost one entry rather than one type,
  // so nothing about the type set went unchecked.
  //
  // Recorded rather than deleted quietly: this file's header counts the doors, and a reader who
  // finds four where the prose says five should learn why here.
  // -------------------------------------------------------------------------------------------

  // DOOR 3 — the generic `/objects/{type}` family. Listed as closed; MEASURED closed, all verbs.

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

  // DOOR 4 — IaC plan + apply. Listed as closed; MEASURED closed.

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
  // THE GRANT-SPECIFIC CASES, carried in from M22.6/D3 on the rebase onto main.
  //
  // They were written against this file's other draft, whose door numbering ran 1 objects-generic /
  // 2 IaC / 3 federation-import. This file numbers five doors differently, so the cases are
  // RENUMBERED to the doors they actually drive — an IaC case labelled `DOOR 2` here would name the
  // discovery-proposal door and send the next reader to the wrong module.
  // -------------------------------------------------------------------------------------------
  it("DOOR 4b: a policy:write HOLDER cannot mint an ALREADY-APPROVED grant through IaC — the permission mapping was never the defence", async () => {
    // ============================================================================================
    // THE HOLE THIS CLOSES
    // ============================================================================================
    // `writePermissionFor` maps a governance-managed type to `policy:write` at the resolved target
    // domain, and DOOR 2 above proves an `object:write`-only actor is refused. Nobody ever asked what
    // happens to an actor who HOLDS `policy:write` — a routine scoped policy-author binding, which is
    // exactly what an Administrator at a containment domain is. drizzle/0075's `property_schema` is
    // typed-but-OPEN (it must be: `import-repo.ts` Ajv-validates with no try/catch and one rejection
    // aborts a peer's whole signed bundle), so it accepts `status: "approved"` and a free-string
    // `expiresAt`. That actor could therefore apply an already-approved standing waiver with NO tier
    // check on the rule being waived, NO Decision, NO hash-chained audit event and NO future-expiry
    // validation — every guarantee of the override design, routed around a second door.
    //
    // The fix is NOT another permission: it is `assertScanOverrideGrantNotSelfDecided`, installed at
    // the `graph/objects-repo.ts` choke point every local write door funnels through.
    const server: ListeningTestServer = await listenTestServer({});
    try {
      const org: TestOrg = await createTestOrg(server, "gm-grant-iac");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      const domain = await admin.object("domain").create({ name: "payments" });
      const component = await createOrphanComponent(server, org, "payments-api");

      // A GENUINE `policy:write` HOLDER, scoped to that domain. Administrator is the role that
      // carries `policy:write` (see `governance/scan-declared-override-exclusions`'s O4).
      // `Viewer` at the org root supplies the `object:read` that `POST /plans` requires and NOTHING
      // else; `Administrator` — the role carrying `policy:write` (drizzle/0010) — is bound at the
      // DOMAIN only. That is the realistic shape: an author with policy authority over their own
      // subtree and none above it.
      const author = await createTestUser(server, org, [
        { role: "Viewer", scope: org.orgId },
        { role: "Administrator", scope: domain.id }
      ]);
      const client = new ScpClient({ baseUrl: server.baseUrl, token: author.token });

      const grantProperties = (status: string, extra: Record<string, unknown> = {}) => ({
        componentId: component.id,
        vulnerabilityId: "CVE-2024-3094",
        tierObjectId: domain.id,
        status,
        reason: "accepted",
        ...extra
      });

      const applyGrant = async (stackName: string, properties: Record<string, unknown>) => {
        const plan = await client.plans.create({
          stackName,
          objects: [
            {
              urn: `urn:scp:${stackName}:scan_override_grant:smuggled`,
              typeId: "scan_override_grant",
              name: `smuggled-${stackName}`,
              domainId: domain.id,
              properties
            }
          ],
          relationships: []
        });
        return client.plans.apply(plan.id);
      };

      // ANTI-VACUITY CONTROL, FIRST. The same actor, the same door, the same type — a `requested`
      // grant. It MUST go through: a grant that authorizes nothing is exactly the record ADR-0033
      // wants raised early, and refusing it would make this case pass for the wrong reason (namely
      // "this actor cannot use IaC on this type at all").
      const okStack = `gm-req-${randomUUID().slice(0, 8)}`;
      await applyGrant(okStack, grantProperties("requested"));
      const afterOk = await admin.object("scan_override_grant").list();
      expect(afterOk.items).toHaveLength(1);

      // ...and now the same manifest with the decision already made.
      for (const [label, properties] of [
        [
          "status: approved",
          grantProperties("approved", { expiresAt: "2999-01-01T00:00:00.000Z" })
        ],
        [
          "a bare future expiry",
          grantProperties("requested", { expiresAt: "2999-01-01T00:00:00.000Z" })
        ],
        ["a forged decider", grantProperties("requested", { decidedByActorId: author.objectId })]
      ] as const) {
        const stackName = `gm-grant-${randomUUID().slice(0, 8)}`;
        await applyGrant(stackName, properties as Record<string, unknown>).then(
          () => {
            throw new Error(`IaC apply must refuse a grant carrying ${label}`);
          },
          (err: unknown) => {
            expect(err, label).toBeInstanceOf(ScpApiError);
          }
        );
      }

      // ASSERT THE ROWS, not the statuses. A refusal that stored the object anyway would satisfy
      // three rejects and leave a live waiver in the graph.
      const stored = await admin.object("scan_override_grant").list();
      expect(stored.items).toHaveLength(1);
      expect(stored.items[0]?.properties).toMatchObject({ status: "requested" });
      expect(stored.items[0]?.properties).not.toHaveProperty("expiresAt");
      expect(stored.items[0]?.properties).not.toHaveProperty("decidedByActorId");

      // ...AND THE ONE THAT DID GET THROUGH CANNOT BE APPROVED EITHER. It names `payments` as its
      // tier while the component hangs off the org root, so `payments` is nowhere on that component's
      // containment chain. This is the case that proves the approve route RE-DERIVES standing rather
      // than inheriting the raise route's check: this grant never passed through the raise route at
      // all — it arrived through IaC — and a federated peer could deliver the same shape.
      await expect(
        admin.scanOverrideGrants.approve(stored.items[0]!.id, {
          expiresAt: "2999-01-01T00:00:00.000Z",
          reason: "approving a grant that names an off-chain authority"
        })
      ).rejects.toBeInstanceOf(ScpApiError);
      const afterApprove = await admin.object("scan_override_grant").list();
      expect(afterApprove.items[0]?.properties).toMatchObject({ status: "requested" });
    } finally {
      await server.close();
    }
  }, 120_000);

  it("DOOR 4c: the UPDATE half — IaC cannot flip an existing grant to approved either", async () => {
    // `updateObject` REPLACES `properties`, so the same door that could mint an approved grant could
    // also flip an already-DENIED one to `approved` — which the `decide` route explicitly refuses
    // ("only a 'requested' grant can be approved"). A guard installed only on the create half would
    // leave the strictly worse of the two open.
    const server: ListeningTestServer = await listenTestServer({});
    try {
      const org: TestOrg = await createTestOrg(server, "gm-grant-update");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      const component = await createOrphanComponent(server, org, "billing-api");
      const stackName = `gm-upd-${randomUUID().slice(0, 8)}`;
      const urn = `urn:scp:${stackName}:scan_override_grant:standing`;
      const base = {
        componentId: component.id,
        vulnerabilityId: "CVE-2024-3094",
        tierObjectId: org.orgId,
        reason: "accepted"
      };

      const apply = async (properties: Record<string, unknown>) => {
        const plan = await admin.plans.create({
          stackName,
          objects: [
            { urn, typeId: "scan_override_grant", name: `standing-${stackName}`, properties }
          ],
          relationships: []
        });
        return admin.plans.apply(plan.id);
      };

      await apply({ ...base, status: "requested" });
      await expect(
        apply({ ...base, status: "approved", expiresAt: "2999-01-01T00:00:00.000Z" })
      ).rejects.toBeInstanceOf(ScpApiError);

      const stored = await admin.object("scan_override_grant").list();
      expect(stored.items).toHaveLength(1);
      expect(stored.items[0]?.properties).toMatchObject({ status: "requested" });
    } finally {
      await server.close();
    }
  }, 120_000);

  it("DOORS 1+5: HAND-FILL and OVERLAY refuse a decided grant too — the census run filterlessly, not the two doors the docblock named", async () => {
    // The two doors a per-route install always misses, and the reason the guard lives at the choke
    // point. HAND-FILL is the sharper of the two: `handFillObject` stamps `federationImport`, which is
    // exactly the flag that exempts the choke point — so it inherits an exemption whose stated reason
    // ("a throw aborts a peer's whole signed bundle") is a statement about a CHANNEL that does not
    // exist on a local operator action. `handfill-repo.ts` therefore calls the guard for itself, and
    // this case is what proves it did. OVERLAY needs no special handling — `overlay-repo.ts` calls
    // `createObject` with no import flag — and is asserted anyway, because "needs no handling" is a
    // claim about today's code.
    const server: ListeningTestServer = await listenTestServer({});
    try {
      const org: TestOrg = await createTestOrg(server, "gm-grant-fed");
      const admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
      const component = await createOrphanComponent(server, org, "fed-api");
      const decided = {
        componentId: component.id,
        vulnerabilityId: "CVE-2024-3094",
        tierObjectId: org.orgId,
        status: "approved",
        reason: "accepted",
        expiresAt: "2999-01-01T00:00:00.000Z"
      };

      const peerDomainId = randomUUID();
      const { publicKey } = generateKeyPairSync("ed25519");
      await admin.federation.pair({
        domainId: peerDomainId,
        name: `cmdr-${peerDomainId.slice(0, 8)}`,
        role: "commander",
        publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64")
      });

      const handFilledUrn = `urn:scp:${org.orgId}:scan_override_grant:hand-filled`;
      await expect(
        admin.federation.handFill({
          peer: peerDomainId,
          typeId: "scan_override_grant",
          urn: handFilledUrn,
          name: "hand-filled-grant",
          properties: decided
        })
      ).rejects.toBeInstanceOf(ScpApiError);

      const base = await admin.services.create({ name: `svc-${randomUUID().slice(0, 8)}` });
      await expect(
        admin.federation.createOverlay({
          base: base.id,
          typeId: "scan_override_grant",
          name: "overlay-grant",
          urn: `urn:scp:${org.orgId}:scan_override_grant:overlay`,
          properties: decided
        })
      ).rejects.toBeInstanceOf(ScpApiError);

      expect((await admin.object("scan_override_grant").list()).items).toHaveLength(0);

      // CONTROL: the same hand-fill with `status: "requested"` goes through. Without it, the case
      // above is satisfied by a route that refuses every `scan_override_grant`, or that broke.
      const filled = await admin.federation.handFill({
        peer: peerDomainId,
        typeId: "scan_override_grant",
        urn: handFilledUrn,
        name: "hand-filled-grant",
        properties: { ...decided, status: "requested", expiresAt: undefined }
      });
      expect(filled.provenance).toBe("manual");
      const stored = await admin.object("scan_override_grant").list();
      expect(stored.items).toHaveLength(1);
      expect(stored.items[0]?.properties).toMatchObject({ status: "requested" });
    } finally {
      await server.close();
    }
  }, 120_000);

  it("CENSUS: the set's docblock NAMES the federation-import path — the door its previous version omitted", async () => {
    // Deliberately a source assertion and deliberately the ONLY one in this file. The behaviour of
    // door 3 is that it does NOT refuse, which is indistinguishable from "nobody wired the guard" by
    // observation alone — so the thing worth pinning is that the exemption is DOCUMENTED where the
    // next author will look, rather than being an omission they have to rediscover. Its behavioural
    // proof is `subscription-guard-write-doors.integration.test.ts`'s signed-bundle case.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("./governance-managed-types.ts", import.meta.url),
      "utf8"
    );
    expect(source).toContain("federation/import-repo.ts");
    expect(source).toContain("object_upsert");
  });

  it("DOOR 5: hand-fill is out of an Operator's reach entirely — it needs federation:write", async () => {
    const name = `handfill-escalation-${randomUUID().slice(0, 8)}`;
    const res = await post("/api/v1/federation/hand-fill", operator.token, {
      peer: handFillPeer,
      typeId: "policy",
      urn: `urn:scp:${org.orgId}:policy:${name}`,
      name,
      properties: ORG_WIDE_POLICY_PROPERTIES
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toMatch(/federation:write/);
    expect(await policyRowsByName(name)).toHaveLength(0);
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
    //
    // THE PEER IS REAL (`handFillPeer`), and that is the other half. With the nonexistent peer this
    // case shipped with, the "nothing was written" assertion below could not have failed whatever
    // the guard did — the write was unreachable regardless — and unwiring the guard turned the case
    // red with a 404 about the peer instead of letting the row land. Measured with the real peer:
    // deleting the `assertGovernanceAuthorityForHandFill` call from `handFillObject` fails this case
    // on `expected 201 to be 403`, with the org-wide `policy` row live in `objects`.
    // ============================================================================================
    const federationOnly = await createFederationOnlyUser();
    for (const typeId of GOVERNANCE_MANAGED_OBJECT_TYPE_IDS) {
      const name = `handfill-${typeId}-${randomUUID().slice(0, 8)}`;
      const res = await post("/api/v1/federation/hand-fill", federationOnly.token, {
        peer: handFillPeer,
        typeId,
        urn: `urn:scp:${org.orgId}:${typeId}:${name}`,
        name,
        properties: ORG_WIDE_POLICY_PROPERTIES
      });
      expect(res.statusCode, `${typeId}: ${res.body}`).toBe(403);
      // THE SPECIFIC VIOLATION, PER TYPE — and this assertion is where the one-bar-for-the-whole-set
      // assumption first became visible. Most governance-managed types are refused here for a
      // PERMISSION reason and the detail names `policy:write`. A PROJECTION-BOUND type (M25.7's
      // `freeze`) is refused for a TYPE reason, ahead of that check, and its detail names the typed
      // door instead — because `policy:write` was never the bar it should have had to clear. A
      // blanket `/policy:write/` here would have had to be satisfied by weakening the freeze
      // refusal back into a permission upgrade, which is the defect, so the expectation branches.
      expect(res.body).toMatch(
        PROJECTION_BOUND_OBJECT_TYPE_IDS.has(typeId) ? /projection-backed/ : /policy:write/
      );
      expect(await governanceRowsByName(typeId, name)).toHaveLength(0);
    }
  });

  it("DOOR 5 (control): an Administrator's policy hand-fill still lands the row", async () => {
    // Without this, DOOR 5 above is satisfied by refusing `policy` at hand-fill outright — which
    // would delete the feature's reason for existing (DESIGN §13: an air-gapped outpost with no
    // bundle transport keys in a commander-origin object by hand, and a commander-distributed
    // global policy is squarely that).
    //
    // This case used to name a peer that does not exist and assert only `not.toBe(403)` — satisfied
    // by the 404 the missing peer produces, i.e. by a hand-fill route that is broken for every
    // caller. With `handFillPeer` it asserts the write ACTUALLY COMPLETES, which is the claim the
    // control is making. `provenance: 'manual'` is asserted because that is what makes a later
    // signed bundle reconcile over the row (`handfill-repo.ts` module doc) — a 201 that stored an
    // ordinary locally-authored policy would be a different feature.
    const name = `handfill-authorized-${randomUUID().slice(0, 8)}`;
    const res = await post("/api/v1/federation/hand-fill", org.adminToken, {
      peer: handFillPeer,
      typeId: "policy",
      urn: `urn:scp:${org.orgId}:policy:${name}`,
      name,
      properties: ORG_WIDE_POLICY_PROPERTIES
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as { provenance?: string }).provenance).toBe("manual");
    expect(await policyRowsByName(name)).toHaveLength(1);
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

  interface Door {
    door: string;
    run: (typeId: string, name: string) => Promise<{ statusCode: number; body: string }>;
  }

  /**
   * EVERY door whose `typeId` comes from the request, driven by ONE caller's token.
   *
   * Parameterised on the actor (M25.7) rather than hardcoding `operator`/`federationOnly` inside
   * each entry, because the bar is per TYPE, not per door table: the same five doors have to be
   * driven by a second actor — one holding every permission they ask for except `freeze:write` —
   * and a copy of this table for that actor is a copy that goes stale when a sixth door lands.
   *
   * `handFillActorToken` is separate because DOOR 5's front gate is `federation:write`: the
   * `object:write`-only Operator cannot reach it at all, so the original property case handed it
   * the federation-only actor. An actor holding both drives the whole table with one token.
   */
  function doorsFor(token: string, handFillActorToken: string = token): Door[] {
    /**
     * THE PAYLOAD HAS TO BE WELL-FORMED FOR THE TYPE, OR THE REFUSAL IS NOT WHAT STOPPED IT.
     *
     * `ORG_WIDE_POLICY_PROPERTIES` is a `policy` document. Sent as a `freeze` it fails
     * `drizzle/0089`'s registered `required` list at Ajv, and every door answers 400 — which LOOKS
     * like a refusal and is not one: a caller who sends a well-formed freeze walks straight past a
     * schema that was never an authorization control. MEASURED: with the three
     * `isProjectionBoundObjectType` refusals deleted, this table sending the policy bag returned
     * 400 from `/overlays`, and sending the bag below returned 201 with a live `freeze` object.
     * The second is the escalation; only the second proves the guard.
     */
    const propertiesFor = (typeId: string): Record<string, unknown> =>
      typeId === "freeze"
        ? {
            // The five constitutive fields drizzle/0089 marks `required`, in the exact shapes
            // `governance/freeze-object.ts` writes them — `freezeId` and `scopeObjectId` as real
            // UUIDs (they become `uuid` columns at every receiving instance), the window as ISO
            // instants, ordered.
            freezeId: randomUUID(),
            scopeObjectId: org.orgId,
            name: "smuggled freeze",
            startsAt: new Date(Date.now() - 60_000).toISOString(),
            endsAt: new Date(Date.now() + 86_400_000).toISOString(),
            reason: "minted through a door that is not POST /api/v1/freezes",
            atomic: true
          }
        : ORG_WIDE_POLICY_PROPERTIES;
    return [
      {
        door: "POST /api/v1/federation/overlays",
        run: async (typeId, name) =>
          post("/api/v1/federation/overlays", token, {
            base: await createBaseService(),
            typeId,
            name,
            properties: propertiesFor(typeId)
          })
      },
      {
        door: "POST /api/v1/objects/{type}",
        run: (typeId, name) =>
          post(`/api/v1/objects/${typeId}`, token, {
            name,
            properties: propertiesFor(typeId)
          })
      },
      {
        door: "POST /api/v1/plans + /apply",
        run: async (typeId, name) => {
          const stackName = `gov-prop-${randomUUID().slice(0, 8)}`;
          const plan = await post("/api/v1/plans", token, {
            manifest: {
              stackName,
              objects: [
                {
                  urn: `urn:scp:${stackName}:${typeId}:smuggled`,
                  typeId,
                  name,
                  properties: propertiesFor(typeId)
                }
              ],
              relationships: []
            }
          });
          expect(plan.statusCode, plan.body).toBe(201);
          return post(`/api/v1/plans/${(plan.json() as { id: string }).id}/apply`, token, {});
        }
      },
      {
        door: "POST /api/v1/federation/hand-fill",
        run: (typeId, name) =>
          // A REAL peer: with a nonexistent one this door's `stored it anyway` check below is
          // unfalsifiable, because the write is unreachable whatever the guard does.
          post("/api/v1/federation/hand-fill", handFillActorToken, {
            peer: handFillPeer,
            typeId,
            urn: `urn:scp:${org.orgId}:${typeId}:${name}`,
            name,
            properties: propertiesFor(typeId)
          })
      }
    ];
  }

  it("PROPERTY: no door with a caller-supplied typeId writes a governance object without policy:write", async () => {
    const federationOnly = await createFederationOnlyUser();
    const doors = doorsFor(operator.token, federationOnly.token);

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

  // -------------------------------------------------------------------------------------------
  // THE SECOND PROPERTY (M25.7) — THE BAR IS PER TYPE, AND THE CASE ABOVE CANNOT SEE THAT.
  //
  // The loop above drives two actors who are refused everywhere, so it measures ONE bar for the
  // WHOLE set and stays green whatever the doors do to an actor who clears the governance bar.
  // That is precisely the gap M25.7 fell into: adding `freeze` to
  // `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS` makes two doors refuse it and instructs the other three to
  // demand `policy:write` — an UPGRADE, not a refusal — and `policy:write` is neither of the two
  // permissions a freeze actually requires. Measured before the fix: a holder of `policy:write` and
  // `federation:write`, with `freeze:write` NOWHERE, minted a federating freeze through
  // `POST /plans`+apply, `/federation/overlays` and `/federation/hand-fill`, with its declared
  // `scopeObjectId` bound to no authority at all and no `freezes` row at this instance — a block
  // that federates and cannot be lifted at either end.
  //
  // So the second property is stated over `PROJECTION_BOUND_OBJECT_TYPE_IDS` and the SAME door
  // table, with the strongest actor that still lacks the typed door's own permission.
  //
  // MUTATIONS RUN 2026-08-24, MEASURED not predicted. Baseline: 24 passed.
  //
  //   P-1  DELETE all three `isProjectionBoundObjectType` refusals (`iac/plans-repo.ts`,
  //          `federation/overlay-repo.ts`, `federation/handfill-repo.ts`)
  //          -> 1 failed, on the FIRST door in the table, with the object live in the response:
  //             "POST /api/v1/federation/overlays accepted a 'freeze' from an actor with no
  //              'freeze:write': {…"typeId":"freeze"…"originDomainId":"01a035ea-85f5-…"…}:
  //              expected 201 to be 403"
  //   P-2  DELETE only `iac/plans-repo.ts`'s
  //          -> "POST /api/v1/plans + /apply accepted a 'freeze' … "status":"applied" …
  //              expected 200 to be 403"
  //   P-3  DELETE only `federation/handfill-repo.ts`'s
  //          -> "POST /api/v1/federation/hand-fill accepted a 'freeze' … expected 201 to be 403"
  //
  // Each guard is therefore load-bearing on its own door, not covered by a sibling. Note what P-1
  // FIRST produced: with the door table still sending `ORG_WIDE_POLICY_PROPERTIES`, the un-guarded
  // overlay answered 400 from Ajv's `required` list, not 201 — a red test for a reason that is not
  // an authorization control at all. `propertiesFor` exists because of that measurement.
  // -------------------------------------------------------------------------------------------

  it("PROPERTY (per type): a projection-bound type is REFUSED at every caller-supplied-typeId door, even for an actor holding every permission those doors ask for", async () => {
    const governanceNoFreeze = await createGovernanceNoFreezeUser();
    // A GUARD ON THIS GUARD, like LAYER 0 below: a loop over an empty set passes vacuously.
    expect(
      [...PROJECTION_BOUND_OBJECT_TYPE_IDS].length,
      "PROJECTION_BOUND_OBJECT_TYPE_IDS is empty — this whole case would pass by looping zero times"
    ).toBeGreaterThanOrEqual(1);
    expect([...PROJECTION_BOUND_OBJECT_TYPE_IDS]).toContain("freeze");

    for (const { door, run } of doorsFor(governanceNoFreeze.token)) {
      for (const typeId of PROJECTION_BOUND_OBJECT_TYPE_IDS) {
        const name = `projbound-${randomUUID().slice(0, 8)}`;
        const res = await run(typeId, name);
        expect(
          res.statusCode,
          `${door} accepted a '${typeId}' from an actor with no '${typeId}:write': ${res.body}`
        ).toBe(403);
        expect(
          await governanceRowsByName(typeId, name),
          `${door} refused a '${typeId}' and stored it anyway`
        ).toHaveLength(0);
      }
    }
  });

  it("PROPERTY (per type, control): the SAME actor IS admitted for a type whose bar really is policy:write — so the refusal above is about the TYPE, not the actor", async () => {
    // ============================================================================================
    // WITHOUT THIS, THE CASE ABOVE IS SATISFIED BY AN ACTOR WHO CAN DO NOTHING.
    //
    // Every assertion up there is a 403, and a 403 is what a mis-provisioned role, a broken token
    // or a route-level front gate produces too. This case drives the two doors whose remedy is a
    // PERMISSION rather than a refusal (`/overlays` and `/hand-fill` — DESIGN §13 makes both
    // canonical for `policy`) with the identical token and requires a 201. So the pair together
    // says what the property actually claims: the doors distinguish `policy` from `freeze` by TYPE,
    // and this actor clears the governance bar for the one and is refused the other.
    //
    // The refusing door (`/objects/{type}`) has no such control by
    // construction — they refuse EVERY governance-managed type for every caller, which their own
    // DOOR cases above already pin.
    // ============================================================================================
    const governanceNoFreeze = await createGovernanceNoFreezeUser();

    const basePolicy = await post("/api/v1/policies", org.adminToken, {
      name: `gov-doors-perbar-base-${randomUUID().slice(0, 8)}`,
      properties: { enforcement: "advisory" }
    });
    expect(basePolicy.statusCode, basePolicy.body).toBe(201);
    const overlayName = `perbar-overlay-${randomUUID().slice(0, 8)}`;
    const overlay = await post("/api/v1/federation/overlays", governanceNoFreeze.token, {
      base: (basePolicy.json() as { id: string }).id,
      typeId: "policy",
      name: overlayName,
      properties: { enforcement: "required" }
    });
    expect(overlay.statusCode, `overlay: ${overlay.body}`).toBe(201);
    expect(await policyRowsByName(overlayName)).toHaveLength(1);

    const handFillName = `perbar-handfill-${randomUUID().slice(0, 8)}`;
    const handFill = await post("/api/v1/federation/hand-fill", governanceNoFreeze.token, {
      peer: handFillPeer,
      typeId: "policy",
      urn: `urn:scp:${org.orgId}:policy:${handFillName}`,
      name: handFillName,
      properties: ORG_WIDE_POLICY_PROPERTIES
    });
    expect(handFill.statusCode, `hand-fill: ${handFill.body}`).toBe(201);
    expect(await policyRowsByName(handFillName)).toHaveLength(1);
  });
});

/**
 * THE COMPLETENESS HALF OF THE CENSUS — the part that was missing, and the reason the two holes
 * existed at all.
 *
 * Every behavioural case above tests a door someone thought to list. Nothing above goes red when a
 * SIXTH door appears, and "a census written for a sibling guard, never re-run for this one" is
 * precisely how DOOR 1 and DOOR 2 shipped open. So the census itself is machine-checked, in three
 * layers, each of which fails by FILE NAME on the thing the layer below it cannot see:
 *
 *  LAYER 1 — THE CHOKE POINT'S EXPORTED SURFACE. `graph/objects-repo.ts` is where every local write
 *    lands, and layer 3's scan can only look for calls to functions it knows the names of. So the
 *    names are not hardcoded: this layer enumerates the module's exported callables and requires
 *    the set to equal a REVIEWED classification, then layer 3 builds its pattern from the entries
 *    classified `WRITE`. A new exported write wrapper there — the shape that used to be invisible,
 *    because the whole file was exempt and its internal delegation `input.typeId` was already an
 *    accepted expression — now fails here by name, and once classified `WRITE` every call site of
 *    it anywhere in the tree comes into layer 3's scan. The classification is not taken on trust
 *    either: every function that touches the `objects` table directly is DERIVED from the source
 *    and must be classified `WRITE`, so a direct writer cannot be filed as read-only.
 *
 *  LAYER 2 — RAW WRITES THAT SKIP THE CHOKE POINT ENTIRELY. Layers 1 and 3 are both anchored on
 *    `graph/objects-repo.ts`; a module that reached for drizzle (or raw SQL) against the `objects`
 *    table itself would be outside both. So every file that writes that table is enumerated and
 *    must equal a reviewed table, with the reason each non-choke-point one cannot mint a type.
 *
 *  LAYER 3 — THE DOORS. Every call to the choke point's write surface whose `typeId` argument is
 *    NOT a string literal — i.e. every site where the type is chosen at runtime — must equal a
 *    REVIEWED table. A new such call site anywhere fails with the file and the expression, which
 *    forces the governance question to be asked for it. The table is per SITE, not per expression:
 *    every entry carries `×<how many call sites in that file spell it that way>`, so a SECOND door
 *    in a file the census already lists is a diff even when it is spelled exactly like the first.
 *    That count is a round-2 repair; `scanRuntimeTypeIdWriteSites`'s own doc comment records what
 *    the `Set<string>` it replaced was measured hiding.
 *
 * A string literal is exempt because the type is then fixed at the call site: `createObject({typeId:
 * "component"})` can never produce a `policy` no matter what the request says. Everything else is in
 * the table, including the internal and import-channel sites, each with the reason it is safe —
 * "not listed" and "listed as safe" have to be different states or the table is just a filter.
 *
 * `deleteObject` IS one of the write names, and its absence was a hole: the scan used to name
 * `createObject`/`updateObject`/`upsertObjectByUrn` only, so a door that DELETED a governance object
 * with a caller-supplied `typeId` passed it silently. Removing a `required` policy is exactly as
 * governance-relevant as installing one. Adding it surfaced `iac/plans-repo.ts`'s apply-delete branch
 * (`entry.typeId`), which is accounted for below — `prepareApplyChecks` demands
 * `writePermissionFor(entry.typeId)` for every non-`noop` action, delete included.
 *
 * Deliberately NOT filtered to `routes/`: three of the five doors (`overlay-repo`, `handfill-repo`,
 * `plans-repo`) live under `federation/` and `iac/`, and a filter is where the next instance hides.
 *
 * ================================================================================================
 * WHAT THESE THREE LAYERS STILL CANNOT SEE — stated because a completeness test that over-claims is
 * worse than none, since it stops the next person looking.
 * ================================================================================================
 *  - WHETHER AN EXPRESSION IS CALLER-SUPPLIED. The scan reports the `typeId` EXPRESSION; only a
 *    human can say whether `OUTPOST_OBJECT_TYPE_ID` is a constant and `input.typeId` is a request
 *    field. That is the reviewing this test forces, not the reviewing it performs.
 *  - A CALL WHOSE `typeId` THE WALKER CANNOT RESOLVE. This bullet used to claim such a call "reads
 *    as the empty expression … so it FAILS rather than passing … fails safe by construction". THAT
 *    WAS FALSE, and false in the direction that matters. Measured on the real tree (2026-08-17, not
 *    argued — the walker was run against a mutated `graph/placements-repo.ts`): the old walker took
 *    the first `typeId:` LINE within 30 lines below the call, which need not have belonged to that
 *    call at all. A one-line `await deleteObject(tx, { ...base, typeId: input.typeId, idOrUrn })`
 *    inserted above the existing literal-typed delete resolved to `"placement"` — a literal,
 *    therefore skipped — and this describe stayed GREEN with a new caller-supplied door in the tree.
 *    The empty expression only occurred when no `typeId:` line at all appeared before the walk
 *    stopped; the same mutation moved 20 lines up, where nothing followed it, did go red.
 *    THE WALKER WAS FIXED RATHER THAN THE SENTENCE SOFTENED (`resolveTypeIdArgument`): it reads the
 *    call's OWN argument object, starting at the call itself so a single-line call is seen, with
 *    bracket-depth tracking so a nested object's `typeId` cannot be mistaken for the argument's. A
 *    matched call therefore has exactly two outcomes — its own `typeId` expression, or the literal
 *    `<no typeId found>`, which no reviewed table contains and which fails loudly. None of that is
 *    asserted in prose here: `LAYER 3 (self-test)` runs the walker over synthetic sources holding
 *    each spelling, so weakening it turns a NAMED case red.
 *  - A CALL THE WALKER NEVER MATCHES, which is the blind spot that remains. The write surface is
 *    found by NAME, so an aliased import (`import { createObject as mintObject }`) or a dynamic
 *    dispatch (`writers[kind](…)`) is invisible to all of layer 3 — not reported as unresolved,
 *    simply not seen. The self-test pins that as a known limit with a fixture, so it is a measured
 *    hole rather than a remembered one. LAYER 1 is the partial backstop: a new write surface AT the
 *    choke point still fails there by name, whatever its call sites are spelled like.
 *  - RELATIONSHIP writes, and every non-`objects` table. Out of scope: a `policy` is an object row.
 */
describe("policy:write door census: the CENSUS is complete (source scan, no DB)", () => {
  /**
   * LAYER 0 — A GUARD ON THE GUARD (M22.6, carried in on the rebase).
   *
   * Two cases above (`DOOR 3` and `PROPERTY`) are loops over `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS`.
   * A loop over an accidentally-empty — or accidentally-shrunk — set passes every one of its
   * assertions VACUOUSLY, which is this repo's second most reliable defect class (a test green for
   * the wrong reason). Pinning the membership means the set cannot quietly lose a member without a
   * red test.
   *
   * Naming the known members also makes an ADDITION visible in review. A fourth type is driven
   * against every door above automatically, which is the point of the loop — but a reader still
   * sees it arrive here rather than inferring it from a passing suite.
   */
  it("LAYER 0: the governance-managed set is non-empty and still holds the four known types", () => {
    const typeIds = [...GOVERNANCE_MANAGED_OBJECT_TYPE_IDS];
    expect(typeIds.length).toBeGreaterThanOrEqual(4);
    // `freeze` is M25.7's (owner decision D6): its graph object is the WIRE FORM of a freeze
    // window, rebuilt into a peer's `freezes` table on import, where it BLOCKS — so minting one
    // through a door that takes a caller-supplied `typeId` would stop releases in another security
    // domain on plain `object:write`. The count moved 3 -> 4 and this line is where the addition is
    // visible in review, which is what the docblock above says this case is for.
    expect(typeIds).toEqual(
      expect.arrayContaining(["policy", "control", "scan_override_grant", "freeze"])
    );
  });

  /**
   * LAYER 1's reviewed table: every exported callable of `graph/objects-repo.ts`, classified.
   *
   * `WRITE` entries become layer 3's scan pattern. Add an export to that module and this test names
   * it; classify it `WRITE` and every call site of it in the tree joins the door census.
   */
  const REVIEWED_OBJECTS_REPO_EXPORTS: Record<string, "WRITE" | "read-only"> = {
    // The four write doors of the choke point. All four touch the `objects` table directly, which
    // the test re-derives from the source rather than believing this table.
    createObject: "WRITE",
    updateObject: "WRITE",
    upsertObjectByUrn: "WRITE",
    deleteObject: "WRITE",
    // Readers and pure helpers — none of them can produce or amend a row.
    canonicalJson: "read-only",
    findObjectByIdOrUrnAnyType: "read-only",
    getObjectByIdOrUrn: "read-only",
    getObjectByIdOrUrnAnyType: "read-only",
    getOrgRootObjectId: "read-only",
    isUuid: "read-only",
    journalEntryKindFor: "read-only",
    listObjects: "read-only",
    resolveContainmentParent: "read-only",
    resolveDomainId: "read-only",
    toGraphObject: "read-only"
  };

  /** LAYER 2's reviewed table: file → why a write to the `objects` table there cannot mint a type. */
  const REVIEWED_OBJECT_TABLE_WRITERS: Record<string, string> = {
    "graph/objects-repo.ts": "the choke point itself — layers 1 and 3 are about exactly this file",
    // Sets `updated_at` on one existing campaign row for round-robin fairness. No insert, no
    // `type_id` in the `set`, and the row is selected by id.
    "coordination/campaign-reconcile.ts": "updatedAt bump on an existing row",
    // Clears `domain_local` / `domain_local_inherited_from` on one existing row (M20.7). Same shape.
    "federation/publish-domain-local.ts": "clears the domain-local columns on an existing row",
    // Sets `managed_by_stack` on rows an IaC apply DECLARES (drizzle/0068). Same shape as the two
    // above: no insert, no `type_id` in the `set`, and the rows are selected by an id list the
    // caller already resolved. It is a raw write on purpose — the column is not federated content
    // and must not allocate a journal sequence or a revision, so routing it through the choke point
    // would be wrong, not merely unnecessary.
    //
    // WHY IT IS SAFE IS NOT "IT CANNOT MINT A TYPE" ALONE — this column decides which rows an apply
    // DELETES, so being outside the choke point deserves the second sentence. It is unreachable from
    // any request: nothing in `objects-repo.ts`'s inputs, no route, and no schema can express it, so
    // it moves only when `iac/plans-repo.ts`'s apply moves it, on ids that apply already authorized
    // per entry. That is the entire point of moving stack ownership out of tenant-writable `labels`.
    "iac/stack-ownership.ts":
      "sets managed_by_stack on already-resolved ids; no insert, no type_id",
    // ADR-0045 D2a adoption: a signature-verified shared journal entry CONVERGES onto the
    // receiver's import-minted artifact anchor (same urn, different id) instead of being
    // skip-and-record-dropped forever. Sets originDomainId/revision/properties on ONE existing row
    // selected `FOR UPDATE` by (type_id = 'artifact', urn) — no insert, no `type_id` in the `set`,
    // and the row's type is pinned in the WHERE, so it cannot mint or retype anything. It is a raw
    // write on purpose: the choke point's update path allocates a fresh journal sequence and
    // revision, and adoption must take the PEER'S origin/revision verbatim (allocating our own
    // would make the adopted copy diverge from the very entry it adopts).
    "graph/artifacts-repo.ts":
      "D2a adoption: origin/revision/properties onto one urn-locked artifact row; no insert, no type_id",
    // Raw SQL, and the ONE instance of that class in the tree — listed rather than filtered out
    // precisely because a raw statement is what layers 1 and 3 are structurally blind to. It is a
    // developer load-generator (not wired into any route or worker) and its `type_id` is the SQL
    // literal `'service'`, so no caller chooses it.
    "load-test/graph-scale.ts": "raw bulk INSERT in the load generator, type_id literal 'service'"
  };

  /**
   * LAYER 3's reviewed table: file → the `typeId` expressions it passes to a write, with why.
   *
   * `×N` is the number of CALL SITES in that file spelling it that way, and it is part of the
   * assertion: a second site is a diff even when it reuses the first one's expression. Bump a count
   * only after asking the governance question of the NEW site — the reason it is written down.
   */
  const REVIEWED_RUNTIME_TYPEID_WRITE_SITES: Record<string, string[]> = {
    // ---- THE FOUR DOORS: `typeId` comes from the request body or path. -----------------------
    // DOOR 1 — `policy:write` at the org root (M21.7).
    "federation/overlay-repo.ts": ["input.overlayTypeId ×1"],
    // DOOR 2 WAS `routes/executors.ts`'s `proposedObject.typeId`, and it is GONE: increment 6
    // removed `POST /discovery/accept` (ADR-0047), taking the write site with it. This census
    // noticing the disappearance is the mechanism working — it fails on a site that appears OR
    // vanishes, because either changes the set of places a governance type could reach the graph.
    // Five doors became four; nothing was re-pointed.
    // DOOR 3 — governance types refused outright (`assertNotGovernanceManagedObjectType`), on every
    // verb including DELETE — which is what the four sites are: create, update, upsert-by-URN,
    // delete, all spelled `type`, and all four of them one entry until this table went per-site.
    "routes/objects-generic.ts": ["type ×4"],
    // DOOR 4 — `writePermissionFor` demands `policy:write` for every non-`noop` action, plus the
    // declared-scope binding on create/update. `entry.typeId` is the apply-DELETE branch;
    // `target.typeId` is the create and the update.
    "iac/plans-repo.ts": ["entry.typeId ×1", "target.typeId ×2"],
    // DOOR 5 — `policy:write` at the org root (M21.7).
    "federation/handfill-repo.ts": ["input.typeId ×1"],

    // ---- NOT DOORS: the type is runtime-valued but no CALLER chooses it. ---------------------
    // A fixed `typeId` per registry, closed over from `TypedRegistryConfig`; never a route param.
    // The governance registries ARE the legitimate door — they carry `writePermission:
    // 'policy:write'` and, for `policy`, `assertPolicyScopeWithinAuthority`. Four sites, one per
    // verb, the same shape as DOOR 3.
    "routes/typed-registries.ts": ["typeId ×4"],
    // The `OUTPOST_OBJECT_TYPE_ID` constant — a literal behind a name — at the create, the delete
    // and both updates.
    "federation/outposts-repo.ts": ["OUTPOST_OBJECT_TYPE_ID ×4"],
    // Journal replay. `typeId` comes from a signature- and chain-verified bundle, not a caller, and
    // `existing.typeId` is re-read from the row being updated. Deliberately exempt from local write
    // guards: `object_upsert` has no try/catch, so one refusal aborts a whole signed bundle
    // (ADR-0032 §6a). A hostile peer is a PAIRING problem, not a permission one.
    "federation/import-repo.ts": ["existing.typeId ×1", "typeId ×2"],
    // The choke point's own internal delegation: `upsertObjectByUrn` hands the input it was given to
    // `createObject` on the insert path and to `updateObject` on the replace path — hence ×2, both
    // inside that one function. NARROWED from the wholesale file exemption this used to be: only
    // these already-reviewed expressions are accepted, and layer 1 is what fires when a NEW write
    // surface appears in this file rather than a new expression inside an existing one.
    "graph/objects-repo.ts": ["input.typeId ×2"],
    // M22.6's typed grant routes — ADDED BY THIS CENSUS RATHER THAN BY THE AUTHOR, which is the
    // mechanism working. The routes landed and this layer went red on the next run; the entry below
    // is the review the redness demanded, not a suppression of it.
    //
    // NOT A DOOR, for the same reason `OUTPOST_OBJECT_TYPE_ID` is not: `SCAN_OVERRIDE_GRANT_TYPE_ID`
    // is a module constant — a literal behind a name — so no caller chooses this type. The ×2 are
    // the `createObject` at the RAISE route and the `updateObject` at the DECIDE route.
    //
    // AND THE PERMISSION SPLIT IS THE POINT OF THE PAIR, so it is recorded here where the next
    // reviewer will read it: the raise site authorizes `object:write` at the COMPONENT (raising a
    // `requested` grant authorizes nothing), while the decide site authorizes `policy:write` at the
    // grant's derived tier object, refuses a self-approval, and is the ONLY caller permitted to write
    // the five decision properties — `graph/objects-repo.ts` refuses `status`, `expiresAt`,
    // `decidedByActorId`, `decidedAt` and `decisionReason` at every other local door. A future edit
    // that let the raise site write those, or that let the decide site skip the tier check, would
    // leave this entry looking unchanged, which is why DOORS 4b/4c above assert the behaviour.
    "routes/scan-override-grants.ts": ["SCAN_OVERRIDE_GRANT_TYPE_ID ×2"],
    // M25.7's freeze wire form — ADDED BY THIS CENSUS RATHER THAN BY THE AUTHOR, the second time
    // the mechanism has worked: `governance/freeze-object.ts` landed and this layer went red on the
    // next run. The entry below is the review that redness demanded.
    //
    // NOT A DOOR, for the same reason `OUTPOST_OBJECT_TYPE_ID` and `SCAN_OVERRIDE_GRANT_TYPE_ID` are
    // not: `FREEZE_OBJECT_TYPE_ID` is a module constant — a literal behind a name — so no caller
    // chooses this type. The ×2 are `attachFreezeObject`'s `createObject` (minting the wire form of
    // a freeze the caller has ALREADY inserted into `freezes`) and `syncFreezeObject`'s
    // `updateObject` (re-snapshotting it after a lift or a window edit).
    //
    // THE GOVERNANCE QUESTION, ASKED AND ANSWERED, because that is what this table is for: a
    // `freeze` object federates and is rebuilt into a peer's `freezes` table where it BLOCKS, so
    // minting one through a weak door would stop releases in ANOTHER SECURITY DOMAIN on plain
    // `object:write`. `freeze` is therefore IN `GOVERNANCE_MANAGED_OBJECT_TYPE_IDS`, which is why
    // every behavioural case above now loops over it too.
    //
    // AND THAT WAS NOT ENOUGH, which is the correction this entry carries. The first version of
    // this note said membership "closes all five doors at once". It closes TWO. At the other three
    // (`POST /plans`+apply, `/federation/overlays`, `/federation/hand-fill`) membership means
    // "demand `policy:write` instead of `object:write`" — an UPGRADE, not a refusal — and
    // `policy:write` is neither of the permissions a freeze needs. `freeze` is therefore ALSO in
    // `PROJECTION_BOUND_OBJECT_TYPE_IDS`, which those three refuse outright; `PROPERTY (per type)`
    // above measures it with an actor holding every permission those doors ask for except
    // `freeze:write`, and its `(control)` sibling proves that actor is still admitted for `policy`.
    //
    // This module is reachable only from `POST /api/v1/freezes`, which authorizes `freeze:write` at
    // the freeze's own scope plus `federation:write` for the federating form — the latter on the
    // lift and window-edit verbs too, since both re-publish the object.
    "governance/freeze-object.ts": ["FREEZE_OBJECT_TYPE_ID ×2"]
  };

  /** `graph/objects-repo.ts` relative to the scan root — the anchor all three layers share. */
  const CHOKE_POINT = "graph/objects-repo.ts";

  /** The real tree, as `scanRuntimeTypeIdWriteSites` also takes it from the self-test's fixtures. */
  let sources: ScannedSource[];

  beforeAll(async () => {
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
    sources = await Promise.all(
      files.map(async (file) => ({
        rel: nodePath.relative(srcRoot, file),
        lines: (await readFile(file, "utf8")).split("\n")
      }))
    );
  });

  /** A comment line is not code; every layer skips them so prose cannot trip or silence a scan. */
  const isComment = (line: string) => {
    const t = line.trimStart();
    return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
  };

  /** One source file as a scan sees it: path relative to the scan root, and its lines. */
  type ScannedSource = { rel: string; lines: string[] };

  /** What LAYER 3 reports for a matched call whose `typeId` argument it could not resolve. */
  const NO_TYPEID = "<no typeId found>";

  /** How far past a call's first line the walker will look for the end of its argument list. */
  const CALL_WALK_LIMIT = 40;

  /**
   * Resolves the `typeId` ARGUMENT of the write call beginning at `lines[i]`, column `from`.
   *
   * It walks the call character by character, tracking bracket depth, and accepts a `typeId` key
   * only at the depth of the call's own argument object — `write(tx, { HERE })`. Two consequences,
   * both of them the point:
   *
   *  - it starts AT the call, so `write(tx, { orgId, typeId: input.typeId })` on one line is read;
   *  - a `typeId` in a NESTED object, or in a later unrelated statement, is not mistaken for it.
   *
   * The line-based walker this replaces did neither, and it did not fail when it missed — it took
   * the first `typeId:` line within 30 lines below the call, whoever's it was. Measured 2026-08-17:
   * a one-line `deleteObject(tx, { ...base, typeId: input.typeId, idOrUrn })` added to
   * `graph/placements-repo.ts` resolved to the `"placement"` literal of the NEXT call and was
   * dropped as a literal — a new caller-supplied door, and LAYER 3 green.
   *
   * When the argument object closes without a `typeId` (built elsewhere, spread in), the answer is
   * `NO_TYPEID`, which is in no reviewed table and so fails loudly. The one thing that gets past is
   * a call this never matches at all — see the self-test's `aliased-import.ts`.
   */
  function resolveTypeIdArgument(lines: string[], i: number, from: number): string {
    let depth = 0;
    let opened = false;
    /** Non-null once the `typeId:` key is found: the value being accumulated. */
    let value: string | null = null;
    let valueDepth = 0;
    for (let j = i; j < Math.min(i + CALL_WALK_LIMIT, lines.length); j += 1) {
      const line = lines[j]!;
      if (value !== null && j > i) value += " ";
      let k = j === i ? from : 0;
      while (k < line.length) {
        const ch = line[k]!;
        if (ch === "/" && line[k + 1] === "/") break;
        if (ch === '"' || ch === "'" || ch === "`") {
          // A quoted string is opaque: brackets and `//` inside it are text, not structure.
          const start = k;
          k += 1;
          while (k < line.length && line[k] !== ch) k += line[k] === "\\" ? 2 : 1;
          k += 1;
          if (value !== null) value += line.slice(start, k);
          continue;
        }
        const opens = ch === "(" || ch === "{" || ch === "[";
        const closes = ch === ")" || ch === "}" || ch === "]";
        if (value !== null) {
          // Reading the value: it ends at the `,` or `}` that is at ITS OWN depth, so
          // `typeId: pickType(a, b),` is one expression rather than two.
          if (opens) valueDepth += 1;
          else if (closes) {
            if (valueDepth === 0) return value.trim();
            valueDepth -= 1;
          } else if (ch === "," && valueDepth === 0) return value.trim();
          value += ch;
          k += 1;
          continue;
        }
        if (opens) {
          depth += 1;
          opened = true;
          k += 1;
          continue;
        }
        if (closes) {
          depth -= 1;
          k += 1;
          if (opened && depth <= 0) return NO_TYPEID; // the call closed and never named a type
          continue;
        }
        if (
          depth === 2 &&
          line.startsWith("typeId", k) &&
          !/[A-Za-z0-9_$]/.test(line[k - 1] ?? " ")
        ) {
          const after = line.slice(k + "typeId".length);
          const key = /^\s*:/.exec(after);
          if (key) {
            value = "";
            valueDepth = 0;
            k += "typeId".length + key[0].length;
            continue;
          }
          // `{ …, typeId, … }` — the shorthand, including as the last property of a line.
          if (/^\s*[,}]/.test(after) || after.trim() === "") return "typeId";
        }
        k += 1;
      }
    }
    return NO_TYPEID;
  }

  /**
   * LAYER 3's measurement, extracted from the test that uses it so the SELF-TEST can run it over
   * synthetic sources. Returns file → `<typeId expression> ×<call sites spelling it that way>`,
   * with string-literal types dropped (a literal cannot be chosen by a caller).
   *
   * PER SITE, NOT PER EXPRESSION. This collected into a `Set<string>` keyed on `(file, expression)`
   * until 2026-08-17, so a second unguarded write in an already-listed file, spelled like the first,
   * was invisible — measured by adding a whole extra `createObject(tx, { … typeId: input.typeId … })`
   * to `federation/handfill-repo.ts`, the very file whose door this census had just closed, and
   * watching LAYER 3 stay green. Thirteen of the tree's twenty-three write sites were hidden behind
   * ten deduped entries at the time.
   */
  function scanRuntimeTypeIdWriteSites(
    scanned: ScannedSource[],
    writeNames: string[]
  ): Record<string, string[]> {
    const writeCall = new RegExp(String.raw`\b(?:${writeNames.join("|")})\s*\(`);
    // A function's own DECLARATION is not a call site; without this the walker reads the parameter
    // list and reports noise like `string;` as a `typeId` expression.
    const writeDeclaration = new RegExp(
      String.raw`^\s*(?:export\s+)?(?:async\s+)?function\s+(?:${writeNames.join("|")})\s*\(`
    );
    const perFile = new Map<string, Map<string, number>>();
    for (const { rel, lines } of scanned) {
      for (let i = 0; i < lines.length; i += 1) {
        if (isComment(lines[i]!)) continue;
        if (writeDeclaration.test(lines[i]!)) continue;
        const call = writeCall.exec(lines[i]!);
        if (!call) continue;
        const expr = resolveTypeIdArgument(lines, i, call.index);
        if (/^"[a-z0-9-]+"$/.test(expr)) continue; // a literal type cannot be chosen by a caller
        const counts = perFile.get(rel) ?? new Map<string, number>();
        counts.set(expr, (counts.get(expr) ?? 0) + 1);
        perFile.set(rel, counts);
      }
    }
    return Object.fromEntries(
      [...perFile.entries()]
        .map(([rel, counts]) => [
          rel,
          [...counts.entries()].map(([expr, n]) => `${expr} ×${n}`).sort()
        ])
        .sort(([a], [b]) => (a as string).localeCompare(b as string))
    );
  }

  /**
   * LAYER 1's measurement, shared with layer 3: the choke point's exported callables, and which of
   * its top-level functions write the `objects` table directly.
   */
  function scanChokePoint(): { exported: Set<string>; directWriters: Set<string> } {
    const file = sources.find((s) => s.rel === CHOKE_POINT);
    expect(file, `${CHOKE_POINT} was not found by the scan — the anchor moved`).toBeDefined();
    const exported = new Set<string>();
    const directWriters = new Set<string>();
    let enclosing: string | null = null;
    for (const line of file!.lines) {
      const declared = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(line);
      if (declared) enclosing = declared[1]!;
      const exportedFn = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(line);
      if (exportedFn) exported.add(exportedFn[1]!);
      const exportedConst = /^export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)\b/.exec(line);
      if (exportedConst) exported.add(exportedConst[1]!);
      // `export { canonicalJson };` — a re-export is an exported surface like any other.
      const reExport = /^export\s*\{([^}]*)\}/.exec(line);
      if (reExport) {
        for (const part of reExport[1]!.split(",")) {
          const name = part
            .trim()
            .split(/\s+as\s+/)
            .pop()
            ?.trim();
          if (name) exported.add(name);
        }
      }
      if (!isComment(line) && /\.(?:insert|update|delete)\(objects\)/.test(line) && enclosing) {
        directWriters.add(enclosing);
      }
    }
    return { exported, directWriters };
  }

  const sortedNames = (names: Iterable<string>) => [...names].sort();

  it("LAYER 1: the choke point's exported surface is the reviewed one, and every direct writer is classified WRITE", () => {
    const { exported, directWriters } = scanChokePoint();

    // A NEW export here means a new write surface at the choke point — the case the whole-file
    // exemption used to swallow. Classify it in `REVIEWED_OBJECTS_REPO_EXPORTS`: `WRITE` puts every
    // call site of it into LAYER 3's scan, `read-only` states that it cannot produce a row.
    expect(sortedNames(exported)).toEqual(sortedNames(Object.keys(REVIEWED_OBJECTS_REPO_EXPORTS)));

    // And the classification is measured, not trusted: anything that touches the `objects` table
    // itself must be a `WRITE`, so a direct writer cannot be filed away as a reader.
    const misfiled = sortedNames(directWriters).filter(
      (name) => REVIEWED_OBJECTS_REPO_EXPORTS[name] !== "WRITE"
    );
    expect(
      misfiled,
      "these functions write the `objects` table but are not classified WRITE"
    ).toEqual([]);
    expect(
      directWriters.size,
      "no function in the choke point writes the `objects` table — the derivation is measuring nothing"
    ).toBeGreaterThan(0);
  });

  it("LAYER 2: nothing outside the reviewed set writes the objects table at all", () => {
    // Both other layers are anchored on `graph/objects-repo.ts`. A module that went straight at the
    // table — drizzle builder or raw SQL — would be outside both, so it is enumerated here.
    const tableWrite =
      /\.(?:insert|update|delete)\(objects\)|\b(?:insert\s+into|update|delete\s+from)\s+objects\b/i;
    const writers = new Set<string>();
    for (const { rel, lines } of sources) {
      for (const line of lines) {
        if (isComment(line)) continue;
        if (tableWrite.test(line)) writers.add(rel);
      }
    }
    expect(sortedNames(writers)).toEqual(sortedNames(Object.keys(REVIEWED_OBJECT_TABLE_WRITERS)));
  });

  it("LAYER 3: every runtime-valued typeId write site is one the census accounted for", () => {
    expect(
      sources.length,
      "the scan found no source files — it is not scanning anything"
    ).toBeGreaterThan(100);

    const { exported, directWriters } = scanChokePoint();
    // THE PATTERN IS DERIVED, NOT HARDCODED. Three names used to be spelled here, which is why
    // `deleteObject` was missing for as long as it was. The write surface comes from LAYER 1's
    // reviewed classification, unioned with anything measured to write the table — so even if the
    // classification were wrong, a direct writer still pulls its call sites into this scan.
    const writeNames = sortedNames(
      new Set([
        ...Object.entries(REVIEWED_OBJECTS_REPO_EXPORTS)
          .filter(([name, kind]) => kind === "WRITE" && exported.has(name))
          .map(([name]) => name),
        ...directWriters
      ])
    );
    expect(
      writeNames,
      "the derived write surface is empty — this scan would match nothing"
    ).not.toEqual([]);
    const normalize = (table: Record<string, string[]>) =>
      Object.fromEntries(
        Object.entries(table)
          .map(([f, s]) => [f, sortedNames(s)] as const)
          .sort(([a], [b]) => a.localeCompare(b))
      );
    // A NEW entry — a new file, a new expression, or a HIGHER `×N` on one already listed — means a
    // new write door whose type a caller may choose. Do not append it to the table: run the
    // governance question against it first (`isGovernanceManagedObjectType`: refuse the type, or
    // demand `policy:write`), then record the answer above.
    expect(normalize(scanRuntimeTypeIdWriteSites(sources, writeNames))).toEqual(
      normalize(REVIEWED_RUNTIME_TYPEID_WRITE_SITES)
    );
  });

  it("LAYER 3 (self-test): the walker sees each spelling of a write, and says so when it cannot", () => {
    // ============================================================================================
    // THE LAYER THAT WATCHES LAYER 3. Every claim this file makes about what the scan can and cannot
    // see is asserted HERE, against synthetic sources, because the alternative is a comment — and a
    // comment claiming this walker "fails safe by construction" is exactly what shipped in M21.7
    // round 1 and was measured false the next day. Weaken the walker and a NAMED case goes red.
    //
    // The KNOWN LIMIT at the bottom asserts the walker's actual, unhappy behaviour. It is a change
    // detector on purpose: improve the walker and it goes red, which is the prompt to move the limit
    // out of the header. What it must never become is silence.
    // ============================================================================================
    const src = (rel: string, lines: string[]): ScannedSource => ({ rel, lines });
    const fixtures: ScannedSource[] = [
      // The ordinary spelling, and the one every real door in the tree uses today.
      src("multi-line.ts", [
        "  const created = await createObject(tx, {",
        "    orgId: input.orgId,",
        "    typeId: input.typeId,",
        "    name: input.name",
        "  });"
      ]),
      // THE MUTATION THAT PROVED THE OLD CLAIM FALSE: the whole call on the call line. The old
      // walker started at the NEXT line and never looked here.
      src("same-line.ts", [
        "  await deleteObject(tx, { ...base, typeId: input.typeId, idOrUrn });"
      ]),
      src("same-line-shorthand.ts", ["  await createObject(tx, { orgId, typeId, name });"]),
      // A nested object's `typeId` is not the call's. The old walker took whichever came first.
      src("nested-literal-first.ts", [
        "  await createObject(tx, {",
        '    properties: mapProperties({ typeId: "service" }),',
        "    typeId: input.typeId,",
        "    name",
        "  });"
      ]),
      // The value is an expression containing a comma — one expression, not two.
      src("call-expression-value.ts", [
        "  await createObject(tx, {",
        "    typeId: pickType(input.a, input.b),",
        "    name",
        "  });"
      ]),
      // TWO sites, one expression: the `Set<string>` this replaced reported a single entry.
      src("two-sites.ts", [
        "  await createObject(tx, { orgId, typeId: input.typeId, name });",
        "  await createObject(tx, {",
        "    orgId,",
        "    typeId: input.typeId,",
        "    name",
        "  });"
      ]),
      // Not doors: a literal type, and a call that is only prose.
      src("literal.ts", [
        "  await createObject(tx, {",
        '    typeId: "component",',
        "    name",
        "  });"
      ]),
      src("commented-out.ts", ["  // await createObject(tx, { typeId: input.typeId });"]),
      // UNRESOLVED, both flavours: the argument object is built elsewhere, or spread in. Neither is
      // silently dropped — both report `NO_TYPEID`, which is in no reviewed table.
      src("built-elsewhere.ts", ["  await createObject(tx, buildInput(request));"]),
      src("spread-only.ts", ["  await createObject(tx, { ...buildInput(request) });"]),
      // KNOWN LIMIT: the write surface is matched BY NAME, so a rename at the import hides the call
      // from the scan entirely. LAYER 1 is the partial backstop — a new write surface at the choke
      // point fails there whatever its call sites look like — but a rename of an EXISTING one does
      // not, and this is where that hole is written down.
      src("aliased-import.ts", [
        "  import { createObject as mintObject } from '../graph/objects-repo.js';",
        "  await mintObject(tx, { orgId, typeId: input.typeId });"
      ])
    ];

    expect(scanRuntimeTypeIdWriteSites(fixtures, ["createObject", "deleteObject"])).toEqual({
      "multi-line.ts": ["input.typeId ×1"],
      "same-line.ts": ["input.typeId ×1"],
      "same-line-shorthand.ts": ["typeId ×1"],
      "nested-literal-first.ts": ["input.typeId ×1"],
      "call-expression-value.ts": ["pickType(input.a, input.b) ×1"],
      "two-sites.ts": ["input.typeId ×2"],
      "built-elsewhere.ts": [`${NO_TYPEID} ×1`],
      "spread-only.ts": [`${NO_TYPEID} ×1`]
      // `literal.ts`, `commented-out.ts` — correctly absent, no caller chooses those types.
      // `aliased-import.ts` — absent, and that one is the KNOWN LIMIT above, not a pass.
    });

    // AND THE OTHER HALF OF "fails loudly": reporting `NO_TYPEID` only fails LAYER 3 for as long as
    // no reviewed table has learned to accept it. The day someone silences an unresolvable site by
    // pasting it into the table instead of spelling the call so it can be read, this says so.
    expect(
      Object.entries(REVIEWED_RUNTIME_TYPEID_WRITE_SITES)
        .flatMap(([file, entries]) => entries.map((entry) => `${file}: ${entry}`))
        .filter((entry) => entry.includes(NO_TYPEID)),
      "an unresolvable write site was reviewed as acceptable — unresolvable no longer fails LAYER 3"
    ).toEqual([]);
  });
});
