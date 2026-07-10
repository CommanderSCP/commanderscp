import { and, eq, isNull, lt } from "drizzle-orm";
import type { ChangeState } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { changes } from "../db/schema.js";
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

      await tx
        .update(changes)
        .set({ watchdogFlaggedAt: now })
        .where(eq(changes.objectId, change.objectId));

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
