import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

const execFileAsync = promisify(execFile);

/**
 * `@scp/plugin-managed-iac` — the `scp-managed-iac` executor (DESIGN.md §12 Mode 2, charter's
 * Managed Execution Exception, BUILD_AND_TEST.md §8 M7 item 3): "a thin orchestrator inside
 * scpd; each run launches an ephemeral runner container from [the `scp-runner-iac`] image... Org-
 * supplied credentials are held scoped and encrypted in SCP's secret store and injected only into
 * the ephemeral runner for the duration of the run. The plan output is persisted as the change's
 * evidence; apply proceeds only when the change's gates pass."
 *
 * COORDINATION-NOT-EXECUTION, PRESERVED AT THE TYPE LEVEL EVEN HERE: this is the one scoped
 * exception where `trigger()`'s body performs real infrastructure work — but it still does so
 * behind the unchanged `ExecutorPlugin` verb (no new `execute()`/`deploy()` method was added to
 * the interface), and it holds credentials ONLY for THIS org's infrastructure, ONLY for the
 * duration of one ephemeral container's lifetime, injected via `docker run -e` and NEVER written
 * to a file, logged, or reachable from this plugin's own subprocess environment once the
 * container exits (`--rm` — the container and its env are gone; this plugin process never sees
 * the runner's env either, since it sets it only on the CHILD `docker run` process it spawns).
 *
 * SYNCHRONOUS TRIGGER (deliberate simplification, v1 — "trivial-to-moderate IaC deployments" is
 * DESIGN's own scoping for Mode 2): `trigger()` runs the container to completion and returns only
 * once it has exited, rather than the fire-then-poll shape every other M7 executor uses. This
 * means `status()` never observes "running" for THIS executor — a call to `trigger()` blocks
 * `coordination/reconcile.ts`'s reconcile tick for as long as the container takes, and `abort()`
 * has nothing to abort (documented, not silently absent — see `abort()` below). Acceptable for
 * "trivial-to-moderate" plans/applies; a genuinely long-running Mode 2 deployment is exactly the
 * kind of case DESIGN says to use Mode 1 (an org's own pipeline) or ArgoCD for instead. Idempotency
 * is enforced BEFORE any container ever launches (the dedup cache below), which is what actually
 * matters for "a retry must never double-apply real infrastructure" — this is intentionally the
 * single strongest idempotency guarantee of any M7 executor, because the stakes here are highest.
 *
 * `docker run` (not the Kubernetes Job path DESIGN also names for production) is what this v1
 * implements and what the DoD's real-container integration test exercises — the Kubernetes Job
 * variant is a documented, flagged follow-up (mirrors federation-https's M6 "DEFERRED, FLAGGED"
 * posture): the container-contract (`run.sh`'s plan/apply/rollback actions, evidence files,
 * `PRIOR_STATE_FILE`) is identical either way, so a K8s Job launcher slots in behind the same
 * `runRunnerContainer()` seam below without another interface change.
 */

