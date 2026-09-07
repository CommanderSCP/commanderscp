import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AbortResult,
  Cursor,
  ExecutionStatus,
  ExecutorCapabilities,
  ExecutorEvent,
  ExecutorPlugin,
  ExternalRunRef,
  PluginContext,
  PluginManifest,
  TriggerIntent
} from "@scp/plugin-api";
import {
  MANAGED_RUN_TIMEOUT_MAX_MS,
  RUN_OUTCOME_CACHE_MAX_IN_MEMORY,
  boundDetail,
  MANAGED_RUN_TIMEOUT_MIN_MS,
  resolveRunnerLauncher,
  runnerOutcomeDetail,
  toRunnerRunId,
  pruneOutcomeMap,
  type BoundedDetail,
  type KubernetesLauncherSettings,
  type ResolveRunnerLauncher,
  // THE PORT'S OWN RESULT TYPE rather than an inline `{ succeeded, stdout, stderr }`: a structural
  // restatement of a union whose false arm REQUIRES a failure diagnosis is a restatement that drops
  // the diagnosis, and dropping it is the defect this plugin's failure `detail` was built out of.
  type RunnerResult
} from "@scp/runner-launcher";
import {
  coordinateRuleCandidates,
  isDependencyEcosystem,
  verifyManifestBump,
  type DependencyEcosystem,
  type ManifestBumpSpec
} from "./bump-edit.js";
import {
  resolveRepoWriter,
  type BumpDelivery,
  type MergeOutcome,
  type RepoWriter,
  type RepoWriteResult
} from "./repo-write.js";
import {
  assertBranchIsNotBase,
  assertWriteBaseBranch,
  assertWriteBranch,
  assertWriteCommit,
  assertWritePath,
  assertWriteRepo,
  locateVersionLine,
  verifyManifestOnlyEdit
} from "./write-guard.js";

/** `@scp/plugin-managed-dep` — the `scp-managed-dep` executor. See docs/plugins.md §273. */

export interface ManagedDepConfig {
  /** SERVER-INJECTED (never tenant): the vetted, pinned `scp-runner-dep` image reference. */
  runnerImage: string;
  /** SERVER-INJECTED (never tenant): operator root under which per-run scratch dirs are made. */
  workspaceRoot: string;
  /** ms before the container run is killed as hung (TENANT config). Default 5 minutes — a manifest
   *  edit is a text transform on one small file, so a run that takes longer is stuck, not busy. */
  timeoutMs?: number;
  /** The container CLI to spawn. See docs/plugins.md §274. */
  dockerBinary?: string;

  /** SERVER-INJECTED (never tenant). See docs/plugins.md §275. */
  runnerLauncher?: "docker" | "kubernetes";
  /** SERVER-INJECTED (never tenant): the Kubernetes launcher's deployment settings. Required when
   *  {@link runnerLauncher} is `"kubernetes"` — the resolver refuses BY NAME when it is missing,
   *  rather than producing a TypeError inside a half-built Job manifest. */
  kubernetes?: KubernetesLauncherSettings;

