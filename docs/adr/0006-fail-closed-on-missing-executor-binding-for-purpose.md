# ADR 0006 — Fail-closed on a missing executor binding for a target's purpose

**Status:** Accepted (owner decision in chat, 2026-07-17)
**Relates to:** [charter principle 1](../../PROJECT_CHARTER.md) (coordinate, not execute), [charter principle 6](../../PROJECT_CHARTER.md) (explainability & auditability — every blocked response carries a `decision_id`), [ADR-0002](0002-execution-strategy.md) (execution strategy / managed-exec), the M12 purpose model (bindings gained an `infra`/`software` purpose — `apps/server/src/coordination/executor-bindings-repo.ts`, migrations 0023/0024), the shared fake-executor fallback (`apps/server/src/coordination/executor-config.ts`).

## Context

M12 P3/P4A made an executor binding *purpose-scoped*: a Component/DeploymentTarget can hold both an `infra` binding and a `software` binding, and a change wave carries the `purpose` it rolls (snapshotted at plan time from the source mapping that matched the release). Reconcile resolves the binding to trigger with `getExecutorBinding(target, purpose)`.

When no binding matches, reconcile fell through to a single hardcoded shared **fake** executor instance (`executor-config.ts`) and the wave target **fake-succeeded as a no-op** — no Decision, no audit event, no distinct state. That fallback exists for a good reason (M0–M6 and every demo/rehearsal target relies on it), but it is applied indiscriminately, and that is charter-wrong for one of two populations a missing-binding lookup actually covers:

- **(a) INTENDED-FAKE** — the target has **zero** executor bindings. The fake executor genuinely *is* its configured executor (rehearsal/demo/test). Fake-succeeding is correct.
- **(b) MASKING-GAP** — the target has **≥1 real binding** but **none for the purpose being triggered** (e.g. a component with only a `software` binding receiving an `infra` release, most naturally from a source-mapped infra push). Here fake-success silently **greens a misconfiguration**: it violates principle 1 (the platform pretends it executed against a real system it never touched) and principle 6 (a blocked/undeliverable outcome with no `decision_id`, no audit trail, no queryable state).

The API read-path already models (b) as an error — `PUT/GET .../binding` returns 404 "no binding for this purpose" (`binding-purpose.integration.test.ts`). Reconcile was the one path that swallowed it.

## Decision

Disambiguate (a) from (b) **inside `triggerWaveTarget`, before any executor is started or `trigger()` is called**, keyed on the **resolved** purpose reconcile actually triggers (unrecognised purpose values are already normalised to `software` upstream by the plan/propose path; we key on the normalised value, not the raw wave-target string):

1. `getExecutorBinding(target, purpose)` matches → **normal coordinate path**, unchanged.
2. No match, and `listExecutorBindingsForTarget(target)` is **empty** → **(a) intended-fake** → fall through to the shared fake fallback, **unchanged**.
3. No match, but the target has **other** bindings → **(b) masking-gap** → **fail closed**:
   - Emit a `block` **Decision** (with `decision_id`) naming the gap: `requestedPurpose`, `boundPurposes`, and a remediation string.
   - Write the **hash-chained audit event** (`change.wave_target.no_executor`, carrying the `decision_id`) in the same transaction.
   - Terminalize the wave target on a **new dedicated status `no_executor`** — deliberately **not** `failed`, so `scp change explain`/the UI can name the actual cause. This mirrors `campaign_waves`' purpose-built `blocked` status.
   - Mark the wave `failed` and **park the change** via the existing reconcile-blocked mechanism (`markChangeReconcileBlocked` / `reconcile_blocked_at`). The change stays `executing`, parked, awaiting manual remediation: bind the missing purpose, then cancel/rollback/re-propose. No new change-lifecycle state is introduced.

Only `listExecutorBindingsForTarget` applies the live-target (soft-delete) filter — `getExecutorBinding` itself does not. That asymmetry, plus the check order, is what makes the boundary safe: a live target with a matching-purpose binding is caught by the permissive `getExecutorBinding` first (normal path), while a soft-deleted target yields **zero** rows from `listExecutorBindingsForTarget` and therefore falls to case (a) fake — so a stale binding on a deleted target can never wrongly force a (b) block.

**Idempotent.** `markWaveTargetNoExecutor` is guarded on `status IN ('pending','triggering')` with `RETURNING`; the Decision + audit event are emitted only when it flips the row. A later reconcile tick that finds the target already `no_executor` appends nothing to the audit chain. (Parking also excludes the change from subsequent sweeps, so in practice the block runs once; the status guard is the durable backstop.)

### Scope (deliberately narrow — implement exactly this)

- **TARGET-LOCAL resolution only.** No component→service/deployment-target walk-up. Resolving a target's purpose against a service- or deployment-target-level binding is **separate future M12 work** and is intentionally out of scope here.
- **The Decision NAMES the gap only.** It does **not** auto-offer the `scp-managed-iac` executor. Per the charter, managed execution is never a default; offering it automatically on any unbound-for-purpose target would make it one. Managed-exec (ADR-0002 Mode 2) is a *possible future* remediation an operator may choose explicitly — noted here, not wired.

### Schema / API impact

`change_wave_targets.status` is a plain `text` column (no Postgres ENUM, no CHECK constraint), so `no_executor` is storable with **no migration**. The read schema `ChangeWaveTargetSchema.status` is already `z.string()`, so exposing the new value is **API-additive** within `/v1` (no request-enum touched; oasdiff gate passes) and requires **no codegen change**.

## Consequences

