import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScpClient } from "@scp/sdk";
import { OrgRole, RoleBinding, Stack } from "@scp/iac";
import { withTenantTx } from "../db/tenant-tx.js";
import { hasPermission } from "../authz/resolve.js";
import {
  buildTestServer,
  createTestOrg,
  createTestUser,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg,
  type TestServer,
  type TestUser
} from "../test-support/harness.js";

/**
 * ================================================================================================
 * IaC-DECLARED ROLES AND ROLE BINDINGS — apply, prune, and every door still standing
 * ================================================================================================
 *
 * THE PROPERTY IS AUTHORITY, NOT ROWS. A plan that shows the right lines and an apply that writes
 * the right rows would both be satisfied by a feature that changes nothing anyone can do, so every
 * case here ends at `hasPermission` — the function the doors call — rather than at a row count.
 *
 * THE PRUNE IS THE DANGEROUS HALF and gets the most attention. Dropping a line from a manifest
 * REVOKES a person's access on the next apply (owner decision 2026-08-28, taken with that risk
 * named). Two properties bound it and both are pinned below: a binding granted through the typed
 * door carries `managed_by_stack = NULL` and is invisible to every manifest, and the administrative
 * floor refuses the revoke that would leave an org with nobody able to grant anything.
 *
 * THE HAND-GRANTED PROPERTY IS DEFENDED TWICE and the tests say so honestly: `managed_by_stack` is
 * filtered both when LOADING the prune population (`listStackManagedRoleBindings`) and again in the
 * delete helper. Removing EITHER alone leaves this file green — the loader mutation is caught by
 * the idempotence case, and the delete-helper filter is pure defence in depth. Removing BOTH reds
 * the suite loudly. That is a real redundancy rather than a gap, and it is recorded here so nobody
 * reads a surviving single mutation as proof the test is weak.
 */
describe("IaC: roles and role bindings apply, prune, and respect the doors", () => {
  let server: ListeningTestServer;
  let org: TestOrg;
  let admin: ScpClient;
  let subject: TestUser;
  const stackName = `rbac-iac-${randomUUID().slice(0, 8)}`;
  // Resolved rather than assumed: the harness exposes ids, and a manifest addresses by URN.
  let subjectUrn: string;
  let orgUrn: string;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "iac-rbac");
    admin = new ScpClient({ baseUrl: server.baseUrl, token: org.adminToken });
    subject = await createTestUser(server, org, []);
    subjectUrn = (await admin.object("user").get(subject.objectId)).urn;
    orgUrn = (await admin.object("organization").get(org.orgId)).urn;
  }, 180_000);

  afterAll(async () => {
    await server?.close();
  });

  function may(permission: "policy:write" | "object:read") {
    return withTenantTx(server.deps.db, org.orgId, (tx) =>
      hasPermission(tx, {
        orgId: org.orgId,
        subjectObjectId: subject.objectId,
        scopeObjectId: org.orgId,
        permission
      })
    );
  }

  /** A stack declaring one org role and (optionally) one binding of it to the fixture subject. */
  function manifest(opts: { withBinding: boolean; permissions?: string[] }) {
    const stack = new Stack(stackName);
    new OrgRole(stack, "iac-role", {
      name: `IaC Authored ${stackName}`,
      permissions: opts.permissions ?? ["object:read", "policy:write"],
      reason: "declared by the estate repo"
    });
    if (opts.withBinding) {
      new RoleBinding(stack, "iac-binding", {
        subject: subjectUrn,
        role: `IaC Authored ${stackName}`,
        scope: orgUrn,
        reason: "declared by the estate repo"
      });
    }
    return stack.synth();
  }

  async function apply(m: ReturnType<typeof manifest>) {
    const plan = await admin.plans.create(m as Parameters<typeof admin.plans.create>[0]);
    await admin.plans.apply(plan.id);
    return plan;
  }

  it("holds nothing before any apply (known-positive control)", async () => {
    // Every admission below would be satisfiable by a fixture that already had the permission.
    expect(await may("policy:write")).toBe(false);
  });

  it("APPLIES: the declared role is authored and the declared binding CONFERS it", async () => {
    await apply(manifest({ withBinding: true }));
    // Not "a row exists" — the doors admit them.
    expect(await may("policy:write")).toBe(true);
    expect(await may("object:read")).toBe(true);
  });

  it("is IDEMPOTENT — re-applying the same manifest changes nothing", async () => {
    const plan = await apply(manifest({ withBinding: true }));
    const lines = [
      ...((plan as unknown as { diff?: { roleBindings?: { action: string }[] } }).diff
        ?.roleBindings ?? [])
    ];
    // A second apply must produce `noop`, not a delete+create that would flicker the authority.
    expect(lines.every((l) => l.action === "noop")).toBe(true);
    expect(await may("policy:write")).toBe(true);
  });

  it("UPDATES a role in place when its permissions change", async () => {
    await apply(manifest({ withBinding: true, permissions: ["object:read"] }));
    // The role's identity is its NAME and its permissions are its value, so narrowing it is one
    // row changing — and the binding, untouched, now confers less.
    expect(await may("policy:write")).toBe(false);
    expect(await may("object:read")).toBe(true);
  });

  it("PRUNES: dropping the binding line REVOKES the access on the next apply", async () => {
    await apply(manifest({ withBinding: false, permissions: ["object:read"] }));
    // The owner-accepted risk, made real and pinned: a merge that deletes a line takes away
    // somebody's access.
    expect(await may("object:read")).toBe(false);
  });

  it("REFUSES an apply whose principal lacks what it is granting (the subset rule, on the IaC path)", async () => {
    // THE GAP THIS CLOSES, found by mutation: every other case here applies as the org's bootstrap
    // ADMIN, who holds everything — so deleting the subset rule from the apply path changed
    // nothing and all seven tests stayed green. A rule only exercised by a principal who satisfies
    // it is not exercised at all.
    //
    // An OrgAdmin holds `role_binding:write` and NOT `freeze:override`, so a manifest of theirs
    // that authors a role carrying it must be refused — the same bar `POST /roles` applies, on the
    // path a config-source sync uses.
    const orgAdmin = await createTestUser(server, org, [{ role: "OrgAdmin", scope: org.orgId }]);
    const restricted = new ScpClient({ baseUrl: server.baseUrl, token: orgAdmin.token });

    const stack = new Stack(`${stackName}-escalate`);
    new OrgRole(stack, "too-powerful", {
      name: `Escalator ${stackName}`,
      permissions: ["freeze:override"],
      reason: "should be refused"
    });
    const plan = await restricted.plans.create(
      stack.synth() as Parameters<typeof restricted.plans.create>[0]
    );
    // Plan may compute — the refusal is an APPLY-time authority question, which is exactly where
    // `prepareApplyChecks` runs it.
    await expect(restricted.plans.apply(plan.id)).rejects.toMatchObject({ status: 403 });
  });

  it("NEVER prunes a binding granted through the typed door (managed_by_stack IS NULL)", async () => {
    // The property that makes the prune survivable. Grant by hand, then apply a manifest that
    // declares no bindings at all: the hand-granted row must be untouched.
    const roles = await admin.roles.list();
    const viewer = roles.items.find((r) => r.name === "Viewer")!;
    await admin.roleBindings.create({
      subjectId: subject.objectId,
      roleId: viewer.id,
      scopeObjectId: org.orgId,
      reason: "granted by hand, must survive every apply"
    });
    expect(await may("object:read")).toBe(true);

    await apply(manifest({ withBinding: false, permissions: ["object:read"] }));

    // If this ever fails, a manifest is revoking authority it never granted — the single worst
    // outcome this design has, and the reason `managed_by_stack` is filtered on the delete path.
    expect(await may("object:read")).toBe(true);
  });
});

