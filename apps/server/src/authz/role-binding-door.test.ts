import { describe, expect, it } from "vitest";
import type { TenantTx } from "../db/tenant-tx.js";
import { ProblemError } from "../errors.js";
import {
  assertBindableSubject,
  assertGrantAcknowledgesEmpoweredPrincipals,
  assertGrantReachesOnlyBindableMembers,
  assertRoleAcceptsNewBindings,
  assertRoleBindableAtScope,
  builtInNameCollisionReason,
  DEPRECATED_BUILTIN_ROLES,
  revokeAffectsAdministrativeFloor,
  roleDeprecationReason,
  subjectTypeNeedsMembershipReview,
  unbindablePrincipalReasons,
  type BindableRole,
  type ReachedPrincipal
} from "./role-binding-door.js";

/**
 * ================================================================================================
 * THE ROLE-BINDING DOOR'S PURE REFUSALS — the half of the door that judges rows, not the database
 * ================================================================================================
 *
 * `role-binding-door.ts` is mostly transaction-bound and is exercised end to end by
 * `routes/rbac-role-binding-door.integration.test.ts` and `routes/rbac-administrative-floor.
 * integration.test.ts` against real PostgreSQL, which is where it belongs (CLAUDE.md: integration
 * tests never mock a DB). Nothing in this file mocks one. Every function below takes rows that have
 * ALREADY been fetched and returns a verdict over them — set difference, string comparison, an
 * own-property lookup — so a `TenantTx` would add nothing but a fixture.
 *
 * WHAT THIS LAYER CAN REACH THAT THE INTEGRATION LAYER CANNOT REACH CHEAPLY. An integration case
 * builds ONE membership through real `POST /relationships` calls and asserts one verdict. The
 * properties these predicates actually promise are quantified over inputs a fixture cannot
 * conveniently produce: an acknowledgement whose ids are in the wrong ORDER or DUPLICATED (the
 * docblock says "order is irrelevant; duplicates are irrelevant; the comparison is set equality"),
 * a `bindable_at` that is `[]` rather than `null`, a principal that is soft-deleted AND of a
 * non-bindable type at the same time (the "only one reason per principal" rule), a built-in role
 * whose name is `'toString'`. Each of those is one line here and a fixture there.
 *
 * WHAT IS DELIBERATELY NOT HERE: `missingPermissionsFor`, `assertMayWriteRoleBinding`,
 * `assertMayJoinRoleBearingSubject`, `principalsReachedBy`, `readableSubsetOf`,
 * `assertOrgRetainsAdministrativeFloor`, `objectTouchesRoleAuthority`, `lockOrgRoleAuthority` and
 * every function in `roles-repo.ts`. All of them ask PostgreSQL a question — the subset rule's whole
 * correctness is that it runs `hasPermission` per permission rather than reading the actor's role
 * rows, and a fake `tx` would let a wrong implementation pass. They stay in the integration layer.
 */

/** The four seeded shapes these predicates are asked about, as `roles` rows. */
const builtIn = (name: string, over: Partial<BindableRole> = {}): BindableRole => ({
  id: "11111111-1111-4111-8111-111111111111",
  orgId: null,
  name,
  permissions: [],
  bindableAt: null,
  ...over
});

const orgRole = (name: string, over: Partial<BindableRole> = {}): BindableRole => ({
  id: "22222222-2222-4222-8222-222222222222",
  orgId: "99999999-9999-4999-8999-999999999999",
  name,
  permissions: [],
  bindableAt: null,
  ...over
});

const principal = (over: Partial<ReachedPrincipal> & { id: string }): ReachedPrincipal => ({
  typeId: "user",
  name: null,
  deleted: false,
  credentialed: true,
  depth: 1,
  ...over
});

/** Every refusal in this module is a thrown `ProblemError`; the STATUS is the contract (422 = fix
 *  your request, 409 = re-read and retry), so it is asserted alongside the wording every time. */
