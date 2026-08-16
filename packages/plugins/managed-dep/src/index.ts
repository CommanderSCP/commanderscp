import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
  isDependencyEcosystem,
  verifyManifestBump,
  type DependencyEcosystem,
  type ManifestBumpSpec
} from "./bump-edit.js";
import {
  resolveRepoWriter,
  type BumpDelivery,
  type RepoWriter,
  type RepoWriteResult
} from "./repo-write.js";
import {
  assertBranchIsNotBase,
  assertWriteBaseBranch,
  assertWriteBranch,
  assertWritePath,
  assertWriteRepo,
  verifyManifestOnlyEdit
} from "./write-guard.js";

const execFileAsync = promisify(execFile);

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
 * AUTO-MERGE IS NOT DECIDED HERE
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
  /** SERVER-INJECTED (never tenant): `docker create --network <value>`, default `"none"`. The
   *  runner reaches no hosts; the ORCHESTRATOR holds the credential (see `repo-write.ts`). */
  networkMode: string;
  /** SERVER-INJECTED (never tenant): operator root under which per-run scratch dirs are made. */
  workspaceRoot: string;
  /** ms before the container run is killed as hung (TENANT config). Default 5 minutes — a manifest
   *  edit is a text transform on one small file, so a run that takes longer is stuck, not busy. */
  timeoutMs?: number;
  /** Override for tests only; default "docker". Server-injected in production. */
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
const DEFAULT_NETWORK_MODE = "none";

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

/** What the SERVER's actuator seam sends. Every field is a reference to something that already
 *  exists, or a version token. Nothing here can hold a file body. */
export interface ManagedDepIntentParameters {
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
}

export interface ParsedBumpDescriptor {
  spec: ManifestBumpSpec;
  repo: string;
  baseBranch: string;
  headBranch: string;
  declaredManifestPaths: string[];
  changeObjectId: string;
  delivery: BumpDelivery;
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

/**
 * Turn an intent into a descriptor, or throw. Every refusal below is a REFUSAL rather than a
 * fallback: a bump whose target cannot be stated precisely is a bump that must not happen, because
 * the alternative is guessing which declaration in somebody else's repository to rewrite.
 */
export function parseBumpDescriptor(intent: TriggerIntent): ParsedBumpDescriptor {
  const params = (intent.parameters ?? {}) as Record<string, unknown>;

  for (const key of CONTENT_BEARING_KEYS) {
    if (key in params) {
      throw new Error(
        `managed-dep: intent.parameters carries '${key}', which could hold authored file content. ` +
          "ADR-0032 §9 forbids that channel: this executor reads the manifest from the repository " +
          "itself and the isolated runner is what edits it."
      );
    }
  }

  const str = (key: keyof ManagedDepIntentParameters): string => {
    const value = params[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        `managed-dep: intent.parameters.${key} is required and must be a non-empty string`
      );
    }
    return value;
  };

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

  const changeObjectId = str("changeObjectId");
  if (!/^[A-Za-z0-9-]{1,64}$/.test(changeObjectId)) {
    throw new Error(
      `managed-dep: changeObjectId '${changeObjectId}' is not an object id — it becomes the branch name, so it must be one`
    );
  }
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
    delivery
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
    networkMode: c.networkMode ?? DEFAULT_NETWORK_MODE,
    timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    dockerBinary: c.dockerBinary ?? "docker"
  };
}

// -------------------------------------------------------------------------------------------
// The runner container — COPY the one manifest in, COPY the edited manifest out. Never a bind
// mount, never a docker socket, always the server-fixed `--network` (default `none`). Identical in
// shape to managed-iac/managed-scan's launch, for the identical reason (a host-path escape is
// structurally impossible when nothing is mounted).
// -------------------------------------------------------------------------------------------

