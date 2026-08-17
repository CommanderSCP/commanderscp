import type PgBoss from "pg-boss";
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { orgs } from "../db/schema.js";
import type { ServerConfig } from "../config.js";
import type { PluginHost } from "../plugin-host/contract.js";
import { SYSTEM_ACTOR_ID } from "../coordination/system-actor.js";
import { insertDecisionIfChanged } from "../coordination/decisions-repo.js";
import {
  listThirdPartyDependencyLinesByIds,
  recordDependencyLineHead
} from "./dependency-inventory-repo.js";
import type { HeadRefusalReason, ThirdPartyLine } from "./line-head.js";
import { listSubscribedComponentLines } from "./subscription-resolution.js";
import { queryLineHead, type LineHeadOutcome } from "./version-index.js";
import { readDependencyIndexFeed, type FeedRead } from "./version-index-feed.js";

/**
 * M21.4 — THE DAILY THIRD-PARTY VERSION POLL (ADR-0032 §7).
 *
 * A self-rescheduling pg-boss tick that asks, for every (component, dependency line) pair a
 * dependency subscription actually enables, "what is the head of this line now?" — and records
 * either an observation or a legible reason there is none.
 *
 * SIX PROPERTIES CARRY THIS FILE. Each one is a specific failure that was possible before it:
 *
 * 0. IT POLLS THIRD-PARTY LINES ONLY, AND THE SPLIT IS STRUCTURAL (ADR-0032 §7). An INTERNAL line —
 *    one the org DECLARES it produces (`produced_by_object_id`) — has its head DERIVED from its own
 *    accepted production releases (`internal-release-detection.ts`), and asking a public index about
 *    it is dependency confusion with a scheduler attached: a stranger's package sharing the
 *    coordinate answers `9.9.9`, that overwrites the head the org's own release put there, and every
 *    subscriber is bumped onto it. This file therefore holds NO `produced_by` predicate of its own,
 *    because a predicate here is a predicate to forget. `listThirdPartyDependencyLinesByIds` narrows
 *    in SQL and returns a branded {@link ThirdPartyLine}, which is the ONLY type `queryLineHead`
 *    accepts — so an internal line is neither loaded nor passable.
 *
 * 1. THE WORK-LIST IS M21.3'S RESOLUTION, NOT A FILTER HERE. `listSubscribedComponentLines` returns
 *    exactly the pairs whose monotone AND resolved TRUE, so a disabled component is never fetched
 *    and an opted-out line is never polled BY CONSTRUCTION (ADR-0032 §6). This file writes no second
 *    predicate over enablement — not a `WHERE`, not an `if`. A second filter is a place for the
 *    work-list and a UI verdict to disagree, and the resolver's own module doc says the AND appears
 *    exactly once on purpose.
 *
 * 2. IT IS EXPLICITLY ROLE-GUARDED, AND THE GUARD IS THE POINT. There is no trustworthy runtime
 *    commander/outpost predicate (`self_domain.role` is per-ORG, set lazily post-install, and
 *    advisory — config.ts:36-56 says so at length), so an UNGUARDED background job runs on
 *    AIR-GAPPED OUTPOSTS TOO, where it would spend every day dialling registries that are
 *    unreachable by design and writing an `unavailable` Decision per dependency for it. The guard is
 *    install-time `config.federationRole` (commander only) AND the `SCP_ROLE` process split
 *    (`all`/`worker` — an api-only process owns no background work). See
 *    {@link dependencyVersionPollRoleGuard}.
 *
 * 3. EVERY VERDICT GOES THROUGH `insertDecisionIfChanged`. A daily poll that re-wrote a byte-
 *    identical "no new version" Decision per dependency reproduces the MEASURED 1.44 GB/day
 *    amplification exactly (ADR-0024; `decisions-repo.ts` carries the measurement). Nothing in the
 *    Decision this file builds is time-varying — no timestamps, no durations, no counters that move
 *    on their own — which is what makes suppression actually fire rather than merely be called.
 *
 * 4. NOTHING HERE CAN DELETE INVENTORY. The poll writes ONLY the `latest_*` observation trio via
 *    `recordDependencyLineHead`. `pruneComponentDependencies` is not imported, and the manifest
 *    parsers are not called at all — so the "an unreadable fetch treated as an empty parse DELETES
 *    the component's declarations" failure (`@scp/dependency-manifests`'s caller contract) is absent
 *    from this path rather than guarded on it. Every per-line failure is caught per line, so one bad
 *    index can neither reject the job nor stop the other lines in the estate being polled.
 *
 * 5. THE INDEX SUBPROCESSES IT STARTS ARE STOPPED WHEN THE SWEEP ENDS. This is the only caller in
 *    the tree whose plugin instances come from a WORK-LIST rather than from operator configuration,
 *    so it is the only one for which "start on demand and never stop" accumulates with tenancy.
 *    See `pollOrgDependencyVersions`.
 */

