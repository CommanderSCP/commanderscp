# iac

Long-form reference for the **iac** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 327 of 329 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/coordination-as-code/estate-migration.integration.test.ts`](#apps-server-src-iac-estate-migration-integration-test-ts) — §1–§2
- [`apps/server/src/coordination-as-code/iac-administrative-floor.integration.test.ts`](#apps-server-src-iac-iac-administrative-floor-integration-test-ts) — §3–§3
- [`apps/server/src/coordination-as-code/iac-adopt.integration.test.ts`](#apps-server-src-iac-iac-adopt-integration-test-ts) — §4–§5
- [`apps/server/src/coordination-as-code/iac-campaign-deadline-widening.integration.test.ts`](#apps-server-src-iac-iac-campaign-deadline-widening-integration-test-ts) — §6–§17
- [`apps/server/src/coordination-as-code/iac-dependency-producers.integration.test.ts`](#apps-server-src-iac-iac-dependency-producers-integration-test-ts) — §18–§23
- [`apps/server/src/coordination-as-code/iac-governance-move-rungs.integration.test.ts`](#apps-server-src-iac-iac-governance-move-rungs-integration-test-ts) — §24–§27
- [`apps/server/src/coordination-as-code/iac-member-of-role-escalation.integration.test.ts`](#apps-server-src-iac-iac-member-of-role-escalation-integration-test-ts) — §28–§28
- [`apps/server/src/coordination-as-code/iac-pair-bound-types.integration.test.ts`](#apps-server-src-iac-iac-pair-bound-types-integration-test-ts) — §29–§30
- [`apps/server/src/coordination-as-code/iac-pipeline-hooks.integration.test.ts`](#apps-server-src-iac-iac-pipeline-hooks-integration-test-ts) — §31–§38
- [`apps/server/src/coordination-as-code/iac-placement-bindings.integration.test.ts`](#apps-server-src-iac-iac-placement-bindings-integration-test-ts) — §39–§42
- [`apps/server/src/coordination-as-code/iac-placements.integration.test.ts`](#apps-server-src-iac-iac-placements-integration-test-ts) — §43–§45
- [`apps/server/src/coordination-as-code/iac-rbac-apply.ts`](#apps-server-src-iac-iac-rbac-apply-ts) — §46–§46
- [`apps/server/src/coordination-as-code/iac-rbac.integration.test.ts`](#apps-server-src-iac-iac-rbac-integration-test-ts) — §47–§49
- [`apps/server/src/coordination-as-code/iac-rollouts-convergence.integration.test.ts`](#apps-server-src-iac-iac-rollouts-convergence-integration-test-ts) — §50–§51
- [`apps/server/src/coordination-as-code/iac-stack-ownership.integration.test.ts`](#apps-server-src-iac-iac-stack-ownership-integration-test-ts) — §52–§53
- [`apps/server/src/coordination-as-code/plan-diff.test.ts`](#apps-server-src-iac-plan-diff-test-ts) — §54–§57
- [`apps/server/src/coordination-as-code/plan-diff.ts`](#apps-server-src-iac-plan-diff-ts) — §58–§102
- [`apps/server/src/coordination-as-code/plans-repo.ts`](#apps-server-src-iac-plans-repo-ts) — §103–§164
- [`apps/server/src/coordination-as-code/rollout-convergence-repo.ts`](#apps-server-src-iac-rollout-convergence-repo-ts) — §165–§165
- [`apps/server/src/coordination-as-code/stack-ownership.ts`](#apps-server-src-iac-stack-ownership-ts) — §166–§169
- [`packages/coordination-as-code/src/behaviors.test.ts`](#packages-iac-src-behaviors-test-ts) — §170–§171
- [`packages/coordination-as-code/src/behaviors.ts`](#packages-iac-src-behaviors-ts) — §172–§177
- [`packages/coordination-as-code/src/canonical.ts`](#packages-iac-src-canonical-ts) — §178–§178
- [`packages/coordination-as-code/src/construct.determinism.test.ts`](#packages-iac-src-construct-determinism-test-ts) — §179–§181
- [`packages/coordination-as-code/src/construct.test.ts`](#packages-iac-src-construct-test-ts) — §182–§196
- [`packages/coordination-as-code/src/construct.ts`](#packages-iac-src-construct-ts) — §197–§252
- [`packages/coordination-as-code/src/duration.ts`](#packages-iac-src-duration-ts) — §253–§253
- [`packages/coordination-as-code/src/estate-program.test.ts`](#packages-iac-src-estate-program-test-ts) — §254–§256
- [`packages/coordination-as-code/src/estate-program.ts`](#packages-iac-src-estate-program-ts) — §257–§262
- [`packages/coordination-as-code/src/index.ts`](#packages-iac-src-index-ts) — §263–§266
- [`packages/coordination-as-code/src/infra.test.ts`](#packages-iac-src-infra-test-ts) — §267–§267
- [`packages/coordination-as-code/src/infra.ts`](#packages-iac-src-infra-ts) — §268–§275
- [`packages/coordination-as-code/src/pipeline-behaviors.l1.test.ts`](#packages-iac-src-pipeline-behaviors-l1-test-ts) — §276–§278
- [`packages/coordination-as-code/src/pipeline.placeAt.typecheck.test.ts`](#packages-iac-src-pipeline-placeat-typecheck-test-ts) — §279–§279
- [`packages/coordination-as-code/src/pipeline.test.ts`](#packages-iac-src-pipeline-test-ts) — §280–§280
- [`packages/coordination-as-code/src/pipeline.ts`](#packages-iac-src-pipeline-ts) — §281–§294
- [`packages/coordination-as-code/src/products.placeAt.typecheck.test.ts`](#packages-iac-src-products-placeat-typecheck-test-ts) — §295–§295
- [`packages/coordination-as-code/src/products.test.ts`](#packages-iac-src-products-test-ts) — §296–§299
- [`packages/coordination-as-code/src/products.ts`](#packages-iac-src-products-ts) — §300–§304
- [`packages/coordination-as-code/src/rbac.test.ts`](#packages-iac-src-rbac-test-ts) — §305–§305
- [`packages/coordination-as-code/src/rbac.ts`](#packages-iac-src-rbac-ts) — §306–§309
- [`packages/coordination-as-code/src/render.test.ts`](#packages-iac-src-render-test-ts) — §310–§310
- [`packages/coordination-as-code/src/render.ts`](#packages-iac-src-render-ts) — §311–§315
- [`packages/coordination-as-code/src/scaffold.ts`](#packages-iac-src-scaffold-ts) — §316–§317
- [`packages/coordination-as-code/src/urn.ts`](#packages-iac-src-urn-ts) — §318–§319
- [`packages/coordination-as-code/src/waves.ts`](#packages-iac-src-waves-ts) — §320–§325
- [`packages/coordination-as-code/vitest.config.ts`](#packages-iac-vitest-config-ts) — §326–§327

## `apps/server/src/coordination-as-code/estate-migration.integration.test.ts`

### §1. THE ESTATE MIGRATION, END TO END

THE ESTATE MIGRATION, END TO END (proposal section 9; increment 7).

THE QUESTION THIS ANSWERS, WHICH NOTHING ELSE DID
Two halves were each proven and never joined. `scp iac export` round-trips through the real `tsc` and compares synth output (`iac-estate-program.roundtrip.test.ts`); adoption is driven through the real routes (`iac-adopt.integration.test.ts`). Neither runs the JOURNEY an org actually takes:

```text
  an estate that already exists in SCP, unmanaged
    -> `scp iac export` reads it
    -> the emitted program synthesizes a manifest
    -> `POST /plans` + apply lands it
    -> every object is ADOPTED, and NOTHING IS DUPLICATED
```

The failure this guards against is specific and was live once: export derived the release-topology URN from a construct id with no override, so applying an exported estate CREATED A SECOND TOPOLOGY beside the original, repointed `releases_via` at it, and orphaned the live one — while the plan read as a clean set of creates. `adoptTopologyUrn` fixed that, and this is the test that would have caught it from the outside.

A DUPLICATE IS COUNTED, NOT INFERRED. Every assertion below counts live rows by type and name before and after; "the plan looked right" is exactly the evidence that failed last time.

WHAT IT FOUND ON ITS FIRST RUN — a 500, not an assertion failure

`prepareApplyChecks` skipped `noop` relationship entries entirely, so their endpoints were never resolved into `objectResolutions`. `executePlanDiff` then stamps relationship ownership over every `action !== "delete"` entry — INCLUDING noops — and `endpointId` throws an internal error for a URN this pass never resolved. Applying an exported estate therefore returned a 500.

It is the adoption path specifically, which is why nothing else caught it: an ordinary stack declares its own objects, so their URNs resolve in the object loop. An exported estate REFERENCES its service (`Service.fromUrn`) and re-declares the `contains` edge that already exists — every endpoint a reference, every entry a noop. Fixed by resolving endpoints for every non-delete entry while still checking permissions only for the rest.

MUTATION LOG - each applied, watched fail, reverted, watched pass (MEASURED) | Mutation | Result |
| `prepareApplyChecks` goes back to skipping noop relationships before resolving | BOTH cases FAIL with the original 500 | | `Pipeline` drops `adoptTopologyUrn`, so export cannot adopt the live topology | (1) FAILS with a **409 `cardinality 'many_to_one' violated`** — worth recording precisely, because it is not the silent duplicate the original defect produced: `releases_via` is one-per-component (0049), so today the second topology is refused at the edge rather than created beside the first. The defect's blast radius shrank when that index landed; the adoption path still needs the override, and this case still catches its absence. |

### §2. A RELEASE TOPOLOGY AND ITS `releases_via` EDGE

A RELEASE TOPOLOGY AND ITS `releases_via` EDGE — without them the export emits no pipeline, and the duplication defect this test exists to catch lives precisely in the topology: export once derived the topology URN from a construct id with no override, so applying an exported estate created a SECOND topology beside the live one and repointed `releases_via` at it. An estate with no topology cannot catch that, so the fixture has one.

## `apps/server/src/coordination-as-code/iac-administrative-floor.integration.test.ts`

### §3. THE ADMINISTRATOR FLOOR IS AT THE CHOKE POINT, NOT AT THE ROUTE

THE ADMINISTRATOR FLOOR IS AT THE CHOKE POINT, NOT AT THE ROUTE — proven through IaC APPLY

`docs/authz/role-binding-door.md` §7's floor is enforced from `graph/relationships-repo.ts`'s `deleteRelationship` and `graph/objects-repo.ts`'s `deleteObject`, not from `routes/relationships.ts` and `routes/objects-generic.ts`. `routes/rbac-administrative-floor.integration.test.ts` measures every refusal through the HTTP doors and **cannot tell the difference** — move both calls up into the route handlers and that whole file stays green.

THIS FILE IS THE DIFFERENCE. `iac/plans-repo.ts` PRUNES: an object or a relationship that a stack used to declare and no longer does is deleted on the next apply, through `deleteRelationship` (`plans-repo.ts:1490`) and `deleteObject` (`:1950`) directly — never through an HTTP route. So a route-level floor would leave `POST /plans/{id}/apply` able to prune the `member_of` edge that makes an org's administrators reachable, and the org would be bricked by a manifest edit.

That is not a hypothesis about this file: the campaign-deadline guard in this same programme shipped at the route, was measured bypassable through IaC apply, and had to be moved to the `updateObject` choke point — and §2a's own guard needed the identical proof, which is the sibling file `iac-member-of-role-escalation.integration.test.ts`.

MUTATION LOG — applied ALONE, CONFIRMED ON DISK, measured, reverted (2026-08-27)
1. `graph/relationships-repo.ts` — the floor call MOVED into `routes/relationships.ts`'s DELETE handler (the "obvious" placement), byte-identical call, import added, `tsc --noEmit` clean -> **1 failed, and ONLY here; the route suite passed 8/8.** `the pruning apply must be REFUSED, not resolved: expected null to be an instance of ScpApiError`. `routes/rbac-administrative-floor.integration.test.ts` went fully green — door B's refusal, door C's refusal, every admission pair — while the pruning apply resolved and left the org holding an administrative binding no live principal resolves through. THIS IS THE MEASUREMENT THE PLACEMENT IS ABOUT. 2. `graph/relationships-repo.ts` — the floor call deleted outright -> **2 failed:** here, and door B in the route suite. One deletion, both doors. 3. `authz/role-binding-door.ts` — `assertOrgRetainsAdministrativeFloor` early-returns -> **8 failed across three files**, this one included. The full list is in the route suite's mutation log.

NOT MUTATION-PROVEN here: the `deleteObject` prune arm (`plans-repo.ts:1950`). This case prunes a RELATIONSHIP; an IaC apply that prunes the administrators TEAM object goes through the other choke point and is covered by the same predicate, but no case fires it. Named rather than implied.

## `apps/server/src/coordination-as-code/iac-adopt.integration.test.ts`

### §4. ADOPTION, AND THE THEFT IT IS NOT (proposal section 9, increment 7)

ADOPTION, AND THE THEFT IT IS NOT (proposal section 9, increment 7).

Two halves of one read of `managed_by_stack`:

1. **Adoption is legal and VISIBLE.** A stack may claim an object no stack manages — that is how an existing estate comes under IaC, and the whole purpose of `scp iac export`. Section 9 requires the plan to SAY SO, because it is the one action whose blast radius is invisible from the manifest alone: the manifest looks identical whether the URN is new or forty other things already point at it.

2. **Cross-stack adoption is refused.** Before this, `stampObjectStackOwnership`'s predicate was `managed_by_stack IS NULL OR <> $stack`, so an apply re-stamped ANY object in its diff, including one another stack owned — its own header treated that as the design. The effect was silent takeover, after which the losing stack's next apply either proposes deleting rows it no longer owns, or proposes nothing for an object it still believes it manages.

MUTATION LOG - each applied, watched fail, reverted, watched pass (MEASURED) | Mutation | Result |
| `computePlanDiff` stops collecting ownership conflicts | (3) FAILS — the thief's plan computes and the takeover proceeds | | `prepareApplyChecks` skips `assertNoStackTheftAtApply` | (4) FAILS — a plan computed while the object was unmanaged still steals it after another stack claimed it. (3) stays GREEN, which is the point of having both doors: plan-time alone does not cover the review-then-apply gap. | | the `adopted` qualifier is never set | (1) and (2) FAIL — an adoption becomes indistinguishable from an ordinary update |

### §5. A measured correction to this case's first expectation

MEASURED CORRECTION to this case's first version, which expected a plain adoption to be a `noop`: it is not, and cannot be. `managedLabels()` is merged into the diff target, so adopting an unmanaged object always changes `labels` at minimum and therefore always shows as an `update`. Asserting `noop` there was asserting something false about the design.

The branch IS reachable, and only through the hazard `managed_by_stack` was introduced for (drizzle/0068): someone hand-writes the descriptive labels onto an object at plain `object:write`, so the labels claim IaC ownership while the server-written column says nobody owns it. The declared state then matches byte-for-byte — a genuine `noop` — while ownership still changes on apply. Calling that a plain no-op would hide the only thing that happens, which is precisely the "a description is not an assertion" failure.

## `apps/server/src/coordination-as-code/iac-campaign-deadline-widening.integration.test.ts`

### §6. THE IaC DOOR ONTO A CAMPAIGN'S DEADLINE

THE IaC DOOR ONTO A CAMPAIGN'S DEADLINE — owner ruling 2026-08-25 (decision D1, option b-i)

## The bypass this closes

The ruling — *clearing a campaign's deadline, or moving it to a later instant, costs the Owner-only `campaign:deadline-override` on top of `object:write`* — shipped as a check inside the handler for `POST /api/v1/campaigns/{id}/deadline`, and nowhere else.

`campaign.properties` has THREE write doors. `governance/campaign-recipe-guard.ts` wrote that census down one milestone earlier, for this exact property bag, and said in as many words that a route-level guard is invisible to two of them. IaC apply is door 2: `iac/plans-repo.ts`'s `executePlanDiff` calls `updateObject` DIRECTLY with a free-form `typeId` and free-form `properties`, `writePermissionFor("campaign")` returns plain `object:write`, and the update branch's only campaign-specific check reads `targets`. `plan-diff.ts` diffs `properties` WHOLESALE and the apply replaces them wholesale, so a manifest that simply OMITS `deadline` deletes it.

MEASURED, not reasoned about — see the mutation log below. With the choke-point guard removed (the pre-guard tree), an Operator holding org-root `object:write` and no `campaign:deadline-override` gets a **200** from `POST /plans` + `/plans/{id}/apply` and the deadline is gone from the stored row: no reason, no Decision, no `loosening` label, no `campaign.deadline.set` audit event, and every target the campaign was withholding its changes from releases on the next tick. That is exactly the effect the route refuses that same subject with a 403 (`coordination/campaign-deadline.integration.test.ts` E5), at exactly the permission the route was raised above.

## What these cases assert, and why they are not about an error message

That the STORED deadline is unchanged after a refusal, and actually changed after an admitted write. A refusal that still wrote the row would satisfy a status-code assertion.

BOTH DIRECTIONS, ONE SUBJECT, ONE CAMPAIGN — that is R3, and it is the case that carries the argument. The same Operator, on the same campaign, through the same door, is ADMITTED the shortening and the unchanged restatement and REFUSED the removal. So what they lack is `campaign:deadline-override` and not standing on the campaign; a refusal-only file would be equally green against a guard that simply refused every IaC write touching a campaign, which would take IaC-managed deadlines away from everyone below Owner.

## Mutation log (each applied ALONE against a green suite, then reverted — house rule)

| Mutation | Result |
| neutralise `assertMayWidenCampaignDeadline` entirely (an unconditional `return` at its head, which is what deleting its call from `graph/objects-repo.ts`'s `updateObject` amounts to) — i.e. restore the hole | **R1, R2, R3, R6, W1 and W4 FAIL** (6 failed / 5 passed, RE-MEASURED once the waiver cases landed). R1: `AssertionError: dropping the key from the manifest deletes the deadline, which releases every withheld target — the same act the route refuses: expected 200 to be 403`. R2: `... 'drop the key' becomes 'set it to 2099': expected 200 to be 403`. R3: `the same subject, the same campaign, the same door — only the direction changed: expected 200 to be 403`. R6: `a deadline nobody can parse withholds nothing — it is a clear wearing the key: expected 200 to be 403`. W1 and W4 as recorded in the waiver log below. The 200s are the bypass itself: the apply succeeded and the deadline was gone from the row, or the Operator's own component was excused from it. | | narrow the guard's equality test so an UNCHANGED instant reads as a widening (`slipped`'s `incoming.at > stored.at` becomes `>=`) | **R3, W3, W4 and W5 FAIL** (4 failed / 7 passed, RE-MEASURED once the waiver cases landed). R3: `AssertionError: restating a deadline releases nobody: expected 403 to be 200`. W3/W4/W5 fail because they hold the instant still on purpose: W4's 403 body reads `moves the deadline later, from '2026-11-23T21:01:34.000Z' to '2026-11-23T21:01:34.000Z'`, which is the mutation naming itself. | | give the guard `routes/campaigns.ts`'s FLAT rule (a removal is escalated even when nothing readable was stored) | **R5 FAILS**: `AssertionError: nothing was being withheld, so this write releases nobody: expected 403 to be 200` — every deadline-less campaign in the estate would need an Owner to re-apply. MEASURED against the R cases alone, before the waiver cases below existed; none of those stores an unreadable deadline, so re-measuring cannot change the row. |

R3 EARNED ITS PLACE ON THAT LIST THE HARD WAY, and the first draft is recorded because the trap is general. Written as a plain re-apply of the identical manifest it was VACUOUS: byte-identical properties make the diff entry a `noop`, `executePlanDiff` never calls `updateObject`, and the mutation above left the file 6/6 green. See the case body for what it does instead.

## What is deliberately NOT here

The `federationImport` half. `updateObject` runs this guard inside the block that exempts imports, and that exemption is load-bearing: `federation/import-repo.ts`'s `object_upsert` branch has no try/catch, so one permission refusal there wedges a peer's whole signed bundle — and the importing instance holds no role bindings for the exporting domain's operator, so EVERY imported campaign whose deadline moved later would wedge it. Hand-fill, the other supplier of that flag, cannot reach a locally authored campaign at all: it passes a FOREIGN `originDomainId`, so `updateObject`'s single-writer check 409s first (`federation/handfill-repo.ts`).

### §7. A campaign with one target and a deadline, plus the stack

A campaign with ONE component target and a deadline, plus the stack name and urn a manifest needs to address it.

THE DEADLINE IS AUTHORED AT CREATE TIME (`POST /api/v1/campaigns`, which `CreateCampaignRequestSchema` lets carry one) rather than through `POST /campaigns/{id}/deadline`. Two reasons, and the second is the point: it is one call instead of two, and it means the fixture never exercises the route-level check these cases are here to prove is insufficient on its own. A create is always a FIRST set, so it takes plain `object:write` either way and the setup does not depend on the ruling it is testing.

The urn is DECLARED rather than derived: `CreateCampaignRequestSchema` accepts one, and a test that re-implemented `deriveUrn`'s slug rules would be asserting its own arithmetic.

### §8. ---- RESTATE THE SAME INSTANT IN A DIFFERENT RENDERING

---- RESTATE THE SAME INSTANT IN A DIFFERENT RENDERING. Two things at once, and both are the reason it is written this way rather than as a plain re-apply of the identical manifest:

```text
1. IT REACHES THE GUARD AT ALL. A byte-identical re-apply is a `noop` in the diff, so
   `executePlanDiff` never calls `updateObject` and the comparison is never made — a case
   that would pass with the whole guard deleted AND with the comparison inverted, which is
   the definition of vacuous. MEASURED: written as a plain re-apply, mutating the guard's
   `<=` to `<` left this file 6/6 green. Changing the milliseconds makes `properties`
   textually different, so the entry is a real `update`.
2. IT PINS THE COMPARISON TO PARSED INSTANTS, never to the ISO strings. `...T00:00:00Z` and
   `...T00:00:00.000Z` are the same instant and both are accepted by `z.string().datetime()`,
   but they sort the WRONG WAY as strings (`'Z' > '.'`) — so a string compare here would read
   an unchanged deadline as a slip and demand an Owner for a no-op re-apply.
```

### §9. And now the other direction, on the same campaign

---- AND NOW THE OTHER DIRECTION, ON THIS SAME CAMPAIGN AND FROM THIS SAME SUBJECT. This is what makes the two 200s above mean something: the Operator is refused the widening not because they lost standing on the campaign somewhere along the way, but because of the DIRECTION of the write. A refusal-only case and an admission-only case cannot draw that distinction between them; only one subject exercising both can.

### §10. The bootstrap admin is an owner, which is where it sits

The bootstrap admin is an org-root Owner, which is where drizzle/0088 put `campaign:deadline-override`, and `hasPermission` expands the checked scope UPWARD from the campaign to reach it. If the guard were mis-scoped — resolved at a target, say, or at some object an org-root binding does not reach — THIS is what would fail, and the failure would be "IaC can no longer manage a deadlined campaign at all".

### §11. The case that makes the flat rule untenable

THE CASE THAT MAKES THE FLAT RULE UNTENABLE, and the reason this guard asks a NARROWER question than `routes/campaigns.ts` does. The route treats a clear as escalated even over a campaign with no readable deadline, so that a status code cannot leak stored state. Applying that rule here would demand an Owner for every routine re-apply of every deadline-less campaign in the estate — the manifest omits `deadline` on every single one of them.

### §12. The resolver calls this malformed, and the loop then

`resolveCampaignDeadline` reports this as `malformed`, and `campaign-reconcile.ts` fails OPEN on a malformed bag — it locks nothing and writes a `warn`. So in EFFECT this releases exactly the targets a clear would, which is why it is priced like one. A guard that merely asked "is the `deadline` key still present?" would let this through, and the bypass would be one typo wide.

Reachable only through a free-form-`properties` door: `CampaignDeadlineInputSchema` refuses it at both typed authoring doors. That is exactly what makes it this file's business.

### §13. R1-R6 above closed the deadline INSTANT at this door

R1-R6 above closed the deadline INSTANT at this door. They were censused by SYMPTOM (`deadline.at`) rather than by PROPERTY — *any edit to the stored deadline document that releases a withheld target* — and the second half of that document was left wide open.

MEASURED through the HTTP API on the tree those cases shipped on: an Operator who keeps `at` BYTE-IDENTICAL, so the instant test sees no widening at all and returns, while adding a fully-formed `overrides` entry naming their own component, gets a **200**; `findEffectiveDeadlineOverride` then excuses that target on the next tick. Enumerating every target reproduces a CLEAR exactly, at exactly the permission the ruling raised the act above. CONTROL measured alongside: the same Operator on `POST /campaigns/{id}/deadline-override` → 403.

The guard's own doc block asserted this vector could not exist ("`overrides[]` ARE NOT READ … a per-target waiver is minted by `POST /campaigns/{id}/deadline-override`, which already demands this exact permission"). That is true of the typed door and false of this one, which is why the comment is corrected in the same change as the code.

## Mutation log (each applied ALONE against a green suite, then reverted — house rule)

See the file-level log for R1-R6; the waiver half adds:

| Mutation | Result |
| delete the `waived`/`widenedWaiverTargets` half of `assertMayWidenCampaignDeadline`, leaving the instant test — i.e. restore the hole | **W1 AND W4 FAIL** (2 failed / 9 passed). W1: `AssertionError: the instant never moved, so only the waiver can be refusing this — and a waiver is exactly what /deadline-override refuses this subject: expected 200 to be 403`. W4: `AssertionError: moving a waiver's expiry later excuses the target for longer, which releases it: expected 200 to be 403`. Both 200s ARE the bypass: the apply succeeded and the Operator's own component was excused from the campaign's deadline. R1-R6, W2, W3 and W5 stay green — they are the instant half and the admit directions, which this delta must leave exactly as they were. | | loosen `widenedWaiverTargets`'s comparison from `reach > storedReach` to `>=`, so a waiver RESTATED unchanged reads as an addition | **W3 FAILS**: `AssertionError: IaC re-applies an unchanged manifest constantly — a round-trip releases nobody: expected 403 to be 200`. The flat-refusal failure mode in miniature: every routine re-apply of any campaign carrying one waiver would demand an Owner. | | give the delta `governanceLabelDelta`'s rule instead — a target present in `before` and absent from `after` counts as changed, i.e. REMOVAL is the attack | **W5 FAILS**: `AssertionError: re-locking an excused target releases nobody: expected 403 to be 200`. W3 stays green under it (its restatement keeps every target), which is why W5 has to exist separately to pin that direction. |

W1 CANNOT GO GREEN THROUGH R6's BRANCH, and that is closed at the top of the case rather than argued: the document it sends is asserted to PARSE under `CampaignDeadlineSchema` before it is sent, so `resolveCampaignDeadline` reports `deadline` and not `malformed`, and its `at` is the stored one byte for byte. Without that assertion a typo in the fixture would make W1 green as a restatement of R6 — the second-sufficient-cause trap this file already fell into once at R3.

### §14. A fully-formed waiver, minted the way a MANIFEST mints one

A fully-formed waiver, minted the way a MANIFEST mints one: every field `/deadline-override` fills in from the authenticated act is simply ASSERTED here, `actorId` included. That is the attribution residue the guard's doc names — this delta prices the RELEASE, not the claim about who granted it.

### §15. MINTED THROUGH THE TYPED DOOR, by the Owner. Two things at once

MINTED THROUGH THE TYPED DOOR, by the Owner. Two things at once: it is the honest way to get a waiver into the row, and it PROVES THIS GUARD DOES NOT DOUBLE-CHARGE THAT ROUTE — `overrideCampaignDeadline` writes through `updateObject`, so its own write reaches the guard with a delta that is non-empty by construction and must pass on the permission it already resolved one frame earlier. A guard that refused there would 403 the only door that mints waivers at all.

### §16. ---- RE-APPLY THE IDENTICAL WAIVERS. NOT a byte-identical manifest

---- RE-APPLY THE IDENTICAL WAIVERS. NOT a byte-identical manifest: that is a `noop` in the diff, `executePlanDiff` never calls `updateObject`, and the case would pass with the whole guard deleted — R3 learned that the hard way and the trap is general. Re-rendering `at` (`.000Z` -> `Z`) makes `properties` textually different, so the entry is a real `update` and the comparison is actually made, while the instant and every waiver stay exactly as stored.

### §17. The deliberate divergence from the sibling four lines up

THE DELIBERATE DIVERGENCE FROM `governanceLabelDelta`, which sits four lines away in `updateObject` and treats a REMOVAL as the whole attack. A governance label is a MATCH KEY — deleting it makes a constraint stop applying. A waiver is a RELEASE — deleting it puts the target back under the deadline, withholding strictly more. Pricing this at Owner would demand one for the routine re-apply that follows a waiver's deliberate removal.

## `apps/server/src/coordination-as-code/iac-dependency-producers.integration.test.ts`

### §18. THE IaC RUNG OF THE PRODUCER DECLARATION

THE IaC RUNG OF THE PRODUCER DECLARATION (charter principle 3: API -> SDK -> CLI -> IaC -> UI).

THE ONE RULE THAT MAKES THIS COLLECTION DIFFERENT, AND WHY THE FIRST TEST IS THE ONE IT IS
`sourceMappings`, `executorBindings` and `placements` treat an ABSENT collection and an EMPTY one as the same thing, and both PRUNE. `plan-diff.ts` is emphatic about it and records that changing it broke three `plans.integration` tests.

`producers` DIVERGES, by owner ruling (2026-08-17): AN ABSENT KEY MEANS UNMANAGED AND PRUNES NOTHING. Pruning a mapping costs a route an operator notices the same day; pruning a producer declaration hands a coordinate the org PUBLISHES back to a public index on a daily poll timer, and the symptom is an ABSENCE of dependency updates — dependency confusion (ADR-0032 §7b clause 1) re-armed by a stack that merely forgot a key. So the first case here is the NEGATIVE one: a stack with a standing declaration, whose manifest omits the key, must produce NO producer diff entries at all and leave the declaration alone.

The positive rule is in the same file because the two are only correct TOGETHER: a present collection IS authoritative over its own members, or "unmanaged on absent" would mean IaC could add a declaration and never remove one.

WHAT EACH GATE REFUSES TO BE SATISFIED BY
1. **THE RULING.** Not "the plan summary is zero" — that would pass if the entries existed and happened to be noops. The assertion is that `diff.producers` is ABSENT, and that the row is still there after an apply of that plan. 2. **WIRING.** `executePlanDiff` must actually write the row. Named so the mutation is obvious: delete the producer block from `executePlanDiff` and "(2) WIRING" goes red while everything that only reads the DIFF stays green. That asymmetry is the whole point — a plan that SHOWS a create and an apply that PERFORMS one are two different claims, and this repo has shipped the first without the second before. 3. **THE WHOLE ACT, NOT THE ROW.** A declaration clears every covered line's observed head, records a Decision and appends an audit event. A second door that writes only the row arms the exact failures the verb exists to prevent (a poisoned public head surviving the declaration meant to undo it) and makes `routes/dependency-producers.ts`'s claim that `GET /decisions?kind=dependency_line_producer` lists every declaration FALSE. 4. **THE MEMBER QUESTION**, settled behaviourally: removing B from `[A, B]` prunes B and leaves A. 5. **THE TRANSFER**, which is this collection's own hazard: identity is the COORDINATE and the table upserts, so a declaration changes hands with NO row deleted. Owning the destination component is not enough. 7. **THE PLAN/APPLY WINDOW.** Every refusal in (5) is derived from the STORED diff — deliberately, so a plan written by an older build is re-checked — and that is exactly what makes the diff's account of WHO HOLDS the coordinate un-recheckable once the world moves. Three shapes, three different wrong outcomes, all silent; the `delete` one RETRACTS SOMEBODY ELSE'S declaration. 8. **THE AUTHORITY**, which was present and held by NOTHING — see (8)'s own header. 9. **A HOLDER THAT CANNOT BE NAMED IS STILL A HOLDER.** A tombstoned producer component leaves its declaration standing, and the snapshot's null-drop made the diff report `create` about a coordinate that is declared.

MUTATION LOG — each applied, watched fail, reverted, watched pass
| Mutation | Measured |
| "fix the inconsistency" in FULL — absent maps to `[]` AND the prune pool is read unconditionally | 1 fails: "(1) an ABSENT producers key…", on the SUBSTANTIVE assertion — `expected undefined to be '<producer id>'`, i.e. the standing declaration was pruned. This is the catastrophic direction and it is the one the message names | | the WEAKER half alone — absent maps to `[]`, prune pool still gated | the same 1 fails, now on the shape: `expected [] to be undefined`. Recorded separately because a half-edit that prunes nothing today is what the next edit completes | | delete both producer loops from `executePlanDiff` | 7 of 11 fail, "(2) WIRING" among them. The 4 that stay green are exactly the plan-time refusals — "(5) cannot declare on a component it does not manage", "(5) SERVICE-valued", and both "(6)" cases — which is the asymmetry the wiring gate exists to expose | | `declareProducerWithEffects` -> a bare `declareDependencyLineProducer` in the apply path | exactly 2 fail: "(3) …CLEARS a poisoned public head" (`expected '2.99.0' to be null`) and "(3) …records its own Decision…". "(2) WIRING" STAYS GREEN — which is precisely why a row-exists gate is not sufficient on its own | | drop the `displacedProducerUrn` guard from `invalidProducerDeclarations` | 1 fails: "(5) a stack cannot TAKE a coordinate…" — the plan is accepted instead of rejected. `plan-diff.test.ts`'s unit case fails alongside it | | drop the commander-only block from `routes/plans.ts`'s apply | 1 fails: "(6) …is refused on a deployment that is not a declared commander" — the apply resolves with a 200 | | drop both `assertPlannedProducerHolder` calls from `executePlanDiff` | exactly 3 fail, one per shape, each on the SUBSTANTIVE assertion rather than on the refusal: CREATE and UPDATE read `expected '<the stack's component>' to be '<the interloper>'` — the coordinate was taken from the component that claimed it in the window — and DELETE reads `expected undefined to be '<the interloper>'`, the silent retraction. "(7) …a plan whose world did NOT move still applies" stays green, so the guard is proven to be about DISAGREEMENT and not about refusing to re-apply | | delete `checks.push(dependencyProducerScopeCheck(orgId))` from `prepareApplyChecks` | exactly 1 fails: "(8)(b) …the SAME Operator is REFUSED a plan that declares one" — `promise resolved … instead of rejecting`, the plan applies with `creates: 4` and the declaration is written by a principal holding `policy:write` nowhere. "(8)(a)" stays green, which is what makes the 403 a statement about the collection rather than about Operators and plans | | restore the shared null-drop — `toExisting = toManaged`, both pools filtered | exactly 1 fails: "(9) a coordinate whose producer component was deleted…" — `POST /plans` resolves instead of rejecting, and the diff it returns reads `"action":"create"` with the reason `no producer is declared for … it is polled as third-party today` about a coordinate that IS declared. Measured on the same run: the apply is then stopped by (7)'s guard with `409 … it was computed when the coordinate was declared by nobody, and it is now declared by 'urn:scp:…:component:lib'` — the two layers are independent, and only this one keeps the reviewed plan honest |