const refusal = (fn: () => unknown): ProblemError => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProblemError) return err;
    throw err;
  }
  throw new Error("expected a refusal, the call returned normally");
};

describe("subjectTypeNeedsMembershipReview — one definition for four call sites", () => {
  it("is true for exactly the two types a grant reaches THROUGH", () => {
    expect(subjectTypeNeedsMembershipReview("group")).toBe(true);
    expect(subjectTypeNeedsMembershipReview("team")).toBe(true);
    expect(subjectTypeNeedsMembershipReview("user")).toBe(false);
    expect(subjectTypeNeedsMembershipReview("service-account")).toBe(false);
  });

  it("is false for anything else, including a case variant and an empty string", () => {
    // `objects.type_id` is a plain text column; nothing upstream normalizes case. A `'Group'` that
    // answered true here would demand an acknowledgement the preview never computes.
    for (const typeId of ["Group", "GROUP", "teams", "component", "", " group"]) {
      expect(subjectTypeNeedsMembershipReview(typeId)).toBe(false);
    }
  });
});

describe("unbindablePrincipalReasons — §2b's two arms over an already-walked membership", () => {
  it("returns nothing for an empty closure", () => {
    expect(unbindablePrincipalReasons([])).toEqual([]);
  });

  it("accepts all four binding-subject types when live", () => {
    const clean = ["user", "service-account", "group", "team"].map((typeId, i) =>
      principal({ id: `id-${i}`, typeId })
    );
    expect(unbindablePrincipalReasons(clean)).toEqual([]);
  });

  it("names a soft-deleted principal — it still resolves through the group", () => {
    const reasons = unbindablePrincipalReasons([
      principal({ id: "u-1", name: "ada", deleted: true })
    ]);
    expect(reasons).toEqual(["'ada' (user 'u-1') is soft-deleted"]);
  });

  it("names a principal whose type cannot hold a binding at all", () => {
    const reasons = unbindablePrincipalReasons([
      principal({ id: "c-1", name: "checkout", typeId: "component" })
    ]);
    expect(reasons).toEqual(["'checkout' (component 'c-1') cannot hold a role binding"]);
  });

  it("gives ONE reason for a principal that is both tombstoned and wrong-typed, liveness first", () => {
    // The docblock's rule, and it is about how the refusal READS: naming one broken principal twice
    // makes an operator believe there are two problems to fix.
    const reasons = unbindablePrincipalReasons([
      principal({ id: "c-1", typeId: "component", deleted: true })
    ]);
    expect(reasons).toEqual(["'c-1' (component 'c-1') is soft-deleted"]);
  });

  it("falls back to the id when a principal has no name", () => {
    expect(
      unbindablePrincipalReasons([principal({ id: "u-9", name: null, deleted: true })])
    ).toEqual(["'u-9' (user 'u-9') is soft-deleted"]);
  });

  it("reports every offender rather than the first, and leaves clean rows out", () => {
    const reasons = unbindablePrincipalReasons([
      principal({ id: "ok", typeId: "team" }),
      principal({ id: "bad-1", deleted: true }),
      principal({ id: "bad-2", typeId: "change" })
    ]);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain("'bad-1'");
    expect(reasons[1]).toContain("'bad-2'");
  });

  it("judges depth-blind — the caller chooses the population, not this function", () => {
    // The grant door passes `depth > 0`; the JOIN door passes ALL depths. A depth filter in here
    // would silently disarm the join door's member-shape half.
    expect(
      unbindablePrincipalReasons([principal({ id: "seed", depth: 0, deleted: true })])
    ).toEqual(["'seed' (user 'seed') is soft-deleted"]);
  });
});

