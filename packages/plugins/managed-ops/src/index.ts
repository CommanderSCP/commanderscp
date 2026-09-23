import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AbortResult,
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
  resolveRunnerLauncher,
  type KubernetesLauncherSettings,
  type ResolveRunnerLauncher,
  type RunnerResult
} from "@scp/runner-launcher";
import {
  SERVER_DERIVED_OPS_KEYS,
  readServerDerivedMaterial,
  type ServerDerivedOpsMaterial
} from "./run-material.js";

/**
 * `scp-managed-ops` — the thin ORCHESTRATOR for host-reaching managed execution (M27.7).
 *
 * It runs inside scpd and launches `apps/runner-ops` as an ephemeral container per run. The split
 * is DESIGN.md §3's: no Ansible, no catalog and no SSH client live here; no Node app code lives in
 * the image. This file's entire job is to hand the runner four things it cannot obtain for itself —
 * the role, the inventory, the credential and the addresses it may reach — and to make each of them
 * impossible for a tenant or a recipe to choose.
 *
 * WHY THERE IS NO `deploy()` OR `execute()` VERB. The charter's Managed Execution Exception widens
 * the CREDENTIAL constraint for host-reaching classes; it does not widen the interface. This
 * plugin implements observe/trigger/status/abort like every other executor, and `trigger` invokes
 * a role from a closed, signed catalog — it does not accept a program.
 */

const DEFAULT_TIMEOUT_MS = 900_000;
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 3_600_000;

export interface ManagedOpsConfig {
  /** The vetted, pinned `scp-runner-ops` image. SERVER-GOVERNED; never tenant-suppliable. */
  runnerImage: string;
  /** Operator root under which per-run scratch directories are made. */
  workspaceRoot: string;
  /** cosign public key for catalog verification, as a SECRET KEY (resolved via `ctx.secrets`). */
  catalogPubkeySecretKey?: string;
  timeoutMs?: number;
  dockerBinary?: string;
  runnerLauncher?: "docker" | "kubernetes";
  kubernetes?: KubernetesLauncherSettings;
}

function asConfig(config: unknown): ManagedOpsConfig {
  const c = config as Partial<ManagedOpsConfig> | undefined;
  if (!c?.runnerImage) {
    throw new Error(
      "managed-ops: runnerImage is not configured (server-governed — is host-reaching managed " +
        "execution enabled? SCP_MANAGED_OPS_RUNNER_IMAGE)"
    );
  }
  if (!c.workspaceRoot) {
    throw new Error("managed-ops: workspaceRoot is not configured (server-governed)");
  }
  const timeoutMs = c.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(
      `managed-ops: timeoutMs ${timeoutMs} is outside [${MIN_TIMEOUT_MS}, ${MAX_TIMEOUT_MS}]`
    );
  }
  return { ...c, runnerImage: c.runnerImage, workspaceRoot: c.workspaceRoot, timeoutMs };
}

/**
 * The role's own arguments — everything a recipe legitimately authored.
 *
 * Built by REMOVING the closed set rather than by copying an allowlist: a role's arguments are
 * open-ended by design (each catalog role declares its own), so an allowlist here would silently
 * drop a new role's parameters. Removing the bound is the operation that is actually closed.
 */