- A source-event infra push (or any release) against a target that has real bindings but none for that purpose now **blocks loudly and parks a change** instead of fake-greening. Operators get a `decision_id`, an audit event, and a distinct `no_executor` terminal to act on — the misconfiguration is *detected*, not hidden.
- Rehearsal/demo/test targets with zero bindings are **unchanged**; a boundary-pin test guards against a future refactor collapsing (a) into (b).
- Because the block parks the change directly (rather than routing through the failed-wave path), no auto-rollback of an un-runnable pipeline is attempted — a rollback would only hit the same gap. Remediation is manual by design.
- The new `no_executor` status is terminal-for-reconcile: the target is never re-triggered (which would duplicate the Decision/audit), and it counts as a wave failure.

### Follow-ups (out of scope here)

- Service-level / deployment-target-level binding walk-up (future M12).
- An explicit operator opt-in to remediate a `no_executor` gap with the managed-iac executor (ADR-0002 Mode 2), if ever wanted — never a default.

---

## Amendment (2026-08-02) — placement-aware resolution, and a fourth case

**Status of the original decision: unchanged.** Cases (a) and (b) mean exactly what they meant, and
the boundary-pin test that guards (a) from collapsing into (b) still guards it. What changes is
*where resolution looks* before it concludes "no binding", and the addition of one new refusal.

**Why.** [ADR-0026](0026-placements-and-derived-stage-names.md) made the `(component × place)` pair a
first-class `placement`, and an executor binding attaches to the pair. Migrating the estate therefore
means moving bindings from components onto placements — but a wave target is a **component** under
legacy compilation and a **placement** only under stage-shaped compilation. Moving a binding while
compilation is still legacy leaves the component with **zero** bindings, and case (a) reads zero as
intended-fake: every wave target would fake-succeed. Green reports, nothing deployed — precisely the
masking failure this ADR exists to prevent, reintroduced through the migration rather than through a
code change.

The ordering is circular as the migration was originally written: bindings cannot move until
compilation is stage-shaped, compilation cannot go stage-shaped until a topology is attached, and
attaching one fails loudly for anything unplaced. Placement-aware resolution breaks the cycle by
making each step independently safe.

### What resolution now does

`coordination/binding-resolution.ts`'s `resolveBindingForTarget` replaces the bare
`getExecutorBinding` at the **read/resolve** sites. **Direct is always checked first**, so nothing
that resolves today changes answer:

1. the target itself carries a binding of this type → **direct**, unchanged;
2. otherwise, if the target is a component with **exactly one** placement carrying one → **via
   placement**, resolve it;
3. **two or more placements carry one → (d) AMBIGUOUS PLACEMENT → fail closed.**

### (d) is a new population, not a variant of (b)

(b) is *"bound, but not for this pipeline"*. (d) is *"bound for this pipeline in more than one
**place**, and the wave target does not say which"* — and the honest answer is that a component alone
**cannot** answer it. That is the entire reason the placement type exists: "which Argo CD" is a
function of *where*. Choosing arbitrarily would reintroduce the cross-product bug ADR-0026 was written
to kill, silently and in a new place.

It gets its own audit action (`change.wave_target.ambiguous_placement_binding`), its own gate label
(`ambiguous_placement_binding`), and a Decision that **names every competing placement** — because
the remediation is not "add a binding", it is "make the wave target a placement", i.e. attach a
stage-shaped topology. The state is reachable the moment an env-suffixed pair is merged: the survivor
gets two placements, which is exactly when stage-shaped compilation must take over.

### (a) had to look further to keep meaning the same

Case (a) is *"nothing anywhere"*. Once a binding can live on a placement, "anywhere" must include
placements, so the (a)/(b) discrimination now reads `listVisibleBindingsForTarget` — the target's own
bindings **plus its placements'**. Reading only the target's own would let a component whose
`configuration` binding had moved to its placement, receiving an `image` release, look like
zero-bindings and fake-succeed: case (b) wearing case (a)'s clothes. This is a change of *reach*, not
of *rule*.

### Where the fallback is, and where it deliberately is not

A filterless census found 9 non-test `getExecutorBinding` call sites across 5 files. The fallback was
applied to the 6 that ask *"what will drive this target?"* and withheld from the 3 that ask *"what row
is on this object?"*:

| Applied | Withheld |
|---|---|
| `reconcile.ts` gap analysis | `executor-bindings-repo.ts` `putExecutorBinding` existence check |
| `reconcile.ts` trigger (externalRef) | `setExecutorBindingType` from-lookup |
| `reconcile.ts` `ensureExecutorInstanceStarted` | `setExecutorBindingType` to-clash lookup |
| `regional-executors.ts` deploy gate (membership hop) | |
| `routes/executors.ts` `GET .../binding` | |
| (`resolveExecutorPluginInstance` reached via the resolved carrier) | |

The three withheld are **write** paths where a fallback would be actively wrong: an upsert that
"found" a placement's binding would update the wrong row, and a relabel would report a clash against a
binding on a different object. Applying it uniformly is the failure mode this table exists to prevent.

### One thing this amendment fixes that was not asked for

`evaluateRegionalDeployGate` resolved region membership by requiring the wave target to be a
`deployment-target`. Under stage-shaped compilation a wave target is a **placement**, which carries no
`environment`/`region` of its own — so the M15.6 silent-region-deploy gate (case (c)) would have
**silently stopped firing**, quietly becoming case (a). The gate now hops a placement to the
deployment-target it names for the *membership* question, while still resolving the *binding* against
the wave target itself. Not reachable on the estate today (no placement names a region target), which
is exactly why it would have gone unnoticed until the first regional stage rollout.
