import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { isNull } from "drizzle-orm";
import { roles } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { createObject } from "../graph/objects-repo.js";
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
 * STEP 3 — THE THREE PERMISSION SPLITS AND THE FIVE PURPOSE ROLES (role-model.md §5 step 3)
 * ================================================================================================
 *
 * `drizzle/0099` splits `secret:write`, `scan:override` and `change:accept` out of the two generic
 * write verbs, deletes `org:admin`, and seeds SecurityOfficer / FederationAdmin / OrgAdmin /
 * ServiceAdmin / ComponentAdmin. Two of those splits change who can do what on a live deployment,
 * and role-model.md §8.5 measured why that is dangerous here: all 334 `403` occurrences across
 * `apps/server`'s tests were enumerated and **zero** of them pinned any of the behaviour this
 * increment moves. So the splits would otherwise ship with nothing holding them to anything.
 *
 * EVERY CASE BELOW ENTERS AT THE ROUTE, through `app.inject`, with a real bearer token from the
 * real login flow, against real PostgreSQL. Asserting `hasPermission()` directly would prove the
 * resolver agrees with itself and say nothing about whether the door demands the permission — which
 * is precisely the failure class this repo keeps hitting (a component built and wired nowhere).
 *
 * ------------------------------------------------------------------------------------------------
 * THE PAIRING RULE THIS FILE FOLLOWS
 * ------------------------------------------------------------------------------------------------
 * Every refusal is paired with an ADMISSION on the same door with the same request body, differing
 * only in the actor's role. A lone 403 proves nothing — a typo'd URL, a schema rejection or a
 * missing fixture all produce one — and the pair is what says the ACTOR'S STANDING decided it.
 *
 * ------------------------------------------------------------------------------------------------
 * MUTATION LOG — each applied ALONE, measured, then reverted (2026-08-27)
 * ------------------------------------------------------------------------------------------------
 *  1. `routes/executors.ts` PUT /secrets/:key — `secret:write` -> `object:write`
 *       -> "the credential doors refuse org-root `object:write` alone" FAILED:
 *          `{"configured":true,"key":"cred-c76be3f0"}: expected 200 to be 403`.
 *  2. `routes/scan-override-grants.ts` `decide` — deleted the whole `scan:override` `authorize()`
 *       -> "DECIDING refuses a `policy:write`-only principal" FAILED: `expected 200 to be 403`,
 *          the body carrying `"status":"approved"` — the OrgAdmin really did sign the waiver.
 *  3. `routes/changes.ts` accept handler — `assertAcceptableAtEveryChangeTarget` ->
 *     `assertWritableAtEveryChangeTarget`
 *       -> "accept and rollback refuse an org-root `object:write` holder" FAILED:
 *          `expected 409 to be 403`, detail `illegal transition: 'proposed' -> 'accepted'` — i.e.
 *          the org-root Operator cleared authorization and reached the state machine.
 *  4. `routes/changes.ts` CANCEL handler — `assertWritableAtEveryChangeTarget` ->
 *     `assertAcceptableAtEveryChangeTarget`
 *       -> "CANCEL still works for exactly that principal" FAILED: `expected 403 to be 200`,
 *          detail `subject '<id>' lacks 'change:accept' at scope '<orgId>'`.
 *  5. `drizzle/0099` §1 — deleted the `array_remove(permissions, 'org:admin')` statement
 *       -> "`org:admin` is gone from Owner" FAILED:
 *          `expected [ 'approval:write', ...(22) ] to not include 'org:admin'`.
 *  6. `drizzle/0099` §2c — added `'Operator'` to the `change:accept` grant's name list
 *       -> "Operator and Approver deliberately do NOT hold `change:accept`" FAILED:
 *          `Operator: expected [ 'audit:read', 'change:accept', ...(7) ] to not include
 *          'change:accept'` — AND case 3 FAILED too (`expected 409 to be 403`). The seed half and
 *          the door half agreeing is what says they are the same fact.
 *  7. `drizzle/0099` §3C — added `'scan:override'` to OrgAdmin's permission literal
 *       -> "the separation of duty is real" FAILED:
 *          `expected [ 'approval:write', ...(17) ] to not include 'scan:override'` — AND
 *          "DECIDING refuses a `policy:write`-only principal" FAILED (`expected 200 to be 403`),
 *          which is the SoD claim and its enforcement measured as one thing.
 *
 * Each mutation was CONFIRMED APPLIED before its run, and confirmed REVERTED after — the migration
 * ones by re-reading the `.sql` off disk, the route ones by `git diff --stat` plus a call-site
 * count. A mutation that never landed is a false negative, and this programme has produced one.
 */