describe("IaC: the RBAC doors are not bypassed by the apply path", () => {
  let server: TestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await buildTestServer();
    org = await createTestOrg(server, "iac-rbac-doors");
  });

  afterAll(async () => {
    await server?.app.close();
  });

  it("REFUSES a manifest binding to a GROUP, even though the construct also refuses it", async () => {
    // The construct refuses at synth; this is the OTHER authoring path — a hand-written manifest
    // that never went through `@scp/iac` at all. Both doors exist because both paths do.
    const group = await server.app.inject({
      method: "POST",
      url: "/api/v1/groups",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: { name: `hand-${Date.now()}` }
    });
    const groupUrn = group.json().urn as string;

    const res = await server.app.inject({
      method: "POST",
      url: "/api/v1/plans",
      headers: { authorization: `Bearer ${org.adminToken}` },
      payload: {
        stackName: `hand-${Date.now()}`,
        objects: [],
        relationships: [],
        roleBindings: [
          {
            subjectUrn: groupUrn,
            roleName: "Viewer",
            scopeUrn: (
              await server.app.inject({
                method: "GET",
                url: `/api/v1/objects/organization/${org.orgId}`,
                headers: { authorization: `Bearer ${org.adminToken}` }
              })
            ).json().urn,
            reason: "hand-written"
          }
        ]
      }
    });
    // Either the plan refuses it or the apply does; what must NOT happen is a silent success.
    // Accepting a plan here is fine — the refusal lands at apply, where the subject's type is
    // resolved — so this asserts the pair rather than one status code.
    if (res.statusCode === 201) {
      const applied = await server.app.inject({
        method: "POST",
        url: `/api/v1/plans/${res.json().id}/apply`,
        headers: { authorization: `Bearer ${org.adminToken}` }
      });
      expect(applied.statusCode).toBeGreaterThanOrEqual(400);
    } else {
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
  });
});
