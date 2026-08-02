import { and, eq, isNull } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";
import { getOrgRootObjectId } from "../graph/objects-repo.js";

/**
 * Pipeline resolution — which release topology does a change inherit, and FROM WHERE
 * (ADR-0026, post-import-configuration.md §5, owner decisions D4/D12-as-amended/D15).
 *
 * ============================================================================================
 * WHY THIS IS A DEDICATED WALK AND NOT `containmentChain` (D15) — READ BEFORE "SIMPLIFYING" IT
 * ============================================================================================
 * D12 originally said resolution "reuses the existing ladder rather than inventing one", on the
 * grounds that `containmentChain` "already encodes service-beats-domain precedence". That second
 * claim is FALSE, and `graph/containment.ts`'s own docblock says so: it walks two axes per hop
 * (the `contains` edge AND `domain_id`), and when a component's `domain_id` differs from its
 * service's the two are "each exactly ONE hop from C and TIE … no ordering of these two routes is
 * obviously 'correct'". It then says, in as many words:
 *
 *     "DO NOT write code that assumes a strict org < domain < service < component ordering across
 *      DIFFERENT kinds … if you are about to write that, fix this first."
 *
 * "Walk the chain and take the nearest match" is exactly that code. So this module walks three
 * NAMED rungs instead, each answering a question with one unambiguous answer, and
 * `containmentChain` is left untouched — modifying it would move RBAC scope, policy resolution,
 * freeze scope and approval scope, four security-relevant consumers, for a feature none of them
 * needs.
 *
 * The org rung is reached DIRECTLY rather than via `domain_id`, which is the axis D15 dropped. That
 * matters: the org root is normally reached through that axis, so dropping it without rung 3 would
 * have silently dropped the org default too.
 *
 * ============================================================================================
 * WHY THE RUNG IS RETURNED, NOT JUST THE TOPOLOGY (principle 6)
 * ============================================================================================
 * "Why did this change get this pipeline?" has four possible answers — an explicit flag, the
 * component's own edge, its service's, or the org default. Only the rung distinguishes them. A
 * Decision naming the topology alone cannot explain an inheritance surprise, which is the failure
 * an operator actually hits: someone attaches a pipeline to a service and every component in it
 * silently changes how it releases.
 */

/** Which rung of the walk supplied the topology. `explicit` never reaches this module. */
export type PipelineRung = "component" | "service" | "organization";

export interface ResolvedRung {
  rung: PipelineRung;
  /** The object the winning `releases_via` edge hangs off — the rung's subject, for the Decision. */
  attachedToObjectId: string;
  topologyObjectId: string;
  topologyVersion: number;
}

export interface PipelineResolution {
  /** `null` when nothing resolved, or when the targets disagreed. */
  resolved: ResolvedRung | null;
  /**
   * Why `resolved` is null, or `null` when it is not.
   * `no_pipeline` — no rung had an edge. `targets_disagree` — see `resolvePipelineForTargets`.
   */
  reason: "no_pipeline" | "targets_disagree" | null;
  /** Per-target outcome, for the Decision. One entry per target, in the order given. */
  perTarget: {
    targetObjectId: string;
    rung: PipelineRung | null;
    topologyObjectId: string | null;
  }[];
}

/**
 * The live `releases_via` edge hanging off `fromId`, with its topology's current version, or null.
 *
 * `many_to_one` (migration 0049) plus its partial unique index guarantee AT MOST ONE such edge, so
 * this needs no tie-break and must not grow one — a `limit(1)` over an unordered set would be a
 * silent arbitrary choice. If that cardinality ever changes, this returns a nondeterministic answer
 * and the fix is the cardinality, not a sort here.
 *
 * The join to `objects` is what makes a dangling or soft-deleted topology read as NO pipeline
 * rather than as a topology id that later fails to load: a change must not be born pointing at a
 * tombstone.
 */
async function attachedTopology(
  tx: TenantTx,
  orgId: string,
  fromId: string
): Promise<{ topologyObjectId: string; topologyVersion: number } | null> {
  const rows = await tx
    .select({ id: objects.id, version: objects.version })
    .from(relationships)
    .innerJoin(objects, eq(objects.id, relationships.toId))
    .where(
      and(
        eq(relationships.orgId, orgId),
        eq(relationships.typeId, "releases_via"),
        eq(relationships.fromId, fromId),
        isNull(relationships.deletedAt),
        eq(objects.orgId, orgId),
        eq(objects.typeId, "release-topology"),
        isNull(objects.deletedAt)
      )
    );
  const row = rows[0];
  if (!row || rows.length !== 1) return null;
  return { topologyObjectId: row.id, topologyVersion: row.version };
}

