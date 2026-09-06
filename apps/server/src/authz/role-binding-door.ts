import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { conflict, forbidden, unprocessable } from "../errors.js";
import {
  PERMISSIONS,
  authorize,
  hasPermission,
  memberExpandCte,
  subjectExpandCte,
  type Permission
} from "./resolve.js";
import {
  partitionReadableRoots,
  readableObjectFilterSql,
  readableRootsFor
} from "./readable-scope.js";

/** The role-binding write door — every refusal, in one place. See docs/authz/role-binding-door.md. */

/**
 * §0 — SERIALIZE THE CHECK WITH THE ACT. Takes the org's transaction-scoped advisory lock; every
 * other caller of it blocks here until this transaction COMMITs or ROLLBACKs.
 *
 * MUST BE THE FIRST STATEMENT of the transaction that then reads authority state. A read taken
 * before the lock is a read from a snapshot the lock does not protect, which is the whole defect.
 *
 * THE KEY IS `audit/audit-repo.ts`'s, ON PURPOSE — `hashtext(orgId)` in the one-argument advisory
 * lock space, the per-org key `db/provision.ts`'s key-registry comment already names. A second
 * per-org key would deadlock against it: these doors would take authority-then-audit, while any
 * transaction that appends an audit event before writing a `member_of` edge (an IaC apply replaying
 * a manifest diff) takes audit-then-authority. Sharing one key removes the ordering. Taking it twice
 * in a transaction is free — advisory locks are counted per transaction and never block on
 * themselves — which is what lets `createRelationship` take it for an edge in a transaction whose
 * earlier `appendAuditEvent` already did.
 *
 * The full reasoning, the measured [200, 200] brick it closes, why `SELECT ... FOR UPDATE` cannot
 * close §2a/§2b, and what this does NOT cover are all in §0 of this module's header.
 */