export const DEPENDENCY_VERSION_POLL_QUEUE = "dependency-version-poll-tick";

/** The `decisions.kind` every verdict below is filed under — also the key
 *  `insertDecisionIfChanged` compares the previous verdict on, so it must be a constant. */
export const DEPENDENCY_VERSION_POLL_DECISION_KIND = "dependency_version_poll";

/** Daily by default (ADR-0032 §7: "a daily self-rescheduling tick"). Floor of 5 minutes so a
 *  misconfigured value cannot turn a registry poll into a hot loop. Read from the LIVE env per tick,
 *  never frozen at import — the rule M14.4 established for every re-scheduling loop. */
export function dependencyVersionPollIntervalSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(300, Number(env.SCP_DEPENDENCY_VERSION_POLL_INTERVAL_SECONDS ?? 86_400));
}

// -------------------------------------------------------------------------------------------
// The role guard
// -------------------------------------------------------------------------------------------

export interface DependencyVersionPollRoleVerdict {
  allowed: boolean;
  /** Why — carried so the boot log says which of the two axes refused, rather than staying silent
   *  about a loop that never ticks. */
  reason: string;
}

/**
 * MAY THIS PROCESS RUN THE POLL?
 *
 * Two independent axes, both required, and they are different questions:
 *
 *  - `config.federationRole` is the OPERATOR'S INSTALL-TIME declaration of what this deployment IS
 *    (`SCP_FEDERATION_ROLE`, Helm's `federationRole`). Only a `commander` polls. An `outpost` is
 *    frequently air-gapped or high-side and must never initiate outbound registry traffic on a timer
 *    — that is the exact hazard ADR-0032 §7 names when it calls the guard explicit. A `retrans` node
 *    sits ON a CDS boundary and runs less than an outpost, not more.
 *  - `config.role` is the PROCESS SPLIT (`SCP_ROLE`). Background work belongs to `all`/`worker`;
 *    an `api` process must stay a request server, exactly as the reconcile/observe/watchdog loops
 *    already require (`main.ts`'s `runsBackgroundWork`).
 *
 * Deliberately NOT derived from `self_domain.role`: that value is per-org, set lazily through the
 * federation API, and advisory (config.ts's own doc comment, and M15.4's helm-verify note). A
 * background job that decided whether to reach the internet from tenant-writable data would be
 * exactly the runtime/install-time fork M15.4 declined to create.
 *
 * THE BRANCH ORDER IS PART OF THE CONTRACT, NOT A DETAIL OF THIS COPY (M21.7 follow-up, LOW 5).
 * This body is hand-written rather than delegating to {@link commanderOnlyJobVerdict} because its
 * refusal TEXT carries a fact a shared string cannot ("dials package registries from an air-gapped
 * site") — but the VERDICT and the ORDER the axes are tested in are shared. It used to test
 * federation first, so a deployment misconfigured on more than one axis was sent to a DIFFERENT
 * setting depending on which job complained: the poll said "federationRole is 'outpost'", the
 * dispatcher said "SCP_ROLE is 'api'", for one and the same deployment. Process axis FIRST, then
 * the undeclared case, then the declared non-commander — the order `commanderOnlyJobVerdict`
 * documents and `commander-only.test.ts` pins across every copy by comparing each multi-axis
 * refusal against the single-axis refusal it must be identical to.
 */
