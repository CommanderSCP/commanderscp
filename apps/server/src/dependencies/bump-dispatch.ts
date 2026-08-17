import { randomUUID } from "node:crypto";
import type PgBoss from "pg-boss";
import { compareVersions, parseComparableVersion } from "@scp/dependency-manifests";
import type {
  ComponentDependency,
  DependencyLine,
  DependencySubscriptionDelivery,
  DependencySubscriptionGranularity
} from "@scp/schemas";
import type { Db } from "../db/client.js";
import { withTenantTx } from "../db/tenant-tx.js";
import type { ServerConfig } from "../config.js";
import type { PluginHost } from "../plugin-host/contract.js";
import type { DomainEventJob, DomainEventRouter } from "../events/pgboss.js";
import { ProblemError } from "../errors.js";
import { SYSTEM_ACTOR_ID } from "../coordination/system-actor.js";
import { insertDecisionIfChanged } from "../coordination/decisions-repo.js";
import {
  listExecutorBindings,
  type ExecutorBindingRow
} from "../coordination/executor-bindings-repo.js";
import { pickComponentGitBinding, startManagedDepInstance } from "./managed-dep-instance.js";
import {
  DEPENDENCY_LINE_HEAD_ADVANCED_EVENT,
  getDependencyLineById,
  listComponentDependencies,
  listComponentsDeclaringLine
} from "./dependency-inventory-repo.js";
import { lineAcceptsVersion } from "./line-head.js";
import { listSubscribedComponentLines } from "./subscription-resolution.js";
import {
  assertComponentNotDelegated,
  buildBumpIntentParameters,
  recordBumpChange,
  resolveEffectiveDelivery,
  type DeliveryResolution
} from "./bump-actuator.js";
import {
  findOpenBumpAuthorship,
  recordBumpPullRequest,
  type BumpAuthorship
} from "./bump-authorship-repo.js";
import {
  delegationProbeFailureDetail,
  delegationProbeIsInconclusive,
  probeDependencyUpdateDelegation,
  recordDelegationProbe,
  type DelegationProbeSubject
} from "./delegation-detection.js";
import {
  bindingRepoPath,
  createGitProviderManifestReader,
  isGitProviderModule
} from "./manifest-reader.js";

