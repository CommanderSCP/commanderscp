# plan-compiler-stages.test

Reference for `apps/server/src/coordination/plan-compiler-stages.test.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 8 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. The second precision half

The second precision half. The pair IS co-placed — at `staging` — so a check keyed on "do these two share any place at all" refuses. But the topology names only gamma and prod, so `staging` never becomes a wave target, the hold (scoped by a wave target's deployment-target) can never look there, and nothing could ever deadlock. Refusing here would auto-cancel a pipeline that never co-schedules the pair: `compilePlan` -> 400 (`plan-service.ts`) -> `auto-cancelled: plan compilation failed` (`reconcile.ts`).

This is why the refusal is handed the placements the plan actually SCHEDULES rather than every placement of the change's components.

## §2. THE TOMBSTONE WEDGE

THE TOMBSTONE WEDGE. `materialiseStageDependencyEdges` deliberately treats a SOFT-DELETED edge as "already materialised" (a plain UNIQUE key, not a partial index), so an operator's one-off deletion of `api -> db` means that edge is never re-minted. `loadDependsOnEdges` filters on `deleted_at IS NULL`, so the compiler saw only `db -> api` and found no cycle.

The RUNTIME hold does not read edges for this pair at all — it enforces the change's own DECLARATIONS, and a declaration is CHANGE-scoped, applying to EVERY target (the KNOWN LIMITATION in `changes-repo.ts`). So `api@gamma` holds behind `db@gamma` and `db@gamma` holds behind `api@gamma`: every target held, none failed, and reconcile's pure-hold return fires forever. The change wedges in `executing` behind a watchdog warn, and the loud `auto-cancelled: plan compilation failed` epitaph ADR-0028 promises never arrives.

The compiler must therefore see what the HOLD enforces, not only what the graph still stores.

## §3. The precision half

The precision half. `db` is declared as a dependency of the change, which the KNOWN LIMITATION applies to BOTH targets — so `api` holds behind `db`, and `db`'s entry against itself is the `self` branch (satisfied, dropped, exactly as `buildDependencyMap` drops `from === to`). One wave per place, serialised inside it by the hold. Refusing this would auto-cancel the ordinary shape ADR-0028 exists to support.
