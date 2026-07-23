import { and, eq, isNull, lt } from "drizzle-orm";
import type PgBoss from "pg-boss";
import type { ChangeState } from "@scp/schemas";
import type { Db } from "../db/client.js";
import { withTenantTx, type TenantTx } from "../db/tenant-tx.js";
import { changes, objects, orgs } from "../db/schema.js";
import { insertDecision } from "./decisions-repo.js";
import { requiresOf } from "./changes-repo.js";
import { describeRequirements, unsatisfiedRequirements } from "./coupling.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { SYSTEM_ACTOR_ID } from "./system-actor.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { dispatchNotification } from "../notify/dispatch.js";

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
  // M12 P4B: a change WAITING on a cross-change prerequisite is an expected long wait (the owner's
  // rule is "wait forever, warn at a threshold"), not a stall — so it gets the same 24h SLA as
  // `validating` (which waits on a human `promote`), NOT `executing`'s 30-min stall SLA. The watchdog
  // only WARNS (it never transitions), and notification bindings are off by default, so past 24h this
  // costs a Decision row + a log line, never an auto-cancel of a still-legitimately-waiting change.
  waiting: 24 * 60 * 60_000,
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
 * returns what it flagged. The notification seam (DESIGN §9.4 "escalates via notifications") now
 * dispatches for real (`notify/dispatch.ts`, M7) to every configured `notification_bindings`
 * channel meeting its own severity threshold — best-effort, never able to fail this sweep; the
 * Decision record remains the durable, queryable artifact regardless of delivery outcome.
 *
 * Idempotent per state-entry: `watchdog_flagged_at IS NULL` (cleared by `transitionChange` on
 * every legal transition, since a transition IS progress) is the guard against re-flagging the
 * same stall on every sweep tick — this sweep sets it, so the NEXT sweep skips this change until
 * either it progresses (clearing the flag) or an operator re-runs a manual check.
 */
export async function runWatchdogSweep(
  tx: TenantTx,
  orgId: string,
  host: PluginHost,
  masterKey: Buffer,
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
      // M12 P4B (coupled-pipelines.md §3.6 — explainability): a `waiting` warn that says only
      // "stalled in waiting for 24h" is strictly worse than the state badge. Name the actual
      // unsatisfied `{key, at}` pairs (re-read LIVE at flag time via the same predicate the sweep
      // uses) — and any malformed (unsatisfiable, fail-closed) entries — so the notification alone
      // tells the operator what the change is waiting FOR.
      let waitingDetail: { waitingOn: string; unsatisfied?: unknown; malformed?: unknown } | null =
        null;
      if (state === "waiting") {
        const objRows = await tx
          .select({ properties: objects.properties })
          .from(objects)
          .where(eq(objects.id, change.objectId))
          .limit(1);
        const { requirements, malformed } = requiresOf(
          (objRows[0]?.properties ?? {}) as Record<string, unknown>
        );
        const unmet = await unsatisfiedRequirements(tx, orgId, change.objectId, requirements);
        const parts: string[] = [];
        if (unmet.length > 0) {
          parts.push(`unsatisfied cross-change prerequisite(s): ${describeRequirements(unmet)}`);
        }
        if (malformed.length > 0) {
          parts.push(
            `${malformed.length} malformed (unsatisfiable) \`requires\` entr${malformed.length === 1 ? "y" : "ies"} — fail-closed, will never release; see \`scp change explain\``
          );
        }
        waitingDetail = {
          waitingOn:
            parts.length > 0
              ? parts.join("; ")
              : "cross-change prerequisites (all currently satisfied — release expected next tick)",
          ...(unmet.length > 0 ? { unsatisfied: unmet } : {}),
          ...(malformed.length > 0 ? { malformed } : {})
        };
      }
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
          checkedAt: now.toISOString(),
          ...(waitingDetail?.unsatisfied ? { unsatisfiedRequirements: waitingDetail.unsatisfied } : {}),
          ...(waitingDetail?.malformed ? { malformedRequires: waitingDetail.malformed } : {})
        },
        reasonTree: {
          summary: `change has shown no progress in state '${state}' for ${Math.round(
            stalledForMs / 1000
          )}s (SLA ${Math.round(slaMs / 1000)}s)`,
          waitingOn:
            state === "waiting" && waitingDetail
              ? waitingDetail.waitingOn
              : state === "executing"
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

      // Escalation seam (DESIGN §9.4) — real NotificationPlugin dispatch (M7). console.warn stays
      // as the durable, always-present signal (an operator/log-aggregator sees it even with zero
      // channels configured); dispatchNotification is the best-effort, never-throwing fan-out on
      // top of it.
      console.warn(
        `[watchdog] change ${change.objectId} stalled in '${state}' for ${Math.round(stalledForMs / 1000)}s — decision ${decision.id}`
      );
      await dispatchNotification(tx, host, orgId, masterKey, {
        subject: `Change stalled in '${state}'`,
        body: `Change ${change.objectId} has shown no progress in state '${state}' for ${Math.round(
          stalledForMs / 1000
        )}s (SLA ${Math.round(WATCHDOG_SLA_MS[state] / 1000)}s). Decision ${decision.id}.`,
        severity: "warning",
        context: { changeObjectId: change.objectId, state, decisionId: decision.id }
      });

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
export async function runWatchdogSweepForAllOrgs(db: Db, host: PluginHost, masterKey: Buffer): Promise<void> {
  const orgRows = await db.select({ id: orgs.id }).from(orgs);
  for (const org of orgRows) {
    try {
      await withTenantTx(db, org.id, (tx) =>
        runWatchdogSweep(tx, org.id, host, masterKey, { requestId: "watchdog-sweep" })
      );
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
  host: PluginHost,
  masterKey: Buffer,
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
    const sweep = runWatchdogSweepForAllOrgs(db, host, masterKey);
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
