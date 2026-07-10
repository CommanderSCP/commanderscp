import { and, eq, isNull, lt } from "drizzle-orm";
import type PgBoss from "pg-boss";
import type { ChangeState } from "@scp/schemas";
import type { Db } from "../db/client.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { changes, orgs } from "../db/schema.js";
import { insertDecision } from "./decisions-repo.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";

/**
 * Stuck-change watchdog (DESIGN.md §9.4): "a watchdog sweep flags any change showing no progress
 * within its per-state SLA, writes a Decision naming what it's waiting on, and escalates via
 * notifications. The 'stuck change' failure mode is *detected*, not discovered."
 *
 * Per-state SLA — how long a change may sit in a non-terminal state with no progress
 * (`state_entered_at` unchanged) before the sweep flags it. `validating` gets a much longer SLA
 * because it is often waiting on a HUMAN `scp change promote` call, not engine work — that's an
 * expected wait, not a stall.
 */
export const WATCHDOG_SLA_MS: Record<
  Exclude<ChangeState, "cancelled" | "rolled_back" | "promoted">,
  number
> = {
  proposed: 5 * 60_000,
  evaluated: 5 * 60_000,
  coordinated: 5 * 60_000,
  executing: 30 * 60_000,
  validating: 24 * 60 * 60_000
};

const NON_TERMINAL_STATES = Object.keys(WATCHDOG_SLA_MS) as (keyof typeof WATCHDOG_SLA_MS)[];

export interface WatchdogFlag {
  changeObjectId: string;
  state: ChangeState;
  stalledForMs: number;
  decisionId: string;
}

/** System-actor id used to attribute watchdog-authored audit events/Decisions (no human actor) —
 *  re-exported under this name for call-site clarity; same sentinel `reconcile.ts` uses. */
export const WATCHDOG_SYSTEM_ACTOR_ID = SYSTEM_ACTOR_ID;

/**
 * One sweep pass over one org: finds changes past their per-state SLA that haven't already been
 * flagged since entering this state, writes a Decision + escalation audit event for each, and
 * returns what it flagged. The notification seam (DESIGN §9.4 "escalates via notifications") is
 * a structured console log for now — a real `NotificationPlugin` dispatch is M7; the Decision
 * record is the durable, queryable artifact regardless.
 *
 * Idempotent per state-entry: `watchdog_flagged_at IS NULL` (cleared by `transitionChange` on
 * every legal transition, since a transition IS progress) is the guard against re-flagging the
 * same stall on every sweep tick — this sweep sets it, so the NEXT sweep skips this change until
 * either it progresses (clearing the flag) or an operator re-runs a manual check.
 */
export async function runWatchdogSweep(
  tx: TenantTx,
  orgId: string,
  opts: { requestId: string; now?: Date } = { requestId: "watchdog-sweep" }
): Promise<WatchdogFlag[]> {
  const now = opts.now ?? new Date();
  const flags: WatchdogFlag[] = [];

  for (const state of NON_TERMINAL_STATES) {
    const slaMs = WATCHDOG_SLA_MS[state];
    const deadline = new Date(now.getTime() - slaMs);

    const stalled = await tx
      .select()
      .from(changes)
      .where(
        and(
          eq(changes.orgId, orgId),
          eq(changes.state, state),
          lt(changes.stateEnteredAt, deadline),
          isNull(changes.watchdogFlaggedAt)
        )
      );

    for (const change of stalled) {
      const stalledForMs = now.getTime() - change.stateEnteredAt.getTime();
      const decision = await insertDecision(tx, {
        orgId,
        kind: "watchdog",
        subjectId: change.objectId,
        verdict: "warn",
        inputContext: {
          state,
          stateEnteredAt: change.stateEnteredAt.toISOString(),
          slaMs,
          stalledForMs,
          checkedAt: now.toISOString()
        },
        reasonTree: {
          summary: `change has shown no progress in state '${state}' for ${Math.round(
            stalledForMs / 1000
          )}s (SLA ${Math.round(slaMs / 1000)}s)`,
          waitingOn:
            state === "executing"
              ? "wave target executor status to report success/failure, or an operator to cancel/rollback"
              : state === "validating"
                ? "an operator to run `scp change promote` (or cancel/rollback)"
                : "the reconciliation loop's next tick to advance this change, or an operator to investigate"
        }
      });

      // MINOR #9 fix (PR #7 review): guarded on `state` + `watchdog_flagged_at IS NULL` — without
      // this, a change that progressed (clearing the flag and moving to a new state via
      // `transitionChange`) in the window between the SELECT above and this UPDATE would have its
      // flag stomped back on by a sweep that already decided (based on now-stale data) that it was
      // stalled, re-flagging a change that just made real progress.
      await tx
        .update(changes)
        .set({ watchdogFlaggedAt: now })
        .where(
          and(
            eq(changes.orgId, orgId),
            eq(changes.objectId, change.objectId),
            eq(changes.state, state),
            isNull(changes.watchdogFlaggedAt)
          )
        );

      await appendAuditEvent(tx, {
        orgId,
        actorId: WATCHDOG_SYSTEM_ACTOR_ID,
        action: "change.watchdog.flagged",
        subjectId: change.objectId,
        reason: `stalled in '${state}' for ${Math.round(stalledForMs / 1000)}s`,
        decisionId: decision.id,
        requestId: opts.requestId
      });

      // Escalation seam (DESIGN §9.4) — a real NotificationPlugin dispatch lands in M7; this is
      // the durable signal an operator/dashboard/alerting integration can act on today.
      console.warn(
        `[watchdog] change ${change.objectId} stalled in '${state}' for ${Math.round(stalledForMs / 1000)}s — decision ${decision.id}`
      );

      flags.push({
        changeObjectId: change.objectId,
        state: state as ChangeState,
        stalledForMs,
        decisionId: decision.id
      });
    }
  }

  return flags;
}

