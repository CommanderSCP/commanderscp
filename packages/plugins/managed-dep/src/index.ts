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
  MANAGED_RUN_TIMEOUT_MIN_MS,
  resolveDockerRunnerLauncher,
  toRunnerRunId,
  type ResolveRunnerLauncher
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

/**
 * `@scp/plugin-managed-dep` — the `scp-managed-dep` executor (charter Managed Execution Exception,
 * amendment approved 2026-08-13; ADR-0032 §8/§9; BUILD_AND_TEST.md M21.5). The THIRD managed
 * executor, and the first thing CommanderSCP has ever built that writes to a user's repository.
 *
 * It mirrors `@scp/plugin-managed-iac` and `@scp/plugin-managed-scan` in shape because the charter
 * names their shape: the standard four-verb executor interface, server-injected never-tenant runner
 * settings, a single-shot ephemeral runner from a separate pinned image, scoped vaulted credentials.
 *
 * ============================================================================================
 * WHAT THE CLASS IS, IN ONE SENTENCE, AND WHAT ENFORCES EACH HALF OF IT
 * ============================================================================================
 * "Editing the declared version of an already-declared dependency in a manifest the component
 * already contains" — and the enforcement is deliberately spread across three layers that fail in
 * different places, because a single layer is a single thing to get wrong:
 *
 *   * WHAT CAN BE RUN AT ALL — the runner image contains no package manager and no build toolchain,
 *     so "never runs a package manager, never resolves or regenerates a lockfile, and never builds,
 *     compiles, or tests" is a property of the image rather than of this code's restraint. The
 *     container is launched `--network none`, with no docker socket and no bind mount, so it can
 *     neither fetch a dependency graph nor reach a host.
 *   * WHAT MAY BE ASKED FOR — {@link parseBumpDescriptor} refuses an intent carrying anything that
 *     could be file content, and refuses a manifest path that is not a plain repo-relative path.
 *   * WHAT MAY BE PUSHED — `verifyManifestBump` (see `bump-edit.ts`) re-reads the runner's OUTPUT
 *     against its INPUT and refuses anything that is not exactly one declaration's version token
 *     changing. Nothing is written to the repository until that verdict is `ok`.
 *
 * ============================================================================================
 * THE VERB SET DOES NOT CHANGE (ADR-0032 §9, charter principle 1)
 * ============================================================================================
 * observe/trigger/status/abort, and no fifth verb. That set IS the structural enforcement of
 * "coordination, not execution": a `write()` verb would remove the enforcement mechanism rather than
 * extend it. What makes a repository write expressible without one is that a bump is an ordinary
 * `trigger()` — the same way an `apply` is for managed-iac and a scan is for managed-scan.
 *
 * ============================================================================================
 * THE DESCRIPTOR IS NOT CONTENT — WHICH IS THE DISTINCTION §9 ACTUALLY DRAWS
 * ============================================================================================
 * ADR-0032 §9 says: "Authored content is NOT threaded through `TriggerIntent.parameters` —
 * `managed-iac`'s `intent.parameters.sourceFiles` is not a precedent (nothing ever populates it, and
 * it writes to an ephemeral workspace, never a repo)."
 *
 * `intent.parameters` here carries a BUMP DESCRIPTOR and nothing else: which repository, which
 * manifest, which coordinate, what it declares today, what it should declare instead. Every one of
 * those names something that ALREADY EXISTS in the component's repository — they are a reference to
 * a declaration, not a body to write. `managed-scan`'s shipped `intent.parameters` is the same kind
 * of thing (method, inputDir, outputDir: all server-controlled descriptors of a job), and it is the
 * precedent this follows.
 *
 * That distinction is not left to good intentions. {@link CONTENT_BEARING_KEYS} is a fail-closed
 * refusal: an intent carrying `sourceFiles`, `content`, `patch`, `diff`, `files` or `body` is
 * REJECTED before anything is launched, so the channel §9 forbids cannot be opened later by a caller
 * that finds it convenient. The manifest's actual bytes never travel through the intent at all —
 * this plugin READS them from the repository itself, with the run's own credential.
 *
 * ============================================================================================
 * AUTO-MERGE IS NOT DECIDED HERE — BUT IT IS CONDITIONED HERE
 * ============================================================================================
 * "Automatic merge is permitted only where a governed control evidences that the component's own
 * checks passed" (charter; ADR-0032 §8: "expressed as a governed control so the existing gate
 * machinery decides, not new code").
 *
 * So this plugin does not look at CI. It receives `delivery` already resolved, and the server's
 * actuator seam is what refuses to pass `auto_merge` without a passing `control_runs` row for the
 * bump change (`apps/server/src/dependencies/bump-actuator.ts`). Putting the check here would be the
 * second gate ADR-0032 §8 forbids, and it would be the WEAKER of the two — a plugin cannot read
 * `control_runs`, so it would have had to re-ask the provider, which is a different question asked
 * of a different system at a different time than the one the gate machinery answered.
 *
 * What this plugin DOES enforce is the binding between that decision and a TREE. Every merge it
 * performs carries `expectedHeadCommit` as the provider's merge precondition, so the commit that
 * merges is the commit the control passed and no other. The decision is the server's; the guarantee
 * that it was actuated against what it was about is this file's.
 *
 * ============================================================================================
 * TWO ACTIONS, AND THE SECOND ONE IS WHAT MAKES AUTO-MERGE REACHABLE (M21.5, ADR-0032 §8c)
 * ============================================================================================
 * `action: "bump"` (the default) authors the edit and opens the pull request. `action: "merge"`
 * merges a pull request THIS class already authored, and nothing else — it never edits, never
 * pushes, and never opens a pull request that a human has since closed.
 *
 * They are separate because evidence names a commit and the authoring run CREATES that commit: at
 * the moment a bump is authored there is no commit for a control to have passed, so an authoring run
 * can only ever merge on evidence about something else. The server's gate job re-runs the governed
 * gate once the component's checks conclude on the authored commit and then dispatches the merge
 * action against exactly that commit.
 *
 * ============================================================================================
 * SYNCHRONOUS TRIGGER, exactly as both siblings
 * ============================================================================================
 * `trigger()` runs the container and completes the delivery before returning, so `status()` reports
 * a finished run from the outcome cache and `abort()` honestly reports that there is nothing left to
 * abort. Idempotency is the `idempotencyKey` cache PLUS the branch name: the branch carries the
 * originating change's id, so a retry that gets past the cache still converges on the same branch and
 * the same pull request rather than opening a second one.
 *
 * ============================================================================================
 * WHAT THIS INCREMENT DOES NOT SHIP
 * ============================================================================================
 * The `scp-runner-dep` IMAGE (`apps/runner-dep`) is not built here. This is the orchestrator half,
 * and it fails closed without the image exactly as `managed-iac` does without
 * `SCP_MANAGED_IAC_RUNNER_IMAGE`: with the setting unset, `resolveExecutorPluginInstance` throws
 * before a dispatch is possible. `applyManifestBump` in `bump-edit.ts` is the reference edit the
 * image's editor must agree with, and it is what this package's own tests use as a stand-in runner.
 */