/**
 * M21.5 — THE THING THAT ACTUALLY PROPOSES AND DISPATCHES A BUMP (ADR-0032 §8/§9).
 *
 * ============================================================================================
 * WITHOUT THIS FILE, M21.5 WAS THREE FUNCTIONS NOBODY CALLED
 * ============================================================================================
 * `recordBumpChange`, `resolveEffectiveDelivery` and `buildBumpIntentParameters` were built, tested
 * and correct, and measured filterlessly at the time NOTHING in the tree constructed a `managed-dep`
 * `TriggerIntent`: no job, no route, no loop, no worker. A subscriber to a line whose head advanced
 * received nothing, forever, with no error anywhere. That is the fourth time in M21 something was
 * built and never installed, which is why the definition of done for this increment is WIRED — and
 * why the test that proves it drives the ROUTER and the JOB rather than the functions.
 *
 * ============================================================================================
 * THE SHAPE: ROUTE ON THE SHARED STREAM, WORK ON THIS CAPABILITY'S OWN QUEUE
 * ============================================================================================
 *   recordDependencyLineHead (the ONE write door, both ingresses)
 *      -> outbox `scp.dependency.line_head_advanced`   [same transaction as the head write]
 *      -> domain-events -> {@link advancedLineHeadRouter} (one cheap predicate + one enqueue)
 *      -> {@link DEPENDENCY_BUMP_QUEUE} -> this file's worker -> a change, then a dispatch.
 *
 * `boss.work()` is a COMPETING consumer, so this cannot be a second worker on `domain-events`: it
 * would steal roughly half of M21.4's internal-release events and receive roughly half of its own
 * (`events/pgboss.ts`'s `DomainEventRouter`). The router is the fan-out point and does no work —
 * a repository write's latency and retry budget must not sit on the shared event stream.
 *
 * WHY THE EVENT IS EMITTED AT THE WRITE DOOR rather than by each ingress is argued where it is
 * emitted (`dependency-inventory-repo.ts`): the two ingresses have already demonstrated that a rule
 * applied per caller regresses per caller.
 *
 * ============================================================================================
 * THE WORK-LIST IS M21.3'S RESOLUTION. THERE IS NO SECOND FILTER HERE.
 * ============================================================================================
 * `listSubscribedComponentLines` returns exactly the (component, line) pairs whose monotone AND
 * resolved TRUE, so an unsubscribed component is never bumped BY CONSTRUCTION (ADR-0032 §6). This
 * file writes no predicate over enablement — not a `WHERE`, not an `if`. The one narrowing it does
 * apply is `componentObjectIds`, which is a narrowing of the SCAN (the components that declare this
 * line, from the reverse index) and not of the ANSWER: every candidate still goes through the merge.
 *
 * ============================================================================================
 * IDEMPOTENT UNDER REDELIVERY, AT EVERY HOP
 * ============================================================================================
 * The outbox->pg-boss path is at-least-once and there are two hops that can redeliver. Nothing on
 * this path appends:
 *
 *  - a bump change is looked up BEFORE it is proposed (`findOpenBumpAuthorship`), keyed on the
 *    (component, manifest, coordinate, target version) SCP ITSELF RECORDED in
 *    `dependency_bump_authorships` — so a redelivery re-uses the existing change and its existing
 *    branch instead of minting a second, while two components subscribed to the SAME line each get
 *    their own (that function's header says why every field of that key has to be compared, and what
 *    happened when two of them were not);
 *  - the dispatch carries `idempotencyKey = <changeObjectId>`, which is what the plugin's own
 *    outcome cache keys on, and the branch it authors carries that same id — so a retry that gets
 *    past the cache still converges on one branch and one pull request;
 *  - the verdict goes through `insertDecisionIfChanged`, whose inputs here are stable facts only;
 *  - the head is RE-READ from the row rather than trusted from the event.
 *
 * ============================================================================================
 * THE ROLE GUARD — COMMANDER-ONLY, WITH ITS OWN REASON ON TOP OF THE SHARED ONE
 * ============================================================================================
 * Since ADR-0032 §7d (owner decision, 2026-08-17) EVERY dependency job is commander-only, so this
 * verdict is no longer the strict one in a split field — it is the shared rule, and the shared
 * reason lives in `commander-only.ts`: dependency automation exists to pull from PUBLIC
 * repositories, which a FIELD outpost has no need to do, because the resulting change is pushed down
 * the global pipeline the commander manages. ("Field" is load-bearing — an HQ outpost is the outpost
 * in the commander's own trust domain and is this very process; see `commander-only.ts`, which reads
 * that out of the code. Every deployment this guard actually refuses is a field outpost, so the
 * refusal strings below say "outpost" exactly.) (This paragraph used to open by contrasting M21.4's
 * two jobs, which "reached OPPOSITE verdicts on the federation axis"; they no longer do, and internal
 * detection no longer "runs everywhere" — §7d marks that clause reversed.)
 *
 * THIS JOB'S OWN REASON SURVIVES THE CONVERGENCE AND IS STILL WORTH STATING, because it is what
 * would keep the guard here even if the shared rule were ever relaxed: it does not merely READ from
 * the internet, it WRITES to somebody's source repository, with a credential, on a trigger nobody
 * watched. An air-gapped or high-side outpost must never do that. The guard is fail-CLOSED on an
 * UNDECLARED deployment, because `SCP_FEDERATION_ROLE` defaults to `commander` for deployments that
 * predate the setting — and that is exactly the population most likely to be air-gapped. It also
 * logs when it ALLOWS: a posture that writes to a user's repository must not be the invisible one.
 *
 * The process axis (`SCP_ROLE`) applies unchanged — background work belongs to `all`/`worker`.
 *
 * ============================================================================================
 * WHAT IT REFUSES TO GUESS
 * ============================================================================================
 * Every branch that cannot state the bump precisely records a NAMED reason and dispatches nothing.
 * A missed bump is visible (the component keeps declaring the old version); a wrong one is a commit
 * in somebody else's repository. The named reasons are {@link BumpRefusalReason} and each is its own
 * cause — a reason named after the branch that matched goes false the moment that branch covers a
 * second case (ADR-0032 §7b clause 6, charter principle 6).
 */

export const DEPENDENCY_BUMP_QUEUE = "dependency-bump";

/** The `decisions.kind` every dispatch verdict is filed under — also the key
 *  `insertDecisionIfChanged` compares the previous verdict on, so it must be a constant. */
export const DEPENDENCY_BUMP_DECISION_KIND = "dependency_bump_dispatch";

// -------------------------------------------------------------------------------------------
// The role guard
// -------------------------------------------------------------------------------------------

export interface BumpDispatchRoleVerdict {
  allowed: boolean;
  reason: string;
}

/** MAY THIS PROCESS AUTHOR DEPENDENCY BUMPS? See the module doc for why this asks the poll's two
 *  questions and keeps BOTH of them, where internal detection keeps one. */
export function bumpDispatchRoleGuard(
  config: Pick<ServerConfig, "role" | "federationRole" | "federationRoleDeclared">
): BumpDispatchRoleVerdict {
  if (config.role !== "all" && config.role !== "worker") {
    return {
      allowed: false,
      reason: `SCP_ROLE is '${config.role}' — background work belongs to an 'all' or 'worker' process`
    };
  }
  if (!config.federationRoleDeclared) {
    return {
      allowed: false,
      reason:
        "SCP_FEDERATION_ROLE is not declared on this deployment, and this job writes to a source " +
        "repository over the network — an outpost that predates the setting (or a chart that omits " +
        "it) is indistinguishable from a commander here, so the undeclared case is refused rather " +
        "than assumed"
    };
  }
  if (config.federationRole !== "commander") {
    return {
      allowed: false,
      reason: `SCP_FEDERATION_ROLE is '${config.federationRole}' — only a commander authors dependency bumps; an outpost is frequently air-gapped or high-side and must never initiate an outbound repository write`
    };
  }
  return {
    allowed: true,
    reason:
      "background-work process on an explicitly-declared commander — dependency bumps are authored " +
      "into a source repository over the network, so both axes are required"
  };
}

// -------------------------------------------------------------------------------------------
// The router
// -------------------------------------------------------------------------------------------

