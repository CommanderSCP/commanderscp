import { and, asc, eq, isNull } from "drizzle-orm";
import { mapGithubWebhookEventToHint } from "@scp/plugin-github";
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
 * Correlation hint extraction (M3 -> M7): the common shape `coordination/correlation.ts`'s
 * `CorrelationHint` models (`repo`, `path`, `correlationKey`) is still the baseline — a generic
 * source (a source-specific adapter, `scp change report`, or a direct test/curl caller) that sends
 * this flat shape directly keeps working unchanged. M7 ADDS real provider-specific parsing for
 * `sourceKind === "github"`: `@scp/plugin-github`'s `mapGithubWebhookEventToHint` (the SAME
 * function used by that plugin's own polling-fallback `observe()` — DESIGN §12's "poll-vs-push
 * equivalence") reads the real nested GitHub webhook JSON (`repository.full_name`, `head_commit.id`,
 * etc.) using the `X-GitHub-Event` header persisted alongside the payload
 * (`change_source_events.headers`). A github-specific hint field, when present, wins; any field it
 * doesn't set (or an unrecognized/missing event name) falls back to the flat generic shape, so a
 * hand-crafted test payload with a bare `{repo, correlationKey}` still correlates exactly as
 * before. ArgoCD/Terraform provider-specific parsing is not yet added (both source kinds' M7
 * plugins don't define an inbound webhook payload shape of their own — ArgoCD is poll-only,
 * Terraform Mode 1's inbound path is `scp change report`'s own flat shape already) — tracked as
 * natural follow-up if/when TFC/Atlantis-native webhook payloads need first-class parsing too.
 */
interface ExtractedHint {
  repo?: string;
  path?: string;
  correlationKey?: string;
}

function genericHint(payload: unknown): ExtractedHint {
  if (!payload || typeof payload !== "object") return {};
  const p = payload as Record<string, unknown>;
  return {
    repo: typeof p.repo === "string" ? p.repo : undefined,
    path: typeof p.path === "string" ? p.path : undefined,
    correlationKey: typeof p.correlationKey === "string" ? p.correlationKey : undefined
  };
}

function extractHint(sourceKind: string, headers: unknown, payload: unknown): ExtractedHint {
  const generic = genericHint(payload);
  if (sourceKind !== "github") return generic;

  const headerMap = (headers ?? {}) as Record<string, unknown>;
  const eventName = headerMap["x-github-event"];
  if (typeof eventName !== "string") return generic;

  const githubHint = mapGithubWebhookEventToHint(eventName, payload);
  if (!githubHint) return generic;
  return {
    repo: githubHint.repo ?? generic.repo,
    path: githubHint.path ?? generic.path,
    correlationKey: githubHint.correlationKey ?? generic.correlationKey
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
    const hint = extractHint(row.sourceKind, row.headers, row.payload);
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
