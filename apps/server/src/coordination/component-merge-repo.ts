import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { GraphObject } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { changes, objects } from "../db/schema.js";
import { badRequest, conflict } from "../errors.js";
import { authorize } from "../authz/resolve.js";
import { getObjectByIdOrUrnAnyType, deleteObject } from "../graph/objects-repo.js";
import { listRelationships } from "../graph/relationships-repo.js";
import { insertDecision } from "./decisions-repo.js";
import {
  listExecutorBindingsForTarget,
  repointExecutorBindingTarget,
  type BindingPurpose
} from "./executor-bindings-repo.js";

/**
 * Driving-case component merge (M12 P5d, docs/proposals/organize-after.md §2.4). Folds a LOSER
 * component into a SURVIVOR: the loser's executor bindings are re-pointed onto the survivor and the
 * loser is soft-deleted. This is the concrete homelab case — `scp connect argocd` imports one real
 * component as TWO (an infra Argo CD app + a software Argo CD app), each a separate orphan with its
 * own `purpose='software'` binding, that must become one component with two purpose-keyed bindings.
 *
 * Deliberately SCOPED to that case (proposal §2.4 / §4): the general graph-rewrite (re-pointing
 * relationship edges, jsonb references, role_bindings, freezes, source_mappings) is OUT until a
 * non-fresh case demands it. So the loser must be a freshly-imported orphan — bindings only, no live
 * relationship edges (guarded below). Owner ruling Q1: on a binding-purpose COLLISION the merge
 * REJECTS and tells the operator to relabel one binding first (`scp executor repurpose`); it never
 * guesses a new purpose.
 */

/** Non-terminal change states — a binding must not be re-pointed while a change actively resolves it
 *  (reconcile resolves bindings fresh at trigger AND status-poll, so a mid-flight move silently
 *  no-ops or drives the wrong target). Terminal states (promoted/cancelled/rolled_back) are settled. */
const IN_FLIGHT_CHANGE_STATES = [
  "proposed",
  "evaluated",
  "coordinated",
  "waiting",
  "executing",
  "validating"
] as const;

/** True if any non-terminal change targets any of `targetIds` (its object's `properties.targets`
 *  jsonb array contains the id). */
async function anyInFlightChangeTargets(
  tx: TenantTx,
  orgId: string,
  targetIds: string[]
): Promise<boolean> {
  const targetConds = targetIds.map(
    (id) => sql`${objects.properties} -> 'targets' @> ${JSON.stringify([id])}::jsonb`
  );
  const rows = await tx
    .select({ id: changes.objectId })
    .from(changes)
    .innerJoin(objects, eq(objects.id, changes.objectId))
    .where(
      and(
        eq(changes.orgId, orgId),
        inArray(changes.state, [...IN_FLIGHT_CHANGE_STATES]),
        or(...targetConds)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** True if the loser participates in ANY live relationship (as either endpoint) — the signal that it
 *  is not a fresh binding-only orphan, so the (unimplemented) general graph-rewrite would be needed. */
async function hasLiveRelationships(tx: TenantTx, orgId: string, objectId: string): Promise<boolean> {
  const asFrom = await listRelationships(tx, orgId, { fromId: objectId, limit: 1 });
  if (asFrom.items.length > 0) return true;
  const asTo = await listRelationships(tx, orgId, { toId: objectId, limit: 1 });
  return asTo.items.length > 0;
}

export interface MergeComponentsInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  survivorIdOrUrn: string;
  loserIdOrUrn: string;
}

export interface MergeComponentsResult {
  survivor: GraphObject;
  /** The purposes of the bindings moved from the loser onto the survivor. */
  movedBindingPurposes: BindingPurpose[];
}

export async function mergeComponents(
  tx: TenantTx,
  input: MergeComponentsInput
): Promise<MergeComponentsResult> {
  const survivor = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.survivorIdOrUrn);
  if (survivor.typeId !== "component") {
    throw badRequest(`survivor '${input.survivorIdOrUrn}' is a '${survivor.typeId}', not a component`);
  }
  const loser = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.loserIdOrUrn);
  if (loser.typeId !== "component") {
    throw badRequest(`loser '${input.loserIdOrUrn}' is a '${loser.typeId}', not a component`);
  }
  if (survivor.id === loser.id) {
    throw badRequest("cannot merge a component into itself");
  }

  // Authority over BOTH components: re-pointing a binding is a write on the losing and gaining target
  // (the bar `PUT`/`DELETE /binding` require), and soft-deleting the loser needs its own object:write.
  await authorize(tx, { orgId: input.orgId, subjectObjectId: input.actorObjectId, permission: "object:write", scopeObjectId: survivor.id });
  await authorize(tx, { orgId: input.orgId, subjectObjectId: input.actorObjectId, permission: "object:write", scopeObjectId: loser.id });

  // Scope guard: the loser must be a fresh binding-only orphan. Any live edge (contains, owns,
  // depends_on, consumes, …) means the general graph-rewrite would be required — out of scope (§2.4).
  if (await hasLiveRelationships(tx, input.orgId, loser.id)) {
    throw conflict(
      `loser '${input.loserIdOrUrn}' has live graph relationships — only a freshly-imported, binding-only ` +
        `component can be merged (general graph-rewrite is out of scope; detach its edges first)`
    );
  }

  // Safety guard: never re-point a binding out from under an active change (reconcile resolves it
  // fresh at trigger/status-poll). Checks BOTH targets — an in-flight change on the survivor is
  // equally unsafe to disturb.
  if (await anyInFlightChangeTargets(tx, input.orgId, [survivor.id, loser.id])) {
    throw conflict(
      "an in-flight change targets one of these components — wait for it to reach a terminal state before merging"
    );
  }

  // Owner Q1 (reject-and-require-relabel): a purpose the survivor ALREADY binds cannot receive the
  // loser's same-purpose binding (UNIQUE(org,target,purpose)). Reject with a clear next step; never
  // auto-relabel. The common homelab case (two software imports) trips exactly this.
  const loserBindings = await listExecutorBindingsForTarget(tx, input.orgId, loser.id);
  const survivorPurposes = new Set(
    (await listExecutorBindingsForTarget(tx, input.orgId, survivor.id)).map((b) => b.purpose)
  );
  for (const lb of loserBindings) {
    if (survivorPurposes.has(lb.purpose)) {
      throw conflict(
        `both components have a '${lb.purpose}' binding — relabel one first ` +
          `(\`scp executor repurpose\`) before merging, so the survivor holds one binding per purpose`
      );
    }
  }

  // No collision: re-point every loser binding onto the survivor, then soft-delete the (now
  // binding-free) loser. All inside the caller's tx — a collision mid-way (concurrent racer) rolls the
  // whole merge back at the index.
  for (const lb of loserBindings) {
    await repointExecutorBindingTarget(tx, input.orgId, lb.id, survivor.id);
  }
  await deleteObject(tx, {
    orgId: input.orgId,
    typeId: "component",
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    idOrUrn: loser.id
  });

  const movedBindingPurposes = loserBindings.map((b) => b.purpose);
  await insertDecision(tx, {
    orgId: input.orgId,
    kind: "transition",
    subjectId: survivor.id,
    verdict: "allow",
    inputContext: {
      trigger: "merge",
      actorId: input.actorObjectId,
      loserId: loser.id,
      movedBindingPurposes
    },
    reasonTree: {
      summary:
        `merged component ${loser.id} into ${survivor.id} — moved ${movedBindingPurposes.length} ` +
        `binding(s) [${movedBindingPurposes.join(", ")}] and soft-deleted the loser`
    }
  });

  return { survivor, movedBindingPurposes };
}
