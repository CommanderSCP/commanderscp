import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { executionSystemSourceAllowlists, objects } from "../db/schema.js";
import { globMatch } from "./glob-match.js";
import { executionSystemRoutingFingerprint } from "../authz/execution-system-routing-door.js";

/**
 * AN EXECUTION SYSTEM'S SOURCE-REPO ALLOWLIST (M28.3 re-verify, owner ruling R1, ADR-0056 §7a).
 *
 * The question a target's `infrastructureRepo` or a component's source mapping cannot answer on its
 * own: MAY this repository run with THAT system's credentials? Both are written with `object:write`,
 * so a subject who may re-declare the target could name their own repo and have it planned with the
 * plan credentials (verification probe C2). The authority therefore lives with the credentials — on
 * the execution system, behind `secret:write` at the org root — and a run needs BOTH: its repo in
 * the system's allowlist AND matching what the target/component declares.
 *
 * An entry is `owner/name` or `owner/*`. A system with no row allows nothing; an INLINE binding has
 * no system and so no allowlist, and these lanes refuse it.
 *
 * BOUND TO THE SYSTEM'S ROUTING (ADR-0056 addendum 3, belt-and-braces to the routing door): each row
 * records the fingerprint of the system's whole `properties` object when it was set, and a reader whose live system no longer matches reads NOTHING ALLOWED. The list names
 * which repos may run at one destination with one credential; re-pointing the system — by any door,
 * a replicated revision included — means someone with `secret:write` re-sets it for the new one.
 */

export const ALLOWLIST_ENTRY = /^[A-Za-z0-9._-]+\/([A-Za-z0-9._-]+|\*)$/;
export const ALLOWLIST_MAX_ENTRIES = 200;

export class SourceAllowlistInvalid extends Error {}

export interface SourceAllowlist {
  executionSystemObjectId: string;
  repos: string[];
  /** False when the live system's routing is not what the list was set for — then nothing is allowed. */
  routingCurrent: boolean;
  recordedBySubjectId: string;
  updatedAt: Date;
}

/** Normalised (sorted, deduplicated) at the write door, so a stored list compares byte-for-byte. */
export function validateSourceAllowlist(repos: readonly string[]): string[] {
  if (repos.length > ALLOWLIST_MAX_ENTRIES) {
    throw new SourceAllowlistInvalid(`at most ${ALLOWLIST_MAX_ENTRIES} entries`);
  }
  for (const r of repos) {
    if (!ALLOWLIST_ENTRY.test(r)) {
      throw new SourceAllowlistInvalid(`'${r}' is not 'owner/name' or 'owner/*'`);
    }
  }
  return [...new Set(repos)].sort();
}

export async function putSourceAllowlist(
  tx: TenantTx,
  input: {
    orgId: string;
    executionSystemObjectId: string;
    repos: readonly string[];
    recordedBySubjectId: string;
  }
): Promise<SourceAllowlist> {
  const repos = validateSourceAllowlist(input.repos);
  // The fingerprint is read off the LIVE system in this transaction, never taken from the caller.
  const [system] = await tx
    .select({ properties: objects.properties })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, input.orgId),
        eq(objects.id, input.executionSystemObjectId),
        eq(objects.typeId, "execution-system"),
        isNull(objects.deletedAt)
      )
    )
    .limit(1);
  if (!system) throw new SourceAllowlistInvalid("the execution system does not exist");
  const routingFingerprint = executionSystemRoutingFingerprint(system.properties);
  const now = new Date();
  const [row] = await tx
    .insert(executionSystemSourceAllowlists)
    .values({
      id: randomUUID(),
      orgId: input.orgId,
      executionSystemObjectId: input.executionSystemObjectId,
      repos,
      routingFingerprint,
      recordedBySubjectId: input.recordedBySubjectId,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [
        executionSystemSourceAllowlists.orgId,
        executionSystemSourceAllowlists.executionSystemObjectId
      ],
      set: {
        repos,
        routingFingerprint,
        recordedBySubjectId: input.recordedBySubjectId,
        updatedAt: now
      }
    })
    .returning();
  if (!row) throw new Error("failed to record the source allowlist");
  return {
    executionSystemObjectId: row.executionSystemObjectId,
    repos: row.repos,
    routingCurrent: true,
    recordedBySubjectId: row.recordedBySubjectId,
    updatedAt: row.updatedAt
  };
}

export async function getSourceAllowlist(
  tx: TenantTx,
  orgId: string,
  executionSystemObjectId: string
): Promise<SourceAllowlist | undefined> {
  // FAILS CLOSED ON A TOMBSTONED SYSTEM: the row outlives its system (no DELETE grant, deliberately),
  // and an allowlist is only an allowlist of a LIVE execution system — joined here, so a caller
  // holding a stale id reads "nothing allowed" (docs/graph.md §125f).
  const [joined] = await tx
    .select({ row: executionSystemSourceAllowlists, systemProperties: objects.properties })
    .from(executionSystemSourceAllowlists)
    .innerJoin(
      objects,
      and(
        eq(objects.orgId, executionSystemSourceAllowlists.orgId),
        eq(objects.id, executionSystemSourceAllowlists.executionSystemObjectId)
      )
    )
    .where(
      and(
        eq(executionSystemSourceAllowlists.orgId, orgId),
        eq(executionSystemSourceAllowlists.executionSystemObjectId, executionSystemObjectId),
        eq(objects.typeId, "execution-system"),
        isNull(objects.deletedAt)
      )
    )
    .limit(1);
  const row = joined?.row;
  if (!row) return undefined;
  return {
    executionSystemObjectId: row.executionSystemObjectId,
    repos: row.repos,
    routingCurrent:
      row.routingFingerprint === executionSystemRoutingFingerprint(joined.systemProperties),
    recordedBySubjectId: row.recordedBySubjectId,
    updatedAt: row.updatedAt
  };
}

/** Is `repo` one the system allows? Exact, or an `owner/*` entry for its owner. */
export function repoAllowedBy(allowlist: SourceAllowlist | undefined, repo: string): boolean {
  if (!allowlist || !allowlist.routingCurrent) return false;
  return allowlist.repos.some((entry) => entry === repo || globMatch(entry, repo));
}