describe("roleDeprecationReason — D5, and it is keyed by name on BUILT-IN rows only", () => {
  it("refuses the built-in Administrator and names the purpose roles that replace it", () => {
    const reason = roleDeprecationReason(builtIn("Administrator"));
    expect(reason).toBe(DEPRECATED_BUILTIN_ROLES.Administrator);
    // D5's migration path is the whole point of the ruling: a refusal that does not say what to bind
    // instead sends the operator back to `Administrator` by another route.
    for (const replacement of [
      "OrgAdmin",
      "ServiceAdmin",
      "ComponentAdmin",
      "FederationAdmin",
      "SecurityOfficer"
    ]) {
      expect(reason).toContain(replacement);
    }
  });

  it("says existing bindings are untouched — this is a refusal at the door, not a removal", () => {
    expect(roleDeprecationReason(builtIn("Administrator"))).toContain("keep resolving");
  });

  it("does NOT deprecate an org's own row that happens to be called Administrator", () => {
    // A different row with different permissions. Deprecating it by name collision would refuse a
    // grant for a reason that is not true of it. (It has its own refusal — the collision one.)
    expect(roleDeprecationReason(orgRole("Administrator"))).toBeNull();
  });

  it("leaves every other built-in grantable", () => {
    for (const name of ["Owner", "Viewer", "Operator", "Approver", "OrgAdmin", "SecurityOfficer"]) {
      expect(roleDeprecationReason(builtIn(name))).toBeNull();
    }
  });

  it("returns null — never an inherited Object.prototype member — for a role named 'toString'", () => {
    // `roles.name` is a plain text column and this key comes straight off it. On a bare index
    // lookup, `DEPRECATED_BUILTIN_ROLES['toString']` is a FUNCTION, `?? null` does not filter it
    // (not nullish), and it would surface as `Role.deprecationReason` — a non-string where the
    // schema promises `string | null` — and as the 422 detail below.
    for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(roleDeprecationReason(builtIn(name))).toBeNull();
    }
  });
});

describe("builtInNameCollisionReason — the quorum-bypass predicate", () => {
  const collide = (over: Partial<Parameters<typeof builtInNameCollisionReason>[0]> = {}) =>
    builtInNameCollisionReason({
      id: "22222222-2222-4222-8222-222222222222",
      orgId: "99999999-9999-4999-8999-999999999999",
      name: "Approver",
      collidesWithBuiltIn: true,
      ...over
    });

  it("refuses an ORG row sharing a BUILT-IN name, and says why quorum is the reason", () => {
    const reason = collide();
    expect(reason).not.toBeNull();
    // `hasRoleAtScope` matches `rl.name` with NO org predicate, so holders of this row become
    // eligible voters everywhere a policy names 'Approver'. The refusal has to say that, because a
    // zero-permission role looks harmless to every other check on this door.
    expect(reason).toContain("'Approver'");
    expect(reason).toContain("fromRole");
    expect(reason).toContain("NAME");
    expect(reason).toContain("Rename the role");
  });

  it("fires on a ZERO-PERMISSION row — its danger is its name, not its permissions", () => {
    // The subset rule cannot catch this: a zero-permission role is vacuously a subset of everything.
    // That is the whole reason this predicate exists beside it.
    expect(collide()).not.toBeNull();
  });

  it("never fires on a built-in — a built-in cannot collide with itself", () => {
    expect(collide({ orgId: null, collidesWithBuiltIn: true })).toBeNull();
  });

  it("does not fire on an org role whose name matches no built-in", () => {
    expect(collide({ name: "PaymentsReleaseManager", collidesWithBuiltIn: false })).toBeNull();
  });
});