export function dependencyVersionPollRoleGuard(
  config: Pick<ServerConfig, "role" | "federationRole" | "federationRoleDeclared">
): DependencyVersionPollRoleVerdict {
  if (config.role !== "all" && config.role !== "worker") {
    return {
      allowed: false,
      reason: `SCP_ROLE is '${config.role}' — background work belongs to an 'all' or 'worker' process`
    };
  }
  if (!config.federationRoleDeclared) {
    // THE GUARD USED TO BE FAIL-OPEN HERE, and silently. `config.federationRole` DEFAULTS to
    // `commander` when `SCP_FEDERATION_ROLE` is unset (config.ts), which is the right default for
    // "may I serve the SPA?" — it preserves every pre-M16.3 deployment — and the wrong one for "may
    // I dial the public internet every day?". An outpost installed before M16.3, or from a chart
    // that omits the value, presents as a declared commander and would poll: precisely the
    // air-gapped, high-side deployment ADR-0032 §7 makes this guard explicit to protect.
    //
    // So the SAFE DEFAULT for reaching the internet is DO NOT, and the remedy is one env var that
    // an operator can set truthfully either way. This costs a deployment that really is a commander
    // one explicit declaration; it saves an undeclared outpost from a daily outbound sweep nobody
    // asked for. Nothing else about the `commander` default moves.
    return {
      allowed: false,
      reason:
        "SCP_FEDERATION_ROLE is not set — this deployment has NOT DECLARED that it is a commander, " +
        "it merely defaults to one. The third-party version poll reaches package registries on the " +
        "public internet on a timer, so it will not start on an undeclared deployment: an outpost " +
        "predating this setting looks identical to a commander here. Set SCP_FEDERATION_ROLE " +
        "explicitly (Helm: `federationRole`) to turn it on"
    };
  }
  if (config.federationRole !== "commander") {
    return {
      allowed: false,
      reason:
        `federationRole is '${config.federationRole}' — the third-party version poll runs on a ` +
        `commander only. An outpost is frequently air-gapped and must not dial registries on a timer`
    };
  }
  return {
    allowed: true,
    reason: "SCP_FEDERATION_ROLE is explicitly 'commander' and this is a background-work process"
  };
}

// -------------------------------------------------------------------------------------------
// One org's tick
// -------------------------------------------------------------------------------------------

/** What the tick did about ONE line — returned for tests and logging, never persisted as such. */
export interface PolledLineResult {
  lineId: string;
  outcome: LineHeadOutcome;
  /** The Decision id standing on the record afterwards (a fresh row, or the restated existing one). */
  decisionId: string;
  /** False when `insertDecisionIfChanged` suppressed a byte-identical restatement. */
  decisionCreated: boolean;
  /** True when the observation trio was written. False for every non-`observed` outcome — NOTHING is
   *  recorded when a version could not be determined (ADR-0032 §7) — AND false when the write door
   *  refused the move: an index that has gone backwards (a yanked release, a mirror serving an older
   *  snapshot) does not drag this line's head back with it. */
  headRecorded: boolean;
  /** Why the door refused, when it did. `undefined` on every other path. */
  headRefusedReason?: HeadRefusalReason;
}

export interface DependencyVersionPollDeps {
  host: PluginHost;
  env?: NodeJS.ProcessEnv;
  /** Read ONCE per sweep by the caller and threaded down — see `readDependencyIndexFeed`. */
  feed?: FeedRead;
}

/** The subscribers of one line, deduped and sorted — one line is ONE registry query no matter how
 *  many components declare it, and the sorted id list is what makes the Decision's `inputContext`
 *  stable across ticks (an unstable order would defeat persist-on-change silently). */
