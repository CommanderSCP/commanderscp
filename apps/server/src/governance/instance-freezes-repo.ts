import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { instanceFreezes } from "../db/schema.js";
import { freezeWindowCovers } from "./freezes-repo.js";
import type { StageCoordinate } from "../coordination/regional-executors.js";

/**
 * M25.3 — THE INSTANCE-SCOPED (PLATFORM) FREEZE TIER'S READ PATH (drizzle/0086,
 * docs/proposals/campaigns-rework.md §2 — owner decision D1).
 *
 * `freezes-repo.ts` is the ORG tier: a freeze names a graph object and `containmentChain` decides
 * coverage. This file is the tier ABOVE org, which has no `org_id` and no object id to name, and
 * therefore matches on a STAGE COORDINATE instead (0086's header; `regional-executors.ts`'s
 * `readStageCoordinate` is the one reader of that convention).
 *
 * ============================================================================================
 * READS ONLY — the write path is `routes/instance-freezes.ts`, over a DIFFERENT CONNECTION
 * ============================================================================================
 * `scp_app` (the `TenantTx` this file runs on) holds SELECT and nothing else on
 * `instance_freezes`: no write grant, and no write RLS policy in any verb. Operator writes go
 * over `withOperatorDb`'s `scp_operator` connection, which is not a `TenantTx` at all. So there
 * is no `createInstanceFreeze` here and there cannot be one — a write verb in this file would
 * fail at the database on every real deployment while passing under the Testcontainers superuser,
 * which is exactly how four tables shipped with no writable principal (drizzle/0076's header).
 */

export interface InstanceFreezeRow {
  /** A real uuid (uuidv7), not `platform:<key>` — see the schema mirror. */
  id: string;
  /** The operator slug; the `PUT`/`DELETE` path segment. */
  key: string;
  name: string | null;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  /** The EXPLICIT deployment-wide form. When true, `matchEnvironment`/`matchRegion` are null. */
  matchAllEnvironments: boolean;
  matchEnvironment: string | null;
  matchRegion: string | null;
  /** Owner decision D5, identical semantics to `freezes.atomic`. */
  atomic: boolean;
  /** Proposal §2.2 — whether ANY tenant role may override this freeze. Default false. */
  overridable: boolean;
  note: string | null;
  liftedAt: Date | null;
  liftReason: string | null;
  updatedAt: Date;
}

/**
 * EVERY LIVE INSTANCE FREEZE COVERING `at` — no coordinate filter at all.
 *
 * ============================================================================================
 * THE WINDOW PREDICATE IS STILL KNOWN IN EXACTLY ONE PLACE, AND IT IS NOT THIS FUNCTION
 * ============================================================================================
 * `freezes-repo.ts`'s `activeFreezesInWindow` claims in its own docblock to be THE ONLY PLACE
 * that knows `starts_at <= at < ends_at AND lifted_at IS NULL`, and that claim is load-bearing:
 * `graph/containment.ts`'s header records that three copies of ONE walk drifted until a
 * service-scoped freeze failed OPEN, and the half-open boundary (`lte` on the start, `gt` on the
 * end) is precisely the detail two copies stop agreeing about — silently, in either direction.
 * `coordination/service-board.ts` already made that claim false once by hand-rolling the
 * comparison in JS, and M25.2 had to undo it.
 *
 * A second table cannot share the first table's `where` clause, so the predicate is factored into
 * {@link freezeWindowCovers} — a column-generic SQL fragment — and BOTH tiers' window reads are
 * built from that one fragment. There is still exactly one place that knows the predicate; it
 * moved down a level rather than being copied.
 *
 * SOFT LIFT is part of the predicate for the same reason it is at the org tier (drizzle/0085): a
 * retracted freeze stops being returned here and therefore stops holding anything on EVERY path
 * at once, with no lift-specific code in reconcile, the gate, or the board.
 *
 * Served by `instance_freezes_window`. Returns `[]` on the overwhelmingly common deployment —
 * this table ships empty — which is what preserves `freeze-scope.ts`'s INERTNESS property: the
 * cost of M25.3 to an instance with nothing frozen is ONE extra indexed read per change per tick,
 * and not a single additional containment walk or property lookup.
 */
export async function activeInstanceFreezesInWindow(
  tx: TenantTx,
  at: Date
): Promise<InstanceFreezeRow[]> {
  const rows = await tx
    .select()
    .from(instanceFreezes)
    .where(
      freezeWindowCovers(
        instanceFreezes.startsAt,
        instanceFreezes.endsAt,
        instanceFreezes.liftedAt,
        at
      )
    );
  return rows as InstanceFreezeRow[];
}

/**
 * DOES THIS PLATFORM FREEZE COVER A TARGET AT THIS STAGE COORDINATE? — pure, no database.
 *
 * `coordinate` is `null` for a target that declares no stage at all: a legacy component-shaped
 * wave target, or a placement whose deployment-target carries no `properties.environment`
 * (`readStageCoordinate`'s three cases). Such a target is covered ONLY by an explicitly
 * deployment-wide freeze — an environment-addressed freeze reaches the stages that SAY they are
 * that environment, following ADR-0031's rule that locality is declared and never inferred.
 *
 * THE THREE FORMS, and the second is the one a reviewer guesses wrong:
 *   * `matchAllEnvironments`            -> every target, coordinate or not.
 *   * `matchEnvironment` alone          -> EVERY REGION of that environment, including a stage
 *                                          that declares no region at all. "Freeze prod" means
 *                                          prod, not "the parts of prod that named themselves".
 *   * `matchEnvironment` + `matchRegion`-> that one stage. A target with no declared region does
 *                                          NOT match a region-narrowed freeze: it has not said it
 *                                          is that region.
 *
 * Comparison is exact on the trimmed strings both sides already store — `readStageCoordinate`
 * trims what the graph declares and 0086's CHECK refuses a blank match value, so neither side can
 * carry whitespace. Deliberately NOT case-insensitive: `properties.environment` is an opaque
 * operator-chosen label everywhere else in this repo (`listRegionTargets` compares it with `=`),
 * and one matcher folding case while the region view does not is the drift this file is careful
 * about.
 */
export function instanceFreezeCovers(
  freeze: Pick<InstanceFreezeRow, "matchAllEnvironments" | "matchEnvironment" | "matchRegion">,
  coordinate: StageCoordinate | null
): boolean {
  if (freeze.matchAllEnvironments) return true;
  if (coordinate === null) return false;
  if (freeze.matchEnvironment !== coordinate.environment) return false;
  if (freeze.matchRegion === null) return true;
  return freeze.matchRegion === coordinate.region;
}

/**
 * The whole live table, newest window first — the operator LIST read.
 *
 * Includes LIFTED rows, deliberately and for the same reason `listFreezes`/`getFreeze` do at the
 * org tier: lifted is a FIELD, not an absence. An operator asking "what did we freeze last week"
 * is asking about rows this instance retracted, and the id in a months-old block Decision has to
 * stay resolvable through this surface.
 */
export async function listInstanceFreezes(tx: TenantTx): Promise<InstanceFreezeRow[]> {
  const rows = await tx
    .select()
    .from(instanceFreezes)
    .orderBy(sql`${instanceFreezes.startsAt} DESC`, instanceFreezes.key);
  return rows as InstanceFreezeRow[];
}
