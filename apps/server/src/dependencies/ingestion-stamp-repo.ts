import { and, eq, inArray, sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { dependencyIngestionStamps, type IngestionStampManifest } from "../db/schema.js";

/**
 * M21.7 — THE DEPENDENCY-INGESTION STAMP repo: one row per component, saying whether that
 * component's dependency manifests were ever read, when, by which producer, and with what result
 * (ADR-0032 §4; migration 0065 carries the full derivation).
 *
 * ============================================================================================
 * WHAT IT IS FOR, IN ONE SENTENCE
 * ============================================================================================
 * `component_dependencies.observed_at` is PER ROW, so a component with ZERO rows carries no
 * timestamp at all and three different truths collapse into one empty list — never ingested;
 * ingested fine and genuinely declares nothing; ingestion ran and every manifest was unreadable.
 * A reader that cannot tell them apart has to render "no dependencies" over all three, and the
 * third rendered as the second is the class of dishonesty this codebase treats as a defect.
 *
 * ============================================================================================
 * THE ROW IS PER COMPONENT; THE EVIDENCE IS PER (COMPONENT, REPOSITORY). THE WRITER MERGES.
 * ============================================================================================
 * This was wrong in the first cut and it produced exactly the lie above, by two routes:
 *
 *  - A COMPONENT IS FED BY SEVERAL REPOSITORIES. `source_mappings` is many-per-component and a pass
 *    reads exactly ONE repository, so `acme/widgets` (a `go.mod`) and `acme/charts` (a `Dockerfile`)
 *    each produce their own pass. Replacing the whole row, a widgets pass whose read FAILED wrote
 *    `unreadable`, and a charts pass minutes later wrote `ok` over it. State (iii) became state (ii)
 *    on a component whose manifests could not be read.
 *  - A REFUSAL FOR AN UNMAPPED REPOSITORY IS NOT EVIDENCE ABOUT THE MANIFESTS. An accepted change
 *    can target a component from a repository none of its mappings names; the ingestion refuses it
 *    without fetching (correctly — see `repoManifestScope`). Written as `unreadable` over the row,
 *    that refusal destroyed the good receipt the previous pass had just written. "This repository is
 *    not this component's" and "this component's manifests are unreadable" are different facts.
 *
 * So {@link mergeIngestionStamp} — pure, and the whole of the decision — folds a pass into the
 * stored row: it replaces the `(repo, *)` slice the pass holds evidence over, KEEPS every other
 * repository's slice, and recomputes the component-level `outcome` and `rows_written` ACROSS the
 * merged set. A pass that read no repository at all (the gate was closed, no repository was named,
 * the named one is unmapped) replaces nothing.
 *
 * The primary key is unchanged — `(org_id, component_object_id)`, one row per component — because
 * the question the stamp answers ("what does this component's empty inventory mean?") is asked of
 * a COMPONENT. Repository-level detail lives inside the jsonb, where a reader that does not care
 * about it does not have to fold rows to get a component-level answer.
 *
 * ============================================================================================
 * THREE FUNCTIONS TOUCH THE TABLE, AND ONLY ONE OF THEM WRITES
 * ============================================================================================
 * {@link recordIngestionStamp} is the ONE write door and it is called from exactly one place —
 * `inventory-ingestion.ts`'s `ingestComponentManifests`, which is the choke point BOTH producers go
 * through (the event-driven loop and the operator backfill). That is deliberate: a stamp written at
 * each producer would be two places for "did we remember to stamp?" to diverge, and the third
 * producer would arrive without one. `source` is a required input of `ingestComponentManifests`
 * rather than something this function infers, because a label derived from which caller-shaped
 * field happened to be set is exactly the provenance-label mistake this repo has already shipped
 * once (ADR-0030 §2, charter principle 6).
 *
 * The two reads are point lookups on the primary key. There is no list-the-org read and no join:
 * everything here descends `(org_id, component_object_id)`.
 */

/** Which producer wrote a stamp. The closed set lives here, at the write door's parameter, rather
 *  than in a CHECK constraint — see the column comment in drizzle/0065 for why. */
export type IngestionStampSource = "loop" | "backfill";

/** What a pass established about a component's manifests as a whole. See
 *  `dependencyIngestionStamps.outcome`. */
export type IngestionStampOutcome = "ok" | "partial" | "unreadable" | "not_enabled";

export type { IngestionStampManifest };

/**
 * One manifest entry as a PASS produces it — before the write door attributes it to a repository
 * and to an instant.
 *
 * `repo` and `at` are deliberately NOT the caller's to supply: they are the same for every entry of
 * one pass, and a caller that could set them per entry could also fabricate a slice belonging to a
 * repository it never read, which is the merge's whole safety property.
 */
export interface IngestionStampObservation {
  readonly path: string;
  readonly outcome: IngestionStampManifest["outcome"];
  /** `component_dependencies` rows this manifest's observation wrote. 0 on anything not read. */
  readonly rows: number;
  readonly detail?: string;
}

/** One stamp, as callers read it. Timestamps are ISO strings, the same shape
 *  `toComponentDependency` returns, so a caller never has to know whether a `Date` survived the
 *  driver. */
export interface DependencyIngestionStamp {
  readonly orgId: string;
  readonly componentObjectId: string;
  readonly lastAttemptAt: string;
  readonly source: IngestionStampSource;
  readonly outcome: IngestionStampOutcome;
  readonly detail: string | null;
  /** 0 IS LEGAL AND MEANINGFUL — `outcome: "ok"` with `rowsWritten: 0` is "read fine, genuinely
   *  declares nothing", the state that could not be expressed before this table. Summed across
   *  every repository's slice, so it is a fact about the COMPONENT and not about the last pass. */
  readonly rowsWritten: number;
  readonly manifests: readonly IngestionStampManifest[];
  readonly createdAt: string;
}

export interface RecordIngestionStampInput {
  readonly componentObjectId: string;
  /** WHEN THIS PASS LOOKED — the caller passes its own read time, never `now()`. See the
   *  ordering note on {@link mergeIngestionStamp}. */
  readonly lastAttemptAt: Date;
  readonly source: IngestionStampSource;
  /**
   * THE REPOSITORY THIS PASS HOLDS EVIDENCE ABOUT, or `null` when it holds none.
   *
   * `null` is not "unknown", it is a CLAIM: this pass looked at no repository, so it may not
   * replace any slice and may not turn a good receipt into a bad one. The three callers that pass
   * it are the gate refusal, the "no repo was named" refusal and the "no mapping names this
   * repository" refusal — the last of which is the one that used to overwrite a healthy stamp with
   * `unreadable`. Over an existing row the latter two are a complete no-op; only the gate refusal
   * carries a fact about the component (`not_enabled`) and so is allowed to restate the row.
   *
   * Non-null means the pass reached the read phase for that repository and its `manifests` are the
   * COMPLETE current picture of it: every candidate path lands in exactly one of read / absent /
   * skipped, so a path missing from the slice is a path that is genuinely no longer known there.
   * That is why a slice is REPLACED rather than unioned per path — a per-path union would keep an
   * `ok` entry for a manifest that has since been deleted, forever.
   */
  readonly repo: string | null;
  /** THIS PASS'S OWN verdict. It decides the row only where the merged evidence cannot: the
   *  `not_enabled` gate (a fact about the component, not about any manifest) and the empty-evidence
   *  case. Otherwise the merged set decides. */
  readonly outcome: IngestionStampOutcome;
  readonly detail?: string | null;
  /** This pass's per-path entries for {@link repo}. Ignored — and asserted empty — when `repo` is
   *  `null`, because an entry with no repository could never be replaced by a later pass. */
  readonly manifests?: readonly IngestionStampObservation[];
}

function toStamp(row: typeof dependencyIngestionStamps.$inferSelect): DependencyIngestionStamp {
  return {
    orgId: row.orgId,
    componentObjectId: row.componentObjectId,
    lastAttemptAt: row.lastAttemptAt.toISOString(),
    source: row.source,
    outcome: row.outcome,
    detail: row.detail,
    rowsWritten: row.rowsWritten,
    // Defensive `?? []`: the column is NOT NULL with a `'[]'` default, so this is unreachable
    // through the write door — but a jsonb column read as `null` would otherwise crash every
    // consumer that maps over it, and the honest reading of a missing array is an empty one.
    manifests: row.manifests ?? [],
    createdAt: row.createdAt.toISOString()
  };
}

/** The row fields a fold produces, or `null` for "this pass changes nothing, write nothing".
 *  `createdAt` is deliberately absent — see the write door. */
export interface MergedIngestionStamp {
  readonly lastAttemptAt: Date;
  readonly source: IngestionStampSource;
  readonly outcome: IngestionStampOutcome;
  readonly detail: string | null;
  readonly rowsWritten: number;
  readonly manifests: IngestionStampManifest[];
}

/** Sorted by repository, then path, then outcome — a stable order, so two passes that establish the
 *  same thing produce the same jsonb rather than a reordering that reads as a change. */
function entryKey(entry: IngestionStampManifest): string {
  return `${entry.repo} ${entry.path} ${entry.outcome}`;
}

/** An instant, or `null` when the value is absent or unparseable. Used instead of a bare
 *  `Date.parse` because `NaN` propagates silently through `Math.max` and would turn "this pass is
 *  newer" into `false` for every comparison after it. */
function instantOf(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * FOLD ONE PASS INTO THE STORED ROW. Pure, exported, and unit-tested directly — the ordering rules
 * below are the whole of the correctness argument for this table and they must be assertable
 * without a database.
 *
 * ============================================================================================
 * WHAT REPLACES WHAT
 * ============================================================================================
 *  - A pass that reached NO repository and resolved no component-level fact returns the stored row
 *    untouched — see the early return, which is the whole of the unmapped-repository fix.
 *  - Otherwise the pass replaces the slice for ITS OWN repository, and only if it is at least as
 *    recent as the newest entry stored for that repository. Every other repository's slice is
 *    carried forward untouched.
 *  - `outcome` and `rows_written` are then RECOMPUTED over the merged set: `ok` when every entry
 *    was read, `unreadable` when none was, `partial` for the mixed case — which is now reachable
 *    ACROSS repositories, and is the reading a component with one healthy and one broken source
 *    actually deserves.
 *  - `last_attempt_at`, `source` and `detail` describe the LATEST attempt on the component, so a
 *    late-delivered older pass leaves them alone even where its own slice still applies.
 *
 * ============================================================================================
 * WHY ORDERING IS PER REPOSITORY AND `>=` RATHER THAN `>`
 * ============================================================================================
 * Both delivery hops are at-least-once and the ingestion queue is a competing consumer, so a retry
 * of an earlier accept can be delivered after a later one. Ordering has to be per repository:
 * ordering the whole row would DROP an older-but-only pass over repository B whenever a newer pass
 * over repository A had landed first, which loses B's verdict entirely — the same silence this
 * table replaces, arriving by a race instead of by a bug.
 *
 * `>=` because two passes stamped within the same millisecond carry no order between them, so
 * either winning is equally correct, and `>=` lets a re-run at the same instant refresh the slice
 * rather than silently doing nothing.
 *
 * THE RESIDUE, STATED: this orders passes by WHEN THEY LOOKED, not by commit ancestry — the same
 * residue, for the same reason, that `inventory-ingestion.ts`'s row-level guard names (two commit
 * shas carry no order between them and this system has no history walk behind the plugin seam).
 * The next accepted change, or a backfill, re-derives the truth.
 *
 * ============================================================================================
 * `not_enabled` IS AN OVERRIDE, NOT AN ENTRY
 * ============================================================================================
 * A closed gate is a fact about the COMPONENT — nothing was fetched, in any repository — so it
 * cannot be expressed as evidence about a path and it dominates the computed outcome while it is
 * the latest word. The stored entries are kept rather than cleared: the `component_dependencies`
 * rows they describe are still there (a closed gate prunes nothing), so deleting the explanation
 * for rows that still exist would trade one silence for another.
 */
export function mergeIngestionStamp(
  stored: DependencyIngestionStamp | null,
  pass: RecordIngestionStampInput
): MergedIngestionStamp | null {
  const attemptAt = pass.lastAttemptAt;
  const attemptMs = attemptAt.getTime();
  const storedMs = stored === null ? null : instantOf(stored.lastAttemptAt);
  /** Is this pass the latest word ON THE COMPONENT? Decides the row-level fields only. */
  const isLatestAttempt = storedMs === null || attemptMs >= storedMs;

  // ==========================================================================================
  // A PASS THAT REACHED NO REPOSITORY AND RESOLVED NO COMPONENT-LEVEL FACT CHANGES NOTHING.
  // ==========================================================================================
  // The unmapped-repository refusal, and the "no repo was named" one. Neither looked at a manifest,
  // so neither may revise the verdict — that was the defect. Neither may advance `last_attempt_at`
  // either, and that is the same argument rather than a separate one: the column is what a reader
  // means by FRESHNESS, and moving it for a pass that read nothing would report a three-month-old
  // inventory as looked at a minute ago. The refusal is still worth logging, and the loop and the
  // backfill response both do; it is not worth overwriting a receipt with.
  //
  // With NO row it is a different question — "never attempted" is the absence of a row, and this
  // component HAS been attempted — so the refusal falls through and creates one.
  //
  // `null` rather than a copy of the stored row, so the write door can skip the UPDATE entirely: on
  // any real estate these refusals are the common case (an org-wide backfill refuses for every
  // unsubscribed component), and restating a byte-identical row per accepted change is the
  // persist-on-change shape ADR-0024's 1.44 GB/day measurement is about, in dead tuples instead of
  // appended rows.
  if (stored !== null && pass.repo === null && pass.outcome !== "not_enabled") return null;

  // An entry with no repository cannot be attributed, so it cannot be replaced by a later pass
  // either — it would sit in the array forever. The write door cannot produce one; this drops the
  // rows a pre-merge build of this branch wrote into a developer's database (the table has never
  // shipped, so that is the only place they exist).
  const storedEntries = (stored?.manifests ?? []).filter(
    (entry) => typeof entry.repo === "string" && entry.repo !== ""
  );
  const otherRepositories = storedEntries.filter((entry) => entry.repo !== pass.repo);
  const ownRepository = storedEntries.filter((entry) => entry.repo === pass.repo);

  // The newest evidence already stored FOR THIS PASS'S REPOSITORY. `null` when there is none, which
  // is what lets a first pass write its slice.
  const sliceMs = ownRepository.reduce<number | null>((newest, entry) => {
    const at = instantOf(entry.at);
    if (at === null) return newest;
    return newest === null ? at : Math.max(newest, at);
  }, null);

  const repo = pass.repo;
  const observed: IngestionStampManifest[] =
    repo === null
      ? []
      : (pass.manifests ?? []).map((entry) => ({
          repo,
          path: entry.path,
          outcome: entry.outcome,
          rows: Number.isFinite(entry.rows) ? entry.rows : 0,
          at: attemptAt.toISOString(),
          ...(entry.detail !== undefined ? { detail: entry.detail } : {})
        }));

  const speaksForItsRepository = repo !== null && (sliceMs === null || attemptMs >= sliceMs);
  const manifests = [
    ...otherRepositories,
    ...(speaksForItsRepository ? observed : ownRepository)
  ].sort((a, b) => (entryKey(a) < entryKey(b) ? -1 : entryKey(a) > entryKey(b) ? 1 : 0));

  const read = manifests.filter((entry) => entry.outcome === "ok").length;
  /** What the merged EVIDENCE says, or `null` when there is none to say it. */
  const fromEvidence: IngestionStampOutcome | null =
    manifests.length === 0
      ? null
      : read === 0
        ? "unreadable"
        : read === manifests.length
          ? "ok"
          : "partial";

  // `detail` follows whichever verdict won, so the sentence and the outcome can never describe
  // different things. Where the evidence decides, the per-path details ARE the explanation.
  let outcome: IngestionStampOutcome;
  let detail: string | null;
  if (isLatestAttempt && pass.outcome === "not_enabled") {
    outcome = "not_enabled";
    detail = pass.detail ?? null;
  } else if (!isLatestAttempt && stored?.outcome === "not_enabled") {
    // A closed gate is still the latest word about the component; this pass only contributed a
    // slice of older evidence.
    outcome = "not_enabled";
    detail = stored.detail;
  } else if (fromEvidence !== null) {
    outcome = fromEvidence;
    detail = null;
  } else if (stored !== null && !isLatestAttempt) {
    // NO EVIDENCE LEFT IN THE MERGED SET and this pass is not the latest word, so the row keeps
    // what it had. Reachable when a late-delivered older pass found its repository empty.
    outcome = stored.outcome;
    detail = stored.detail;
  } else {
    // NO EVIDENCE, AND THIS PASS IS THE LATEST WORD. Either it looked and every probe came back
    // "not there" — `ok` with 0 rows, "we looked and it genuinely declares nothing", the whole
    // reason this table exists — or it is the first attempt on this component and it refused,
    // which is exactly what the row is for saying (the alternative, no row at all, would mean
    // "never attempted" and be false). The early return above is what keeps the first reading out
    // of reach of a pass that did NOT look.
    outcome = pass.outcome;
    detail = pass.detail ?? null;
  }

  return {
    lastAttemptAt: isLatestAttempt ? attemptAt : new Date(storedMs ?? attemptMs),
    source: isLatestAttempt || stored === null ? pass.source : stored.source,
    outcome,
    detail,
    rowsWritten: manifests.reduce((sum, entry) => sum + entry.rows, 0),
    manifests
  };
}

/**
 * RESTATE what is known about this component, folding in what this pass established. Upserted on
 * `(org_id, component_object_id)` — one row per component, forever.
 *
 * READ-MODIFY-WRITE, SERIALISED BY THE SAME ADVISORY LOCK THE INGESTION'S PHASE 3 TAKES. The merge
 * needs the stored row, so two concurrent passes over the same component would otherwise both read
 * the pre-state and the second would write back a row missing the first's slice — the lost update
 * that per-repository merging exists to prevent, reintroduced at the write. The key is identical to
 * `ingestComponentManifests`' (`hashtext(org), hashtext(component)`), so a phase-3 caller already
 * holds it and re-taking it is free.
 *
 * WHAT THAT LINE ACTUALLY BUYS, STATED HONESTLY, because a guard nobody can redden is a guard
 * nobody should trust: every pass that writes a SLICE goes through phase 3, which already holds
 * this lock, so the concurrency test in `inventory-ingestion.integration.test.ts` stays green with
 * the line deleted (measured). The one writer outside that lock is the gate refusal, and it can
 * only race an ingest of the same component if the gate FLIPS between the two passes' gate reads —
 * an operator disabling a component mid-release. Its lost update would write stale manifests back
 * over a slice the ingest had just written, until the next pass re-derives. That interleaving
 * cannot be produced deterministically from a test without a seam invented for the test, so the
 * line is defence in depth carrying a stated residue rather than a pinned property. The refusals
 * that establish nothing now write nothing at all (see the fold), which removes the other two.
 *
 * `createdAt` is deliberately absent from the update set: it records when this component was FIRST
 * attempted, and a re-observation must not reset it — the same reason
 * `upsertComponentDependency` keeps `created_at` out of its own set list. Nothing but the literal
 * list below enforces that, so it is pinned behaviourally in
 * `inventory-ingestion.integration.test.ts` rather than by this paragraph.
 */
export async function recordIngestionStamp(
  tx: TenantTx,
  orgId: string,
  input: RecordIngestionStampInput
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${orgId}), hashtext(${input.componentObjectId}))`
  );
  const stored = await findIngestionStampByComponent(tx, orgId, input.componentObjectId);
  const merged = mergeIngestionStamp(stored, input);
  // NOTHING TO SAY, SO NOTHING IS WRITTEN — not even a byte-identical restatement. See the fold.
  if (merged === null) return;
  await tx
    .insert(dependencyIngestionStamps)
    .values({
      orgId,
      componentObjectId: input.componentObjectId,
      lastAttemptAt: merged.lastAttemptAt,
      source: merged.source,
      outcome: merged.outcome,
      detail: merged.detail,
      rowsWritten: merged.rowsWritten,
      manifests: merged.manifests
    })
    .onConflictDoUpdate({
      target: [dependencyIngestionStamps.orgId, dependencyIngestionStamps.componentObjectId],
      set: {
        lastAttemptAt: merged.lastAttemptAt,
        source: merged.source,
        outcome: merged.outcome,
        detail: merged.detail,
        rowsWritten: merged.rowsWritten,
        manifests: merged.manifests
      }
    });
}

/**
 * THE STAMP FOR ONE COMPONENT, or `null` when there is none.
 *
 * `null` MEANS "NEVER ATTEMPTED" and nothing else — there is no `outcome` value for it, because the
 * only writer of "we have never looked" would be a pass that ran. A caller must not render `null`
 * as "no dependencies"; that is the exact conflation this table exists to break.
 *
 * One index descent on the primary key.
 */
export async function findIngestionStampByComponent(
  tx: TenantTx,
  orgId: string,
  componentObjectId: string
): Promise<DependencyIngestionStamp | null> {
  const [row] = await tx
    .select()
    .from(dependencyIngestionStamps)
    .where(
      and(
        eq(dependencyIngestionStamps.orgId, orgId),
        eq(dependencyIngestionStamps.componentObjectId, componentObjectId)
      )
    )
    .limit(1);
  return row ? toStamp(row) : null;
}

/**
 * The same lookup for MANY components in ONE round trip — the list view's read.
 *
 * It is a genuine batch and not a loop wearing a batch's name: `IN` over the primary key's second
 * column, inside its `org_id` prefix, so the whole call is one index range scan rather than N
 * descents. A component with no stamp is ABSENT from the result rather than present as a null — the
 * caller keys the array by `componentObjectId` and a missing key is "never attempted", which is the
 * same reading {@link findIngestionStampByComponent}'s `null` carries.
 *
 * Returns nothing for an empty id list rather than scanning the org.
 */
export async function listIngestionStampsByComponents(
  tx: TenantTx,
  orgId: string,
  componentObjectIds: readonly string[]
): Promise<DependencyIngestionStamp[]> {
  if (componentObjectIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(dependencyIngestionStamps)
    .where(
      and(
        eq(dependencyIngestionStamps.orgId, orgId),
        inArray(dependencyIngestionStamps.componentObjectId, [...new Set(componentObjectIds)])
      )
    );
  return rows.map(toStamp);
}
