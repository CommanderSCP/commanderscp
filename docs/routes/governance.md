# governance

Reference for `apps/server/src/routes/governance.ts`. The source carries a one-line headline at each site and points here.

> Partial: 6 of 20 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. M25.9 / OWNER RULING D1

M25.9 / OWNER RULING D1 (2026-08-25) — TAKING PROTECTION AWAY FROM A FREEZE YOU DID NOT DECLARE
`freeze:override` on top of `freeze:write`, and ONLY when the acting subject is not the freeze's `created_by_actor_id`. The full reasoning, the three artifacts that disagreed and which of `campaigns-rework.md` §1.7's three exits the owner took, is in the lift route's docblock below; this is the one place the rule is spelled.

ONE FUNCTION, TWO CALLERS, DELIBERATELY. `DELETE` (lift) and a SHORTENING `PATCH` are the same act — both end a protection early for everyone the freeze covers — and `freezes-repo.ts`'s `lockFreezeRow` header records what the asymmetric version of a freeze refusal costs: "a lift that is refused while a window edit is not lets an outpost push a commander's `ends_at` to a past instant and achieve the retraction it was refused, through a verb nobody thought to guard." The same sentence is true one authority-model over. A third loosening verb must call this too.

COMPARED ON `created_by_actor_id`, READ FROM THE ROW. Never inferred from who holds what, and never from `lifted_by_actor_id` (which is null until the very write being authorized). For any freeze these routes can write, the column is set once by `createFreeze` and never updated: the only other writer is `governance/freeze-object.ts`'s rebuild, whose update arm is fenced to `object_id = <the peer object>` — a REPLICA row, which `freezes-repo.ts`'s `lockFreezeRow` already refuses both write verbs on with a 409 before authorship could matter. So the value cannot drift out from under an authorization decision made on it, which is what makes the comparison safe against the lift route's unlocked read.

ADDED, NEVER SUBSTITUTED: `freeze:write` at the freeze's own scope is authorized by the time this runs, on both verbs, for every caller. This is a second bar, and it is demanded at THE FREEZE'S OWN SCOPE — the same scope as the `freeze:write` check it sits beside, and the scope DESIGN §10.3 already demands `freeze:override` at for a per-change override ("at that freeze's own scope"), so one permission means one thing on both of its doors. `hasPermission` expands upward only, so an Owner bound at service S can retract an S-scoped freeze a colleague declared and CANNOT reach the org-root freeze that covers everyone — the same bound `freeze:write` gets here, for the same reason. Demanding the override at `auth.orgId` instead would not be a hole (it is strictly narrower: only an org-root Owner would ever clear it), but it would make this bar's reach disagree with the reach of the permission it is stacked on, and would leave a service Owner unable to retract a colleague's freeze inside their own service.

AND THAT PARAGRAPH IS PINNED, NOT MERELY ARGUED — `coordination/freeze-admission.integration. test.ts`, the `M25.9 ladder` case "the override is demanded at THE FREEZE'S OWN SCOPE": a SERVICE-bound Owner lifts a service-scoped freeze an org-root Administrator declared, with a service-bound ADMINISTRATOR refused on the same freeze as its control. Rewrite `scopeObjectId` below to `auth.orgId` and that one case goes red. It exists because review found this claim unmeasured: every OTHER actor in that block is bound at the ORG ROOT, where the two spellings name the same scope, so all of them passed under either. A claim about a second parameter needs a case in which that parameter is the only thing that moved.

## §2. M22.8 — WHICH CROSSING THIS RUN AUTHORIZED

M22.8 — WHICH CROSSING THIS RUN AUTHORIZED. Stored since M4, never projected. It became load-bearing at M22.0a, which keyed the cache on gate identity and thereby made several runs per change the NORM rather than an anomaly; until now an operator reading this list saw N rows for one control with no way to tell which one let production through.

Sent unconditionally. The columns are NOT NULL, so the wire fields' optionality is for older generated clients only (see `ControlRunSchema`), never a licence to omit them — and a `?? undefined` here would silently turn a schema-drift bug into a missing field.

## §3. M25.7 / OWNER DECISION D6

M25.7 / OWNER DECISION D6 — THE FEDERATING FORM IS A SECOND, HIGHER GATE
`freeze:write` above is the permission for freezing YOUR OWN estate, and it is still required — this is ADDED, never substituted. `federation:write` is demanded on top because `federate: true` declares a freeze that BINDS ANOTHER SECURITY DOMAIN: the object rides `object_upsert` to every peer at a scope that carries it, and `governance/freeze-object.ts`'s projection rebuild makes it BLOCK there. That is categorically different from describing your own estate, and it is the exact line ADR-0022 drew for commander-authored outpost config, in the same direction.

