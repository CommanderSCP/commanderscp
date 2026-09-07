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

/** Stuck-change watchdog (DESIGN.md §9.4). See docs/coordination.md §1023. */
export const WATCHDOG_SLA_MS: Record<
  Exclude<ChangeState, "cancelled" | "rolled_back" | "accepted">,
  number
> = {
  proposed: 5 * 60_000,
  evaluated: 5 * 60_000,
  coordinated: 5 * 60_000,
  // A change waiting on a prerequisite is an expected long wait. See docs/coordination.md §1024.
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

/** One sweep pass over one org. See docs/coordination.md §1025. */
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
      // Per-candidate isolation, as every sibling loop does. See docs/coordination.md §1026.
      try {
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
      } catch (err) {
        console.error(
          `[watchdog] failed to claim/flag stalled change ${candidate.objectId} (state=${state}, ` +
            `org=${orgId}) — skipping this candidate, it re-qualifies next tick`,
          err
        );
      }
    }
  }

  return flags;
}

/** Claims one stalled change, writing only on a win. See docs/coordination.md §1027. */
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
    // The claim first, before any per-state detail work. See docs/coordination.md §1028.
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

    // M12 P4B (coupled-pipelines.md §3.6 — explainability). See docs/coordination.md §1029.
    let waitingDetail: { waitingOn: string; unsatisfied?: unknown; malformed?: unknown } | null =
      null;
    if (state === "waiting") {
      // The org id alongside, like every query in this file. See docs/coordination.md §1030.
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
    // ADR-0028 increment 4 — the `executing` arm. See docs/coordination.md §1031.
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

  // ESCALATION, STRICTLY AFTER COMMIT. See docs/coordination.md §1032.
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

/** The held targets as ids only, for the input context. See docs/coordination.md §1033. */
function withoutDisplayNames(target: ChangeStageDependencyTarget): unknown {
  return {
    targetObjectId: target.targetObjectId,
    componentObjectId: target.componentObjectId,
    deploymentTargetObjectId: target.deploymentTargetObjectId,
    held: target.held,
    dependencies: target.dependencies.map(({ dependsOnName: _dropped, ...verdict }) => verdict)
  };
}

// The pg-boss wiring, without which this never ran. See docs/coordination.md §1034.

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
  // `stop()` awaits whichever sweep is currently in flight. See docs/coordination.md §1035.
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
  // Startup kick: UNKEYED, so it always inserts. See docs/coordination.md §1036.
  await boss.send(WATCHDOG_QUEUE, {});
  return {
    async stop() {
      stopped = true;
      await inFlightSweep;
    }
  };
}
