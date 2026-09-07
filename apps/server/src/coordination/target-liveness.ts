import { and, eq } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";

/** IS THE OBJECT THIS WAVE TARGET NAMES STILL LIVE? See docs/coordination.md §982. */

/** The status used when the named object is gone. See docs/coordination.md §983. */
export const WAVE_TARGET_TOMBSTONED_STATUS = "target_deleted";

/** The hash-chained audit action for that refusal, sibling of `change.wave_target.no_executor`. */
export const WAVE_TARGET_TOMBSTONED_AUDIT_ACTION = "change.wave_target.target_deleted";

/** The `inputContext.gate` label every refusal on this path carries — the key an operator (or the
 *  service board, or `scp change explain`) filters Decisions by. */
export const TARGET_DELETED_GATE = "target_deleted";

export type TargetLiveness =
  | { live: true }
  | {
      live: false;
      /** WHICH way it was not live. `deleted` = tombstoned; `missing` = no row at all. Never
       *  inferred from the other — see the provenance-label rule in the module doc. */
      reason: "deleted" | "missing";
      /** The object that is actually gone. For a placement target this is the COMPONENT or the
       *  DEPLOYMENT-TARGET, not the placement, so the Decision names the thing an operator deleted
       *  rather than the row that merely referenced it. */
      objectId: string;
      /** That object's `type_id`, when there is a row to read it from (`null` for `missing`). */
      typeId: string | null;
      /** How the wave target reached it: `"target"` = the wave target's own object;
       *  `"placement.component"` / `"placement.deploymentTarget"` = one half of a live placement's
       *  pair. Read off the branch that produced it, never re-derived. */
      via: "target" | "placement.component" | "placement.deploymentTarget";
    };

interface LivenessRow {
  id: string;
  typeId: string;
  deletedAt: Date | null;
  properties: unknown;
}

/** Deliberately WITHOUT the `deleted_at IS NULL` filter every other reader applies: this is the one
 *  read whose job is to tell a tombstone apart from an absence, and a filtered read collapses both
 *  into "no row". */
async function readObjectRow(
  tx: TenantTx,
  orgId: string,
  objectId: string
): Promise<LivenessRow | undefined> {
  const [row] = await tx
    .select({
      id: objects.id,
      typeId: objects.typeId,
      deletedAt: objects.deletedAt,
      properties: objects.properties
    })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), eq(objects.id, objectId)))
    .limit(1);
  return row;
}

/** Resolve one wave target's liveness. See docs/coordination.md §984. */
export async function readTargetLiveness(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<TargetLiveness> {
  const row = await readObjectRow(tx, orgId, targetObjectId);
  if (!row) {
    return {
      live: false,
      reason: "missing",
      objectId: targetObjectId,
      typeId: null,
      via: "target"
    };
  }
  if (row.deletedAt !== null) {
    return {
      live: false,
      reason: "deleted",
      objectId: targetObjectId,
      typeId: row.typeId,
      via: "target"
    };
  }
  if (row.typeId !== "placement") return { live: true };

  // ADR-0026 stage shape — see the module doc for why a LIVE placement is not enough.
  const props = (row.properties ?? {}) as { componentId?: unknown; deploymentTargetId?: unknown };
  const pair: { id: unknown; via: "placement.component" | "placement.deploymentTarget" }[] = [
    { id: props.componentId, via: "placement.component" },
    { id: props.deploymentTargetId, via: "placement.deploymentTarget" }
  ];
  for (const half of pair) {
    // A placement whose properties do not carry a half is malformed rather than deleted. It is left
    // to the resolvers that already refuse it (`plan-service.ts` skips such rows outright), because
    // reporting "deleted" for a shape fault would be the provenance-label mistake: a label named
    // after the branch that matched rather than after what is true.
    if (typeof half.id !== "string") continue;
    const sub = await readObjectRow(tx, orgId, half.id);
    if (!sub) {
      return { live: false, reason: "missing", objectId: half.id, typeId: null, via: half.via };
    }
    if (sub.deletedAt !== null) {
      return {
        live: false,
        reason: "deleted",
        objectId: half.id,
        typeId: sub.typeId,
        via: half.via
      };
    }
  }
  return { live: true };
}

/** One sentence naming what is gone and how the wave target reached it — the `reasonTree.summary` of
 *  the block Decision and the `reason` of the audit event, built once so the two always agree. */
export function describeDeadTarget(
  targetObjectId: string,
  liveness: Extract<TargetLiveness, { live: false }>
): string {
  const what =
    liveness.reason === "deleted" ? "soft-deleted (tombstoned)" : "absent from the graph";
  const noun = liveness.typeId ? `${liveness.typeId} ${liveness.objectId}` : liveness.objectId;
  const reached =
    liveness.via === "target"
      ? "the wave target itself"
      : liveness.via === "placement.component"
        ? `the component of placement ${targetObjectId}`
        : `the deployment-target of placement ${targetObjectId}`;
  return (
    `wave target ${targetObjectId} cannot be driven: ${reached} — ${noun} — is ${what}. ` +
    `A deleted object is out of scope for every policy, role binding and containment walk in the ` +
    `platform, so releasing to it would deploy something nothing governs.`
  );
}

/** The `inputContext` of that Decision — the inputs the verdict was taken on (charter principle 6). */
export function deadTargetInputContext(
  targetObjectId: string,
  liveness: Extract<TargetLiveness, { live: false }>
): Record<string, unknown> {
  return {
    targetObjectId,
    gate: TARGET_DELETED_GATE,
    liveness: liveness.reason,
    deadObjectId: liveness.objectId,
    deadObjectTypeId: liveness.typeId,
    reachedVia: liveness.via
  };
}

/** What an operator should do about it. Restoring a tombstoned object is not an operation this
 *  platform offers, so the remedy is stated in verbs that exist. */
export const DEAD_TARGET_REMEDIATION =
  "cancel or roll back this change, then re-propose it against a live target (a soft-deleted " +
  "object is never resurrected — nothing in the platform un-tombstones one)";