/** What {@link advancedLineHeadRouter} puts on {@link DEPENDENCY_BUMP_QUEUE}. */
export interface BumpDispatchJob {
  orgId: string;
  lineId: string;
}

/** True for the one event shape this capability reacts to. Exported so a test can pin the predicate
 *  without a queue: a router that matched too widely would enqueue a job per head observation,
 *  including the daily restatements the write door deliberately does not emit. */
export function isLineHeadAdvancedEvent(event: DomainEventJob): boolean {
  return event.type === DEPENDENCY_LINE_HEAD_ADVANCED_EVENT;
}

/** The fan-out point on the shared domain-event stream: one predicate, one enqueue, no work. */
export function advancedLineHeadRouter(): DomainEventRouter {
  return {
    name: "dependency-bump",
    queue: DEPENDENCY_BUMP_QUEUE,
    async route(boss: PgBoss, event: DomainEventJob): Promise<void> {
      if (!isLineHeadAdvancedEvent(event)) return;
      const lineId = event.subject;
      if (typeof lineId !== "string" || lineId === "") return;
      const job: BumpDispatchJob = { orgId: event.orgId, lineId };
      // NO DEDUP OPTION, DELIBERATELY, AND THE COMMENT THAT USED TO BE HERE WAS FALSE.
      //
      // This passed `{ singletonKey: lineId }` and claimed it "collapses a redelivery of the SAME
      // advance that arrives while an earlier job for it is still queued". It does not: pg-boss
      // enforces `singleton_key` uniqueness through three PARTIAL indexes, every one of them scoped
      // `WHERE ... policy = 'short' | 'singleton' | 'stately'` (`pg-boss/src/plans.js`). This queue
      // is created with `boss.createQueue(name)` and therefore has the DEFAULT `standard` policy, for
      // which no such index exists — so the key was recorded and ignored, and the sentence describing
      // it was a control that did not exist.
      //
      // The queue keeps `standard`, and that is the deliberate half. `short` WOULD make the key bite,
      // by REJECTING a send while an earlier job for the same key is still `created` — and this job's
      // whole safety story is that it is idempotent and RE-DERIVES from the row rather than trusting
      // the event, so collapsing was only ever an optimisation ("never the correctness argument", as
      // the old comment itself said). Trading a queue's rejection semantics for an optimisation that
      // is not load-bearing is the wrong direction; an inert option with a sentence explaining its
      // importance is worse than neither.
      await boss.send(DEPENDENCY_BUMP_QUEUE, job);
    }
  };
}

// -------------------------------------------------------------------------------------------
// Deciding whether a bump is due, and what it says — a pure function, so it is testable without a
// database, a provider or a container.
// -------------------------------------------------------------------------------------------

export type BumpRefusalReason =
  /** The head is not observed at all (`latest_version` is NULL — "not yet observed", never "nothing
   *  newer exists"). */
  | "no_head_observed"
  /** The declaration pins no concrete version (an open range: `^1`, `*`, `latest`). Deciding what to
   *  edit would need a lockfile, and resolving one is CI by definition (ADR-0032 §8). */
  | "declaration_pins_no_version"
  /** The version the component declares cannot be read by this ecosystem's grammar, so it cannot be
   *  ordered against the head. Skipped rather than guessed. */
  | "declared_version_not_comparable"
  /** The head is not a version on this line as the line is defined now. */
  | "head_not_on_line"
  /** The component already declares the head, or something ahead of it. */
  | "already_at_or_ahead_of_head"
  /** `patch` granularity, and the head is a MINOR (or major) move. The subscription asked for patch
   *  releases only, and this is not one. */
  | "beyond_granularity"
  /** The verbatim declaration does not contain the resolved version as a substring, so the edited
   *  text cannot be composed by replacing it — `resolved_version` and `declared_version` disagree
   *  about what the file says, and rewriting on a guess is how a range operator gets lost. */
  | "declaration_not_composable";

export type BumpPlan =
  | {
      readonly due: true;
      /** What the manifest says today, VERBATIM — the string the runner replaces. */
      readonly fromVersion: string;
      /** What it must say afterwards, carrying the declaration's own prefix/suffix. */
      readonly toVersion: string;
    }
  | { readonly due: false; readonly reason: BumpRefusalReason; readonly detail: string };

/**
 * Is a bump due for THIS declaration, and what would it say?
 *
 * THE EDIT IS COMPOSED BY SUBSTITUTION, NOT BY FORMATTING. `component_dependencies.declared_version`
 * is what the manifest literally holds (`^1.2.3`, `~=1.4`, `v1.2.3`, `3.18-alpine`) and
 * `resolved_version` is the concrete version parsed OUT of it. The new text is the declaration with
 * that concrete substring replaced by the head — so `^1.2.3` becomes `^1.3.0` and keeps its range
 * operator, and `v1.2.3` keeps its `v`. Re-rendering a declaration from a parsed triple would
 * silently drop whatever the parser did not model, in a file this system then commits.
 *
 * A declaration whose resolved version is not a substring of it is REFUSED rather than reformatted:
 * the two columns disagree about what the file says, and every way of proceeding from there is a
 * guess about somebody else's manifest.
 */
