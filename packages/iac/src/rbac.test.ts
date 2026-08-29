import { describe, expect, it } from "vitest";
import { Stack } from "./construct.js";
import { OrgRole, RoleBinding } from "./rbac.js";

/**
 * RBAC constructs — the L1/L2 equality, the group refusal, and determinism.
 *
 * THE EQUALITY CASE IS BUILT BY HAND ON THE L1 SIDE, deliberately. Deriving it from the same helper
 * the construct uses would make the two sides agree BY CONSTRUCTION and prove nothing about drift —
 * which is the whole property D16(1) asks for, since generated files and standards packages author
 * through the L1 door and would otherwise diverge invisibly until somebody diffed two manifests.
 * So every field the L2 form inherited is spelled out below.
 */

const SUBJECT = "urn:scp:acme:service-account:ci";
const SCOPE = "urn:scp:acme:component:checkout";

describe("RoleBinding — L1 and L2 synthesize identically (D16(1))", () => {
  it("produces a byte-identical manifest either way", () => {
    const viaL2 = new Stack("rbac-l2");
    new RoleBinding(viaL2, "ci-deployer", {
      subject: SUBJECT,
      role: "ComponentAdmin",
      scope: SCOPE,
      reason: "CI deploys checkout"
    });

    const viaL1 = new Stack("rbac-l2");
    // Hand-authored: every field spelled out, no shared helper with the construct.
    viaL1.addRoleBinding({
      subjectUrn: "urn:scp:acme:service-account:ci",
      roleName: "ComponentAdmin",
      scopeUrn: "urn:scp:acme:component:checkout",
      reason: "CI deploys checkout"
    });

    expect(viaL2.synth()).toEqual(viaL1.synth());
  });
});

describe("OrgRole — L1 and L2 synthesize identically", () => {
  it("produces a byte-identical manifest either way, including the optional bindableAt", () => {
    const viaL2 = new Stack("role-l2");
    new OrgRole(viaL2, "release-captain", {
      name: "Release Captain",
      permissions: ["object:read", "change:accept"],
      bindableAt: ["service"],
      reason: "seat the release team"
    });

    const viaL1 = new Stack("role-l2");
    viaL1.addRole({
      name: "Release Captain",
      permissions: ["object:read", "change:accept"],
      bindableAt: ["service"],
      reason: "seat the release team"
    });

    expect(viaL2.synth()).toEqual(viaL1.synth());
  });

  it("omits `bindableAt` entirely when not given, rather than emitting null", () => {
    const stack = new Stack("role-nobindable");
    new OrgRole(stack, "r", { name: "R", permissions: ["object:read"], reason: "why" });
    const role = stack.synth().roles?.[0];
    // Absent and explicit-null mean different things downstream (`bindable_at` NULL = ANY scope),
    // and emitting a key the author did not write would make the manifest claim a decision.
    expect(role && "bindableAt" in role).toBe(false);
  });
});

describe("RoleBinding refuses a group or team subject at SYNTH", () => {
  for (const typeId of ["group", "team"]) {
    it(`refuses a '${typeId}' subject and names the alternative`, () => {
      const stack = new Stack("rbac-refuse");
      expect(
        () =>
          new RoleBinding(stack, "admins", {
            subject: { urn: `urn:scp:acme:${typeId}:platform`, typeId },
            role: "OrgAdmin",
            scope: SCOPE,
            reason: "platform admins"
          })
      ).toThrow(/grant-preview/);
    });
  }

  it("refuses a group named by BARE URN too — the type is read off the urn", () => {
    const stack = new Stack("rbac-refuse-urn");
    expect(
      () =>
        new RoleBinding(stack, "admins", {
          subject: "urn:scp:acme:group:platform",
          role: "OrgAdmin",
          scope: SCOPE,
          reason: "platform admins"
        })
    ).toThrow(/cannot bind/);
  });

  it("explains WHY rather than only refusing", () => {
    const stack = new Stack("rbac-refuse-why");
    try {
      new RoleBinding(stack, "admins", {
        subject: "urn:scp:acme:group:platform",
        role: "OrgAdmin",
        scope: SCOPE,
        reason: "platform admins"
      });
      throw new Error("expected a refusal");
    } catch (err) {
      const message = (err as Error).message;
      // A refusal an author cannot act on is a wall. This one names the control (D7's
      // acknowledgement), the reason a manifest cannot carry it (a stale snapshot), and the two
      // commands that do the job.
      expect(message).toMatch(/snapshot/i);
      expect(message).toMatch(/scp role-binding create/);
    }
  });

  it("ALLOWS a user and a service-account — the guard narrows, it does not block", () => {
    // Load-bearing: without it, a guard that refused every subject would satisfy every case above.
    const stack = new Stack("rbac-allow");
    new RoleBinding(stack, "a", {
      subject: "urn:scp:acme:user:ada",
      role: "Viewer",
      scope: SCOPE,
      reason: "read access"
    });
    new RoleBinding(stack, "b", {
      subject: SUBJECT,
      role: "ComponentAdmin",
      scope: SCOPE,
      reason: "CI"
    });
    expect(stack.synth().roleBindings).toHaveLength(2);
  });

  it("ALLOWS a URN whose type cannot be read — this layer does not police URN shape", () => {
    // Failing closed on an unparseable URN would reject legitimate external references for a shape
    // the authoring layer has no business judging; the API refuses a genuinely bad subject anyway.
    const stack = new Stack("rbac-opaque");
    new RoleBinding(stack, "x", {
      subject: "some-external-reference",
      role: "Viewer",
      scope: SCOPE,
      reason: "external"
    });
    expect(stack.synth().roleBindings).toHaveLength(1);
  });
});

describe("determinism", () => {
  it("sorts bindings on (subjectUrn, roleName, scopeUrn), not declaration order", () => {
    const a = new Stack("order");
    new RoleBinding(a, "z", {
      subject: "urn:scp:acme:user:zoe",
      role: "Viewer",
      scope: SCOPE,
      reason: "r"
    });
    new RoleBinding(a, "m", {
      subject: "urn:scp:acme:user:ada",
      role: "Viewer",
      scope: SCOPE,
      reason: "r"
    });

    const b = new Stack("order");
    new RoleBinding(b, "m", {
      subject: "urn:scp:acme:user:ada",
      role: "Viewer",
      scope: SCOPE,
      reason: "r"
    });
    new RoleBinding(b, "z", {
      subject: "urn:scp:acme:user:zoe",
      role: "Viewer",
      scope: SCOPE,
      reason: "r"
    });

    // Declaration order must leave no trace in the synthesized bytes — otherwise a reordered
    // program produces a spurious diff and every review has to ignore it.
    expect(a.synth()).toEqual(b.synth());
    expect(a.synth().roleBindings?.map((r) => r.subjectUrn)).toEqual([
      "urn:scp:acme:user:ada",
      "urn:scp:acme:user:zoe"
    ]);
  });

  it("omits both collections entirely when a stack declares none", () => {
    // A stack that uses none of this must synthesize the manifest it did before these collections
    // existed — the interchange format stays stable for every existing program.
    const stack = new Stack("empty");
    const manifest = stack.synth();
    expect("roleBindings" in manifest).toBe(false);
    expect("roles" in manifest).toBe(false);
  });
});