  // --- The git-provider identity (TENANT config — the App the component's team installed) --------
  /** Only `github` is implementable under the charter's credential clause today; see
   *  `resolveRepoWriter` for the refusal that says why. */
  provider?: string;
  appId?: string;
  installationId?: string;
  privateKeySecretKey?: string;
  privateKeyPem?: string;
  apiBaseUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/** `docker create --network <this>`. See docs/plugins.md §276. */
export const RUNNER_NETWORK_MODE = "none";

/** The branch prefix is part of the provenance contract. See docs/plugins.md §277. */
export const BUMP_BRANCH_PREFIX = "scp/dep-bump/";

/** The branch a bump for `changeObjectId` is authored on. Deterministic, so a retry converges. */
export function bumpBranchFor(changeObjectId: string): string {
  return `${BUMP_BRANCH_PREFIX}${changeObjectId}`;
}

/** Keys an intent may NOT carry. See docs/plugins.md §278. */
export const CONTENT_BEARING_KEYS = [
  "sourceFiles",
  "content",
  "contents",
  "patch",
  "diff",
  "files",
  "body",
  "script",
  "command"
] as const;

/** Which of the two acts an intent is asking for. Absent means `bump`, so every intent built before
 *  the merge action existed keeps its meaning — and a value this plugin does not know is REFUSED
 *  rather than defaulted, because defaulting an unknown action to the authoring one would silently
 *  edit a repository for a request that asked for something else. */
export type ManagedDepAction = "bump" | "merge";

/** What the SERVER's actuator seam sends. Every field is a reference to something that already
 *  exists, or a version token. Nothing here can hold a file body. */
export interface ManagedDepIntentParameters {
  action?: ManagedDepAction;
  ecosystem: DependencyEcosystem;
  coordinate: string;
  manifestPath: string;
  /** Every manifest path this component's inventory declares. A list of references to files that
   *  already exist — see `parseBumpDescriptor` for why it is required rather than defaulted. */
  declaredManifestPaths: string[];
  fromVersion: string;
  toVersion: string;
  /** `owner/repo` — the single repository this run's credential is scoped to. */
  repo: string;
  /** The branch the bump is based on and the pull request targets. */
  baseBranch: string;
  /** The originating bump change's object id. It becomes the branch name, which is what makes the
   *  returning webhook correlate to THAT change (see `BUMP_BRANCH_PREFIX`). */
  changeObjectId: string;
  /** Resolved by the server from the subscription merge AND, for `auto_merge`, from a passing
   *  governed control. This plugin never upgrades it. */
  delivery: BumpDelivery;
  /** The commit a governed control evidenced. REQUIRED for any merge — see
   *  `PublishBumpInput.expectedHeadCommit` and `MergeAuthoredBranchInput`. */
  expectedHeadCommit?: string;
  /** `action: "merge"` only — the pull request CommanderSCP itself opened for this bump, as the
   *  SERVER recorded it (`dependency_bump_authorships.pull_request_number`). The merge is addressed
   *  to this number rather than found by listing. */
  pullRequestNumber?: number;
}

export interface ParsedBumpDescriptor {
  spec: ManifestBumpSpec;
  repo: string;
  baseBranch: string;
  headBranch: string;
  declaredManifestPaths: string[];
  changeObjectId: string;
  delivery: BumpDelivery;
  expectedHeadCommit?: string;
}

/** What `action: "merge"` needs, and nothing more. No ecosystem, no manifest, no versions: a merge
 *  is not an edit and may not describe one. */
export interface ParsedMergeDescriptor {
  repo: string;
  baseBranch: string;
  headBranch: string;
  changeObjectId: string;
  expectedHeadCommit: string;
  pullRequestNumber: number;
  commitTitle: string;
}

/** The provider name descriptor-time refusals carry. The descriptor is validated before a provider
 *  arm is even resolved, and only the GitHub arm exists (`resolveRepoWriter`), so naming it here is
 *  accurate rather than a placeholder — and the SAME asserts run again inside the arm at the actual
 *  splice site, which is what the traversal matrix measures. */
const DESCRIPTOR_PROVIDER = "github";

/** NOTE ON WHAT IS *NOT* HERE. See docs/plugins.md §279. */

/** The content-bearing-key refusal, applied to EVERY action rather than to the one that happens to
 *  edit a file. A merge intent has no legitimate use for these keys either, and the channel ADR-0032
 *  §9 forbids is forbidden per-plugin, not per-code-path. */
function refuseContentBearingKeys(params: Record<string, unknown>): void {
  for (const key of CONTENT_BEARING_KEYS) {
    if (key in params) {
      throw new Error(
        `managed-dep: intent.parameters carries '${key}', which could hold authored file content. ` +
          "ADR-0032 §9 forbids that channel: this executor reads the manifest from the repository " +
          "itself and the isolated runner is what edits it."
      );
    }
  }
}

function requiredString(
  params: Record<string, unknown>,
  key: keyof ManagedDepIntentParameters
): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `managed-dep: intent.parameters.${key} is required and must be a non-empty string`
    );
  }
  return value;
}

/** The change id, validated as the thing it BECOMES — a branch name. Shared by both actions so the
 *  merge target is composed by exactly the rule the authoring run composed it by. */
function requiredChangeObjectId(params: Record<string, unknown>): string {
  const changeObjectId = requiredString(params, "changeObjectId");
  if (!/^[A-Za-z0-9-]{1,64}$/.test(changeObjectId)) {
    throw new Error(
      `managed-dep: changeObjectId '${changeObjectId}' is not an object id — it becomes the branch name, so it must be one`
    );
  }
  return changeObjectId;
}

