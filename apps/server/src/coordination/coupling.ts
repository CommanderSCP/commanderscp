import { sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";

/** Coupled-pipeline prerequisites, provided and required. See docs/coordination.md §399. */
export interface Requirement {
  key: string;
  /** Object id (resolved at propose time) the key must be provided at. */
  at: string;
}

/** A requirement plus WHETHER it is currently satisfied, and by which change if so. */
export interface RequirementStatus extends Requirement {
  satisfied: boolean;
  /** The object id of the change that satisfies this requirement (in validating|accepted), or null. */
  satisfiedByChangeObjectId: string | null;
}

/** The satisfaction status of EVERY requirement. See docs/coordination.md §400. */
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
        AND c.state IN ('validating', 'accepted')
        AND o.id <> ${selfChangeObjectId}::uuid
        AND o.deleted_at IS NULL
        AND o.properties @> ${probe}::jsonb
      LIMIT 1
    `);
    const satisfiedBy = result.rows[0]?.change_object_id ?? null;
    statuses.push({
      ...req,
      satisfied: satisfiedBy !== null,
      satisfiedByChangeObjectId: satisfiedBy
    });
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

/** "Did you mean?". See docs/coordination.md §401. */
export async function listProvidedKeysAtScope(
  tx: TenantTx,
  orgId: string,
  at: string
): Promise<string[]> {
  const scopeProbe = JSON.stringify({ targets: [at] });
  const result = await tx.execute<{ key: string }>(sql`
    SELECT DISTINCT key
    FROM changes c
    JOIN objects o ON o.id = c.object_id AND o.org_id = c.org_id
    CROSS JOIN LATERAL jsonb_array_elements_text(o.properties -> 'provides') AS key
    WHERE c.org_id = ${orgId}::uuid
      AND o.deleted_at IS NULL
      AND o.properties @> ${scopeProbe}::jsonb
      AND jsonb_typeof(o.properties -> 'provides') = 'array'
    ORDER BY key
    LIMIT ${DIAGNOSTIC_LIMIT}
  `);
  return result.rows.map((r) => r.key);
}

/** One requirement key satisfied by MORE THAN ONE currently-{validating,accepted} change at the
 *  same `at` — the release-time ambiguity a reused `provides` key produces (coupled-pipelines.md
 *  §6#8: "key reuse fails open"). `providerChangeObjectIds` is capped at `DIAGNOSTIC_LIMIT` — this
 *  is a diagnostic record, not an exhaustive audit. */
export interface AmbiguousProvider {
  key: string;
  at: string;
  providerChangeObjectIds: string[];
}

/** Release-time key-reuse warn. See docs/coordination.md §402. */
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
        AND c.state IN ('validating', 'accepted')
        AND o.id <> ${selfChangeObjectId}::uuid
        AND o.deleted_at IS NULL
        AND o.properties @> ${probe}::jsonb
      ORDER BY o.id
      LIMIT ${DIAGNOSTIC_LIMIT}
    `);
    if (result.rows.length > 1) {
      ambiguous.push({
        key: s.key,
        at: s.at,
        providerChangeObjectIds: result.rows.map((r) => r.change_object_id)
      });
    }
  }
  return ambiguous;
}
