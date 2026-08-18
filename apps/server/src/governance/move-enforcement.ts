import { and, eq, inArray, sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { governanceMoveRungs, objects } from "../db/schema.js";
import { hasPermission } from "../authz/resolve.js";
import { badRequest, conflict, ProblemError } from "../errors.js";
import { containmentChain } from "../graph/containment.js";

/**
 * `governance:move` — THE OPT-IN SECOND BAR ON A CONTAINMENT MOVE, resolved in exactly one place.
 * (docs/proposals/governance-reach-on-containment-move.md §9.2; owner ruling 2026-08-18; drizzle/0079.)
 *
 * ## What the lattice is
 *
 * Enforcement is a set of enabled RUNGS. A rung is either THE INSTANCE (a deployment-wide singleton,
 * operator-authored) or ONE CONTAINER OBJECT (org root, containment domain, service, assembly).
 * Enforcement APPLIES TO A MOVE iff the instance rung is enabled, or any object on the MOVED
 * object's containment chain, or any object on the DESTINATION container's chain, carries a rung.
 * That OR is the monotone half of the owner's ruling — *"if enabled there, orgs can't disable it;
 * same with the next layer … if an org enables it, a service can't disable it"* — and the DELETE
 * verb enforces the other half by refusing 409 while an upper rung is enabled, rather than reporting
 * a disable that leaves the state enforced anyway.
 *
 * When enforcement applies, the actor must hold `governance:move` AT-OR-ABOVE the moved object AND
 * AT-OR-ABOVE the destination — the deliberate mirror of #244's `object:write` pair, so an operator
 * learns ONE rule about moves rather than two.
 *
 * ## There is no computed trigger, and that is the design
 *
 * Whether a move needs the permission depends ONLY on which rungs are set — never on which policies
 * happen to match the object, and never on whether the move would drop a policy. §4(a) of the same
 * proposal argues that at length: a bar that appears and disappears as unrelated governance is
 * authored elsewhere is unpredictable to the person being refused, and un-explainable in a refusal
 * sentence. Predictability over precision (charter priority 1: simplicity).
 *
 * ## THE ORG ROOT IS NOT EXEMPT HERE — the one place this check DIFFERS from #244's pair
 *
 * `graph/containment-parent-authz.ts` exempts the org root at BOTH ends, and both exemptions are
 * proved there: the org root's holders already held custody of every rooted row, so a move to or out
 * of the root can only SHRINK the custodian set, and a shrinking custodian set is not the escalation
 * an `object:write` pair exists to stop.
 *
 * THAT PROOF DOES NOT TRANSFER, because this permission is not about custody. Governance REACH runs
 * with containment: the policies that match an object are the ones scoped at it or at something on
 * its chain (`governance/policy-resolve.ts`). Moving a row OUT of a governed subtree and up to the
 * org root is precisely the reach REDUCTION this permission gates — it is the archetypal case, not
 * an edge case — so exempting the root would exempt the very move the owner asked to govern. The
 * custody argument and the reach argument point in OPPOSITE directions at the root, and each check
 * follows its own. Cross-referenced in `containment-parent-authz.ts` beside its two exemptions so
 * the difference reads as deliberate rather than as one of the copies having been missed.
 *
 * ## What is carved out, and why the carve-out is structural rather than a flag
 *
 * Federation import, discovery accept, the federation OVERLAY and HAND-FILL are NOT subject to this
 * bar, and no code in them says so — because none of them can reach a door. Measured, not assumed
 * (filterless census, 2026-08-18):
 *
 *   - `federation/import-repo.ts` (:208 `upsertObjectByUrn`, :363 `updateObject`),
 *     `federation/handfill-repo.ts` (:294), `federation/overlay-repo.ts` (:188) and
 *     `federation/outposts-repo.ts` (:142/:569/:634) call the REPO directly. They never call
 *     `resolveDeclaredContainmentParent`, which is where door (a) lives.
 *   - The only internal minters of a `contains` edge are `graph/components-repo.ts` (:104 create,
 *     :180/:238 the assign/move this file gates) — nothing in federation or discovery mints one, so
 *     doors (c) cover the whole of the caller-facing surface and nothing of the receiver's.
 *   - The subjects those paths carry are synthetic (`FEDERATION_IMPORT_ACTOR_ID` and friends) and
 *     hold no bindings, so running an authorization down there would abort every import rather than
 *     protect anything — the same argument `graph/containment-parent-authz.ts`'s "authorization at
 *     the door, invariant at the repo" section makes, applied unchanged.
 *
 * The receiver does not referee: a peer's authority already decided the move, and refusing its
 * journal would diverge the replica from the authority that owns it.
 *
 * ## Why a refusal here carries no `decision_id`
 *
 * Every door below throws from INSIDE the caller's `withTenantTx`, so a Decision written here would
 * be rolled back with the refusal it explains and the id would name a row that does not exist —
 * a dangling pointer is worse than none. The refusal instead carries the whole explanation in its
 * sentence: which rung is enabled, at which tier and name, and which END the actor lacks the
 * permission at. The out-of-band shape that WOULD persist a Decision on a refusal
 * (`federation/promotion-repo.ts`: record in a fresh committed transaction, then throw) needs a `Db`
 * handle, which no repo-level door has; raised as an open question rather than faked here.
 */

/** The tiers a rung may sit at — the literal stored at write time (drizzle/0079's CHECK). */
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

/**
 * THE INSTANCE RUNG — no row means DISABLED, decided here and nowhere else.
 *
 * Byte-for-byte the reasoning `dependencies/subscription-resolution.ts`'s
 * `readInstanceSubscriptionUnlock` carries: re-deriving "absent = off" in a route is how the API and
 * the doors come to disagree about a deployment nobody has configured — the loudest possible bug in
 * the safest-sounding line of code.
 */
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
  return {
    // The stored literal, never recomputed (drizzle/0079). Narrowed rather than cast so a row that
    // somehow escaped the CHECK is visible instead of silently mislabelled.
    tier: (GOVERNANCE_MOVE_TIERS as readonly string[]).includes(row.tier)
      ? (row.tier as GovernanceMoveTier)
      : "org",
    subjectObjectId: row.subject_object_id,
    name: row.name ?? row.subject_object_id,
    enabledAt:
      row.enabled_at instanceof Date ? row.enabled_at.toISOString() : String(row.enabled_at),
    enabledByObjectId: row.enabled_by_object_id,
    ...(row.depth === undefined ? {} : { depth: row.depth })
  };
}