/** Which act this intent asks for. See docs/plugins.md §280. */
export function parseIntentAction(intent: TriggerIntent): ManagedDepAction {
  const raw = (intent.parameters ?? {})["action" satisfies keyof ManagedDepIntentParameters];
  if (raw === undefined || raw === "bump") return "bump";
  if (raw === "merge") return "merge";
  throw new Error(
    `managed-dep: intent.parameters.action must be 'bump' or 'merge' (got ${JSON.stringify(raw)})`
  );
}

/** Turn an intent into a descriptor, or throw. See docs/plugins.md §281. */
export function parseBumpDescriptor(intent: TriggerIntent): ParsedBumpDescriptor {
  const params = (intent.parameters ?? {}) as Record<string, unknown>;

  refuseContentBearingKeys(params);

  const str = (key: keyof ManagedDepIntentParameters): string => requiredString(params, key);

  const ecosystem = str("ecosystem");
  if (!isDependencyEcosystem(ecosystem)) {
    throw new Error(
      `managed-dep: unknown ecosystem '${ecosystem}' (the runner image ships editors for go, oci, npm, python, maven)`
    );
  }
  const repo = str("repo");
  assertWriteRepo(DESCRIPTOR_PROVIDER, repo, 2);
  const manifestPath = str("manifestPath");
  assertWritePath(DESCRIPTOR_PROVIDER, manifestPath);
  const baseBranch = str("baseBranch");
  assertWriteBaseBranch(DESCRIPTOR_PROVIDER, baseBranch);

  // WHICH MANIFESTS THIS COMPONENT ACTUALLY DECLARES. See docs/plugins.md §282.
  const declared = params.declaredManifestPaths;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(
      "managed-dep: intent.parameters.declaredManifestPaths is required and must be a non-empty array of the manifest paths this component's inventory declares — the manifest-only verifier refuses a target the component does not declare, and defaulting it here would make that check agree with itself"
    );
  }
  const declaredManifestPaths = declared.map((value, i) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `managed-dep: intent.parameters.declaredManifestPaths[${i}] is not a non-empty string`
      );
    }
    assertWritePath(DESCRIPTOR_PROVIDER, value);
    return value;
  });
  if (!declaredManifestPaths.includes(manifestPath)) {
    throw new Error(
      `managed-dep: manifestPath '${manifestPath}' is not one of the manifest paths this component declares (${declaredManifestPaths.join(", ")}) — the edit must target a manifest the component already contains`
    );
  }

  const changeObjectId = requiredChangeObjectId(params);
  const fromVersion = str("fromVersion");
  const toVersion = str("toVersion");
  // A version token never spans lines or carries control bytes. See docs/plugins.md §283.
  for (const [label, value] of [
    ["fromVersion", fromVersion],
    ["toVersion", toVersion]
  ] as const) {
    // eslint-disable-next-line no-control-regex -- the point is to reject control characters
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(
        `managed-dep: ${label} contains a newline or control character — a declared version is one token on one line`
      );
    }
  }
  if (fromVersion === toVersion) {
    throw new Error(
      `managed-dep: fromVersion and toVersion are both '${fromVersion}' — there is no bump to author`
    );
  }
  const delivery = params.delivery;
  if (delivery !== "pull_request" && delivery !== "auto_merge") {
    throw new Error(
      `managed-dep: intent.parameters.delivery must be 'pull_request' or 'auto_merge' (got ${JSON.stringify(delivery)})`
    );
  }
  // A grant without a commit is refused at the descriptor. See docs/plugins.md §284.
  const expectedHeadCommit =
    delivery === "auto_merge" ? requiredString(params, "expectedHeadCommit") : undefined;
  if (expectedHeadCommit !== undefined) {
    assertWriteCommit(DESCRIPTOR_PROVIDER, expectedHeadCommit);
  }

  const headBranch = bumpBranchFor(changeObjectId);
  // Composed here, but asserted anyway: the prefix is a constant and the id is validated above, so
  // this can only fail if one of those changes — which is exactly when it should fail, rather than
  // at the splice site with a token already minted.
  assertWriteBranch(DESCRIPTOR_PROVIDER, headBranch);
  assertBranchIsNotBase(DESCRIPTOR_PROVIDER, headBranch, baseBranch);

  return {
    spec: {
      ecosystem,
      coordinate: str("coordinate"),
      manifestPath,
      fromVersion,
      toVersion
    },
    repo,
    baseBranch,
    headBranch,
    declaredManifestPaths,
    changeObjectId,
    delivery,
    ...(expectedHeadCommit ? { expectedHeadCommit } : {})
  };
}

