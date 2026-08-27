-- ===========================================================================================
-- 0097 — RBAC DDL hardening: the preconditions for seeding purpose-shaped roles.
--         (docs/proposals/role-model.md §1.3g/§1.3h, build order §5 step 1.)
--
-- MIGRATION NUMBERING: 0095 was the tail on main when this was authored. Numbering across open
-- PRs is strictly serial in MERGE order and `db/journal-ordering.test.ts` gates journal
-- contiguity + strictly-increasing `when` — so RE-VERIFY this number and the `_journal.json`
-- entry against main at merge time, and renumber if anything landed first.
--
-- THIS MIGRATION ADDS NO ROLE AND NO PERMISSION. It makes the two RBAC tables able to HOLD the
-- purpose roles safely. Nothing about who can do what changes: the only rows it touches are ones
-- that are provably inert (§3) or provably redundant (§1, §2). Where it CANNOT prove that — two
-- built-in rows with the same name and DIFFERENT permissions, where collapsing them changes some
-- subject's authority in one direction or the other — it REFUSES TO GUESS and aborts the upgrade
-- with the ids and the exact delta (§1a). Argument and cost in §1's header.
--
-- Four gaps, all verified present on main, plus one new column:
--
--   (a) `roles` has a PRIMARY KEY on `id` and NOTHING else (0001_graph_core.sql:70-75). So the
--       built-in seed's `INSERT ... ON CONFLICT DO NOTHING` with `gen_random_uuid()`
--       (0002_rls_rbac_seed.sql:207) has NO arbiter index to conflict against — the ON CONFLICT
--       clause can never fire, and any re-execution of that seed silently creates a SECOND
--       'Viewer', a second 'Owner', and so on. `auth/local-auth.ts:78` and `auth/oidc.ts:173`
--       both resolve their role with `findFirst(name = ...)`, so duplicates do not error: they
--       fork the estate's notion of what "Owner" IS, arbitrarily per query plan.
--       PARTIAL (`WHERE org_id IS NULL`) because an org's own custom roles are its own business
--       and may legitimately reuse a built-in name — the collision that matters is between
--       SHARED SINGLETON rows, which every org reads through the `roles` RLS `USING (... OR
--       org_id IS NULL)` clause.
--
--   (b) `role_bindings` likewise has only a PK on `id` (0001:76-85). Without a natural key, a
--       write door creates duplicate grants that are individually revocable and COLLECTIVELY
--       still granting: revoke one, the other still grants, and the UI shows the revoke
--       succeeded. This is the defect that makes a revoke verb untrustworthy, so it must land
--       BEFORE the role-binding API (§5 step 5), not with it.
--
--   (c) `effect` is a bare `text` column defaulting to 'allow' with no CHECK. `hasPermission`
--       and `hasRoleAtScope` classify in JS — `effects.includes("deny")` then
--       `effects.includes("allow")` (authz/resolve.ts:285-286, :353-354) — so a row whose effect
--       is 'ALLOW', 'Deny', '' or 'allowed' grants NOTHING and denies NOTHING. It is SILENTLY
--       INERT: it renders in any future listing as authority that does not exist. Make the
--       database refuse it.
--
--   (d) `scp_app` holds SELECT/INSERT/UPDATE on `role_bindings` and NO DELETE (0002:27-31).
--       Verified by filterless census of every `GRANT ... DELETE` in drizzle/: 0025, 0050, 0061,
--       0073, 0083, 0071, 0014, 0040, 0076, 0086 — none names `role_bindings`. A revoke verb
--       could not revoke; it would fail with a hard 42501 at runtime, after the route had already
--       authorized the caller.
--
--   (e) `roles.bindable_at text[]`, NULL = "any scope". `role_bindings.scope_object_id` is
--       `uuid NOT NULL REFERENCES objects(id)` with NO type constraint, no `scope_kind` column
--       and no CHECK (§1.3h), so a binding at a `user` or a `change` is accepted today and
--       silently inert. This column is what will later make "ComponentAdmin binds at an assembly
--       OR a component" ENFORCED rather than conventional. NO ENFORCEMENT IN THIS INCREMENT —
--       just the column, and NULL on the five existing built-in rows so their behaviour is
--       unchanged in every code path.
--
-- WHAT IS DELIBERATELY *NOT* GRANTED: `DELETE ON roles`. Owner ruling D5 (deprecate
-- Administrator on arrival) rests on the fact that the row can never be removed — every existing
-- binding must keep resolving, and the deprecation is a refusal at the WRITE DOOR, not a removal.
-- Granting `scp_app` DELETE on `roles` would also let a runtime bug orphan `role_bindings.role_id`
-- (an FK with no ON DELETE action, so it would fail loudly — but at an arbitrary later moment).
--
-- ===========================================================================================
-- WHY THIS MIGRATION CLEANS BEFORE IT CONSTRAINS
-- ===========================================================================================
-- (a), (b) and (c) can HARD-FAIL on a populated database: `CREATE UNIQUE INDEX` over rows that
-- already contain duplicates aborts, and so does `ADD CONSTRAINT ... CHECK` over rows that
-- already violate it. And this deployment's own database may hold duplicate built-in roles
-- PRECISELY BECAUSE OF the never-firing ON CONFLICT in (a) — the constraint being added is the
-- one whose absence produced the rows that would block it. Every path that re-executes
-- 0002's seed outside drizzle's `__drizzle_migrations` ledger (a restored dump re-migrated, a
-- reset ledger, a hand-run seed) produces exactly that state — and, as §1 works through, produces
-- it with the DUPLICATE'S PERMISSIONS ALREADY BEHIND the survivor's, which is why §1a exists.
--
-- Each cleanup below is written to be a NO-OP on a clean database (every one is bounded by a
-- `HAVING COUNT(*) > 1` / an explicit "not a legal value" predicate), and each is destructive
-- ONLY of rows that are provably redundant or provably inert. The one case where redundancy is
-- NOT provable — duplicate built-ins whose permission sets disagree — aborts (§1a) rather than
-- picking a winner.
--
-- ORDERING IS LOAD-BEARING, and §1 must precede §2 for a reason that is not obvious: repointing
-- a binding from a loser role to the survivor can itself MANUFACTURE a duplicate binding (a
-- subject bound to both the loser and the survivor at the same scope becomes two identical rows).
-- Dedupe therefore runs after the repoint, never before.
--
-- RLS NOTE: `role_bindings` and `roles` are `FORCE ROW LEVEL SECURITY` (0002 §2). Migrations run
-- as the bootstrap connection role, which bypasses RLS in every supported deployment (it is the
-- role that CREATEs the policies); 0077 already relies on exactly this to `DELETE FROM
-- role_bindings`. If some future deployment ran migrations as a non-bypassing role, the cleanups
-- would silently match zero rows — but the constraint adds in §4 are in the SAME per-migration
-- transaction and would then ABORT on the still-present duplicates. The failure mode is LOUD and
-- fully rolled back, never a half-cleaned security table.
-- ===========================================================================================

