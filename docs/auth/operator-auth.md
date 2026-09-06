# operator-auth

Reference for `apps/server/src/auth/operator-auth.ts`. The source carries a one-line headline at each site and points here.

> Partial: 5 of 6 multi-line comment blocks in this file have been
> moved here. The rest are still inline pending a hand-written one-line headline.

## §1. INSTANCE-TIER OPERATOR AUTHENTICATION

INSTANCE-TIER OPERATOR AUTHENTICATION — role-model.md §5 step 9 / §3B

The credential guarding every write door whose blast radius is the WHOLE DEPLOYMENT: platform freezes that stop releases for every org, scan floors no tenant may loosen, the governance:move rung, scanner assignments, the dependency-subscription unlock. No RBAC permission can grant these — a tenant, however privileged inside its own org, must never author config that binds its neighbours — so this is a separate, deployment-level credential by design (config.ts's `operatorToken` docblock says so, and that part was always right).

WHAT WAS WRONG WITH THE THING IT REPLACES
`SCP_OPERATOR_TOKEN` is ONE shared static string on every api and worker pod. It cannot be rotated without redeploying all of them (so it is not rotated), cannot be revoked for one person (there is one secret and everyone who ever operated the deployment holds it, including leavers), never expires, and sits in plaintext in pod specs and `kubectl describe`. The doors also `requireAuth`, so the audit chain does name a principal — but the AUTHORITY is the shared string, so "who was entitled to do this" has the same answer for everyone who has ever seen it.

AND ONE THING THE CENSUS FOUND: THE CHECK EXISTED EIGHT TIMES
`requireOperator` was hand-written in EIGHT route files — `instance-freezes`, `instance-scan-floors`, `instance-scan-exclusion-admissions`, `scanner-assignments`, `scan-db`, `governance-move`, `dependency-subscriptions`, and `doctor` (as `requireOperatorToken`) — each with its own wording and its own two branches. Eight copies of an authentication decision is eight places for the next change to reach seven of. They now compose `requireInstanceOperator`, which keeps the per-surface message (that part was worth having) and has one definition of what admits a caller.

THE ENV TOKEN STILL WORKS, ON PURPOSE, AND IS NOW NAMED "BOOTSTRAP"
Removing it in the same change would lock out every existing deployment on upgrade AND leave no way to mint the first credential — the table would be unreachable. So it is accepted, and `OperatorAuthResult` reports WHICH mechanism admitted the request, so a deployment can see that it is still on the bootstrap path rather than assuming it migrated.

ORDER OF ATTEMPTS IS DELIBERATE: the database credential first. A deployment that has minted real credentials and left the env var set must not have its revocations silently bypassed by a fallback that fires first — a revoked credential presenting a value equal to the env token is a case that cannot arise (they are independent secrets), but the ordering also means the common post-migration path does no argon2 work against a value that will not match.

## §2. Constant-time comparison for the bootstrap env token

Constant-time comparison for the bootstrap env token.

Length is compared first and NOT with `timingSafeEqual` — that function throws on unequal lengths, so a length check has to happen anyway; doing it explicitly makes the early return visible rather than hidden in a catch. The length of a secret is not the secret.

## §3. Mints a credential

Mints a credential. The caller must already have been admitted by `requireInstanceOperator`.

WRITES THROUGH THE OPERATOR CONNECTION, not the request-serving one. `scp_app` holds SELECT and UPDATE on this table and deliberately no INSERT or DELETE — the same read/write split every other instance-scoped table has (drizzle/0076, 0086, 0102). The verifier needs to read rows and stamp `last_used_at` on the request path; nothing on that path should be able to MINT authority.

MEASURED, not assumed: the first version of this function used `deps.db` and returned a 500 on every mint, because the grant it needed does not exist and should not.

## §4. Revokes by stamping `revoked_at`, never by DELETE

Revokes by stamping `revoked_at`, never by DELETE.

A deleted row cannot answer "what was this, and when did it stop working" — and the whole point of replacing a shared secret is that the estate can answer that per credential.

Through the operator connection, for `createOperatorCredential`'s reason.

## §5. Verifies a presented `x-scp-operator-token`

Verifies a presented `x-scp-operator-token`.

Returns `null` for every failure — unknown, malformed, revoked, expired, wrong secret — because a caller learning WHICH of those applies learns whether a token id exists, and there is no operator workflow that needs the distinction from an unauthenticated position.
