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

/**
 * M25.8b — THE PRODUCER OF "THE NEXT ATTEMPT" (owner decision D8, the half that was missing).
 *
 * ============================================================================================
 * THE DEFECT THIS FILE CLOSES: A REFUSAL THAT PROMISED A RETRY NOTHING SCHEDULED
 * ============================================================================================
 * M25.8 made the auto-merge gate consult freezes (`bump-gate.ts` PHASE 3b) and refuse with
 * `frozen`. The Decision an operator reads says the pull request "stays open … and the next attempt
 * after the window closes merges it". There was no next attempt, and each link was measured rather
 * than assumed:
 *
 *   * The ONLY producer of {@link DEPENDENCY_BUMP_GATE_QUEUE} jobs was `observedBumpRouter` — one
 *     `boss.send`, driven by a PROVIDER WEBHOOK correlated to the bump's branch or to its recorded
 *     head commit. A freeze does not touch the tenant's repository, so no provider event exists.
 *   * A freeze EXPIRING emits nothing at all — expiry is a clock passing a `ends_at` column, not a
 *     write. Being LIFTED (`DELETE /v1/freezes/{id}`) or SHORTENED (`PATCH`) writes the row but
 *     emits no outbox event that any dependency consumer subscribes to.
 *   * `runBumpGateJob` RETURNS NORMALLY on a `frozen` refusal (it is a verdict, not a fault), so
 *     pg-boss records the job complete and never retries it.
 *
 * Net effect, and it is strictly worse than the bug D8 closed: before M25.8 a bump merged during a
 * freeze; after it the bump NEVER merged, silently, with the pull request stranded and the latest
 * Decision asserting the opposite. The wave side never had this shape because `reconcile.ts` re-READS
 * the freeze predicate every tick; the bump side is event-driven and had no equivalent. This file is
 * that equivalent.
 *
 * ============================================================================================
 * WHY A SWEEP AND NOT A JOB SCHEDULED AT `endsAt`
 * ============================================================================================
 * A freeze stops covering a bump three different ways, and only one of them is `endsAt`:
 *
 *   1. the window simply CLOSES;
 *   2. an operator LIFTS it early (`DELETE /v1/freezes/{id}`, `DELETE /v1/instance/freezes/{key}`);
 *   3. an operator SHORTENS it (`PATCH /v1/freezes/{id}`, `PUT /v1/instance/freezes/{key}`).
 *
 * A delayed job posted at refusal time for `endsAt` covers (1) and MISSES (2) and (3) — which are
 * the two an operator performs deliberately and then watches for. Worse, (3) can also move `endsAt`
 * LATER, so a job pinned to the old boundary would re-drive into a still-standing freeze. A sweep
 * that RE-ASKS the question covers all three with one mechanism and needs no event from the freeze
 * doors at all, which is also what keeps M25.1/M25.2/M25.3's write surfaces free of a coupling to
 * this feature.
 *
 * ============================================================================================
 * THE CANDIDATE PREDICATE IS `frozen`, SPECIFICALLY — NOT "EVERY OPEN BUMP"
 * ============================================================================================
 * The narrowing is the whole safety argument. Re-driving every open bump would re-enter gates that
 * are legitimately waiting for CI to conclude, and PHASE 2 of that gate RUNS CONTROLS — a real
 * control plugin call against a real provider, depositing `control_runs` rows — once a minute,
 * forever, for every bump anybody left open. So a candidate is an open bump whose LATEST
 * {@link DEPENDENCY_BUMP_MERGE_DECISION_KIND} Decision says `refusal: "frozen"`: the gate itself has
 * already decided that everything except the calendar was satisfied.
 *
 * That predicate is also SELF-LIMITING in the direction that matters. A re-driven gate writes a new
 * latest Decision — `merged`, or some other refusal — and the bump stops being a candidate at once.
 * Only a bump that is STILL frozen (or freshly frozen again between this read and the job) stays on
 * the list, which is exactly the set that should be re-asked.
 *
 * ============================================================================================
 * ONE FREEZE RESOLVER, IMPORTED — NEVER A SECOND WINDOW PREDICATE
 * ============================================================================================
 * "Does anything still cover this bump?" is answered by `checkBumpMergeFreeze`, the SAME function
 * `bump-gate.ts` refuses on, which is itself `freeze-scope.ts`'s `freezesByTarget`. Nothing here
 * re-derives a window comparison, a tier union or a containment walk. A hand-rolled `domain_id`-only
 * walk once made a SERVICE-scoped freeze fail OPEN (see `bump-merge-freeze.ts`'s header); the same
 * hand-rolling here would fail in the OTHER direction — a bump re-driven while a freeze it could not
 * see still stands — and the gate would then merge it, because the gate is what this sweep hands the
 * decision to. The gate re-asks too, so the sweep's answer is an admission filter and not the last
 * word; but a filter that disagrees with the gate is a filter that wakes the gate for nothing at
 * best, and this way there is only one answer in the tree.
 *
 * ============================================================================================
 * WHAT IT COSTS WHEN NOTHING IS FROZEN
 * ============================================================================================
 * One indexed read per org per minute for the OPEN bumps (`merged_at IS NULL AND
 * pull_request_number IS NOT NULL` — the set is bounded by how many dependency pull requests are
 * awaiting a merge, i.e. by human review throughput, not by history), then one single-row Decision
 * probe per open bump served by `decisions_org_subject_kind_created`. `checkBumpMergeFreeze` — the
 * only part that walks a containment chain — is reached ONLY for a bump already refused `frozen`,
 * so a deployment that has never declared a freeze pays no freeze resolution at all.
 */