-- ===========================================================================================
-- 1. Collapse duplicate BUILT-IN roles to one row per name, re-pointing bindings first —
--    but ONLY when the duplicates agree about what the role IS. Otherwise: STOP.
--
--    SURVIVOR = LOWEST `id`, chosen because it is DETERMINISTIC: the same row wins on every
--    replica, on a re-run, and in the test fixture. Determinism is ALL it buys. It carries no
--    claim to be the right row, and §1a below is why that distinction is load-bearing.
--
--    WHY THIS ABORTS INSTEAD OF PICKING (the argument, because a failed upgrade is a real cost).
--    Duplicate built-ins are NOT byte-identical apart from `id`. The producer this migration's
--    own header names — a re-executed 0002 seed, outside drizzle's `__drizzle_migrations` ledger
--    — manufactures a DIVERGENT duplicate every single time, deterministically:
--
--      * 0002:207-223 seeds the M1-era permission arrays as SQL literals. Owner's is 11
--        permissions long.
--      * Five later migrations append to Owner by name — `UPDATE roles SET permissions =
--        array_append(...) WHERE org_id IS NULL AND name IN (...) AND NOT (... = ANY(permissions))`
--        — 0010:174-184 (policy:write, freeze:write, freeze:override, change:emergency),
--        0012:218-222 (federation:write, federation:read), 0083:143-145 (governance:move),
--        0088:34-36 (campaign:deadline-override), 0094:53-55 (federation:pair). Nine in all;
--        today's Owner therefore carries 20.
--      * Those five are ALREADY in the ledger on any database old enough to have duplicates, so
--        they do NOT re-run over the newly created row. The duplicate is born with 11.
--
--    THE TEMPTING WRONG READING, named so nobody re-derives it: those five migrations do update
--    all duplicates identically — but only the duplicates that exist AT THE TIME THEY RUN. "Every
--    grant targets by name and updates all matching rows" does NOT imply "all matching rows are
--    equal"; a row created after the grant has already run is never touched by it. Duplicate
--    built-ins are therefore not interchangeable, and the survivor choice is not free.
--
--    And 0002 seeds with `gen_random_uuid()` — a RANDOM v4, not a time-ordered v7. So which of
--    the two Owners holds the lower id is a coin flip, and on half of those databases
--    lowest-id-wins deletes the 20-permission Owner, keeps the 11-permission one, and repoints
--    every Owner binding in the estate at it. Nine permissions — including `freeze:override` and
--    `change:emergency` — vanish during an upgrade that reported success.
--
--    The reverse flip is not "the safe half" either: repointing bindings from the 11-permission
--    duplicate onto a 20-permission survivor WIDENS those subjects' authority just as silently.
--    Neither direction is a no-op, so there is no fail-safe pick and no union to fall back on —
--    a union widens by construction. A migration that answered this would be inventing an
--    authority answer for an estate whose two rows disagree about what `Owner` means, with no
--    Decision record and nobody in the loop (charter principle 6).
--
--    RAISE WARNING + narrow (the idiom §3 uses for illegal-effect rows) was considered and
--    rejected HERE, though it is right THERE. §3's rows contribute nothing to either branch of
--    the resolver, so deleting them is provably outcome-preserving and the warning is a courtesy.
--    These rows are the opposite: the outcome changes either way, the change is unrecoverable
--    once the row is gone, and an upgrade-job log in Helm or compose is very often discarded — so
--    the first signal would be a 403 weeks later, with the evidence deleted.
--
--    Cost of aborting: a failed upgrade, fully rolled back (drizzle runs the pending set in one
--    transaction), on a database whose RBAC table genuinely holds two disagreeing definitions of
--    one built-in role. That database has a real problem, and the exception below hands the
--    operator the ids and the exact permission delta needed to resolve it in one query.
--
--    §1b/§1c below are then reached ONLY when every duplicate group is permission-identical, so
--    collapsing is a true no-op for every binding regardless of which row survives.
--
--    The repoint is not optional: `role_bindings.role_id` is an FK to `roles.id` with no ON
--    DELETE action (0001:153), so deleting a loser out from under a live binding raises 23503 and
--    aborts the upgrade.
--
--    `(array_agg(id ORDER BY id))[1]` rather than the obvious `MIN(id)`: MEASURED on the
--    `postgres:16` image this repo's compose/Helm/Testcontainers baseline pins (charter principle
--    4) — `SELECT min('...'::uuid)` fails there with 42883 `function min(uuid) does not exist`
--    (PostgreSQL 16.15, 2026-08-26). Which later release grew `min(uuid)` is not asserted here
--    because it was not measured and does not matter: 16 is the floor, and on 16 `MIN(id)` would
--    abort the upgrade at exactly the moment the operator is least able to diagnose it. Same
--    ordering (bytewise on the uuid), same determinism. Do not "simplify" this back.
-- ===========================================================================================

