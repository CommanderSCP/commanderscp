import { and, asc, eq, isNull } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents } from "../db/schema.js";
import { linkToCoordinatedChange, matchComponentForSource } from "./correlation.js";
import { proposeChange } from "./changes-repo.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";

const BATCH_LIMIT = 20;

/**
 * The "process" half of persist-then-process webhook ingress (DESIGN.md §8: "raw payload
 * persisted first (signature-verified), then processed as an event — replayable and auditable").
 * `routes/change-sources.ts`'s webhook route does ONLY the persist step (a plain INSERT); this
 * turns unprocessed `change_source_events` rows into Changes, run from the SAME reconciliation
 * tick as everything else in `coordination/reconcile.ts` (one more "observe → decide →
 * coordinate" step, reusing its per-org loop rather than a second scheduling mechanism) — which
 * is what makes ingress "replayable": a row that fails processing simply stays unprocessed and is
 * retried on the next tick, exactly like every other engine action in this milestone.
 *
 * Provider-agnostic on purpose: M3 ships no GitHub/ArgoCD/Terraform-specific payload parsing (that
 * lands with the real executor plugins in M7) — the correlation hint this reads is the same small,
 * documented common shape `coordination/correlation.ts`'s `CorrelationHint` already models
 * (`repo`, `path`, `correlationKey`), which a source-specific adapter (or, today, a direct test/
 * curl caller) is expected to send.
 */
function extractHint(payload: unknown): { repo?: string; path?: string; correlationKey?: string } {
  if (!payload || typeof payload !== "object") return {};
  const p = payload as Record<string, unknown>;
  return {
    repo: typeof p.repo === "string" ? p.repo : undefined,
    path: typeof p.path === "string" ? p.path : undefined,
    correlationKey: typeof p.correlationKey === "string" ? p.correlationKey : undefined
  };
}

export async function processChangeSourceEvents(tx: TenantTx, orgId: string): Promise<void> {
  const rows = await tx
    .select()
    .from(changeSourceEvents)
    .where(and(eq(changeSourceEvents.orgId, orgId), isNull(changeSourceEvents.processedAt)))
    .orderBy(asc(changeSourceEvents.createdAt))
    .limit(BATCH_LIMIT);

  for (const row of rows) {
    const hint = extractHint(row.payload);
    const componentObjectId = await matchComponentForSource(tx, orgId, {
      sourceKind: row.sourceKind,
      repo: hint.repo,
      path: hint.path
    });

    if (!componentObjectId) {
      // No `source_mappings` row matched — nothing to correlate against, so there's no target to
      // propose a Change for. Marked processed anyway: persist-then-process's "replayable"
      // promise covers retrying TRANSIENT failures, not waiting forever for a mapping that may
      // never be added — an operator who adds the missing mapping later is covered by the NEXT
      // webhook delivery, not a replay of this one.
      await tx
        .update(changeSourceEvents)
        .set({ processedAt: new Date() })
        .where(eq(changeSourceEvents.id, row.id));
      continue;
    }

    const { change } = await proposeChange(tx, {
      orgId,
      actorObjectId: SYSTEM_ACTOR_ID,
      requestId: `webhook-${row.id}`,
      name: `${row.sourceKind}${hint.repo ? `: ${hint.repo}` : ""}`,
      sourceKind: row.sourceKind,
      sourceRef: (row.payload as Record<string, unknown>) ?? {},
      correlationKey: hint.correlationKey,
      targets: [componentObjectId]
    });

    if (hint.correlationKey) {
      await linkToCoordinatedChange(tx, {
        orgId,
        changeObjectId: change.id,
        correlationKey: hint.correlationKey,
        actorObjectId: SYSTEM_ACTOR_ID,
        requestId: `webhook-${row.id}`
      });
    }

    await tx
      .update(changeSourceEvents)
      .set({ processedAt: new Date(), resultingChangeObjectId: change.id })
      .where(eq(changeSourceEvents.id, row.id));
  }
}
