/**
 * THE DELIVERY RECORD (D26, owner ruling 2026-08-27) — which stacks a config source has actually
 * applied, and therefore owns.
 *
 * `config-sources-repo.ts`'s header states the gap this closes: §4 makes the explicit `stackTeams`
 * map the D7 binding, D9 gives an unclaimed stack the registration's default team, and between them
 * sat a stack the sync applies every time the repo changes while the CLI-apply guard called it
 * unowned — so a push succeeded and the next sync silently reverted it. Ownership follows delivery.
 *
 * ================================================================================================
 * ONE STACK HAS ONE OWNER, AND THE DATABASE IS WHAT SAYS SO
 * ================================================================================================
 * The primary key is `(org_id, stack_name)`. {@link recordStackDelivery} therefore does an UPSERT
 * whose `DO UPDATE` is GUARDED by `config_source_id` — a second config source delivering a stack
 * the first already owns updates ZERO rows, and this function reports that as
 * `owned_by_other_source` rather than swallowing it. An unguarded `DO UPDATE` would be
 * last-writer-wins, which is exactly what D9 says must never happen, and it would be invisible: the
 * insert would "succeed" every time and the owner would flip with whichever repo pushed last.
 */

import { and, eq, sql } from "drizzle-orm";
import { configSourceStacks } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";

export interface StackDelivery {
  stackName: string;
  configSourceId: string;
  teamObjectId: string;
  lastCommitSha: string;
  lastManifestPath: string;
}

export type RecordDeliveryResult =
  | { outcome: "recorded"; created: boolean }
  /** The stack is already delivered by a DIFFERENT config source. Never overwritten. */
  | { outcome: "owned_by_other_source"; ownerConfigSourceId: string };

export async function recordStackDelivery(
  tx: TenantTx,
  orgId: string,
  delivery: StackDelivery
): Promise<RecordDeliveryResult> {
  const rows = await tx
    .insert(configSourceStacks)
    .values({
      orgId,
      stackName: delivery.stackName,
      configSourceId: delivery.configSourceId,
      teamObjectId: delivery.teamObjectId,
      lastCommitSha: delivery.lastCommitSha,
      lastManifestPath: delivery.lastManifestPath
    })
    .onConflictDoUpdate({
      target: [configSourceStacks.orgId, configSourceStacks.stackName],
      // THE GUARD. Without it this is last-writer-wins ownership transfer, silently.
      setWhere: eq(configSourceStacks.configSourceId, delivery.configSourceId),
      set: {
        teamObjectId: delivery.teamObjectId,
        lastCommitSha: delivery.lastCommitSha,
        lastManifestPath: delivery.lastManifestPath,
        lastDeliveredAt: sql`now()`
      }
    })
    .returning({
      configSourceId: configSourceStacks.configSourceId,
      firstDeliveredAt: configSourceStacks.firstDeliveredAt,
      lastDeliveredAt: configSourceStacks.lastDeliveredAt
    });

  const row = rows[0];
  if (!row) {
    // Zero rows means the conflict target matched but `setWhere` did not: some OTHER config source
    // owns this stack. Read it back so the refusal can NAME the owner rather than saying "someone".
    const existing = await tx
      .select({ configSourceId: configSourceStacks.configSourceId })
      .from(configSourceStacks)
      .where(
        and(
          eq(configSourceStacks.orgId, orgId),
          eq(configSourceStacks.stackName, delivery.stackName)
        )
      )
      .limit(1);
    const owner = existing[0];
    if (!owner) {
      // Neither inserted nor conflicting: not reachable through the statement above, so it is a bug
      // rather than a state, and it fails loudly instead of being reported as an ownership answer.
      throw new Error(
        `internal: delivery of stack '${delivery.stackName}' neither inserted nor conflicted`
      );
    }
    return { outcome: "owned_by_other_source", ownerConfigSourceId: owner.configSourceId };
  }
  return {
    outcome: "recorded",
    created: row.firstDeliveredAt.getTime() === row.lastDeliveredAt.getTime()
  };
}

/** The config source delivering this stack, or `null`. The delivered half of D7's predicate. */
export async function findDeliveredStackOwner(
  tx: TenantTx,
  orgId: string,
  stackName: string
): Promise<{ configSourceId: string; teamObjectId: string } | null> {
  const rows = await tx
    .select({
      configSourceId: configSourceStacks.configSourceId,
      teamObjectId: configSourceStacks.teamObjectId
    })
    .from(configSourceStacks)
    .where(and(eq(configSourceStacks.orgId, orgId), eq(configSourceStacks.stackName, stackName)))
    .limit(1);
  return rows[0] ?? null;
}
