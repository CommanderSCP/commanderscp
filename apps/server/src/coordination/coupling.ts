import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";

/**
 * Coupled-pipeline prerequisites (M12 P4B — docs/proposals/coupled-pipelines.md). A change declares
 * `properties.requires: {key, at}[]`; it may not execute until, for EACH requirement, some OTHER
 * change is in `validating` or `promoted` and `provides` that `key` at that `at` object.
 *
 * The predicate is EXISTENTIAL over a CONDITION, not a pointer to a specific prerequisite row: a
 * failed/cancelled prerequisite is simply not in {validating, promoted}, so the waiter keeps
 * waiting; the operator fixes it and re-pushes, a NEW change reaches `validating` with the same
 * key, and the waiter releases — nothing to re-point. That is what makes "wait forever" (the owner's
 * choice) coherent rather than stubborn.
 *
 * State choice `validating|promoted`, NOT `promoted` alone (owner ruling: "run successfully, not a
 * human gate"): a forward change never auto-promotes (`reconcile.ts` completeExecution returns for
 * non-rollback changes — promotion is a human `scp change promote`), so a `promoted` predicate would
 * deadlock every automated coupled release. `validating` is the state the engine writes once every
 * wave succeeded — the executor ran, the bucket exists.
 */
export interface Requirement {
  key: string;
  /** Object id (resolved at propose time) the key must be provided at. */
  at: string;
}

/** A requirement plus WHETHER it is currently satisfied, and by which change if so. */
export interface RequirementStatus extends Requirement {
  satisfied: boolean;
  /** The object id of the change that satisfies this requirement (in validating|promoted), or null. */
  satisfiedByChangeObjectId: string | null;
}

/**
 * The satisfaction status of EVERY requirement — the single query implementation behind both the
 * reconcile predicate and the `explain` wait-status surface (Phase 4). One jsonb-containment probe
 * per requirement, served by the `obj_props` GIN index (`drizzle/0001:170`, `jsonb_path_ops`):
 * `properties @> {"provides":[key],"targets":[at]}` is true iff the provider's `provides` array
 * contains `key` AND its `targets` array contains `at`. No new index, no new column — `provides`/
 * `targets` already live in `objects.properties`.
 */
export async function requirementStatuses(
  tx: TenantTx,
  orgId: string,
  selfChangeObjectId: string,
  requires: Requirement[]
): Promise<RequirementStatus[]> {
  const statuses: RequirementStatus[] = [];
  for (const req of requires) {
    const probe = JSON.stringify({ provides: [req.key], targets: [req.at] });
    const result = await tx.execute<{ change_object_id: string }>(sql`
      SELECT c.object_id AS change_object_id
      FROM changes c
      JOIN objects o ON o.id = c.object_id AND o.org_id = c.org_id
      WHERE c.org_id = ${orgId}::uuid
        AND c.state IN ('validating', 'promoted')
        AND o.id <> ${selfChangeObjectId}::uuid
        AND o.deleted_at IS NULL
        AND o.properties @> ${probe}::jsonb
      LIMIT 1
    `);
    const satisfiedBy = result.rows[0]?.change_object_id ?? null;
    statuses.push({ ...req, satisfied: satisfiedBy !== null, satisfiedByChangeObjectId: satisfiedBy });
  }
  return statuses;
}

/**
 * The subset of `requires` NOT yet satisfied. Empty ⇒ the change is free to execute. Also drives the
 * `waiting` Decision's reason, so an operator can see exactly which prerequisites are outstanding.
 */
export async function unsatisfiedRequirements(
  tx: TenantTx,
  orgId: string,
  selfChangeObjectId: string,
  requires: Requirement[]
): Promise<Requirement[]> {
  const statuses = await requirementStatuses(tx, orgId, selfChangeObjectId, requires);
  return statuses.filter((s) => !s.satisfied).map((s) => ({ key: s.key, at: s.at }));
}

/** True iff every requirement is satisfied (or there are none). */
export async function requirementsSatisfied(
  tx: TenantTx,
  orgId: string,
  selfChangeObjectId: string,
  requires: Requirement[]
): Promise<boolean> {
  if (requires.length === 0) return true;
  return (await unsatisfiedRequirements(tx, orgId, selfChangeObjectId, requires)).length === 0;
}

/** Renders a requirement list for a Decision reason, e.g. `feature-a@<uuid>, bucket@<uuid>`. */
export function describeRequirements(requires: Requirement[]): string {
  return requires.map((r) => `${r.key}@${r.at}`).join(", ");
}

