import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createTestOrg,
  listenTestServer,
  type ListeningTestServer,
  type TestOrg
} from "../test-support/harness.js";
import { withTenantTx } from "../db/tenant-tx.js";

/**
 * THE DANGLING-ROW CENSUS, AS A GATE. See docs/graph.md §125f.
 *
 * `objects` rows are soft-deleted, and no foreign key anywhere in this schema carries
 * `ON DELETE CASCADE`, so EVERY column that names an `objects.id` can end up naming a tombstone. The
 * question "what should happen to that row?" has been answered four times now (source mappings →
 * route 5, executor bindings → route 6, placements → the repairable measurement, governance:move
 * rungs → route 7) and each time the answer was rederived from a fresh census, because the previous
 * census lived only in a PR body.
 *
 * WHY THIS IS A TEST AND NOT A DOCUMENT. The last census was written in docs/graph.md §125b as prose
 * and was wrong within a day: it ruled out a route 7 over eight tables on the strength of "no
 * `.delete(...)` statement anywhere in the codebase", a claim produced by grepping the DRIZZLE
 * identifier, which cannot see `governance/move-enforcement.ts`'s raw
 * `DELETE FROM governance_move_rungs`. A prose census cannot fail. This one can, in three ways:
 *
 *   (A) A NEW COLUMN that names an object and carries no recorded verdict fails the test. The
 *       population is derived from the CATALOG — every foreign key to `objects`, unioned with every
 *       uuid column named `%object_id%` and the handful of object-naming columns that follow neither
 *       convention — so the next table added to this schema fails here rather than being discovered
 *       by the census after next.
 *   (B) A RECORDED VERDICT that names a column the catalog no longer has fails the test, so a rename
 *       or a drop cannot leave a stale ruling behind.
 *   (C) A DELETE GRANT appearing on a table recorded as having no delete door fails the test. This is
 *       the derived proxy for "somebody built a door": under `FORCE ROW LEVEL SECURITY` a write needs
 *       both a grant and a policy, so a new delete verb cannot ship without a `GRANT DELETE` in its
 *       migration — and the moment one appears, the "a guard here would be a permanent wall" verdict
 *       that rested on there being no door has to be re-argued. Read out of
 *       `information_schema.role_table_grants` rather than by attempting a write, because the
 *       integration harness connects as the superuser and would hide the answer either way.
 *
 * The verdicts themselves, and the measurements behind them, are in docs/graph.md §125f. `why` here
 * is the one-line form; it is deliberately short for the columns that were never in question and
 * long for the ones that were.
 */

/** What the delete of the OWNING object does, or does not do, to this row. */
type Verdict =
  /** A delete-time refusal exists — one of `deleteObject`'s orphan-guard routes. */
  | "guarded"
  /** Tombstoned in the same transaction as its owner. */
  | "cascaded"
  /** Dangles, is reported by `GET /graph/integrity`, and `--repair` clears it through a door. */
  | "repairable"
  /** Dangles by design: the record must outlive its subject (the `audit_events` class). */
  | "historical"
  /** Dangles; NO delete statement exists anywhere, so a guard would make the owner permanently
   *  undeletable — the wall docs/graph.md §124 forbids. A door has to come first. */
  | "no-door-left"
  /** Dangles; every reader refuses to act on it rather than acting wrongly. */
  | "reader-fails-closed"
  /** Dangles; a delete exists but only inside an internal pass whose owner pool is live-only, so an
   *  orphan is never visited. Same "a door before a guard" ordering as `no-door-left`. */
  | "door-not-operator-reachable"
  /** The column names an object, but the row is not keyed to that object's life — it is a pointer
   *  whose dangling is meaningless (an actor, a producer, a prior version). */
  | "attribution-only";

interface TableVerdict {
  table: string;
  column: string;
  verdict: Verdict;
  why: string;
  /** TRUE when `scp_app` holds DELETE on this table. Recorded per ROW rather than derived, so gate
   *  (C) compares a written expectation against the catalog instead of restating it. */
  deleteGrant: boolean;
}

/**
 * EVERY column that can name a tombstoned `objects.id`, with what happens to the row when it does.
 *
 * Live counts are from a read-only measurement of the homelab estate on 2026-09-19 and are quoted in
 * docs/graph.md §125f rather than here, because a count goes stale and a verdict should not.
 */