### §19. The shape, which catches that edit one step earlier

And the shape, which catches the same edit one step earlier and catches a WEAKER version of it (emit `[]`, prune nothing) that the assertion above cannot see. NOT "summary.deletes === 0" and NOT "no delete entries": the key is ABSENT, because an empty array means "this stack manages producers and has nothing to change" — a different, and here wrong, statement.

### §20. That table is keyed on the coordinate and upserted

`dependency_line_producers` is keyed on the COORDINATE and upserted, so it can change hands with no row deleted, nothing to stale-mark the plan, and no trace in either stack's prune pool. Every guard section (5) proves is derived from the STORED diff — deliberately, so a plan written by an older build is re-checked — and that same property is what makes the diff's own account of the world un-recheckable once the world moves. `executePlanDiff` therefore re-reads the live holder for every non-noop entry.

THE WINDOW IS DRIVEN AT THE REPO SEAM, the precedent `version-poll.integration.test.ts`'s race replays set: `declareDependencyLineProducer` is verbatim what the verb writes, called between `POST /plans` and `POST /plans/{id}/apply`, which are two separate HTTP requests in production and therefore a real wall-clock gap.

### §21. The apply, driven to completion whichever way it goes

The apply, DRIVEN TO COMPLETION whichever way it goes, so each case can assert the state of the coordinate FIRST. That ordering is deliberate and is the file's own discipline from (1): with `rejects.toMatchObject` first, removing the guard fails on "promise resolved instead of rejecting" and the damage it did is never read. Here the substantive assertion goes first, so the measured failure names the wrong OUTCOME — whose declaration was overwritten or retracted.

### §22. THE GUARD THIS PINS WAS HELD BY NOTHING

THE GUARD THIS PINS WAS HELD BY NOTHING. Deleting `checks.push(dependencyProducerScopeCheck(orgId))` from `prepareApplyChecks` left 46 tests green — a security check that is present and uninstalled, which is the exact class this whole increment exists to close. A guard nobody exercises is one the next refactor removes without a symptom.

`Operator` IS THE RIGHT PRINCIPAL, and the two cases below are one pair on purpose. Operator carries `object:write` and NOT `policy:write` (the `0002` seed; `0010` adds `policy:write` to Administrator and Owner only), so at the ORG ROOT it holds authority over every object in the org and still holds none over a producer declaration. Case (a) is what makes case (b) mean something: without it, a 403 would be satisfied by an Operator who simply cannot apply plans.

MUTATION — applied, watched fail, reverted, watched pass: | Mutation | Measured |
| delete `checks.push(dependencyProducerScopeCheck(orgId))` from `prepareApplyChecks` | "(8) … a plan that DECLARES one is REFUSED" fails: the apply resolves 200 and the declaration is written by a principal holding no `policy:write` anywhere. "(a)" stays green |

### §23. A tombstoned producer component leaves its declaration STANDING

A tombstoned producer component leaves its declaration STANDING — `deleteObject` is a soft delete and `dependency_line_producers` has no `deleted_at` — while every object read in `plans-repo.ts` filters `deleted_at IS NULL`, so the holder resolves to no URN.

The snapshot used to DROP such a row from both producer pools and call that "conservative in the safe direction". For the prune pool it is. For the EXISTENCE pool it is the opposite: the diff then emits `create`, whose reason sentence reads "no producer is declared for this coordinate — it is polled as third-party today" about a coordinate that IS declared, and the apply upserts straight over the standing row. The reviewed plan is false about the one fact that separates a first declaration from a transfer.

THE STRANDING IS PRODUCED BY THE PRODUCT'S OWN RULES, not by a hand-written row: rule (1) — an absent `producers` key manages nothing — is exactly how a stack deletes a component without retracting what it produced.

## `apps/server/src/coordination-as-code/iac-governance-move-rungs.integration.test.ts`

### §24. THE IaC RUNG OF THE `governance:move` LATTICE

THE IaC RUNG OF THE `governance:move` LATTICE (charter principle 3: API -> SDK -> CLI -> IaC -> UI; the follow-up named in `docs/proposals/governance-reach-on-containment-move.md` §9.6 Q4).

WHAT MAKES A RUNG DIFFERENT FROM EVERY OTHER MANIFEST COLLECTION
`sourceMappings`, `executorBindings` and `placements` treat an ABSENT collection and an EMPTY one as the same thing, and both PRUNE. `producers` diverges (owner ruling 2026-08-17): absent means UNMANAGED. `governanceMoveRungs` is the SECOND collection to diverge, and its reason is sharper.

Pruning a mapping costs a route an operator notices the same day. Pruning a producer declaration re-arms dependency confusion on a daily poll timer. Pruning a RUNG turns off a governance BAR, and the symptom is an ABSENCE OF REFUSALS — moves that should have been refused quietly succeeding, which nothing surfaces until somebody audits where a governed object ended up. So (1) here is the NEGATIVE case, exactly as it is in `iac-dependency-producers.integration.test.ts`: a stack with a standing rung whose manifest omits the key must plan NO rung entries and leave the rung alone.

(5) is the positive half, and the two are only correct TOGETHER: a PRESENT collection is authoritative over its members, or "unmanaged on absent" would mean IaC could enable a rung and never disable one.

WHAT EACH GATE REFUSES TO BE SATISFIED BY
1. **THE RULING.** Not "the summary is zero" — that passes if the entries exist and happen to be noops. The assertion is that `diff.governanceMoveRungs` is ABSENT and the rung is still enforced after applying that plan. 2. **WIRING**, read through the LATTICE and not through the table: `governanceMove.enforcement` — the same read the doors, the CLI and the Admin page use — must answer `enforced: true`. A plan that SHOWS a create and an apply that PERFORMS one are two different claims, and this repo has shipped the first without the second before. 3. **THE WHOLE ACT, NOT THE ROW.** A rung write records a Decision under one kind and appends an audit event. A second door that writes only the row makes `GET /decisions?kind=governance.move_enforcement` — "every rung this org ever enabled or disabled" — silently FALSE for exactly the rungs an auditor came looking for (principle 6). 4. **IDEMPOTENCE**, which for this collection is the ordinary case: `scp apply` re-runs. 5. **THE MEMBER QUESTION**, settled behaviourally: removing B from `[A, B]` disables B, and A stays enforced. 6. **THE AUTHORITY.** `policy:write` at-or-above the subject, against the REAL applying principal — on the ENABLE and on the DISABLE alike. Paired with a control apply by the same Operator so the 403 is a statement about the collection and not about Operators and plans. The disable half (c) is the one that matters more: narrowing the check to `create` would let an Operator turn a governance bar OFF, and a bar that is off announces itself only by an absence of refusals. 7. **THE MONOTONE REFUSAL.** A manifest that drops a rung under an ENABLED upper rung fails its apply with the verb's own 409, naming the upper rung — reporting a successful disable that leaves every move under the subtree enforced anyway is the worst of both. 8. **THE POINT OF THE WHOLE FEATURE**: a rung written by IaC feeds the SAME lattice. An Operator is refused a containment move under it, an Administrator makes the identical move, and the refusal NAMES the container the manifest declared.

MUTATION LOG — each applied, watched fail, reverted, watched pass
| Mutation | Measured |
| delete `checks.push(governanceMoveRungScopeCheck(…))` from `prepareApplyChecks` | EXACTLY 1 fails: "(6)(b)" — `promise resolved … instead of rejecting`; the rung is written by a principal holding `policy:write` nowhere. "(6)(a)" stays green, which is what makes the 403 a statement about the COLLECTION and not about Operators and plans | | narrow `prepareApplyChecks`'s rung loop to `if (entry.action === "create")` | EXACTLY 1 fails: "(6)(c)" — `promise resolved … instead of rejecting`, then the bar is measurably down. Before (6)(c) existed this mutation was GREEN across all 44 tests of this file, `move-enforcement.integration` and `governance-managed-write-doors`, and a probe confirmed an org-root Operator holding `policy:write` nowhere could disable a standing rung through it | | apply calls the bare `enableGovernanceMoveRung` instead of `enableGovernanceMoveRungWithEffects` | EXACTLY 1 fails: "(3)", `expected [] to have a length of 1` — no Decision, no audit event. "(2) WIRING" STAYS GREEN, which is precisely why a rung-is-enforced gate is not sufficient on its own | | an absent `governanceMoveRungs` key maps to `[]` in `computeDiffForManifest` | EXACTLY 1 fails: "(1)", on the SUBSTANTIVE assertion — `an absent governanceMoveRungs key manages nothing …: expected false to be true`. The standing bar was disabled by a manifest that merely forgot the key. This is the catastrophic direction and it is the one the message names | | drop the `delete` loop from `executePlanDiff`'s rung block | 2 fail: "(5)" (`the dropped member's rung must be disabled: expected true to be false`) and "(7)" (`promise resolved … instead of rejecting` — a disable that never runs cannot be refused by the monotone check either). Recorded as two because the second shows the 409 is reached through the WRITE and not asserted independently of it |

### §25. That role is the right principal, and these are a pair

`Operator` IS THE RIGHT PRINCIPAL, and the two cases are one pair on purpose. Operator carries `object:write` and NOT `policy:write` (the `0002` seed; `0010` adds `policy:write` to Administrator and Owner only), so at the ORG ROOT it holds authority over every object in the org and still holds none over a governance bar. Case (a) is what makes case (b) mean something: without it a 403 would be satisfied by an Operator who simply cannot apply plans at all.

### §26. The disable half, and why it is a separate case

THE DISABLE HALF, and the reason it is a separate case rather than a variant of (b).

`prepareApplyChecks` authorizes every NON-NOOP entry. Narrow that one predicate to `entry.action === "create"` and (a), (b) and every other gate in this file stay green while an Operator holding `policy:write` NOWHERE can delete a rung out of a manifest and turn a governance bar off. That is strictly worse than the enable direction it shares a check with: an unauthorized ENABLE announces itself the first time somebody is refused a move, an unauthorized DISABLE announces itself by an ABSENCE of refusals — nothing, until an audit notices where a governed object ended up. The same asymmetry is why an absent collection is unmanaged (1) rather than empty.

### §27. This is the case the whole increment exists for

This is the case the whole increment exists for. Everything above proves a row was written with the right ceremony; only this proves the row MEANS anything. If the IaC path wrote to some parallel place — or wrote a tier the doors do not recognise — every gate above would still be green and the feature would be inert. The Administrator's identical move is the control that makes the Operator's 403 a statement about `governance:move` rather than about the move being impossible.

## `apps/server/src/coordination-as-code/iac-member-of-role-escalation.integration.test.ts`

### §28. THE `member_of` SUBSET RULE IS AT THE CHOKE POINT, NOT AT THE ROUTE

THE `member_of` SUBSET RULE IS AT THE CHOKE POINT, NOT AT THE ROUTE — proven through IaC APPLY

`docs/authz/role-binding-door.md` §2a closes the escalation where a lesser principal joins a group that holds a powerful role binding and inherits it through `authz/resolve.ts`'s `subject_expand`. `routes/rbac-role-binding-door.integration.test.ts` pins that through `POST /relationships`.

THIS FILE EXISTS BECAUSE THAT IS NOT THE ONLY DOOR, and a route-only guard is the shape this programme has already paid for twice: the campaign-deadline fix shipped at the route, was measured bypassable through IaC apply, and had to be moved to the `updateObject` choke point (role-model.md §5 step 0b). `iac/plans-repo.ts` replays a manifest diff's **free-form `typeId`** straight into `graph/relationships-repo.ts`'s `createRelationship`, and `prepareApplyChecks` mirrors `routes/relationships.ts`'s both-endpoint `relationship:write` and nothing else — so before the guard moved into the repo function, `POST /plans/{id}/apply` was a second, unguarded way to write exactly the same edge. That is not a hypothesis about this file: it is the same sentence `plans-repo.ts:1221` already carries about the `contains` governance-move rung, which shipped INERT on IaC for precisely this reason.

So the assertion here is not "IaC refuses this too" as extra coverage. It is the ONLY behavioural evidence that the guard is where the finding required it to be: **delete the call from `createRelationship` and put it in `routes/relationships.ts`, and every case in the other file still passes while this one goes green-to-red.**

MUTATION LOG — each applied ALONE, CONFIRMED ON DISK, measured, then reverted (2026-08-27)
Each mutation was confirmed to have LANDED by re-reading the mutated file off disk (`grep -ac` on an injected marker, checked against a known-positive count) before the run, and confirmed reverted by the same count going to zero afterwards. A mutation that never applied reads as a pass.

1. `graph/relationships-repo.ts` — deleted the whole `if (type.id === "member_of" && !input.federationImport)` block -> **2 failed across the two files, 24 passed.** Here: `the escalating apply must be REFUSED, not resolved: expected null to be an instance of ScpApiError` — the apply RESOLVED. And in `routes/rbac-role-binding-door.integration.test.ts`, the exploit chain: `expected 201 to be 403`, the response body carrying the minted edge with `"typeId":"member_of"` and `"deletedAt":null`. Both doors, one deletion. 2. `graph/relationships-repo.ts` — the guard MOVED to `routes/relationships.ts`'s POST handler (the "obvious" placement), byte-identical call, nothing else changed -> **1 failed, and ONLY here: 25 passed.** The route suite went fully green — its exploit case, its admission pair, all of it — while `POST /plans/{id}/apply` still minted the escalating edge. THIS IS THE MEASUREMENT THE MODULE DOC IS ABOUT: every test that names the escalation passes against a placement that does not close it.

## `apps/server/src/coordination-as-code/iac-pair-bound-types.integration.test.ts`

### §29. An apply must refuse a pair-bound type, as the route does

IaC APPLY MUST REFUSE A PAIR-BOUND OBJECT TYPE, EXACTLY AS THE GENERIC ROUTE DOES.

THE HOLE
`routes/objects-generic.ts` refuses three classes of type on every write verb: governance-managed (`policy`/`control`), peer-bound (`outpost`), and PAIR-BOUND (`placement`). Its reasoning for the last is explicit — a placement's identity IS a pair of other objects, so a door taking free-form `properties` would "store two UUIDs without resolving them, without checking they name a `component` and a `deployment-target`, and — decisively — without writing the two derived edges that make the pair traversable, leaving an island invisible to every impact query".

`iac/plans-repo.ts` is a SECOND write door: apply calls `createObject` directly, not through that route. It special-cases `policy`, `campaign` and peer-bound types — two of the three classes — and says nothing about pair-bound ones. So a manifest declaring `typeId: "placement"` reached `createObject` with every guarantee of `/api/v1/placements` skipped.

That is the incomplete-call-site pattern BUILD_AND_TEST.md §4.4 exists for: the concept "types the generic door must refuse" had two call sites and was applied to one.

WHAT THE TEST ASSERTS
Not the error message — that a placement is NOT CREATED, and that no untraversable island is left behind. A refusal that still wrote the row would satisfy a message assertion.

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
| Mutation | Result |
| remove the pair-bound guard from `plans-repo.ts` (the hole) | this test FAILS — apply creates a placement with NO derived edges | | guard only `create` and not `update`/`delete` | the update case FAILS |

TWO doors WHEN THIS WAS WRITTEN, one now. The IaC hole was found first; censusing every `createObject` caller for the guard turned up `POST /discovery/accept` as well — user-facing, since it took its proposal from the request body, while `pair-bound-types.ts` had classed it with internal journal replay. ADR-0047 removed that door, so the census that found it now returns one user-facing caller: IaC apply, which is what remains under test here.

### §30. THE `accept` CASE IS GONE WITH ITS DOOR

THE `accept` CASE IS GONE WITH ITS DOOR (ADR-0047). It proved that a hand-written proposal declaring `typeId: "placement"` was refused — accept was different in kind from the other import paths `pair-bound-types.ts` leaves permissive, because it took its proposal FROM THE REQUEST rather than from a signed journal, so a caller could hand-write one.

No door of that kind remains: discovery proposes and a human commits IaC, and the manifest path is covered by the case above ("refuses a manifest that declares a placement as a raw object"), which is the door a hand-written declaration reaches now.

## `apps/server/src/coordination-as-code/iac-pipeline-hooks.integration.test.ts`

### §31. THE IaC RUNG OF THE PIPELINE-HOOK CONTRACT

THE IaC RUNG OF THE PIPELINE-HOOK CONTRACT (team-pipeline-iac increment 8, D11/D21; charter principle 3: API -> SDK -> CLI -> IaC -> UI).

WHAT THIS FILE EXISTS TO STOP
`DesiredStateManifestSchema` has accepted a `pipelineHooks` key since the collection was specified, and the server ignored it ENTIRELY. A team could declare a `postDeploy` gate, watch `scp apply` report `applied`, and have no gate. That is the worst shape a coordination platform can ship: a decorative safety declaration. Every case below is a claim about the WIRE, the DIFF or the ROWS — never about a function existing.

WHAT MAKES A HOOK DIFFERENT FROM `sourceMappings`/`executorBindings`/`placements`
Those three treat an ABSENT collection and an EMPTY one as the same thing, and both PRUNE. `producers` diverges (owner ruling 2026-08-17) and `governanceMoveRungs` diverges (proposal §9.6 Q4). `pipelineHooks` is the THIRD, and its argument is the rung's argument verbatim:

```text
- Pruning a mapping costs a route an operator notices the same day.
- Pruning a HOOK disarms a GATE. A vanished `postDeploy` entry stops gating every wave's exit;
  a vanished `bakeAlarms` entry stops holding the widening. The symptom in both cases is an
  ABSENCE — of refusals, of holds, of anything — and nothing surfaces it until a bad release
  walks the whole fleet unimpeded.
```

So (3) here is the NEGATIVE case, exactly as (1) is in `iac-dependency-producers.integration.ts` and `iac-governance-move-rungs.integration.ts`: a stack with standing hooks whose manifest omits the key must plan NO hook entries and leave every hook alone. (2) and (4) are the positive half, and the three are only correct TOGETHER — without them, "unmanaged on absent" would mean IaC could arm a gate and never disarm one.

MUTATION LOG — each applied, watched fail, reverted, watched pass
| Mutation | Measured |
| REMOVE THE PRUNE-SKIP: `computeDiffForManifest` maps an absent `pipelineHooks` key to `[]` instead of `null`, and the pool guard is dropped — so absent behaves exactly like empty | EXACTLY 1 fails: "(3) an ABSENT pipelineHooks key manages NOTHING", on the SUBSTANTIVE assertion — `an absent pipelineHooks key manages nothing — the standing hooks must survive: expected [] to deeply equal [ { kind: 'bakeAlarms', …(6) }, …(1) ]`. Two standing gates were disarmed by a manifest that merely forgot the key. This is the catastrophic direction and it is the one the message names. NOTHING ELSE MOVED — (2), (4) and (5) stayed green, which is what makes this a statement about the ABSENT case and not about pruning in general | | `pipelineHookKey` drops `hookId`, so the diff key ignores it | EXACTLY 1 fails: "(5) … renaming the hookId plans both lines" — `expected { 'postDeploy/smoke-v2': 'noop' } to deeply equal { 'postDeploy/smoke': 'delete', …(1) }`. A renamed hook read as "matches current state" and the apply did nothing at all | | drop `checks.push(...)` from `prepareApplyChecks`'s hook loop, keeping the resolve | 2 fail: "(6)(b)" and "(6)(c)", both `promise resolved … instead of rejecting`. A Viewer holding `object:write` NOWHERE armed a gate, and disarmed a standing one. "(6)(a)" stays green, which is what makes the 403 a statement about the COLLECTION and not about Viewers and plans | | narrow that same loop to `entry.action === "create"` | EXACTLY 1 fails: "(6)(c)" — `promise resolved … instead of rejecting`, and the standing gate is measurably gone. This is why (c) exists as a case of its own: an unauthorized ARM announces itself the first time a wave is held; an unauthorized DISARM announces itself by an absence of holds |

The two sibling `absent-means-unmanaged` files were mutation-proven on the same run and are NOT vacuous: mapping an absent `producers` key to `[]` reds their "(1)" (`expected undefined to be '01a0437f-…'`), and doing the same to `governanceMoveRungs` reds theirs (`expected false to be true`). Recorded here because a rule with three instances is only as good as its weakest test.

### §32. The live rows, read through the function the loop uses

The live rows for a component, read through the SAME function the reconcile path's gate reads through (`listHooksForComponents`) rather than a SELECT written here — so a green in this file cannot disagree with what actually gates a wave.

### §33. THE PLAN IS THE WHOLE STORY

THE PLAN IS THE WHOLE STORY (property 7), asserted as a FUNCTION so every case below gets it rather than one case claiming it.

Compares the rows before an apply with the rows after, and requires that EVERY difference is named by a plan line and every plan line is honoured: - a row that appeared must have a `create` entry whose declaration matches it FIELD FOR FIELD; - a row that vanished must have a `delete` entry likewise; - a row that survived unchanged must have a `create` or `noop` entry, or no entry at all when the collection was unmanaged. A write the plan did not show, or a shown write that did not land, fails here.

### §34. A stack with one service and component, plus the hooks

A stack with one service and one component, plus whatever `pipelineHooks` value is asked for.

`hooks: undefined` OMITS the key entirely — the shape `Stack.synth()` produces for a pipeline that declares none, and exactly the shape that makes "unmanaged" and "I declare none" indistinguishable. `@scp/coordination-as-code` has no hook construct yet (increment 8 wires the SERVER half), so a declaring manifest is hand-authored here, which is also the only way to express the present-but-empty statement `Stack.synth()` cannot emit.

### §35. The pair is the whole ruling; neither half means anything

The pair (3)+(4) is the whole ruling, and neither half means anything alone. (3) alone would be satisfied by a build that ignores the collection entirely — which is exactly the state this increment found. (4) alone would be satisfied by prune-on-absent. Only together do they say "the KEY's presence is the statement".

`Stack.synth()` cannot emit this shape (it omits an empty collection), so this is the hand-authored escape hatch `ManifestPipelineHookSchema` documents — the only way IaC can remove a stack's LAST hook.

### §36. The payload half, which would go silently wrong

THE PAYLOAD HALF, and the one that would go silently wrong if the diff keyed on the identity tuple alone. `(componentUrn, kind, hookId)` is unchanged here — only `stage` moves — so an identity-keyed diff reads `noop` while the apply's `ON CONFLICT DO UPDATE` rewrites the gate. D21(a) is emphatic that adding a `stage` REMOVES gates: this transition narrows a gate-every-wave to a gate-at-prod, which is precisely the change that must not be invisible.

### §37. THE AUTHORITY PAIR, and the two cases are one pair on purpose

THE AUTHORITY PAIR, and the two cases are one pair on purpose: (a) is what makes (b) mean something, because without it a 403 would be satisfied by a principal who simply cannot apply plans at all.

`Viewer` AT THE ORG ROOT IS EXACTLY THE RIGHT PRINCIPAL, and the choice is the whole design of the pair. `POST /plans` needs `object:read` at the org root, which a Viewer has — so it can compute and submit. It holds `object:write` NOWHERE, which is what the hook loop demands. And the two manifests below are BYTE-IDENTICAL apart from the `pipelineHooks` key: every object and relationship entry is a `noop` (the admin already applied this exact stack), so the all-noop plan in (a) pushes NO checks at all and applies. The ONLY difference between an apply that succeeds and an apply that 403s is the hook. Drop `checks.push(...)` from `prepareApplyChecks`'s hook loop and (b) goes green while nothing else in the suite moves.

### §38. The disarm direction, as a separate case

THE DISARM DIRECTION, and it is a separate case rather than a variant of (b) for the reason the rung file gives one: narrow `prepareApplyChecks`'s hook loop to `action === "create"` and (a), (b) and every other gate here stay green while a principal holding `object:write` NOWHERE can drop a hook out of a manifest and DISARM a standing gate. That is strictly worse than the arm direction it shares a check with — an unauthorized arm announces itself the first time a wave is held; an unauthorized disarm announces itself by an absence of holds, which is to say never.

## `apps/server/src/coordination-as-code/iac-placement-bindings.integration.test.ts`

### §39. DECLARING AN EXECUTOR BINDING ON A PLACEMENT

DECLARING AN EXECUTOR BINDING ON A PLACEMENT.