export async function lockOrgRoleAuthority(tx: TenantTx, orgId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}))`);
}

/**
 * Object types a `role_bindings.subject_id` may point at.
 *
 * THE COLUMN CONSTRAINS NOTHING: it is a bare `uuid NOT NULL` with **no foreign key at all** and no
 * type check (`db/schema.ts`), which is the same unconstrained-uuid property role-model.md §1.3h
 * raises about `scope_object_id` — found here by censusing the property rather than the symptom, and
 * strictly worse, because `scope_object_id` at least has an FK to `objects`.
 *
 * The list is `member_of`'s registered `from_types` (drizzle/0002 §6) — the set of things the
 * subject expansion can even reach — plus nothing. A binding whose subject is a `component` is
 * accepted by the database and can never match a request, because `subject_expand` is seeded from
 * the authenticated principal's own graph object.
 */
export const ROLE_BINDING_SUBJECT_TYPES = ["user", "service-account", "group", "team"] as const;

/** The two subject types whose membership a grant reaches THROUGH — i.e. the ones §2b, §2c and the
 *  preview all have something to say about. One definition rather than a `=== "group" || === "team"`
 *  repeated at four call sites, because those four must agree about when an acknowledgement is
 *  demanded, when the membership walk runs, and what `GET /grant-preview` reports. */
export function subjectTypeNeedsMembershipReview(typeId: string): boolean {
  return typeId === "group" || typeId === "team";
}

/**
 * THE SUBJECT-SHAPED REFUSALS, ONE DEFINITION — §2b's two arms, expressed over an already-computed
 * membership closure so the GRANT door (`assertGrantReachesOnlyBindableMembers`) and the JOIN door
 * (`assertMayJoinRoleBearingSubject`) cannot disagree about what makes a principal unbindable.
 *
 * Returns a human-readable reason per offending principal, empty when the set is clean. The CALLER
 * chooses the population: the grant door passes `depth > 0` (the seed is the named subject, already
 * judged by `assertBindableSubject` and by `getObjectByIdOrUrnAnyType`'s liveness refusal), the join
 * door passes ALL depths (§2a's member-shape half — the joiner's own type is re-judged against the
 * binding-subject set rather than against the widenable `relationship_types.from_types`).
 *
 * LIVENESS FIRST, then type, and only one reason per principal: a tombstoned object of a
 * non-bindable type is one problem to fix, and naming it twice makes the refusal read as two.
 */
export function unbindablePrincipalReasons(principals: readonly ReachedPrincipal[]): string[] {
  const bad: string[] = [];
  for (const principal of principals) {
    const label = `'${principal.name ?? principal.id}' (${principal.typeId} '${principal.id}')`;
    if (principal.deleted) {
      bad.push(`${label} is soft-deleted`);
      continue;
    }
    if (!(ROLE_BINDING_SUBJECT_TYPES as readonly string[]).includes(principal.typeId)) {
      bad.push(`${label} cannot hold a role binding`);
    }
  }
  return bad;
}

/**
 * D5 (owner ruling 2026-08-25, role-model.md §7.1) — BUILT-IN roles that accept no NEW bindings.
 *
 * ONE DEFINITION, TWO CONSUMERS: the write door's 422 and `GET /roles`'s `deprecated` /
 * `deprecationReason` fields both read this table, so the listing a UI greys and the refusal an
 * operator hits can never name different replacements. A hard-coded map rather than a column because
 * the fact is about the SHIPPED BUILT-IN CATALOGUE, not about a row's data: `scp_app` holds no
 * UPDATE-worthy notion of deprecation and adding a column would invite an org to mark its own rows.
 *
 * KEYED BY NAME AND APPLIED ONLY TO `org_id IS NULL` ROWS. An org's own hand-written role that
 * happens to be called `Administrator` is a different row with different permissions; deprecating it
 * by name collision would refuse a grant for a reason that is not true of it. (That row has its own
 * problem and its own refusal — see {@link assertRoleAcceptsNewBindings}.)
 *
 * WHY ADMINISTRATOR. Its grab-bag is exactly what makes "SecOps implies type-registry authority"
 * true today. Leaving it grantable would keep it the path of least resistance and make the
 * least-privilege story aspirational, so the purpose roles are THE migration path rather than a
 * parallel option. The row stays, `role_bindings.role_id` is an FK and `scp_app` holds no DELETE on
 * `roles`, and every existing binding resolves unchanged — this is a refusal at the door, never a
 * removal.
 */
export const DEPRECATED_BUILTIN_ROLES: Readonly<Record<string, string>> = {
  Administrator:
    "the built-in 'Administrator' role is deprecated and accepts no new bindings (owner ruling D5). " +
    "Bind a purpose-shaped role instead: 'OrgAdmin' at the organization for full authority inside " +
    "one org, 'ServiceAdmin' at a service or domain, 'ComponentAdmin' at an assembly or component, " +
    "'FederationAdmin' at the organization to operate the federation link, or 'SecurityOfficer' at " +
    "the organization for scan ceilings and override waivers. Existing 'Administrator' bindings are " +
    "untouched and keep resolving."
};

/** The columns of a `roles` row this module reasons about. */
export interface BindableRole {
  id: string;
  /** `null` = a shared built-in singleton. Load-bearing on every check below. */
  orgId: string | null;
  name: string;
  permissions: string[];
  bindableAt: string[] | null;
}

/**
 * `true` when this row is a built-in the write door refuses new bindings to (D5).
 *
 * `Object.hasOwn` RATHER THAN A BARE INDEX, and it is not defensive noise: `roles.name` is a plain
 * `text` column and the lookup key comes straight off it, so `DEPRECATED_BUILTIN_ROLES[name]` for a
 * built-in row named `'toString'` or `'constructor'` resolves through `Object.prototype` and returns
 * a FUNCTION. `?? null` does not filter it — it is not nullish — so the value would be reported as
 * `Role.deprecationReason` (a non-string where the schema promises `string | null`) and handed to
 * {@link assertRoleAcceptsNewBindings}, whose 422 detail would then be a function body. Own-property
 * lookup is the same fix `governance/governance-labels.ts` makes for the same property.
 */
export function roleDeprecationReason(role: { orgId: string | null; name: string }): string | null {
  if (role.orgId !== null) return null;
  if (!Object.hasOwn(DEPRECATED_BUILTIN_ROLES, role.name)) return null;
  return DEPRECATED_BUILTIN_ROLES[role.name] ?? null;
}

/**
 * D5, plus the one refusal that keeps this door from becoming the second half of a live quorum
 * bypass. GRANT ONLY — see §4.
 *
 * THE QUORUM BYPASS, and why an ORG-SCOPED role sharing a BUILT-IN NAME is refused here.
 * `hasRoleAtScope` (`authz/resolve.ts`) decides approval-quorum eligibility by joining `roles` and
 * matching `rl.name = <the name a policy asked for>` with **no `org_id` predicate on the roles row**,
 * while `roles_builtin_name_key` is a PARTIAL unique index (`WHERE org_id IS NULL`) that
 * deliberately permits an org to hold a row with the same name. So a zero-permission org row named
 * `'Approver'` makes its holders eligible voters everywhere a policy names Approver — the
 * self-service quorum bypass role-model.md §5 keeps custom roles (step 10) out of this increment to
 * avoid.
 *
 * Refusing to AUTHOR such a role is step 10's job and there is no authoring API. But the bypass
 * needs two halves — the row, and a binding to it — and THIS DOOR IS THE SECOND HALF. Without this
 * check, shipping the binding API turns a row that today can only be created by hand-written SQL
 * into something exploitable through the public API by anyone holding `role_binding:write`. The
 * subset rule does not catch it: a ZERO-permission role is vacuously a subset of everything, and its
 * danger is not in its permissions at all — it is in its name.
 */
export function assertRoleAcceptsNewBindings(
  role: BindableRole,
  builtInRoleNames: ReadonlySet<string>
): void {
  const deprecated = roleDeprecationReason(role);
  if (deprecated) throw unprocessable(deprecated);

  const collision = builtInNameCollisionReason({
    id: role.id,
    orgId: role.orgId,
    name: role.name,
    collidesWithBuiltIn: builtInRoleNames.has(role.name)
  });
  if (collision) throw unprocessable(collision);
}

/**
 * THE QUORUM-BYPASS PREDICATE — one definition, two consumers ({@link assertRoleAcceptsNewBindings}
 * for a grant, {@link assertMayJoinRoleBearingSubject} for a `member_of` edge that would INHERIT such
 * a binding).
 *
 * Factored out 2026-08-27 because the join door needed the identical fact and a permissions-only
 * subset test cannot express it: the danger of this row is not in its permissions — a zero-permission
 * row is vacuously a subset of everything — it is in its NAME.
 *
 * `collidesWithBuiltIn` is passed in rather than read here so both callers can source it the way
 * their query already does: the grant door has `builtInRoleNames(tx)` in hand, and the join door
 * gets it as a column off the join it is already making.
 */
export function builtInNameCollisionReason(role: {
  id: string;
  orgId: string | null;
  name: string;
  collidesWithBuiltIn: boolean;
}): string | null {
  if (role.orgId === null || !role.collidesWithBuiltIn) return null;
  return (
    `role '${role.id}' is an org-defined role named '${role.name}', which collides with a ` +
    `built-in role name. Binding it is refused: approval quorums resolve 'fromRole' by NAME ` +
    `with no org predicate, so holders of this row would become eligible voters everywhere a ` +
    `policy names '${role.name}'. Rename the role, or bind the built-in of that name.`
  );
}

/**
 * `bindable_at` (drizzle/0097 §5, seeded by 0099) — GRANT ONLY, see §4.
 *
 * `role_bindings.scope_object_id` is `uuid NOT NULL REFERENCES objects(id)` with no type constraint,
 * no `scope_kind` column and no CHECK, so a binding at a `user`, a `change` or a `group` is accepted
 * today and silently INERT (role-model.md §1.3h). Inert is not the end of it: `objects.domain_id`
 * carries no type constraint either, so an object parented under such a row would make that binding
 * SUDDENLY CONFER AUTHORITY — a grant that was harmless when written and is not afterwards, with
 * nothing in between to notice.
 *
 * This is what turns "ComponentAdmin binds at an assembly or a component" from a sentence in a
 * proposal into something the API enforces. `null` means ANY scope and is what the five
 * cumulative-ladder rows carry: their live bindings predate the column, so narrowing them would
 * break deployments retroactively.
 */
export function assertRoleBindableAtScope(
  role: BindableRole,
  scopeObject: { id: string; typeId: string }
): void {
  if (role.bindableAt === null) return;
  if (role.bindableAt.includes(scopeObject.typeId)) return;
  throw unprocessable(
    `role '${role.name}' cannot be bound at a '${scopeObject.typeId}' object — it binds at ` +
      `${role.bindableAt.map((t) => `'${t}'`).join(", ")}. Scope object: '${scopeObject.id}'.`
  );
}

/** Validates the SUBJECT half of the same unconstrained-uuid property — see
 *  {@link ROLE_BINDING_SUBJECT_TYPES}. GRANT ONLY, for the §4 reason: a binding already written to a
 *  wrong-typed subject must stay revocable. */
export function assertBindableSubject(subject: { id: string; typeId: string }): void {
  if ((ROLE_BINDING_SUBJECT_TYPES as readonly string[]).includes(subject.typeId)) return;
  throw unprocessable(
    `'${subject.id}' is a '${subject.typeId}' object and cannot hold a role binding — a subject is ` +
      `one of ${ROLE_BINDING_SUBJECT_TYPES.map((t) => `'${t}'`).join(", ")}. A binding to anything ` +
      `else can never match a request, because the subject expansion is seeded from the ` +
      `authenticated principal's own graph object.`
  );
}

/**
 * §2'S SUBSET TEST — ONE DEFINITION, THREE CONSUMERS ({@link assertMayWriteRoleBinding} for grant and
 * for revoke, {@link assertMayJoinRoleBearingSubject} for a `member_of` edge).
 *
 * Returns everything in `permissions` that the actor does NOT already hold at `scopeObjectId`, in the
 * order given; the callers sort for the message. Empty means the subset rule is satisfied.
 *
 * **COMPUTED BY RUNNING `hasPermission` ONCE PER PERMISSION — never by reading the actor's own role
 * rows.** That distinction is the whole distance between the correct implementation and the obvious
 * one and it is spelled out at length in §2 above; it is factored out HERE so no second consumer can
 * re-implement it the plausible way. It is pinned by exactly one test — the `member_of`-inherited
 * administrator case in `routes/rbac-role-binding-door.integration.test.ts` — which is the only case
 * a row-reading implementation gets wrong.
 *
 * The `as Permission` cast is deliberate: `roles.permissions` is a plain `text[]` that can hold a
 * string outside today's union (a restored dump, a hand-written row, or a permission a later
 * migration removes — `org:admin` was exactly that), and asking `hasPermission` for such a string is
 * the CORRECT question. It answers "does any binding of yours grant this exact string", which is
 * precisely what a subset test over two string sets needs, and it fails closed for a string nobody
 * holds.
 *
 * The full set is collected rather than short-circuiting on the first miss, so one refusal names
 * everything that is wrong instead of costing the operator a round trip per missing permission.
 */
