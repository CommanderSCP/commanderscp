import { z } from "zod";
import { CursorPageQuerySchema, cursorPageResponseSchema } from "./common.js";

/** ROLES AND ROLE BINDINGS. See docs/schemas/rbac.md §1. */

/** One role, as `GET /api/v1/roles` publishes it. See docs/schemas/rbac.md §2. */
export const RoleSchema = z.object({
  id: z.string().uuid(),
  /** `null` for the SHARED BUILT-IN singletons — the rows every org on the deployment reads through
   *  the `roles` RLS `USING (org_id = current_org OR org_id IS NULL)` clause and no org can write. */
  orgId: z.string().uuid().nullable(),
  name: z.string(),
  permissions: z.array(z.string()),
  /** Object type ids this role may be bound at (drizzle/0097 §5), enforced at the write door.
   *  `null` means ANY scope, which is what the five cumulative-ladder rows carry and must keep
   *  carrying — their live bindings predate the column. */
  bindableAt: z.array(z.string()).nullable(),
  /**
   * D5 (owner ruling, role-model.md §7.1) — `true` for a built-in the write door refuses NEW
   * bindings to. A UI greys the row; the row itself stays, and every EXISTING binding to it keeps
   * resolving unchanged. This is a refusal at the door, not a removal.
   *
   * Required-and-always-present rather than optional: an absent field reads as "old server" and the
   * UI would have to guess. It is `false` for every role but the deprecated ones.
   */
  deprecated: z.boolean(),
  /** Human-readable reason + the purpose role to use instead, or `null` when not deprecated. The
   *  SAME string the write door's refusal carries, from the same table, so the listing and the 422
   *  can never name different replacements. */
  deprecationReason: z.string().nullable()
});
export type Role = z.infer<typeof RoleSchema>;

/**
 * Unpaginated, deliberately. `roles` is a bounded catalogue — ten built-in singletons today, plus
 * whatever an org has hand-written, and there is no authoring API to grow it (see the module doc).
 * Same shape as `PatListResponseSchema`. Adding `nextCursor` later is an additive response change;
 * paginating a ten-row catalogue now would only make every consumer write a loop.
 */
export const RoleListResponseSchema = z.object({
  items: z.array(RoleSchema)
});
export type RoleListResponse = z.infer<typeof RoleListResponseSchema>;

/** One `role_bindings` row. `roleName` is denormalized onto the response so a list of bindings is
 *  readable without a second call to `GET /roles` per row. */
export const RoleBindingSchema = z.object({
  id: z.string().uuid(),
  /** The graph object holding the authority — a `user`, `service-account`, `group` or `team`. */
  subjectId: z.string().uuid(),
  roleId: z.string().uuid(),
  roleName: z.string(),
  /** The object at-or-below which this binding grants. `authz/resolve.ts`'s scope walk expands
   *  UPWARD from the object being checked, so a binding here reaches everything beneath it. */
  scopeObjectId: z.string().uuid(),
  /** A `deny` overrides every `allow` at any matching scope. Not writable through this API — see
   *  the module doc — but readable, because a deny row that exists must be visible and revocable. */
  effect: z.enum(["allow", "deny"]),
  createdAt: z.string().datetime()
});
export type RoleBinding = z.infer<typeof RoleBindingSchema>;

export const RoleBindingListQuerySchema = CursorPageQuerySchema.extend({
  subjectId: z.string().uuid().optional(),
  /** Filter to bindings written AT this exact object. See docs/schemas/rbac.md §3. */
  scopeObjectId: z.string().uuid().optional()
});
export type RoleBindingListQuery = z.infer<typeof RoleBindingListQuerySchema>;

export const RoleBindingListResponseSchema = cursorPageResponseSchema(RoleBindingSchema);
export type RoleBindingListResponse = z.infer<typeof RoleBindingListResponseSchema>;