interface LineWorkItem {
  /** Branded: only a line with a NULL `produced_by_object_id` can be one (property 0). */
  line: ThirdPartyLine;
  componentObjectIds: string[];
}

/**
 * Build this org's work-list: the enabled pairs, collapsed to distinct LINES.
 *
 * The collapse is not an optimisation detail — polling the same coordinate once per subscribing
 * component would multiply an org's registry traffic by its fan-out and would write N identical
 * Decisions about one line. The line is the subject; the components are an input to it.
 */
export async function buildLineWorkList(db: Db, orgId: string): Promise<LineWorkItem[]> {
  return withTenantTx(db, orgId, async (tx) => {
    // THE WORK-LIST IS THE RESOLUTION (property 1 in the module doc). Not filtered afterwards.
    const subscribed = await listSubscribedComponentLines(tx, orgId, {
      // A background tick has no human actor. `SYSTEM_ACTOR_ID` is the same sentinel the reconcile
      // loop threads into `matchPoliciesForTargets`. This comment used to draw a conclusion from that
      // which is FALSE (ADR-0032 §6a-ii): "it is a member of no group, so a `group`-scoped ENABLE
      // does not contribute for this caller — the SAFE direction". The sentinel's membership is
      // still nothing, but group scope's OWNING half never reads the actor, so a group-scoped enable
      // DOES contribute here wherever that group owns something on the component's chain. Neither
      // direction is therefore inert for this caller; what makes both safe is upstream, not here —
      // ADR-0032 §6a refuses authoring a group-scoped effect at all, in either direction.
      actorObjectId: SYSTEM_ACTOR_ID
    });
    if (subscribed.length === 0) return [];

    const componentsByLine = new Map<string, Set<string>>();
    for (const pair of subscribed) {
      let set = componentsByLine.get(pair.lineId);
      if (!set) {
        set = new Set<string>();
        componentsByLine.set(pair.lineId, set);
      }
      set.add(pair.componentObjectId);
    }

    // The resolution carries the line's NATURAL KEY only; `tagPattern` (which an image line's head
    // selection depends on) lives on the row, so the rows are hydrated in one batched point lookup.
    //
    // THAT LOOKUP IS THE THIRD-PARTY ONE (property 0). An internal line is dropped IN SQL here, not
    // by an `if` below: the poll may not move a head that the org's own production release owns.
    // The enablement AND is still not re-expressed — this narrows by PRODUCER, which is a different
    // question from "is anyone subscribed", and a subscribed internal line is legitimately in the
    // work-list of `internal-release-detection.ts` instead.
    const lines = await listThirdPartyDependencyLinesByIds(tx, orgId, [...componentsByLine.keys()]);
    return lines
      .map((line) => ({
        line,
        componentObjectIds: [...(componentsByLine.get(line.id) ?? [])].sort()
      }))
      .sort((a, b) => (a.line.id < b.line.id ? -1 : 1));
  });
}

/**
 * The Decision for one polled line.
 *
 * NOTHING TIME-VARYING MAY ENTER THIS OBJECT. `insertDecisionIfChanged` compares the candidate's
 * `verdict` + `inputContext` + `reasonTree` against the latest row of the same kind for the same
 * subject; a timestamp, an age, or an elapsed-ms field would make every daily comparison unequal and
 * restore the unbounded write with no visible symptom — the 1.44 GB/day shape. "When did we last
 * look" is already recorded, in the place that belongs to observation state rather than to a
 * verdict: `dependency_lines.latest_observed_at`.
 *
 * `detail` on an `unavailable` outcome IS included even though it is the one field that can vary
 * between two failures. That is deliberate: two DIFFERENT failure texts are two different facts
 * about the deployment (a redirect today, a refused connection tomorrow) and principle 6 wants both
 * on the record. Two IDENTICAL failures — the steady state, and the only one that could amplify —
 * still compare equal and are still suppressed.
 *
 * THE WRITE DOOR'S `advanced`/`restated` LABEL IS DELIBERATELY NOT CARRIED HERE, for the same rule
 * one paragraph up: it describes a TRANSITION, so the first tick that sees a head says `advanced`
 * and every identical tick after it says `restated` — a field that differs between two otherwise
 * byte-identical verdicts, which is precisely how persist-on-change is defeated without a symptom.
 * A REFUSAL is carried, because it is a statement about the world (this index is behind this line's
 * head) that stays true, and therefore compares equal, for as long as it holds.
 */