export async function missingPermissionsFor(
  tx: TenantTx,
  check: {
    orgId: string;
    /** The ACTING principal's graph object — never the subject receiving the authority. */
    actorObjectId: string;
    permissions: readonly string[];
    scopeObjectId: string;
  }
): Promise<string[]> {
  const missing: string[] = [];
  for (const permission of check.permissions) {
    const held = await hasPermission(tx, {
      orgId: check.orgId,
      subjectObjectId: check.actorObjectId,
      permission: permission as Permission,
      scopeObjectId: check.scopeObjectId
    });
    if (!held) missing.push(permission);
  }
  return missing;
}

/** One `allow` role binding a would-be member of a group/team would inherit. */
interface InheritableBinding {
  roleId: string;
  roleOrgId: string | null;
  roleName: string;
  /** `true` when a shared `org_id IS NULL` row of the same NAME exists — the quorum-bypass fact
   *  {@link builtInNameCollisionReason} judges. Read off the same join rather than a second query. */
  collidesWithBuiltIn: boolean;
  permissions: string[];
  scopeObjectId: string;
}

/**
 * Every `allow` binding a new member of `groupObjectId` would inherit — the group's own bindings PLUS
 * those of every group/team the group is itself transitively `member_of`.
 *
 * SEEDED AT THE GROUP AND WALKED WITH THE RESOLVER'S OWN FRAGMENT (`subjectExpandCte`), because the
 * question is exactly "what will `hasPermission` see once this edge exists": `subject_expand` seeded
 * at the JOINER will, after the write, contain the group and everything above it. Composing the
 * fragment rather than re-typing the walk is what keeps this answer and the resolver's answer from
 * drifting — a nested-membership case the resolver reaches and this walk did not would be an
 * escalation the guard reports as clean.
 *
 * `effect = 'allow'` ONLY, and that is a rule about direction rather than an omission. Inheriting a
 * `deny` row NARROWS the joiner — deny-override beats every allow at any matching scope — so it
 * confers nothing and gating it would refuse a membership on the grounds that it takes authority
 * away.
 */
async function inheritableBindingsOf(
  tx: TenantTx,
  orgId: string,
  groupObjectId: string
): Promise<InheritableBinding[]> {
  const result = await tx.execute<{
    role_id: string;
    role_org_id: string | null;
    role_name: string;
    collides_with_builtin: boolean;
    permissions: string[];
    scope_object_id: string;
  }>(sql`
    WITH RECURSIVE ${subjectExpandCte(orgId, groupObjectId)}
    SELECT DISTINCT rl.id AS role_id, rl.org_id AS role_org_id, rl.name AS role_name,
           EXISTS (
             SELECT 1 FROM roles b WHERE b.org_id IS NULL AND b.name = rl.name
           ) AS collides_with_builtin,
           rl.permissions, rb.scope_object_id
    FROM role_bindings rb
    JOIN roles rl ON rl.id = rb.role_id
    WHERE rb.org_id = ${orgId}
      AND rb.effect = 'allow'
      AND rb.subject_id IN (SELECT subject_id FROM subject_expand)
  `);
  return result.rows.map((row) => ({
    roleId: row.role_id,
    roleOrgId: row.role_org_id,
    roleName: row.role_name,
    collidesWithBuiltIn: row.collides_with_builtin,
    permissions: row.permissions,
    scopeObjectId: row.scope_object_id
  }));
}

/**
 * §2a — the subset rule applied to CREATING a `member_of` edge. See §2a of docs/authz/role-binding-door.md for the
 * measured exploit chain, the choke-point placement and the two things this deliberately does not do.
 *
 * Called from `graph/relationships-repo.ts`'s `createRelationship`, under that file's existing
 * `federationImport` carve-out. Costs ONE query when the target group holds no bindings, which is
 * the common case — every ordinary team membership on the estate.
 *
 * TAKES §0'S ORG LOCK ITSELF rather than asking its caller to, and that is not symmetry with the two
 * route handlers — it is because `createRelationship` has thirteen call sites (IaC apply, discovery
 * accept, the seed, six repos) and a guard at a choke point that needs a caller to remember
 * something is a guard with a door beside it.
 *
 * ⚠️ **CORRECTED 2026-08-27. This paragraph used to end "Nothing is read before the lock here", and
 * that is the opposite of what the code does.** By the time `createRelationship` reaches this call it
 * has already read the `relationship_types` row, BOTH endpoint objects (`requireLiveObject` twice),
 * the `contains` admissibility walk where applicable — and, on the governance-labels guard two blocks
 * above, `role_bindings` itself, through a full `hasPermission` probe. The transaction is not
 * lock-clean when this runs.
 *
 * WHAT IS ACTUALLY TRUE, which is the narrower claim §0's rule needs: every read whose VALUE THIS
 * GUARD'S VERDICT DEPENDS ON — {@link inheritableBindingsOf}'s join over `role_bindings`/`roles`,
 * {@link missingPermissionsFor}'s `hasPermission` probes, and {@link principalsReachedBy}'s
 * membership walk — happens strictly AFTER the lock, because the lock is this function's first
 * statement. The earlier reads feed OTHER decisions (does the type exist, are the endpoints live, may
 * you write these labels) and none of them is re-consulted here. They carry the ordinary
 * unsynchronized-`authorize()` property every one of this codebase's ~170 enforcement sites has, and
 * closing that is not §0's claim and is not this guard's job.
 *
 * Throws 403 naming, per inherited binding, the role, its scope and the permissions the actor lacks
 * there; or 422 when the JOINING subject's own membership closure holds a principal §2b refuses to
 * bind. Never returns false, for {@link assertMayWriteRoleBinding}'s reason: a boolean would invite
 * a caller to fall through it.
 */
