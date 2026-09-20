import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { OrphanPlacement } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import type { ExecutorLane, ExecutorType } from "@scp/schemas";
import { executorBindings, objects, relationships, sourceMappings } from "../db/schema.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { UUID_TEXT_PATTERN } from "./containment.js";

/** GRAPH INTEGRITY — rows that outlived the object they hang off. See docs/graph.md §53. */

export interface DanglingRelationship {
  id: string;
  typeId: string;
  /** Which end is dead — both, when a delete took out two related objects. */
  deadEnd: "from" | "to" | "both";
  fromUrn: string;
  toUrn: string;
  /** A replica edge cannot be repaired locally (single-writer authority); reported, never actioned. */
  repairable: boolean;
}

export interface OrphanProjectionRow {
  id: string;
  /** The DEAD object the row hangs off, named for the operator. */
  ownerUrn: string;
  ownerName: string;
  detail: string;
  /** FALSE when the row's own delete door would refuse it, or when there is no id-addressed door at
   *  all (the mapping arm). See docs/schemas.md §296c. */
  repairable: boolean;
  /** Why not, in the operator's own vocabulary; null when `repairable` is true. */
  blockedReason: string | null;
}

/** The one projection row `--repair` can act on, so the one that carries its door's whole key.
 *  See docs/graph.md §53a. */
export interface OrphanExecutorBindingRow extends OrphanProjectionRow {
  /** `(targetType, lane)` completes the key `DELETE /executors/{idOrUrn}/binding` takes, beside
   *  `ownerUrn`. Structured, not folded into `detail`: a repair run has to PASS them, and a `lane`
   *  parsed back out of a display string silently defaults to `build` when it is wrong. */
  targetType: ExecutorType;
  lane: ExecutorLane;
  /** Read off `managed_by_policy_id`, never inferred. A managed row is re-derived every reconcile
   *  tick and reaped by `pruneUnwanted` once its target is a tombstone, so `--repair` skips it. */
  policyManaged: boolean;
}

export interface GraphIntegrityReport {
  danglingRelationships: DanglingRelationship[];
  orphanSourceMappings: OrphanProjectionRow[];
  orphanExecutorBindings: OrphanExecutorBindingRow[];
  /** A live placement whose component or deployment-target is dead (ADR-0026 D17 reads the pair
   *  from `properties`, so this cannot be expressed as a foreign key). Richer than the two
   *  projection arms because a placement is a graph OBJECT with its own delete door — see
   *  `OrphanPlacementSchema` for why that difference has to reach the wire. */
  orphanPlacements: OrphanPlacement[];
}