const VERDICTS: TableVerdict[] = [
  // ---- the four that have been closed, and the two the graph itself handles -------------------
  {
    table: "source_mappings",
    column: "component_object_id",
    verdict: "guarded",
    why: "orphan-guard route 5 refuses the component delete; the tuple door clears strays",
    deleteGrant: true
  },
  {
    table: "executor_bindings",
    column: "target_object_id",
    verdict: "guarded",
    why: "orphan-guard route 6 refuses the target delete; `--repair` clears strays through the unbind door",
    deleteGrant: true
  },
  {
    table: "governance_move_rungs",
    column: "subject_object_id",
    verdict: "guarded",
    why: "orphan-guard route 7 refuses the container delete unless an upper rung pins the disable; `--repair` clears strays",
    deleteGrant: true
  },
  {
    table: "governance_move_rungs",
    column: "enabled_by_object_id",
    verdict: "attribution-only",
    why: "WHO enabled the rung. Deliberately unguarded: refusing to delete a user while any rung they enabled still stands would be a wall, and the attribution must survive them exactly as `audit_events.actor_id` does",
    deleteGrant: true
  },
  {
    table: "relationships",
    column: "from_id",
    verdict: "cascaded",
    why: "`deleteObject` tombstones self-authored edges in the same transaction; a replica edge is reported `repairable: false` and cleared by its own authority",
    deleteGrant: false
  },
  {
    table: "relationships",
    column: "to_id",
    verdict: "cascaded",
    why: "same cascade as `from_id`; a stack-managed dangling edge is repairable and NOT exempt — the IaC apply provably cannot see it (docs/graph.md §125e)",
    deleteGrant: false
  },

  // ---- the eight recorded in §125b as "no delete statement anywhere" ---------------------------
  // Seven of them still are. `governance_move_rungs` was not, and is now route 7 above.
  {
    table: "object_health",
    column: "object_id",
    verdict: "no-door-left",
    why: "no delete statement anywhere; `pushObjectHealth` is the only writer and it is an upsert. NOT inert: `getObjectHealthBatch` (POST /graph/health) applies no owner-liveness filter, so a caller passing a tombstoned id gets a live-looking health record. The fix is that reader's filter, not a guard over a table with no door",
    deleteGrant: false
  },
  {
    table: "control_bindings",
    column: "control_object_id",
    verdict: "no-door-left",
    why: "no delete statement anywhere — there is not even an unbind concept, only a repoint. NOT inert: `getControlBinding` (control-runner) and the scan-rule authoring guard both read it unfiltered, so a tombstoned control still evaluates and still counts as 'provable'. Structurally route 6's table with no door; the ordered fix is a DELETE /controls/{idOrUrn}/binding first, then a guard that names it",
    deleteGrant: false
  },
  {
    table: "gate_bindings",
    column: "topology_object_id",
    verdict: "no-door-left",
    why: "no delete statement AND no insert statement — a hand-operated seam (drizzle/0007). The wave arm can only match a topology id the caller supplies, and that is resolved live-only, so a dangling row can never be selected again",
    deleteGrant: false
  },
  {
    table: "pipeline_hook_runs",
    column: "change_object_id",
    verdict: "no-door-left",
    why: "no delete statement anywhere (the code says so at pipeline-hook-runs.ts: 'nothing deletes these rows today'). Terminal rows are the record that we asked",
    deleteGrant: true
  },
  {
    table: "pipeline_hook_runs",
    column: "component_object_id",
    verdict: "no-door-left",
    why: "as `change_object_id`. NOT inert for the NON-TERMINAL slice: `listNonTerminalHookRuns` is org-wide with no liveness filter, so a pending run on a tombstoned component is polled every tick. A reader fix, not a guard",
    deleteGrant: true
  },
  {
    table: "pipeline_hook_runs",
    column: "target_object_id",
    verdict: "no-door-left",
    why: "as `component_object_id`",
    deleteGrant: true
  },
  {
    table: "dependency_ingestion_stamps",
    column: "component_object_id",
    verdict: "no-door-left",
    why: "no delete statement, and drizzle/0065 REVOKEs DELETE from `scp_app` outright. Every reader reaches it only through a live-component resolution, so the dangle is unreachable in both directions — a receipt, not config",
    deleteGrant: false
  },
  {
    table: "dependency_bump_authorships",
    column: "change_object_id",
    verdict: "historical",
    why: "no delete statement; the row records THAT SCP AUTHORED THIS and must outlive the change. Nothing closes an open (`merged_at IS NULL`) row when its change goes terminal — real, but it does NOT block future bumps: `dispatchOneBump` REUSES the change id rather than refusing, and the lookup key includes `toVersion`, so a bump to a newer version misses it entirely. See docs/graph.md §125f",
    deleteGrant: false
  },
  {
    table: "dependency_bump_authorships",
    column: "component_object_id",
    verdict: "historical",
    why: "as `change_object_id`; the read surface resolves the component live-only, so a dangling row is unreachable through it",
    deleteGrant: false
  },
  {
    table: "config_source_stacks",
    column: "config_source_id",
    verdict: "no-door-left",
    why: "no delete statement (the DELETE grant is LATENT — granted by drizzle/0101, exercised by nothing). Retaining the row when the config source is soft-deleted is DELIBERATE, so the stack is not handed back to CLI-push while its manifest still sits in a repo. The gap is the exit: `applyPlan` then 409s for that stack name for ever, naming a bare uuid. A release door first, then a guard",
    deleteGrant: true
  },
  {
    table: "config_source_stacks",
    column: "team_object_id",
    verdict: "attribution-only",
    why: "recorded provenance for the delivery; no reader consumes it",
    deleteGrant: true
  },
  {
    table: "config_source_sync_queue",
    column: "config_source_id",
    verdict: "no-door-left",
    why: "no delete statement (LATENT DELETE grant from drizzle/0109); drained by stamping `processed_at`. The drain skips an entry whose registration is gone, so a stale entry is re-claimed and re-skipped — throughput, not correctness",
    deleteGrant: true
  },

  // ---- the five recorded in §125b as door-not-reachable / historical ---------------------------
  {
    table: "pipeline_hooks",
    column: "component_object_id",
    verdict: "door-not-operator-reachable",
    why: "`deleteHook`'s only callers are the IaC apply prune and the federation import, and the prune's owner pool is live-only, so an orphan is never visited. Live config, so this is the strongest of the five follow-ups — and the federation import writes a hook with no liveness check at all, which means a guard alone would not close it",
    deleteGrant: true
  },
  {
    table: "pipeline_evidence",
    column: "component_object_id",
    verdict: "historical",
    why: "the OBSERVED half — what actually happened. drizzle/0096 says in as many words that evidence must outlive a deleted subject",
    deleteGrant: true
  },
  {
    table: "pipeline_evidence",
    column: "target_object_id",
    verdict: "historical",
    why: "as `component_object_id`",
    deleteGrant: true
  },
  {
    table: "pipeline_evidence",
    column: "producer_subject_id",
    verdict: "attribution-only",
    why: "WHO said the window was quiet. drizzle/0096 leaves it un-FK'd deliberately so it can name a deleted subject",
    deleteGrant: true
  },
  {
    table: "component_rollouts",
    column: "component_object_id",
    verdict: "door-not-operator-reachable",
    why: "the apply prune is the only reaper and its pool is live-only. No reader exists yet, so a dangling row does nothing today — which is exactly why it must be re-verdicted when one lands",
    deleteGrant: true
  },
  {
    table: "component_convergence",
    column: "component_object_id",
    verdict: "door-not-operator-reachable",
    why: "as `component_rollouts`",
    deleteGrant: true
  },
  {
    table: "component_convergence",
    column: "target_object_id",
    verdict: "door-not-operator-reachable",
    why: "as `component_object_id`, with a second dangle vector: the prune needs BOTH ends live-nameable",
    deleteGrant: true
  },
  {
    table: "component_dependencies",
    column: "component_object_id",
    verdict: "door-not-operator-reachable",
    why: "the ingestion prune is per (repo, manifest path) and both its ingresses enumerate live components only. NOT inert: `resolveDeclaredComponentLines` scans org-wide with no liveness filter, which keeps a dead component's coordinates on the version-poll work list. A reader fix, not a guard over live inventory",
    deleteGrant: true
  },
  {
    table: "change_wave_targets",
    column: "target_object_id",
    verdict: "reader-fails-closed",
    why: "`coordination/target-liveness.ts` parks the target `target_deleted` with a Decision and an audit event before anything dispatches. The row is a plan SNAPSHOT carrying the rollback pre-image, so it must outlive its target; and there is no delete statement, so a guard would make every object that was ever a wave target undeletable",
    deleteGrant: false
  },

  // ---- the rest of the population, by class ----------------------------------------------------
  {
    table: "audit_events",
    column: "subject_id",
    verdict: "historical",
    why: "append-only; the delete itself writes one",
    deleteGrant: false
  },
  {
    table: "audit_events",
    column: "actor_id",
    verdict: "attribution-only",
    why: "append-only; the actor must outlive their own deletion",
    deleteGrant: false
  },
  {
    table: "decisions",
    column: "subject_id",
    verdict: "historical",
    why: "an engine verdict must outlive its subject (charter principle 6)",
    deleteGrant: false
  },
  {
    table: "plans",
    column: "actor_id",
    verdict: "attribution-only",
    why: "who ran the plan",
    deleteGrant: false
  },
  {
    table: "changes",
    column: "object_id",
    verdict: "historical",
    why: "a change IS a graph object; the row is its projection and is tombstoned with it",
    deleteGrant: false
  },
  {
    table: "changes",
    column: "topology_object_id",
    verdict: "historical",
    why: "the topology a change compiled against, snapshotted",
    deleteGrant: false
  },
  {
    table: "changes",
    column: "rollback_of_object_id",
    verdict: "attribution-only",
    why: "the change this one rolls back; a pointer into history",
    deleteGrant: false
  },
  {
    table: "change_plans",
    column: "change_object_id",
    verdict: "historical",
    why: "the compiled plan is a SNAPSHOT of what would be done; it must outlive the change it describes, and no delete statement exists",
    deleteGrant: false
  },
  {
    table: "change_plans",
    column: "topology_object_id",
    verdict: "historical",
    why: "as `change_object_id`",
    deleteGrant: false
  },
  {
    table: "campaign_plans",
    column: "campaign_object_id",
    verdict: "historical",
    why: "as `change_plans`",
    deleteGrant: false
  },
  {
    table: "campaign_plans",
    column: "topology_object_id",
    verdict: "historical",
    why: "as `change_plans`",
    deleteGrant: false
  },
  {
    table: "campaign_wave_targets",
    column: "target_object_id",
    verdict: "reader-fails-closed",
    why: "the campaign twin of `change_wave_targets`",
    deleteGrant: false
  },
  {
    table: "campaign_wave_targets",
    column: "member_change_object_id",
    verdict: "historical",
    why: "the member change this wave target produced",
    deleteGrant: false
  },
  {
    table: "control_runs",
    column: "change_object_id",
    verdict: "historical",
    why: "a run is evidence; drizzle/0064 stamps the plugin module at insert precisely so history is not relabelled later",
    deleteGrant: false
  },
  {
    table: "control_runs",
    column: "control_object_id",
    verdict: "historical",
    why: "as `change_object_id`",
    deleteGrant: false
  },
  {
    table: "approval_requests",
    column: "change_object_id",
    verdict: "historical",
    why: "the approval record must outlive its subject",
    deleteGrant: false
  },
  {
    table: "approval_requests",
    column: "policy_object_id",
    verdict: "historical",
    why: "which policy demanded the approval, snapshotted",
    deleteGrant: false
  },
  {
    table: "approval_requests",
    column: "scope_object_id",
    verdict: "historical",
    why: "the scope the quorum was computed at, snapshotted",
    deleteGrant: false
  },
  {
    table: "approval_votes",
    column: "voter_object_id",
    verdict: "attribution-only",
    why: "who voted; must outlive them",
    deleteGrant: false
  },
  {
    table: "imported_approval_evidence",
    column: "change_object_id",
    verdict: "historical",
    why: "imported evidence about a change",
    deleteGrant: false
  },
  {
    table: "freezes",
    column: "object_id",
    verdict: "cascaded",
    why: "a freeze IS a graph object; the importer lifts the projection in the same transaction and the local door refuses the type",
    deleteGrant: false
  },
  {
    table: "freezes",
    column: "scope_object_id",
    verdict: "historical",
    why: "what the freeze covered, snapshotted",
    deleteGrant: false
  },
  {
    table: "change_source_events",
    column: "reported_by_object_id",
    verdict: "attribution-only",
    why: "who reported the event",
    deleteGrant: false
  },
  {
    table: "change_source_events",
    column: "resulting_change_object_id",
    verdict: "historical",
    why: "what the event produced",
    deleteGrant: false
  },
  {
    table: "continuous_probe_retractions",
    column: "component_object_id",
    verdict: "historical",
    why: "a retraction is a record of something withdrawn",
    deleteGrant: true
  },
  {
    table: "federation_relay_builds",
    column: "change_object_id",
    verdict: "historical",
    why: "the record of a relay tarball that was built for a change; no delete statement, and a dangling row drives nothing — the build already happened",
    deleteGrant: false
  },
  {
    table: "federation_unattached_change_status",
    column: "change_object_id",
    verdict: "historical",
    why: "a peer's status for a change this domain has not attached",
    deleteGrant: true
  },
  {
    table: "federation_peer_observations",
    column: "change_object_id",
    verdict: "historical",
    why: "what a PEER observed; deliberately its own table (drizzle/0116) so a peer can never write `change_wave_targets`. The DELETE grant is LATENT — the repo only inserts — and this census caught the gap between the grant and the statement, which is the whole point of gate (C)",
    deleteGrant: true
  },
  {
    table: "federation_peer_observations",
    column: "component_object_id",
    verdict: "historical",
    why: "as `change_object_id`",
    deleteGrant: true
  },
  {
    table: "federation_peer_observations",
    column: "target_object_id",
    verdict: "historical",
    why: "as `change_object_id`",
    deleteGrant: true
  },
  {
    table: "dependency_line_producers",
    column: "producer_object_id",
    verdict: "door-not-operator-reachable",
    why: "a retraction is keyed by COORDINATE, not by the object, so the door reaches a dangling row — but nothing enumerates them for an operator",
    deleteGrant: true
  },
  {
    table: "dependency_line_producers",
    column: "declared_by_object_id",
    verdict: "attribution-only",
    why: "who declared the producer",
    deleteGrant: true
  },
  {
    table: "role_bindings",
    column: "subject_id",
    verdict: "no-door-left",
    why: "a revoke is a hard DELETE addressed by BINDING id, so a binding on a deleted subject is removable — but nothing refuses the subject's delete. The administrator floor is the guard that matters here and it runs on every object delete",
    deleteGrant: true
  },
  {
    table: "role_bindings",
    column: "scope_object_id",
    verdict: "no-door-left",
    why: "as `subject_id`; a binding AT a deleted scope is still seeded into `scope_expand`, and re-scoping (not deletion) is the open question recorded elsewhere",
    deleteGrant: true
  },
  {
    table: "users",
    column: "object_id",
    verdict: "no-door-left",
    why: "no delete statement on `users` keyed to a tombstoned object; `local-auth.ts` has no liveness check, so the user still authenticates as a tombstoned subject. A door before a guard",
    deleteGrant: false
  }
];