describe("assertRoleAcceptsNewBindings — D5 and the collision, in that order", () => {
  const builtIns = new Set(["Owner", "Administrator", "Approver", "Viewer"]);

  it("admits a live built-in", () => {
    expect(() => assertRoleAcceptsNewBindings(builtIn("Owner"), builtIns)).not.toThrow();
  });

  it("admits an org role with a name of its own", () => {
    expect(() =>
      assertRoleAcceptsNewBindings(orgRole("PaymentsReleaseManager"), builtIns)
    ).not.toThrow();
  });

  it("refuses the deprecated built-in with 422 — a malformed request, not a state conflict", () => {
    const err = refusal(() => assertRoleAcceptsNewBindings(builtIn("Administrator"), builtIns));
    expect(err.status).toBe(422);
    expect(err.detail).toContain("deprecated");
  });

  it("refuses an org role colliding with a built-in name, with 422", () => {
    const err = refusal(() => assertRoleAcceptsNewBindings(orgRole("Approver"), builtIns));
    expect(err.status).toBe(422);
    expect(err.detail).toContain("fromRole");
  });

  it("reports the DEPRECATION when a row is both deprecated and colliding", () => {
    // Order is a message decision, and it is only observable here: an org row named
    // 'Administrator' takes the collision arm (it is not a built-in), so the only input that hits
    // both arms is a built-in that is also in the built-in name set — which every built-in is.
    const err = refusal(() => assertRoleAcceptsNewBindings(builtIn("Administrator"), builtIns));
    expect(err.detail).toContain("owner ruling D5");
  });

  it("admits an org role named Administrator when no built-in of that name is seeded", () => {
    // The collision fact is passed in rather than assumed, so an estate whose catalogue differs
    // gets a verdict about ITS catalogue.
    expect(() =>
      assertRoleAcceptsNewBindings(orgRole("Administrator"), new Set(["Owner"]))
    ).not.toThrow();
  });
});

describe("assertRoleBindableAtScope — bindable_at, and `[]` is not `null`", () => {
  const scope = { id: "s-1", typeId: "service" };

  it("admits ANY scope for the cumulative-ladder rows, whose bindable_at is null", () => {
    for (const typeId of ["service", "organization", "component", "user", "change"]) {
      expect(() => assertRoleBindableAtScope(builtIn("Owner"), { id: "x", typeId })).not.toThrow();
    }
  });

  it("admits a scope type the role lists", () => {
    expect(() =>
      assertRoleBindableAtScope(
        builtIn("ServiceAdmin", { bindableAt: ["service", "domain"] }),
        scope
      )
    ).not.toThrow();
  });

  it("refuses a scope type the role does not list, naming the role, the type and the allowed set", () => {
    const err = refusal(() =>
      assertRoleBindableAtScope(
        builtIn("ComponentAdmin", { bindableAt: ["assembly", "component"] }),
        {
          id: "s-1",
          typeId: "organization"
        }
      )
    );
    expect(err.status).toBe(422);
    expect(err.detail).toContain("'ComponentAdmin'");
    expect(err.detail).toContain("'organization'");
    expect(err.detail).toContain("'assembly', 'component'");
    expect(err.detail).toContain("'s-1'");
  });

  it("refuses EVERY scope for an empty bindable_at — `[]` is a closed set, `null` is 'any'", () => {
    // The boundary that matters: a migration that writes `'{}'` instead of NULL makes the role
    // unbindable everywhere rather than bindable anywhere, and those two must not be confused.
    expect(() => assertRoleBindableAtScope(builtIn("X", { bindableAt: [] }), scope)).toThrow(
      ProblemError
    );
  });

  it("matches the type id exactly — no case folding, no trimming", () => {
    for (const typeId of ["Service", "SERVICE", " service"]) {
      expect(() =>
        assertRoleBindableAtScope(builtIn("X", { bindableAt: ["service"] }), { id: "s", typeId })
      ).toThrow(ProblemError);
    }
  });
});

describe("assertBindableSubject — the subject half of the unconstrained-uuid property", () => {
  it("admits exactly the four types member_of can reach", () => {
    for (const typeId of ["user", "service-account", "group", "team"]) {
      expect(() => assertBindableSubject({ id: "s", typeId })).not.toThrow();
    }
  });

  it("refuses anything else with 422, and says why such a binding could never match", () => {
    const err = refusal(() => assertBindableSubject({ id: "c-1", typeId: "component" }));
    expect(err.status).toBe(422);
    expect(err.detail).toContain("'c-1'");
    expect(err.detail).toContain("'component'");
    expect(err.detail).toContain("'user', 'service-account', 'group', 'team'");
    expect(err.detail).toContain("can never match a request");
  });

  it("refuses an empty or whitespace-padded type id", () => {
    // `role_bindings.subject_id` has no FK and no type check, and `objects.type_id` is plain text:
    // a padded value is a real row shape, not a hypothetical.
    for (const typeId of ["", " ", "user ", " user", "User"]) {
      expect(() => assertBindableSubject({ id: "s", typeId })).toThrow(ProblemError);
    }
  });
});