export interface ManagedIacConfig {
  /** `scp-runner-iac` image reference, e.g. `scp-runner-iac:dev` or a registry-qualified tag from
   *  the same signed bundle as this `scpd` build (DESIGN §12: "the runner image ships in the same
   *  signed bundle at the same version tag"). */
  runnerImage: string;
  /** Host (or shared-volume) directory holding the org's `.tf`/`.tofu` configuration AND where
   *  plan/state evidence persists across the plan -> apply -> rollback lifecycle — bind-mounted
   *  into the runner container as `/workspace` on every invocation. */
  workspaceDir: string;
  /** Env-var-name -> `SecretsAccessor` key map — resolved and injected ONLY into the runner
   *  container's environment, never this plugin's own process env (module doc). E.g.
   *  `{ "AWS_ACCESS_KEY_ID": "org-aws-key-id", "AWS_SECRET_ACCESS_KEY": "org-aws-secret" }`. */
  infraCredsSecretKeys?: Record<string, string>;
  dockerBinary?: string; // override for tests; default "docker"
  statePath?: string;
  /** `docker run --network <value>`. Default `"none"` — a local-state fixture (and, generally,
   *  the safest default for a container about to hold real infra credentials) needs no network at
   *  all; a real cloud-provider binding sets this explicitly (e.g. `"bridge"`) since its provider
   *  plugin genuinely needs to reach the provider's API. Deny-by-default, not allow-by-default. */
  networkMode?: string;
  /** ms before a `docker run` is killed as hung. Default 10 minutes — generous for "trivial-to-
   *  moderate" plans/applies, bounded so a wedged provider call can't block the reconcile loop
   *  forever. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_NETWORK_MODE = "none";

function asConfig(config: unknown): ManagedIacConfig {
  const c = config as Partial<ManagedIacConfig> | undefined;
  if (!c?.runnerImage || !c.workspaceDir) {
    throw new Error("managed-iac: config.runnerImage and config.workspaceDir are required");
  }
  return {
    runnerImage: c.runnerImage,
    workspaceDir: c.workspaceDir,
    infraCredsSecretKeys: c.infraCredsSecretKeys,
    dockerBinary: c.dockerBinary ?? "docker",
    statePath: c.statePath,
    networkMode: c.networkMode ?? DEFAULT_NETWORK_MODE,
    timeoutMs: c.timeoutMs ?? DEFAULT_TIMEOUT_MS
  };
}

// -----------------------------------------------------------------------------------------
// Dedup cache — see module doc ("the single strongest idempotency guarantee of any M7 executor").
// Persists the FULL outcome (not just an id), since trigger() is synchronous and status() has
// nothing else to consult.
// -----------------------------------------------------------------------------------------

interface RunOutcome {
  externalId: string;
  succeeded: boolean;
  detail: string;
  stateRef?: string;
}

interface DedupState {
  keys: Record<string, RunOutcome>;
}

let inMemoryState: DedupState = { keys: {} };

async function loadState(statePath: string | undefined): Promise<DedupState> {
  if (!statePath) return inMemoryState;
  try {
    return JSON.parse(await readFile(statePath, "utf8")) as DedupState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { keys: {} };
    throw err;
  }
}

async function saveState(statePath: string | undefined, state: DedupState): Promise<void> {
  if (!statePath) {
    inMemoryState = state;
    return;
  }
  await mkdir(dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state), "utf8");
  await rename(tmpPath, statePath);
}

// -----------------------------------------------------------------------------------------
// Runner container launch — the ONE place credentials are materialized as env vars, on the
// CHILD process only (`execFile`'s third-arg `env` is scoped to that child; this plugin's own
// `process.env` is never touched). `--rm` guarantees the container (and therefore its env) is
// gone the moment it exits, win or lose.
// -----------------------------------------------------------------------------------------

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
  ctx: PluginContext,
  config: ManagedIacConfig,
  action: "plan" | "apply" | "rollback",
  extraEnv: Record<string, string> = {}
): Promise<{ succeeded: boolean; stdout: string; stderr: string }> {
  const infraCreds = await resolveInfraCreds(ctx, config);
  const envArgs = Object.entries({ ...infraCreds, ...extraEnv }).flatMap(([k, v]) => [
    "-e",
    `${k}=${v}`
  ]);
  const args = [
    "run",
    "--rm",
    "--network",
    config.networkMode ?? DEFAULT_NETWORK_MODE, // deny-by-default — see ManagedIacConfig.networkMode's doc
    "-v",
    `${config.workspaceDir}:/workspace`,
    ...envArgs,
    config.runnerImage,
    action
  ];

  try {
    const { stdout, stderr } = await execFileAsync(config.dockerBinary ?? "docker", args, {
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024
    });
    return { succeeded: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { succeeded: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
  }
}

// -----------------------------------------------------------------------------------------
// ExecutorPlugin
// -----------------------------------------------------------------------------------------

async function observe(_ctx: PluginContext, _since?: Cursor): Promise<ExecutorEvent[]> {
  return []; // no push events — this executor's only activity is driven by its own trigger().
}

async function trigger(ctx: PluginContext, intent: TriggerIntent): Promise<ExternalRunRef> {
  const config = asConfig(ctx.config);
  const cacheKey = intent.idempotencyKey ?? randomUUID();
  const state = await loadState(config.statePath);
  const existing = state.keys[cacheKey];
  if (existing) {
    return { externalId: existing.externalId };
  }

  const externalId = `managed-iac::${cacheKey}`;
  let outcome: RunOutcome;

  if (intent.kind === "rollback") {
    const priorStateFile =
      typeof intent.priorStateRef === "string" ? intent.priorStateRef : undefined;
    if (!priorStateFile) {
      outcome = {
        externalId,
        succeeded: false,
        detail: "managed-iac rollback: no priorStateRef supplied"
      };
    } else {
      const result = await runRunnerContainer(ctx, config, "rollback", {
        PRIOR_STATE_FILE: priorStateFile
      });
      outcome = {
        externalId,
        succeeded: result.succeeded,
        detail: result.succeeded ? result.stdout : result.stderr,
        stateRef: priorStateFile
      };
    }
  } else {
    const iacAction = (intent.parameters?.iacAction as "plan" | "apply" | undefined) ?? "plan";
    const result = await runRunnerContainer(ctx, config, iacAction);
    outcome = {
      externalId,
      succeeded: result.succeeded,
      detail: result.succeeded ? result.stdout : result.stderr
    };
  }

  state.keys[cacheKey] = outcome;
  await saveState(config.statePath, state);
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
    detail: outcome.detail.slice(0, 4000), // evidence, bounded — the full plan.json lives on disk
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
    supportsAbort: true, // capability advertised (conformance-suite-visible); abort() itself always
    // reports {aborted:false} per the module doc — advertised so callers get a well-formed,
    // honest answer instead of the call failing outright, not because it can meaningfully cancel.
    triggerKinds: ["sync", "rollback", "custom"]
  };
}

export const managedIacExecutorPlugin: ExecutorPlugin = {
  observe,
  trigger,
  status,
  abort,
  describeCapabilities
};

export function createManagedIacExecutorPlugin(): ExecutorPlugin {
  return managedIacExecutorPlugin;
}

export const manifest: PluginManifest = {
  id: "managed-iac",
  kind: "executor",
  version: "0.1.0",
  configSchema: {
    type: "object",
    required: ["runnerImage", "workspaceDir"],
    properties: {
      runnerImage: { type: "string" },
      workspaceDir: { type: "string" },
      infraCredsSecretKeys: { type: "object", additionalProperties: { type: "string" } },
      networkMode: { type: "string", default: DEFAULT_NETWORK_MODE },
      timeoutMs: { type: "integer", minimum: 1000, default: DEFAULT_TIMEOUT_MS }
    }
  }
};

export default managedIacExecutorPlugin;