describe("the dangling-row census, as a gate", () => {
  let server: ListeningTestServer;
  let org: TestOrg;

  beforeAll(async () => {
    server = await listenTestServer();
    org = await createTestOrg(server, "dangling-census");
  });
  afterAll(async () => {
    await server?.close();
  });

  const key = (t: string, c: string): string => `${t}.${c}`;

  /** Every column in the live schema that can name an `objects.id`, derived from the CATALOG.
   *
   *  Three arms, because one convention does not cover the population and a single pattern is where
   *  the next instance hides: the foreign keys (authoritative, but several object columns carry no
   *  FK at all), every uuid column named `%object_id%`, and the object-naming columns that follow
   *  neither convention (`subject_id`, `actor_id`, …) — that third arm is a NAME list rather than a
   *  pattern precisely so a new name cannot join it silently; it is asserted non-empty below. */
  async function catalogColumns(): Promise<string[]> {
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute<{ tbl: string; col: string }>(sql`
        select distinct tbl, col from (
          select c.conrelid::regclass::text as tbl, a.attname as col
          from pg_constraint c
          join unnest(c.conkey) k(attnum) on true
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
          where c.contype = 'f' and c.confrelid = 'public.objects'::regclass
          union
          select c.table_name, c.column_name
          from information_schema.columns c
          join information_schema.tables tt
            on tt.table_schema = c.table_schema
           and tt.table_name = c.table_name
           and tt.table_type = 'BASE TABLE'
          where c.table_schema = 'public'
            and c.data_type = 'uuid'
            and (c.column_name like '%object\\_id%'
                 or c.column_name in ('subject_id', 'actor_id', 'producer_subject_id'))
        ) s
        order by 1, 2
      `)
    );
    return (rows as unknown as { rows: { tbl: string; col: string }[] }).rows.map((r) =>
      key(r.tbl, r.col)
    );
  }

  it("(A) every column that can name a tombstoned object carries a recorded verdict", async () => {
    // The gate that catches the NEXT table. A new `%object_id%` column, or a new foreign key to
    // `objects`, fails here — which is the whole reason this is a test and not a paragraph.
    const recorded = new Set(VERDICTS.map((v) => key(v.table, v.column)));
    const missing = (await catalogColumns()).filter((k) => !recorded.has(k));
    expect(
      missing,
      "a new column that can name a tombstoned object needs a verdict in VERDICTS and a line in docs/graph.md §125f — decide guard / door / leave, and say why"
    ).toEqual([]);
  });

  it("(B) no recorded verdict names a column the schema no longer has", async () => {
    // The other direction, and it is not symmetry for its own sake: a stale ruling reads as a
    // considered decision about a thing that is gone, which is worse than no ruling at all.
    const catalog = new Set(await catalogColumns());
    expect(
      VERDICTS.map((v) => key(v.table, v.column)).filter((k) => !catalog.has(k)),
      "a verdict naming a dropped or renamed column must be removed or re-pointed"
    ).toEqual([]);
  });

  it("(B2) the third derivation arm is not silently empty", async () => {
    // `subject_id`/`actor_id`/`producer_subject_id` follow neither convention, so they are matched by
    // NAME. A rename would make that arm quietly match nothing and gate (A) would go on passing over
    // a shrinking population — the known-positive control this census needs.
    const catalog = await catalogColumns();
    for (const name of ["subject_id", "actor_id", "producer_subject_id"]) {
      expect(
        catalog.filter((k) => k.endsWith(`.${name}`)).length,
        `no column named '${name}' in the schema — the name arm has gone stale`
      ).toBeGreaterThan(0);
    }
  });

  it("(C) a DELETE grant appearing where a verdict says there is no door fails the census", async () => {
    // The derived proxy for "somebody built a door". Under FORCE RLS a write needs a grant AND a
    // policy, so a new delete verb cannot ship without a `GRANT DELETE` in its migration. Read out of
    // the catalog rather than by attempting a write: the integration harness connects as the
    // superuser, which bypasses grants outright and would hide the answer either way.
    const rows = await withTenantTx(server.deps.db, org.orgId, (tx) =>
      tx.execute<{ table_name: string }>(sql`
        select distinct table_name
        from information_schema.role_table_grants
        where grantee = 'scp_app' and table_schema = 'public' and privilege_type = 'DELETE'
      `)
    );
    const granted = new Set(
      (rows as unknown as { rows: { table_name: string }[] }).rows.map((r) => r.table_name)
    );
    // Known-positive control: if this set is empty the query is wrong, not the schema, and every
    // comparison below would pass vacuously.
    expect(granted.size, "no DELETE grants at all — the catalog query is wrong").toBeGreaterThan(0);

    const drift = VERDICTS.filter((v) => granted.has(v.table) !== v.deleteGrant).map(
      (v) =>
        `${key(v.table, v.column)} recorded deleteGrant=${v.deleteGrant}, catalog says ${granted.has(v.table)}`
    );
    expect(
      drift,
      "a DELETE grant gained or lost changes what the verdict can claim: a 'no-door-left' ruling rests on there being nothing that could delete the row, and a 'guarded' one rests on the door it names still being able to"
    ).toEqual([]);
  });

  it("(D) no verdict of `guarded` or `repairable` sits on a table with no DELETE grant", async () => {
    // The internal consistency the other three cannot see. A guard is only legitimate when the
    // refusal can be acted on, and a row whose table `scp_app` cannot delete has no door to act at —
    // that is the wall docs/graph.md §124 forbids. `cascaded` is exempt: an edge is soft-deleted, so
    // its cleanup is an UPDATE and needs no DELETE grant at all.
    const offenders = VERDICTS.filter(
      (v) => (v.verdict === "guarded" || v.verdict === "repairable") && !v.deleteGrant
    ).map((v) => key(v.table, v.column));
    expect(
      offenders,
      "a guard whose door cannot delete is a wall — add the door and its grant first"
    ).toEqual([]);
  });
});
