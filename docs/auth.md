# auth

Long-form reference for the **auth** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 39 of 39 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/auth/argon2-limiter.test.ts`](#apps-server-src-auth-argon2-limiter-test-ts) — §1–§1
- [`apps/server/src/auth/argon2-limiter.ts`](#apps-server-src-auth-argon2-limiter-ts) — §2–§4
- [`apps/server/src/auth/device-flow.ts`](#apps-server-src-auth-device-flow-ts) — §5–§7
- [`apps/server/src/auth/identity-sync.integration.test.ts`](#apps-server-src-auth-identity-sync-integration-test-ts) — §8–§8
- [`apps/server/src/auth/identity-sync.test.ts`](#apps-server-src-auth-identity-sync-test-ts) — §9–§9
- [`apps/server/src/auth/identity-sync.ts`](#apps-server-src-auth-identity-sync-ts) — §10–§12
- [`apps/server/src/auth/local-auth.ts`](#apps-server-src-auth-local-auth-ts) — §13–§16
- [`apps/server/src/auth/oidc.integration.test.ts`](#apps-server-src-auth-oidc-integration-test-ts) — §17–§19
- [`apps/server/src/auth/oidc.ts`](#apps-server-src-auth-oidc-ts) — §20–§24
- [`apps/server/src/auth/operator-auth.ts`](#apps-server-src-auth-operator-auth-ts) — §25–§30
- [`apps/server/src/auth/operator-credentials.integration.test.ts`](#apps-server-src-auth-operator-credentials-integration-test-ts) — §31–§32
- [`apps/server/src/auth/pat.ts`](#apps-server-src-auth-pat-ts) — §33–§35
- [`apps/server/src/auth/prefixed-token.test.ts`](#apps-server-src-auth-prefixed-token-test-ts) — §36–§36
- [`apps/server/src/auth/prefixed-token.ts`](#apps-server-src-auth-prefixed-token-ts) — §37–§38
- [`apps/server/src/auth/require-auth.ts`](#apps-server-src-auth-require-auth-ts) — §39–§39

## `apps/server/src/auth/argon2-limiter.test.ts`

### §1. The argon2 gate's guarantees, mutation-proven with fake tasks

The argon2 gate is the libuv-threadpool-saturation defense for login + prefixed-token verify (argon2-limiter.ts). Its guarantees, mutation-proven here against controllable tasks (never real argon2 — the point is deterministic concurrency, not hashing). `__setArgon2LimiterForTest` sets the caps and clears gate state per case.

MUTATION LOG (each applied ALONE against a passing suite, then reverted)
| Mutation | Result |
| remove the `active < maxConcurrent` cap (run everything at once) | the concurrency test FAILS — peak in-flight exceeds the cap | | drop the `waiters.length >= maxQueue` 429 (queue unboundedly) | the overflow test FAILS — the over-cap call resolves instead of throwing 429 | | make `release()` not wake a waiter | the drain test FAILS — a queued task never runs |

## `apps/server/src/auth/argon2-limiter.ts`

### §2. BOUNDED-CONCURRENCY GATE FOR argon2 VERIFICATION

BOUNDED-CONCURRENCY GATE FOR argon2 VERIFICATION.

`argon2.verify` is a NATIVE binding that runs on the libuv threadpool (default size 4). Every login (`local-auth.ts`) and every prefixed-token check (`prefixed-token.ts` → PAT / operator credential) calls it. An unauthenticated attacker who knows one valid username (or floods login for the bootstrap admin) can fire these faster than they complete, saturating the threadpool — which is ALSO where the rest of the process's fs/dns/zlib/crypto work runs — and starving the whole server, without ever tripping a request-rate limit. This is IP-independent, so it holds behind an ingress where every request shares one source IP (no `trustProxy` is configured).

The gate caps concurrent argon2 verifications at `MAX_CONCURRENT` (default: threadpool size − 1, so at least one thread is always free for everything else) and bounds the WAIT QUEUE at `MAX_QUEUE`. Past the queue ceiling it fails closed with a 429 — deliberate load-shedding: under an argon2 flood some legitimate logins get a retryable 429, which is strictly better than every async operation in the process stalling behind a full threadpool. A genuine argon2 error (a malformed stored hash) is still the caller's own `.catch(() => false)` concern; only the saturation 429 propagates from here.

Env overrides: SCP_ARGON2_MAX_CONCURRENT, SCP_ARGON2_MAX_QUEUE, and UV_THREADPOOL_SIZE feed the default concurrency.

### §3. Run `fn` (an argon2 operation) through the concurrency gate

Run `fn` (an argon2 operation) through the concurrency gate. Acquires a slot or a queue place, awaits `fn`, and always releases. A saturation 429 from `acquire` rejects BEFORE `fn` runs. Exported for the drift test (which drives the gate with controllable tasks); prefer `verifyPasswordHashLimited` in production code.

### §4. Verify a password through the gate; only saturation throws

Verify `password` against a stored argon2 `hash` through the concurrency gate. Returns `false` for a non-matching password OR a malformed/unreadable stored hash (same as a bare `argon2.verify(...).catch(() => false)`); the ONLY thing that throws is the saturation 429 from the gate, which callers must let propagate to the HTTP layer.

## `apps/server/src/auth/device-flow.ts`

### §5. SCP's OWN RFC 8628-shaped device-authorization flow

SCP's OWN RFC 8628-shaped device-authorization flow (M2 step 2 Part C, DESIGN.md §7's "OIDC device flow... grafted — headless jump boxes can't do browser redirects") — a decision made deliberately, flagged here as security-sensitive: this is NOT a proxy to the upstream IdP's device grant. It's hosted entirely by SCP, so it works identically whether the org is OIDC-configured or local-auth-only/air-gapped. The `verificationUri` points at SCP's own web UI/API; the human approves there using whatever auth method (local or OIDC) they already have a browser session for (routes/device-flow.ts `approve`, behind `requireAuth`).

Session minting is deferred to claim time (`pollDeviceAuth`), not done at approval (`approveDeviceAuth`): the `device_auth_requests` row must never hold a usable bearer token at rest, matching every other credential in the system (sessions: SHA-256 hash; PATs: argon2 hash) — see the doc comments on those two functions and drizzle/0006_device_flow_defer_session.sql.

### §6. `POST /auth/device/approve` — REQUIRES requireAuth

`POST /auth/device/approve` — REQUIRES requireAuth (the already-logged-in human approving from their own browser/UI session). Deliberately does NOT mint a session here: it records only WHO approved (`approvedByUserId`) and WHEN (`approvedAt`), so the device row never holds a usable credential. The actual session is minted later, at claim time, inside `pollDeviceAuth`'s `FOR UPDATE` transaction (single-use, see below). Returns `false` if no matching PENDING, unexpired request exists — callers should turn that into a 404 without more detail (don't leak which case it was).

### §7. `POST /auth/device/token` — no auth required

`POST /auth/device/token` — no auth required (this IS the auth mechanism); RFC 8628 error-code vocabulary (`authorization_pending`/`expired_token`/`access_denied`/`invalid_grant`) so the CLI can branch predictably (routes/device-flow.ts documents the response shape in a schema).

Single-use AND the point where a session first comes into existence: once a row is confirmed `approved` (and only then, under the `FOR UPDATE` lock taken below — no other poller can be concurrently inspecting the same row), this mints the session via `createSession` and, in the same transaction, flips the row to `claimed`. The device row itself never stores the resulting plaintext bearer — it exists only in this function's return value, handed to the caller exactly once. A second poll after a successful claim always sees `claimed` and gets `invalid_grant`, never a replayed token or a second minted session.

## `apps/server/src/auth/identity-sync.integration.test.ts`

### §8. IdP GROUP SYNC

IdP GROUP SYNC — reconciliation against a real graph

THE PROPERTY UNDER TEST IS AUTHORITY, NOT EDGES. A sync that writes the right `member_of` rows and does not change what anyone may DO would be an elaborate no-op, so every case here ends at `hasPermission` — the same function the doors call — rather than at a row count.

## `apps/server/src/auth/identity-sync.test.ts`

### §9. The two PURE halves of IdP group sync

The two PURE halves of IdP group sync. The reconciliation itself needs a database and lives in `identity-sync.integration.test.ts`; these are the parts a unit test can pin, and one of them is the most safety-critical line in the feature.

## `apps/server/src/auth/identity-sync.ts`

### §10. IdP GROUP SYNC

IdP GROUP SYNC — claim values to SCP group membership

THE PROBLEM. Generic OIDC authenticates an Entra/Okta/Keycloak user and JIT-provisions them as a Viewer at the org root. That is the whole of it: 500 people in the directory can sign in on day one and all 500 are Viewers until an admin makes 500 decisions. Nothing has ever read a claim beyond `sub`/`email`/`preferred_username`/`name`.

THE SHAPE. An SCP `group` or `team` object carries `EXTERNAL_IDENTITY_PROPERTY`, naming the claim value it mirrors. At login, the values in the configured claim are matched against those objects and `member_of` edges are reconciled. Roles are bound to the GROUP, once, by a human, through the existing door — so the estate keeps one decision per group instead of one per person, and every existing read surface (`GET /role-bindings`, `GET /authz/effective`) explains the result without knowing the IdP exists.

THE IdP IS AUTHORITATIVE FOR A MAPPED GROUP — including deletions
Reconciliation REMOVES memberships as well as adding them, and it does not distinguish an edge it created from one a human added by hand. For a group carrying a mapping, the directory is the source of truth, full stop: adding somebody to it through `POST /relationships` is undone at that person's next login.

That is a deliberate choice over the alternative — marking edges as sync-owned and leaving hand-made ones alone — because the alternative produces a group whose membership no single system can state. Half the members come from Entra and half from somebody's afternoon, the two are indistinguishable in the UI, and removing a person from the directory silently leaves their authority in place. A mapped group means "this group is the directory's"; an estate that wants a hand-managed group should not map one.

UNMAPPED GROUPS ARE NEVER TOUCHED. The reconciliation's delete arm is scoped to groups that carry a mapping, so ordinary teams are entirely outside this system.

WHY THIS IS EXEMPT FROM THE `member_of` SUBSET RULE, AND WHERE THE BAR WENT INSTEAD
`graph/relationships-repo.ts` applies the no-escalation subset rule to every `member_of` create: writing that edge confers whatever the group's bindings carry, so the actor must already hold it. A login sync has NO human actor and could never satisfy it — the "actor" is the identity provider.

Owner decision: the sync is carved out, and the bar moves to AUTHORING THE MAPPING (`authz/identity-mapping-door.ts`). The reasoning is that the escalation §2a closes is a low-privileged principal choosing to join a high-privileged group — and here nobody chooses their own claims. Entra does. So the question worth gating is not "may this person join" but "who decided that this claim value means this group", and that is a human act with a human actor, which can carry the full subset rule.

WHAT THAT LEAVES OPEN, STATED RATHER THAN IMPLIED: whoever administers the identity provider can grant any authority any mapped group carries, without any SCP permission at all. That is not a bug — it is what federating identity MEANS, and it is true of every SSO integration ever built — but it moves part of the estate's trust boundary into the directory, and an operator should decide that knowingly. `role-binding-door.ts`'s grant preview reports whether a subject is externally synced for exactly this reason.

### §11. Pulls the claim values out of a validated ID token

Pulls the claim values out of a validated ID token.

⚠️ THE OVERAGE CASE FAILS THE LOGIN LOUDLY, and that is the single most important line here. Entra omits the `groups` claim entirely once a user is in roughly 200 groups, substituting `_claim_names` / `_claim_sources` that point at MS Graph. Resolving those needs an outbound call to graph.microsoft.com, which CLAUDE.md principle 5 forbids — so SCP cannot see the user's groups at all in that case.

The tempting behaviour is to treat "no claim" as "no groups" and carry on. That would sign the user in with their entire group-derived authority silently removed — and worse, the reconciliation below would then REVOKE the memberships they legitimately had, because an empty desired set is indistinguishable from "the IdP says they are in nothing". A privileged user would be quietly demoted at their next login, and the only symptom would be permissions that used to work. That is a check passing because it never ran.

So an overage token is refused with an explanation naming the fix. This costs a login; the alternative costs an unexplained privilege loss that looks like an SCP bug.

### §12. Reconciles mapped group membership through the edge doors

Reconciles one principal's membership of MAPPED groups against the claim values in their token.

GOES THROUGH `createRelationship`/`deleteRelationship` with an `identitySync` flag, rather than writing rows directly. The first draft of this function did write them directly, and the compiler caught why that is wrong: `relationships` carries `origin_domain_id` and `content_hash`, which `createRelationship` computes for federation. Hand-rolling the insert would have meant a SECOND definition of how a relationship's identity is derived — the exact duplicated-walk defect this codebase keeps paying for — and it would have silently produced edges a federation journal could not replay.

So the exemption is one boolean on the existing input, sibling to `federationImport`, read at one `if`. Every other guard that function applies — cardinality, cycles, governance labels — still runs.

## `apps/server/src/auth/local-auth.ts`

### §13. Local-auth bootstrap, in-server until the plugin host exists

Local-auth bootstrap (DESIGN.md §7, §3 `packages/plugins/local-auth`). The full IdentityPlugin subprocess-isolated implementation arrives once the plugin host exists (M3); until then this logic lives directly in the server, behind the same argon2 bootstrap-admin behavior the plugin will eventually provide.

Idempotent: safe to call on every boot. Creates the seeded org + graph root object + bootstrap admin (as both an auth row and a graph `user` object bound to the built-in Owner role at the org's root scope) only if they don't exist yet, and prints the one-time password once.

Audit events written during bootstrap attribute `actorId = orgId` — a "system" placeholder, since no user (graph subject) exists yet at the point the org root object itself is created.

### §14. Issues a session token: the one place every login path shares

Issues a new opaque bearer/session token for an already-authenticated `(userId, orgId)` pair — shared by every login path (local-auth `login()` below, OIDC `auth/oidc.ts`, device-flow claim `auth/device-flow.ts` `pollDeviceAuth`) so token generation/hashing/expiry logic lives in exactly one place. Accepts either the top-level `Db` or a `TenantTx`/plain transaction handle so callers that must mint the session atomically inside a wider transaction (device-flow's claim, which mints the session only once the row is confirmed claimable under `FOR UPDATE`) can pass their `tx` straight through instead of opening a second, unrelated transaction.

### §15. Resolves a `users.id` to its full auth context

Resolves a `users.id` to its full auth context — shared by `verifyToken` below and PAT verification (auth/pat.ts), which both end at "I know the user row, now build the AuthContext" after their own distinct token-lookup step.

### §16. `POST /auth/logout` (routes/auth.ts, M2 step 4)

`POST /auth/logout` (routes/auth.ts, M2 step 4) — invalidates the session row a local-auth/ OIDC session token resolves to, so it's rejected by `verifyToken` immediately, even if the client kept a copy. Expires it (UPDATE) rather than deleting the row: the runtime `scp_app` login role is only granted SELECT/INSERT/UPDATE on auth-substrate tables, never DELETE (PR #4 security review, CRITICAL 3 — `drizzle/0002_rls_rbac_seed.sql` §1) — same externally-observable effect (the token stops working) without widening that grant for a "logout" nicety. No-op if the token doesn't match a live session — callers own deciding whether that's worth surfacing.

## `apps/server/src/auth/oidc.integration.test.ts`

### §17. A real PKCE round-trip against a containerized Keycloak

Generic OIDC (Authorization Code + PKCE via `openid-client`) round-trip against a CONTAINERIZED Keycloak fixture — BUILD_AND_TEST.md §8 M2 DoD (c), non-negotiable. Drives the real PKCE dance with raw `fetch` + manual `redirect: 'manual'` (no browser, no keycloak-admin-client SDK).

### §18. THE ENTRA APP-ROLE SHAPE, reproduced on Keycloak

THE ENTRA APP-ROLE SHAPE, reproduced on Keycloak (role-model.md — SSO groups)
Entra emits assigned APP ROLES as a `roles` claim whose values you choose. Keycloak does the same thing under a different name: a realm role plus a `oidc-usermodel-realm-role-mapper` that writes them into the ID TOKEN. `id.token.claim: "true"` is the load-bearing setting — without it the role lands in the ACCESS token only, `tokens.claims()` never sees it, and the sync silently reconciles to nothing. That is the exact silent-strip this feature refuses.

### §19. THE WIRING THIS FILE EXISTS TO PROVE, and which nothing else could

THE WIRING THIS FILE EXISTS TO PROVE, and which nothing else could.
`identity-sync.integration.test.ts` calls `syncExternalGroupMembership` DIRECTLY, so it proves reconciliation and proves nothing about whether a login ever reaches it. The chain handleCallback -> claims.raw -> claimValuesFrom(config.roleClaim) -> sync was, until this test, verified only by reading the source. Delete the sync call from `routes/oidc.ts` and every other test in the suite stays green — which is this repo's dominant failure class wearing an SSO costume.

Keycloak stands in for Entra deliberately: same generic-OIDC seam, same `roles` claim, no per-provider code. What is NOT covered is Entra's own quirks — the groups-claim overage in particular — which no local fixture can reproduce.

## `apps/server/src/auth/oidc.ts`

### §20. Generic OIDC (Authorization Code + PKCE via `openid-client`)

Generic OIDC (Authorization Code + PKCE via `openid-client`) — DESIGN.md §7, M2 step 2 Part B. One config (issuer discovery) covers Okta/Entra/Keycloak/Ping with no per-provider special casing. Written as a self-contained module with a clear `authorize()`/`handleCallback()` seam (the "IdentityPlugin seam" the M2 task describes) so it's easy to lift into a real subprocess-isolated plugin once the plugin host exists (M3) — that host is explicitly out of scope here.

SECURITY: this module must never log the authorization code, the PKCE code_verifier, or any token. Callers (routes/oidc.ts) must not either.

### §21. The authorize URL plus the PKCE triple the caller must persist

Builds the authorization redirect URL plus the PKCE code_verifier / state / nonce triple the caller MUST persist tied to this specific browser session (routes/oidc.ts stores it in a short-lived signed httpOnly cookie, per DESIGN.md §7) and pass back into `handleCallback` — these three values are the CSRF/replay protection and are actually validated there, not decorative.

### §22. Exchanges the callback for tokens and validates state and nonce

Exchanges the authorization callback for tokens and validates the response: `state` is checked against the value generated in `authorize()` (mismatch throws — CSRF protection), the ID token's issuer/audience/`nonce` claim are validated by `openid-client` against the expected values passed here (not decorative — a forged or replayed ID token fails these checks).

### §23. JIT-provisions the user row, graph object and Viewer binding

Creates the local `users` row + graph `user` object + Viewer role binding for a first-time OIDC login, mirroring `ensureBootstrapAdmin`'s pattern (graph object + role binding inside one tenant transaction, the `users` row inserted afterward via a plain `db` call — orgs/users/ sessions/PATs are pre-tenant-resolution auth substrate with no RLS, DESIGN.md §4.2).

Least privilege (security-sensitive, flagged in the M2 step 2 report): JIT-provisioned accounts get the built-in Viewer role at the org root, never Owner/Administrator — an admin can grant more afterward. Race note: if two concurrent first-logins for the same (org, sub) land at once, the loser's graph object/role binding is orphaned (harmless, unreferenced) and this function re-fetches the winner rather than erroring — accepted complexity/simplicity trade-off for M2 (DESIGN.md's decision priorities put Simplicity first).

### §24. Later logins issue a session and never touch role bindings

On first successful OIDC login for a given `(org, sub)` pair, JIT-provisions a local account (see `provisionNewOidcUser`). On subsequent logins, looks the existing user up and issues a new session WITHOUT touching role bindings — an admin may have since changed them, and this must never clobber that.

## `apps/server/src/auth/operator-auth.ts`

### §25. INSTANCE-TIER OPERATOR AUTHENTICATION

INSTANCE-TIER OPERATOR AUTHENTICATION — role-model.md §5 step 9 / §3B

The credential guarding every write door whose blast radius is the WHOLE DEPLOYMENT: platform freezes that stop releases for every org, scan floors no tenant may loosen, the governance:move rung, scanner assignments, the dependency-subscription unlock. No RBAC permission can grant these — a tenant, however privileged inside its own org, must never author config that binds its neighbours — so this is a separate, deployment-level credential by design (config.ts's `operatorToken` docblock says so, and that part was always right).

WHAT WAS WRONG WITH THE THING IT REPLACES
`SCP_OPERATOR_TOKEN` is ONE shared static string on every api and worker pod. It cannot be rotated without redeploying all of them (so it is not rotated), cannot be revoked for one person (there is one secret and everyone who ever operated the deployment holds it, including leavers), never expires, and sits in plaintext in pod specs and `kubectl describe`. The doors also `requireAuth`, so the audit chain does name a principal — but the AUTHORITY is the shared string, so "who was entitled to do this" has the same answer for everyone who has ever seen it.

AND ONE THING THE CENSUS FOUND: THE CHECK EXISTED EIGHT TIMES
`requireOperator` was hand-written in EIGHT route files — `instance-freezes`, `instance-scan-floors`, `instance-scan-exclusion-admissions`, `scanner-assignments`, `scan-db`, `governance-move`, `dependency-subscriptions`, and `doctor` (as `requireOperatorToken`) — each with its own wording and its own two branches. Eight copies of an authentication decision is eight places for the next change to reach seven of. They now compose `requireInstanceOperator`, which keeps the per-surface message (that part was worth having) and has one definition of what admits a caller.

THE ENV TOKEN STILL WORKS, ON PURPOSE, AND IS NOW NAMED "BOOTSTRAP"
Removing it in the same change would lock out every existing deployment on upgrade AND leave no way to mint the first credential — the table would be unreachable. So it is accepted, and `OperatorAuthResult` reports WHICH mechanism admitted the request, so a deployment can see that it is still on the bootstrap path rather than assuming it migrated.

ORDER OF ATTEMPTS IS DELIBERATE: the database credential first. A deployment that has minted real credentials and left the env var set must not have its revocations silently bypassed by a fallback that fires first — a revoked credential presenting a value equal to the env token is a case that cannot arise (they are independent secrets), but the ordering also means the common post-migration path does no argon2 work against a value that will not match.

### §26. Constant-time comparison for the bootstrap env token

Constant-time comparison for the bootstrap env token.

Length is compared first and NOT with `timingSafeEqual` — that function throws on unequal lengths, so a length check has to happen anyway; doing it explicitly makes the early return visible rather than hidden in a catch. The length of a secret is not the secret.

### §27. Mints a credential

Mints a credential. The caller must already have been admitted by `requireInstanceOperator`.

WRITES THROUGH THE OPERATOR CONNECTION, not the request-serving one. `scp_app` holds SELECT and UPDATE on this table and deliberately no INSERT or DELETE — the same read/write split every other instance-scoped table has (drizzle/0076, 0086, 0102). The verifier needs to read rows and stamp `last_used_at` on the request path; nothing on that path should be able to MINT authority.

MEASURED, not assumed: the first version of this function used `deps.db` and returned a 500 on every mint, because the grant it needed does not exist and should not.

### §28. Revokes by stamping `revoked_at`, never by DELETE

Revokes by stamping `revoked_at`, never by DELETE.

A deleted row cannot answer "what was this, and when did it stop working" — and the whole point of replacing a shared secret is that the estate can answer that per credential.

Through the operator connection, for `createOperatorCredential`'s reason.

### §29. Verifies a presented `x-scp-operator-token`

Verifies a presented `x-scp-operator-token`.

Returns `null` for every failure — unknown, malformed, revoked, expired, wrong secret — because a caller learning WHICH of those applies learns whether a token id exists, and there is no operator workflow that needs the distinction from an unauthenticated position.

### §30. THE ONE DEFINITION of what admits an instance-operator request

THE ONE DEFINITION of what admits an instance-operator request. Replaces eight hand-written copies.

`surface` is the per-door phrase those copies each carried ("instance freezes are operator-authored", "scanner assignments ..."), kept because a refusal that names the door an operator was trying to open is materially more useful than a generic one — that part of the duplication was worth preserving, and it is the only part.

## `apps/server/src/auth/operator-credentials.integration.test.ts`

### §31. A revoked or expired credential must stop opening the door

INSTANCE-TIER CREDENTIALS — role-model.md §5 step 9 / §3B

Replaces the single shared `SCP_OPERATOR_TOKEN` with named, hashed, individually revocable, optionally expiring credentials.

THE PROPERTY THAT MATTERS MOST IS THE ONE A HAPPY-PATH TEST MISSES: a credential that has been revoked, or has expired, must stop opening doors — not the door that minted it, but the REAL instance-tier doors whose blast radius is the whole deployment. So the tests below drive `PUT /api/v1/instance/governance-move-rung`, an actual operator surface, rather than only the credential CRUD. A credential API that mints correctly and is not consulted by anything is the "built, never installed" defect wearing a security feature's name.

### §32. THE ESCALATION THIS CLOSES

THE ESCALATION THIS CLOSES. `scp_app` must stamp `last_used_at` on the request path, so it needs UPDATE — and a BLANKET update grant would let anything running as the request-serving role clear `revoked_at` and bring a revoked credential back to life, which is exactly the capability this table exists to provide. The grant is therefore column-scoped.

Asserted as `scp_app` specifically, because the harness's ordinary connection is the Testcontainers SUPERUSER, which bypasses grants and RLS and would make this pass vacuously.

## `apps/server/src/auth/pat.ts`

### §33. Personal Access Tokens

Personal Access Tokens (M2 step 2 Part A, BUILD_AND_TEST.md §8 M2 item 3) — hashed at rest (argon2, like local-auth passwords), never stored or returned in plaintext after creation.

Token shape: `scp_pat_<tokenId>.<secret>`. `tokenId` (16 random URL-safe base64 chars) is a CLEARTEXT, indexed lookup key — argon2's output is salted/non-comparable, so unlike `sessions.tokenHash`'s SHA-256 equality lookup, a presented PAT can't be found by hashing it and matching a row directly. `secret` (32+ random bytes, base64url) is the part that's actually argon2-hashed into `tokenHash` and verified on every use. Parse/verify sequence shared with `operator-auth.ts`'s instance operator credentials via `./prefixed-token.js`.

### §34. Revokes a PAT owned by `(orgId, userId)`

Revokes a PAT owned by `(orgId, userId)`. Returns `null` if no such (unrevoked) PAT exists — callers should turn that into a 404 regardless of whether the id doesn't exist, belongs to someone else, or was already revoked, so existence doesn't leak across users.

### §35. A PAT resolves to the user's own context, never a broader one

Verifies a `scp_pat_<tokenId>.<secret>` bearer token and resolves it to the exact same `AuthContext` shape a session token would produce for the owning user (same RBAC subject, same org) — a PAT is exactly as permission-scoped as the user's own session, never more.

## `apps/server/src/auth/prefixed-token.test.ts`

### §36. The shared prefixed-token decision sequence, without a database

The shared `<prefix><tokenId>.<secret>` parse/mint/verify sequence behind both `pat.ts`'s `verifyPat` and `operator-auth.ts`'s `verifyOperatorCredential`. No DB here — `verifyPrefixedToken` takes plain `findByTokenId`/`touchLastUsed` callbacks, so its full decision sequence (parse -> lookup -> revoked -> expired -> secret -> touch) is exercised in-memory, at the layer both callers actually depend on.

## `apps/server/src/auth/prefixed-token.ts`

### §37. The `<prefix><tokenId>.<secret>` bearer-token shape shared by PATs

The `<prefix><tokenId>.<secret>` bearer-token shape shared by PATs (`pat.ts`) and instance operator credentials (`operator-auth.ts`): `tokenId` is a cleartext, indexed lookup key (argon2's output is salted/non-comparable, so a presented token can't be found by hashing it and matching a row directly); `secret` is the part that's argon2-hashed at rest and verified on every use.

Extracted after `verifyPat`/`verifyOperatorCredential` and their `generate*` helpers were found byte-for-byte duplicated — this is the ONE definition of the parse/verify sequence, so a future fix (e.g. to the ENOENT/expiry/revocation ordering) lands for both token kinds at once.

### §38. Verifies a presented `<prefix><tokenId>.<secret>` token

Verifies a presented `<prefix><tokenId>.<secret>` token: parse, look up by `tokenId`, reject on revoked/expired, argon2-verify the secret, then best-effort stamp `lastUsedAt`. Returns the row on success so each caller can shape its own result (an `AuthContext` for a PAT, an `OperatorAuthResult` for an operator credential) — never `null` vs. a reason, since neither caller distinguishes "unknown" from "wrong secret" to the presenter.

## `apps/server/src/auth/require-auth.ts`

### §39. Org is always resolved from the token

Org is always resolved from the token (DESIGN.md §6); path overrides only assert a match. The ONE seam that resolves a bearer/cookie value to an AuthContext — a `scp_pat_` prefixed token is a Personal Access Token (auth/pat.ts), anything else falls through to the existing local-auth session-token path (auth/local-auth.ts `verifyToken`, unchanged).
