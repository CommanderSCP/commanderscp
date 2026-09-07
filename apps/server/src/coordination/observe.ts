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

/** The observe driver, for poll-versus-push equivalence. See docs/coordination.md §564. */

export const OBSERVE_QUEUE = "coordination-observe-tick";

export const OBSERVE_TICK_INTERVAL_SECONDS = Math.max(
  5,
  Number(process.env.SCP_OBSERVE_TICK_INTERVAL_SECONDS ?? 60)
);

/** The source kind an observed event is filed under. See docs/coordination.md §565. */
function sourceKindForModule(pluginModule: string): string {
  return pluginModule;
}

/** The observe cursor. See docs/coordination.md §566. */
export type ObserveWatermarks = Record<string, string>;

/** A watermark map is keyed by `ExecutorEvent.kind`. See docs/coordination.md §567. */
function emptyWatermarks(): ObserveWatermarks {
  return Object.create(null) as ObserveWatermarks;
}

/** Own-key lookup. Never `marks[kind]`: for `kind` of `"__proto__"`, `"toString"`,
 *  `"constructor"`, … that expression returns an INHERITED member of `Object.prototype`, not a
 *  watermark. `emptyWatermarks` already removes the inherited members from maps this module
 *  builds; this makes the read correct even for a map a caller built as a plain object literal. */
function ownMark(marks: ObserveWatermarks, kind: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(marks, kind) ? marks[kind] : undefined;
}

/** A watermark must be a parseable timestamp — anything else is corruption, not a cursor, and
 *  passing it through would reach the provider as a nonsense `?since=` query parameter. */
function isTimestamp(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}

export function parseCursorToken(token: string | null): ObserveWatermarks {
  if (!token) return emptyWatermarks();
  const trimmed = token.trim();
  if (!trimmed.startsWith("{")) {
    const out = emptyWatermarks();
    if (isTimestamp(trimmed)) out._legacy = trimmed;
    return out;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyWatermarks();
    const out = emptyWatermarks();
    for (const [kind, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) out[kind] = value;
    }
    return out;
  } catch {
    // An unparseable token is treated as "no watermark" rather than throwing: a corrupt cursor must
    // not wedge the observe loop for that instance forever. Re-polling is safe — dedupe collapses
    // anything already ingested.
    return emptyWatermarks();
  }
}

/** The watermark a given event kind should resume from — its own, else the legacy scalar. */
export function watermarkFor(marks: ObserveWatermarks, kind: string): string | undefined {
  return ownMark(marks, kind) ?? ownMark(marks, "_legacy");
}

export function advanceWatermarks(
  events: ExecutorEvent[],
  current: ObserveWatermarks
): ObserveWatermarks {
  // `Object.assign` onto a null-prototype target, not `{ ...current }`: the spread would give the
  // accumulator `Object.prototype` back and reopen every hazard described on `emptyWatermarks`.
  const next: ObserveWatermarks = Object.assign(emptyWatermarks(), current);
  for (const ev of events) {
    if (typeof ev.occurredAt !== "string" || !ev.kind) continue;
    const seen = ownMark(next, ev.kind) ?? ownMark(next, "_legacy");
    if (seen === undefined || ev.occurredAt > seen) next[ev.kind] = ev.occurredAt;
  }
  return next;
}

export function serializeCursorToken(marks: ObserveWatermarks): string {
  // Keys sorted so an unchanged cursor serializes byte-identically and does not churn the row.
  const sorted: ObserveWatermarks = emptyWatermarks();
  for (const key of Object.keys(marks).sort()) sorted[key] = marks[key] as string;
  return JSON.stringify(sorted);
}

/** The dedupe identity of ONE observed event. See docs/coordination.md §568. */
export function observedEventIdentity(ev: ExecutorEvent): string {
  const c = ev.correlation ?? {};
  const group = c.correlationKey ?? ev.kind;
  // `stateRef` sits AFTER the two natural identities and BEFORE the timestamp fallback: a provider
  // that can name the state it observed should never be deduped by a clock it does not control.
  const discriminator = c.commitSha ?? c.artifactDigest ?? c.stateRef ?? ev.occurredAt;
  return `${group}|${discriminator}`;
}

/** Normalize observed events into `change_source_events`. See docs/coordination.md §569. */
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
    const dedupeKey = `observe:${pluginInstanceId}:${observedEventIdentity(ev)}`;
    const payload: Record<string, unknown> = {
      repo: c.repo,
      path: c.path,
      // The changed-file set. Persisted at top level beside `path` for the same reason `path` is:
      // `webhook-processor.ts`'s generic `extractHint` reads an observed payload flat, so a field
      // that stays nested in `raw` is invisible to correlation.
      paths: c.paths,
      correlationKey: c.correlationKey,
      // Flat, beside `repo`/`path`, for exactly the reason `paths` is: `extractHint`'s generic
      // reader takes an observed payload at TOP LEVEL, so a ref left nested in `raw` would be
      // invisible to correlation and a polled push would silently ignore every ref-scoped mapping
      // that a delivered webhook honours (DESIGN §12 poll-vs-push equivalence).
      ref: c.ref,
      commitSha: c.commitSha,
      artifactDigest: c.artifactDigest,
      // Persisted for forensics only — never read back for correlation. Without it, "why did this
      // event dedupe away?" is unanswerable from the row.
      stateRef: c.stateRef,
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

/** Poll every observe-capable executor instance in one org. See docs/coordination.md §570. */
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

      const nextToken =
        events.length > 0
          ? serializeCursorToken(advanceWatermarks(events, parseCursorToken(cursorToken)))
          : cursorToken;
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

export async function runObserveSweep(db: Db, host: PluginHost, masterKey: Buffer): Promise<void> {
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
  // Startup kick: UNKEYED, so it always inserts (LOOP_STARTUP_SEND_IS_UNKEYED, events/pgboss.ts).
  // Never give this send a singletonKey+window — not the chain's "tick" and not a private key
  // either: job_i4 counts COMPLETED jobs, so any window lets a previous boot swallow it silently.
  await boss.send(OBSERVE_QUEUE, {});
  return {
    async stop() {
      stopped = true;
      await inFlightTick;
    }
  };
}