export function planBump(input: {
  line: Pick<DependencyLine, "ecosystem" | "major" | "tagPattern" | "latestVersion">;
  declaration: Pick<ComponentDependency, "declaredVersion" | "resolvedVersion">;
  granularity: DependencySubscriptionGranularity;
}): BumpPlan {
  const head = input.line.latestVersion;
  if (head === null || head === "") {
    return {
      due: false,
      reason: "no_head_observed",
      detail:
        "this line has no observed head (`latest_version` is NULL, which means 'not yet observed' and never 'nothing newer exists')"
    };
  }
  const acceptance = lineAcceptsVersion(input.line, head);
  if (!acceptance.accepted) {
    return {
      due: false,
      reason: "head_not_on_line",
      detail: `the stored head '${head}' is not a version on this line as it is defined now (${acceptance.reason}): ${acceptance.detail}`
    };
  }
  const resolved = input.declaration.resolvedVersion;
  if (resolved === null || resolved === "") {
    return {
      due: false,
      reason: "declaration_pins_no_version",
      detail: `'${input.declaration.declaredVersion}' pins no concrete version, and finding out what it currently resolves to needs a lockfile — resolving one is CI by definition (ADR-0032 §8), so nothing is edited`
    };
  }
  const current = parseComparableVersion(resolved);
  if (!current) {
    return {
      due: false,
      reason: "declared_version_not_comparable",
      detail: `'${resolved}' has no comparable numeric core, so it cannot be ordered against the head '${head}' — skipped rather than guessed`
    };
  }
  const order = compareVersions(acceptance.parsed, current);
  if (order === undefined || order <= 0) {
    return {
      due: false,
      reason: "already_at_or_ahead_of_head",
      detail: `the component declares '${resolved}' and this line's head is '${head}' — there is nothing ahead of it to move to`
    };
  }
  if (input.granularity === "patch" && acceptance.parsed.minor !== current.minor) {
    return {
      due: false,
      reason: "beyond_granularity",
      detail: `the head '${head}' is a minor move from '${resolved}', and this subscription resolved to 'patch' — the most restrictive granularity wins and no minor is authored`
    };
  }
  const declared = input.declaration.declaredVersion;
  if (!declared.includes(resolved)) {
    return {
      due: false,
      reason: "declaration_not_composable",
      detail: `the manifest declares '${declared}' but the resolved version recorded for it is '${resolved}', which is not a substring of it — the edited text cannot be composed by substitution, and reformatting the declaration would drop whatever the parser did not model`
    };
  }
  const at = declared.indexOf(resolved);
  const toVersion = declared.slice(0, at) + head + declared.slice(at + resolved.length);
  if (toVersion === declared) {
    return {
      due: false,
      reason: "already_at_or_ahead_of_head",
      detail: `substituting '${head}' for '${resolved}' in '${declared}' changes nothing`
    };
  }
  return { due: true, fromVersion: declared, toVersion };
}

// -------------------------------------------------------------------------------------------
// The job
// -------------------------------------------------------------------------------------------

export interface BumpDispatchLoopDeps {
  db: Db;
  host: PluginHost;
  config: Pick<
    ServerConfig,
    "role" | "federationRole" | "federationRoleDeclared" | "secretsMasterKey"
  >;
}

/** What one job did, per (component, manifest) candidate. Returned so the worker can log it and an
 *  integration test can assert the real function's own verdict rather than a copy of it. */
export interface BumpDispatchOutcome {
  lineId: string;
  /** Bumps actually dispatched to `scp-managed-dep`. */
  dispatched: {
    componentObjectId: string;
    manifestPath: string;
    changeObjectId: string;
    delivery: DependencySubscriptionDelivery;
  }[];
  /** Candidates that were considered and not dispatched, each with its own named cause. */
  skipped: { componentObjectId: string; manifestPath?: string; reason: string; detail: string }[];
}

/**
 * Run ONE queued job. Exported so an integration test drives the exact function the worker runs.
 *
 * PHASES, and the split is the one M21.4 §7c clause 2 already established: read in a transaction,
 * do provider I/O OUTSIDE any transaction, write in a transaction. Holding an RLS-scoped pooled
 * connection across a git round trip — against a 5s production `statement_timeout` and a bounded
 * pool — is the failure both M21.4 ingresses are arranged to avoid, and a repository WRITE is a
 * longer round trip than either of them.
 */
