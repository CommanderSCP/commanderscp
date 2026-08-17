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
 * THREE FUNCTIONS, AND ONLY ONE OF THEM WRITES
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
   *  declares nothing", the state that could not be expressed before this table. */
  readonly rowsWritten: number;
  readonly manifests: readonly IngestionStampManifest[];
  readonly createdAt: string;
}

export interface RecordIngestionStampInput {
  readonly componentObjectId: string;
  /** WHEN THIS PASS LOOKED — the caller passes its own read time, never `now()`. See the
   *  monotonicity note on {@link recordIngestionStamp}. */
  readonly lastAttemptAt: Date;
  readonly source: IngestionStampSource;
  readonly outcome: IngestionStampOutcome;
  readonly detail?: string | null;
  readonly rowsWritten: number;
  readonly manifests?: readonly IngestionStampManifest[];
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

/**
 * RESTATE what the latest pass established about this component. Upserted on
 * `(org_id, component_object_id)` — one row per component, forever.
 *
 * ============================================================================================
 * AN OLDER PASS CANNOT OVERWRITE A NEWER ONE
 * ============================================================================================
 * `setWhere` refuses the update unless the incoming `last_attempt_at` is at least the stored one.
 * The same race `inventory-ingestion.ts`'s phase-3 ordering guard exists for reaches here: both
 * delivery hops are at-least-once, the ingestion queue is a competing consumer, and a retry of an
 * earlier accept can be delivered after a later one. Without this an older pass would land last and
 * the stamp would describe a state the inventory is no longer in — an "unreadable" receipt sitting
 * over rows a later, successful pass wrote.
 *
 * IT IS DELIBERATELY `>=` RATHER THAN `>`. Two passes stamped within the same millisecond carry no
 * order between them, so either winning is equally correct, and `>=` lets a re-run at the same
 * instant refresh the row rather than silently doing nothing.
 *
 * THE RESIDUE, STATED: this orders passes by WHEN THEY LOOKED, not by commit ancestry — the same
 * residue, for the same reason, that the row-level guard names (two commit shas carry no order
 * between them and this system has no history walk behind the plugin seam). The next accepted
 * change, or a backfill, re-derives the truth.
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
  const manifests = [...(input.manifests ?? [])];
  await tx
    .insert(dependencyIngestionStamps)
    .values({
      orgId,
      componentObjectId: input.componentObjectId,
      lastAttemptAt: input.lastAttemptAt,
      source: input.source,
      outcome: input.outcome,
      detail: input.detail ?? null,
      rowsWritten: input.rowsWritten,
      manifests
    })
    .onConflictDoUpdate({
      target: [dependencyIngestionStamps.orgId, dependencyIngestionStamps.componentObjectId],
      set: {
        lastAttemptAt: input.lastAttemptAt,
        source: input.source,
        outcome: input.outcome,
        detail: input.detail ?? null,
        rowsWritten: input.rowsWritten,
        manifests
      },
      setWhere: sql`${dependencyIngestionStamps.lastAttemptAt} <= ${input.lastAttemptAt}`
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