function decisionFor(
  item: LineWorkItem,
  outcome: LineHeadOutcome,
  refusal?: { reason: HeadRefusalReason; detail: string; head: string | null }
): { verdict: string; inputContext: Record<string, unknown>; reasonTree: Record<string, unknown> } {
  const inputContext: Record<string, unknown> = {
    ecosystem: item.line.ecosystem,
    coordinate: item.line.coordinate,
    major: item.line.major,
    tagPattern: item.line.tagPattern,
    // Which components' subscriptions caused this line to be polled at all — sorted, so the
    // comparison is stable, and present so "why was this fetched?" is answerable (principle 6).
    subscribedComponentObjectIds: item.componentObjectIds
  };
  if (outcome.status === "observed") {
    const reasonTree: Record<string, unknown> = {
      source: outcome.source,
      head: outcome.head,
      considered: outcome.selection.considered,
      // Skipped = offered but unparseable (`latest`, a branch name, a malformed tag). Recorded
      // rather than dropped: "we understood 12 of 40 tags" is the difference between a healthy
      // line and one whose tag scheme this build cannot read (ADR-0032 §7).
      skippedUnparseable: outcome.selection.skipped,
      offLine: outcome.selection.offLine
    };
    if (refusal === undefined) return { verdict: "observed", inputContext, reasonTree };
    return {
      // A DISTINCT VERDICT: the index answered and was understood, and the head still did not move.
      // Reporting this as `observed` would say the line is now at a version it is not.
      verdict: "not_recorded",
      inputContext,
      reasonTree: {
        ...reasonTree,
        reason: refusal.reason,
        detail: refusal.detail,
        standingHead: refusal.head,
        norecord:
          "the index's answer does not move this line's head, so the columns were left alone — a " +
          "head never moves backwards and never leaves the line it names (ADR-0032 §7)"
      }
    };
  }
  if (outcome.status === "undetermined") {
    return {
      // A DISTINCT VERDICT from `unavailable`: something answered, and nothing it said could be
      // understood as a version on this line. Merging the two would hide a line whose `major` or
      // `tag_pattern` is simply wrong behind "the network is down".
      verdict: "undetermined",
      inputContext,
      reasonTree: {
        source: outcome.source,
        reason: outcome.reason,
        considered: outcome.selection.considered,
        skippedUnparseable: outcome.selection.skipped,
        offLine: outcome.selection.offLine,
        norecord:
          "no version could be determined, so NOTHING was recorded — a wrong version would make " +
          "this component look up to date (ADR-0032 §7)"
      }
    };
  }
  return {
    verdict: "unavailable",
    inputContext,
    reasonTree: {
      source: outcome.source,
      reason: outcome.reason,
      detail: outcome.detail,
      norecord:
        "no index and no operator-loaded feed answered. This is NOT 'no new version': nothing was " +
        "asked, so nothing is known (ADR-0032 §7, charter principle 5)"
    }
  };
}

/** Poll every subscribed line in ONE org. Each line is isolated: a throw anywhere in its handling
 *  is contained, recorded as unavailable, and the sweep moves on. */
