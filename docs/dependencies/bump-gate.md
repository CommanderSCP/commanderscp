# bump-gate

Reference for `apps/server/src/dependencies/bump-gate.ts`. The source carries a one-line headline at each site and points here.

> Partial: 5 of 12 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. Run ONE queued job

Run ONE queued job. Exported so an integration test drives the exact function the worker runs.

PHASES, and the split is the one ADR-0032 §7c clause 2 established: read in a transaction, do provider I/O OUTSIDE any transaction, write in a transaction. The governance prewarm is the exception and it is the SHIPPED exception — `coordination/reconcile.ts` calls it inside a transaction too, because `ensureControlRun` writes its `control_runs` row in the same transaction that decided it, which is what makes a control outcome a durable historical fact rather than something a crash can lose after the external call was already made.

## §2. ASKED, NOT ASSUMED

ASKED, NOT ASSUMED — and asked with the ref the plugin ITSELF returned rather than one this file recomposed from the idempotency key. `trigger()` returns the run ref, this class runs synchronously to completion, so `status()` is the honest record of whether the merge HAPPENED rather than of whether a dispatch was made. A provider refusal (branch protection, a required review, a check that went red since the gate) is a `failed` phase with the reason in `detail`.

## §3. A THROW HERE USED TO LEAVE NO DECISION AT ALL

A THROW HERE USED TO LEAVE NO DECISION AT ALL — the one class of merge refusal where charter principle 6's "every blocked response carries a `decision_id`" was not honoured. The reachable causes are ordinary: the runner image is not configured on this deployment, the binding cannot be resolved, the plugin host is unreachable. Nothing merged, and an operator must be able to see why from the same place every other refusal is recorded.

## §4. THE MERGE HAPPENED

THE MERGE HAPPENED — record that BEFORE the Decision, because it is what stops the merge's own provider events from re-running this job and overwriting the verdict below with a refusal. A crash between the two leaves the merge stamped and the Decision missing, which is the recoverable direction: the next observed event returns "already merged" and writes nothing, rather than writing "not merged" about a merge that happened.

## §5. Register the capability's worker

Register the capability's worker. The ROUTER is registered separately, by `events/domain-event-registry.ts` under the SAME guard as the dispatcher's, and a refused guard contributes no router — so an event is not even enqueued for a queue nothing will drain.

A REFUSED ROLE RETURNS AN INERT HANDLE AND NEVER CREATES THE QUEUE, the same shape every other background loop uses and for the same reason: a process that merely skipped the work inside the handler would still hold a worker for a queue it will never act on.