/** Turns a merge intent into a descriptor, or throws. See docs/plugins.md §285. */
export function parseBumpMergeDescriptor(intent: TriggerIntent): ParsedMergeDescriptor {
  const params = (intent.parameters ?? {}) as Record<string, unknown>;
  refuseContentBearingKeys(params);

  const repo = requiredString(params, "repo");
  assertWriteRepo(DESCRIPTOR_PROVIDER, repo, 2);
  const baseBranch = requiredString(params, "baseBranch");
  assertWriteBaseBranch(DESCRIPTOR_PROVIDER, baseBranch);
  const changeObjectId = requiredChangeObjectId(params);
  const expectedHeadCommit = requiredString(params, "expectedHeadCommit");
  assertWriteCommit(DESCRIPTOR_PROVIDER, expectedHeadCommit);
  // A POSITIVE INTEGER, refused at the descriptor before a credential is minted. There is no
  // fallback to "find one": a merge intent that does not name the pull request SCP opened did not
  // come from the server's gate, and searching for a substitute is exactly the behaviour that let
  // provider list ordering decide what got merged.
  const pullRequestNumber = params.pullRequestNumber;
  if (
    typeof pullRequestNumber !== "number" ||
    !Number.isInteger(pullRequestNumber) ||
    pullRequestNumber <= 0
  ) {
    throw new Error(
      `managed-dep: intent.parameters.pullRequestNumber must be a positive integer (got ${JSON.stringify(pullRequestNumber)}) — a merge is addressed to the pull request CommanderSCP itself opened, never to whichever one a listing returns first`
    );
  }
  // Stated rather than implied: a merge intent that asks for `pull_request` delivery is a
  // contradiction, and treating it as "merge anyway" would make the field decorative.
  const delivery = params.delivery;
  if (delivery !== undefined && delivery !== "auto_merge") {
    throw new Error(
      `managed-dep: a merge intent's delivery must be 'auto_merge' (got ${JSON.stringify(delivery)}) — a merge is the actuation of that resolution, not an override of another one`
    );
  }

  const headBranch = bumpBranchFor(changeObjectId);
  assertWriteBranch(DESCRIPTOR_PROVIDER, headBranch);
  assertBranchIsNotBase(DESCRIPTOR_PROVIDER, headBranch, baseBranch);

  return {
    repo,
    baseBranch,
    headBranch,
    changeObjectId,
    expectedHeadCommit,
    pullRequestNumber,
    // DERIVED here, never passed in — same narrowing as `bumpCommitMessage`: the only strings this
    // class writes into somebody's repository are ones it composed itself.
    commitTitle: `chore(deps): merge SCP-authored bump ${changeObjectId}`
  };
}

function asConfig(config: unknown): ManagedDepConfig {
  const c = config as Partial<ManagedDepConfig> | undefined;
  if (!c?.runnerImage) {
    throw new Error(
      "managed-dep: runnerImage is not configured (server-governed — is dependency authoring enabled? SCP_MANAGED_DEP_RUNNER_IMAGE)"
    );
  }
  if (!c.workspaceRoot) {
    throw new Error("managed-dep: workspaceRoot is not configured (server-governed)");
  }
  return {
    ...c,
    runnerImage: c.runnerImage,
    workspaceRoot: c.workspaceRoot,
    timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    dockerBinary: c.dockerBinary ?? "docker",
    // CARRIED THROUGH THE NORMALISER, and its absence would have been silent: `asConfig` REBUILDS
    // the object field by field, so a server-injected key it does not name is dropped before the
    // resolver ever sees it — the launcher selection would have been accepted at every layer and
    // then discarded here.
    runnerLauncher: c.runnerLauncher,
    kubernetes: c.kubernetes
  };
}

// The runner container. See docs/plugins.md §286.