Checked at the SCOPE OBJECT, not at the org root, so the permission's reach and the freeze's reach are the same bounded thing — the property `freeze:write` already has here and that the lift route's docblock spells out at length.

ASYMMETRIC ON PURPOSE, exactly like `assertMayDeclareDomainLocal`: only `true` is gated. An ordinary `POST /freezes` is unchanged for every existing caller.

## §4. M25.1 — LIFT AND SHORTEN

M25.1 — LIFT AND SHORTEN. The exits `/freezes` shipped without.

WHY THIS EXISTS. `/api/v1/freezes` was CREATE / LIST / GET, so a freeze could be declared and never retracted or shortened. That was survivable while a freeze parked a WHOLE wave — the operator waited for `endsAt` and the release resumed on its own. M25.2's per-target admission made it unsurvivable: a far-future `endsAt` now holds a SUBSET of a wave's targets while the siblings have already shipped, so a mistyped year leaves a fleet split across two versions with no API exit at all. The only escapes were `scp change cancel` / `scp change rollback`, both of which throw the RELEASE away rather than lifting the FREEZE.

AUTHORIZATION: `freeze:write` AT THE FREEZE'S OWN `scopeObjectId`
SCOPE FIRST, because it is the part that is easy to get silently wrong. `hasPermission` expands the checked scope UPWARD to its containment ancestors (`authz/resolve.ts`'s `scopeExpandCte`), so a binding at the org root satisfies a check at a service, and a binding at a service does NOT satisfy a check at the org root. Checking at the FREEZE'S OWN scope therefore gives exactly the property that matters: an Administrator scoped to one service can lift that service's freeze and CANNOT lift the org-root freeze that covers everyone. This mirrors `checkFreeze`, which authorizes `freeze:override` per freeze at that freeze's own scope — checking only `active[0]`, at one scope, was a shipped bug (CRITICAL #2). Checking at `auth.orgId` here would have been the same bug wearing different clothes.

AND `freeze:override` ON TOP, FOR A FREEZE YOU DID NOT DECLARE — M25.9, OWNER RULING D1
SETTLED 2026-08-25 by owner ruling (decision D1, option a-ii). This block previously read "OPEN, PENDING AN OWNER RULING"; it is now closed, and the exit taken is (b) of the three `docs/proposals/campaigns-rework.md` §1.7 offered:

```text
`freeze:override` is required to LIFT or SHORTEN a freeze YOU DID NOT DECLARE, compared on
`freezes.created_by_actor_id` against the acting subject. Retracting or shortening YOUR OWN
freeze stays `freeze:write` alone.
```

WHAT WAS WRONG WITH `freeze:write` ALONE. An override is per-CHANGE: it lets ONE change past and leaves the freeze standing for everyone else, and `drizzle/0010` grants it to Owner only. A lift is per-FREEZE: it retracts the protection for EVERYONE the freeze covers. Demanding only Administrator-tier `freeze:write` for the lift made the strictly wider-reaching verb take the strictly narrower permission — an Administrator at service S could retract an Owner's S-scoped freeze for everyone with a permission they already held, where the Owner-only override would have admitted exactly one change. Three artifacts disagreed about that: `drizzle/0010`'s comment calls `freeze:override` and `change:emergency` "the two highest-blast-radius bypass permissions (DESIGN §10.3), deliberately NOT granted to Administrator by default", DESIGN §10.3 says getting past a freeze "requires an explicit `freeze:override` permission", and this file argued the opposite from first principles. The ruling makes 0010's comment and DESIGN §10.3 AGREE with this file rather than the reverse: `freeze:override` is once again what it costs to take protection away from a freeze someone else declared, whether by bypassing it for one change or by retracting it for all of them.

AND THE DOCS WERE ACTUALLY EDITED, which is the only thing that makes the sentence above true. The point of the ruling was to stop three artifacts contradicting each other, so naming agreement without producing it would have been the same defect one layer down. What changed, and it is checkable: DESIGN §10.3's **retraction** bullet ("A freeze can be retracted") stated the rule flatly as `freeze:write` at the freeze's own scope with no mention of the override — it now carries the override clause, the actor comparison, and the shorten/extend split. BUILD_AND_TEST.md §8's **M25.1 definition of done** carried the identical superseded wording and now carries the same clause, marked as a deliberate post-ship correction of a DoD rather than a quiet rewrite. §10.3's **Override** bullet already agreed and is untouched — it is the retraction bullet, describing the exact two verbs gated here, that did not. `drizzle/0010`'s comment needs no edit: it says only that the override is not granted to Administrator by default, which is precisely what this bar now relies on.

BOTH PROPERTIES SURVIVE, WHICH IS WHY THE ACTOR IS IN THE RULE AT ALL:

```text
* A SURFACE WITH AN ENTRANCE AND NO EXIT IS THE DEFECT M25.1 EXISTS TO REMOVE. `freeze:write`
  is what declares a freeze. Requiring `freeze:override` to lift EVERY freeze would mean an
  Administrator can create a governance object they cannot retract, and would put every
  mistyped `endsAt` on the estate in front of the Owner — reproducing, one level up, exactly
  the "no way out" M25.1 closed. Your own mistake stays yours to undo, at the same permission
  that made it.
* NO ADMINISTRATOR SILENTLY UNDOING AN OWNER. Someone else's freeze is someone else's
  protection. Scope alone did not give this: `freeze:write` at S covers every freeze at S, no
  matter who declared it, so an Administrator and an Owner bound at the same service were
  indistinguishable to this route. The actor comparison is the part scope cannot express.
```

WHICH ACTS THE SECOND BAR COVERS, and this is the half that is easy to get wrong:

```text
* LIFT (this route) — retracts the protection outright. Covered.
* PATCH that SHORTENS `endsAt` — ends the protection early for everyone covered. It is the
  same act with a different record (`updateFreezeWindow`'s docblock: same effect on
  admission, and deliberately not re-labelled a lift), so gating the lift alone would leave
  the retraction one PATCH away — §1.7 exit (b)'s own caveat, "must cover PATCH-shortening
  too, or it is bypassed in one call". Covered, in the PATCH route below.
* PATCH that EXTENDS `endsAt` — ADDS protection. Nothing is taken from anyone the freeze
  covers, so it stays `freeze:write`, and extending someone else's freeze is deliberately NOT
  an override-tier act. (A federating freeze is the one case where extending IS the sharper
  direction, because it grows a block inside another security domain — that is
  `assertMayEditFederatingFreeze`'s bar, a different permission for a different reason, and
  both apply.)
* PATCH that moves `endsAt` NOWHERE (`direction === "unchanged"`) — nothing was weakened, so
  nothing extra is demanded. Re-saving a form must not require the Owner.
```

The three-way split is why the PATCH route authorizes on `direction` rather than on the verb.

NOT ESCALATABLE FROM BELOW — but the REASON changed on 2026-08-27, and the old one has expired.

This comment used to read "`role_binding:write` has no write API, so an Administrator cannot mint themselves the Owner role and clear the new bar." That was true, and it was load-bearing safety resting on an UNBUILT FEATURE — the kind of argument that expires silently the day somebody ships the obvious missing CRUD. `routes/role-bindings.ts` (role-model.md §5 step 5) ships it: there is now a `POST /api/v1/role-bindings`, and `role_binding:write` is seeded onto Administrator, Owner and OrgAdmin.

THE PROPERTY SURVIVES, ON A DIFFERENT FOOTING. That door applies the NO-ESCALATION SUBSET RULE (`docs/authz/role-binding-door.md` §2): a binding may be written only if every permission the granted role carries is one the acting subject already holds AT THAT SCOPE, computed by running `hasPermission` per member of the target role's array. `Owner` holds `freeze:override`, `change:emergency` and `campaign:deadline-override`; Administrator deliberately holds none of the three (drizzle/0010's comment says so in as many words, and this bar rests on it). So an Administrator granting themselves Owner fails the subset rule on exactly the permission this route demands, and the refusal names it.

AND THE SUBSET RULE HAS TO BOUND *BOTH* DOORS, because there were two. The paragraph above was correct about `POST /role-bindings` and incomplete about everything else: a role binding held by a GROUP resolves for every member (`authz/resolve.ts`'s `subject_expand` walks `member_of`), so until 2026-08-27 an Administrator could bind Owner to a group and then join it — and so could an ORG-ROOT OPERATOR, four rungs lower, since creating that edge needed only the `relationship:write` every org-root principal holds at every object. `docs/authz/role-binding-door.md` §2a closes it by applying the SAME subset rule at `graph/relationships-repo.ts`'s `createRelationship`, so the rule now bounds the membership door as well as the binding door, on every caller of that function — IaC apply included.

WHAT IS CHECKED, STATED WITHOUT A CLOSURE CLAIM. The previous version of this paragraph ended "the only thing that would break it now is somebody granting Administrator `freeze:override`" — and the reversed ordering of the same two requests disproved it within the day, which is the second time a comment here has closed on an exhaustiveness claim its author could not verify. So: three doors apply the subset rule — `POST /role-bindings` (§2), a `member_of` create (§2a), and a grant whose subject is a group/team (§2b, added for that reversed ordering). Pinned by `routes/rbac-role-binding-door.integration.test.ts` and, for the choke-point placement, `iac/iac-member-of-role-escalation.integration.test.ts`.

PATHS KNOWN TO BE OPEN, named here rather than implied, with the full list and the reasoning in `docs/authz/role-binding-door.md` §8:

```text
* §2a applies the subset rule and NOT bar §1, so an actor who already holds everything a
  group's bindings carry may add a THIRD party to that group without `role_binding:write`.
  That is an unauthorised DELEGATION of authority the actor already has; it cannot elevate the
  actor, and it cannot give anyone `freeze:override` the delegator does not already hold.
* A grant to a group is BLIND — §2b refuses on the membership's shape and cannot refuse on the
  members' standing, because no authority bar on that door reads the subject's identity. An
  Owner binding Owner to a team empowers whoever is in it, including a principal who put
  themselves there. That is the Owner's own grant reaching further than the Owner looked; it
  is not reachable by a principal who does not already hold `freeze:override`, so it does not
  clear THIS bar, but it is not closed either.
* `member_of` edges arriving on the FEDERATION IMPORT path are exempt from §2a by design.
```

Granting Administrator `freeze:override` would also break the property, and remains the loudest way to do it — a migration rather than an absence.

An `authorize` failure throws a raw 403 rather than returning a `blocked` verdict, and that differs from `checkFreeze` deliberately: `checkFreeze` runs inside a change's gate evaluation, where a rejected override must become a Decision so the change carries a resolvable `decision_id`. This is a direct authoring call with no change in hand and nothing to explain later — a 403 with no side effects is the honest answer, and matches `POST /freezes`.

AUDIT + DECISION ON BOTH VERBS
Each route writes ONE Decision (`kind: "freeze_window"`, `subjectId` = the freeze id) and ONE high-severity audit event carrying that Decision's id — the shape `freeze.override` already sets in `coordination/transition.ts`, and the same authoring-Decision precedent `graph/components-repo.ts` and `coordination/campaign-repo.ts` use for non-change subjects. The audit event's `reason` is the operator's own words, and the Decision's `inputContext` carries the machine-readable before/after — the audit table has no payload column, so the Decision is where "from what, to what, which direction" survives.

NO `insertDecisionIfChanged` HERE, and no dedup concern: these are one-per-API-call authoring records, not a predicate re-evaluated every tick. ADR-0024's write amplification came from the reconcile loop restating an unchanged verdict; a human pressing a button is not that.

## §5. M25.7 — THE LIFT MUST REACH DOWNSTREAM TOO

M25.7 — THE LIFT MUST REACH DOWNSTREAM TOO. A no-op for a non-federating freeze. Without it a commander could declare a freeze that blocks at an outpost and never retract it there: M25.1's "a surface with an entrance and no exit" defect rebuilt one boundary over, and strictly worse, because `lockFreezeRow`'s replica guard deliberately denies the outpost a local exit. The re-snapshot rides the next bundle like any other object edit.

## §6. M25.9 / OWNER RULING D1

M25.9 / OWNER RULING D1 — A SHORTENING IS A RETRACTION, AND THE SAME BAR APPLIES
Only `direction === "shortened"` takes protection away from the people this freeze covers; extending ADDS protection and `"unchanged"` moves nothing, and both of those stay `freeze:write`. See the lift route's docblock for the three-way split.

AFTER `updateFreezeWindow`, NOT BEFORE, AND THAT PLACEMENT IS THE WHOLE CORRECTNESS OF THIS CHECK. `direction` is the authorization INPUT here, and it is only knowable against the row that is actually in force — which is what `lockFreezeRow`'s `FOR UPDATE` inside `updateFreezeWindow` establishes, and nothing else in this handler does. The unlocked `getFreeze` above returns the pre-transaction committed value under READ COMMITTED, so a check written against `existing.endsAt` is decidable on a window that is no longer live: with the freeze at +30d, a concurrent extension in flight and this request asking for +1d, the stale read says "+1d is later than the +0.5d I read, so this is an extension" and admits it — and the UPDATE, which does take the lock, then cuts a 30-day protection to a day for an actor holding no override. That is the exact staleness `freezes-repo.ts`'s `lockFreezeRow` header describes corrupting the audit record, one consequence worse: there it makes a governance record lie, here it decides a permission.

A 403 THROWN HERE STILL HAS NO SIDE EFFECTS. `withTenantTx` is one `db.transaction`, so throwing aborts it and the UPDATE above is rolled back with the row lock — nothing is committed, no Decision, no audit event, no `syncFreezeObject` publish. The route's "an `authorize` failure throws a raw 403 with no side effects" note below still holds exactly as written. Splitting the difference — a cheap stale pre-check plus this one — was rejected on the repo's most-repeated defect: two copies of one refusal, free to disagree, where the copy that runs first is the one nobody re-reads.