async function runEditorContainer(
  config: ManagedDepConfig,
  spec: ManifestBumpSpec,
  inDir: string,
  outDir: string
): Promise<{ succeeded: boolean; stdout: string; stderr: string }> {
  const docker = config.dockerBinary ?? "docker";
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = 8 * 1024 * 1024;

  // The edit is described ENTIRELY on argv — five strings that name a declaration and a version.
  // Nothing on this command line can be a file body, a path outside the container, or a command.
  const { stdout: createOut } = await execFileAsync(
    docker,
    [
      "create",
      "--network",
      config.networkMode,
      config.runnerImage,
      spec.ecosystem,
      spec.manifestPath,
      spec.coordinate,
      spec.fromVersion,
      spec.toVersion
    ],
    { timeout, maxBuffer }
  );
  const containerId = createOut.trim();

  try {
    await execFileAsync(docker, ["cp", `${inDir}/.`, `${containerId}:/work/in`], {
      timeout,
      maxBuffer
    });

    let succeeded: boolean;
    let stdout: string;
    let stderr: string;
    try {
      const r = await execFileAsync(docker, ["start", "-a", containerId], { timeout, maxBuffer });
      succeeded = true;
      stdout = r.stdout;
      stderr = r.stderr;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      succeeded = false;
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? e.message;
    }

    if (succeeded) {
      await execFileAsync(docker, ["cp", `${containerId}:/work/out/.`, outDir], {
        timeout,
        maxBuffer
      });
    }
    return { succeeded, stdout, stderr };
  } finally {
    await execFileAsync(docker, ["rm", "-f", containerId], { timeout: 30_000 }).catch(
      () => undefined
    );
  }
}

// -------------------------------------------------------------------------------------------
// ExecutorPlugin — four verbs, no more.
// -------------------------------------------------------------------------------------------

interface RunOutcome {
  succeeded: boolean;
  detail: string;
  result?: RepoWriteResult;
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

async function trigger(ctx: PluginContext, intent: TriggerIntent): Promise<ExternalRunRef> {
  const config = asConfig(ctx.config);
  const externalId = `managed-dep::${intent.idempotencyKey ?? `${Date.now()}`}`;
  const cached = outcomes.get(externalId);
  if (cached) return { externalId };

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

  await mkdir(config.workspaceRoot, { recursive: true });
  const scratch = await mkdtemp(join(config.workspaceRoot, "scp-dep-"));
  const inDir = join(scratch, "in");
  const outDir = join(scratch, "out");
  const fileName = "manifest";

  try {
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

      // 2. EDIT, in the isolated single-shot runner. It gets the file and five argv strings; it has
      //    no network, no credential, and no package manager.
      await mkdir(inDir, { recursive: true });
      await mkdir(outDir, { recursive: true });
      await writeFile(join(inDir, fileName), original.content, "utf8");
      const run = await runEditorContainer(config, descriptor.spec, inDir, outDir);
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
      const verdict = verifyManifestBump(original.content, edited, descriptor.spec);
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
        path: descriptor.spec.manifestPath,
        declaredManifestPaths: descriptor.declaredManifestPaths,
        ecosystem: descriptor.spec.ecosystem,
        baseContent: original.content,
        newContent: verdict.after,
        coordinate: descriptor.spec.coordinate
      });

      // 4. PUBLISH. Branch, commit, pull request — and merge only when the server already decided.
      const result = await session.publishBump({
        target: {
          repo: descriptor.repo,
          baseBranch: descriptor.baseBranch,
          headBranch: descriptor.headBranch
        },
        spec: descriptor.spec,
        content: verdict.after,
        proof,
        delivery: descriptor.delivery
      });
      return {
        succeeded: true,
        result,
        detail: result.merged
          ? `managed-dep: ${descriptor.spec.coordinate} ${descriptor.spec.fromVersion} -> ${descriptor.spec.toVersion} merged as ${result.commitSha} (#${result.pullRequestNumber})`
          : `managed-dep: ${descriptor.spec.coordinate} ${descriptor.spec.fromVersion} -> ${descriptor.spec.toVersion} opened as ${result.pullRequestUrl || `#${result.pullRequestNumber}`}${result.mergeRefusal ? ` — ${result.mergeRefusal}` : ""}`
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
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
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
    // The authored commit + pull request, so the server can record what this run actually did
    // without re-asking the provider.
    stateRef: outcome.result,
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

export const managedDepExecutorPlugin: ExecutorPlugin = {
  observe,
  trigger,
  status,
  abort,
  describeCapabilities
};

export function createManagedDepExecutorPlugin(): ExecutorPlugin {
  return managedDepExecutorPlugin;
}

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
      timeoutMs: { type: "integer", minimum: 1000, default: DEFAULT_TIMEOUT_MS }
    }
  }
};

export * from "./bump-edit.js";
export * from "./write-guard.js";
export type {
  BumpDelivery,
  PublishBumpInput,
  RepoSession,
  RepoWriteResult,
  RepoWriter
} from "./repo-write.js";
export { bumpCommitMessage, bumpPullRequestBody, resolveRepoWriter } from "./repo-write.js";

export default managedDepExecutorPlugin;
