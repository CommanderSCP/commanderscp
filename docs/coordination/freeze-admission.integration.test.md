# freeze-admission.integration.test

Reference for `apps/server/src/coordination/freeze-admission.integration.test.ts`. The source carries a one-line headline at each site and points here.

> Partial: 7 of 37 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. D7, READ SIDE

D7, READ SIDE — the read-time projection (`GET /changes/{id}/explain`) has to agree with the actuator above, or an operator sees a rollback dispatched WHILE `explain` still reports its target held by the very freeze it was exempted from (M25.UI review finding 3).

## §2. (c) THE QUANTIFIER

(c) THE QUANTIFIER. Authority at the SECOND service overrides the freeze declared there and says nothing about the one at the first — so the change is STILL blocked. Flip `every` to `some` in `checkFreeze`'s loop and this arm goes green: one overridden freeze would be enough and the actor would ship past a freeze they hold no authority over. THIS is the arm the case is named after, and it needs two freezes to exist at all.

## §3. M25.7 / D6 AUTHORING DOOR

M25.7 / D6 AUTHORING DOOR — `federate` IS A SECOND, HIGHER GATE, AND IT DEFAULTS OFF
Two properties that fail in opposite directions, so both need a case: the default must change NOTHING (a new reach never defaults on), and the federating form must demand `federation:write` ON TOP of `freeze:write` — declaring a freeze that binds another security domain is not the act of describing your own estate (ADR-0022's line, applied by ADR-0043 §3).

THE REFUSAL CASE'S ACTOR IS AN ORG-DEFINED ROLE, NOT A BUILT-IN ONE, and that is load-bearing. `freeze:write` and `federation:write` both land on Administrator and Owner and nowhere else, so nothing reachable through today's role table holds one without the other: against a built-in actor the gate would be satisfied by coincidence between two grant lists in two unrelated migrations, and deleting the check would leave every case green. `roles.org_id` exists for exactly this, and `governance/governance-managed-write-doors.integration.test.ts` builds the mirror-image actor for the mirror-image reason.

## §4. D6 GATE, THE OTHER TWO VERBS

D6 GATE, THE OTHER TWO VERBS — `federation:write` IS DEMANDED WHEREVER THE OBJECT IS PUBLISHED
The create gate above is only one of three doors that reach another security domain. Both write verbs call `syncFreezeObject`, which re-snapshots the `freeze` object so the edit rides the next bundle — so gating the create alone left the SAME reach available with strictly less authority:

```text
a `freeze:write`-only actor could take a federating freeze whose window ends in an hour and
PATCH its `endsAt` a year out, extending a release-stopping block across a boundary they hold
no federation authority over; or lift it, retracting a commander's protection at every
downstream instance.
```

Keyed on `objectId !== null` — on whether the publish will actually happen — so a non-federating freeze is untouched, which is what the control half of each case measures. The actor is the same org-defined role the create gate uses, and for the same reason: no built-in role separates these permissions.

MUTATION RUN 2026-08-24, MEASURED. Deleting BOTH `assertMayEditFederatingFreeze(tx, auth, …)` calls from `routes/governance.ts` fails exactly these two cases and nothing else:

```text
× D6 gate: … cannot LIFT a federating freeze …
  → lifting a federating freeze retracts it downstream — that needs federation:write:
    expected 200 to be 403
× D6 gate: … cannot EXTEND a federating freeze's window …
  → expected 200 to be 403
```

The CREATE gate case stayed green through it, which is the point: the create check could not and did not cover these verbs. RE-MEASURED 2026-08-25 after M25.9 added the actor ladder, which is why `createFreezeOnlyUser` now also grants `freeze:override`: see its docblock.

## §5. THE FIXTURE IS THE TEST

THE FIXTURE IS THE TEST. The previous shape (one held target, one covering freeze) made both Decision sorts operate on ONE-ELEMENT arrays, so deleting them changed nothing and the mutation survived while three docblocks and this case's own banner claimed it was covered. Both sorts are now given input whose NATURAL order is the reverse of their sorted order:

```text
* TARGETS. Placements are created govcloud -> emea -> apac -> amer, so their uuidv7 ids
  ascend in that order — while the topology's wave lists them amer, apac, emea, govcloud.
  `getLatestPlanForChange`'s target query carries no `ORDER BY` at all, so the order
  reconcile sees is the insertion order of the wave's targets — the wave's. Sorted
  ascending is therefore the exact REVERSE of it.
* FREEZES. The atomic freeze is created FIRST (lowest id) and the plain one SECOND, and the
  covering set for `apac` is built as [its own] ++ [the atomic ones] — i.e. highest id
  first. Sorted ascending flips it.
```

Delete either sort and the corresponding assertion below goes red. That matters because `restatesDecision` canonicalizes object KEYS only: array element order is significant, so an unsorted array plus a reordered query result is one new Decision row per second, for weeks — ADR-0024's measured 1.44 GB/day rebuilt from parts.

## §6. EQUALITY IS ITS OWN CASE

EQUALITY IS ITS OWN CASE. The comparison shipped as `endsAt < before.endsAt ? "shortened" : "extended"`, which folds "the same instant" into the extension arm — so re-saving a freeze-editing form without touching the field (the ordinary shape of a UI PATCH, and the UI this increment unblocks is the next session's) wrote a HASH-CHAINED audit event claiming an extension that did not happen, alongside a Decision asserting `from === to`. Principle 6 is about a record that reconstructs what occurred; a record of a governance edit that did not occur fails it in the direction that is hardest to notice, because nothing looks broken.

## §7. M25.9 — THE ACTOR LADDER

M25.9 — THE ACTOR LADDER. OWNER RULING D1 (2026-08-25), `campaigns-rework.md` §1.7 exit (b).

`freeze:override` is required to LIFT or SHORTEN a freeze YOU DID NOT DECLARE (compared on `freezes.created_by_actor_id`); your own stays `freeze:write`. M25.1 shipped the lift on `freeze:write` alone, which made the WIDER-reaching verb take the NARROWER permission: an Administrator at service S could retract an Owner's S-scoped freeze FOR EVERYONE with a permission they already held, where the Owner-only `freeze:override` admits exactly ONE change.

WHY THE SCOPE CASES ABOVE DID NOT ALREADY COVER THIS: `freeze:write` at S covers every freeze at S no matter who declared it, so an Administrator and an Owner bound at the same service are indistinguishable to a scope check. Authorship is the dimension scope cannot express, so every ACTOR case below puts TWO ACTORS AT THE SAME SCOPE — a one-actor version is green against a route with no actor comparison in it at all. The one deliberate exception is the final SCOPE case, whose two actors are bound at different scopes on purpose; see its own header.

THE STANDING MUTATION GATES FOR THIS BLOCK. `assertMayRetractAnothersFreeze` in `routes/governance.ts` has TWO parameters that decide the verdict — WHO declared the freeze and WHICH SCOPE the override is demanded at — and each needs its own gate, because a suite that measures one of them is not measuring the other. All three were run ALONE against a passing suite on 2026-08-25 and the named cases are the ones that actually died:

```text
1. DELETE the `freeze.createdByActorId === auth.subjectObjectId` early return — every
   retraction then demands the override. This kills the ALLOW-YOUR-OWN arms, NOT the
   refusals: "an Administrator lifts THEIR OWN freeze" and the second case's closing arm
   (bob lifts a freeze he declared) both 403 where they require 200, and the pre-existing
   `M25.1 authz` SCOPE case ("`freeze:write` at a service cannot lift the ORG-ROOT freeze")
   dies with them, on its own closing control arm, for the same reason. RE-RUN 2026-08-25:
   those THREE and nothing else. Named precisely because there are two `M25.1 authz` cases
   and the OTHER one — the Viewer/Operator case — correctly survives: it asserts refusals
   only, and a mutation that makes the route stricter cannot red a refusal. Note what that
   means generally: deleting the guard makes the route STRICTER, so a block asserting only
   refusals would survive it untouched. The own-freeze arms are the half of the ruling this
   mutation measures.
2. INVERT it to `!==` — the override is then demanded of the DECLARING actor and of nobody
   else, which is the mutation the refusals answer. Five of the six cases here go red:
   "expected 200 to be 403" on the lift refusal, on the PATCH shortening arm, on the
   locked-direction case, and on the scope case's service-Administrator control; the
   own-freeze case 403s. Only "an OWNER holds `freeze:override`" survives, because the Owner
   clears the bar under either spelling.
3. CHANGE `scopeObjectId: freeze.scopeObjectId` TO `auth.orgId` — the FINAL case ("the
   override is demanded at THE FREEZE'S OWN SCOPE") goes red with a bare `Forbidden`, and it
   is the ONLY case in the file that moves. Nothing else here can see that parameter: every
   other actor in this block is bound at the ORG ROOT, where the two spellings name the same
   scope, so all five of the others pass under EITHER. That gate was added after review found
   the second parameter argued at length in a route comment and pinned by nothing.
```
