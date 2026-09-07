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

/** M21.4 — THE DAILY THIRD-PARTY VERSION POLL. See docs/dependencies.md §435. */

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

export interface DependencyVersionPollRoleVerdict {
  allowed: boolean;
  /** Why — carried so the boot log says which of the two axes refused, rather than staying silent
   *  about a loop that never ticks. */
  reason: string;
}

/** MAY THIS PROCESS RUN THE POLL? See docs/dependencies.md §436. */
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
    // THE GUARD USED TO BE FAIL-OPEN HERE, and silently. See docs/dependencies.md §437.
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

/** What the tick did about ONE line — returned for tests and logging, never persisted as such. */
export interface PolledLineResult {
  lineId: string;
  outcome: LineHeadOutcome;
  /** The Decision id standing on the record afterwards (a fresh row, or the restated existing one). */
  decisionId: string;
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

/** Build this org's work-list. See docs/dependencies.md §438. */
export async function buildLineWorkList(db: Db, orgId: string): Promise<LineWorkItem[]> {
  return withTenantTx(db, orgId, async (tx) => {
    // THE WORK-LIST IS THE RESOLUTION (property 1 in the module doc). Not filtered afterwards.
    const subscribed = await listSubscribedComponentLines(tx, orgId, {
      // A background tick has no human actor. See docs/dependencies.md §439.
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

    // The resolution carries the natural key only. See docs/dependencies.md §440.
    const lines = await listThirdPartyDependencyLinesByIds(tx, orgId, [...componentsByLine.keys()]);
    return lines
      .map((line) => ({
        line,
        componentObjectIds: [...(componentsByLine.get(line.id) ?? [])].sort()
      }))
      .sort((a, b) => (a.line.id < b.line.id ? -1 : 1));
  });
}

/** The Decision for one polled line. See docs/dependencies.md §441. */
/** Why nothing was recorded, in the terms of the rule. See docs/dependencies.md §442. */
export function norecordFor(reason: HeadRefusalReason): string {
  switch (reason) {
    case "line_is_internal":
      return (
        "a producer is declared for this coordinate, so its head is derived from the org's own " +
        "production releases and a public index may not write it — the columns were left alone. " +
        "This is NOT a statement about the version offered (ADR-0032 §7: dependency confusion)"
      );
    case "line_is_third_party":
    case "line_transferred":
      // Unreachable from THIS ingress. See docs/dependencies.md §443.
      return (
        "the ingress that offered this head does not own this line, so the columns were left " +
        "alone — WHO may write a head is decided before WHAT the version is (ADR-0032 §7)"
      );
    case "behind_head":
      return (
        "the index's answer is BEHIND this line's head, so the columns were left alone — a head " +
        "never moves backwards (ADR-0032 §7)"
      );
    case "different_major_line":
    case "different_tag_variant":
    case "major_line_not_comparable":
    case "version_not_comparable":
      return (
        "the index's answer is not a version on this line as it is defined now, so the columns " +
        "were left alone — a head never leaves the line it names (ADR-0032 §7)"
      );
  }
}

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
        norecord: norecordFor(refusal.reason)
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
  /** The index subprocesses have a lifecycle, ending here. See docs/dependencies.md §444. */
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
          // Observation state, not a verdict. See docs/dependencies.md §445.
          const head = await recordDependencyLineHead(
            tx,
            orgId,
            {
              lineId: item.line.id,
              latestVersion: outcome.head.version,
              latestDigest: outcome.head.digest
            },
            { kind: "third_party" }
          );
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

/** Self-rescheduling pg-boss loop. See docs/dependencies.md §446. */
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
  // AND IT SAYS SO WHEN IT ALLOWS, TOO. See docs/dependencies.md §447.
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
  // Startup kick: UNKEYED, so it always inserts (LOOP_STARTUP_SEND_IS_UNKEYED, events/pgboss.ts).
  // Never give this send a singletonKey+window — not the chain's "tick" and not a private key
  // either: job_i4 counts COMPLETED jobs, so any window lets a previous boot swallow it silently.
  await boss.send(DEPENDENCY_VERSION_POLL_QUEUE, {});
  return {
    async stop() {
      stopped = true;
      await inFlightTick;
    }
  };
}