describe("assertGrantAcknowledgesEmpoweredPrincipals — D7 (owner ruling 2026-08-27)", () => {
  const role = builtIn("Owner");
  const group = { id: "g-1", typeId: "group" };
  const ack = (
    subject: { id: string; typeId: string },
    reached: ReachedPrincipal[],
    acknowledgedPrincipalIds: readonly string[] | undefined
  ) =>
    assertGrantAcknowledgesEmpoweredPrincipals({
      role,
      subject,
      reached,
      acknowledgedPrincipalIds
    });

  it("does not burden a user or service-account subject — no acknowledgement is even read", () => {
    // The ruling's own words. The short-circuit is on the subject TYPE, before the membership is
    // consulted at all, so a nonsense acknowledgement on a user grant is simply irrelevant.
    for (const typeId of ["user", "service-account"]) {
      expect(() =>
        ack({ id: "u-1", typeId }, [principal({ id: "u-1", depth: 0 })], ["nobody-in-particular"])
      ).not.toThrow();
    }
  });

  it("refuses a group grant with NO acknowledgement — 422, and it points at grant-preview", () => {
    const err = refusal(() =>
      ack(
        group,
        [principal({ id: "g-1", depth: 0, typeId: "group" }), principal({ id: "u-1" })],
        undefined
      )
    );
    // 422 rather than 409: an absent field is a malformed request for this subject type and
    // retrying the same body can never fix it.
    expect(err.status).toBe(422);
    expect(err.detail).toContain("acknowledgedPrincipalIds");
    expect(err.detail).toContain("grant-preview?subjectId=g-1");
    expect(err.detail).toContain("currently reaches 1");
  });

  it("distinguishes `undefined` from `[]` for an EMPTY group — 'I did not look' vs 'it is empty'", () => {
    const emptyGroup = [principal({ id: "g-1", depth: 0, typeId: "group" })];
    // `[]` is a TRUE statement at the moment of the grant, and is the seat-the-team-later flow.
    expect(() => ack(group, emptyGroup, [])).not.toThrow();
    expect(refusal(() => ack(group, emptyGroup, undefined)).status).toBe(422);
  });

  it("excludes the depth-0 seed — acknowledging the group ITSELF is 'not reached'", () => {
    const reached = [principal({ id: "g-1", depth: 0, typeId: "group" }), principal({ id: "u-1" })];
    expect(() => ack(group, reached, ["u-1"])).not.toThrow();
    const err = refusal(() => ack(group, reached, ["u-1", "g-1"]));
    expect(err.status).toBe(409);
    expect(err.detail).toContain("not reached");
  });

  it("compares as a SET — order and duplicates are irrelevant", () => {
    // The docblock's promise, and the case a fixture cannot produce: `grant-preview` returns the
    // value sorted, so an integration test that pastes it through can never exercise either.
    const reached = [
      principal({ id: "g-1", depth: 0, typeId: "group" }),
      principal({ id: "a" }),
      principal({ id: "b" }),
      principal({ id: "c", depth: 2 })
    ];
    expect(() => ack(group, reached, ["c", "a", "b"])).not.toThrow();
    expect(() => ack(group, reached, ["b", "a", "a", "c", "c"])).not.toThrow();
  });

  it("counts a NESTED group as an empowered principal in its own right", () => {
    // A nested group is itself empowered, and naming it is how the caller learns the nesting
    // exists — so it is in the set, not collapsed into its members.
    const reached = [
      principal({ id: "g-1", depth: 0, typeId: "group" }),
      principal({ id: "g-2", typeId: "group" }),
      principal({ id: "u-1", depth: 2 })
    ];
    expect(refusal(() => ack(group, reached, ["u-1"])).detail).toContain("'g-2'");
    expect(() => ack(group, reached, ["g-2", "u-1"])).not.toThrow();
  });

  it("refuses with 409 when a member joined between the read and the write, naming them", () => {
    const err = refusal(() =>
      ack(
        group,
        [
          principal({ id: "g-1", depth: 0, typeId: "group" }),
          principal({ id: "u-1", name: "ada" }),
          principal({ id: "u-2", name: "grace" })
        ],
        ["u-1"]
      )
    );
    // 409, not 422: the body is well-formed and the caller's standing is not in question — the
    // request conflicts with the state of the org right now, so re-read and retry is the remedy.
    expect(err.status).toBe(409);
    expect(err.detail).toContain("1 principal(s) this binding WOULD empower are not in the");
    expect(err.detail).toContain("'grace' (user 'u-2')");
    expect(err.detail).toContain("Nothing was granted");
  });

  it("reports BOTH directions in one refusal, each set sorted", () => {
    // The id-list shape was chosen over a digest precisely so the refusal can name the difference,
    // and over a count because a count is unchanged by a substitution — which is this case.
    const err = refusal(() =>
      ack(
        group,
        [
          principal({ id: "g-1", depth: 0, typeId: "group" }),
          principal({ id: "u-b" }),
          principal({ id: "u-a" })
        ],
        ["u-z", "u-y"]
      )
    );
    expect(err.status).toBe(409);
    expect(err.detail).toContain("2 principal(s) this binding WOULD empower");
    expect(err.detail).toContain("2 acknowledged id(s) are not reached");
    // Sorted, so two callers hitting the same mismatch read the same sentence.
    expect(err.detail?.indexOf("'u-a'")).toBeLessThan(err.detail?.indexOf("'u-b'") ?? -1);
    expect(err.detail?.indexOf("'u-y'")).toBeLessThan(err.detail?.indexOf("'u-z'") ?? -1);
  });

  it("names an unreached id bare — it describes no principal it cannot see", () => {
    const err = refusal(() =>
      ack(group, [principal({ id: "g-1", depth: 0, typeId: "group" })], ["ghost"])
    );
    expect(err.detail).toContain("'ghost'");
    expect(err.detail).not.toContain("(user 'ghost')");
  });
});