export async function assertMayJoinRoleBearingSubject(
  tx: TenantTx,
  check: {
    orgId: string;
    /** The ACTING principal's graph object — the one writing the edge, not the one joining. */
    actorObjectId: string;
    /** `member_of`.from — the principal (or nested group) that would inherit the authority. */
    joinerObjectId: string;
    /** `member_of`.to — the group/team whose bindings would be inherited. */
    groupObjectId: string;
  }
): Promise<void> {
  // §0 — BEFORE THE READ BELOW, not after it. Without this, a concurrent `POST /role-bindings`
  // writing a binding onto this very group commits between this read and this transaction's insert,
  // and the join is admitted against a group that holds authority the actor does not — a pair of
  // requests whose every SERIAL order refuses one of the two, admitted twice. Measured; pinned by
  // the concurrent join-vs-grant case in `routes/rbac-role-binding-door.integration.test.ts`.
  await lockOrgRoleAuthority(tx, check.orgId);

  const inheritable = await inheritableBindingsOf(tx, check.orgId, check.groupObjectId);
  if (inheritable.length === 0) return;

  // THE ROLE-NAME HALF, BEFORE THE PERMISSION HALF. A zero-permission org row named 'Approver' is
  // vacuously a subset of everything, so the loop below cannot see it — and what it confers is
  // quorum eligibility, not a permission. Same predicate the grant door refuses on, one definition.
  for (const binding of inheritable) {
    const collision = builtInNameCollisionReason({
      id: binding.roleId,
      orgId: binding.roleOrgId,
      name: binding.roleName,
      collidesWithBuiltIn: binding.collidesWithBuiltIn
    });
    if (collision) {
      throw forbidden(
        `subject '${check.actorObjectId}' may not add '${check.joinerObjectId}' to ` +
          `'${check.groupObjectId}': that group holds a binding this door would refuse to write. ` +
          collision
      );
    }
  }

  const refusals: string[] = [];
  // One subset test per (role, scope) pair. Two bindings of the same role at the same scope — which
  // `role_bindings_grant_key` makes impossible for a single subject but not across the group chain —
  // ask an identical question, and asking it twice would name the same permissions twice.
  const asked = new Set<string>();
  for (const binding of inheritable) {
    const key = `${binding.roleName}@${binding.scopeObjectId}`;
    if (asked.has(key)) continue;
    asked.add(key);
    const missing = await missingPermissionsFor(tx, {
      orgId: check.orgId,
      actorObjectId: check.actorObjectId,
      permissions: binding.permissions,
      scopeObjectId: binding.scopeObjectId
    });
    if (missing.length > 0) {
      refusals.push(
        `'${binding.roleName}' at scope '${binding.scopeObjectId}' (missing ` +
          `${[...missing].sort().join(", ")})`
      );
    }
  }

  if (refusals.length > 0) {
    throw forbidden(
      `subject '${check.actorObjectId}' may not add '${check.joinerObjectId}' to ` +
        `'${check.groupObjectId}': that group holds ${refusals.length} role binding(s) whose ` +
        `authority the subject does not itself hold — ${refusals.sort().join("; ")}. Joining a ` +
        `role-bearing group IS a grant of that role's authority, because RBAC resolves a group's ` +
        `bindings for every member, so it clears the same no-escalation subset rule as ` +
        `POST /role-bindings.`
    );
  }

  // §2b'S REFUSALS, ON THIS PATH. Everything below the JOINER inherits the target group's bindings
  // too, and a direct `POST /role-bindings` naming the joiner would refuse on exactly these two
  // shapes. LAST, after the authority test above, because this message names other rows' ids — the
  // ordering rule §2b's own placement establishes. The seed row is included on purpose (see the
  // docblock): `from_types` is a widenable `text[]`, so the joiner's own type is re-judged here
  // against the set that can actually hold a binding.
  const reachedByJoiner = await principalsReachedBy(tx, check.orgId, check.joinerObjectId);
  const bad = unbindablePrincipalReasons(reachedByJoiner);
  if (bad.length > 0) {
    throw unprocessable(
      `'${check.joinerObjectId}' cannot be added to '${check.groupObjectId}': that group holds ` +
        `${inheritable.length} role binding(s), so this membership grants their authority to every ` +
        `principal that reaches '${check.joinerObjectId}' through 'member_of' — and ${bad.length} ` +
        `of them ${bad.length === 1 ? "is" : "are"} one the role-binding door refuses to bind ` +
        `directly — ${[...bad].sort().join("; ")}. A soft-deleted principal still resolves through ` +
        `a group (the permission walk joins 'relationships.deleted_at', never ` +
        `'objects.deleted_at'), so this join would confer authority a grant naming that principal ` +
        `would be refused. Clean the membership up, then join.`
    );
  }
}

/** One principal a binding on a group/team would reach. `depth` 0 is the group itself. */
export interface ReachedPrincipal {
  id: string;
  typeId: string;
  name: string | null;
  deleted: boolean;
  /**
   * §7's CREDENTIAL ANCHOR — `true` when a row in `users` for THIS org carries
   * `object_id = <this object>`. That is not "is a person": it is the exact and only condition under
   * which this graph object can ever be the `subjectObjectId` of an authenticated request. See
   * {@link principalsReachedBy} for the census behind that claim.
   *
   * Read off the SAME walk as `deleted`, for the same reason: two queries can disagree about a
   * concurrent write, and this fact and the liveness fact are judged together in one predicate.
   */
  credentialed: boolean;
  depth: number;
}

/**
 * Every object {@link memberExpandCte} reaches from `subjectObjectId`, with the liveness, type and
 * CREDENTIAL facts §2b and §7 judge — read from `objects` and `users`, the two joins `hasPermission`
 * deliberately does NOT make (which is the whole reason a tombstoned principal keeps resolving, and
 * the whole reason a graph object with no login resolves at all).
 *
 * ------------------------------------------------------------------------------------------------
 * WHY `users.object_id` IS THE ANCHOR — the census, not an assumption
 * ------------------------------------------------------------------------------------------------
 * `credentialed` exists because §7's predicate counted GRAPH OBJECTS OF A PRINCIPAL TYPE, and a
 * `user` graph object is not a principal that can authenticate. MEASURED, three plain sequential
 * requests with no privilege beyond the bootstrap admin's and no concurrency:
 *
 *   POST /api/v1/objects/user {"name":"phantom"}                    -> 201  (no `users` row)
 *   POST /api/v1/role-bindings {phantom, Owner, org root}           -> 201  (D7 exempts a `user`)
 *   DELETE /api/v1/role-bindings/<the bootstrap admin's own>        -> 200  ** ORG BRICKED **
 *   GET /api/v1/roles                                               -> 403, recovery is raw SQL
 *
 * FILTERLESS CENSUS OF EVERY WAY AN `AuthContext` IS PRODUCED (`grep -rna` over `apps/server/src`,
 * NUL-byte files included): `auth/require-auth.ts`'s `requireAuth` is the ONE seam, and it has
 * exactly two branches — `auth/pat.ts`'s `verifyPat` and `auth/local-auth.ts`'s `verifyToken`. Both
 * end at `resolveAuthContext(db, userId)`, which reads a `users` row and returns
 * `subjectObjectId = user.objectId`, refusing when that column is NULL. The four credential kinds
 * feed that same funnel and none of them adds a fifth: a password login (`login()`), an OIDC login
 * (`auth/oidc.ts`, which INSERTs a `users` row before it can issue anything), a PAT
 * (`personal_access_tokens.user_id` -> `users.id`) and the device flow (`auth/device-flow.ts`
 * mints a session for an already-authenticated `users.id`). **No `users` row for an object => that
 * object can never be the actor of any request at any door.**
 *
 * SO THE ANCHOR IS TYPE-BLIND, ON PURPOSE, AND THAT IS WHAT KEEPS A SERVICE ACCOUNT COUNTING.
 * `resolveAuthContext` reads no `type_id` and neither does anything below it: a `users` row whose
 * `object_id` names a `service-account` object authenticates and resolves RBAC exactly like one
 * naming a `user`. **MEASURED, and it is the answer to "a service account has its own shape":
 * IT DOES NOT.** `POST /api/v1/service-accounts` (a plain typed registry, `routes/typed-registries.ts`)
 * creates the graph object and nothing else — there is no service-account token table, no
 * service-account row anywhere but `objects`, and `personal_access_tokens` is keyed on `users.id`.
 * A service account becomes able to present a token by acquiring a `users` row pointing at it, and
 * by no other route. Anchoring on the credential therefore counts a REAL service-account
 * administrator and refuses a PHANTOM one, from one predicate, with no type special-case — which is
 * the mirror-image failure a `type_id = 'user'`-only anchor would have walked straight into.
 *
 * `u.org_id = ${orgId}` IS LOAD-BEARING AND IS NOT DECORATION. `users` is auth substrate and carries
 * NO ROW-LEVEL SECURITY (drizzle/0002 §1 grants `scp_app` SELECT on it and never enables RLS), so
 * unlike every `objects`/`relationships` read in this module the tenant boundary here is this
 * predicate and only this predicate. Without it a `users` row in ANOTHER org whose `object_id`
 * happened to collide would count as this org's administrator — and `users.object_id` has no
 * FOREIGN KEY and no unique constraint (`db/schema.ts`), so such a row is a plain INSERT rather than
 * a database-refused impossibility.
 *
 * **PINNED, 2026-08-27 — it was not.** The delivered suite could not see this predicate at all,
 * because `users.object_id` values do not collide across orgs by accident, so a census by SYMPTOM
 * ("what fails if I drop it") returned nothing. `routes/rbac-administrative-floor.integration.test.ts`
 * now builds the collision on purpose — a `users` row in org B naming org A's PHANTOM object — and
 * asserts org A is still refused its floor-emptying revoke. Dropping this predicate makes that org
 * administrable by a credential that belongs to a different tenant, and the case goes red.
 *
 * LEFT JOIN rather than `EXISTS`, and the GROUP BY carries the derived boolean: `users.object_id`
 * has no unique constraint (and no foreign key), so two rows may name one object; grouping on the
 * boolean collapses that pair without changing the answer.
 *
 * The seed row is included (`depth = 0`), so a caller asking about a `user` subject gets that user
 * back and needs no special case; §2b filters to `depth > 0` because the seed is the group whose
 * own type the route has already checked.
 */