/**
 * Does the `governance:move` lattice reach this object, and why?
 *
 * Walks `containmentChain` — the SAME walk the authorization scope expansion and the policy matcher
 * use, so a rung can never describe a containment relationship the rest of the system does not
 * believe in — and joins the rung table onto it. Loud on the depth bound (ADR-0035): a chain that
 * exceeds the bound throws rather than answering "not enforced", because failing OPEN here would
 * silently un-govern exactly the deep subtrees an org bothered to put a rung on.
 *
 * The read half of the whole feature: the doors, the explain route, the CLI and the Admin page all
 * call this, so a UI verdict and a refusal cannot disagree.
 */
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
  /** The object whose containment parent this write changes. */
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
 * THE DOOR CHECK. Fail-closed, called AFTER the door's own `object:write`/`relationship:write` pair,
 * and a no-op — one cheap singleton read plus at most two chain walks — on every deployment with no
 * rung set, which is all of them until an operator sets one.
 *
 * ORs enforcement over the MOVED object's chain and the DESTINATION's chain (the monotone rule), then
 * demands `governance:move` at BOTH ends. The org root is NOT exempt at either end — see the module
 * header for why the custody exemption in `containment-parent-authz.ts` does not transfer.
 *
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

// ---------------------------------------------------------------------------------------------
// The rung write verbs. Authorization lives at the route (`routes/governance-move.ts`); what lives
// here is the SHAPE of an enablement and the monotone refusal, so the HTTP door and any later door
// (IaC rungs are a named follow-up) cannot disagree about either.
// ---------------------------------------------------------------------------------------------

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

/**
 * Disable one rung — REFUSED 409 while any UPPER rung is enabled, naming it.
 *
 * "Orgs can't disable it" is the owner's monotone half, and this is where it is real. Reporting a
 * successful disable while the OR above keeps every move under this subtree enforced would be the
 * worst of both: the operator believes they turned it off, the refusals continue, and nothing in the
 * system says why. THE INSTANCE RUNG COUNTS AS AN UPPER RUNG — it is above everything by
 * construction.
 *
 * Disabling a rung that is not enabled is a 404 at the route, not here.
 */
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