WHY THIS EXISTS
C1 (#215) let a manifest declare `placements`, but not the bindings that hang off them — the pool of "bindings this stack manages" was keyed on owned OBJECTS, and a placement is not in `manifest.objects` (#207 refuses pair-bound types at that door). So `POST /plans` refused every such declaration as "on object(s) this stack does not manage", and its suggested remedy ("declare that object in this stack's manifest") was unavailable by construction.

That mattered beyond IaC completeness: on the live estate 61 of 66 executor bindings hang off placements, so the collection was silently unable to express the majority of real bindings.

ADDRESSING IS THE PAIR, NEVER THE URN
A placement's URN is DERIVED (ADR-0026 D3) from the org id plus both endpoints' *display names* — `urn:scp:<orgId>:placement:<component>/<deployment-target>`. An author cannot write that, and it changes under a rename.

So a placement is addressed as `targetUrn` (the COMPONENT) narrowed by `deploymentTargetUrn`. The first shape tried was a separate `targetPlacement` pair replacing `targetUrn`, and it failed the oasdiff /v1 additive-only gate: making `targetUrn` optional is a breaking change for every response that echoes a plan's manifest and diff. Expressing the placement as a QUALIFIER keeps `targetUrn` required, and collapses ownership back to one unconditional rule — the stack must own `targetUrn`, which for a placement IS its component (decision Q4).

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
| Mutation | Result |
| revert the pool to `ownedIdList` (objects only) | FOUR fail: adopt, prune, the cross-stack update, and "removes BOTH" in the placements suite | | drop the "pair must be declared" check | the undeclared-pair test FAILS (asserted on the offender TEXT, so the other branch cannot satisfy it) | | drop `resolveEndpoint` from the BINDING loop | only the noop-placement test fails | | drop `resolveEndpoint` from the PLACEMENTS loop | only the no-binding test fails | | drop the Q2 surviving-binding check | only the TOCTOU test in the placements suite fails |

The two `resolveEndpoint` rows are why this file has nine tests rather than seven. With the original seven, each call was individually redundant — every single-drop mutation stayed green because the other covered it, and only removing BOTH failed anything. Two lines each "covered" only by the other are not covered at all, so the cases that separate them were added: a placement whose pair is `noop` (the placements loop skips those) and a placement with no binding at all.

An earlier version of the foreign-component test asserted only a 400, which the PLACEMENT guard could satisfy on its own — green under a mutation that broke the binding guard entirely. It now asserts the offender text and uses a stack declaring no placements, so only the binding guard can answer.

### §40. This stack declares no placements and not the foreign one

This stack declares NO placements of its own and does not declare the foreign pair either — so the placements guard has nothing to object to and only the BINDING guard can refuse. That isolation is the point: an earlier version of this test also declared the foreign placement, and stayed green under a mutation that broke the binding guard entirely, because the placement guard was answering for it.

### §41. A pre-existing C1

A pre-existing C1 (#215) gap, not something this change introduced. `ManifestPlacementSchema` says the deployment-target "may belong to another stack", but `prepareApplyChecks` resolved only the COMPONENT — so `endpointId(deploymentTargetUrn)` threw "internal: could not resolve object id" at apply for exactly the case the schema advertises. It never bit the live estate because every stack there happens to declare its own targets.

### §42. The case those two endpoint resolutions exist for

The case the two `resolveEndpoint(deploymentTargetUrn)` calls exist for, and the only one that distinguishes them. The placements loop SKIPS `noop` entries, so on a re-apply where the pair is unchanged but the binding changed, the placement no longer resolves the foreign deployment-target — only the binding loop does. Drop that one line and this fails with "internal: could not resolve object id" while every other test here stays green.

## `apps/server/src/coordination-as-code/iac-placements.integration.test.ts`

### §43. DECLARING PLACEMENTS IN IaC (C1, ADR-0026)

DECLARING PLACEMENTS IN IaC (C1, ADR-0026) — the four decisions, enforced end to end.

The design is in docs/proposals/iac-placements.md; §6 records the rulings. This file exists because three of the four are only real if APPLY enforces them, and one of them is destructive.

WHY A TYPED COLLECTION AT ALL — the assertion the whole feature rests on
A placement cannot be a raw `objects[]` entry: that door is refused for pair-bound types (#207) because it stores unresolved UUIDs and writes NO derived edges, leaving an island invisible to every traversal. So the first test asserts the DERIVED EDGES exist after apply — not merely that a row appeared. A create path that produced the row without the edges would satisfy a row-count check and reintroduce exactly what #207 closed.

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
| Mutation | Result |
| apply via `createObject` instead of `createPlacement` | the derived-edges test FAILS — the row exists, the edges do not | | make an ABSENT collection skip pruning | the absent-collection test FAILS here AND three `plans.integration` C1 prune tests fail — absent is the only way `synth()` can say "none", so it must prune | | drop the Q2 binding check from the prune path | the TOCTOU test FAILS (the placement is deleted and the binding orphaned) | | move the placement prune BEFORE the binding prune | the remove-both test FAILS — a manifest legitimately dropping both is refused, which is the ordering bug this file caught during development | | scope the owned pool on the deployment-target instead of the component | the foreign-component test FAILS |

### §44. This replaces the original case, and the change is deliberate

THIS REPLACES THE ORIGINAL Q2 TEST, and the change is deliberate rather than a regression.

Q2 ruled that pruning a placement carrying a binding REFUSES, on the stated grounds that "the manifest cannot even name it (its target is the placement)". A manifest CAN now name it, by the pair — so silence means "I declare none", the binding is pruned first, and the placement then prunes cleanly. That is exactly how `sourceMappings` on an owned component have always behaved; making bindings-on-placements the one collection that cannot be removed through IaC would be the inconsistency, not this.

### §45. NOT a quirk, and I got this backwards first

NOT a quirk, and I got this backwards first. `Stack.synth()` OMITS a collection when empty (construct.ts), so an absent key is the ONLY way an author can say "this stack has no placements". If absent meant "assert nothing", the LAST placement could never be removed through IaC — you could add the final one and never take it away.

`@scp/schemas`'s "an absent collection must not read as 'prune everything'" is about a pre-C1 or hand-rolled manifest staying VALID, not about suppressing prune. Reading it the other way, I "fixed" a non-bug and broke three plans.integration tests that assert exactly this.

## `apps/server/src/coordination-as-code/iac-rbac-apply.ts`

### §46. IaC-APPLIED ROLE BINDINGS AND ORG ROLES

IaC-APPLIED ROLE BINDINGS AND ORG ROLES (drizzle/0108)

THROUGH THE REAL DOORS, NEVER AROUND THEM. Every function here composes the same `authz/role-binding-door.ts` guards `routes/role-bindings.ts` uses. An IaC path that inserted rows itself would be a SECOND door with its own drift, and this milestone's whole guard census would be wrong the day the two disagreed.

WHAT IS DIFFERENT FROM THE TYPED ROUTE, and each is deliberate:

- **`managed_by_stack` is stamped**, which is what makes the row prunable by a later apply. A binding created through the route carries NULL and no manifest can ever touch it. - **No D7 acknowledgement**, because group and team subjects are not declarable at all (`packages/coordination-as-code/src/rbac.ts` refuses them at synth). `assertBindableSubject` re-checks that here rather than trusting the client: the construct is one authoring path, and a hand-written manifest is another. - **No `Idempotency-Key`** — an apply is already idempotent by diff: a binding that exists is a `noop` line and never reaches this code.

## `apps/server/src/coordination-as-code/iac-rbac.integration.test.ts`

### §47. IaC-DECLARED ROLES AND ROLE BINDINGS

IaC-DECLARED ROLES AND ROLE BINDINGS — apply, prune, and every door still standing

THE PROPERTY IS AUTHORITY, NOT ROWS. A plan that shows the right lines and an apply that writes the right rows would both be satisfied by a feature that changes nothing anyone can do, so every case here ends at `hasPermission` — the function the doors call — rather than at a row count.

THE PRUNE IS THE DANGEROUS HALF and gets the most attention. Dropping a line from a manifest REVOKES a person's access on the next apply (owner decision 2026-08-28, taken with that risk named). Two properties bound it and both are pinned below: a binding granted through the typed door carries `managed_by_stack = NULL` and is invisible to every manifest, and the administrative floor refuses the revoke that would leave an org with nobody able to grant anything.

THE HAND-GRANTED PROPERTY IS DEFENDED TWICE and the tests say so honestly: `managed_by_stack` is filtered both when LOADING the prune population (`listStackManagedRoleBindings`) and again in the delete helper. Removing EITHER alone leaves this file green — the loader mutation is caught by the idempotence case, and the delete-helper filter is pure defence in depth. Removing BOTH reds the suite loudly. That is a real redundancy rather than a gap, and it is recorded here so nobody reads a surviving single mutation as proof the test is weak.

### §48. THE GAP THIS CLOSES, found by mutation

THE GAP THIS CLOSES, found by mutation: every other case here applies as the org's bootstrap ADMIN, who holds everything — so deleting the subset rule from the apply path changed nothing and all seven tests stayed green. A rule only exercised by a principal who satisfies it is not exercised at all.

An OrgAdmin holds `role_binding:write` and NOT `freeze:override`, so a manifest of theirs that authors a role carrying it must be refused — the same bar `POST /roles` applies, on the path a config-source sync uses.

### §49. Entered at the writer rather than the route deliberately

Entered at the writer rather than the route deliberately: `prepareApplyChecks` resolves both endpoints first and 404s there, so the plan path cannot reach this guard — which is precisely how it came to be written against `getObjectByIdOrUrnAnyType`, a function that THROWS its own generic 404 and never returns a falsy value. Both refusals below were therefore unreachable from every caller, including this one, and "does not exist" was a string nothing could print.

## `apps/server/src/coordination-as-code/iac-rollouts-convergence.integration.test.ts`

### §50. ROLLOUTS AND CONVERGENCE SURVIVE APPLY

ROLLOUTS AND CONVERGENCE SURVIVE APPLY (D12, D25(b); migration 0106).

THE DEFECT THIS CLOSES, AND WHY A SHAPE ASSERTION WOULD NOT HAVE CAUGHT IT
`@scp/coordination-as-code` has emitted both collections since the L1 doors and the `CanaryRollout` / `RollingRollout` constructs shipped. `plans-repo.ts` projected NEITHER — its own comment said so ("not projected at all yet") — so a team could declare a canary, watch `scp plan` return a clean diff, apply it, and have the server discard it without a word. Every existing test still passed, because nothing asked what happened to the collection AFTER apply.

So the assertions here are on the DATABASE, through the real `POST /plans` + apply route.

MUTATION LOG — each applied, watched fail, reverted, watched pass (MEASURED) | Mutation | Result |
| remove the `rollouts` apply writer | 2 FAIL — (1) and (2). The plan still shows a create and the row is absent: the pre-0106 behaviour exactly, and note the PLAN was never wrong, only the write. | | remove the `convergence` apply writer | 2 FAIL — (3) and (4) | | the snapshot never reads the rollout pool | (2) FAILS — with an empty pool every apply reads as a `create` and no retraction prunes | | `converge: false` is stored as `true` | (4) FAILS — the opt-out is silently inverted |

### §51. THE COMPONENT MUST BE DECLARED BY THIS STACK, not created beside it

THE COMPONENT MUST BE DECLARED BY THIS STACK, not created beside it. The diff's pool is "rows on components this stack owns" (`managed_by_stack`), so a component created through the typed route is invisible to matching AND pruning — every apply then reads as a `create` and no retraction ever prunes. Measured: the first version of this fixture used `components.create` and case (2) failed with `create` where `update` belonged, which is the ownership rule announcing itself rather than a bug in the diff.

## `apps/server/src/coordination-as-code/iac-stack-ownership.integration.test.ts`

### §52. IaC STACK OWNERSHIP IS NOT WRITABLE BY ITS SUBJECT

IaC STACK OWNERSHIP IS NOT WRITABLE BY ITS SUBJECT (drizzle/0068)

THE PROPERTY. A governance decision whose match key is writable by its own subject, at a weaker permission than the one that authored the constraint. Here the decision is the IaC PRUNE POOL — which live rows an apply DELETES — and the match key WAS the `scp:managed-by`/`scp:stack` pair in the row's own `labels`, writable at plain `object:write` AT THE OBJECT, validated by nothing.

Both directions were reproduced against these exact doors before the fix; the cases below are those reproductions with their expectations inverted, so the file reads as what it measured:

```text
R1 ENROLMENT — an Operator bound at ONE object, holding no IaC authority at all, PATCHed two
label keys onto it. The stack's UNCHANGED manifest then proposed deleting it, over the reason
"previously managed by this stack, no longer present in the desired manifest", which was false.
The apply executed that delete and the object 404'd.
```

```text
R2 ESCAPE — the object's owner stripped the two keys. The object left the pool, so when its
stack later dropped it from the manifest to decommission it, ZERO deletes were proposed. It
survived its own decommission with nothing in the diff to notice.
```

WHY THIS FILE IS AN INTEGRATION TEST AND NOT A UNIT TEST. `plan-diff.test.ts` proves the predicate DECIDES correctly and cannot prove it is WIRED — a suite that calls `isStackManaged` directly stays green with every installation deleted, which is this repo's dominant defect class. So every case here drives real HTTP doors: `PATCH /objects/{type}/{id}`, `POST /plans`, `POST /plans/{id}/apply`.

INSTALLATION PROVEN BY MUTATION — MEASURED, and the results are recorded as observed rather than as intended. Each was applied against an otherwise-green suite and the named cases FAILED:

```text
m1. `fetchManagedObjects` back to `labels @> managedLabels(stack)`                -> R2
m2. the object prune's `isStackManaged(existing.managedByStack, …)` back to the
    two-label test                                                               -> R2
m1+m2 together (i.e. the whole pre-0068 object read path restored)               -> R1, R2
m3. delete the `stampObjectStackOwnership` call in `executePlanDiff`             -> R2, A1
m4. narrow that stamp to `action === "create"` (drop `update`/`noop`)            -> A1
m5. delete the `stampRelationshipStackOwnership` call                            -> E1
m6. `fetchManagedRelationships` back to the label containment test               -> E1, E2
```

READ m1 AND m2 CAREFULLY — the result is more interesting than "both are wired". Neither ALONE revives R1, because the two are independent gates over the same fact: the pool QUERY selects on the column, and the prune PREDICATE re-tests it. Reverting one leaves the other refusing the enrolled object. R1 needs both reverted, which is exactly what the composite row shows. That is defence in depth rather than a gap, but it does mean neither mutation alone is a complete installation proof for R1, and saying so is the point of listing the composite.

### §53. The branch that is impossible to see from the outside

The branch that is easy to miss and impossible to see from the outside. Under the old scheme, adoption happened as a SIDE EFFECT of merging the marker labels — so a declared object was never a `noop` on the apply that adopted it. Ownership is now explicit, which means `noop` has to be stamped on purpose. Skipping it would leave the object declared-but-unowned: undeletable by the very stack that declares it, i.e. the ESCAPE direction reached by accident.

The object is pre-seeded WITH the marker labels, which is what makes its first plan a `noop` and is also the state a pre-0068 estate is full of.

## `apps/server/src/coordination-as-code/plan-diff.test.ts`

### §54. Pure tests over hand-built manifest and snapshot fixtures

Pure unit tests over hand-built "manifest + current-state snapshot" fixtures — no DB, per BUILD_AND_TEST.md §4.1 ("anything testable as a pure function must be written as a pure function"). The DB-aware assembly (`iac/plans-repo.ts`'s `computeDiffForManifest`) is exercised separately by `routes/plans.integration.test.ts`.

### §55. A compile-time property expressed as a runtime assertion

drizzle/0068. This is a compile-time property expressed as a runtime assertion: the only argument `isStackManaged` accepts is the column, so the label pair that used to BE ownership now reaches it only as the plain string it wraps — and the wrapper object is not assignable. If someone widens the signature back to a labels map, the `@ts-expect-error` below stops erroring and this test fails, which is the point of writing it here rather than in prose.

### §56. PRODUCER DECLARATIONS (ADR-0032 §7e)

PRODUCER DECLARATIONS (ADR-0032 §7e) — the one collection where ABSENT and EMPTY differ.

The type carries the ruling (`ResolvedManifest.producers` is `T[] | null`, not `T[]`), so the first two cases below are what that type is FOR: `null` must skip the block entirely and `[]` must prune. A mutation that maps absent to `[]` in `plans-repo.ts` cannot be caught here — it is caught in `iac-dependency-producers.integration.test.ts` — so these cases pin the ENGINE's half and that file pins the wiring's.

### §57. A tombstoned producer leaves its declaration standing

A tombstoned producer component leaves its declaration standing and resolves to no URN, so the snapshot carries `unresolvedProducerUrn`. It gets its own branch rather than failing the membership test: the fixture below puts the sentinel IN `diff.objects`, which a real URN could legitimately be (a manifest still naming the deleted component diffs it as a `create`) — and membership alone would then wave the overwrite through on precisely the plan to refuse.

## `apps/server/src/coordination-as-code/plan-diff.ts`

### §58. Pure desired-vs-actual diff engine for `@scp/coordination-as-code` plans

Pure desired-vs-actual diff engine for `@scp/coordination-as-code` plans (BUILD_AND_TEST.md §8 M2 item 4, DESIGN.md §15). Takes plain data in, produces plain data out — no DB, no I/O — per BUILD_AND_TEST.md §4.1's "anything testable as a pure function must be written as a pure function" rule (same split as `authz/resolve.ts` vs its integration test). The DB-aware assembly of `PlanDiffSnapshot` (querying live objects/relationships) lives in the thin wrapper, `iac/plans-repo.ts`.

### §59. The human-readable mirror of stack ownership, on each row

The HUMAN-READABLE MIRROR of stack ownership, merged into every managed row's labels at PLAN time (goal statement — "this happens at PLAN time... not an apply-time surprise").

DESCRIPTIVE ONLY SINCE drizzle/0068 — READ BY NOTHING THAT DECIDES ANYTHING. It used to BE the ownership record, which meant the prune target wrote its own match key under plain `object:write`: two label keys enrolled an arbitrary object into a stack's delete pool, or walked an object out of one so its own decommission silently did nothing. Ownership now lives in the server-written `managed_by_stack` column (`iac/stack-ownership.ts`); these keys survive only so operators, dashboards and `scp` output keep the marker they already grep for.

They are self-healing rather than protected: a tenant edit makes the object's labels differ from what the manifest merges, so the next plan diffs it as an `update` and the apply rewrites them. Between those two moments the label can lie to a human reader; it can no longer lie to the diff.

IF YOU ARE ABOUT TO KEY A DECISION ON THESE, DON'T — read `managed_by_stack` instead. That is the one sentence this whole change exists to make true.

### §60. True if this row is owned by THIS stack

True if this row is owned by THIS stack — the sole scoping test for pruning (goal statement: "pruning is scoped").

TAKES THE COLUMN, NOT THE LABELS, and the signature changed to `string | null` for exactly that reason: a predicate that still ACCEPTED a labels map would let a caller re-introduce the evasion by passing the wrong argument, and it would type-check. There is one input and it is server-written.

### §61. Stack theft: a manifest claiming another stack's object

STACK THEFT — a manifest claiming an object another stack already manages (§9: "adopting an object already managed by a DIFFERENT stack is refused (409) — stack theft is not a merge").

WHAT THIS CLOSES, MEASURED ON THE TREE BEFORE IT EXISTED
`stampObjectStackOwnership`'s predicate is `managed_by_stack IS NULL OR <> $stack`, so an apply re-stamped ANY object in its diff — including one another stack owned. Its own header states the consequence plainly and treats it as the design ("the only other way out would be another stack declaring it — which is a `create`/`update`/`noop` in that stack's diff, i.e. a re-stamp by this same function"). The effect: a manifest that names a foreign URN takes the object over silently, and the LOSING stack's next apply then proposes deleting rows it no longer owns, or proposes nothing at all for an object it still believes it manages.

ADOPTION OF AN *UNMANAGED* OBJECT REMAINS LEGAL AND IS THE POINT — it is how an existing estate comes under IaC (§9, and `scp iac export`'s whole purpose). Only the cross-stack case is refused. The two are distinguished by reading `managed_by_stack`, which is server-written and, unlike the labels it replaced, not writable by the subject of the decision.

### §62. A manifest object whose domain is already resolved

A manifest object with `domainId` already resolved to a concrete value — `undefined` ("default to the org root") resolved via `graph/objects-repo.ts`'s `resolveDomainId` in `plans-repo.ts`, since that resolution needs a DB read and this function must stay pure. `properties`/`labels` are defaulted to `{}` by the same caller (the raw `ManifestObject` from `@scp/schemas` leaves both optional).

### §63. A source-mapping entry with every optional field normalized

A manifest `sourceMappings` entry with every optional field normalized to the row that will actually be written (`null` patterns, the `configuration` Type default) — so the diff compares like with like and the reviewed entry shows the real row, not the author's shorthand.

### §64. Declared reach (migration 0066, §10.6)

Declared reach (migration 0066, §10.6) — an attribute, NOT part of `sourceMappingKey`, but the ONE attribute this diff CONVERGES on an existing tuple (an `update` verdict; apply sets it in place on every row sharing the tuple). Three states on the DESIRED side: `undefined` = this manifest does not manage the scope (never proposes an update, and a create writes NULL); `null` = declare it undeclared (clears a label); a value = that value. On the ACTUAL side (`managedSourceMappings`) always `null` or a value — what the row holds.

### §65. An executor-binding entry, normalized the same way

A manifest `executorBindings` entry, normalized the same way, with `executionSystemId` already resolved from an id-or-URN reference to a real object id by `plans-repo.ts` (a DB read, hence not here). Without that resolution a manifest naming a system by URN would diff as a perpetual `update` against the uuid the table stores — DoD (b)'s "apply twice is a no-op" would be false.

### §66. A declared pipeline hook

A declared pipeline hook (D11/D21, migration 0096). IDENTITY is `(componentUrn, hookKind, hookId)` — the table's own `pipeline_hooks_identity` — but the DIFF keys on the whole declaration (`pipelineHookKey`), because a hook has no attribute that converges in place: a `stage` or `maxAgeSeconds` that moved is a different gate, and `ManifestPipelineHookSchema` states the consequence ("a changed hook is a delete + create").

Every per-kind field is NORMALIZED to `null` here rather than left `undefined`, so the ACTUAL side (rows read back from a table whose per-kind columns are nullable) and the DESIRED side (a discriminated union whose members simply lack the fields they do not use) key identically. Without that, a `postMerge` hook would key one way from the manifest and another from the database and every plan would propose a delete plus a create for a hook that never changed.

### §67. ABSENT AND EMPTY ARE THE SAME THING HERE, deliberately

ABSENT AND EMPTY ARE THE SAME THING HERE, deliberately — do not "fix" this.

`Stack.synth()` OMITS a collection when it is empty (construct.ts), so an absent key is the ONLY way an author can express "this stack has no mappings/bindings/placements". If absent meant "assert nothing, prune nothing", the LAST row in a collection could never be removed through IaC — you could add the final mapping and never take it away.

`@scp/schemas`'s "an absent collection must not read as 'prune everything'" is about a pre-C1 or hand-rolled manifest staying VALID, not about suppressing prune. I misread it as the latter, made absent skip pruning, and broke three `plans.integration` tests that assert exactly this: `build(false)` synthesizes a manifest with no `sourceMappings` key and expects `deletes === 2`. The tests were right.

### §68. HERE, AND ONLY HERE, ABSENT AND EMPTY ARE DIFFERENT

HERE, AND ONLY HERE, ABSENT AND EMPTY ARE DIFFERENT — `null` vs `[]`. The type is the ruling.

Read the comment on `sourceMappings` above first: for those three collections absent and empty are the same thing on purpose, and someone already tried to change that and broke three `plans.integration` tests. THIS ONE DIVERGES, by owner ruling (2026-08-17), and the divergence is expressed as `| null` rather than as a boolean flag beside an array precisely so a caller cannot forget to consult it: `computePlanDiff` cannot read the collection without deciding what `null` means.

`null`  = the manifest had NO `producers` key = this stack manages no producer declarations. The prune step is skipped ENTIRELY and no diff entries are emitted at all. `[]`    = the key was present and empty = "I manage producers and declare none" -> prune all.

WHY THE ASYMMETRY IS CORRECT AND MUST SURVIVE THE NEXT SWEEP. For the three above, a prune-on-absent costs a route or a binding that an operator notices immediately. Here it returns a coordinate the org PUBLISHES to a public index on a daily poll timer, and the symptom is an ABSENCE of dependency updates: dependency confusion (ADR-0032 §7b clause 1) re-armed by a stack that merely forgot a key. The consistency argument is real and it loses to that.

THE ACCEPTED COST, stated where it bites: `Stack.synth()` omits an empty collection, so "unmanaged" and "I declare none" are indistinguishable in a SYNTHESIZED manifest, and `@scp/coordination-as-code` therefore cannot retract a stack's LAST declaration. Use the retract verb (which also reports the bumps already in flight), or hand-author `"producers": []`.

### §69. The second nullable collection, null for the same reason

THE SECOND `| null` COLLECTION, and it is null for the same KIND of reason `producers` is — read that comment first (proposal governance-reach-on-containment-move.md §9.6 Q4).

`null`  = the manifest had NO `governanceMoveRungs` key = this stack manages no rungs. The prune step is skipped ENTIRELY and no diff entries are emitted at all. `[]`    = the key was present and empty = "I manage rungs and declare none" -> disable all.

A rung is a governance BAR: pruning one on a forgotten key un-governs a subtree, and the symptom is an ABSENCE of refusals — moves that should have been refused quietly succeeding, which nothing surfaces until somebody audits where a governed object ended up. Same accepted cost as `producers`: `Stack.synth()` omits an empty collection, so `@scp/coordination-as-code` cannot disable a stack's LAST rung; use `DELETE /governance/move-enforcement/rungs/{idOrUrn}` or hand-author `"governanceMoveRungs": []`.

Each member is the SUBJECT CONTAINER'S URN — the whole identity. A rung has no value beyond existing, and its TIER is derived from the subject's object type, never declared.

### §70. The third nullable collection, null for the same reason

THE THIRD `| null` COLLECTION, null for the same KIND of reason the two above are — read both of those comments first (docs/proposals/team-pipeline-iac.md D11/D21).

`null`  = the manifest had NO `pipelineHooks` key = this stack manages no hooks. The prune step is skipped ENTIRELY and no diff entries are emitted at all. `[]`    = the key was present and empty = "I manage hooks and declare none" -> prune all.

A hook is a GATE. Pruning a `postDeploy` entry stops gating every wave's exit; pruning a `bakeAlarms` entry stops holding the widening. The symptom in both cases is an ABSENCE — of refusals, of holds, of anything at all — and nothing surfaces it until a bad release walks the whole fleet unimpeded. A stack that merely FORGOT A KEY must not disarm a gate an operator deliberately armed. Same accepted cost as the two above: `Stack.synth()` omits an empty collection, so `@scp/coordination-as-code` cannot remove a stack's LAST hook; remove one while others remain, or hand-author `"pipelineHooks": []`.

Ownership is DERIVED from the owning COMPONENT (`pipeline_hooks` has no `managed_by_stack`), exactly as `sourceMappings`/`executorBindings` are: the pool a prune considers is hooks whose component this stack owns.

### §71. The two collections that were authorable and dropped

D12 / D25(b) — the two collections that were authorable and dropped until migration 0106.

ORDINARY RULE, unlike `pipelineHooks` directly above: absent and empty are the SAME here and both prune, so these are plain arrays rather than `| null`. The asymmetry is the contract's and is deliberate — an omitted hook DISARMS A GATE, while an omitted rollout costs a declared strategy that is visible the next time anything deploys.

### §72. Live objects the diff must reason about, keyed by urn

Live objects the diff needs to reason about, keyed implicitly by `urn` (one entry per live URN). Must cover: every URN referenced by `manifest.objects` that currently exists, every URN referenced as a relationship endpoint (`fromUrn`/`toUrn`, including "external" URNs outside this stack) that currently exists, AND every object whose `managed_by_stack` is this stack (drizzle/0068) regardless of whether it's still in the manifest (prune detection). A superset is harmless — `plans-repo.ts` errs toward fetching more rather than risking a missed prune/create signal.

### §73. Live relationship triples this stack manages

Live relationship `(typeId, fromUrn, toUrn)` triples whose `managed_by_stack` is this stack (drizzle/0068) — the exhaustive prune-candidate pool. Anything in here NOT present in `manifest.relationships` becomes a `delete` entry.

### §74. Live relationship triples that exist for any reason

Live relationship `(typeId, fromUrn, toUrn)` triples that exist for ANY reason (managed by this stack, another stack, or created by hand) — the "does this already exist" pool used for create/noop determination, so a plan never proposes creating a relationship that would 409 at apply time. Overlapping with `managedRelationships` is expected and harmless.

### §75. Live source mappings hanging off objects this stack owns

Live `source_mappings` rows hanging off an object THIS stack owns, URN-keyed (C1). This is BOTH the prune-candidate pool AND the "does this already exist" pool — ONE pool, because ownership is inherited from the owning object rather than carried on the row (see `@scp/schemas`'s `coordination-as-code.ts` C1 note): a row on an object this stack owns is this stack's to converge, and a row on any other object is invisible here and therefore unprunable. `plans-repo.ts` builds it; a duplicate tuple (the table has no unique constraint) collapses to one entry here, and pruning removes every duplicate.

### §76. Live declarations for the coordinates this manifest names

Live declarations for the coordinates THIS MANIFEST NAMES, regardless of who owns the producer — the "does this coordinate already have a producer" pool, exactly parallel to `existingRelationships` sitting beside `managedRelationships`.

TWO POOLS, NOT ONE, AND THE SECOND IS WHAT MAKES A TRANSFER VISIBLE. `dependency_line_producers` is keyed on the COORDINATE, so a declaration can change hands without any row being deleted: `ON CONFLICT (org_id, ecosystem, coordinate) DO UPDATE` silently re-points it. With only the ownership-scoped pool, a manifest claiming a coordinate another stack currently produces would diff as a plain `create` and apply would perform the steal without a word — and the victim stack could never see it, because after the transfer the row is outside ITS pool too. This pool is how the diff learns to say `update` + `displacedProducerUrn`, which is in turn what lets the ownership guard refuse the cross-stack case from the STORED diff at apply time.

A coordinate the manifest does not name may be absent here; the diff only ever asks about keys it is converging.

### §77. Live move rungs whose subject container this stack owns

Live `governance_move_rungs` rows whose SUBJECT CONTAINER this stack owns, as subject URNs — the prune pool AND the existence pool, which for this collection is ONE pool rather than the two `producers` needs.

The second pool exists there because a producer declaration is keyed on the COORDINATE and can change hands with no row deleted, so "who holds it" is a question the ownership-scoped pool cannot answer. A rung is keyed on its SUBJECT and cannot change hands at all: it is enabled at that container or it is not. And a declaration whose subject this stack does not own is REFUSED (`invalidGovernanceMoveRungDeclarations`), so every rung this diff asks about is one whose subject is in the pool. One pool is therefore not a simplification — it is the whole question.

### §78. Live `pipeline_hooks` rows whose COMPONENT this stack owns

Live `pipeline_hooks` rows whose COMPONENT this stack owns — the prune pool AND the existence pool, ONE pool for the reason the projection tables have one: ownership is inherited from the component the row hangs off, so a hook on a component this stack owns is this stack's to converge and a hook on any other component is invisible here and therefore unprunable.

`plans-repo.ts` builds it and it is left EMPTY when the manifest omits the collection — reading a prune pool we must never act on would only invite a later edit to act on it.

### §79. A hook's DIFF key

A hook's DIFF key — the WHOLE declaration, identity and payload alike, exactly as `sourceMappingKey` keys nearly the whole tuple and for the same reason.

A hook has no attribute that converges in place. `sourceMappings` has one (`scope`) and pays for it with an `update` verdict; a hook's every field IS the gate, so a `stage` that moved from `undefined` (every wave) to `"prod"` is not the same gate wearing a new value — it is a narrower gate, and D21(a) is emphatic that adding a `stage` REMOVES gates. Keying on the identity alone would render that change as a `noop` while the apply's upsert quietly rewrote it: a gate changed with no plan line, which is precisely the class of silence this whole collection exists to prevent.

So the key includes the payload and a changed hook is a `delete` plus a `create` — two lines the reviewer sees. The identity tuple still matters, at the DB (`pipeline_hooks_identity`) and at `pipelineHookIdentityKey`, where a manifest declaring one tuple twice is REJECTED rather than collapsed: two declarations sharing an identity but differing in payload would race through one row and the last would silently win.

### §80. The ref pattern is in the key and the other is deliberately out

`refPattern` is IN the key and `classification` is deliberately OUT of it (ADR-0030 §1/§2).

The ref is a ROUTING discriminator: `refs/heads/dev` → the dev pipeline and `refs/heads/main` → the production one are two legitimate rows differing in nothing else. Leaving it out would make them one key — the second declaration would diff as a `noop` (so the dev pipeline would never be created, silently), and a prune of either would match both.

The classification is a descriptive label. Keying on it would turn "relabel this pipeline `dev`" into a delete-plus-create of a LIVE route, which is a real interruption for a cosmetic edit.

### §81. A producer declaration's identity

A producer declaration's identity — `(ecosystem, coordinate)`, mirroring the table's `PRIMARY KEY (org_id, ecosystem, coordinate)`. The PRODUCER IS DELIBERATELY OUT OF THE KEY: it is the row's value, so re-pointing a coordinate is an `update` of one row. Putting the producer in would turn every transfer into a delete-plus-create of the same primary key — two entries whose apply order decides the outcome, for a table that can only hold one of them.

### §82. The stand-in urn when a producer object cannot be named

THE STAND-IN URN FOR A LIVE DECLARATION WHOSE PRODUCER OBJECT CANNOT BE NAMED — a tombstoned (or hard-deleted) component, which `plans-repo.ts` cannot resolve to a URN because every object read there filters `deleted_at IS NULL`.

WHY A SENTINEL AND NOT A DROP. `dependency_line_producers` has no `deleted_at` of its own and `deleteObject` is a SOFT delete, so tombstoning a producer component leaves the declaration STANDING: the coordinate still has a holder, and the next declaration of it is an `ON CONFLICT DO UPDATE` that overwrites that holder. Dropping the row from the existence pool made the diff say `create` — whose reason sentence is literally "no producer is declared for this coordinate — it is polled as third-party today" — for a coordinate that IS declared. The plan an operator reviews would then be false about the single fact that decides whether the apply is a first declaration or a silent overwrite.

WHY IT IS NOT THE TOMBSTONED OBJECT'S REAL URN. `invalidProducerDeclarations` refuses a displacement whose URN is not in `diff.objects`; a real URN can legitimately BE there (a manifest still naming the deleted component diffs it as a `create`), which would let the overwrite through on exactly the plan that should be refused. A sentinel is refused by its own named branch instead of by set membership, so no manifest can construct a passing case.

NOT a valid address for anything: nothing resolves it, `executePlanDiff` never passes it to `endpointId`, and it appears only in `displacedProducerUrn`, which is read by the guard and by the operator. It satisfies `UrnSchema` because the diff is validated on the way into `plans.diff`.

### §83. A binding's identity

A binding's identity — `(target, type)`, mirroring `UNIQUE (org_id, target_object_id, type)`.

The two addressings are TAGGED rather than merged into one string. An untagged key would let an object URN and a placement pair collide in principle, and — more practically — makes the key unreadable in a failing diff. `target_object_id` is a single column, so the two forms are two ways of naming one row, never two rows.

### §84. The fields whose drift makes a binding an `update`

The fields whose drift makes a binding an `update`. MODE-DEPENDENT, and that is load-bearing: for an execution-system-backed binding the module, instance id, config, secret refs and egress allowlist are all SERVER-derived from the system at write time (`bindTargetToExecutionSystem`), so comparing the manifest's (necessarily absent) values against the stored derived ones would make every re-plan an `update` forever — DoD (b)'s "apply the same manifest twice is a no-op" would be false for every Mode A binding. Only what the author actually declares is compared.

### §85. Computes the create/update/delete/noop diff for one `@scp/coordination-as-code` plan

Computes the create/update/delete/noop diff for one `@scp/coordination-as-code` plan (DESIGN.md §15 — "Kubernetes-apply semantics, not client-side Terraform semantics"). Object identity is the URN; comparison uses the same canonical-JSON-equality discipline as `objects-repo.ts`'s `upsertObjectByUrn` true-idempotency check, so a plan re-computed against unchanged state is always all-noop (BUILD_AND_TEST.md §8 M2 DoD (b)).

Relationship diffing is identity-only (does a live `(typeId, fromUrn, toUrn)` triple exist?) — relationship `properties` drift is not diffed in this milestone (a changed relationship is effectively a delete+create the caller must express explicitly in the manifest); documented simplification, not an oversight.

### §86. Prune: objects this stack managed that the manifest dropped

Prune: objects this stack managed last time that are no longer in the manifest. Strictly scoped by `isStackManaged` — an object whose server-written `managed_by_stack` is not this stack is never a delete candidate here, even if its URN happens to collide with something (security self-check item 2, goal statement) and even if its LABELS say otherwise. That last clause is drizzle/0068: the labels are a mirror the subject can edit, the column is not.

### §87. §10.6 — the ONE in-place convergence this diff performs on a mapping

§10.6 — the ONE in-place convergence this diff performs on a mapping. A declared scope that differs from the live row's is an `update` (an attribute changed, not the identity — never a delete + create of a live route). An OMITTED scope manages nothing: the row's current value is reported and left alone, so a manifest that predates the field never clears a label an operator set by hand. Duplicate rows sharing the tuple: any one differing is enough to propose the update — apply converges every row matching the tuple, so the plan converges.

### §88. Two declarations for the same

Two declarations for the same (target, type) would race each other through the SAME upsert row: whichever ran last would silently win. `UNIQUE (org_id, target_object_id, type)` says there is exactly one, so a manifest claiming two is malformed desired state, not a precedence question (proposal §11: "a silently-preferred key is how parseTopologyWaves already loses malformed documents"). Rejected outright by `duplicateBindingDeclarations` before this function's output is ever used; the guard here just keeps the diff well-formed.

### §89. DEPENDENCY-LINE PRODUCERS (ADR-0032 §7e)

DEPENDENCY-LINE PRODUCERS (ADR-0032 §7e). Converge-then-prune like the three above, with ONE divergence and one addition:

- THE DIVERGENCE: `manifest.producers === null` (the manifest had no `producers` key) means UNMANAGED. The whole block is skipped — no entries, no prune, and the diff carries no `producers` key at all, so the stored plan itself records that this stack manages none. Every other collection treats absent as empty; read `ResolvedManifest.producers` for why this one must not, and do not "fix" the inconsistency. - THE ADDITION: identity is the COORDINATE, so a declaration changes hands without a delete. A live declaration by ANOTHER producer is an `update` naming the displaced one, not a `create` — see `existingDependencyProducers`.

### §90. `governance:move` RUNGS (ADR-0038 §2; proposal §9.6 Q4)

`governance:move` RUNGS (ADR-0038 §2; proposal §9.6 Q4). Converge-then-prune like the four above, with the SAME divergence `producers` has and NONE of its additions:

- THE DIVERGENCE: `manifest.governanceMoveRungs === null` (no key) means UNMANAGED. The whole block is skipped — no entries, no prune, and the diff carries no `governanceMoveRungs` key at all, so the stored plan itself records that this stack manages no rungs. - NO `update`: a rung has no value beyond existing (the tier is derived from the subject's type), so the verdicts are enable, disable and "already enabled". - NO transfer case: identity is the SUBJECT, and a rung cannot change hands.

### §91. PIPELINE HOOKS (D11/D21; migration 0096)

PIPELINE HOOKS (D11/D21; migration 0096). Converge-then-prune like every collection above, with the SAME divergence `producers` and `governanceMoveRungs` have and one shape note:

- THE DIVERGENCE: `manifest.pipelineHooks === null` (the manifest had no `pipelineHooks` key) means UNMANAGED. The whole block is skipped — no entries, NO PRUNE, and the diff carries no `pipelineHooks` key at all, so the stored plan itself records that this stack manages no hooks. Read `ResolvedManifest.pipelineHooks` for why, and do not "fix" the inconsistency: pruning a hook DISARMS A GATE and the symptom is an absence of refusals. - NO `update`: the diff keys on the WHOLE declaration (`pipelineHookKey`), so a hook whose payload moved is a delete plus a create — two lines the reviewer sees. - OWNERSHIP IS THE COMPONENT'S. The pool is hooks on components this stack owns, exactly as the projection tables' is; `unownedProjectionDeclarations` refuses the write half.

ROLLOUTS AND CONVERGENCE ARE NOW BELOW, and they follow the ORDINARY rule rather than this one (absent = empty = prune). Until migration 0106 they had no storage and this file said so — the half-wired state that comment warned about was live for both: `@scp/coordination-as-code` emitted them and the server discarded them.

### §92. ROLLOUTS (D12) and CONVERGENCE (D25(b))

ROLLOUTS (D12) and CONVERGENCE (D25(b)) — the ORDINARY collection rule.

Absent and empty mean the same thing and both prune, so there is no `!== null` guard above these: a stack that stops declaring a rollout retracts it, and the cost of being wrong in that direction is a strategy that has to be re-declared — visible the next time anything deploys, unlike a disarmed gate whose symptom is an absence of refusals.

UNLIKE HOOKS, THESE CARRY `update`. A hook's diff keys on the whole declaration, so a changed hook is a delete plus a create — two lines a reviewer sees, which is right when the change may disarm something. A rollout's identity is genuinely `(component, targetClass)`: the strategy is its VALUE, so a changed strategy is one object changing, and showing it as a deletion would imply a window in which the component had no strategy at all.

### §93. ROLE BINDINGS (drizzle/0108)

ROLE BINDINGS (drizzle/0108) — CREATE and DELETE only, and a delete REVOKES A PERSON'S ACCESS
No `update`: `(subjectUrn, roleName, scopeUrn)` is the whole identity — the same triple `role_bindings_grant_key` makes unique — so nothing is left over to be a binding's "value". A different grant is a different binding, and rendering it as an update would hide which authority went away behind a line that reads like an edit.

The prune population is `snapshot.managedRoleBindings`, which the repo scopes to this stack's own `managed_by_stack` rows. A binding granted by hand carries NULL and is therefore invisible here — that, not any check in this function, is what stops a manifest revoking an Owner binding somebody granted through the typed door.

PRUNE-ON-ABSENCE IS DELIBERATE HERE AND DELIBERATELY ABSENT ON TWO OTHER COLLECTIONS, so the asymmetry is a decision on the record rather than an inconsistency to be "fixed" later. `pipelineHooks` and `producers` do NOT prune on absence: a forgotten manifest key there would disarm a gate or re-arm dependency confusion, and the symptom of both is an ABSENCE OF REFUSALS, which nobody notices until it matters. A role binding fails the opposite way — a forgotten key revokes access and the person says so within minutes. Loud-and-recoverable is the safe direction to be wrong in, which is why the owner's ruling here was "Both, with revocation" (2026-08-28).

### §94. Components this plan creates with no incoming containment

URNs of components this plan CREATES that have no incoming `contains` edge in the same plan — the strict create-in-service invariant, enforced on the IaC path too (owner ruling 2026-07-16, "make IaC strict"; M12 P5a, docs/proposals/organize-after.md). A component ALWAYS belongs to a service; a manifest that mints one with no owning service is malformed desired state, rejected 400 at plan-compute AND (defense-in-depth, matching every other invariant this module's apply path re-checks) at apply — `plans-repo.ts` is the caller for both.

Pure (plain data in, `string[]` out — this module's discipline) so it's unit-testable without a DB. Only object CREATES are checked: updating or reading an already-existing component (including an orphan imported via discovery/accept, which is permissive by design) needs no service, and re-assigning one between services is P5b's `move` verb. A `contains` edge counts whether it is itself being created (the usual case — both endpoints are new) or already live and merely restated as a noop; only a `delete` of the edge does NOT satisfy containment.

### §95. Readable descriptions of the entries this plan may not write

Human-readable descriptions of any `sourceMappings`/`executorBindings` entry declared TWICE in one manifest (C1). Rejected 400 at plan-compute rather than resolved by precedence: for a binding the two declarations would race through the same `UNIQUE (org_id, target_object_id, type)` row and the last one would silently win; for a mapping the table has no unique constraint, so both would be written and correlation would match a component twice. Proposal §11's rule — "a silently-preferred key is how `parseTopologyWaves` already loses malformed documents" — applied to the same shape.

Pure over the RESOLVED manifest (normalized patterns/Types), so `{repoPattern: undefined}` and an omitted `repoPattern` are correctly seen as the same declaration rather than two.

### §96. A coordinate declared twice

A coordinate declared twice — to the SAME producer or to two different ones. Both are rejected, and the second is the one that matters: the table holds one row per coordinate, so the two declarations are not two rows but two opinions, and `ON CONFLICT DO UPDATE` would silently keep whichever the array happened to end on. "Declared, never inferred" is worth nothing if WHICH component was declared depends on array order.

### §97. A hook is keyed on its identity here, not its declaration

A HOOK IS KEYED ON ITS IDENTITY HERE AND NOT ON ITS DECLARATION, which is the opposite of what `pipelineHookKey` (the DIFF key) does, and the divergence is the whole point. Two declarations sharing `(componentUrn, hookKind, hookId)` but differing in payload are the dangerous shape: they race through one `pipeline_hooks_identity` row and the last one silently wins — the silently-preferred key proposal §11 names. A BYTE-IDENTICAL repeat is not an offender; the diff collapses it, because the two copies cannot disagree about what the gate is.

### §98. Readable descriptions of producer declarations it may not make

Human-readable descriptions of every producer declaration this plan may not make — the IaC twin of the two refusals `routes/dependency-producers.ts` performs, re-expressed so they can be re-derived from the STORED DIFF at apply time (exactly like `unownedProjectionDeclarations`, and for the same fail-closed reason: a plan computed by an older build must not be trusted).

THREE REFUSALS.

1. THE PRODUCER IS NOT AN OBJECT THIS STACK OWNS. `dependency_line_producers` carries no labels, so ownership is inherited from the producing component — the same rule the projection tables use. Without this, stack A writes a declaration onto stack B's component: a row A can never see again (it is outside A's prune pool) and B's next apply prunes one it never declared.

2. THE DISPLACED PRODUCER IS NOT THIS STACK'S EITHER. This one has no analogue in the other collections and it is the reason `displacedProducerUrn` exists. A producer declaration changes hands WITHOUT A DELETE — the key is the coordinate, and the table upserts — so refusal (1) alone lets stack A take `@acme/lib` from stack B's component P by declaring it on A's own component Q. Refusal (1) passes (Q is A's). The row is then outside B's pool forever: B cannot prune it, cannot restore it, and no plan of B's ever mentions it again. The coordinate the org publishes silently changed hands. Transfers are legitimate — through the VERB, which reports the blast radius and the bumps in flight, or within one stack — but not as a side effect of a manifest that never names the component it takes from.

```text
  AND THE HOLDER MAY BE UNNAMEABLE. A tombstoned producer component leaves its declaration
  standing (soft delete; the table has no `deleted_at`), and no object read resolves it to a
  URN — so the displacement carries `unresolvedProducerUrn` and gets its own refusal
  branch. Same act, same reason; only the remedy differs, because there is no stack to hand the
  coordinate back to.
```

```text
  "This stack's" here means "appears in `diff.objects` AT ALL", `delete` entries included. A
  delete entry can only have come from the label-scoped prune pool, so its presence PROVES
  ownership; excluding it would refuse the ordinary "component P is being replaced by Q, and the
  coordinate moves with it" manifest, which is a legitimate one-stack transfer.
```

3. THE PRODUCER IS NOT A `component`. `listProducedLines` derives a head only from the component a production placement names, so a `service`-valued declaration removes the coordinate from third-party polling and derives no head at all — the harmful half without the useful one (ADR-0032 §7e). The typed verb refuses it; this door must too, or IaC is the way around it.

`delete` entries are exempt from (1) and (3): a prune entry can only have come from the ownership-scoped pool, and its producer component may legitimately be being deleted by this same plan.

### §99. Readable descriptions of move rungs this plan may not write

Human-readable descriptions of any `governanceMoveRungs` entry this plan may not make (ADR-0038 §2; proposal §9.6 Q4). Two refusals, both derived PURELY from the diff so `plans-repo.ts` can re-run them at apply against the STORED diff — the same defence-in-depth every other guard here gets:

1. THE SUBJECT IS NOT AN OBJECT THIS STACK OWNS. `governance_move_rungs` carries no labels, so ownership is inherited from the subject container — the rule the projection tables and `producers` already use. Without it, stack A enables a rung on stack B's service: a row A can never see again (it is outside A's pool) and B's next apply disables one it never enabled. The practical consequence is worth stating rather than discovering: a rung on the ORG ROOT, or on a container another stack owns, is authored through the API/CLI, not through a manifest.

2. THE SUBJECT CANNOT CARRY A RUNG. `moveRungTierForObjectType` is the one place that decides which types can (`assertRungSubjectType` is its throwing form at the HTTP door): a rung governs moves of the things INSIDE a container, and nothing is contained by a component or a deployment-target, so a rung on one would govern the empty set of moves — a bar an operator believes they set and that refuses nothing, which is worse than no bar. The typed verb refuses it; this door must too, or IaC is the way around it.

`delete` entries are exempt from BOTH: a prune entry can only have come from the ownership-scoped pool (so ownership is proved), its subject's type was proved when the rung was enabled, and the subject container may legitimately be being deleted by this same plan.

### §100. Readable descriptions of the entries this plan may not touch

Human-readable descriptions of any `sourceMappings`/`executorBindings` entry this plan would WRITE whose owning object the stack does not own (C1) — the enforcement half of the ownership-scoping decision documented in `@scp/schemas`'s `coordination-as-code.ts`.

WHY IT MUST EXIST. Neither projection table carries an owner of its own, so ownership is inherited from the graph object the row hangs off. Inheritance only scopes pruning if the converse also holds: a stack may only WRITE a row onto an object it owns. Without this, stack A could create or update a binding on stack B's component — a row A can never see again (it is outside A's prune pool, because the object's `managed_by_stack` is B), so A can never remove it and B's next apply prunes a row it never declared. Refusing the write is what keeps ownership single-valued in both directions, and it is what makes "a stack never touches another stack's rows" true rather than merely true-for-deletes.

DERIVED PURELY FROM THE DIFF, exactly like `uncontainedComponentCreates`, so `plans-repo.ts` can re-run it at APPLY time against the STORED diff without re-reading the graph — defence in depth against a plan computed by an older build. An object entry with any action other than `delete` is an object this stack will own once the plan applies (the diff carries an entry for every manifest object, and apply stamps `managed_by_stack = <stack>` on each — drizzle/0068). A `delete` mapping or binding entry is exempt: it can only have come from the prune pool, which is already ownership-scoped, and its owning object may legitimately be being deleted by this same plan.

### §101. The pair must ALSO survive this plan

The pair must ALSO survive this plan. Apply runs binding-prune, placement-prune, placement-create, binding-create in that order, so a binding declared on a pair the manifest does not declare would be written onto a placement the SAME apply just pruned — failing at the resolve step, mid-apply, after other writes had landed. Refusing here turns that into a plan-time error naming both halves.

### §102. PIPELINE HOOKS, under the identical rule and for the identical reason

PIPELINE HOOKS, under the identical rule and for the identical reason. `pipeline_hooks` carries no owner of its own, so ownership is inherited from the COMPONENT the row hangs off — and inheritance only scopes pruning if the converse also holds. Without this, stack A arms (or re-declares) a gate on stack B's component: a row A can never see again, because it is outside A's prune pool, and B's next apply DISARMS a gate it never declared. `delete` is exempt for the same reason it is above: a prune entry can only have come from the ownership-scoped pool, and its component may legitimately be being deleted by this same plan.

## `apps/server/src/coordination-as-code/plans-repo.ts`

### §103. Rejects a diff creating a component with no owning service

Rejects (400) a diff that CREATES any component with no owning service (M12 P5a, owner ruling 2026-07-16 "make IaC strict"). Called at BOTH plan-compute (so `POST /plans` fails fast, and the reviewed plan is guaranteed valid) AND apply (defense-in-depth: `prepareApplyChecks` re-derives every invariant from the STORED diff rather than trusting plan-compute ran — the same fail-closed discipline the policy-scope / campaign-target / system-managed-type checks in this module use). The message points at both the IaC ergonomics fix and the raw-manifest fix.

### §104. Rejects a plan that would write such a row it may not

Rejects (400) a plan that would WRITE a `source_mappings`/`executor_bindings` row onto an object this stack does not own (C1). Run at BOTH plan-compute and apply, exactly like `assertComponentsContained` and for the same reason: `prepareApplyChecks` re-derives every invariant from the STORED diff rather than trusting plan-compute ran.

This is the enforcement half of the ownership-scoping decision (see `plan-diff.ts`'s `unownedProjectionDeclarations` for the full rationale) — it is what makes "a stack never touches another stack's rows" true for writes as well as for prunes.

### §105. Rejects a plan whose producer declarations it may not make

Rejects (400) a plan whose producer declarations this stack may not make — the producer it does not own, the CURRENT producer it would displace and does not own, or a producer that is not a `component` (ADR-0032 §7e). Run at BOTH plan-compute and apply, from the DIFF alone, exactly like `assertProjectionsOwned` and for the same fail-closed reason.

The displacement half has no analogue in the other collections and is the one worth pausing on: a producer declaration is keyed on the COORDINATE and upserted, so it can change hands with NO row deleted anywhere. Owning the destination component is therefore not sufficient to make a transfer this stack's business — `invalidProducerDeclarations` carries the full argument.

### §106. Rejects a plan whose move-rung declarations it may not make

Rejects (400) a plan whose `governance:move` rung declarations this stack may not make — a rung on a container it does not own, or on a type that cannot carry one. Run at BOTH plan-compute and apply, exactly like the three guards around it and for the same reason: `prepareApplyChecks` re-derives every invariant from the STORED diff rather than trusting plan-compute ran.

`invalidGovernanceMoveRungDeclarations` carries the full argument for both refusals.

### §107. Rejects a manifest declaring the same thing twice

Rejects (400) a manifest declaring the same source mapping or the same `(target, type)` binding twice. See `duplicateProjectionDeclarations` — silently preferring one is the failure mode proposal §11 names explicitly.

### §108. A manifest hook, flattened to the row shape the diff keys on

A manifest hook -> the flat, fully-NORMALIZED row shape the diff keys on.

Every per-kind field is written to `null` where the kind does not carry it, rather than left `undefined`. That is what makes the DESIRED side (a discriminated union whose members simply lack the fields they do not use) key byte-for-byte against the ACTUAL side (rows from a table whose per-kind columns are all nullable). Skip it and a `postMerge` hook keys one way from the manifest and another from the database, so every plan proposes a delete plus a create for a hook nobody touched — and, worse, the apply performs them.

The per-kind reads are guarded by the discriminant rather than by optional chaining so a fifth hook kind cannot be added without this function failing to compile.

### §109. Runs the same three checks for every inline binding

Runs, for every INLINE binding this plan would write, the exact three checks `PUT /executors/{idOrUrn}/binding` runs before storing one — module allowlist, reserved instance-id namespace, and plugin config-schema validation. Called at BOTH plan-compute and apply.

This is the census, not a nicety. IaC apply is a SECOND door into `executor_bindings`, and each of these guards was written because the FIRST door needed it: an unknown/wrong-kind `pluginModule` otherwise surfaces as a confusing dispatch-time failure (M8 item 6); a `pluginInstanceId` in the reserved `execution-system:` namespace silently re-points a real system's coordination traffic at tenant config (`assertNotReservedInstanceId`); and `managed-iac`'s `additionalProperties: false` config schema is what stops a tenant setting the server-governed runnerImage/networkMode/ workspaceRoot (adversarial-review CRITICAL #1). A guard on one door only is not a guard.

Execution-system-backed bindings are deliberately NOT checked here — their module and instance id are derived from the system object at write time, and validating them needs a read of that object, which must not happen before `authorize()` (see `executionSystemBindingIdentity`'s call-order note).

### §110. The thin database wrapper around the pure diff engine

The thin DB-I/O wrapper around `iac/plan-diff.ts`'s pure diff engine, plus the `plans` table's CRUD and the apply-time authorization-scope resolution + mutation execution. Everything that *can* be a pure function lives in plan-diff.ts (BUILD_AND_TEST.md §4.1); this module is where that meets `graph/objects-repo.ts`/`graph/relationships-repo.ts` (reused, never reimplemented — per the parent task's explicit instruction).

### §111. The URN of one object by id, TOMBSTONES INCLUDED

The URN of one object by id, TOMBSTONES INCLUDED — deliberately unlike every other object read in this file, all of which filter `deleted_at IS NULL`.

Used only to NAME the current holder of a producer coordinate in an apply-time refusal. `dependency_line_producers` has no `deleted_at` and `deleteObject` is a soft delete, so a holder may perfectly well be tombstoned while its declaration stands; a refusal that could not name it would leave the operator with a coordinate, a conflict, and nothing to go and look at. Never used to resolve an address — nothing is written to a tombstoned object on the strength of this.

### §112. Live objects this stack OWNS

Live objects this stack OWNS — the object prune pool.

Keyed on the server-written `managed_by_stack` column (drizzle/0068), NOT on `labels @> {"scp:managed-by":"iac","scp:stack":…}` as it was until then. That containment test read a map the prune target itself could write under plain `object:write`, so two label keys put an arbitrary object into this delete pool — or took an object out of it, so its own stack could never decommission it. `iac/stack-ownership.ts` has the full account.

### §113. Bindings THIS stack owns

Bindings THIS stack owns (drizzle/0108). The `managed_by_stack` predicate is the whole safety property of IaC-managed authority: a binding granted through `POST /role-bindings` carries NULL, never matches, and therefore cannot be revoked by any manifest.

Joined to `roles` for the NAME, because a manifest declares a role by name and the diff has to key on the same thing the author wrote.

### §114. Assembles a snapshot from live state and runs the diff

Assembles a `PlanDiffSnapshot` from live graph state and runs the pure diff engine (`plan-diff.ts`). Zod validation of `manifest` (400 on malformed input) happens in the route handler BEFORE this is ever called — security self-check item 3 (goal statement).

### §115. `governance:move` RUNG SUBJECTS

`governance:move` RUNG SUBJECTS — id-or-URN in, URN out, resolved HERE (a DB read, hence not in the pure diff engine) so every downstream stage speaks the one vocabulary the rest of the diff uses. Same shape as the `executionSystemId` resolution further down, with one addition that matters:

A URN THIS MANIFEST ITSELF DECLARES IS CARRIED VERBATIM AND NOT LOOKED UP, because the subject may not exist yet — "create this service and govern moves under it" is the ordinary first manifest, and resolving it here would 404 on precisely the plan that is allowed to create it. Every other reference must already exist, and a miss is "your manifest is wrong" (400) rather than a plan that silently manages nothing.

### §116. A role binding names TWO objects and OWNS NEITHER

A role binding names TWO objects and OWNS NEITHER. Unlike every collection above — where the referenced object is the row's owner and the stack declares it — a binding points at a subject and a scope that almost always live outside this stack (a user, an org root, somebody else's service). They are added here so `endpointId` can resolve them at apply; ownership is unaffected, and `computePlanDiff` never treats them as objects this stack manages.

### §117. C1 — the ownership pool for `source_mappings`/`executor_bindings`

C1 — the ownership pool for `source_mappings`/`executor_bindings`.

Neither table carries an owner of its own, so a row's owner is the owner of the object it hangs off. The pool is therefore "every object this stack will own once this plan applies": the objects it ALREADY owns (`managedObjectRows` — `managed_by_stack` = this stack) UNION the live objects this manifest declares (apply stamps ownership onto each, so declaring an object adopts it).

One pool serves BOTH prune detection and create/noop matching, and that union is what makes it correct. Restricting it to already-labelled objects would make the FIRST apply that adopts a discovery-imported component blind to that component's existing mapping rows — it would create a byte-identical duplicate (the table has no unique constraint to stop it) and then propose deleting it on the next plan, so the same manifest applied twice would not be a no-op.

### §118. THE BINDING POOL SPANS OBJECTS *AND* PLACEMENTS

THE BINDING POOL SPANS OBJECTS *AND* PLACEMENTS. `executor_bindings.target_object_id` points at either, and a placement is not in `manifest.objects` (that door refuses pair-bound types, #207), so keying the pool on owned OBJECTS alone made every binding on a placement invisible to the diff: unadoptable (a re-plan proposes it forever) and unprunable. Sequenced after the placement read rather than folded into the Promise.all above, because the placement ids ARE the extra targets — the dependency is real, not incidental ordering.

### §119. PRODUCER DECLARATIONS (ADR-0032 §7e)

PRODUCER DECLARATIONS (ADR-0032 §7e) — TWO pools, mirroring `managedRelationships` vs `existingRelationships` rather than the projection tables' one-pool shape.

The prune pool is ownership-scoped: declarations whose PRODUCER is a component this stack owns. The existence pool is NOT, and must not be — a declaration is keyed on the coordinate and upserted, so `@acme/lib` can move from stack B's component to stack A's with nothing deleted. Reading only the scoped pool would make that transfer look like a `create` and let apply perform it silently; reading the live row for each DECLARED coordinate is what turns it into an `update` naming the displaced producer, which `invalidProducerDeclarations` then refuses when the displaced producer is not this stack's.

Skipped entirely when the manifest has no `producers` key: that means UNMANAGED (see `ResolvedManifest.producers`), so there is nothing to converge and nothing to prune, and reading a prune pool we must never act on would only invite a later edit to act on it.

### §120. THE PRUNE POOL

THE PRUNE POOL — DROP, and here the claim holds. This pool decides what gets RETRACTED. A declaration whose producer cannot be named is one this plan can neither honestly report a prune of (the reviewed entry names the producer LOSING the coordinate) nor prove ownership of, since ownership is inherited from a component that is no longer there. Dropping it means the retraction does not happen: inaction, and the coordinate keeps the behaviour it has today.

### §121. THE EXISTENCE POOL

THE EXISTENCE POOL — KEEP, ALWAYS. This pool answers "does this coordinate already have a holder", and the answer is YES whether or not the holder can be named: the row is live and the next declaration is an upsert straight over it. Dropping it made the diff emit a `create`, whose reason sentence tells the reviewing operator the coordinate "is polled as third-party today" — so the plan inverted its own most consequential fact and the apply performed an unreviewed overwrite. Keeping the row under `unresolvedProducerUrn` makes it an `update` that NAMES the situation, which `invalidProducerDeclarations` refuses in its own branch.

### §122. `governance:move` RUNGS (ADR-0038 §2)

`governance:move` RUNGS (ADR-0038 §2) — ONE pool, ownership-scoped, and the reason it is one rather than the two `producers` needs is on `PlanDiffSnapshot.managedGovernanceMoveRungs`.

Read through `listGovernanceMoveRungs` — the same function the API list read and the Admin page use — rather than a SELECT written here, so a plan can never disagree with what an operator sees on the page they authored the rung from. The whole org's rungs is a handful of rows by construction (one per governed container), so the filter is in memory.

Skipped entirely when the manifest has no `governanceMoveRungs` key: absent means UNMANAGED, so there is nothing to converge and nothing to prune, and reading a prune pool we must never act on would only invite a later edit to act on it.

### §123. PIPELINE HOOKS (D11/D21; migration 0096)

PIPELINE HOOKS (D11/D21; migration 0096) — ONE pool, ownership-scoped through the COMPONENT, exactly like `source_mappings` and `executor_bindings` and for the identical reason: `pipeline_hooks` carries no owner of its own, so a row's owner is the owner of the component it hangs off. The pool therefore serves BOTH prune detection and create/noop matching.

Skipped entirely when the manifest has no `pipelineHooks` key: absent means UNMANAGED (see `ResolvedManifest.pipelineHooks`), so there is nothing to converge and nothing to prune, and reading a prune pool we must never act on would only invite a later edit to act on it.

### §124. ROLE BINDINGS AND ORG ROLES

ROLE BINDINGS AND ORG ROLES (drizzle/0108). Read UNCONDITIONALLY for the reason the rollout pool gives: absent means empty for both, so a prune is always in scope and a pool we skipped reading would make every prune a silent no-op.

SCOPED TO THIS STACK'S OWN ROWS. `managed_by_stack = :stackName` is the whole safety property: a binding granted through `POST /role-bindings` carries NULL, is invisible here, and therefore cannot be revoked by any manifest.

### §125. §9 — STACK THEFT IS A 409, NOT AN INTERNAL ERROR

§9 — STACK THEFT IS A 409, NOT AN INTERNAL ERROR. `computePlanDiff` throws a typed `StackOwnershipConflictError` when the manifest names an object another stack manages; without this mapping it would surface as a 500 and read as a server fault rather than the deliberate refusal it is. Adoption of an UNMANAGED object is untouched and stays legal — that is how an existing estate comes under IaC in the first place.

### §126. The apply-time half of the stack-theft refusal

The apply-time half of §9's stack-theft refusal, read against LIVE `managed_by_stack`.

Every non-delete object entry is checked, not only the ones the stored diff marked `adopted`: the marking is a fact about the instant the plan was computed, and trusting it here would make the guard exactly as stale as the thing it is guarding against.

### §127. The diff, with its one typed refusal shaped for HTTP

`computePlanDiff` with its one typed refusal translated into an HTTP-shaped one.

Kept as a named wrapper rather than a try/catch inline so the APPLY door can call exactly the same thing (`prepareApplyChecks` re-runs the ownership check against the STORED diff, because a plan is reviewed at one instant and applied at another, and the object could have been claimed by another stack in between).

### §128. Loads and locks a plan for apply, rejecting non-pending

Loads and locks a plan for apply, rejecting anything not `pending` with 409 (goal statement: "re-applying an already-applied plan should be rejected with 409" — the diff it recorded may be stale; callers re-converge by POSTing a fresh `/plans`, which is also what makes "apply the same manifest twice" naturally produce an all-noop second diff, DoD (b)).

### §129. Apply: per-entry authorization-scope resolution, then mutation execution

Apply: per-entry authorization-scope resolution, then mutation execution. Split into two functions so the route handler (routes/plans.ts) can run EVERY `authorize()` call from `checks` to completion before calling `executePlanDiff` — "check every entry's permission BEFORE executing any mutation" (goal statement's security note), matching every other route's convention of owning the authz decision itself (objects-generic.ts, ownership.ts).

### §130. Object write for ordinary types, policy write for governed

`object:write` for every ordinary type; `policy:write` for the governance-owned `policy`/ `control` types — mirrors `routes/typed-registries.ts`'s `writePermission` gate so the IaC apply path can never authorize a governance-object write with a weaker permission than the typed `/policies`/`/controls` routes require (security fast-follow after PR #9).

M16.2 phase A (E1) adds the same treatment for the peer-bound `outpost` type: its own routes (`/api/v1/federation/outposts`) require `federation:write`, so a manifest declaring an `outpost` object must clear the SAME bar rather than the weaker `object:write` — otherwise `POST /plans` + `.../apply` would be a third door into commander-authored federation config with the wrong gate, exactly the shape the governance carve-out above was written to close. The 1:1 peer BINDING needs no work here: it is enforced inside `graph/objects-repo.ts`, which this path calls (`federation/outpost-binding.ts` explains the single-choke-point choice).

### §131. Resolves which permission and scope each entry needs

Resolves, for every non-noop diff entry, which permission + scope `authorize()` must allow. Object creates check `object:write` at the resolved target domain (mirrors `objects-generic.ts`'s create handler); updates/deletes check at the object's own id. Relationship creates/deletes check `relationship:write` at BOTH endpoints (mirrors the M1 security review's "relationship writes require write permission at both endpoints' scopes" — CRITICAL 1 — applied here too, not just on the generic endpoint). An endpoint not covered by any object diff entry in this plan (an "external" URN reference, or a plain pre-existing dependency) is resolved via a live lookup and must already exist — `getObjectByIdOrUrnAnyType` 404s otherwise.

**Governance carve-out (security fast-follow after PR #9's adversarial review):** a manifest can declare `policy`/`control` objects like any other type — `typeId` is a free-form string (`ManifestObjectSchema`), so nothing before this function stops a caller from including one. The ORIGINAL code checked only `object:write` here, meaning an actor with no `policy:write` anywhere could plant a `policy`/`control` object through `POST /plans` + `.../apply` even though both the typed `/policies` route AND (after this fix) the generic `/objects/policy` endpoint refuse that. Worse, for `policy` specifically, the DECLARED `properties.scope` was never bound to the actor's own authority — a narrow-scope actor's apply could plant an org-wide `required` policy, the exact CRITICAL #1b vector `assertPolicyScopeWithinAuthority` closes on the typed route. Fixed here by (a) using `policy:write` instead of `object:write` for these types (`writePermissionFor`), and (b) calling `assertPolicyScopeWithinAuthority` for every `policy` create/update, exactly like `routes/typed-registries.ts`'s POST/PATCH/PUT handlers do. Thrown eagerly (not deferred into the `checks` array the caller drains after this returns) — still fully fail-closed: an uncaught throw here aborts `prepareApplyChecks` before `executePlanDiff` ever runs, inside the same transaction the route handler opened, so nothing partially applies.

### §132. The stack this diff belongs to, required not optional

The stack this diff belongs to — REQUIRED, not optional, so §9's stack-theft check cannot be skipped by omission at a future call site. `PlanDiff` does not carry the name (the `plans` row does), and an optional parameter defaulting to "no check" is the shape that lets a third door quietly opt out of a guard the other two enforce.

### §133. §9 STACK THEFT, RE-CHECKED AT APPLY AGAINST LIVE OWNERSHIP

§9 STACK THEFT, RE-CHECKED AT APPLY AGAINST LIVE OWNERSHIP — and this door is the one that matters, not plan-compute's. A plan is reviewed at one instant and applied at another: an object that was unmanaged (legally adoptable) when the diff was computed may have been claimed by another stack since, and the stored diff would still say `adopted`. Reading the column here is the only check that sees the state the write will actually land on.

### §134. Those two invariants get the same defence in depth

C1's two invariants get the same defense-in-depth treatment, and for a sharper reason: a plan stored by a pre-C1 build cannot carry these collections at all, but a plan stored between plan-compute and apply by ANY build must still be re-proved to write only onto objects this stack owns, and to carry only inline bindings whose module/config clear the same bar the typed route requires.

### §135. A PAIR-BOUND type

A PAIR-BOUND type (`placement`) cannot be declared as a raw manifest object. This is the IaC-apply twin of `routes/objects-generic.ts`'s `assertNotPairBoundObjectType`, and it was missing: apply calls `createObject` DIRECTLY, so the route's refusal never ran here. A manifest declaring `typeId: "placement"` therefore wrote a row carrying two unresolved, un-type-checked UUIDs and — decisively — NO derived `places`/`placed_at` edges, leaving an island invisible to every traversal and impact query. Proven reachable on this exact code path before the guard existed, not reasoned about.

`pair-bound-types.ts` names its consumers as "the generic route and the federation overlay route — both user-facing create surfaces". IaC apply is a third, and was not on the list; the same omission shape as the system-managed RELATIONSHIP refusal below, which this file already carries for exactly the same "second injection vector" reason.

Refused for every non-noop action, not just `create`: an update would rewrite the pair without re-deriving the edges, and a delete would tombstone the object while leaving them. Placements are authored through `/api/v1/placements`; a stack that needs them declares them there until a typed manifest collection exists (post-import-configuration.md §8).

### §136. M25.7 — A PROJECTION-BOUND type

M25.7 — A PROJECTION-BOUND type (`freeze`) is refused for the same shape of reason one type further, and this door is the one where its absence was a live ESCALATION rather than a malformed row. `writePermissionFor` below maps every governance-managed type to `policy:write`, so adding `freeze` to that set did not close this door: it OPENED a substitution, in which `policy:write` at a narrow domain stood in for BOTH of a freeze's real gates (`freeze:write` at its own scope, `federation:write` on top to federate it), neither of which this path ever asks for. Worse, the create branch below scope-binds a declared `properties.*` for exactly `policy` and `campaign`, so the freeze's declared `scopeObjectId` was bound to nothing at all — a component-scoped actor could name the org root. And the row it produced was UNLIFTABLE AT BOTH ENDS: only `POST /v1/freezes` writes the object and its `freezes` row together, so `DELETE /v1/freezes/{id}` 404s here while the peer, which DOES rebuild the row, refuses to lift it because its origin domain is foreign.

Refused for every non-noop action, like the pair-bound refusal above and for the same reason: an update re-snapshots a window that federates, and a delete tombstones the wire form while leaving every peer's enforcement row standing (`import-repo.ts`'s tombstone branch lifts the projection, but only for an object this path never should have minted).

### §137. M5 (BUILD_AND_TEST.md §8 M5 security note)

M5 (BUILD_AND_TEST.md §8 M5 security note): the IaC-apply-path twin of `routes/objects-generic.ts`'s `campaign` block — a manifest declaring a `campaign` object is a free-form `typeId` just like `policy` is, so this apply path must independently bind its DECLARED `properties.targets` to the actor's own authority (same fail-closed shape as the policy-scope check right above), not rely on `POST /campaigns` having done so.

### §138. A containment move is a write at two places

A CONTAINMENT MOVE IS A WRITE AT TWO PLACES, and IaC apply is a door like any other. `executePlanDiff` writes `target.domainId` onto the row through the same `updateObject` the HTTP doors use, so without this a manifest re-parents an object the actor holds `object:write` over into a subtree they hold nothing at — and because RBAC scope expands strictly upward (`authz/resolve.ts`), that hands the destination subtree's holders custody of it. The apply-path twin of `graph/containment-parent-authz.ts`, written as a `checks` entry rather than a call to that helper because this path authorizes through one drained list (module doc above) and because the diff engine has ALREADY decided whether the parent changes — `plan-diff.ts` records exactly that as the `domainId` changed-field. Only a real change is checked, so an unchanged re-apply demands nothing extra: the same "re-stating the current parent is not a move" rule the helper applies, for the same idempotency reason.

BOTH ends, not just the destination. The entry below was only half of "a write at two places": authority expands strictly UPWARD, so holding it at the OBJECT says nothing about the container the object is being taken OUT of, and a manifest could yank a row out of a subtree the applier holds nothing at — the mirror image of the escalation the destination entry stops. The same second end `graph/containment-parent-authz.ts` now checks, and the one `graph/components-repo.ts`'s `setComponentService` has always checked ("the OLD service too on a move (it loses a child)").

TWO SOURCES ARE EXEMPT. `found.domainId` is null only for the org root ITSELF, which has no source container to authorize at — and `found.domainId === orgId`, the org ROOT OBJECT, is exempt too, because the org root cannot lose custody of anything that stays inside the org: `updateObject`'s `assertRootedContainmentParent` proves on this same write that the destination reaches the root, so the root is on the row's chain after the move exactly as it was before, and the premise of this check ("its holders lose custody") is false for it.

That second half was missing HERE as well as in the helper — the identical over-broad refusal, in the identical words, in the twin. It is not an edge case: `createObject` defaults an unnamed `domainId` to the org root, so MOST rows sit there, and apply refused every manifest that re-parented one of them unless the applier held ORG-ROOT authority. See `graph/containment-parent-authz.ts` for the full argument — the two copies must agree, and `routes/containment-root-source-and-create-rooting.integration.test.ts` pins both doors.

AND THE DESTINATION IS EXEMPT AT THE ORG ROOT FOR THE MIRROR REASON — the half that was reasoned about at neither end. A manifest that moves a row BACK to the top level named the org root as its destination, and demanding authority there refused an applier who owns the whole subtree the row is leaving. Nobody gains custody: X's chain already terminated at the org root (the root-reachability invariant), so the org root's holders held it before the move and hold it after, while the intermediate holders LOSE it — a strictly shrinking custodian set is not the escalation the destination entry stops. Full argument, including where the proof is one step weaker than the source-side one, in `graph/containment-parent-authz.ts`; `routes/containment-root-destination-authz.integration.test.ts` pins both doors.

Reachable on this path in TWO shapes, not one: an explicit `domainId` naming the org root, and — because `resolveDomainId` maps an ABSENT `domainId` to the org root — a manifest that simply omits the field for a row that currently sits inside a domain. The second is the common one and it is why this refusal bit IaC harder than it bit the HTTP doors.

The CYCLE half of the same fix is deliberately NOT duplicated here: it is a subject-free invariant and lives in `graph/objects-repo.ts`'s `updateObject`, which this path writes through — see the comment there for why the repo, not the doors, owns it. The ROOT- REACHABILITY half of the CREATE branch above is subject-free for the same reason and lives in `createObject`, which `executePlanDiff` calls directly.

### §139. THE `governance:move` TWIN

THE `governance:move` TWIN (proposal §9.2 door (b), owner ruling 2026-08-18). A door-only fix ships INERT on IaC — proven by mutation in #244 — so the second bar has to be added here as well as in `graph/containment-parent-authz.ts`, and the two must agree.

Thrown EAGERLY rather than pushed onto `checks`, for the reason `assertPolicyScopeWithinAuthority` and `assertCampaignTargetsWithinAuthority` are: the demand is CONDITIONAL (it exists only where a rung is enabled) and its refusal carries a written explanation naming the rung, neither of which a `{permission, scopeObjectId}` pair can express. Still fully fail-closed: an uncaught throw aborts `prepareApplyChecks` before `executePlanDiff` runs, inside the route's transaction, so nothing partially applies.

The applying principal is the REAL one (`actorObjectId`, resolved at apply time), which is what makes this path a genuine door rather than a replay of a plan-time decision.

NO ORG-ROOT EXEMPTION at either end, unlike the four `object:write` entries above — see `governance/move-enforcement.ts`'s header: custody shrinks at the root, but governance REACH is exactly what a move to the root reduces.

### §140. ROLE BINDING ENDPOINTS

ROLE BINDING ENDPOINTS. A binding names two objects and OWNS NEITHER — the subject and the scope almost always live outside this stack — so they are resolved here rather than falling out of the object loop above, which only walks objects the manifest DECLARES. Without this `endpointId` throws at apply and the whole plan 500s, which is exactly what it did.

No authorization check is attached: writing a binding is not writing the subject or the scope, and demanding `object:write` on them would refuse every legitimate grant to a user this stack does not manage. The authority question is the subset rule, which `createStackManagedRoleBinding` asks at the moment of the write.

### §141. RESOLVED FOR EVERY NON-DELETE ENTRY, INCLUDING `noop`

RESOLVED FOR EVERY NON-DELETE ENTRY, INCLUDING `noop` — checked only for the rest.

`executePlanDiff` stamps relationship ownership over `action !== "delete"`, which INCLUDES noops, and `endpointId` throws an internal error for a URN this pass never resolved. So a manifest re-declaring an ALREADY-EXISTING edge between objects it does not itself declare (it only references them) produced a 500 at apply.

THAT IS EXACTLY THE ADOPTION PATH, which is why no existing test caught it: an ordinary stack declares its own objects, so their URNs resolve in the object loop above. An estate exported by `scp iac export` references its service by URN (`Service.fromUrn`) and re-declares the `contains` edge that already exists — every endpoint a reference, every entry a noop. Measured end to end by `estate-migration.integration.test.ts`.

Resolving is not checking: a noop changes nothing, so it demands no new permission — the same "RESOLVED BUT NOT CHECKED" split the placement loop below already makes for its target.

### §142. M5 CRITICAL (adversarial review)

M5 CRITICAL (adversarial review): a manifest can declare any `typeId` on a relationship entry (`ManifestRelationshipSchema`), so this apply path — exactly like the generic `POST /relationships` endpoint (`routes/relationships.ts`) — must refuse an engine-owned system-managed type (`coordinates`/`approves`) outright. Otherwise IaC apply becomes a second injection vector for a `coordinates` membership edge that only needs `relationship:write`, bypassing the authority-checked campaign membership path (`graph/system-managed-relationships.ts` has the full rationale). Legitimate campaign IaC membership goes exclusively through the authority-checked `campaign.properties.targets` declaration (`assertCampaignTargetsWithinAuthority`, above).

### §143. THE `governance:move` TWIN FOR ROUTE 2

THE `governance:move` TWIN FOR ROUTE 2 — the SECOND half of door (b), and it was missing.

The twin above guards `objects[].domainId` (containment route 1). A manifest reaches the SAME move through route 2: a `contains` relationship entry. `contains` is not system-managed (`graph/system-managed-relationships.ts` lists `approves`/`coordinates`/`annotates` only), so the refusal above does not touch it, and `executePlanDiff` mints it — and prunes it — from the manifest verbatim. That is exactly what a manifest's `component.service` change compiles to (`plan-diff.ts`: a `contains` create plus a prune-delete), so without this, door (c) (`components-repo.ts::setComponentService`, `routes/relationships.ts`) shipped INERT on IaC and an Operator holding `relationship:write` could perform through `POST /plans/{id}/apply` the very move the HTTP doors refuse them. #244's lesson repeated one loop lower: the twin was added where the first hole was found rather than to the whole class.

Endpoints, matching `routes/relationships.ts` exactly: create → the child is the `to`, the destination container is the `from` (:104); delete → the child is the `to`, the destination is the ORG ROOT (`null`), because losing a `contains` parent drops the row back onto its `domain_id` route (:252). Thrown EAGERLY for the reason the route-1 twin above is: the demand is conditional and its refusal names a rung, neither of which a `{permission, scopeObjectId}` pair can carry. A MISSING `id` MEANS "created by THIS apply" (`ObjectResolution.id` is unset for a `create` entry until `executePlanDiff` runs it), and that decides both halves: - `to.id` unset → the child is being created here, so there is no prior governance reach for it to leave. A create is not a move; door (a) does not gate a create either (`resolveDeclaredContainmentParent` runs on an object that already exists), and `POST /discovery/accept` carves out the same shape for the same reason. Gating it would refuse the ordinary "new service and its new components" manifest under any enabled rung. - `from.id` unset → the destination CONTAINER is being created here; it can carry no rung of its own yet, and its reach is exactly its declared parent's, which is what `scopeObjectId` already holds (`entry.target?.domainId ?? orgId`). So the destination chain is checked at that parent rather than skipped.

### §144. PIPELINE HOOKS (D11/D21)

PIPELINE HOOKS (D11/D21) — `object:write` at the OWNING COMPONENT, the same per-object bar the mapping loop directly above uses, and for the same reason: a stack must not configure a component it does not own. Per-object rather than one coarse org-root check (unlike producers, whose blast radius really is org-wide): a hook's reach is exactly the component's own pipeline, and authz walks containment, so an org-wide writer still passes.

`delete` is INCLUDED, deliberately — narrowing this to `create` would let a principal holding `object:write` nowhere DISARM a gate, and a gate that is off announces itself only by an absence of refusals. `noop` is exempt, matching every other loop here.

The resolution is also what `executePlanDiff` needs: `deleteHook`/`upsertHook` are keyed on the component's OBJECT ID, so a prune entry has to be resolved here too, not only checked.

### §145. ROLLOUTS (D12) and CONVERGENCE (D25(b))

ROLLOUTS (D12) and CONVERGENCE (D25(b)) — `object:write` AT THE COMPONENT, the same rule the hook loop above uses and for the same reason: ownership of both is the component's, so the component's scope is where the authority to change them lives.

`delete` is included on both, matching the hook loop rather than the placement one: retracting a rollout removes a declared strategy, and retracting a convergence declaration stops a fleet self-healing. Neither is a gate, but neither is something a principal with no write authority on the component should be able to do.

### §146. RESOLVED BUT NOT CHECKED

RESOLVED BUT NOT CHECKED. `endpointId` throws an INTERNAL error for a URN this pass did not resolve, and the deployment-target may legitimately belong to another stack — so a placement at a foreign target used to fail apply with "internal: could not resolve object id". No `object:write` is pushed for it deliberately: ownership follows the COMPONENT (decision Q4), and demanding write on the target would hand every deployment-target owner a veto.

### §147. Producer declarations: policy write at the org root

PRODUCER DECLARATIONS — `policy:write` AT THE ORG ROOT, and deliberately NOT the per-object `object:write` every other collection in this function uses.

The rule is `dependencyProducerScopeCheck`'s, imported rather than restated so this door and `POST /dependencies/producers` cannot come to require different things. The reason it is not per-object is the reason the verb's is not: declaring "X produces @acme/lib" changes behaviour for every OTHER component in the org that depends on that coordinate, and RBAC scope expands strictly UPWARD — so `object:write` at X reaches none of the siblings it affects. One check for the whole plan, because the permission and scope do not vary per entry.

`noop` entries are exempt, matching every other loop here: a re-apply that changes nothing must not demand authority the first apply already exercised.

### §148. Move rungs: policy write at or above the subject, per entry

`governance:move` RUNGS — `policy:write` AT-OR-ABOVE THE SUBJECT, per entry.

The pair is `governanceMoveRungScopeCheck`'s, imported rather than restated so this door and `PUT /governance/move-enforcement/rungs/{idOrUrn}` cannot come to require different things. It is per-subject and not one org-root check (unlike producers, whose blast radius really is org-wide): a rung's reach is exactly the subtree under its container, and `authorize` expands strictly UPWARD, so a narrowly-bound Administrator can govern their own service and an org-wide one still passes everywhere.

`noop` entries are exempt, matching every other loop here: a re-apply that changes nothing must not demand authority the first apply already exercised.

A `create` whose subject THIS PLAN creates resolves to the pending entry — no id yet, and `scopeObjectId` is the declared containment parent (`entry.target?.domainId ?? orgId`). That is the right scope and not a weaker one: authority expands upward, so `policy:write` at-or-above the parent is `policy:write` at-or-above a child of it.

### §149. A placement-targeted binding authorizes at the component

A PLACEMENT-targeted binding authorizes at the COMPONENT, exactly as the placement loop above does (decision Q4) — and it must, because the placement object may not exist yet: on a first apply the same plan creates it a few steps later. Resolving the placement here would 404 on precisely the plan that is allowed to create it. `targetUrn` IS the component for a placement-targeted binding, so this one check covers both shapes — ownership follows the component (decision Q4).

### §150. A system-backed binding dispatches with that system's token

A system-backed binding makes SCP dispatch with THAT system's decrypted token (and, where both egress layers agree, its internal-egress reach) — a use-of-credentials capability. The typed route gates it with `object:write` at the system itself (ADR-0003); this door must too, or IaC apply is a way to borrow a system an actor may not use. The id is already resolved (plan-compute), so pushing the check needs no read — which is exactly what keeps this path from becoming the type/existence oracle `bindTargetToExecutionSystem`'s authorize-first ordering exists to prevent. The system's typeId/kind/serverUrl are validated later, in `executePlanDiff`, after every one of these checks has been authorized.

### §151. Executes an authorized diff inside the caller's transaction

Executes an already-authorized diff, all inside the caller's transaction (transactional apply, goal statement). Order matters: object creates/updates first (so relationship creates can resolve freshly-created endpoints), then relationship DELETES, then relationship CREATES, then C1's projection rows (mapping/binding deletes, then binding creates/updates, then mapping creates), then object deletes last (so a relationship delete never races an already-gone endpoint, and no projection row is orphaned behind a soft-deleted object).

Relationship deletes run BEFORE creates so a declarative re-parent converges in one apply (M12 P5b): changing a component's `service` in a manifest yields a `contains` create (new service) plus a prune-delete (old service) — with creates first, the new edge would trip migration 0022's one-service-per-component index while the old edge is still live (a false 409). Deleting first frees the component. Delete-before-create is safe generally: both endpoints are objects, which are created earlier (creates loop) and deleted later (object-deletes loop), so an edge's endpoints always exist during both its delete and its create; and no relationship depends on another relationship existing.

### §152. OWNERSHIP, STAMPED FOR EVERY OBJECT THIS MANIFEST DECLARES

OWNERSHIP, STAMPED FOR EVERY OBJECT THIS MANIFEST DECLARES (drizzle/0068). One statement, and one rule: a stack owns exactly the rows its manifest declares, plus the rows it already owned.

`noop` counts, and that is the case worth stating. A declared object that happens to be byte-identical to what is stored is still an object this stack declares — skipping it because "nothing changed" would leave it undeletable by the stack that owns it, which is the escape direction of the very defect this replaces, arrived at by accident. Under the old label scheme this was accidentally handled: adopting an object rewrote its labels, so it was never a noop on the apply that adopted it. Ownership is now explicit rather than a side effect of a label merge, so it has to be said.

`delete` entries are excluded by construction — they are not in this list — and ownership is never CLEARED here: a row leaves a stack by being pruned, not by being disowned into an orphan no stack could ever clean up.

### §153. The relationship half of the same stamp, after the creates

The relationship half of the same stamp, for the same reason, after the creates so a just-created edge is included. It also closes a gap the label scheme had: only edge CREATES were ever labelled, so an edge a manifest declared but that some other door had already written (`POST /components` writes a `contains` edge) stayed declared-but-unowned forever and could never be pruned by the stack that declared it. Objects never had that gap.

### §154. C1 — projection rows

C1 — projection rows. These run AFTER object creates (a binding needs its deployment-target / a mapping needs its component to exist) and BEFORE object deletes. The delete ordering is load-bearing, not cosmetic: `deleteObject` is a SOFT delete, and both projection tables are keyed on the object id with no `deleted_at` of their own. Prune the object first and its rows become permanently unreachable garbage — invisible to every list query (they filter on a live target) and outside every future plan's ownership pool (which is built from LIVE labelled objects), so nothing would ever remove them.

Deletes before creates/updates, mirroring the relationship ordering above and for the same reason: `UNIQUE (org_id, target_object_id, type)` means two bindings swapping Types in one plan would collide if the creates ran first.

### §155. The binding target a diff entry names, either way

The `executor_bindings.target_object_id` a diff entry names, whichever way it was addressed.

A placement is resolved BY ITS PAIR — its URN is derived (ADR-0026 D3), so there is no stable URN to look up. It must already be live at the moment of the call, which the apply ORDER makes true in both directions: binding-prune runs BEFORE placement-prune, and binding-create runs AFTER placement-create.

### §156. DECISION Q2 — REFUSE, naming the binding

DECISION Q2 — REFUSE, naming the binding. A cascade would delete execution configuration the manifest never mentioned, and an orphaned binding fails SILENTLY (no FK, no deleted_at, and `targetObjectIsLive` hides it at read time).

Q2 WAS DECIDED ON A PREMISE THAT NO LONGER HOLDS, and this is now a different guard than it was. The ruling's reasoning was "the manifest cannot even name it (its target is the placement)" — true when bindings could only be addressed by object URN. A manifest CAN now declare a binding on a placement by its pair, so a stack that wants both gone declares neither and the binding-prune above removes it first; the common case no longer reaches here.

What survives is narrower and still worth having: this is the APPLY-TIME net for a binding that was NOT in the plan's prune set — most realistically one written between plan and apply, which no diff computed earlier could have known about. Refusing beats destroying it, and the message still has to name what to remove first.

### §157. Placement creates run first, because a binding may need one

PLACEMENT CREATE runs BEFORE the binding creates below, because a binding may TARGET a placement — after the ADR-0026 migration most do — and its target must exist first.

Goes through `createPlacement`, the same function `POST /v1/placements` uses, and NOT `createObject`. That is the whole reason this is a typed collection: `createPlacement` resolves and type-checks both endpoints, derives the URN from the pair, and writes the two derived `places`/`placed_at` edges in the SAME transaction. `createObject` does none of those, which is why the generic door refuses pair-bound types outright (#207) — and this apply path is one of the doors that refusal had to be added to.

### §158. In-place convergence of the one non-identity attribute

§10.6 — the in-place convergence of the ONE non-identity attribute the diff manages. Every row sharing the tuple, for the same reason `deleteSourceMappingsMatching` takes them all: a byte-identical sibling left behind would re-propose this update on every plan forever. A plan stored without a scope key (`undefined`) cannot have produced an `update` verdict, so reading it as null here is unreachable rather than a silent clear.

### §159. PIPELINE HOOKS (D11/D21; migration 0096)

PIPELINE HOOKS (D11/D21; migration 0096). Same position and same reason as the projection rows above: AFTER object creates (a hook needs its component to exist — "create this component and gate its waves" is the ordinary first manifest) and BEFORE object deletes, because `deleteObject` is a SOFT delete and `pipeline_hooks` has no `deleted_at` of its own. A hook left behind a tombstoned component is a gate nobody can see: outside every list read's join and outside every future plan's ownership pool, and it would spring back on any object restore.

Deletes before creates, mirroring every other collection here — and here it CAN matter: a payload change is rendered as a delete plus a create of the SAME `(org_id, component_object_id, kind, hook_id)` row, so creates-first would upsert the new gate and the prune would then remove it.

A PRUNE MISS IS NOT AN ERROR, unlike the mapping/producer/rung prunes above. `deleteHook` returns `undefined` when there was no row, and that is the honest outcome here: the plan's end state ("this gate is not armed") holds either way, and the alternative — 409ing the whole apply — would make a re-run of an interrupted apply un-runnable for no gain in safety. The direction that matters for a GATE is that a delete never silently fails to happen, and it cannot: the row is keyed on the identity this entry names.

### §160. ROLLOUTS AND CONVERGENCE

ROLLOUTS AND CONVERGENCE (D12/D25(b); migration 0106) — the writes that end the drop. Deletes first, then upserts, mirroring the hook block above so a same-key delete+create in one plan cannot land in the order that leaves nothing behind.

`update` IS APPLIED HERE TOO, unlike hooks, which have no update action: a rollout's identity is `(component, targetClass)` and the strategy is its VALUE, so a changed strategy is one row changing. Treating it as a delete+create would imply a window with no strategy at all.

### §161. ROLE BINDINGS AND ORG ROLES

ROLE BINDINGS AND ORG ROLES (drizzle/0108) — through the REAL doors, never around them
Every refusal the typed route enforces applies here unchanged, because this calls the same functions: the no-escalation subset rule, `bindable_at`, D5's Administrator deprecation, the administrative floor on delete, and the org advisory lock. That is deliberate and is the whole reason this is not a direct insert — an IaC path that wrote `role_bindings` itself would be a second door with its own drift, and the guard census this milestone paid for would be wrong.

THE APPLYING PRINCIPAL IS `actorObjectId`, which for a config-source sync is the TEAM object (ADR-0046 §1 / D9). So a team's own repo cannot grant that team authority it does not already hold — the subset rule refuses it. Stated because the symptom (an apply refusing a line the author believes correct) is otherwise hard to attribute.

ROLES BEFORE BINDINGS on the create side: a binding may name a role this same manifest authors, and `getRoleByName` has to find it. Deletes run in the opposite order for the mirror reason — the role delete door refuses while a binding still points at the role.

### §162. PRODUCER DECLARATIONS (ADR-0032 §7e)

PRODUCER DECLARATIONS (ADR-0032 §7e). AFTER object creates (a declaration needs its producer component to exist) and BEFORE object deletes, for the same reason the projection rows above run there: `deleteObject` is a SOFT delete and `dependency_line_producers` has no `deleted_at` of its own, so a declaration left behind a tombstoned component is unreachable garbage — invisible to the poll's internal/third-party join and outside every future plan's ownership pool, which is built from LIVE labelled objects.

EACH ENTRY GOES THROUGH THE SAME FUNCTION THE VERB CALLS. A declaration is not a row write: the covered lines' observed heads must be cleared (a poisoned public head would otherwise survive the declaration meant to undo it; a stale internal head is an M22 vendor-scan-rule input on a coordinate that is third-party again), a Decision must be recorded, and an audit event appended. `dependencies/producer-declaration.ts` owns all four so this door cannot perform a fraction of the verb.

Deletes before creates/updates, mirroring every other collection here — though for this one it cannot matter: identity is the coordinate, so a single plan can never both prune and declare the same key.

AND EVERY NON-NOOP ENTRY RE-READS WHO HOLDS THE COORDINATE, HERE, RATHER THAN TRUSTING THE STORED DIFF — see `assertPlannedProducerHolder`.

### §163. The coordinate must still be held by whoever the plan said

THE COORDINATE MUST STILL BE HELD BY WHOEVER THE PLAN SAID HELD IT.

`plan-diff.ts` computes `create` / `update` + `displacedProducerUrn` / `delete` from a snapshot taken at `POST /plans` time, and `dependency_line_producers` is keyed on the COORDINATE and UPSERTED — so the coordinate can change hands between plan and apply with no row deleted and nothing stale-marking the plan. `displacedProducerUrn` exists precisely because a transfer is a supported act, which is the same reason one can happen inside this window. Trusting the stored answer produced three distinct wrong outcomes, all silent:

- a `create` whose coordinate was claimed in the window OVERWRITES the new holder. The reviewed plan said "no producer is declared … it is polled as third-party today"; the apply performs a transfer, and `invalidProducerDeclarations` cannot object because the STORED diff carries no displacement to object to. - an `update` whose displaced producer was itself displaced in the window takes the coordinate from a THIRD component that the plan never named and no guard ever saw — the cross-stack steal that refusal (2) exists to refuse, arriving through the back door. - a `delete` whose row changed hands in the window RETRACTS SOMEBODY ELSE'S DECLARATION. The existence check alone passes (a row is there), and the coordinate silently returns to third-party polling for the component that just took it — a dependency-confusion re-arm (ADR-0032 §7b) performed by a plan whose reviewed text names a different producer entirely.

SO A STALE PLAN FAILS LOUDLY. The refusal is a 409 inside the apply transaction, so nothing partially applies, and the remedy is the ordinary one: re-plan against current state. The holder is compared BY URN because that is the vocabulary of the diff, and the read includes tombstones so a holder whose component was deleted is NAMED rather than reading as "nobody" — the null-drop that would otherwise let a `create` sail past a standing declaration for the second time.

### §164. The move rungs, and the permission each entry needs

`governance:move` RUNGS (ADR-0038 §2; proposal governance-reach-on-containment-move.md §9.6 Q4).

POSITION IS LOAD-BEARING AT BOTH ENDS, the same sandwich the producer block above sits in: - AFTER object creates, because "create this service and govern moves under it" is the ordinary first manifest and the subject has no id until then. - BEFORE object deletes, because `deleteObject` is a SOFT delete and `governance_move_rungs` has no `deleted_at` of its own. A rung left behind a tombstoned container is a bar nobody can see (it is outside every list read's join and outside every future plan's ownership pool) that would spring back to life on any object restore.

EACH ENTRY GOES THROUGH THE SAME FUNCTION THE VERB CALLS (`governance/move-rung-write.ts`), so this door writes the whole act — row, Decision, audit event — or none of it. Nothing here reaches `governance_move_rungs` directly, and that is the point: a second writer that wrote only the row would make `GET /decisions?kind=governance.move_enforcement` silently false for exactly the rungs an auditor came looking for (charter principle 6).

Deletes before creates, mirroring every other collection here — and unlike the producers', this ordering CAN matter: identity is the subject, and disabling a rung above before enabling one below is precisely the sequence the monotone refusal permits (the reverse order 409s).

NO STALE-PLAN HOLDER CHECK. The producers' `assertPlannedProducerHolder` exists because a coordinate can change hands between plan and apply with no row deleted. A rung cannot change hands: it is enabled at its subject or it is not, both states are re-read here, and each of the two mismatches has its own honest failure below — a create finds the upsert idempotent, and a delete that lost its row 404s as a prune miss.

## `apps/server/src/coordination-as-code/rollout-convergence-repo.ts`

### §165. STORAGE FOR THE TWO MANIFEST COLLECTIONS THAT USED TO BE DROPPED

STORAGE FOR THE TWO MANIFEST COLLECTIONS THAT USED TO BE DROPPED (D12, D25(b); migration 0106).

`@scp/coordination-as-code` has emitted `rollouts` and `convergence` since the L1 doors and the `CanaryRollout` / `RollingRollout` constructs shipped, and `plans-repo.ts` projected neither — so a declared canary synthesised, validated, planned green, applied, and was discarded in silence. These are the reads and writes that end that.

Ownership derives from the COMPONENT, exactly as it does for `pipeline_hooks`, `source_mappings` and `executor_bindings`: a row carries no owner of its own, so its owner is the owner of the component it hangs off. That is why every function here is keyed by component id and why the diff's pool is "rows on components this stack owns".

## `apps/server/src/coordination-as-code/stack-ownership.ts`

### §166. THE SOLE WRITER OF `managed_by_stack`

THE SOLE WRITER OF `managed_by_stack` — "a description is not an assertion" (drizzle/0068)

## What this closes

The IaC prune pool — which live objects and relationships an apply DELETES — used to be read out of `objects.labels` / `relationships.labels`, from the pair `scp:managed-by=iac` + `scp:stack=X`. `labels` is writable at plain `object:write` AT THE OBJECT, validated by nothing. So the SUBJECT of the decision wrote its own match key, at a strictly weaker permission than the one that authored the desired state. Both directions are reproduced through real HTTP doors in `iac-stack-ownership.integration.test.ts`:

- **Enrolment.** An Operator bound at ONE object, with no IaC authority at all, PATCHes the two keys onto it. The stack's UNCHANGED manifest then proposes deleting it — over the reason "previously managed by this stack", which is false — and the apply executes that delete under the applier's authority, taking the object's `source_mappings`, `placements` and `executor_bindings` with it. - **Escape.** The object's owner strips the two keys. The object leaves the pool, so when its stack later drops it from the manifest to decommission it, NO delete is proposed. It survives its own decommission silently.

## Why a column and not a reserved label namespace

PR #247 reserved `scp.governance/` for keys a governance constraint may match on, and said in its own census that this instance was "not fixable with this namespace". That is right, and the reason is worth stating precisely rather than inherited: a `scp.governance/` key is written by an AUTHORITY — an operator holding org-root `policy:write` — so the namespace's rule is a permission bar. Stack ownership has no such principal. It is stamped by an apply, as a consequence of what a manifest declares, and there is no permission that should let anyone type it directly. The honest encoding of "not tenant data" in this schema is a column, which is what `origin_domain_id`, `provenance`, `revision` and `domain_local` already are.

A namespace would also have cost what a column gets for free: `labels` FEDERATE, and `managed_by_stack` does not — it is absent from the journal payload, so a replica arrives owned by nobody, which is the truth (the importing domain's IaC does not manage a row another domain authored).

DERIVED BY READING THE CODE, NOT REPRODUCED END-TO-END, and flagged as such because everything else in this module's header was measured: `createObject`/`updateObject` put `labels` in the journal payload verbatim and `import-repo.ts` writes them back, `fetchManagedObjects` had no origin filter, and `deleteObject` refuses a foreign-origin row with a 409 that aborts the whole apply. Each link is read directly; the chain was not executed against two live domains. Treat it as a strong reason to prefer the column, not as a reported second defect.

## The one rule

**A stack owns exactly the rows its manifest declares, plus the rows it already owned.** Nothing else can put a row in a stack's prune pool, and nothing a request can send takes one out.

Ownership is therefore stamped for every NON-DELETE entry in the diff — `create`, `update` and `noop` alike. `noop` is not an optimisation to skip: a declared row that happens to be byte-identical to what is stored is still a row this stack declares, and leaving it unstamped would make it undeletable by the stack that owns it (the escape direction, arrived at by accident). Each half below is ONE bulk UPDATE whose predicate skips rows already carrying this stack, so an apply that changes no ownership writes no rows — this must not become per-object write amplification on the hottest path IaC has.

Ownership is never CLEARED here. A row leaves a stack by being pruned (which deletes it), and the only other way out would be another stack declaring it — which is a `create`/`update`/`noop` in that stack's diff, i.e. a re-stamp by this same function.

### §167. Stamps the stack onto every object, skipping owned rows

Stamps `stackName` onto every object id given, skipping rows that already carry it.

The caller passes the ids of every non-delete object entry in the applied diff. Rows outside that list are untouched, including rows this stack owned before — an object that dropped out of the manifest is handled by the PRUNE, which deletes it; silently disowning it instead would leave an orphan no stack could ever clean up.

### §168. Spelled out, because the builder has no such helper

`IS NULL OR <> $stack`, spelled out because drizzle's query builder has no `IS DISTINCT FROM` (the relationship statement below, being raw SQL, uses the operator directly — same predicate, two spellings). The `IS NULL` arm is not belt-and-braces: a bare `<>` evaluates to NULL, not TRUE, against an unowned row, so leaving it out would skip precisely the rows that need stamping most — the ones being adopted.

### §169. The relationship half

The relationship half. One statement over a VALUES list rather than N lookups: the diff already knows every triple (both endpoint ids are resolved before any mutation runs), so re-reading each edge to find its id would be a round trip per declared edge for no extra information.

THIS ALSO CLOSES A PRE-EXISTING ASYMMETRY, not just the label hole. Under the label scheme, only relationship CREATES were stamped (`createRelationship` set the labels; nothing rewrote an edge that already existed). So an edge a manifest declared but that some other door had already created — `POST /components` writes a `contains` edge, for instance — was declared-but-unowned forever, and could never be pruned by the stack that declared it. Objects never had that gap, because adopting one rewrote its labels. Stamping every non-delete entry makes the two agree.

## `packages/coordination-as-code/src/behaviors.test.ts`

### §170. THE TYPED PIPELINE BEHAVIOURS

THE TYPED PIPELINE BEHAVIOURS (L2) — `behaviors.ts`.

THE ONE PROPERTY THAT MATTERS, AND WHY IT IS AN EQUALITY RATHER THAN A SHAPE ASSERTION
D16(1): "an L1-authored entry and its L2 equivalent synthesize identically." A shape assertion on the L2 output would pass while the two doors drifted — which is the failure this library is most exposed to, because the L1 door is what a standards package or a generated file uses and the L2 door is what a human writes. So the central case builds the SAME declaration both ways and compares whole manifests.

MUTATION LOG — each applied, watched fail, reverted, watched pass (MEASURED)
| Mutation | Result |
| `Workflow` stops inheriting `repo` from the pipeline (hard-codes `""`) | 3 FAIL — (1), (2), (3). The L1/L2 equality is the first to go, which is the drift this case exists to catch | | `PipelineBase.componentUrn` returns the URN even at the shared rung | (5) FAILS — a service-rung hook is accepted and synthesizes keyed on a SERVICE urn, which no read path resolves | | `ContinuousTest` passes `props.every` through without `.toSeconds()` | (3) FAILS — a raw `Duration` reaches the entry, the hazard `duration.ts`'s header records | | `PostDeployTest` defaults `stage` to `"production"` instead of omitting it | 2 FAIL — (1) and (2). Absent means EVERY wave (D21(a)), so a default silently REMOVES gates |

### §171. D8's shared-rung exception

D8's shared-rung exception: the pipeline attaches to the SERVICE, so it names no component, and which components inherit it is resolved at READ time by the nearest-rung ladder. The SERVICE is the scope — that is how the shared rung is spelled (`resolvePipelineCtorArgs` sets `isComponentScoped` from `scope instanceof Component`), not a `scope:` prop. No `service:` prop in the nested form — that belongs to the ROOT form, which auto-creates a component. Here the scope IS the service.

## `packages/coordination-as-code/src/behaviors.ts`

### §172. TYPED PIPELINE BEHAVIOURS

TYPED PIPELINE BEHAVIOURS (L2) — `Workflow`, the four test hooks, and the two rollout strategy classes, as thin sugar over the increment-8 contract in `@scp/schemas`.

THE GRAMMAR THESE FOLLOW, AND WHERE IT COMES FROM
D15(b) as amended by D17: **a `Workflow` scopes to its pipeline, which carries repo + branch; `path:` is within that repo; a test hook scopes to the `Workflow`.** That scope chain IS how a test knows where the code and the template live — so the repo is not repeated on every hook, and it cannot drift from the pipeline's own source mapping, because it is read from the same place.

D8's rule then applies at the boundary: **inference at synth, explicitness at apply.** The construct infers `repo` and `branch` from the scope chain; the MANIFEST always carries them literally. Nothing server-side ever infers.

D16(3): durations are the `Duration` value class on every duration-shaped prop (`every`, `maxAge`, `quietWindow`, `pauseBetween`), percentages are plain numbers on self-describing props (`weightPercent`, `batchPercent`). Never `"5m"`, never `"25%"`.

D16(6): every construct exports its props interface, optionals carry `@default`, and the types those props use are the contract's own — one vocabulary from authoring to wire, so a prop cannot drift from what plan/apply accepts. Where a construct is a natural singleton per scope, `id` defaults to the construct kind and is typed only when declaring same-kind siblings.

WHY THESE EMIT THROUGH THE L1 DOORS
Every construct here ends in `stack.addPipelineHook(...)` / `addRollout(...)` — the same L1 hatches a hand-authoring caller uses. D16(1)'s "an L1-authored entry and its L2 equivalent synthesize identically" is then true by construction rather than by two code paths agreeing, which is the same reason `addManifestEntry` entries sort in beside typed constructs' objects.

### §173. The scope chain a behaviour needs

The scope chain a behaviour needs: which stack to declare into, and which component the declaration is ABOUT.

A pipeline scoped to a SERVICE (D8's shared-rung exception) has no component — `PipelineBase` says so at length for source mappings and placements, and hooks are in the same position: the contract keys every hook on `componentUrn`, and which components inherit a service-rung pipeline is decided at READ time, not at this program's synth time. So such a pipeline reports `componentUrn: undefined` and the constructs below refuse, naming the reason.

### §174. WHERE A TEST'S CODE AND TEMPLATE LIVE

WHERE A TEST'S CODE AND TEMPLATE LIVE. Scopes to a pipeline and inherits its repo and branch; the test hooks scope to this.

It declares nothing on its own — a workflow nobody gates on is not a manifest entry, it is an unused file — so this construct emits no manifest entry by itself. The hooks under it do.

### §175. Post-merge gates entry to the first wave, on merge

POST-MERGE — gates entry to WAVE 1, and fires on merge to the pipeline's branch.

It does NOT gate the artifact reaching the registry, and the contract says why at length: D22 puts build → unit → scan → sign → push inside the team's own workflow, so SCP first sees the artifact when the build reports a digest. The build-internal gate is DISPLAYED by `scp iac render`, not enforced here.

### §176. Evidence older than this reads as ABSENT

Evidence older than this reads as ABSENT — not stale-pass, and not fail. Required, because it is the entire reason the hook exists: a probe that last succeeded six hours ago is evidence that nobody has looked, not that the target is healthy.

### §177. Bake alarms: a quiet window that must pass alarm-free

BAKE ALARMS — a declared quiet window that must pass alarm-free after a target deploys.

Scopes to the PIPELINE, not to a `Workflow`: it triggers nothing, so it has no template to point at. It consumes signals that already exist (the rollout executor's analysis, plus pushed alarm state), which is why the contract gives it no `workflow` field at all.

## `packages/coordination-as-code/src/canonical.ts`

### §178. Deterministic JSON serialization

Deterministic JSON serialization (recursively sorted object keys). This is what makes `app.synth()`/`stack.synth()` produce byte-identical JSON across independent synths even when caller-supplied `properties`/`labels` objects were built with different key insertion order — plain `JSON.stringify` alone is NOT enough for that (goal statement's determinism requirement).

NO LONGER AN IMPLEMENTATION — a re-export of the single canonicalizer in `@scp/schemas/canonical-json`. This file used to carry its own byte-for-byte copy, "vendored here for the same `no @scp/server dependency` reason as `urn.ts`"; that reason was real but the copy was not needed, because `@scp/schemas` is already a dependency of this package AND of `apps/server`, so it is a legal shared home for a pure helper. The vendoring is what let one defect (a dropped `__proto__` subtree, silently absent from the canonical form) live in five places at once. Import path kept stable for this package's callers.

## `packages/coordination-as-code/src/construct.determinism.test.ts`

### §179. The load-bearing determinism property (goal statement, Part A)

The load-bearing determinism property (goal statement, Part A): `app.synth()`/`stack.synth()` is a PURE function of the construct tree. This test asserts two things fast-check-style:

1. Re-synthesizing the SAME tree object twice gives identical output. 2. Two INDEPENDENTLY-BUILT trees with the same logical content — same resources, same relationships — synthesize to byte-identical canonical JSON even when constructed in a DIFFERENT order, because identity is URN-keyed and both the objects/relationships arrays are sorted before being returned (construct.ts's `Stack.synth()`).

### §180. Only the uniform `defineResourceConstruct` types belong here

Only the uniform `defineResourceConstruct` types belong here — they share the `(scope, id, ResourceProps)` signature this generic loop relies on. `Component` is deliberately EXCLUDED: like the campaign/topology constructs (see the note below), it is bespoke and needs its own typed props (`service`, to emit its `contains` edge), so it can't be built via the uniform `new Ctor(stack, id, props)` call. Its own synth is pinned in `construct.test.ts`.

### §181. Same determinism property as above

Same determinism property as above (re-synthesizing the same tree twice is byte-identical; two independently-built-but-equivalent trees synthesize identically regardless of construction order), applied to the M5 constructs (`Campaign`/`ReleaseTopology`). These can't join `RESOURCE_CTORS` above — each needs its own typed props (`waves`, `targets`, `topology`) rather than plain `ResourceProps` — so this is a small dedicated tree builder instead, varying both the random content (names, wave mode/fan-in, descriptions) and, within real dependency constraints (a Campaign's targets must exist before the Campaign does), the construction order.

## `packages/coordination-as-code/src/construct.test.ts`

### §182. Example-based synth test for a realistic small stack

Example-based synth test for a realistic small stack (goal statement): two services, a team owning both, one `depends_on` the other. The fast-check property test (`construct.determinism.test.ts`) covers the general determinism guarantee; this test pins down the EXACT expected manifest shape for one concrete, readable case.

### §183. M5 constructs (Campaign, ReleaseTopology)

M5 constructs (Campaign, ReleaseTopology) — same example-based style as above: the fast-check property test in `construct.determinism.test.ts` covers the general determinism guarantee, this file pins down the exact expected manifest shape.

### §184. That edge is system-managed, and the apply path refuses it

`coordinates` is a system-managed relationship the server refuses on the IaC apply path (apps/server/src/graph/system-managed-relationships.ts) — an edge injected by any actor holding `relationship:write` could sweep an arbitrary Change into a victim campaign's rollback. So there is deliberately no `.coordinates()` synth method; a manifest declaring one would only ever 403 at apply. The campaign -> member-change edges are written by the reconciler's own authority-checked path instead.

This guarantee used to be asserted through the removed grouping construct (ADR-0036). The property is about `coordinates`, not about what sat above a campaign, so it moved here rather than being deleted alongside it.

### §185. C1 (docs/proposals/post-import-configuration.md §8)

C1 (docs/proposals/post-import-configuration.md §8) — `source_mappings` and `executor_bindings` are the two configurations that had no manifest representation, breaking principle 3's API → SDK → CLI → IaC → UI parity for exactly what an operator must reproduce offline.

### §186. THE GAP THE CASE ABOVE LEAVES, and it is not a corner

THE GAP THE CASE ABOVE LEAVES, and it is not a corner: the two mappings there differ by `repoPattern`, which the sort key carried, so the whole case passed with `refPattern` missing from the key entirely. Two mappings that differ in nothing else tied, `Array.prototype.sort` is stable, and the tie fell through to declaration order.

This is the shape `PipelineBase` synthesizes for every multi-branch component — one repo, `refs/heads/dev` → dev and `refs/heads/main` → production (ADR-0030 §1) — so it is the common case, not a constructed one.

### §187. A placement is one component at one deployment-target

A placement is one component at one deployment-target. It is NOT emitted into `objects` — a pair-bound type cannot be created through a door taking free-form properties (PR #207), so it rides its own collection like a source mapping does.

| Mutation | Result |
| emit `placements: []` instead of omitting it when empty | the pre-C1 shape test FAILS | | sort placements by declaration order instead of the pair | the determinism test FAILS | | have `placeAt` push a decl directly instead of constructing `Placement` | no test fails — the two forms are required to converge, so this is asserted by BOTH producing the identical manifest |

### §188. A dependency subscription is a policy effect, not a row

M21.6 (proposal §3.3) — a dependency subscription is a `dependencySubscription` EFFECT on an ordinary `policy` object (ADR-0032 §3a); there is deliberately no bespoke construct or verb for it anywhere. So the IaC door is a first-class `Policy` construct whose `properties` travel VERBATIM into the manifest as a `typeId: "policy"` object — no schema change, because the manifest already accepts any typeId. This is also the DELETE-THE-WIRING gate for the export: drop `Policy` from index.ts and the import below is `undefined`, so `new Policy(...)` throws.

### §189. A producer declaration says where this line comes from

A producer declaration says "this component's production releases are where this coordinate's versions come from" — the coordinate stops being polled against its public index.

THE COLLECTION IS OMITTED WHEN EMPTY, exactly like the three above it — and that omission MEANS SOMETHING DIFFERENT server-side, which is the point of the last case here. For every other collection absent and empty both prune; for this one absent means UNMANAGED and prunes nothing (owner ruling 2026-08-17). The consequence a construct author hits is that deleting your only `producesDependency(...)` call retracts nothing, and that is what the last case pins so nobody "fixes" `synth()` to emit `producers: []` — which WOULD retract it, silently, on the next apply of every stack that ever declared one.

| Mutation | Result |
| emit `producers: []` instead of omitting it when empty | "…omits the collection when empty…" FAILS, and so does the pre-C1 shape test above | | sort producers by declaration order instead of `(ecosystem, coordinate)` | "sorts on (ecosystem, coordinate)…" FAILS | | have `producesDependency` push a decl directly instead of delegating to the stack | no test fails — the two spellings are required to converge, which the sugar-equivalence case asserts |

### §190. Do not "fix" this to emit

Do not "fix" this to emit `producers: []`. An empty array is a PRESENT collection, which the server reads as "I manage producers and declare none" and therefore PRUNES; an absent key means UNMANAGED. Emitting `[]` here would make every stack that ever dropped a `producesDependency(...)` call retract that coordinate back to a public index on the next apply — the accepted cost documented on `Stack.addDependencyProducer` runs in this direction precisely so the catastrophic one cannot.

### §191. A rung says moves beneath this container need permission

A rung says "every containment move BENEATH this container needs `governance:move` at both ends". It is the SECOND collection whose absent key means UNMANAGED, and the more dangerous of the two to get wrong: pruning a producer re-arms dependency confusion, pruning a rung turns OFF a governance bar and the symptom is an ABSENCE of refusals. So the last case here is the one that matters — it exists so nobody "fixes" `synth()` to emit `governanceMoveRungs: []`, which WOULD disable, silently, every rung on every container each stack that ever declared one owns.

| Mutation | Result |
| emit `governanceMoveRungs: []` instead of omitting it when empty | "…omits the collection when empty…" FAILS | | sort rungs by declaration order instead of by subject | "sorts on the subject…" FAILS | | resolve the subject to something other than its URN (e.g. the construct id) | "lands in the manifest…" and "accepts a container referenced by URN…" FAIL |

### §192. Do not "fix" this to emit

Do not "fix" this to emit `governanceMoveRungs: []`. An empty array is a PRESENT collection, which the server reads as "I manage rungs and declare none" and therefore DISABLES every rung on a container this stack owns. An absent key means UNMANAGED. Emitting `[]` here would un-govern a subtree on the next apply of every stack that ever declared a rung and later dropped it — and the symptom would be moves quietly succeeding, which nothing surfaces.

### §193. D16(2) — `fromXxx()` reference statics returning interface types

D16(2) — `fromXxx()` reference statics returning interface types. `Service.fromName(...)` / `.fromUrn(...)` return `IService`, and an OWNED `Service` construct implements the same interface, so the two are interchangeable wherever `IService` (or the looser `IResourceRef`) is accepted — this is what lets a component in one repo reference a service declared in another stack's file without a bare, untyped URN string.

### §194. D16(1) — the guaranteed L1 escape hatch

D16(1) — the guaranteed L1 escape hatch: `Stack.addManifestEntry`/`addRelationship` (raw doors) and `ResourceConstruct.overrideManifestEntry` (per-construct patch). Follows the house "synthesizes identically through the sugar and the stack-level door" pattern already used for placements/producers/rungs above.

### §195. D16(5) — construct-path in synth errors

D16(5) — construct-path in synth errors (synth-side half). Every `DesiredStateManifestSchema` validation failure now names the construct-tree PATH that produced the offending entry, not just a bare array index into the assembled manifest — the whole point being that a large multi- construct file's refusal maps back to the ONE construct a team actually wrote.

### §196. TWO CONSTRUCTS, ONE URN

TWO CONSTRUCTS, ONE URN — the case-folding collision `Stack.synth()` refuses.

Found by `products.test.ts`'s fast-check generator (id pair `("F", "f")`, CI seed 1953244992): `urn.ts`'s `slugify` lowercases, so sibling ids differing only in case derive ONE URN while the tree treats them as two constructs. Nothing downstream could catch it — the manifest schema has no cross-entry constraint and the server diffs BY URN, so the second entry silently became an update of the first and one declared object never existed.

## `packages/coordination-as-code/src/construct.ts`

### §197. Omitting over a union distributes across its members

`Omit` over a DISCRIMINATED UNION distributes across the members instead of collapsing them into one object type — without this, `Omit<ManifestPipelineHook, "componentUrn">` erases the union and `kind` stops narrowing `workflow`/`stage`/`maxAgeSeconds`, so a `bakeAlarms` hook carrying a `workflow` would typecheck at the L1 door and be refused only by Zod at synth.

### §198. The construct tree, in the shape a CDK user expects

CDK-style construct tree, inspired by AWS CDK's `App`/`Stack`/`Construct` shape but far simpler and written from scratch (no CDK library dependency, per the goal statement). The tree is a plain in-memory object graph; `synth()` is the one place it turns into data (`DesiredStateManifest` — `@scp/schemas`). Nothing here does I/O, reads the clock, or generates randomness — PURE synth (goal statement's load-bearing determinism requirement), verified by `construct.determinism.test.ts`'s fast-check property.

**Relationship ergonomics decision (documented):** fluent methods on the resource construct itself (`service.dependsOn(other)`, `team.owns(service)`) rather than standalone `new Owns(...)` constructs — reads closer to real CDK (`bucket.grantRead(role)`-style) and needs no extra import per relationship type. The tradeoff: relationship declarations live on `Stack` internally (`_registerRelationship`), not as their own addressable construct id — acceptable here since relationships have no independent lifecycle state to reference later within a single synth.

## Layering: L1 / L2 / L3 (team-pipeline-iac.md D16(1))

**L1 — the raw manifest entry.** `Stack.addManifestEntry(object)` appends a `ManifestObject` verbatim; `Stack.addRelationship(typeId, from, to, properties?)` does the same for an edge; every `ResourceConstruct` additionally offers `overrideManifestEntry(patch)` to patch fields its own typed props don't expose. None of these doors consult a registry of "known" typeIds — a `typeId` no typed construct in this package has ever heard of synthesizes exactly as well as `"service"` does. That is what makes "no L2 construct may block reaching L1" structurally true: there is no gate to bypass, because the L2 constructs below are themselves built on these same doors and contribute to the SAME collections `synth()` sorts and emits.

**L2 — the typed constructs.** Everything exported from this module below this comment: `Service`, `Component`, `Campaign`, `ReleaseTopology`, the `add*`/fluent sugar. Each is a thin layer that resolves references to URNs and calls the L1 doors underneath — `Component.placeAt` constructs a `Placement`, which calls `Stack.addPlacement`; `ResourceConstruct.dependsOn` calls `Stack._registerRelationship`. An L1-authored entry and its L2 equivalent synthesize IDENTICALLY (pinned in `construct.test.ts`), because the L2 form is never anything more than the L1 call plus ergonomics.

**L3 — patterns shipped via standards packages.** Not part of `@scp/coordination-as-code` itself: an org's `@corp/scp-standards`-style package (D10) composes L2 constructs into higher-level authoring patterns (a `waves.standard` wave shape, a `repos()` helper) and publishes them like any other package. `@scp/coordination-as-code` has no special knowledge of L3 — it is ordinary code built on L1/L2's public surface, which is exactly why nothing here needs to change for a new L3 pattern to exist.

### §199. Slash-joined construct-tree path from the root, e.g

Slash-joined construct-tree path from the root, e.g. `billing-platform/billing-api` (team-pipeline-iac.md D16(5)) — every synth validation error names this, so a refusal maps back to the construct a team actually wrote, not just an array index in the assembled manifest. `App` is excluded from the path (it is synth plumbing, D15a, and never appears in user-facing IaC).

### §200. A URN plus which typed-registry kind it names

A URN plus which typed-registry kind it names — the shape BOTH an owned `ResourceConstruct` and a `fromXxx()` reference satisfy (D16(2)). `Kind` is the construct's `typeId` literal (`"service"`, `"component"`, …), so `IService` and `ITeam` are structurally distinct in TypeScript even though neither carries any field beyond identity — passing a `Team` reference where an `IService` is expected is a compile error, not just a naming convention.

### §201. The placeholder urn a by-name reference resolves to

Builds the placeholder URN a `fromName()` reference resolves to at synth time (D16(2)/D14).

`@scp/coordination-as-code` synth is pure, offline, and single-stack-scoped (`urn.ts`'s module doc) — it has no visibility into WHICH stack owns an object merely named `"payments"`, so it cannot derive that object's real `deriveConstructUrn`-style URN the way an OWNED construct can. What it CAN do is name the reference unambiguously by (kind, name) in a reserved namespace that still satisfies `UrnSchema`'s `urn:scp:{org}:{type}:{slug-path}` shape (`@scp/schemas`), so the reference is legal wherever a construct's own URN would be.

Resolving `urn:scp:named-ref:service:payments` to the real object — matching by (typeId, name) across whatever stack actually declared it — is SERVER-SIDE behavior at plan time (team-pipeline-iac.md D14: "every fromName()/fromUrn() reference resolves server-side at plan time"). That resolution is not built yet; until it lands, a manifest using a `fromName()` reference REFUSES THE PLAN LOUDLY (not-found) rather than silently succeeding against the wrong object — which is the correct behavior for an unresolved structural reference, not a defect of this placeholder.

### §202. Root scope every `Stack` sits under

Root scope every `Stack` sits under. `App` itself never appears in a manifest — it is purely in-memory synth plumbing (`Construct.path` excludes it, mirroring real CDK's `App`), and it is NOT part of `@scp/coordination-as-code`'s public surface (D15a: "`App` disappears from user code entirely"). `new Stack("platform-estate")` auto-creates one internally; no user-facing IaC file ever needs to write `new App()`, because there is no longer any form of `Stack`'s constructor that accepts one.

### §203. Glob matched against the event's git ref (`refs/heads/main`)

Glob matched against the event's git ref (`refs/heads/main`) — ADR-0030 §1's routing discriminator, joining the mapping's identity tuple alongside `repoPattern`/`pathPattern`/ `type` (`ManifestSourceMappingSchema`). Added for team-pipeline-iac.md D17/D18: a pipeline's `branch` prop threads through to here (`refs/heads/${branch}`) so two pipelines sharing a repo but differing only in branch (`main` vs `dev`) synthesize two distinct mappings rather than colliding as one.

### §204. Declared reach of the repo

Declared reach of the repo (pipeline-substrate-registry-scan.md §10.6): `global` (shared across domains, tracked at the commander) | `domain` (tracked only in one domain). A label read by pipelines, the CLI and plans — never a routing input.

### §205. An `executor_bindings` declaration minus the target it binds

An `executor_bindings` declaration minus the target it binds — see `ManifestExecutorBindingSchema`, whose either-inline-or-system-backed rule this shape inherits (the server rejects a manifest that satisfies neither, at `POST /plans`).

### §206. All fields optional

All fields optional — the either-inline-or-execution-system-backed refinement (which combination is legal) is enforced by `ManifestExecutorBindingSchema` at synth, not by this type. Every call site that takes one (`bindsExecutor`, `addExecutorBinding`, `addPlacementExecutorBinding`) makes the parameter itself optional too, per D16(6)'s "props? omitted entirely when all fields are optional" — `component.bindsExecutor()` is legal TypeScript; it just fails synth validation like any other incomplete binding.

### §207. A named deployable unit (`new Stack('billing-platform')`)

A named deployable unit (`new Stack('billing-platform')`) — this name becomes the row's server-written `managed_by_stack` (drizzle/0068), which is what scopes pruning, and the "org" segment of every URN this stack's constructs derive (`urn.ts` — synth is offline and has no real org id to key off). It is also mirrored into `labels` as `scp:stack`, for humans only. A `dependency_line_producers` declaration minus the component that produces it (which the fluent method supplies) — see `ManifestDependencyProducerSchema`.

### §208. A named deployable unit (`new Stack('billing-platform')`)

A named deployable unit (`new Stack('billing-platform')`) — this name becomes the `scp:stack` managed-by marker (`apps/server/src/coordination-as-code/plan-diff.ts`) that scopes pruning, and the "org" segment of every URN this stack's constructs derive (`urn.ts` — synth is offline and has no real org id to key off).

### §209. `new Stack("platform-estate")` is the ONLY form (D15a)

`new Stack("platform-estate")` is the ONLY form (D15a): `App` is internal synth plumbing, auto-created here, and never appears in user code — nothing in a component's, team's, or estate's file ever writes `new App()`.

### §210. L1 — the guaranteed raw manifest-entry door

L1 — the guaranteed raw manifest-entry door (D16(1)). Appends `object` to this stack's `objects` VERBATIM, exactly as if a typed construct had synthesized it — no L2 construct (`Service`, `Component`, …) sits between this call and the manifest, and none of them can block it: this method takes any `typeId`, including one no typed construct in this package knows about yet. It is what makes "no L2 construct may block reaching L1" structurally true rather than a promise — there is no registry of "known" typeIds this checks against.

The one thing it does NOT do that a typed construct does: derive a URN when one is omitted. `ManifestObjectSchema.urn` is required, so callers supply it — `deriveConstructUrn` (`urn.ts`, also exported from `./index.js`) is the same deterministic algorithm every typed construct uses, so an L1 entry can reproduce an L2 one byte-for-byte (see `construct.test.ts`'s "an L1 addManifestEntry object and its L2 equivalent synthesize identically" case).

### §211. L1 — the guaranteed raw relationship door

L1 — the guaranteed raw relationship door (D16(1)). Declares an edge of ANY `typeId`, from and to any construct/reference/URN — the same escape hatch `addManifestEntry` is for objects. `dependsOn`/`consumes`/`owns` are convenience sugar over exactly this call (with `from` fixed to `this`); reach for this one directly for an edge type none of those three name, or when `from` is not the construct doing the declaring.

### §212. Declares a `source_mappings` row for `component`

Declares a `source_mappings` row for `component` (docs/proposals/post-import-configuration.md §8 C1). Prefer `component.mapsSource(...)`; this stack-level form exists for a component that lives OUTSIDE this program and is referenced by URN — the same escape hatch relationship endpoints already have.

The component must be one this stack owns: declared here, or already carrying this stack's name in its server-written `managed_by_stack` (drizzle/0068). `POST /plans` rejects anything else with a 400 — ownership of a mapping is inherited from its component, so a stack cannot configure a component it does not manage.

DELIBERATELY typed `IResourceRef`, not `IComponent`: this is the L1-adjacent escape hatch, not the typed sugar (`Component.mapsSource`) — it exists precisely so a caller CAN write something `Component.mapsSource` cannot, and the SERVER is the authority on whether the target is a component (`iac-dependency-producers.integration.test.ts`'s analogous "…refused, exactly as the typed verb refuses one" pins the same shape for `addDependencyProducer`). Narrowing the parameter here would make that a compile error instead of the intended 400.

### §213. Declares an `executor_bindings` row for `target`

Declares an `executor_bindings` row for `target` (C1). Prefer `target.bindsExecutor(...)`; this form exists for a target referenced by URN from outside this program. Same ownership rule as `addSourceMapping`.

### §214. Declares a `placement` (ADR-0026)

Declares a `placement` (ADR-0026) — this component at this deployment-target.

Prefer `component.placeAt(target)`; this stack-level form exists for a component referenced by URN from outside this program, the same escape hatch mappings and relationships already have.

OWNERSHIP is the COMPONENT's stack (decision Q4), matching `addSourceMapping` — a declaration whose component this stack does not own is rejected at `POST /plans`, which is what stops two stacks pruning each other's placements.

There is no `urn` argument and cannot be: a placement's URN is DERIVED from both endpoints (ADR-0026 D3), so supplying one could disagree with what the server mints.

DELIBERATELY typed `IResourceRef` on both parameters, not `IComponent`/`IDeploymentTarget` — see `addSourceMapping`'s doc for why the stack-level escape hatch stays loose while the sugar (`Component.placeAt`) stays typed.

### §215. Whether this stack already declares that exact placement

Whether this stack already declares a placement for this exact `(component, deploymentTarget)` pair — the identity is the pair (ADR-0026 D3), same as `addPlacement`. Exists so a HIGHER-LEVEL inference step (team-pipeline-iac.md D8: "placements from the stages a component's waves name") can check "did an explicit declaration already say this?" before adding an inferred one, rather than emitting two `ManifestPlacement` entries for one pair — D8's rule that "an explicit declaration always overrides an inferred one" is enforced by never emitting the inferred one at all when the explicit one already exists, not by a later dedup pass.

### §216. Declares a binding on a placement, addressed by its pair

Declares an `executor_bindings` row on a PLACEMENT, addressed by its pair.

The placement is expressed as `targetUrn` (the component) NARROWED by `deploymentTargetUrn`, not by a URN of its own: a placement's URN is derived (ADR-0026 D3) from the org id and both endpoints' display names, so it is neither hand-writable nor stable under a rename. Prefer `component.placeAt(target).bindsExecutor(...)`.

The pair must ALSO be declared as a placement by this same stack — `POST /plans` refuses a binding on a pair the manifest does not declare, because apply would otherwise write it onto a placement the same apply just pruned.

DELIBERATELY typed `IResourceRef` — see `addSourceMapping`'s doc.

### §217. Declares that `component` PRODUCES one dependency coordinate

Declares that `component` PRODUCES one dependency coordinate (ADR-0032 §7e) — the IaC form of `POST /dependencies/producers`. Prefer `component.producesDependency(...)`; this stack-level form exists for a component referenced by URN from outside this program, the same escape hatch mappings, placements and relationships already have.

WHAT THE DECLARATION DOES, so it is not mistaken for a label: it makes the coordinate INTERNAL. Every major line of it stops being polled against its public index, and its versions start being derived from `component`'s own production releases instead. Every other component in the org that depends on the coordinate is affected. That is why it takes `policy:write` AT THE ORG ROOT rather than write authority on `component`, and why the API verb — not this — is the surface that reports the blast radius before you commit to it (`--dry-run`).

The component must be one this stack owns AND must be a `component` (a `service` is refused). `POST /plans` rejects anything else with a 400, including a plan that would take the coordinate away from a producer belonging to ANOTHER stack.

READ THIS BEFORE YOU DELETE A CALL TO IT: REMOVING YOUR LAST ONE RETRACTS NOTHING
`producers` is the ONE manifest collection where an ABSENT key does not prune. It means UNMANAGED, deliberately and unlike `sourceMappings`/`executorBindings`/`placements`: retracting a declaration hands a coordinate the org PUBLISHES back to a public index on a daily poll timer, and the symptom is an ABSENCE of dependency updates — dependency confusion re-armed by a stack that merely forgot a key. So:

```text
- Removing ONE of several calls DOES retract that coordinate. The collection is still present,
  so it is authoritative over its own members and the plan shows a `delete` entry.
- Removing your ONLY call retracts NOTHING. `synth()` omits an empty collection, so the
  manifest becomes indistinguishable from one that never managed producers at all. This is an
  ACCEPTED COST of the rule above, not a bug to work around.
```

To retract a final declaration, use `scp dependency producer retract` (`POST /dependencies/producers/retract`) — which is the better path anyway, because only the verb reports the bumps SCP has already authored and cannot recall. A hand-authored manifest carrying `"producers": []` also works; `@scp/coordination-as-code` cannot emit one.

DELIBERATELY typed `IResourceRef`, not `IComponent`: this stack-level door is the escape hatch, not the typed sugar (`Component.producesDependency`) — it must stay able to express a SERVICE-valued producer so the server's own refusal of one is testable (`iac-dependency-producers.integration.test.ts`'s "a SERVICE-valued producer is refused, exactly as the typed verb refuses one"). Narrowing this parameter would turn that server-authority test into a compile error instead.

### §218. Declares that moves beneath this subject need permission

Declares that containment moves BENEATH `subject` require `governance:move` at BOTH ends (ADR-0038 §2) — the IaC form of `PUT /governance/move-enforcement/rungs/{idOrUrn}`, and the follow-up named in `docs/proposals/governance-reach-on-containment-move.md` §9.6 Q4.

WHAT THE RUNG DOES, so it is not mistaken for a label: from the moment it exists, every move of an object under `subject` — through `objects[].domainId`, through a `contains` relationship, through `setComponentService`, through discovery-accept and through this very apply path — is refused unless the mover holds `governance:move` at-or-above the object AND at-or-above the destination. `object:write` at both ends is no longer enough. That is a bar on other people's ordinary work, so it takes `policy:write` at-or-above `subject` to set.

THERE IS NO TIER ARGUMENT, and the omission is the design: the tier is DERIVED server-side from `subject`'s object type (org root / domain / service / assembly). A manifest that could name one could name a tier the subject is not, and the stored literal would then describe a containment shape nothing else in the system believes in.

THE SUBJECT MUST BE A CONTAINER THIS STACK OWNS. `governance_move_rungs` carries no stack labels, so ownership is inherited from the subject container, exactly like a source mapping's and a producer declaration's — `POST /plans` rejects 400 anything else, including a component (nothing is contained by a component, so the rung would govern the empty set of moves). The practical consequence is worth knowing before you reach for this: a rung on the ORG ROOT, or on a container another stack manages, is authored through the API/CLI, never through a manifest.

THERE IS DELIBERATELY NO FLUENT `subject.governsMoves()`. `Service` and `Domain` come from the uniform `defineResourceConstruct` factory, so a fluent method would have to live on `ResourceConstruct` and would therefore be offered on `Component`, `Team`, `Policy` and `DeploymentTarget` — every one of which `POST /plans` refuses. That is the reason `producesDependency` sits on `Component` alone rather than on the base class; here the same reasoning lands on "stack-level only".

READ THIS BEFORE YOU DELETE A CALL TO IT: REMOVING YOUR LAST ONE DISABLES NOTHING
`governanceMoveRungs` is the SECOND collection where an ABSENT key does not prune (`producers` is the first), and the reason is sharper: pruning a rung DISABLES A GOVERNANCE BAR, and the symptom is an ABSENCE of refusals — moves that should have been refused quietly succeeding, which nothing surfaces until somebody audits where a governed object ended up. So:

```text
- Removing ONE of several calls DOES disable that rung. The collection is still present, so it
  is authoritative over its members and the plan shows a `delete` entry.
- Removing your ONLY call disables NOTHING. `synth()` omits an empty collection, so the
  manifest becomes indistinguishable from one that never managed rungs at all. ACCEPTED COST
  of the rule above, identical to `producers`.
```

To disable a final rung use `scp governance move-enforcement disable` (`DELETE /governance/move-enforcement/rungs/{idOrUrn}`), or hand-author `"governanceMoveRungs": []`; `@scp/coordination-as-code` cannot emit one. And note a disable may still be REFUSED: the lattice is monotone, so a rung whose ancestor — or the instance rung — is enabled cannot be turned off below, and the apply fails 409 naming the upper rung.

### §219. Pure synth: no clock, no randomness, no ambient input

Pure synth: no `Date.now()`, no `Math.random()`, no `crypto.randomUUID()`, no network/ filesystem I/O — everything comes from the construct tree's own props. Objects are sorted by URN and relationships by `(typeId, fromUrn, toUrn)` so re-ordering how constructs were added in code never changes the synthesized manifest, only their CONTENT does — the property `construct.determinism.test.ts` exercises.

### §220. L1 ESCAPE HATCH for a pipeline hook (D11, D21)

L1 ESCAPE HATCH for a pipeline hook (D11, D21) — the `pipelineHooks` half of the increment-8 contract (`@scp/schemas`'s `ManifestPipelineHookSchema`).

D16(1)'s guarantee is that no L2 construct may block reaching L1. Until this existed, the guarantee was empty for this collection in the strongest possible sense: there were no L2 constructs for hooks AND `synth()` did not assemble the collection at all, so a CDK program could not emit a hook by any route. The server half has been waiting since the contract merged — `plans-repo.ts` applies `pipelineHooks`, `render.ts` displays them — and the only way to get one into the database was a hand-authored manifest POSTed to `/plans`, which is precisely the authoring experience the construct library exists to replace.

Takes the hook MINUS its `componentUrn`, which is resolved from `component` the way every other hatch here resolves its subject — so a caller cannot accidentally declare a hook against a URN that does not match the construct they passed.

PREFER THE TYPED CONSTRUCTS once they exist (`PostMergeTest`, `PostDeployTest`, `ContinuousTest`, `BakeAlarms`); this door stays for a component referenced by URN from outside the program, and for a hook kind the library has not grown sugar for yet.

### §221. L1 ESCAPE HATCH for a rollout declaration

L1 ESCAPE HATCH for a rollout declaration (D12), keyed by TARGET CLASS — one component legitimately declares a canary for its clusters and a rolling batch for its instance groups.

The strategy is the contract's own discriminated union, so the wire carries a discriminant rather than a strategy string the server has to interpret (D15(c)), and percentages are plain numbers on self-describing props (D16(3)).

### §222. L1 ESCAPE HATCH for a convergence declaration (D25(b))

L1 ESCAPE HATCH for a convergence declaration (D25(b)) — a configuration pipeline placed at an infrastructure PRODUCT re-applies its currently-released, already-gated state when that product's observed membership changes.

BOTH FIELDS ARE REQUIRED HERE even though `converge` defaults on and `scope` defaults to the changed subset. That is D8's rule (inference at synth, explicitness at apply) applied to the door it was written for: the typed construct picks the defaults, the MANIFEST always says which, and "this fleet self-converges" stays a reviewable line rather than a server-side default nobody can see. An L1 caller is authoring the manifest directly, so it says both.

### §223. L1 ESCAPE HATCH for a role binding

L1 ESCAPE HATCH for a role binding — grant `roleName` to `subjectUrn` at `scopeUrn`.

SUBJECT MUST BE A `user` OR `service-account`, and that is enforced by the L2 construct rather than here: this door takes URNs it cannot resolve to a type at synth time, so the refusal lives where the type is known. The reasoning is in `ManifestRoleBindingSchema` — D7's acknowledgement is a statement about a membership at a moment, and a manifest can only carry a snapshot that goes stale and trains its author to stop reading the refusal.

The applying principal, not the author, is who the no-escalation subset rule judges. For a config-source sync that is the TEAM object, so a team's own repo cannot bootstrap that team's permissions.

### §224. L1 ESCAPE HATCH for an org-defined role

L1 ESCAPE HATCH for an org-defined role. `permissions` must be strings this system defines AND ones the APPLYING principal holds at the org root — authoring a role that advertises authority its author cannot confer is refused at the door, not here.

### §225. OMITTED WHEN EMPTY, like the three above

OMITTED WHEN EMPTY, like the three above — but here that omission MEANS SOMETHING DIFFERENT server-side. For the others, absent and empty both prune. For this one, absent means UNMANAGED and prunes nothing, which is why a stack that drops its last `producesDependency(...)` call does not retract it. See `addDependencyProducer` for the whole rule and for how to retract a final declaration.

### §226. Omitted when empty, meaning what the sibling's omission does

OMITTED WHEN EMPTY, and meaning the same thing `producers`' omission means — UNMANAGED, not "manages them and declares none" — which is why dropping the last `addGovernanceMoveRung` call disables nothing. See that method for the whole rule and for how to disable a final rung. This is the more dangerous of the two omissions to get wrong: pruning here would turn OFF a governance bar, and the symptom would be an absence of refusals.

### §227. Omitted when empty, and this is the third such collection

OMITTED WHEN EMPTY, and `pipelineHooks` is the THIRD collection whose omission means UNMANAGED rather than "manages none" — the contract says so explicitly and for the same reason `producers` does: dropping the last declaration would silently DISARM a gate, and the symptom of a disarmed gate is an absence of refusals. Retracting a final hook needs a hand-authored `"pipelineHooks": []`, exactly as retracting a final producer does.

`rollouts` and `convergence` follow the ORDINARY rule (absent = empty = prune): neither gates anything, so a forgotten key costs a declared strategy, not a removed bar.

### §228. TWO OBJECTS, ONE URN

TWO OBJECTS, ONE URN — REFUSED HERE, BEFORE THE MANIFEST CAN CARRY BOTH.

A URN is derived from `(stackName, construct id)` through `slugify`, WHICH LOWERCASES. So sibling constructs whose ids differ only in case — `Api` and `api`, `payBlue` and `PayBlue` — are two distinct constructs (the tree's own duplicate-id check compares ids exactly, and CDK semantics say those are different resources) that derive ONE URN. Punctuation folds the same way: `pay-blue` and `pay_blue` both slug to `pay-blue`.

Nothing downstream could catch it. `DesiredStateManifestSchema` has no cross-entry constraint, and the server DIFFS BY URN (`iac/plan-diff.ts`), so the second entry silently becomes an update of the first: one of the two objects the author declared never exists, and the plan reads as a clean create + update. The symptom is a missing object, discovered whenever someone goes looking for it.

MEASURED, not theorised: `new Service(stack, "Api", …)` beside `new Service(stack, "api", …)` synthesized two entries both carrying `urn:scp:probe:service:api`. Found by the fast-check generator in `products.test.ts`, which produced the id pair `("F", "f")` and hit `collectProducts`'s identifier-collision throw — the products module was the only place in the library incidentally protected, and only because `camelIdentifier` folds case too.

Named by CONSTRUCT PATH, not by URN: the URNs are identical (that is the defect), so printing them twice tells the author nothing about what to change. The paths are what differ and what they must rename — D16's construct-path error rule, which the validation branch below already follows.

### §229. Every synth error names the tree path that produced it

D16(5): every synth validation error names the construct-tree PATH that produced the entry it is about. A `safeParse` failure's `issue.path` starts with the collection name and, for a collection member, the array index into it — the SAME index `objectLocations`/ `relationshipLocations`/… line up with, because every array above was built and sorted in lockstep with its location array.

### §230. Sorts on the mapping's full identity tuple

Sorts on the mapping's full identity tuple — the same tuple the server diffs on, so declaration order in code never changes the synthesized manifest, only content does.

`refPattern` IS IN THE TUPLE and was missing here (ADR-0030 §1): a manifest legitimately declares `refs/heads/dev` → dev and `refs/heads/main` → production as two rows differing in NOTHING else, which is exactly what `PipelineBase` synthesizes for two same-repo pipelines. Without it the two tie, `Array.prototype.sort` is stable, and the tie falls back to DECLARATION order — the one thing this function exists to keep out of the bytes.

`scope` is deliberately NOT here, matching `ManifestSourceMappingSchema`, which places it outside the identity tuple beside `classification`/`mirrorOfShared`/`enabled`. Two mappings differing only in `scope` are one declaration made twice and are rejected as a duplicate, so there is no tie for it to break — adding it would make this key stop being the identity it claims to be.

### §231. Base class for the 8 typed-registry resource constructs

Base class for the 8 typed-registry resource constructs. `typeId` is fixed per subclass (`Service` -> `'service'`, etc.) via `defineResourceConstruct` below, mirroring `routes/typed-registries.ts`'s server-side "one factory, invoked per resource" pattern instead of 8 hand-copied classes.

Generic over `TypeId` (D16(2)) so an OWNED construct structurally implements the SAME `IResourceRef<Kind>`-family interface a `fromXxx()` reference returns — `new Service(...)` is an `IService` and `Service.fromName(...)` is an `IService`, interchangeable wherever the interface is accepted, which is the whole point of the reference statics.

### §232. Public, widened from the earlier round's narrower access

PUBLIC (widened from round A's `protected`, team-pipeline-iac.md D17/D19/D24 round B): a `Pipeline` construct scoping infra products (`Cluster`, `InstanceGroup`, …) or nested pipelines under an owned `Component`/`Service` lives in a DIFFERENT module (`pipeline.ts`) from this class, so it needs to read the owning `Stack` off a construct it did not itself create — `protected` only reaches subclasses in the SAME file. Still `readonly`: nothing outside the constructor may reassign which stack a construct belongs to.

### §233. `scope` accepts either a `Stack` directly

`scope` accepts either a `Stack` directly (every construct round A shipped) OR any construct that itself carries a `.stack` (round B's `Pipeline` — a non-`Stack` scope for infra products and nested pipelines, team-pipeline-iac.md D19). This is a WIDENING, not a behavior change: a `Stack` scope resolves to itself exactly as before, and every existing call site (`new Service(stack, …)`, `new Component(stack, …)`, …) is unaffected because `Stack` still satisfies the union's first arm.

### §234. Declares the binding that drives one of these pipelines

Declares the executor binding that drives one of this target's pipelines (C1) — the IaC form of `PUT /executors/{idOrUrn}/binding`, closing principle 3's parity hole for the projection tables (docs/proposals/post-import-configuration.md §8). Call once per Type: a target holds at most one binding per Type (`UNIQUE (org_id, target_object_id, type)`), and declaring two of the same Type is rejected at `POST /plans` rather than silently resolved.

Unlike `dependsOn`/`owns` this is NOT a relationship — `executor_bindings` is a projection table with no graph-object equivalent, which is precisely why it needed its own manifest collection.

### §235. NOTE — there is deliberately NO `coordinates()` fluent method

NOTE — there is deliberately NO `coordinates()` fluent method (M5 CRITICAL, adversarial review). `coordinates` is a system-managed relationship type (campaign MEMBERSHIP): the server refuses it on BOTH the generic `POST /relationships` endpoint AND the IaC plan/apply path (`apps/server/src/graph/system-managed-relationships.ts`), because a `coordinates` edge injected by any actor with `relationship:write` could sweep an arbitrary Change into a victim campaign's rollback. Legitimate campaign IaC membership is declared through a `Campaign`'s authority-checked `targets` (which the server binds to the applying actor's own authority at apply time via `assertCampaignTargetsWithinAuthority`). Offering a `.coordinates()` synth method here would just produce a manifest that fails at apply — so it doesn't exist.

### §236. L1 escape hatch, PER-CONSTRUCT (D16(1))

L1 escape hatch, PER-CONSTRUCT (D16(1)): patches this construct's own synthesized manifest object with fields its typed L2 props don't expose — `name`, `domainId`, `properties`, or `labels`, applied AFTER whatever the construct's own props computed, so an override always wins. `urn`/`typeId` are excluded on purpose: those are identity, already settled by the constructor, and an override that disagreed with them would desynchronize this construct's `.urn` (still used by every reference to it) from what actually lands in `objects`.

Composable with repeated calls — each patches over the last, `properties`/`labels` replaced wholesale (not deep-merged) so the override is exactly what the caller wrote, not a guess at how to combine it with the construct's own value.

### §237. One tiny factory per resource type, not eight subclasses

One tiny factory invoked per resource type instead of 8 hand-copied subclasses. Explicitly typed as a constructor-of-`ResourceConstruct` (rather than letting TS infer the anonymous subclass's own shape) so declaration emission doesn't need to describe `ResourceConstruct`'s private members on an anonymous exported class type (TS4094).

### §238. A policy (server-side object type `"policy"`)

A policy (server-side object type `"policy"`) — first-class in a stack since M21.6 so that a DEPENDENCY SUBSCRIPTION, which IS a `dependencySubscription` effect on an ordinary policy (ADR-0032 §3a) and has no bespoke construct or verb anywhere, can be declared in IaC:

```text
new Policy(stack, "checkout-deps", {
  name: "checkout-deps",
  properties: {
    enforcement: "advisory",
    scope: { objectRef: "urn:scp:…:component:checkout-api" },
    effects: [{ dependencySubscription: { enabled: true, granularity: "minor_and_patch" } }]
  }
});
```

The properties travel VERBATIM into the manifest (the policy document is validated server-side by the type's JSON Schema at plan/apply, exactly as through `POST /policies`); a sole `group` scope on a dependencySubscription policy is refused there in both directions (ADR-0032 §6a). Uniform — no custom constructor logic — so it belongs in the factory list, not beside `Component`.

### §239. The service this component belongs to, or a reference

The service this component belongs to — a `Service` construct/reference, or an external service's URN string. Required: a component ALWAYS belongs to a service (M12 P5a, docs/proposals/organize-after.md), mirroring `CreateComponentRequest.service` on the API. The constructor emits the `contains` edge (service -> component) from it; a component an IaC plan CREATES with no incoming `contains` edge is rejected at plan-compute time server-side (`plan-diff.ts`'s `uncontainedComponentCreates`), so requiring it here just moves that failure from apply time to a TypeScript compile error.

### §240. Resolves the two constructor forms into one triple

Resolves `Component`'s two constructor forms into one `(scope, id, props)` triple, computed BEFORE `super()` is called (team-pipeline-iac.md D15a/D17 round B) so a root-form `Component` creates exactly ONE `Stack` — calling the resolution twice (once to compute `super()`'s arguments, once more inside the constructor body) would construct two DIFFERENT `Stack` instances and register the component under the one nobody kept a reference to. A plain (non-`this`-touching) statement before `super()` is legal JS, which is what lets this run once and be reused for both.

### §241. A component (server-side object type `"component"`)

A component (server-side object type `"component"`). Unlike the uniform `defineResourceConstruct` types, `Component` is a bespoke subclass because create-in-service is strict: it emits a `contains` edge from `props.service` to itself so the synthesized manifest satisfies the strict apply invariant. Re-assignment (moving a component between services) is P5b's `move` verb, not an IaC concern here.

Carries its own `fromName()`/`fromUrn()` statics (D16(2)) rather than going through `defineResourceConstruct` — same contract as every other typed-registry construct (`ResourceConstructStatics<"component">`), hand-written here because `Component` already is.

TWO CONSTRUCTOR FORMS (team-pipeline-iac.md D15a/D17 round B): `new Component(scope, id, props)` (round A, unchanged) for a `Component` declared inside an existing `Stack`, and `new Component(name, props)` for a MULTI-PIPELINE repo's root file — "a multi-pipeline repo roots at `Component`" (D17) — which auto-creates its own `Stack` exactly the way a root `Pipeline` class does (`pipeline.ts`), so `App`/`Stack` stay absent from that file's own code (D15a).

### §242. Declares a source mapping onto this component (C1)

Declares a source mapping onto this component (C1) — the repo/path glob whose events correlate to one of this component's pipelines (DESIGN §9.2). Declared on `Component` rather than on `ResourceConstruct` because `source_mappings.component_object_id` is exactly that: a mapping routes a source to a COMPONENT, and offering the method on every resource type would invite mappings onto services and deployment-targets that correlation would never consult. `stack.addSourceMapping(urn, ...)` remains available for a component outside this program.

Call it once per source: mappings are identified by their whole tuple, so several are fine (a repo that drives both an `image` build and a `configuration` sync), but declaring the same tuple twice is rejected at `POST /plans`.

### §243. Declares that this component PRODUCES a dependency coordinate

Declares that this component PRODUCES a dependency coordinate (ADR-0032 §7e) — "this component's production releases are where `@acme/lib`'s versions come from". Sugar over `stack.addDependencyProducer(this, spec)`, which carries the full rule.

Declared on `Component` and not on `ResourceConstruct` for the same reason `mapsSource` is: `dependency_line_producers.producer_object_id` must be a component, and a `service`-valued declaration is REFUSED at `POST /plans` — internal head derivation reads the component a production placement names, so a service declaration would stop the coordinate being polled and derive no head at all. Offering the method on every resource type would invite exactly that.

TWO THINGS THIS SURFACE CANNOT DO, both by design: 1. Retract the stack's LAST declaration — deleting the call leaves it standing, because an absent `producers` collection means UNMANAGED (`addDependencyProducer`). 2. Show you the blast radius first. The API verb's `--dry-run` lists the components whose repositories this reaches; a manifest cannot, so run it before you commit the code.

### §244. Places this component at `deploymentTarget` (ADR-0026)

Places this component at `deploymentTarget` (ADR-0026) — the form to reach for.

Sugar over the standalone `Placement` construct, which it CONSTRUCTS rather than duplicating: one implementation, two spellings (decision Q1). Reads like `dependsOn`/`consumes`/`owns`, and names the component implicitly, which is what makes it the ergonomic default.

Note it is NOT the safety argument for preferring it: both endpoints are required on the standalone form too, so a half-declared placement is unexpressible either way — the pair IS the identity (D3).

### §245. A placement as a standalone construct (decision Q1's second form)

A placement as a standalone construct (decision Q1's second form) — for the case the sugar cannot serve, e.g. a component referenced by URN from outside this program.

NOT a `ResourceConstruct`: a placement is not emitted into the manifest's `objects` at all. It is a side-table declaration like a source mapping, because it cannot be created through a door taking free-form `properties` — that door is refused outright, since it could not resolve or type-check the endpoints nor write the derived edges (PR #207).

### §246. Declares an `executor_bindings` row on THIS placement

Declares an `executor_bindings` row on THIS placement — `component.placeAt(prod).bindsExecutor({…})`.

This is the pipeline that actually releases the component AT that target, which is why it hangs off the placement rather than off either endpoint: the same component at two targets is two bindings, and the same target for two components likewise.

### §247. Campaign / Release Topology constructs (M5, BUILD_AND_TEST.md §8)

Campaign / Release Topology constructs (M5, BUILD_AND_TEST.md §8) — written as real `ResourceConstruct` subclasses rather than via `defineResourceConstruct`, because each needs custom constructor logic (resolving construct references to URN strings, typed `waves`/`targets` props) that plain `ResourceProps` doesn't support.

### §248. Resolves a relationship-style reference to a URN string

Resolves a relationship-style reference to a URN string — the same `typeof t === "string" ? t : t.urn` pattern `Stack.synth()` uses for relationship endpoints, reused here for the `properties.targets`/`properties.waves[].targets` arrays these constructs synthesize (which are plain JSON, not relationship declarations). Accepts an owned construct, a `fromXxx()` reference, or a bare URN string — all three carry `.urn` except the string, which already IS one. A reference is NEVER registered anywhere by this call; it only ever contributes the URN it already carries (D16(2): "a reference must never create an object in the manifest").

### §249. Best-effort human-readable LOCATION for a synth validation error

Best-effort human-readable LOCATION for a synth validation error (D16(5)): the construct's tree PATH when the reference is an owned construct in this program, else the raw URN/id string it names (an external reference, a `fromXxx()` placeholder, or a bare id — none of which sit in this program's construct tree, so there is no path to report beyond the identifier itself). Used to annotate every entry `Stack.synth()` pushes into a collection the final schema validation checks, so a refusal names the file/construct a team actually wrote, not just an array index.

### §250. A named, reusable wave plan

A named, reusable wave plan (server-side object type `"release-topology"`, pre-seeded — `drizzle/0007_change_coordination.sql`). A `Campaign` (or a Change) links one by id — see `CampaignProps.topology`'s doc comment for the id-vs-URN caveat that applies there.

### §251. The objects this campaign fans out to, one change each

Object ids or URNs this campaign fans out to — one member Change per target, per wave. Resolved to URN strings here, mirroring `CreateCampaignRequestSchema.targets`'s idOrUrn semantics. `coordination/campaign-reconcile.ts` re-resolves every declared target (and `topology`, below) to a real object id the first time the campaign's plan compiles — the same `getObjectByIdOrUrnAnyType` idOrUrn resolution `POST /campaigns` (`proposeCampaign`) and `POST /changes` (`proposeChange`) already do at creation time, just deferred to reconcile time for an IaC-authored campaign (which has no such creation-time hook — `iac/plans-repo.ts` persists a manifest's declared `properties` verbatim). This is what makes an IaC-authored campaign's implicit `depends_on`-based wave auto-sequencing work identically to an API-created campaign's: `campaign-plan-service.ts`'s `loadDependsOnEdges` queries `relationships` by real object id, so resolution has to land BEFORE that query runs, not after — reconcile.ts's ordering guarantees exactly that. The campaign's own stored `properties.targets` is canonicalized to the resolved real ids as a side effect of that first compile (a one-time, idempotent no-op for an already-real-id API-created campaign).

### §252. A coordinated multi-target rollout

A coordinated multi-target rollout (server-side object type `"campaign"`, pre-seeded — `drizzle/0011_campaigns.sql`). See `CampaignProps.targets`/`CampaignProps.topology` for how IaC-authored (URN-only, pre-apply) references get resolved to real object ids server-side.

SECURITY NOTE: `campaign.properties.targets` is bound to the applying actor's own `object:write` authority at apply time (`coordination/campaign-scope-authz.ts`'s `assertCampaignTargetsWithinAuthority`, wired into `iac/plans-repo.ts`'s `prepareApplyChecks`) — every declared target is individually resolved and `authorize()`-checked, the same shape as `POST /campaigns`. The generic `/objects/campaign` endpoint refuses campaign writes outright (forcing ordinary API clients through `POST /campaigns`); IaC apply is exempt from that block only because it runs this equivalent per-target check itself. Net effect for IaC authors: an `apply` can 403 on a single target inside an otherwise-valid plan, not just reject the whole manifest up front — every `checks` entry is authorized before ANY mutation executes (`plans-repo.ts`'s module doc), so a partial/mismatched campaign is never created, but the failure is per-target, not whole-manifest.

## `packages/coordination-as-code/src/duration.ts`

### §253. CDK-exact duration value class (team-pipeline-iac.md D16(3))

CDK-exact duration value class (team-pipeline-iac.md D16(3)) — `Duration.seconds(n)`, `.minutes(n)`, `.hours(n)`, `.days(n)`. Every duration prop in this grammar (`every:`, `maxAge:`, `pauseBetween:`, a `BakeAlarms` quiet window, …) takes one of these, never a `"5m"` string and never a bespoke ad hoc wrapper. Percentages stay plain numbers on self-describing props (`batchPercent: 25`, CDK's `minHealthyPercent` pattern) — there is deliberately no `Percent` class alongside this one; a number already says what it is when the prop name does.

## Canonical form

Every `Duration`, regardless of which factory built it, normalizes to a total-milliseconds count internally — `Duration.minutes(5)` and `Duration.seconds(300)` are indistinguishable once built, which is exactly what makes an embedded duration byte-stable in a synthesized manifest (the goal statement's determinism requirement) no matter which unit an author happened to write. `toJSON()` returns that count, so `JSON.stringify` (and anything that calls it, including `JSON.stringify`-based equality checks in tests) serializes a `Duration` as one canonical number.

`canonicalJson`'s `canonicalizeDeep` (`@scp/schemas/canonical-json`, re-exported from `./canonical.js`) walks own enumerable object keys and does **not** call `toJSON()` — it is not `JSON.stringify`, it is the recursive key-sorter `Stack.synth()` runs the ASSEMBLED manifest through. A raw `Duration` instance left inside a manifest's `properties` would therefore NOT canonicalize through this class's `toJSON()`; a construct that embeds one must resolve it to a plain value first (`duration.toMilliseconds()`), exactly the same discipline `resolveUrn()` already imposes on construct references before they reach `properties`. No construct in this package embeds a `Duration` into a manifest yet (the constructs that will — `Workflow`, `ContinuousTest`, `BakeAlarms`, the rollout classes — ship in a later increment against this class); this doc note is here so that increment does not rediscover the hazard.

UPDATE: the L1 half of that increment has landed — `Stack.addPipelineHook`/`addRollout`/ `addConvergence` and the three manifest collections `synth()` now assembles. Those doors take the contract's own plain-number seconds (`everySeconds`, `maxAgeSeconds`, `quietWindowSeconds`, `pauseSeconds`), so they still embed no `Duration`. The hazard above becomes live only when the typed L2 constructs accept a `Duration` prop and must resolve it before it reaches the entry.

## Validation

Every factory rejects a non-integer or negative amount at CONSTRUCTION time, loudly — never a silently-clamped or silently-truncated duration reaching synth.

## `packages/coordination-as-code/src/estate-program.test.ts`

### §254. Unit coverage for the shared export and scaffold emitter

Unit-level coverage for the shared `scp iac export`/`scp iac scaffold` emitter (team-pipeline-iac.md §9/§7). The stronger, whole-file proofs — "the rendered TS actually compiles against the real `@scp/coordination-as-code` package" and "export → synth → compare" executed through a real `tsc` — live in `@scp/cli`'s `iac-estate-program.roundtrip.test.ts`, because only a package that already depends on `@scp/coordination-as-code` (a real `node_modules` symlink, not a source-relative import) can compile generated code AGAINST the published surface the way a real team's repo would. This file covers the two pure functions' own behavior in isolation: what they build/render for a given `ServiceSpec`, and the placeholder count they agree on.

### §255. MUTATION-WATCHED (restored before commit)

MUTATION-WATCHED (restored before commit): removing the `adoptTopologyUrn` spread from `buildEstateManifest`'s `props` object makes this case go red — the synthesized topology's URN reverts to a fresh, derived one instead of the live URN `spec` supplied, which is exactly the silent-duplication hazard this prop closes (applying the exported manifest would then CREATE a second `release-topology` object beside the real one and repoint `releases_via` at it).

### §256. Mutation-watched: a plausible alternative would be caught

MUTATION-WATCHED: if the `repo:` branch below were changed to emit a plausible fabricated string (e.g. `${slug}/${component}`) instead of the `undefined` placeholder constant, this case goes red (the marker text and `TODO_MISSING_REPO_1` both vanish) — and `@scp/cli`'s `iac-estate-program.roundtrip.test.ts` placeholder case goes red too, because the emitted file would then typecheck when it must not. Restoring the `undefined` constant turns both green again.

## `packages/coordination-as-code/src/estate-program.ts`

### §257. The shared emitter behind `scp iac export`

The shared emitter behind `scp iac export` (team-pipeline-iac.md §9/D5) and `scp iac scaffold` (§7/D1/ADR-0047). Both commands walk a live estate (export: existing graph state; scaffold: a discovery proposal) into the SAME normalized `ServiceSpec` below, then hand it to ONE of two pure functions here:

```text
- `buildEstateManifest(spec)` — INTERPRETS `spec` by calling the REAL `@scp/coordination-as-code` constructs
  (`Component`, the typed `XxxPipeline` classes, `placeAt`, …) and returns `stack.synth()`.
- `renderEstateProgram(spec)` — RENDERS the SAME calls as TypeScript SOURCE TEXT.
```

Both read `spec` and nothing else — no SDK, no I/O, no clock (matching every other pure module in this package). The CLI (`packages/cli`) owns turning live SDK reads into a `ServiceSpec`; this module owns turning a `ServiceSpec` into a manifest or into code. That split is what makes the round-trip property (§9: "exported ts, when synthesized, must produce a manifest equivalent to the json export of the same scope") a fact about ONE input rather than two independently-maintained readers of the live estate that could silently drift from each other.

NOT auto-derived from each other (deliberately): `buildEstateManifest` calls real constructs, so TypeScript itself enforces that `spec` matches what `@scp/coordination-as-code` accepts; `renderEstateProgram` mirrors the same calls as text. Nothing here CHECKS the two stay in lockstep beyond the round-trip test in `estate-program.test.ts` — which is exactly the point: that test is the thing that would go red the moment they diverge, matching the task's "assert this directly" instruction rather than relying on a shared internal representation neither path can prove against the real types.

### §258. D18's loud placeholder

D18's loud placeholder. ONE marker string, shared by both emitters' documentation (not their literal output — see `renderEstateProgram`'s doc for why the TS side goes further and fails typecheck), so a human grepping either form for "why is this here" finds the same trail.

### §259. The erased constructor shape every generated class satisfies

Erased constructor shape every generated pipeline-kind class satisfies — `pipeline.ts`'s own `PipelineConstructStatics<K>` is generic per-kind (its props type varies with `K`, specifically `MaybePublishProps<K>`), which is exactly right for a program written by hand against ONE known kind and exactly unusable for a table indexed by `ExecutorType` at large: `Record<ExecutorType, PipelineConstructStatics<K>>` has no single `K` to be generic over. This interpreter passes a loosely-typed `props` object built from `spec` (below) instead — the real per-kind type-checking this erasure steps around is proven elsewhere (`pipeline.placeAt.typecheck.test.ts`); what THIS table needs is "call the right class", not "re-derive its compile-time prop shape".

### §260. The renderer — `--format ts`'s path

The renderer — `--format ts`'s path. Mirrors `buildEstateManifest`'s calls as TypeScript source, with ONE deliberate divergence: the D18 placeholder.

WHY THE TS PLACEHOLDER IS `undefined`, NOT THE SAME STRING THE JSON PATH USES
`buildEstateManifest` needs *a* non-empty string (the real `PipelineBase` constructor throws on an empty one) so the interpreter can still produce a manifest to inspect/diff. The renderer has a stronger tool available and the task calls for using it: a `repo` prop typed `string` (required, D18) rejects `undefined` at compile time under this repo's `strict` tsconfig, so emitting an `undefined`-typed local as the value makes the whole file FAIL TO TYPECHECK until a human replaces it — not just visually obvious, but mechanically unmissable (CI/`tsc --noEmit` refuses it, matching this repo's "fail loudly, not just visibly" standard). `estate-program.test.ts`'s placeholder case proves this by actually invoking the TypeScript compiler against the rendered output.

### §261. §8's commented starter wave topology

§8's commented starter wave topology — text only, never live code (a scaffolded component's real environments/stages are not something discovery can know). `scp iac scaffold` passes this via `renderEstateProgram`'s `waveGuidance` option so every emitted pipeline that starts with an EMPTY `waves: []` carries the shape a team is expected to grow it into, in `staging`/`production` vocabulary (D6/D21(e)) — never `gamma`, never bare `prod`.

### §262. Trailing synth + export

Trailing synth + export — lets a caller (or CI, or this package's own round-trip test) `import()` the file and read `.manifest` straight off it, the same drift-check shape `scp iac render --write` already establishes for the pipeline picture. Real teams' own CI still owns committing this next to a `scp/manifest.json` (D2/D9); this export is what makes THAT step (and this tool's own round-trip proof) a plain `import`, not a second bespoke synth entry point.

## `packages/coordination-as-code/src/index.ts`

### §263. The constructs that synthesize a deterministic manifest

`@scp/coordination-as-code` — CDK-style TypeScript constructs that synthesize a deterministic desired-state manifest via PURE synth (BUILD_AND_TEST.md §8 M2 item 4, DESIGN.md §15). No API calls, no randomness, no wall-clock reads in `synth()` — works fully offline, so IaC programs can be authored/synthesized in CI or across an air gap and applied later (`scp plan`/`scp apply`, `packages/cli`), exactly like a CDK cloud assembly being `cdk deploy`'d separately from where it was synthesized.

### §264. RBAC (role-model.md — the IaC rung)

RBAC (role-model.md — the IaC rung). `RoleBinding` refuses a group/team subject at synth: D7's acknowledgement is a statement about a membership at a moment, and a manifest can only carry a snapshot that goes stale and trains its author to stop reading the refusal. Groups are granted through `scp role-binding grant-preview` + `create`. The L1 doors (`Stack.addRoleBinding`, `addRole`) stay available for a subject referenced by URN from outside the program.

### §265. Writes the canonical JSON manifest to disk

Writes the canonical JSON manifest to disk — the interchange point between IaC authoring (pure, offline synth) and server-side reconciliation (`scp plan`/`scp apply`, `POST /plans`), exactly like `cdk synth` writing a cloud-assembly directory that `cdk deploy` reads separately. Uses recursively-sorted-key canonical JSON (`canonicalJson`), not plain `JSON.stringify`, so the file's bytes are stable even when caller-supplied `properties`/`labels` objects were built with different key insertion order — the same byte-identical-output guarantee `synth()` itself makes.

### §266. Writes a pipeline's products module to disk

Writes an infra/configuration pipeline's D20 products module to disk — the same impure-I/O layer `synthToFile` is for the manifest, and for the same reason: `productsModuleSource` itself (like `Stack.synth()`) does no I/O, so a caller who only wants the text (a test, a different write target) calls that directly. `synthToFile` and this are typically called side by side against one pipeline's `Stack`/scope — "alongside its manifest" (D20) — but neither calls the other; a repo's CI publishes the written module as its own package (D10), independent of the manifest's own `scp plan`/`scp apply` path.

## `packages/coordination-as-code/src/infra.test.ts`

### §267. D24's compile-rung derivation has two layers

D24's compile-rung derivation has two layers (see `infra.ts`'s module doc for the full reasoning): a TYPE-level `PLACEMENT_MATRIX` (checked by the compile-fail cases in `pipeline.placeAt.typecheck.test.ts`) and this VALUE-level parity check, which is what actually proves the two matrices cannot drift — `@scp/schemas`'s own export is the authority, and this test is deliberately the kind of guard that goes RED the instant `infra.ts`'s copy disagrees with it.

## `packages/coordination-as-code/src/infra.ts`

### §268. Typed infra-product constructs (team-pipeline-iac.md D19/D24)

Typed infra-product constructs (team-pipeline-iac.md D19/D24) — `Cluster`, `InstanceGroup`, `Database`, `Bucket`, `Queue`, one per member of `InfraKindSchema` (`@scp/schemas/pipeline- behaviors.ts`), scoped to the Infrastructure/Configuration `Pipeline` that manages it (`pipeline.ts` — a `Cluster`'s scope is a pipeline, never a bare `Stack`, which is what round A's widened `ResourceConstruct` scope union exists to allow).

INFRA PRODUCTS ARE `deployment-target` OBJECTS, NOT A PARALLEL TYPE — READ BEFORE CHANGING typeId
The first version of this file gave each infra kind its OWN manifest `typeId` (`"cluster"`, `"instanceGroup"`, …) and had `placeAt` emit a `deploys_to` relationship to route around `placements`' `deployment-target`-only endpoint. Both halves of that were wrong, and MEASURED wrong on `main`, not merely awkward:

```text
1. `deploys_to`'s registered relationship type excludes every infra kind as a `to` endpoint
   (`apps/server/drizzle/0002_rls_rbac_seed.sql`: `to_types = ['deployment-target']`) — an edge
   to a `cluster`/`instanceGroup`/… object is refused at apply, exactly the failure the
   workaround existed to dodge.
2. `deploys_to` is explicitly legacy on the component path (`apps/server/drizzle/
   0055_assembly_object_type.sql`: "ADR-0026 made the component/target pair a `placement`, so
   this edge is legacy on the component path already") — building new behavior on it
   contradicts the ADR that created placements in the first place.
```

The actual fix needs no migration: `docs/GLOSSARY.md` already defines "deployment target" as *"the graph object type an executor acts on (cluster, host, environment, region) — deliberately broad"* — naming *cluster* as an example, not a different type. D24's infra kinds are SUBTYPES of `deployment-target`, not a sibling type needing its own placement machinery.

So every infra product below synthesizes with `typeId: "deployment-target"` and carries its infra kind as `properties.kind` (`"cluster"`, `"instanceGroup"`, …) — additive data on an ALREADY-OPEN property schema (`apps/server/drizzle/0081_target_facet_and_publishes_to.sql`'s header states the schema is deliberately open: no `enum`, no `required`, no `additionalProperties:false`, precisely so a new well-known property never needs a migration or wedges an older federation peer). `placeAt` (`pipeline.ts`) writes a REAL `placements` entry, which is legal for exactly the reason the workaround wasn't: `createPlacement`'s `typeId === "deployment-target"` check now PASSES, because the object genuinely is one. D19's "the graph object and the real infrastructure share one managing pipeline" still holds through `managed_by_stack`, unchanged by any of this.

WHY THE COMPILE-TIME COMPATIBILITY DERIVATION LIVES HERE, AND WHAT "DERIVED" ACTUALLY MEANS
D24: "Each pipeline kind's `placeAt` accepts only the infra interfaces its artifact can actually land on... Derive the per-kind signatures from `ARTIFACT_INFRA_COMPATIBILITY` so the types and the server's matrix cannot drift."

`@scp/schemas` exports `ARTIFACT_INFRA_COMPATIBILITY` typed as `Record<ExecutorType, readonly InfraKind[]>` — an explicit WIDENING annotation, deliberate on that side (D24's own doc: "TOTALITY IS THE POINT... a TOTAL mapping keyed by the enum itself"). The cost of that annotation is that TypeScript cannot recover each key's LITERAL row (`image: ["cluster"]`) from the exported VALUE — once a value is typed `readonly InfraKind[]`, every element reads back as the general union `InfraKind`, not the specific literal(s) that row actually holds. A `placeAt` overload keyed off the erased type could therefore only accept `InfraKind` in general, which is exactly the "anything accepts anything" hole D24 exists to close — so pulling the TYPE-LEVEL information through the VALUE-LEVEL export, alone, cannot produce a compile-time-checked `placeAt`.

The derivation therefore happens in two layers, and BOTH must hold for the guarantee to be real:

```text
1. TYPE level — `PLACEMENT_MATRIX` below is `@scp/schemas`'s rows, re-declared `as const` so
   TypeScript keeps each key's LITERAL tuple, combined with `satisfies Record<ExecutorType,
   readonly InfraKind[]>` (not a `:` annotation) so the totality guarantee is STILL compile-
   checked — a member added to `ExecutorTypeSchema` without a row here is a compile error,
   exactly like the schemas-side export. `satisfies` is what lets both things be true at once:
   totality-checked AND literal-preserving, which a `:`-annotated `Record` cannot be.
2. VALUE level — `infra.test.ts`'s parity case asserts, by `Object.entries`, that this
   constant is deep-equal to the real `ARTIFACT_INFRA_COMPATIBILITY` import, row for row. A row
   that drifts from the server's own matrix fails that test immediately.
```

Together: a member or a value can never drift from `@scp/schemas` without one of the two layers catching it at build time or test time — which is the best TypeScript can do here, since it has no way to recover literal types from an already-widened value it does not itself declare. This is the "if TypeScript cannot express that derivation cleanly, say so" case D24's build instructions anticipate; the honest answer is a two-layer derivation, not a single one, and NOT eleven hand-written `placeAt` signatures with no check tying them back to the schema's matrix.

### §269. The infra interfaces a pipeline of that kind accepts

The infra interface(s) a `K`-kind pipeline's `placeAt` accepts, derived from `PLACEMENT_MATRIX` (see the module doc above for exactly what "derived" means and does not mean here). Distributes over a multi-row kind (`configuration` → `ICluster | IInstanceGroup`); a kind whose row is `[]` (`npm`, `infrastructure`, …) derives `never`, which is what makes `placeAt` UNCONSTRUCTABLE for those kinds — a compile error at the call site, not a runtime check (D24's compile rung).

### §270. Any construct owning a stack, which can parent a product

Any construct that owns a `Stack` and can therefore parent an infra product — round A's `ResourceConstruct` (widened) or round B's `Pipeline` base. Kept narrow and structural rather than importing `PipelineBase` here, so `infra.ts` has no dependency on `pipeline.ts` (the reverse dependency — `pipeline.ts` imports `infra.ts` for `PlaceableTarget`/the interface types — would otherwise become circular).

### §271. The BROADER deployment-target

The BROADER deployment-target (stage) this infra product lives at/within — GLOSSARY's stage grammar (e.g. `commercial-amer-production`). Recorded as `properties.within` (a plain URN, resolved from a construct/reference/string like every other endpoint in this package) rather than as a relationship, since no cross-boundary consumer of that fact exists yet in this increment. Orthogonal to the object's OWN identity as a (narrower) deployment-target in its own right — see this module's doc for why an infra product is a `deployment-target` object.

### §272. Every infra product's placeholder reference lives in the SAME

Every infra product's placeholder reference lives in the SAME (typeId=`deployment-target`, name) namespace an ordinary `DeploymentTarget.fromName()` reference does — because it IS one. Two infra products (or an infra product and a plain stage) sharing a display name collide here exactly as two same-named deployment-targets would collide server-side; this is the expected, pre-existing rule, not a new hazard this file introduces.

### §273. A reference to an infra product

A reference to an infra product — deliberately NOT `IResourceRef<Kind>` (round A's pattern for every OTHER typed-registry reference, where the interface's `typeId` field equals the object's real wire `typeId`). An infra product's wire `typeId` is uniformly `"deployment-target"` (this module's doc explains why), so reusing `IResourceRef<Kind>` here would make `ICluster` and `IInstanceGroup` the SAME type once `Kind` is fixed to `"deployment-target"` for both — exactly the "anything accepts anything" hole D24's compile rung exists to close. `kind` is the extra, TYPE-LEVEL-ONLY discriminant that keeps `ICluster`/`IInstanceGroup`/… structurally distinct; it is ALSO real wire data (`properties.kind`), so it is never a fabricated field — see `_toManifestObject` below, where the two uses of `kind` (the TS discriminant and the property) are kept in lockstep by construction (one `kind` variable feeds both). Structurally still an `IDeploymentTarget` (`urn` + `typeId: "deployment-target"`, with `kind` as an allowed EXTRA property) — an infra product reference is legal anywhere a plain deployment-target reference is accepted, matching "an infra product IS a deployment-target" all the way down to the type system.

### §274. Type guard: true for an owned resource of this module

Type guard: true for an OWNED resource construct that is one of THIS module's infra products (`Cluster`/`InstanceGroup`/`Database`/`Bucket`/`Queue`) — as opposed to a plain `DeploymentTarget` or any other `"deployment-target"`-typed resource a program might declare. `defineInfraProduct Construct`'s generated classes are the only place a `kind` field is ever set on an instance, so checking for it is sufficient without importing this module's private class list. Used by `products.ts` (D20) to walk a pipeline's owned resources (`Stack._resourcesWithin`, construct.ts) and pick out only its own declared products, never a bare stage a program also happens to declare in the same subtree.

### §275. A kubernetes-style cluster

A kubernetes-style cluster (D24 `InfraKindSchema`'s `"cluster"` member) — the deploy target for `image`/`chart`/`configuration` pipelines (`PLACEMENT_MATRIX`). Synthesizes as a `deployment- target` object with `properties.kind: "cluster"` (this module's doc) — a real placement target.

## `packages/coordination-as-code/src/pipeline-behaviors.l1.test.ts`

### §276. THE L1 DOOR FOR THE INCREMENT-8 CONTRACT

THE L1 DOOR FOR THE INCREMENT-8 CONTRACT — `pipelineHooks`, `rollouts`, `convergence`.

WHAT WAS BROKEN, MEASURED BEFORE THIS FILE EXISTED
The contract merged in #294 and the server half has been live since: `plans-repo.ts` applies `pipelineHooks` through `upsertHook`, `render.ts` displays them per component, the gates read them, and `POST /plans` accepts them. **And `@scp/coordination-as-code` could not emit one by any route.** There were no L2 constructs (`duration.ts` said so in a comment) and — the part that made it a blocker rather than an ergonomic gap — no L1 hatch and no assembly: `synth()` did not build the three collections at all, so even a hand-rolled declaration would have been dropped on the floor.

D16(1) promises that no L2 construct may block reaching L1. For these three collections there was no L1 to reach, which is a stronger failure than the promise anticipated: the whole increment-8 runtime was unreachable from a CDK program, and the only way to author a hook was to hand-write manifest JSON and POST it — exactly the experience the construct library exists to replace.

MUTATION LOG — each applied, watched fail, reverted, watched pass
| Mutation | Result (MEASURED) |
| `synth()` stops assembling `pipelineHooks` into `candidate` | 4 FAIL — (1), (2), (3), (7). This is the pre-existing bug, and it fails silently: the declaration simply is not in the output. | | `addPipelineHook` spreads the caller's object AFTER the resolved `componentUrn` instead of before | (2) FAILS — a smuggled `componentUrn` attaches the hook to another component. **SURVIVED the first version of case (2)**, which passed a well-typed spec and asserted the URN matched: true under both spread orders. The smuggled key is what makes it discriminating. | | the hook sort key drops `hookId` | (4) FAILS — same-kind siblings stop sorting deterministically, so declaration order changes the bytes. | | `pipelineHooks` emitted as `[]` when empty instead of omitted | (5) FAILS. The omission is load-bearing: absent means UNMANAGED for this collection, so emitting `[]` would make a program that declares no hooks RETRACT every hook the component has — a disarmed gate, whose symptom is an absence of refusals. |

The `rollouts`/`convergence` omissions are pinned by the same case (5); they follow the ORDINARY rule (absent = empty = prune) because neither gates anything.

### §277. The type omits that field, so this is reachable only from JS

The type `Omit`s `componentUrn`, so this is only reachable from JavaScript or through a cast — which is exactly why it is worth pinning. The hatch spreads the caller's object FIRST and writes the resolved URN AFTER, so the construct wins; the opposite order would let a stray key silently attach a hook to a component the caller never passed, and every type-level protection would be intact while it happened.

THIS CASE WAS VACUOUS WHEN FIRST WRITTEN. It passed a well-typed spec and asserted the URN matched, which is true under BOTH spread orders — the mutation that reverses them survived it. The smuggled key is what makes the assertion discriminating.

### §278. A RUNTIME contract violation, not a type error

A RUNTIME contract violation, not a type error: `maxAgeSeconds` is `z.number().int().positive()`, whose refinements are invisible to TypeScript (the inferred type is plain `number`), so `-1` typechecks and only Zod refuses it. That is exactly what this case is for — synth must still VALIDATE the collection it now assembles, and D16(5) requires the refusal to name the construct path.

## `packages/coordination-as-code/src/pipeline.placeAt.typecheck.test.ts`

### §279. The compile rung, proved the way this repo already does

D24's COMPILE rung, proved the way this repo already proves compile-time guards (per this increment's build instructions): `// @ts-expect-error` lines that fail the BUILD — `tsc --noEmit`, the package's `typecheck` script, `tsconfig.json`'s `include: ["src"]` sweeps this file in — the moment the error they name stops occurring. A RUNTIME-ONLY test proves nothing about a compile- time guard; the proof here is the presence of this file passing `pnpm --filter @scp/coordination-as-code typecheck`, not the `it()` block below (which exists only so this is also a normal, green vitest module and so the "legal pairings" section has a runtime assertion of its own).

MUTATION-PROVED (restored before commit): commenting out any ONE `@ts-expect-error` line below and running `pnpm --filter @scp/coordination-as-code typecheck` makes tsc report "Unused '@ts-expect-error' directive" — RED — for every line whose error stopped firing; re-adding it goes back GREEN. That is what confirms each directive is load-bearing rather than decorative.

## `packages/coordination-as-code/src/pipeline.test.ts`

### §280. MUTATION-PROVED (restored before commit)

MUTATION-PROVED (restored before commit): reverting `pipeline.ts`'s `ReleaseTopology(...)` call to drop the `...(resolved.props.adoptTopologyUrn !== undefined ? { urn: ... } : {})` spread makes this case fail — the synthesized topology's URN reverts to the derived one instead of the live URN supplied here, which is exactly the silent-duplication bug this prop exists to close (a second `scp apply` of an exported estate would create a SECOND topology object beside the real one and repoint `releases_via` at it).

## `packages/coordination-as-code/src/pipeline.ts`

### §281. Typed pipeline-kind constructs

Typed pipeline-kind constructs (team-pipeline-iac.md D15/D16/D17/D18/D8, round B). A "pipeline" is DERIVED, never a new manifest collection (main doc §2): every `Pipeline` construct below synthesizes into the SAME collections round A's `Stack` already exposes — a `release-topology` object, a `releases_via` relationship, `sourceMappings`, and `placements` — which is exactly why this file needs no schema change and no codegen.

### §282. `ExecutionSystem` — reference-only

`ExecutionSystem` — reference-only (§12: "`ExecutionSystem.fromName()` remains reference-only — creation stays an operator act — credentials"). No owned-construction form exists here on purpose: connecting a real execution system holds credentials, which stays a `scp connect` / `POST /executors` operator ceremony (main doc §1's worked example), never something a component's own committed manifest can conjure.

### §283. Keeps a pipeline's `repo:` prop to the org-relative slug

Keeps a pipeline's `repo:` prop to the org-relative slug (`repos("payments/payments-api")`) — D18's helper. THIS FUNCTION DELIBERATELY DOES NOT PREPEND A HOST: `@scp/coordination-as-code` is org-agnostic (it ships to every org on the platform, DESIGN.md's air-gap/self-hosting principle), so it has no single git host to default to, and the worked examples show the org's OWN standards package (`@corp/scp-standards`) re-exporting a host-aware `repos()` for its fleet (main doc D10, examples §5: "import { waves, repos } from '@corp/scp-standards'"). This identity function is what a standards package wraps — it exists in `@scp/coordination-as-code` so a repo that has not yet grown a standards package can still write `repos("payments/payments-api")` and get useful type-checked call-site documentation ("this is the org-relative part"), not an unlabeled string literal. Where the host ultimately comes from (a config-source's own `repo` pattern-match, §4) is unaffected either way — the config source matches by GLOB, not by this function's output.

### §284. The wave topology (§8)

The wave topology (§8) — `waves.linear(...)`/`waves.widening(...)`/`waves.byDomain(...)`, or a plain array in the same relaxed shape (`waves.ts`'s `WaveItem`). Placements are INFERRED from every stage these waves name (D8) — synth-time only; the synthesized manifest carries every inferred placement as an explicit entry, and an explicit `component.placeAt(...)` declaration for the same pair is never duplicated.

### §285. AN ADOPTION AFFORDANCE, not a greenfield-authoring prop

AN ADOPTION AFFORDANCE, not a greenfield-authoring prop: overrides this pipeline's auto-created `release-topology` object's URN with an EXISTING one (team-pipeline-iac.md §9/D5).

Without this, the topology object is ALWAYS a fresh, synth-derived URN (`deriveConstructUrn(stack, "release-topology", "${id}-topology")`) — correct for a program authoring a topology for the first time, but WRONG for `scp iac export`: applying an exported program against an estate whose component already has a live `release-topology` would create a SECOND topology object beside the original, repoint `releases_via` at the new one, and leave the real object unmanaged — a plan that *looks* like a clean set of creates while silently duplicating the very thing export exists to bring under management (D5: "a manifest entry matching an existing object by URN that is unmanaged becomes an `adopt` plan action").

A hand-authored program has no existing topology to name, so this stays `undefined` in every ordinary case — `scp iac export` is the one caller that sets it, using the live topology's own URN so `scp apply` adopts it instead of creating a duplicate.

### §286. Constructor-argument resolution, as a pure step

Constructor-argument resolution (root vs. nested), computed as a pure step before any `super()` call — same technique `construct.ts`'s `resolveComponentCtorArgs` uses, and for the same reason: the root form must create exactly ONE `Stack`/`Component` pair, so the resolution can only run once.

### §287. The shared synth logic every generated pipeline class uses

`PipelineBase` — the shared synth logic every generated pipeline-kind class runs. Extends `Construct` (not `ResourceConstruct`): a pipeline is not itself one manifest object, it is several (main doc §2's "derived, not a table"), so it has no single `.urn`/`.typeId` of its own.

### §288. The pipeline's own repo and branch, re-exposed

The pipeline's own source repo and branch, re-exposed because THE SCOPE CHAIN CARRIES CONTEXT (D15(b) as amended by D17): a `Workflow` declared under this pipeline inherits both rather than repeating them, which is also what stops a hook's workflow ref from drifting away from the source mapping this same pipeline declares — they are read from one place.

`repo` is always present (D18 makes it a required prop and the constructor refuses without it).

### §289. The component every behaviour here is about, or undefined

The component every behaviour declared under this pipeline is ABOUT, or `undefined` at D8's shared rung.

`undefined` is not a gap to fill in later: the contract keys every hook and rollout on a `componentUrn`, and which components inherit a SERVICE-rung pipeline is resolved at read time (the nearest-rung ladder), not at this program's synth time — the identical reason source mappings and placements are skipped for a shared-rung pipeline a few lines below. The L2 constructs refuse rather than guess, naming that reason.

### §290. Source mapping + placement inference

Source mapping + placement inference (D8) apply only at the COMPONENT rung. A pipeline scoped at the shared-rung exception (D8: a `Pipeline` scoped to a `Service`) attaches `releases_via` from the service, but `source_mappings.componentUrn` and `placements.componentUrn` are BOTH required fields (`@scp/schemas/iac.ts`) — there is no component here for this program to name, because pipeline resolution decides WHICH components inherit a service-rung pipeline at READ time, not at this program's synth time. So a shared-rung `Pipeline` declares the topology and its attachment only; per-component source mapping / placements remain each component's own declaration (its own `Pipeline`, or `Component.mapsSource`/`.placeAt`), exactly as the worked example's comment says: "components that declare their own pipeline still win by rung."

### §291. Declares a dependency edge from this component to a target

Declares a `depends_on` edge from this pipeline's component to `target` — sugar over `Stack.addRelationship`, matching `ResourceConstruct.dependsOn`'s shape so `image.dependsOn(...)` reads the same as `component.dependsOn(...)` (D14: a target that doesn't exist yet becomes a pending dependency rather than a refusal).

### §292. Declares which infra product

Declares which infra product (D19/D24) this pipeline's artifact deploys onto — `image.placeAt(products.payBlue)`. TYPE-CHECKED: `K`'s `PlaceableTarget<K>` (`infra.ts`, derived from the shared `PLACEMENT_MATRIX`) is `never` for a kind that cannot legally land on any infra kind (`npm`/`maven`/`python`/`go`/`infrastructure`), which makes THIS METHOD UNCONSTRUCTABLE for those kinds — a compile error at the call site (D24's compile rung), not a runtime check. `RpmPipeline.placeAt(anICluster)` fails to type-check for the same reason: `PlaceableTarget<"rpm">` is `IInstanceGroup` only.

A REAL `placements` ENTRY — AN INFRA PRODUCT IS A `deployment-target` OBJECT (see `infra.ts`)
An earlier version of this method emitted a bespoke `deploys_to` relationship instead, to route around what looked like a type mismatch: `Cluster`/`InstanceGroup`/… carried their OWN `typeId` (`"cluster"`, …), and `apps/server/src/graph/placements-repo.ts`'s `createPlacement` refuses any placement target whose `typeId !== "deployment-target"`. That workaround was itself broken, MEASURED on `main`: `deploys_to`'s registered relationship type excludes every infra kind as a `to` endpoint (`apps/server/drizzle/0002_rls_rbac_seed.sql`: `to_types = ['deployment-target']` only), and `deploys_to` is explicitly legacy on the component path (`apps/server/drizzle/0055_assembly_object_type.sql`: "ADR-0026 made the component/target pair a `placement`, so this edge is legacy on the component path already") — so the edge would have synthesized cleanly and then failed apply for a DIFFERENT reason than the one it was dodging.

The real fix is `infra.ts`'s own premise correction: `docs/GLOSSARY.md` already defines "deployment target" as *"the graph object type an executor acts on (cluster, host, environment, region) — deliberately broad,"* naming *cluster* as an example. D24's infra kinds are SUBTYPES of `deployment-target`, not a parallel type — so every `Cluster`/`InstanceGroup`/… synthesizes with `typeId: "deployment-target"` and its kind riding as `properties.kind` (an already-open property schema, `apps/server/drizzle/0081_target_facet_and_publishes_to.sql`). `createPlacement` therefore accepts it exactly as it accepts any other deployment-target — no server change needed, no migration, and D19's "the graph object and the real infrastructure share one managing pipeline" holds through `managed_by_stack` unchanged.

### §293. The products module for this pipeline's own owned infra

D20's products module, for THIS pipeline's own owned infra products (`Cluster`/`InstanceGroup`/ …, `infra.ts`) — pure TypeScript source text, exactly like `stack.synth()` is a pure manifest (no I/O here); `synthProductsModuleToFile` (`index.ts`) is the impure sibling that writes it to disk, the same split `synthToFile` already makes for the manifest itself. Every `PipelineBase` can call this (not just `InfrastructurePipeline`/`ConfigurationPipeline`) because nothing stops an infra product from being scoped to a build-kind pipeline that also manages its own substrate — it is simply empty (`renderProductsModule([])`) for the common case of a pipeline that owns none.

### §294. The 11 typed pipeline-kind classes

The 11 typed pipeline-kind classes — GENERATED from the closed `ExecutorTypeSchema` vocabulary (D17), never hand-copied. `definePipelineConstruct` is the one class body; `PIPELINE_CLASSES`'s `satisfies Record<ExecutorType, unknown>` is what makes a future `ExecutorTypeSchema` member with no row here a COMPILE ERROR — the same totality trick `@scp/schemas`'s own `ARTIFACT_INFRA_COMPATIBILITY` uses, applied to "does every kind have a class" instead of "does every kind have a placement row".

## `packages/coordination-as-code/src/products.placeAt.typecheck.test.ts`

### §295. The whole point, proved as a compile-time guarantee

D20's whole point, proved the way this repo already proves a `placeAt` compile-time guard (`pipeline.placeAt.typecheck.test.ts`'s own doc explains the pattern in full): `// @ts-expect- error` lines that fail the BUILD — `tsc --noEmit`, this package's `typecheck` script, `tsconfig.json`'s `include: ["src"]` sweeps this file in — the moment the error they name stops occurring. The runtime `it()` block exists only so this stays a normal green vitest module too.

WHY A HAND-WRITTEN `products` CONST HERE, NOT A GENERATED ONE. TypeScript typechecks this FILE'S source; it cannot typecheck a string `productsModuleSource(...)` returns at runtime in the same pass (that string only becomes real, checkable TypeScript once it lands in a consuming repo's own `.ts` file — D20/D10's whole publish step). So the object below is written by hand to be BYTE-FOR-BYTE THE SAME SHAPE `renderProductsModule` emits — an explicit type annotation naming each field's `I<Kind>` interface, values carrying exactly `{urn, typeId, kind}` — and `products.test.ts`'s content-assertion tests are what pin that `renderProductsModule` really does emit this shape. Together the two files close the loop: "the generator emits X" (products.test.ts) and "X makes a wrong `placeAt` a compile error" (this file) — neither on its own proves the whole chain, but both together do.

MUTATION-PROVED (restored before commit): commenting out any ONE `@ts-expect-error` line below and running `pnpm --filter @scp/coordination-as-code typecheck` makes tsc report "Unused '@ts-expect-error' directive" for that line — RED — confirming it is load-bearing. Also proved the OTHER direction the way D20 actually breaks in practice: temporarily typing `paymentsDb` below as `ICluster` instead of `IDatabase` (simulating a broken `INFRA_KIND_INTERFACE_NAME` row in `products.ts`) makes `image.placeAt(products.paymentsDb)` STOP being a type error — the `@ts-expect-error` above it then reports "Unused directive", RED — which is exactly the failure this test exists to catch. Both mutations were reverted before commit.

## `packages/coordination-as-code/src/products.test.ts`

### §296. D20's products module

D20's products module — "the infra pipeline's synth emits a typed products module alongside its manifest... a product the infra pipeline never declared fails at compile time; the wire still carries only the name/URN ref." This file covers the VALUE side (what gets collected, what text comes out, determinism); `products.placeAt.typecheck.test.ts` covers the COMPILE-TIME half — the actual guarantee a consuming repo relies on.

### §297. `camelIdentifier` and `deriveConstructUrn`'s `slugify`

`camelIdentifier` and `deriveConstructUrn`'s `slugify` (`urn.ts`) both normalize on the same separator/case rules, so in practice a camelCase collision IS a same-URN collision — this is that case, constructed the way it actually happens (a copy-pasted `new Cluster(...)` call whose id was never changed). The guard still fires on the identifier, not the URN equality, which is what makes it apply even if that coupling ever loosens.

### §298. Runs the emitter and returns its output or its refusal

Runs `productsModuleSource` and returns EITHER its output or its refusal message.

A REFUSAL IS PART OF THE PROPERTY, not an escape from it. The generator can produce ids that differ only in case (`"F"` and `"f"`), which is a legitimate authoring mistake the library is REQUIRED to refuse — and it did, which is how the underlying `Stack.synth()` duplicate-URN defect was found (this property failed in CI on seed 1953244992 and passed locally, because fast-check reseeds every run). Filtering those inputs out of the generator would have hidden a real bug: two constructs whose ids differ only in case derive ONE URN, and the server diffs by URN, so one of the two declared objects silently never existed. See `construct.test.ts`'s "two objects may not claim one URN".

So determinism is asserted over the whole behaviour: the same tree gives the same ANSWER twice, and a refusal is reproducible byte-for-byte exactly like an output.

### §299. Both were seeded with the same pairs, constructed differently

Both were seeded with the SAME set of (id, kind) pairs, just constructed in different order — the stack NAME differs (random, for isolation), so compare the RENDERED MODULE, which never mentions the stack name (D20: the module is keyed by construct id only). …and the refusal is order-independent too, which is the sharper half: a collision must not depend on which of the two colliding constructs was declared first.

## `packages/coordination-as-code/src/products.ts`

### §300. D20's products module

D20's products module — "the infra pipeline's synth emits a typed products module alongside its manifest ... a product the infra pipeline never declared fails at COMPILE TIME". PURE, exactly like `Stack.synth()` (no I/O in here) — this file only computes what the module's TEXT should be; writing it to disk lives beside `synthToFile` in `index.ts`, the same layering split the manifest side already makes.

INTERFACE-TYPED PER D24: the emitted `products` const carries an EXPLICIT type annotation (`readonly payBlue: ICluster`), not an inferred literal object type — that is what makes `products.payBlue: ICluster` the thing an IDE shows at the use site, and it is the property that turns `rpm.placeAt(products.payBlue)` into a compile error in the CONSUMING repo: `PlaceableTarget <"rpm">` is `IInstanceGroup` only (`infra.ts`), and `ICluster`/`IInstanceGroup` are structurally distinct on their `kind` literal (`infra.ts`'s `IInfraProductRef<Kind>`). `products.placeAt. typecheck.test.ts` proves that mechanism the same way `pipeline.placeAt.typecheck.test.ts` proves D24's compile rung: `@ts-expect-error` lines swept by `tsc --noEmit`.

THE WIRE STILL CARRIES ONLY THE NAME/URN REFERENCE (D20): the generated module's values are exactly the `{urn, typeId, kind}` shape `Cluster.fromUrn(...)` would hand back — this file adds no new manifest shape, it is authoring sugar over the SAME synthesized `deployment-target` objects `infra.ts` already emits.

### §301. camelCase JS identifier from any construct id/slug

camelCase JS identifier from any construct id/slug — `pay-blue` -> `payBlue`, `pay_blue` -> `payBlue`, `Pay Blue` -> `payBlue`. Every run of non-alphanumeric characters is a word boundary, matching how `slugify` (`urn.ts`) already treats separators, so an id built by hand and one built by `slugify` camelCase to the same identifier.

### §302. Every infra product owned anywhere under `scope`

Every infra product owned anywhere under `scope` (D19: "declared by — scoped to — the Infrastructure/Configuration pipeline that manages it"), as `ProductEntry`s — SORTED BY URN (the same determinism convention `Stack.synth()` uses for `objects`/`relationships`), so declaration order in the authoring program never changes the generated module's bytes, only content does.

Throws if two products under `scope` camelCase to the SAME identifier (e.g. `pay-blue` and `pay_blue` are two different construct ids that collide once slugified into JS) — a generated module with a duplicate key would silently drop one product rather than fail loudly, and this is the one place that can still be caught before the module ships.

### §303. When two urns print the same, the collision is upstream

WHEN THE TWO URNs PRINT THE SAME, the collision is upstream of this module and the sentence above is unactionable on its own: a URN is slugified (lowercased), so ids differing only in case derive ONE URN and the tree carries two objects claiming it. `Stack.synth()` refuses that outright; this line is for the paths that reach here WITHOUT going through synth (`productsModuleSource` is callable on its own), so the author is told which defect they actually have.

### §304. Renders `entries` as the module's TypeScript SOURCE TEXT

Renders `entries` as the module's TypeScript SOURCE TEXT — pure string building, deterministic given a deterministic `entries` (which `collectProducts` already guarantees by sorting on URN). Exported separately from `productsModuleSource` so a test (or a caller with its own product list, e.g. the D20 aggregated `targets.*` form) can render without needing a live construct tree.

## `packages/coordination-as-code/src/rbac.test.ts`

### §305. The two levels' equality, the group refusal, and determinism

RBAC constructs — the L1/L2 equality, the group refusal, and determinism.

THE EQUALITY CASE IS BUILT BY HAND ON THE L1 SIDE, deliberately. Deriving it from the same helper the construct uses would make the two sides agree BY CONSTRUCTION and prove nothing about drift — which is the whole property D16(1) asks for, since generated files and standards packages author through the L1 door and would otherwise diverge invisibly until somebody diffed two manifests. So every field the L2 form inherited is spelled out below.

## `packages/coordination-as-code/src/rbac.ts`

### §306. TYPED RBAC CONSTRUCTS

TYPED RBAC CONSTRUCTS (L2) — `RoleBinding` and `OrgRole`, thin sugar over the manifest contract.

WHY THESE EMIT THROUGH THE L1 DOORS
Every construct here ends in `stack.addRoleBinding(...)` / `addRole(...)` — the same hatches a hand-authoring caller uses. D16(1)'s "an L1-authored entry and its L2 equivalent synthesize identically" is then true BY CONSTRUCTION rather than by two code paths agreeing, which matters because generated files and standards packages author through L1 and would otherwise drift invisibly until somebody diffed two manifests.

WHAT THIS DELIBERATELY CANNOT EXPRESS: A BINDING TO A GROUP OR TEAM
`RoleBinding` REFUSES a `group` or `team` subject at synth. That is the one substantive design decision in this module and it narrows the surface rather than guarding it.

D7 requires the granter to acknowledge every principal a group binding empowers, compared by SET EQUALITY at the door. In a manifest that value is a MEMBERSHIP SNAPSHOT, and it goes stale the moment anyone joins or leaves. The failure that produces is not "the snapshot is wrong" — it is that a stale-snapshot refusal TRAINS THE AUTHOR TO STOP READING IT. They paste whatever the last error named, and a control whose entire purpose is that a human looks at the current membership becomes a checksum updated mechanically. Refusing here sends them to `scp role-binding grant-preview` + `create`, where the set is read at the moment of granting.

The refusal lives in this L2 layer rather than in `Stack.addRoleBinding` because the L1 door takes URNs it cannot resolve to a type at synth time. A construct knows what it was handed.

WHO APPLIES IS WHO IS JUDGED
`authz/role-binding-door.ts`'s no-escalation subset rule is evaluated against the APPLYING principal, which for a config-source sync is the TEAM object (ADR-0046 §1 / D9) and for the reconciler is a system actor. So a declared binding is refused unless the applier already holds every permission that role carries at that scope — meaning **a team's own repo cannot bootstrap that team's permissions**. That is the rule working rather than a gap, and it is stated here because the symptom (an apply that refuses a line the author believes is correct) is otherwise hard to attribute.

Note also that `prepareApplyChecks` runs every authorization check to completion BEFORE any mutation, in one transaction. A binding whose legality depends on a role created in the SAME manifest is therefore judged against the graph as it stood BEFORE the apply, and is refused. Split such a manifest in two; failing closed is deliberate.

### §307. Grants a role to a `user` or `service-account` at a scope. ``

Grants a role to a `user` or `service-account` at a scope.

```ts new RoleBinding(stack, "ci-deployer", { subject: ciAccount, role: "ComponentAdmin", scope: checkoutComponent, reason: "CI deploys checkout" }); ```

### §308. Declares an organization-defined role. ``

Declares an organization-defined role.

```ts new OrgRole(stack, "release-captain", { name: "Release Captain", permissions: ["object:read", "change:accept"], reason: "seat the release team" }); ```

### §309. Refuses a group subject with the reason and the alternative

Refuses a group/team subject with the reason and the alternative, not just a rejection.

A construct ref carries its type; a bare URN string is checked on the `:group:`/`:team:` segment that `urn:scp:<org>:<type>:<name>` always has. A URN whose type cannot be read is ALLOWED — this is a helpfulness guard at the authoring layer, and the API refuses a genuinely bad subject regardless. Failing closed on an unparseable URN would reject legitimate external references for a shape this layer has no business policing.

## `packages/coordination-as-code/src/render.test.ts`

### §310. The render shows all gates that apply, including inherited

D21(d): `scp iac render` shows ALL gates that will apply, including estate-imposed ones the team never declared — "the picture must be the truth, not the team's subset of it." This file proves the two halves of that: what a synthesized manifest's OWN declarations render as (waves, source, publish, declared hooks), and the FIXED, always-present honesty section (`MANIFEST_ONLY_ DISCLAIMER` + the estate-imposed gate lines) that `render.ts`'s module doc explains render can and cannot know from a manifest alone.

## `packages/coordination-as-code/src/render.ts`

### §311. Regenerates the human-readable pipeline picture

D21(d): `scp iac render` regenerates the human-readable pipeline picture from a SYNTHESIZED manifest — pure string transforms, exactly like `Stack.synth()`/`products.ts` are pure; the CLI (`packages/cli/src/cli.ts`) owns the only I/O (reading `--manifest`, writing `--write`).

THE HARD PART, AND THE REASON THIS EXISTS: D21(d)'S "ALL GATES", HONESTLY
"`scp iac render` shows ALL gates that will apply, including estate-imposed ones the team never declared (the scan gate at the registry) — the picture must be the truth, not the team's subset of it." This module runs OFFLINE against a manifest file alone (D21(d)'s own constraint — render is a local dev-loop tool, not an API call), so it genuinely cannot see domain binding policy, an org's scan requirements, or anything else that lives server-side. Two things follow, and both are load-bearing:

```text
1. The FIXED estate-imposed gates the canonical journey (D21/D22) always applies — the registry
   scan + origin signature, the commander's per-crossing signature, the build's own unit gate —
   are DOCUMENTED FACTS about how this platform's build/promotion path works, not something a
   manifest could ever carry (D22's build order runs entirely inside the team's own build
   workflow, before SCP ever sees the artifact). Render states them explicitly, every time, for
   every build-family pipeline, so the picture is never just "what this team happened to type".
2. Beyond that fixed set, render CANNOT know what a domain's binding policy or an org's own
   additional scan/security rules require — that is real information this view does not have.
   `MANIFEST_ONLY_DISCLAIMER` says so, in the output, every time — an honest boundary line
   rather than a picture that LOOKS complete and silently isn't (D21(d)'s literal test).
```

### §312. Kinds `PLACEMENT_MATRIX` (`infra.ts`) ever gives a non-empty row

Kinds `PLACEMENT_MATRIX` (`infra.ts`) ever gives a non-empty row — i.e. kinds that cross a CDS boundary on their way to a real deploy target, as opposed to publish-only artifacts. Duplicated as a literal (not imported from `infra.ts`) on purpose: `render.ts` only needs the KIND names, not the compatibility matrix itself, and importing `infra.ts` here would pull `@scp/schemas`'s `InfraKind` type into a module whose whole job is staying a thin, manifest-only reader.

### §313. Renders ONE pipeline's picture, pure

Renders ONE pipeline's picture, pure — the body of the generated block. `componentUrn`/`kind` identify which `releases_via` relationship this is for (a manifest may declare several pipelines, one per `releases_via` edge — image + infrastructure sharing a repo is the worked example's own shape); the topology object it points to carries the waves.

### §314. The full generated section

The full generated section — every pipeline's block, the honesty disclaimer, wrapped once in the BEGIN/END markers `updateGeneratedSection` looks for. This is what `--write` inserts and what plain `scp iac render` prints to stdout, so the two are always byte-identical modulo where they land (drift-check: running `--write` twice on an unchanged manifest is a no-op diff).

### §315. `--write`'s pure string surgery

`--write`'s pure string surgery: replaces the marked generated section in `existingSource` with `generatedSection`, or APPENDS it (with a blank-line separator) when no marker is present yet — the first run against a hand-authored file. Idempotent: calling this twice in a row with the same `generatedSection` on its own output is a no-op, which is what makes `scp iac render --write` a meaningful CI drift check (regenerate, then `git diff --exit-code`).

## `packages/coordination-as-code/src/scaffold.ts`

### §316. Scaffold grouping: the pure decision behind the command

SCAFFOLD GROUPING — the pure decision behind `scp iac scaffold` and the `/connect` wizards (ADR-0047; team-pipeline-iac section 7).

MOVED HERE FROM `@scp/cli` when the wizards became scaffolder UI. It was always pure — no SDK calls, no I/O — and it has two consumers now: the CLI, which writes the emitted code to disk, and the web wizard, which shows it for a human to commit. A second copy in the browser would be a second definition of "which components are ungrouped", and the whole point of ADR-0047 is that the ungrouped set is surfaced rather than defaulted. One definition, two callers.

### §317. Groups a `discovery run` proposal's components into services

Groups a `discovery run` proposal's components into services (ADR-0047: "the orphan problem is solved at authoring time, where a human is present") — PURE, no SDK calls; `group` is the CLI's `--group <name>=<service>` flags collapsed to a lookup table. Every discovered `component` object either lands in exactly one returned `ServiceSpec`, or is reported in `ungrouped` — never both, and never silently dropped.

## `packages/coordination-as-code/src/urn.ts`

### §318. Tiny vendored copy of `apps/server/src/graph/urn.ts`'s `slugify`

Tiny vendored copy of `apps/server/src/graph/urn.ts`'s `slugify` — `@scp/coordination-as-code` must not depend on `@scp/server` (synth is pure and must work fully offline, including in CI/air-gap contexts with no server checked out — goal statement), and `@scp/schemas` doesn't export a reusable slugify/URN helper (checked `packages/schemas/src/index.ts`'s exports first). Duplicated on purpose rather than imported; keep in sync with the server's version if its algorithm ever changes (unlikely — pure string logic, no external behavior to drift from).

### §319. The deterministic urn for a construct without an explicit one

Deterministic URN for a construct that doesn't specify an explicit `urn` prop, derived from `(stack name, construct id)` ONLY (goal statement) — stable across repeated synths and independent of construction order, which is exactly what lets two independently-built-but- equivalent construct trees converge to byte-identical manifests.

Deliberately a DIFFERENT scheme from the server's `deriveUrn` (graph/urn.ts, keyed by `orgId`/name and used only when the generic API creates an object without an explicit `urn`): synth is pure and offline, so it has no `orgId` to key off — it never calls the API (goal statement). Using the stack name as the URN's "namespace" segment instead gives IaC-synthesized URNs their own stable, collision-resistant, synth-time-computable identity; the org segment of `UrnSchema`'s regex just needs to be SOME lowercase-alnum-dash token, not literally the real org id — the server never re-derives or re-validates this segment's meaning, URNs are opaque stable keys past that point (DESIGN.md §4.1).

## `packages/coordination-as-code/src/waves.ts`

### §320. Wave-organization guidance (team-pipeline-iac.md §8, D6 vocabulary)

Wave-organization guidance (team-pipeline-iac.md §8, D6 vocabulary) — the friendlier authoring shape a `Pipeline`'s `waves` prop accepts, and the three helpers (`linear`/`widening`/`byDomain`) that build it. `docs/guides/organizing-waves.md` is the prose companion to this file; keep the two in sync if the shape here changes.

`staging`/`production` vocabulary throughout (D6/D21e) — never `gamma`, never bare `prod`.

### §321. One wave, in the relaxed shape a pipeline's `waves` prop accepts

One wave, in the relaxed shape a pipeline's `waves` prop accepts (team-pipeline-iac-examples.md §5's `waves.standard`): - a bare target — a single-member wave (`"commercial-amer-production"`); - a bare array of targets — a single unnamed PARALLEL wave (`[a, b, c]`); - an object — full control over `name`/`mode`/`requiresFanIn`.

A pipeline's synth normalizes every item to a `ReleaseTopologyWaveSpec` (`construct.ts`): an unnamed item gets `wave${index + 1}` (1-based, by POSITION — the same numbering regardless of whether earlier waves were named, so `[{name:"staging",...}, x, [a,b]]` names its third item `wave3`, matching the worked example's synth output), and `mode` defaults to `"parallel"` unless given.

### §322. Normalizes a `WaveItem[]`

Normalizes a `WaveItem[]` (what a pipeline's `waves` prop and every `waves.*` helper below produce) into the `ReleaseTopologyWaveSpec[]` `ReleaseTopology`'s constructor already accepts (round A, `construct.ts`). Exported so `pipeline.ts` (which embeds this into a component's release-topology object) and tests share one normalization instead of two.

### §323. A straight sequence of stages, one wave each

`waves.linear(stages)` — a straight sequence of stages, one wave each, in the given order (`staging → production`). Each element may itself be a group (an array) for a stage that fans out to several targets at once while still being ONE step in the sequence — `linear` does not merge or reorder; it is a typed pass-through so a program reads "this is the ordered stage list" at the call site rather than an unlabeled array literal.

### §324. `waves.widening(targets, { start, factor })`

`waves.widening(targets, { start, factor })` — buckets a flat target list into waves whose size grows geometrically (`1 → 2 → 4 → 8`, D6/§8's canonical production shape), each wave PARALLEL. The final wave holds whatever remains, even if short of the ideal size — this is not padded or refused, since "these targets, sooner" is exactly the point of the tail wave.

### §325. One wave per security-domain group, in the given order

`waves.byDomain(...groups)` — one wave per security-domain group, IN THE GIVEN ORDER (`commercial before govcloud before air-gap`, §8) — the CDS crossing gate applies per crossing, so naming the domain order here is what keeps a later domain from widening ahead of an earlier one that hasn't cleared its own gate. Each group is one PARALLEL wave (targets within a domain release together); the SEQUENCE between groups is what carries the domain ordering.

## `packages/coordination-as-code/vitest.config.ts`

### §326. THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED

THE PER-TEST BUDGET, DECLARED RATHER THAN INHERITED (M23.1f clause 6).

Vitest's implicit default is 5,000ms. `@scp/runner-launcher` ran its unit suite on it while holding the repo's heaviest sweeps and flaked 5 runs in 23 of `pnpm -w test` — never once in 420 isolated runs, because isolation is the wrong load profile: what consumes the headroom is the 109-task parallel graph, not the test. `apps/server` had already raised its own budget for exactly this reason in 2026-08 and the sibling packages were left on the default, which is the incomplete-call-site-census property CLAUDE.md names.

The rule is now machine-checked by `@scp/source-census`'s `test-budget-census.test.ts`: every package whose `test` script is vitest must DECLARE a number, and that number must be one the census table names. This is headroom, not a slow-test licence — a passing test is unaffected by the budget, so the only cost is that a genuinely wedged test takes longer to be declared dead.

### §327. The hook budget: a second deadline nobody chose

THE HOOK BUDGET, declared for the reason `@scp/source-census`'s `test-budget-census.test.ts` gives in full: vitest's `hookTimeout` is a SECOND, independent deadline whose implicit default (10,000ms) nobody chose, and the only hook cost this repo has ever measured under CI's load profile — `@scp/cli`'s lazy-import warm-up — was 5,400ms against it. 30,000 is 25x the isolated worst case in the unit layer (1,205ms) and half the un-declarable 60,000ms `onTaskUpdate` RPC deadline a synchronous hook would otherwise be free to cross.