export async function pollOrgDependencyVersions(
  db: Db,
  orgId: string,
  deps: DependencyVersionPollDeps
): Promise<PolledLineResult[]> {
  const work = await buildLineWorkList(db, orgId);
  const results: PolledLineResult[] = [];
  /**
   * PROPERTY 5 — THE INDEX SUBPROCESSES HAVE A LIFECYCLE, AND IT ENDS HERE.
   *
   * Every other plugin-host caller in this tree starts instances derived from operator
   * CONFIGURATION (an executor binding), which persists, so leaving those children up between ticks
   * is right. This job is the first whose instances are derived from its own WORK-LIST: up to five
   * per org, started on demand by `queryLineHead`. Without a stop they were never torn down —
   * `host.start()` skips an id it already holds, so nothing leaked per tick, and the symptom was
   * instead a standing child-process count that grows with TENANCY and never falls, held for the
   * lifetime of the worker by a job that runs once a DAY. On a multi-tenant commander that is 5×N
   * idle subprocesses for 86,399 of every 86,400 seconds.
   *
   * The set is a RECEIPT from `queryLineHead` (`onIndexInstanceStarted`), not a re-derivation of
   * which instances "should" be running — see that option's doc for why the difference matters.
   */
  const startedIndexInstanceIds = new Set<string>();

  try {
    return await pollWork(db, orgId, deps, work, results, startedIndexInstanceIds);
  } finally {
    // In a `finally`, and tolerant of ids that were never actually started, so a throw anywhere
    // above still tears down whatever this sweep spun up. A failure to stop is logged, never
    // rethrown: it must not mask the sweep's own error, and it must not fail a sweep that worked.
    try {
      await deps.host.stopInstances([...startedIndexInstanceIds]);
    } catch (err) {
      console.error(
        `[dependency-version-poll] org ${orgId}: stopping index plugin instances failed:`,
        err
      );
    }
  }
}

async function pollWork(
  db: Db,
  orgId: string,
  deps: DependencyVersionPollDeps,
  work: LineWorkItem[],
  results: PolledLineResult[],
  startedIndexInstanceIds: Set<string>
): Promise<PolledLineResult[]> {
  for (const item of work) {
    // The network call happens OUTSIDE any transaction — a registry that takes 15s must never hold
    // a tenant transaction (and the 5s production `statement_timeout`) open behind it.
    let outcome: LineHeadOutcome;
    try {
      outcome = await queryLineHead(item.line, {
        host: deps.host,
        orgId,
        onIndexInstanceStarted: (instanceId) => startedIndexInstanceIds.add(instanceId),
        ...(deps.env !== undefined ? { env: deps.env } : {}),
        ...(deps.feed !== undefined ? { feed: deps.feed } : {})
      });
    } catch (err) {
      // `queryLineHead` catches its own plugin failures; this is the belt for anything else
      // (a malformed instance config, an unexpected host error). One line must never end the sweep.
      outcome = {
        status: "unavailable",
        source: "none",
        reason: "unreachable",
        detail: `polling this line threw: ${err instanceof Error ? err.message : String(err)}`
      };
    }

    try {
      const written = await withTenantTx(db, orgId, async (tx) => {
        let refusal: { reason: HeadRefusalReason; detail: string; head: string | null } | undefined;
        if (outcome.status === "observed") {
          // Observation state, not a verdict — a single-row UPDATE of the `latest_*` trio, bounded
          // by the number of lines and therefore not a growth source. The door DECIDES: the version
          // and its digest move together (an unresolved digest is an explicit `null`, never the
          // previous version's bytes left standing beside a new tag), the head never moves backwards
          // and never leaves the line it names. Whatever it refuses is reported, not swallowed.
          const head = await recordDependencyLineHead(tx, orgId, {
            lineId: item.line.id,
            latestVersion: outcome.head.version,
            latestDigest: outcome.head.digest
          });
          if (!head.recorded) {
            refusal = {
              reason: head.reason,
              detail: head.detail,
              head: head.line.latestVersion
            };
          }
        }
        const record = decisionFor(item, outcome, refusal);
        const inserted = await insertDecisionIfChanged(tx, {
          orgId,
          kind: DEPENDENCY_VERSION_POLL_DECISION_KIND,
          subjectId: item.line.id,
          verdict: record.verdict,
          inputContext: record.inputContext,
          reasonTree: record.reasonTree
        });
        return { inserted, refusal };
      });
      results.push({
        lineId: item.line.id,
        outcome,
        decisionId: written.inserted.decision.id,
        decisionCreated: written.inserted.created,
        headRecorded: outcome.status === "observed" && written.refusal === undefined,
        ...(written.refusal !== undefined ? { headRefusedReason: written.refusal.reason } : {})
      });
    } catch (err) {
      console.error(
        `[dependency-version-poll] org ${orgId} line ${item.line.id}: recording the verdict failed:`,
        err
      );
    }
  }
  return results;
}