export interface ManagedDepConfig {
  /** SERVER-INJECTED (never tenant): the vetted, pinned `scp-runner-dep` image reference. */
  runnerImage: string;
  /** SERVER-INJECTED (never tenant): operator root under which per-run scratch dirs are made. */
  workspaceRoot: string;
  /** ms before the container run is killed as hung (TENANT config). Default 5 minutes — a manifest
   *  edit is a text transform on one small file, so a run that takes longer is stuck, not busy. */
  timeoutMs?: number;
  /**
   * The container CLI to spawn. Defaults to `"docker"`, resolved on the subprocess's PATH, and
   * SERVER-INJECTED IN PRODUCTION from `SCP_MANAGED_RUNNER_DOCKER_BINARY` — the operator-governed
   * knob that lets a deployment run rootless podman instead, which is the sanctioned runtime on the
   * RHEL/air-gapped estates this class ships into (docs/container-runtimes.md).
   *
   * THE HISTORY IS WORTH KEEPING, because it is the shape of the bug rather than a war story. This
   * comment previously said "NOTHING SETS IT IN PRODUCTION — a test/fixture seam", and that was
   * accurate: `managedDepServerSettings` injected `runnerImage` and `workspaceRoot` and nothing
   * else, on BOTH of this class's construction paths, while its two sibling managed classes
   * injected the binary correctly. The gap had been NOTICED — an earlier edit corrected this
   * comment from "Server-injected in production" to describe the hole — but the comment was
   * corrected to match the broken behaviour instead of the behaviour being fixed, which left an
   * operator's `podman` silently applying to two managed classes out of three, and left the
   * defence-in-depth argument in `managedRunnerDockerBinary`'s doc ("the two defences now fail
   * independently") untrue for this one. Wired 2026-08-16; both paths are pinned by tests
   * (`routes/executors.integration.test.ts` for the hand-made binding,
   * `dependencies/bump-dispatch.integration.test.ts` for the ordinary binding-free dispatch).
   *
   * A TENANT still cannot set it: the manifest at the bottom of this file is
   * `additionalProperties: false` with `dockerBinary` absent, so a binding carrying it is rejected
   * at create/update by `routes/executors.ts` (`plugin-manifests-managed-dep.test.ts` pins that
   * refusal by name). The write door refuses it and the server overwrites it — two independent
   * defences, which is the point.
   */
  dockerBinary?: string;

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

/**
 * `docker create --network <this>` — A LITERAL, NOT A DEFAULT, AND THE DIFFERENCE IS THE CHARTER.
 *
 * The 2026-08-15 amendment says, of this class and without qualification: "Runner network egress is
 * `--network none`; the runner holds no credential, contains no package manager, and edits only the
 * bytes handed to it." Compare `scp-managed-scan`, whose otherwise-identical clause the 2026-07-23
 * amendment DOES qualify ("excepting operator-allowlisted registry pulls for the subject artifact's
 * bytes") — which is why that class reads an operator setting and this one must not.
 *
 * This was briefly built as a server-injected `networkMode` with a `"none"` default, read from
 * `SCP_MANAGED_DEP_NETWORK_MODE`. A default is a value an operator may change, and an
 * operator-settable knob is an operator-facing way to contradict an unqualified charter clause —
 * "the runner reaches no hosts" would have been true of the shipped default and false of a
 * deployment. There is nothing to configure here, so there is no configuration for it: the setting
 * is gone from the plugin manifest, from `ManagedDepConfig`, and from
 * `coordination/executor-bindings-repo.ts`'s `managedDepServerSettings`.
 *
 * Exported so `runner-containment.test.ts` can assert the launched argv rather than this constant.
 */
export const RUNNER_NETWORK_MODE = "none";

/**
 * THE BRANCH PREFIX IS PART OF THE PROVENANCE CONTRACT, not cosmetics.
 *
 * The server's correlation half (`apps/server/src/coordination/correlation.ts`'s
 * `matchAuthoredBumpChange`) recognises a returning push by this prefix plus the change id that
 * follows it, and then REQUIRES the named change to claim that same repo and ref before it will
 * attach anything. Both halves read this constant, so the two cannot drift into disagreeing about
 * what an authored branch looks like.
 */
export const BUMP_BRANCH_PREFIX = "scp/dep-bump/";

/** The branch a bump for `changeObjectId` is authored on. Deterministic, so a retry converges. */
export function bumpBranchFor(changeObjectId: string): string {
  return `${BUMP_BRANCH_PREFIX}${changeObjectId}`;
}

/**
 * Keys an intent may NOT carry. This is the enforcement of ADR-0032 §9's "authored content is not
 * threaded through `TriggerIntent.parameters`": the channel is refused rather than merely unused, so
 * a later caller cannot open it by populating a field nobody removed.
 *
 * `sourceFiles` is named explicitly because it is the exact field §9 calls out as NOT a precedent.
 */
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

/**
 * NOTE ON WHAT IS *NOT* HERE. This file used to carry its own `isSafeRepo`/`isSafeManifestPath`/
 * `isSafeBranch` predicates. They are gone, and the descriptor is validated with the SHARED asserts
 * (`write-guard.ts`, delegating to `@scp/git-provider-core`'s `assertSafeRepo`/`assertSafeRepoPath`/
 * `assertSafeRef`) instead.
 *
 * That is not tidying. A second, subtly-different validator for the same property is precisely the
 * mistake that produced M21.2's two proven holes — the fix was applied to one instance instead of to
 * the class — and the local predicates were already drifting: `isSafeBranch` allowed `HEAD` and a
 * `refs/heads/…` prefix, and `isSafeRepo` accepted a repo the shared assert's charset would have
 * refused nothing about but whose segment-count rule it states explicitly. One rule, one place, and
 * the same one the write itself re-applies at the splice site.
 */

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

/**
 * Which act this intent asks for. `undefined` is `bump` (every intent built before the merge action
 * existed), and anything else is REFUSED — an unrecognised action must never fall through to the
 * one that writes a commit.
 */
export function parseIntentAction(intent: TriggerIntent): ManagedDepAction {
  const raw = (intent.parameters ?? {})["action" satisfies keyof ManagedDepIntentParameters];
  if (raw === undefined || raw === "bump") return "bump";
  if (raw === "merge") return "merge";
  throw new Error(
    `managed-dep: intent.parameters.action must be 'bump' or 'merge' (got ${JSON.stringify(raw)})`
  );
}

/**
 * Turn an intent into a descriptor, or throw. Every refusal below is a REFUSAL rather than a
 * fallback: a bump whose target cannot be stated precisely is a bump that must not happen, because
 * the alternative is guessing which declaration in somebody else's repository to rewrite.
 */
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