-- --- 1a. The refusal. Runs BEFORE the repoint, so nothing has moved when it fires. --------------
DO $$
DECLARE
  report text;
BEGIN
  -- WHAT COUNTS AS DIVERGENCE, and why it is not `o.permissions IS DISTINCT FROM k.permissions`.
  -- The two `ARRAY(... EXCEPT ...)` expressions below compare the arrays as SETS, because that is
  -- how the resolver reads them: `hasPermission` tests `<permission> = ANY(rl.permissions)`
  -- (authz/resolve.ts), which is blind to element order and to repeated elements. Two rows holding
  -- the same permissions in a different order carry IDENTICAL authority, and stopping an upgrade
  -- over that would be a false alarm an operator cannot act on. `EXCEPT` gives set semantics for
  -- free — no separate normalisation step, and `lost`/`gained` are then exactly the text the
  -- operator needs. At this point in the file `roles` has exactly four columns — `id`, `org_id`,
  -- `name`, `permissions` (`bindable_at` is added in §5, below) — and the first three are the
  -- group key or the tiebreak, so `permissions` is the WHOLE divergence surface, not a sample.
  WITH builtin AS (
    SELECT id, name, permissions FROM roles WHERE org_id IS NULL
  ),
  survivor AS (
    SELECT b.name, (array_agg(b.id ORDER BY b.id))[1] AS keep_id
    FROM builtin b
    GROUP BY b.name
    HAVING COUNT(*) > 1
  ),
  divergence AS (
    SELECT s.name,
           s.keep_id,
           o.id AS loser_id,
           ARRAY(SELECT unnest(o.permissions) EXCEPT SELECT unnest(k.permissions) ORDER BY 1) AS lost,
           ARRAY(SELECT unnest(k.permissions) EXCEPT SELECT unnest(o.permissions) ORDER BY 1) AS gained
    FROM survivor s
    JOIN builtin k ON k.id = s.keep_id
    JOIN builtin o ON o.name = s.name AND o.id <> s.keep_id
  )
  SELECT string_agg(
           format(
             'role %L: every role_binding pointing at %s would be repointed to the lowest id %s, LOSING %s permission(s) [%s] and GAINING %s [%s]',
             name, loser_id, keep_id,
             cardinality(lost), array_to_string(lost, ', '),
             cardinality(gained), array_to_string(gained, ', ')
           ),
           E'\n' ORDER BY name, loser_id
         )
    INTO report
  FROM divergence
  WHERE cardinality(lost) > 0 OR cardinality(gained) > 0;

  IF report IS NOT NULL THEN
    RAISE EXCEPTION '0097: refusing to collapse duplicate built-in roles whose permissions have DIVERGED — an upgrade must not invent an authority answer.'
      USING DETAIL = report,
            HINT = 'Resolve it deliberately: decide which permission set is correct, UPDATE the row you intend to keep, repoint role_bindings.role_id off the other ids, DELETE them, then re-run the upgrade. Nothing in 0097 has been applied — drizzle runs the pending set in one transaction, so this database is exactly as it was.';
  END IF;
