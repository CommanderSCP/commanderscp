# iac

Reference for `packages/schemas/src/iac.ts`. The source carries a one-line headline at each site and points here.

> Partial: 8 of 30 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. ROLE BINDINGS AND CUSTOM ROLES IN A MANIFEST

ROLE BINDINGS AND CUSTOM ROLES IN A MANIFEST (role-model.md — the IaC rung of principle 3)

WHAT IS DELIBERATELY NOT EXPRESSIBLE: a binding whose subject is a `group` or `team`.

D7 requires the granter to acknowledge every principal a group binding empowers, compared by SET EQUALITY at the door. In a manifest that value is a MEMBERSHIP SNAPSHOT and it goes stale the moment anyone joins or leaves. The failure is not that the snapshot is wrong — it is that a stale-snapshot refusal TRAINS the author to stop reading it: they paste whatever the last error said, and a control whose whole purpose is that a human looks at the current set becomes a checksum updated mechanically. So the construct refuses a group subject at SYNTH, and the operator uses `scp role-binding grant-preview` + `create`, where the set is read at the moment of granting.

WHO APPLIES MATTERS, AND IS NOT SPECIAL-CASED. The no-escalation subset rule (`authz/role-binding-door.ts`) is evaluated against the APPLYING principal, which for a config-source sync is the TEAM object (ADR-0046 §1 / D9). A team whose repo declares a binding must therefore already hold every permission that role carries at that scope — so a team's own repo cannot bootstrap that team's permissions. That is the rule working, not a gap: authority must not be conferrable by someone who lacks it, and "the applying identity is a team" does not change the argument.

## §2. One `source_mappings` row's verdict

One `source_mappings` row's verdict. Identity is the whole tuple (see `ManifestSourceMappingSchema`), so a changed TUPLE surfaces as a delete plus a create — the same identity-only treatment `PlanRelationshipDiffEntrySchema` gets, for the same reason. `update` (§10.6, additive — a response enum gaining a member) is the verdict for an existing tuple whose declared `scope` differs from the manifest's: scope is an attribute of the row, not part of its identity, so it converges IN PLACE (apply sets it on every row matching the tuple) rather than by re-creating a live route. `classification`/`mirrorOfShared`/`enabled` are NOT converged this way today (a differing value still reads `noop`) — pre-existing, and left as is here on purpose: `enabled` is an enforcement input a hand-set pause must survive an apply of a manifest that omits it, and the other two have no "omitted ⇒ unmanaged" reading yet. `repoPattern`/`pathPattern`/`type` are normalized here (null / the `configuration` default) so the entry the operator reviews shows exactly the row that will be written, not the author's shorthand.

## §3. One `pipeline_hooks` row's verdict (D11/D21)

One `pipeline_hooks` row's verdict (D11/D21). No `update`, and the reason is the one `PlanPlacementDiffEntrySchema` gives rather than the one `PlanSourceMappingDiffEntrySchema` gives: a hook has no attribute that converges in place. The DECLARATION is what the diff keys on — identity `(componentUrn, kind, hookId)` PLUS the payload beside it — so a hook whose `stage` or `maxAgeSeconds` moved surfaces as a `delete` line and a `create` line, exactly as `ManifestPipelineHookSchema` says it must. Both lines are shown; nothing about a gate changes without an entry the reviewer can read.

`kind` is the DISCRIMINANT every entry in this file carries, so the hook's OWN kind is `hookKind`. Two fields named `kind` on one object is how a reviewer reads the wrong one.

The per-kind fields are all nullable because the four kinds carry different ones (the table's own shape, migration 0096) — a `postMerge` entry has no `stage`, a `bakeAlarms` entry no `workflow`. They are on the ENTRY and not hidden behind a `target` object because they ARE the gate: a plan that pruned a `postDeploy` hook without showing which stage it gated is a prune the operator cannot check, and the whole reason this collection diverges from the prune-on-absent rule is that a disarmed gate announces itself only by an absence.

## §4. D12 — one rollout declaration's diff entry

D12 — one rollout declaration's diff entry.

ORDINARY PRUNE RULE, unlike the hook entry above it: an absent `rollouts` collection means the stack declares none and prunes the ones it owns. That asymmetry is the contract's and is deliberate — an omitted hook DISARMS A GATE (symptom: an absence of refusals), while an omitted rollout costs a declared strategy, which is visible the next time anything deploys.

## §5. One role binding's diff entry

One role binding's diff entry.

NO `update` ACTION, deliberately. A binding's identity is the WHOLE of it — `(subjectUrn, roleName, scopeUrn)` is the same triple `role_bindings_grant_key` makes unique, and `reason` is not stored on the row. So there is nothing a binding can change INTO; a different grant is a different binding, and the plan shows a delete beside a create rather than an "update" that would hide which authority went away.

⚠️ A `delete` HERE REVOKES A PERSON'S ACCESS, which is what makes this collection unlike every other prunable one. The plan line is the review surface for that, so it names the subject and the role rather than an opaque id.

## §6. Producer declarations (ADR-0032 §7e)

Producer declarations (ADR-0032 §7e). OPTIONAL FOR A SECOND REASON ON TOP OF THE PRE-C1 ONE, and the second reason is load-bearing: this key is ABSENT — not `[]` — whenever the manifest omitted its own `producers` collection, because absent there means UNMANAGED (`DesiredStateManifestSchema.producers`). So the stored plan itself records "this stack manages no producer declarations", and an operator reading the plan can tell that apart from "this stack manages them and has nothing to change". An empty array means the latter.

## §7. `governance:move` rungs (ADR-0038 §2)

`governance:move` rungs (ADR-0038 §2). OPTIONAL FOR THE SAME TWO REASONS `producers` is, and the second one is load-bearing in the same way: this key is ABSENT — not `[]` — whenever the manifest omitted its own `governanceMoveRungs` collection, because absent there means UNMANAGED. The stored plan therefore records "this stack manages no rungs", which an operator can tell apart from "this stack manages them and has nothing to change" (an empty array).

## §8. Pipeline test/bake hooks (D11/D21)

Pipeline test/bake hooks (D11/D21). OPTIONAL FOR THE SAME TWO REASONS `producers` is, and the second one is load-bearing in the same way: this key is ABSENT — not `[]` — whenever the manifest omitted its own `pipelineHooks` collection, because absent there means UNMANAGED. The stored plan therefore records "this stack manages no hooks", which an operator can tell apart from "this stack manages them and has nothing to change" (an empty array). The third of the three collections that diverge; `rollouts` and `convergence` deliberately do not, and are not projected here at all yet.
