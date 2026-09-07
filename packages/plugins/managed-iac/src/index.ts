import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createFileBackedJsonCache } from "@scp/plugin-api";
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
  RUN_OUTCOME_CACHE_MAX_DURABLE,
  boundDetail,
  MANAGED_RUN_TIMEOUT_MIN_MS,
  resolveRunnerLauncher,
  runnerOutcomeDetail,
  toRunnerRunId,
  withRecordedOutcome,
  pruneOutcomeRecord,
  type BoundedDetail,
  type KubernetesLauncherSettings,
  type ResolveRunnerLauncher,
  type RunnerResult
} from "@scp/runner-launcher";

/** `@scp/plugin-managed-iac` — the `scp-managed-iac` executor. See docs/plugins.md §416. */

export interface ManagedIacConfig {
  /** SERVER-INJECTED (never tenant): the vetted, pinned `scp-runner-iac` image reference. */
  runnerImage: string;
  /** SERVER-INJECTED (never tenant): the operator's root directory under which this plugin
   *  derives a per-(org, target) workspace. The tenant cannot influence the path. */
  workspaceRoot: string;
  /** SERVER-INJECTED (never tenant): `docker create --network <value>`, default `"none"`. */
  networkMode: string;
  /** SERVER-INJECTED (never tenant): durable dedup-cache path (MAJOR #4 — survives a subprocess
   *  restart, so a crash/resume retry can never double-apply). */
  statePath?: string;
  /** Env-var-name -> `SecretsAccessor` key map (TENANT config) — resolved and injected ONLY into
   *  the runner container's env, redacted out of returned evidence, never this plugin's own env. */
  infraCredsSecretKeys?: Record<string, string>;
  /** ms before the container run is killed as hung (TENANT config). Default 10 minutes. */
  timeoutMs?: number;
  /** SERVER-INJECTED (never tenant): the container CLI to exec. Refused by the manifest schema and
   *  injected by `resolveExecutorPluginInstance` from `SCP_MANAGED_RUNNER_DOCKER_BINARY`, so the
   *  `?? "docker"` fallback below is for this package's own unit tests, not a tenant hook. */
  dockerBinary?: string;
  /** SERVER-INJECTED (never tenant). See docs/plugins.md §417. */
  runnerLauncher?: "docker" | "kubernetes";
  /** SERVER-INJECTED (never tenant): the Kubernetes launcher's deployment settings. Required when
   *  {@link runnerLauncher} is `"kubernetes"` — the resolver refuses BY NAME when it is missing,
   *  rather than producing a TypeError inside a half-built Job manifest. */
  kubernetes?: KubernetesLauncherSettings;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_NETWORK_MODE = "none";
/** Filenames a tenant may supply via `intent.parameters.sourceFiles` — no path separators, no
 *  `..`, no leading-dot traversal; just plain tofu source/tfvars filenames. */
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

function asConfig(config: unknown): ManagedIacConfig {
  const c = config as Partial<ManagedIacConfig> | undefined;
  if (!c?.runnerImage) {
    throw new Error(
      "managed-iac: runnerImage is not configured (server-governed — is Mode 2 enabled?)"
    );
  }
  if (!c.workspaceRoot) {
    throw new Error("managed-iac: workspaceRoot is not configured (server-governed)");
  }
  return {
    runnerImage: c.runnerImage,
    workspaceRoot: c.workspaceRoot,
    networkMode: c.networkMode ?? DEFAULT_NETWORK_MODE,
    statePath: c.statePath,
    infraCredsSecretKeys: c.infraCredsSecretKeys,
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

/** Server-controlled per-(org, target) workspace — sanitized so neither `orgId` nor `targetRef`
 *  can ever escape `workspaceRoot` (no separators/`..` survive the replace). Persists across
 *  plan -> apply -> rollback for the same target (the tofu state/plan lifecycle needs that). */
function workspaceDirFor(
  config: ManagedIacConfig,
  orgId: string,
  targetRef: string | undefined
): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(config.workspaceRoot, safe(orgId), safe(targetRef ?? "default"));
}

/** WHERE THE TRANSIENT `--env-file` IS STAGED. See docs/plugins.md §418. */
function secretEnvDirFor(config: ManagedIacConfig): string {
  return config.statePath
    ? dirname(config.statePath)
    : join(config.workspaceRoot, ".scp-runner-secret-env");
}

/** Replaces every occurrence of each resolved secret VALUE with `***` (MINOR — never leak a
 *  credential back to a tenant via `plan.json`/stdout evidence surfaced through `status()`).
 *  Plain split/join, not regex, since secret values may contain regex metacharacters. */
function redactSecrets(text: string, secretValues: string[]): string {
  let out = text;
  for (const value of secretValues) {
    if (value.length === 0) continue;
    out = out.split(value).join("***");
  }
  return out;
}

// Dedup cache — see module doc. Backed by the server-provided durable `statePath` (MAJOR #4).

interface RunOutcome {
  externalId: string;
  succeeded: boolean;
  /** A bounded detail rather than a string, which is the fix. See docs/plugins.md §419. */
  detail: BoundedDetail;
  stateRef?: string;
}

interface DedupState {
  keys: Record<string, RunOutcome>;
}

/** BOUNDING ONE ENTRY DID NOT BOUND THE LEDGER. See docs/plugins.md §420. */
function pruneDedupState(state: DedupState): number {
  return pruneOutcomeRecord(state.keys, RUN_OUTCOME_CACHE_MAX_DURABLE);
}

/** WHAT THIS FILE COMPOSES. See docs/plugins.md §421. */
type PendingOutcome = Omit<RunOutcome, "detail"> & { detail: string };

/** THE ONLY WAY AN OUTCOME ENTERS THE LEDGER. One bound, at the store. */
function storeOutcome(state: DedupState, cacheKey: string, outcome: PendingOutcome): void {
  state.keys[cacheKey] = { ...outcome, detail: boundDetail(outcome.detail) };
}

const dedupCache = createFileBackedJsonCache<DedupState>(() => ({ keys: {} }));
const loadState = dedupCache.load;
const saveState = dedupCache.save;

// Runner container launch. See docs/plugins.md §422.

async function resolveInfraCreds(
  ctx: PluginContext,
  config: ManagedIacConfig
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [envVar, secretKey] of Object.entries(config.infraCredsSecretKeys ?? {})) {
    const value = await ctx.secrets.get(secretKey);
    if (value !== undefined) resolved[envVar] = value;
  }
  return resolved;
}

async function runRunnerContainer(
  config: ManagedIacConfig,
  resolveLauncher: ResolveRunnerLauncher,
  action: "plan" | "apply" | "rollback",
  workspaceDir: string,
  /** The dedup cache key for this run — see {@link RunnerSpec.runId} on why the CALLER supplies it. */
  cacheKey: string,
  /** RESOLVED ONCE, by the caller. See docs/plugins.md §423. */
  infraCreds: Record<string, string>,
  extraEnv: Record<string, string> = {}
): Promise<RunnerResult> {
  const secretValues = Object.values(infraCreds);

  const result = await resolveLauncher({
    dockerBinary: config.dockerBinary,
    runnerLauncher: config.runnerLauncher,
    kubernetes: config.kubernetes
  }).run({
    // Derived from the idempotency key, so a retry addresses one. See docs/plugins.md §424.
    runId: toRunnerRunId(cacheKey),
    // ATTRIBUTION FOR AN ORPHAN (M23.0 defect 1). A container the daemon made for a `create` that
    // then timed out is now findable — `docker ps -a --filter label=scp.executor=scp-managed-iac`.
    labels: { "scp.executor": "scp-managed-iac", "scp.run-id": toRunnerRunId(cacheKey) },
    image: config.runnerImage,
    // The single operand this runner takes: which tofu verb `run.sh` should perform.
    operands: [action],
    // A CONFIG READ HERE, deliberately — unlike managed-dep, whose charter clause carries no
    // operator qualifier. `networkMode` is server-injected (default "none"), never tenant.
    networkMode: config.networkMode,
    // THE NON-SECRET ENV — `PRIOR_STATE_FILE` and anything else an action appends. Still `-e`, and
    // rightly so: it is a path inside the container, and hiding it buys nothing while making the
    // command line harder to read.
    env: Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`),
    // THE CREDENTIALS, AND THE ONE PLACE THEY ARE MATERIALIZED. See docs/plugins.md §425.
    secretEnv: Object.entries(infraCreds).map(([k, v]) => `${k}=${v}`),
    secretEnvDir: secretEnvDirFor(config),
    // COPIED, never bind-mounted (CRITICAL #1 + the dind-share fix): there is no host path that
    // becomes a container mount, so a `workspaceDir: "/"`-style escape is structurally impossible.
    copyIn: [{ hostDir: workspaceDir, containerPath: "/workspace" }],
    // The asymmetry that is this plugin's alone, on both axes. See docs/plugins.md §426.
    copyOut: {
      containerPath: "/workspace",
      hostDir: workspaceDir,
      when: "always",
      onFailure: "swallow"
    },
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024
  });

  // THE SECOND, INDEPENDENT REDACTION. See docs/plugins.md §427.
  if (result.succeeded) {
    return {
      succeeded: true,
      stdout: redactSecrets(result.stdout, secretValues),
      stderr: redactSecrets(result.stderr, secretValues)
    };
  }
  return {
    succeeded: false,
    stdout: redactSecrets(result.stdout, secretValues),
    stderr: redactSecrets(result.stderr, secretValues),
    failure: {
      ...result.failure,
      // RE-BOUND AFTER REDACTING, because redaction is not length-preserving: a secret value shorter
      // than `***` makes the string GROW. The compiler is what insists — `RunnerFailure.detail` is
      // `BoundedDetail`, so a transform that returns a plain `string` cannot be assigned back.
      detail: boundDetail(redactSecrets(result.failure.detail, secretValues))
    }
  };
}

async function observe(_ctx: PluginContext, _since?: Cursor): Promise<ExecutorEvent[]> {
  return []; // no push events — this executor's only activity is driven by its own trigger().
}

/** Writes tenant-supplied source files into the (server-controlled) workspace, rejecting any
 *  filename that isn't a plain, separator-free name (path-traversal defense). */
async function writeSourceFiles(
  workspaceDir: string,
  sourceFiles: Record<string, string>
): Promise<void> {
  for (const [name, content] of Object.entries(sourceFiles)) {
    if (!SAFE_FILENAME.test(name) || name === "." || name === "..") {
      throw new Error(
        `managed-iac: illegal source filename '${name}' (must match ${SAFE_FILENAME})`
      );
    }
    await writeFile(join(workspaceDir, name), content, "utf8");
  }
}

async function trigger(
  ctx: PluginContext,
  intent: TriggerIntent,
  resolveLauncher: ResolveRunnerLauncher
): Promise<ExternalRunRef> {
  const config = asConfig(ctx.config);
  const cacheKey = intent.idempotencyKey ?? randomUUID();
  // MOVED AHEAD OF `loadState` (LOW-6) — deterministic, IO-free, so a state-load failure below still
  // has a ref to record its own refusal against, instead of nothing.
  const externalId = `managed-iac::${cacheKey}`;

  let state: DedupState;
  try {
    state = await loadState(config.statePath);
  } catch (err) {
    // State load and save now sit inside the guarded region. See docs/plugins.md §428.
    const refusalState: DedupState = { keys: {} };
    storeOutcome(refusalState, cacheKey, {
      externalId,
      succeeded: false,
      detail:
        `managed-iac: FAILED CLOSED — could not load dedup state at '${config.statePath}' ` +
        `(${err instanceof Error ? err.message : String(err)}). Refusing to launch: an unreadable ` +
        "dedup cache cannot tell this run apart from one that already applied."
    });
    try {
      await saveState(config.statePath, refusalState);
    } catch (saveErr) {
      // Recording the refusal itself failed too — nothing left to do but be LOUD about it, which is
      // exactly the property that keeps this LOW rather than HIGH (status()'s own loadState would
      // fail just as loudly here).
      ctx.logger.error("managed-iac: could not record the dedup-state-load failure either", {
        externalId,
        loadError: err instanceof Error ? err.message : String(err),
        saveError: saveErr instanceof Error ? saveErr.message : String(saveErr)
      });
      throw err;
    }
    ctx.logger.info("managed-iac: run complete", { externalId, succeeded: false });
    return { externalId };
  }

  const existing = state.keys[cacheKey];
  if (existing) {
    return { externalId: existing.externalId };
  }

  const workspaceDir = workspaceDirFor(config, ctx.orgId, intent.targetRef);
  let outcome: PendingOutcome = { externalId, succeeded: false, detail: "" };

  // THE REDACTION SET FOR THE FAILURE PATH. See docs/plugins.md §429.
  let secretValues: string[] = [];
  const redact = (text: string): string => redactSecrets(text, secretValues);

  // EVERY PATH OUT OF THE REST OF THIS FUNCTION RECORDS AN OUTCOME. See docs/plugins.md §430.
  await withRecordedOutcome(
    {
      record: (succeeded, detail) => {
        outcome = { externalId, succeeded, detail };
      },
      redact
    },
    async () => {
      await mkdir(workspaceDir, { recursive: true });
      const infraCreds = await resolveInfraCreds(ctx, config);
      secretValues = Object.values(infraCreds);

      if (intent.kind === "rollback") {
        const priorStateFile =
          typeof intent.priorStateRef === "string" ? intent.priorStateRef : undefined;
        // Jail PRIOR_STATE_FILE to `state-history/` (MINOR) — never let a rollback ref point outside
        // the workspace's own snapshot dir (run.sh enforces the same, defence in depth).
        if (
          !priorStateFile ||
          !priorStateFile.startsWith("state-history/") ||
          priorStateFile.includes("..")
        ) {
          outcome = {
            externalId,
            succeeded: false,
            detail:
              "managed-iac rollback: FAILED CLOSED — priorStateRef missing or not a state-history/*.tfstate path"
          };
        } else {
          const result = await runRunnerContainer(
            config,
            resolveLauncher,
            "rollback",
            workspaceDir,
            cacheKey,
            infraCreds,
            {
              PRIOR_STATE_FILE: priorStateFile
            }
          );
          outcome = {
            externalId,
            succeeded: result.succeeded,
            // `runnerOutcomeDetail`, NOT `succeeded ? stdout : stderr` — that expression recorded
            // the EMPTY STRING for a budget-killed or never-spawned runner, which is exactly the
            // pair an operator most needs told apart. See `@scp/runner-launcher`'s
            // `classifyRunnerFailure`.
            detail: runnerOutcomeDetail(result),
            stateRef: priorStateFile
          };
        }
      } else {
        const sourceFiles = intent.parameters?.sourceFiles as Record<string, string> | undefined;
        if (sourceFiles) await writeSourceFiles(workspaceDir, sourceFiles);
        const iacAction = (intent.parameters?.iacAction as "plan" | "apply" | undefined) ?? "plan";
        const result = await runRunnerContainer(
          config,
          resolveLauncher,
          iacAction,
          workspaceDir,
          cacheKey,
          infraCreds
        );
        outcome = {
          externalId,
          succeeded: result.succeeded,
          // See the rollback arm above: an empty `detail` in a DURABLE, replicated ledger is how a
          // SIGTERMed `tofu apply` came to look identical to a runner that exited quietly.
          detail: runnerOutcomeDetail(result)
        };
      }
    }
  );

  storeOutcome(state, cacheKey, outcome);
  // PRUNE BEFORE THE WRITE, so the bound is a property of what reaches the disk rather than of what
  // is in memory at some later moment. See `pruneDedupState`.
  const pruned = pruneDedupState(state);
  if (pruned > 0) {
    ctx.logger.info("managed-iac: pruned the oldest dedup-cache entries", {
      pruned,
      kept: Object.keys(state.keys).length
    });
  }
  try {
    await saveState(config.statePath, state);
  } catch (err) {
    // LOW-6: THE RUN ALREADY HAPPENED. See docs/plugins.md §431.
    ctx.logger.error("managed-iac: run completed but the dedup state could not be saved", {
      externalId,
      succeeded: outcome.succeeded,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  ctx.logger.info("managed-iac: run complete", { externalId, succeeded: outcome.succeeded });
  return { externalId };
}

async function status(ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus> {
  const config = asConfig(ctx.config);
  const state = await loadState(config.statePath);
  const outcome = Object.values(state.keys).find((o) => o.externalId === ref.externalId);
  if (!outcome) {
    return {
      phase: "pending",
      detail: "managed-iac: unknown run (not found in local outcome cache)"
    };
  }
  return {
    phase: outcome.succeeded ? "succeeded" : "failed",
    // No slice: the evidence is bounded where it is composed. See docs/plugins.md §432.
    detail: outcome.detail,
    stateRef: outcome.stateRef,
    progress: 1
  };
}

async function abort(_ctx: PluginContext, _ref: ExternalRunRef): Promise<AbortResult> {
  // See module doc — trigger() is synchronous, so by the time any caller could hold a ref to
  // abort, the container has already exited. Honestly reported, never silently ignored.
  return {
    aborted: false,
    detail: "managed-iac: trigger() runs synchronously to completion; nothing left to abort"
  };
}

function describeCapabilities(): ExecutorCapabilities {
  return {
    supportsObserve: true,
    supportsTrigger: true,
    supportsAbort: true, // advertised for a well-formed answer; abort() always {aborted:false} (module doc)
    triggerKinds: ["sync", "rollback", "custom"]
  };
}

/** THE LAUNCHER SEAM. See docs/plugins.md §433. */
export function createManagedIacExecutorPlugin(
  // THE DEFAULT IS THE SELECTING RESOLVER, NOT THE DOCKER ONE. See docs/plugins.md §434.
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

export const managedIacExecutorPlugin: ExecutorPlugin = createManagedIacExecutorPlugin();

/** Manifest `configSchema` is the TENANT-facing surface only. See docs/plugins.md §435. */
export const manifest: PluginManifest = {
  id: "managed-iac",
  kind: "executor",
  version: "0.1.0",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      infraCredsSecretKeys: { type: "object", additionalProperties: { type: "string" } },
      // BOUNDED AT BOTH ENDS. See docs/plugins.md §436.
      timeoutMs: {
        type: "integer",
        minimum: MANAGED_RUN_TIMEOUT_MIN_MS,
        maximum: MANAGED_RUN_TIMEOUT_MAX_MS,
        default: DEFAULT_TIMEOUT_MS
      }
    }
  }
};

export default managedIacExecutorPlugin;