/** Cap on rows returned by the two diagnostic queries below — "modest LIMIT" (P4B Phase 4
 *  ergonomics spec, coupled-pipelines.md §3.7/§6#8): these serve a human reading a 2am wait-status
 *  or a release Decision, never the hot reconcile path, so a handful of examples is enough. */
const DIAGNOSTIC_LIMIT = 20;

/**
 * "Did you mean?" (coupled-pipelines.md §3.7, `listProvidedKeysAtScope`): for an UNSATISFIED
 * requirement, the `provides` keys that SOME change has actually declared at that `at` object,
 * org-scoped. Because `at` is a resolved object id (not a substring embedded in the key), this is
 * exact rather than a prefix guess — "no change has ever provided `feture-a` at `us-east-1`; keys
 * provided there: `feature-a`, `feature-b`." Every change ever proposed at that scope counts
 * (not just currently-`validating`/`promoted` ones) — a typo diagnosis cares what pipelines
 * DECLARE, not what is live right now. Served by the same `obj_props` GIN index as
 * `requirementStatuses` (`jsonb_path_ops` covers `@>`, not the `jsonb_array_elements_text` unnest
 * itself, but the `@>` prefilter is what keeps this cheap).
 */
export async function listProvidedKeysAtScope(tx: TenantTx, orgId: string, at: string): Promise<string[]> {
  const scopeProbe = JSON.stringify({ targets: [at] });
  const result = await tx.execute<{ key: string }>(sql`
    SELECT DISTINCT key
    FROM changes c
    JOIN objects o ON o.id = c.object_id AND o.org_id = c.org_id
    CROSS JOIN LATERAL jsonb_array_elements_text(o.properties -> 'provides') AS key
    WHERE c.org_id = ${orgId}::uuid
      AND o.deleted_at IS NULL
      AND o.properties @> ${scopeProbe}::jsonb
    ORDER BY key
    LIMIT ${DIAGNOSTIC_LIMIT}
  `);
  return result.rows.map((r) => r.key);
}

/** One requirement key satisfied by MORE THAN ONE currently-{validating,promoted} change at the
 *  same `at` — the release-time ambiguity a reused `provides` key produces (coupled-pipelines.md
 *  §6#8: "key reuse fails open"). `providerChangeObjectIds` is capped at `DIAGNOSTIC_LIMIT` — this
 *  is a diagnostic record, not an exhaustive audit. */
export interface AmbiguousProvider {
  key: string;
  at: string;
  providerChangeObjectIds: string[];
}

/**
 * Release-time key-reuse warn (M12 P4B Phase 4, coupled-pipelines.md §6#8/§3.8): given the
 * ALREADY-satisfied `statuses` for a releasing waiter (every requirement true — this is called
 * only once `unsatisfiedRequirements` is empty), re-probes each requirement's provider set and
 * reports every key with more than one qualifying provider. Deliberately a SEPARATE query from
 * `requirementStatuses`'s `LIMIT 1` (which exists to pick the one id pinned in
 * `satisfiedRequirements` — changing its cardinality would ripple into every caller); this runs
 * ONCE per release, not per reconcile tick, so the extra query is cheap where it matters. Warn,
 * never block (coupled-pipelines.md §5: "no key uniqueness constraint... a hotfix under one
 * release name is legitimate") — the caller records this in the release Decision's inputs and
 * proceeds regardless.
 */
export async function ambiguousProvidersFor(
  tx: TenantTx,
  orgId: string,
  selfChangeObjectId: string,
  statuses: RequirementStatus[]
): Promise<AmbiguousProvider[]> {
  const ambiguous: AmbiguousProvider[] = [];
  for (const s of statuses) {
    if (!s.satisfied) continue; // only a satisfied requirement can have been released on
    const probe = JSON.stringify({ provides: [s.key], targets: [s.at] });
    const result = await tx.execute<{ change_object_id: string }>(sql`
      SELECT c.object_id AS change_object_id
      FROM changes c
      JOIN objects o ON o.id = c.object_id AND o.org_id = c.org_id
      WHERE c.org_id = ${orgId}::uuid
        AND c.state IN ('validating', 'promoted')
        AND o.id <> ${selfChangeObjectId}::uuid
        AND o.deleted_at IS NULL
        AND o.properties @> ${probe}::jsonb
      ORDER BY o.id
      LIMIT ${DIAGNOSTIC_LIMIT}
    `);
    if (result.rows.length > 1) {
      ambiguous.push({ key: s.key, at: s.at, providerChangeObjectIds: result.rows.map((r) => r.change_object_id) });
    }
  }
  return ambiguous;
}
