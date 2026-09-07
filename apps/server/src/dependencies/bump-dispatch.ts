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
  manifestIsEditableInThisBuild,
  recordBumpChange,
  resolveEffectiveDelivery,
  type DeliveryResolution
} from "./bump-actuator.js";
import {
  findOpenBumpAuthorship,
  recordBumpPullRequest,
  type BumpAuthorship
} from "./bump-authorship-repo.js";
import { checkBumpMergeFreeze, type BumpMergeFreezeVerdict } from "./bump-merge-freeze.js";
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
  isGitProviderModule,
  normalizeRepoIdentity
} from "./manifest-reader.js";

/** The thing that actually proposes and dispatches a bump. See docs/dependencies.md §79. */

export const DEPENDENCY_BUMP_QUEUE = "dependency-bump";

/** The `decisions.kind` every dispatch verdict is filed under — also the key
 *  `insertDecisionIfChanged` compares the previous verdict on, so it must be a constant. */
export const DEPENDENCY_BUMP_DECISION_KIND = "dependency_bump_dispatch";

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
      // No dedup option, and the comment that was here was false. See docs/dependencies.md §80.
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
  | "declaration_not_composable"
  /** A bump IS due, and the declaration is pinned by a DIGEST as well as by a version. Only the
   *  version text would be edited — the digest for the new release is known (`latest_digest`, moved
   *  by the same poll) but writing both is a TWO-LINE edit and the plugin's `verifyManifestBump`
   *  admits exactly one — and a container runtime resolves by digest whenever one is present. So
   *  the edit would change the manifest and NOT the image that runs: a pull request that reads as
   *  an upgrade, delivers nothing, and leaves the file saying two different things about which
   *  release it wants. Refused HERE, before a credential is minted (ADR-0032 §8i). */
  | "declaration_pinned_by_digest"
  /** A bump IS due, and this build's runner cannot author into a file of this KIND. Refused HERE so
   *  the reason is legible on the Decision, instead of after a container round trip that ends in the
   *  plugin's own `not_a_known_manifest` — which reads as a broken runner.
   *
   *  `values.yaml` used to be the case that exists and is no longer (M21.7 split-shape round): a
   *  chart's images are now writable, so what remains here is a genuinely unregistered file kind
   *  (`kustomization.yaml`, a `build.gradle`, a `Chart.yaml` subchart version). A values file whose
   *  particular declaration cannot be located is a different question and gets a different name —
   *  the plugin's `anchor_not_derivable`, which is decidable only with the file's bytes in hand. */
  | "manifest_not_editable_in_this_build";

export type BumpPlan =
  | {
      readonly due: true;
      /** What the manifest says today, VERBATIM — the string the runner replaces. */
      readonly fromVersion: string;
      /** What it must say afterwards, carrying the declaration's own prefix/suffix. */
      readonly toVersion: string;
    }
  | { readonly due: false; readonly reason: BumpRefusalReason; readonly detail: string };

/** Is a bump due for THIS declaration, and what would it say? See docs/dependencies.md §81. */
export function planBump(input: {
  line: Pick<DependencyLine, "ecosystem" | "major" | "tagPattern" | "latestVersion">;
  declaration: Pick<
    ComponentDependency,
    // `resolvedDigest` is REQUIRED rather than optional, and every caller states it — including
    // each test fixture, which is the point. An optional field would let a caller that never heard
    // of the digest rule opt out of it silently, and "absence is never permission" is the same rule
    // `declaredManifestPaths` is required by in the plugin.
    "declaredVersion" | "resolvedVersion" | "resolvedDigest" | "manifestPath"
  >;
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
  // A DECLARATION PINNED TWICE. See docs/dependencies.md §82.
  if (input.declaration.resolvedDigest !== null && input.declaration.resolvedDigest !== "") {
    return {
      due: false,
      reason: "declaration_pinned_by_digest",
      detail:
        `a bump from '${declared}' to '${toVersion}' is due, and this declaration is ALSO pinned by ` +
        `digest '${input.declaration.resolvedDigest}'. A container runtime resolves by digest whenever ` +
        `one is present, so moving the version alone would change '${input.declaration.manifestPath}' ` +
        `and not the image that runs — a pull request that reads as an upgrade and delivers nothing. ` +
        `Re-pin the digest together with the tag, or drop the digest from the declaration; the line is ` +
        `still inventoried and still polled, so '${head}' remains observed`
    };
  }
  // LAST, AND DELIBERATELY LAST. A bump that is not due needs no editability question answered, and
  // asking it earlier would replace an accurate "already at head" with a refusal about a file
  // nothing wanted to write. Asked HERE, the refusal appears exactly when it is the operative fact:
  // SCP can see the newer version, and this build cannot author the edit that would take it.
  if (!manifestIsEditableInThisBuild(input.line.ecosystem, input.declaration.manifestPath)) {
    return {
      due: false,
      reason: "manifest_not_editable_in_this_build",
      detail:
        `a bump from '${declared}' to '${toVersion}' is due, and '${input.declaration.manifestPath}' is not a ` +
        `${input.line.ecosystem} manifest this build's editor may write: the write allowlist is ` +
        `fail-closed and no bump is authored into a file kind it does not name. The declaration is ` +
        `still inventoried and still polled, so this line's head is observed — only the edit is refused`
    };
  }
  return { due: true, fromVersion: declared, toVersion };
}

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
  dispatched: {
    componentObjectId: string;
    manifestPath: string;
    changeObjectId: string;
    delivery: DependencySubscriptionDelivery;
  }[];
  /** Candidates that were considered and not dispatched, each with its own named cause. */
  skipped: { componentObjectId: string; manifestPath?: string; reason: string; detail: string }[];
}

