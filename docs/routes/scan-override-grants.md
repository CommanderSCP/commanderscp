# scan-override-grants

Reference for `apps/server/src/routes/scan-override-grants.ts`. The source carries a one-line headline at each site and points here.

> Partial: 3 of 6 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. ...AND IT MUST BE AN ANCESTOR

...AND IT MUST BE AN ANCESTOR. Resolving proves the row exists and nothing else. Because `scopeExpandCte` expands UPWARD, a requester naming any object they happen to hold `policy:write` at would be choosing the authority that approves their own waiver — D3's escalation guard, self-selected. The named object must be on THIS component's containment chain, and the gate re-derives its tier from that same chain (D3).

## §2. SEPARATION OF DUTIES

SEPARATION OF DUTIES — the raiser may not be the approver (owner decision, 2026-08-18).

APPROVE ONLY, deliberately, and for the same reason the instance-floor check above is approve-only: taking a waiver back must never be harder than making one. Denying or revoking your own request is ordinary withdrawal and stays free.

WHAT THIS IS AND IS NOT. It is defence in depth for the D3 authority bar, not a replacement for it: the escalation the bar exists to stop survives this check intact the moment any SECOND principal holds the same scoped `policy:write`. It closes only the one-actor shape — raise at a tier you hold, then immediately sign your own waiver — which is also the cheapest shape to reach and the only one that leaves a single name on both halves of the record.

IT CANNOT BIND A FEDERATED GRANT, and that is correct rather than a gap. A grant arriving over the journal was decided at its AUTHORING instance, where this check ran; re-deciding it here is not a thing this door does. `requestedByActorId` from a peer also names a subject in that domain's `objects`, so comparing it to a local subject id would be meaningless.

## §3. THE ONE CALLER THAT MAY WRITE A DECISION

THE ONE CALLER THAT MAY WRITE A DECISION. `graph/objects-repo.ts` refuses `status`, `expiresAt`, `decidedByActorId`, `decidedAt` and `decisionReason` at every other local door; this is the path that earns them, having just run the derived-tier authority check above and about to write the Decision and the hash-chained audit event below, in this same transaction. The flag is a TypeScript-only field on the repo input — no request body reaches it, and `grep -rna scanOverrideGrantDecision` finds exactly this one setter.