/** Its OWN queue, never a second worker on {@link DEPENDENCY_BUMP_GATE_QUEUE}: `boss.work()` is a
 *  COMPETING consumer, so a worker here would steal the gate jobs this very sweep produces. */
export const BUMP_FREEZE_REDRIVE_QUEUE = "dependency-bump-freeze-redrive";

/**
 * 60 SECONDS, and the number is a judgement rather than a copy.
 *
 * The daily cadence the version poll uses is right for reaching out to package indexes and wrong
 * here: an operator who lifts a freeze at 09:00 expects the queued pull requests to land, and "some
 * time in the next 24 hours" reads as broken. A minute is the coarsest interval that still reads as
 * "it happened when I lifted it", and the tick is two indexed reads per org when nothing is frozen.
 * It is NOT the reconcile loop's ~1 s either: nothing here is a lifecycle transition a user is
 * watching a spinner for, and the act at the end is a repository write.
 */
export const BUMP_FREEZE_REDRIVE_INTERVAL_SECONDS = 60;

/** What one tick did, for a test and for the tick log. */
export interface BumpFreezeRedriveOutcome {
  /** Open bumps whose LATEST merge Decision is a `frozen` refusal — the set that was RE-ASKED. */
  candidates: string[];
  /** The subset nothing covers any more. One {@link DEPENDENCY_BUMP_GATE_QUEUE} job was sent per
   *  entry, so this is a record of enqueues that HAPPENED, not of enqueues that were intended. */
  enqueued: string[];
}

/**
 * One org, one tick. Exported so a test can drive a single tenant, and so the sweep below is
 * nothing but the per-org call in a loop.
 *
 * READS IN ONE TRANSACTION, ENQUEUES OUTSIDE IT — the split `bump-gate.ts` documents as ADR-0032
 * §7c clause 2. `boss.send` reaches a different database (`pgBossDatabaseUrl`) and cannot be part of
 * the tenant transaction, so holding the transaction open across it would only lengthen it.
 *
 * AT-LEAST-ONCE, DELIBERATELY. A crash between the send and the gate running re-drives on the next
 * tick, because nothing here records that it enqueued — the CANDIDATE PREDICATE is the state. A
 * duplicate gate job is harmless by construction: `runBumpGateJob` re-derives every fact from
 * `dependency_bump_authorships`, and a bump that merged in the meantime is stamped `merged_at` and
 * returns before dispatching anything.
 */
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

    // THE SHIPPED RESOLVER, ON THE COMPONENT THE GATE ITSELF RESOLVES AGAINST — called ONCE for
    // every frozen candidate in this org's tick rather than once per bump, so `freezesByTarget`'s
    // two guard reads (its own doc: "two indexed queries are what make a change with nothing frozen
    // cost nothing") run once instead of N times whenever a freeze withholds several bumps at once,
    // the realistic case. An empty `freezes` list is the only admitting answer, meaning precisely
    // "nothing covers this any more" — expired, lifted or shortened, indistinguishably, which is why
    // one mechanism covers all three release paths. `freezesByTarget` returns one entry per input id
    // in order, so the result zips back onto `frozenBumps` by index.
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
    // The SAME job shape `observedBumpRouter` sends, onto the SAME queue, so the re-drive and a
    // provider event are indistinguishable to the worker — there is one gate path, not two. No
    // dedup option, for the reason that router states: this queue carries pg-boss's default
    // `standard` policy, which maintains no `singleton_key` index, so the option would be recorded
    // and ignored.
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

/**
 * Self-rescheduling pg-boss loop — `startDependencyVersionPollLoop`'s `startAfter` + `singletonKey`
 * shape exactly (there is no `boss.schedule` usage anywhere in this tree to copy, ADR-0032 §7), at a
 * per-minute rather than a daily cadence.
 *
 * THE ROLE GUARD IS `bumpDispatchRoleGuard`, IMPORTED RATHER THAN RESTATED — the same object
 * `startBumpGateLoop` and `startBumpDispatchLoop` consult. It has to be the same one in both
 * directions: an outpost must never initiate a repository write (so this must not run there), and a
 * refused gate loop never CREATES {@link DEPENDENCY_BUMP_GATE_QUEUE}, so a sweep that ran anyway
 * would send to a queue that does not exist and fail every tick loudly for no purpose.
 *
 * A REFUSED ROLE RETURNS AN INERT HANDLE AND NEVER CREATES THE QUEUE — the shape every other
 * background loop uses. A process that merely skipped the work inside the handler would still be
 * waking every minute to decide to do nothing.
 */
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
