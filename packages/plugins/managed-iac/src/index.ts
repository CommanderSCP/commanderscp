import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { resolveDockerRunnerLauncher, type ResolveRunnerLauncher } from "@scp/runner-launcher";

/**
 * `@scp/plugin-managed-iac` — the `scp-managed-iac` executor (DESIGN.md §12 Mode 2, charter's
 * Managed Execution Exception, BUILD_AND_TEST.md §8 M7 item 3): "a thin orchestrator inside
 * scpd; each run launches an ephemeral runner container from [the `scp-runner-iac`] image... Org-
 * supplied credentials are held scoped and encrypted in SCP's secret store and injected only into
 * the ephemeral runner for the duration of the run. The plan output is persisted as the change's
 * evidence; apply proceeds only when the change's gates pass."
 *
 * SECURITY MODEL (adversarial-review CRITICAL #1 — the reason this file's config shape is what it
 * is): the fields that decide WHAT image runs, on WHICH network, and against WHICH host directory
 * are **operator/server-governed, NEVER tenant-suppliable**. A tenant (any org member with plain
 * `object:write` on a Component) configures ONLY `infraCredsSecretKeys` + `timeoutMs` (the
 * manifest's `configSchema` below is `additionalProperties: false` and does NOT list runnerImage/
 * networkMode/workspace — so a binding that tries to set them is rejected at create/update by
 * `routes/executors.ts`'s config validation). The server injects `runnerImage`/`networkMode`/
 * `workspaceRoot`/`statePath` into this plugin's config when it provisions the instance
 * (`coordination/executor-bindings-repo.ts`'s `resolveExecutorPluginInstance`), so by the time
 * this code reads `ctx.config`, those values are the vetted server settings, not anything a tenant
 * chose. Two further hardening measures below: (1) the runner workspace is **copied into the
 * container** (`docker cp`), never bind-mounted — there is no tenant- OR server-path that becomes
 * a host mount, so `workspaceDir: "/"`-style host-root escapes are structurally impossible; the
 * host workspace directory itself is derived server-side from `orgId`+`targetRef` under the
 * operator's `workspaceRoot`, so it can't be steered outside that root. (2) the container is
 * launched with NO docker socket mount and the server-fixed `--network` (default `none`).
 *
 * COORDINATION-NOT-EXECUTION, PRESERVED AT THE TYPE LEVEL EVEN HERE: this is the one scoped
 * exception where `trigger()`'s body performs real infrastructure work — but it still does so
 * behind the unchanged `ExecutorPlugin` verb (no new `execute()`/`deploy()` method), and it holds
 * credentials ONLY for THIS org's infrastructure, ONLY for the duration of one ephemeral
 * container, injected via `docker create -e`, redacted out of any returned evidence, and never
 * reachable from this plugin's own subprocess environment.
 *
 * SYNCHRONOUS TRIGGER (deliberate v1 simplification — "trivial-to-moderate IaC deployments" is
 * DESIGN's own scoping for Mode 2): `trigger()` runs the container to completion. Idempotency is
 * enforced BEFORE any container ever launches (the dedup cache below, backed by a server-provided
 * durable `statePath` — the strongest idempotency guarantee of any M7 executor, because
 * double-applying live infrastructure is the highest-stakes failure mode).
 */

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
    dockerBinary: c.dockerBinary ?? "docker"
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

