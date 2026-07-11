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
}

function toRow(row: {
  id: string;
  targetObjectId: string;
  pluginModule: string;
  pluginInstanceId: string;
  config: unknown;
  secretRefs: unknown;
  allowedHosts: unknown;
}): ExecutorBindingRow {
  return {
    id: row.id,
    targetObjectId: row.targetObjectId,
    pluginModule: row.pluginModule,
    pluginInstanceId: row.pluginInstanceId,
    config: row.config,
    secretRefs: (row.secretRefs ?? {}) as Record<string, string>,
    allowedHosts: (row.allowedHosts ?? []) as string[]
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

export interface UpsertExecutorBindingInput {
  orgId: string;
  targetObjectId: string;
  pluginModule: string;
  pluginInstanceId: string;
  config?: unknown;
  secretRefs?: Record<string, string>;
  allowedHosts?: string[];
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
      allowedHosts: input.allowedHosts ?? []
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
const KNOWN_EXECUTOR_MODULES: PluginModule[] = [
  "fake-executor",
  "github",
  "argocd",
  "terraform",
  "managed-iac"
];

function isKnownExecutorModule(value: string): value is PluginModule {
  return (KNOWN_EXECUTOR_MODULES as string[]).includes(value);
}

export interface ResolvedExecutorInstance {
  instanceConfig: PluginHostInstanceConfig;
}

/**
 * Resolves `targetObjectId`'s configured executor binding into a ready-to-provision
 * `PluginHostInstanceConfig` — secret refs decrypted via `secrets/secrets-repo.ts`'s
 * `resolveSecretRefs` (never left as opaque key names once they cross into what `host.start()`
 * injects into a subprocess env). Returns `undefined` when no binding is configured (the caller
 * falls back to the shared default fake-executor instance — `coordination/executor-config.ts`'s
 * M3 behavior, preserved unchanged for any org/target that hasn't configured a real executor yet)
 * OR when the binding's `pluginModule` isn't a known `ExecutorPlugin` module (fails closed, same
 * posture as `control-runner.ts`'s `ensureControlRun` for an unknown control module).
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

  return {
    instanceConfig: {
      id: binding.pluginInstanceId,
      module: binding.pluginModule,
      orgId: input.orgId,
      domainId: input.domainId ?? "default",
      config: binding.config,
      secrets: resolvedSecrets,
      allowedHosts: binding.allowedHosts
    }
  };
}