  // WHICH MANIFESTS THIS COMPONENT ACTUALLY DECLARES (ADR-0032 §3 projection rows), sent by the
  // server's actuator seam. It is a list of REFERENCES to files that already exist, not content —
  // the same category as `manifestPath` itself.
  //
  // It is REQUIRED rather than defaulted, and that is the whole point of it: `verifyManifestOnlyEdit`
  // refuses a target the component does not declare, and a default of `[manifestPath]` would make
  // that gate agree with itself and pass vacuously. Absence is never permission.
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
  // A version TOKEN never spans lines and never carries control characters. This matters because
  // `toVersion` is the one descriptor field derived from a THIRD-PARTY VERSION INDEX (ADR-0032 §7):
  // a newline in it would turn a one-line edit into a multi-line one, which is a shape the class
  // does not have. This is the cheap half of the defence — `verifyManifestBump`'s reconstruction and
  // JSON key-set comparison are what actually catch a token carrying manifest SYNTAX, and
  // `bump-edit.test.ts` pins both injections.
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
  // A GRANT WITHOUT A COMMIT IS REFUSED AT THE DESCRIPTOR, before a credential is minted. The server
  // only ever resolves `auto_merge` from a control run whose evidence names the bump's own head
  // commit, so an `auto_merge` intent that carries no commit did not come from that resolution —
  // and merging on it would merge whatever the branch is at, which is the fail-open the whole
  // evidence chain exists to close.
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

/**
 * Turn a `action: "merge"` intent into a merge descriptor, or throw.
 *
 * WHAT IS DELIBERATELY NOT READABLE FROM THIS INTENT: a head branch. It is COMPOSED from
 * `changeObjectId` by {@link bumpBranchFor} — the same function the authoring run used — so the only
 * branch this action can ever merge is the branch a bump of that change authored. A caller-supplied
 * branch name would turn the narrowest write in the tree into "merge whatever you are told to",
 * which is precisely the widening the charter amendment does not grant.
 *
 * `expectedHeadCommit` is required and full-length. It is the merge precondition, and the server
 * takes it from `dependency_bump_authorships.head_commit` — SERVER-OWNED storage of what SCP's own
 * branch is at, written when the authored push came back through the two-sided branch check — never
 * from `changes.source_ref`, which any authenticated principal can write, and never from anything the
 * payload of this intent asserts about the world.
 *
 * `pullRequestNumber` is required for the same reason and closes a wider hole: without it this action
 * LISTED open pull requests on the head branch and merged the first one, so provider ordering chose
 * what got merged and no base was ever compared. The server records the number when SCP's own
 * authoring run reports the pull request it opened; the write path then re-reads that pull request
 * and refuses unless its state, head and base all still match the grant.
 */
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
    dockerBinary: c.dockerBinary ?? "docker"
  };
}

