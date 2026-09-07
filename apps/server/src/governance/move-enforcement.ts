import { and, eq, inArray, sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { governanceMoveRungs, objects } from "../db/schema.js";
import { hasPermission } from "../authz/resolve.js";
import { badRequest, conflict, ProblemError } from "../errors.js";
import { containmentChain } from "../graph/containment.js";

/** The opt-in second bar on a containment move. See docs/governance.md §253. */

/** The tiers a rung may sit at — the literal stored at write time (drizzle/0083's CHECK). */
export const GOVERNANCE_MOVE_TIERS = ["org", "containment_domain", "service", "assembly"] as const;
export type GovernanceMoveTier = (typeof GOVERNANCE_MOVE_TIERS)[number];

/** The object types that may carry a rung, and the tier each is recorded as. `organization` is the
 *  ORG ROOT object (`auth/local-auth.ts`'s `ensureOrgRootObject` gives it `id === orgId`). */
const TIER_BY_OBJECT_TYPE: Readonly<Record<string, GovernanceMoveTier>> = {
  organization: "org",
  domain: "containment_domain",
  service: "service",
  assembly: "assembly"
};

/** The tier for an object type, or `undefined` when that type cannot carry a rung. A component is
 *  deliberately absent: a rung governs moves BENEATH a container, and nothing is contained by a
 *  component. */
export function moveRungTierForObjectType(objectTypeId: string): GovernanceMoveTier | undefined {
  return TIER_BY_OBJECT_TYPE[objectTypeId];
}

export interface GovernanceMoveRung {
  tier: GovernanceMoveTier;
  subjectObjectId: string;
  /** The subject container's `objects.name` — carried so a refusal and the explain read can NAME the
   *  rung instead of printing a bare uuid at somebody who has to go and find it. */
  name: string;
  enabledAt: string;
  enabledByObjectId: string;
  /** Depth on the walked chain: 0 = org root, increasing toward the object. Absent on the list read,
   *  which walks no chain. */
  depth?: number;
}

export interface GovernanceMoveEnforcement {
  /** `true` iff the instance rung is enabled OR at least one rung sits on this object's chain. */
  enforced: boolean;
  instance: { enabled: boolean };
  /** Every rung ON THIS OBJECT'S CHAIN, org root first (ascending depth). Empty when none. */
  rungs: GovernanceMoveRung[];
}

/** THE INSTANCE RUNG. See docs/governance.md §254. */
export async function readInstanceMoveRung(
  tx: TenantTx
): Promise<{ enabled: boolean; updatedAt: string | null }> {
  const result = await tx.execute<{ enabled: boolean; updated_at: Date | string }>(sql`
    SELECT enabled, updated_at FROM governance_move_instance_rung WHERE id = 'default'
  `);
  const row = result.rows[0];
  const updatedAt = row?.updated_at;
  return {
    enabled: row?.enabled === true,
    updatedAt:
      updatedAt === undefined || updatedAt === null
        ? null
        : updatedAt instanceof Date
          ? updatedAt.toISOString()
          : String(updatedAt)
  };
}

/** Every rung this org has enabled, with its subject's name — the list read. Ordered by tier then
 *  name so two calls agree. */
export async function listGovernanceMoveRungs(
  tx: TenantTx,
  orgId: string
): Promise<GovernanceMoveRung[]> {
  const result = await tx.execute<{
    subject_object_id: string;
    tier: string;
    name: string | null;
    enabled_at: Date | string;
    enabled_by_object_id: string;
  }>(sql`
    SELECT r.subject_object_id, r.tier, o.name, r.enabled_at, r.enabled_by_object_id
    FROM governance_move_rungs r
    LEFT JOIN objects o ON o.id = r.subject_object_id AND o.org_id = ${orgId}
    WHERE r.org_id = ${orgId}
    ORDER BY r.tier, o.name NULLS LAST
  `);
  return result.rows.map(toRung);
}

function toRung(row: {
  subject_object_id: string;
  tier: string;
  name: string | null;
  enabled_at: Date | string;
  enabled_by_object_id: string;
  depth?: number;
}): GovernanceMoveRung {
  if (!(GOVERNANCE_MOVE_TIERS as readonly string[]).includes(row.tier)) {
    // drizzle/0083's CHECK makes this unreachable in production — throwing costs nothing and keeps
    // this comment true. A silent relabel to "org" would misreport a subtree's tier to an operator
    // reading the lattice, which is worse than crashing loudly on data the CHECK should have refused.
    throw new Error(
      `governance_move_rungs row ${row.subject_object_id} carries tier "${row.tier}", which is not one of ${GOVERNANCE_MOVE_TIERS.join(", ")} — the migration 0083 CHECK should make this impossible`
    );
  }
  return {
    // The stored literal, never recomputed (drizzle/0083). Narrowed rather than cast so a row that
    // somehow escaped the CHECK is visible instead of silently mislabelled.
    tier: row.tier as GovernanceMoveTier,
    subjectObjectId: row.subject_object_id,
    name: row.name ?? row.subject_object_id,
    enabledAt:
      row.enabled_at instanceof Date ? row.enabled_at.toISOString() : String(row.enabled_at),
    enabledByObjectId: row.enabled_by_object_id,
    ...(row.depth === undefined ? {} : { depth: row.depth })
  };
}

/** Does the move lattice reach this object, and why. See docs/governance.md §255. */
export async function resolveGovernanceMoveEnforcement(
  tx: TenantTx,
  orgId: string,
  input: { objectId: string }
): Promise<GovernanceMoveEnforcement> {
  const instance = await readInstanceMoveRung(tx);
  const chain = await containmentChain(tx, orgId, input.objectId);
  const rungs: GovernanceMoveRung[] = [];
  if (chain.length > 0) {
    const depthById = new Map(chain.map((entry) => [entry.id, entry.depth]));
    const rows = await tx
      .select({
        subject_object_id: governanceMoveRungs.subjectObjectId,
        tier: governanceMoveRungs.tier,
        name: objects.name,
        enabled_at: governanceMoveRungs.enabledAt,
        enabled_by_object_id: governanceMoveRungs.enabledByObjectId
      })
      .from(governanceMoveRungs)
      .leftJoin(objects, eq(objects.id, governanceMoveRungs.subjectObjectId))
      .where(
        and(
          eq(governanceMoveRungs.orgId, orgId),
          inArray(
            governanceMoveRungs.subjectObjectId,
            chain.map((entry) => entry.id)
          )
        )
      );
    for (const row of rows) {
      rungs.push(toRung({ ...row, depth: depthById.get(row.subject_object_id) ?? 0 }));
    }
    rungs.sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0));
  }
  return {
    enforced: instance.enabled || rungs.length > 0,
    instance: { enabled: instance.enabled },
    rungs
  };
}