/** `POST /api/v1/role-bindings` — a GRANT. See docs/schemas/rbac.md §4. */
export const CreateRoleBindingRequestSchema = z.object({
  subjectId: z.string().uuid(),
  roleId: z.string().uuid(),
  scopeObjectId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
  /**
   * D7 (owner ruling 2026-08-27) — THE GRANTER STATES WHOM THIS BINDING WILL EMPOWER.
   *
   * THE PROBLEM IT ANSWERS, and it is not escalation. Binding a role to a group hands that role to
   * every principal `member_of` reaches, including one who self-joined while the group was empty.
   * The granter already holds the role, so nothing is escalated — what they cannot do is SEE whom
   * they are empowering, and a previous round measured that no membership-shape-blind rule separates
   * the exploit from the legitimate "bind SecurityOfficer to the security team" (every authority bar
   * on this door asks about the ACTOR, the ROLE and the SCOPE, and none reads the subject's
   * identity, so a standing-based refusal here admits every request it is ever asked about). The
   * owner ruled: make the grant INFORMED rather than refused.
   *
   * ------------------------------------------------------------------------------------------------
   * WHY AN ID LIST, and not a count and not a digest
   * ------------------------------------------------------------------------------------------------
   * All three shapes were weighed against what a UI and a CLI can each produce and against what a
   * stale value means.
   *
   *  - **A COUNT is producible without ever reading the membership** — which is precisely the
   *    blindness the ruling is about — and it is unchanged by a substitution (member A out, member B
   *    in), so it witnesses the wrong property.
   *  - **A DIGEST needs the same input an id list needs** (the caller must have the ids to hash
   *    them), so it costs the caller exactly as much, and it destroys the server's ability to name
   *    the DIFFERENCE: from a hash the 409 can say "not what you acknowledged" and nothing more.
   *    This repo's standing rule is that a refusal names what is wrong.
   *  - **AN ID LIST is the only shape in which the caller has demonstrably handled every principal**,
   *    and it lets the mismatch be reported in both directions — ids reached but not acknowledged (a
   *    member joined between the caller's read and its write), and ids acknowledged but no longer
   *    reached (a member left, or the caller sent something it never read).
   *
   * The value is the FULL `member_of` closure below the subject — every principal at depth > 0,
   * nested groups and teams included, because a nested group is itself empowered and naming it is
   * how the caller learns the nesting exists. It is the identical set the door's §2b membership walk
   * computes, from the identical `memberExpandCte` definition, so the field can never mean something
   * different from what the binding does. Order is irrelevant; duplicates are irrelevant; the
   * comparison is set equality.
   *
   * ------------------------------------------------------------------------------------------------
   * OPTIONAL IN THE CONTRACT, REQUIRED AT THE DOOR — and which one this is, is a decision
   * ------------------------------------------------------------------------------------------------
   * The requirement is CONDITIONAL: mandatory when `subjectId` names a `group` or a `team`, absent
   * for a `user` or `service-account`, because the ruling says not to burden the common case. A
   * schema-level `required` cannot express "only when the subject is a group" — it would force every
   * grant to a user to carry `[]` — so the field is optional here and its absence is refused at the
   * door (422) when the subject is a group or team.
   *
   * That also keeps the OpenAPI change unambiguously additive. Adding a REQUIRED request property to
   * an existing operation is a breaking change on this repo's oasdiff gate; it happens not to bite
   * here, because `POST /api/v1/role-bindings` does not exist in the committed document at all (it
   * ships in this same increment, and a NEW path is an addition), but relying on that would leave a
   * field that could never be relaxed afterwards. Optional-with-refusal is the shape that stays true
   * if the operation is ever cut and re-landed.
   *
   * ------------------------------------------------------------------------------------------------
   * HOW A CALLER LEARNS THE VALUE — `GET /api/v1/role-bindings/grant-preview?subjectId=…`
   * ------------------------------------------------------------------------------------------------
   * A field a CLI cannot compute is a field nobody can use. The preview operation
   * ({@link GrantPreviewResponseSchema}) walks the same closure and returns
   * `acknowledgedPrincipalIds` ready to paste into this body, alongside the per-principal detail a
   * UI renders. One call, no `member_of` traversal in the client, and the same walk on both sides.
   *
   * ⚠️ **THE PREVIEW PROJECTS ONLY WHAT ITS CALLER COULD ALREADY READ**, so for a caller whose
   * `object:read` does not reach every empowered principal the value it returns is INCOMPLETE and
   * this door will 409 on it. That response says so in a field (`acknowledgementComplete`) rather
   * than leaving it to be discovered, and {@link GrantPreviewResponseSchema} carries the measurement
   * of who is and is not in that population. Such a caller is not stuck: the 409 this door throws
   * NAMES every id it was not given, and that disclosure sits behind `role_binding:write` at the
   * scope plus the whole no-escalation subset rule — a strictly stronger bar than the preview's
   * `audit:read` — so the acknowledgement costs them one extra round trip rather than being
   * unobtainable.
   *
   * ------------------------------------------------------------------------------------------------
   * THE EMPTY GROUP — `[]` IS EXPRESSIBLE AND MEANS SOMETHING
   * ------------------------------------------------------------------------------------------------
   * `[]` states "this binding empowers nobody today", which is the legitimate seat-the-team-later
   * flow AND the exploit's step 2. It is accepted, because acknowledging zero is a TRUE statement at
   * the moment of the grant, and because the follow-on it enables is separately guarded: joining a
   * group that already holds a binding runs the no-escalation subset rule at the choke point
   * (`docs/authz/role-binding-door.md` §2a), so an empty group can only be seated afterwards by a
   * principal who already holds everything it carries. `undefined` and `[]` are therefore NOT the
   * same thing here — the first is "I did not look", the second is "I looked and it is empty" — and
   * only the second is admitted for a group subject.
   *
   * The bound is `member_of`'s registered cardinality times the closure depth in practice; 5000 is a
   * request-size guard, not a model limit, and a group larger than that cannot be acknowledged
   * through this field. Recorded as a limit rather than left to be discovered.
   */
  acknowledgedPrincipalIds: z.array(z.string().uuid()).max(5000).optional()
});
export type CreateRoleBindingRequest = z.infer<typeof CreateRoleBindingRequestSchema>;

