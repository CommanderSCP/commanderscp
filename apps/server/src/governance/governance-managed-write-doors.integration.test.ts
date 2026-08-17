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
import { objects } from "../db/schema.js";

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
 * WHAT THE CENSUS FOUND (M21.7; measured, not read)
 * ================================================================================================
 * Two doors were open, and both were open for the same reason: their type-refusal blocks were
 * written by censusing a DIFFERENT sibling guard (peer-bound config, pair-bound identity,
 * service membership), so the guard those censuses were modelled on — the governance one — is the
 * one neither census went looking for.
 *
 *   OVERLAY  `POST /api/v1/federation/overlays` — `object:write` at the org root, free-form
 *            `typeId`, free-form `properties`. Returned 201 for `{typeId:"policy", properties:
 *            {enforcement:"required", ...}}` posted by an Operator. Note that
 *            `assertPolicyOverlayOnlyAddsStrictness` never even ran: it is gated on base AND
 *            overlay both being `policy`, and the base here is a service.
 *   DISCOVERY `POST /api/v1/discovery/accept` — `object:write` at the org root, `typeId` taken
 *            from `request.body.proposal.objects[]`. Same 201, same Operator.
 *
 * Two remedies, because the two doors differ in whether the type must stay serviceable:
 *   - OVERLAY keeps serving `policy`: DESIGN §13's canonical overlay case IS "locally annotating a
 *     commander-distributed global policy", and `assertPolicyOverlayOnlyAddsStrictness` exists for
 *     exactly that. So overlay gets the PAIR of checks (1)+(2), which is what `routes/
 *     typed-registries.ts` and `iac/plans-repo.ts` both already run — not a type refusal.
 *   - DISCOVERY refuses the type outright, alongside its two existing sibling refusals: no
 *     discovery plugin proposes governance documents, a proposal carries no scope binding, and a
 *     refusal costs nothing that works today.
 *
 * ================================================================================================
 * WHAT THIS FILE ASSERTS
 * ================================================================================================
 * Every door in the census, INCLUDING the ones already closed — "listed as closed" is not
 * "measured closed", and the doors that were open here had been listed. Each refusal case asserts
 * the SPECIFIC violation (status + the reason in the detail) and that NOTHING was written; each
 * door also has a control proving the fix did not simply close the door.
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

  /** Live `policy` rows in this org with this name — the "nothing was written" assertion. */
  async function policyRowsByName(name: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx
        .select({ id: objects.id, properties: objects.properties })
        .from(objects)
        .where(
          and(
            eq(objects.orgId, org.orgId),
            eq(objects.typeId, "policy"),
            eq(objects.name, name),
            isNull(objects.deletedAt)
          )
        )
    );
  }

  async function post(url: string, token: string, payload: unknown) {
    return server.app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}` },
      payload: payload as Record<string, unknown>
    });
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
    expect(
      await withTenantTx(server.deps.db, org.orgId, (tx) =>
        tx
          .select({ id: objects.id })
          .from(objects)
          .where(
            and(
              eq(objects.orgId, org.orgId),
              eq(objects.typeId, "control"),
              eq(objects.name, name),
              isNull(objects.deletedAt)
            )
          )
      )
    ).toHaveLength(0);
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
});