export async function runBumpDispatchJob(
  deps: BumpDispatchLoopDeps,
  job: BumpDispatchJob
): Promise<BumpDispatchOutcome> {
  const outcome: BumpDispatchOutcome = { lineId: job.lineId, dispatched: [], skipped: [] };

  // ---- PHASE 1 (read) -----------------------------------------------------------------------
  const work = await withTenantTx(deps.db, job.orgId, async (tx) => {
    // RE-READ the line rather than trusting the event: at-least-once delivery means this can arrive
    // after a later observation has moved the head again, or after an operator repointed the line.
    const line = await getDependencyLineById(tx, job.orgId, job.lineId);
    if (!line) return null;

    // The scan is narrowed to the components that DECLARE this line (one index descent on
    // `component_dependencies_org_line`) — a narrowing of the scan, never of the answer: every
    // candidate below still goes through `listSubscribedComponentLines`'s merge.
    const declaring = await listComponentsDeclaringLine(tx, job.orgId, job.lineId);
    const componentObjectIds = [...new Set(declaring.map((d) => d.componentObjectId))];
    if (componentObjectIds.length === 0) return { line, candidates: [] };

    const subscribed = await listSubscribedComponentLines(tx, job.orgId, {
      // The system actor, exactly as M21.4's two ingresses resolve. It has no `objects` row and so
      // is a transitive `member_of` nothing — which is NOT, as this comment used to claim, the
      // reason a GROUP-scoped `dependencySubscription` effect is refused at authoring time. Group
      // scope's OWNING half ignores the actor entirely, so such a policy can match right here
      // (ADR-0032 §6a-ii). The refusal is about a reach decided by mutable `owns` edges instead of
      // by the author.
      actorObjectId: SYSTEM_ACTOR_ID,
      componentObjectIds
    });

    const candidates = [];
    for (const pair of subscribed.filter((s) => s.lineId === job.lineId)) {
      const declarations = declaring.filter((d) => d.componentObjectId === pair.componentObjectId);
      // EVERY manifest path this component declares, across every line — what the plugin's
      // manifest-only verifier compares the edit target against. Sending only the one being edited
      // would make that gate agree with itself (`parseBumpDescriptor` refuses a descriptor without
      // this for exactly that reason).
      const allDeclarations = await listComponentDependencies(
        tx,
        job.orgId,
        pair.componentObjectId
      );
      const bindings = await listExecutorBindings(tx, job.orgId);
      candidates.push({
        componentObjectId: pair.componentObjectId,
        granularity: pair.granularity,
        delivery: pair.delivery,
        declarations,
        declaredManifestPaths: [...new Set(allDeclarations.map((d) => d.manifestPath))].sort(),
        gitBindings: bindings.filter(
          (b) => b.targetObjectId === pair.componentObjectId && isGitProviderModule(b.pluginModule)
        )
      });
    }
    return { line, candidates };
  });

  if (!work) {
    outcome.skipped.push({
      componentObjectId: "",
      reason: "line_gone",
      detail: `dependency line ${job.lineId} no longer exists`
    });
    return outcome;
  }

  const { line, candidates } = work;
  // THIS RUN's receipt, threaded into every plugin-instance id this job starts. `bump-gate.ts` is a
  // concurrent consumer of the SAME component bindings and also tears its instances down in a
  // `finally`; with one shared id per binding, either job's teardown killed the other's in-flight
  // RPC. See `managed-dep-instance.ts`'s module doc.
  const runToken = randomUUID();
  const startedInstances = new Set<string>();
  try {
    for (const candidate of candidates) {
      await dispatchForComponent(
        deps,
        job.orgId,
        line,
        candidate,
        outcome,
        startedInstances,
        runToken
      );
    }
  } finally {
    // PLUGIN INSTANCES DERIVED FROM A WORK-LIST NEED A LIFECYCLE (ADR-0032 §7c clause 4). These
    // instances come from this job's own candidate list — up to one per component per org, started
    // on demand — not from operator configuration that persists. Stopped from a RECEIPT of what this
    // code started, never from a second derivation of what "should" be running. (The git-provider
    // instances the delegation probe starts are the OTHER kind — ordinary binding instances the
    // reconcile/observe loops also hold — and `manifest-reader.ts` documents why those are left up.)
    if (startedInstances.size > 0) {
      await deps.host.stopInstances([...startedInstances]).catch(() => undefined);
    }
  }
  return outcome;
}

interface BumpCandidate {
  componentObjectId: string;
  granularity: DependencySubscriptionGranularity;
  delivery: DependencySubscriptionDelivery;
  declarations: ComponentDependency[];
  declaredManifestPaths: string[];
  gitBindings: ExecutorBindingRow[];
}