/**
 * `GET /api/v1/role-bindings/grant-preview` — what `acknowledgedPrincipalIds` must say.
 *
 * READ-ONLY, and it answers exactly one question: "if I bind a role to this subject, whom does that
 * empower?". It names no role and no scope because the answer does not depend on either — the
 * membership closure is a property of the subject alone — and inventing parameters the answer
 * ignores would be a contract that lies about what it consults.
 */
export const GrantPreviewQuerySchema = z.object({
  /** The prospective binding's subject. See docs/schemas/rbac.md §5. */
  subjectId: z.string().uuid()
});
export type GrantPreviewQuery = z.infer<typeof GrantPreviewQuerySchema>;

/** One principal a binding on the previewed subject would reach **and the caller may read**. See
 *  {@link GrantPreviewResponseSchema}'s projection rule: this array contains only principals inside
 *  the caller's readable scope as `authz/readable-scope.ts` computes it.
 *
 *  That set equals what `GET /api/v1/objects/{type}/{id}` admits, with ONE measured exception: an
 *  org-root reader carrying a `deny` lower down. `org-root-arm.ts`'s org-root arm never consults such
 *  a deny, so the filter's `null` short-circuit shows the row while get-by-id refuses it. That is not
 *  a widening introduced here — the LIST doors already return the same rows to the same caller from
 *  the same short-circuit — but it means "get-by-id would admit it" is the wrong rule to state, and
 *  stating it as an absolute is how a reader is misled. `role-binding-door.ts`'s `readableSubsetOf`
 *  carries the divergence in full. */
export const EmpoweredPrincipalSchema = z.object({
  id: z.string().uuid(),
  typeId: z.string(),
  name: z.string().nullable(),
  /** `member_of` hops from the subject. Always ≥ 1: the subject itself is not in this list. */
  depth: z.number().int(),
  /** `true` when the object is soft-deleted. Such a principal STILL RESOLVES through the group (the
   *  permission walk joins `relationships.deleted_at`, never `objects.deleted_at`), and the grant
   *  door refuses a binding that reaches one — so a UI must be able to show it as the blocker. */
  deleted: z.boolean(),
  /** `false` when the object's type cannot hold a role binding at all. The other arm of the same
   *  refusal. */
  bindable: z.boolean()
});
export type EmpoweredPrincipal = z.infer<typeof EmpoweredPrincipalSchema>;