async function runEditorContainer(
  config: ManagedDepConfig,
  resolveLauncher: ResolveRunnerLauncher,
  /** This run's own key — see `RunnerSpec.runId` on why the CALLER supplies the identity. */
  runKey: string,
  spec: ManifestBumpSpec,
  inDir: string,
  outDir: string
): Promise<RunnerResult> {
  return resolveLauncher({
    dockerBinary: config.dockerBinary,
    runnerLauncher: config.runnerLauncher,
    kubernetes: config.kubernetes
  }).run({
    // The same key `externalId` is built from, so an orphan is traceable to the bump it was editing.
    runId: toRunnerRunId(runKey),
    // ATTRIBUTION FOR AN ORPHAN (M23.0 defect 1) — the only way an operator finds a container left
    // behind by a `create` that timed out after the daemon had already made it.
    labels: { "scp.executor": "scp-managed-dep", "scp.run-id": toRunnerRunId(runKey) },
    image: config.runnerImage,
    // The edit is described ENTIRELY on argv. See docs/plugins.md §287.
    operands: [
      spec.ecosystem,
      spec.manifestPath,
      spec.coordinate,
      spec.fromVersion,
      spec.toVersion,
      ...(spec.anchor ? [String(spec.anchor.line), spec.anchor.text] : [])
    ],
    // THE LITERAL, never a config read — see {@link RUNNER_NETWORK_MODE}.
    networkMode: RUNNER_NETWORK_MODE,
    // NO ENVIRONMENT AT ALL, SECRET OR OTHERWISE. The runner holds no credential — the orchestrator
    // does, on this side of the boundary (charter `scp-managed-dep`, amended 2026-08-15) — so both
    // lists are empty and no `--env-file` is ever written for this plugin.
    env: [],
    secretEnv: [],
    copyIn: [{ hostDir: inDir, containerPath: "/work/in" }],
    // Only on success. See docs/plugins.md §288.
    copyOut: {
      containerPath: "/work/out",
      hostDir: outDir,
      when: "on-success",
      onFailure: "propagate"
    },
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    // 8 MiB — the smallest of the three, because this runner edits one manifest and prints nothing.
    maxBuffer: 8 * 1024 * 1024
  });
}

interface RunOutcome {
  succeeded: boolean;
  /** {@link BoundedDetail}, NOT `string`. See docs/plugins.md §289. */
  detail: BoundedDetail;
  result?: RepoWriteResult;
  /** Set by the merge action. Reported through `status().stateRef` so the SERVER records what the
   *  provider actually did rather than what it asked for. */
  merge?: MergeOutcome;
}

/** Synchronous-trigger outcome cache, keyed by externalId. In-memory like managed-scan's: a bump is
 *  idempotent through its BRANCH (which carries the change id), so there is no cross-restart
 *  double-apply hazard of the kind managed-iac's durable statePath exists to prevent — a re-run
 *  converges on the same branch and the same pull request. */
const outcomes = new Map<string, RunOutcome>();

/** WHAT THE CODE BELOW COMPOSES. See docs/plugins.md §290. */
type PendingOutcome = Omit<RunOutcome, "detail"> & { detail: string };

/** THE ONLY WAY AN OUTCOME ENTERS THE CACHE. See docs/plugins.md §291. */
function recordOutcome(ctx: PluginContext, externalId: string, outcome: PendingOutcome): void {
  outcomes.set(externalId, { ...outcome, detail: boundDetail(outcome.detail) });
  const pruned = pruneOutcomeMap(outcomes, RUN_OUTCOME_CACHE_MAX_IN_MEMORY);
  if (pruned > 0) {
    ctx.logger.info("managed-dep: pruned the oldest outcome-cache entries", {
      pruned,
      kept: outcomes.size
    });
  }
}

/** Exported for tests only: the outcome cache is process-lifetime state, and a test that asserts a
 *  refusal must not be able to see a previous test's run. */
export function __resetManagedDepOutcomes(): void {
  outcomes.clear();
}

/** Exported for tests only. See docs/plugins.md §292. */
export function __managedDepStoredDetail(externalId: string): string | undefined {
  return outcomes.get(externalId)?.detail;
}

async function observe(_ctx: PluginContext, _since?: Cursor): Promise<ExecutorEvent[]> {
  // No push events. The bump SCP authors is observed back in through the component's OWN git
  // provider webhook, correlated to the originating change by branch name — deliberately, so the
  // provenance loop uses the ingress every other change uses rather than a private one.
  return [];
}

