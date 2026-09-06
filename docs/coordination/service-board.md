# service-board

Reference for `apps/server/src/coordination/service-board.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 20 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. ARM 1 — the local observation

ARM 1 — the local observation. Authoritative for every component it answers for.

THE PLACEMENT HOP (ADR-0026). A wave target is a component under legacy compilation and a PLACEMENT under stage-shaped compilation, so `t.target_object_id AS component_id` is only half true and the `IN (componentIds)` filter matched NOTHING for a stage-shaped plan. Arm 1 would have returned zero rows for every component and this function would have silently degraded to arm 2 for the whole board — which is not a smaller answer, it is a DIFFERENT KIND of answer. Arm 2 is the fallback precisely because it is an unknown rather than an observation, and this file's own header records what happens when the two are confused: on an outpost, a newer commander-origin replica hides the outpost's genuinely-observed failure — the one fact it actually holds. The board would have kept rendering, with the strict-fallback shape it was built around quietly inverted.

`placementComponentParentSql` is the SAME fragment `graph/containment.ts` and `authz/resolve.ts` walk, LATERAL-joined here: one definition of "the component a placement places", including its guard against a malformed `componentId` casting-error. A legacy component target matches no placement row, so the LATERAL yields nothing and COALESCE falls through to the target itself — both shapes read through one query, and the legacy answer is unchanged.

## §2. WHICH FREEZE IS ACTUALLY ON THIS ROW

WHICH FREEZE IS ACTUALLY ON THIS ROW — resolved through CONTAINMENT, not exact scope membership
What this used to be: `listFreezes` (every freeze ever authored in the org), a hand-rolled half-open window comparison in JS, and a `Map` keyed on `scopeObjectId` looked up with `component.id`. Two defects in three lines, and M25.2 makes both worse:

```text
* EXACT-SET MEMBERSHIP. A freeze declared at a domain, at the org root, or at a
  deployment-target appeared on NO board row at all — `activeFreeze: null` for every affected
  component. Before per-target admission, such a freeze at least produced a whole-wave
  `gate`/`block` Decision that `latestBlockDecisionForSubject` turned into `attention.blocked`,
  so an operator saw *something*. A PARTIALLY frozen wave now returns `allow`, its hold
  Decision is deliberately `verdict: "hold"` so it does not reach that reader, and the held
  target sits at `status: "pending"` — indistinguishable from queued. The lever works and the
  signal was missing (proposal §1.8).
* A SECOND COPY OF THE WINDOW PREDICATE. `freezes-repo.ts`'s `activeFreezesInWindow` claims in
  its own docblock to be THE ONLY PLACE that knows `starts_at <= at < ends_at`; this file made
  that false. Two copies of one predicate drifting is precisely how the containment routes
  drifted until a service-scoped freeze failed OPEN.
```

`freezesByTarget` fixes both at once: it owns the window predicate and walks `containmentChain` per id, so every route reaches — component (3), deployment-target (4), service, domain, org. INERT when the org has no active freeze (one indexed read, zero graph walks), which is the state nearly every board render is in.

## §3. Nothing found for this component

Nothing found for this component. On a domain every peer of which forwards change objects that is a complete observation — genuinely nothing is rolling here. On a change-blind deployment it is not an observation at all, and `emptyRowUnknowns` says so rather than letting the nulls/false/[] below read as an all-clear. It still counts toward `stable` for shape stability (the four buckets must keep summing to `rows.length`, as `service-board-federation.integration.test.ts` pins) — which is precisely why the response then declares `summary.stable` itself unknown.