/** THE PROJECTION RULE. See docs/schemas/rbac.md §6. */
export const GrantPreviewResponseSchema = z.object({
  subjectId: z.string().uuid(),
  subjectTypeId: z.string(),
  /** `true` when `POST /role-bindings` will refuse a body with no `acknowledgedPrincipalIds` for
   *  this subject — i.e. when the subject is a `group` or a `team`. Read from the door's own rule so
   *  a client never has to re-derive it from `subjectTypeId`. */
  acknowledgementRequired: z.boolean(),
  /**
   * `true` when this caller can see the WHOLE set the door will compare against — i.e.
   * `withheldPrincipalCount` is 0 — and `acknowledgedPrincipalIds` may therefore be sent as-is.
   *
   * Required and always present rather than left to be derived from the count, for
   * {@link RoleSchema}'s `deprecated` reason: a client that has to compute "is this value usable"
   * from two other fields is a client that will get it wrong once, and getting it wrong here means
   * pasting a value the grant door refuses.
   */
  acknowledgementComplete: z.boolean(),
  /** How many principals this binding would empower that the caller may NOT `object:read`, and whose
   *  identities are therefore absent from both arrays below. A count, never an id — see the
   *  projection rule above for why it is a count and why it is not nothing. */
  withheldPrincipalCount: z.number().int().nonnegative(),
  /** The value to send as `acknowledgedPrincipalIds`, sorted, so a CLI can paste it through without
   *  sorting or de-duplicating — **complete only when `acknowledgementComplete` is `true`**. Empty
   *  for a subject that empowers nobody, and equally empty for a caller who may read none of the
   *  principals it does empower; the two are told apart by `withheldPrincipalCount`. */
  acknowledgedPrincipalIds: z.array(z.string().uuid()),
  /** The same set with the detail a human needs to decide — filtered identically. */
  principals: z.array(EmpoweredPrincipalSchema),
  /**
   * `true` when this subject's membership is managed by an IDENTITY PROVIDER
   * (`auth/identity-sync.ts` — the group carries an `externalIdentity.claimValue`).
   *
   * WHY THIS IS ON THE PREVIEW AND NOT JUST IN A DOC. D7 asks the granter to acknowledge WHOM a
   * group binding empowers, and the acknowledgement is a statement about a moment. For a
   * directory-synced group that moment is shorter than it looks: the membership this response
   * enumerates is whatever the provider said at the last login of each member, and it changes
   * without anyone touching SCP. A granter who reads the list and concludes "these five people"
   * has understood the wrong thing.
   *
   * So the honest framing, which a UI should render and a CLI should print: binding a role here
   * delegates the choice of WHO HOLDS IT to whoever administers the directory. The acknowledgement
   * still means what it says about today; it stops being a control tomorrow, and this flag is how
   * the caller finds that out BEFORE granting rather than afterwards.
   */
  subjectExternallySynced: z.boolean()
});
export type GrantPreviewResponse = z.infer<typeof GrantPreviewResponseSchema>;

/** `DELETE /api/v1/role-bindings/{id}` — a REVOKE. A body on a DELETE, with the in-tree precedent
 *  being `DELETE /api/v1/freezes/{id}` and `DELETE /api/v1/change-sources/{kind}/mappings`: the
 *  reason is mandatory for the same reason it is on a grant, and a free-text governance
 *  justification does not belong in a query string. */
export const DeleteRoleBindingRequestSchema = z.object({
  reason: z.string().min(1).max(2000)
});
export type DeleteRoleBindingRequest = z.infer<typeof DeleteRoleBindingRequestSchema>;

export const RoleBindingIdParamSchema = z.object({ id: z.string().uuid() });
export type RoleBindingIdParam = z.infer<typeof RoleBindingIdParamSchema>;