describe("RBAC permission splits + purpose roles (drizzle/0099)", () => {
  let server: TestServer;
  let org: TestOrg;

  /** Org-root `Operator`: holds `object:write` and NOT `secret:write` / `change:accept`. The
   *  principal both breaking changes are aimed at, and the reason they must be announced. */
  let operator: TestUser;
  /** Org-root `Administrator`: the LADDER control. 0099 grants it all three new permissions, so
   *  every case it appears in is a no-regression assertion, not a new capability. */
  let administrator: TestUser;
  /** Org-root `OrgAdmin`: `policy:write` and `secret:write` and `change:accept`, but deliberately
   *  NO `scan:override` — the separation of duty the whole design is built around. */
  let orgAdmin: TestUser;
  /** Org-root `SecurityOfficer`: `policy:write` + `scan:override`, and NO `object:write` and NO
   *  `secret:write`. The role the cumulative ladder cannot express. */
  let securityOfficer: TestUser;

  let componentId: string;
  /** Component-scoped `Operator` — `object:write` at the component and nothing wider. Raises scan
   *  override requests (which must keep working on `object:write`) and is never an approver. */
  let componentOperator: TestUser;
  /** Component-scoped `ComponentAdmin` — `object:write` AND `change:accept` at the component. */
  let componentAdmin: TestUser;

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  async function call(
    method: "GET" | "POST" | "PUT" | "DELETE",
    token: string,
    url: string,
    payload?: Record<string, unknown>
  ): Promise<LightMyRequestResponse> {
    const options: InjectOptions = { method, url, headers: bearer(token) };
    if (payload !== undefined) options.payload = payload;
    return server.app.inject(options);
  }

  /** Proposes a change as the org-root Owner, so the PROPOSE door is never what a case measures. */
  async function propose(targets: string[]): Promise<string> {
    const res = await call("POST", org.adminToken, "/api/v1/changes", {
      name: `split-${randomUUID().slice(0, 8)}`,
      targets
    });
    if (res.statusCode !== 201) throw new Error(`propose failed: ${res.statusCode} ${res.body}`);
    return (res.json() as { id: string }).id;
  }

  /** Raises a `requested` scan override grant at the ORG ROOT tier. The org root is on every
   *  component's containment chain, and `OVERRIDE_APPROVAL_TIER_FLOOR = 'org'` — so this is the
   *  only tier a graph object can name that a waiver is not inert at. */
  async function raiseGrant(): Promise<string> {
    const res = await call("POST", componentOperator.token, "/api/v1/scan-override-grants", {
      componentId,
      vulnerabilityId: `CVE-2026-${Math.floor(Math.random() * 90000 + 10000)}`,
      tierObjectId: org.orgId,
      reason: "raised by the component operator on object:write"
    });
    if (res.statusCode !== 201) throw new Error(`raise failed: ${res.statusCode} ${res.body}`);
    return (res.json() as { id: string }).id;
  }

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "rbac-splits");

    componentId = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const c = await createObject(tx, {
        orgId: org.orgId,
        typeId: "component",
        actorObjectId: org.orgId,
        requestId: "rbac-splits-setup",
        name: `comp-${randomUUID().slice(0, 8)}`
      });
      return c.id;
    });

    operator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);
    administrator = await createTestUser(server, org, [
      { role: "Administrator", scope: org.orgId }
    ]);
    orgAdmin = await createTestUser(server, org, [{ role: "OrgAdmin", scope: org.orgId }]);
    securityOfficer = await createTestUser(server, org, [
      { role: "SecurityOfficer", scope: org.orgId }
    ]);
    componentOperator = await createTestUser(server, org, [
      { role: "Operator", scope: componentId }
    ]);
    componentAdmin = await createTestUser(server, org, [
      { role: "ComponentAdmin", scope: componentId }
    ]);
  });

  afterAll(async () => {
    await server?.close();
  });

  // SPLIT 1 — `secret:write` SUBSTITUTES `object:write` at the three credential doors (§1.3d)

  it("the credential doors refuse org-root `object:write` alone — this is the breaking change", async () => {
    // THE PRINCIPAL IS THE ONE THE SPLIT EXISTS TO STOP: org-root `Operator`, which holds
    // `object:write` at the org root and therefore satisfied all three of these doors on every
    // deployment before 0099. Three unrelated blast radii shared that one grant — writing the
    // tokens SCP dials GitHub/ArgoCD/Terraform with, DELETING them (an availability kill switch for
    // all coordination), and rotating the HMAC secret that authenticates inbound webhooks, where
    // whoever sets it can thereafter forge signed source events.
    const key = `cred-${randomUUID().slice(0, 8)}`;
    const kind = `hook-${randomUUID().slice(0, 8)}`;

    const put = await call("PUT", operator.token, `/api/v1/secrets/${key}`, { value: "v" });
    expect(put.statusCode, put.body).toBe(403);
    // Named, not just refused: a 403 that says `object:write` would mean the SCOPE walk refused
    // them (a different bug entirely), and this case would pass while testing nothing it claims.
    expect(put.body).toContain("secret:write");

    const del = await call("DELETE", operator.token, `/api/v1/secrets/${key}`);
    expect(del.statusCode, del.body).toBe(403);
    expect(del.body).toContain("secret:write");

    const hook = await call(
      "PUT",
      operator.token,
      `/api/v1/change-sources/${kind}/webhook-secret`,
      { secret: "s" }
    );
    expect(hook.statusCode, hook.body).toBe(403);
    expect(hook.body).toContain("secret:write");
  });

  it("a `secret:write` holder is admitted at all three — the OrgAdmin and the ladder both", async () => {
    // The other half of every pair above: same doors, same bodies, only the actor differs. Run for
    // BOTH the new purpose role (proving 0099 §3C's literal reaches the door) and the ladder rung
    // (proving §2a's `array_append` did not regress a live deployment's Administrator).
    for (const actor of [orgAdmin, administrator]) {
      const key = `cred-${randomUUID().slice(0, 8)}`;
      const kind = `hook-${randomUUID().slice(0, 8)}`;

      const put = await call("PUT", actor.token, `/api/v1/secrets/${key}`, { value: "v" });
      expect(put.statusCode, put.body).toBe(200);

      const del = await call("DELETE", actor.token, `/api/v1/secrets/${key}`);
      expect(del.statusCode, del.body).toBe(204);

      const hook = await call("PUT", actor.token, `/api/v1/change-sources/${kind}/webhook-secret`, {
        secret: "s"
      });
      expect(hook.statusCode, hook.body).toBe(200);
    }
  });

  it("SecurityOfficer is refused credential custody — deliberately, not by omission", async () => {
    // role-model.md §3A: holding the org's outbound execution-system credentials is an OPERATIONS
    // act, not a compliance one. A security officer who could also rotate the tokens that reach
    // production would be inside the thing they audit. Pinned here so that "SecurityOfficer looks
    // under-powered, let us add secret:write" is a decision someone has to take deliberately.
    const key = `cred-${randomUUID().slice(0, 8)}`;
    const put = await call("PUT", securityOfficer.token, `/api/v1/secrets/${key}`, { value: "v" });
    expect(put.statusCode, put.body).toBe(403);
    expect(put.body).toContain("secret:write");
  });

  // SPLIT 2 — `scan:override` is ADDED to the decide door's `policy:write` (§1.3e, ruling D3)

  it("RAISING a scan override request still works on `object:write` at the component — no regression", async () => {
    // The half that must NOT change. A `requested` grant authorizes nothing until it is signed, so
    // gating the REPORT of a finding harder than the WAIVER of one would only stop the people who
    // know about it from saying so (role-model.md §1.3e). `componentOperator` holds `object:write`
    // at the component and no `policy:write` and no `scan:override` anywhere.
    const res = await call("POST", componentOperator.token, "/api/v1/scan-override-grants", {
      componentId,
      vulnerabilityId: "CVE-2026-11111",
      tierObjectId: org.orgId,
      reason: "raise must stay on object:write"
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as { status: string }).status).toBe("requested");
  });

  it("DECIDING refuses a `policy:write`-only principal — authoring a rule is no longer waiving it", async () => {
    // OrgAdmin holds `policy:write` at the org root, which authored scan ceilings at that tier and,
    // before 0099, was the ENTIRE authority to waive a finding against them. That is the textbook
    // separation-of-duty violation the route file itself conceded.
    const grantId = await raiseGrant();
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();

    const approve = await call(
      "POST",
      orgAdmin.token,
      `/api/v1/scan-override-grants/${grantId}/approve`,
      { expiresAt, reason: "org admin should not be able to sign this" }
    );
    expect(approve.statusCode, approve.body).toBe(403);
    expect(approve.body).toContain("scan:override");
    // And it is the SECOND bar that refused, not the first: OrgAdmin cleared `policy:write`. If the
    // split were ever written as a SUBSTITUTION the message would still say `scan:override` and
    // this case would still pass — so the `policy:write` half is pinned by its own case below.
    expect(approve.body).not.toContain("policy:write");
  });

  it("DECIDING admits a principal holding BOTH — SecurityOfficer, and the ladder's Administrator", async () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();

    // The new role. `securityOfficer` is not the raiser (`componentOperator` is), so the
    // raiser≠approver separation is satisfied for reasons unrelated to this split.
    const officerGrant = await raiseGrant();
    const byOfficer = await call(
      "POST",
      securityOfficer.token,
      `/api/v1/scan-override-grants/${officerGrant}/approve`,
      { expiresAt, reason: "signed by the security officer" }
    );
    expect(byOfficer.statusCode, byOfficer.body).toBe(200);
    expect((byOfficer.json() as { status: string }).status).toBe("approved");

    // The LADDER control — this is what makes the addition a behavioural no-op on every live
    // deployment. `policy:write` is held today by Administrator and Owner alone (drizzle/0010), and
    // 0099 §2b grants `scan:override` to exactly those two, so no in-flight waiver decision starts
    // 403ing on upgrade.
    const ladderGrant = await raiseGrant();
    const byAdministrator = await call(
      "POST",
      administrator.token,
      `/api/v1/scan-override-grants/${ladderGrant}/approve`,
      { expiresAt, reason: "the ladder still decides waivers" }
    );
    expect(byAdministrator.statusCode, byAdministrator.body).toBe(200);
  });

  it("DECIDING still demands `policy:write` too — the split ADDED a bar, it did not move one", async () => {
    // The direction the mutation log's case 2 cannot catch. `componentOperator` holds neither
    // permission, so it is refused on the FIRST bar and the message says `policy:write` — which is
    // the evidence that `scan:override` was added beside it rather than substituted for it. If a
    // later edit "simplified" the door down to `scan:override` alone, this goes red.
    const grantId = await raiseGrant();
    const deny = await call(
      "POST",
      componentOperator.token,
      `/api/v1/scan-override-grants/${grantId}/deny`,
      { reason: "the raiser has no standing to decide" }
    );
    expect(deny.statusCode, deny.body).toBe(403);
    expect(deny.body).toContain("policy:write");
  });

  it("DENY and REVOKE take the same two bars as APPROVE — taking a waiver back is never harder", async () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();

    const toDeny = await raiseGrant();
    expect(
      (
        await call("POST", orgAdmin.token, `/api/v1/scan-override-grants/${toDeny}/deny`, {
          reason: "policy:write alone must not deny either"
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await call("POST", securityOfficer.token, `/api/v1/scan-override-grants/${toDeny}/deny`, {
          reason: "the officer denies it"
        })
      ).statusCode
    ).toBe(200);

    const toRevoke = await raiseGrant();
    expect(
      (
        await call(
          "POST",
          securityOfficer.token,
          `/api/v1/scan-override-grants/${toRevoke}/approve`,
          {
            expiresAt,
            reason: "approve first so there is something to revoke"
          }
        )
      ).statusCode
    ).toBe(200);
    expect(
      (
        await call("POST", orgAdmin.token, `/api/v1/scan-override-grants/${toRevoke}/revoke`, {
          reason: "policy:write alone must not revoke"
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await call(
          "POST",
          securityOfficer.token,
          `/api/v1/scan-override-grants/${toRevoke}/revoke`,
          {
            reason: "the officer revokes it"
          }
        )
      ).statusCode
    ).toBe(200);
  });

  it("DENY refuses an already-approved grant — un-approving has exactly one path, `revoke`", async () => {
    // The state-machine bar, not an authority one: `securityOfficer` clears BOTH permission bars in
    // every call below. `approve` requires `requested` and `revoke` requires `approved`; `deny` used
    // to require nothing, so `approved -> denied` silently took a LIVE waiver away through the verb
    // that answers a request, skipping revoke's precondition and writing a transition no docblock in
    // the route describes.
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const grantId = await raiseGrant();
    expect(
      (
        await call(
          "POST",
          securityOfficer.token,
          `/api/v1/scan-override-grants/${grantId}/approve`,
          {
            expiresAt,
            reason: "approve first so there is something to deny"
          }
        )
      ).statusCode
    ).toBe(200);

    const deny = await call(
      "POST",
      securityOfficer.token,
      `/api/v1/scan-override-grants/${grantId}/deny`,
      { reason: "deny must not be a second way to un-approve" }
    );
    expect(deny.statusCode, deny.body).toBe(400);
    expect(deny.body).toContain("approved");
    expect(deny.body).toContain("revoke it instead");

    // And it is still `approved` — the refusal did not half-apply. Proven through the door rather
    // than a read: `revoke` demands `approved`, so a 200 here is the status assertion.
    const revoke = await call(
      "POST",
      securityOfficer.token,
      `/api/v1/scan-override-grants/${grantId}/revoke`,
      { reason: "the documented path to take it back" }
    );
    expect(revoke.statusCode, revoke.body).toBe(200);
  });

  // SPLIT 3 — `change:accept` is ADDED at every target of accept/rollback, and NOT to cancel

  it("accept and rollback refuse an org-root `object:write` holder — the intentional breakage", async () => {
    // `operator` is org-root `Operator`: `object:write` at the org root satisfies the WIDE arm of
    // the target check, so it accepted and rolled back EVERY change in the org before 0099. That
    // capability is deliberately removed — accepting a release into production is not the same
    // authority as editing the graph. It has to be ANNOUNCED, not discovered in a 403.
    const forAccept = await propose([componentId]);
    const accept = await call("POST", operator.token, `/api/v1/changes/${forAccept}/accept`, {});
    expect(accept.statusCode, accept.body).toBe(403);
    expect(accept.body).toContain("change:accept");
    // NOT a scope failure and NOT the `object:write` bar: they clear that one. If the two bars were
    // ever collapsed into one, this assertion is what notices.
    expect(accept.body).not.toContain("object:write");

    const forRollback = await propose([componentId]);
    const rollback = await call("POST", operator.token, `/api/v1/changes/${forRollback}/rollback`, {
      reason: "revert"
    });
    expect(rollback.statusCode, rollback.body).toBe(403);
    expect(rollback.body).toContain("change:accept");
  });

  it("CANCEL still works for exactly that principal — the boundary, and the easiest thing to get wrong", async () => {
    // THE SAME ACTOR, THE SAME CHANGE SHAPE, THE OTHER VERB. Cancelling STOPS a release rather than
    // authorizing one, so it deliberately stays on `object:write` alone. Folding it into
    // `change:accept` would make a cancel-only incident-responder role inexpressible — and that is
    // the role an on-call rota most obviously wants, which is why it is pinned beside the breakage
    // rather than in a file of its own.
    const changeId = await propose([componentId]);
    const cancel = await call("POST", operator.token, `/api/v1/changes/${changeId}/cancel`, {
      reason: "an operator can still stop a bad release"
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect((cancel.json() as { state: string }).state).toBe("cancelled");
  });

  it("a `change:accept` holder is admitted — ComponentAdmin at the component, and the ladder", async () => {
    // `proposed -> accepted` is not a legal edge, so once BOTH authority bars are cleared the
    // honest outcome is the state conflict. "409, not 403" is what says the door opened.
    const forComponentAdmin = await propose([componentId]);
    const byComponentAdmin = await call(
      "POST",
      componentAdmin.token,
      `/api/v1/changes/${forComponentAdmin}/accept`,
      {}
    );
    expect(byComponentAdmin.statusCode, byComponentAdmin.body).not.toBe(403);
    expect(byComponentAdmin.statusCode).toBe(409);

    // The ladder control: 0099 §2c grants `change:accept` to Administrator and Owner, so a
    // deployment that has not adopted the purpose roles keeps working at those two rungs.
    const forAdministrator = await propose([componentId]);
    const byAdministrator = await call(
      "POST",
      administrator.token,
      `/api/v1/changes/${forAdministrator}/accept`,
      {}
    );
    expect(byAdministrator.statusCode, byAdministrator.body).toBe(409);

    const forOwner = await propose([componentId]);
    const byOwner = await call("POST", org.adminToken, `/api/v1/changes/${forOwner}/accept`, {});
    expect(byOwner.statusCode, byOwner.body).toBe(409);
  });

  it("the `object:write` bar is still checked FIRST — a partial-authority refusal names the target", async () => {
    // ADDED, NEVER SUBSTITUTED, in the direction the case above cannot show. `componentAdmin` holds
    // both permissions at `componentId` and nothing at all at a SECOND component, so the
    // every-target `object:write` loop refuses first and names the target they lack. That ordering
    // is what keeps the refusal an operator sees for the ordinary case byte-identical to 2.5a's.
    const otherComponent = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const c = await createObject(tx, {
        orgId: org.orgId,
        typeId: "component",
        actorObjectId: org.orgId,
        requestId: "rbac-splits-setup",
        name: `comp-other-${randomUUID().slice(0, 8)}`
      });
      return c.id;
    });
    const changeId = await propose([componentId, otherComponent]);
    const res = await call("POST", componentAdmin.token, `/api/v1/changes/${changeId}/accept`, {});
    expect(res.statusCode, res.body).toBe(403);
    expect(res.body).toContain("object:write");
    expect(res.body).toContain(otherComponent);
  });

  // THE SEEDED DATA — asserted as SETS, so a later migration appending to the wrong role fails here

  describe("the roles table after drizzle/0099", () => {
    /** Every built-in role row (`org_id IS NULL`), name -> its permission SET and `bindable_at`. */
    async function builtins(): Promise<
      Map<string, { permissions: string[]; bindableAt: string[] | null }>
    > {
      const rows = await withTenantTx(server.deps.db, org.orgId, async (tx) =>
        tx
          .select({
            name: roles.name,
            permissions: roles.permissions,
            bindableAt: roles.bindableAt
          })
          .from(roles)
          .where(isNull(roles.orgId))
      );
      return new Map(
        rows.map((r) => [
          r.name,
          { permissions: [...r.permissions].sort(), bindableAt: r.bindableAt }
        ])
      );
    }

    it("the five purpose roles exist with EXACTLY role-model.md §3's permission sets", async () => {
      // SETS, sorted, compared with `toEqual` — not `toContain`. A containment assertion goes green
      // when a future migration appends a permission to the wrong role, which is the single most
      // likely way this design degrades: `array_append` targets by NAME and a typo'd name list is
      // invisible. Comparing the whole set makes any drift, in either direction, fail HERE.
      const table = await builtins();

      expect(table.get("SecurityOfficer")?.permissions).toEqual(
        [
          "audit:read",
          "federation:read",
          "freeze:write",
          "graph:query",
          "object:read",
          "policy:write",
          "relationship:read",
          "scan:override",
          "type_registry:read"
        ].sort()
      );
      expect(table.get("FederationAdmin")?.permissions).toEqual(
        [
          "audit:read",
          "federation:read",
          "federation:write",
          "graph:query",
          "object:read",
          "relationship:read",
          "type_registry:read"
        ].sort()
      );
      // `federation:pair` IS here, and its absence was a real bug this assertion caught. A first
      // draft of 0099 withheld it fail-closed because §3C's list omitted it while §4.1 and D4 both
      // granted it — the proposal contradicting itself. Owner ruling D6 (2026-08-27) resolved it in
      // D4's favour: FederationAdmin is the ONLY deliberate withholding, because operating a link is
      // not establishing one. Withholding it from OrgAdmin too would leave an org whose only pairing
      // principals are Owner and the D5-deprecated Administrator.
      //
      // NOT `scan:override`, and that is the design's whole separation of duty: OrgAdmin authors org
      // policy with `policy:write` and cannot waive a scan verdict, SecurityOfficer can waive and
      // holds no `object:write`, and neither is the other. Nor the three bypasses
      // (`freeze:override`, `change:emergency`, `campaign:deadline-override`).
      expect(table.get("OrgAdmin")?.permissions).toEqual(
        [
          "approval:write",
          "audit:read",
          "change:accept",
          "federation:pair",
          "federation:read",
          "federation:write",
          "freeze:write",
          "governance:move",
          "graph:query",
          "object:read",
          "object:write",
          "policy:write",
          "relationship:read",
          "relationship:write",
          "role_binding:write",
          "secret:write",
          "type_registry:read",
          "type_registry:write"
        ].sort()
      );
      expect(table.get("ServiceAdmin")?.permissions).toEqual(
        [
          "approval:write",
          "audit:read",
          "change:accept",
          "freeze:write",
          "governance:move",
          "graph:query",
          "object:read",
          "object:write",
          "policy:write",
          "relationship:read",
          "relationship:write",
          "type_registry:read"
        ].sort()
      );
      expect(table.get("ComponentAdmin")?.permissions).toEqual(
        [
          "approval:write",
          "audit:read",
          "change:accept",
          "freeze:write",
          "graph:query",
          "object:read",
          "object:write",
          "relationship:read",
          "relationship:write",
          "type_registry:read"
        ].sort()
      );
    });

    it("`bindable_at` is seeded exactly as §3 specifies, and NULL on the five ladder rungs", async () => {
      const table = await builtins();

      // Org root ONLY, and both are MECHANICAL rather than conventional:
      //  * SecurityOfficer — `OVERRIDE_APPROVAL_TIER_FLOOR = 'org'` and `tierForObjectType` maps no
      //    graph object above org, so a domain-bound officer would mint waivers that are approved,
      //    audited and INERT.
      //  * FederationAdmin — all 14 federation doors pass `scopeObjectId: auth.orgId`, so a
      //    narrower binding holds every permission and fails the SCOPE check on every door: a trap.
      expect(table.get("SecurityOfficer")?.bindableAt).toEqual(["organization"]);
      expect(table.get("FederationAdmin")?.bindableAt).toEqual(["organization"]);
      expect(table.get("OrgAdmin")?.bindableAt).toEqual(["organization"]);

      // ServiceAdmin at a DOMAIN is the same purpose at wider reach (route 1 of the scope walk
      // handles nested domains) — which is why no separate `DomainAdmin` is seeded.
      expect(table.get("ServiceAdmin")?.bindableAt).toEqual(["service", "domain"]);

      // `placement` and `deployment-target` are deliberately OFF ComponentAdmin: a
      // deployment-target binding reaches the PLACEMENTS at that target and NOT the components
      // placed there, so it would be a half-expressible "operator of prod" that reads as a bug.
      expect(table.get("ComponentAdmin")?.bindableAt).toEqual(["assembly", "component"]);

      // NULL = "any scope" on the ladder, which is their behaviour today and must stay so: the five
      // are bound at org roots, services and components across live deployments, and any non-NULL
      // value invented for them would retroactively make some of those bindings illegal.
      for (const name of ["Viewer", "Operator", "Approver", "Administrator", "Owner"]) {
        expect(table.get(name)?.bindableAt, name).toBeNull();
      }
    });

    it("`org:admin` is gone from Owner, and from every built-in row", async () => {
      const table = await builtins();
      expect(table.get("Owner")?.permissions).not.toContain("org:admin");
      const carriers = [...table.entries()]
        .filter(([, r]) => r.permissions.includes("org:admin"))
        .map(([name]) => name);
      expect(carriers).toEqual([]);
    });

    it("the legacy ladder carries the three new permissions — Administrator and Owner only", async () => {
      const table = await builtins();
      for (const permission of ["secret:write", "scan:override", "change:accept"]) {
        const carriers = [...table.entries()]
          .filter(([, r]) => r.permissions.includes(permission))
          .map(([name]) => name)
          .sort();
        const ladder = carriers.filter((n) =>
          ["Viewer", "Operator", "Approver", "Administrator", "Owner"].includes(n)
        );
        expect(ladder, permission).toEqual(["Administrator", "Owner"]);
      }
    });

    it("Operator and Approver deliberately do NOT hold `change:accept` or `secret:write`", async () => {
      // The intentional breakage, pinned at the source of it as well as at the door. Both rungs
      // hold `object:write` and could accept, roll back and write credentials before 0099; the
      // whole point of the split is that they no longer can. Anyone "fixing" this by appending to
      // the two rungs has to delete this case to do it.
      const table = await builtins();
      for (const name of ["Operator", "Approver"]) {
        expect(table.get(name)?.permissions, name).not.toContain("change:accept");
        expect(table.get(name)?.permissions, name).not.toContain("secret:write");
        // Still holds the generic verb, so the refusals above really are about the split.
        expect(table.get(name)?.permissions, name).toContain("object:write");
      }
    });

    it("the separation of duty is real: OrgAdmin has `policy:write` and NOT `scan:override`", async () => {
      // role-model.md §7.1 D3. This one line is the whole reason the design does not simply hand
      // OrgAdmin everything Administrator has: an org can seat an estate administrator who authors
      // org policy and a security officer who owns the waiver, and NEITHER IS THE OTHER.
      const table = await builtins();
      expect(table.get("OrgAdmin")?.permissions).toContain("policy:write");
      expect(table.get("OrgAdmin")?.permissions).not.toContain("scan:override");
      expect(table.get("SecurityOfficer")?.permissions).toContain("scan:override");
    });

    it("SecurityOfficer holds NO `object:write`, and FederationAdmin no `object:write`/`federation:pair`", async () => {
      const table = await builtins();
      // The whole point of SecurityOfficer: it enforces rules over the estate without holding any
      // authority to change it. The cumulative ladder cannot express that at any rung.
      expect(table.get("SecurityOfficer")?.permissions).not.toContain("object:write");
      expect(table.get("SecurityOfficer")?.permissions).not.toContain("secret:write");

      // FederationAdmin OPERATES the link and does not ESTABLISH trust (ruling D4). Withholding
      // `federation:pair` is what makes that invariant true rather than aspirational: on
      // `federation:write` alone you could pair a peer with a keypair you generated and import a
      // bundle you signed with it, holding estate write authority having never held `object:write`.
      expect(table.get("FederationAdmin")?.permissions).not.toContain("object:write");
      expect(table.get("FederationAdmin")?.permissions).not.toContain("federation:pair");
    });

    it("every built-in row is UNIQUE by name — 0097's partial index, still holding after a seed", async () => {
      // 0099 seeds with `INSERT ... SELECT ... WHERE NOT EXISTS` rather than `ON CONFLICT`,
      // deliberately. This asserts the outcome that matters either way: exactly one row per
      // built-in name. Ten today — five ladder rungs plus five purpose roles.
      const rows = await withTenantTx(server.deps.db, org.orgId, async (tx) =>
        tx.select({ name: roles.name }).from(roles).where(isNull(roles.orgId))
      );
      const names = rows.map((r) => r.name).sort();
      expect(new Set(names).size).toBe(names.length);
      expect(names).toEqual(
        [
          "Administrator",
          "Approver",
          "ComponentAdmin",
          "FederationAdmin",
          "OrgAdmin",
          "Operator",
          "Owner",
          "SecurityOfficer",
          "ServiceAdmin",
          "Viewer"
        ].sort()
      );
    });
  });
});
