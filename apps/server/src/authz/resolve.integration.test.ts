import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { and, eq, isNull } from "drizzle-orm";
import { withTenantTx } from "../db/tenant-tx.js";
import { roleBindings, roles } from "../db/schema.js";
import { createObject } from "../graph/objects-repo.js";
import { createRelationship } from "../graph/relationships-repo.js";
import { authorize, hasPermission, type Permission } from "./resolve.js";
import {
  buildTestServer,
  createTestOrg,
  type TestOrg,
  type TestServer
} from "../test-support/harness.js";

/**
 * PR #4 security review, CRITICAL 2 / BUILD_AND_TEST.md §9 ("RBAC inheritance + deny-override
 * matrix"): direct integration coverage of the permission evaluator (authz/resolve.ts) against
 * real Postgres — containment inheritance, scope non-leakage, deny-override (direct and via
 * groups), member_of expansion (flat and nested, user and service-account subjects), default
 * deny, and unknown permissions failing closed.
 *
 * Fixture containment: orgRoot ─▶ domain D ─▶ service S (plus sibling domain D2 for
 * non-leakage checks). Subjects are created per-case so bindings never interfere.
 */
describe("RBAC evaluator: inheritance + deny-override matrix", () => {
  let server: TestServer;
  let org: TestOrg;
  let orgRootId: string;
  let domainId: string;
  let siblingDomainId: string;
  let serviceId: string;

  async function makeSubject(typeId: "user" | "service-account" | "group" | "team", name: string) {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      createObject(tx, {
        orgId: org.orgId,
        typeId,
        actorObjectId: org.orgId,
        requestId: "authz-matrix-setup",
        name
      })
    );
  }

  async function bind(
    subjectId: string,
    roleName: string,
    scopeObjectId: string,
    effect: "allow" | "deny" = "allow"
  ): Promise<void> {
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      const role = await tx.query.roles.findFirst({
        where: and(isNull(roles.orgId), eq(roles.name, roleName))
      });
      if (!role) throw new Error(`built-in role '${roleName}' not found`);
      await tx.insert(roleBindings).values({
        id: uuidv7(),
        orgId: org.orgId,
        subjectId,
        roleId: role.id,
        scopeObjectId,
        effect
      });
    });
  }

  async function memberOf(fromId: string, toId: string): Promise<void> {
    await withTenantTx(server.deps.db, org.orgId, async (tx) => {
      await createRelationship(tx, {
        orgId: org.orgId,
        actorObjectId: org.orgId,
        requestId: "authz-matrix-setup",
        typeId: "member_of",
        fromId,
        toId
      });
    });
  }

  async function can(subjectId: string, permission: Permission, scopeId: string): Promise<boolean> {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      hasPermission(tx, {
        orgId: org.orgId,
        subjectObjectId: subjectId,
        permission,
        scopeObjectId: scopeId
      })
    );
  }

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "authz-matrix");
    orgRootId = org.orgId; // org root object id === org id (bootstrap invariant)

    const domain = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createObject(tx, {
        orgId: org.orgId,
        typeId: "domain",
        actorObjectId: org.orgId,
        requestId: "authz-matrix-setup",
        name: "authz-domain"
      })
    );
    domainId = domain.id;

    const sibling = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createObject(tx, {
        orgId: org.orgId,
        typeId: "domain",
        actorObjectId: org.orgId,
        requestId: "authz-matrix-setup",
        name: "authz-sibling-domain"
      })
    );
    siblingDomainId = sibling.id;

    const service = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      createObject(tx, {
        orgId: org.orgId,
        typeId: "service",
        actorObjectId: org.orgId,
        requestId: "authz-matrix-setup",
        name: "authz-service",
        domainId: domain.id
      })
    );
    serviceId = service.id;
  });

  afterAll(async () => {
    await server.close();
  });

  it("1. allow at org root is inherited downward (root -> domain -> service)", async () => {
    const user = await makeSubject("user", "matrix-root-viewer");
    await bind(user.id, "Viewer", orgRootId);

    expect(await can(user.id, "object:read", orgRootId)).toBe(true);
    expect(await can(user.id, "object:read", domainId)).toBe(true);
    expect(await can(user.id, "object:read", serviceId)).toBe(true);
  });

  it("2. allow at a narrow scope does NOT leak upward or sideways", async () => {
    const user = await makeSubject("user", "matrix-narrow-viewer");
    await bind(user.id, "Viewer", serviceId);

    expect(await can(user.id, "object:read", serviceId)).toBe(true); // at the scope itself
    expect(await can(user.id, "object:read", domainId)).toBe(false); // not upward
    expect(await can(user.id, "object:read", orgRootId)).toBe(false); // not to the root
    expect(await can(user.id, "object:read", siblingDomainId)).toBe(false); // not sideways
  });

  it("3. deny at a narrow scope overrides a broader allow (deny-override)", async () => {
    const user = await makeSubject("user", "matrix-denied-at-service");
    await bind(user.id, "Viewer", orgRootId, "allow");
    await bind(user.id, "Viewer", serviceId, "deny");

    expect(await can(user.id, "object:read", serviceId)).toBe(false); // denied at the leaf
    expect(await can(user.id, "object:read", domainId)).toBe(true); // deny does not radiate up
    expect(await can(user.id, "object:read", orgRootId)).toBe(true);
  });

  it("4. deny-override when BOTH bindings arrive via group memberships", async () => {
    const user = await makeSubject("user", "matrix-two-groups");
    const allowGroup = await makeSubject("group", "matrix-allow-group");
    const denyGroup = await makeSubject("group", "matrix-deny-group");
    await memberOf(user.id, allowGroup.id);
    await memberOf(user.id, denyGroup.id);
    await bind(allowGroup.id, "Viewer", orgRootId, "allow");
    await bind(denyGroup.id, "Viewer", serviceId, "deny");

    expect(await can(user.id, "object:read", serviceId)).toBe(false);
    expect(await can(user.id, "object:read", domainId)).toBe(true);
  });

  it("5. member_of expansion: user in group, group bound to a role", async () => {
    const user = await makeSubject("user", "matrix-group-member");
    const group = await makeSubject("group", "matrix-operators");
    await memberOf(user.id, group.id);
    await bind(group.id, "Operator", orgRootId);

    expect(await can(user.id, "object:write", serviceId)).toBe(true);
    expect(await can(user.id, "relationship:write", serviceId)).toBe(true);
  });

  it("5b. nested member_of expansion: user -> group -> team, team bound", async () => {
    const user = await makeSubject("user", "matrix-nested-member");
    const group = await makeSubject("group", "matrix-inner-group");
    const team = await makeSubject("team", "matrix-outer-team");
    await memberOf(user.id, group.id);
    await memberOf(group.id, team.id);
    await bind(team.id, "Viewer", domainId);

    expect(await can(user.id, "object:read", serviceId)).toBe(true); // via nested membership + containment
    expect(await can(user.id, "object:read", siblingDomainId)).toBe(false);
  });

  it("6. non-member gets nothing: same group binding, user NOT a member -> 403", async () => {
    const outsider = await makeSubject("user", "matrix-outsider");
    const group = await makeSubject("group", "matrix-exclusive-group");
    await bind(group.id, "Owner", orgRootId);
    // outsider is deliberately NOT member_of the group

    expect(await can(outsider.id, "object:read", serviceId)).toBe(false);
    await expect(
      withTenantTx(server.deps.db, org.orgId, (tx) =>
        authorize(tx, {
          orgId: org.orgId,
          subjectObjectId: outsider.id,
          permission: "object:read",
          scopeObjectId: serviceId
        })
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  it("7. service-account subjects work directly and via member_of", async () => {
    const direct = await makeSubject("service-account", "matrix-sa-direct");
    await bind(direct.id, "Operator", domainId);
    expect(await can(direct.id, "object:write", serviceId)).toBe(true);
    expect(await can(direct.id, "object:write", siblingDomainId)).toBe(false);

    const viaTeam = await makeSubject("service-account", "matrix-sa-team");
    const team = await makeSubject("team", "matrix-sa-owning-team");
    await memberOf(viaTeam.id, team.id);
    await bind(team.id, "Viewer", orgRootId);
    expect(await can(viaTeam.id, "object:read", serviceId)).toBe(true);
  });

  it("8. unknown/unheld permission fails closed (default deny)", async () => {
    const user = await makeSubject("user", "matrix-viewer-only");
    await bind(user.id, "Viewer", orgRootId);

    // Held by no role the subject has:
    expect(await can(user.id, "org:admin", serviceId)).toBe(false);
    expect(await can(user.id, "role_binding:write", serviceId)).toBe(false);
    // Not a permission any role grants at all — fails closed rather than erroring open:
    expect(await can(user.id, "made:up-permission" as Permission, serviceId)).toBe(false);
    // And a subject with no bindings whatsoever:
    const nobody = await makeSubject("user", "matrix-nobody");
    expect(await can(nobody.id, "object:read", orgRootId)).toBe(false);
  });
});
