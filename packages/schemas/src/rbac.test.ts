import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CreateRoleBindingRequestSchema,
  DeleteRoleBindingRequestSchema,
  EmpoweredPrincipalSchema,
  GrantPreviewQuerySchema,
  GrantPreviewResponseSchema,
  RoleBindingListQuerySchema,
  RoleBindingSchema,
  RoleSchema
} from "./rbac.js";

/**
 * ================================================================================================
 * THE RBAC CONTRACTS — what the SCHEMA refuses, as opposed to what the door refuses
 * ================================================================================================
 *
 * `routes/role-bindings.ts`'s handlers are exercised against real PostgreSQL in `apps/server`. This
 * file is about the layer BELOW them: several of this increment's security properties are enforced
 * by the Zod contract and by nothing else, so they are invisible to a test that goes through the
 * route — a request the schema rejects never reaches a handler, and a field the schema STRIPS
 * reaches it as `undefined` no matter what the client sent. If the contract silently relaxed, the
 * integration suite would stay green while the property was gone.
 *
 * The four properties pinned here, each with the consequence of losing it:
 *
 *  1. `effect` (and `roleName`) are NOT writable. `role_bindings.effect` is `'allow' | 'deny'` and a
 *     deny overrides every allow at any matching scope; the module doc rules a deny out of this
 *     increment because the no-escalation subset rule is UNSOUND for one. The repo never reads the
 *     field off the body, so what actually blocks the mass assignment is that the contract drops it.
 *  2. `acknowledgedPrincipalIds` is OPTIONAL. D7's requirement is CONDITIONAL (groups and teams
 *     only) and is enforced at the door with a 422. Making it schema-required would force every
 *     grant to a user to carry `[]` and would be a BREAKING request change on this repo's oasdiff
 *     gate — the shape was chosen so the operation stays true if it is ever cut and re-landed.
 *  3. `undefined` and `[]` are DIFFERENT values that survive parsing distinctly. The door reads them
 *     as "I did not look" and "I looked and it is empty" and admits only the second for a group. A
 *     `.default([])` on this field would erase that distinction silently, and the exploit D7 exists
 *     to stop — seat the group AFTER the grant — would be admitted with no acknowledgement at all.
 *  4. Response fields that a client must not have to derive — `Role.deprecated`,
 *     `GrantPreviewResponse.acknowledgementComplete` — are REQUIRED and always present, because an
 *     absent field reads as "old server" and the client guesses.
 */

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";

const grant = (over: Record<string, unknown> = {}) => ({
  subjectId: UUID_A,
  roleId: UUID_B,
  scopeObjectId: UUID_C,
  reason: "seating the payments on-call rotation",
  ...over
});