// -------------------------------------------------------------------------------------------
// pg-boss wiring (CRITICAL #1 fix, PR #7 review: "watchdog never runs in production" —
// `runWatchdogSweep` had no non-test caller; `main.ts` scheduled the reconcile loop but never
// this). Mirrors `coordination/reconcile.ts`'s `startReconcileLoop` shape exactly: a lightweight,
// self-re-scheduling pg-boss job that, on every firing, sweeps every org with the same tenant
// scoping (`withTenantTx` per org) the reconcile loop uses. A much longer interval than the
// reconcile tick's 1s is deliberate — the shortest watchdog SLA (`proposed`/`evaluated`/
// `coordinated`, 5 minutes) makes sub-minute sweep granularity pointless — but the shape (one
// queue, one singleton-keyed re-send) is identical on purpose: same failure-isolation guarantees,
// same crash-resumption story, no new machinery to reason about.
// -------------------------------------------------------------------------------------------

export const WATCHDOG_QUEUE = "coordination-watchdog-sweep";
export const WATCHDOG_SWEEP_INTERVAL_SECONDS = 60;

/** One full sweep: every org, one `runWatchdogSweep` each, same tenant scoping as the reconcile
 *  loop's `runReconcileSweep`. Errors in one org's sweep are caught and logged so they never take
 *  down the sweep (or the pg-boss job) for every other org. */
export async function runWatchdogSweepForAllOrgs(db: Db): Promise<void> {
  const orgRows = await db.select({ id: orgs.id }).from(orgs);
  for (const org of orgRows) {
    try {
      await withTenantTx(db, org.id, (tx) => runWatchdogSweep(tx, org.id, { requestId: "watchdog-sweep" }));
    } catch (err) {
      console.error(`[watchdog] org ${org.id} sweep failed:`, err);
    }
  }
}

export interface WatchdogLoopHandle {
  stop(): Promise<void>;
}

export async function startWatchdogLoop(
  boss: PgBoss,
  db: Db,
  opts: { intervalSeconds?: number } = {}
): Promise<WatchdogLoopHandle> {
  const intervalSeconds = opts.intervalSeconds ?? WATCHDOG_SWEEP_INTERVAL_SECONDS;
  let stopped = false;
  // `stop()` awaits whichever sweep is currently in flight — same reasoning as
  // `reconcile.ts`'s `startReconcileLoop`: without draining an already-running sweep, a caller
  // that closes `db`'s pool right after `stop()` resolves can race an in-flight sweep's own
  // queries against a torn-down pool, and (in tests) a straggling sweep can outlive its own test
  // server and reach into a later test's orgs.
  let inFlightSweep: Promise<void> | undefined;
  await boss.createQueue(WATCHDOG_QUEUE);
  await boss.work(WATCHDOG_QUEUE, async () => {
    if (stopped) return;
    const sweep = runWatchdogSweepForAllOrgs(db);
    inFlightSweep = sweep;
    try {
      await sweep;
    } finally {
      inFlightSweep = undefined;
    }
    if (stopped) return;
    await boss.send(
      WATCHDOG_QUEUE,
      {},
      { startAfter: intervalSeconds, singletonKey: "tick", singletonSeconds: intervalSeconds }
    );
  });
  await boss.send(WATCHDOG_QUEUE, {});
  return {
    async stop() {
      stopped = true;
      await inFlightSweep;
    }
  };
}
