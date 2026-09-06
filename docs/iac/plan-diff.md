# plan-diff

Reference for `apps/server/src/iac/plan-diff.ts`. The source carries a one-line headline at each site and points here.

> Partial: 5 of 45 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. A declared pipeline hook (D11/D21, migration 0096)

A declared pipeline hook (D11/D21, migration 0096). IDENTITY is `(componentUrn, hookKind, hookId)` — the table's own `pipeline_hooks_identity` — but the DIFF keys on the whole declaration (`pipelineHookKey`), because a hook has no attribute that converges in place: a `stage` or `maxAgeSeconds` that moved is a different gate, and `ManifestPipelineHookSchema` states the consequence ("a changed hook is a delete + create").

Every per-kind field is NORMALIZED to `null` here rather than left `undefined`, so the ACTUAL side (rows read back from a table whose per-kind columns are nullable) and the DESIRED side (a discriminated union whose members simply lack the fields they do not use) key identically. Without that, a `postMerge` hook would key one way from the manifest and another from the database and every plan would propose a delete plus a create for a hook that never changed.

## §2. HERE, AND ONLY HERE, ABSENT AND EMPTY ARE DIFFERENT

HERE, AND ONLY HERE, ABSENT AND EMPTY ARE DIFFERENT — `null` vs `[]`. The type is the ruling.

Read the comment on `sourceMappings` above first: for those three collections absent and empty are the same thing on purpose, and someone already tried to change that and broke three `plans.integration` tests. THIS ONE DIVERGES, by owner ruling (2026-08-17), and the divergence is expressed as `| null` rather than as a boolean flag beside an array precisely so a caller cannot forget to consult it: `computePlanDiff` cannot read the collection without deciding what `null` means.

`null`  = the manifest had NO `producers` key = this stack manages no producer declarations. The prune step is skipped ENTIRELY and no diff entries are emitted at all. `[]`    = the key was present and empty = "I manage producers and declare none" -> prune all.

WHY THE ASYMMETRY IS CORRECT AND MUST SURVIVE THE NEXT SWEEP. For the three above, a prune-on-absent costs a route or a binding that an operator notices immediately. Here it returns a coordinate the org PUBLISHES to a public index on a daily poll timer, and the symptom is an ABSENCE of dependency updates: dependency confusion (ADR-0032 §7b clause 1) re-armed by a stack that merely forgot a key. The consistency argument is real and it loses to that.

THE ACCEPTED COST, stated where it bites: `Stack.synth()` omits an empty collection, so "unmanaged" and "I declare none" are indistinguishable in a SYNTHESIZED manifest, and `@scp/iac` therefore cannot retract a stack's LAST declaration. Use the retract verb (which also reports the bumps already in flight), or hand-author `"producers": []`.

## §3. The fields whose drift makes a binding an `update`

The fields whose drift makes a binding an `update`. MODE-DEPENDENT, and that is load-bearing: for an execution-system-backed binding the module, instance id, config, secret refs and egress allowlist are all SERVER-derived from the system at write time (`bindTargetToExecutionSystem`), so comparing the manifest's (necessarily absent) values against the stored derived ones would make every re-plan an `update` forever — DoD (b)'s "apply the same manifest twice is a no-op" would be false for every Mode A binding. Only what the author actually declares is compared.

## §4. `governance:move` RUNGS (ADR-0038 §2; proposal §9.6 Q4)

`governance:move` RUNGS (ADR-0038 §2; proposal §9.6 Q4). Converge-then-prune like the four above, with the SAME divergence `producers` has and NONE of its additions:

- THE DIVERGENCE: `manifest.governanceMoveRungs === null` (no key) means UNMANAGED. The whole block is skipped — no entries, no prune, and the diff carries no `governanceMoveRungs` key at all, so the stored plan itself records that this stack manages no rungs. - NO `update`: a rung has no value beyond existing (the tier is derived from the subject's type), so the verdicts are enable, disable and "already enabled". - NO transfer case: identity is the SUBJECT, and a rung cannot change hands.

## §5. The pair must ALSO survive this plan

The pair must ALSO survive this plan. Apply runs binding-prune, placement-prune, placement-create, binding-create in that order, so a binding declared on a pair the manifest does not declare would be written onto a placement the SAME apply just pruned — failing at the resolve step, mid-apply, after other writes had landed. Refusing here turns that into a plan-time error naming both halves.
