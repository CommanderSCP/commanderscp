import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { and, eq, isNull, sql } from "drizzle-orm";
import { auditEvents, decisions, relationships, roleBindings } from "../db/schema.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { hasRoleAtScope } from "../authz/resolve.js";
import { principalsReachedBy } from "../authz/role-binding-door.js";
import { createObject } from "../graph/objects-repo.js";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  testDatabaseUrl,
  type TestOrg,
  type TestServer,
  type TestUser
} from "../test-support/harness.js";

/** STEP 5 — THE ROLE AND ROLE-BINDING WRITE DOOR. See docs/routes.md §344. */
describe("the role-binding write door (role-model.md §5 step 5)", () => {
  let server: TestServer;
  let org: TestOrg;

  /** Org-root `OrgAdmin`: holds `role_binding:write`, and DELIBERATELY not `scan:override`,
   *  `freeze:override`, `change:emergency` or `campaign:deadline-override`. The protagonist — the
   *  principal the subset rule exists to stop from becoming Owner. */
  let orgAdmin: TestUser;
  /** Org-root `Administrator`: an EXISTING binding, written the way a live deployment's hand SQL
   *  wrote one before this door existed. D5 must keep it resolving. */
  let legacyAdministrator: TestUser;
  /** `ServiceAdmin` at `serviceS`: full authority over that subtree and NO `role_binding:write`
   *  anywhere. The bar-§1 refusal, and the proof that §1 is a real demand and not implied by §2. */
  let serviceAdmin: TestUser;
  /** `OrgAdmin` bound at `serviceS` (written raw — `bindable_at` says `organization`, and a live
   *  deployment's hand SQL was not checking it either). Holds `role_binding:write` AT and BELOW
   *  `serviceS` and nowhere else, which is what makes "at-or-above" measurable. */
  let scopedBinder: TestUser;
  /** A user with NO role binding of its own, `member_of` a group that holds org-root `OrgAdmin`.
   *  The ONLY fixture that distinguishes the resolved answer from a read of the actor's role rows. */
  let groupBinder: TestUser;
  /** Org-root `Operator` — holds `relationship:write` at every object in the org and NO
   *  `role_binding:write` anywhere. The §2a exploit's protagonist: the escalation floor was four
   *  rungs below Administrator precisely because this principal's `relationship:write` is not narrow,
   *  which is the one thing the pre-existing both-endpoint check cannot constrain. */
  let operator: TestUser;

  let serviceS: string;
  let serviceOther: string;
  let componentC: string;

  const roleIds = new Map<string, string>();
  /** Role permission array by name, from the live catalogue. */
  const rolePermissions = new Map<string, string[]>();

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

  function roleId(name: string): string {
    const id = roleIds.get(name);
    if (!id) throw new Error(`role '${name}' is not in the catalogue`);
    return id;
  }

  function permissionsOf(name: string): string[] {
    const perms = rolePermissions.get(name);
    if (!perms) throw new Error(`role '${name}' is not in the catalogue`);
    return perms;
  }

  /** Everything the target carries that the actor does not. See docs/routes.md §345. */
  function missingFor(actorRole: string, targetRole: string): string[] {
    const held = new Set(permissionsOf(actorRole));
    const missing = permissionsOf(targetRole).filter((p) => !held.has(p));
    expect(
      missing,
      `'${targetRole}' must carry at least one permission '${actorRole}' lacks, or every ` +
        `escalation case below is vacuous — the seed changed and this file has not`
    ).not.toHaveLength(0);
    return missing;
  }

  /** A brand-new principal holding nothing, as the subject. See docs/routes.md §346. */
  async function freshSubject(): Promise<TestUser> {
    return createTestUser(server, org, []);
  }

  /** The `member_of` closure below an object. See docs/routes.md §347. */
  async function empoweredIds(orgId: string, subjectId: string): Promise<string[]> {
    const reached = await withTenantTx(server.deps.db, orgId, async (tx) =>
      principalsReachedBy(tx, orgId, subjectId)
    );
    return reached
      .filter((p) => p.depth > 0)
      .map((p) => p.id)
      .sort();
  }

  /** AUTO-ACKNOWLEDGES BY DEFAULT. See docs/routes.md §348. */
  async function grant(
    token: string,
    body: Record<string, unknown>
  ): Promise<LightMyRequestResponse> {
    const acknowledged =
      "acknowledgedPrincipalIds" in body
        ? body.acknowledgedPrincipalIds
        : await empoweredIds(org.orgId, String(body.subjectId));
    return call("POST", token, "/api/v1/role-bindings", {
      reason: "granted by the role-binding door integration suite",
      ...body,
      acknowledgedPrincipalIds: acknowledged
    });
  }

  /** The persisted `role_bindings` rows for one (subject, role, scope) triple — read straight from
   *  the table, never from the response body, so an assertion about what LANDED cannot be satisfied
   *  by what was ECHOED. */
  async function bindingRows(
    subjectId: string,
    roleIdValue: string,
    scopeObjectId: string
  ): Promise<{ id: string; effect: string }[]> {
    return withTenantTx(server.deps.db, org.orgId, async (tx) =>
      tx
        .select({ id: roleBindings.id, effect: roleBindings.effect })
        .from(roleBindings)
        .where(
          and(
            eq(roleBindings.orgId, org.orgId),
            eq(roleBindings.subjectId, subjectId),
            eq(roleBindings.roleId, roleIdValue),
            eq(roleBindings.scopeObjectId, scopeObjectId)
          )
        )
    );
  }

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "rbac-door");

    const ids = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const mk = async (typeId: string, name: string) =>
        (
          await createObject(tx, {
            orgId: org.orgId,
            typeId,
            actorObjectId: org.orgId,
            requestId: "rbac-door-setup",
            name
          })
        ).id;
      return {
        serviceS: await mk("service", `svc-s-${randomUUID().slice(0, 8)}`),
        serviceOther: await mk("service", `svc-other-${randomUUID().slice(0, 8)}`),
        componentC: await mk("component", `comp-c-${randomUUID().slice(0, 8)}`)
      };
    });
    serviceS = ids.serviceS;
    serviceOther = ids.serviceOther;
    componentC = ids.componentC;

    // serviceS CONTAINS componentC — route 2 of the scope walk. Through the real API, so the
    // relationship-type registry validates it exactly as it would in production.
    const contains = await call("POST", org.adminToken, "/api/v1/relationships", {
      typeId: "contains",
      fromId: serviceS,
      toId: componentC
    });
    if (contains.statusCode !== 201) {
      throw new Error(`contains edge setup failed: ${contains.statusCode} ${contains.body}`);
    }

    orgAdmin = await createTestUser(server, org, [{ role: "OrgAdmin", scope: org.orgId }]);
    legacyAdministrator = await createTestUser(server, org, [
      { role: "Administrator", scope: org.orgId }
    ]);
    serviceAdmin = await createTestUser(server, org, [{ role: "ServiceAdmin", scope: serviceS }]);
    scopedBinder = await createTestUser(server, org, [{ role: "OrgAdmin", scope: serviceS }]);
    operator = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);

    // The group-derived administrator. See docs/routes.md §349.
    groupBinder = await createTestUser(server, org, []);
    const binderGroup = await withTenantTx(server.deps.db, org.orgId, async (tx) =>
      createObject(tx, {
        orgId: org.orgId,
        typeId: "group",
        actorObjectId: org.orgId,
        requestId: "rbac-door-setup",
        name: `binders-${randomUUID().slice(0, 8)}`
      })
    );
    const memberOf = await call("POST", org.adminToken, "/api/v1/relationships", {
      typeId: "member_of",
      fromId: groupBinder.objectId,
      toId: binderGroup.id
    });
    if (memberOf.statusCode !== 201) {
      throw new Error(`member_of setup failed: ${memberOf.statusCode} ${memberOf.body}`);
    }
    // The group's binding, written raw. `createTestUser` only binds users, and the whole point of
    // this fixture is that the SUBJECT of the binding is not the acting principal.
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
        SELECT gen_random_uuid(), ${org.orgId}::uuid, ${binderGroup.id}::uuid, rl.id,
               ${org.orgId}::uuid, 'allow'
        FROM roles rl WHERE rl.org_id IS NULL AND rl.name = 'OrgAdmin'
      `);
    });

    // The catalogue, read through the door itself. Every expectation below is derived from this.
    const catalogue = await call("GET", org.adminToken, "/api/v1/roles");
    if (catalogue.statusCode !== 200) {
      // THE WIRING DIAGNOSIS, SPELLED OUT AT THE HOOK. A 404 here means the routes exist as a
      // module and are registered on no app — `registerRoleBindingRoutes(app, deps)` missing from
      // `app.ts`. The named WIRING case below asserts the same thing behaviourally, but the hook
      // reaches it first, so the message it dies with has to be the answer rather than a symptom.
      throw new Error(
        `GET /roles setup failed: ${catalogue.statusCode} ${catalogue.body}` +
          (catalogue.statusCode === 404
            ? " — the role-binding routes are NOT REGISTERED. Check that `app.ts` still calls " +
              "`registerRoleBindingRoutes(app, deps)`; the module compiling is not the same fact " +
              "as the door being installed."
            : "")
      );
    }
    for (const role of (
      catalogue.json() as { items: { id: string; name: string; permissions: string[] }[] }
    ).items) {
      roleIds.set(role.name, role.id);
      rolePermissions.set(role.name, role.permissions);
    }
    for (const required of [
      "Viewer",
      "Owner",
      "Administrator",
      "OrgAdmin",
      "ServiceAdmin",
      "ComponentAdmin",
      "SecurityOfficer"
    ]) {
      if (!roleIds.has(required)) throw new Error(`built-in role '${required}' is not seeded`);
    }
  });

  afterAll(async () => {
    await server?.close();
  });

  it("WIRING: the four operations are REGISTERED on the app, not merely written", async () => {
    // Deleting the wiring is the only check that works here. See docs/routes.md §350.
    const roles = await call("GET", org.adminToken, "/api/v1/roles");
    expect(roles.statusCode, roles.body).toBe(200);

    const list = await call("GET", org.adminToken, "/api/v1/role-bindings");
    expect(list.statusCode, list.body).toBe(200);

    // A grant and its revoke, so POST and DELETE are both proven ROUTED rather than merely
    // proven-to-refuse — a 404 and a 403 are both "not 201", and only one of them means installed.
    const subject = await freshSubject();
    const created = await grant(org.adminToken, {
      subjectId: subject.objectId,
      roleId: roleId("Viewer"),
      scopeObjectId: serviceOther
    });
    expect(created.statusCode, created.body).toBe(201);
    const revoked = await call(
      "DELETE",
      org.adminToken,
      `/api/v1/role-bindings/${(created.json() as { id: string }).id}`,
      { reason: "wiring case cleanup" }
    );
    expect(revoked.statusCode, revoked.body).toBe(200);
  });

  // =============================================================================================
  // 1. `role_binding:write` AT-OR-ABOVE THE SCOPE — necessary, and not sufficient
  // =============================================================================================

  it("bar §1: a principal without `role_binding:write` cannot grant, however much else it holds", async () => {
    // `serviceAdmin` holds FULL authority over `serviceS` — `object:write`, `policy:write`,
    // `freeze:write`, `change:accept`, `governance:move`. It holds no `role_binding:write`
    // anywhere, and that single withholding is the whole difference between administering a
    // subtree and being able to hand that administration to somebody else.
    expect(permissionsOf("ServiceAdmin")).not.toContain("role_binding:write");

    const subject = await freshSubject();
    const refused = await grant(serviceAdmin.token, {
      subjectId: subject.objectId,
      roleId: roleId("Viewer"),
      scopeObjectId: serviceS
    });
    expect(refused.statusCode, refused.body).toBe(403);
    // NAMED, not merely refused: a 403 that named some other permission would mean a different bar
    // refused this, and the case would pass while testing nothing it claims.
    expect(refused.body).toContain("role_binding:write");
    expect(await bindingRows(subject.objectId, roleId("Viewer"), serviceS)).toHaveLength(0);

    // THE PAIR: identical body, identical scope, only the actor differs.
    const admitted = await grant(orgAdmin.token, {
      subjectId: subject.objectId,
      roleId: roleId("Viewer"),
      scopeObjectId: serviceS
    });
    expect(admitted.statusCode, admitted.body).toBe(201);
  });

  it("bar §1 is AT-OR-ABOVE: a service-scoped binder reaches beneath it and not sideways", async () => {
    // A binder holding root-grade permissions, bound at a service. See docs/routes.md §351.
    const subject = await freshSubject();
    const beneath = await grant(scopedBinder.token, {
      subjectId: subject.objectId,
      roleId: roleId("ComponentAdmin"),
      scopeObjectId: componentC
    });
    expect(beneath.statusCode, beneath.body).toBe(201);

    const sideways = await grant(scopedBinder.token, {
      subjectId: subject.objectId,
      roleId: roleId("ServiceAdmin"),
      scopeObjectId: serviceOther
    });
    expect(sideways.statusCode, sideways.body).toBe(403);
    expect(sideways.body).toContain("role_binding:write");
    expect(await bindingRows(subject.objectId, roleId("ServiceAdmin"), serviceOther)).toHaveLength(
      0
    );

    // ...and not UPWARD either. The org root is above `serviceS`, so a binder scoped at the service
    // must not be able to author authority over the whole org.
    const upward = await grant(scopedBinder.token, {
      subjectId: subject.objectId,
      roleId: roleId("Viewer"),
      scopeObjectId: org.orgId
    });
    expect(upward.statusCode, upward.body).toBe(403);
    expect(upward.body).toContain("role_binding:write");
  });

  // =============================================================================================
  // 2. THE NO-ESCALATION SUBSET RULE — the single most important assertion in this file
  // =============================================================================================

  it("an org-root `role_binding:write` holder CANNOT mint themselves Owner", async () => {
    // WITHOUT THIS RULE THE DOOR IS AN ESCALATION SURFACE WITH A PERMISSION CHECK ON IT. `orgAdmin`
    // passes bar §1 at every scope in the org, the org root included, so bar §1 alone admits this
    // request and the OrgAdmin holds every permission in the system by lunchtime.
    const missing = missingFor("OrgAdmin", "Owner");

    const refused = await grant(orgAdmin.token, {
      subjectId: orgAdmin.objectId,
      roleId: roleId("Owner"),
      scopeObjectId: org.orgId
    });
    expect(refused.statusCode, refused.body).toBe(403);
    // EVERY missing permission is named, not just the first: the door collects the whole set so one
    // refusal tells the operator everything that is wrong, and asserting on the whole set is what
    // stops a short-circuiting rewrite from passing this case.
    for (const permission of missing) expect(refused.body).toContain(permission);
    expect(await bindingRows(orgAdmin.objectId, roleId("Owner"), org.orgId)).toHaveLength(0);

    // AND THE ESCALATION REALLY WAS BLOCKED, measured at the door it would have opened: this is
    // `routes/governance.ts`'s "NOT ESCALATABLE FROM BELOW" comment, now resting on the subset rule
    // instead of on the API being unbuilt. `campaign:deadline-override` is one of the permissions
    // the refusal named; the OrgAdmin must still not hold it.
    expect(missing).toContain("campaign:deadline-override");
  });

  it("OrgAdmin CAN grant ServiceAdmin and ComponentAdmin — proper subsets of its own set", async () => {
    // The admission half of the pair above, and the thing that makes the rule usable rather than
    // merely safe. Both roles are proper subsets of OrgAdmin's array, so every `hasPermission`
    // probe resolves true and the grant lands.
    expect(missingFor("ServiceAdmin", "OrgAdmin")).not.toHaveLength(0);
    expect(
      permissionsOf("ServiceAdmin").filter((p) => !permissionsOf("OrgAdmin").includes(p))
    ).toEqual([]);
    expect(
      permissionsOf("ComponentAdmin").filter((p) => !permissionsOf("OrgAdmin").includes(p))
    ).toEqual([]);

    const subject = await freshSubject();
    const service = await grant(orgAdmin.token, {
      subjectId: subject.objectId,
      roleId: roleId("ServiceAdmin"),
      scopeObjectId: serviceS
    });
    expect(service.statusCode, service.body).toBe(201);

    const component = await grant(orgAdmin.token, {
      subjectId: subject.objectId,
      roleId: roleId("ComponentAdmin"),
      scopeObjectId: componentC
    });
    expect(component.statusCode, component.body).toBe(201);
  });

  it("OrgAdmin CANNOT grant SecurityOfficer — `scan:override` is the separation of duty (D3)", async () => {
    // The design's whole separation-of-duty claim in one request. OrgAdmin authors org policy
    // (`policy:write`) and deliberately cannot decide a scan waiver (`scan:override`); if it could
    // MINT a SecurityOfficer it would hold the waiver by proxy, and the withholding would be
    // decoration. This is the case that turns ruling D3 from a table in a document into a 403.
    const missing = missingFor("OrgAdmin", "SecurityOfficer");
    expect(missing).toEqual(["scan:override"]);

    const refused = await grant(orgAdmin.token, {
      subjectId: orgAdmin.objectId,
      roleId: roleId("SecurityOfficer"),
      scopeObjectId: org.orgId
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.body).toContain("scan:override");
    expect(await bindingRows(orgAdmin.objectId, roleId("SecurityOfficer"), org.orgId)).toHaveLength(
      0
    );

    // THE PAIR: the Owner, who does hold `scan:override`, is admitted for the identical body —
    // except for the SUBJECT, which must be a fresh principal and NOT `orgAdmin`. Granting it to
    // the actor would hand `orgAdmin` `scan:override` for the rest of the file and quietly shrink
    // the Owner-escalation refusal from four named permissions to three. (Measured: it did.)
    const admitted = await grant(org.adminToken, {
      subjectId: (await freshSubject()).objectId,
      roleId: roleId("SecurityOfficer"),
      scopeObjectId: org.orgId
    });
    expect(admitted.statusCode, admitted.body).toBe(201);
  });

  it("the subset rule holds for authority inherited through `member_of`, not just direct bindings", async () => {
    // The case distinguishing a correct implementation from one. See docs/routes.md §352.
    const direct = await withTenantTx(server.deps.db, org.orgId, async (tx) =>
      tx
        .select({ id: roleBindings.id })
        .from(roleBindings)
        .where(
          and(eq(roleBindings.orgId, org.orgId), eq(roleBindings.subjectId, groupBinder.objectId))
        )
    );
    expect(
      direct,
      "groupBinder must hold NO direct binding, or this case proves nothing about member_of"
    ).toHaveLength(0);

    const admitted = await grant(groupBinder.token, {
      subjectId: (await freshSubject()).objectId,
      roleId: roleId("ComponentAdmin"),
      scopeObjectId: componentC
    });
    expect(admitted.statusCode, admitted.body).toBe(201);

    // AND THE CEILING TRAVELS WITH IT: inherited authority is still bounded by the same subset
    // rule, so the group-derived OrgAdmin cannot mint an Owner either. Inheriting authority must
    // not inherit MORE authority than the group holds.
    const refused = await grant(groupBinder.token, {
      subjectId: groupBinder.objectId,
      roleId: roleId("Owner"),
      scopeObjectId: org.orgId
    });
    expect(refused.statusCode, refused.body).toBe(403);
    for (const permission of missingFor("OrgAdmin", "Owner")) {
      expect(refused.body).toContain(permission);
    }
  });

  // 2b. THE SAME CLAUSE ON DELETE — the half that is easy to leave out

  it("DELETE is refused when the binding OUTRANKS the caller", async () => {
    // WITHOUT THE SUBSET RULE ON DELETE, A SUBJECT REVOKES THE BINDING THAT OUTRANKS THEM: the
    // OrgAdmin deletes the org's Owner binding, using a permission it holds by design, and the org
    // is left with nobody who can put it back. Bar §1 does not stop it — the OrgAdmin passes
    // `role_binding:write` at the org root — so this is bar §2 or nothing.
    const ownerBinding = await call(
      "GET",
      org.adminToken,
      `/api/v1/role-bindings?subjectId=${encodeURIComponent(await bootstrapOwnerSubjectId())}`
    );
    expect(ownerBinding.statusCode, ownerBinding.body).toBe(200);
    const owner = (ownerBinding.json() as { items: { id: string; roleName: string }[] }).items.find(
      (b) => b.roleName === "Owner"
    );
    expect(owner, "the bootstrap admin's org-root Owner binding must exist").toBeDefined();

    const refused = await call("DELETE", orgAdmin.token, `/api/v1/role-bindings/${owner!.id}`, {
      reason: "an OrgAdmin trying to remove the org's Owner"
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.body).toContain("revoke");
    for (const permission of missingFor("OrgAdmin", "Owner")) {
      expect(refused.body).toContain(permission);
    }

    // THE ROW SURVIVED. Asserting only on the status code would pass against a handler that
    // deleted first and threw afterwards outside a transaction.
    const stillThere = await call(
      "GET",
      org.adminToken,
      `/api/v1/role-bindings?subjectId=${encodeURIComponent(await bootstrapOwnerSubjectId())}`
    );
    expect((stillThere.json() as { items: { id: string }[] }).items.map((b) => b.id)).toContain(
      owner!.id
    );
  });

  it("DELETE is ADMITTED when the caller outranks the binding — the pair", async () => {
    // Same verb, same door, same actor. The only difference is the rank of the binding being
    // revoked, which is what says the SUBSET RULE decided the case above rather than DELETE being
    // broken or `role_binding:write` being absent.
    const subject = await freshSubject();
    const created = await grant(orgAdmin.token, {
      subjectId: subject.objectId,
      roleId: roleId("ComponentAdmin"),
      scopeObjectId: componentC
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;

    const revoked = await call("DELETE", orgAdmin.token, `/api/v1/role-bindings/${id}`, {
      reason: "revoking a binding the caller outranks"
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(await bindingRows(subject.objectId, roleId("ComponentAdmin"), componentC)).toHaveLength(
      0
    );
  });

  it("DELETE also demands bar §1: `role_binding:write` at-or-above the binding's scope", async () => {
    // THE REVOKE PATH APPLIES BOTH BARS, not just the subset rule. See docs/routes.md §353.
    const created = await grant(org.adminToken, {
      subjectId: (await freshSubject()).objectId,
      roleId: roleId("Viewer"),
      scopeObjectId: componentC
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;

    const refused = await call("DELETE", serviceAdmin.token, `/api/v1/role-bindings/${id}`, {
      reason: "a principal with no role_binding:write trying to revoke"
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.body).toContain("role_binding:write");

    const admitted = await call("DELETE", orgAdmin.token, `/api/v1/role-bindings/${id}`, {
      reason: "the pair — same binding, a caller who holds role_binding:write"
    });
    expect(admitted.statusCode, admitted.body).toBe(200);
  });

  // =============================================================================================
  // 3. `effect` IS NOT SETTABLE THROUGH THE WRITE API
  // =============================================================================================

  it("`effect` cannot be set through ANY path — body, query string, or mass assignment", async () => {
    // A deny row overrides every allow at any matching scope. See docs/routes.md §354.
    const subject = await freshSubject();
    const body = await grant(orgAdmin.token, {
      subjectId: subject.objectId,
      roleId: roleId("Viewer"),
      scopeObjectId: componentC,
      effect: "deny"
    });
    expect(body.statusCode, body.body).toBe(201);
    expect((body.json() as { effect: string }).effect).toBe("allow");
    const bodyRows = await bindingRows(subject.objectId, roleId("Viewer"), componentC);
    expect(bodyRows).toHaveLength(1);
    expect(bodyRows[0]!.effect).toBe("allow");

    // The query string, which no schema on this route reads and which a `?effect=deny` habit from
    // another API would reach for.
    const viaQuery = await call("POST", orgAdmin.token, "/api/v1/role-bindings?effect=deny", {
      subjectId: subject.objectId,
      roleId: roleId("Viewer"),
      scopeObjectId: serviceOther,
      reason: "query-string effect attempt"
    });
    expect(viaQuery.statusCode, viaQuery.body).toBe(201);
    expect((viaQuery.json() as { effect: string }).effect).toBe("allow");
    const queryRows = await bindingRows(subject.objectId, roleId("Viewer"), serviceOther);
    expect(queryRows).toHaveLength(1);
    expect(queryRows[0]!.effect).toBe("allow");

    // Mass assignment under several spellings at once, including the snake_case the COLUMN uses —
    // the spelling a careless `...request.body` spread into the insert would pick up.
    const plantedId = randomUUID();
    const massAssign = await call("POST", orgAdmin.token, "/api/v1/role-bindings", {
      subjectId: subject.objectId,
      roleId: roleId("Viewer"),
      scopeObjectId: serviceS,
      reason: "mass-assignment attempt",
      effect: "deny",
      effect_column: "deny",
      orgId: randomUUID(),
      id: plantedId
    });
    expect(massAssign.statusCode, massAssign.body).toBe(201);
    const massRows = await bindingRows(subject.objectId, roleId("Viewer"), serviceS);
    expect(massRows).toHaveLength(1);
    expect(massRows[0]!.effect).toBe("allow");
    // The injected `id` was ignored too. `insertRoleBinding` mints a uuidv7; a caller choosing a
    // binding's primary key is how a collision with a future grant gets pre-planted, and it is the
    // same `...body` spread that would carry `effect` through.
    expect(massRows[0]!.id).not.toBe(plantedId);
    expect((massAssign.json() as { id: string }).id).toBe(massRows[0]!.id);
  });

  it("a binding at a NONSENSICAL SCOPE TYPE is refused (role-model.md §1.3h)", async () => {
    // The scope column is a bare reference, with what that means. See docs/routes.md §355.
    const subject = await freshSubject();
    const refused = await grant(orgAdmin.token, {
      subjectId: subject.objectId,
      roleId: roleId("ComponentAdmin"),
      scopeObjectId: groupBinder.objectId // a `user` object
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.body).toContain("ComponentAdmin");
    // The refusal names WHERE the role does bind, so the operator's next request is the right one.
    for (const typeId of ["assembly", "component"]) expect(refused.body).toContain(typeId);
    expect(
      await bindingRows(subject.objectId, roleId("ComponentAdmin"), groupBinder.objectId)
    ).toHaveLength(0);

    // A REAL object type, still wrong for THIS role: ServiceAdmin binds at `service` or `domain`,
    // never at a component. Distinguishes "the door validates the type" from "the door refuses
    // anything that is not a container".
    const wrongContainer = await grant(orgAdmin.token, {
      subjectId: subject.objectId,
      roleId: roleId("ServiceAdmin"),
      scopeObjectId: componentC
    });
    expect(wrongContainer.statusCode, wrongContainer.body).toBe(422);
    expect(wrongContainer.body).toContain("ServiceAdmin");

    // THE PAIR, twice over: the same role at a scope it DOES list, and the same nonsensical scope
    // with a role whose `bindable_at` is NULL. NULL means ANY, and it must keep meaning that —
    // the five cumulative-ladder rows carry it because their live bindings predate the column.
    const rightScope = await grant(orgAdmin.token, {
      subjectId: subject.objectId,
      roleId: roleId("ServiceAdmin"),
      scopeObjectId: serviceS
    });
    expect(rightScope.statusCode, rightScope.body).toBe(201);

    const ladder = await call("GET", org.adminToken, "/api/v1/roles");
    const viewerRow = (
      ladder.json() as { items: { name: string; bindableAt: unknown }[] }
    ).items.find((r) => r.name === "Viewer");
    expect(viewerRow?.bindableAt, "the ladder rows must keep `bindable_at = NULL`").toBeNull();
    const anyScope = await grant(orgAdmin.token, {
      subjectId: subject.objectId,
      roleId: roleId("Viewer"),
      scopeObjectId: groupBinder.objectId
    });
    expect(anyScope.statusCode, anyScope.body).toBe(201);
  });

  it("a binding to a NON-SUBJECT object is refused — the same unconstrained-uuid property", async () => {
    // `role_bindings.subject_id` is a bare `uuid NOT NULL` with NO FOREIGN KEY AT ALL — strictly
    // worse than `scope_object_id`, and found by censusing the property rather than the symptom.
    // A binding whose subject is a `component` can never match a request, because `subject_expand`
    // is seeded from the authenticated principal's own graph object.
    const refused = await grant(orgAdmin.token, {
      subjectId: componentC,
      roleId: roleId("Viewer"),
      scopeObjectId: serviceS
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.body).toContain("component");
    expect(await bindingRows(componentC, roleId("Viewer"), serviceS)).toHaveLength(0);

    // THE PAIR: a `group` IS a legal subject — `member_of`'s registered `from_types` are exactly
    // the set the subject expansion can reach — so the refusal above is about the TYPE and not
    // about the door refusing anything that is not a user.
    const groupObject = await withTenantTx(server.deps.db, org.orgId, async (tx) =>
      createObject(tx, {
        orgId: org.orgId,
        typeId: "group",
        actorObjectId: org.orgId,
        requestId: "rbac-door-subject-pair",
        name: `subject-group-${randomUUID().slice(0, 8)}`
      })
    );
    const admitted = await grant(orgAdmin.token, {
      subjectId: groupObject.id,
      roleId: roleId("Viewer"),
      scopeObjectId: serviceS
    });
    expect(admitted.statusCode, admitted.body).toBe(201);
  });

  // =============================================================================================
  // 5. D5 — Administrator is deprecated ON ARRIVAL
  // =============================================================================================

  it("a NEW `Administrator` binding is refused and NAMES a purpose role to use instead", async () => {
    // Administrator's grab-bag is exactly what makes "SecOps implies type-registry authority" true
    // today; leaving it grantable would keep it the path of least resistance and make the
    // least-privilege story aspirational. The refusal has to NAME the replacement, or D5 just
    // removes the obvious migration target and offers nothing.
    const subject = await freshSubject();
    const refused = await grant(org.adminToken, {
      subjectId: subject.objectId,
      roleId: roleId("Administrator"),
      scopeObjectId: org.orgId
    });
    // 422 and not 403: the request is well-formed and the OWNER is making it, so this is a refusal
    // about the ROLE rather than about the caller's standing. An Owner getting a 403 here would
    // read as an authority bug.
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.body).toContain("deprecated");
    expect(refused.body).toContain("OrgAdmin");
    for (const replacement of ["ServiceAdmin", "ComponentAdmin", "SecurityOfficer"]) {
      expect(refused.body).toContain(replacement);
    }
    expect(await bindingRows(subject.objectId, roleId("Administrator"), org.orgId)).toHaveLength(0);
  });

  it("an EXISTING `Administrator` binding still RESOLVES — this is a refusal, not a removal", async () => {
    // `legacyAdministrator` was bound before the deprecation. See docs/routes.md §356.
    const secret = await call(
      "PUT",
      legacyAdministrator.token,
      `/api/v1/secrets/legacy-${randomUUID().slice(0, 8)}`,
      { value: "v" }
    );
    expect(secret.statusCode, secret.body).toBe(200);

    // AND AT THIS DOOR: the existing Administrator binding still carries `role_binding:write`, so
    // it can still grant everything it outranks. A deprecation that quietly stopped an existing
    // Administrator administering would be the removal D5 says it is not.
    expect(
      permissionsOf("ComponentAdmin").filter((p) => !permissionsOf("Administrator").includes(p))
    ).toEqual([]);
    const stillGrants = await grant(legacyAdministrator.token, {
      subjectId: (await freshSubject()).objectId,
      roleId: roleId("ComponentAdmin"),
      scopeObjectId: componentC
    });
    expect(stillGrants.statusCode, stillGrants.body).toBe(201);
  });

  it("an EXISTING `Administrator` binding is REVOKABLE — the grant-only refusals are grant-only", async () => {
    // Re-checking D5 on DELETE would make every existing `Administrator` binding IMMORTAL the day
    // the role was deprecated, which is the exact opposite of a deprecation. The same is true of
    // `bindable_at`: a binding already written at a nonsensical scope must stay cleanable, and
    // cleaning those up is half the reason the column exists.
    const doomed = await createTestUser(server, org, [
      { role: "Administrator", scope: org.orgId },
      // ...and one at a scope `bindable_at` would refuse on a grant, cleaned up by the same verb.
      { role: "ComponentAdmin", scope: serviceOther }
    ]);
    const listed = await call(
      "GET",
      org.adminToken,
      `/api/v1/role-bindings?subjectId=${encodeURIComponent(doomed.objectId)}`
    );
    expect(listed.statusCode, listed.body).toBe(200);
    const rows = (listed.json() as { items: { id: string; roleName: string }[] }).items;
    expect(rows.map((r) => r.roleName).sort()).toEqual(["Administrator", "ComponentAdmin"]);

    for (const row of rows) {
      const revoked = await call("DELETE", org.adminToken, `/api/v1/role-bindings/${row.id}`, {
        reason: `revoking a pre-deprecation ${row.roleName} binding`
      });
      expect(revoked.statusCode, revoked.body).toBe(200);
    }
    const after = await call(
      "GET",
      org.adminToken,
      `/api/v1/role-bindings?subjectId=${encodeURIComponent(doomed.objectId)}`
    );
    expect((after.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("`GET /roles` marks `Administrator` deprecated, from the SAME table the refusal reads", async () => {
    // ONE DEFINITION, TWO CONSUMERS. If the listing and the door read different tables, a UI greys
    // a role the door still accepts (or offers one it refuses) and the operator learns the truth
    // only from a 422. Mutating `DEPRECATED_BUILTIN_ROLES` must break BOTH, which is the
    // measurement that they are one fact.
    const res = await call("GET", org.adminToken, "/api/v1/roles");
    expect(res.statusCode, res.body).toBe(200);
    const items = (
      res.json() as {
        items: {
          name: string;
          orgId: string | null;
          deprecated: boolean;
          deprecationReason: string | null;
        }[];
      }
    ).items;

    const administrator = items.find((r) => r.name === "Administrator");
    expect(administrator?.deprecated).toBe(true);
    expect(administrator?.deprecationReason).toContain("OrgAdmin");

    // NOTHING ELSE IS MARKED. A blanket `deprecated: true` would satisfy the assertion above while
    // greying the entire catalogue.
    expect(items.filter((r) => r.deprecated).map((r) => r.name)).toEqual(["Administrator"]);
    for (const role of items.filter((r) => !r.deprecated)) {
      expect(role.deprecationReason).toBeNull();
    }

    // The marker is keyed by name AND applies only to shared built-ins (`orgId === null`), so an
    // org's own row named `Administrator` is a different row and is not deprecated by collision.
    expect(administrator?.orgId).toBeNull();
  });

  // =============================================================================================
  // 6. AN AUDIT EVENT AND A DECISION PER GRANT AND PER REVOKE, IN THE SAME TRANSACTION
  // =============================================================================================

  it("a grant and a revoke each write an audit event AND a Decision carrying its inputs", async () => {
    const subject = await freshSubject();
    const grantReason = `grant-audit-${randomUUID().slice(0, 8)}`;
    const created = await grant(orgAdmin.token, {
      subjectId: subject.objectId,
      roleId: roleId("ServiceAdmin"),
      scopeObjectId: serviceS,
      reason: grantReason
    });
    expect(created.statusCode, created.body).toBe(201);
    const bindingId = (created.json() as { id: string }).id;

    const revokeReason = `revoke-audit-${randomUUID().slice(0, 8)}`;
    const revoked = await call("DELETE", orgAdmin.token, `/api/v1/role-bindings/${bindingId}`, {
      reason: revokeReason
    });
    expect(revoked.statusCode, revoked.body).toBe(200);

    // AUDIT — through the API, the way `scp audit verify` reads it, because an audit event only
    // the database can see is not an audit trail.
    const audit = await call("GET", org.adminToken, "/api/v1/audit-events?limit=200");
    expect(audit.statusCode, audit.body).toBe(200);
    const events = (
      audit.json() as {
        items: {
          action: string;
          subjectId: string | null;
          reason: string | null;
          actorId: string;
        }[];
      }
    ).items.filter((e) => e.subjectId === bindingId);

    const grantEvent = events.find((e) => e.action === "role_binding.grant");
    const revokeEvent = events.find((e) => e.action === "role_binding.revoke");
    expect(grantEvent, "a grant must append `role_binding.grant`").toBeDefined();
    expect(revokeEvent, "a revoke must append `role_binding.revoke`").toBeDefined();
    // The ACTOR is the granting principal, not the principal receiving the authority — the two are
    // different subjects and confusing them makes the audit trail say the wrong person acted.
    expect(grantEvent!.actorId).toBe(orgAdmin.objectId);
    expect(grantEvent!.reason).toBe(grantReason);
    expect(revokeEvent!.reason).toBe(revokeReason);

    // DECISION — `audit_events` has no payload column and a revoke HARD-DELETES the row it is
    // about, so without this the estate records "somebody revoked <a uuid that no longer resolves>"
    // and loses what authority was removed from whom.
    const decisionRes = await call(
      "GET",
      org.adminToken,
      `/api/v1/decisions?kind=role_binding&subjectId=${encodeURIComponent(bindingId)}&limit=50`
    );
    expect(decisionRes.statusCode, decisionRes.body).toBe(200);
    const records = (
      decisionRes.json() as {
        items: { kind: string; verdict: string; inputContext: Record<string, unknown> }[];
      }
    ).items;
    const grantDecision = records.find((d) => d.inputContext.action === "grant");
    const revokeDecision = records.find((d) => d.inputContext.action === "revoke");
    expect(grantDecision, "a grant must persist a `role_binding` Decision").toBeDefined();
    expect(revokeDecision, "a revoke must persist a `role_binding` Decision").toBeDefined();

    // The permission set AS IT STOOD AT THE MOMENT OF THE ACT. A role's array is mutable by
    // migration — eight have appended to the built-ins so far — so without this snapshot the record
    // of what was handed over drifts with the role, and the Decision stops being "the inputs".
    expect(grantDecision!.inputContext.grantedPermissions).toEqual(
      [...permissionsOf("ServiceAdmin")].sort()
    );
    // The revoke's copy is the WHOLE ROW, because it is gone after the transaction.
    const revokedBinding = revokeDecision!.inputContext.binding as Record<string, unknown>;
    expect(revokedBinding.id).toBe(bindingId);
    expect(revokedBinding.subjectId).toBe(subject.objectId);
    expect(revokedBinding.roleName).toBe("ServiceAdmin");
    expect(revokedBinding.scopeObjectId).toBe(serviceS);
    expect(revokeDecision!.inputContext.revokedPermissions).toEqual(
      [...permissionsOf("ServiceAdmin")].sort()
    );
  });

  it("a failure after the write rolls BOTH the binding and its audit event back (one transaction)", async () => {
    // The audit event must be written in the same transaction. See docs/routes.md §357.
    const subject = await freshSubject();
    const magic = `same-tx-probe-${randomUUID()}`;
    const admin = new pg.Client({ connectionString: testDatabaseUrl() });
    await admin.connect();
    try {
      await admin.query(`
        CREATE OR REPLACE FUNCTION rbac_door_same_tx_probe() RETURNS trigger AS $$
        BEGIN
          IF NEW.reason = ${literal(magic)} THEN
            RAISE EXCEPTION 'rbac_door_same_tx_probe: forced failure after the write';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await admin.query(`
        CREATE TRIGGER rbac_door_same_tx_probe_trg
          BEFORE INSERT ON audit_events
          FOR EACH ROW EXECUTE FUNCTION rbac_door_same_tx_probe();
      `);

      // THE FIXTURE'S OWN SELF-CHECK. A trigger that silently did not install would make every
      // assertion below pass for the wrong reason — the request would 201 and the rollback claim
      // would never be tested. This measures the trigger instead of trusting the DDL.
      const installed = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_trigger WHERE tgname = 'rbac_door_same_tx_probe_trg'`
      );
      expect(
        installed.rows[0]!.n,
        "the audit trigger did not install — the rollback assertions below would be VACUOUS"
      ).toBe("1");

      const res = await grant(orgAdmin.token, {
        subjectId: subject.objectId,
        roleId: roleId("ServiceAdmin"),
        scopeObjectId: serviceOther,
        reason: magic
      });
      // 500, specifically: a 4xx would mean a BAR refused this before the write and the case would
      // prove nothing about rollback.
      expect(res.statusCode, res.body).toBe(500);

      expect(
        await bindingRows(subject.objectId, roleId("ServiceAdmin"), serviceOther),
        "the role binding survived a failure after the write — it is not in the audit event's transaction"
      ).toHaveLength(0);

      const orphans = await withTenantTx(server.deps.db, org.orgId, async (tx) => {
        const d = await tx
          .select({ id: decisions.id })
          .from(decisions)
          .where(
            and(
              eq(decisions.orgId, org.orgId),
              eq(decisions.kind, "role_binding"),
              sql`${decisions.inputContext}->>'reason' = ${magic}`
            )
          );
        const a = await tx
          .select({ id: auditEvents.id })
          .from(auditEvents)
          .where(and(eq(auditEvents.orgId, org.orgId), eq(auditEvents.reason, magic)));
        return { decisions: d, audit: a };
      });
      expect(orphans.decisions, "an orphaned Decision survived the rollback").toHaveLength(0);
      expect(orphans.audit).toHaveLength(0);
    } finally {
      await admin
        .query("DROP TRIGGER IF EXISTS rbac_door_same_tx_probe_trg ON audit_events")
        .catch(() => undefined);
      await admin.query("DROP FUNCTION IF EXISTS rbac_door_same_tx_probe()").catch(() => undefined);
      await admin.end();
    }

    // THE PAIR — the identical request with an ordinary reason, once the trigger is gone. Without
    // it, a door that refused this grant for an unrelated reason would satisfy every assertion
    // above and the case would be measuring its own fixture.
    const admitted = await grant(orgAdmin.token, {
      subjectId: subject.objectId,
      roleId: roleId("ServiceAdmin"),
      scopeObjectId: serviceOther,
      reason: "the same grant, with the trigger removed"
    });
    expect(admitted.statusCode, admitted.body).toBe(201);
  });

  // =============================================================================================
  // 7. The two remaining shapes: a duplicate grant, and the listing's own door
  // =============================================================================================

  it("a duplicate grant is a 409, not a silent success and not a second row", async () => {
    // Without `role_bindings_grant_key` (drizzle/0097) a write door creates duplicate grants that
    // are individually revocable and COLLECTIVELY still granting: revoke one, the other still
    // grants, and the revoke reports success. `onConflictDoNothing` reproduces the same failure
    // from the other end — a revoke against a binding the caller believes they created.
    const subject = await freshSubject();
    const body = {
      subjectId: subject.objectId,
      roleId: roleId("Viewer"),
      scopeObjectId: componentC
    };
    const first = await grant(orgAdmin.token, body);
    expect(first.statusCode, first.body).toBe(201);

    const second = await grant(orgAdmin.token, body);
    expect(second.statusCode, second.body).toBe(409);
    expect(await bindingRows(subject.objectId, roleId("Viewer"), componentC)).toHaveLength(1);
  });

  it("`GET /role-bindings` demands `audit:read` — a principal with no binding sees nothing", async () => {
    // A binding listing is an ACCOUNTABILITY RECORD about principals, not estate data, and
    // `audit:read` is the permission this codebase already uses for "may you see who did what".
    // The refusal that matters is the JIT-provisioned principal with no binding at all, which is
    // what an OIDC user is on first login before anyone has granted them anything.
    const unbound = await createTestUser(server, org, []);
    const refused = await call("GET", unbound.token, "/api/v1/role-bindings");
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.body).toContain("audit:read");

    const admitted = await call("GET", org.adminToken, "/api/v1/role-bindings");
    expect(admitted.statusCode, admitted.body).toBe(200);
  });

  // =============================================================================================
  // 8. THE `member_of` ROUTE-AROUND — the subset rule at the relationship choke point
  // =============================================================================================

  /** A fresh `group` object with no bindings of its own. */
  async function freshGroup(label: string): Promise<string> {
    const row = await withTenantTx(server.deps.db, org.orgId, async (tx) =>
      createObject(tx, {
        orgId: org.orgId,
        typeId: "group",
        actorObjectId: org.orgId,
        requestId: "rbac-door-memberof",
        name: `${label}-${randomUUID().slice(0, 8)}`
      })
    );
    return row.id;
  }

  /** Live `member_of` edges between a pair — read from the table, never from a response body. */
  async function memberOfEdges(fromId: string, toId: string): Promise<{ id: string }[]> {
    return withTenantTx(server.deps.db, org.orgId, async (tx) =>
      tx
        .select({ id: relationships.id })
        .from(relationships)
        .where(
          and(
            eq(relationships.orgId, org.orgId),
            eq(relationships.typeId, "member_of"),
            eq(relationships.fromId, fromId),
            eq(relationships.toId, toId),
            isNull(relationships.deletedAt)
          )
        )
    );
  }

  it("THE EXPLOIT CHAIN: a lesser principal cannot self-join a group that holds a powerful role", async () => {
    // Measured before the guard, with real requests. See docs/routes.md §358.
    const powerGroup = await freshGroup("power");

    // STEP 1, and it must still be ADMITTED — "bind SecurityOfficer to the security team" is the
    // obvious first operator action, and a guard that refused role-bearing groups outright would
    // delete the feature rather than secure it.
    const bindToGroup = await grant(org.adminToken, {
      subjectId: powerGroup,
      roleId: roleId("Owner"),
      scopeObjectId: org.orgId
    });
    expect(bindToGroup.statusCode, bindToGroup.body).toBe(201);

    // STEP 2 — and this is the request that used to answer 201. See docs/routes.md §359.
    expect(permissionsOf("Operator")).toContain("relationship:write");
    const refused = await call("POST", operator.token, "/api/v1/relationships", {
      typeId: "member_of",
      fromId: operator.objectId,
      toId: powerGroup
    });
    expect(refused.statusCode, refused.body).toBe(403);

    // NAMED, not merely refused, and named with EVERY permission the join would have conferred that
    // the actor does not hold — derived from the live catalogue, so a migration that changes either
    // role's array changes this expectation with it.
    for (const permission of missingFor("Operator", "Owner")) {
      expect(refused.body).toContain(permission);
    }
    // ...and it is §2a's refusal rather than the both-endpoint `relationship:write` bar, read off the
    // message rather than inferred from the status code — both throw 403.
    expect(refused.body).toContain("no-escalation subset rule");

    // THE EDGE DID NOT LAND. Asserting only on the status would pass against a handler that wrote
    // the row and threw afterwards outside a transaction.
    expect(await memberOfEdges(operator.objectId, powerGroup)).toHaveLength(0);

    // AND THE ESCALATION REALLY WAS BLOCKED, measured at the door it would have opened rather than
    // at the door that refused it — the ROLE-BINDING door itself, which is the point of the whole
    // chain. Owner carries `role_binding:write` and Operator does not; had the join landed, the
    // Operator would have inherited it through the group and this grant would have answered 201.
    expect(permissionsOf("Operator")).not.toContain("role_binding:write");
    const stillNotOwner = await grant(operator.token, {
      subjectId: (await freshSubject()).objectId,
      roleId: roleId("Viewer"),
      scopeObjectId: serviceOther
    });
    expect(stillNotOwner.statusCode, stillNotOwner.body).toBe(403);
    expect(stillNotOwner.body).toContain("role_binding:write");
  });

  it("THE ADMISSION PAIR: a principal who DOES hold everything the group carries can still join", async () => {
    // WITHOUT THIS THE GUARD COULD BE A BLANKET REFUSAL AND LOOK CORRECT. Same edge type, same
    // group shape, same body — only the ACTOR differs, which is what says the actor's standing
    // decided the case above rather than `member_of` having been made unwritable.
    const powerGroup = await freshGroup("power-pair");
    const bound = await grant(org.adminToken, {
      subjectId: powerGroup,
      roleId: roleId("Owner"),
      scopeObjectId: org.orgId
    });
    expect(bound.statusCode, bound.body).toBe(201);

    // The bootstrap admin IS Owner at the org root, so every permission the group's binding carries
    // is one it already holds there: the subset rule is satisfied and the join lands.
    const joiner = await freshSubject();
    const admitted = await call("POST", org.adminToken, "/api/v1/relationships", {
      typeId: "member_of",
      fromId: joiner.objectId,
      toId: powerGroup
    });
    expect(admitted.statusCode, admitted.body).toBe(201);
    expect(await memberOfEdges(joiner.objectId, powerGroup)).toHaveLength(1);

    // AND THE MEMBERSHIP REALLY CONFERRED THE AUTHORITY — the property the guard exists to govern,
    // asserted rather than assumed. `joiner` holds no binding of its own; if `subject_expand` did
    // not reach the group's Owner binding, this whole section would be guarding nothing.
    const inherited = await call("GET", joiner.token, "/api/v1/role-bindings");
    expect(inherited.statusCode, inherited.body).toBe(200);
  });

  it("joining a group that holds NO role bindings is unaffected — the common case must not regress", async () => {
    // EVERY ORDINARY TEAM MEMBERSHIP ON THE ESTATE IS THIS CASE, and it is measured with the SAME
    // lesser principal the exploit case refuses. That is what makes this two proofs in one: the
    // common path is untouched, AND the Operator's both-endpoint `relationship:write` is genuinely
    // satisfied — so the 403 above was §2a and not the older bar firing.
    const plainGroup = await freshGroup("plain");
    const admitted = await call("POST", operator.token, "/api/v1/relationships", {
      typeId: "member_of",
      fromId: operator.objectId,
      toId: plainGroup
    });
    expect(admitted.statusCode, admitted.body).toBe(201);
    expect(await memberOfEdges(operator.objectId, plainGroup)).toHaveLength(1);

    // REMOVAL IS A NARROWING AND STAYS UNGATED, in both directions. See docs/routes.md §360.
    const powerGroup = await freshGroup("power-leave");
    const bound = await grant(org.adminToken, {
      subjectId: powerGroup,
      roleId: roleId("Owner"),
      scopeObjectId: org.orgId
    });
    expect(bound.statusCode, bound.body).toBe(201);
    const joined = await call("POST", org.adminToken, "/api/v1/relationships", {
      typeId: "member_of",
      fromId: operator.objectId,
      toId: powerGroup
    });
    expect(joined.statusCode, joined.body).toBe(201);
    const edgeId = (joined.json() as { id: string }).id;

    const left = await call("DELETE", operator.token, `/api/v1/relationships/${edgeId}`);
    expect(left.statusCode, left.body).toBe(200);
    expect(await memberOfEdges(operator.objectId, powerGroup)).toHaveLength(0);
  });

  // =============================================================================================
  // 9. THE LAST ADMINISTRATOR — one request used to brick an org permanently
  // =============================================================================================

  it("the LAST org-root administrative binding cannot be revoked, and the second-to-last can", async () => {
    // MEASURED ON A FRESH ORG before the guard. See docs/routes.md §361.
    const solo = await createTestOrg(server, "rbac-solo");
    const soloOwnerSubject = (
      (
        await server.app.inject({
          method: "GET",
          url: "/api/v1/auth/me",
          headers: bearer(solo.adminToken)
        })
      ).json() as { subjectObjectId: string }
    ).subjectObjectId;

    const listSolo = async () =>
      (
        await server.app.inject({
          method: "GET",
          url: "/api/v1/role-bindings",
          headers: bearer(solo.adminToken)
        })
      ).json() as { items: { id: string; subjectId: string; roleName: string }[] };

    const initial = (await listSolo()).items;
    expect(
      initial.map((b) => b.roleName),
      "a freshly bootstrapped org holds exactly one binding: the admin's org-root Owner"
    ).toEqual(["Owner"]);
    const bootstrapBinding = initial[0]!;
    expect(bootstrapBinding.subjectId).toBe(soloOwnerSubject);

    // THE ADMISSION HALF FIRST, and it is not optional: without it the guard could be a blanket
    // refusal on every revoke of an Owner binding and this case would still be green. Seat a SECOND
    // org-root Owner, then revoke it — two exist, so removing one leaves the org administrable.
    const second = await createTestUser(server, solo, []);
    const granted = await server.app.inject({
      method: "POST",
      url: "/api/v1/role-bindings",
      headers: bearer(solo.adminToken),
      payload: {
        subjectId: second.objectId,
        roleId: roleId("Owner"),
        scopeObjectId: solo.orgId,
        reason: "seating a second Owner"
      }
    });
    expect(granted.statusCode, granted.body).toBe(201);
    const secondBindingId = (granted.json() as { id: string }).id;

    const revokedSecond = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/role-bindings/${secondBindingId}`,
      headers: bearer(solo.adminToken),
      payload: { reason: "revoking one of TWO administrative bindings" }
    });
    expect(revokedSecond.statusCode, revokedSecond.body).toBe(200);
    expect((await listSolo()).items.map((b) => b.id)).toEqual([bootstrapBinding.id]);

    // THE REFUSAL — the identical verb against the identical role at the identical scope, differing
    // only in that this row is now the LAST one.
    const refused = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/role-bindings/${bootstrapBinding.id}`,
      headers: bearer(solo.adminToken),
      payload: { reason: "the org's only Owner revoking itself" }
    });
    // 409 and not 403: the caller's standing is not in question — an Owner has every standing there
    // is. The request conflicts with the STATE of the org, and a 403 would read as an authority bug.
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.body).toContain("role_binding:write");
    expect(refused.body).toContain("Owner");

    // THE ROW SURVIVED, AND THE ORG IS STILL ADMINISTRABLE. Asserting on the status code alone would
    // pass against a handler that deleted first and threw afterwards outside a transaction — which
    // is exactly the shape that leaves the estate in the state this guard exists to prevent.
    expect((await listSolo()).items.map((b) => b.id)).toEqual([bootstrapBinding.id]);
    const stillWorks = await server.app.inject({
      method: "GET",
      url: "/api/v1/roles",
      headers: bearer(solo.adminToken)
    });
    expect(stillWorks.statusCode, stillWorks.body).toBe(200);
  });

  // =============================================================================================
  // 10. THE OTHER ORDERING — a binding written ONTO a group somebody already joined (§2b)
  // =============================================================================================

  /** Tombstone an object's row while leaving its edges live. See docs/routes.md §362. */
  async function tombstoneObjectRowOnly(objectId: string): Promise<void> {
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx.execute(
        sql`UPDATE objects SET deleted_at = now() WHERE org_id = ${org.orgId}::uuid AND id = ${objectId}::uuid`
      );
    });
  }

  async function joinGroup(token: string, fromId: string, toId: string) {
    return call("POST", token, "/api/v1/relationships", { typeId: "member_of", fromId, toId });
  }

  it("ORDERING: join an EMPTY group first, then grant to it — what is and is not refused", async () => {
    // THE REVERSED ORDERING, MEASURED END TO END. See docs/routes.md §363.
    const team = await freshGroup("reversed-order");

    // STEP 1 — the Operator joins while the team holds nothing. MUST be 201: it is the same request
    // as "joining a group that holds NO role bindings is unaffected", which is every ordinary team
    // membership on the estate.
    const joined = await joinGroup(operator.token, operator.objectId, team);
    expect(joined.statusCode, joined.body).toBe(201);

    // STEP 2 — the Owner binds Owner to the team. Admitted, by a principal who holds Owner.
    const bound = await grant(org.adminToken, {
      subjectId: team,
      roleId: roleId("Owner"),
      scopeObjectId: org.orgId
    });
    expect(bound.statusCode, bound.body).toBe(201);

    // STEP 3 — and the Operator has really inherited it, measured at a door Operator cannot open on
    // its own. This is the estate consequence, asserted rather than described: an Owner's grant
    // reached a principal the Owner never named, through a membership the beneficiary authored.
    expect(permissionsOf("Operator")).not.toContain("role_binding:write");
    const inherited = await grant(operator.token, {
      subjectId: (await freshSubject()).objectId,
      roleId: roleId("Viewer"),
      scopeObjectId: serviceOther
    });
    expect(
      inherited.statusCode,
      "the reversed ordering confers the group's authority — if this is no longer 201, the grant " +
        "door has become subject-sensitive and `docs/authz/role-binding-door.md` §2b's measurement is stale"
    ).toBe(201);

    // CLEAN UP, so the Operator does not carry Owner into the cases below. Revoking the group's
    // binding removes it from every member at once, which is the only revoke verb there is for it.
    const revoked = await call(
      "DELETE",
      org.adminToken,
      `/api/v1/role-bindings/${(bound.json() as { id: string }).id}`,
      { reason: "reversed-ordering case cleanup" }
    );
    expect(revoked.statusCode, revoked.body).toBe(200);
    const noLonger = await grant(operator.token, {
      subjectId: (await freshSubject()).objectId,
      roleId: roleId("Viewer"),
      scopeObjectId: serviceOther
    });
    expect(noLonger.statusCode, noLonger.body).toBe(403);
  });

  it("§2b: a grant to a TEAM is refused when it would reach a soft-deleted principal", async () => {
    // A DIRECT grant to a tombstoned principal is a 404 — `getObjectByIdOrUrnAnyType` refuses a
    // soft-deleted row. Through a group it was a 201, because the subject expansion filters
    // `relationships.deleted_at` and never `objects.deleted_at`. So the same authority, conferred on
    // the same principal, was refused by name and admitted by membership.
    const team = await freshGroup("tombstoned-member");
    const ghost = await freshSubject();
    const joined = await joinGroup(org.adminToken, ghost.objectId, team);
    expect(joined.statusCode, joined.body).toBe(201);
    await tombstoneObjectRowOnly(ghost.objectId);

    // THE FIXTURE'S SELF-CHECK: the EDGE must still be live, or this case measures nothing. (It is
    // written raw for exactly this reason — see `tombstoneObjectRowOnly`.)
    expect(
      await memberOfEdges(ghost.objectId, team),
      "the member_of edge must survive the tombstone, or §2b's liveness arm is untested"
    ).toHaveLength(1);

    const refused = await grant(orgAdmin.token, {
      subjectId: team,
      roleId: roleId("ServiceAdmin"),
      scopeObjectId: serviceS
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.body).toContain(ghost.objectId);
    expect(refused.body).toContain("soft-deleted");
    expect(await bindingRows(team, roleId("ServiceAdmin"), serviceS)).toHaveLength(0);

    // AND THE DIRECT GRANT REALLY IS REFUSED TOO — the fact §2b is restoring symmetry with. Asserted
    // rather than assumed: if a direct grant to a tombstoned subject were admitted, §2b would be
    // narrowing the door rather than making it consistent.
    const direct = await grant(orgAdmin.token, {
      subjectId: ghost.objectId,
      roleId: roleId("ServiceAdmin"),
      scopeObjectId: serviceS
    });
    expect(direct.statusCode, direct.body).toBe(404);
  });

  it("§2b ADMISSION PAIR: the same grant to the same team lands once the membership is clean", async () => {
    // Without this, the guard could refuse everything and pass. See docs/routes.md §364.
    const team = await freshGroup("clean-members");
    const memberA = await freshSubject();
    const memberB = await freshSubject();
    for (const member of [memberA, memberB]) {
      const joined = await joinGroup(org.adminToken, member.objectId, team);
      expect(joined.statusCode, joined.body).toBe(201);
    }

    const admitted = await grant(orgAdmin.token, {
      subjectId: team,
      roleId: roleId("ServiceAdmin"),
      scopeObjectId: serviceS
    });
    expect(admitted.statusCode, admitted.body).toBe(201);

    // AND THE EMPTY GROUP, which empowers nobody and must also stay a 201 — the case that says the
    // guard is about the members rather than about the subject being a group at all.
    const emptyTeam = await freshGroup("empty");
    const emptyAdmitted = await grant(orgAdmin.token, {
      subjectId: emptyTeam,
      roleId: roleId("ServiceAdmin"),
      scopeObjectId: serviceS
    });
    expect(emptyAdmitted.statusCode, emptyAdmitted.body).toBe(201);
  });

  it("§2b is TRANSITIVE: a grant to the OUTER group sees a bad principal in the inner one", async () => {
    // NESTED MEMBERSHIP IS THE CASE A SINGLE-HOP WALK GETS WRONG, and it is the direction §2a cannot
    // cover from its end: `memberExpandCte` is seeded at the group being bound and walks DOWN, so
    // inner ⊂ outer has to be reached by recursion rather than by one join. A guard that looked only
    // at direct members would admit this and confer the role on the ghost anyway.
    const outer = await freshGroup("outer");
    const inner = await freshGroup("inner");
    const nested = await joinGroup(org.adminToken, inner, outer);
    expect(nested.statusCode, nested.body).toBe(201);

    const ghost = await freshSubject();
    const joined = await joinGroup(org.adminToken, ghost.objectId, inner);
    expect(joined.statusCode, joined.body).toBe(201);
    await tombstoneObjectRowOnly(ghost.objectId);

    const refused = await grant(orgAdmin.token, {
      subjectId: outer,
      roleId: roleId("ComponentAdmin"),
      scopeObjectId: componentC
    });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.body).toContain(ghost.objectId);
    expect(await bindingRows(outer, roleId("ComponentAdmin"), componentC)).toHaveLength(0);

    // THE PAIR, one hop away: binding the INNER group is refused for the same reason (the ghost is a
    // direct member there), and binding a THIRD group nested the same way but holding only live
    // members is admitted — so the refusal tracks the membership, not the nesting.
    const cleanOuter = await freshGroup("outer-clean");
    const cleanInner = await freshGroup("inner-clean");
    expect((await joinGroup(org.adminToken, cleanInner, cleanOuter)).statusCode).toBe(201);
    const liveMember = await freshSubject();
    expect((await joinGroup(org.adminToken, liveMember.objectId, cleanInner)).statusCode).toBe(201);
    const admitted = await grant(orgAdmin.token, {
      subjectId: cleanOuter,
      roleId: roleId("ComponentAdmin"),
      scopeObjectId: componentC
    });
    expect(admitted.statusCode, admitted.body).toBe(201);
  });

  it("§2a: joining a group that holds an org-defined role COLLIDING with a built-in name is refused", async () => {
    // THE ROLE-**NAME** HOLE IN A PERMISSIONS-ONLY SUBSET TEST. See docs/routes.md §365.
    const collidingRoleId = randomUUID();
    const quorumGroup = await freshGroup("quorum-bypass");
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await tx.execute(sql`
        INSERT INTO roles (id, org_id, name, permissions)
        VALUES (${collidingRoleId}::uuid, ${org.orgId}::uuid, 'Approver', ARRAY[]::text[])
      `);
      await tx.execute(sql`
        INSERT INTO role_bindings (id, org_id, subject_id, role_id, scope_object_id, effect)
        VALUES (gen_random_uuid(), ${org.orgId}::uuid, ${quorumGroup}::uuid,
                ${collidingRoleId}::uuid, ${org.orgId}::uuid, 'allow')
      `);
    });

    // THE ACTOR IS THE OWNER — the strongest principal there is. A permissions-only test admits this
    // for ANY actor, because the empty array is a subset of everything, so proving the refusal with a
    // weak actor would leave it indistinguishable from the ordinary subset refusal.
    const refused = await joinGroup(org.adminToken, (await freshSubject()).objectId, quorumGroup);
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.body).toContain("Approver");
    expect(refused.body).toContain("by NAME");

    // THE PAIR: the same actor, the same shape, a group holding a BUILT-IN role whose permissions the
    // actor does hold. For a built-in, name and permissions travel together, so the permission subset
    // test IS what the grant door would have allowed and nothing extra is demanded.
    const builtInGroup = await freshGroup("builtin-role");
    const boundBuiltIn = await grant(org.adminToken, {
      subjectId: builtInGroup,
      roleId: roleId("ServiceAdmin"),
      scopeObjectId: serviceS
    });
    expect(boundBuiltIn.statusCode, boundBuiltIn.body).toBe(201);
    const admitted = await joinGroup(org.adminToken, (await freshSubject()).objectId, builtInGroup);
    expect(admitted.statusCode, admitted.body).toBe(201);
  });

  it("`Idempotency-Key` replay is scoped to the ACTOR, not just the org", async () => {
    // `idempotency_keys` is keyed `(org_id, idempotency_key)`, so a stored result is handed to
    // whoever presents the key next. On this route the stored result is an AUTHORITY RECORD — the
    // binding's id, subject, role and scope — so a principal holding nothing could replay an
    // administrator's grant and read it back, on the one door in the system that hands out authority.
    const key = `rbac-idem-${randomUUID()}`;
    const subject = await freshSubject();
    const body = {
      subjectId: subject.objectId,
      roleId: roleId("Viewer"),
      scopeObjectId: componentC,
      reason: "the original grant"
    };
    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/role-bindings",
      headers: { ...bearer(orgAdmin.token), "idempotency-key": key },
      payload: body
    });
    expect(created.statusCode, created.body).toBe(201);
    const bindingId = (created.json() as { id: string }).id;

    // THE ORIGINAL ACTOR'S OWN RETRY STILL REPLAYS — without this the fix would be "keys stopped
    // working", which is a different bug and would satisfy the refusal assertion below.
    const retried = await server.app.inject({
      method: "POST",
      url: "/api/v1/role-bindings",
      headers: { ...bearer(orgAdmin.token), "idempotency-key": key },
      payload: body
    });
    expect(retried.statusCode, retried.body).toBe(201);
    expect((retried.json() as { id: string }).id).toBe(bindingId);

    // A DIFFERENT PRINCIPAL, holding nothing, presenting the same key and the same body.
    const unbound = await createTestUser(server, org, []);
    const stolen = await server.app.inject({
      method: "POST",
      url: "/api/v1/role-bindings",
      headers: { ...bearer(unbound.token), "idempotency-key": key },
      payload: body
    });
    expect(stolen.statusCode, stolen.body).not.toBe(201);
    // AND THE RECORD DID NOT LEAK. The status alone would pass against a 422 that helpfully echoed
    // the stored response; what matters is that the binding id is not in the body.
    expect(stolen.body).not.toContain(bindingId);
  });

  // =============================================================================================
  // 11. THE LAST-ADMINISTRATOR FLOOR COUNTS REACHABLE PRINCIPALS, NOT ROWS
  // =============================================================================================

  it("the floor is not satisfied by a binding on an EMPTY group — the two-request brick", async () => {
    // MEASURED against the row-counting version of §7. See docs/routes.md §366.
    const solo = await createTestOrg(server, "rbac-empty-group-floor");
    const listSolo = async () =>
      (
        await server.app.inject({
          method: "GET",
          url: "/api/v1/role-bindings",
          headers: bearer(solo.adminToken)
        })
      ).json() as { items: { id: string; subjectId: string; roleName: string }[] };

    const initial = (await listSolo()).items;
    expect(initial.map((b) => b.roleName)).toEqual(["Owner"]);
    const bootstrapBinding = initial[0]!;

    // REQUEST 1 — a real, admitted grant. An Owner binding Owner to a team is the canonical
    // documented action and must stay a 201; it is the SECOND request that has to be refused.
    const emptyTeam = await withTenantTx(server.deps.db, solo.orgId, async (tx) =>
      createObject(tx, {
        orgId: solo.orgId,
        typeId: "team",
        actorObjectId: solo.orgId,
        requestId: "rbac-empty-group-floor",
        name: `ghost-admins-${randomUUID().slice(0, 8)}`
      })
    );
    const bound = await server.app.inject({
      method: "POST",
      url: "/api/v1/role-bindings",
      headers: bearer(solo.adminToken),
      payload: {
        subjectId: emptyTeam.id,
        roleId: roleId("Owner"),
        scopeObjectId: solo.orgId,
        reason: "binding Owner to a team nobody is in",
        // D7: `[]` is the acknowledgement for an EMPTY group and is the whole point of that being
        // expressible — this is the legitimate seat-the-team-later flow, and it is also the shape
        // the floor must refuse to count. Both are true at once, which is why D7 informs rather
        // than refuses.
        acknowledgedPrincipalIds: []
      }
    });
    expect(bound.statusCode, bound.body).toBe(201);
    expect((await listSolo()).items).toHaveLength(2);

    // REQUEST 2 — the brick. Two rows survive the delete; neither of the two is reachable by a live
    // principal once this one goes.
    const refused = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/role-bindings/${bootstrapBinding.id}`,
      headers: bearer(solo.adminToken),
      payload: { reason: "revoking the only REACHABLE administrative binding" }
    });
    expect(refused.statusCode, refused.body).toBe(409);
    // The message moved from naming types to naming reachability. See docs/routes.md §367.
    expect(refused.body).toContain("role_binding:write");
    expect(refused.body).toContain("a binding on an EMPTY group");

    // THE ROW SURVIVED AND THE ORG IS STILL ADMINISTRABLE — asserting on the status alone would pass
    // against a handler that deleted first and threw afterwards outside a transaction.
    expect((await listSolo()).items.map((b) => b.id)).toContain(bootstrapBinding.id);
    const stillWorks = await server.app.inject({
      method: "GET",
      url: "/api/v1/roles",
      headers: bearer(solo.adminToken)
    });
    expect(stillWorks.statusCode, stillWorks.body).toBe(200);

    // THE ADMISSION PAIR, AND IT IS THE POINT OF THE WHOLE FIX. See docs/routes.md §368.
    const successor = await createTestUser(server, solo, []);
    const joined = await server.app.inject({
      method: "POST",
      url: "/api/v1/relationships",
      headers: bearer(solo.adminToken),
      payload: { typeId: "member_of", fromId: successor.objectId, toId: emptyTeam.id }
    });
    expect(joined.statusCode, joined.body).toBe(201);

    const admitted = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/role-bindings/${bootstrapBinding.id}`,
      headers: bearer(solo.adminToken),
      payload: { reason: "retiring the bootstrap admin now the team has a live member" }
    });
    expect(admitted.statusCode, admitted.body).toBe(200);

    // AND THE SUCCESSOR REALLY CAN ADMINISTER — the property the count is a proxy for, asserted
    // rather than assumed. If `member_of` did not confer the team's Owner binding, the "reachable
    // principal" count would be measuring something that is not authority.
    const successorGrants = await server.app.inject({
      method: "POST",
      url: "/api/v1/role-bindings",
      headers: bearer(successor.token),
      payload: {
        subjectId: (await createTestUser(server, solo, [])).objectId,
        roleId: roleId("Viewer"),
        scopeObjectId: solo.orgId,
        reason: "the successor administering after the bootstrap admin retired"
      }
    });
    expect(successorGrants.statusCode, successorGrants.body).toBe(201);
  });

  it("the floor does not count a group whose only member is SOFT-DELETED", async () => {
    // THE SAME BYPASS ONE STEP LATER: seat the team, then tombstone its only member. The team's
    // binding is still a row and still has a `member_of` edge under it, so a count that stopped at
    // "does any principal resolve" without checking liveness would report the org administrable
    // through a principal the grant door itself refuses to bind (§2b).
    const solo = await createTestOrg(server, "rbac-dead-member-floor");
    const listSolo = async () =>
      (
        await server.app.inject({
          method: "GET",
          url: "/api/v1/role-bindings",
          headers: bearer(solo.adminToken)
        })
      ).json() as { items: { id: string }[] };
    const bootstrapBinding = (await listSolo()).items[0]!;

    const team = await withTenantTx(server.deps.db, solo.orgId, async (tx) =>
      createObject(tx, {
        orgId: solo.orgId,
        typeId: "team",
        actorObjectId: solo.orgId,
        requestId: "rbac-dead-member-floor",
        name: `dead-admins-${randomUUID().slice(0, 8)}`
      })
    );
    const doomed = await createTestUser(server, solo, []);
    const joined = await server.app.inject({
      method: "POST",
      url: "/api/v1/relationships",
      headers: bearer(solo.adminToken),
      payload: { typeId: "member_of", fromId: doomed.objectId, toId: team.id }
    });
    expect(joined.statusCode, joined.body).toBe(201);

    const bound = await server.app.inject({
      method: "POST",
      url: "/api/v1/role-bindings",
      headers: bearer(solo.adminToken),
      payload: {
        subjectId: team.id,
        roleId: roleId("Owner"),
        scopeObjectId: solo.orgId,
        reason: "seating a successor team",
        // D7 — the team's one live member, acknowledged.
        acknowledgedPrincipalIds: [doomed.objectId]
      }
    });
    expect(bound.statusCode, bound.body).toBe(201);

    // THE ADMISSION HALF FIRST, while the member is alive: the revoke is admitted, so the refusal
    // below is caused by the tombstone and by nothing else about this fixture.
    // (Re-granted immediately, because the case needs the bootstrap binding back.)
    const admitted = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/role-bindings/${bootstrapBinding.id}`,
      headers: bearer(solo.adminToken),
      payload: { reason: "admitted while the team has a live member" }
    });
    expect(admitted.statusCode, admitted.body).toBe(200);
    const restored = await server.app.inject({
      method: "POST",
      url: "/api/v1/role-bindings",
      headers: bearer(doomed.token),
      payload: {
        subjectId: (
          (
            await server.app.inject({
              method: "GET",
              url: "/api/v1/auth/me",
              headers: bearer(solo.adminToken)
            })
          ).json() as { subjectObjectId: string }
        ).subjectObjectId,
        roleId: roleId("Owner"),
        scopeObjectId: solo.orgId,
        reason: "restoring the bootstrap admin's binding, granted by the team-derived Owner"
      }
    });
    expect(restored.statusCode, restored.body).toBe(201);
    const restoredId = (restored.json() as { id: string }).id;

    // NOW TOMBSTONE THE TEAM'S ONLY MEMBER, leaving the edge live — the replica / import / restored-
    // dump shape (`deleteObject` would cascade the edge; see §2b).
    await withTenantTx(server.deps.db, solo.orgId, async (tx) => {
      await tx.execute(
        sql`UPDATE objects SET deleted_at = now() WHERE org_id = ${solo.orgId}::uuid AND id = ${doomed.objectId}::uuid`
      );
    });

    const refused = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/role-bindings/${restoredId}`,
      headers: bearer(solo.adminToken),
      payload: { reason: "the team's only member is a tombstone" }
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect((await listSolo()).items.map((b) => b.id)).toContain(restoredId);
  });

  // Concurrency: the third ordering, which is neither of those. See docs/routes.md §369.

  async function listBindingsAs(token: string) {
    const res = await server.app.inject({
      method: "GET",
      url: "/api/v1/role-bindings",
      headers: bearer(token)
    });
    return {
      statusCode: res.statusCode,
      items: (res.json() as { items: { id: string; subjectId: string; roleName: string }[] }).items
    };
  }

  /** Org-root `role_binding:write`-carrying `allow` bindings, read from the TABLE — the count §7 is
   *  a guard over, measured without an API call so it does not depend on a token still working. */
  async function administrativeBindingCount(orgId: string): Promise<number> {
    const rows = await withTenantTx(server.deps.db, orgId, async (tx) =>
      tx.execute<{ n: string }>(sql`
        SELECT count(*)::text AS n
        FROM role_bindings rb
        JOIN roles rl ON rl.id = rb.role_id
        WHERE rb.org_id = ${orgId}::uuid
          AND rb.effect = 'allow'
          AND rb.scope_object_id = ${orgId}::uuid
          AND 'role_binding:write' = ANY(rl.permissions)
      `)
    );
    return Number(rows.rows[0]!.n);
  }

  it("CONCURRENCY: two simultaneous revokes cannot empty an org's administrative bindings", async () => {
    // The measurement this case exists for, on a fresh org. See docs/routes.md §370.
    const ATTEMPTS = 8;
    const outcomes: string[] = [];

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const solo = await createTestOrg(server, `rbac-race-revoke-${attempt}`);
      const initial = await listBindingsAs(solo.adminToken);
      expect(initial.items.map((b) => b.roleName)).toEqual(["Owner"]);
      const bootstrapBinding = initial.items[0]!;

      // A SECOND LIVE ORG-ROOT OWNER, seated through the door. Two administrators, two tokens, two
      // separate revokes — neither of which is refusable on its own.
      const second = await createTestUser(server, solo, []);
      const granted = await server.app.inject({
        method: "POST",
        url: "/api/v1/role-bindings",
        headers: bearer(solo.adminToken),
        payload: {
          subjectId: second.objectId,
          roleId: roleId("Owner"),
          scopeObjectId: solo.orgId,
          reason: "seating the second of two administrators"
        }
      });
      expect(granted.statusCode, granted.body).toBe(201);
      const secondBindingId = (granted.json() as { id: string }).id;
      expect(await administrativeBindingCount(solo.orgId)).toBe(2);

      // Two actors each retiring their own binding at once. See docs/routes.md §371.
      const [byBootstrap, bySecond] = await Promise.all([
        server.app.inject({
          method: "DELETE",
          url: `/api/v1/role-bindings/${bootstrapBinding.id}`,
          headers: bearer(solo.adminToken),
          payload: { reason: "concurrent revoke A — the bootstrap admin retiring itself" }
        }),
        server.app.inject({
          method: "DELETE",
          url: `/api/v1/role-bindings/${secondBindingId}`,
          headers: bearer(second.token),
          payload: { reason: "concurrent revoke B — the second administrator retiring itself" }
        })
      ]);
      const codes = [byBootstrap.statusCode, bySecond.statusCode];
      outcomes.push(codes.join(","));

      // EXACTLY ONE 200 AND EXACTLY ONE 409 — the only two outcomes a serial execution admits. The
      // whole array is asserted rather than a count, so a CI failure prints which attempt and which
      // pair rather than "expected 1 to be 2".
      expect(
        [...codes].sort(),
        `attempt ${attempt}: outcomes so far ${JSON.stringify(outcomes)} — a [200,200] pair means ` +
          `both revokes were admitted against a survivor the other was deleting, which is the ` +
          `check-then-act race docs/authz/role-binding-door.md §0's advisory lock exists to close. ` +
          `A=${byBootstrap.body} B=${bySecond.body}`
      ).toEqual([200, 409]);

      // AN ADMINISTRATOR SURVIVED. The status codes alone would pass against a handler that answered
      // 409 after committing its delete, so this reads the TABLE.
      expect(
        await administrativeBindingCount(solo.orgId),
        `attempt ${attempt}: the org was left with no org-root administrative binding — bricked`
      ).toBe(1);

      // AND THE ORG IS STILL ADMINISTRABLE THROUGH THE SURVIVOR, which is the property the count is
      // a proxy for. Whichever revoke was REFUSED still holds its binding.
      const survivorToken = byBootstrap.statusCode === 409 ? solo.adminToken : second.token;
      const stillWorks = await server.app.inject({
        method: "GET",
        url: "/api/v1/roles",
        headers: bearer(survivorToken)
      });
      expect(stillWorks.statusCode, stillWorks.body).toBe(200);
    }
  });

  it("CONCURRENCY: a `member_of` join and a grant onto the same team cannot both be admitted", async () => {
    // Why the instrument had to be one that covers both. See docs/routes.md §372.
    const ATTEMPTS = 6;
    const outcomes: string[] = [];

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const team = await freshGroup(`race-team-${attempt}`);
      const joiningGroup = await freshGroup(`race-joiner-${attempt}`);

      const benign = await grant(org.adminToken, {
        subjectId: team,
        roleId: roleId("Viewer"),
        scopeObjectId: org.orgId
      });
      expect(benign.statusCode, benign.body).toBe(201);

      // The tombstoned principal that makes the GRANT refusable once `joiningGroup` is inside the
      // team. Written raw for `tombstoneObjectRowOnly`'s stated reason.
      const ghost = await freshSubject();
      expect((await joinGroup(org.adminToken, ghost.objectId, joiningGroup)).statusCode).toBe(201);
      await tombstoneObjectRowOnly(ghost.objectId);

      // A FRESH org-root Operator per attempt, so an admitted join in one attempt cannot change what
      // the next attempt's actor holds.
      const weak = await createTestUser(server, org, [{ role: "Operator", scope: org.orgId }]);

      expect(missingFor("Operator", "SecurityOfficer")).not.toHaveLength(0);
      const [grantRes, joinRes] = await Promise.all([
        grant(org.adminToken, {
          subjectId: team,
          roleId: roleId("SecurityOfficer"),
          scopeObjectId: org.orgId
        }),
        joinGroup(weak.token, joiningGroup, team)
      ]);
      const codes = [grantRes.statusCode, joinRes.statusCode];
      outcomes.push(codes.join(","));

      expect(
        codes.filter((c) => c >= 400),
        `attempt ${attempt}: outcomes so far ${JSON.stringify(outcomes)} — grant=${grantRes.body} ` +
          `join=${joinRes.body}. Exactly one of the two must be refused: every serial order of ` +
          `these two requests refuses one, so admitting both is an outcome no serial execution ` +
          `produces (docs/authz/role-binding-door.md §0)`
      ).toHaveLength(1);

      // AND THE END STATE MATCHES ONE OF THE TWO SERIAL ONES, read from the tables rather than
      // inferred from the status codes: the team never both holds the binding and contains the
      // group. That conjunction IS the escalation — the Operator would reach Owner through a group
      // whose join §2a refuses.
      const teamHoldsRole =
        (await bindingRows(team, roleId("SecurityOfficer"), org.orgId)).length > 0;
      const groupIsInTeam = (await memberOfEdges(joiningGroup, team)).length > 0;
      expect(
        [teamHoldsRole, groupIsInTeam],
        `attempt ${attempt}: the team holds SecurityOfficer AND the concurrently-joined group is ` +
          `inside it — neither door saw the other's write`
      ).not.toEqual([true, true]);
    }
  });

  // =============================================================================================
  // 13. DISCLOSURE ORDERING, AND ONE MEASURED OPEN PROPERTY
  // =============================================================================================

  it("§2b's 422 names group members only AFTER the authority bars have admitted the caller", async () => {
    // The one grant-path message derived from other rows. See docs/routes.md §373.
    const team = await freshGroup("disclosure");
    const ghost = await freshSubject();
    expect((await joinGroup(org.adminToken, ghost.objectId, team)).statusCode).toBe(201);
    await tombstoneObjectRowOnly(ghost.objectId);

    // THE CALLER WITH NO STANDING. `serviceAdmin` holds full authority over `serviceS` and no
    // `role_binding:write` anywhere, so bar §1 refuses it — and it must learn nothing else.
    expect(permissionsOf("ServiceAdmin")).not.toContain("role_binding:write");
    const refused = await grant(serviceAdmin.token, {
      subjectId: team,
      roleId: roleId("ServiceAdmin"),
      scopeObjectId: serviceS
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(
      refused.body,
      "the 403 named a principal inside the group — §2b ran before the authority bars"
    ).not.toContain(ghost.objectId);
    expect(refused.body).not.toContain("soft-deleted");

    // THE ADMISSION PAIR, and it is what says the reorder did not simply delete §2b: the SAME body
    // from an actor who DOES clear both bars still gets §2b's 422, still naming the ghost.
    const named = await grant(orgAdmin.token, {
      subjectId: team,
      roleId: roleId("ServiceAdmin"),
      scopeObjectId: serviceS
    });
    expect(named.statusCode, named.body).toBe(422);
    expect(named.body).toContain(ghost.objectId);
    expect(named.body).toContain("soft-deleted");
  });

  it("MEASUREMENT (open, not a guard): role NAME authority is conferred by a permissions-subset grant", async () => {
    // NOT A REFUSAL CASE. See docs/routes.md §374.
    expect(
      permissionsOf("Approver").filter((p) => !permissionsOf("OrgAdmin").includes(p)),
      "Approver must stay a permission-subset of OrgAdmin, or this measurement is of something else"
    ).toEqual([]);

    const subject = await freshSubject();
    const admitted = await grant(orgAdmin.token, {
      subjectId: subject.objectId,
      roleId: roleId("Approver"),
      scopeObjectId: serviceS
    });
    expect(admitted.statusCode, admitted.body).toBe(201);

    // Read with the resolver the APPROVAL path uses, not with a re-implementation of it: this is
    // the exact call `governance/` makes to decide whether a vote counts toward a quorum that names
    // a role. The grantee is eligible; the OrgAdmin who granted it is not.
    const [granteeIsApprover, granterIsApprover] = await withTenantTx(
      server.deps.db,
      org.orgId,
      async (tx) => [
        await hasRoleAtScope(tx, {
          orgId: org.orgId,
          subjectObjectId: subject.objectId,
          roleName: "Approver",
          scopeObjectId: serviceS
        }),
        await hasRoleAtScope(tx, {
          orgId: org.orgId,
          subjectObjectId: orgAdmin.objectId,
          roleName: "Approver",
          scopeObjectId: serviceS
        })
      ]
    );
    expect(
      [granteeIsApprover, granterIsApprover],
      "if this is no longer [true, false] the door has grown a role-NAME bar and " +
        "`docs/authz/role-binding-door.md` §2a/§8's 'not checked' statement is now false — rewrite it"
    ).toEqual([true, false]);
  });

  /** The bootstrap admin's graph `user` object id — the subject of the org's Owner binding. */
  async function bootstrapOwnerSubjectId(): Promise<string> {
    const me = await call("GET", org.adminToken, "/api/v1/auth/me");
    if (me.statusCode !== 200) throw new Error(`GET /auth/me failed: ${me.statusCode} ${me.body}`);
    return (me.json() as { subjectObjectId: string }).subjectObjectId;
  }
});

/** A single-quoted SQL literal for the trigger body. The value is a test-generated UUID, never
 *  caller input; this exists so the DDL string above reads as SQL rather than as concatenation. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
