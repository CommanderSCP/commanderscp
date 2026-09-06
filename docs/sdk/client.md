# client

Reference for `packages/sdk/src/client.ts`. The source carries a one-line headline at each site and points here.

> Partial: 8 of 47 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. M2 typed registries (DESIGN.md — BUILD_AND_TEST.md §8 M2 item 1)

M2 typed registries (DESIGN.md — BUILD_AND_TEST.md §8 M2 item 1). All 8 resources share the exact same generic request/response shapes (CreateObjectRequest/.../ObjectListResponse) — the generated per-resource functions (createDomain, createService, ...) differ only by which operationId/URL they call, so `ScpClient.typedResource` below is a single generic wrapper invoked once per resource instead of 8 hand-copies of the same 6 methods, mirroring routes/typed-registries.ts's server-side route factory. `ownerMethods`/`edgeMethods` do the same for the `owns`/`consumes`/`depends_on` sub-resource ergonomics (routes/ownership.ts).

## §2. `scp doctor` — read-only operational self-checks

`scp doctor` — read-only operational self-checks. Distinct from `/healthz` ("is this process up") and from `client.health` below ("what did an owner say about this object"): these report whether the instance's own state is COHERENT, which is exactly the class of fault a green liveness probe hides.

## §3. M4 Governance Engine (BUILD_AND_TEST.md §8 M4, DESIGN §10)

M4 Governance Engine (BUILD_AND_TEST.md §8 M4, DESIGN §10). Policy/Control documents reuse `typedResource` exactly like every other typed registry (routes/typed-registries.ts); control bindings/runs, approvals, freezes, and `policy evaluate` are their own thin wrappers.

## §4. M25.1 — move a freeze's `endsAt`, in EITHER direction

M25.1 — move a freeze's `endsAt`, in EITHER direction. Shortening it is a loosening and extending it is a tightening; both take `freeze:write` at the freeze's own scope, both require a reason, and the server records which direction it was along with the old and new instants. Shortening to a past instant is allowed and is NOT re-labelled a lift.

THE TWO DIRECTIONS DO NOT COST THE SAME (M25.9 / owner ruling D1(a-ii), 2026-08-25). A SHORTENING ends the protection early for everyone the freeze covers — the same act as `lift` with a different record — so it additionally takes the Owner-only `freeze:override` at the freeze's own scope whenever you are not the actor who declared it, and gating the lift alone would have left the retraction one PATCH away. EXTENDING adds protection and takes nothing from anyone, so it stays `freeze:write` even on someone else's freeze; so does re-sending the `endsAt` a freeze already has, which moves nothing. The server decides this from the direction it computes under the row lock, so the answer is about the window actually in force, not the one you last read.

## §5. THE PRODUCER DECLARATION

THE PRODUCER DECLARATION (ADR-0032 §7e) — which COMPONENT this org declares it publishes a coordinate from, and therefore which coordinates are INTERNAL.

It is the switch between two entirely different head ingresses. An internal coordinate's versions are DERIVED from the org's own production releases; a third-party one's are FETCHED from a public index. Declaring a coordinate the org does not publish silently stops security updates reaching every subscriber of it; failing to declare one it does publish hands that coordinate to a public index, where a stranger's package answering `9.9.9` bumps every subscriber onto it.

SO CALL IT WITH `dryRun` FIRST. Both verbs return the BLAST RADIUS — every major line the coordinate covers, each line's observed head, and the components subscribed to it — and with `dryRun: true` they compute it and write nothing. That list is unguessable from the request: you name one coordinate and affect repositories you cannot see.

WHO MAY CALL THESE: a principal holding `policy:write` AT THE ORG ROOT. Custody of the producing component is deliberately NOT enough (`governance/policy-scope-authz.ts`'s precedent — custody of a row is not jurisdiction over what it reaches). The READ needs only `object:read`.

THERE IS NO `producerIdOrUrn: null` FORM. Retraction is its own verb, because a nullable field that switches a call between "declare" and "undeclare" is how an omitted key becomes a destructive default.

## §6. DECLARE that a component produces this coordinate

DECLARE that a component produces this coordinate. Idempotent.

It CLEARS the observed head of every line the coordinate covers, deliberately: a poisoned public head would otherwise survive the very declaration that exists to undo it, and internal detection can never move a head backwards.

`declaredByObjectId` is NOT a parameter and must not become one — the server stamps the authenticated subject, because a provenance label the asserter supplies is forgeable.

A `service` is REFUSED with a 400 in the first cut: head derivation reads the COMPONENT a production placement names, so a service declaration would do the harmful half (remove the coordinate from polling) and none of the useful half.

## §7. N9 — `keep` names the row that should SURVIVE

N9 — `keep` names the row that should SURVIVE. Absent keeps the most authoritative one, so the default call is unchanged. It is the ONLY public-API way out of a VERIFIED foreign-origin duplicate: with it, this domain deletes the row IT authored (an ordinary journaled tombstone). Deleting a signature-verified replica stays refused unconditionally.

`ifClaimants` is the OPTIMISTIC-CONCURRENCY PRECONDITION — the `objectId:version` token of every claimant the caller PREVIEWED, from `outpostClaimantTokens`. If the live set has moved since, the call is refused 412 having written NOTHING, and the refusal body carries the fresh claimants (parse with `OutpostReconcileStaleProblemSchema`, or use `reconcileStaleClaimants`). Omitting it proceeds unchecked, which is the protocol default for compatibility — not a recommendation.

## §8. The live event stream (`GET /events/stream`, DESIGN §6/§8)

The live event stream (`GET /events/stream`, DESIGN §6/§8). Every frame is validated against the contract schema before it is yielded — the generated `responseValidator` runs per frame, exactly as it does per JSON body everywhere else (ADR-0023), which is what closes that ADR's named "not in the spec at all" hole.