export interface GovernanceMoveAdmitsInput {
  orgId: string;
  /** The acting principal (the RBAC subject), NOT the object being moved. */
  subjectObjectId: string;
  movedObjectId: string;
  /** The container it is moving INTO, or `null` for the org root (`DELETE /relationships` of a
   *  `contains` edge drops the child back to its `domain_id` route, i.e. the org root). */
  destinationObjectId: string | null;
  /** The permission the DOOR itself gated on (`object:write`, `relationship:write`, `policy:write`).
   *  Explainability only — it is named in the refusal so an operator can tell which of the two bars
   *  they cleared and which they did not. It never widens or narrows the `governance:move` demand. */
  permissionSetForExplain: string;
}

/**
 * THE DOOR CHECK. See docs/governance.md §256.
 * @throws 403 with the single refusal sentence of proposal §9.2.
 */
export async function assertGovernanceMoveAdmits(
  tx: TenantTx,
  input: GovernanceMoveAdmitsInput
): Promise<void> {
  const destinationObjectId = input.destinationObjectId ?? input.orgId;
  const [movedSide, destinationSide] = await Promise.all([
    resolveGovernanceMoveEnforcement(tx, input.orgId, { objectId: input.movedObjectId }),
    resolveGovernanceMoveEnforcement(tx, input.orgId, { objectId: destinationObjectId })
  ]);
  if (!movedSide.enforced && !destinationSide.enforced) return;

  // The rung the refusal NAMES: the deepest one found on either chain (the most specific enablement
  // an operator would go and look at), or the instance rung when only that is on.
  const named = [...movedSide.rungs, ...destinationSide.rungs].sort(
    (a, b) => (b.depth ?? 0) - (a.depth ?? 0)
  )[0];
  const where = named ? `${named.tier} '${named.name}'` : "the instance (commander) rung";

  const [allowedAtObject, allowedAtDestination] = await Promise.all([
    hasPermission(tx, {
      orgId: input.orgId,
      subjectObjectId: input.subjectObjectId,
      permission: "governance:move",
      scopeObjectId: input.movedObjectId
    }),
    hasPermission(tx, {
      orgId: input.orgId,
      subjectObjectId: input.subjectObjectId,
      permission: "governance:move",
      scopeObjectId: destinationObjectId
    })
  ]);
  if (allowedAtObject && allowedAtDestination) return;

  const end = !allowedAtObject ? "the object" : "the destination";
  throw new ProblemError(403, "Forbidden", {
    detail:
      `moving '${input.movedObjectId}' is governed here — governance:move enforcement is enabled at ` +
      `${where} (and above); '${input.subjectObjectId}' lacks 'governance:move' at ${end}. ` +
      `Ask an Administrator to move it, or disable enforcement at that rung (policy:write). ` +
      `(The door's own '${input.permissionSetForExplain}' bar was cleared — this is the second, ` +
      `opt-in bar.)`
  });
}