export async function principalsReachedBy(
  tx: TenantTx,
  orgId: string,
  subjectObjectId: string
): Promise<ReachedPrincipal[]> {
  const result = await tx.execute<{
    id: string;
    type_id: string;
    name: string | null;
    deleted: boolean;
    credentialed: boolean;
    depth: number;
  }>(sql`
    WITH RECURSIVE ${memberExpandCte(orgId, subjectObjectId)}
    SELECT o.id, o.type_id, o.name,
           (o.deleted_at IS NOT NULL) AS deleted,
           (u.object_id IS NOT NULL) AS credentialed,
           min(me.depth) AS depth
    FROM member_expand me
    JOIN objects o ON o.id = me.member_id AND o.org_id = ${orgId}
    LEFT JOIN users u ON u.object_id = o.id AND u.org_id = ${orgId}
    GROUP BY o.id, o.type_id, o.name, (o.deleted_at IS NOT NULL), (u.object_id IS NOT NULL)
  `);
  return result.rows.map((row) => ({
    id: row.id,
    typeId: row.type_id,
    name: row.name,
    deleted: row.deleted,
    credentialed: row.credentialed,
    depth: Number(row.depth)
  }));
}

/**
 * §2d — THE PREVIEW'S PROJECTION FILTER. Of `candidateIds`, the ones `readerObjectId` could fetch
 * individually with `GET /api/v1/objects/{type}/{idOrUrn}`.
 *
 * WHY THIS EXISTS AT ALL. `GET /role-bindings/grant-preview` is authorized AT THE SUBJECT, which
 * settles who may ask about a group and settles nothing about what may come back — **the principals
 * it discloses are not the subject**. A `member_of` member is a separate graph object with its own
 * containment chain, and `authz/resolve.ts`'s scope walk expands UPWARD only, so a Viewer bound at a
 * TEAM reaches that team and reaches nothing through it. MEASURED on that fixture: a **200** carrying
 * a member's `id`, `typeId` and `name` to a token whose own `GET /objects/user/{that id}` answers
 * **403**. See §2d of `packages/schemas/src/rbac.ts`'s `GrantPreviewResponseSchema` for the trade the
 * withheld COUNT makes and for why D7 still works.
 *
 * **COMPOSED FROM `authz/readable-scope.ts`, NOT RE-DERIVED, AND NOT A `hasPermission` LOOP.**
 * `readableRootsFor` + `partitionReadableRoots` + `readableObjectFilterSql` is this tree's one
 * definition of "which objects may this subject `object:read`" — the exact downward inverse of the
 * upward walk `authorize()` runs, with the `effect = 'allow'` string comparison, the deny
 * subtraction and the shared depth bound already right, and with `authz/inverse-walk-drift
 * .integration.test.ts` standing over the two directions as a drift detector. A per-principal
 * `hasPermission` loop would be a fifth hand-synced copy of the same idea AND would cost one
 * recursive CTE per member (5,000 of them at the acknowledgement's bound); this costs one query for
 * the roots, plus one intersect, plus NOTHING AT ALL in the common case — an org-root `object:read`
 * holder short-circuits to `null` before the second query is built.
 *
 * ⚠️ **ONE DIVERGENCE FROM `hasPermission`, INHERITED AND DELIBERATE.** `readableObjectFilterSql`
 * returns `null` ("everything") for a subject holding an org-root allow even when a `deny` sits
 * lower down, because `authz/org-root-arm.ts`'s doctrine is that the org-root arm is evaluated first
 * and never consults such a deny. So this can report an object readable that `hasPermission` called
 * in ISOLATION at that object would refuse. That is not a widening of what the caller can see: the
 * LIST doors already hand that org-root holder those rows (`readableScopeForListDoor` returns the
 * same `null`), so the preview is still disclosing nothing they could not already read — which is
 * the bar, stated in terms of the API surface rather than of one function.
 *
 * `(VALUES (…::uuid), …)` rather than `unnest($1::uuid[])` for `readable-scope.ts`'s measured reason:
 * drizzle's `sql` tag expands an array interpolation into a parenthesised parameter LIST that will
 * not cast. Every id is bound as its own parameter and none is concatenated into SQL text.
 */
export async function readableSubsetOf(
  tx: TenantTx,
  orgId: string,
  readerObjectId: string,
  candidateIds: readonly string[]
): Promise<Set<string>> {
  if (candidateIds.length === 0) return new Set();
  const { allowRoots, denyRoots } = partitionReadableRoots(
    await readableRootsFor(tx, {
      orgId,
      subjectObjectId: readerObjectId,
      permission: "object:read"
    })
  );
  const filter = readableObjectFilterSql(orgId, allowRoots, denyRoots);
  // `null` means NO FILTER and is the OPPOSITE of an empty set — mapping it onto `[]` here would
  // withhold every principal from every org-root reader, i.e. from exactly the caller D7 is for.
  if (filter === null) return new Set(candidateIds);
  const values = sql.join(
    candidateIds.map((id) => sql`(${id}::uuid)`),
    sql`, `
  );
  const result = await tx.execute<{ id: string }>(sql`
    SELECT c.id FROM (VALUES ${values}) AS c(id) WHERE c.id IN ${filter}
  `);
  return new Set(result.rows.map((row) => row.id));
}

