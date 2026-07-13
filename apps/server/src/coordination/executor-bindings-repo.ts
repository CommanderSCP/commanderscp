import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { TenantTx } from "../db/tenant-tx.js";
import { executorBindings } from "../db/schema.js";
import { resolveSecretRefs } from "../secrets/secrets-repo.js";
import type { PluginHostInstanceConfig, PluginModule } from "../plugin-host/contract.js";

/**
 * `executor_bindings` — the registry-object gap `coordination/executor-config.ts`'s M3 doc
 * comment named explicitly ("that lands once ExecutorPlugin config becomes a registry object,
 * alongside GitHub/ArgoCD/Terraform in M7"): binds a Component/DeploymentTarget graph object to a
 * concrete, configured `ExecutorPlugin` instance. Modeled directly on `governance/controls-repo.ts`'s
 * `control_bindings` (1:1 binding per graph object, same upsert-by-lookup shape).
 */

export interface ExecutorBindingRow {
  id: string;
  targetObjectId: string;
  pluginModule: string;
  pluginInstanceId: string;
  config: unknown;
  secretRefs: Record<string, string>;
  allowedHosts: string[];
  externalRef: string | null;
}

function toRow(row: {
  id: string;
  targetObjectId: string;
  pluginModule: string;
  pluginInstanceId: string;
  config: unknown;
  secretRefs: unknown;
  allowedHosts: unknown;
  externalRef?: string | null;
}): ExecutorBindingRow {
  return {
    id: row.id,
    targetObjectId: row.targetObjectId,
    pluginModule: row.pluginModule,
    pluginInstanceId: row.pluginInstanceId,
    config: row.config,
    secretRefs: (row.secretRefs ?? {}) as Record<string, string>,
    allowedHosts: (row.allowedHosts ?? []) as string[],
    externalRef: row.externalRef ?? null
  };
}

export async function getExecutorBinding(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<ExecutorBindingRow | undefined> {
  const rows = await tx
    .select()
    .from(executorBindings)
    .where(
      and(eq(executorBindings.orgId, orgId), eq(executorBindings.targetObjectId, targetObjectId))
    )
    .limit(1);
  return rows[0] ? toRow(rows[0]) : undefined;
}

/**
 * All executor bindings for an org — the observe()-driver (`coordination/observe.ts`) enumerates
 * these, dedupes by `pluginInstanceId` (bindings sharing an instance share observe scope), and polls
 * each observe-capable instance once per tick.
 */
export async function listExecutorBindings(
  tx: TenantTx,
  orgId: string
): Promise<ExecutorBindingRow[]> {
  const rows = await tx
    .select()
    .from(executorBindings)
    .where(eq(executorBindings.orgId, orgId));
  return rows.map(toRow);
}

export interface UpsertExecutorBindingInput {
  orgId: string;
  targetObjectId: string;
  pluginModule: string;
  pluginInstanceId: string;
  config?: unknown;
  secretRefs?: Record<string, string>;
  allowedHosts?: string[];
  externalRef?: string | null;
}

export async function upsertExecutorBinding(
  tx: TenantTx,
  input: UpsertExecutorBindingInput
): Promise<ExecutorBindingRow> {
  const existing = await getExecutorBinding(tx, input.orgId, input.targetObjectId);
  if (existing) {
    const [row] = await tx
      .update(executorBindings)
      .set({
        pluginModule: input.pluginModule,
        pluginInstanceId: input.pluginInstanceId,
        config: input.config ?? {},
        secretRefs: input.secretRefs ?? {},
        allowedHosts: input.allowedHosts ?? [],
        externalRef: input.externalRef ?? null,
        updatedAt: new Date()
      })
      .where(eq(executorBindings.id, existing.id))
      .returning();
    return toRow(row!);
  }
  const [row] = await tx
    .insert(executorBindings)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      targetObjectId: input.targetObjectId,
      pluginModule: input.pluginModule,
      pluginInstanceId: input.pluginInstanceId,
      config: input.config ?? {},
      secretRefs: input.secretRefs ?? {},
      allowedHosts: input.allowedHosts ?? [],
      externalRef: input.externalRef ?? null
    })
    .returning();
  return toRow(row!);
}

/**
 * `executor_bindings.plugin_module` is a free-form string at the schema layer (validated no
 * further than "non-empty" by the route's Zod schema) — this is the only thing standing between
 * an attacker/misconfigured-operator-controlled binding and `host.start()` provisioning an
 * arbitrary subprocess module. Mirrors `governance/control-runner.ts`'s identical
 * `KNOWN_CONTROL_MODULES` allowlist pattern, scoped to the modules that are actually
 * `ExecutorPlugin`s (excludes `webhook-control` — a `ControlPlugin` — and `github-discovery`/
 * `webhook-notify`/`smtp-notify`, which are `DiscoveryPlugin`/`NotificationPlugin` and would only
 * ever produce a confusing "unknown method" RPC failure if a wave target were bound to one).
 */
export const KNOWN_EXECUTOR_MODULES: PluginModule[] = [
  "fake-executor",
  "github",
  "argocd",
  "terraform",
  "managed-iac"
];

/**
 * Exported (M8 hardening — BUILD_AND_TEST.md §8 M8 item 6, "create-time module allowlist"): until
 * now this check ran ONLY here, at dispatch time (`resolveExecutorPluginInstance`, below) — a
 * binding with an unknown/wrong-kind `pluginModule` (e.g. `webhook-control`, a `ControlPlugin`, or
 * a typo) was accepted uncomplainingly by `PUT /executors/:idOrUrn/binding` and only ever surfaced
 * as a confusing failure the next time the coordination engine tried to trigger that target.
 * `routes/executors.ts`'s binding-create handler now calls this SAME function at WRITE time —
 * defense in depth, mirroring the discovery-create route's `KNOWN_DISCOVERY_MODULES` check it was
 * always inconsistent with.
 */
