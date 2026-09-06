# changes

Reference for `apps/server/src/routes/changes.ts`. The source carries a one-line headline at each site and points here.

> Partial: 4 of 23 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. AUTHORIZATION SCOPE FOR A CHANGE

AUTHORIZATION SCOPE FOR A CHANGE — the change's TARGETS (role-model.md §4.2, §8.4)

WHY NOT `auth.orgId`, WHICH IS WHAT EVERY DOOR HERE USED TO PASS. `authz/resolve.ts`'s `scopeExpandCte` expands a checked scope UPWARD only, so `scopeObjectId: auth.orgId` is satisfiable by an ORG-ROOT binding and by nothing else. A principal who administers one service or one component could therefore hold `object:read`/`object:write` and still be refused the read and the accept of the release against their own estate — the read-surface blocker that made every scoped role in role-model.md §3 unusable.

WHY NOT THE CHANGE ITSELF, WHICH IS THE OBVIOUS RE-SCOPE AND IS INERT. A change has no scope of its own: `objects.domain_id` for a change is the ORG ROOT for every one of the five internal `proposeChange` callers (they pass no `domainId` at all), `scp change propose` has no `--domain` flag, and route 1 of the scope walk goes from `change.id` straight back to that same `domain_id`. `scopeObjectId: change.id` would READ as a narrowing to a reviewer and BE the org-root pin it replaced. Measured in role-model.md §8.4, which also records why re-parenting changes onto a nearest-common-ancestor was rejected.

So: the targets, read back off the persisted `properties.targets`.

```text
* READ doors — ANY ONE target. A principal who can see one target is already told the whole
  target list by `properties.targets` on the object they just read, so an every-target read
  bar buys nothing and would make reads strictly HARDER to satisfy than the writes they gate.
* WRITE doors — EVERY target, so that the admin of one target of a five-target change cannot
  accept the release into the four they have no standing on.
```

AND THE ORG-ROOT ARM STAYS, ADDED TO THE TARGET CHECK RATHER THAN REPLACED BY IT. "An org-root binding satisfies a check at any object below it" is ALMOST true and was written here as though it were exhaustive; it is false in exactly the case these doors reach most easily. `scopeExpandCte` joins every ANCESTOR `deleted_at IS NULL`, so a target whose containment parents have been tombstoned expands to the seed alone and matches NO binding — the org-root Owner's included. A change's targets are read back VERBATIM and deliberately never re-resolved (see `readChangeTargetScopeIds`), so a target that has since been deleted, along with its service and its domain, is the ordinary case rather than the exotic one. Both helpers below therefore compose `authz/org-root-arm.ts`'s `checkAtOrgRootOrScopes`, which is the ONE definition of the org-root arm shared with the campaign doors, the source-mapping doors and `POST /policy-evaluate`, and which argues the arm and its ORDER in full.

AND THE ARM RUNS BEFORE THE TARGET SET IS EVEN READ, WHICH IS WHAT MAKES IT A PURE WIDENING. The pre-2.5a check never looked at `properties.targets`, so nothing about that array may decide an org-root principal's request. `checkAtOrgRootOrChangeTargets` therefore evaluates the org-root arm FIRST and only then inspects the persisted set — a change whose targets are empty, missing or malformed is served to an org-root Owner exactly as it was before, while a SCOPED principal still hits the explicit trap-4 refusal (an unvalidated persisted array must never authorize by being empty). Both properties, one ordering; that helper's docblock argues it in full. This is a FIX, not a caveat: reading the target set first is what the first cut of this increment did, and it 403'd the org-root Owner on any row a federation import had mangled.

SO THE ONLY THING AN ORG-ROOT OWNER CAN NOW GET THAT THEY COULD NOT BEFORE IS A 404, AND ONLY ON AN ID THAT IS NOT A CHANGE:

```text
* An id that is not a change — which `GET /changes/{idOrUrn}/control-runs` used to answer
  `200 []` — is a 404 (`resolveChangeForScope`). Deliberate, and a better answer than `200 []`.
* `GET /approvals?changeId=` is the SAME 200-to-404, on a caller-supplied parameter: it used to
  resolve any object type and hand the id to `listApprovalRequestsForChange`, so a component's
  id came back `200 {items: []}`. It is now the same 404 `resolveChangeForScope` gives
  everywhere. (`GET /approvals/{id}`, its `/votes` and `GET /control-runs/{id}/findings` take
  the same 404 on a `change_object_id` that does not name a change — but that value comes off a
  persisted row, so reaching it means the row is already corrupt.)
```

A SOFT-DELETED change is NOT that 404: `resolveChangeForScope` resolves tombstoned rows too, for the reason its docblock gives — the four doors that reach a change through it did not resolve one at all before 2.5a, and `getChange` (behind the other five) has never filtered `deleted_at`.

Reporting an authorization failure to a principal with authority over the whole org is the one outcome this re-scope must never produce, and after the reorder above there is no input — row contents included — that can produce it.

These live here rather than in `coordination/campaign-scope-authz.ts` (with the propose-time target check) only because this increment's file set is these two route files; they are exported so `routes/governance.ts`'s change-scoped doors use the SAME implementation and the read bar and the write bar cannot drift apart. Moving them next to `assertCoordinationTargetsWithinAuthority` is a mechanical follow-up.

## §2. ONE EVERY-TARGET WRITE BAR, PARAMETERISED BY PERMISSION

ONE EVERY-TARGET WRITE BAR, PARAMETERISED BY PERMISSION — extracted so the two bars `accept` and `rollback` stack cannot drift on the org-root arm, the trap-4 refusal or the wording of the 403. The message names the permission it actually demanded, which is the whole diagnostic value of a stacked bar: "lacks 'change:accept' at scope X" tells an operator to grant a purpose role, while "lacks 'object:write' at scope X" tells them the principal has no standing on that target at all.

## §3. THE VERDICT-READ RULE

THE VERDICT-READ RULE — one bar for Decision rows, wherever they are served

Decision rows about one subject are served by TWO doors: `GET /decisions` + `GET /decisions/{id}` (as themselves) and `GET /changes/{id}/explain` (embedded, via `listDecisionsForSubject`, whose subject is the change). One dataset behind two different bars is a defect either way round — it makes "may I see why I was blocked" depend on which URL the caller happened to open. So both sites obey ONE rule, stated here and pointed at from each:

```text
A principal who may READ the thing a verdict is about may read the verdict about it —
`object:read` at the subject, and where the subject is a CHANGE, at ANY ONE of its targets,
which is exactly the bar `assertReadableAtSomeChangeTarget` puts on the change itself.
PLUS, always, the deployment-wide auditor's arm: `audit:read` at the ORG ROOT.
```

WHY THE READ BAR AND NOT SOMETHING STRICTER, decided rather than lowered to match. Charter principle 6 says every blocked response carries a `decision_id`; a `decision_id` its recipient is then 403'd on is a reference to nothing. `/explain` is the door `scp change explain` is built on and has always served these rows to whoever may read the change, so the strict alternative is not "raise /explain" — it is "delete the explanation from the product". The bar that stands is the one that lets the party who was refused read the refusal.

WHY THE ORG-ROOT ARM SURVIVES ANYWAY (role-model.md §8.6). §8.6's caveat is that re-scoping this door to `decision.subjectId` hands the accountability record to the party being held accountable. The target-based arm does NOT reopen that, for two reasons: it is per-subject, so it never becomes an enumeration — an UNFILTERED `GET /decisions` still admits only the org-root arm, and the LIST half (increment 2.5b) is where a filterable listing would have to answer for itself — and the record a target's admin can reach is the record of a release against their own estate, which `/explain` already showed them. What §8.6 protects is the DEPLOYMENT-WIDE read: seeing every verdict ever recorded, across subjects you have no standing on. That stays behind `audit:read` at the org root, and it is the broad arm here.

## §4. DECISIONS ARE A DISJUNCTION, NOT A RE-SCOPE

