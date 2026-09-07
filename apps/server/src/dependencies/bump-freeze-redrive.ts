import type PgBoss from "pg-boss";
import type { Db } from "../db/client.js";
import type { ServerConfig } from "../config.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { orgs } from "../db/schema.js";
import { latestDecisionForSubjectKind } from "../coordination/decisions-repo.js";
import { bumpDispatchRoleGuard } from "./bump-dispatch.js";
import { listOpenBumpAuthorshipsAwaitingMerge } from "./bump-authorship-repo.js";
import { freezesByTarget } from "../governance/freeze-scope.js";
import {
  DEPENDENCY_BUMP_GATE_QUEUE,
  DEPENDENCY_BUMP_MERGE_DECISION_KIND,
  type BumpGateJob
} from "./bump-gate.js";

/** M25.8b — THE PRODUCER OF "THE NEXT ATTEMPT". See docs/dependencies.md §96. */

/** Its OWN queue, never a second worker on {@link DEPENDENCY_BUMP_GATE_QUEUE}: `boss.work()` is a
 *  COMPETING consumer, so a worker here would steal the gate jobs this very sweep produces. */
export const BUMP_FREEZE_REDRIVE_QUEUE = "dependency-bump-freeze-redrive";

/** Sixty seconds, and the number is a judgement. See docs/dependencies.md §97. */
export const BUMP_FREEZE_REDRIVE_INTERVAL_SECONDS = 60;

/** What one tick did, for a test and for the tick log. */
export interface BumpFreezeRedriveOutcome {
  /** Open bumps whose LATEST merge Decision is a `frozen` refusal — the set that was RE-ASKED. */
  candidates: string[];
  /** The subset nothing covers any more. One {@link DEPENDENCY_BUMP_GATE_QUEUE} job was sent per
   *  entry, so this is a record of enqueues that HAPPENED, not of enqueues that were intended. */
  enqueued: string[];
}

/** One org, one tick. See docs/dependencies.md §98. */
export async function redriveOrgBumpFreezes(
  boss: PgBoss,
  db: Db,
  orgId: string
): Promise<BumpFreezeRedriveOutcome> {
  const { candidates, ready } = await withTenantTx(db, orgId, async (tx) => {
    const candidates: string[] = [];
    // Frozen candidates, kept paired with their component so the batched freeze check below can
    // report back per bump.
    const frozenBumps: { changeObjectId: string; componentObjectId: string }[] = [];
    for (const bump of await listOpenBumpAuthorshipsAwaitingMerge(tx, orgId)) {
      // THE LATEST verdict, not "any `frozen` verdict in this bump's history". A bump refused
      // `frozen` in March and refused `merge_refused` yesterday is not waiting on a calendar, and
      // re-driving it would re-run its controls once a minute for ever.
      const latest = await latestDecisionForSubjectKind(
        tx,
        orgId,
        bump.changeObjectId,
        DEPENDENCY_BUMP_MERGE_DECISION_KIND
      );
      if (latest?.inputContext.refusal !== "frozen") continue;
      candidates.push(bump.changeObjectId);
      frozenBumps.push({
        changeObjectId: bump.changeObjectId,
        componentObjectId: bump.componentObjectId
      });
    }

    // The shipped resolver, on the component the gate uses. See docs/dependencies.md §99.
    const ready: string[] = [];
    if (frozenBumps.length > 0) {
      const covering = await freezesByTarget(
        tx,
        orgId,
        frozenBumps.map((b) => b.componentObjectId),
        new Date()
      );
      for (const [index, entry] of covering.entries()) {
        if (entry.freezes.length === 0) ready.push(frozenBumps[index]!.changeObjectId);
      }
    }
    return { candidates, ready };
  });

  const enqueued: string[] = [];
  for (const changeObjectId of ready) {
    const job: BumpGateJob = { orgId, changeObjectId };
    // The same job shape, onto the same queue. See docs/dependencies.md §100.
    await boss.send(DEPENDENCY_BUMP_GATE_QUEUE, job);
    enqueued.push(changeObjectId);
  }
  return { candidates, enqueued };
}

/** Every org, one tick — mirrors `runDependencyVersionPollSweep`, including the per-org catch that
 *  keeps one tenant's bad row from stopping every other tenant's merges. */
export async function runBumpFreezeRedriveSweep(
  boss: PgBoss,
  db: Db
): Promise<BumpFreezeRedriveOutcome> {
  const total: BumpFreezeRedriveOutcome = { candidates: [], enqueued: [] };
  const orgRows = await db.select({ id: orgs.id }).from(orgs);
  for (const org of orgRows) {
    try {
      const one = await redriveOrgBumpFreezes(boss, db, org.id);
      total.candidates.push(...one.candidates);
      total.enqueued.push(...one.enqueued);
    } catch (err) {
      console.error(`[dependency-bump-freeze-redrive] org ${org.id} tick failed:`, err);
    }
  }
  return total;
}

export interface BumpFreezeRedriveLoopHandle {
  stop(): Promise<void>;
}

/** Self-rescheduling pg-boss loop. See docs/dependencies.md §101. */
export async function startBumpFreezeRedriveLoop(
  boss: PgBoss,
  db: Db,
  config: Pick<ServerConfig, "role" | "federationRole" | "federationRoleDeclared">
): Promise<BumpFreezeRedriveLoopHandle> {
  const guard = bumpDispatchRoleGuard(config);
  if (!guard.allowed) {
    console.info(`[dependency-bump-freeze-redrive] not started: ${guard.reason}`);
    return { async stop() {} };
  }
  console.info(
    `[dependency-bump-freeze-redrive] STARTING: ${guard.reason}. Every ` +
      `${BUMP_FREEZE_REDRIVE_INTERVAL_SECONDS}s this process re-asks whether the change freeze that ` +
      `withheld an auto-merge still covers it, and re-drives the gate for those it no longer does`
  );

  let stopped = false;
  let inFlightTick: Promise<unknown> | undefined;
  await boss.createQueue(BUMP_FREEZE_REDRIVE_QUEUE);
  await boss.work(BUMP_FREEZE_REDRIVE_QUEUE, async () => {
    if (stopped) return;
    const tick = runBumpFreezeRedriveSweep(boss, db);
    inFlightTick = tick;
    try {
      const outcome = await tick;
      if (outcome.enqueued.length > 0) {
        console.info(
          `[dependency-bump-freeze-redrive] re-driving ${outcome.enqueued.length} of ` +
            `${outcome.candidates.length} freeze-withheld bump(s) — nothing covers them any more`
        );
      }
    } finally {
      inFlightTick = undefined;
    }
    if (stopped) return;
    await boss.send(
      BUMP_FREEZE_REDRIVE_QUEUE,
      {},
      {
        startAfter: BUMP_FREEZE_REDRIVE_INTERVAL_SECONDS,
        singletonKey: "tick",
        singletonSeconds: BUMP_FREEZE_REDRIVE_INTERVAL_SECONDS
      }
    );
  });
  await boss.send(BUMP_FREEZE_REDRIVE_QUEUE, {});
  return {
    async stop() {
      stopped = true;
      await inFlightTick;
    }
  };
}
