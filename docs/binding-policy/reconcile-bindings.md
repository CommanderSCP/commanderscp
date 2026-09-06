# reconcile-bindings

Reference for `apps/server/src/binding-policy/reconcile-bindings.ts`. The source carries a one-line headline at each site and points here.

> Partial: 4 of 6 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. THE DOMAIN-LOCAL BINDING RECONCILER

THE DOMAIN-LOCAL BINDING RECONCILER (ADR-0046 section 4; team-pipeline-iac section 6, D4).

Teams author the WHAT and it federates; each domain authors the HOW once, locally. This loop is the join: it walks the placements visible in this domain, resolves the `executorBinding` policy effects matching each target, and materialises `executor_bindings` rows - so a team never files a per-outpost binding ticket and credentials never leave the domain that owns them.

The DECISION is `resolve-bindings.ts` (pure, unit-tested). This file is the impure half: gather, write, prune, report.

WHAT IT WILL AND WILL NOT TOUCH

It owns exactly the rows it created, identified by `managed_by_policy_id` being non-NULL (migration 0105). A hand-authored binding - which stays legal, e.g. a one-off - carries NULL there and is never updated and never pruned. ADR-0046 section 4 requires that provenance be READ FROM THE ROW rather than inferred from which policy happens to match now, and the difference is not academic: "prune anything no current policy explains" would delete precisely the one-offs an operator cared enough to write by hand.

FALLBACK IS NOT MATERIALISED. A test lane that resolves through the build lane produces NO row - `resolveLaneBinding` does that at read time, once, for every consumer. Writing a duplicate row would double every target's rows and leave two records to keep in step. What the fallback buys here is the absence of a spurious GAP: a domain that never separated lanes is not reported as missing a test lane it does not need.

UNBOUND IS LOUD, AND THAT IS THE POINT (section 14 resolution 2). Gaps are returned, not logged and dropped: an unbound placement FAKE-SUCCEEDS under stage-shaped compilation (ADR-0006 case (a), the post-import hazard), so turning that silence into a reported state is a safety improvement on its own, independent of anything this design adds.

## §2. One reconcile pass for one org

One reconcile pass for one org.

`actorObjectId` is `SYSTEM_ACTOR_ID`: this loop derives rows from a policy an operator already authored under `policy:write`, in the domain that owns the executor. That is NOT the forbidden shortcut ADR-0046 section 1 names - that one is about applying a TEAM'S MANIFEST as the system instead of as the team, which would void the cross-team guarantee. Nothing here writes graph objects on a team's behalf; it writes the domain's own routing rows.

## §3. The reconciler has no acting user

The reconciler has no acting user. Group-scope's ACTING half therefore never fires, and its OWNING half - which does not read the actor at all (ADR-0016 section 2a) - still does. That asymmetry is documented in `subscription-authoring-guard.ts` and is deliberate here too: a binding policy scoped to a group is matched by what that group OWNS, not by who is acting, because nobody is.

## §4. Read DIRECTLY declared edges only

Read DIRECTLY declared edges only. The nearest-rung ladder (ADR-0027/0029) that lets a component inherit a service- or assembly-rung pipeline is resolved at READ time by `binding-resolution.ts`, and duplicating it here would be a second implementation of one walk - the failure mode this repo has hit before. A component with no direct edge contributes no Types and is reported by its absence, never by a guess.
