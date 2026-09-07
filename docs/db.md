# db

Long-form reference for the **db** subsystem — the rationale, hazards and open items that
used to sit inline. Each source file below carries a one-line headline at the site and points here.

> Partial: 156 of 156 multi-line comment blocks in this subsystem are here. The rest are
> still inline, pending a hand-written one-line headline.

## Files

- [`apps/server/src/db/client.ts`](#apps-server-src-db-client-ts) — §1–§2
- [`apps/server/src/db/journal-ordering.test.ts`](#apps-server-src-db-journal-ordering-test-ts) — §3–§3
- [`apps/server/src/db/member-heartbeat-repo.integration.test.ts`](#apps-server-src-db-member-heartbeat-repo-integration-test-ts) — §4–§5
- [`apps/server/src/db/member-heartbeat-repo.ts`](#apps-server-src-db-member-heartbeat-repo-ts) — §6–§6
- [`apps/server/src/db/operator-write-principal.integration.test.ts`](#apps-server-src-db-operator-write-principal-integration-test-ts) — §7–§7
- [`apps/server/src/db/pg-errors.ts`](#apps-server-src-db-pg-errors-ts) — §8–§8
- [`apps/server/src/db/pgboss-role.integration.test.ts`](#apps-server-src-db-pgboss-role-integration-test-ts) — §9–§10
- [`apps/server/src/db/pool-factory-census.test.ts`](#apps-server-src-db-pool-factory-census-test-ts) — §11–§12
- [`apps/server/src/db/provision.integration.test.ts`](#apps-server-src-db-provision-integration-test-ts) — §13–§16
- [`apps/server/src/db/provision.ts`](#apps-server-src-db-provision-ts) — §17–§24
- [`apps/server/src/db/rbac-ddl-preconditions.integration.test.ts`](#apps-server-src-db-rbac-ddl-preconditions-integration-test-ts) — §25–§36
- [`apps/server/src/db/schema-ddl-drift.integration.test.ts`](#apps-server-src-db-schema-ddl-drift-integration-test-ts) — §37–§37
- [`apps/server/src/db/schema.ts`](#apps-server-src-db-schema-ts) — §38–§154
- [`apps/server/src/db/snapshot-freshness.test.ts`](#apps-server-src-db-snapshot-freshness-test-ts) — §155–§155
- [`apps/server/src/db/tenant-tx.ts`](#apps-server-src-db-tenant-tx-ts) — §156–§156

## `apps/server/src/db/client.ts`

### §1. `pg.Pool` does not connect eagerly

`pg.Pool` does not connect eagerly — constructing it (and the drizzle wrapper around it) is always safe to call even when no database is reachable, which is what lets `openapi:emit` boot the app's route definitions without a DB (BUILD_AND_TEST.md §8 M0).

THE ONE POOL FACTORY (proposal multi-region-instance-resilience.md §4-A6, §7.1 item 6). Every `new pg.Pool(...)` in this codebase goes through here — a source-lint test (pool-factory-census.test.ts) asserts it. `connectionTimeoutMillis` and `keepAlive` are applied by default so a connect against a dead/failed-over host fails fast onto the promoted primary instead of hanging at OS TCP patience; callers needing a different shape (e.g. `max: 1` single-connection pools) pass `options` to override or extend the defaults, never construct their own `pg.Pool`.

### §2. FAILOVER SURVIVAL (§7.5 failover drill found this)

FAILOVER SURVIVAL (§7.5 failover drill found this): a Postgres failover terminates every IDLE pooled connection at once, and `pg.Pool` emits `'error'` for each. With NO listener attached, Node treats it as an unhandledError and CRASHES the process — so a failover, the exact event this milestone exists to survive, would take down every pod on the way back up. Log and swallow: the pool discards the dead connection and re-establishes a fresh one on the next checkout (the `connectionTimeoutMillis` above makes that checkout fast-fail onto the promoted primary, §4-A6).

## `apps/server/src/db/journal-ordering.test.ts`

### §3. THE MIGRATION JOURNAL'S ORDERING INVARIANTS

THE MIGRATION JOURNAL'S ORDERING INVARIANTS — a guard against a merge that fails SILENTLY, and specifically against the way EVERY OTHER CHECK IN THIS REPO IS BLIND TO IT.

`drizzle-orm/pg-core/dialect.cjs` gates each migration like this:

```text
  const lastDbMigration = dbMigrations[0];              // newest already applied
  for await (const migration of migrations) {
    if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) { ... }
```

Two consequences, and the second is the trap:

1. `idx` IS NEVER CONSULTED FOR GATING. It orders the array; it does not decide what runs. A journal with perfect contiguous idx values can still skip a migration. 2. `lastDbMigration` is read ONCE, BEFORE the loop. So on a FRESH database it is undefined and every migration applies regardless of `when` — which is exactly what every integration suite in this repo does (Testcontainers hands out a new database per file). On an EXISTING database a migration whose `when` is BELOW the newest applied one is skipped, permanently, with no error. CI is structurally incapable of catching that: green here, broken on upgrade.

That is not hypothetical. On 2026-08-10 three branches landed migrations the same day; the `reconcile_cursor` journal entry was authored while main was at 0055 and carried `when: 1787940000000`, but `0057_source_mapping_ref_pattern` merged first with `when: 1788006400000`. Any instance that had applied 0057 would have skipped 0058 forever — the `reconcile_cursor_at` column would simply never exist, and every candidate query would fail against a column the schema swore was there. Every test still passed, because they all migrate from empty.

So this asserts the property the merge conflict CANNOT: not "did we resolve the array", but "does the resolved array actually apply". Resolving a `_journal.json` conflict with `--ours`/`--theirs`, or appending an entry authored against an older main, breaks it — and nothing else here notices.

## `apps/server/src/db/member-heartbeat-repo.integration.test.ts`

### §4. §7.4 — the member-cluster heartbeat round-trip

§7.4 — the member-cluster heartbeat round-trip (also validates that migration 0093 applies and the runtime `scp_app` role can upsert its own row under the instance-wide RLS policy). A live heartbeat is what the migrations Job's version-skew gate and the instance doctor read.

### §5. AGE THE ROW EXPLICITLY rather than shrinking the window to zero

AGE THE ROW EXPLICITLY rather than shrinking the window to zero. The zero-width version compared a DB-clock `updated_at` against a JS-clock cutoff and so depended on the two clocks agreeing to the millisecond — it passed locally and failed in CI, where the row came back "live" because the container's clock ran marginally ahead. Ageing the row by an hour makes the assertion about the WINDOW, which is what it claims to be about, on any clock.

## `apps/server/src/db/member-heartbeat-repo.ts`

### §6. §7.4 version-skew gate

§7.4 version-skew gate — pure, so the migrations Job's refusal is directly testable. REFUSES (by throwing) iff any LIVE member cluster reports a version DIFFERENT from `deployingVersion` — i.e. an old (or newer) member cluster is still up, so the contract half must wait. `own` heartbeats already on the deploying version are fine (this cluster restarting), and an empty set is fine (first deploy). N and N+1 only: it is the DIFFERENCE that blocks a contract migration, since a contract migration is safe only once every member runs the release that shipped its expand half.

## `apps/server/src/db/operator-write-principal.integration.test.ts`

### §7. EVERY INSTANCE-SCOPED TABLE HAS A WRITE PRINCIPAL

EVERY INSTANCE-SCOPED TABLE HAS A WRITE PRINCIPAL — role-model.md §5 step 9, drizzle/0102

THE PROPERTY. An instance-scoped table here is tenant-READ (a `tenant_read` policy, `FOR SELECT USING (true)`) and operator-WRITE (the `scp_operator` role, drizzle/0076). Under FORCE ROW LEVEL SECURITY both halves are required: the GRANT alone is denied by the absent policy, and the POLICY alone is denied by the absent grant.

IT SHIPPED WRONG THREE TIMES, WHICH IS WHY THIS IS A CENSUS AND NOT TWO ASSERTIONS. 0029/0035/0036/0074 created four such tables with no write principal and 0076 came back for them; 0083 §2 then created `governance_move_instance_rung` without one — 0086's comment records this as having happened "AGAIN" — and 0062 had already done the same for `dependency_subscription_unlock`. Each time the noticed instances were fixed and the CLASS was left open. So this test does not name tables: it DERIVES the population from `pg_policies` and requires the write principal for every member. A table added tomorrow with a `tenant_read` policy and no operator write fails here, which is the only version of this check that stops the recurrence.

WHY THIS READS THE CATALOG INSTEAD OF ATTEMPTING A WRITE
The obvious test — write the row and see it land — CANNOT detect this defect in this suite. The integration harness's `DATABASE_URL` is the Testcontainers SUPERUSER, and a superuser bypasses both grants and row-level security outright. That is precisely why two of these survived a fully green suite for as long as they did, and it generalises: **a passing integration run here is not evidence that a grant exists.** The catalog is the only instrument in this environment that can see the thing being asserted.

## `apps/server/src/db/pg-errors.ts`

### §8. drizzle wraps every driver error, so unwrap before matching

drizzle-orm >=0.44 (bumped to 0.45.2 to clear GHSA-gpj5-g38j-94v9) wraps every error a driver throws in its own `DrizzleQueryError`, with the original `pg` driver error preserved on `.cause` (standard ES2022 error-cause chaining — see drizzle-orm's `errors.ts`). Every caller in this codebase that branches on a raw Postgres error code (e.g. `graph/query-timeout.ts`'s `57014` statement-timeout check, or this module's own `23505`/`23503` checks below) needs to see THROUGH that wrapper to the original `pg` error, so this is exported for reuse rather than duplicated. Walks `.cause` repeatedly (not just one level) so this keeps working even if something else ever wraps a `DrizzleQueryError` again.

## `apps/server/src/db/pgboss-role.integration.test.ts`

### §9. M3 tracked security follow-up

M3 tracked security follow-up (BUILD_AND_TEST.md §8 M3 item 9, closing a gap flagged in an earlier security review): pg-boss no longer runs its own internal schema migrations on the admin/superuser connection — it connects as the schema-scoped `scp_pgboss` login role (drizzle/0008_pgboss_role.sql, src/db/provision.ts's `provisionPgBossRole`, src/events/pgboss.ts). Two things need PROVING here, not just asserting:

```text
1. pg-boss actually boots under this least-privileged role — its own internal
   `CREATE SCHEMA`/`CREATE TYPE`/`CREATE TABLE`/`CREATE FUNCTION` migrations at `.start()`
   succeed without superuser, because `scp_pgboss` OWNS the `pgboss` schema (ownership, not
   elevated privilege, is what makes this work — see the migration's own comments for why no
   `ALTER DEFAULT PRIVILEGES` is needed on top of that).
2. `scp_pgboss` has ZERO privilege on `public`'s tenant tables — proven as an actual Postgres
   permission-denied failure (SQLSTATE 42501), not merely an empty result set, since RLS
   could otherwise make an ungranted role's SELECT look identical to a granted-but-filtered
   one.
```

`listenTestServer({ withEventRelay: true })` is what actually starts pg-boss in-process (main.ts's `role === "all" || "worker"` branch) — at the time this test was written, no other integration test in the suite exercised that path, so this is also the first real proof pg-boss boots end to end under the new role, not just under the old admin connection.

### §10. MINOR #10 fix (PR #7 review)

MINOR #10 fix (PR #7 review): the probe previously covered only 4 tables (objects/relationships/role_bindings/changes) and only SELECT/INSERT. `scp_pgboss` has NO grant at all on `public` (0008's §2 — "the absence of a GRANT here IS the enforcement"), so the isolation guarantee is identical across every tenant table and every DML verb; this extends the probe to the REST of the M3 tenant surface (decisions, change_waves, change_wave_targets, gate_bindings, source_mappings, change_source_events, change_plans, outbox, audit_events) and to UPDATE/DELETE, not just SELECT/INSERT.

Data-driven rather than one repetitive `it` per table x verb: `insert` is a syntactically valid statement satisfying each table's NOT NULL columns (values are throwaway — the point is proving the ACL check rejects the statement before any constraint/data question is even reached); UPDATE/DELETE use `org_id`, present and NOT NULL on every one of these tables, so a single WHERE shape works uniformly without needing each table's actual primary key column (`changes`' PK is `object_id`, not `id` — deliberately not assumed here).

## `apps/server/src/db/pool-factory-census.test.ts`

### §11. THE ONE POOL FACTORY

THE ONE POOL FACTORY — a standing gate against the A6 census reopening

Problem (proposal multi-region-instance-resilience.md §4-A6, §7.1 item 6): `createPool` in `client.ts` is the only place that applies `connectionTimeoutMillis`/`keepAlive`, so a connect against a dead host (mid-failover) fails fast onto the promoted primary instead of hanging at OS TCP patience. Three route files were found constructing `new pg.Pool(...)` directly, bypassing that — this is the census that keeps a fourth one from landing unnoticed.

`productionSourceFiles` excludes `*.test.ts`: integration tests legitimately build their own scratch pools against a Testcontainers instance (unrelated to this production failover concern), and `outbox-relay.ts`'s dedicated `new pg.Client` for its LISTEN connection is a `Client`, not a `Pool`, and is out of this item's scope.

### §12. The test-support trees are Testcontainers-only scaffolding

`test-support/` trees (root and nested) are Testcontainers-only scaffolding — bootstrapping a throwaway template/scratch database before migrations run, never a request-serving connection — and are excluded from the A6 concern the same way `productionSourceFiles` already excludes `*.test.ts`. `productionSourceFiles` cannot tell the two apart on filename alone (these files don't end in `.test.ts`, since vitest never loads them as test files directly).

## `apps/server/src/db/provision.integration.test.ts`

### §13. B9 — the credential-clobber guard

B9 — the credential-clobber guard (multi-region-instance-resilience.md §4-B9, §7.4). `provisionRuntimeRole`/`provisionPgBossRole` run on every boot (main.ts Phase 1 / migrate-bin.ts — see their doc comments); before this guard they unconditionally `ALTER ROLE ... PASSWORD`ed, so a second member cluster installed against the SAME shared database with its OWN independently-generated password would silently clobber the first cluster's live credentials on every one of ITS boots. These tests prove: create-if-absent, skip-if-already-correct (no clobber), refuse-on-mismatch (naming the hazard, and — the load-bearing assertion — leaving the live credential untouched), the explicit opt-in reset, and that a non-auth connectivity failure during the verification probe propagates instead of being misread as "needs a reset."

Deliberately never touches `scp_app`/`scp_pgboss` themselves: those are CLUSTER-GLOBAL roles already provisioned (and relied upon) by the rest of this suite via global-setup.ts. Every test here provisions its own throwaway, per-test-unique role name instead — `pg_roles` is cluster- wide, not per-database, and this file's own worker database is one of several sharing the same Testcontainers Postgres cluster.

### §14. Mirrors what migrations leave before first boot provisions

Mirrors what the migrations actually leave behind BEFORE first boot ever provisions a login role — a NOLOGIN role has no live password to clobber, so this must NOT be treated as a re-provisioning needing verification (a NOLOGIN role rejects every password with the same class-28 SQLSTATE a real mismatch would, so this case would otherwise be misread as "the configured password doesn't match" and refuse on every fresh install).

### §15. Connection limit zero makes every future attempt fail loudly

CONNECTION LIMIT 0 makes every future connection attempt as this role fail with "too many connections for role" (SQLSTATE 53300, class 53 "insufficient resources") REGARDLESS of whether the password is correct — a connectivity-class failure, distinct from the class-28 auth failures the guard treats as "needs a reset." Re-provisioning with the SAME (correct) password must still hit this during the verification probe and propagate it as-is.

### §16. The exact bootstrap race B9 must survive

The exact bootstrap race B9 must survive: two member clusters' migration Jobs run against the same shared cluster while the role is still the migration-created NOLOGIN shell. Without the per-role advisory lock (review finding PV-1), both read `rolcanlogin = false`, both take the "first provisioning" branch, and both blindly ALTER — the later commit silently clobbers the earlier's credential with no error. The lock serializes read-decide-write, so the second caller re-reads AFTER the first committed LOGIN and hits the verify-or-refuse path instead.

Iterated over fresh roles: the unlocked outcome is timing-dependent (sometimes the second SELECT happens to land after the first COMMIT and refuses anyway), so a single shot could pass even against the bug. Repeating makes the without-lock double-clobber reliably surface — every iteration must show the deterministic one-wins-one-refuses shape the lock guarantees.

## `apps/server/src/db/provision.ts`

### §17. An env flag restores the unconditional password rotation

`SCP_PROVISION_ALLOW_PASSWORD_RESET=1` restores the pre-B9 unconditional-ALTER behavior for a deliberate, operator-initiated password rotation (proposal multi-region-instance-resilience.md §4-B9, §7.4). Read directly from `process.env` rather than through `config.ts`: `config.ts` itself imports `deriveRuntimeDatabaseUrl` from this module, so importing `loadConfig` back here would be circular. Every call site may still override per-call via the `allowPasswordReset` option (used by the guard's own tests).

### §18. True for a Postgres SQLSTATE class-28 error

True for a Postgres SQLSTATE class-28 error ("Invalid Authorization Specification" — 28000 role/ db mismatch, 28P01 bad password): the ONLY signal that means "this role's live password differs from what we're configured with." Anything else (refused connection, DNS failure, timeout, the role's own CONNECTION LIMIT) is a connectivity failure, not evidence of a clobber risk, and must propagate instead of being read as "needs a reset."

### §19. Connects only to learn whether the password already matches

Connects as `user`/`password` against the same server + database `adminPool` targets, purely to find out whether that password is ALREADY the role's live password — a read, never a write. Returns `true` (matches — the ALTER can be skipped), `false` (a class-28 auth failure — a DIFFERENT password is live), or throws (a non-auth connectivity failure, which proves nothing about the password and must not be treated as a mismatch).

### §20. The shared compare-and-skip implementation behind both roles

Shared implementation behind `provisionRuntimeRole`/`provisionPgBossRole` (B9 — multi-region-instance-resilience.md §4-B9, §7.4's "compare-and-skip-or-refuse rather than unconditional reset"). The old behavior was `ALTER ROLE ... WITH LOGIN PASSWORD` unconditionally, every boot — harmless for one cluster, but a second member cluster installed against the SAME shared database with its OWN independently-generated password would silently clobber the first cluster's live credentials on every one of ITS boots. Now:

```text
- role doesn't exist yet → CREATE it with LOGIN + the configured password.
- role exists but has never been granted LOGIN before (`rolcanlogin = false` — this is what
  the migration files leave it as: `CREATE ROLE scp_app NOLOGIN ...`, drizzle/0002 etc.) →
  there is no LIVE password to clobber, so this is a FIRST provisioning wearing the role's
  migration-created shell, not a re-provisioning. Grant LOGIN + the configured password
  directly (via ALTER, since the role object already exists) — no verification needed or
  possible, since a NOLOGIN role rejects every password with the SAME class-28 error a real
  mismatch would, which would otherwise misfire this guard on every fresh install.
- role exists AND already has LOGIN (a previous boot provisioned it) — this is a genuine
  RE-provisioning. If the configured password is ALREADY live (verified by actually
  connecting as it, never by comparing anything at rest) → skip the ALTER. Nothing to clobber.
  If it is NOT live → refuse loudly, naming the hazard, unless `allowPasswordReset` is set, in
  which case this falls back to the old unconditional ALTER for a deliberate,
  operator-initiated rotation.
```

### §21. Serialize the WHOLE read-decide-write per role

Serialize the WHOLE read-decide-write per role (review finding PV-1). Without this, two member clusters' migration Jobs bootstrapping concurrently both read the role while it is still NOLOGIN (the migration-created shell), both take the "first provisioning" branch, and both blindly `ALTER ROLE ... PASSWORD` — the second silently clobbers the first's credentials, the exact failure B9 exists to prevent, just at first boot. A transaction-level advisory lock (auto-released on COMMIT/ROLLBACK) makes the second caller wait, then re-read AFTER the first committed LOGIN — so it sees `rolcanlogin = true` and falls into the verify-or-refuse branch instead of a blind ALTER. The whole sequence therefore runs on ONE held connection.

### §22. Boot-time runtime-role provisioning

Boot-time runtime-role provisioning (PR #4 review, CRITICAL 3). Runs over the admin/bootstrap connection immediately after migrations, then the admin pool is closed — the request-serving pool connects as the login role provisioned here and never sees superuser privileges.

The migration files fix `scp_app`'s privilege shape (NOSUPERUSER, NOBYPASSRLS, table grants, RLS policies — drizzle/0002, 0003); this only grants LOGIN and sets the password, which cannot live in committed SQL. Idempotent: safe on every boot.

B9 GUARD (multi-region-instance-resilience.md §4-B9, §7.4): does NOT unconditionally reset the password any more — see `ensureManagedRolePassword`'s doc comment above. `options. allowPasswordReset` defaults to `SCP_PROVISION_ALLOW_PASSWORD_RESET=1` when omitted.

### §23. Boot-time pg-boss role provisioning

Boot-time pg-boss role provisioning (M3 tracked security follow-up: pg-boss no longer connects on the admin/superuser URL for its own `pgboss` schema). Same mechanism and same reasoning as `provisionRuntimeRole` above — drizzle/0008_pgboss_role.sql fixes `scp_pgboss`'s privilege shape (NOLOGIN, NOSUPERUSER, NOBYPASSRLS, owns only the `pgboss` schema, no grants on `public` at all); this only grants LOGIN and sets the password, which cannot live in committed SQL. A distinct function (rather than reusing `provisionRuntimeRole` under this name) keeps main.ts's boot sequence self-documenting: each role provisioned in Phase 1 gets its own named call. Idempotent: safe on every boot.

B9 GUARD: same compare-and-skip-or-refuse behavior as `provisionRuntimeRole` — see `ensureManagedRolePassword`.

### §24. Derives the runtime

Derives the runtime (least-privileged) connection string from the admin one: same host, port, database, and password — only the user is swapped to `scp_app`. Operators who manage the role themselves override with an explicit SCP_RUNTIME_DATABASE_URL instead.

## `apps/server/src/db/rbac-ddl-preconditions.integration.test.ts`

### §25. drizzle/0097 — the RBAC DDL preconditions

drizzle/0097 — the RBAC DDL preconditions (docs/proposals/role-model.md §1.3g/§1.3h, build order §5 step 1). This increment adds NO role and NO permission; it makes `roles` and `role_bindings` able to HOLD the purpose-shaped roles safely. So there is no route to test through — the whole subject matter is what the DATABASE refuses, and the only honest way to assert that is to attempt the write against real Postgres and read the SQLSTATE back.

Two of these guards protect against a failure that CANNOT be caught at the application layer:

```text
- the duplicate-grant key (`role_bindings_grant_key`) is what makes a revoke verb
  trustworthy. Two identical grants are individually revocable and collectively still
  granting — revoke one, the other still grants, and the API reports success. No amount of
  care in one write door prevents that; the database is the only layer every writer passes
  through.
- the effect CHECK closes a SILENT INERTNESS: `hasPermission` classifies with exact string
  equality (`effects.includes("deny")`, then `includes("allow")` — authz/resolve.ts:285-286),
  so a row with effect 'ALLOW' grants nothing and denies nothing while rendering, to any
  reader of the table, as authority.
```

And the "cleanup path" describe block is the one that carries the real risk. (a), (b) and (c) can HARD-FAIL on a populated database — a unique index over pre-existing duplicates aborts, and so does a CHECK over pre-existing violations — so 0097 cleans before it constrains. A cleanup that has never run on dirty data is a cleanup nobody has tested: every integration database here is migrated from EMPTY, so the clean path is the only one CI would otherwise ever see. That block therefore builds the dirty state by hand and re-executes the migration's own committed SQL text against it — not a re-implementation of the cleanup in TypeScript, which would only prove the test agrees with itself.

Its last three cases are about §1a, the REFUSAL, and they are the ones with authority riding on them. Collapsing duplicate built-in roles keeps the lowest id, which is deterministic but carries no claim to be right: a re-executed 0002 seed writes the M1-era 11-permission `Owner` beside today's 22-permission one, `gen_random_uuid()` decides which holds the lower id, and half the time lowest-id-wins would strip twelve permissions — `freeze:override`, `change:emergency` and `change:accept` among them — from every Owner in the estate, during an upgrade that reported success. The other half widens instead, and since drizzle/0099 it also RESURRECTS `org:admin`, a permission that was deleted precisely because it gates nothing. So 0097 refuses to pick and aborts with the ids and the delta; the tests below pin the refusal, pin that the abort leaves the database untouched, and pin that it does NOT fire on duplicates that merely differ in array order. The exact counts are MEASURED from the live row inside each case rather than restated here, so a later grant migration moves them without touching this paragraph's argument.

MUTATION LOG — each applied ALONE to `drizzle/0097`'s §1a, measured 2026-08-26, then reverted

| Mutation | Measured result |
| `IF report IS NOT NULL THEN` → `IF false THEN` (i.e. §1a computes the delta and never raises) | **1 fail, and the right one.** `ABORTS instead of collapsing built-ins whose permissions have DIVERGED`: `Error: 0097 SUCCEEDED against two Owner rows with different permissions — it silently picked one`. The other 23 stay green, including both collapse cases — which is the whole point: the harmful behaviour is invisible to every test that only checks that duplicates went away. | | The set comparison → a literal array comparison (`WHERE o.permissions IS DISTINCT FROM k.permissions`) | **1 fail, the opposite one.** `does NOT abort when the duplicates agree — order and repeats are not divergence` dies on the migration's own message: `0097: refusing to collapse duplicate built-in roles whose permissions have DIVERGED …`. A false alarm an operator cannot act on, since `hasPermission` reads the array with `= ANY(...)` and does not care about order. |

### §26. Located by SUFFIX, not by number

Located by SUFFIX, not by number. Migration numbering across open PRs is strictly serial in merge order and is expected to be re-verified (and RENUMBERED) at merge time — a test that hard-coded `0097_` would silently stop covering the migration the moment that happened. Matching on the stable half of the filename removes the question, and `toHaveLength(1)` makes a rename that breaks the match a loud failure rather than a skipped assertion.

### §27. The `WHERE org_id IS NULL` half

The `WHERE org_id IS NULL` half. If someone "simplifies" the index to a plain UNIQUE(name), this test is what tells them they just made every org's custom-role namespace global.

NARROWED BY drizzle/0103, DELIBERATELY. This case used to insert TWO org rows named 'Viewer' and assert a count of 2 — which the new `roles_org_name_key` (`UNIQUE (org_id, name) WHERE org_id IS NOT NULL`) now refuses, because two roles sharing a name inside one org make the catalogue unreadable: both bind, both render identically in GET /roles, and a revoke names one of them. The CLAIM this case exists to make is unchanged and is still measured here — 0097's index does not constrain org rows, so an org row may take a built-in's name — it is now demonstrated with ONE row, which is all the claim ever needed.

Such a row is refused by the AUTHORING door (`assertRoleNameNotBuiltIn`) and unbindable at the grant door (`builtInNameCollisionReason`). Those are doors, not DDL, which is exactly why this DDL-level assertion is still worth making: it pins that the database permits what the doors refuse, so nobody later "fixes" the index and silently changes two doors' meaning.

### §28. NULL = "any scope", ON THE FIVE LADDER ROWS

NULL = "any scope", ON THE FIVE LADDER ROWS. Backfilling any non-NULL value for them would retroactively make live bindings illegal the day the write door starts enforcing it: Viewer/Operator/Approver/Administrator/Owner are bound at org roots, services and components across deployments, and 0097 has no way to know which.

SCOPED TO THE LADDER BY NAME, not to "every built-in", because drizzle/0099 seeds five PURPOSE roles that DO carry a `bindable_at` (role-model.md §3) — they have no bindings in the field to invalidate, since there is no write door yet. Their exact arrays are asserted in `routes/rbac-permission-splits.integration.test.ts`; what belongs here is the 0097 property that the pre-existing rows were left alone.

### §29. schema.ts <-> DDL agreement

schema.ts <-> DDL agreement.

Drizzle does not enforce constraints at runtime and these tables' DDL is hand-authored (not `drizzle-kit generate`d), so a `unique(...)`/`check(...)` declaration in schema.ts is, on its own, a comment that TypeScript happens to compile. That is precisely the "built and tested but wired nowhere" shape: the schema.ts edit in this increment would pass every other check in the repo even if the migration had never been written. These assertions read BOTH sides.

`db/schema-ddl-drift.integration.test.ts` now carries the general form of this — every index in the migrated database must have a named declaration in schema.ts, and vice versa. It was written because this block's own observation ("nothing else in this repo checks it") turned out to be load-bearing: seven indexes, four of them race-closing partial uniques on `objects`/`relationships`, had been missing from schema.ts for up to four milestones. What stays here is the SHAPE of 0097's own constraints, which a name-level gate cannot see.

### §30. Located BY NAME, not by asserting the whole index array

Located BY NAME, not by asserting the whole index array. `roles` has since acquired `roles_org_name_key` (drizzle/0103) and `roles_managed_stack` (drizzle/0108), and an exact-array assertion here would make every later index on this table look like a regression in 0097's test. That completeness question — no index in the database missing from schema.ts, and none declared that the database lacks — is `schema-ddl-drift`'s job now, generically, for every table. What belongs HERE is 0097's own index's SHAPE.

### §31. Owner's permissions exactly as the seed migration writes them

`roles.permissions` for `Owner` EXACTLY as 0002:220-222 writes it — the literal a re-run of that seed puts on disk today, copied here so this fixture is the real producer and not a stylised one.

IT STILL INCLUDES `org:admin`, WHICH THE LIVE ROW NO LONGER CARRIES. drizzle/0099 deleted that permission with `array_remove` and deliberately LEFT 0002's literal alone: a shipped migration is a record of what the database was asked to do at that version, and editing one makes the file on disk disagree with the hash `__drizzle_migrations` recorded on every deployment that already ran it. So a re-executed 0002 seed really does still write this, and the divergence it manufactures is now BIDIRECTIONAL — the stale row is no longer a strict subset of the live one, which the assertions below measure rather than assume.

### §32. The duplicate takes an all-zero-prefix id so it is the LOWEST

The duplicate takes an all-zero-prefix id so it is the LOWEST — i.e. the half of the coin flip where lowest-id-wins would keep the STALE row. 0002 seeds with `gen_random_uuid()` (a random v4, not a time-ordered v7), so on a real estate this is a coin flip, not an edge case: whichever way it lands, one of the two Owners is deleted and every Owner binding in the org is repointed at the other.

### §33. Re-run 0002's seed row for Owner

Re-run 0002's seed row for Owner. Its permission literal is FROZEN at M1; the six migrations that later edited Owner by name (0010/0012/0083/0088/0094 append, 0099 appends three and removes one) are already in `__drizzle_migrations` and do not re-run over the new row. So the duplicate is born behind — which is exactly why "every grant migration updates all duplicates identically" does not imply "duplicates are identical".

### §34. AND THE OTHER DIRECTION IS NO LONGER EMPTY

AND THE OTHER DIRECTION IS NO LONGER EMPTY. Until drizzle/0099 the stale row was a strict SUBSET of the live one, and the case still refused because repointing bindings the other way would WIDEN. 0099 REMOVED `org:admin` from the live Owner (it gated nothing at any call site) while deliberately leaving 0002's frozen literal alone — so a re-executed seed now manufactures a duplicate that is behind in twelve permissions AND ahead in one dead one. Both directions in one fixture, which is what §1a's predicate is written for.

### §35. The other side of the predicate, and the reason it compares SETS

The other side of the predicate, and the reason it compares SETS. `hasPermission` reads `<permission> = ANY(rl.permissions)` (authz/resolve.ts), which is blind to element order and to repeats — so two rows differing only that way carry identical authority, and stopping an upgrade over them would be a false alarm an operator cannot act on. A straight `permissions = permissions` comparison would fire here; this is what says it must not. (The byte-identical case is covered by the dirty-fixture test above, which copies `permissions` from the survivor.)

### §36. The other half of "safe to run on a populated database"

The other half of "safe to run on a populated database": every cleanup is bounded by a `HAVING COUNT(*) > 1` or an explicit not-a-legal-value predicate, so on a clean estate it must touch nothing. If a future edit drops one of those bounds, this is what catches it — a cleanup that deletes on a CLEAN database is a data-loss bug that the dirty-fixture test above would happily pass.

## `apps/server/src/db/schema-ddl-drift.integration.test.ts`

### §37. THE INDEX DRIFT GATE

THE INDEX DRIFT GATE — `src/db/schema.ts` against the database the migrations actually build.

`apps/server/drizzle/*.sql` is hand-authored; `drizzle-kit generate` has not produced a migration here since the M1/M2 era. So schema.ts is a DESCRIPTION of the database that, until this file, nothing forced to be true. Drizzle enforces no constraint at runtime, which makes an undeclared index invisible in the worst way: every test passes, every query works, and the omission surfaces only when somebody reads schema.ts to decide whether an invariant is enforced. That reading is exactly what the four race-closing partial unique indexes on `objects`/`relationships` (drizzle/0022, 0049, 0051, 0095) exist to answer — and all four were absent from schema.ts for between one and four milestones, alongside `roles_org_name_key`, `config_source_sync_queue_pending_identity` and `instance_operator_credentials_token_id_key`.

BOTH DIRECTIONS, because the two failures are different bugs. An index in the database and not in schema.ts is an invariant a reader will not know is enforced. An index in schema.ts and not in the database is the opposite and worse: a guarantee the code may already be leaning on, which no deployment has.

BY NAME, deliberately. Comparing columns or predicates would need this test to re-implement Drizzle's SQL emitter, and a mismatch there would be a test bug reported as drift. The name is the one thing both sides state literally — and it is also the half Drizzle's `.unique()` column sugar gets wrong in this repo: the sugar names its constraint `<table>_<column>_unique` while the hand-authored migrations write `<table>_<column>_key`, so a bare `.unique()` beside a hand-written `..._key` index reads as declared and is not. `instance_freezes` and `federation_self` both had that shape. Per-index SHAPE (partiality, column order) is asserted where it is load-bearing, next to the invariant it protects — see `rbac-ddl-preconditions.integration.test.ts`.

MUTATION-PROVEN 2026-08-31: removing `uniqueIndex("roles_org_name_key")` from schema.ts turns the first case red naming `roles_org_name_key (roles)`; a declaration for an index no migration creates turns the second case red naming it. Neither mutation moves any other test in the suite.

NOT COVERED HERE: CHECK constraints, grants and RLS policies. Those have no schema.ts counterpart to compare against for most tables (Drizzle models only the first, and only where someone wrote a `check(...)`), so a gate over them would assert the absence of something schema.ts never claimed. Indexes are the class where schema.ts does make a complete claim.

## `apps/server/src/db/schema.ts`

### §38. M1 Graph Core schema

M1 Graph Core schema (DESIGN.md §4.1-§4.3, §7, §8). Supersedes M0's minimal `objects` table with the full generic graph model: object_types/relationship_types (runtime type registry), objects/relationships (the graph itself, federation-ready provenance columns, optimistic concurrency, soft delete), roles/role_bindings (RBAC), audit_events (hash-chained append-only log), outbox (transactional outbox feeding pg-boss + SSE), and idempotency_keys (Idempotency-Key replay per DESIGN.md §6).

RLS policies, the `scp_app` least-privileged role, built-in type/role seed rows, and the outbox NOTIFY trigger are hand-authored SQL (drizzle-kit cannot express them) — see drizzle/0002_rls_rbac_seed.sql.

### §39. Personal Access Tokens (M2 step 2, BUILD_AND_TEST.md §8 M2 item 3)

Personal Access Tokens (M2 step 2, BUILD_AND_TEST.md §8 M2 item 3) — auth substrate like orgs/users/sessions above (no RLS, see drizzle/0004_auth_expansion.sql). `tokenId` is an indexable CLEARTEXT lookup key: argon2's output is salted/non-comparable, so — unlike `sessions.tokenHash`'s SHA-256 equality lookup — a PAT can't be found by hashing the presented secret and matching it directly. The presented token is `scp_pat_<tokenId>.<secret>`; `tokenId` finds the row in O(1), then `tokenHash` (argon2 of `secret`) is verified (auth/pat.ts).

### §40. SCP's own RFC 8628-shaped device-authorization flow

SCP's own RFC 8628-shaped device-authorization flow (M2 step 2 Part C) — hosted by SCP itself, not a proxy to the upstream IdP's device grant, so it works identically for local-auth-only air-gapped orgs and OIDC-configured orgs alike (DESIGN.md §7 "headless jump boxes can't do browser redirects"). Auth substrate, no RLS — same treatment as orgs/users/sessions.

Session minting is DEFERRED to claim time (auth/device-flow.ts `pollDeviceAuth`, drizzle/0006): approval (`approveDeviceAuth`) only records WHO approved (`approvedByUserId`) and WHEN (`approvedAt`) — never a token. `createSession` (session.ts) is called for the first time inside the claiming poll's `FOR UPDATE` transaction, and the resulting plaintext bearer is returned exactly once, never persisted. This row therefore never holds a usable credential at any point in its lifecycle — matching every other credential in the system (sessions: SHA-256 hash; PATs: argon2 hash).

### §41. CONTAINMENT sense (ADR-0021 D4)

CONTAINMENT sense (ADR-0021 D4) — the containment parent (ANY object; a `domain` in the common case); NULL only for the org root object. There is deliberately NO FK and NO CHECK here (0001_graph_core.sql:32) and `resolveContainmentParent` applies no type filter, so a service id or a component id is valid and is what several shipped tests pass. The brand asserts the SENSE, never the TYPE. Deliberately branded differently from `originDomainId` nine lines below, which is the TRUST sense: the two are structurally identical uuids and were freely interchangeable before branding.

### §42. True when this object's existence stays inside its own domain

M20.1 (ADR-0031 §1) — TRUE = this object's existence stays inside its own security domain: `federation/scope-filter.ts` matches its journal entries against NO peer scope, in either direction. Operator-DECLARED at create under `federation:write`, never inferred from a repo name, a target label or a branch string (the ADR-0030 §2 lesson).

IMMUTABLE BY CONSTRUCTION, not by a guard: of the five statements that write this table, only `createObject`'s INSERT names this column. Shared -> domain-local is refused forever (federation has no un-send); domain-local -> shared is the one-way M20.4 publication verb.

VISIBILITY ONLY (ADR-0031 §7). It is never an enforcement input: it grants no scan exemption, relaxes no gate, and is read by no governance path. The exemption domain-local content enjoys comes from the PATH (no peer => `exportPromotionBundle` unreachable => E6 never applies), and an inertness test pins that this bit and that gate stay unaware of each other.

### §43. M20.7 (ADR-0031 §6c) — WHY this object is domain-local

M20.7 (ADR-0031 §6c) — WHY this object is domain-local. The container it INHERITED locality from at create (M20.5/§6a), or NULL when an operator DECLARED it, or when it is not domain-local at all. Those three states are exhaustive and need no discriminator column.

HISTORICAL, deliberately: it records the container as it was at create and is never updated to follow it, so after §6b's publish-container-then-child flow a still-local child legitimately points at a container that has since become shared. That is the true answer to "how did this become domain-local", not staleness. Re-deriving it live would need the containment walk §6a exists to avoid.

No FK: losing the provenance because its source was tombstoned would be worse than a dangling id, which readers render as "inherited, source no longer present". The URN is denormalized alongside the id because `objects.urn` is IMMUTABLE (`updateObject` writes `urn: existing.urn`), so it cannot drift — and it is accepted anywhere an id is, which means a badge can render "inherited from secure-partition" and link to it with NO lookup. `name` is deliberately absent: it IS mutable, and the urn's last segment is the name as at create, which for historical provenance is the more honest label.

### §44. The stack whose apply owns this row, which is what scopes pruning

drizzle/0068 — the `@scp/iac` stack whose apply owns this row, or NULL. This is what scopes PRUNING: an apply deletes exactly the live rows carrying its own stack name that its manifest no longer declares (`iac/plan-diff.ts`'s `isStackManaged`).

SERVER-WRITTEN ONLY, and that is the whole point of it being a column. It lived in `labels` until 0068, where the prune TARGET could rewrite it under plain `object:write` — enrolling an arbitrary object into a stack's delete pool, or walking its own object out of one. The sole writer is `iac/stack-ownership.ts`, called from the IaC apply path; no request body can reach it and no route passes it, exactly as for `origin_domain_id`, `provenance` and `domain_local`.

DOES NOT FEDERATE, deliberately: it is absent from the journal payload, so a replica arrives owned by nobody. That is the truth — the importing domain's IaC does not manage a row another domain authored — and it is a bonus over the label scheme, under which a peer's `scp:stack=X` did land here (labels ARE in the payload) and would join a local stack X's prune pool. That consequence is READ FROM THE CODE, not reproduced against two live domains; see `iac/stack-ownership.ts` for the chain and the caveat.

### §45. Mirrors the object labels an IaC apply stamps

M2 step 3 addition (BUILD_AND_TEST.md §8 M2 item 4, drizzle/0005_plans.sql) — mirrors `objects.labels`. An IaC apply writes `scp:managed-by`/`scp:stack` here, but SINCE drizzle/0068 THOSE ARE A DESCRIPTIVE MIRROR THAT SCOPES NOTHING: pruning reads `managed_by_stack` below. This map is writable by the endpoints' owners, which is exactly what made the previous "pruning convention" a delete decision its own subject could rewrite.

### §46. drizzle/0097 — object type ids this role may be bound at

drizzle/0097 — object type ids this role may be bound at. NULL = ANY scope, which is what the five built-in ladder rows carry and must keep carrying (their live bindings predate the column).

**ENFORCED SINCE role-model.md §5 step 5** — `authz/role-binding-door.ts`'s `assertRoleBindableAtScope`, called by `POST /api/v1/role-bindings`. GRANT ONLY: a revoke deliberately does not re-check it, or every binding already written at a nonsensical scope would become permanent, and cleaning those up is half the reason the column exists.

THE DATABASE STILL ENFORCES NOTHING and that is unchanged: `scope_object_id` is a bare `uuid NOT NULL REFERENCES objects(id)` with no type constraint, so a row written by hand SQL or restored from a dump can still point at a `user` or a `change`. Such a binding is inert — until `objects.domain_id`, which carries no type constraint either, parents something under it and it suddenly confers authority (role-model.md §1.3h). The door is the only layer that sees this, which is why the check is at the door and not here.

### §47. Partial, so an org may reuse a built-in role name

drizzle/0097 — PARTIAL, so an org's own custom roles may reuse a built-in name; the collision that matters is between the SHARED SINGLETON rows every org reads through the `roles` RLS `USING (... OR org_id IS NULL)` clause. Without it, 0002's seed `INSERT ... ON CONFLICT DO NOTHING` has no arbiter index and can never fire, so re-running that seed forks "Owner" into two rows that `findFirst` picks between arbitrarily.

### §48. The org-scoped counterpart the earlier index left uncovered

drizzle/0103 — the org-scoped counterpart 0097 deliberately did not cover. Without it an org can hold two roles both named 'Release Captain' with different permission arrays: nothing MISRESOLVES (bindings take a role by id), but the catalogue becomes unreadable and a revoke names one of two rows an operator cannot tell apart. A built-in's name stays creatable here on purpose — that collision is refused at the authoring and binding doors, not in the DDL.

### §49. The stack that created this binding, or null when granted

drizzle/0108 — the IaC stack that created this binding, or NULL for one granted through `POST /role-bindings` or at bootstrap.

⚠️ UNLIKE EVERY OTHER `managed_by_stack`, pruning here revokes a PERSON'S ACCESS rather than a capability: an apply that no longer declares a binding DELETES it. NULL is what keeps that safe for hand-granted rows — a manifest can only ever prune bindings carrying its own stack name, so an unrelated stack cannot touch an Owner binding somebody granted by hand.

WHY THIS TABLE CARRIES THE COLUMN WHEN THE PROJECTIONS DO NOT (asked and answered 2026-08-28): `pipeline_hooks`, `component_rollouts`, `component_convergence`, `source_mappings` and `executor_bindings` deliberately have NO `managed_by_stack` — each hangs off a component, so ownership DERIVES and there is exactly one owner question with one answer. A second column there could only ever disagree with the parent. A role binding has no such parent: it hangs off a SUBJECT and a SCOPE, which may be owned by different stacks or by none. `objects` and `relationships` carry the column for the same reason. The rule is "no natural parent", not "IaC can write it".

### §50. drizzle/0097 — the NATURAL KEY of a grant

drizzle/0097 — the NATURAL KEY of a grant. Without it a write door creates duplicate grants that are individually revocable and COLLECTIVELY still granting: revoke one, the other still grants, and the revoke reports success. That is why this lands BEFORE the role-binding API, not with it.

### §51. Classified by exact string equality, never by coercion

drizzle/0097 — `hasPermission`/`hasRoleAtScope` classify with exact string equality (`effects.includes("deny")`, then `includes("allow")` — authz/resolve.ts:285-286, :353-354). So 'ALLOW' or '' grants nothing AND denies nothing: a silently inert row that reads as authority. Deleting this CHECK re-opens that; the database is the only layer that sees every writer.

### §52. Strictly-monotonic insertion-order tiebreaker

Strictly-monotonic insertion-order tiebreaker — audit_events chain appends are serialized per org via `pg_advisory_xact_lock` (apps/server/src/audit/audit-repo.ts), but two events committed within the same microsecond can still share `occurred_at`, and UUIDv7's random low bits are not a true insertion-order counter. `seq` is DB-internal only (never exposed by the API — the public `AuditEvent` shape stays exactly DESIGN.md §4.3's columns).

### §53. IaC plans (BUILD_AND_TEST.md §8 M2 item 4, DESIGN.md §15)

IaC plans (BUILD_AND_TEST.md §8 M2 item 4, DESIGN.md §15) — a `plans` table is a "projection table for hot lifecycle state" (DESIGN.md §4.1): unlike M2 step 1's typed registries (which deliberately reused objects/relationships), a plan has its own lifecycle (pending -> applied, or stale) and needs real columns for that, so it's a dedicated table referencing the graph only loosely (via URNs inside `manifest`/`diff`, not a `object_id` FK — a single plan touches many objects, not one). TENANT data (org_id-scoped, not auth substrate), so it needs the same RLS treatment as objects/relationships — hand-authored in drizzle/0005_plans.sql, same pattern as 0002_rls_rbac_seed.sql §2.

### §54. M3 Change Coordination Engine

M3 Change Coordination Engine (DESIGN.md §9, §10.4, BUILD_AND_TEST.md §8 M3). Hand-authored grants/RLS/seed data in drizzle/0007_change_coordination.sql (same pattern as 0002/0005).

`changes` is the projection table DESIGN §9.1 specifies verbatim, plus M3 additions: watchdog bookkeeping (`state_entered_at`/`last_heartbeat_at`/`watchdog_flagged_at` — §9.4), the compiled-plan's topology pin, and rollback linkage (a rollback is its OWN Change row, `rollback_of_object_id` pointing at the change it reverts — §9.4).

### §55. The raw delivery payload, plus the canonical keys lifted from it

The raw delivery payload kept verbatim, plus CANONICAL keys lifted from it by `coordination/webhook-processor.ts`'s `canonicalizeSourceRef`: {repo, ref, commit, run_url, workspace, artifact_digest,                       // the artifact this release promotes (M15.3c/M17.1, //   ADR-0013 — what the scan gate binds to) sbom: {format, specVersion?, digest, location, mediaType?, signatureRef?, scanner?, scannerVersion?, generatedAt?}, // M17.2, ADR-0015 §5 — a REFERENCE to the //   EXECUTOR's build-time, cosign-signed-at-origin //   SBOM. SCP never generates, signs, or stores the //   document bytes; only this reference. Typed as //   `SbomRefSchema` (@scp/schemas supply-chain.ts). ...} jsonb ⇒ every one of these is zero-migration.

### §56. MAJOR #6 fix

MAJOR #6 fix (PR #7 review — "batch starvation"): set by `coordination/reconcile.ts` when an `executing` change's active wave has `failed` and is awaiting an operator's manual cancel/rollback (M3 has no auto-retry). That branch never otherwise touches `changes` at all, so `updated_at` would sit frozen forever and — under `listChangeRowsInStates`'s oldest-`updated_at`-first, capped batch — 25+ such parked changes would sort ahead of every newer, genuinely-progressing `executing` change and starve it out of every batch indefinitely. `listChangeRowsInStates` filters this column `IS NULL`, so a parked change simply stops occupying batch slots until an operator acts (via the API directly, never through this batch listing — see reconcile.ts's doc comment on the `failed` branch).

### §57. THE RECONCILE ROUND-ROBIN CURSOR

THE RECONCILE ROUND-ROBIN CURSOR (migration 0056) — engine scheduling state, and the ONLY column `listChangeRowsInStates` orders by. "When did the engine last take this change's turn", which is a queue position and NOT a fact about the change.

It exists because `updated_at` used to carry both meanings at once. The engine serves `ORDER BY <cursor> ASC LIMIT BATCH_LIMIT`, and five reconcile paths re-stamp a change they examined but could NOT advance so it goes to the back of the queue — without that, >BATCH_LIMIT stuck changes own every batch slot forever and everything behind them is never evaluated even once (measured: 13 days of stopped production coordination behind green health checks, homelab 2026-08-01 — see reconcile.ts's gate-blocked bump). Sharing `updated_at` for that made the API-visible `Change.updatedAt` read "1s ago" for a change that had done nothing for three days.

THE SPLIT IS STARVATION-SAFE BY DIRECTION, which is the property to check when touching this. The guarantee needs the not-advanced paths to push a change BACKWARD in the queue; every other write that used to move `updated_at` incidentally (a transition, a `source_ref` stamp, a park) now leaves the cursor alone, which can only make a change be served SOONER. Nothing that could delay a change was removed.

DELIBERATELY UN-INDEXED. `changes_org_state` already narrows the candidate set to one org and state; adding a btree on this column would defeat HOT updates for the per-tick bump — index churn on exactly the write that fires most often (ADR-0024's cost lesson, one write class over). `updated_at`, which this replaces in the ORDER BY, was never indexed either.

NOT ON THE WIRE, like `reconcile_blocked_at` beside it. See `Change`'s `updatedAt` docblock in `@scp/schemas` for the reasoning.

### §58. Legal lifecycle edges

Legal lifecycle edges — DESIGN §9.1 "Legal transitions are data". This table mirrors `coordination/transitions.ts`'s `LEGAL_TRANSITIONS` constant exactly (seeded in the migration, cross-checked by an integration test) so the state machine's shape is queryable data, not just an in-process constant — while `coordination/transition.ts`'s guarded transition function uses the pure TS function as its legality gate (BUILD_AND_TEST.md §4.1: "anything testable as a pure function must be written as a pure function" — the exhaustive unit test needs no Docker).

### §59. The gate-binding SEAM

The gate-binding SEAM (BUILD_AND_TEST.md §8 M3 item 1: "gates are minimal here — M4 adds policy/controls; model the binding seam now"). Nothing in M3 writes rows here (no API exposes it yet — that's M4's policy engine); `coordination/gates.ts` queries it and, finding none, always returns an `allow` verdict. The shape exists so M4 can bind real controls to a lifecycle edge or a wave boundary without redesigning the guarded transition function.

### §60. Decision records (DESIGN §10.4)

Decision records (DESIGN §10.4) — the explainability funnel. Every engine verdict (lifecycle transition, gate check, watchdog flag, rollback trigger, plan compile) persists exactly one of these with its full input context and a structured reason tree, independent of whether the verdict allowed or blocked anything.

### §61. The RECONCILE HOT PATH's exact shape

The RECONCILE HOT PATH's exact shape (`decisions-repo.ts`'s `latestDecisionForSubjectKind`: org + subject + kind, newest first, LIMIT 1). Neither index above covers `kind`, so it is a HEAP FILTER and the scan walks every one of the subject's other-kind rows above the newest match — measured at 12M rows: 22.8 s / 402,430 buffers for a probe that returns NO row, 0.3 ms with this index (drizzle/0044 carries the full before/after EXPLAIN and the write cost). With `kind` in the key, every probe is one index descent whatever else the subject holds. `id DESC` CLOSES THE KEY, and it is load-bearing for a reason that is NOT about the answer — see the identical note on the block index below, and drizzle/0069 for the measurements.

### §62. The SERVICE BOARD's shape

The SERVICE BOARD's shape (`decisions-repo.ts`'s `latestBlockDecisionForSubject`, once per board row): org + subject + the latest `block`. PARTIAL, because `block` is the only verdict that query is ever issued with — so `verdict` becomes the index PREDICATE rather than a heap filter, and a change that NEVER blocked (the common case) is answered by an index descent that finds nothing instead of a walk over its whole history. Measured at 12M rows: 45.8 ms / 20,526 buffers fully cached to return NO row, 0.070 ms / 13 buffers with this index (drizzle/0046 carries the full before/after EXPLAIN and the write cost).

`id DESC` CLOSES THE KEY, AND IT IS THE DIFFERENCE BETWEEN THIS INDEX BEING USED AND NOT BEING USED. The read ends `ORDER BY created_at DESC, id DESC`; an index that stops at `created_at DESC` supplies only a PREFIX of that order, so every plan using it carries an `Incremental Sort` above it — and a sort node's STARTUP cost is exactly what `LIMIT 1` cannot amortise. `decisions_org_created` below supplies the whole order sortlessly, so the planner prices it at `1/estimated_matches` of its length and prefers it the moment statistics make a match look near, then applies `subject_id`/`verdict` as a heap FILTER and walks the ORG's entire stream. This comment previously argued the opposite — that a `LIMIT 1` query needs no tiebreak in its index because a tiebreak "cannot change the answer". It cannot; that was never its job here. drizzle/0069 carries the before/after plans and the CI failure (`expected 804 to be less than or equal to 10`) that this cost.

### §63. `GET /decisions?kind=…` WITHOUT a subject (ADR-0028 increment 4)

`GET /decisions?kind=…` WITHOUT a subject (ADR-0028 increment 4) — the operator who knows the coupling but not the change id. Every index above leads with `subject_id` or omits `kind`, so that filter was a PARALLEL SEQ SCAN of the whole table, sorted: measured at 4M rows, 100.0 ms / 55,650 buffers and every row scanned to return 101, versus 0.098 ms / 8 buffers with this index (drizzle/0056 carries the full before/after EXPLAIN and the write cost). `created_at, id` closes the key because that is the keyset cursor's ordering verbatim, so a page costs one descent and no sort. That is the same reason the two indexes above now close theirs (drizzle/0069): "no sort node" is a property every one of these ordered reads needs, `LIMIT 1` included — this index is also the RIVAL that won whenever they lacked it.

### §64. Glob matched against the event's git REF

Glob matched against the event's git REF (`refs/heads/dev`), migration 0057 / ADR-0030 §1. The third routing glob and a PEER of the two above, not a rank above them: paths and refs are orthogonal, and the same directory on two branches is two pipelines — which no path glob can express. NULL matches EVERY ref (the matcher skips a null one, exactly as it already does for the other two), so every mapping written before 0057 keeps its behaviour unchanged.

### §65. WHICH pipeline of that component this source drives

WHICH pipeline of that component this source drives — the routing Type (ADR-0007, migration 0026; was `purpose` in 0024). A change IS a release and comes from ONE source per pipeline, so the mapping is where the release declares its Type — deliberately NOT inferred from source_kind, because `github` can run Terraform OR deploy an app. Defaults to 'configuration'. Plain text (no pg enum / CHECK): the closed value set is enforced in packages/schemas (Zod).

### §66. The operator's DECLARED classification of this pipeline

The operator's DECLARED classification of this pipeline (`dev`|`beta`), migration 0057 / ADR-0030 §2. UI and reporting read THIS; nothing parses the branch name looking for "dev". A label named after WHICH BRANCH MATCHED goes false the moment that branch covers a second kind — a failure already shipped once here (charter principle 6).

NEVER an enforcement input (ADR-0030 §3): it is not threaded into the export gate, and forging or removing it changes no gate outcome. Enforcement keys on the path — a change targeting no federation peer never reaches `exportPromotionBundle`. Plain text (no pg enum / CHECK), like `type` above: the closed value set is enforced in packages/schemas (Zod).

### §67. The operator's declared provenance for this mapping's repo

The operator's DECLARED provenance of this mapping's repo, migration 0062 / outpost-ui.md §9.3a (owner, 2026-08-14). A component spans domains and its ONE pipeline has inputs of two provenances: globally SHARED repos authored at the commander, and DOMAIN-SPECIFIC repos tracked only by this domain's outpost. Where a domain holds a COPY of a shared repo (the owner's row 2 — "IaC shared source → IaC repo, domain-B copy → component (domain B)"), that mapping is physically local but its provenance is the commander. `true` declares exactly that: "this repo mirrors a commander-shared source". NULL/false = domain-specific (the owner's row 3), which is also every pre-0062 row's meaning unchanged.

DECLARED, never inferred — same discipline as `classification` above and for the same charter-6 reason: guessing "shared" from the repo host or a name pattern would label a domain's classified network repo as shared the moment it lived on the same Gitea. And NEVER an enforcement input: it grants and withholds nothing; the UI groups the source lane by it and reporting may read it, and that is all.

### §68. The operator's PAUSE SWITCH, migration 0063

The operator's PAUSE SWITCH, migration 0063 (owner ask 2026-08-14, UI source-lane enable/disable). A mapping stays DECLARED but routes nothing while disabled — distinct from delete, which forgets the rule entirely. `correlation.ts`'s `matchComponentForSource` skips a disabled row as its first filter, so this is an ENFORCEMENT input (unlike `classification` and `mirrorOfShared` above): a caller flipping it changes what a push actually correlates to, not just how it renders. `NOT NULL DEFAULT true` — every pre-0063 row was already routing, so the default preserves that behaviour with no backfill.

### §69. A timed close, read together with `enabled`

TIMED CLOSE (owner, 2026-08-14: "disable for x period of time or until manually enabled again"), migration 0064. Read together with `enabled`, exactly the way a freeze window is read (governance/freezes-repo.ts): NO timer job re-opens anything — the correlation matcher evaluates `now()` at every push. Three states: enabled=true → open (this column ignored); enabled=false, disabled_until NULL → closed until an operator re-opens; enabled=false, disabled_until = T → closed while now() < T, then OPEN again automatically, on time, with zero moving parts. `enabled` stays the operator's declared intent; this column bounds it.

### §70. The operator's declared reach for this mapping's repo

The operator's DECLARED reach of this mapping's repo, migration 0066 / pipeline-substrate-registry-scan.md §10.6 (owner, 2026-08-16): `global` = a cross-domain shared repo authored and tracked at the commander; `domain` = tracked only in one domain. NULL = NOT DECLARED → the pipeline renders NO label and NOTHING is inferred (not from the site's federation role, not from the repo host, not from a name pattern) — a pre-0066 row on the commander is not thereby global. Orthogonal to `mirrorOfShared` above (a `domain`-scope mapping may mirror a global one; the mirror wins the eyebrow). Like `classification` and `mirrorOfShared`, NEVER an enforcement input: `correlation.ts` does not read it (pinned by source-mapping-scope.integration.test.ts). Plain text with a CHECK on the two values — the value set is closed at both ends because a third value would render as no label, silently.

### §71. Webhook ingress: persist-then-process

Webhook ingress: persist-then-process (DESIGN §8 "Webhook ingestion: raw payload persisted first (signature-verified), then processed as an event — replayable and auditable"). The route handler only verifies the signature and inserts a row; `coordination/webhook-processor.ts` (invoked via pg-boss, same tick loop as reconciliation) turns unprocessed rows into Changes.

### §72. M7 (MAJOR #5, adversarial review)

M7 (MAJOR #5, adversarial review): the PROVIDER's own delivery identity — GitHub's `X-GitHub-Delivery` (unique per delivery, stable across a redelivery of the same event), or a `payload-sha256:<hex>` of the raw body when no delivery header exists. A unique index on `(org_id, source_kind, dedupe_key)` makes a redelivered/replayed (even validly-signed) webhook a no-op instead of a second Change → second real workflow_dispatch/sync/apply. The PK `id` is freshly minted per HTTP request and is NOT this key (that was the bug).

### §73. The authenticated principal that reported this event

ADR-0028 (migration 0054): the authenticated principal that reported this event. The processor runs as SYSTEM_ACTOR_ID — right for the CHANGE, since nobody asked for it — but a declared `stageDependencies` on the same body MINTS a `depends_on` edge, and an edge write attributed to the system actor leaves "who declared this?" unanswerable in the audit chain, the federation journal and the emitted event. NULL for observe()-driven rows (no principal exists) and for rows written before 0054; the processor falls back to the system actor.

### §74. observe()-driver watermarks (M10.2)

observe()-driver watermarks (M10.2) — one cursor per (org, executor plugin INSTANCE) that the pull-based change-detection loop (`coordination/observe.ts`) passes to `ExecutorPlugin.observe(since)`. Bindings that share a `plugin_instance_id` share observe scope (identical configured source), so the cursor is instance-scoped, not binding-scoped. The loop polls each observe-capable binding, normalizes returned events into `change_source_events` (the SAME queue the inbound-webhook route feeds — poll-vs-push equivalence, DESIGN §12), and advances `cursor_token`. This is the fallback for connected-but-unwebhookable and air-gapped domains whose executors cannot reach SCP's ingress. Upsert-in-place only (no delete route).

### §75. Latest object health

Latest object health (observe-enrichment signal 4; ADR-0008 decision 4) — an object-referencing PROJECTION table keyed by `objects(id)` (DESIGN §4.1's "thin projection tables that reference their graph object" pattern, same class as `changes.objectId`, `freezes.scopeObjectId` and `executorObserveCursors`), NOT a new top-level concept table (charter principle 2). It projects the hot latest-health state of an EXISTING graph object; it does not introduce a new first-class concept, registry, or relationship.

INVARIANT (coordinate-not-execute, principle 1): SCP never probes/polls/computes health. This row is written ONLY by a PUSH-IN (owner PUT today; a future opt-in health-source binding writes the SAME row via `source`). One latest row per (org, object), UPSERT-IN-PLACE (no delete route), mirroring `executorObserveCursors`. Per-observation history is a deferred non-goal (ADR-0008).

### §76. Plan -> waves -> wave_targets ROWS (DESIGN §9.3)

Plan -> waves -> wave_targets ROWS (DESIGN §9.3) — the compiled execution shape of a Change. Named `change_*` to avoid colliding with M2's unrelated `plans` table (`@scp/iac` desired-state plan/apply). `topology_document` is a snapshot of the release topology at compile time (not a live FK dereference) so a later topology edit never retroactively changes an in-flight plan — consistent with DESIGN §10.1's "policies are versioned documents" pinning pattern.

### §77. Last status() stateRef reconcile observed

Last status() stateRef reconcile observed — the synced revision it previously computed and discarded (ADR-0008 decision 1; docs/proposals/observe-enrichment.md signal 1). Additive/ nullable, null until the first successful observe; a status() with no stateRef never nulls a previously-captured value (updateWaveTargetObserved writes it only when defined).

NOT AS-IS — the claim this comment made until M23.1g, and M23.1f made it false. Everything in this column is plugin-supplied and passes `boundPluginJson` on the way in: a string may be shortened, a list may lose its tail, U+0000 and lone surrogates become U+FFFD. What was removed is written into the SAME jsonb under `truncation`, per field, so a reader is never left to infer a cut from a suspiciously short value — and so `no rollout` and `we cut the rollout` stop being the same bytes (`ChangeWaveTargetSchema.observed.truncation`). `observedAt` is stamped here too and is deliberately NOT on the API.

### §78. The target's status, where `no_executor` is fail-closed terminal

pending|triggering|triggered|observing|succeeded|failed|aborted|no_executor `no_executor` (docs/adr/0006): fail-closed terminal — the target has real executor bindings but NONE for the Type this wave rolls, so reconcile refused to fake-succeed the gap. Plain text column (no Postgres ENUM / CHECK), so the value is additive with no migration; the read schema (ChangeWaveTargetSchema.status) is already `z.string()`, so the API is additive too.

### §79. M4 Governance Engine

M4 Governance Engine (DESIGN.md §10, BUILD_AND_TEST.md §8 M4). Hand-authored grants/RLS in drizzle/0010_governance.sql (same pattern as 0002/0005/0007). Policies and Controls themselves are NOT new tables — they are graph objects of the pre-seeded `policy`/`control` types (0002 §5), managed through typed-registry endpoints exactly like `release-topology` (0007 §9): the document lives in `objects.properties`, and the document's own version is `objects.version` (bumped on every update) — the same pinning pattern `change_plans.topology_version` already uses. What DOES need new projection tables is everything with real lifecycle/quorum state that the graph's generic model has no place for: control run evidence, approval quorum, and freezes.

THAT LAST CLAUSE WAS NARROWED BY OWNER DECISION D6 (M25.7, ADR-0043) — READ BOTH HALVES
It used to be flat: a freeze was not a graph object and never could be, and this line is the PRIMARY SOURCE the rest of the codebase cited for that — `drizzle/0089` and `governance/freeze-object.ts` both quote it by line number. Left as it stood it would keep asserting, from the file the citations point at, exactly what the citations say was retracted.

THE DISTINCTION THAT SURVIVES, and it is a real one rather than a hedge:

```text
* A freeze's ENFORCEMENT STATE still has no place in the generic object model. The window
  predicate `starts_at <= at < ends_at AND lifted_at IS NULL` is evaluated on a hot gate path
  by `activeFreezesInWindow` — the single owner of that comparison — and re-expressing it as
  jsonb comparisons would put a second copy of it in the system. That is why `freezes` (below)
  STAYS, unchanged, and why every reader that BLOCKS still reads it.
* A freeze's WIRE FORM is now a `freeze` graph object (drizzle/0089), for one reason: nothing
  table-shaped can cross a security boundary. `JournalEntryKindSchema` admits nine kinds and
  none is freeze-shaped, and widening it is both an oasdiff response break and a fail-closed
  cliff at an un-upgraded peer — so an object on the existing `object_upsert` is the only
  route a freeze has. `federation/import-repo.ts` rebuilds the projection row from it at the
  receiving instance, which is what makes an imported freeze actually block.
```

So: object PLUS projection (the pattern `changes` and `campaigns` already use), opt-in per freeze (`freezes.object_id IS NULL` is the default and the whole pre-M25.7 estate), and org tier only — `instance_freezes` (drizzle/0086) has no `org_id` and does not federate under any decision (ADR-0040). Control run evidence and approval quorum are untouched by D6: both clauses above still hold for them flatly.

### §80. Binds a control object to a concrete plugin implementation

Binds an abstract `control` graph object to a concrete ControlPlugin implementation (DESIGN §10.2: "ControlPlugin implementations are bindings — swapping Trivy for Snyk... changes a binding, never a policy"). `pluginModule`/`pluginInstanceId` feed the exact same `PluginHostInstanceConfig` shape the M3 executor plugin host already uses (plugin-host/contract.ts) — control plugins run under the identical subprocess host, just a different `PluginHost.control(instanceId)` client (plugin-host/contract.ts, host.ts).

### §81. Persisted control outcomes

Persisted control outcomes (DESIGN §10.2: "always with an evidence payload (persisted, referenced by Decisions)"). One row per control evaluation attempt against one change at one gate point; `decisionId` links back to the gate Decision that consulted this outcome.

### §82. The plugin module stamped at insert, not read back later

The `control_bindings.plugin_module` that PRODUCED this run, stamped at insert (0063). Deliberately not read from the binding at query time: a binding is mutable, so re-pointing one control at `github-check` would retroactively relabel every historical run of it as "the component's own checks passed" — which is the label `dependencies/bump-actuator.ts` grants an unattended merge on. NULL on pre-0063 rows and on rows no bound plugin produced.

### §83. 0065 — the composite-FK target for `scan_findings`

0065 — the composite-FK target for `scan_findings`. `id` is already the primary key, so this adds no new uniqueness; it exists so a `(org_id, control_run_id)` foreign key has something to reference, which is what makes "a finding cannot point at another org's scan" a STRUCTURAL barrier rather than a repo-layer habit (0061 could not do this for its `objects(id)` references and says so).

### §84. A materialized N-of-M approval requirement

A materialized N-of-M approval requirement (DESIGN §10.2: "approval control instances materialize as approval tasks"), one row per (change, firing policy, policy version, effect) — re-derived idempotently by governance/gate evaluation every time it runs (the unique key below makes creation an upsert-shaped no-op on repeat). `policyVersion` pins the exact `objects.version` of the policy that was in force when this request was created, so the requirement stays reconstructible even if the policy document is edited later (DESIGN §10.4).

### §85. One individual approval vote

One individual approval vote (DESIGN §10.2 "approval attestation"). The unique key is the DB-enforced core of N-of-M quorum integrity — SECURITY-SENSITIVE (BUILD_AND_TEST.md §8 M4): it makes "the same actor voting twice" a constraint violation, not just an application-layer check that a bug could bypass. `attestation` holds the Ed25519-signed canonical record (governance/attestation.ts) binding voter + approved object + decision id + timestamp (DESIGN §10.2), independent of this row's own columns so the signed payload is self-contained and portable (it is exactly what a future federation Promotion Bundle carries — DESIGN §13).

### §86. Freeze windows (DESIGN §10.3)

Freeze windows (DESIGN §10.3): "a built-in policy effect with time windows and scope (org/domain/service/component)." A dedicated projection table because a freeze's whole enforcement state is a time window + scope + reason, queried on a hot gate path, and `/freezes` is its own top-level API resource per DESIGN §6.

M25.7 / OWNER DECISION D6 (ADR-0043) — "NOT A GRAPH OBJECT" IS NO LONGER TRUE, AND THAT SENTENCE USED TO BE HERE. A freeze that opts into federation (`object_id` non-null) ALSO gets a `freeze` graph object, because the sync journal has nine entry kinds, none freeze-shaped, and widening that enum is both an oasdiff response break and a fail-closed cliff at an older peer — so the object is the only way a freeze can cross a boundary. This table STAYS: the object is the wire form, this row is the enforcement form every reader already composes over (`activeFreezesInWindow` and everything above it). Object-plus-projection, the pattern `changes` and `campaigns` already use.

### §87. Whether this freeze still parks a whole wave

M25.2 / owner decision D5 (drizzle/0084) — WHETHER THIS FREEZE STILL PARKS A WHOLE WAVE. `false` (the default, and retroactively true of every freeze authored before M25.2): the covered wave targets are held one by one in `coordination/reconcile.ts`'s trigger loop and their uncovered siblings ship. `true`: any coverage parks every target of the wave — the pre-M25.2 behaviour, for coupled targets where half-applied is worse than not-applied. Read in exactly one place: `gate-orchestrator.ts`'s `partiallyFrozen` predicate.

### §88. This freeze was retracted: a soft lift, regardless of end

M25.1 (drizzle/0085) — THIS FREEZE WAS RETRACTED, and is no longer in force regardless of `endsAt`. A SOFT lift, following `personal_access_tokens.revoked_at`: the row stays readable by id forever, because two Decision writers put `freeze.id` in their `inputContext` and a hard DELETE would dangle every one of them (charter principle 6 — a blocked response stays reconstructible).

FILTERED IN EXACTLY ONE PLACE: `governance/freezes-repo.ts`'s `activeFreezesInWindow`, the single function that knows the window predicate. Every "is this freeze in force" consumer composes over it, so one `IS NULL` retires a freeze on every path at once; a second liveness filter elsewhere is the drift hazard that once made a service-scoped freeze fail OPEN. `listFreezes`/`getFreeze` deliberately do NOT filter — lifted is a FIELD, not an absence.

### §89. The id of this freeze's graph object, or null when local

M25.7 / owner decision D6 (drizzle/0089, ADR-0043) — THE ID OF THIS FREEZE'S `freeze` GRAPH OBJECT, or NULL when this freeze does not federate.

NULL IS THE DEFAULT AND THE STATUS QUO. Every freeze authored before M25.7 has it, and a `POST /api/v1/freezes` that omits `federate` still produces one — byte-identical behaviour on every path. D6 adds a new REACH, and a new reach never defaults on.

Non-null means two things at once, and they are the two halves of the feature: the object rides `object_upsert` to a peer (there is no freeze journal kind and there cannot be one — see drizzle/0089's header), and THIS ROW BECOMES REPLICA-AWARE. `freezes-repo.ts`'s `lockFreezeRow` — the read half of both write verbs — refuses a lift or a window edit when the named object is authoritatively owned by another domain, so an outpost cannot lift a commander freeze; its remedy is `freeze:override` at the replica's own scope.

No FK, matching `scope_object_id` and both `*_actor_id` columns.

### §90. The Ed25519 keypair this domain signs attestations with

Ed25519 keypair this domain signs approval attestations AND (as of M6) sync-journal entries/bundles with (DESIGN §10.2/§13: "the domain instance signs (Ed25519 domain key)"). Generated once per org on first use (governance/attestation.ts `ensureInstanceKey`), same trust tier as `SCP_COOKIE_SECRET` — a server-side secret, never sent to clients.

M6 CHANGE (org-scoped — M4's own doc comment anticipated exactly this: "multi-org attestation verification is out of M4 scope (no federation yet — M6)"): originally a single fixed-id row with "no org scoping, no RLS" under the reasoning that DESIGN's "domain key" is one key per SCP INSTANCE (= federation domain), and a real deployment has exactly one org per instance anyway (charter: "MSPs needing hard isolation run one instance per customer"). Scoped by `org_id` here — matching `federation_self`'s own scoping decision (schema.ts's M6 section doc) — for two reasons: (1) it lets federation's Testcontainers-level integration tests model two distinct "domains" as two orgs sharing one test Postgres instance with genuinely DIFFERENT signing keys, which the M6 DoD's tamper/signature tests require; (2) it keeps every federation identity concept (self, peers, journal, signing key) consistently scoped the same way.

M8 SECURITY-PASS FIX (drizzle/0016_instance_keys_rls.sql): the M6 org-scoping change above left this table WITHOUT an `org_isolation` RLS policy — its "no RLS" reasoning predates M6 and was written for a single GLOBAL row ("same treatment as state_transitions"), a premise the M6 change made false but the policy was never revisited to match. Once this table held one PRIVATE SIGNING KEY PER ORG in a table shared across every tenant, that gap meant a single forgotten `org_id` filter (an app bug) — with no independent DB-level backstop — could leak one org's federation/ attestation signing key to another org's request context, violating DESIGN.md §4.2's non-negotiable "two independent failures" invariant. Now has full RLS, matching every other tenant-scoped table; `ensureInstanceKey`'s only call sites already run inside `withTenantTx` (it takes a `TenantTx`), so this closes the gap with no impact on the legitimate access path.

### §91. M17.3 E4 (drizzle/0030_instance_cosign_keys.sql)

M17.3 E4 (drizzle/0030_instance_cosign_keys.sql): each org's cosign MANIFEST-SIGNING keypair. Distinct from `instanceKeys` above (which holds the org's Ed25519 attestation/federation identity key): this holds the cosign keypair each org's commander signs its own promotion manifests with (E6) and whose PUBLIC half E5 distributes to outposts for verification.

DEDICATED TABLE, DELIBERATELY NOT THE `secrets` VAULT (owner decision, M17.3 grounding Area C): `secrets/secrets-repo.ts` `resolveSecretRefs` resolves any `executor_bindings.secretRefs` entry an org names into a `secrets` row and `plugin-host/host.ts` injects the plaintext into a plugin subprocess. A dedicated table is STRUCTURALLY unreachable by that path (it queries `secrets` only), so the SCP signing key can never be pulled into a plugin — the vault-exfiltration hole cannot apply. Posture MIRRORS `instanceKeys`: ORG-SCOPED (one row per org), unique(orgId), full `org_isolation` RLS. `privateKey` is cosign's empty-password encrypted PEM (`cosign.key`) — the table's RLS + dedicated-table isolation are the protection, exactly the narrow plaintext-with-RLS exception `instanceKeys` documents. `privateKey` is server-side only and is NEVER returned over any HTTP API or SDK type.

### §92. M5 Campaigns (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5)

M5 Campaigns (DESIGN.md §9.5, BUILD_AND_TEST.md §8 M5). Hand-authored grants/RLS/seed data in drizzle/0011_campaigns.sql (same pattern as 0002/0005/0007/0010).

KEY DESIGN DECISION (documented at length in 0011's own header): a Campaign is NOT a second transition-guarded state machine. `campaign` is a graph object (pre-seeded built-in types, 0002 §5); what they need beyond the generic object model is exactly what a Change needed — a compiled plan -> waves -> wave_targets shape, over the SAME `coordination/plan-compiler.ts` pure function `change_plans`/`change_waves`/ `change_wave_targets` already use. `campaign_wave_targets` differs in one way: its unit of work is an entire real M3 Change (`memberChangeObjectId`), not a direct executor trigger — see `coordination/campaign-reconcile.ts`. Campaign STATUS is a pure derived aggregation (`coordination/campaign-status.ts`), never a stored column here.

### §93. M6 Federation (DESIGN.md §13, BUILD_AND_TEST.md §8 M6)

M6 Federation (DESIGN.md §13, BUILD_AND_TEST.md §8 M6). Hand-authored grants/RLS in drizzle/0012_federation.sql (same pattern as 0002/0007/0010/0011).

SCOPING DECISION (M6 PR body): DESIGN.md's federation "domain" means a whole SCP instance (a Domain Control Plane) — a different concept from the pre-existing `domain` OBJECT TYPE (an org-internal containment node under which services/components live). This schema keeps federation identity/peers/journal ORG-SCOPED (one federation self-identity + peer set per org, same `org_isolation` RLS every other tenant table gets), because the sync journal is derived from the per-org outbox/audit stream and every row it carries (`objects`/`relationships`/ `changes`/policy/approval rows) is already org_id-scoped end to end. Per the charter ("MSPs needing hard isolation run one instance per customer"), one org per instance is the expected shape, so this collapses to one federation domain per instance in practice — nothing in the M6 DoD depends on the distinction. The Ed25519 key that SIGNS journal segments/bundles is the SAME key `governance/attestation.ts`'s `ensureInstanceKey` already manages for approval attestations — as of M6 that table (`instanceKeys`, above) is ALSO org-scoped, for exactly this reason, so "one Ed25519 identity signs both approval attestations and federation material" (DESIGN §13: "SCP performs all signing and validation itself") holds at the org-as-domain granularity this schema uses throughout.

### §94. TRUST sense (ADR-0021 D4)

TRUST sense (ADR-0021 D4) — this security domain's own stable identity (UUIDv7, generated once, never reused). NOT a containment `domain` object id.

Named explicitly because drizzle/0012 calls it `..._key`, not the `..._unique` this sugar defaults to.

### §95. Known peer domains

Known peer domains (DESIGN §13 "peer pairing"), one row per paired remote domain. `syncScope` is configurable per peer (§13: full graph / policies-only / changes-only / status-only / label-selector custom). Pairing is always initiated by dialing OUT (§13 outpost-initiated-only) or, for air-gapped peers, by an out-of-band exchange of each side's public identity (`scp federation pair`) — never a live handshake the commander initiates.

### §96. The peer's delivery target for signed channel artifacts

M13.2a (proposal §13.2) — the peer's per-peer DeliveryTarget (`DeliveryTargetSchema`, packages/schemas): where signed channel artifacts (`.scpbundle` / relay tarballs) addressed to this peer are dropped, and where inbound ones from it arrive. NULLABLE, no backfill: a NULL falls back to the instance env (`SCP_RELAY_OUT_DIR`/`SCP_RELAY_IN_DIR` — PR #112's behavior, byte-identical), so existing setups migrate as no-ops. jsonb (not columns) because 13.2b adds a `provider: 's3-compatible'` member additively — registry-shaped data, not a new table (charter principle 2).

### §97. M14.1 (ADR-0009, drizzle/0037) — per-peer poke-mode

M14.1 (ADR-0009, drizzle/0037) — per-peer poke-mode. NOT NULL DEFAULT false: default-off, so every existing peer migrates as a no-op poll-mode peer. `true` means the commander MAY send this peer a contentless wake signal and its frequent poll is disabled (full enforcement is M14.4); the M14.1 pair-time guard requires an https/mTLS-capable `baseUrl` before it can be set true. Plain boolean column (not jsonb) — a two-state switch, not registry-shaped data.

### §98. The live-pull scheduler's per-peer due state; null means now

M14.4 (ADR-0009, drizzle/0038) — the live-pull scheduler's PER-PEER due-state. All three are NULLABLE with no backfill: NULL = "never" = due now, so every pre-M14.4 row migrates as a no-op (its next tick pulls immediately, exactly as before).

`lastPullAttemptAt` is stamped by the scheduler's CONDITIONAL claim (one atomic UPDATE … WHERE last_pull_attempt_at IS NULL OR < now() - interval), so two worker replicas cannot both pull the same peer in one window — an in-memory throttle would multiply the effective poll rate by the replica count and defeat sparse mode entirely. `lastPullSuccessAt` is stamped only on an `imported` outcome, so `lastPullSuccessAt IS NULL OR < lastPullAttemptAt` IS the "last attempt failed" signal that returns a poke-mode peer to the FREQUENT cadence until one pull succeeds (the reconnect leg — no counters, replica-safe). `lastPokeReceivedAt` is stamped by the M14.2 poke handler when it ACCEPTS a poke from that caller: a peer goes sparse only once it has PROVEN pokes actually arrive (D2 self-proving), never merely because its flag is set.

NOT derivable from `sync_cursors.updatedAt`: `advanceCursor` early-returns when nothing advanced, so an idempotent no-op pull leaves that timestamp untouched — it records applied progress, never a pull ATTEMPT.

### §99. Peer public-key history

Peer public-key history (rotation via signed journal events, DESIGN §13). Exactly one row per peer has `supersededAt IS NULL` (the current key) at any time — `federation-repo.ts` enforces this invariant on rotation rather than a DB constraint (a partial unique index would need a fixed sentinel for "current", which `NULL` already conveys unambiguously per peer).

SECURITY-SENSITIVE (M6 review fix — CRITICAL: rotation gave no compromise recovery). Key validity is anchored to the AUTHENTICATED, monotonic journal SEQUENCE, never to a self-declared timestamp an attacker can choose. On rotation, the OLD key records `supersededAtSequence` = the highest origin sequence this domain had verifiably applied from that peer (from `sync_cursors`); the NEW key records `effectiveFromSequence` at the same anchor. A key verifies entry with sequence S iff `effectiveFromSequence < S AND (supersededAtSequence IS NULL OR S <= supersededAtSequence)`. Because every future import applies only entries with sequence > the cursor (>= the anchor), a rotated-away (compromised) key can never verify any content that will ever be applied — rotation HARD-revokes it. The `effectiveFrom`/`supersededAt` TIMESTAMP columns are retained for display/audit only and are NEVER consulted for verification.

### §100. The peer's cosign key, riding the same key window as Ed25519

M17.3 (E5) — the peer's cosign MANIFEST-VERIFICATION public key (`cosign.pub` PEM), riding in the SAME key-window row as its Ed25519 `publicKey`: distributed via the existing out-of-band pairing exchange (zero new transport) and rotated by the SAME supersede mechanic (a changed Ed25519 OR cosign pubkey opens a new window). Nullable — a peer paired before E5, or one that never supplied a cosign key, has none. Verification against it is E6/M17.4; E5 only registers it. NEVER the private half.

### §101. The append-only Sync Journal (DESIGN §13 core)

The append-only Sync Journal (DESIGN §13 core) — every row hash-chained AND Ed25519-signed, monotonic `sequence` PER (org, origin domain) — see the scoping decision above. Stamps `(origin_domain_id, sequence, content_hash)` per DESIGN §13, plus the two v1-unused reserved fields (`baseRevision`, `conflict`) the overlay decision insures against a future format break. `seq` (identity) is a DB-internal insertion-order tiebreaker only, mirroring `audit_events.seq` — never part of the signed/hashed payload.

### §102. The imported `rowHash` of the entry at `lastAppliedSeq`

The imported `rowHash` of the entry at `lastAppliedSeq` — SECURITY-SENSITIVE: this is what lets a RESUMED import verify true hash-chain continuity across separate import calls (not just internal-to-one-bundle contiguity). Without it, an attacker controlling a later bundle could splice in a fabricated sub-chain starting at `cursor + 1` with a `prevHash` that matches nothing real, and `verifyJournalChain` would have no prior tail to check it against. NULL until the first entry from this (peer, origin) pair is applied.

### §103. ONE-SHOT RE-ANCHOR PERMIT

ONE-SHOT RE-ANCHOR PERMIT (drizzle/0042) — SECURITY-SENSITIVE, and deliberately writable only from a LOCAL, AUTHENTICATED OPERATOR ACTION that declares this peer's own `sync_scope`: today `pairPeer` (`POST /v1/federation/peers`) and `updatePeerTransport` (`PATCH /v1/federation/peers/{id}`, M16.2 phase A E4 — which re-applies this guard precisely so widening a scope to `full` heals a wedged cursor on BOTH scope-declaring routes rather than one). Nothing else may write it; read "`pairPeer`" below as "either of those two operator paths".

A receiver whose own `sync_scope` is narrow verifies sparse and advances this cursor with `last_applied_row_hash = NULL` (it never holds the tail entry's hash — the tail may be an entry it was never shown). That is correct while it stays narrow. When a `pairPeer` call leaves that peer's `sync_scope` at `full` — whatever it was set to before that call — while this cursor is still anchorless, the strict path has no way to link the peer's next, perfectly contiguous run to it — every subsequent import is refused forever (the one-way ratchet). Setting this column to the CURRENT `last_applied_seq` permits the next strict run to adopt its OWN first entry as the anchor, for that one cursor position only. Everything else stays strict: the run must still begin at exactly `last_applied_seq + 1`, be internally gap-free, and verify every rowHash and signature — so a re-signed run with a deleted middle entry is still refused.

Consumed by the first `advanceCursor` that records real progress (which always writes a real row hash on the strict path), and only re-issued by another `pairPeer` call that again leaves this peer at `full` with an anchorless cursor. NOTHING a peer sends can set it: no import/relay/poke path writes this column.

### §104. RAIL 4 — EXPORTER TAIL ATTESTATION HIGH-WATER MARK

RAIL 4 — EXPORTER TAIL ATTESTATION HIGH-WATER MARK (drizzle/0090, M26.2 §7.2 rail 4). A monotonic per-`(org, peer, origin)` record of the highest journal tail this side has ever seen the exporter *attest and sign* (`SyncBundle.tailAttestation`), independent of what this receiver's scope let it actually apply. This is what makes B1 (a lost/rolled-back tail after an async-replication failover) detectable for a NARROW-scope peer, where rails 1–3 are silent because that peer never holds a real anchor. NULL until the first signed attestation is seen. Verify-and-advance only: a later attestation whose `tailSequence` regresses, or whose `tailRowHash` differs at the SAME height, is a `journal_divergence` refusal — never a regression of these columns. Nothing a peer sends other than a validly-signed attestation may move them. Read/written only by `cursors-repo.ts`'s tail-attestation path.

### §105. Federation audit witness (§7.2.7, drizzle/0091)

Federation audit witness (§7.2.7, drizzle/0091) — a passive record of a peer ORIGIN's audit-chain head, persisted from the `audit_segment` journal entries importers used to discard. INFORMATIONAL: never blocks an import. The post-failover runbook compares a restored local head against peers' witnessed `(auditEventId, contentHash)` at each sequence to DETECT truncation — the one thing `scp audit verify` cannot see, since any prefix of a valid chain verifies (B2). Peers are detectors of truncation here, never sources of the truncated data.

### §106. Bundle-transfer tracking (DESIGN §13)

Bundle-transfer tracking (DESIGN §13). One row per `.scpbundle` this side produced or consumed. PER-HOP AND INSERT-ONLY — never a lifecycle (doc corrected 2026-07-29, M16.1): `created` is written by the exporter, `submitted` only by a retrans's onward drop, `confirmed` only by the receiver, each in its OWN database, and no production path ever updates a row. See `bundle-transfers-repo.ts` for the full note (including the one test-fixture update) and the UNBUILT return-path confirmation (future increment M16.4).

### §107. drizzle/0041 — HOW this transfer travelled

drizzle/0041 — HOW this transfer travelled: 'live-pull' (the federation-sync scheduler dialled the peer) or 'bundle' (a file/pushed/inbox handoff). NULL on rows written before 0041, which surfaces as `via: "unknown"` rather than a guess. Recorded at import time because that is the only moment the transport is known — no pair of stored timestamps can reconstruct it (see the migration header).

### §108. drizzle/0087 — WHICH LEG this hop was

drizzle/0087 — WHICH LEG this hop was: 'metadata' (an ordinary `.scpbundle` sync/promotion export or import) or 'bytes' (a retrans byte-relay hop). NULL on rows written before 0087 or by a writer that genuinely could not determine it — never inferred from direction/kind/status, which are identical across both channels for a `kind:'promotion'` row. See `bundle-transfers-repo.ts::recordBundleTransfer` (required-at-callsite) and 0087's migration header.

### §109. Declared for fidelity; the migration creates it concurrently

drizzle/0041 — serves `lastConfirmedSyncImportAt`, which runs per peer on every service-board render. Declared here for schema fidelity; the migration creates it PARTIAL + INCLUDE (`direction='import' AND kind='sync' AND status='confirmed'`, INCLUDE (transport)), which drizzle-kit cannot express — see 0041's header.

`DESC NULLS LAST` MATCHES THE READ, and that is the whole point of the column order here: the query orders by `confirmed_at DESC NULLS LAST` (deliberately — a NULL `confirmed_at` must not sort ahead of a real one), while 0041 built the index as bare `DESC`, which PostgreSQL reads as NULLS FIRST. Those are different orderings, so the index was INELIGIBLE for the read and every board render seq-scanned the whole never-pruned transfer ledger and sorted it. drizzle/0070 carries the plans.

### §110. The unattended inbox loop's processed-file ledger

M13.1a (proposal §13.1) — the unattended inbox loop's PROCESSED-FILE LEDGER: one row per (org, inbox dir, file name, content sha256) the loop has terminally handled, keyed on CONTENT identity so a replaced file (same name, new bytes) is processed as new while a re-listed identical file is a silent no-op. Deliberately separate from `bundle_transfers` (per-hop observational bookkeeping with no file identity — see drizzle/0034's header for the documented ledger decision). INSERT-only from the loop; files themselves are always LEFT IN PLACE in the inbox ("quarantined" is a ledger state, never a filesystem move).

### §111. M13.1b (drizzle/0047) — the staging-node AUTO-RELAY BUILD LEDGER

M13.1b (drizzle/0047) — the staging-node AUTO-RELAY BUILD LEDGER. One row per (org, LOCAL imported change) that OWES the onward byte hop, so a `role: retrans` instance builds the tarball exactly once per imported promotion, retries a transient failure, and STOPS at an operator-configured cap.

CAUSAL, NOT DERIVED: the row is written by the promotion import itself (`promotion-repo.ts`), in that transaction, on a `role: retrans` instance only — the sweep never stands a predicate scan over `changes`. See the migration header for why (the high-side retrans would otherwise enumerate builds it can never perform) and for why no existing surface can carry this state.

### §112. Pre-M16 residual, Track A (drizzle/0040)

Pre-M16 residual, Track A (drizzle/0040) — peer change STATUS this domain received and could not attach to anything. A `change_status` journal entry is positive evidence that a change exists and is moving on the peer (it names `payload.objectId` and a state); when no local replica of that object exists, or when this receiver's own scope filter discards the entry, `federation/import-repo.ts` used to drop that evidence silently and `coordination/service-board.ts` then reported the affected components as a confident `stable`.

This is the store `import-repo.ts`'s own comment already named as the missing feature. It is what makes the board's change-blindness caveat EVIDENCE-derived rather than only SCOPE-derived — decisive when the SENDER is the narrow side, because `sync_scope` is purely local config that never rides the wire and the two peers' values are never reconciled.

Keyed on (org, peer, change object id) and UPSERTED, so a from-genesis re-sync converges (DESIGN §6 replay invariant); DELETED when the change's `object_upsert` finally lands, so the signal resolves itself and can never fabricate persistent ignorance. It deliberately carries no target components: no `change_status` payload shape carries `targets`, so attribution stays at the (peer, change) grain and the board's caveat stays board-level — see drizzle/0040's header for the owner decision that would change that.

### §113. M7 Real Executor Integrations

M7 Real Executor Integrations (DESIGN.md §11, §12, BUILD_AND_TEST.md §8 M7). Hand-authored grants/RLS in drizzle/0014_m7_executor_integrations.sql (same pattern as 0002/0005/0007/0010).

`executor_bindings` is the exact gap `coordination/executor-config.ts`'s module doc predicted ("that lands once ExecutorPlugin config becomes a registry object, alongside GitHub/ArgoCD/ Terraform in M7") — the M4 `control_bindings` precedent for a graph object bound to a concrete plugin instance, applied to Component/DeploymentTarget objects instead of Control objects.

`secrets` is the org-scoped, ENCRYPTED-AT-REST credential store the GitHub App private key / ArgoCD token / managed-IaC vaulted infra credentials need (`secrets/crypto.ts` — AES-256-GCM, keyed by an operator-supplied `SCP_SECRETS_MASTER_KEY`, never the app database itself). This is deliberately NOT modeled on `instance_keys` (M4/M6): that table is explicitly plaintext-in- Postgres with no RLS, an acceptable narrow exception for one federation-domain-wide signing key; a general-purpose secrets store handling many tenants' arbitrary plugin credentials gets both real encryption and RLS.

`notification_bindings` gives the M3 watchdog escalation seam (coordination/watchdog.ts) and governance gate blocks somewhere real to send to — an org may configure more than one channel (hence no per-org uniqueness), each bound to a `NotificationPlugin` instance exactly like an executor/control binding.

### §114. Encrypted secret material, referenced by key from a binding

Org-scoped, encrypted-at-rest secret material referenced BY KEY from `executor_bindings.config` / `notification_bindings.config` (e.g. `{ "privateKeySecretRef": "github-app-1-private-key" }`) — plugin instances never see a secret unless their own binding's config explicitly names it, and the plaintext is decrypted only in-memory, injected into the plugin's subprocess env at spawn time (`plugin-host/host.ts`), never logged, never persisted anywhere but this ciphertext column.

### §115. Binds a graph object to a concrete executor plugin instance

Binds a Component/DeploymentTarget graph object to a concrete `ExecutorPlugin` instance — `pluginModule`/`pluginInstanceId`/`config` feed the exact same `PluginHostInstanceConfig` shape `control_bindings` already does (plugin-host/contract.ts); `secretRefs` names which `secrets` rows (by key) get resolved and injected as this instance's `PluginContext.secrets` at provisioning time (coordination/executor-bindings-repo.ts's `resolveExecutorPluginInstance`). `allowedHosts` is this instance's egress allowlist (SSRF mitigation, plugin-host/host.ts) — empty/omitted means the plugin's own manifest-declared defaults apply.

### §116. Per-org, per-source-kind webhook signing secret KEY REFERENCE

Per-org, per-source-kind webhook signing secret KEY REFERENCE (into `secrets`) — resolved by `routes/change-sources.ts` before it will accept a delivery as signature-verified. Kept as its own tiny table (not folded into `source_mappings`, which is 1:N per source kind and has no natural place for a singleton secret) so rotating a webhook secret never touches correlation config.

### §117. M17.5 — instance-scoped scan-requirement floors

M17.5 — instance-scoped scan-requirement floors (ADR-0016 §3). Hand-authored table/RLS/grants in drizzle/0029_scan_requirement_floors.sql; read that file's header for the full rationale.

THE ONE TABLE IN THIS SCHEMA WITH NO `org_id`, and deliberately so: it carries the two ABOVE-ORG tiers of the six-tier scan-requirement chain (platform -> trust domain (partition) -> org -> containment domain -> service -> component). A deployment sits in exactly one partition, so a trust-domain floor applies to EVERY org hosted on it. This is the documented exception to DESIGN §4.2's "org_id NOT NULL on every tenant-scoped table" — the table is not tenant-scoped and holds no per-tenant rows at all, so it exposes no cross-tenant visibility.

`tier` is spelled `trust_domain`, NEVER bare `domain`: the trust domain (partition) is the ambient federation boundary ABOVE org, while the `domain` OBJECT TYPE (the containment domain, see the `federation_self` comment above) is an intra-org grouping BELOW org. Different concepts.

Access: tenant-READ (RLS `FOR SELECT USING (true)`, `scp_app` holds SELECT only) / operator-WRITE (over the admin connection — `scp_app` has no write grant AND there is no write policy).

Every severity ceiling is NULLABLE: NULL = "this tier sets no ceiling for this severity", which contributes NOTHING to the per-severity MIN. Absent is never read as 0.

### §118. 'local' | 'federated'. NOTE (dated 2026-07-23, M17.5 follow-on)

'local' | 'federated'. NOTE (dated 2026-07-23, M17.5 follow-on): the CHECK admits both, but NO federation writer producing `origin: 'federated'` rows exists — only the operator PUT (routes/instance-scan-floors.ts) writes this table. Under the 2026-07-23 D5 decision (outposts/retrans never evaluate scan policy — they validate the commander's signature, not requirements), federated-origin floors are DORMANT until a genuine multi-commander distribution need exists. Not a bug; see the matching note in scan-requirements.ts and the ADR-0016 addendum.

### §119. M22.2 — instance-scoped scan-EXCLUSION admissions

M22.2 — instance-scoped scan-EXCLUSION admissions (ADR-0033 §1, §7a). Hand-authored table/RLS/ grants in drizzle/0074_scan_exclusion_admissions.sql; read that file's header for the full rationale.

THE SECOND TABLE IN THIS SCHEMA WITH NO `org_id`, and it is the SAME documented exception as `scanRequirementFloors` above rather than a new one: an admission is an operator statement about the DEPLOYMENT ("exclusions of this class may have effect beneath the platform/trust-domain rung"), identical for every org hosted here, so it holds no per-tenant rows and exposes no cross-tenant visibility. Access is the same: tenant-READ (RLS `FOR SELECT USING (true)`, `scp_app` holds SELECT only) / operator-WRITE over the admin connection.

DO NOT REASON ABOUT THIS TABLE BY ANALOGY WITH `scanFindings` BELOW — M22 added both and they are deliberately opposite. `scan_findings` is ordinary tenant data (`org_id NOT NULL`, standard RLS): it records what a scanner saw for one tenant's artifact. This one is instance config.

A ROW IS AN ADMISSION; NO ROW IS NO ADMISSION. The table ships EMPTY and is never seeded, so on every existing deployment the `platform` rung admits nothing, every clause beneath fails the monotone AND, and behaviour is byte-identical to pre-M22.2. Note the sign is the OPPOSITE of the neighbour above: an absent floor row means NO CEILING (a loosening), an absent admission row means NO ADMISSION (a tightening). A tightening and a loosening cannot share a default.

`class` must agree with `ScanExclusionClassSchema` (packages/schemas/src/supply-chain.ts); the migration carries a CHECK holding the same four values, and an integration test pins that the two lists agree.

### §120. M21.2 — the DEPENDENCY INVENTORY substrate

M21.2 — the DEPENDENCY INVENTORY substrate (ADR-0032 §3/§4/§5/§7). Hand-authored table/RLS/grants in drizzle/0061_dependency_inventory.sql; read that file's header for the full rationale — the four measurements behind the principle-2 bend, the URN-collision argument, and the RLS mirroring.

Two things about these tables are invariants rather than current shape:

1. NO `depends_on` EDGE IS EVER MINTED for a package dependency (ADR-0032 §5). That relationship type is the wave-plan toposort input, the `impact-of`/`blast-radius` default relType, and the `stageDependencies` materialisation target; a cycle among co-placed targets is a hard plan-compile error and package graphs routinely contain cycles. Package dependencies live in these two tables and nowhere else. 2. NOTHING HERE MAY EXPOSE A TRANSITIVE TRAVERSAL (ADR-0032 §3). Direct declared dependencies only — the transitive closure is an SBOM by another name (ADR-0013) and SCP stores no SBOM bytes. Both hot queries are single-hop index lookups served by the two indexes below; the moment a recursive walk appears here the graph representation becomes necessary again and the measured `impact-of` CTE hazard (7+ min, then disk exhaustion, against a 5s statement_timeout) applies.

### §121. The identity of ONE MAJOR LINE of one dependency, in one org

The identity of ONE MAJOR LINE of one dependency, in one org. Derived, high-churn observation data — the category `changeSourceEvents` and `objectHealth` already occupy — so it is a projection table and it does NOT federate (ADR-0032 §3, unchanged: that is what justifies the principle-2 bend).

IT IS WRITTEN ON THE COMMANDER ONLY (ADR-0032 §7d, owner decision 2026-08-17). This comment used to say "per-domain … each domain derives its own", quoting §3; that half is reversed. All dependency automation is commander-only — a FIELD outpost never ORIGINATES a bump, it receives the resulting change down the global pipeline the commander manages — so these rows exist in exactly one place, and an EMPTY `dependency_lines` on a field outpost is correct rather than a sync failure. "Field" is the qualifier that makes that sentence true: an HQ outpost is the outpost in the COMMANDER'S OWN trust domain, so its rows ARE these rows (ADR-0032 §7d's vocabulary note, read out of the code in `dependencies/commander-only.ts`). Any deployment whose `SCP_FEDERATION_ROLE` reads `outpost` is a field outpost, which is why the table is empty exactly there and nowhere else. `drizzle/0061`'s `COMMENT ON` carried the old wording, which is what an operator actually meets in `\d+ dependency_lines`; 0061 is merged and not editable in place, so `drizzle/0066` restates it there. The two are meant to be read as one statement — keep them saying the same thing.

THE COORDINATE IS NOT A URN, and that is why this is a table. `graph/urn.ts`'s `slugify` lowercases and hyphenate-collapses every non-alphanumeric run, so `@acme/lib`, `acme/lib` and `acme-lib` all become `acme-lib` — one URN, a 409 collision, no auto-suffix and no upsert-by-coordinate. `coordinate` is therefore the ecosystem-native string stored VERBATIM, and `(orgId, ecosystem, coordinate, major)` is the identity.

### §122. `oci` only: image tags are not semver

`oci` only — the tag shape whose parsed version this line follows. Image tags are not semver (`1.2.3`, `1.2.3-alpine`, `1.2`, `latest` and date stamps coexist) and a registry has no notion of a major line, so an image line needs a pattern plus an extractor; tags the extractor cannot parse are SKIPPED, never guessed (ADR-0032 §7). NULL for the four language ecosystems.

### §123. THE PRODUCER LINK USED TO BE HERE

THE PRODUCER LINK USED TO BE HERE — `produced_by_object_id` + `produced_by_declared_at` + `produced_by_declared_by_object_id`, with a partial index and the `dependency_lines_internal_is_declared` CHECK. All five are gone (drizzle/0068, ADR-0032 §7e).

They made the declaration PER MAJOR LINE, and a line is minted only by a CONSUMER's manifest. So every new major of a coordinate the org publishes minted a fresh row with a NULL producer — honestly third-party, since nobody had filled it in — and `buildLineWorkList` then handed the org's own coordinate to a PUBLIC INDEX. That is §7b clause 1's dependency-confusion catastrophe, re-armed silently at each major bump; both barriers that exist against it read the column, and neither can protect a column nobody filled in. The declaration now lives in `dependencyLineProducers`, keyed `(org_id, ecosystem, coordinate)`.

DO NOT REINSTATE THIS AS A MATERIALIZED CACHE stamped by `upsertDependencyLine` at mint time. It closes the same hole with no human step, and it puts a `produced_by_*` write back inside the ingestion verb — which deletes "the capability is absent from ingestion", the property this whole feature protects. The join makes the projection unnecessary rather than safe.

### §124. WHICH COMPONENT THIS ORG DECLARES IT PRODUCES ONE COORDINATE

WHICH COMPONENT THIS ORG DECLARES IT PRODUCES ONE COORDINATE (ADR-0032 §7e, proposal §12.1). Hand-authored table/RLS/grants in `drizzle/0068_dependency_line_producers.sql`.

THE GRAIN IS THE COORDINATE, NOT THE LINE, and that is a security property rather than tidiness. A `dependency_lines` row is `(org, ecosystem, coordinate, major)` and is minted ONLY by a consumer's manifest, so under per-line grain (a) a producer with no consumers yet had no row to attach to, and (b) every new major minted a fresh NULL-producer row that the version poll then handed to a public index — §7b clause 1's dependency confusion, on a daily timer, re-armed at each major bump with nothing to alert on. Keyed by coordinate, a brand-new major of a declared coordinate is internal FROM THE INSTANT IT IS MINTED, because there is no per-major field left to populate.

IT IS NOT A GRAPH OBJECT, AND THAT IS THE FEDERATION DECISION (proposal §12.4). A `produces` relationship or a `producedBy` policy effect WOULD federate — `policy` does — and a field outpost would then hold a declaration with no inventory behind it: a visible assertion nothing can act on. A projection table cannot make that mistake; it exists only where the inventory does, which since ADR-0032 §7d is the commander alone.

DECLARED, NEVER INFERRED. Nothing writes this table except the two verbs in `routes/dependency-producers.ts`; `inventory-ingestion.ts` does not import it, which is the enforcement, exactly as `dependency-inventory-repo.ts` not importing `relationships` is the enforcement for "no `depends_on` edge is minted".

### §125. Which component declares which line, at which version

The projection: which component DECLARES which dependency line, at which version, out of which dependency manifest (ADR-0032 §4). Keyed by the component's GRAPH OBJECT ID — the same "thin projection table that references its graph object" pattern `changes.objectId`, `objectHealth` and `freezes.scopeObjectId` use (DESIGN §4.1). The component stays a first-class graph object; only this projection of it is tabular.

DIRECT DECLARED DEPENDENCIES ONLY. No column here can hold a transitive closure, deliberately.

### §126. The repository the manifest was read from, as spelled

The REPOSITORY the manifest was read from, as the provider spells it — the other half of the address `observed_ref` only ever gave one half of (a commit sha names no repository).

It is what makes a prune attributable: an ingestion pass reads ONE repo, and "this path is not in repo A" is evidence about repo A alone. Without this column a pass over a component fed by two repositories pruned the OTHER repository's declarations, which silently unsubscribes the component (drizzle/0063). NULL means "not recorded" and is never pruned.

### §127. WHEN THE MANIFEST WAS READ

WHEN THE MANIFEST WAS READ — the phase-2 provider read, not the phase-3 write. That is what makes it comparable between two passes that overlap: the ordering guard in `inventory-ingestion.ts` refuses to apply a pass whose evidence is older than what the row already carries, and a write-time stamp would say the opposite thing (the pass that landed last, not the pass that looked last).

### §128. The repository this evidence came from, so the array merges

THE REPOSITORY THIS ENTRY'S EVIDENCE CAME FROM — which is what makes the array a merge target rather than something a pass replaces wholesale.

A pass reads exactly ONE repository, and `source_mappings` is many-per-component: a component legitimately releases from `acme/widgets` (its `go.mod`) and from `acme/charts` (its `Dockerfile`). Keyed by `path` alone, a charts pass replaced the entire array and ERASED the widgets pass's `unreadable` verdict minutes later — state (iii) "manifests unreadable" rendered as state (ii) "genuinely declares nothing", which is precisely the lie this table was built to prevent. So the writer replaces only the `(repo, *)` slice it holds evidence over (`mergeIngestionStamp`), and the component-level `outcome` is computed ACROSS the merged set.

### §129. Read outcomes: `ok`, retryable `unreadable`, or `unsupported`

`ok` read and parsed; `unreadable` a read or parse that failed THIS TIME and may succeed on the next pass; `unsupported` a file SCP structurally cannot read (no parser registered for that filename in this build, an LFS pointer, a directory, a binary, an encoding the decoder does not implement). The split is by OPERATOR ACTION, which is the test for whether a reason deserves its own name (ADR-0032 §7b clause 6).

### §130. WHEN THE PASS THAT WROTE THIS ENTRY LOOKED, ISO-8601

WHEN THE PASS THAT WROTE THIS ENTRY LOOKED, ISO-8601. The only thing that orders two passes over the SAME repository: a late-delivered retry of an earlier pass must not replace a newer slice (both delivery hops are at-least-once and the ingestion queue is a competing consumer). Per entry rather than per row because the row's own `last_attempt_at` is now the newest across ALL repositories, which says nothing about whether this repository's slice is stale.

### §131. THE DEPENDENCY INGESTION'S RECEIPT, PER COMPONENT

THE DEPENDENCY INGESTION'S RECEIPT, PER COMPONENT (migration 0065, ADR-0032 §4)
`component_dependencies.observed_at` is PER ROW, so a component with ZERO rows carries no timestamp at all and three different truths produce the same empty list: never ingested; ingested fine and genuinely declares nothing; ingestion ran and every manifest was unreadable. The ingestion has always COMPUTED which one — the verdict, the per-manifest skip reason and a detail are all on `ComponentIngestionOutcome`, the backfill route reports them per component and the loop logs them — and NOTHING PERSISTED IT, so a reader arriving later has only the absence of rows to go on and is forced to render "no dependencies" over all three. The third rendered as the second is a lie told with a straight face: the component is silently unsubscribed from everything it declares, and the screen says it has nothing to declare.

ONE ROW PER COMPONENT, UPSERTED. Bounded by the component count, not by the event rate — a pass updates a row rather than appending one, which is the distinction ADR-0024's 1.44 GB/day measurement is actually about.

"NEVER ATTEMPTED" IS THE ABSENCE OF A ROW, never a value: the only writer of "we have never looked at this component" would be a pass that ran, which is a contradiction. `scp_app` holds no DELETE grant here for the same reason — deleting a stamp forges that absence.

WHY NOT THE DECISION THE INGESTION ALREADY WRITES: it writes NO Decision on the refused paths (not enabled, not addressable), which are exactly the components whose empty list needs explaining; and it is persist-on-change with the ref, the commit and every timestamp deliberately excluded, so "when did we last look?" is unanswerable from it BY DESIGN.

### §132. Org-unbound reference, the form the sibling columns use

Org-unbound `references(objects.id)` — the form `changes.objectId` and `component_dependencies.component_object_id` use. There is NO composite foreign key here and that is a finding rather than an omission: `component_dependencies` carries one because a row of it points at a `dependency_lines` row and 0061 gave that table a `(org_id, id)` UNIQUE constraint expressly so a composite key had something to reference. This table points at nothing org-scoped, and `objects` carries no `(org_id, id)` unique constraint to hang one on. 0061's barrier-2 residue therefore applies verbatim (drizzle/0065's header states it in full, including what a future read route owes).

### §133. Whether this inventory is loop-maintained or backfilled

`loop` (event-driven, reacting to an accepted change) or `backfill` (an operator ran `POST /dependencies/inventory/backfill`) — "is this inventory maintained by the component's own releases, or only by whoever last ran a backfill?", two very different freshnesses behind one timestamp. Plain text with no CHECK, like `dependencyLines.ecosystem`: the closed set is enforced by the union type at the one write door, and `source` is a REQUIRED input of `ingestComponentManifests`, so a third producer does not compile until it names itself.

### §134. What the manifests are known to be across every repository

What the component's manifests are KNOWN TO BE, across every repository that feeds it — computed over the merged `manifests` set, not reported by whichever pass wrote last. `ok` every entry was read; `partial` some read and some not (the mixed case, which `manifests` names, and which a component fed by two repositories reaches routinely); `unreadable` nothing was read at all; `not_enabled` the gate is closed so nothing is fetched — the empty list is correct and is not evidence about the manifests.

### §135. The pass's own sentence, only when it declared the outcome

The ingestion's own sentence behind `outcome`, and ONLY when the outcome is one a pass declared rather than one the merged evidence computed (`not_enabled`, "no repository was named"). It exists because `manifests` is keyed BY PATH and those refusals have no path to hang an explanation on; where the evidence decides, the per-path details ARE the explanation and this is null.

### §136. The rows the merged manifest set currently accounts for

`component_dependencies` rows the component's manifests currently account for — the SUM of `manifests[].rows` over the merged set, so a pass over one repository cannot report its own count as the whole component's. 0 IS LEGAL AND MEANINGFUL: `ok` + 0 is "read fine, genuinely declares nothing", the state that could not be expressed before this table. Counts what was written, never what was pruned — this describes the observation.

### §137. Per (REPOSITORY, manifest path), sorted

Per (REPOSITORY, manifest path), sorted. Per path because `manifest_path` is part of `component_dependencies`' primary key — one component legitimately declares from several manifests, so "one readable, one not" is ordinary rather than hypothetical, and a count cannot tell an operator WHICH file to fix. Per REPOSITORY because a pass reads exactly one and `source_mappings` is many-per-component: a pass replaces only its own repository's slice, so a successful charts release can no longer erase a failed widgets read. `[]` — never NULL — states "no manifest is known for this component".

### §138. WHAT COMMANDERSCP ITSELF AUTHORED FOR A DEPENDENCY BUMP

WHAT COMMANDERSCP ITSELF AUTHORED FOR A DEPENDENCY BUMP (migration 0063, ADR-0032 §8/§9)
SERVER-OWNED STORAGE, AND THAT IS THE ENTIRE POINT OF THE TABLE.

Every input that decides whose credential merges what — the repository, the authored ref, the base branch, the component, the line, the branch's head commit, the pull request — used to be read out of `changes.source_ref.scp_authored`. `source_ref` is the raw delivery payload plus a few lifted keys, and ANY authenticated principal can write it verbatim through `POST /api/v1/changes`; the event that starts the merge gate can likewise be produced through `POST /change-sources/{kind}/report`. A tenant could therefore fabricate a "bump" naming any repository and have SCP merge into it with SCP's own installation credential — a confused deputy, not a validation gap, and no amount of validating an attacker-writable field fixes one.

A merge is the one irreversible thing this feature does, so it acts ONLY on facts SCP ITSELF RECORDED. These rows are written by `dependencies/bump-actuator.ts` when SCP decides to author, and updated only by the ingress that observes SCP's own branch coming back and by the gate that actuates the merge. There is no route, no IaC type and no federation importer that reaches them. A change with no row here is NOT a bump change and never reaches the merge path.

`changes.source_ref.scp_authored` is still written — as the human-readable explanation on the change (principle 6) — and is no longer READ by anything that decides a write.

### §139. The pull request URL as the provider returned it

That pull request's web URL AS THE PROVIDER RETURNED IT (migration 0066). NOT derived from `repo` + `pullRequestNumber`: those compose a working link only for github.com, and nothing on this row says which provider authored the bump — an outpost-local Gitea (M15) is another host AND spells the path `/pulls/`, GitHub Enterprise is another host again. NULL means SCP recorded no link; it never means "compose one".

### §140. THE PER-OBJECT RUNGS OF THE `governance:move` LATTICE

THE PER-OBJECT RUNGS OF THE `governance:move` LATTICE (drizzle/0083, docs/proposals/governance-reach-on-containment-move.md §9.2 — owner ruling 2026-08-18).

One row per CONTAINER (org root, containment domain, service, assembly) under which a containment MOVE additionally requires `governance:move` at both ends. The lattice is monotone and top-down: enforcement applies iff the instance rung (`governanceMoveInstanceRung`) is enabled OR any object on the moved object's containment chain or on the destination's chain carries a row here. A rung enabled ABOVE therefore cannot be disabled below — the DELETE route answers 409 naming the upper rung rather than reporting a disable that leaves the state enforced anyway.

EMPTY IS THE SHIPPED STATE and means no enforcement anywhere, which is why adding this table moved no existing authorization outcome.

### §141. THE INSTANCE (COMMANDER) RUNG

THE INSTANCE (COMMANDER) RUNG — the singleton that ACTIVATES the lattice deployment-wide (drizzle/0083 §2; owner decision Q1-A: "if enabled there, orgs can't disable it").

Storage is byte-for-byte the `dependency_subscription_unlock` shape (0062): `CHECK id = 'default'`, tenant SELECT-only, FORCE RLS, no write policy, operator-token `PUT` through the raw admin pool. The MEANING differs — the unlock permits, this activates — but the authority question is the same: a deployment-wide switch no tenant role may flip.

NO ROW MEANS DISABLED, decided in exactly one place (`governance/move-enforcement.ts`'s `readInstanceMoveRung`).

### §142. M25.3 — THE INSTANCE-SCOPED

M25.3 — THE INSTANCE-SCOPED (PLATFORM) FREEZE TIER, above org (drizzle/0086, docs/proposals/campaigns-rework.md §2 — owner decision D1, 2026-08-23).

ONE ROW BINDS EVERY ORG ON THE DEPLOYMENT. No `org_id` — the DESIGN §4.2 exception 0029/0035/ 0036/0062/0074/0083 already take, for the same reason: this is an operator statement about the deployment, not tenant data. Tenant-READ (charter principle 6 — a blocked change must be able to name what blocked it), operator-WRITE only (`SCP_OPERATOR_TOKEN` + the `scp_operator` connection; `scp_app` holds SELECT and has no write policy in any verb).

ADDRESSES A STAGE COORDINATE, NOT AN OBJECT. `freezes.scopeObjectId` names a graph object and the containment walk decides coverage; that is unavailable here, because object ids are per-org rows and `containmentChain` is org-filtered — no id names anything in a second tenant. So a platform freeze matches on the M15.6 / ADR-0017 §3 coordinate a `deployment-target` DECLARES: `properties.environment` (+ optional `properties.region`), read by `coordination/regional-executors.ts`'s `readStageCoordinate` (the one reader of that convention) INCLUDING the placement -> deployment-target hop.

`instanceFreezes.matchAllEnvironments` is the EXPLICIT deployment-wide form. An absent `matchEnvironment` is NOT deployment-wide (the proposal said it was; 0086's header states why that was changed) — the widest tightening this table can express must be said out loud, not reached by omitting a field.

MERGE IS UNION, NOT MIN. ADR-0016's scan floors take a per-severity MIN because a threshold is a number; a freeze is a PREDICATE and the merge is an OR. An instance freeze blocks even when the org declared nothing, and nothing an org can author subtracts from it — the "floor" property lives entirely in `instanceFreezes.overridable`, never in the merge.

DOES NOT FEDERATE and structurally cannot: `SyncJournalEntrySchema.orgId` is a required uuid and every layer below it is org-scoped. Hence no `origin` column (0086's header) — a field with no possible writer lies. Distribution to a fleet is deployment tooling, the same path that distributes `SCP_OPERATOR_TOKEN`.

EMPTY IS THE SHIPPED STATE, and empty is byte-identical to pre-M25.3 behaviour everywhere.

### §143. Whether any tenant role may override this freeze at all

Proposal §2.2 — WHETHER ANY TENANT ROLE MAY OVERRIDE THIS FREEZE AT ALL.

`false` (the default): none can, however privileged — not an org-root Owner holding `freeze:override`. `hasPermission` builds `scopeExpandCte(orgId, scopeObjectId)` and joins `role_bindings` filtered `rb.org_id = orgId`, so every id in that query is org-scoped and a platform freeze has no id in it; the three natural fakes are all wrong (an org-root scope hands every org Administrator the lift, a synthetic sentinel makes it un-overridable BY ACCIDENT, and an operator token on the request is impossible for the case that matters because wave-boundary gates run under `SYSTEM_ACTOR_ID` with no HTTP request in scope).

`true`: the OPERATOR has admitted tenant override for THIS freeze, and an actor holding `freeze:override` AT THE ORG ROOT may override it with the same mandatory non-empty reason every other override needs. Two independent authorities, both required.

### §144. The per-finding projection of one scan verdict

M22.1b (ADR-0033 §7/§7a, migration 0073) — the per-finding projection of ONE scan verdict.

A scan verdict was four integers until M22.1a; every rule in ADR-0033 is a rule ABOUT A FINDING, so this is the substrate the rest of M22 queues behind. See 0073's header for the full argument; the four load-bearing facts, restated where the code is:

```text
1. ORDINARY TENANT DATA, `org_id NOT NULL` under the standard `org_isolation` RLS policy. NOT
   the DESIGN §4.2 tenancy exception — M22.2's instance-tier ADMISSION rows are that, and the
   two land in the same milestone and must not be copied from each other.
2. A PROJECTION TABLE, not a graph object type, on drizzle/0061's four measured tests: a finding
   has no sluggable identity (the same CVE recurs per package; an entry may carry no
   `VulnerabilityID` at all yet still counts), 2000 rows/scan through the graph write path is
   2000 signed journal rows behind two per-org advisory locks, a new builtin type can wedge a
   peer's whole signed bundle mid-upgrade, and this is high-churn derived observation data.
3. COMMANDER-LOCAL. `control_runs.evidence` is copied VERBATIM into the promotion bundle, so
   findings are deliberately rows here and never on that column — the bundle keeps counts.
4. RETENTION IS PER ROW (ADR-0024 §D1, ADR-0033 D10): an EXCLUDED finding is accepted-risk
   evidence ('E'); an ordinary one is telemetry ('O').
```

### §145. The four DECLARED test hooks per component (D11/D21)

The four DECLARED test hooks per component (D11/D21) — `postMerge`, `postDeploy`, `continuous`, `bakeAlarms`.

IDENTITY is `(orgId, componentObjectId, kind, hookId)` and it is a real UNIQUE constraint, not a convention the writer observes. `ManifestPipelineHookSchema` states the rule: there is no update path keyed on a subset, so a changed hook is a delete + create.

NO `managedByStack` COLUMN, AND NONE IS EVER ADDED. `packages/schemas/src/iac.ts` settles this for the whole family of per-object configuration tables and this is one of them: "OWNERSHIP IS DERIVED FROM THE OWNING OBJECT ... neither table has a `labels` column, and neither gets one. A row belongs to stack S iff the graph object it hangs off (`component_object_id` / `target_object_id`) is one THIS stack owns." A stack-label column would be a SECOND answer to "who owns this row", and the moment it can disagree with the first, a plan's prune set and its apply's prune set are computed from different facts. `source_mappings` and `executor_bindings` are the precedents.

The per-kind nullable columns are not split into four tables: the closed per-kind shape is enforced by the Zod discriminated union at every write door, and a CHECK matrix here would be a second, driftable copy of it.

### §146. Which stacks a config source actually delivers

D26 (owner ruling 2026-08-27) — WHICH STACKS A CONFIG SOURCE ACTUALLY DELIVERS.

Ownership follows delivery: a stack the sync has applied for a config source is repo-owned whether or not an operator wrote it into that registration's `stackTeams` map, and the D7 CLI-apply guard reads this table UNION the explicit claims. See `drizzle/0101` for the full reasoning and for why the PRIMARY KEY is `(org_id, stack_name)` rather than including the source.

SERVER-OWNED, like `plans` and `decisions`: no IaC manifest can declare or prune a row here, and there is deliberately no `managed_by_stack` column to suggest otherwise.

### §147. The rollout strategy a component declares per target class

D12 — the rollout strategy a component declares per TARGET CLASS, and D25(b) — whether a config pipeline placed at an infrastructure product re-applies its released state when that product's membership changes.

BOTH WERE AUTHORABLE AND DROPPED before migration 0106: the contract defined the collections and `@scp/iac` emitted them, and `plans-repo.ts` projected neither, so a declared canary planned green and vanished at apply. See the migration header.

Ordinary prune rule (absent = empty = prune), unlike `pipelineHooks`; ownership derives from `component_object_id`, so there is no `managed_by_stack` column on either.

### §148. The config-source trigger's durable handoff

The config-source trigger's durable handoff (migration 0109). The webhook pass RECORDS that a registered repo moved; a separate reconcile step drains it outside that transaction, where an out-of-process manifest read is legal and a failure is isolated to one row.

Dedup is a PARTIAL UNIQUE INDEX over pending rows only — see the migration header for why the same commit may legitimately be enqueued again once the first entry has drained.

### §149. Schedules a deleted hook still owes its executor

Schedules a deleted `continuous` hook still owes its executor a `removeSchedule` for (migration 0111). `deleteHook` enqueues inside its own transaction; the probe driver drains it on the next tick, where an out-of-process RPC is legal and one unreachable executor cannot abort the apply or import that removed the row. See the migration header.

### §150. Concluded test runs and asserted alarm-state windows

Concluded test runs and asserted alarm-state windows (D21(b)/D23).

`source` AND `producerSubjectId` ARE SERVER-STAMPED. THEY ARE NEVER SETTABLE FROM A REQUEST BODY.
`SubmitPipelineEvidenceRequestSchema` carries no `producer`/`source`/`reportedBy` field and must never gain one. The rule, already written down in `federation/scan-evidence.ts`: PROVENANCE — which authenticated principal and which module produced the row — IS THE AUTHORIZATION BOUNDARY, NOT THE PAYLOAD SHAPE, because a shape-valid payload is forgeable by anyone who can read the schema. Both columns are filled at INSERT from the authenticated subject and from which door the row arrived through, the same way `controlRuns.pluginModule` is stamped.

That matters beyond bookkeeping: `evaluateBakeGate` evaluates window coverage PER SOURCE (source A's reports never fill source B's gaps), so a caller who could choose its own `source` could manufacture single-source coverage of a window it never observed.

TWO WRITE SEMANTICS, ON PURPOSE — `testRun` rows supersede newest-wins (enforced by the partial unique index `pipeline_evidence_test_run_identity`, migration 0096), `alarmState` rows ACCUMULATE. See `recordTestRunEvidence` / `recordAlarmEvidence` for why each is the semantics rather than a retention choice.

### §151. IN-FLIGHT AND CONCLUDED HOOK RUNS

IN-FLIGHT AND CONCLUDED HOOK RUNS (migration 0098) — the state `pipelineEvidence` structurally cannot hold.

`TestRunEvidenceSchema.outcome` is `passed|failed` and nothing else, on purpose: "Evidence is a record of something that FINISHED; an in-flight run is expressed by the ABSENCE of evidence." That leaves one fact with nowhere to live — THAT SCP ALREADY ASKED. Without it, the 1s reconcile tick looks for evidence of a postDeploy suite, correctly finds none, and dispatches the suite again; and again; because nothing in the database distinguishes "not started" from "started, running".

This table is NOT a second evidence table and must never become one. `evaluatePostDeployGate` does not read it. Evidence records the answer; this records the question having been posed.

`pipelineHookRunsIdentity` IS THE TRIGGER GUARD, AND IT IS `NULLS NOT DISTINCT`
The claim row is inserted BEFORE `trigger()` fires, so winning or losing this constraint is what decides who dispatches — the crash-safe three-step shape `reconcile.ts`'s `triggerWaveTarget` uses for wave targets (PR #7 review CRITICAL #2), applied to hooks.

`.nullsNotDistinct()` because `postMerge` is not target-specific and belongs to no wave, so its `waveIndex` is NULL — and under PostgreSQL's DEFAULT `NULLS DISTINCT`, NULL never equals NULL, so a plain UNIQUE would leave the guard applying to every hook kind EXCEPT that one. Nothing would error and nothing would log; the suite would simply run once per tick. Requires PostgreSQL 15+; DESIGN.md §3 pins the required floor at 16+.

### §152. NULLABLE, AND THAT IS THE WHOLE DESIGN

NULLABLE, AND THAT IS THE WHOLE DESIGN. The row is claimed BEFORE `trigger()` is called, so there is no external run to name yet. NOT NULL would force trigger-then-insert, and a crash between the two would leave a running workflow in the estate with no record of it here — the exact double-dispatch this table exists to prevent. NULL therefore means "durably claimed, not yet dispatched OR did not survive to record the answer"; both recover identically by re-deriving the SAME `idempotencyKey` and re-calling `trigger()`, which a conformant executor dedups (`TriggerIntent.idempotencyKey`).

### §153. The D23 pin: `CapturedWorkflowRef`

The D23 pin: `CapturedWorkflowRef` — declared (repo, branch, path) PLUS the BUILT `commitSha` PLUS the digest-pinned `bundle`. Per-BUILD, so it belongs on the run rather than on the hook declaration (which is only "a pointer into whatever the cluster happens to hold right now").

POPULATED BY `deriveCapturedWorkflow` at claim time, from three facts that must ALL be present: the hook's declared `WorkflowRef`, the change's built commit, and the test bundle the build REPORTED on `sourceRef.testBundle` (`ChangeReportRequestSchema.testBundle`). NULL when any one of them is absent — a build that reports no bundle, most commonly. The driver's response to NULL is to record the terminal status and write NO evidence, loudly; NOT to synthesise a digest so the shape type-checks. Fabricated, it would satisfy `evaluatePostDeployGate` while bound to bytes nobody verified — the failure `evaluateScanCoverage`'s `not_digest_bound` refusal prevents one layer down.

### §154. drizzle/0104 — instance-tier operator credentials

drizzle/0104 — instance-tier operator credentials (role-model.md §5 step 9).

INSTANCE TIER: no `org_id`. One row set binds the whole deployment, the same DESIGN §4.2 exception `instance_freezes` takes. Modelled on `personalAccessTokens` rather than invented: same `<prefix><tokenId>.<secret>` shape, same argon2-at-rest, same cleartext indexed lookup id.

## `apps/server/src/db/snapshot-freshness.test.ts`

### §155. DRIZZLE-KIT'S SNAPSHOT STATE, against schema.ts

DRIZZLE-KIT'S SNAPSHOT STATE, against schema.ts.

`drizzle-kit generate` does not read the database and does not read the `.sql` files. It diffs schema.ts against the newest `drizzle/meta/*_snapshot.json` — so that snapshot IS the tool's entire model of what already exists, and a stale one makes `db:generate` (BUILD_AND_TEST.md §3.2, the documented workflow after any schema edit) emit a migration that recreates everything it has forgotten.

It had been stale since the M1/M2 era: `0000_snapshot.json` described 4 tables while the journal carried 110 entries and schema.ts declared 71, and `db:generate` did not merely emit a bad migration — it aborted on an interactive rename prompt for columns it thought were new. The workflow every schema change is supposed to use had not worked in ~107 migrations.

This is the gate that keeps it working. A pure comparison of two files, no database and no subprocess, so it runs in the unit suite where the workflow it protects is used.

SCOPED TO NAMES — tables, columns, indexes, unique constraints. Types and defaults are what `db:generate` itself decides, and re-deriving them here would be re-implementing the tool. The name level is where staleness actually shows: a new table, column or index that schema.ts declares and the snapshot has never heard of is exactly what makes the next generate wrong.

TABLES THE MIGRATIONS CREATE AND schema.ts DOES NOT MODEL are deliberately outside this test's reach — it compares schema.ts to the snapshot, and both are silent about them. Measured 2026-08-31 against a fully-migrated database: `scanner_assignments`, `scan_db_staleness_policy` and `dependency_subscription_unlock` (instance-scoped singletons addressed by raw SQL) plus the dead `objects_m0_deprecated`. They hold no indexes, so `schema-ddl-drift.integration.test.ts` does not see them either. Naming them here so the next reader does not rediscover them as a surprise.

MUTATION-PROVEN 2026-08-31: adding a column to schema.ts without re-running `db:generate` turns this red naming `config_source_sync_queue.probe_column`; running `db:generate` (which emits the one-line `ALTER TABLE ... ADD COLUMN` and writes the next snapshot) turns it green again.

## `apps/server/src/db/tenant-tx.ts`

### §156. Every tenant-scoped read/write runs inside this wrapper

Every tenant-scoped read/write runs inside this wrapper (DESIGN.md §4.2). Two things happen, both `LOCAL` to the transaction so they can never leak onto a pooled connection reused by an unrelated request:

1. `SET LOCAL ROLE scp_app` — the runtime pool already *authenticates* as the scp_app login role (main.ts phase 2; PR #4 security review, CRITICAL 3), so this is normally a no-op self-assignment. It stays as belt-and-braces: if an operator misconfigures the runtime connection string to a privileged user, tenant transactions still drop to scp_app (no BYPASSRLS) before touching data. 2. `SET LOCAL app.current_org_id` — the value every `org_isolation` RLS policy compares against. Uses `set_config(..., true)` (parameterized) rather than string-interpolated SQL.

Fails closed: a transaction that never calls this (or an adversarial raw connection that never sets the GUC) sees `current_setting('app.current_org_id', true)` as NULL, and `org_id = NULL` is never true under RLS — BUILD_AND_TEST.md §8 M1 DoD (a). Because the pool itself is scp_app, even code that skips this wrapper entirely is still RLS-confined.