describe("assertGrantReachesOnlyBindableMembers — §2b, over an already-walked closure", () => {
  /**
   * The function's own docblock: "`tx` is kept in the signature though nothing in here uses it:
   * this is a door, and every other assert in this module takes the transaction it judges." So no
   * transaction is passed. If this ever throws a TypeError instead of failing an assertion, the
   * function stopped being pure and belongs in the integration layer — which is the signal, not a
   * flake.
   */
  const NO_TX = undefined as unknown as TenantTx;
  const check = (subject: { id: string; typeId: string }, reached: ReachedPrincipal[]) =>
    assertGrantReachesOnlyBindableMembers(NO_TX, {
      orgId: "org-1",
      role: builtIn("Owner"),
      scopeObjectId: "scope-1",
      subject,
      reached
    });

  it("short-circuits for a user subject, whatever the walk returned", async () => {
    await expect(
      check({ id: "u-1", typeId: "user" }, [principal({ id: "x", deleted: true })])
    ).resolves.toBeUndefined();
  });

  it("admits a group whose whole closure is live and bindable", async () => {
    await expect(
      check({ id: "g-1", typeId: "group" }, [
        principal({ id: "g-1", depth: 0, typeId: "group" }),
        principal({ id: "u-1" }),
        principal({ id: "t-1", typeId: "team", depth: 2 })
      ])
    ).resolves.toBeUndefined();
  });

  it("ignores the depth-0 seed, which the route has already judged", async () => {
    // The seed's type is `assertBindableSubject`'s job and its liveness is the object fetch's. If
    // this filter were dropped, the two doors would refuse the same group for two different
    // reasons and one of them would be wrong.
    await expect(
      check({ id: "g-1", typeId: "group" }, [
        principal({ id: "g-1", depth: 0, typeId: "group", deleted: true })
      ])
    ).resolves.toBeUndefined();
  });

  it("refuses a group reaching a soft-deleted member, and explains why it still resolves", async () => {
    const err = await check({ id: "g-1", typeId: "group" }, [
      principal({ id: "g-1", depth: 0, typeId: "group" }),
      principal({ id: "u-1", name: "ada", deleted: true })
    ]).then(
      () => null,
      (e: unknown) => e as ProblemError
    );
    expect(err?.status).toBe(422);
    expect(err?.detail).toContain("'ada' (user 'u-1') is soft-deleted");
    expect(err?.detail).toContain("1 of them is one this door refuses");
    // The reason the refusal exists at all: the permission walk joins `relationships.deleted_at`,
    // never `objects.deleted_at`.
    expect(err?.detail).toContain("relationships.deleted_at");
  });

  it("agrees in number with the plural of its own sentence", async () => {
    const err = await check({ id: "t-1", typeId: "team" }, [
      principal({ id: "t-1", depth: 0, typeId: "team" }),
      principal({ id: "u-1", deleted: true }),
      principal({ id: "c-1", typeId: "component" })
    ]).then(
      () => null,
      (e: unknown) => e as ProblemError
    );
    expect(err?.detail).toContain("2 of them are one this door refuses");
  });
});

