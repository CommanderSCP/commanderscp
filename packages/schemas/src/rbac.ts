import { z } from "zod";
import { CursorPageQuerySchema, cursorPageResponseSchema } from "./common.js";

/** ROLES AND ROLE BINDINGS. See docs/schemas.md §359. */

/** One role, as `GET /api/v1/roles` publishes it. See docs/schemas.md §360. */
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
  /** D5 (owner ruling, role-model.md §7.1). See docs/schemas.md §361. */
  deprecated: z.boolean(),
  /** Human-readable reason + the purpose role to use instead, or `null` when not deprecated. The
   *  SAME string the write door's refusal carries, from the same table, so the listing and the 422
   *  can never name different replacements. */
  deprecationReason: z.string().nullable()
});
export type Role = z.infer<typeof RoleSchema>;

/** Unpaginated, deliberately. `roles` is a bounded catalogue. See docs/schemas.md §362. */
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
  /** Filter to bindings written AT this exact object. See docs/schemas.md §363. */
  scopeObjectId: z.string().uuid().optional()
});
export type RoleBindingListQuery = z.infer<typeof RoleBindingListQuerySchema>;

export const RoleBindingListResponseSchema = cursorPageResponseSchema(RoleBindingSchema);
export type RoleBindingListResponse = z.infer<typeof RoleBindingListResponseSchema>;

/** `POST /api/v1/role-bindings` — a GRANT. See docs/schemas.md §364. */
export const CreateRoleBindingRequestSchema = z.object({
  subjectId: z.string().uuid(),
  roleId: z.string().uuid(),
  scopeObjectId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
  /** The granter states whom this binding will empower. See docs/schemas.md §365. */
  acknowledgedPrincipalIds: z.array(z.string().uuid()).max(5000).optional()
});
export type CreateRoleBindingRequest = z.infer<typeof CreateRoleBindingRequestSchema>;

/** What the acknowledgement must equal, previewed. See docs/schemas.md §366. */
export const GrantPreviewQuerySchema = z.object({
  /** The prospective binding's subject. See docs/schemas.md §367. */
  subjectId: z.string().uuid()
});
export type GrantPreviewQuery = z.infer<typeof GrantPreviewQuerySchema>;

/** One principal the binding reaches and the caller may read. See docs/schemas.md §368. */
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

/** THE PROJECTION RULE. See docs/schemas.md §369. */
export const GrantPreviewResponseSchema = z.object({
  subjectId: z.string().uuid(),
  subjectTypeId: z.string(),
  /** `true` when `POST /role-bindings` will refuse a body with no `acknowledgedPrincipalIds` for
   *  this subject — i.e. when the subject is a `group` or a `team`. Read from the door's own rule so
   *  a client never has to re-derive it from `subjectTypeId`. */
  acknowledgementRequired: z.boolean(),
  /** True when this caller can see the whole compared set. See docs/schemas.md §370. */
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
  /** True when this subject's membership is IdP-managed. See docs/schemas.md §371. */
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

/** Effective permissions: what this subject may do here. See docs/schemas.md §372. */
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
  /** The permissions held at this scope, deny already applied. See docs/schemas.md §373. */
  permissions: z.array(z.string()),
  /** Every binding that contributed, so a refusal is explainable rather than mysterious. Empty
   *  when the caller holds nothing here, which is a legitimate and common answer. */
  contributingBindings: z.array(ContributingBindingSchema)
});
export type EffectivePermissionsResponse = z.infer<typeof EffectivePermissionsResponseSchema>;

/** Custom roles: the authoring routes and their shapes. See docs/schemas.md §374. */
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

/** A partial update. See docs/schemas.md §375. */
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

/** INSTANCE OPERATOR CREDENTIALS. See docs/schemas.md §376. */
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
  /** How the CALLING request was admitted. See docs/schemas.md §377. */
  callerMechanism: z.enum(["credential", "bootstrap-env-token"])
});
export type OperatorCredentialListResponse = z.infer<typeof OperatorCredentialListResponseSchema>;

export const OperatorCredentialIdParamSchema = z.object({ id: z.string().uuid() });
export type OperatorCredentialIdParam = z.infer<typeof OperatorCredentialIdParamSchema>;