function roleArguments(parameters: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parameters ?? {})) {
    if ((SERVER_DERIVED_OPS_KEYS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** A stable per-run id, so an orphaned container is traceable to the run that left it. */
function toRunnerRunId(key: string): string {
  return `scp-ops-${key.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 48)}`;
}

/** Nothing to poll. SCP drives this executor; it is not watching a system that acts on its own. */
async function observe(): Promise<ExecutorEvent[]> {
  return [];
}

async function trigger(
  ctx: PluginContext,
  intent: TriggerIntent,
  resolveLauncher: ResolveRunnerLauncher
): Promise<ExternalRunRef> {
  const config = asConfig(ctx.config);
  // REFUSES an incomplete bound before anything is staged or launched (ADR-0052).
  const material: ServerDerivedOpsMaterial = readServerDerivedMaterial(intent.parameters);

  const runKey = intent.idempotencyKey ?? `${ctx.scopeKey}:${material.opsRole}`;
  const runId = toRunnerRunId(runKey);
  const inDir = await mkdtemp(join(config.workspaceRoot || tmpdir(), "scp-ops-"));

  try {
    // THE INVENTORY IS A FILE THE SERVER WROTE. `run.sh` refuses to start without it, and nothing
    // a tenant can set reaches this path — which is the whole of D25(a) in one line.
    await writeFile(join(inDir, "inventory.ini"), material.opsInventory, { mode: 0o600 });
    // The role's arguments, as DATA. `params_to_vars.py` marks every string !unsafe on the way in
    // (M27.2), so a value containing `{{ ... }}` reaches the task literally.
    await writeFile(join(inDir, "params.json"), JSON.stringify(roleArguments(intent.parameters)), {
      mode: 0o600
    });

    // Resolved HERE, from the secret store, never carried in parameters — see
    // `opsCredentialSecretKey`. Written 0600 into a directory that dies with the run.
    const credential = await ctx.secrets.get(material.opsCredentialSecretKey);
    if (!credential) {
      throw new Error(
        `managed-ops: no credential at secret key '${material.opsCredentialSecretKey}'. ` +
          "REFUSING rather than launching a host-reaching run with no certificate."
      );
    }
    await writeFile(join(inDir, "ssh-credential"), credential, { mode: 0o600 });

    const launcher = resolveLauncher({
      dockerBinary: config.dockerBinary,
      runnerLauncher: config.runnerLauncher,
      kubernetes: config.kubernetes
    });

    const result: RunnerResult = await launcher.run({
      runId,
      labels: { "scp.executor": "scp-managed-ops", "scp.run-id": runId },
      image: config.runnerImage,
      operands: [],
      // `none` is the FALLBACK, not the control: the real bound is `egressAllowlist` below, which
      // the kubernetes adapter turns into a per-run NetworkPolicy. If a deployment ever ran this on
      // the docker launcher, the launcher REFUSES the spec rather than running it unconstrained.
      networkMode: "none",
      // THE BOUND (M27.6b). Exactly the addresses this run's observed membership resolved.
      egressAllowlist: material.opsEgressAllowlist,
      env: [
        `SCP_OPS_ROLE=${material.opsRole}`,
        ...(config.catalogPubkeySecretKey ? ["SCP_OPS_CATALOG_VERIFY=required"] : [])
      ],
      // The credential is a FILE, not an env var: env is visible in `ps` on some platforms and is
      // carried in the container's inspect output, which evidence collection reads.
      secretEnv: [],
      copyIn: [{ hostDir: inDir, containerPath: "/work/in" }],
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // 16 MiB. Ansible is the CHATTIEST of the runners — one line per task per host, and a fleet
      // is many hosts — so this is the largest of the three per-call buffers, not the smallest.
      // It was omitted entirely at first and an `as never` cast hid the fact that it is required.
      maxBuffer: 16 * 1024 * 1024
    });

    return {
      externalId: runId,
      ...(result.succeeded ? {} : {})
    };
  } finally {
    // The inventory, the role arguments AND the credential all die here, whatever happened.
    await rm(inDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Host-reaching runs are SYNCHRONOUS: `trigger` returns only once the container has exited, so by
 * the time anything asks for status the run is over. Reported as `succeeded` because a failure
 * would have thrown from `trigger` — there is no in-flight state for this executor to describe.
 */
async function status(_ctx: PluginContext, ref: ExternalRunRef): Promise<ExecutionStatus> {
  return { phase: "succeeded", detail: `managed-ops run ${ref.externalId} completed` };
}

/**
 * Always `{aborted: false}`, and honestly so. A single-shot container that has already exited
 * cannot be aborted, and claiming otherwise would let a caller believe a host change was stopped
 * when it was not — the worst possible lie for a class that mutates hosts.
 */
async function abort(): Promise<AbortResult> {
  return { aborted: false, detail: "managed-ops runs are single-shot and already complete" };
}

function describeCapabilities(): ExecutorCapabilities {
  return {
    supportsObserve: true,
    supportsTrigger: true,
    supportsAbort: true,
    triggerKinds: ["custom"]
  };
}

/** THE LAUNCHER SEAM, as managed-dep has — the default is the SELECTING resolver, not docker's. */
export function createManagedOpsExecutorPlugin(
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

export const managedOpsExecutorPlugin: ExecutorPlugin = createManagedOpsExecutorPlugin();

/**
 * The manifest's `configSchema` is the TENANT-facing surface only. `runnerImage`, `workspaceRoot`
 * and the launcher settings are SERVER-INJECTED and deliberately absent from it — a tenant that
 * could name the image could name any image.
 */
export const manifest: PluginManifest = {
  id: "managed-ops",
  kind: "executor",
  version: "0.1.0",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      timeoutMs: {
        type: "integer",
        minimum: MIN_TIMEOUT_MS,
        maximum: MAX_TIMEOUT_MS,
        default: DEFAULT_TIMEOUT_MS
      }
    }
  }
};

export * from "./run-material.js";
export default managedOpsExecutorPlugin;