/** Run ONE queued job. See docs/dependencies.md §83. */
export async function runBumpDispatchJob(
  deps: BumpDispatchLoopDeps,
  job: BumpDispatchJob
): Promise<BumpDispatchOutcome> {
  const outcome: BumpDispatchOutcome = { lineId: job.lineId, dispatched: [], skipped: [] };

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
      // The system actor, exactly as the two ingresses resolve. See docs/dependencies.md §84.
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
    // PLUGIN INSTANCES DERIVED FROM A WORK-LIST NEED A LIFECYCLE. See docs/dependencies.md §85.
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

  // One repository and ref for the dispatch, grouped for. See docs/dependencies.md §86.
  const sources = new Map<string, { repo: string | null; ref: string | null; paths: string[] }>();
  for (const { declaration } of dueDeclarations) {
    const key = JSON.stringify([declaration.observedRepo, declaration.observedRef]);
    const group = sources.get(key) ?? {
      repo: declaration.observedRepo,
      ref: declaration.observedRef,
      paths: []
    };
    group.paths.push(declaration.manifestPath);
    sources.set(key, group);
  }
  if (sources.size > 1) {
    const described = [...sources.values()]
      .map(
        (g) =>
          `${g.repo ?? "(no repository recorded)"}@${g.ref ?? "(no ref recorded)"} ` +
          `(${[...g.paths].sort().join(", ")})`
      )
      .sort()
      .join("; ");
    // Per declaration, so each refused manifest is named in the outcome rather than one of them
    // standing in for the rest.
    for (const { declaration } of dueDeclarations) {
      skip(
        "declarations_disagree_on_source",
        `this component's due declarations of this line were observed in more than one place — ` +
          `${described} — and a bump is only ever composed against the ref its manifest was read ` +
          `at. Nothing is authored until they agree`,
        declaration.manifestPath
      );
    }
    return;
  }
  const source = [...sources.values()][0]!;

  // AND THE BINDING MUST NAME THAT REPOSITORY. See docs/dependencies.md §87.
  if (source.repo !== null && normalizeRepoIdentity(repo) !== normalizeRepoIdentity(source.repo)) {
    skip(
      "git_binding_names_another_repository",
      `the manifest was observed in '${source.repo}' but this component's git binding names ` +
        `'${repo}', so the credential in hand is not authority over the repository being edited`
    );
    return;
  }

  // Phase two: provider I/O, outside any transaction. See docs/dependencies.md §88.
  const baseRef = source.ref;
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
    // A probe that could not read is not one that found none. See docs/dependencies.md §89.
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
      // Per declaration, so one refusal cannot stop another. See docs/dependencies.md §90.
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

  const prepared = await withTenantTx(deps.db, orgId, async (tx) => {
    // THE OTHER HALF OF THE DELEGATION REFUSAL — the stored verdict this job may have just written,
    // read back at the choke point immediately before SCP would write to the repository. It throws
    // a 409 carrying the probe's `decision_id`, which the caller records as this candidate's skip.
    await assertComponentNotDelegated(tx, orgId, candidate.componentObjectId);

    // Already proposed: a redelivery, or a second advance. See docs/dependencies.md §91.
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
    const granted: DeliveryResolution = await resolveEffectiveDelivery(tx, orgId, {
      changeObjectId,
      requested: candidate.delivery,
      repo: existing?.repo,
      authoredHeadCommit: existing?.headCommit
    });

    // M25.8 — THE FREEZE, AT THE SEAM WHERE THIS PATH CAN MERGE. See docs/dependencies.md §92.
    let mergeFreeze: BumpMergeFreezeVerdict | null = null;
    if (granted.delivery === "auto_merge") {
      mergeFreeze = await checkBumpMergeFreeze(tx, orgId, candidate.componentObjectId);
    }
    const delivery: DeliveryResolution = mergeFreeze
      ? { delivery: "pull_request", reason: mergeFreeze.reason }
      : granted;

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
        reused: existing !== undefined,
        // Absent when nothing is frozen, so the context matches. See docs/dependencies.md §93.
        ...(mergeFreeze ? { mergeDeferredByFreeze: mergeFreeze.freezes } : {})
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

  // Phase five: record which pull request was opened. See docs/dependencies.md §94.
  try {
    const status = await executor.status(ref);
    const outcome = status.stateRef as
      { pullRequestNumber?: unknown; pullRequestUrl?: unknown } | undefined;
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

export interface BumpDispatchLoopHandle {
  stop(): Promise<void>;
}

/** Register the capability's worker. See docs/dependencies.md §95. */
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