/**
 * §2b — the grant door's half of the group symmetry. GRANT ONLY, for §4's reason: a binding already
 * written over a bad membership must stay revocable, and revoking it is the remedy this refusal
 * points at.
 *
 * See §2b of docs/authz/role-binding-door.md for the measured ordering, for the direction of the walk, and — most
 * importantly — for the measurement showing why this checks the membership's SHAPE rather than the
 * members' standing: no authority bar on this door reads the subject's identity, so a standing-based
 * guard here admits every request and would be a refusal that can never fire.
 *
 * Costs NOTHING beyond a string comparison unless the subject is a `group` or `team`: the caller
 * makes the ONE membership walk (`principalsReachedBy`) and hands the result to this check and to
 * {@link assertGrantAcknowledgesEmpoweredPrincipals} alike, so the two cannot be given different
 * answers about the same group, and a grant to a `user` or `service-account` — the common case —
 * never walks at all.
 *
 * **THE CALLER MUST HOLD §0'S ORG LOCK** ({@link lockOrgRoleAuthority}) and must have taken it
 * before that walk. The walk reads `relationships`; a concurrent `member_of` write commits into it
 * otherwise, and this refusal is then evaluated against a membership that is already stale by the
 * time the grant lands. `routes/role-bindings.ts`'s POST handler takes it as the first statement of
 * the transaction.
 *
 * **CALLED AFTER THE AUTHORITY BARS, not with the shape refusals** — the 422 below names the
 * principals it refused on, so on the original ordering a caller heading for a 403 read any group's
 * membership out of it. See §2b.
 *
 * `tx` is kept in the signature though nothing in here uses it: this is a door, and every other
 * assert in this module takes the transaction it judges. A synchronous outlier here would be read as
 * "this one is safe to call outside the lock", which is exactly wrong.
 */
export async function assertGrantReachesOnlyBindableMembers(
  _tx: TenantTx,
  check: {
    orgId: string;
    role: BindableRole;
    scopeObjectId: string;
    /** The binding's subject, already resolved live and type-checked by the caller. */
    subject: { id: string; typeId: string };
    /** {@link principalsReachedBy}'s output for `subject`, ALL depths, taken under §0's lock. */
    reached: readonly ReachedPrincipal[];
  }
): Promise<void> {
  if (!subjectTypeNeedsMembershipReview(check.subject.typeId)) return;

  // `depth > 0` — the seed is the group itself, whose own type the route has already checked with
  // {@link assertBindableSubject} and whose liveness `getObjectByIdOrUrnAnyType` has already
  // enforced. (The JOIN path deliberately does NOT filter it out; see §2a's member-shape half.)
  const bad = unbindablePrincipalReasons(check.reached.filter((p) => p.depth > 0));
  if (bad.length === 0) return;

  throw unprocessable(
    `role '${check.role.name}' cannot be bound to '${check.subject.id}' at scope ` +
      `'${check.scopeObjectId}': binding a role to a ${check.subject.typeId} grants it to every ` +
      `principal that reaches it through 'member_of', and ${bad.length} of them ` +
      `${bad.length === 1 ? "is" : "are"} one this door refuses to bind directly — ` +
      `${[...bad].sort().join("; ")}. A soft-deleted principal still resolves through a group ` +
      `(the permission walk joins 'relationships.deleted_at', never 'objects.deleted_at'), so this ` +
      `grant would confer authority the same request naming that principal directly would be ` +
      `refused. Remove the membership, then grant.`
  );
}

/**
 * §2c — D7's acknowledgement. GRANT ONLY: a revoke empowers nobody.
 *
 * Refuses with **409** unless `acknowledgedPrincipalIds` equals, as a SET, the principals this
 * binding would reach — the same `depth > 0` closure {@link assertGrantReachesOnlyBindableMembers}
 * walks, from the same {@link memberExpandCte} definition. Only for a `group`/`team` subject; a
 * grant to a `user` or `service-account` short-circuits on a string comparison and needs no
 * acknowledgement, which is the ruling's "do not burden the common case".
 *
 * **409 AND NOT 422**, deliberately, and it is the same distinction §7 makes: the body is
 * well-formed and the caller's standing is not in question — the request conflicts with the STATE of
 * the org as it stands at this moment. A member who joined between the caller's read and its write
 * is exactly that conflict, and a 409 is what tells a client to re-read and retry rather than to fix
 * its request. The ONE 422 this function throws is the different case: no acknowledgement at all,
 * which IS a malformed request for this subject type and cannot be fixed by retrying the same body.
 *
 * **THE CALLER MUST HOLD §0'S ORG LOCK** ({@link lockOrgRoleAuthority}), taken before its first read.
 * Without it this comparison is against a membership a concurrent `POST /relationships` is already
 * changing, and the acknowledgement would witness a set that was never the set at commit — which is
 * the precise failure the field exists to prevent, one level down.
 *
 * `reached` is passed IN rather than re-walked: `assertGrantReachesOnlyBindableMembers` has already
 * computed it under the same lock in the same statement sequence, and a second walk could return a
 * different answer only if something raced — in which case the two refusals would disagree about the
 * same membership. One walk, two judgements.
 */
export function assertGrantAcknowledgesEmpoweredPrincipals(check: {
  role: BindableRole;
  subject: { id: string; typeId: string };
  /** {@link principalsReachedBy}'s output for the subject, ALL depths. Filtered here. */
  reached: readonly ReachedPrincipal[];
  /** The request field. `undefined` = absent (the caller did not look); `[]` = "I looked and it is
   *  empty", which is a different statement and the only one accepted for an empty group. */
  acknowledgedPrincipalIds: readonly string[] | undefined;
}): void {
  if (!subjectTypeNeedsMembershipReview(check.subject.typeId)) return;

  const empowered = check.reached.filter((p) => p.depth > 0);
  const expected = new Set(empowered.map((p) => p.id));

  if (check.acknowledgedPrincipalIds === undefined) {
    throw unprocessable(
      `binding role '${check.role.name}' to a ${check.subject.typeId} requires ` +
        `'acknowledgedPrincipalIds': the binding grants that role to every principal reached ` +
        `through 'member_of', and the granter must state which principals it believes it is ` +
        `empowering. This ${check.subject.typeId} currently reaches ${expected.size} — read them ` +
        `from GET /api/v1/role-bindings/grant-preview?subjectId=${check.subject.id} and send the ` +
        `'acknowledgedPrincipalIds' it returns. An EMPTY group is acknowledged with an empty ` +
        `array, which is a statement that it empowers nobody today, not an omission.`
    );
  }

  const acknowledged = new Set(check.acknowledgedPrincipalIds);
  const unacknowledged = [...expected].filter((id) => !acknowledged.has(id)).sort();
  const notReached = [...acknowledged].filter((id) => !expected.has(id)).sort();
  if (unacknowledged.length === 0 && notReached.length === 0) return;

  const describe = (id: string): string => {
    const principal = empowered.find((p) => p.id === id);
    return principal
      ? `'${principal.name ?? principal.id}' (${principal.typeId} '${id}')`
      : `'${id}'`;
  };
  const clauses: string[] = [];
  if (unacknowledged.length > 0) {
    clauses.push(
      `${unacknowledged.length} principal(s) this binding WOULD empower are not in the ` +
        `acknowledgement — ${unacknowledged.map(describe).join(", ")}`
    );
  }
  if (notReached.length > 0) {
    clauses.push(
      `${notReached.length} acknowledged id(s) are not reached by this ${check.subject.typeId} — ` +
        `${notReached.map(describe).join(", ")}`
    );
  }

  throw conflict(
    `the acknowledgement does not match the membership of '${check.subject.id}': ` +
      `${clauses.join("; ")}. The membership changed between your read and this write, or the ` +
      `value was not read from this ${check.subject.typeId}. Nothing was granted. Re-read ` +
      `GET /api/v1/role-bindings/grant-preview?subjectId=${check.subject.id} and retry — the ` +
      `point of this field is that a principal joining mid-flight is CAUGHT rather than silently ` +
      `handed role '${check.role.name}'.`
  );
}

