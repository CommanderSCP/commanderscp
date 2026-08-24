import { and, eq, isNull, lt } from "drizzle-orm";
import type PgBoss from "pg-boss";
import type { ChangeStageDependencyTarget, ChangeState } from "@scp/schemas";
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { changes, objects, orgs } from "../db/schema.js";
import { insertDecision } from "./decisions-repo.js";
import { requiresOf } from "./changes-repo.js";
import { describeRequirements, unsatisfiedRequirements } from "./coupling.js";
import {
  describeStageDependencyStatus,
  resolveStageDependencyStatus
} from "./stage-dependency-status.js";
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
 * because it is often waiting on a HUMAN `scp change accept` call, not engine work — that's an
 * expected wait, not a stall.
 */
export const WATCHDOG_SLA_MS: Record<
  Exclude<ChangeState, "cancelled" | "rolled_back" | "accepted">,
  number
> = {
  proposed: 5 * 60_000,
  evaluated: 5 * 60_000,
  coordinated: 5 * 60_000,
  // M12 P4B: a change WAITING on a cross-change prerequisite is an expected long wait (the owner's
  // rule is "wait forever, warn at a threshold"), not a stall — so it gets the same 24h SLA as
  // `validating` (which waits on a human `accept`), NOT `executing`'s 30-min stall SLA. The watchdog
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
 * flagged since entering this state, and for each one races to CLAIM it before writing anything.
 * Returns what THIS call actually flagged — a losing claim never appears here. The notification
 * seam (DESIGN §9.4 "escalates via notifications") dispatches for real (`notify/dispatch.ts`, M7)
 * to every configured `notification_bindings` channel meeting its own severity threshold —
 * best-effort, never able to fail this sweep; the Decision record remains the durable, queryable
 * artifact regardless of delivery outcome.
 *
 * TRANSACTION SHAPE (§7.1 item 3 restructure — was one long `withTenantTx` for the ENTIRE per-org
 * sweep; mirrors `reconcile.ts`'s per-row pattern now): candidates are read cheaply, one short
 * transaction per SLA state below; each candidate then gets its OWN short transaction
 * (`claimAndFlagStall`) that claims the row and, ONLY on a winning claim, writes that change's
 * Decision + audit event in the SAME transaction, with the escalation notification dispatched
 * strictly after that transaction commits. The bug this replaces: the old sweep built the Decision
 * FIRST and ran a guarded UPDATE afterward whose affected-row count it never checked, so two
 * overlapping sweeps hitting the same row both committed their own full Decision + audit event —
 * the guard ordered statements inside an uncommitted transaction, which guards nothing.
 *
 * Idempotent per state-entry: `watchdog_flagged_at IS NULL` (cleared by `transitionChange` on
 * every legal transition, since a transition IS progress) is the guard against re-flagging the
 * same stall on every sweep tick — this sweep sets it, so the NEXT sweep skips this change until
 * either it progresses (clearing the flag) or an operator re-runs a manual check.
 */
export async function runWatchdogSweep(
  db: Db,
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

    // Cheap read, its own short transaction — nothing is claimed here, so this never holds a lock
    // any longer than the SELECT itself takes.
    const stalled = await withTenantTx(db, orgId, (tx) =>
      tx
        .select({ objectId: changes.objectId, stateEnteredAt: changes.stateEnteredAt })
        .from(changes)
        .where(
          and(
            eq(changes.orgId, orgId),
            eq(changes.state, state),
            lt(changes.stateEnteredAt, deadline),
            isNull(changes.watchdogFlaggedAt)
          )
        )
    );

    for (const candidate of stalled) {
      const flag = await claimAndFlagStall(
        db,
        orgId,
        state,
        candidate.objectId,
        candidate.stateEnteredAt,
        now,
        slaMs,
        host,
        masterKey,
        opts.requestId
      );
      if (flag) flags.push(flag);
    }
  }

  return flags;
}

/**
 * Claims exactly one stalled change and, only on a winning claim, writes its Decision + audit
 * event in the SAME short transaction as the claim, then dispatches the escalation notification
 * in a SEPARATE transaction strictly after that one commits. Returns `null` on a lost race — see
 * `runWatchdogSweep`'s doc comment; that is the ordinary multi-replica outcome, not an error.
 */
async function claimAndFlagStall(
  db: Db,
  orgId: string,
  state: (typeof NON_TERMINAL_STATES)[number],
  changeObjectId: string,
  stateEnteredAt: Date,
  now: Date,
  slaMs: number,
  host: PluginHost,
  masterKey: Buffer,
  requestId: string
): Promise<WatchdogFlag | null> {
  const won = await withTenantTx(db, orgId, async (tx) => {
    // THE CLAIM, first, before any of the per-state detail work below — this ordering (and
    // actually checking `.returning()`'s row count) is the fix: a losing claim now costs nothing
    // beyond the UPDATE itself, rather than a full Decision + audit event committed on stale
    // information. Guarded on `state` too (not just the flag), so a change that progressed out of
    // this state in the window between the candidate read and this claim also loses cleanly.
    const claim = await tx
      .update(changes)
      .set({ watchdogFlaggedAt: now })
      .where(
        and(
          eq(changes.orgId, orgId),
          eq(changes.objectId, changeObjectId),
          eq(changes.state, state),
          isNull(changes.watchdogFlaggedAt)
        )
      )
      .returning({ objectId: changes.objectId });
    if (claim.length === 0) return null;

    const stalledForMs = now.getTime() - stateEnteredAt.getTime();

    // M12 P4B (coupled-pipelines.md §3.6 — explainability): a `waiting` warn that says only
    // "stalled in waiting for 24h" is strictly worse than the state badge. Name the actual
    // unsatisfied `{key, at}` pairs (re-read LIVE at flag time via the same predicate the sweep
    // uses) — and any malformed (unsatisfiable, fail-closed) entries — so the notification alone
    // tells the operator what the change is waiting FOR.
    let waitingDetail: { waitingOn: string; unsatisfied?: unknown; malformed?: unknown } | null =
      null;
    if (state === "waiting") {
      // `org_id` alongside the id, like every other query in this file. RLS would scope this on
      // its own — the tenant tx sets `app.org_id` and the policy on `objects` enforces it — but a
      // predicate that leans on RLS ALONE is one `withSystemTx`, one maintenance script or one
      // policy regression away from reading another tenant's row, and this is a defence in depth
      // the rest of the codebase already pays for everywhere.
      const objRows = await tx
        .select({ properties: objects.properties })
        .from(objects)
        .where(and(eq(objects.orgId, orgId), eq(objects.id, changeObjectId)))
        .limit(1);
      const { requirements, malformed } = requiresOf(
        (objRows[0]?.properties ?? {}) as Record<string, unknown>
      );
      const unmet = await unsatisfiedRequirements(tx, orgId, changeObjectId, requirements);
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
    // ADR-0028 increment 4 — the `executing` arm. A stall notice that says only "wave target
    // executor status to report success/failure" is actively misleading for a change whose
    // trigger was never issued: nothing is going to report, because nothing was ever handed to an
    // executor. Name the dependency and the place instead, from the SAME live resolver `explain`
    // uses (`stage-dependency-status.ts`) — one predicate, not two — re-read at flag time exactly
    // as the `waiting` arm above re-reads its requirements. Reached only on a winning claim, so
    // this still costs nothing per tick for every OTHER sweep that loses the race on this row.
    let heldDetail: { waitingOn: string; held: unknown } | null = null;
    if (state === "executing") {
      const objRows = await tx
        .select({ properties: objects.properties })
        .from(objects)
        .where(and(eq(objects.orgId, orgId), eq(objects.id, changeObjectId)))
        .limit(1);
      const stageStatus = await resolveStageDependencyStatus(tx, orgId, {
        objectId: changeObjectId,
        properties: (objRows[0]?.properties ?? {}) as Record<string, unknown>
      });
      const described = stageStatus ? describeStageDependencyStatus(stageStatus) : null;
      if (stageStatus && described) {
        heldDetail = {
          waitingOn: described,
          held: stageStatus.targets.filter((target) => target.held).map(withoutDisplayNames)
        };
      }
    }

    const decision = await insertDecision(tx, {
      orgId,
      kind: "watchdog",
      subjectId: changeObjectId,
      verdict: "warn",
      inputContext: {
        state,
        stateEnteredAt: stateEnteredAt.toISOString(),
        slaMs,
        stalledForMs,
        checkedAt: now.toISOString(),
        ...(waitingDetail?.unsatisfied
          ? { unsatisfiedRequirements: waitingDetail.unsatisfied }
          : {}),
        ...(waitingDetail?.malformed ? { malformedRequires: waitingDetail.malformed } : {}),
        // The held targets — IDS ONLY (`withoutDisplayNames`) — so `scp decision get` answers
        // "which dependency, where" without a second call, in terms that cannot be rewritten by
        // a later rename. Absent, not an empty array, when no coupling is involved, so every
        // pre-increment-4 watchdog Decision keeps exactly the shape it had.
        ...(heldDetail ? { heldStageDependencies: heldDetail.held } : {})
      },
      reasonTree: {
        summary: `change has shown no progress in state '${state}' for ${Math.round(
          stalledForMs / 1000
        )}s (SLA ${Math.round(slaMs / 1000)}s)`,
        waitingOn:
          state === "waiting" && waitingDetail
            ? waitingDetail.waitingOn
            : state === "executing"
              ? // A HELD target was never handed to an executor, so "waiting for executor status"
                // is not merely vague there, it names a report that is never coming. When a
                // coupling is what is withholding it, say so and name it.
                (heldDetail?.waitingOn ??
                "wave target executor status to report success/failure, or an operator to cancel/rollback")
              : state === "validating"
                ? "an operator to run `scp change accept` (or cancel/rollback)"
                : "the reconciliation loop's next tick to advance this change, or an operator to investigate"
      }
    });

    await appendAuditEvent(tx, {
      orgId,
      actorId: WATCHDOG_SYSTEM_ACTOR_ID,
      action: "change.watchdog.flagged",
      subjectId: changeObjectId,
      reason: `stalled in '${state}' for ${Math.round(stalledForMs / 1000)}s`,
      decisionId: decision.id,
      requestId
    });

    // console.warn stays as the durable, always-present signal (an operator/log-aggregator sees
    // it even with zero notification channels configured) — written here, inside the winning
    // transaction, so it fires exactly once per claimed stall, same as the Decision and the audit
    // event.
    console.warn(
      `[watchdog] change ${changeObjectId} stalled in '${state}' for ${Math.round(stalledForMs / 1000)}s — decision ${decision.id}`
    );

    return { decision, heldDetail, stalledForMs };
  });

  if (!won) return null;

  // ESCALATION, STRICTLY AFTER COMMIT (§7.1 item 3): the flag, the Decision and the audit event
  // are already durable by the time this runs, in a brand-new transaction — a delivery failure
  // here must never roll any of that back. `dispatchNotification` is already best-effort PER
  // CHANNEL (notify/dispatch.ts's doc comment: a channel's own misconfiguration or downstream
  // failure is caught and logged, never allowed to propagate); the try/catch below covers the one
  // thing that isn't per-channel — `listNotificationBindings` itself throwing (e.g. a dropped
  // connection) — with the same "log it, don't propagate" contract external dispatch has
  // everywhere else in this codebase: at-least-once, never transactional with the write that
  // triggered it.
  try {
    await withTenantTx(db, orgId, (tx) =>
      dispatchNotification(tx, host, orgId, masterKey, {
        subject: `Change stalled in '${state}'`,
        body: `Change ${changeObjectId} has shown no progress in state '${state}' for ${Math.round(
          won.stalledForMs / 1000
        )}s (SLA ${Math.round(slaMs / 1000)}s). Decision ${won.decision.id}.${
          // The coupling in the notification itself, not only in the Decision: the whole point of
          // naming it is that the operator learns WHAT the change is waiting for from the message
          // that woke them, without having to know to go and look (ADR-0028 increment 4).
          won.heldDetail ? ` Held by ${won.heldDetail.waitingOn}` : ""
        }`,
        severity: "warning",
        context: { changeObjectId, state, decisionId: won.decision.id }
      })
    );
  } catch (err) {
    console.error(
      `[watchdog] org ${orgId} change ${changeObjectId} notification dispatch failed (flag/Decision/audit already committed):`,
      err
    );
  }

  return {
    changeObjectId,
    state: state as ChangeState,
    stalledForMs: won.stalledForMs,
    decisionId: won.decision.id
  };
}

/**
 * THE HELD TARGETS AS IDS ONLY, for the Decision's `inputContext`.
 *
 * `resolveStageDependencyStatus` returns display names alongside every id, because its primary
 * consumers are a CLI and a web page where an id is not an answer. A DECISION is the other kind of
 * consumer: `stage-dependency-status.ts`'s own `toWireVerdict` doc states the rule — display names
 * are the thing a persisted Decision deliberately does NOT carry, because renaming a component
 * would then rewrite the recorded inputs of a verdict that was reached about something else
 * entirely. An audit record has to keep meaning what it meant, and an id is the only part of this
 * that does.
 *
 * `summary` stays: `describeStageDependencyHold` renders ids, never names (checked, and it is the
 * same function the hold Decision's own `reasonTree` is built from), so it is already byte-stable.
 *
 * The `reasonTree.waitingOn` sentence beside this DOES name the deployment-target, and that is
 * deliberate rather than an oversight of the same rule: it is the line that goes out in the
 * notification to a human being woken at 2am, and `describeStageDependencyStatus` says so where it
 * appends the place. Structured inputs get ids; prose gets names.
 */
function withoutDisplayNames(target: ChangeStageDependencyTarget): unknown {
  return {
    targetObjectId: target.targetObjectId,
    componentObjectId: target.componentObjectId,
    deploymentTargetObjectId: target.deploymentTargetObjectId,
    held: target.held,
    dependencies: target.dependencies.map(({ dependsOnName: _dropped, ...verdict }) => verdict)
  };
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
export async function runWatchdogSweepForAllOrgs(
  db: Db,
  host: PluginHost,
  masterKey: Buffer
): Promise<void> {
  const orgRows = await db.select({ id: orgs.id }).from(orgs);
  for (const org of orgRows) {
    try {
      // `runWatchdogSweep` now manages its own per-row short transactions (§7.1 item 3) — no
      // outer `withTenantTx` wrapping the whole org's sweep any more.
      await runWatchdogSweep(db, org.id, host, masterKey, { requestId: "watchdog-sweep" });
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
  // A4 fix: the initial send now carries the SAME singleton params as the reschedule send above
  // (only `startAfter` differs — the reschedule delays, the initial send fires immediately) — see
  // reconcile.ts's `startReconcileLoop` for the identical shape. Without this, N replicas starting
  // together each queue their own unkeyed first job and all N fire the very first sweep.
  await boss.send(WATCHDOG_QUEUE, {}, { singletonKey: "tick", singletonSeconds: intervalSeconds });
  return {
    async stop() {
      stopped = true;
      await inFlightSweep;
    }
  };
}
