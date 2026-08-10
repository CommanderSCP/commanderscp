import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * THE CANDIDATE-LOOP REGISTRY — a CI guard for one specific, expensive failure class.
 *
 * THE PROPERTY: *a batch-limited candidate query, ordered by a column the loop can fail to write,
 * whose body may re-serve a row without writing it.* Such a loop starves everything queued behind
 * the rows it keeps re-serving, silently and forever.
 *
 * IT HAS BEEN HIT SIX TIMES IN THIS FILE'S SUBJECT AREA:
 *   1. `advanceWaitingChanges`   — found, fixed, and well commented ("STARVATION fix,
 *                                   coupled-pipelines.md §3.5 hazard"). Only that ONE instance.
 *   2. `advanceExecutingChanges` — the same property, untouched. In production it stopped
 *                                   coordination for 13 DAYS behind green health checks: 25
 *                                   gate-blocked changes pinned every batch slot and 231 changes
 *                                   were never evaluated once.
 *   3. `advanceValidatingChanges`— the same property, latent (7 rows against a limit of 25).
 *   4. `reconcileCampaignsOrgTick` — the same property, latent (0 campaigns), and found ONLY by
 *                                   censusing the property rather than chasing the symptom.
 *   5. `reconcileExecutingChange`'s POLL path — instance 2 again, in the SAME function, on the
 *                                   branch the fix for 2 did not reach. See below.
 *   6. THE S10 SINGLE-WRITER SKIP    — `if (object.originDomainId !== selfDomainId) continue;`, in
 *                                   all six `advance*` loops and (added the same day) in
 *                                   `reconcileCampaignsOrgTick`. The ONLY instance whose remedy is
 *                                   NOT a bump — bumping would write a read-only replica's row.
 *                                   Closed on BOTH loops by filtering the candidate query instead.
 *                                   Latent on the change side (no `changes` candidate can have a
 *                                   foreign origin) and NOT latent on the campaign side, where the
 *                                   un-filtered loop was measured driving a peer's campaign. See
 *                                   "THE ONE OPEN ITEM" and the `campaign-reconcile.ts` entry below.
 *
 * A comment naming the hazard as a class did not stop instances 2-6 from existing. That is what
 * this test is for: it cannot prove a loop is correct, but it makes ADDING one a deliberate act
 * that fails CI until somebody writes down which side of the property it falls on.
 *
 * THE ORDERING COLUMN IS `changes.reconcile_cursor_at` ON THE CHANGE SIDE (migration 0058), and
 * `objects.updated_at` on the campaign side. Read the property statement above with that in mind:
 * "a column the loop can fail to write" was, until 0058, `updated_at` — which every ordinary write
 * also moved, so the scheduler's queue position and the operator-visible "last modified" were the
 * same field, and a change re-stamped every tick by the round-robin reported itself as freshly
 * updated forever. The cursor is now its own engine-owned column and `updated_at` is nobody's queue
 * position.
 *
 * THAT SPLIT IS EXACTLY THE KIND OF EDIT THIS FILE EXISTS TO POLICE, so it was made to police it:
 * `count` and the "cursor agrees with itself" arm below were added in the same change, because the
 * guard as it stood would have passed a split that moved the `ORDER BY` and four of the five bumps.
 * A guard that cannot fail on the change being made is not a guard for that change.
 *
 * THIS REGISTRY CLASSIFIES FUNCTIONS; THE PROPERTY LIVES ON PATHS. Instance 5 is the lesson, and
 * it is worth stating because this file was already green while the bug was live. The bump for
 * instance 2 sits on ONE branch of `reconcileExecutingChange` — the wave gate blocking while the
 * wave is still `pending`. The moment a gate ALLOWS, the wave goes `running` and every later tick
 * of that change takes a DIFFERENT branch: the per-target loop, whose writes all land on
 * `change_wave_targets`. A change whose targets merely sit `observing` — an Argo CD Application
 * stuck `Progressing`, any executor whose `status()` never terminalizes — therefore froze its
 * `updated_at` and held a batch slot forever, exactly as in the outage, while `bumpIn` below
 * truthfully reported a bump present in that function. The mechanical check can only ask "is there
 * a bump in here"; a reviewer has to ask "does EVERY not-advanced path reach one".
 *
 * CENSUS RESULT, 2026-08-08 (filterless sweep of every `orderBy` + `limit` pair in apps/server/src,
 * not just the reconcile files). Recorded so the next sweep starts from a baseline instead of
 * re-deriving it:
 *   * `webhook-processor.ts` / `events/outbox-relay.ts` — batch-limited and oldest-first, but the
 *     ORDER BY column (`created_at`) is immutable and the candidate predicate is `processed_at IS
 *     NULL`, which every branch either satisfies or deliberately leaves set for a transient retry.
 *     Self-evicting. A round-robin bump would be actively WRONG there: both are ordered queues
 *     whose ordering is a guarantee, not a scheduling convenience.
 *   * `watchdog.ts` — no LIMIT at all, and it self-evicts on `watchdog_flagged_at`. Not subject.
 *     It also reads `state_entered_at`, never `updated_at`, which is precisely why every bump in
 *     the reconcile files leaves `state_entered_at` alone.
 *   * `observe.ts` — `listExecutorBindings` is unbounded, and the cursor advances per instance.
 *   * `federation/journal-repo.ts` — `ORDER BY sequence ASC LIMIT n` read from a monotonic cursor.
 *   * `campaign-reconcile.ts`'s `reconcileCampaignsOrgTick` — the S10 finding recorded here on
 *     2026-08-08 as "a deliberate decision of its own, not a drive-by" IS NOW FIXED, same PR, and
 *     the finding was CONFIRMED EXACTLY AS WRITTEN before anything was changed. Reproduction, from
 *     `foreign-origin-campaign.integration.test.ts` run against the unfixed loop: the replica
 *     compiled a plan on tick 1 (`expected null, received { waves: [ { targets: [ { status:
 *     "change_proposed", memberChangeObjectId: ... } ] } ] }`), proposed a member Change from it
 *     (`state: "proposed"`, `sourceRef.campaignObjectId` = the peer's campaign), and had its
 *     `objects.updated_at` written by the round-robin bump.
 *
 *     THE ASYMMETRY THAT MADE THIS THE WORSE HALF, re-verified in code: `import-repo.ts`'s
 *     `object_upsert` branch is type-agnostic (`const typeId = String(payload.typeId)`) and
 *     `graph/objects-repo.ts`'s `journalEntryKindFor` routes every non-`policy` object onto that
 *     entry kind, so a peer's campaign object rides an ordinary `full`-scope journal and lands
 *     locally with a foreign `origin_domain_id`. A synced CHANGE cannot: `object_upsert` never
 *     creates the local `changes` state-machine row that `listChangeRowsInStates` INNER JOINs. So
 *     the change-side hole was latent and this one was live — and its consequence was not a
 *     scheduling delay but WRITES: `campaign_plans`/`campaign_waves`/`campaign_wave_targets` rows,
 *     brand-new `changes`, and a `coordinates` edge hanging off a replica.
 *
 *     REMEDY: the same shape as the change side. `listActiveCampaignObjectIds` now takes
 *     `selfDomainId` (REQUIRED) and filters on `objects.origin_domain_id = self`, so the replica
 *     leaves the candidate set instead of being skipped in the body. The mid-loop `continue` was
 *     rejected for the usual reason AND a sharper one: this query really is `ORDER BY
 *     objects.updated_at ASC LIMIT 25` (checked, not assumed), so a body-level skip would have been
 *     a genuine SEVENTH instance of the starvation property — and the bump that closes every other
 *     instance sits at the bottom of this very loop and would itself be the S10 write. A guard
 *     REMAINS in the loop body, above the bump, as defence in depth; it is unreachable and must
 *     never become a bump. Regressions: `foreign-origin-campaign.integration.test.ts` (end to end)
 *     and `campaign-active-filter.integration.test.ts`'s S10 arm (the query predicate itself).
 *
 *     CENSUS, filterless, of every campaign/initiative-side read that feeds a write — because the
 *     named loop is one instance and the property is "an engine-driven read of a campaign whose
 *     writes are not authority-checked". Everything below is FINE, and the reason is recorded so the
 *     next sweep does not re-derive it:
 *       - `campaign-rollback.ts`'s `authoritativeCampaignMembers` -> `triggerRollback`: operator-
 *         driven, not a tick, and every member write goes through `triggerRollback`, which already
 *         refuses a foreign-origin change and reports it as a `skipped` reason.
 *       - `proposeCampaign` / `proposeInitiative` / `addCampaignToInitiative` / `iac/plans-repo.ts`'s
 *         campaign apply: actor-driven creates and updates through `createObject`/`updateObject`,
 *         which carry the replica guard themselves ("object is a read-only replica").
 *       - `getCampaignStatus`, `listCampaigns`, `getCampaign`, `computeInitiativeRollupFor`,
 *         `graph/named-queries.ts`'s `initiative-rollup`, `routes/campaigns.ts`'s `:id/explain`:
 *         pure reads. Reporting a replica's status is correct and required.
 *       - `campaign-plan-service.ts`: writes only, and only ever called from the loop above — the
 *         authority decision belongs at the candidate query, not repeated at each writer.
 *       - `memberChangeIdsForCampaign`: DELETED. It had zero callers, and its doc comment claimed
 *         "used by the reconciler to poll progress" — which was false: the reconciler polls
 *         inline via `tx.query.changes.findFirst`, and `campaign-rollback.ts` sources membership
 *         from `authoritativeCampaignMembers` (whose own comment explains why raw wave-target
 *         reads are not the security boundary). A stale comment asserting a caller that does not
 *         exist is precisely the hazard CLAUDE.md's census rule warns about — it would have let a
 *         future census tick this off as covered.
 *     `watchdog.ts` does not read campaigns, and there is no initiative-side tick.
 *   * THE ONE OPEN ITEM — NOW CLOSED (2026-08-08, same day it was opened). It was: the S10
 *     single-writer skip (`if (object.originDomainId !== selfDomainId) continue;`) at the top of
 *     five `advance*` loops leaves the row un-stamped, which IS this property — a SIXTH instance,
 *     latent because `federation/import-repo.ts`'s `object_upsert` branch never creates a local
 *     `changes` state-machine row for a synced change and a PROMOTED change is locally originated,
 *     so no row in the candidate set could have a foreign origin (measured in
 *     `change-origin-domain.integration.test.ts`'s header).
 *
 *     THE REMEDY TAKEN was the one this note called for: `listChangeRowsInStates` now takes
 *     `selfDomainId` and joins `objects.origin_domain_id = self`, filtering foreign-origin rows out
 *     of the candidate set exactly as `reconcile_blocked_at IS NULL` filters out a parked change.
 *     The alternative — a round-robin `updated_at` bump on the skip path, which is what closed
 *     instances 1-5 — was rejected and must stay rejected: it WRITES a read-only replica's row,
 *     which is the single-writer violation the skip exists to prevent. The five guards REMAIN as
 *     defence in depth; the filter makes them unreachable, it does not replace their meaning.
 *     Regression: `foreign-origin-batch-starvation.integration.test.ts`.
 *
 *     THE CENSUS FOUND A SIXTH CALL SITE the open item had not: `advanceValidatingChanges` fetches
 *     candidates too and never had an origin guard at all, so following the five `continue`s alone
 *     would have missed it. All six call sites are threaded; the argument is REQUIRED, so a seventh
 *     that forgets it cannot compile.
 *
 * WHEN THIS TEST FAILS, DO NOT JUST ADD THE NAME. Answer the question first:
 *
 *   Can this loop re-serve the same row on the next tick WITHOUT having written the column its
 *   ORDER BY reads?
 *
 *   - NO  (it always transitions, or it parks the row out of the candidate set) -> add it to
 *          `SELF_EVICTING` with a one-line reason.
 *   - YES -> it needs a round-robin bump on the not-advanced path, like the four above, plus a
 *          regression test. Then add it to `BUMPED`.
 *
 * Deliberately a SOURCE-TEXT check, not a type- or runtime-level one: the property is about
 * control flow that no type expresses, and the failure mode is a loop nobody thought about. A
 * grep-shaped guard that catches "a new loop appeared" is worth more here than a precise analysis
 * that only runs on loops we already know about.
 */

const SOURCES = ["reconcile.ts", "campaign-reconcile.ts", "watchdog.ts", "observe.ts"] as const;

/**
 * The two files holding the candidate QUERIES, read separately from `SOURCES` because they are
 * scanned for a different thing: the column each `ORDER BY` reads. Deliberately NOT added to
 * `SOURCES` — the classification sweep looks for function bodies containing `<fetcher>(`, and a
 * fetcher's own declaration line contains its own name, so `listChangeRowsInStates` would report
 * itself as an unclassified candidate loop.
 */
const QUERY_SOURCES = ["changes-repo.ts", "campaign-repo.ts"] as const;

/**
 * Batch-fetch helpers that feed a per-tick candidate loop. A call to one of these inside the
 * coordination sweep is what makes a loop subject to the property above.
 */
const CANDIDATE_FETCHERS = ["listChangeRowsInStates", "listActiveCampaignObjectIds"] as const;

/**
 * Loops that CAN re-serve without writing, and therefore carry an explicit round-robin bump.
 *
 * `bumpIn` names the functions the bumps actually live in, which are NOT always the function that
 * fetched the batch — `advanceExecutingChanges` delegates to `reconcileExecutingChange`, and the
 * gate-blocked path that needs the bump is in the callee. An earlier cut of this guard checked only
 * the fetching function's own body and reported the (present, working) executing bump as missing;
 * recording the location is what makes the check precise instead of merely loud.
 *
 * ## `count` and `queryIn` — added with migration 0058, and why "is there a bump in here" was not enough
 *
 * 0058 moved the round-robin off `changes.updated_at` onto `changes.reconcile_cursor_at`, which is
 * a five-call-site edit on a codebase whose recurring bug is fixing SOME call sites of a concept.
 * The pre-0058 check would have passed a HALF-DONE split without a murmur: it asked only whether
 * each registered function contained at least one bump, so moving four of the five — or moving the
 * `ORDER BY` and none of them — leaves every assertion satisfied while the engine reads one column
 * and writes another and starves exactly as it did for 13 days in production.
 *
 * Two things close that, and both are DERIVED FROM SOURCE rather than restated here, so a rename
 * cannot make the guard and the engine agree on a column neither one actually uses:
 *
 *  - `count` pins how many bumps each function holds. Moving 4 of 5 fails. So does silently
 *    dropping one during an unrelated refactor, which is the same failure a year later.
 *  - `queryIn` names the candidate fetcher whose `ORDER BY` column every one of this entry's bumps
 *    must WRITE. This is the actual invariant — *the column the scheduler reads is the column the
 *    not-advanced paths write* — and it is the one no amount of counting can express. Note the two
 *    entries do not agree with each other, and must not: the change side reads and writes
 *    `changes.reconcile_cursor_at`, the campaign side reads and writes `objects.updated_at`.
 */
const BUMPED: Record<
  string,
  { bumpIn: string[]; count: number; queryIn: (typeof CANDIDATE_FETCHERS)[number]; why: string }
> = {
  advanceWaitingChanges: {
    bumpIn: ["advanceWaitingChanges"],
    count: 1,
    queryIn: "listChangeRowsInStates",
    // The bump covers the still-waiting path ONLY. The S10 foreign-origin skip in the same loop is
    // a different not-advanced path with a different remedy — filtered out of the candidate query,
    // never bumped, because bumping writes a read-only replica's row.
    why: "a still-unsatisfied waiter writes nothing (coupled-pipelines.md §3.5)"
  },
  advanceExecutingChanges: {
    // THREE bumps across TWO functions, and enumerating them is the point — the second was missing
    // for the whole life of the first. See this file's header, "THIS REGISTRY CLASSIFIES FUNCTIONS;
    // THE PROPERTY LIVES ON PATHS". `recordStageDependencyHold` is reached only from
    // `reconcileExecutingChange` and holds the ADR-0028 hold bump; before 0058 this registry did not
    // name it at all, so one of the five bumps in the subject area was entirely unguarded.
    bumpIn: ["reconcileExecutingChange", "recordStageDependencyHold"],
    count: 3,
    queryIn: "listChangeRowsInStates",
    why:
      "a gate-blocked wave stays pending and writes nothing (the 13-day production outage); a " +
      "wave whose targets are merely POLLED writes only change_wave_targets, never the change row; " +
      "and a stage-dependency hold (ADR-0028) withholds its targets and writes only a Decision " +
      "(its FOURTH not-advanced path, the S10 foreign-origin skip, is filtered out of the candidate " +
      "query instead — a bump there would write a read-only replica's row)"
  },
  advanceValidatingChanges: {
    bumpIn: ["advanceValidatingChanges"],
    count: 1,
    queryIn: "listChangeRowsInStates",
    // THE SIXTH `listChangeRowsInStates` CALL SITE, and the one with no origin guard in its body at
    // all — so the bump below used to fire on a foreign-origin row, writing a replica. The query
    // filter is what stops that; the bump remains for the ordinary local case.
    why: "the loop only prewarms governance and never writes the change row"
  },
  reconcileCampaignsOrgTick: {
    bumpIn: ["reconcileCampaignsOrgTick"],
    count: 1,
    // THE CAMPAIGN SIDE DID NOT MOVE IN 0058, and `queryIn` is what records that as a checked fact
    // rather than an omission. It orders `objects.updated_at` — the shared graph-object table, not
    // `changes` — so the change-side column does not exist for it to use, and giving the universal
    // object table an engine-scheduling column would put reconcile state on every service,
    // component and policy row in the graph to serve one loop. See this file's census section.
    queryIn: "listActiveCampaignObjectIds",
    // The bump sits BELOW this loop's S10 guard, deliberately. That guard's `continue` is the
    // second not-advanced path and it must NEVER reach the bump: writing a replica's `updated_at`
    // is the single-writer violation the guard exists to prevent. It is un-starvable anyway,
    // because `listActiveCampaignObjectIds` filters foreign-origin campaigns out of the candidate
    // set — the query is where the exclusion belongs.
    why:
      "nothing in reconcileOneCampaign writes the campaign's objects row (its second not-advanced " +
      "path, the S10 foreign-origin skip, is filtered out of the candidate query instead — a bump " +
      "there would write a read-only replica's row)"
  }
};

/** Loops that CANNOT re-serve without writing — each either always transitions the row on its
 *  success path, or parks it out of the candidate set, or has the row filtered out of the candidate
 *  query in the first place. No bump needed, and adding one would be noise. Keep the reason specific
 *  enough to re-check.
 *
 *  EVERY ENTRY BELOW CARRIES THE S10 CLAUSE, because until 2026-08-08 every one of them had a
 *  second, un-registered not-advanced path: the `originDomainId !== selfDomainId` skip, which
 *  `continue`d without writing. `listChangeRowsInStates` now filters those rows out of the candidate
 *  set (its doc comment says why a bump would have been the wrong remedy), so the skip no longer
 *  leaves a row in the batch — which is what actually makes these loops self-evicting rather than
 *  merely un-triggerable. Do not drop the clause when re-checking a reason: it is a separate path
 *  from the one the first half of each line describes. */
const SELF_EVICTING: Record<string, string> = {
  advanceProposedChanges:
    "always transitions proposed->evaluated (that edge is never gated); the S10 foreign-origin skip " +
    "cannot re-serve because listChangeRowsInStates filters those rows out on origin_domain_id",
  advanceEvaluatedChanges:
    "always compiles a plan and transitions on its success path; S10 foreign-origin rows are " +
    "filtered out of the candidate query, not skipped in the body",
  advanceCoordinatedChanges:
    "a blocked gate PARKS the change (reconcile_blocked_at non-null), which listChangeRowsInStates " +
    "filters out; the same query also filters out S10 foreign-origin rows"
};

function readSource(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

/** Every `async function <name>(` in the given sources — the universe of candidate loop bodies. */
function functionNames(source: string): string[] {
  return [...source.matchAll(/async function (\w+)\s*\(/g)].map((m) => m[1]!);
}

/**
 * The text of one `async function`, from its declaration to the start of the next one.
 *
 * The boundary pattern MUST accept the `export ` prefix. Without it, an unexported function
 * declared above an exported one swallowed the exported one's entire body — which made
 * `reconcileOneCampaign` look like it fetched a candidate batch (it does not; its caller does) and
 * produced a false positive that read exactly like a real finding. A guard that cries wolf gets
 * silenced, so this is worth the precision.
 */
function bodyOf(source: string, fnName: string): string | null {
  const start = source.search(new RegExp(`(?:export )?async function ${fnName}\\(`));
  if (start === -1) return null;
  const rest = source.slice(start + 1);
  const nextIdx = rest.search(/\n(?:export )?async function \w+\s*\(/);
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

/**
 * The columns a function's round-robin bumps WRITE — every `.set({ <col>: new Date() })` in it.
 *
 * Deliberately shaped to match a bump and nothing else. A bump is a lone timestamp assignment; a
 * real content write carries other fields beside it (`markChangeReconcileBlocked`'s
 * `{ reconcileBlockedAt, updatedAt }`, `transitionChange`'s multi-field set), and the trailing `}`
 * is what keeps those out of the count. If a future bump gains a second field it will stop matching
 * and this guard will fail — which is correct: a bump that also writes something else is no longer
 * only a queue position, and somebody should have to say so here.
 */
function bumpColumnsIn(body: string): string[] {
  return [...body.matchAll(/\.set\(\{\s*(\w+): new Date\(\)\s*\}\)/g)].map((m) => m[1]!);
}

/** The column a candidate fetcher's `ORDER BY` actually reads, parsed from its own body. Scoped to
 *  the function so an unrelated ordered query elsewhere in the same repo file cannot answer for it. */
function orderByColumnOf(fetcher: string): string | null {
  for (const name of QUERY_SOURCES) {
    let text: string;
    try {
      text = readSource(name);
    } catch {
      continue;
    }
    const body = bodyOf(text, fetcher);
    if (!body) continue;
    const m = body.match(/\.orderBy\(asc\(\w+\.(\w+)\)\)/);
    if (m) return m[1]!;
  }
  return null;
}

describe("candidate-loop registry: every batch-limited reconcile loop is classified", () => {
  const sources = new Map<string, string>();
  for (const name of SOURCES) {
    try {
      sources.set(name, readSource(name));
    } catch {
      // A source listed here that no longer exists is itself worth failing on — asserted below
      // rather than silently skipped, so a rename can't quietly shrink this guard's coverage.
      sources.set(name, "");
    }
  }

  it("every source this guard claims to cover actually exists", () => {
    for (const [name, text] of sources) {
      expect(text, `${name} is listed in SOURCES but could not be read — did it move?`).not.toBe(
        ""
      );
    }
  });

  it("every function that fetches a candidate batch is classified as BUMPED or SELF_EVICTING", () => {
    const classified = new Set([...Object.keys(BUMPED), ...Object.keys(SELF_EVICTING)]);
    const unclassified: string[] = [];

    for (const [file, text] of sources) {
      if (!text) continue;
      const names = functionNames(text);
      for (const fnName of names) {
        const body = bodyOf(text, fnName) ?? "";
        const fetchesCandidates = CANDIDATE_FETCHERS.some((f) => body.includes(`${f}(`));
        if (!fetchesCandidates) continue;
        if (!classified.has(fnName)) unclassified.push(`${file}:${fnName}`);
      }
    }

    expect(
      unclassified,
      "A new batch-limited candidate loop appeared and is not classified. Read this file's header " +
        "BEFORE adding it: decide whether it can re-serve a row without writing the column its " +
        "ORDER BY reads. If it can, it needs a round-robin bump and a regression test (see " +
        "executing-batch-starvation.integration.test.ts), then add it to BUMPED. If it cannot, add " +
        "it to SELF_EVICTING with the reason."
    ).toEqual([]);
  });

  it("every loop registered as BUMPED still contains EXACTLY the bumps it claims", () => {
    // Guards the other direction: a refactor that deletes a bump must not leave the registry
    // asserting a protection that is no longer there. Looks for the write, not for a comment.
    //
    // COUNTED, not merely detected (0058). "At least one bump somewhere in this function" is
    // satisfied by a half-finished migration of the cursor column, which is precisely the shape of
    // this repo's recurring bug. See the `count` note on BUMPED.
    const wrong: string[] = [];
    for (const [fnName, { bumpIn, count }] of Object.entries(BUMPED)) {
      let found = 0;
      for (const fn of bumpIn) {
        for (const text of sources.values()) {
          if (!text) continue;
          const body = bodyOf(text, fn);
          if (body) found += bumpColumnsIn(body).length;
        }
      }
      if (found !== count) {
        wrong.push(`${fnName}: expected ${count} bump(s) in ${bumpIn.join(" + ")}, found ${found}`);
      }
    }
    expect(
      wrong,
      "A loop registered as BUMPED no longer holds the round-robin bumps it claims. Either a bump " +
        "was removed (restore it — see this file's header for what it costs), or one was added " +
        "without updating `count`, or the loop was restructured so it can no longer re-serve " +
        "without writing (then move it to SELF_EVICTING)."
    ).toEqual([]);
  });

  it("THE CURSOR AGREES WITH ITSELF: every bump writes the column its own candidate query orders by", () => {
    // THE INVARIANT NO COUNT CAN EXPRESS, and the one migration 0058 could have broken silently.
    // The round-robin only works if the column the scheduler READS to pick candidates is the column
    // the not-advanced paths WRITE to give up their turn. Point the `ORDER BY` at a new column and
    // leave one bump behind on the old one and every other assertion in this file still passes,
    // while that bump's loop re-serves the same row forever — the 13-day outage, restored.
    //
    // BOTH SIDES ARE READ FROM SOURCE. Nothing here hardcodes "reconcileCursorAt": the expected
    // column is whatever the query actually orders by today, so renaming the column in one place
    // and not the other fails, and renaming it in both passes without touching this file.
    const mismatches: string[] = [];
    for (const [fnName, { bumpIn, queryIn }] of Object.entries(BUMPED)) {
      const ordered = orderByColumnOf(queryIn);
      expect(
        ordered,
        `Could not find the ORDER BY column of ${queryIn} — the guard cannot check what it cannot read.`
      ).not.toBeNull();
      for (const fn of bumpIn) {
        for (const text of sources.values()) {
          if (!text) continue;
          const body = bodyOf(text, fn);
          if (!body) continue;
          for (const col of bumpColumnsIn(body)) {
            if (col !== ordered) {
              mismatches.push(
                `${fnName}/${fn} bumps \`${col}\` but ${queryIn} orders by \`${ordered}\``
              );
            }
          }
        }
      }
    }
    expect(
      mismatches,
      "A round-robin bump writes a different column from the one its candidate query orders by. " +
        "The bump therefore does nothing for scheduling: the loop re-serves the same rows forever " +
        "and starves everything behind them. Move the bump onto the ORDER BY column."
    ).toEqual([]);
  });

  it("the registry has no stale entries", () => {
    const allNames = new Set<string>();
    for (const text of sources.values()) {
      if (!text) continue;
      for (const n of functionNames(text)) allNames.add(n);
    }
    const stale = [
      ...Object.keys(BUMPED),
      ...Object.values(BUMPED).flatMap((b) => b.bumpIn),
      ...Object.keys(SELF_EVICTING)
    ].filter((n) => !allNames.has(n));
    expect(
      stale,
      "The registry names functions that no longer exist — a rename that silently dropped this " +
        "guard's coverage. Update the entry to the new name."
    ).toEqual([]);
  });
});
