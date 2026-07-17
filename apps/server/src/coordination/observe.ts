import { v7 as uuidv7 } from "uuid";
import { and, eq } from "drizzle-orm";
import type PgBoss from "pg-boss";
import type { ExecutorEvent } from "@scp/plugin-api";
import type { Db } from "../db/client.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents, executorObserveCursors, orgs } from "../db/schema.js";
import type { PluginHost } from "../plugin-host/contract.js";
import {
  listExecutorBindings,
  resolveExecutorPluginInstance,
  type ExecutorBindingRow
} from "./executor-bindings-repo.js";

/**
 * The observe()-DRIVER (M10.2, DESIGN §12 "poll-vs-push equivalence"). The reconcile loop
 * (`reconcile.ts`) only calls `status()` on already-coordinating changes and processes INBOUND
 * webhook rows — so before this loop, an executor SCP cannot be *reached from* (air-gapped,
 * tailnet-only, most self-hosted) was invisible: nothing created Changes from it. This loop closes
 * that gap on the PULL side, and it is deliberately thin because `ExecutorEvent.correlation` already
 * carries the SAME hint fields (`repo`/`path`/`correlationKey`) that `source_mappings` match against:
 *
 *   observe() → normalize into `change_source_events` → [existing] processChangeSourceEvents → Change
 *
 * i.e. observed events ride the EXACT queue + propose/gate/wave/decision/audit path the inbound
 * webhook route feeds — zero new coordination machinery, and a bounded pull cadence (default 60s,
 * NOT the 1s reconcile tick) to respect external-API rate limits.
 */

export const OBSERVE_QUEUE = "coordination-observe-tick";

export const OBSERVE_TICK_INTERVAL_SECONDS = Math.max(
  5,
  Number(process.env.SCP_OBSERVE_TICK_INTERVAL_SECONDS ?? 60)
);

/**
 * The `source_kind` an observed event is filed under so `matchComponentForSource` can find the
 * operator's `source_mappings` row. The executor plugin module name IS the source kind for the
 * change-detecting executors (`github`/`argocd`/`terraform`), matching what the inbound webhook
 * route uses in its `:sourceKind` path param and what operators register their mappings under.
 */
function sourceKindForModule(pluginModule: string): string {
  return pluginModule;
}

/** ISO-8601 lexicographic max — the watermark cursor advanced past every event just ingested. */
function advanceWatermark(events: ExecutorEvent[], current: string | null): string | null {
  let max = current;
  for (const ev of events) {
    if (typeof ev.occurredAt === "string" && (max === null || ev.occurredAt > max)) {
      max = ev.occurredAt;
    }
  }
  return max;
}

/**
 * Normalize observed events into `change_source_events`. The payload carries the event's structured
 * `correlation` at top level so `webhook-processor.ts`'s generic `extractHint` (which reads
 * `payload.repo`/`.path`/`.correlationKey`) correlates it exactly as a `scp change report` caller
 * would — no `x-github-event` header is set, so github's header-driven parse falls back to generic.
 * `dedupeKey` includes the instance id so overlapping poll windows (and two instances of the same
 * module) never double-propose; `signatureVerified: true` because this is SCP's own trusted poll,
 * not an unauthenticated inbound delivery.
 */
export async function ingestObservedEvents(
  tx: TenantTx,
  orgId: string,
  sourceKind: string,
  pluginInstanceId: string,
  events: ExecutorEvent[]
): Promise<number> {
  let ingested = 0;
  for (const ev of events) {
    const c = ev.correlation ?? {};
    const identity =
      c.correlationKey ?? c.commitSha ?? c.artifactDigest ?? `${ev.kind}:${ev.occurredAt}`;
    const dedupeKey = `observe:${pluginInstanceId}:${identity}`;
    const payload: Record<string, unknown> = {
      repo: c.repo,
      path: c.path,
      correlationKey: c.correlationKey,
      commitSha: c.commitSha,
      artifactDigest: c.artifactDigest,
      kind: ev.kind,
      observedAt: ev.occurredAt,
      _observed: true,
      raw: ev.raw
    };
    const inserted = await tx
      .insert(changeSourceEvents)
      .values({
        id: uuidv7(),
        orgId,
        sourceKind,
        signatureVerified: true,
        dedupeKey,
        headers: {},
        payload
      })
      .onConflictDoNothing({
        target: [
          changeSourceEvents.orgId,
          changeSourceEvents.sourceKind,
          changeSourceEvents.dedupeKey
        ]
      })
      .returning({ id: changeSourceEvents.id });
    if (inserted[0]) ingested += 1;
  }
  return ingested;
}

async function loadCursor(
  tx: TenantTx,
  orgId: string,
  pluginInstanceId: string
): Promise<string | null> {
  const rows = await tx
    .select({ cursorToken: executorObserveCursors.cursorToken })
    .from(executorObserveCursors)
    .where(
      and(
        eq(executorObserveCursors.orgId, orgId),
        eq(executorObserveCursors.pluginInstanceId, pluginInstanceId)
      )
    )
    .limit(1);
  return rows[0]?.cursorToken ?? null;
}