/**
 * ================================================================================================
 * EFFECTIVE PERMISSIONS — role-model.md §5 step 6
 * ================================================================================================
 *
 * `GET /api/v1/authz/effective?scopeObjectId=…` — "what may I do at THIS object".
 *
 * WHY THIS OPERATION HAS TO EXIST. With five purpose-shaped roles the cumulative ladder is gone: a
 * principal is no longer "Operator and therefore everything below Operator", and there is no
 * ordering a UI can use to guess. A SecurityOfficer holds `scan:override` and NO `object:write`;
 * an OrgAdmin holds `policy:write` and NOT `scan:override`. Nothing about either is derivable from
 * a rank, so a client that wants to know whether to render a control has exactly two options: ask,
 * or POST and find out from the 403. role-model.md §5 step 6 records that the second is not a
 * usable UI.
 *
 * THE ANSWER IS ABOUT ONE OBJECT, DELIBERATELY. `authz/resolve.ts`'s scope walk expands UPWARD, so
 * authority at an object comes from bindings at it or ABOVE it, and "what may I do" has no
 * org-wide answer — only a per-object one. This is the question
 * `GET /role-bindings?scopeObjectId=` explicitly REFUSES to answer (that filter is an exact match
 * on where a binding is written, and answering the containment question under its name would be
 * the more dangerous of the two to get wrong).
 */
export const EffectivePermissionsQuerySchema = z.object({
  /** The object to evaluate at. Any graph object; the walk upward from it is what decides. */
  scopeObjectId: z.string().uuid()
});
export type EffectivePermissionsQuery = z.infer<typeof EffectivePermissionsQuerySchema>;

/** One binding that contributes authority at the evaluated scope — including bindings reached
 *  through group or team membership, which is why this is not simply the caller's own rows. */
export const ContributingBindingSchema = z.object({
  roleId: z.string().uuid(),
  roleName: z.string(),
  /** The object the binding is written AT — at or above the evaluated scope. */
  scopeObjectId: z.string().uuid(),
  /** The subject the binding names: the caller, or a group/team the caller belongs to. Naming it
   *  is how an operator answers "why do I have this?" without a second call. */
  viaSubjectId: z.string().uuid(),
  effect: z.enum(["allow", "deny"])
});
export type ContributingBinding = z.infer<typeof ContributingBindingSchema>;

export const EffectivePermissionsResponseSchema = z.object({
  scopeObjectId: z.string().uuid(),
  /**
   * The permissions held at this scope, sorted, deny-override already applied.
   *
   * `string[]` and not an enum, for {@link RoleSchema}'s reason: `roles.permissions` is an
   * unconstrained `text[]`, and a response enum cannot gain a member without breaking this repo's
   * oasdiff gate — which would make every future permission split a `/v1` break.
   */
  permissions: z.array(z.string()),
  /** Every binding that contributed, so a refusal is explainable rather than mysterious. Empty
   *  when the caller holds nothing here, which is a legitimate and common answer. */
  contributingBindings: z.array(ContributingBindingSchema)
});
export type EffectivePermissionsResponse = z.infer<typeof EffectivePermissionsResponseSchema>;

/**
 * ================================================================================================
 * CUSTOM ROLES — role-model.md §5 step 10
 * ================================================================================================
 *
 * `POST /roles`, `PATCH /roles/{id}`, `DELETE /roles/{id}` — an org authoring its own roles.
 *
 * THIS WAS GATED, AND THE GATE IS NOW CLOSED. The module doc above says `GET /roles` is read-only
 * "gated behind closing a live quorum bypass first". That bypass — `hasRoleAtScope` matching
 * `rl.name` with no `org_id` predicate, so an org's own 'Approver' conferred quorum eligibility
 * everywhere a policy named Approver — was closed by owner decision on 2026-08-27: quorum
 * eligibility resolves BUILT-IN names only. Custom roles carry permissions and are bindable; they
 * can never satisfy an approval quorum. That is the property that makes this API safe to ship, and
 * it is enforced in `authz/resolve.ts` rather than here.
 *
 * ------------------------------------------------------------------------------------------------
 * WHAT AUTHORING IS AND IS NOT
 * ------------------------------------------------------------------------------------------------
 * Authoring a role CONFERS NOTHING BY ITSELF — a role with no bindings grants no one anything, and
 * `POST /role-bindings` applies the full no-escalation subset rule to every attempt to bind it. So
 * the load-bearing bar against escalation is, and remains, the binding door.
 *
 * The subset rule is applied HERE TOO, and the reason is not escalation: a catalogue in which a
 * `Viewer` can author a role named 'Estate Owner' carrying `freeze:override` is a catalogue that
 * LIES to every operator who reads `GET /roles`, and it invites the social-engineering step where
 * someone with authority binds it without reading its array. Refusing at authoring keeps the
 * catalogue honest. Stated plainly because "defence in depth" is where unexamined bars accumulate.
 */