describe("revokeAffectsAdministrativeFloor — §7's relevance test for the revoke door", () => {
  const orgId = "org-root-1";
  const writer = builtIn("Owner", { permissions: ["object:read", "role_binding:write"] });

  it("is true for an allow binding of an administrative role AT the org root", () => {
    expect(
      revokeAffectsAdministrativeFloor(orgId, { scopeObjectId: orgId, effect: "allow" }, writer)
    ).toBe(true);
  });

  it("is false for a deny row — a deny grants nothing, so removing it cannot empty the floor", () => {
    expect(
      revokeAffectsAdministrativeFloor(orgId, { scopeObjectId: orgId, effect: "deny" }, writer)
    ).toBe(false);
  });

  it("is false for a malformed effect — a row a pre-check dump can still carry", () => {
    // `role_bindings_effect_check` constrains WRITES; PostgreSQL never re-checks a row on the way
    // out. `hasPermission` treats such a row as neither allow nor deny, and so does this.
    for (const effect of ["ALLOW", "Allow", "", "grant"]) {
      expect(
        revokeAffectsAdministrativeFloor(orgId, { scopeObjectId: orgId, effect }, writer)
      ).toBe(false);
    }
  });

  it("is false below the org root — scopeExpandCte expands upward, so it is no recovery path", () => {
    expect(
      revokeAffectsAdministrativeFloor(
        orgId,
        { scopeObjectId: "service-7", effect: "allow" },
        writer
      )
    ).toBe(false);
  });

  it("is false for a role that cannot administer bindings", () => {
    expect(
      revokeAffectsAdministrativeFloor(
        orgId,
        { scopeObjectId: orgId, effect: "allow" },
        builtIn("Viewer", { permissions: ["object:read", "audit:read"] })
      )
    ).toBe(false);
  });

  it("is false for an empty permission array, and matches the permission string exactly", () => {
    expect(
      revokeAffectsAdministrativeFloor(
        orgId,
        { scopeObjectId: orgId, effect: "allow" },
        builtIn("X")
      )
    ).toBe(false);
    for (const permission of ["role_binding:write ", "Role_binding:write", "role_binding:*"]) {
      expect(
        revokeAffectsAdministrativeFloor(
          orgId,
          { scopeObjectId: orgId, effect: "allow" },
          builtIn("X", { permissions: [permission] })
        )
      ).toBe(false);
    }
  });
});
