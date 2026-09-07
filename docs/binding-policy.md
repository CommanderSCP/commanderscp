# binding-policy

Long-form reference for the **binding-policy** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 16 of 16 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/binding-policy/lane-storage.integration.test.ts`](#apps-server-src-binding-policy-lane-storage-integration-test-ts) — §1–§1
- [`apps/server/src/binding-policy/placement-needs.ts`](#apps-server-src-binding-policy-placement-needs-ts) — §2–§3
- [`apps/server/src/binding-policy/reconcile-bindings.ts`](#apps-server-src-binding-policy-reconcile-bindings-ts) — §4–§9
- [`apps/server/src/binding-policy/reconciler.integration.test.ts`](#apps-server-src-binding-policy-reconciler-integration-test-ts) — §10–§13
- [`apps/server/src/binding-policy/resolve-bindings.test.ts`](#apps-server-src-binding-policy-resolve-bindings-test-ts) — §14–§14
- [`apps/server/src/binding-policy/resolve-bindings.ts`](#apps-server-src-binding-policy-resolve-bindings-ts) — §15–§16

## `apps/server/src/binding-policy/lane-storage.integration.test.ts`

### §1. THE LANE COLUMN AND THE WIDENED IDENTITY

THE LANE COLUMN AND THE WIDENED IDENTITY (migration 0105; ADR-0046 section 4, resolution 7).

WHAT THIS HAS TO PROVE, and why a "the column stores a value" assertion would not:

1. **The widened key permits what the feature needs** - one target, one Type, TWO lanes. Under the old `UNIQUE (org, target, type)` that write was a constraint violation, so the feature was unrepresentable rather than merely unimplemented. 2. **The lookup FILTERS on lane.** This is the dangerous half. `getExecutorBinding` was a `.limit(1)` over `(org, target, type)`; with two lanes present it returns an ARBITRARY row, so a deploy could be dispatched to the test-lane executor. The bug would be invisible - a binding IS returned, it is simply the wrong one. 3. **The upsert keys on lane**, or writing the test lane destroys the build lane in place - the identical failure this repo's own comment records for Type before P3. 4. **Nothing that existed changes.** Every caller that omits a lane means `build`, and every pre-migration row is in it.

MUTATION LOG - each applied, watched fail, reverted, watched pass (MEASURED) | Mutation | Result |
| `getExecutorBinding` drops its `eq(lane)` filter | 3 FAIL - (1), (2), (3). The unfiltered lookup makes the upsert's existence check wrong too, so the damage is wider than the read path it obviously breaks. | | `upsertExecutorBinding` omits `lane` from its existence lookup | 2 FAIL - (1) and (3). The second lane UPDATES the first row in place instead of inserting: one row where two belong, which is the pre-P3 failure exactly. | | the insert omits `lane`, relying on the column default | 3 FAIL - (1), (2), (3). Both rows land in `build`, so the second collides on the widened key. |

## `apps/server/src/binding-policy/placement-needs.ts`

### §2. Every live placement in the org: unpaginated, unscoped

Every live placement in the org, as (component, target) pairs.

NOT PAGINATED, and not filtered by a readable scope. Both are deliberate and both differ from `listPlacements`, which serves an HTTP list door: this runs as the engine, over the whole domain, and its answer is only correct if it sees ALL of it. A page would silently under-bind, and a readable-scope filter would make the domain's routing depend on some user's permissions.

### §3. Which lanes each component needs resolved

Which lanes each component needs resolved.

`build` ALWAYS; `test` only where the component declares a test hook. That is what keeps an estate with no hooks from being reported as missing a test lane it has no use for — the gap list is only worth reading if everything in it is a real gap.

## `apps/server/src/binding-policy/reconcile-bindings.ts`

### §4. THE DOMAIN-LOCAL BINDING RECONCILER

THE DOMAIN-LOCAL BINDING RECONCILER (ADR-0046 section 4; team-pipeline-iac section 6, D4).

Teams author the WHAT and it federates; each domain authors the HOW once, locally. This loop is the join: it walks the placements visible in this domain, resolves the `executorBinding` policy effects matching each target, and materialises `executor_bindings` rows - so a team never files a per-outpost binding ticket and credentials never leave the domain that owns them.

The DECISION is `resolve-bindings.ts` (pure, unit-tested). This file is the impure half: gather, write, prune, report.

WHAT IT WILL AND WILL NOT TOUCH

It owns exactly the rows it created, identified by `managed_by_policy_id` being non-NULL (migration 0105). A hand-authored binding - which stays legal, e.g. a one-off - carries NULL there and is never updated and never pruned. ADR-0046 section 4 requires that provenance be READ FROM THE ROW rather than inferred from which policy happens to match now, and the difference is not academic: "prune anything no current policy explains" would delete precisely the one-offs an operator cared enough to write by hand.

FALLBACK IS NOT MATERIALISED. A test lane that resolves through the build lane produces NO row - `resolveLaneBinding` does that at read time, once, for every consumer. Writing a duplicate row would double every target's rows and leave two records to keep in step. What the fallback buys here is the absence of a spurious GAP: a domain that never separated lanes is not reported as missing a test lane it does not need.

UNBOUND IS LOUD, AND THAT IS THE POINT (section 14 resolution 2). Gaps are returned, not logged and dropped: an unbound placement FAKE-SUCCEEDS under stage-shaped compilation (ADR-0006 case (a), the post-import hazard), so turning that silence into a reported state is a safety improvement on its own, independent of anything this design adds.

### §5. One reconcile pass for one org

One reconcile pass for one org.

`actorObjectId` is `SYSTEM_ACTOR_ID`: this loop derives rows from a policy an operator already authored under `policy:write`, in the domain that owns the executor. That is NOT the forbidden shortcut ADR-0046 section 1 names - that one is about applying a TEAM'S MANIFEST as the system instead of as the team, which would void the cross-team guarantee. Nothing here writes graph objects on a team's behalf; it writes the domain's own routing rows.

### §6. Remove reconciler-owned rows nothing declares any more

Remove reconciler-owned rows nothing declares any more.

`isNotNull(managedByPolicyId)` is the whole guard: a hand-authored binding is invisible to this query and therefore survives every pass, which is what ADR-0046 section 4 promises. Deleting through `deleteExecutorBinding` rather than a bulk statement is deliberate - it writes the `executor.binding.delete` audit event, and a row disappearing from an operator's estate with no audit trail is precisely the silence this design is trying to remove.

### §7. Executor-binding effects for every target in one call

Every `executorBinding` effect matching each target's own containment chain.

ONE call for every target in the org, not one per target: `matchPoliciesForTargetsByTarget` (`governance/policy-resolve.ts`) runs the org-wide policy scan and the group-ownership resolution ONCE for the whole list and still returns per-target attribution, instead of this loop re-running both for every placement target on every ~1s reconcile tick.

### §8. The reconciler has no acting user

The reconciler has no acting user. Group-scope's ACTING half therefore never fires, and its OWNING half - which does not read the actor at all (ADR-0016 section 2a) - still does. That asymmetry is documented in `subscription-authoring-guard.ts` and is deliberate here too: a binding policy scoped to a group is matched by what that group OWNS, not by who is acting, because nobody is.

### §9. Read DIRECTLY declared edges only

Read DIRECTLY declared edges only. The nearest-rung ladder (ADR-0027/0029) that lets a component inherit a service- or assembly-rung pipeline is resolved at READ time by `binding-resolution.ts`, and duplicating it here would be a second implementation of one walk - the failure mode this repo has hit before. A component with no direct edge contributes no Types and is reported by its absence, never by a guess.

## `apps/server/src/binding-policy/reconciler.integration.test.ts`

### §10. THE DOMAIN-LOCAL BINDING RECONCILER, END TO END

THE DOMAIN-LOCAL BINDING RECONCILER, END TO END (ADR-0046 section 4).

WHAT HAS TO BE TRUE, and none of it is established by "a row appeared":

1. A domain declares its HOW ONCE, as a policy, and the placements a team declared get bound - without the team naming an execution system, which it cannot see. 2. HAND-AUTHORED BINDINGS ARE NEVER TOUCHED. Provenance is read from the row (`managed_by_policy_id`), never inferred from what matches now - so the rule cannot delete the one-offs an operator cared enough to write by hand. 3. PRUNING IS REAL. Remove the placement and the derived row goes; the reconciler owning its rows is what makes that safe. 4. THE FALLBACK IS NOT MATERIALISED. A test lane covered by the build lane produces no second row and no gap - `resolveLaneBinding` does it at read time, once.

MUTATION LOG - each applied, watched fail, reverted, watched pass (MEASURED) | Mutation | Result |
| the prune query drops `isNotNull(managedByPolicyId)` | (2) FAILS - the hand-authored one-off is deleted, which is the outcome ADR-0046 section 4 exists to forbid | | the reconciler MATERIALISES a lane fallback (guard removed) | (4) FAILS - a second, duplicate row appears in the test lane. **SURVIVED the first version of (4)**, which declared no test hook: `listHookLanes` then returns `["build"]` only, the resolver never resolves a test lane, and the guard is never reached. The hook is what makes the case exercise the property. | | the prune never removes anything | (3) FAILS - the derived row outlives the placement that explained it | | `resolveLaneBinding` stops falling back | (4) FAILS - a declared test hook has no reachable executor even though the build lane covers it | | **the call is deleted from `reconcileOrgTick`** | (5) FAILS **and the other four stay green** - which is the whole reason (5) exists. Cases (1)-(4) call the reconciler directly, so they cannot tell a wired loop from an unwired one, and "built, tested, called by nobody" is this repo's named dominant failure. |

### §11. Delete the wiring and watch a test fail: the only proof

THE ONLY CHECK THAT WORKS FOR "installed" IS DELETING THE WIRING AND WATCHING A TEST FAIL. Every other case in this file calls `reconcileExecutorBindingsForOrg` directly, so all four stay green with the loop wired to nothing — which is this repo's named dominant failure (built, tested, and called by no one). Measured: with the try/catch block removed from `reconcileOrgTick`, this case fails and the other four do not.

### §12. One policy match per org-tick, not one per target

b5-perf: `gatherContributions` batched to ONE `matchPoliciesForTargets` call per org-tick instead of one per target (`governance/policy-resolve.ts`'s `matchPoliciesForTargetsByTarget`).

A dedicated org and describe block, not a case tacked onto the suite above: an ORG-WIDE (unscoped) policy is declared here on purpose, and every existing target in a shared org would pick up a second contribution from it — this isolates that blast radius from the suite whose assertions above depend on a target having EXACTLY the contribution its own test declared.

### §13. Unscoped: a shared dedup key would unbind a target

UNSCOPED — matches at every target's org root, so t1's and t2's chains resolve to the SAME matched-ancestor object id (the org root). A shared, cross-target dedup key (`${policyId}::${matchedAncestorObjectId}`) would keep only ONE of the two contributions, silently unbinding whichever target lost the race — this is the exact hazard `matchPoliciesForTargetsByTarget`'s per-target dedup exists to close.

## `apps/server/src/binding-policy/resolve-bindings.test.ts`

### §14. THE DOMAIN RECONCILER'S DECISION

THE DOMAIN RECONCILER'S DECISION (ADR-0046 section 4).

Every case here is about a REFUSAL TO GUESS. The happy path - one policy, one target, one binding - is the least interesting property in the file, because it is the one a wrong implementation also gets right.

MUTATION LOG - each applied, watched fail, reverted, watched pass (MEASURED) | Mutation | Result (MEASURED) |
| a same-depth tie picks the lowest policy id instead of reporting ambiguity | 2 FAIL - (3) and (5c). A binding appears where none should, and the operator never learns they wrote two policies. | | `resolveLane` takes the MAX depth instead of the MIN | (2) FAILS - the domain-wide default beats the per-target override, i.e. the ladder inverts. | | the test lane falls back on AMBIGUOUS as well as on absent | (5c) FAILS - the conflict is silently resolved in favour of a declaration nobody made for that lane. | | `laneOf` returns "test" for an absent lane | 8 FAIL - every pre-lane document changes meaning, which is the blast radius that makes this one line worth a case of its own. |

Case (1) - no policy means UNBOUND - has no mutation because its failure mode is an ADDITION: an org-tier default would have to be written in, not removed. It is pinned as an exact-equality assertion on both `bindings` and `gaps` so a default appearing anywhere fails it.

## `apps/server/src/binding-policy/resolve-bindings.ts`

### §15. THE DOMAIN RECONCILER'S DECISION

THE DOMAIN RECONCILER'S DECISION (ADR-0046 section 4; team-pipeline-iac section 6, D4, and section 14 resolutions 2 and 7) - given the placements visible in this domain and the `executorBinding` effects matching each target, decide which `executor_bindings` rows should exist, and which placements are UNBOUND.

PURE. No database, no I/O. The impure half - reading placements, matching policies against each target's containment chain, writing rows - belongs to the reconciler loop; this is the decision it carries out, so the rules below are unit-testable without a container.

THREE RULES, EACH A REFUSAL TO GUESS

1. NEAREST RUNG WINS. A policy matched at the target itself beats one matched at its container, which beats one at the domain - the same depth ordering the rest of the governance machinery uses (`MatchedPolicy.matchedAt.depth`). That is what lets a domain declare one broad default and override it for a single cluster.

2. A TIE IS AMBIGUOUS, NOT A COIN FLIP. Two policies at the SAME depth naming DIFFERENT execution systems for one (target, Type, lane) is a state no rule can adjudicate: unlike a constraint there is no "more restrictive" answer - one of them is simply going to run the work. Picking the lower id would be reproducible and still wrong, and the operator would never learn they had written two. So it is reported, and NOTHING is bound - failing closed exactly as `registration-match.ts` does when two config sources match one repo.

```text
 Two policies at one depth naming the SAME system are not a tie. They agree, and agreeing twice
 is not a conflict.
```

3. NO ORG-TIER FALLBACK. A (target, Type) nothing matches is UNBOUND and reported (res 2). There is deliberately no default executor: a silent default is how an unbound placement FAKE-SUCCEEDS today (ADR-0006 case (a), the post-import hazard), and turning that silence into a reported state is half the reason this reconciler is worth building.

THE TEST LANE FALLS BACK; IT DOES NOT DEFAULT (resolution 7)

A `test` lane request with no `test` declaration resolves to the BUILD lane's answer, and the result says so (`viaLaneFallback`). That is a real declaration someone wrote, attributable to a policy - not an invented default. A domain that never separates lanes behaves exactly as it does today; one that does gets separation from a single extra policy line. If the build lane is itself unbound, the test lane is unbound too: fallback cannot manufacture an answer that does not exist.

### §16. Resolve every placement's bindings

Resolve every placement's bindings.

`contributionsByTarget` carries the effects that matched EACH target's own containment chain, so this function never has to know how policy matching works.