export const CreateRoleRequestSchema = z.object({
  /** Unique within the org (`roles_org_name_key`, drizzle/0103) and refused when it collides with a
   *  built-in name — a shadowing row would be permanently unbindable anyway
   *  (`builtInNameCollisionReason`), so the refusal happens where it is fixable. */
  name: z.string().min(1).max(200),
  /** Must all be members of the catalogue `authz/resolve.ts` exports. An unknown string here is not
   *  a harmless no-op: it renders in `GET /roles` as authority and gates nothing, which is exactly
   *  the `org:admin` shape the drift gate exists to prevent recurring. */
  permissions: z.array(z.string()).max(100),
  /** Object type ids this role may be bound at; `null`/absent means ANY scope. */
  bindableAt: z.array(z.string()).max(50).nullish(),
  /** Mandatory for the same reason it is on a grant: authoring authority is a governance act and
   *  `audit_events` has no payload column. */
  reason: z.string().min(1).max(2000)
});
export type CreateRoleRequest = z.infer<typeof CreateRoleRequestSchema>;

/** A partial update. See docs/schemas/rbac.md §7. */
export const UpdateRoleRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  permissions: z.array(z.string()).max(100).optional(),
  bindableAt: z.array(z.string()).max(50).nullish(),
  reason: z.string().min(1).max(2000)
});
export type UpdateRoleRequest = z.infer<typeof UpdateRoleRequestSchema>;

export const RoleIdParamSchema = z.object({ id: z.string().uuid() });
export type RoleIdParam = z.infer<typeof RoleIdParamSchema>;

/** `DELETE /roles/{id}` — a body on a DELETE, same precedent as `DELETE /role-bindings/{id}`. */
export const DeleteRoleRequestSchema = z.object({
  reason: z.string().min(1).max(2000)
});
export type DeleteRoleRequest = z.infer<typeof DeleteRoleRequestSchema>;

/** INSTANCE OPERATOR CREDENTIALS. See docs/schemas/rbac.md §8. */
export const CreateOperatorCredentialRequestSchema = z.object({
  /** A label a human recognises at revoke time — "ci-runner", "alice-laptop". */
  name: z.string().min(1).max(200),
  /** ISO-8601. Absent means no expiry, which is what the env token it replaces always was; an
   *  expiring credential is the improvement, not the default, because forcing one on an air-gapped
   *  deployment with no rotation process would just cause an outage nobody could pre-empt. */
  expiresAt: z.string().datetime().nullish()
});
export type CreateOperatorCredentialRequest = z.infer<typeof CreateOperatorCredentialRequestSchema>;

/** The ONLY response that ever carries the secret, and only at creation. */
export const CreatedOperatorCredentialSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** `scp_op_<tokenId>.<secret>` — shown ONCE. There is no endpoint that can return it again;
   *  `token_hash` is argon2 output and is never serialized by any route. */
  token: z.string(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable()
});
export type CreatedOperatorCredential = z.infer<typeof CreatedOperatorCredentialSchema>;

export const OperatorCredentialSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** The minter's graph object, or `null` when it was minted with the BOOTSTRAP env token — a real
   *  and reportable state, not missing data. */
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
  /** Revocation stamps rather than deletes: a deleted row cannot answer "what was this, and when
   *  did it stop working", which is most of the point of replacing a shared secret. */
  revokedAt: z.string().datetime().nullable(),
  lastUsedAt: z.string().datetime().nullable()
});
export type OperatorCredential = z.infer<typeof OperatorCredentialSchema>;

export const OperatorCredentialListResponseSchema = z.object({
  items: z.array(OperatorCredentialSchema),
  /** How the CALLING request was admitted. See docs/schemas/rbac.md §9. */
  callerMechanism: z.enum(["credential", "bootstrap-env-token"])
});
export type OperatorCredentialListResponse = z.infer<typeof OperatorCredentialListResponseSchema>;

export const OperatorCredentialIdParamSchema = z.object({ id: z.string().uuid() });
export type OperatorCredentialIdParam = z.infer<typeof OperatorCredentialIdParamSchema>;