// The rung write verbs. See docs/governance.md §257.

export interface EnableGovernanceMoveRungInput {
  orgId: string;
  subjectObjectId: string;
  tier: GovernanceMoveTier;
  enabledByObjectId: string;
  decisionId: string | null;
}

/** Upsert — enabling an already-enabled rung is a no-op restatement, not a 409. Re-stating is what
 *  `scp apply` and an idempotent PUT do routinely, and the state after either call is identical. */
export async function enableGovernanceMoveRung(
  tx: TenantTx,
  input: EnableGovernanceMoveRungInput
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO governance_move_rungs
      (org_id, subject_object_id, tier, enabled_by_object_id, enabled_at, decision_id)
    VALUES (${input.orgId}, ${input.subjectObjectId}::uuid, ${input.tier},
            ${input.enabledByObjectId}::uuid, now(), ${input.decisionId}::uuid)
    ON CONFLICT ON CONSTRAINT governance_move_rungs_pk DO UPDATE SET
      tier = EXCLUDED.tier,
      enabled_by_object_id = EXCLUDED.enabled_by_object_id,
      enabled_at = now(),
      decision_id = EXCLUDED.decision_id
  `);
}

/** Disable one rung. See docs/governance.md §258. */
export async function disableGovernanceMoveRung(
  tx: TenantTx,
  input: { orgId: string; subjectObjectId: string }
): Promise<void> {
  const blocker = await nearestEnabledUpperRung(tx, input.orgId, input.subjectObjectId);
  if (blocker) {
    throw conflict(
      `cannot disable governance:move enforcement at '${input.subjectObjectId}': it is also enabled ` +
        `${blocker} — an enablement above cannot be undone below, so the disable would leave every ` +
        `move under this subtree enforced anyway. Disable it at that rung instead.`
    );
  }
  await tx.execute(sql`
    DELETE FROM governance_move_rungs
    WHERE org_id = ${input.orgId} AND subject_object_id = ${input.subjectObjectId}::uuid
  `);
}

/** A human phrase naming the nearest enabled rung STRICTLY ABOVE this subject, or `undefined`. */
async function nearestEnabledUpperRung(
  tx: TenantTx,
  orgId: string,
  subjectObjectId: string
): Promise<string | undefined> {
  const instance = await readInstanceMoveRung(tx);
  if (instance.enabled) {
    return "at the instance (commander) rung, which activates it for every org on this deployment";
  }
  const enforcement = await resolveGovernanceMoveEnforcement(tx, orgId, {
    objectId: subjectObjectId
  });
  const upper = enforcement.rungs
    .filter((rung) => rung.subjectObjectId !== subjectObjectId)
    .sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0))[0];
  return upper ? `at ${upper.tier} '${upper.name}' above it` : undefined;
}

/** 400 when the caller names something that cannot carry a rung, saying WHAT it is — a component or
 *  a deployment-target contains nothing, so a rung on one would govern the empty set of moves. */
export function assertRungSubjectType(objectTypeId: string, idOrUrn: string): GovernanceMoveTier {
  const tier = moveRungTierForObjectType(objectTypeId);
  if (!tier) {
    throw badRequest(
      `'${idOrUrn}' is a '${objectTypeId}' — a governance:move rung sits on a CONTAINER (the org ` +
        `root, a containment domain, a service or an assembly), because it governs moves of the ` +
        `things inside it, and nothing is contained by a '${objectTypeId}'.`
    );
  }
  return tier;
}