/** Every org, one tick — mirrors `runObserveSweep`. */
export async function runDependencyVersionPollSweep(
  db: Db,
  deps: DependencyVersionPollDeps
): Promise<void> {
  const env = deps.env ?? process.env;
  // ONE feed read per sweep, threaded down: staleness is a property of the deployment, not of a
  // line, and re-reading + re-classifying the file per dependency would be a stat per row.
  const feed = deps.feed ?? readDependencyIndexFeed(env);
  const orgRows = await db.select({ id: orgs.id }).from(orgs);
  for (const org of orgRows) {
    try {
      await pollOrgDependencyVersions(db, org.id, { ...deps, env, feed });
    } catch (err) {
      console.error(`[dependency-version-poll] org ${org.id} tick failed:`, err);
    }
  }
}

export interface DependencyVersionPollLoopHandle {
  stop(): Promise<void>;
}

/**
 * Self-rescheduling pg-boss loop — `startObserveLoop`'s `startAfter` + `singletonKey` shape exactly
 * (there is no `boss.schedule` usage anywhere in this tree to copy, ADR-0032 §7), at a daily rather
 * than a 60s cadence.
 *
 * A REFUSED ROLE RETURNS AN INERT HANDLE AND NEVER CREATES THE QUEUE — the shape `startAutoRelayLoop`
 * and `startInboxLoop` already use for default-off loops. That matters beyond tidiness: an outpost
 * that merely *skipped the work* inside the handler would still have created the queue and still be
 * waking every day to decide to do nothing.
 */
export async function startDependencyVersionPollLoop(
  boss: PgBoss,
  db: Db,
  host: PluginHost,
  config: Pick<ServerConfig, "role" | "federationRole" | "federationRoleDeclared">
): Promise<DependencyVersionPollLoopHandle> {
  const guard = dependencyVersionPollRoleGuard(config);
  if (!guard.allowed) {
    console.info(`[dependency-version-poll] not started: ${guard.reason}`);
    return { async stop() {} };
  }
  // AND IT SAYS SO WHEN IT ALLOWS, TOO. A guard that logs only its refusals makes the ON state the
  // invisible one — an operator reading a boot log could not tell "this deployment polls package
  // registries daily" from "this line of code does not exist", which is the wrong way round for the
  // posture that actually sends traffic. Both verdicts are now on the record (principle 6), and this
  // one names the cadence so the log answers "how often" as well as "whether".
  console.info(
    `[dependency-version-poll] STARTING: ${guard.reason}. This process will reach configured ` +
      `package indexes every ${dependencyVersionPollIntervalSeconds()}s for every org on this ` +
      `instance that has an enabled dependency subscription`
  );

  let stopped = false;
  let inFlightTick: Promise<void> | undefined;
  await boss.createQueue(DEPENDENCY_VERSION_POLL_QUEUE);
  await boss.work(DEPENDENCY_VERSION_POLL_QUEUE, async () => {
    if (stopped) return;
    const tick = runDependencyVersionPollSweep(db, { host });
    inFlightTick = tick;
    try {
      await tick;
    } finally {
      inFlightTick = undefined;
    }
    if (stopped) return;
    const interval = dependencyVersionPollIntervalSeconds();
    await boss.send(
      DEPENDENCY_VERSION_POLL_QUEUE,
      {},
      { startAfter: interval, singletonKey: "tick", singletonSeconds: interval }
    );
  });
  await boss.send(DEPENDENCY_VERSION_POLL_QUEUE, {});
  return {
    async stop() {
      stopped = true;
      await inFlightTick;
    }
  };
}