export function isKnownExecutorModule(value: string): value is PluginModule {
  return (KNOWN_EXECUTOR_MODULES as string[]).includes(value);
}

export interface ResolvedExecutorInstance {
  instanceConfig: PluginHostInstanceConfig;
}

/**
 * OPERATOR/SERVER-GOVERNED settings read straight from the scpd process env — NEVER from a tenant
 * binding (adversarial-review CRITICAL #1: image/network/workspace for managed-iac must not be
 * tenant-suppliable). Read here (server-side code, full process.env) rather than threaded through
 * `config.ts` + the whole reconcile call chain, because these are pure deployment/operator knobs
 * and the plugin subprocess never sees `process.env` (host.ts's `minimalChildEnv` strips it) — the
 * ONLY channel to the plugin is the config this function injects them into.
 *
 *  - SCP_MANAGED_IAC_RUNNER_IMAGE  — the vetted, pinned `scp-runner-iac` image (unset ⇒ Mode 2 is
 *    not enabled; a managed-iac binding then fails closed with a clear error rather than defaulting
 *    to some tenant-influenceable value).
 *  - SCP_MANAGED_IAC_NETWORK_MODE  — `docker --network` (default "none").
 *  - SCP_MANAGED_IAC_WORKSPACE_ROOT — operator root the plugin derives per-(org,target) workspaces
 *    under.
 *  - SCP_PLUGIN_STATE_DIR — durable per-instance dedup-cache root (MAJOR #4): a stable on-disk
 *    path (default under the OS temp dir; operators mount a persistent volume for cross-restart
 *    durability) so an executor's idempotency cache survives a subprocess restart rather than
 *    silently degrading to in-memory-only.
 */
function managedIacServerSettings(): {
  runnerImage: string | undefined;
  networkMode: string;
  workspaceRoot: string;
} {
  return {
    runnerImage: process.env.SCP_MANAGED_IAC_RUNNER_IMAGE,
    networkMode: process.env.SCP_MANAGED_IAC_NETWORK_MODE ?? "none",
    workspaceRoot: process.env.SCP_MANAGED_IAC_WORKSPACE_ROOT ?? join(tmpdir(), "scp-managed-iac")
  };
}

function pluginStateDir(): string {
  return process.env.SCP_PLUGIN_STATE_DIR ?? join(tmpdir(), "scp-plugin-state");
}

function sanitizeInstanceId(instanceId: string): string {
  return instanceId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * Resolves `targetObjectId`'s configured executor binding into a ready-to-provision
 * `PluginHostInstanceConfig` — secret refs decrypted via `secrets/secrets-repo.ts`'s
 * `resolveSecretRefs`, plus two server-governed injections that MUST NOT come from the tenant:
 *
 *   1. A durable per-instance dedup `statePath` (MAJOR #4) — always set, so no executor's
 *      idempotency cache ever silently degrades to in-memory-only across a subprocess restart.
 *   2. For managed-iac, the vetted runnerImage/networkMode/workspaceRoot (CRITICAL #1) — spread
 *      LAST so they win over anything in `binding.config` (the tenant config schema already
 *      rejects those fields at create/update, but overriding here is defence in depth).
 *
 * Returns `undefined` when no binding is configured (caller falls back to the shared default
 * fake-executor instance) OR the module isn't a known `ExecutorPlugin`. Throws (fails closed) if a
 * managed-iac binding is used while Mode 2 isn't enabled (no runner image configured).
 */
export async function resolveExecutorPluginInstance(
  tx: TenantTx,
  input: { orgId: string; targetObjectId: string; masterKey: Buffer; domainId?: string }
): Promise<ResolvedExecutorInstance | undefined> {
  const binding = await getExecutorBinding(tx, input.orgId, input.targetObjectId);
  if (!binding) return undefined;
  if (!isKnownExecutorModule(binding.pluginModule)) {
    throw new Error(
      `executor binding for target '${input.targetObjectId}' references unknown plugin module '${binding.pluginModule}'`
    );
  }

  const resolvedSecrets = await resolveSecretRefs(
    tx,
    input.orgId,
    binding.secretRefs,
    input.masterKey
  );

  const tenantConfig = (binding.config ?? {}) as Record<string, unknown>;
  const serverInjected: Record<string, unknown> = {
    statePath: join(pluginStateDir(), `${sanitizeInstanceId(binding.pluginInstanceId)}.json`)
  };

  if (binding.pluginModule === "managed-iac") {
    const settings = managedIacServerSettings();
    if (!settings.runnerImage) {
      throw new Error(
        "managed-iac binding used but Mode 2 is not enabled (SCP_MANAGED_IAC_RUNNER_IMAGE is unset)"
      );
    }
    serverInjected.runnerImage = settings.runnerImage;
    serverInjected.networkMode = settings.networkMode;
    serverInjected.workspaceRoot = settings.workspaceRoot;
  }

  return {
    instanceConfig: {
      id: binding.pluginInstanceId,
      module: binding.pluginModule,
      orgId: input.orgId,
      domainId: input.domainId ?? "default",
      // Tenant config first, server-governed fields LAST (they win — CRITICAL #1 / MAJOR #4).
      config: { ...tenantConfig, ...serverInjected },
      secrets: resolvedSecrets,
      allowedHosts: binding.allowedHosts
    }
  };
}
