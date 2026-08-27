import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { conflict, forbidden, unprocessable } from "../errors.js";
import {
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

/**
 * ================================================================================================
 * THE ROLE-BINDING WRITE DOOR — every refusal, in one place
 * ================================================================================================
 *
 * TWO CALLERS, and the second one is the point of §2a. `routes/role-bindings.ts` is the API surface
 * — grant and revoke. `graph/relationships-repo.ts`'s `createRelationship` is the other: writing a
 * `member_of` edge into a group that HOLDS role bindings hands the joiner that group's authority
 * without a `role_bindings` row ever being written, so the subset rule has to be applied there too or
 * it is a rule with a door beside it. The checks live here rather than inline because all three
 * verbs must apply the SAME authority rule (see §2) and a rule copied into three handlers is a rule
 * that drifts; and because the difference between what a grant refuses and what a revoke refuses is
 * subtle enough that it needs to be stated once, in writing, next to the code.
 *
 * ------------------------------------------------------------------------------------------------
 * §0. THE ORG AUTHORITY LOCK — every check below is a CHECK-THEN-ACT, and a transaction is not
 *     enough to serialize one
 * ------------------------------------------------------------------------------------------------
 * MEASURED, fresh org, two different actors, `Promise.all` of two `DELETE /role-bindings` for the
 * last two org-root administrative bindings, three attempts:
 *
 *   attempt 1 -> [200, 200]   administrative bindings remaining = 0   GET /roles = 403  ** BRICKED **
 *   attempt 2 -> [200, 409]   1 left
 *   attempt 3 -> [409, 200]   1 left
 *
 * Two earlier revisions of this module asserted that could not happen, on the grounds that §7 runs
 * "inside the same `withTenantTx` as the delete". **One transaction is necessary and is not
 * sufficient.** PostgreSQL's default isolation is READ COMMITTED, so each statement takes a fresh
 * snapshot and two concurrent transactions can both read `remaining >= 1`, both pass, and both
 * commit — the classic check-then-act. It is strictly EASIER to hit than the two-sequential-request
 * defect §7's reachable-principal rewrite replaced, because it needs no group and no second grant.
 *
 * THE SAME SHAPE DEFEATS §2a AND §2b. A `member_of` write and a `POST /role-bindings` touch
 * DIFFERENT TABLES and each reads rows the other has not written yet: §2a reads `role_bindings` for
 * a binding the concurrent grant is about to create, §2b reads `relationships` for a membership the
 * concurrent join is about to create. Interleaved, neither sees the other, and a request pair whose
 * every serial order refuses ONE of the two is admitted twice.
 *
 * {@link lockOrgRoleAuthority} — `pg_advisory_xact_lock(hashtext(org_id))`, transaction-scoped, so
 * it is released on COMMIT **and on ROLLBACK** (a refusal must not strand it).
 *
 * WHY THIS INSTRUMENT AND NOT `SELECT ... FOR UPDATE`. A row lock can only lock rows that EXIST.
 * Both races above are about a row that does not exist yet in the table the other transaction is
 * reading, and PostgreSQL has no predicate locking outside SERIALIZABLE — so `FOR UPDATE` on the
 * candidate administrative bindings would close §7's race (the candidate rows are real) and would be
 * structurally incapable of closing §2a/§2b (the raced rows are not). One instrument that covers
 * both is worth more here than a tighter one that covers one, because the two halves of the same
 * rule disagreeing about a concurrent write is the exact defect §2b exists to close, re-introduced
 * one level down. A partial unique index cannot express the floor either: "at least one surviving
 * row that some live principal reaches through `member_of`" is a closure over two other tables.
 *
 * WHY *THIS* KEY — the same one `audit/audit-repo.ts` takes. Deliberately not a new key. Every
 * audited transaction already takes `pg_advisory_xact_lock(hashtext(orgId))` at its first
 * `appendAuditEvent` and holds it to COMMIT; a SECOND per-org key would be acquired in one order by
 * these doors (authority, then audit) and in the other by any transaction that audits before writing
 * a `member_of` edge — an IaC apply replaying a manifest diff does exactly that — which is a
 * deadlock. One key per org has no ordering to get wrong. Two acquisitions in one transaction are
 * free (the lock is counted per transaction, so re-taking never blocks on itself).
 *
 * COST, and it is real: role-binding writes and `member_of` writes now serialize per ORG against
 * each other AND against every audited write in that org, for the remainder of the transaction
 * rather than from its first audit append. On these doors that adds the duration of the checks —
 * `hasPermission` probes measured well under a millisecond each on role-model.md §8's estate — to a
 * hold every audited transaction in the org already pays. It is NOT free on a long transaction that
 * writes many `member_of` edges (an IaC apply), which already held this lock from its first audited
 * operation anyway.
 *
 * WHERE IT IS TAKEN. `routes/role-bindings.ts`'s POST and DELETE handlers take it as the FIRST
 * statement of their transaction — before `getRoleBindingById` and `getRoleById`, because a read
 * taken before the lock is a read that can be stale. {@link assertMayJoinRoleBearingSubject} and
 * {@link assertOrgRetainsAdministrativeFloor} take it THEMSELVES, because their callers are choke
 * points (`createRelationship` has thirteen callers, `deleteObject` and `deleteRelationship` a
 * dozen between them) and a guard that needs its caller to remember something is a guard with a door
 * beside it. The functions that read authority state under someone else's lock
 * ({@link assertGrantReachesOnlyBindableMembers}, {@link assertGrantAcknowledgesEmpoweredPrincipals},
 * {@link assertMayWriteRoleBinding}) say so at each signature; they do not re-take it, and a new
 * caller of any of them has to take it.
 *
 * **THE FLOOR IS AN ACT-THEN-CHECK, NOT A CHECK-THEN-ACT, AND THE LOCK IS STILL WHAT MAKES IT
 * SOUND.** Its write lands before the lock is taken (the tombstone, then the check). Two concurrent
 * transactions each removing a different last-but-one administrator therefore each perform their
 * write invisibly to the other — but the lock serializes the CHECKS, and a check sees every
 * COMMITTED write before it: T1 takes the lock, still sees T2's un-committed row as live, passes,
 * commits and releases; T2 then acquires the lock, sees T1's committed removal, and refuses. Exactly
 * one of the pair survives, which is the same outcome as a serial execution. No new lock ORDER is
 * introduced, because the key is audit-repo's and `deleteObject`/`deleteRelationship` already take
 * it at their first `appendAuditEvent`.
 *
 * ------------------------------------------------------------------------------------------------
 * §1. `role_binding:write` AT-OR-ABOVE THE BINDING'S SCOPE — necessary, and NOT sufficient
 * ------------------------------------------------------------------------------------------------
 * `authz/resolve.ts`'s `scopeExpandCte` expands UPWARD from the object being checked, so demanding
 * the permission AT the binding's own scope object is exactly "at-or-above": an org-root holder
 * matches because the org root is on the scope's ancestor chain, a service-scoped holder matches for
 * scopes beneath that service, and nobody else matches.
 *
 * On its own this is an escalation door. An org-root `role_binding:write` holder — Administrator,
 * OrgAdmin — passes it for every scope in the org, including the org root, and could therefore mint
 * themselves an Owner binding and hold every permission in the system by lunchtime. §2 is what stops
 * that, and §2 is the single most important thing in this module.
 *
 * ------------------------------------------------------------------------------------------------
 * §2. THE NO-ESCALATION SUBSET RULE
 * ------------------------------------------------------------------------------------------------
 * A binding may be written only if EVERY permission the granted role carries is one the acting
 * subject ALREADY HOLDS, at that same scope. You cannot hand out authority you do not have.
 *
 * **COMPUTED BY RUNNING `hasPermission` ONCE PER MEMBER OF THE TARGET ROLE'S ARRAY — never by
 * reading the actor's own role rows.** That is not an optimisation preference, it is the difference
 * between a correct answer and a wrong one in BOTH directions:
 *
 *   - a subject may hold SEVERAL bindings whose union covers the target role while no single role
 *     row does, so reading rows and comparing one array against another refuses grants that are
 *     legitimate;
 *   - a subject's authority may be INHERITED THROUGH `member_of` — `hasPermission`'s `subject_expand`
 *     walks the group/team chain — and a query over `role_bindings WHERE subject_id = <the actor>`
 *     sees none of it, so it refuses a group-derived administrator entirely;
 *   - and the scope half is invisible to a row read too: a role row says nothing about WHERE it is
 *     bound, so "OrgAdmin at some other service" would read as authority here.
 *
 * It is also this repo's standing rule (CLAUDE.md, [[provenance-labels-read-not-inferred]]): read
 * the resolved answer, do not infer it from which row matched. `hasPermission` IS the resolved
 * answer — it is the same function every other door in the system is judged by, so a grant can never
 * confer something the resolver would not have admitted.
 *
 * WHAT IT BUYS, CONCRETELY. OrgAdmin can grant ServiceAdmin, ComponentAdmin and FederationAdmin
 * (proper subsets of its own set) and CANNOT grant Owner or SecurityOfficer — SecurityOfficer holds
 * `scan:override`, which OrgAdmin deliberately lacks, and that withholding is the separation of duty
 * the whole design is built around (role-model.md ruling D3). The rule turns "OrgAdmin is weaker
 * than Owner" from a table in a document into something the API enforces.
 *
 * ⚠️ **THIS SECTION IS NOT THE WHOLE RULE.** What §2 checks is one request in isolation: the actor's
 * permissions against the role named in THIS body, at the scope named in THIS body. It says nothing
 * about the other two ways a role reaches a principal — a `member_of` edge written into a
 * role-bearing group (§2a), and a binding written onto a group somebody has already joined (§2b).
 * Those are separate doors with separate sections. **This section is not a statement about the
 * system; do not restate it as one.** §8 lists the paths known to be open across all three.
 *
 * COST. One `hasPermission` per permission on the target role — at most ~20 short recursive-CTE
 * queries, each measured at well under a millisecond on the estate role-model.md §8 benchmarked.
 * This is a human-driven authoring door, not a hot path, and short-circuiting on the first miss
 * would cost the operator a round trip per missing permission; the full set is collected so one
 * refusal names everything that is wrong.
 *
 * ------------------------------------------------------------------------------------------------
 * §2a. THE SAME SUBSET RULE ON A `member_of` EDGE — the door §2 was routed around
 * ------------------------------------------------------------------------------------------------
 * MEASURED, WITH REAL REQUESTS, BEFORE THIS GUARD EXISTED:
 *
 *   step 0  OrgAdmin mints itself Owner                                            -> 403  (§2 holds)
 *   step 1  Owner binds Owner to a GROUP                                           -> 201
 *   step 2  Operator POST /relationships {member_of, from: <self>, to: <group>}    -> 201
 *   step 3  resolve                                                                -> Operator holds Owner
 *
 * `authz/resolve.ts`'s `subject_expand` walks `member_of` from_id -> to_id, so a binding held by a
 * group or team is inherited by its members. Creating that edge takes `relationship:write` at BOTH
 * endpoints (`routes/relationships.ts`) — a check that was designed for exactly this attack and says
 * so in its docblock, but which only constrains a principal whose `relationship:write` is NARROW.
 * Every org-root-bound principal from **Operator** upward holds it for every object in the org, so
 * the escalation floor was Operator: four rungs below Administrator.
 *
 * PRE-EXISTING, MADE ROUTINE BY THIS INCREMENT. The hole is as old as `subject_expand`. What step 5
 * changes is the precondition: it ships `group` and `team` as first-class binding subjects
 * ({@link ROLE_BINDING_SUBJECT_TYPES}), and drizzle/0099's purpose roles exist partly to be bound to
 * teams. "Bind SecurityOfficer to the security team" is both the obvious first operator action and
 * the exploit's setup step; before this door that setup needed hand-written SQL.
 *
 * THE RULE. Joining a role-bearing group IS a grant of that role's authority, so
 * {@link assertMayJoinRoleBearingSubject} demands the SAME subset test the grant door applies:
 * every permission carried by every `allow` binding the joiner would inherit must already be held by
 * the ACTOR at that binding's own scope. It composes {@link missingPermissionsFor} — the identical
 * per-permission `hasPermission` loop §2 uses — rather than restating it, so the two can never
 * disagree about what "a subset" means.
 *
 * AT THE CHOKE POINT, NOT AT THE ROUTE. It is called from `graph/relationships-repo.ts`'s
 * `createRelationship`, which is where an edge is actually created, so IaC apply
 * (`iac/plans-repo.ts` replays a manifest diff's free-form `typeId`) and discovery-accept
 * (`routes/executors.ts`) inherit it. A route-only version would be invisible to both — the exact
 * failure the campaign-deadline fix in this same programme paid for twice before it was moved to
 * `updateObject`.
 *
 * THE FEDERATION-IMPORT CARVE-OUT, taken with the mechanism already in that file. The call is
 * wrapped in `if (!input.federationImport)`, byte-identical in shape to the one
 * `assertMayWriteGovernanceLabels` takes two guards above it and to `assertValidCampaignRecipe`'s in
 * `graph/objects-repo.ts`. `federation/import-repo.ts`'s replay branch has no per-entry try/catch
 * for anything but a 400, so a 403 there would abort a peer's WHOLE signed bundle rather than one
 * edge. A replicated membership is the authoring domain's decision, already made under that domain's
 * own door.
 *
 * THE ROLE-**NAME** HALF, added 2026-08-27 with §2b — AND WHAT IT COVERS IS NARROWER THAN AN EARLIER
 * REVISION OF THIS PARAGRAPH CLAIMED. That revision ended "for BUILT-IN roles name and permissions
 * travel together, so the permission subset test is exactly what §2 would have allowed and no name
 * check is added there", which reads as the whole story and is not.
 *
 * THE PROPERTY. `hasRoleAtScope` (`authz/resolve.ts`) is a SEPARATE query from `hasPermission` and
 * matches `rl.name` against the name a policy asked for — `requireApprovals.fromRole: "Approver"`.
 * So a role confers TWO things: its permission array, and quorum eligibility wherever a policy names
 * it. The second is a property of the NAME, is independent of the permissions, and a
 * permissions-subset test cannot see it — for ANY role, built-in or not.
 *
 * WHAT IS CHECKED HERE: exactly one shape — an **org-defined** row (`org_id` non-NULL) whose name
 * collides with a **built-in** role name ({@link builtInNameCollisionReason}, one definition, also
 * applied by {@link assertRoleAcceptsNewBindings} on the grant door). That shape is singled out
 * because the permissions test is VACUOUS against it: a zero-permission row is a subset of
 * everything, so the loop below returns `[]` and the row's whole danger — its name — goes unread.
 *
 * WHAT IS NOT CHECKED, MEASURED rather than reasoned about (see the "role NAME authority" case in
 * `routes/rbac-role-binding-door.integration.test.ts`): **name authority in general.** An actor
 * whose permissions are a strict superset of role R's may grant R, or admit a join that inherits R,
 * while holding no binding of role NAME R at that scope — so it can seat a quorum voter for every
 * policy naming R without being an eligible voter itself. OrgAdmin ⊃ Approver by permissions and
 * OrgAdmin is not an Approver: measured, admitted, and the grantee resolves `hasRoleAtScope`
 * 'Approver' where the granter does not.
 *
 * WHY IT IS RECORDED RATHER THAN CLOSED. The obvious bar — "the actor must itself hold role NAME R
 * at that scope" — refuses OrgAdmin granting ServiceAdmin and ComponentAdmin, which is the
 * delegation role-model.md §3 is built around, so it deletes the feature. Any narrower rule (gate
 * only names some live policy references; gate only `approval:write`-bearing roles) picks which
 * delegations survive, which is an owner ruling and not a comment's to make. Listed in §8.
 *
 * THE MEMBER-SHAPE HALF, added 2026-08-27 — §2b's REFUSALS, ON THE JOIN PATH. §2a as first shipped
 * asked only about the ACTOR: does the actor hold what the joiner would inherit. That is the whole
 * question when the joiner is a `user`, and it is HALF the question when the joiner is a GROUP,
 * because nesting group G into empowered team T empowers everything inside G — and §2b's two
 * subject-shaped refusals (a soft-deleted principal; an object whose type cannot hold a binding)
 * were never applied to them. MEASURED: a direct `POST /role-bindings` naming G is refused when G
 * holds a tombstoned member; `POST /relationships {member_of, G -> T}` where T already holds the
 * binding produced the same end state and was a 201.
 *
 * So the join now runs {@link unbindablePrincipalReasons} — the ONE definition §2b refuses on — over
 * {@link principalsReachedBy} seeded at the JOINER. The seed row (depth 0, the joiner itself) is
 * INCLUDED: `requireLiveObject` and `relationship_types.from_types` already cover it for a local
 * write, but `from_types` is plain `text[]` writable through `POST /type-registry/relationship-types`,
 * which is the same registry-widening population §2b's type arm guards against, and including depth 0
 * costs nothing on a walk that is already being made.
 *
 * IT RUNS LAST, AFTER THE PERMISSION SUBSET TEST, for §2b's disclosure reason: its message names the
 * ids, names and types of principals inside the joining group, and an actor who fails the subset rule
 * must get that 403 and nothing else.
 *
 * ONLY WHEN THE TARGET GROUP HOLDS BINDINGS. The function has already returned by then if it does
 * not, so every ordinary team membership on the estate still costs exactly one query.
 *
 * WHAT IT DOES *NOT* DO, stated because both are real:
 *
 *   - **REMOVAL IS UNTOUCHED** by §2a. `deleteRelationship` carries no subset check and must not:
 *     removing a principal from a group takes authority AWAY. Gating a narrowing on holding the
 *     authority being narrowed is how a compromised membership becomes unremovable. (It DOES carry
 *     §7's availability floor, which is a different question — not "may you narrow this" but "is
 *     there anybody left" — and it refuses only the removal that empties the org.)
 *   - **BAR §1 IS NOT APPLIED HERE — only the subset rule.** An actor who holds everything the
 *     group's bindings carry may add a THIRD party to that group even without `role_binding:write`,
 *     and could not have granted the same authority directly through `POST /role-bindings`. That is
 *     a delegation the actor is not authorised for, though never an ELEVATION of the actor. It is
 *     left open deliberately: demanding `role_binding:write` on every `member_of` write would turn
 *     ordinary team-membership management into a role-administration privilege for any group that
 *     holds a binding, which is a far wider narrowing than the escalation this closes and has no
 *     owner ruling behind it. Recorded here so the next reader finds it named rather than missing.
 *
 * ------------------------------------------------------------------------------------------------
 * §2b. THE OTHER ORDERING — a binding written ONTO a group somebody already joined
 * ------------------------------------------------------------------------------------------------
 * §2a guards the JOIN. It is one of two orderings, and the other one reaches the same end state:
 *
 *   step 1  Operator: POST /relationships {member_of, self -> an EMPTY team}   -> 201
 *   step 2  Owner:    POST /role-bindings {subjectId: <that team>, role Owner} -> 201
 *   step 3  the Operator resolves as Owner
 *
 * MEASURED, and step 1 must stay a 201 — it is the case
 * `routes/rbac-role-binding-door.integration.test.ts` pins as "joining a group that holds NO role
 * bindings is unaffected", and it is every ordinary team membership on the estate.
 *
 * **WHAT THAT CHAIN IS AND IS NOT, measured rather than asserted.** It is NOT a privilege escalation
 * by the Operator, and the reason is worth writing down because the obvious guard for it is vacuous.
 * Step 2 goes through §1 and §2 in full: its actor must hold `role_binding:write` at the org root AND
 * every permission Owner carries there. **Every authority bar on the grant door is a question about
 * the ACTOR and the ROLE and the SCOPE — none of them reads the subject's identity.** So "could the
 * granter have granted this role to that principal directly?" has the same answer for every
 * principal in the org, and a guard phrased that way admits every request it is ever asked about. A
 * refusal that can never fire is worse than no refusal, because it reads as coverage.
 *
 * What the chain IS: a BLIND GRANT. The granter is empowering a membership list somebody else — here,
 * the beneficiary — authored, and the door hands them no way to see it. §2a's own carve-out is why
 * that authorship is cheap: it applies the subset rule and NOT bar §1, so `relationship:write` alone
 * chooses who is in a group that a later binding may make powerful.
 *
 * ORDERED AFTER THE AUTHORITY BARS — corrected 2026-08-27, and the first ordering leaked. §2b was
 * placed with the SHAPE refusals, ahead of `authorize()`, on the reasoning that it IS one. Its 422
 * body NAMES the principals it refused on — ids, names and types — so on that ordering a caller who
 * is about to be 403'd at bar §1 learns the membership of any group in the org by pointing a grant
 * at it. `assertGrantReachesOnlyBindableMembers` now runs after {@link assertMayWriteRoleBinding},
 * so a caller with no standing gets the flat 403 and nothing else.
 *
 * THE SIBLING CONSTRAINT, and the two are now consistent: §7's 409 was ALREADY placed after both
 * bars for exactly this reason — it discloses how many administrators the org has left. A refusal
 * whose BODY is derived from other rows belongs after the authority bars; a refusal derived only
 * from the request and the row it names (D5, `bindable_at`, the subject's own type) does not, and
 * those stay in front so an operator fixing a typo is told about the typo.
 *
 * SO WHAT §2b ACTUALLY CHECKS, and it is deliberately narrow: when the subject of a grant is a
 * `group` or `team`, {@link assertGrantReachesOnlyBindableMembers} walks the membership DOWNWARD and
 * applies the two SUBJECT-shaped refusals a direct grant already applies — the ones that ARE
 * subject-dependent and are therefore the only ones with anything to say here:
 *
 *   - **LIVENESS.** `routes/role-bindings.ts` resolves the subject with `getObjectByIdOrUrnAnyType`,
 *     which refuses a soft-deleted row, so a direct grant to a tombstoned principal is a 404. Through
 *     a group it was a 201: `subject_expand` filters `relationships.deleted_at`, never
 *     `objects.deleted_at`, so a tombstoned user still inside a live `member_of` edge inherits every
 *     binding the team holds.
 *   - **SUBJECT TYPE.** {@link assertBindableSubject}'s set.
 *
 * **HOW REACHABLE EACH ARM IS — measured, and stated because a guard whose reach is overclaimed is
 * how the next reader stops looking.** Neither arm refuses anything a purely LOCAL operator can
 * currently produce, and both are defence in depth rather than a closed live hole:
 *
 *   - the LIVENESS arm needs a tombstoned object with a LIVE `member_of` edge still pointing at it.
 *     `graph/objects-repo.ts`'s `deleteObject` cascade-tombstones every locally-authored edge
 *     touching the row, so the local `DELETE /users/{id}` path does not leave one. What does: a
 *     REPLICA edge (`originDomainId !== self`), which that cascade skips by design and says so; an
 *     object tombstone arriving on the FEDERATION IMPORT path, where the cascade does not run at all;
 *     and a database restored from a dump written before the cascade existed. Those are the same
 *     three populations §5's correction identifies, found the same way.
 *   - the SUBJECT-TYPE arm: `member_of`'s registered `from_types` (drizzle/0002 §6) and
 *     {@link ROLE_BINDING_SUBJECT_TYPES} are the same set today, so it is a guard against the
 *     registry being widened — `relationship_types.from_types` is plain `text[]` and writable through
 *     `POST /type-registry/relationship-types`.
 *
 * The test that pins the liveness arm builds its fixture with a raw `UPDATE objects SET deleted_at`
 * for exactly this reason, and says so at the case.
 *
 * DIRECTION, and why it is the inverse of §2a's. §2a is seeded at the GROUP and walks UP with
 * `subjectExpandCte`, because the question is "what will `hasPermission` see once this edge exists"
 * and `hasPermission` is seeded at the joiner and walks up. §2b's question is the mirror — "which
 * principals does this binding reach" — with the group as the KNOWN end and the principals unknown,
 * so it seeds at the group and walks DOWN with `memberExpandCte`. Both directions are emitted by the
 * one `memberOfClosureCte` definition in `authz/resolve.ts`, so they cannot disagree about a live
 * edge, the depth bound, or cycle termination.
 *
 * TRANSITIVE, both ways. `memberExpandCte` walks the whole closure, so a grant to group B refuses on
 * a bad principal inside group A when A is `member_of` B — which is the same nesting §2a picks up
 * from the other end.
 *
 * THE EMPTY GROUP STAYS A 201. It empowers nobody, so there is nothing to refuse. §7 is where an
 * empty group's binding is NOT allowed to count for anything, and §2c is where the granter has to
 * say out loud that it is empty.
 *
 * ------------------------------------------------------------------------------------------------
 * §2c. D7 — THE ACKNOWLEDGEMENT (owner ruling 2026-08-27)
 * ------------------------------------------------------------------------------------------------
 * §2b bounds the blind grant and cannot close it: the membership a group binding empowers was
 * authored by somebody else, and no authority bar on this door reads the subject's identity, so a
 * standing-based refusal is one that can never fire (the measurement is in §2b). The owner ruled
 * that the grant should be made INFORMED rather than refused — binding a role to a group is not an
 * escalation, since the granter already holds the role; what they cannot do is SEE whom they empower.
 *
 * {@link assertGrantAcknowledgesEmpoweredPrincipals} requires `acknowledgedPrincipalIds` to equal,
 * AS A SET, the principals the binding reaches — the same `depth > 0` closure §2b walks, from the
 * same {@link memberExpandCte} definition — whenever the subject is a `group` or `team`, and refuses
 * with **409** naming the difference in BOTH directions: reached-but-not-acknowledged (a member
 * joined between the caller's read and its write, which is the case that must not be silently
 * included) and acknowledged-but-not-reached (a member left, or the caller sent a value it never
 * read).
 *
 * The shape of the field — why an id list rather than a count or a digest, why it is optional in the
 * contract and required at the door, what `[]` means for an empty group, and how a CLI learns the
 * value (`GET /role-bindings/grant-preview`) — is documented in `packages/schemas/src/rbac.ts` next
 * to the field itself, because that is where the next reader of the contract will be.
 *
 * ORDERED AFTER §2b, and behind the authority bars with it. §2b refuses on a defect in the ESTATE
 * that no retry fixes (a tombstoned member); the acknowledgement refuses on a value the caller can
 * re-read and resend, so reporting the unfixable one first costs one round trip fewer. Both name
 * other rows' ids, so both stay behind {@link assertMayWriteRoleBinding} for §2b's disclosure reason.
 *
 * WHAT IT IS NOT. It is not an authority bar and it refuses nothing an informed granter may do: a
 * caller who has read the membership and still wants the grant sends the list and is admitted. It
 * does not make the grant safe, it makes it witnessed — and the witness is durable, because the
 * Decision this door writes carries the acknowledged set alongside `grantedPermissions`.
 *
 * ------------------------------------------------------------------------------------------------
 * §2d. THE PREVIEW'S PROJECTION — the affordance that made D7 usable, and leaked twice
 * ------------------------------------------------------------------------------------------------
 * `GET /role-bindings/grant-preview` exists because `acknowledgedPrincipalIds` is the transitive
 * `member_of` closure and no client can compute that without re-implementing {@link memberExpandCte}.
 * It has now been narrowed twice, and the second narrowing is the one worth stating as a property:
 *
 *   1. **THE GATE.** It shipped taking a caller-chosen `scopeObjectId` and authorizing at it, so any
 *      scoped `audit:read` holder named their own service and read any group's membership. Re-
 *      anchored to the SUBJECT.
 *   2. **THE PROJECTION, and anchoring at the subject could never have fixed it — THE PRINCIPALS
 *      DISCLOSED ARE NOT THE SUBJECT.** A member is a separate graph object on its own containment
 *      chain; `scopeExpandCte` expands upward, so `audit:read` at a TEAM says nothing about the
 *      members. MEASURED: a team-scoped Viewer received a 200 carrying a member's id, type and name
 *      while that same token's `GET /objects/user/{id}` answered 403.
 *
 * {@link readableSubsetOf} is the fix — the response carries only principals the caller holds
 * `object:read` at, plus a COUNT of the remainder. The count's own leak, why a digest is not better,
 * and the measurement that D7 still works for the caller who needs it are in
 * `packages/schemas/src/rbac.ts` next to `GrantPreviewResponseSchema`, because that is where the next
 * reader of the contract will be.
 *
 * **THE RULE THIS ESTABLISHES, AND IT IS THE SAME ONE §2b's ORDERING FIX ESTABLISHED FROM THE OTHER
 * SIDE.** A refusal whose BODY is derived from other rows goes behind the authority bars; a RESPONSE
 * whose body is derived from other rows is filtered to what the caller could fetch individually. The
 * grant door's §2b 422 and §2c 409 still name principals in full, and that is consistent rather than
 * an exception: they sit behind `role_binding:write` at the scope AND the whole subset rule, which
 * is strictly stronger than the preview's `audit:read`. It is also what keeps D7 obtainable for the
 * caller whose preview is incomplete — the 409 names every id they were not shown, so the
 * acknowledgement costs them one round trip instead of being unreachable.
 *
 * ------------------------------------------------------------------------------------------------
 * §3. THE SAME CLAUSE ON REVOKE — and why `deny` is handled the way it is
 * ------------------------------------------------------------------------------------------------
 * Without §2 on DELETE, a subject revokes the binding that outranks them: an OrgAdmin deletes the
 * Owner binding and the org has no Owner. So {@link assertMayWriteRoleBinding} is called on both
 * verbs with the role being granted / the role of the binding being revoked, and both bars apply.
 *
 * `effect = 'deny'` rows get the same treatment, and that is a DELIBERATE OVER-DEMAND rather than a
 * claim of exactness. Removing a deny is a LOOSENING — it hands the denied subject back whatever
 * their allow bindings say — so the honest question is "may you loosen this", which the subset rule
 * does not exactly answer. Demanding the deny'd role's own permission set is a conservative floor
 * on that: it can refuse someone who should have been allowed, never admit someone who should not.
 * (No deny row is writable through this API at all — see §5 — so the only ones reachable here are
 * hand-written or pre-date it.)
 *
 * ------------------------------------------------------------------------------------------------
 * §4. WHAT REVOKE DELIBERATELY DOES *NOT* RE-CHECK
 * ------------------------------------------------------------------------------------------------
 * {@link assertRoleBindableAtScope} and {@link assertRoleAcceptsNewBindings} are GRANT-ONLY.
 * Applying either to a revoke would make the wrong rows immortal:
 *
 *   - every EXISTING `Administrator` binding would become unrevokable the moment D5 deprecated the
 *     role, which is the exact opposite of a deprecation;
 *   - and every binding written at a nonsensical scope — the `user`/`change`/`group` bindings
 *     role-model.md §1.3h says the schema accepts today — would become permanent, when cleaning
 *     those up is half the reason `bindable_at` exists.
 *
 * A refusal that can only be applied at creation time must only be applied at creation time.
 *
 * ------------------------------------------------------------------------------------------------
 * §5. ACCEPTED CONSEQUENCE — a binding under a TOMBSTONED ancestor is unrevokable
 * ------------------------------------------------------------------------------------------------
 * Both bars are measured with the plain scoped walk, at the binding's own scope object, for grant
 * and revoke alike — NOT through `authz/org-root-arm.ts`'s disjunction. That is a considered choice
 * and it has a cost worth stating.
 *
 * `scopeExpandCte` joins each ancestor `AND parent_o.deleted_at IS NULL`, so a tombstoned ancestor
 * CUTS the chain and `scope_expand` collapses to the seed row alone — matching no org-root binding,
 * the Owner's included. Giving bar §1 an org-root arm would admit an org-root actor there while bar
 * §2 (which must stay at the scope, or it stops being a subset rule at all) still refused them, so
 * the two bars would answer different questions about the same request. Worse, on GRANT an org-root
 * arm would let an actor create authority over a subtree the resolver says their own authority does
 * not reach — a widening on exactly the door that exists to prevent widenings.
 *
 * So: a binding whose scope object has tombstoned containment ancestors cannot be revoked through
 * this API until that chain is repaired. This is the same accepted-consequence shape the federation
 * overlay doors already carry and pin (role-model.md §8.6), stated here rather than discovered
 * later. The operator remedy is to repair the containment chain; the follow-up worth tracking is an
 * authz primitive that can tell "explicitly denied" apart from "nothing reached", which is what
 * would let this door say so out loud instead of returning a flat 403.
 *
 * > **CORRECTED 2026-08-27 — THE CONSEQUENCE IS NOT REACHABLE THROUGH THE LOCAL API, AND IS PINNED
 * > BY NO TEST.** The paragraph above described it as a live cost. Two attempts to reach it through
 * > the public API failed, and `graph/objects-repo.ts`'s container-delete guard is why: it refuses a
 * > delete while ANY live object still names the row through `objects.domain_id`, a live `contains`
 * > edge, or a placement property — enumerating the blockers in the 409. So a local operator cannot
 * > tombstone an ancestor out from under a live binding's scope at all. What remains reachable is
 * > narrower and worth keeping the reasoning for: the guard is skipped on the FEDERATION IMPORT path
 * > and for a foreign-shadow removal (its own comment says so and states the orphaning as a cost), so
 * > a peer tombstoning a container it authored can still strand a local binding beneath it; and a
 * > database restored from a dump written before that guard existed can already hold the shape.
 * > **§5's design choice — both bars measured with the plain scoped walk, never through
 * > `authz/org-root-arm.ts` — stands unchanged and on its own reasoning above.** Only the "so a
 * > binding … cannot be revoked" sentence needed qualifying: it is true of those two populations,
 * > not of anything a local operator can produce.
 *
 * ------------------------------------------------------------------------------------------------
 * §6. THE SUBSET RULE HOLDS AT GRANT TIME, AND ROLES OUTGROW THE GRANTER — NOT FIXABLE HERE
 * ------------------------------------------------------------------------------------------------
 * CONFIRMED BY MEASUREMENT, not projected: a grant that satisfied §2 when it was written becomes a
 * grant the granter could not make, the moment a migration `array_append`s a permission to the
 * GRANTED role. drizzle/0010, 0012, 0083, 0088 and 0094 have each done exactly that to a built-in,
 * so it is the normal way this schema evolves rather than a hypothetical.
 *
 * Concretely: OrgAdmin grants ComponentAdmin at a component today (a proper subset — §2 admits it).
 * A later migration appends `governance:move` to ComponentAdmin. The binding is unchanged, resolves
 * unchanged, and now confers a permission the OrgAdmin who wrote it may not hold at that scope. No
 * check re-runs; nothing is re-evaluated; §2 is a WRITE-time test and there is no read-time mirror.
 *
 * IT CANNOT BE FIXED IN THIS DOOR. Re-testing at resolve time would put ~20 `hasPermission` probes
 * on the hot path of every authorization in the system, and would make a subject's authority depend
 * on the CURRENT authority of whoever granted it years ago — including principals who have since
 * been revoked, which fails closed in an unpredictable direction. Refusing the migration is the
 * other end and is worse: `array_append` onto a shared `org_id IS NULL` singleton is how every
 * permission this system has ever added arrived.
 *
 * WHERE IT SHOULD BE CAUGHT INSTEAD: role-model.md §5 step 4's permission-drift gate — the CI test
 * comparing the exported `PERMISSIONS` array against the seeded role arrays against a filterless
 * call-site census. It is the only place that sees a role's array CHANGE, which is the event. The
 * assertion worth adding there is not about drift at all: it is that widening a built-in role is a
 * deliberate act with a named blast radius, so a migration that appends to role R must state which
 * existing bindings of R it widens. The Decision every grant persists carries
 * `grantedPermissions` — the array AS IT STOOD AT THE GRANT — precisely so that blast radius is
 * computable after the fact rather than guessed at.
 *
 * ------------------------------------------------------------------------------------------------
 * §7. THE ADMINISTRATOR FLOOR — an availability invariant of the ORG, not a rule on one door
 * ------------------------------------------------------------------------------------------------
 * MEASURED on a fresh org holding only its bootstrap admin: `DELETE /role-bindings/<own Owner
 * binding>` returned **200**, leaving the org with zero bindings. Every endpoint then 403s —
 * `GET /roles` and `GET /role-bindings` included — and there is no recovery through the API at all,
 * because restoring a binding needs the `role_binding:write` that nobody now holds. The only fix is
 * hand-written SQL, which is verbatim the failure mode `packages/schemas/src/rbac.ts` says this door
 * exists to eliminate.
 *
 * BOTH AUTHORITY BARS PASS LEGITIMATELY, which is why it is not an authz bug and cannot be fixed by
 * tightening §1 or §2: the actor holds `role_binding:write`, and Owner's permission set is trivially
 * a subset of Owner's. Nothing counted what would be left.
 *
 * **THE FIRST VERSION GUARDED ONE OF THREE DOORS, AND THE OTHER TWO NEEDED NO CONCURRENCY AND NO
 * SPECIAL PRIVILEGE — four plain sequential requests each.** It was `assertNotLastAdministrativeBinding`,
 * a revoke-time rule owned by `routes/role-bindings.ts`. Measured:
 *
 *   A. `DELETE /role-bindings/{id}`   — guarded.
 *   B. `DELETE /relationships/{id}`   — remove the `member_of` edge that makes a group's
 *                                       administrative binding reachable. The BINDING ROW SURVIVES,
 *                                       so a rule that counts rows (or even walks them, at revoke
 *                                       time only) never runs, and the org is left holding an
 *                                       administrative binding no live principal resolves through.
 *   C. `DELETE /objects/team/{id}`    — tombstone the group that HOLDS the binding. `deleteObject`'s
 *                                       edge cascade tombstones its `member_of` edges, which is B
 *                                       again, in bulk, from a door that never mentions bindings.
 *
 * Recovery from either is hand-written SQL. **So the floor is not a rule about revoking a binding.
 * It is an INVARIANT OF THE ORG — "at least one live principal THAT CAN AUTHENTICATE resolves an
 * org-root binding of a role carrying `role_binding:write`" — and it is enforced wherever it can be
 * falsified, from ONE predicate.**
 *
 * {@link assertOrgRetainsAdministrativeFloor} is that predicate, and it is deliberately
 * **evaluated AFTER the write, inside the write's transaction**, refusing with **409** and rolling
 * the transaction back. That ordering is the whole design:
 *
 *   - a BEFORE check has to model what the write is about to do — "count the survivors EXCLUDING
 *     this row" — and every door needs its own model. That is three rules that agree by inspection,
 *     which is what produced B and C. An AFTER check asks the database what is actually true and is
 *     blind to which verb ran, so a CASCADE, a bulk path, or a door nobody has written yet is
 *     covered by construction rather than by a census staying complete.
 *   - it composes {@link principalsReachedBy}, i.e. {@link memberExpandCte} — the same walk §2b uses
 *     and the inverse of the one `hasPermission` uses — so the floor and the resolver cannot
 *     disagree about a live edge, the depth bound, or cycle termination.
 *
 * WHERE IT IS CALLED, and this is the whole list (the filterless census by property is in
 * role-model.md §4.3a):
 *
 *   - `routes/role-bindings.ts` DELETE, after `deleteRoleBindingById` — door A.
 *   - `graph/relationships-repo.ts`'s `deleteRelationship`, after the tombstone, for a `member_of`
 *     edge — door B, AND door C's cascade, because the cascade goes through that same function.
 *   - `graph/objects-repo.ts`'s `deleteObject`, after the tombstone and after the cascade — door C
 *     proper, and the case the cascade cannot cover: tombstoning the USER who holds the binding
 *     directly, which removes no edge at all.
 *
 * AT THE CHOKE POINTS, not at the routes, for §2a's reason exactly: `deleteObject` and
 * `deleteRelationship` are reached by IaC apply (`iac/plans-repo.ts` prunes objects and edges from a
 * manifest diff), by component merge, by placement teardown and by six repos. A route-level copy is
 * invisible to all of them, which this programme has already paid for twice.
 *
 * ORG ROOT ONLY, deliberately. A service-scoped `role_binding:write` holder cannot write a binding
 * at the org root (`scopeExpandCte` expands upward only), so they are not a recovery path and
 * counting them would let the org be bricked with the guard reporting success.
 *
 * **IT COUNTS REACHABLE PRINCIPALS, NOT ROWS — corrected 2026-08-27, and the first version was
 * bypassable in two requests.** `SELECT count(*) FROM role_bindings …` was satisfied by a binding on
 * an EMPTY group: bind a `role_binding:write` role to a team nobody is in, then revoke the real
 * Owner. The floor saw two rows, permitted the delete, and the org was left with one binding that
 * resolves for nobody.
 *
 * **AND IT COUNTS PRINCIPALS THAT CAN AUTHENTICATE, NOT GRAPH OBJECTS OF A PRINCIPAL TYPE —
 * corrected again 2026-08-27, and the SECOND version was bypassable in three.** Counting reachable
 * live objects of type `user`/`service-account` was satisfied by a PHANTOM: `POST /objects/user`
 * creates a graph object and no account, `POST /role-bindings` binds Owner to it at the org root
 * (D7 correctly demands no acknowledgement for a `user` subject), and the real administrator's own
 * binding is then revocable. Measured: 201, 201, 200, and `GET /roles` 403 — the org bricked, with
 * hand-written SQL the only way back.
 *
 * **THIS PREDICATE HAS NOW BEEN WRONG THREE TIMES IN THE SAME DIRECTION, so state the property
 * rather than the test:** the floor asks whether SOMEBODY CAN STILL LOG IN AND ADMINISTER. The
 * third revision joins the CREDENTIAL — `users.object_id`, the one row every authentication path in
 * the system resolves through — and drops the type test entirely, because the type test was both
 * halves of the bug: it counted a phantom of the right type, and it would have refused a real
 * administrator of any other. `{@link principalsReachedBy}` carries the filterless census behind
 * that anchor and the measurement that a service account has no credential shape of its own.
 *
 * **WHY A TOMBSTONED PRINCIPAL IS NOT A SURVIVOR, stated honestly because the 409's first wording
 * was measurably false.** That wording said a group whose only members are soft-deleted "empowers
 * nobody". It empowers them exactly as much as it did before the tombstone: `hasPermission` joins
 * `relationships.deleted_at` and NEVER `objects.deleted_at`, nothing in `auth/local-auth.ts`,
 * `auth/oidc.ts` or `auth/require-auth.ts` reads it either, so a soft-deleted principal still
 * resolves, can still log in, and can still administer (§8 — soft-deleting a principal revokes
 * nothing, and closing that belongs to the DELETE door). This guard excludes one anyway, on a
 * different and weaker ground: an operator being told "you still have an administrator" about a
 * principal the estate has recorded as removed, and whom this very door now refuses to write a NEW
 * binding for ({@link assertGrantReachesOnlyBindableMembers}), is being told something they cannot
 * act on. The 409 says that and no longer says the authority is gone.
 *
 * **THE RELEVANCE TESTS ARE A COST DECISION AND ARE SOUND, which is a different claim from "they
 * are complete".** The predicate is not run on every write in the system; each door runs it only
 * when the write it just performed COULD have changed the floor's answer. The floor reads exactly
 * FIVE things — `role_bindings` rows at the org root, `roles.permissions`, live `member_of` edges,
 * `objects.deleted_at`, and `users.object_id` — so:
 *
 *   - a revoke matters only if the deleted row was an `allow` binding AT the org root of a role
 *     carrying `role_binding:write` ({@link revokeAffectsAdministrativeFloor}); no other row is in
 *     the candidate set at all;
 *   - an edge tombstone matters only for `type_id = 'member_of'`; no other edge is in the closure;
 *   - an object tombstone matters only if that object holds a `role_bindings` row or has a live
 *     `member_of` edge ({@link objectTouchesRoleAuthority}, read BEFORE the tombstone and before the
 *     cascade); an object in neither is in no closure and is no binding's subject.
 *   - `users.object_id` — the fifth input — has NO delete door to short-circuit. `drizzle/0002` §1
 *     grants `scp_app` SELECT/INSERT/UPDATE on `users` and never DELETE (which is also why logout
 *     EXPIRES a session rather than deleting it), and a filterless census of `apps/server/src` finds
 *     three writers, all INSERTs: `auth/local-auth.ts`'s bootstrap, `auth/oidc.ts`'s JIT provision
 *     and the test harness. An INSERT can only ADD a credentialed principal, which can only RAISE
 *     the floor — so no write in the system falsifies the invariant through this input, and there is
 *     nothing here to place a relevance test on. The day something UPDATEs `users.object_id` to NULL
 *     or deletes a `users` row, that is a fourth door onto this invariant and must call
 *     {@link assertOrgRetainsAdministrativeFloor}. Recorded, like the `roles.permissions` case in §8,
 *     rather than left to be discovered.
 *
 * Each is a statement about the five inputs, not a guess about which callers exist — which is the
 * distinction between a sound short-circuit and the grep filter that hides the next instance.
 *
 * **AN ALREADY-BROKEN ORG IS REFUSED A FLOOR-RELEVANT WRITE, and that is a real consequence.** The
 * check is "does the invariant hold AFTER", not "did this write break it", so an org that already
 * has no live credentialed administrator — reachable only from the populations §8 names (a
 * pre-guard database, a federation-import tombstone, a soft-deleted principal, a phantom bound
 * before this revision) — gets a 409 on the next revoke or `member_of` removal.
 *
 * WHETHER IT IS WEDGED DEPENDS ON WHICH SHAPE IT IS, and the two answers differ: a SOFT-DELETED
 * administrator revokes nothing, so that principal can still log in and grant an org-root
 * administrative binding to a live one (the GRANT path takes no floor check — a grant can only add
 * reachability), after which the write proceeds. A PHANTOM administrator cannot do that or anything
 * else, because it has no credential by definition — but such an org was already unadministrable
 * before this check refused anything, and no ordering of this predicate could have made it
 * otherwise. The 409 is the diagnosis, not the cause; its message names the phantom shape for
 * exactly that reason.
 *
 * ------------------------------------------------------------------------------------------------
 * §8. WHAT IS STILL OPEN — the list, not a closure claim
 * ------------------------------------------------------------------------------------------------
 * Every section above states what IT checks. None of them states that the system is closed, and
 * this section exists so nobody has to infer it from an absence. These are the paths a reader should
 * assume are reachable:
 *
 *   - **FEDERATION IMPORT IS EXEMPT FROM §2a BY DESIGN.** A replicated `member_of` entry is written
 *     without the subset rule (`if (!input.federationImport)`), because a throw in
 *     `federation/import-repo.ts`'s replay branch aborts a peer's whole signed bundle rather than one
 *     entry. Pinned in both directions by
 *     `federation/federation-member-of-exemption.integration.test.ts`.
 *   - **§2a APPLIES THE SUBSET RULE AND NOT BAR §1.** `relationship:write` alone chooses who is in a
 *     group. That is a delegation, never an elevation of the actor — and it is what makes §2b's
 *     blind-grant shape cheap to set up.
 *   - **THE BLIND GRANT ITSELF — now WITNESSED, not closed (§2c, owner ruling D7).** §2b refuses on
 *     the membership's SHAPE and cannot refuse on the members' standing, because no authority bar on
 *     this door reads the subject's identity (the measurement is in §2b). `acknowledgedPrincipalIds`
 *     makes the granter state whom they are empowering and 409s when that value is stale — so the
 *     grant is informed and recorded, and a member joining mid-flight is caught. It is NOT a
 *     refusal of the blind grant: a caller who reads the membership and proceeds is admitted, which
 *     is what the ruling asked for.
 *   - **THE PREVIEW'S WITHHELD COUNT IS ITSELF A DISCLOSURE, ACCEPTED (§2d).** A caller who may read
 *     none of a group's members is still told HOW MANY there are. That is a fact about rows they
 *     cannot otherwise reach, and it is kept because the alternative — omitting the field — makes
 *     the response indistinguishable from an empty group, which is the exact confusion D7 exists to
 *     prevent. A count names nobody and joins to nothing. Recorded as a trade, not as a zero.
 *   - **A CALLER ADMITTED ONLY BY THE PREVIEW'S SCOPED ARM CANNOT COMPLETE A GROUP GRANT FROM THE
 *     PREVIEW ALONE (§2d).** Their `object:read` may not reach the members, so what they are handed
 *     is incomplete and the door 409s on it. It is not a dead end — that 409 names every withheld id
 *     and sits behind a strictly stronger bar than the preview's — but it IS an extra round trip for
 *     that population, and the door offers them no other way to learn the set. Measured, pinned, and
 *     stated here rather than left for a bug report.
 *   - **THE ACKNOWLEDGEMENT IS A POINT-IN-TIME WITNESS.** It is verified under §0's org lock against
 *     the closure as it stands at COMMIT, so nothing joins between the check and the write. It says
 *     nothing about the moment AFTER: somebody joining the group tomorrow is empowered by this
 *     binding and no acknowledgement is asked for, because the join door (§2a) is where that is
 *     judged and it judges it by the subset rule rather than by consent.
 *   - **ROLE-**NAME** AUTHORITY IS NOT COMPARED.** §2a and §2b refuse ONE name shape — an org-defined
 *     row colliding with a built-in name — and nothing compares name authority in general. Because
 *     `hasRoleAtScope` resolves quorum eligibility by NAME, an actor who satisfies the PERMISSION
 *     subset rule can seat a voter for every policy naming that role while holding no binding of
 *     that name itself. MEASURED (OrgAdmin ⊃ Approver, OrgAdmin is not an Approver) and pinned as a
 *     measurement, not as a guard. Closing it needs an owner ruling — see §2a for why the obvious
 *     bar deletes the OrgAdmin→ServiceAdmin/ComponentAdmin delegation.
 *   - **`effect = 'deny'` IS NOT MODELLED.** §3 over-demands on revoke and §2a skips deny rows
 *     entirely; neither is an exact answer to "may you loosen this".
 *   - **A GRANT IS NOT RE-TESTED WHEN THE ROLE WIDENS** — §6. CONFIRMED BY MEASUREMENT and OPEN: a
 *     migration that `array_append`s to a granted role widens every existing binding of it, and no
 *     check re-runs. Not fixable in this door; §6 names where it should be caught instead. Recorded
 *     as a known-open property of the model, not as something this increment closed.
 *   - **§0'S LOCK IS PER ORG AND PER INSTANCE-OF-POSTGRES, AND COVERS ONLY THESE THREE ENTRY
 *     POINTS.** A future writer of `role_bindings` or of a `member_of` edge that does not go through
 *     `routes/role-bindings.ts` or `createRelationship` races them all again. `hashtext` collisions
 *     between two org ids make two orgs serialize against each other, which costs throughput and
 *     nothing else.
 *   - **SOFT-DELETING A PRINCIPAL REVOKES NOTHING.** `DELETE /users/{id}` tombstones the graph object
 *     and leaves every `role_bindings` row naming it intact; `hasPermission` never joins `objects`,
 *     so the row still resolves. **Out of scope for this door, deliberately and by owner-visible
 *     reasoning rather than silence:** this door governs writes to `role_bindings`, and cascading a
 *     revoke off an object delete is the DELETE door's decision, with its own audit/Decision records
 *     to write and its own undelete question to answer. What this door does do is refuse to make the
 *     situation worse — §2b will not write a NEW binding that reaches a tombstoned principal, and §7
 *     will not count one as an administrator. Tracked in role-model.md §4.4.
 *   - **THE FLOOR'S CREDENTIAL ANCHOR IS THE `users` ROW, NOT A USABLE SECRET.** `credentialed`
 *     means "a row in `users` names this object", which is exactly the condition `resolveAuthContext`
 *     imposes and is therefore exactly "this object can be the actor of an authenticated request".
 *     It is NOT "somebody currently holds a working credential for it": a `users` row whose
 *     `password_hash` is NULL, whose `oidc_subject` is NULL and which owns no live PAT counts here
 *     and can sign in with nothing. That gap is DELIBERATELY not closed, and the reason is the
 *     mirror-image hazard this revision exists to avoid. Every tighter anchor is time-varying — a
 *     PAT expiring at midnight would drop an org below the floor with no write involved, and the
 *     floor is only ever evaluated ON a write, so the next unrelated revoke would 409 for a reason
 *     that has nothing to do with it. The secret half belongs to a credential-lifecycle door
 *     (rotation, expiry warnings) rather than to a write-time invariant.
 *
 *     **AND IT IS REACHABLE IN THE FIELD, NOT ONLY BY HAND-WRITTEN SQL — corrected 2026-08-27,
 *     because an earlier wording of this bullet ended "a `users` row is not creatable through any
 *     API at all today", which is a true statement about CREATION that reads as a false statement
 *     about reachability and would stop the next reader looking.** The property that matters is not
 *     "can a row be created with no secret", it is "can a row that counts here stop being able to
 *     sign in", and the ordinary OIDC path produces exactly that: `auth/oidc.ts`'s JIT provision
 *     INSERTs a `users` row with `password_hash` NULL and `oidc_subject` set, and the row is this
 *     instance's forever — deprovisioning or disabling that subject AT THE IDP, or re-pointing the
 *     deployment at a different issuer, leaves a `users` row whose only credential no longer
 *     authenticates anywhere. Nothing in this system observes that, because the IdP is the authority
 *     for it and there is no callback. So an org whose administrators are all IdP-provisioned can be
 *     told it retains an administrator when it does not.
 *
 *     THE DESIGN STANDS ANYWAY, on the time-varying argument above: an anchor that could see IdP
 *     deprovisioning would have to be a live probe of a remote system inside a write transaction,
 *     which charter principle 5 (no runtime network calls) refuses outright and which would make an
 *     unrelated revoke 409 because an IdP was slow. The honest position is that this floor bounds
 *     the shape the API can produce — `POST /objects/user` mints a graph object, not an account, and
 *     that phantom is refused — and does not bound the shape an external identity provider can
 *     produce. The remaining gap is strictly narrower than the phantom it replaced, and it is a
 *     credential-lifecycle problem wearing a role-binding costume.
 *   - **`roles.permissions` IS MUTABLE AND NOTHING GUARDS THE FLOOR AGAINST IT.** Removing
 *     `role_binding:write` from the last administrative role would empty the floor's candidate set
 *     with no door involved. There is no runtime writer — a filterless census finds no
 *     `UPDATE roles` anywhere in `apps/server/src`, only migrations — so today the only path is a
 *     migration, which is where §6 already says role-array changes must be reasoned about. Recorded
 *     because the moment step 10 ships a custom-role authoring API, that API is a fourth door onto
 *     this invariant and must call {@link assertOrgRetainsAdministrativeFloor}.
 *   - **THE FLOOR IS EXEMPT ON THE FEDERATION-IMPORT PATH**, by the same mechanism and for the same
 *     reason as §2a: a peer's `object_tombstone` or `relationship_tombstone` entry that removes the
 *     last administrator would otherwise abort that peer's whole signed bundle. A replica of a
 *     principal or a membership is the authoring domain's row, and this instance cannot refuse its
 *     removal without diverging. Same for the unverified-shadow removal carve-out `deleteObject`
 *     already takes.
 */

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

/** `true` when this row is a built-in the write door refuses new bindings to (D5). */
export function roleDeprecationReason(role: { orgId: string | null; name: string }): string | null {
  if (role.orgId !== null) return null;
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
 * §2a — the subset rule applied to CREATING a `member_of` edge. See §2a of the module doc for the
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
 * See §2b of the module doc for the measured ordering, for the direction of the walk, and — most
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
 * that can falsify it**; see §7 of the module doc for the three measured doors, for why it is
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
