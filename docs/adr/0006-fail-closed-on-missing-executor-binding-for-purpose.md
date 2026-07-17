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

`listExecutorBindingsForTarget` shares the same live-target (soft-delete) filter `getExecutorBinding`'s siblings use, so a soft-deleted target's stale binding can never wrongly force a (b) block.

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