async function dispatchForComponent(
  deps: BumpDispatchLoopDeps,
  orgId: string,
  line: DependencyLine,
  candidate: BumpCandidate,
  outcome: BumpDispatchOutcome,
  startedInstances: Set<string>,
  runToken: string
): Promise<void> {
  const skip = (reason: string, detail: string, manifestPath?: string): void => {
    outcome.skipped.push({
      componentObjectId: candidate.componentObjectId,
      ...(manifestPath === undefined ? {} : { manifestPath }),
      reason,
      detail
    });
  };

  // WHICH REPOSITORY, AND ON WHOSE AUTHORITY — `managed-dep-instance.ts`'s
  // `pickComponentGitBinding`, shared with the merge path so both acts reach the same repository
  // through the same credential.
  const binding = pickComponentGitBinding(candidate.gitBindings, candidate.componentObjectId);
  const repo = binding ? bindingRepoPath(binding.config) : null;
  if (!binding || !repo) {
    skip(
      "no_git_binding_for_component",
      "no github/gitea/gitlab executor binding on this component names a repository, so there is no " +
        "repository to author into and no credential that may write to one"
    );
    return;
  }

  // WHICH BRANCH. `component_dependencies.observed_ref` is the ref the manifest was actually read
  // at, which is the only honest base for an edit to it — a bump composed against `main` but
  // observed on another ref would be built on a file this component may not have there. Refused
  // rather than defaulted to a branch name this code invented.
  const dueDeclarations = candidate.declarations
    .map((declaration) => ({
      declaration,
      plan: planBump({ line, declaration, granularity: candidate.granularity })
    }))
    .filter((entry) => {
      if (entry.plan.due) return true;
      skip(entry.plan.reason, entry.plan.detail, entry.declaration.manifestPath);
      return false;
    });
  if (dueDeclarations.length === 0) return;

  // ---- PHASE 2 (provider I/O, OUTSIDE any transaction) ---------------------------------------
  // DOES THIS REPOSITORY ALREADY DELEGATE ITS DEPENDENCY UPDATES TO SOMEBODY ELSE?
  //
  // This is the WRITER the charter clause needed. `probeDependencyUpdateDelegation` and
  // `recordDelegationProbe` existed with two readers and no producer, so "CommanderSCP refuses to
  // enable dependency subscriptions for a component whose repository already delegates the same
  // manifests to another dependency-update system" was enforced by nothing end to end: the
  // authoring-time guard and the actuator re-check both read a verdict that was never written.
  //
  // It runs HERE, and here is the only place it can: answering it requires reading files out of the
  // repository, `graph/objects-repo.ts`'s choke point runs inside a transaction holding two per-org
  // advisory locks, and this is the one production path that already has the repository, the ref and
  // the component's declared manifests in hand. The verdict is persisted as a Decision
  // (`insertDecisionIfChanged` — this path repeats per advance, which is the write-amplification
  // shape that cost 1.44 GB/day elsewhere), and BOTH readers then see it: the actuator seam below
  // refuses this very dispatch, and the authoring choke point refuses the next enable.
  //
  // THE RESIDUAL, stated rather than hidden: a component that has never been a bump candidate has no
  // verdict, so its first enable is not refused at authoring time. That is exactly what
  // `delegation-detection.ts`'s "WHAT ABSENT MEANS" already declares ("no probe on record means NO
  // DELEGATION HAS BEEN OBSERVED"), and it is why the actuator half exists — nothing is written to a
  // delegating repository either way.
  const baseRef = dueDeclarations[0]?.declaration.observedRef ?? null;
  if (!baseRef || !baseRef.startsWith("refs/heads/")) {
    skip(
      "no_observed_branch",
      `the declaration was observed at ${baseRef === null ? "no ref" : `'${baseRef}'`}, which is not a branch this bump can be based on — a base branch is never invented here`
    );
    return;
  }
  const baseBranch = baseRef.slice("refs/heads/".length);

  const probeSubject: DelegationProbeSubject = {
    componentObjectId: candidate.componentObjectId,
    repo,
    ref: baseRef,
    manifests: candidate.declarations.map((d) => ({
      manifestPath: d.manifestPath,
      ecosystem: line.ecosystem
    }))
  };
  const reader = createGitProviderManifestReader({
    db: deps.db,
    host: deps.host,
    orgId,
    masterKey: deps.config.secretsMasterKey
  });
  let probeFailure: string | undefined;
  try {
    const probe = await probeDependencyUpdateDelegation(reader, probeSubject);
    // A PROBE THAT COULD NOT READ IS NOT A PROBE THAT FOUND NOTHING, and the two are byte-identical
    // in the result unless this is asked: a bad credential, a provider 5xx and an egress refusal all
    // yield `configs: []`, `collisions: []`, `delegated: false`. Treating that as "no delegation
    // here" is the fail-OPEN this whole module exists to prevent, so it is a skip with its cause and
    // NOTHING — no dispatch, and no `allow` Decision either (`recordDelegationProbe` refuses to
    // write one, which is where the rule lives so a second producer inherits it).
    if (delegationProbeIsInconclusive(probe)) {
      probeFailure = delegationProbeFailureDetail(probe);
    } else {
      await withTenantTx(deps.db, orgId, (tx) =>
        recordDelegationProbe(tx, orgId, probeSubject, probe)
      );
    }
  } catch (err) {
    // The probe, or the write of its verdict, threw outright. Same treatment and for the same
    // reason: proceeding would author into a repository whose delegation status this run failed to
    // establish, which is the state the refusal exists for.
    probeFailure = err instanceof Error ? err.message : String(err);
  }
  if (probeFailure !== undefined) {
    skip(
      "delegation_probe_failed",
      `could not read '${repo}' to decide whether it already delegates dependency updates: ${probeFailure}`
    );
    return;
  }

  for (const { declaration, plan } of dueDeclarations) {
    if (!plan.due) continue; // narrowed above; kept so the type holds without an assertion
    try {
      await dispatchOneBump(deps, {
        orgId,
        line,
        candidate,
        declaration,
        repo,
        baseBranch,
        fromVersion: plan.fromVersion,
        toVersion: plan.toVersion,
        gitBinding: binding,
        startedInstances,
        runToken,
        outcome
      });
    } catch (err) {
      // PER DECLARATION, so one component's refused bump cannot stop another's. A thrown refusal
      // here is the delegation conflict (a 409 from `assertComponentNotDelegated`) or a provider
      // failure; both are legible in the skip, and both are re-derivable on the next advance.
      // `ProblemError.message` is the STATUS TEXT ("Conflict"); the sentence an operator can act on
      // is in `detail`. Reading it here is what keeps the delegation refusal legible in the log and
      // in the outcome, rather than reducing "this repository delegates to renovate.json" to a
      // status word.
      const detail =
        err instanceof ProblemError
          ? (err.detail ?? err.message)
          : err instanceof Error
            ? err.message
            : String(err);
      skip("dispatch_failed", detail, declaration.manifestPath);
    }
  }
}