// -------------------------------------------------------------------------------------------
// The runner container — COPY the one manifest in, COPY the edited manifest out. Never a bind
// mount, never a docker socket, always `--network none`. Identical in shape to
// managed-iac/managed-scan's launch, for the identical reason (a host-path escape is structurally
// impossible when nothing is mounted) — and since M23.1 that shape is literally the same code:
// `@scp/runner-launcher`, the one port all three managed executors launch through.
//
// WHAT DID NOT MOVE INTO THE PORT, AND MUST NOT: the network mode. It is passed from here as the
// LITERAL {@link RUNNER_NETWORK_MODE}, so the charter clause and the value it fixes stay in the same
// file. A port that read `config.networkMode` uniformly for all three callers would turn an
// unqualified charter clause into an operator-settable default; the golden's third case names a
// different mode in the context and still requires `none` on the command line.
// -------------------------------------------------------------------------------------------

async function runEditorContainer(
  config: ManagedDepConfig,
  resolveLauncher: ResolveRunnerLauncher,
  /** This run's own key — see `RunnerSpec.runId` on why the CALLER supplies the identity. */
  runKey: string,
  spec: ManifestBumpSpec,
  inDir: string,
  outDir: string
): Promise<{ succeeded: boolean; stdout: string; stderr: string }> {
  return resolveLauncher({ dockerBinary: config.dockerBinary }).run({
    // The same key `externalId` is built from, so an orphan is traceable to the bump it was editing.
    runId: toRunnerRunId(runKey),
    // ATTRIBUTION FOR AN ORPHAN (M23.0 defect 1) — the only way an operator finds a container left
    // behind by a `create` that timed out after the daemon had already made it.
    labels: { "scp.executor": "scp-managed-dep", "scp.run-id": toRunnerRunId(runKey) },
    image: config.runnerImage,
    // The edit is described ENTIRELY on argv — five strings that name a declaration and a version,
    // plus (M21.7, split shapes only) the two that name WHICH LINE carries it. Nothing here can be a
    // file body, a path outside the container, or a command: the anchor text is one line the
    // container already has in the file it was handed, and the shim only ever COMPARES it.
    //
    // THE PAIR IS APPENDED ONLY WHEN THERE IS AN ANCHOR, which is what makes version skew
    // fail-closed in both directions (`run.sh`'s argv contract): a five-operand invocation is
    // byte-for-byte the one every previously-shipped image understands, and an image that predates
    // the anchor ignores the extra two and refuses the split shape it could not have edited anyway.
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
    // Only on success — there is nothing to salvage from a runner that did not finish the edit, and
    // copying out a partial manifest would put unverified bytes where the verifiers read from. Not
    // guarded either: `trigger()`'s outer catch is what turns a failed copy-out into a `failed` run
    // (managed-scan's escapes its `trigger()`; managed-iac's is swallowed — three answers to one
    // Docker failure, all three pinned by goldens).
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

// -------------------------------------------------------------------------------------------
// ExecutorPlugin — four verbs, no more.
// -------------------------------------------------------------------------------------------

interface RunOutcome {
  succeeded: boolean;
  detail: string;
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

/** Exported for tests only: the outcome cache is process-lifetime state, and a test that asserts a
 *  refusal must not be able to see a previous test's run. */
export function __resetManagedDepOutcomes(): void {
  outcomes.clear();
}

async function observe(_ctx: PluginContext, _since?: Cursor): Promise<ExecutorEvent[]> {
  // No push events. The bump SCP authors is observed back in through the component's OWN git
  // provider webhook, correlated to the originating change by branch name — deliberately, so the
  // provenance loop uses the ingress every other change uses rather than a private one.
  return [];
}

/**
 * The merge half of `trigger()`. Separate because it has NO workspace, NO container, and NO edit:
 * it mints the run credential, merges the pull request the bump already opened, and revokes it.
 *
 * The runner is not involved at all, and that is correct rather than an omission — the runner exists
 * to perform an offline text edit, and there is no text here.
 */
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
    outcomes.set(externalId, {
      succeeded: false,
      detail: err instanceof Error ? err.message : String(err)
    });
    return;
  }

  let writer: RepoWriter;
  try {
    writer = resolveRepoWriter(writerConfig);
  } catch (err) {
    outcomes.set(externalId, {
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
    outcomes.set(externalId, {
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
    outcomes.set(externalId, {
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
    outcomes.set(externalId, {
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
    outcomes.set(externalId, {
      succeeded: false,
      detail: err instanceof Error ? err.message : String(err)
    });
    return { externalId };
  }

  let writer: RepoWriter;
  try {
    writer = resolveRepoWriter(config);
  } catch (err) {
    outcomes.set(externalId, {
      succeeded: false,
      detail: err instanceof Error ? err.message : String(err)
    });
    return { externalId };
  }

  // LOW-6: `scratch` DECLARED OUTSIDE, INITIALISED INSIDE THE `try` — `mkdir`/`mkdtemp` used to run
  // BEFORE this `try` began, so a disk error here (permissions, ENOSPC) rejected `trigger()`
  // UNRECORDED: no `outcomes.set(externalId, …)`, and the caller's `status()` would report `pending`
  // forever. Moving them inside closes it the same way the descriptor/writer refusals above already
  // are; the `finally` below is `undefined`-safe for the case where `mkdtemp` itself is what failed.
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
        } satisfies RunOutcome;
      }

      // 1b. LOCATE THE VERSION LINE, from the bytes just read (M21.7, split shapes).
      //
      //     Derived HERE and spent immediately, against the very same string: an anchor captured at
      //     ingestion and spent at actuation would be a line number taken from a read at one ref and
      //     applied to a read at another, which is a confidently wrong edit rather than a refused
      //     one. `locateVersionLine` never throws and returns `undefined` freely — its ABSENCE is
      //     not an error, it just means the coordinate rule runs exactly as it always has.
      //
      //     AN ANCHOR IS DERIVED HERE FOR MORE THAN THE NEW SHAPE, and saying otherwise would be a
      //     comment asserting a property this code does not have: `go`, `python`'s
      //     `requirements*.txt` and `oci`'s Dockerfile all anchor, because their parsers report the
      //     line that carries the version. What keeps them unchanged is not the absence of an
      //     anchor but clause (c) of `verifyManifestBump` — those parsers read the coordinate off
      //     that same line, so the anchor is itself a coordinate-rule candidate and the veto admits
      //     it only where the unanchored rule would have chosen it anyway. The ecosystems that
      //     genuinely yield NO anchor are `npm` and `pyproject.toml` (their parsers report no line
      //     at all) and `maven` (`pom-xml.ts` reports the `<dependency>` open-tag line, which does
      //     not carry the version, so step 4 refuses it).
      const anchor = locateVersionLine(original.content, descriptor.spec);
      const spec: ManifestBumpSpec = anchor ? { ...descriptor.spec, anchor } : descriptor.spec;

      // 1c. THE RESIDUE, NAMED. With no anchor AND no line naming both the coordinate and the
      //     declared version, neither selector has an answer and the runner would exit 3 — a
      //     container round trip whose only product is "the runner failed", which reads as a broken
      //     image rather than as a stale inventory row or a declaration pinned identically twice.
      //     Refused here instead, with its own name (ADR-0032 §7b clause 6: a reason names its own
      //     cause). This MEASURES the coordinate rule, it does not author with it — the runner is
      //     still the only thing that produces bytes.
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
        } satisfies RunOutcome;
      }

      // 2. EDIT, in the isolated single-shot runner. It gets the file and five argv strings (seven
      //    when an anchor is supplied); it has no network, no credential, and no package manager.
      await mkdir(inDir, { recursive: true });
      await mkdir(outDir, { recursive: true });
      await writeFile(join(inDir, fileName), original.content, "utf8");
      const run = await runEditorContainer(config, resolveLauncher, runKey, spec, inDir, outDir);
      if (!run.succeeded) {
        return {
          succeeded: false,
          detail: `managed-dep: the runner failed to edit '${descriptor.spec.manifestPath}' — ${run.stderr.slice(0, 2000)}`
        } satisfies RunOutcome;
      }

      let edited: string;
      try {
        edited = await readFile(join(outDir, fileName), "utf8");
      } catch {
        return {
          succeeded: false,
          detail: `managed-dep: the runner produced no '${fileName}' for '${descriptor.spec.manifestPath}'`
        } satisfies RunOutcome;
      }

      // 3. VERIFY before anything is written anywhere. This is the charter's "never authors any
      //    other content, never adds or removes a dependency" as an executable refusal.
      //
      //    TWO verifiers, and they are not redundant. `verifyManifestBump` is TEXTUAL and anchored
      //    on the descriptor: does replacing `fromVersion` with `toVersion` on the one changed line
      //    reproduce the runner's output exactly? `verifyManifestOnlyEdit` (write-guard.ts) is a
      //    PARSE anchored on the document: is the declared dependency SET identical, did exactly one
      //    already-declared version move, and is the textual change confined to that version's own
      //    text? Each catches what the other structurally cannot — the second is what survives a
      //    minified `package.json`, where "bump react AND add a postinstall script" is one line's
      //    worth of change and the textual test alone would pass it.
      const verdict = verifyManifestBump(original.content, edited, spec);
      if (!verdict.ok) {
        return {
          succeeded: false,
          detail: `managed-dep: REFUSED (${verdict.reason}) — ${verdict.detail}. Nothing was written to '${descriptor.repo}'.`
        } satisfies RunOutcome;
      }

      //    ...and only the second one MINTS. The proof is an HMAC over these exact bytes at this
      //    exact path, under a key no other module holds, and `publishBump` re-checks it before any
      //    request. That is what makes the guarantee structural rather than procedural: bytes that
      //    did not pass verification cannot reach a repository, because there is no way to call the
      //    write without a proof and no way to obtain a proof except by passing.
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

      // 4. PUBLISH. Branch, commit, pull request — and merge only when the server already decided.
      //
      //    D2 (`split-shape-image-bumps.md` §9): A SPLIT-SHAPE BUMP IS PULL-REQUEST-ONLY THIS ROUND,
      //    whatever the subscription resolved to. "Split shape" is not a guess about the format — it
      //    is exactly the condition under which the widening did any work: an anchor was used AND no
      //    line of the file named both the coordinate and the declared version, so the binding
      //    between the edited line and the coordinate came from the parser's association of a `tag`
      //    scalar with its sibling `repository` rather than from the bytes. Write-guard gate 6
      //    catches a wrong SELECTION; a wrong ASSOCIATION is common-mode with that gate's own parser
      //    and is not caught, so a human on the diff is the control for it (§4, residual risk).
      //
      //    This only ever DOWNGRADES. The plugin never upgrades a delivery — that decision is the
      //    server's governed one — and a downgrade cannot make an unauthorised write reachable.
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
      } satisfies RunOutcome;
    });
    outcomes.set(externalId, outcome);
    ctx.logger.info("managed-dep: run complete", {
      externalId,
      repo: descriptor.repo,
      succeeded: outcome.succeeded
    });
  } catch (err) {
    outcomes.set(externalId, {
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
    detail: outcome.detail.slice(0, 4000),
    // The authored commit + pull request (or, for a merge run, what the provider actually did), so
    // the server can record the outcome without re-asking the provider.
    stateRef: outcome.result ?? outcome.merge,
    progress: 1
  };
}

async function abort(_ctx: PluginContext, _ref: ExternalRunRef): Promise<AbortResult> {
  // trigger() runs synchronously to completion — by the time a caller holds a ref, the container has
  // exited and the pull request either exists or does not. Honestly reported, never silently
  // ignored. Note what abort deliberately does NOT do: it does not close or revert a pull request
  // SCP opened. That is a repository write nobody asked for, and undoing a proposal is a human's
  // call.
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

/**
 * THE LAUNCHER SEAM (M23.1). `resolveLauncher` defaults to the Docker adapter — the only one that
 * exists until M23.2 — and is a FACTORY PARAMETER rather than a config field on purpose: adapter
 * selection is not tenant-facing, and any new config field would have to join the server-injected,
 * never-tenant-settable class in all three enforcement layers (this manifest's `configSchema`, the
 * four `validatePluginConfig` write doors, and the LAST-wins injection sites) on day one. Note what
 * the seam does NOT carry: the network mode, which this class fixes as a literal rather than a
 * setting (ADR-0032 §8d).
 */
export function createManagedDepExecutorPlugin(
  resolveLauncher: ResolveRunnerLauncher = resolveDockerRunnerLauncher
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

/**
 * Manifest `configSchema` is the TENANT-facing surface ONLY. `additionalProperties: false`, and the
 * server-governed `runnerImage`/`networkMode`/`workspaceRoot` are absent from it — so a binding that
 * tries to set what image runs, on what network, or against what directory is REJECTED at
 * create/update by `routes/executors.ts`'s config validation. The server injects those three itself
 * (`coordination/executor-bindings-repo.ts`'s `managedDepServerSettings`, spread LAST so they win).
 *
 * What a tenant DOES configure is the git-provider identity — the App their team installed on their
 * own repository — plus a timeout. That is the same trust split `@scp/plugin-github` already has.
 */
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
      // BOUNDED AT BOTH ENDS (M23.1c). The `maximum` is the half that was missing: with only a
      // floor, a tenant could set 2^31 and make the runner unkillable by its own timeout AND
      // unbound the plugin-host RPC budget derived from it. Enforced at every write door by
      // `validatePluginConfig` (Ajv honours `maximum`), and clamped again host-side for rows
      // stored before the ceiling existed.
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