END $$;

-- --- 1b. Repoint bindings off the losers. ------------------------------------------------------
WITH survivors AS (
  SELECT name, (array_agg(id ORDER BY id))[1] AS keep_id
  FROM roles
  WHERE org_id IS NULL
  GROUP BY name
  HAVING COUNT(*) > 1
),
losers AS (
  SELECT r.id AS loser_id, s.keep_id
  FROM roles r
  JOIN survivors s ON s.name = r.name
  WHERE r.org_id IS NULL AND r.id <> s.keep_id
)
UPDATE role_bindings rb
SET role_id = l.keep_id
FROM losers l
WHERE rb.role_id = l.loser_id;

-- --- 1c. Delete the losers. -------------------------------------------------------------------
WITH survivors AS (
  SELECT name, (array_agg(id ORDER BY id))[1] AS keep_id
  FROM roles
  WHERE org_id IS NULL
  GROUP BY name
  HAVING COUNT(*) > 1
)
DELETE FROM roles r
USING survivors s
WHERE r.org_id IS NULL AND r.name = s.name AND r.id <> s.keep_id;

-- ===========================================================================================
-- 2. Collapse duplicate role_bindings on the new natural key.
--
--    SURVIVOR = LOWEST `id` again, and here the choice carries meaning as well as determinism:
--    every binding this codebase writes gets a `uuidv7` (auth/local-auth.ts:85, auth/oidc.ts:179,
--    test-support/harness.ts:445), which is time-ordered in its bytes and therefore sorts by
--    creation time under Postgres's bytewise `uuid` comparison. The survivor is the ORIGINAL
--    grant; the losers are the later re-grants that added no authority. `created_at` is NOT used
--    as the discriminator because it is not unique and a tie would make the cleanup
--    non-deterministic — the exact property this is meant to remove. `array_agg ... ORDER BY`
--    rather than `MIN(id)` for the PostgreSQL-16 reason given in §1.
--
--    Deleting these changes NOTHING about who can do what: the rows being deleted are equal to
--    the survivor on all five key columns, and `hasPermission` reads `SELECT DISTINCT rb.effect`
--    (resolve.ts:275) — it already collapses them.
-- ===========================================================================================

DELETE FROM role_bindings rb
USING (
  SELECT org_id, subject_id, role_id, scope_object_id, effect,
         (array_agg(id ORDER BY id))[1] AS keep_id
  FROM role_bindings
  GROUP BY org_id, subject_id, role_id, scope_object_id, effect
  HAVING COUNT(*) > 1
) d
WHERE rb.org_id = d.org_id
  AND rb.subject_id = d.subject_id
  AND rb.role_id = d.role_id
  AND rb.scope_object_id = d.scope_object_id
  AND rb.effect = d.effect
  AND rb.id <> d.keep_id;