/** The merge half of `trigger()`. See docs/plugins.md §293. */
async function triggerMerge(
  ctx: PluginContext,
  intent: TriggerIntent,
  writerConfig: ManagedDepConfig,
  externalId: string
): Promise<void> {
  let descriptor: ParsedMergeDescriptor;
  try {
    descriptor = parseBumpMergeDescriptor(intent);
  } catch (err) {
    recordOutcome(ctx, externalId, {
      succeeded: false,
      detail: err instanceof Error ? err.message : String(err)
    });
    return;
  }

  let writer: RepoWriter;
  try {
    writer = resolveRepoWriter(writerConfig);
  } catch (err) {
    recordOutcome(ctx, externalId, {
      succeeded: false,
      detail: err instanceof Error ? err.message : String(err)
    });
    return;
  }

  try {
    const merge = await writer.withRunCredential(ctx, descriptor.repo, (session) =>
      session.mergeAuthoredBranch({
        target: {
          repo: descriptor.repo,
          baseBranch: descriptor.baseBranch,
          headBranch: descriptor.headBranch
        },
        pullRequestNumber: descriptor.pullRequestNumber,
        expectedHeadCommit: descriptor.expectedHeadCommit,
        commitTitle: descriptor.commitTitle
      })
    );
    recordOutcome(ctx, externalId, {
      // A PROVIDER REFUSAL IS A FAILED RUN, not a succeeded one with a note. The server records the
      // phase, and "the merge did not happen" must not read as "done".
      succeeded: merge.merged,
      merge,
      detail: merge.merged
        ? `managed-dep: merged pull request #${merge.pullRequestNumber} on '${descriptor.repo}' at the evidenced commit ${descriptor.expectedHeadCommit}`
        : `managed-dep: NOT merged — ${merge.mergeRefusal ?? "the provider refused"}`
    });
    ctx.logger.info("managed-dep: merge run complete", {
      externalId,
      repo: descriptor.repo,
      merged: merge.merged
    });
  } catch (err) {
    recordOutcome(ctx, externalId, {
      succeeded: false,
      detail: `managed-dep: ${err instanceof Error ? err.message : String(err)}`
    });
  }
}