/** One synthetic uuid per index, so the 5000-element boundary can be built without 5000 literals. */
const uuidAt = (i: number): string =>
  `${i.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;

describe("CreateRoleBindingRequestSchema — what a grant may say", () => {
  it("accepts the minimal grant: a subject, a role, a scope and a reason", () => {
    const parsed = CreateRoleBindingRequestSchema.parse(grant());
    expect(parsed).toEqual(grant());
  });

  it("DROPS `effect` — a deny is not writable through this door, and this is what stops it", () => {
    // The no-escalation subset rule is unsound for a deny: writing one is not granting authority,
    // it is removing it, and "is deny-X a subset of my permissions" is a category error. The route
    // never reads `effect` off the body, so the contract is the only thing standing here.
    const parsed = CreateRoleBindingRequestSchema.parse(grant({ effect: "deny" }));
    expect(Object.hasOwn(parsed, "effect")).toBe(false);
  });

  it("DROPS `roleName` — an id cannot be ambiguous and a name deliberately can", () => {
    // `roles_builtin_name_key` is a PARTIAL unique index, so a name can legitimately match two rows
    // (a built-in and an org's own). Picking between them is the collision class this increment
    // refuses to open.
    const parsed = CreateRoleBindingRequestSchema.parse(grant({ roleName: "Owner" }));
    expect(Object.hasOwn(parsed, "roleName")).toBe(false);
  });

  it("emits `additionalProperties: false`, so an unknown key is REFUSED on the wire", () => {
    // Stripping and refusing are different outcomes and the deployed one is the emitted JSON
    // Schema, not `.parse` — Fastify validates the body against the emitted document.
    const emitted = z.toJSONSchema(CreateRoleBindingRequestSchema) as Record<string, unknown>;
    expect(emitted.additionalProperties).toBe(false);
  });

  it("leaves `acknowledgedPrincipalIds` OUT of the emitted `required` list", () => {
    // Adding a required request property to an existing operation is breaking on this repo's
    // oasdiff gate. D7's requirement is conditional and lives at the door as a 422.
    const emitted = z.toJSONSchema(CreateRoleBindingRequestSchema) as { required: string[] };
    expect(emitted.required.sort()).toEqual(["reason", "roleId", "scopeObjectId", "subjectId"]);
    expect(emitted.required).not.toContain("acknowledgedPrincipalIds");
  });

  it("keeps `undefined` and `[]` DISTINGUISHABLE after parsing", () => {
    // The whole of D7 rests on this. A `.default([])` here would turn "I did not look" into
    // "I looked and it is empty" and the door's 422 could never fire.
    const absent = CreateRoleBindingRequestSchema.parse(grant());
    expect(Object.hasOwn(absent, "acknowledgedPrincipalIds")).toBe(false);
    expect(absent.acknowledgedPrincipalIds).toBeUndefined();

    const empty = CreateRoleBindingRequestSchema.parse(grant({ acknowledgedPrincipalIds: [] }));
    expect(empty.acknowledgedPrincipalIds).toEqual([]);
  });

  it("accepts an explicit `undefined` as absence rather than as a value", () => {
    const parsed = CreateRoleBindingRequestSchema.parse(
      grant({ acknowledgedPrincipalIds: undefined })
    );
    expect(parsed.acknowledgedPrincipalIds).toBeUndefined();
  });

  it("preserves the order and the duplicates it is given — the door compares as a SET", () => {
    // Normalizing here would hide a caller bug from the door's 409 without changing the verdict,
    // and would make the request body no longer be what the caller sent.
    const ids = [UUID_C, UUID_A, UUID_A];
    expect(
      CreateRoleBindingRequestSchema.parse(grant({ acknowledgedPrincipalIds: ids }))
        .acknowledgedPrincipalIds
    ).toEqual(ids);
  });

  it("holds the 5000-element request-size guard exactly at the boundary", () => {
    const at = Array.from({ length: 5000 }, (_, i) => uuidAt(i));
    expect(
      CreateRoleBindingRequestSchema.safeParse(grant({ acknowledgedPrincipalIds: at })).success
    ).toBe(true);
    expect(
      CreateRoleBindingRequestSchema.safeParse(
        grant({ acknowledgedPrincipalIds: [...at, uuidAt(5000)] })
      ).success
    ).toBe(false);
  });

  it("rejects a malformed id anywhere in the acknowledgement, not just the first", () => {
    for (const bad of ["", "not-a-uuid", `${UUID_A} `, UUID_A.toUpperCase().replace("-4", "-9")]) {
      expect(
        CreateRoleBindingRequestSchema.safeParse(grant({ acknowledgedPrincipalIds: [UUID_A, bad] }))
          .success
      ).toBe(false);
    }
  });

  it("requires all three ids to be uuids — the columns they land in are `uuid` typed", () => {
    for (const field of ["subjectId", "roleId", "scopeObjectId"]) {
      expect(CreateRoleBindingRequestSchema.safeParse(grant({ [field]: "self" })).success).toBe(
        false
      );
      expect(CreateRoleBindingRequestSchema.safeParse(grant({ [field]: undefined })).success).toBe(
        false
      );
    }
  });

  it("makes `reason` mandatory and non-empty — a grant is a governance act", () => {
    // `audit_events` has no payload column; the operator's own words are the one thing the
    // structured Decision this door writes cannot reconstruct.
    expect(CreateRoleBindingRequestSchema.safeParse(grant({ reason: undefined })).success).toBe(
      false
    );
    expect(CreateRoleBindingRequestSchema.safeParse(grant({ reason: "" })).success).toBe(false);
  });

  it("bounds `reason` at 2000 characters, inclusive", () => {
    expect(
      CreateRoleBindingRequestSchema.safeParse(grant({ reason: "x".repeat(2000) })).success
    ).toBe(true);
    expect(
      CreateRoleBindingRequestSchema.safeParse(grant({ reason: "x".repeat(2001) })).success
    ).toBe(false);
  });

  it("does not coerce a non-string reason into one", () => {
    for (const reason of [42, null, ["why"], { why: "because" }]) {
      expect(CreateRoleBindingRequestSchema.safeParse(grant({ reason })).success).toBe(false);
    }
  });
});

describe("DeleteRoleBindingRequestSchema — a revoke carries the same mandatory reason", () => {
  it("accepts a reason and rejects an empty or absent one", () => {
    expect(DeleteRoleBindingRequestSchema.safeParse({ reason: "left the team" }).success).toBe(
      true
    );
    expect(DeleteRoleBindingRequestSchema.safeParse({ reason: "" }).success).toBe(false);
    expect(DeleteRoleBindingRequestSchema.safeParse({}).success).toBe(false);
  });

  it("holds the same 2000-character bound as the grant", () => {
    expect(DeleteRoleBindingRequestSchema.safeParse({ reason: "x".repeat(2000) }).success).toBe(
      true
    );
    expect(DeleteRoleBindingRequestSchema.safeParse({ reason: "x".repeat(2001) }).success).toBe(
      false
    );
  });
});

describe("GrantPreviewQuerySchema — one parameter, and it is the authorization anchor", () => {
  it("takes `subjectId` and nothing else", () => {
    expect(GrantPreviewQuerySchema.parse({ subjectId: UUID_A })).toEqual({ subjectId: UUID_A });
  });

  it("does not carry a caller-chosen `scopeObjectId` through", () => {
    // An earlier revision took one as an "authorization input". Because the caller chooses it, any
    // holder of a scoped `audit:read` anywhere in the org could name their own service and read the
    // full transitive membership of ANY group. The parameter is gone; this is what says so.
    const parsed = GrantPreviewQuerySchema.parse({ subjectId: UUID_A, scopeObjectId: UUID_B });
    expect(Object.hasOwn(parsed, "scopeObjectId")).toBe(false);
  });

  it("requires the subject to be a uuid", () => {
    expect(GrantPreviewQuerySchema.safeParse({ subjectId: "the-payments-team" }).success).toBe(
      false
    );
    expect(GrantPreviewQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe("RoleSchema — the catalogue's open sets and its two closed ones", () => {
  const role = (over: Record<string, unknown> = {}) => ({
    id: UUID_A,
    orgId: null,
    name: "OrgAdmin",
    permissions: ["object:read", "role_binding:write"],
    bindableAt: ["organization"],
    deprecated: false,
    deprecationReason: null,
    ...over
  });

  it("accepts a permission string that is not in today's Permission union", () => {
    // `roles.permissions` is a plain `text[]` with no CHECK: a restored dump or a hand-written row
    // can hold `org:admin`, which a later migration removed. An enum here would 500 on data the
    // database accepts, and adding an enum member to a RESPONSE is breaking on the oasdiff gate.
    expect(
      RoleSchema.safeParse(role({ permissions: ["org:admin", "some:future:split"] })).success
    ).toBe(true);
  });

  it("accepts a `bindableAt` naming an object type that does not exist yet, and `null` for ANY", () => {
    expect(RoleSchema.safeParse(role({ bindableAt: ["not-a-type-yet"] })).success).toBe(true);
    expect(RoleSchema.parse(role({ bindableAt: null })).bindableAt).toBeNull();
    // `[]` is a different statement from `null` and both are representable.
    expect(RoleSchema.parse(role({ bindableAt: [] })).bindableAt).toEqual([]);
  });

  it("requires `deprecated` to be present — an absent field would read as 'old server'", () => {
    const { deprecated: _dropped, ...withoutDeprecated } = role();
    expect(RoleSchema.safeParse(withoutDeprecated).success).toBe(false);
  });

  it("requires `deprecationReason` to be present, and lets it be null", () => {
    const { deprecationReason: _dropped, ...withoutReason } = role();
    expect(RoleSchema.safeParse(withoutReason).success).toBe(false);
    expect(
      RoleSchema.parse(role({ deprecated: true, deprecationReason: "use OrgAdmin" }))
    ).toMatchObject({ deprecated: true, deprecationReason: "use OrgAdmin" });
  });

  it("allows `orgId: null` for the shared built-in singletons and a uuid otherwise", () => {
    expect(RoleSchema.parse(role({ orgId: null })).orgId).toBeNull();
    expect(RoleSchema.parse(role({ orgId: UUID_B })).orgId).toBe(UUID_B);
    expect(RoleSchema.safeParse(role({ orgId: "global" })).success).toBe(false);
  });
});

describe("RoleBindingSchema — `effect` is the deliberate exception, closed at two values", () => {
  const binding = (over: Record<string, unknown> = {}) => ({
    id: UUID_A,
    subjectId: UUID_B,
    roleId: UUID_C,
    roleName: "Viewer",
    scopeObjectId: UUID_A,
    effect: "allow",
    createdAt: "2026-08-27T10:00:00.000Z",
    ...over
  });

  it("accepts exactly `allow` and `deny`", () => {
    expect(RoleBindingSchema.parse(binding({ effect: "allow" })).effect).toBe("allow");
    expect(RoleBindingSchema.parse(binding({ effect: "deny" })).effect).toBe("deny");
  });

  it("rejects a third effect — the set is closed by `role_bindings_effect_check`, not by convention", () => {
    // This is why `roles-repo.ts` narrows a restored pre-check row to `deny` on the way out rather
    // than passing it through: the response contract would refuse to serialize it.
    for (const effect of ["ALLOW", "Allow", "block", "", null]) {
      expect(RoleBindingSchema.safeParse(binding({ effect })).success).toBe(false);
    }
  });

  it("requires `createdAt` to be a datetime, not any string", () => {
    expect(RoleBindingSchema.safeParse(binding({ createdAt: "2026-08-27" })).success).toBe(false);
  });
});

describe("RoleBindingListQuerySchema — two exact-match filters, both optional", () => {
  it("defaults the page size and needs no filter at all", () => {
    expect(RoleBindingListQuerySchema.parse({})).toEqual({ limit: 20 });
  });

  it("accepts either filter, and refuses a non-uuid in place of one", () => {
    expect(RoleBindingListQuerySchema.parse({ subjectId: UUID_A }).subjectId).toBe(UUID_A);
    expect(RoleBindingListQuerySchema.parse({ scopeObjectId: UUID_B }).scopeObjectId).toBe(UUID_B);
    expect(RoleBindingListQuerySchema.safeParse({ subjectId: "me" }).success).toBe(false);
  });
});

describe("GrantPreviewResponseSchema — the projection's honesty fields", () => {
  const preview = (over: Record<string, unknown> = {}) => ({
    subjectId: UUID_A,
    subjectTypeId: "group",
    acknowledgementRequired: true,
    acknowledgementComplete: true,
    withheldPrincipalCount: 0,
    acknowledgedPrincipalIds: [UUID_B],
    principals: [
      { id: UUID_B, typeId: "user", name: "ada", depth: 1, deleted: false, bindable: true }
    ],
    // Required, not optional: a client that has to infer whether a subject's membership is managed
    // by an identity provider is a client that will assume "no" and read the acknowledgement as a
    // durable fact about who holds the role. See the field's own doc.
    subjectExternallySynced: false,
    ...over
  });

  it("accepts a complete preview", () => {
    expect(GrantPreviewResponseSchema.safeParse(preview()).success).toBe(true);
  });

  it("requires `acknowledgementComplete` rather than leaving it to be derived from the count", () => {
    // Deriving "is this value usable" from two other fields is how a client gets it wrong once, and
    // getting it wrong here means pasting a value the grant door refuses.
    const { acknowledgementComplete: _dropped, ...without } = preview();
    expect(GrantPreviewResponseSchema.safeParse(without).success).toBe(false);
  });

  it("requires `withheldPrincipalCount` to be a non-negative integer", () => {
    expect(
      GrantPreviewResponseSchema.safeParse(preview({ withheldPrincipalCount: -1 })).success
    ).toBe(false);
    expect(
      GrantPreviewResponseSchema.safeParse(preview({ withheldPrincipalCount: 1.5 })).success
    ).toBe(false);
    expect(
      GrantPreviewResponseSchema.parse(preview({ withheldPrincipalCount: 3 }))
        .withheldPrincipalCount
    ).toBe(3);
  });

  it("represents the two states a bare `principals: []` can mean, and tells them apart", () => {
    // Empty because the group empowers nobody...
    const emptyGroup = GrantPreviewResponseSchema.parse(
      preview({ acknowledgedPrincipalIds: [], principals: [], withheldPrincipalCount: 0 })
    );
    // ...versus empty because the caller may read none of the principals it does empower.
    const withheld = GrantPreviewResponseSchema.parse(
      preview({
        acknowledgedPrincipalIds: [],
        principals: [],
        withheldPrincipalCount: 2,
        acknowledgementComplete: false
      })
    );
    expect(emptyGroup.withheldPrincipalCount).toBe(0);
    expect(withheld.withheldPrincipalCount).toBe(2);
    expect(withheld.acknowledgementComplete).toBe(false);
  });
});

describe("EmpoweredPrincipalSchema — the two blocker flags a UI must be able to render", () => {
  const p = (over: Record<string, unknown> = {}) => ({
    id: UUID_A,
    typeId: "user",
    name: "ada",
    depth: 1,
    deleted: false,
    bindable: true,
    ...over
  });

  it("carries `deleted` and `bindable` as required booleans", () => {
    // A soft-deleted principal STILL resolves through the group and the grant door refuses on it,
    // so a UI that cannot see the flag cannot show the blocker.
    for (const field of ["deleted", "bindable"]) {
      const without: Record<string, unknown> = { ...p() };
      delete without[field];
      expect(EmpoweredPrincipalSchema.safeParse(without).success).toBe(false);
    }
    expect(EmpoweredPrincipalSchema.parse(p({ deleted: true, bindable: false })).bindable).toBe(
      false
    );
  });

  it("allows a null name — a graph object is not required to have one", () => {
    expect(EmpoweredPrincipalSchema.parse(p({ name: null })).name).toBeNull();
  });

  it("requires `depth` to be an integer", () => {
    expect(EmpoweredPrincipalSchema.safeParse(p({ depth: 1.5 })).success).toBe(false);
    expect(EmpoweredPrincipalSchema.parse(p({ depth: 4 })).depth).toBe(4);
  });
});