DECISIONS ARE A DISJUNCTION, NOT A RE-SCOPE (role-model.md §8.6) — the verdict-read rule above, as code:

```text
`audit:read` at the ORG ROOT     — the auditor's read, deployment-wide, unchanged in reach
OR `object:read` at the SUBJECT  — resolved as the rule says: at ANY ONE TARGET when the
                                   subject is a CHANGE, at the object itself otherwise
```

THE CHANGE CASE IS WHY THE SECOND ARM RESOLVES TARGETS RATHER THAN CHECKING `subjectId` DIRECTLY, and it is not a refinement — without it that arm is INERT for the dominant Decision subject. A change is what almost every Decision in this system is about (`gate`, `wave_target`, `transition`, the promotion and retrans kinds), and a change has no scope of its own: its containment chain runs to the org root (see the block at the top of this file). So `object:read` at `decision.subjectId` for a change-subject Decision is satisfiable only by an ORG-ROOT binding — the very principals the first arm already admits — and the scoped principals the arm exists for would still have been refused.

COMPOSED FROM `checkAtOrgRootOrScopes`, the same one definition of the org-root arm the change, campaign and source-mapping doors use — and this is the door that shows why that helper takes TWO permissions rather than one: the wide arm is `audit:read`, the narrow arm `object:read`, because the two arms answer different questions. `hasPermission`, not `authorize`, on both arms (an arm that threw could not be fallen through) and one clear 403 naming both if neither holds. `readChangeTargetScopeIds`, not `changeTargetScopeIds`, for the same reason: an unestablishable target set must make the SUBJECT arm fail, not the whole check, so the org-root auditor still reads a Decision whose change has since had its `properties` mangled. Refusing there would let a bad row erase the accountability record, which is the opposite of what an audit read is for.

A TOMBSTONED ANCESTOR CANNOT LOCK THE AUDITOR OUT HERE, and that is not luck: the wide arm is checked at the org root, whose expansion is a single depth-0 row, so it is unaffected by whatever happened to the subject's containment chain. The SUBJECT arm alone would be — which is the defect `authz/org-root-arm.ts` exists to prevent everywhere else.

THE WIDE ARM IS THEREFORE NOT LITERALLY THE OLD CHECK, and that is a DECIDED narrowing rather than an oversight — the one place in increment 2.5a where the pre-2.5a check is not reproduced verbatim. Pre-2.5a this door demanded `object:read` at the org root; the arm here demands `audit:read` there. Widening it back to `object:read OR audit:read` was considered and REFUSED: `object:read` at the org root is held by four of the five built-in roles, so folding it in re-opens the exact escalation §8.6 names (handing the deployment-wide record of every verdict ever taken to anyone who can read the estate), and it would put the door on the wrong permission just as role-model.md §5 step 3 begins binding purpose roles in the field.

The narrowing has NO POSSIBLE HOLDER, and that is pinned rather than asserted: every seeded role carrying `object:read` also carries `audit:read` (`drizzle/0002_rls_rbac_seed.sql`), there is no custom-role API to author one that does not, and `change-target-scope.integration.test.ts`'s "the `audit:read` wide arm narrows NOBODY who can exist" case reads the `roles` table and fails if that ever stops being true — at which point this decision has to be made again with a real principal in hand. The argument used to carry a third clause — "and where a subject IS named the second arm admits any org-root `object:read` holder anyway (the scope walk reaches the org root from any object)" — which is exactly the false-exhaustive claim this pass removed everywhere else: a subject whose ancestors are tombstoned reaches nothing. The first two clauses stand on their own and the third is gone. This also puts the door on the permission role-model.md §5 step 3 wants it on, before five purpose roles start being bound in the field.

The subject is looked up with the NON-throwing `findObjectByIdOrUrnAnyType`: a decision outlives its subject (that is what an audit record is for), and a subject that no longer resolves must leave the org-root auditor's read working rather than 404 the accountability record away. That lookup now runs BEFORE the check rather than inside the second arm, because the helper wants the scope set up front — one indexed lookup an org-root auditor did not previously pay for, against the two recursive CTEs the check itself runs.