/** The component's owning service, via the `contains` edge walked INBOUND (`to_id` = component). */
async function owningServiceId(
  tx: TenantTx,
  orgId: string,
  componentObjectId: string
): Promise<string | null> {
  // At most one, guaranteed by `contains`'s `one_to_many` plus migration 0022's partial unique
  // index — the same "one service per component" invariant RBAC and policy scope depend on.
  const row = await tx.query.relationships.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(
        eqOp(t.orgId, orgId),
        eqOp(t.typeId, "contains"),
        eqOp(t.toId, componentObjectId),
        isNullOp(t.deletedAt)
      )
  });
  return row?.fromId ?? null;
}

/**
 * Resolves ONE target's pipeline by walking the three rungs, nearest first.
 *
 * The rungs are tried in order and the FIRST hit wins — that is what "walk past the owning service"
 * (D4) means concretely: a component with no edge of its own does not stop at its service having
 * none either, it continues to the org default.
 */
export async function resolvePipelineForTarget(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<ResolvedRung | null> {
  const own = await attachedTopology(tx, orgId, targetObjectId);
  if (own) {
    return { rung: "component", attachedToObjectId: targetObjectId, ...own };
  }

  const serviceId = await owningServiceId(tx, orgId, targetObjectId);
  if (serviceId) {
    const viaService = await attachedTopology(tx, orgId, serviceId);
    if (viaService) {
      return { rung: "service", attachedToObjectId: serviceId, ...viaService };
    }
  }

  const orgRootId = await getOrgRootObjectId(tx, orgId);
  const viaOrg = await attachedTopology(tx, orgId, orgRootId);
  if (viaOrg) {
    return { rung: "organization", attachedToObjectId: orgRootId, ...viaOrg };
  }

  return null;
}

/**
 * Resolves the pipeline for a change's whole target set.
 *
 * **Every target must resolve to the SAME topology, or nothing is inherited.** Applying one
 * target's pipeline to a change that touches others is precisely the inheritance surprise the rung
 * exists to explain, and there is no non-arbitrary way to pick a winner. A target that resolves to
 * NOTHING counts as a disagreement for the same reason: inheriting a pipeline on its behalf would
 * order a release for an object nobody attached one to.
 *
 * This costs almost nothing in practice and is not the guard being weakened: `matchComponentForSource`
 * returns exactly one component, so an automatically created change has exactly ONE target (277 of
 * 281 measured), and every same-service multi-target change resolves uniformly through rung 2
 * anyway. Only a hand-assembled change spanning differently-piped components declines to inherit —
 * and it declines LOUDLY, on the Decision, rather than silently picking one.
 *
 * The RUNG may legitimately differ while the topology agrees (one component has its own edge to T,
 * another reaches the same T through its service). That is not a disagreement — the answer is
 * unambiguous — so it resolves, and `perTarget` carries the detail for the Decision.
 */
export async function resolvePipelineForTargets(
  tx: TenantTx,
  orgId: string,
  targetObjectIds: string[]
): Promise<PipelineResolution> {
  const perTarget: PipelineResolution["perTarget"] = [];
  const resolvedPerTarget: (ResolvedRung | null)[] = [];

  for (const targetObjectId of targetObjectIds) {
    const hit = await resolvePipelineForTarget(tx, orgId, targetObjectId);
    resolvedPerTarget.push(hit);
    perTarget.push({
      targetObjectId,
      rung: hit?.rung ?? null,
      topologyObjectId: hit?.topologyObjectId ?? null
    });
  }

  const first = resolvedPerTarget[0];
  if (!first) {
    // Nothing on the first target. If NO target resolved, that is the ordinary "no pipeline
    // configured" case; if some did, the set disagrees.
    const anyResolved = resolvedPerTarget.some((r) => r !== null);
    return { resolved: null, reason: anyResolved ? "targets_disagree" : "no_pipeline", perTarget };
  }

  const uniform = resolvedPerTarget.every(
    (r) => r !== null && r.topologyObjectId === first.topologyObjectId
  );
  if (!uniform) return { resolved: null, reason: "targets_disagree", perTarget };

  return { resolved: first, reason: null, perTarget };
}