async function saveCursor(
  tx: TenantTx,
  orgId: string,
  pluginInstanceId: string,
  cursorToken: string | null
): Promise<void> {
  await tx
    .insert(executorObserveCursors)
    .values({ orgId, pluginInstanceId, cursorToken, lastPolledAt: new Date() })
    .onConflictDoUpdate({
      target: [executorObserveCursors.orgId, executorObserveCursors.pluginInstanceId],
      set: { cursorToken, lastPolledAt: new Date() }
    });
}

/**
 * Poll every observe-capable executor instance in one org. Bindings sharing a `pluginInstanceId`
 * share observe scope (identical configured source), so we dedupe to one poll per instance. Each
 * instance is isolated in its own try/catch — a dead/rate-limited executor never stalls the others
 * or the tick.
 */
export async function observeOrgTick(
  db: Db,
  orgId: string,
  host: PluginHost,
  masterKey: Buffer
): Promise<void> {
  const bindings = await withTenantTx(db, orgId, (tx) => listExecutorBindings(tx, orgId));
  if (bindings.length === 0) return;

  const oneBindingPerInstance = new Map<string, ExecutorBindingRow>();
  for (const b of bindings) {
    if (!oneBindingPerInstance.has(b.pluginInstanceId)) {
      oneBindingPerInstance.set(b.pluginInstanceId, b);
    }
  }

  for (const [pluginInstanceId, binding] of oneBindingPerInstance) {
    try {
      const resolved = await withTenantTx(db, orgId, (tx) =>
        // MUST resolve by the deduped binding's OWN routing Type (M12 P4A / ADR-0007). Without it
        // this defaults to 'configuration', so for a target holding several pipelines a non-default
        // entry resolves the configuration binding's instance: that instance gets polled twice in a
        // tick and the other instance is never observed — silently, since resolve returns a valid one.
        resolveExecutorPluginInstance(tx, {
          orgId,
          targetObjectId: binding.targetObjectId,
          masterKey,
          type: binding.type
        })
      );
      if (!resolved) continue;
      await host.start([resolved.instanceConfig]);
      const client = host.executor(resolved.instanceConfig.id);

      const caps = await client.describeCapabilities();
      if (!caps.supportsObserve) continue;

      const cursorToken = await withTenantTx(db, orgId, (tx) =>
        loadCursor(tx, orgId, resolved.instanceConfig.id)
      );
      const events = await client.observe(cursorToken ? { token: cursorToken } : undefined);

      const nextToken = events.length > 0 ? advanceWatermark(events, cursorToken) : cursorToken;
      await withTenantTx(db, orgId, async (tx) => {
        if (events.length > 0) {
          await ingestObservedEvents(
            tx,
            orgId,
            sourceKindForModule(binding.pluginModule),
            resolved.instanceConfig.id,
            events
          );
        }
        await saveCursor(tx, orgId, resolved.instanceConfig.id, nextToken);
      });
    } catch (err) {
      console.error(`[observe] org ${orgId} instance ${pluginInstanceId} failed:`, err);
    }
  }
}

/** Every org, one tick — mirrors `runReconcileSweep`. */
export async function runObserveSweep(
  db: Db,
  host: PluginHost,
  masterKey: Buffer
): Promise<void> {
  const orgRows = await db.select({ id: orgs.id }).from(orgs);
  for (const org of orgRows) {
    try {
      await observeOrgTick(db, org.id, host, masterKey);
    } catch (err) {
      console.error(`[observe] org ${org.id} tick failed:`, err);
    }
  }
}

export interface ObserveLoopHandle {
  stop(): Promise<void>;
}

/**
 * Self-rescheduling pg-boss loop, the pull-side sibling of `startReconcileLoop` — same singleton
 * pattern, a much slower cadence. Runs only under `SCP_ROLE=all|worker` (wired in `main.ts`).
 */
export async function startObserveLoop(
  boss: PgBoss,
  db: Db,
  host: PluginHost,
  masterKey: Buffer
): Promise<ObserveLoopHandle> {
  let stopped = false;
  let inFlightTick: Promise<void> | undefined;
  await boss.createQueue(OBSERVE_QUEUE);
  await boss.work(OBSERVE_QUEUE, async () => {
    if (stopped) return;
    const tick = runObserveSweep(db, host, masterKey);
    inFlightTick = tick;
    try {
      await tick;
    } finally {
      inFlightTick = undefined;
    }
    if (stopped) return;
    await boss.send(
      OBSERVE_QUEUE,
      {},
      {
        startAfter: OBSERVE_TICK_INTERVAL_SECONDS,
        singletonKey: "tick",
        singletonSeconds: OBSERVE_TICK_INTERVAL_SECONDS
      }
    );
  });
  await boss.send(OBSERVE_QUEUE, {});
  return {
    async stop() {
      stopped = true;
      await inFlightTick;
    }
  };
}