-- ===========================================================================================
-- 3. Rows whose `effect` is neither 'allow' nor 'deny': DELETE them, and say so out loud.
--
--    THE ARGUMENT, because this is a destructive act on a security table and the alternative is
--    tempting. Such a row grants nothing and denies nothing TODAY — `effects.includes("deny")` is
--    false and `effects.includes("allow")` is false, so `hasPermission` falls through to its
--    default deny (resolve.ts:285-287). There are exactly two honest options:
--
--      * NORMALISE to 'allow' — REJECTED. It would turn a row that grants nothing into a row that
--        GRANTS, i.e. a migration silently WIDENING authority during an upgrade, with no audit
--        event, no Decision record and no operator in the loop. That is the precise act charter
--        principle 6 exists to forbid. It is also unrecoverable in the direction that matters:
--        nobody notices a permission they did not expect to have.
--      * NORMALISE to 'deny' — REJECTED. Narrowing rather than widening, so safer, but it is
--        still a behaviour change invented by a migration: a `deny` row overrides EVERY allow at
--        every scope (resolve.ts:285), so one typo'd row could lock a legitimate principal out of
--        their own estate on upgrade, presenting as a 403 with no explanation anywhere.
--
--    DELETE preserves the authorization outcome EXACTLY: for every (subject, permission, scope)
--    triple the resolver's answer is byte-identical before and after, because these rows
--    contributed nothing to either branch of the classification. It is the only option that is a
--    true no-op on behaviour.
--
--    RAISE WARNING (not NOTICE) because deleting rows from an RBAC table must appear in an
--    upgrade log an operator actually reads, with the ids, so the intent can be reconstructed
--    from a pre-upgrade backup and re-granted through the API with a real 'allow'/'deny'.
-- ===========================================================================================

DO $$
DECLARE
  doomed_count integer;
  doomed_ids   text;
BEGIN
  SELECT COUNT(*), string_agg(id::text, ', ' ORDER BY id)
    INTO doomed_count, doomed_ids
  FROM role_bindings
  WHERE effect NOT IN ('allow', 'deny');

  IF doomed_count > 0 THEN
    RAISE WARNING '0097: deleting % role_binding row(s) with an effect that is neither ''allow'' nor ''deny''. These rows granted nothing and denied nothing (authz/resolve.ts classifies on exact string equality), so authorization outcomes are unchanged. Recover intent from a pre-upgrade backup and re-grant through the API. ids: %',
      doomed_count, doomed_ids;

    DELETE FROM role_bindings WHERE effect NOT IN ('allow', 'deny');
  END IF;
END $$;

-- ===========================================================================================
-- 4. Now — and only now — constrain.
--
--    `IF NOT EXISTS` / `pg_constraint` guards throughout: this migration must be safe to re-run
--    against a database that already has it (the shape 0087/0082 established), which is also what
--    lets the cleanup path be tested against a hand-built dirty fixture by re-executing this file.
-- ===========================================================================================

CREATE UNIQUE INDEX IF NOT EXISTS "roles_builtin_name_key"
  ON "roles" ("name")
  WHERE "org_id" IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'role_bindings_grant_key'
  ) THEN
    ALTER TABLE "role_bindings"
      ADD CONSTRAINT "role_bindings_grant_key"
      UNIQUE ("org_id", "subject_id", "role_id", "scope_object_id", "effect");
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'role_bindings_effect_check'
  ) THEN
    ALTER TABLE "role_bindings"
      ADD CONSTRAINT "role_bindings_effect_check"
      CHECK ("effect" IN ('allow', 'deny'));
  END IF;
END $$;

-- ===========================================================================================
-- 5. The new column, and the missing DELETE grant.
-- ===========================================================================================

ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "bindable_at" text[];

-- No backfill. NULL on the five existing built-in rows means "any scope", which is exactly their
-- behaviour today and must stay so: Viewer/Operator/Approver/Administrator/Owner are bound at org
-- roots, services and components across live deployments, and any non-NULL value invented here
-- would retroactively make some of those bindings illegal.
COMMENT ON COLUMN "roles"."bindable_at" IS
  'Object type ids this role may be bound at (role_bindings.scope_object_id''s objects.type_id). NULL = ANY scope — the value carried by the five built-in ladder roles, whose bindings predate this column. NOT ENFORCED BY THE DATABASE and not enforced anywhere as of 0097: it is validated at the role-binding write door (role-model.md §5 step 5), which does not exist yet. Until then this column is advisory metadata only, and a binding at a nonsensical scope is still accepted and still silently inert.';

-- (d) — the grant that makes a revoke verb possible. Deliberately NOT paired with `DELETE ON
-- roles`: see the header. `scp_app`'s DELETE here is still fully governed by the `org_isolation`
-- RLS policy on `role_bindings` (0002:85-90), so it can only ever delete rows in the session's
-- own org — a grant, not a hole.
GRANT DELETE ON role_bindings TO scp_app;
