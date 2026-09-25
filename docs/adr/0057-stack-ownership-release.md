# ADR-0057: A stack's ownership is released by an audited door whose bar is the authority to decommission the whole stack

**Status:** Accepted (2026-09-24) — the per-stack (not per-object) authority bar, the D7 refusal and the tombstone refusal below are this increment's calls, and the owner is invited to overrule them
**Relates to:** drizzle/0068 and docs/coordination-as-code.md §52 (stack ownership is a server-written column; R1 enrolment / R2 escape); §4 (cross-stack adoption is theft and is refused); ADR-0046 §3 / docs/routes.md §311 (D7 single ownership per stack); docs/coordination-as-code.md §328–§331 (the full reasoning)

## Context

`managed_by_stack` is written only by an apply, and only ever SET. A row left a stack by being
pruned. §4 then made cross-stack adoption a 409, so a stack that is retired — no longer applied,
rather than applied empty — keeps every row it owns forever, and no other stack can manage them.
Live: a retired stack `agentkit-org` still owns a shared deployment-target and a user.

A release door is the obvious remedy and is dangerous in two ways that are both already on record:
release-then-adopt is §4's takeover in two requests, and release alone is §52's R2 escape (the row
leaves the prune pool, so it survives its stack's decommission). R2 was a defect because a principal
bound at ONE object could do it.

## Decision

1. `POST /api/v1/stacks/{stackName}/release` with a body naming `urns` and/or `relationships`
   (`typeId`, `fromUrn`, `toUrn`). No "release everything" form: naming nothing is a 400.
   All-or-nothing: any named row the stack does not own as a LIVE row is a 409 listing each one.
   One hash-chained `stack.release` audit event per request, same transaction.
2. **The authority bar is the stack's, not the row's**: the apply write permission at every live
   object the stack owns and `relationship:write` at both ends of every live edge it owns — the
   checks an apply of the stack's empty manifest would push — plus `POST /plans`'s `object:read`
   org-root floor. Rejected: the per-object bar ("you may release what you could delete"), because
   it admits R2 at exactly the authority that made R2 a defect; org admin, because a team that owns
   the container its stacks live in already holds this authority and should not need an org owner.
3. **D7 applies**: a stack bound to a config source is refused like a direct apply, because the
   repo's next sync re-adopts whatever it still declares.
4. **Tombstoned rows are refused**, not released: every reader of the column filters live rows and
   there is no restore path, so their ownership is inert and a "success" would mask a mis-aimed
   request.
5. The release is the second writer in `stack-ownership.ts`, which stays the one module writing the
   column on objects and relationships (census-held by `stack-ownership-reachability.test.ts`).

## Consequences

- A stack still being applied re-adopts any released row its manifest still declares, visibly
  (`adopted` in the plan). Release is for rows a stack will not claim again.
- `roles` / `role_bindings` carry their own `managed_by_stack` and are stuck by the same property;
  releasing them needs the RBAC doors' authority, and is a named follow-up.
- Cross-stack adoption is refused for objects only; an edge another stack owns is silently re-stamped
  (pre-existing, recorded in §331). Not changed here.
- The 0068 `COMMENT ON COLUMN` text still names one writer; left rather than spend a migration number.