/**
 * §7 — THE ADMINISTRATOR FLOOR, as a property of the ORG. **ONE predicate, called from every door
 * that can falsify it**; see §7 of docs/authz/role-binding-door.md for the three measured doors, for why it is
 * evaluated AFTER the write, and for the sound relevance tests each caller applies first.
 *
 * The invariant: *at least one live principal THAT CAN AUTHENTICATE resolves an `effect = 'allow'`
 * role binding, AT THE ORG ROOT, of a role carrying `role_binding:write`* — where "can
 * authenticate" is `users.object_id = <that graph object>` in this org, the single anchor
 * {@link principalsReachedBy} documents and censuses.
 *
 * **CALL IT AFTER THE MUTATION, INSIDE THE MUTATION'S TRANSACTION.** It asks the database what is
 * true now; a refusal throws 409 and the transaction rolls the write back with it. Calling it
 * BEFORE a write makes it a check-then-act that must model the write — which is what produced three
 * disagreeing rules and two live bricking paths.
 *
 * **IT TAKES §0'S ORG LOCK ITSELF.** Its callers are choke points with many callers of their own
 * (`deleteObject`, `deleteRelationship`, the revoke handler), and a guard that needs each of them to
 * remember something is a guard with a door beside it. Taking it after the write is sound and is not
 * an oversight — §0's "THE FLOOR IS AN ACT-THEN-CHECK" paragraph works the ordering through. Taking
 * it twice in a transaction is free.
 *
 * `act` is a caller-supplied phrase naming what was just done, so the 409 an operator reads says
 * which of the three doors refused. It is the only caller-specific thing in here.
 */
export async function assertOrgRetainsAdministrativeFloor(
  tx: TenantTx,
  check: { orgId: string; act: string }
): Promise<void> {
  await lockOrgRoleAuthority(tx, check.orgId);

  // THE CANDIDATE ROWS — candidates, not the answer. Counting these was the first version of this
  // guard and it was bypassable in two requests: a binding on an EMPTY group is a row that resolves
  // for nobody, so `count(*) = 1` reported an administrable org that had none. NO `rb.id <> …`
  // exclusion any more, because this runs after the delete: what survives IS what survives.
  const candidates = await tx.execute<{ subject_id: string }>(sql`
    SELECT DISTINCT rb.subject_id
    FROM role_bindings rb
    JOIN roles rl ON rl.id = rb.role_id
    WHERE rb.org_id = ${check.orgId}
      AND rb.effect = 'allow'
      AND rb.scope_object_id = ${check.orgId}::uuid
      AND 'role_binding:write' = ANY(rl.permissions)
  `);

  // ONE WALK PER SURVIVING SUBJECT, short-circuiting on the first that reaches a live principal.
  // A loop rather than one multi-seeded CTE so it can COMPOSE `memberExpandCte` — the same fragment
  // §2b walks and the inverse of the one `hasPermission` walks — instead of hand-typing a fifth copy
  // of the closure with its own bound and its own cycle behaviour. The candidate set is the org's
  // org-root administrative bindings, so this is a handful of sub-millisecond queries.
  //
  // `p.credentialed` — THE THIRD REVISION OF THIS TEST, and the first two were each bypassable with
  // plain sequential requests. It counted binding ROWS (an EMPTY GROUP satisfied it), then live
  // OBJECTS OF A PRINCIPAL TYPE (a PHANTOM `user` graph object with no `users` row satisfied it, in
  // three requests). The property that has to hold is neither: it is "a principal that CAN
  // AUTHENTICATE and resolves `role_binding:write` at the org root". `credentialed` is that half —
  // `users.object_id`, the single row every authentication path in the system funnels through, with
  // the census in {@link principalsReachedBy}.
  //
  // THERE IS NO TYPE TEST LEFT, DELIBERATELY. `user` / `service-account` was the previous predicate
  // and it is the mirror-image hazard in both directions: it counts a phantom of the right type, and
  // it refuses a real administrator of any other. `resolveAuthContext` reads no `type_id`, so
  // "credentialed" is exactly co-extensive with "can present a token" and the type adds nothing
  // except a way to be wrong. A `service-account` with a `users` row counts here; a `user` object
  // without one does not.
  for (const row of candidates.rows) {
    const reached = await principalsReachedBy(tx, check.orgId, row.subject_id);
    const live = reached.some((p) => !p.deleted && p.credentialed);
    if (live) return;
  }

  throw conflict(
    `${check.act} would leave this organization with no live principal that can AUTHENTICATE ` +
      `holding 'role_binding:write' at the org root. Nobody would be able to write a role binding ` +
      `— including the binding that would put this one back — so every endpoint would refuse every ` +
      `principal and the only recovery would be hand-written SQL. ` +
      `${candidates.rows.length} org-root administrative binding(s) would remain and none of them ` +
      `reaches a live principal with a credential. Three shapes are NOT counted, and each of them ` +
      `is a binding that resolves for nobody who can log in: a binding on an EMPTY group; a ` +
      `binding whose only reachable principals are SOFT-DELETED (those do still resolve — ` +
      `permission resolution never joins 'objects.deleted_at', so soft-deleting a principal ` +
      `revokes nothing today — but the estate has recorded them as removed and this door refuses ` +
      `to write a new binding reaching one); and a binding on a graph object that HAS NO LOGIN, ` +
      `which is any 'user' or 'service-account' object with no row in 'users' naming it. ` +
      `POST /api/v1/objects/user creates a graph object, not an account. Give an org-root role ` +
      `holding 'role_binding:write' to a second principal that can actually sign in, then retry.`
  );
}

/**
 * The REVOKE door's relevance test for {@link assertOrgRetainsAdministrativeFloor} — see §7's
 * "THE RELEVANCE TESTS ARE A COST DECISION AND ARE SOUND".
 *
 * A row that is not an `allow` binding AT the org root of a role carrying `role_binding:write` is
 * not in the floor's candidate set, so deleting it cannot change the floor's answer — it is a
 * statement about the predicate's four inputs, not a guess about callers. A deny row grants nothing;
 * a binding below the org root is not a recovery path (`scopeExpandCte` expands upward only, so its
 * holder cannot write an org-root binding); a role without `role_binding:write` cannot administer.
 */
export function revokeAffectsAdministrativeFloor(
  orgId: string,
  binding: { scopeObjectId: string; effect: string },
  role: BindableRole
): boolean {
  if (binding.effect !== "allow") return false;
  if (binding.scopeObjectId !== orgId) return false;
  return role.permissions.includes("role_binding:write");
}