async function dispatchOneBump(
  deps: BumpDispatchLoopDeps,
  input: {
    orgId: string;
    line: DependencyLine;
    candidate: BumpCandidate;
    declaration: ComponentDependency;
    repo: string;
    baseBranch: string;
    fromVersion: string;
    toVersion: string;
    gitBinding: ExecutorBindingRow;
    startedInstances: Set<string>;
    runToken: string;
    outcome: BumpDispatchOutcome;
  }
): Promise<void> {
  const { orgId, line, candidate, declaration, repo, baseBranch } = input;

  // ---- PHASE 3 (write) -----------------------------------------------------------------------
  const prepared = await withTenantTx(deps.db, orgId, async (tx) => {
    // THE OTHER HALF OF THE DELEGATION REFUSAL — the stored verdict this job may have just written,
    // read back at the choke point immediately before SCP would write to the repository. It throws
    // a 409 carrying the probe's `decision_id`, which the caller records as this candidate's skip.
    await assertComponentNotDelegated(tx, orgId, candidate.componentObjectId);

    // ALREADY PROPOSED? A redelivery, or a second advance while the first bump's pull request is
    // still open, must reuse the existing change — its branch is the provenance join and a second
    // change would mean two branches, two pull requests and two releases for one bump.
    //
    // ASKED OF SCP'S OWN RECORD, not of `changes.source_ref`. The predecessor scanned every
    // dependency-bump change in the org and compared jsonb keys a tenant can write; this is one
    // indexed lookup over server-owned columns (`bump-authorship-repo.ts`, migration 0063).
    const existing: BumpAuthorship | undefined = await findOpenBumpAuthorship(tx, orgId, {
      componentObjectId: candidate.componentObjectId,
      manifestPath: declaration.manifestPath,
      coordinate: line.coordinate,
      toVersion: input.toVersion
    });
    const changeObjectId = existing?.changeObjectId ?? randomUUID();

    // Delivery is resolved against THIS change — which on a first dispatch has no control runs, so
    // it resolves to `pull_request` whatever the subscription asked for. See
    // `resolveEffectiveDelivery`'s "A CONSEQUENCE WORTH STATING". Both narrowing inputs come from
    // the authorship row, so neither can be supplied by a tenant.
    const delivery: DeliveryResolution = await resolveEffectiveDelivery(tx, orgId, {
      changeObjectId,
      requested: candidate.delivery,
      repo: existing?.repo,
      authoredHeadCommit: existing?.headCommit
    });

    const recordInput = {
      orgId,
      changeObjectId,
      requestId: `dependency-bump-${changeObjectId}`,
      componentObjectId: candidate.componentObjectId,
      lineId: line.id,
      repo,
      baseBranch,
      ecosystem: line.ecosystem,
      coordinate: line.coordinate,
      manifestPath: declaration.manifestPath,
      declaredManifestPaths: candidate.declaredManifestPaths,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      delivery
    };
    if (!existing) await recordBumpChange(tx, recordInput);

    await insertDecisionIfChanged(tx, {
      orgId,
      kind: DEPENDENCY_BUMP_DECISION_KIND,
      subjectId: changeObjectId,
      verdict: "dispatched",
      inputContext: {
        componentObjectId: candidate.componentObjectId,
        lineId: line.id,
        ecosystem: line.ecosystem,
        coordinate: line.coordinate,
        major: line.major,
        head: line.latestVersion,
        manifestPath: declaration.manifestPath,
        fromVersion: input.fromVersion,
        toVersion: input.toVersion,
        requestedDelivery: candidate.delivery,
        effectiveDelivery: delivery.delivery,
        granularity: candidate.granularity,
        reused: existing !== undefined
      },
      reasonTree: {
        summary: `${line.coordinate} ${input.fromVersion} -> ${input.toVersion} in ${declaration.manifestPath}`,
        delivery: delivery.reason
      }
    });
    return {
      recordInput,
      changeObjectId,
      delivery,
      authoredHeadCommit: existing?.headCommit
    };
  });

  // ---- PHASE 4 (the dispatch itself, outside any transaction) --------------------------------
  const instanceId = await startManagedDepInstance(deps, orgId, input.gitBinding, input.runToken);
  input.startedInstances.add(instanceId);
  const executor = deps.host.executor(instanceId);
  const ref = await executor.trigger({
    kind: "custom",
    // STABLE, and it has to be: it is what the plugin's outcome cache keys on, so a redelivery of
    // this job re-reads the first run's outcome rather than launching a second container against
    // the same branch.
    idempotencyKey: prepared.changeObjectId,
    // The recorded head commit rides along ONLY when the delivery resolved to `auto_merge` — which
    // it can only do when that commit exists and a control passed for it. It is the merge
    // PRECONDITION the plugin sends to the provider, so a publish that moves the branch refuses to
    // merge rather than merging a tree the control never saw.
    parameters: buildBumpIntentParameters(prepared.recordInput, prepared.authoredHeadCommit)
  });

  // ---- PHASE 5 (record WHICH PULL REQUEST SCP OPENED) ----------------------------------------
  // The merge is later addressed to this number rather than found by listing open pull requests on
  // the branch — see `buildBumpMergeIntentParameters`. The only place the number exists is the
  // authoring run's own outcome, so it is ASKED for here (`trigger()` runs this class synchronously
  // to completion, so `status()` reports a finished run) and written to the server-owned authorship
  // row. Recording it is what makes "the pull request SCP itself opened" a fact on disk instead of a
  // search performed against a mutable provider.
  //
  // THE URL IS TAKEN FROM THE SAME OUTCOME, AND THIS IS THE ONLY MOMENT IT EXISTS. The plugin gets
  // it from the provider's own response (`html_url` on the created pull request, or on the one its
  // 422 retry path re-reads) and hands it back on the same `stateRef` as the number. Nothing
  // downstream can recover it: `repo` + number composes a working link for github.com and for
  // nothing else, and an outpost-local Gitea (M15) is both a different host AND a different path
  // segment. A consumer that synthesised one would render a confidently-broken link on every
  // Gitea-authored bump, so the honest value is captured here or not at all (migration 0066).
  // `recordBumpPullRequest` decides what is storable — this path does not repair or compose one.
  //
  // A FAILURE HERE IS NOT A FAILED BUMP. The pull request may well exist; what is missing is our
  // record of its number, and the consequence is that the merge gate refuses for lack of one — the
  // fail-closed direction. So it is logged and swallowed rather than thrown, exactly as the rest of
  // this per-declaration path treats a partial outcome.
  try {
    const status = await executor.status(ref);
    const outcome = status.stateRef as
      | { pullRequestNumber?: unknown; pullRequestUrl?: unknown }
      | undefined;
    const opened = outcome?.pullRequestNumber;
    if (typeof opened === "number" && Number.isInteger(opened) && opened > 0) {
      await withTenantTx(deps.db, orgId, (tx) =>
        recordBumpPullRequest(tx, orgId, prepared.changeObjectId, opened, outcome?.pullRequestUrl)
      );
    }
  } catch (err) {
    console.error(
      `[dependency-bump] could not record the pull request opened for change ${prepared.changeObjectId}:`,
      err
    );
  }

  input.outcome.dispatched.push({
    componentObjectId: candidate.componentObjectId,
    manifestPath: declaration.manifestPath,
    changeObjectId: prepared.changeObjectId,
    delivery: prepared.delivery.delivery
  });
}