/** Every integrity finding for one org, in one read-only pass. See docs/graph.md §54. */
export async function findGraphIntegrityIssues(
  tx: TenantTx,
  orgId: string
): Promise<GraphIntegrityReport> {
  // The REAL helper, not a duck-typed probe. An earlier draft reached for `tx.query.federationSelf`
  // with optional chaining, which yields `undefined` rather than throwing when the shape is not what
  // was assumed — and every edge would then be reported `repairable: true`, including replica edges a
  // repair run can never delete. A silently-wrong default in an integrity report is worse than none.
  const self = await ensureFederationSelf(tx, orgId);
  const selfDomainId = self.domainId;

  const fromObj = sql`from_o`;
  const toObj = sql`to_o`;
  const dangling = await tx.execute(sql`
    select r.id, r.type_id, r.origin_domain_id,
           ${fromObj}.urn as from_urn, ${toObj}.urn as to_urn,
           (${fromObj}.deleted_at is not null) as from_dead,
           (${toObj}.deleted_at is not null) as to_dead
    from ${relationships} r
    join ${objects} from_o on from_o.id = r.from_id
    join ${objects} to_o   on to_o.id   = r.to_id
    where r.org_id = ${orgId}
      and r.deleted_at is null
      and (from_o.deleted_at is not null or to_o.deleted_at is not null)
    order by r.type_id, r.id
  `);

  const danglingRelationships: DanglingRelationship[] = (
    dangling as unknown as {
      rows?: Record<string, unknown>[];
    }
  ).rows!.map((row) => {
    const fromDead = row.from_dead === true;
    const toDead = row.to_dead === true;
    return {
      id: String(row.id),
      typeId: String(row.type_id),
      deadEnd: fromDead && toDead ? "both" : fromDead ? "from" : "to",
      fromUrn: String(row.from_urn),
      toUrn: String(row.to_urn),
      // A replica edge is NOT repairable here: `deleteRelationship` refuses it, and it must not be
      // reported as actionable or a repair run would fail on rows it can never fix.
      repairable: row.origin_domain_id === selfDomainId
    };
  });

  const orphanSourceMappings = (
    await tx
      .select({
        id: sourceMappings.id,
        ownerUrn: objects.urn,
        ownerName: objects.name,
        sourceKind: sourceMappings.sourceKind,
        repoPattern: sourceMappings.repoPattern,
        pathPattern: sourceMappings.pathPattern,
        type: sourceMappings.type
      })
      .from(sourceMappings)
      .innerJoin(objects, eq(objects.id, sourceMappings.componentObjectId))
      .where(and(eq(sourceMappings.orgId, orgId), sql`${objects.deletedAt} is not null`))
  ).map((r) => ({
    id: r.id,
    ownerUrn: r.ownerUrn,
    ownerName: r.ownerName,
    detail: `${r.sourceKind}:${r.repoPattern ?? "*"}:${r.pathPattern ?? "*"} (${r.type})`,
    // NEVER repairable, unconditionally — the one arm with no id-addressed delete door. A mapping
    // is addressed by a five-part identity tuple (org, component, sourceKind, repoPattern,
    // pathPattern) this report does not carry, so `--repair` has always skipped this arm; this just
    // says so on the wire instead of leaving every consumer but the CLI to guess a bare `false`.
    repairable: false,
    blockedReason:
      "no id-addressed delete door — a mapping is removed via `scp change-source delete-mapping " +
      "<sourceKind> --component <urn> --repo <pattern> --path <pattern>`, matching this row's " +
      'detail verbatim (an omitted glob means it matched null, not "any")'
  }));

  const orphanExecutorBindings = (
    await tx
      .select({
        id: executorBindings.id,
        ownerUrn: objects.urn,
        ownerName: objects.name,
        type: executorBindings.type,
        lane: executorBindings.lane,
        managedByPolicyId: executorBindings.managedByPolicyId,
        externalRef: executorBindings.externalRef
      })
      .from(executorBindings)
      .innerJoin(objects, eq(objects.id, executorBindings.targetObjectId))
      .where(and(eq(executorBindings.orgId, orgId), sql`${objects.deletedAt} is not null`))
  ).map((r) => ({
    id: r.id,
    ownerUrn: r.ownerUrn,
    ownerName: r.ownerName,
    // STRUCTURED, because `--repair` passes these to the door (owner decision 2026-09-19) and the
    // door is keyed `(target, type, lane)`. They are ALSO in `detail` below, deliberately: the
    // human-readable line has to stay self-sufficient for an operator reading a table, and `detail`
    // is what the pre-`--repair` runbook parsed. The structured fields are the ones code reads.
    targetType: r.type as ExecutorType,
    lane: r.lane as ExecutorLane,
    policyManaged: r.managedByPolicyId !== null,
    // `lane` is HERE too because the detail line is what an operator types back at the door, and the
    // door is keyed `(target, type, lane)`. Without it the string named a row it could not address:
    // `?lane=` defaults to `build`, so a `test`-lane orphan read as repairable and 404'd. Same rule
    // as the mapping detail carrying its whole tuple. The policy-managed note is there for the
    // opposite reason — that row needs no operator at all, the binding reconciler prunes it next
    // tick, and an operator who races it gets a 404 that looks like a bug.
    detail:
      `${r.type}/${r.lane} -> ${r.externalRef ?? "(no external ref)"}` +
      (r.managedByPolicyId === null ? "" : " [policy-managed: the reconciler prunes this]"),
    // Exactly `!policyManaged` — the CLI used to compute this same expression client-side (owner
    // decision 2026-09-19), which left a non-CLI consumer of this endpoint with no way to tell a
    // policy-managed row from a genuinely repairable one without knowing that rule itself.
    repairable: r.managedByPolicyId === null,
    blockedReason:
      r.managedByPolicyId === null
        ? null
        : "policy-managed — the binding reconciler prunes this itself once its target is a " +
          "tombstone; deleting it by hand here would only race that reconciler"
  }));

  // A placement reads its pair from `properties` (ADR-0026 D17), so no foreign key can express
  // this and it has to be a join on the id text.
  //
  // `originDomainId` and `managedByStack` are selected because they decide `repairable`, which the
  // CLI used to hardcode `true` for every row. See docs/graph.md §125c.
  const placements = await tx
    .select({
      id: objects.id,
      urn: objects.urn,
      name: objects.name,
      properties: objects.properties,
      originDomainId: objects.originDomainId,
      managedByStack: objects.managedByStack
    })
    .from(objects)
    .where(
      and(eq(objects.orgId, orgId), eq(objects.typeId, "placement"), isNull(objects.deletedAt))
    );
  // Every placement's pair of ends, collected up front — ONE query for the whole set's liveness
  // instead of one per placement.
  //
  // The uuid test is NOT belt-and-braces. These strings go into an `IN (…)` list against a `uuid`
  // column, so a `properties.componentId` that is a non-uuid string — which nothing in the schema
  // forbids, and which a federation import or a restore can carry — made Postgres raise
  // `invalid input syntax for type uuid` and **500 the whole integrity endpoint**: one malformed row
  // and the report that exists to find malformed rows stops answering at all, for every other
  // finding too. Same pattern the containment walk has always used for the same values.
  const uuidText = new RegExp(UUID_TEXT_PATTERN);
  const placementEnds = placements.map((placement) => {
    const props = placement.properties as { componentId?: unknown; deploymentTargetId?: unknown };
    const endOf = (v: unknown): string | null =>
      typeof v === "string" && uuidText.test(v) ? v : null;
    return {
      placement,
      componentId: endOf(props.componentId),
      deploymentTargetId: endOf(props.deploymentTargetId)
    };
  });
  const allEndIds = [
    ...new Set(
      placementEnds.flatMap(({ componentId, deploymentTargetId }) =>
        [componentId, deploymentTargetId].filter((v): v is string => v !== null)
      )
    )
  ];
  const liveRows =
    allEndIds.length === 0
      ? []
      : await tx
          .select({ id: objects.id })
          .from(objects)
          .where(
            and(eq(objects.orgId, orgId), isNull(objects.deletedAt), inArray(objects.id, allEndIds))
          );
  const liveIds = new Set(liveRows.map((r) => r.id));

  /** The rows that dangle, before the three repairability questions are asked of them. */
  const danglingPlacements: {
    placement: (typeof placements)[number];
    deadEnd: OrphanPlacement["deadEnd"];
  }[] = [];
  for (const { placement, componentId, deploymentTargetId } of placementEnds) {
    // A row that does not name two resolvable ids used to be `continue`d — silently, so it appeared
    // in NO arm of the report and read as healthy. It is the least explicable state a placement can
    // be in and the one an operator most needs told, so it is reported as `malformed` instead.
    if (componentId === null || deploymentTargetId === null) {
      danglingPlacements.push({ placement, deadEnd: "malformed" });
      continue;
    }
    const componentDead = !liveIds.has(componentId);
    const targetDead = !liveIds.has(deploymentTargetId);
    if (!componentDead && !targetDead) continue;
    danglingPlacements.push({
      placement,
      // Named the same way the edge arm names its ends, and for the same reason: "one of the two is
      // gone" does not tell an operator which object to go and look at.
      deadEnd:
        componentDead && targetDead ? "both" : componentDead ? "component" : "deployment-target"
    });
  }

  // WHAT WOULD REFUSE THE REPAIR — asked once for the whole set, not once per row.
  //
  // `deleteObject` route 6 (docs/graph.md §125b) refuses to tombstone any object an UNMANAGED
  // executor binding names as its target, and every placement on the live estate that ever carried a
  // binding is exactly that shape. A policy-managed binding is exempt there, so it must be exempt
  // here too or the report would claim a block the door does not apply.
  const danglingIds = danglingPlacements.map((d) => d.placement.id);
  const blockingBindings =
    danglingIds.length === 0
      ? []
      : await tx
          .select({
            targetObjectId: executorBindings.targetObjectId,
            type: executorBindings.type,
            lane: executorBindings.lane
          })
          .from(executorBindings)
          .where(
            and(
              eq(executorBindings.orgId, orgId),
              isNull(executorBindings.managedByPolicyId),
              inArray(executorBindings.targetObjectId, danglingIds)
            )
          );
  const bindingsByTarget = new Map<string, { type: string; lane: string }[]>();
  for (const b of blockingBindings) {
    const list = bindingsByTarget.get(b.targetObjectId) ?? [];
    list.push({ type: b.type, lane: b.lane });
    bindingsByTarget.set(b.targetObjectId, list);
  }

  const orphanPlacements: OrphanPlacement[] = danglingPlacements.map(({ placement, deadEnd }) => {
    const detail =
      deadEnd === "malformed"
        ? "properties do not name two resolvable object ids"
        : `${deadEnd === "both" ? "component and deployment-target" : deadEnd} is deleted`;
    // ORDER MATTERS in only one way: the reason printed must be the FIRST door that refuses, because
    // an operator clearing a later one would still get a refusal and read it as a bug.
    const blockedReason = ((): string | null => {
      if (placement.originDomainId !== selfDomainId) {
        return (
          `read-only replica (authoritative domain '${placement.originDomainId}') — ` +
          `single-writer authority refuses a local delete; it clears when its own domain withdraws it`
        );
      }
      const binding = bindingsByTarget.get(placement.id);
      if (binding !== undefined) {
        return (
          `${binding.length} executor binding(s) still name it as their target, so orphan-guard ` +
          `route 6 refuses the delete — remove them first: ` +
          binding
            .map(
              (b) => `\`scp executor unbind ${placement.urn} --type ${b.type} --lane ${b.lane}\``
            )
            .join(", ")
        );
      }
      if (placement.managedByStack !== null) {
        // NOT "cannot" — "should not". The door would take it; the next `scp iac apply` of that stack
        // re-derives the stack's objects from the manifest and would either restore the row or prune
        // it on its own, so a repair run racing the apply is churn at best and a surprising diff at
        // worst. Same shape as route 6's policy-managed carve-out: a row with a reaper is not the
        // operator's job.
        return (
          `managed by coordination-as-code stack '${placement.managedByStack}' — its next ` +
          `\`scp iac apply\` is the reaper; repairing it by hand races that apply`
        );
      }
      return null;
    })();
    return {
      id: placement.id,
      ownerUrn: placement.urn,
      ownerName: placement.name,
      detail,
      deadEnd,
      repairable: blockedReason === null,
      blockedReason
    };
  });

  return {
    danglingRelationships,
    orphanSourceMappings,
    orphanExecutorBindings,
    orphanPlacements
  };
}