async function trigger(
  ctx: PluginContext,
  intent: TriggerIntent,
  resolveLauncher: ResolveRunnerLauncher
): Promise<ExternalRunRef> {
  const config = asConfig(ctx.config);
  // THE BARE KEY, because it becomes a container NAME — see managed-scan's note of the same shape.
  const runKey = intent.idempotencyKey ?? `${Date.now()}`;
  const externalId = `managed-dep::${runKey}`;
  const cached = outcomes.get(externalId);
  if (cached) return { externalId };

  let action: ManagedDepAction;
  try {
    action = parseIntentAction(intent);
  } catch (err) {
    recordOutcome(ctx, externalId, {
      succeeded: false,
      detail: err instanceof Error ? err.message : String(err)
    });
    return { externalId };
  }
  if (action === "merge") {
    await triggerMerge(ctx, intent, config, externalId);
    return { externalId };
  }

  let descriptor: ParsedBumpDescriptor;
  try {
    descriptor = parseBumpDescriptor(intent);
  } catch (err) {
    recordOutcome(ctx, externalId, {
      succeeded: false,
      detail: err instanceof Error ? err.message : String(err)
    });
    return { externalId };
  }

  let writer: RepoWriter;
  try {
    writer = resolveRepoWriter(config);
  } catch (err) {
    recordOutcome(ctx, externalId, {
      succeeded: false,
      detail: err instanceof Error ? err.message : String(err)
    });
    return { externalId };
  }

  // LOW-6: `scratch` DECLARED OUTSIDE, INITIALISED INSIDE THE `try`. See docs/plugins.md §294.
  let scratch: string | undefined;
  const fileName = "manifest";

  try {
    await mkdir(config.workspaceRoot, { recursive: true });
    scratch = await mkdtemp(join(config.workspaceRoot, "scp-dep-"));
    const inDir = join(scratch, "in");
    const outDir = join(scratch, "out");
    const outcome = await writer.withRunCredential(ctx, descriptor.repo, async (session) => {
      // 1. READ the manifest as the repository holds it, with the run's own credential. The bytes
      //    never travelled through the intent — see "THE DESCRIPTOR IS NOT CONTENT".
      const original = await session.readFile(descriptor.spec.manifestPath, descriptor.baseBranch);
      if (original === undefined) {
        return {
          succeeded: false,
          detail: `managed-dep: '${descriptor.spec.manifestPath}' is not present on '${descriptor.repo}@${descriptor.baseBranch}' — refusing to edit a file this component does not contain`
        } satisfies PendingOutcome;
      }

      // Locate the version line from the bytes just read. See docs/plugins.md §295.
      const anchor = locateVersionLine(original.content, descriptor.spec);
      const spec: ManifestBumpSpec = anchor ? { ...descriptor.spec, anchor } : descriptor.spec;

      // The residue, named: no anchor and no qualifying line. See docs/plugins.md §296.
      const candidates = coordinateRuleCandidates(original.content.split("\n"), descriptor.spec);
      if (anchor === undefined && candidates.length === 0) {
        return {
          succeeded: false,
          detail:
            `managed-dep: REFUSED (anchor_not_derivable) — no line of '${descriptor.spec.manifestPath}' names both ` +
            `'${descriptor.spec.coordinate}' and '${descriptor.spec.fromVersion}', and the manifest's own parser did not ` +
            `resolve that declaration to a single line carrying it. The inventory row may be stale, or this file may ` +
            `declare the same image identically in more than one place, which has no single edit site. ` +
            `Nothing was written to '${descriptor.repo}' and no container was started.`
        } satisfies PendingOutcome;
      }

      // 2. EDIT, in the isolated single-shot runner. It gets the file and five argv strings (seven
      //    when an anchor is supplied); it has no network, no credential, and no package manager.
      await mkdir(inDir, { recursive: true });
      await mkdir(outDir, { recursive: true });
      await writeFile(join(inDir, fileName), original.content, "utf8");
      const run = await runEditorContainer(config, resolveLauncher, runKey, spec, inDir, outDir);
      if (!run.succeeded) {
        // `runnerOutcomeDetail`, NOT `run.stderr` — `promisify(execFile)` always attaches `stderr`
        // as a string, so for a budget-killed runner and for a `docker` that never spawned this
        // read `— ` and stopped. See `@scp/runner-launcher`'s `classifyRunnerFailure`.
        return {
          succeeded: false,
          // NOT `.slice(0, 2000)`. Like managed-scan's, that front-slice could never reach the
          // runner's last words at any output size: the port appended them behind `err.message`,
          // which carries the whole of stderr. Bounded at composition instead, END kept.
          detail: `managed-dep: the runner failed to edit '${descriptor.spec.manifestPath}' — ${runnerOutcomeDetail(run)}`
        } satisfies PendingOutcome;
      }

      let edited: string;
      try {
        edited = await readFile(join(outDir, fileName), "utf8");
      } catch {
        return {
          succeeded: false,
          detail: `managed-dep: the runner produced no '${fileName}' for '${descriptor.spec.manifestPath}'`
        } satisfies PendingOutcome;
      }

      // Verify before anything is written anywhere. See docs/plugins.md §297.
      const verdict = verifyManifestBump(original.content, edited, spec);
      if (!verdict.ok) {
        return {
          succeeded: false,
          // `verdict.detail` quotes MANIFEST TEXT the tenant supplied, so this refusal has no
          // length of its own — the one write in this file whose size a hostile input picks.
          detail: `managed-dep: REFUSED (${verdict.reason}) — ${verdict.detail}. Nothing was written to '${descriptor.repo}'.`
        } satisfies PendingOutcome;
      }

      // ...and only the second one MINTS. See docs/plugins.md §298.
      const proof = verifyManifestOnlyEdit({
        // WHERE these bytes are authorised to go, bound into the proof — see
        // `ManifestEditProof.repo`. `publishBump` re-checks both against the target it is about to
        // send to, so a proof cannot be re-aimed at another repository or at the base branch.
        repo: descriptor.repo,
        headBranch: descriptor.headBranch,
        path: descriptor.spec.manifestPath,
        declaredManifestPaths: descriptor.declaredManifestPaths,
        ecosystem: descriptor.spec.ecosystem,
        baseContent: original.content,
        newContent: verdict.after,
        coordinate: descriptor.spec.coordinate
      });

      // 4. PUBLISH. Branch, commit, pull request. See docs/plugins.md §299.
      const splitShape = anchor !== undefined && candidates.length === 0;
      const delivery = splitShape ? "pull_request" : descriptor.delivery;
      const result = await session.publishBump({
        target: {
          repo: descriptor.repo,
          baseBranch: descriptor.baseBranch,
          headBranch: descriptor.headBranch
        },
        spec,
        content: verdict.after,
        proof,
        delivery,
        ...(descriptor.expectedHeadCommit
          ? { expectedHeadCommit: descriptor.expectedHeadCommit }
          : {})
      });
      const downgraded =
        splitShape && descriptor.delivery === "auto_merge"
          ? " (delivered as a pull request, not auto-merged: the coordinate and the version are on" +
            " different lines, so which declaration was edited rests on the manifest parser and a" +
            " human reads the diff)"
          : "";
      return {
        succeeded: true,
        result,
        detail: result.merged
          ? `managed-dep: ${descriptor.spec.coordinate} ${descriptor.spec.fromVersion} -> ${descriptor.spec.toVersion} merged as ${result.commitSha} (#${result.pullRequestNumber})`
          : `managed-dep: ${descriptor.spec.coordinate} ${descriptor.spec.fromVersion} -> ${descriptor.spec.toVersion} opened as ${result.pullRequestUrl || `#${result.pullRequestNumber}`}${result.mergeRefusal ? ` — ${result.mergeRefusal}` : ""}${downgraded}`
      } satisfies PendingOutcome;
    });
    recordOutcome(ctx, externalId, outcome);
    ctx.logger.info("managed-dep: run complete", {
      externalId,
      repo: descriptor.repo,
      succeeded: outcome.succeeded
    });
  } catch (err) {
    recordOutcome(ctx, externalId, {
      succeeded: false,
      detail: `managed-dep: ${err instanceof Error ? err.message : String(err)}`
    });
  } finally {
    // `scratch` is `undefined` exactly when `mkdir`/`mkdtemp` themselves are what threw — nothing to
    // remove in that case.
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
  return { externalId };
}

async function status(_ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus> {
  const outcome = outcomes.get(ref.externalId);
  if (!outcome) {
    return {
      phase: "pending",
      detail: "managed-dep: unknown run (not found in local outcome cache)"
    };
  }
  return {
    phase: outcome.succeeded ? "succeeded" : "failed",
    // NO SLICE — bounded at capture (`RunOutcome.detail` is `BoundedDetail`), both ends kept.
    detail: outcome.detail,
    // The authored commit + pull request (or, for a merge run, what the provider actually did), so
    // the server can record the outcome without re-asking the provider.
    stateRef: outcome.result ?? outcome.merge,
    progress: 1
  };
}

async function abort(_ctx: PluginContext, _ref: ExternalRunRef): Promise<AbortResult> {
  // trigger() runs synchronously to completion. See docs/plugins.md §300.
  return {
    aborted: false,
    detail:
      "managed-dep: trigger() runs synchronously to completion; nothing left to abort (an opened pull request is closed by a human, never by this executor)"
  };
}

function describeCapabilities(): ExecutorCapabilities {
  return {
    supportsObserve: true,
    supportsTrigger: true,
    supportsAbort: true, // advertised for a well-formed answer; abort() always {aborted:false}
    triggerKinds: ["custom"]
  };
}

/** THE LAUNCHER SEAM. See docs/plugins.md §301. */
export function createManagedDepExecutorPlugin(
  // THE DEFAULT IS THE SELECTING RESOLVER, NOT THE DOCKER ONE. See docs/plugins.md §302.
  resolveLauncher: ResolveRunnerLauncher = resolveRunnerLauncher
): ExecutorPlugin {
  return {
    observe,
    trigger: (ctx, intent) => trigger(ctx, intent, resolveLauncher),
    status,
    abort,
    describeCapabilities
  };
}

export const managedDepExecutorPlugin: ExecutorPlugin = createManagedDepExecutorPlugin();

/** Manifest `configSchema` is the TENANT-facing surface ONLY. See docs/plugins.md §303. */
export const manifest: PluginManifest = {
  id: "managed-dep",
  kind: "executor",
  version: "0.1.0",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      provider: { type: "string", enum: ["github"] },
      appId: { type: "string", minLength: 1 },
      installationId: { type: "string", minLength: 1 },
      privateKeySecretKey: { type: "string", minLength: 1 },
      apiBaseUrl: { type: "string", minLength: 1 },
      // BOUNDED AT BOTH ENDS. See docs/plugins.md §304.
      timeoutMs: {
        type: "integer",
        minimum: MANAGED_RUN_TIMEOUT_MIN_MS,
        maximum: MANAGED_RUN_TIMEOUT_MAX_MS,
        default: DEFAULT_TIMEOUT_MS
      }
    }
  }
};

export * from "./bump-edit.js";
export * from "./write-guard.js";
export type {
  BumpDelivery,
  MergeAuthoredBranchInput,
  MergeOutcome,
  PublishBumpInput,
  RepoSession,
  RepoWriteResult,
  RepoWriter
} from "./repo-write.js";
export { bumpCommitMessage, bumpPullRequestBody, resolveRepoWriter } from "./repo-write.js";

export default managedDepExecutorPlugin;