// -----------------------------------------------------------------------------------------
// Dedup cache — see module doc. Backed by the server-provided durable `statePath` (MAJOR #4).
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
// Runner container launch — COPY the workspace in/out (never bind-mount; CRITICAL #1 + fixes the
// dind CI failure where a bind-mounted host /tmp path isn't shared with the dind daemon). The ONE
// place credentials are materialized as env vars, on the CHILD `docker` invocations only.
//
// M23.1: the five-step create/copy-in/start/copy-out/remove sequence itself now lives in
// `@scp/runner-launcher`, shared with `@scp/plugin-managed-scan` and `@scp/plugin-managed-dep` —
// three hand-rolled copies of one mechanism were three places a fix had to be remembered. What
// stays HERE is everything that is this plugin's own: which operands, which env, and the
// copy-out policy (`always` + `swallow`) that no other caller shares.
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
  resolveLauncher: ResolveRunnerLauncher,
  action: "plan" | "apply" | "rollback",
  workspaceDir: string,
  extraEnv: Record<string, string> = {}
): Promise<{ succeeded: boolean; stdout: string; stderr: string }> {
  const infraCreds = await resolveInfraCreds(ctx, config);
  const secretValues = Object.values(infraCreds);

  const result = await resolveLauncher({ dockerBinary: config.dockerBinary }).run({
    image: config.runnerImage,
    // The single operand this runner takes: which tofu verb `run.sh` should perform.
    operands: [action],
    // A CONFIG READ HERE, deliberately — unlike managed-dep, whose charter clause carries no
    // operator qualifier. `networkMode` is server-injected (default "none"), never tenant.
    networkMode: config.networkMode,
    // THE ONE PLACE CREDENTIALS ARE MATERIALIZED, on the child `docker` invocation only. The order
    // is the config's own key order first, the action's extra env last — pinned by the golden.
    // M23.0 recorded that this puts them on the host process table; the Kubernetes arm takes
    // Secret-backed env instead of inheriting the argv shape (M23.2), which is why `env` is a list
    // of entries rather than an argv fragment.
    env: Object.entries({ ...infraCreds, ...extraEnv }).map(([k, v]) => `${k}=${v}`),
    // COPIED, never bind-mounted (CRITICAL #1 + the dind-share fix): there is no host path that
    // becomes a container mount, so a `workspaceDir: "/"`-style escape is structurally impossible.
    copyIn: [{ hostDir: workspaceDir, containerPath: "/workspace" }],
    // THE ASYMMETRY THAT IS THIS PLUGIN'S ALONE, and it is load-bearing on both axes: the evidence
    // comes back out even after a FAILED run (a failed apply may still have produced a partial
    // plan.json worth persisting), and a copy-out that itself fails is SWALLOWED (the run stays
    // succeeded). managed-scan and managed-dep do the opposite on both. Pinned by the goldens; a
    // port that normalised the three into one sequence must break them.
    copyOut: {
      containerPath: "/workspace",
      hostDir: workspaceDir,
      when: "always",
      onFailure: "swallow"
    },
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024
  });

  return {
    succeeded: result.succeeded,
    stdout: redactSecrets(result.stdout, secretValues),
    stderr: redactSecrets(result.stderr, secretValues)
  };
}

// -----------------------------------------------------------------------------------------
// ExecutorPlugin
// -----------------------------------------------------------------------------------------

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
  const state = await loadState(config.statePath);
  const existing = state.keys[cacheKey];
  if (existing) {
    return { externalId: existing.externalId };
  }

  const externalId = `managed-iac::${cacheKey}`;
  const workspaceDir = workspaceDirFor(config, ctx.orgId, intent.targetRef);
  await mkdir(workspaceDir, { recursive: true });
  let outcome: RunOutcome;

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
        ctx,
        config,
        resolveLauncher,
        "rollback",
        workspaceDir,
        {
          PRIOR_STATE_FILE: priorStateFile
        }
      );
      outcome = {
        externalId,
        succeeded: result.succeeded,
        detail: result.succeeded ? result.stdout : result.stderr,
        stateRef: priorStateFile
      };
    }
  } else {
    const sourceFiles = intent.parameters?.sourceFiles as Record<string, string> | undefined;
    if (sourceFiles) await writeSourceFiles(workspaceDir, sourceFiles);
    const iacAction = (intent.parameters?.iacAction as "plan" | "apply" | undefined) ?? "plan";
    const result = await runRunnerContainer(ctx, config, resolveLauncher, iacAction, workspaceDir);
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
    detail: outcome.detail.slice(0, 4000), // evidence, bounded (already secret-redacted at capture)
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

/**
 * THE LAUNCHER SEAM (M23.1). `resolveLauncher` defaults to the Docker adapter — the only one that
 * exists until M23.2 — and is a FACTORY PARAMETER rather than a config field on purpose: adapter
 * selection is not tenant-facing, and adding a config field would mean adding it to the
 * server-injected/never-tenant-settable class in all three enforcement layers for no behaviour a
 * caller can yet ask for. Tests pass a substitute here, which is what makes "the plugin really goes
 * through the port" falsifiable rather than a claim about the source text.
 */
export function createManagedIacExecutorPlugin(
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

export const managedIacExecutorPlugin: ExecutorPlugin = createManagedIacExecutorPlugin();

/**
 * Manifest `configSchema` is the TENANT-facing surface only — `additionalProperties: false` so a
 * binding that tries to set the server-governed runnerImage/networkMode/workspace* fields is
 * REJECTED at create/update (routes/executors.ts's config validation). The server injects those
 * fields into this plugin's runtime config itself (executor-bindings-repo.ts).
 */
export const manifest: PluginManifest = {
  id: "managed-iac",
  kind: "executor",
  version: "0.1.0",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      infraCredsSecretKeys: { type: "object", additionalProperties: { type: "string" } },
      timeoutMs: { type: "integer", minimum: 1000, default: DEFAULT_TIMEOUT_MS }
    }
  }
};

export default managedIacExecutorPlugin;