/**
 * The OBJECT-DELETE door's relevance test — see §7's same paragraph.
 *
 * `true` when tombstoning this object could change the floor's answer: it is the subject of some
 * `role_bindings` row (so it may be a candidate seed), or it has a LIVE `member_of` edge in either
 * direction (so it may be a node of some candidate's closure, and `deleteObject`'s cascade is about
 * to tombstone that edge). An object that is neither is in no closure and is no binding's subject,
 * and its tombstone plus its cascade touch no `member_of` edge at all.
 *
 * **MUST BE READ BEFORE THE TOMBSTONE AND BEFORE THE CASCADE**, because both destroy the evidence
 * this probe reads. `graph/objects-repo.ts` calls it early and carries the boolean to the end of the
 * function; that split is stated at both ends.
 *
 * It reads exactly the two tables the floor reads, which is why it can be trusted to be sound
 * without a second census: any new input to the floor has to be added here too, and that is one
 * place rather than one per door.
 */
export async function objectTouchesRoleAuthority(
  tx: TenantTx,
  orgId: string,
  objectId: string
): Promise<boolean> {
  const result = await tx.execute<{ touches: boolean }>(sql`
    SELECT (
      EXISTS (
        SELECT 1 FROM role_bindings rb
        WHERE rb.org_id = ${orgId} AND rb.subject_id = ${objectId}::uuid
      )
      OR EXISTS (
        SELECT 1 FROM relationships r
        WHERE r.org_id = ${orgId}
          AND r.type_id = 'member_of'
          AND r.deleted_at IS NULL
          AND (r.from_id = ${objectId}::uuid OR r.to_id = ${objectId}::uuid)
      )
    ) AS touches
  `);
  return result.rows[0]?.touches === true;
}

export interface RoleBindingWriteCheck {
  orgId: string;
  /** The ACTING principal's graph object — `auth.subjectObjectId`, never the binding's subject. */
  actorObjectId: string;
  role: BindableRole;
  /** The binding's scope object id. Resolved and liveness-checked by the caller. */
  scopeObjectId: string;
  /** Only shapes the refusal wording; both verbs apply identical bars (§3). */
  verb: "grant" | "revoke";
}

/**
 * The two authority bars — §1 then §2 — applied identically to a grant and a revoke.
 *
 * Order matters for the message, not for the verdict: `role_binding:write` is the coarse "may you
 * administer bindings here at all" question, so failing it first means an operator with no standing
 * whatsoever gets told that, rather than a list of twelve permissions they are also missing.
 *
 * Throws 403 (RFC 9457) and never returns false — every caller's answer to a failed bar is the same
 * refusal, and a boolean here would invite a caller to fall through one.
 *
 * **THE CALLER MUST HOLD §0'S ORG LOCK** ({@link lockOrgRoleAuthority}). Both bars read
 * `role_bindings` through `hasPermission`, so without it a concurrent grant or revoke of the ACTOR'S
 * OWN authority commits between the bar and the write this bar authorised.
 */
export async function assertMayWriteRoleBinding(
  tx: TenantTx,
  check: RoleBindingWriteCheck
): Promise<void> {
  // §1 — at-or-above the binding's scope. `authorize` throws its own 403 naming permission + scope.
  await authorize(tx, {
    orgId: check.orgId,
    subjectObjectId: check.actorObjectId,
    permission: "role_binding:write",
    scopeObjectId: check.scopeObjectId
  });

  // §2 — the subset rule, via the ONE definition {@link missingPermissionsFor}.
  const missing = await missingPermissionsFor(tx, {
    orgId: check.orgId,
    actorObjectId: check.actorObjectId,
    permissions: check.role.permissions,
    scopeObjectId: check.scopeObjectId
  });

  if (missing.length > 0) {
    const verbPhrase = check.verb === "grant" ? "grant" : "revoke a binding of";
    throw forbidden(
      `subject '${check.actorObjectId}' may not ${verbPhrase} role '${check.role.name}' at scope ` +
        `'${check.scopeObjectId}': it carries ${missing.length} permission(s) the subject does not ` +
        `itself hold there — ${[...missing].sort().join(", ")}. A role binding can never confer ` +
        `more authority than the principal writing it already has.`
    );
  }
}

/** §9 — the role-authoring door. See docs/authz/role-binding-door.md §9. */
export async function assertMayAuthorRole(
  tx: TenantTx,
  check: {
    orgId: string;
    actorObjectId: string;
    /** The permission array the role will carry AFTER this write. */
    permissions: readonly string[];
  }
): Promise<void> {
  // BAR 1 — authority to confer authority at all, at the org root.
  if (
    !(await hasPermission(tx, {
      orgId: check.orgId,
      subjectObjectId: check.actorObjectId,
      scopeObjectId: check.orgId,
      permission: "role_binding:write"
    }))
  ) {
    throw forbidden(
      "authoring a role requires 'role_binding:write' at the organization root — a role is an " +
        "org-wide catalogue entry and there is no narrower scope it belongs to"
    );
  }

  // BAR 2 — every permission in the catalogue this system defines. An unknown string renders in
  // `GET /roles` as authority and gates nothing: verbatim the `org:admin` shape the drift gate
  // (`authz/permission-drift.integration.test.ts`) exists to stop recurring, except authored
  // through the API rather than a migration.
  const known = new Set<string>(PERMISSIONS);
  const unknown = [...new Set(check.permissions.filter((p) => !known.has(p)))].sort();
  if (unknown.length > 0) {
    throw unprocessable(
      `unknown ${unknown.length === 1 ? "permission" : "permissions"}: ` +
        `${unknown.map((u) => `'${u}'`).join(", ")}. A role may only carry permissions this ` +
        `system defines, or it would advertise authority in GET /roles while gating nothing.`
    );
  }

  // BAR 3 — the no-escalation subset rule, composing the SAME helper the binding door and the
  // `member_of` choke point use, so there is one definition of "a subset".
  const missing = await missingPermissionsFor(tx, {
    orgId: check.orgId,
    actorObjectId: check.actorObjectId,
    permissions: check.permissions,
    scopeObjectId: check.orgId
  });
  if (missing.length > 0) {
    throw forbidden(
      `a role may not carry permissions you do not hold at the organization root: ` +
        `${missing.map((m) => `'${m}'`).join(", ")}. Authoring one would not grant it — the ` +
        `binding door re-checks — but it would make the roles catalogue advertise authority its ` +
        `author cannot confer.`
    );
  }
}

/**
 * A custom role may not take a BUILT-IN's name.
 *
 * Refused at authoring because such a row is permanently unbindable anyway:
 * {@link builtInNameCollisionReason} rejects it at the grant door, so allowing it here would let an
 * org create a role it can never use and discover why only at the next grant. The refusal belongs
 * where it is fixable.
 *
 * Not a database constraint: the collision is between the org partition and the built-in partition,
 * which no single unique index can express (drizzle/0103 says so at the index).
 */
export function assertRoleNameNotBuiltIn(name: string, builtInNames: ReadonlySet<string>): void {
  if (builtInNames.has(name)) {
    throw conflict(
      `'${name}' is a built-in role name. An org role of that name could never be bound — the ` +
        `grant door refuses a custom role shadowing a built-in — and approval quorums resolve ` +
        `built-in names only, so it would also be silently ineligible to vote. Choose another name.`
    );
  }
}