// -------------------------------------------------------------------------------------------
// The loop
// -------------------------------------------------------------------------------------------

export interface BumpDispatchLoopHandle {
  stop(): Promise<void>;
}

/**
 * Register the capability's worker. Returns nothing the caller has to remember to wire: the ROUTER
 * is registered separately, by `events/domain-event-registry.ts` under `bumpDispatchRoleGuard` —
 * this same guard, by import rather than by copy — and a refused guard contributes NO router, so an
 * event is not even enqueued for a queue nothing will drain.
 *
 * A REFUSED ROLE RETURNS AN INERT HANDLE AND NEVER CREATES THE QUEUE — the same shape the version
 * poll, the internal-release loop and the inbox loop use, and for the same reason: a process that
 * merely skipped the work inside the handler would still hold a worker for a queue it will never
 * act on.
 */
export async function startBumpDispatchLoop(
  boss: PgBoss,
  deps: BumpDispatchLoopDeps
): Promise<BumpDispatchLoopHandle> {
  const guard = bumpDispatchRoleGuard(deps.config);
  if (!guard.allowed) {
    console.info(`[dependency-bump] not started: ${guard.reason}`);
    return { async stop() {} };
  }
  console.info(`[dependency-bump] STARTING: ${guard.reason}`);

  let stopped = false;
  const inFlight = new Set<Promise<unknown>>();
  await boss.createQueue(DEPENDENCY_BUMP_QUEUE);
  await boss.work<BumpDispatchJob>(DEPENDENCY_BUMP_QUEUE, async (jobs) => {
    for (const job of jobs) {
      if (stopped) return;
      try {
        const run = runBumpDispatchJob(deps, job.data);
        inFlight.add(run);
        const result = await run.finally(() => inFlight.delete(run));
        if (result.dispatched.length > 0) {
          console.info(
            `[dependency-bump] line ${job.data.lineId}: dispatched ${result.dispatched.length} bump(s)`
          );
        }
        for (const s of result.skipped) {
          console.info(
            `[dependency-bump] line ${job.data.lineId} component ${s.componentObjectId}: ${s.reason} — ${s.detail}`
          );
        }
      } catch (err) {
        // Per JOB, so one org's bad line cannot stop another's. Swallowed with a loud log rather
        // than rethrown: the derivation re-runs on the next advance, and a wedged queue would
        // silently stop every org's bumps.
        console.error(
          `[dependency-bump] line ${job.data.lineId} (org ${job.data.orgId}) failed:`,
          err
        );
      }
    }
  });
  return {
    async stop() {
      stopped = true;
      await Promise.allSettled([...inFlight]);
    }
  };
}
