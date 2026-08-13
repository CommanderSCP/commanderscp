-- ===========================================================================================
-- `objects.domain_local` — the declaration that an object's existence stays inside its own
-- security domain and never rides the federation journal to any peer (ADR-0031 §1, M20.1).
--
-- ## What this is for
--
-- Some code is true in exactly one trust domain: a partition's VPC layout, route tables,
-- transit-gateway attachments, security-group rules, its per-domain slice of Kubernetes config.
-- It has NO upstream original to promote from — the domain IS its source of truth. ADR-0017 §2
-- already made that class outpost-owned for build and repo hosting; this column is how an
-- operator says so, and how the export filter can see it.
--
-- ## Why a column and not a label
--
-- `objects.labels` is free-form, user-writable jsonb that ALREADY rides the journal payload. A
-- guarantee about what crosses a trust boundary has to be enforceable at a write choke point, not
-- conventional — so it gets a real column, set at create by a `federation:write` caller, and
-- named by NO UPDATE statement anywhere in the codebase.
--
-- ## Immutability is STRUCTURAL, not conditional (ADR-0031 §6)
--
-- The complete census of writers of this table is five statements: `createObject`'s INSERT,
-- `updateObject`'s UPDATE, `upsertObjectByUrn`'s own UPDATE (it does not delegate), `deleteObject`'s
-- soft-delete UPDATE, and the campaign fairness UPDATE in `coordination/campaign-reconcile.ts`.
-- Only the INSERT names `domain_local`. There is therefore no code path that can flip it — the
-- capability is missing rather than guarded, which is the shape ADR-0022 established for the
-- structurally-keyless peer PATCH and for the same reason: a guard can be forgotten at a new call
-- site, an absent column reference cannot.
--
-- Shared -> domain-local stays refused FOREVER: federation has no un-send, so once a row's
-- existence has crossed, a later claim that it is local is one the system cannot deliver. The
-- reverse direction (domain-local -> shared) is a deliberate one-way PUBLICATION verb landing in
-- M20.4, which re-journals the object's current full state — it is the single future writer that
-- will name this column in an UPDATE, and it is one-way by construction.
--
-- ## Additive expand — no backfill, no behaviour change
--
-- NOT NULL DEFAULT false. Postgres 11+ stores a non-volatile default in the catalog rather than
-- rewriting the heap, so this is a metadata-only ALTER even on a large `objects` table. Every
-- existing row reads `false` — i.e. exactly today's behaviour, where every object federates
-- subject only to the peer's `sync_scope` — so nothing that ships today changes meaning.
--
-- FALSE rather than NULL as the "not declared" value is deliberate: this is a two-state property
-- (an object either stays home or it does not), and a nullable boolean would invite a third
-- reading — "unknown" — that the export filter would then have to resolve. A filter deciding what
-- crosses a security boundary must not have an unknown case; see `federation/scope-filter.ts`,
-- where the predicate is a plain `=== true`.
--
-- ## The index, and why it is partial
--
-- The only queries that select ON this column look for the declared minority (the M20.4 publish
-- verb's edge sweep, and operator/UI listings of "what stays home"). A partial index over the true
-- rows keeps it proportional to that minority instead of to the whole table, which for the
-- overwhelmingly-false expected distribution is the difference between a few pages and a full
-- second index of `objects`.
-- ===========================================================================================

-- `IF NOT EXISTS` on both, matching the convention 44 other migrations here already use, and for a
-- reason that is not merely stylistic. Drizzle applies migrations by strictly-increasing `when`, and
-- two branches that derive `when` from the same parent with the same arithmetic produce the SAME
-- value — at which point one of them is silently skipped on a database that already applied the
-- other, surfacing later as a missing column and 500s rather than as a migration error. (Reported
-- from a parallel branch's dev database, 2026-08-13.) A re-run of this file must therefore be a
-- no-op rather than a hard failure on `column already exists`.
ALTER TABLE objects ADD COLUMN IF NOT EXISTS domain_local boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS obj_domain_local ON objects (org_id) WHERE domain_local;

COMMENT ON COLUMN objects.domain_local IS
  'ADR-0031: TRUE = this object never rides the federation journal to any peer, at any sync scope, in either direction. Operator-DECLARED at create (federation:write), never inferred. Named by no UPDATE statement — immutable by construction; the M20.4 publish verb is the one deliberate one-way exception. VISIBILITY ONLY: it is never an enforcement input, grants no scan exemption, and is read by no governance path.';
