import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, exists, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { categoryOfType, type ExecutorType, type ExecutorCategory } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { executorBindings, objects } from "../db/schema.js";
import { conflict, notFound } from "../errors.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { resolveSecretRefs } from "../secrets/secrets-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import type { PluginHostInstanceConfig, PluginModule } from "../plugin-host/contract.js";

/** Stable plugin-instance id for an execution-system-backed binding — every binding that references
 *  the same execution system shares this id, so they share one observe() poll + cursor. */
export function executionSystemInstanceId(executionSystemId: string): string {
  return `${EXECUTION_SYSTEM_INSTANCE_PREFIX}${executionSystemId}`;
}

/** RESERVED plugin-instance-id namespace: only `executionSystemInstanceId()` may mint ids under it. */
export const EXECUTION_SYSTEM_INSTANCE_PREFIX = "execution-system:";

/**
 * Refuse a caller-chosen `pluginInstanceId` inside the reserved execution-system namespace.
 *
 * `PluginHostInstanceConfig.id` is ONE flat keyspace, and `SubprocessPluginHost.start()` silently
 * skips an id that is already registered (host.ts — deliberate idempotency). Execution-system instance
 * ids are deterministic (`execution-system:<uuid>`), so without this guard a tenant could create an
 * INLINE binding whose `pluginInstanceId` squats the id a legitimate execution-system-backed instance
 * will later use: whichever config spawns first wins for the life of the process, and every subsequent
 * (correctly-resolved) start() for the real system is silently discarded — quietly re-pointing that
 * system's trigger/observe/status/abort traffic at a tenant-controlled config. The window reopens on
 * every worker restart. Inline bindings never get an internal-egress grant, so this is a hijack of
 * coordination traffic rather than an SSRF — but it is exactly as unacceptable, and free to close.
 */
export function assertNotReservedInstanceId(pluginInstanceId: string): void {
  if (pluginInstanceId.startsWith(EXECUTION_SYSTEM_INSTANCE_PREFIX)) {
    throw new Error(
      `pluginInstanceId '${pluginInstanceId}' uses the reserved '${EXECUTION_SYSTEM_INSTANCE_PREFIX}' namespace — ` +
        `bind via --execution-system instead of naming its instance id directly`
    );
  }
}

/**
 * `executor_bindings` — the registry-object gap `coordination/executor-config.ts`'s M3 doc
 * comment named explicitly ("that lands once ExecutorPlugin config becomes a registry object,
 * alongside GitHub/ArgoCD/Terraform in M7"): binds a Component/DeploymentTarget graph object to a
 * concrete, configured `ExecutorPlugin` instance. Modeled directly on `governance/controls-repo.ts`'s
 * `control_bindings` (1:1 binding per graph object, same upsert-by-lookup shape).
 */

/** WHICH pipeline a binding drives — the routing Type (ADR-0007). Closed set, re-exported from the
 *  schemas contract so the repo and the wire share one definition. */
export type BindingType = ExecutorType;

/** The Type reconcile resolves by default when a caller names none. Making this explicit (rather than
 *  an inline literal at each call site) keeps the default checkable in one place (ADR-0007). */
export const DEFAULT_BINDING_TYPE: BindingType = "configuration";

export interface ExecutorBindingRow {
  id: string;
  targetObjectId: string;
  type: BindingType;
  /** DERIVED, read-only (ADR-0007): the Category of `type`, via `categoryOfType`. Not stored. */
  category: ExecutorCategory;
  pluginModule: string;
  pluginInstanceId: string;
  config: unknown;
  secretRefs: Record<string, string>;
  allowedHosts: string[];
  externalRef: string | null;
  executionSystemId: string | null;
}

function toRow(row: {
  id: string;
  targetObjectId: string;
  type?: string | null;
  pluginModule: string;
  pluginInstanceId: string;
  config: unknown;
  secretRefs: unknown;
  allowedHosts: unknown;
  externalRef?: string | null;
  executionSystemId?: string | null;
}): ExecutorBindingRow {
  const type = (row.type as BindingType | null) ?? DEFAULT_BINDING_TYPE;
  return {
    id: row.id,
    targetObjectId: row.targetObjectId,
    type,
    category: categoryOfType(type),
    pluginModule: row.pluginModule,
    pluginInstanceId: row.pluginInstanceId,
    config: row.config,
    secretRefs: (row.secretRefs ?? {}) as Record<string, string>,
    allowedHosts: (row.allowedHosts ?? []) as string[],
    externalRef: row.externalRef ?? null,
    executionSystemId: row.executionSystemId ?? null
  };
}

/**
 * The binding driving ONE pipeline of a target, resolved by its routing Type (ADR-0007). `type` is
 * required-by-default rather than optional-and-arbitrary: before P3 this did `.limit(1)` with no
 * ORDER BY, which was fine under UNIQUE(org,target) but would return an ARBITRARY row once a target
 * can hold several Types. Every caller must say which pipeline it means; the default resolves the
 * 'configuration' binding.
 */
export async function getExecutorBinding(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  type: BindingType = DEFAULT_BINDING_TYPE
): Promise<ExecutorBindingRow | undefined> {
  const rows = await tx
    .select()
    .from(executorBindings)
    .where(
      and(
        eq(executorBindings.orgId, orgId),
        eq(executorBindings.targetObjectId, targetObjectId),
        eq(executorBindings.type, type)
      )
    )
    .limit(1);
  return rows[0] ? toRow(rows[0]) : undefined;
}

/**
 * WHERE fragment: the binding's target object is still LIVE (not soft-deleted). A binding whose
 * target was soft-deleted must NOT be returned — `observe.ts` (via `listExecutorBindings`) would
 * otherwise poll the gone target's plugin instance every tick forever (M12 P5c bug; there is no
 * `executor_bindings.deleted_at`, so the binding row outlives its target unless a query excludes it).
 * A correlated EXISTS keeps the SELECT binding-columns-only so `toRow` is unchanged. Applied to BOTH
 * list functions — a soft-deleted target should surface no bindings anywhere.
 */
function targetObjectIsLive(tx: TenantTx) {
  return exists(
    tx
      .select({ one: sql`1` })
      .from(objects)
      .where(and(eq(objects.id, executorBindings.targetObjectId), isNull(objects.deletedAt)))
  );
}

/** Every pipeline bound to one LIVE target (all Types) — the GET-list route and organize-after. */
export async function listExecutorBindingsForTarget(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<ExecutorBindingRow[]> {
  const rows = await tx
    .select()
    .from(executorBindings)
    .where(
      and(
        eq(executorBindings.orgId, orgId),
        eq(executorBindings.targetObjectId, targetObjectId),
        targetObjectIsLive(tx)
      )
    );
  return rows.map(toRow);
}

/**
 * All executor bindings for an org whose target is still LIVE — the observe()-driver
 * (`coordination/observe.ts`) enumerates these, dedupes by `pluginInstanceId` (bindings sharing an
 * instance share observe scope), and polls each observe-capable instance once per tick. The
 * live-target filter is load-bearing: without it, soft-deleting a component leaves its binding polled
 * forever (M12 P5c).
 */
export async function listExecutorBindings(
  tx: TenantTx,
  orgId: string
): Promise<ExecutorBindingRow[]> {
  const rows = await tx
    .select()
    .from(executorBindings)
    .where(and(eq(executorBindings.orgId, orgId), targetObjectIsLive(tx)));
  return rows.map(toRow);
}

export interface UpsertExecutorBindingInput {
  orgId: string;
  targetObjectId: string;
  /** Omitted ⇒ 'configuration' (DEFAULT_BINDING_TYPE) — the server-side default Type. */
  type?: BindingType;
  pluginModule: string;
  pluginInstanceId: string;
  config?: unknown;
  secretRefs?: Record<string, string>;
  allowedHosts?: string[];
  externalRef?: string | null;
  executionSystemId?: string | null;
}

export async function upsertExecutorBinding(
  tx: TenantTx,
  input: UpsertExecutorBindingInput
): Promise<ExecutorBindingRow> {
  // Repo-level net for the reserved instance-id namespace. An execution-system-backed binding's id is
  // SERVER-derived (executionSystemInstanceId) and legitimately uses the prefix; anything else is
  // caller-supplied and must not squat it. Enforced here, not only in the routes, so a future write
  // path can't reintroduce the hole by forgetting the check.
  if (!input.executionSystemId) {
    assertNotReservedInstanceId(input.pluginInstanceId);
  }
  // Key the "is this an update or an insert" lookup on (target, TYPE). Without the Type the lookup
  // found "the" binding and UPDATED it — which is exactly how binding a component's second pipeline
  // silently destroyed the first one before P3.
  const type = input.type ?? DEFAULT_BINDING_TYPE;
  const existing = await getExecutorBinding(tx, input.orgId, input.targetObjectId, type);
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
        executionSystemId: input.executionSystemId ?? null,
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
      type,
      pluginModule: input.pluginModule,
      pluginInstanceId: input.pluginInstanceId,
      config: input.config ?? {},
      secretRefs: input.secretRefs ?? {},
      allowedHosts: input.allowedHosts ?? [],
      externalRef: input.externalRef ?? null,
      executionSystemId: input.executionSystemId ?? null
    })
    .returning();
  return toRow(row!);
}

/**
 * Deletes a target's binding for one Type (M12 P5c) — a HARD delete (executor_bindings has no
 * soft-delete column; a binding is config, not an audited graph object). Detaching a binding is the
 * primitive that was missing: before P5c a binding could be created and repointed but never removed,
 * so a stale/mis-imported binding polled forever. Returns the deleted row (for the route to report),
 * or undefined if no such binding exists (the route 404s).
 */
export async function deleteExecutorBinding(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  type: BindingType = DEFAULT_BINDING_TYPE
): Promise<ExecutorBindingRow | undefined> {
  const [row] = await tx
    .delete(executorBindings)
    .where(
      and(
        eq(executorBindings.orgId, orgId),
        eq(executorBindings.targetObjectId, targetObjectId),
        eq(executorBindings.type, type)
      )
    )
    .returning();
  return row ? toRow(row) : undefined;
}

/**
 * Relabels which pipeline a target's binding drives (M12 P5c): moves the (target, fromType) binding
 * to (target, toType). The motivating case is a discovery-imported binding defaulted to
 * 'configuration' that is actually an `infrastructure` pipeline — and it is exactly the
 * merge-collision resolution owner ruling Q1 mandates ("relabel one first, don't guess"). Rejects
 * (409) if the target already holds a binding at toType: UNIQUE(org,target,type) forbids two, and the
 * caller must delete/repurpose that one first — surfaced as a clear conflict, not a raw
 * unique-violation. A same-type relabel is an idempotent no-op. Returns undefined if no (target,
 * fromType) binding exists (route 404s).
 */
export async function setExecutorBindingType(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  fromType: BindingType,
  toType: BindingType
): Promise<ExecutorBindingRow | undefined> {
  const existing = await getExecutorBinding(tx, orgId, targetObjectId, fromType);
  if (!existing) return undefined;
  if (fromType === toType) return existing; // idempotent no-op relabel

  const clash = await getExecutorBinding(tx, orgId, targetObjectId, toType);
  if (clash) {
    throw conflict(
      `target '${targetObjectId}' already has a '${toType}' binding — delete or repurpose it before relabelling the '${fromType}' one`
    );
  }
  const [row] = await tx
    .update(executorBindings)
    .set({ type: toType, updatedAt: new Date() })
    .where(eq(executorBindings.id, existing.id))
    .returning();
  return toRow(row!);
}

/**
 * Re-points a binding onto a DIFFERENT target object (M12 P5d merge) — moves the binding from its
 * current target onto `newTargetObjectId`, keeping its Type. The caller (`mergeComponents`) verifies
 * the destination has no binding at this Type first (owner Q1: reject-and-relabel, no
 * auto-collision); this still catches a concurrent racer at `UNIQUE(org,target,type)` and surfaces
 * the same one-per-Type 409 rather than a raw unique-violation.
 */
export async function repointExecutorBindingTarget(
  tx: TenantTx,
  orgId: string,
  bindingId: string,
  newTargetObjectId: string
): Promise<ExecutorBindingRow> {
  try {
    const [row] = await tx
      .update(executorBindings)
      .set({ targetObjectId: newTargetObjectId, updatedAt: new Date() })
      .where(and(eq(executorBindings.orgId, orgId), eq(executorBindings.id, bindingId)))
      .returning();
    if (!row) throw notFound(`executor binding '${bindingId}' not found`);
    return toRow(row);
  } catch (err) {
    if (isUniqueViolation(err, "executor_bindings_org_target_type_key")) {
      throw conflict(
        `target '${newTargetObjectId}' already has a binding for this type — relabel one first`
      );
    }
    throw err;
  }
}

/**
 * `executor_bindings.plugin_module` is a free-form string at the schema layer (validated no
 * further than "non-empty" by the route's Zod schema) — this is the only thing standing between
 * an attacker/misconfigured-operator-controlled binding and `host.start()` provisioning an
 * arbitrary subprocess module. Mirrors `governance/control-runner.ts`'s identical
 * `KNOWN_CONTROL_MODULES` allowlist pattern, scoped to the modules that are actually
 * `ExecutorPlugin`s (excludes `webhook-control` — a `ControlPlugin` — and `github-discovery`/
 * `gitea-discovery`/`webhook-notify`/`smtp-notify`, which are `DiscoveryPlugin`/`NotificationPlugin`
 * and would only ever produce a confusing "unknown method" RPC failure if a wave target were bound
 * to one).
 */
export const KNOWN_EXECUTOR_MODULES: PluginModule[] = [
  "fake-executor",
  "github",
  "gitea",
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
/**
 * SCP_INTERNAL_EGRESS_HOSTS — the operator's allowlist of hostnames a plugin may reach even when they
 * resolve to a loopback/private address (an in-cluster Argo CD ClusterIP, an on-prem executor by
 * RFC1918 name). Comma-separated hostnames (NOT URLs, NOT CIDRs), e.g.
 * `argocd-server.argocd.svc.cluster.local`. Unset (the default) ⇒ NO plugin may ever reach an internal
 * address — the pre-existing SSRF posture (egress-guard.ts, MAJOR #6) is completely unchanged.
 *
 * This is the HARD security boundary for internal egress, and it lives here — at the same host-level,
 * operator-configured, NEVER-tenant-suppliable trust tier as SCP_MANAGED_IAC_RUNNER_IMAGE above —
 * precisely BECAUSE it must not depend on graph/RBAC state being right. An execution-system's
 * `allowInternalEgress` property (layer 2) is a per-system DECLARATION of intent, not a grant: a
 * tenant who sets it on a system pointing at an un-allowlisted host gets nothing. Both layers must
 * agree (`resolveInternalEgress`), so a mistake in who-can-write-what can never become an SSRF.
 * See docs/adr/0003-internal-egress-for-execution-systems.md.
 */
function internalEgressHostAllowlist(): Set<string> {
  return new Set(
    (process.env.SCP_INTERNAL_EGRESS_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0)
  );
}

/**
 * Layer 1 (operator env allowlist) AND layer 2 (the execution-system's declared intent) must BOTH
 * permit, else no internal egress. Fail-closed on every edge: not declared, unparseable serverUrl, or
 * a host the operator never allowlisted ⇒ false. Exported so the discovery path (routes/executors.ts)
 * resolves it identically to the binding path — one function, one answer.
 */
export function resolveInternalEgress(
  serverUrl: string | undefined,
  declaredByExecutionSystem: boolean
): boolean {
  if (!declaredByExecutionSystem || !serverUrl) return false;
  let hostname: string;
  try {
    hostname = new URL(serverUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return internalEgressHostAllowlist().has(hostname);
}

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
  input: {
    orgId: string;
    targetObjectId: string;
    masterKey: Buffer;
    domainId?: string;
    /** Which pipeline to resolve — the routing Type (ADR-0007). Defaults to 'configuration'. P4A
     *  supplies this from the wave target, so reconcile starts the instance for the pipeline it is
     *  about to trigger. */
    type?: BindingType;
  }
): Promise<ResolvedExecutorInstance | undefined> {
  const binding = await getExecutorBinding(
    tx,
    input.orgId,
    input.targetObjectId,
    input.type ?? DEFAULT_BINDING_TYPE
  );
  if (!binding) return undefined;

  // Resolve the effective plugin identity + config from one of two sources:
  //   - execution-system-backed (M12 P2): a shared `execution-system` graph object supplies the
  //     module (its `kind`), serverUrl, and token — so many bindings coordinate one system without
  //     re-specifying its URL/token, and all share ONE plugin instance (hence one observe poll).
  //   - inline (pre-M12, unchanged): the binding itself carries module/config/secretRefs.
  let pluginModule: string = binding.pluginModule;
  let pluginInstanceId = binding.pluginInstanceId;
  let tenantConfig = (binding.config ?? {}) as Record<string, unknown>;
  let secretRefs = binding.secretRefs;
  // Two-layer internal-egress allowance (ADR-0003): the execution-system's declared intent AND the
  // operator's SCP_INTERNAL_EGRESS_HOSTS allowlist must BOTH permit. Never from tenant binding config.
  let allowInternalEgress = false;
  // Tenant-supplied by default; REPLACED by the execution-system's own host when it backs this binding.
  let effectiveAllowedHosts = binding.allowedHosts;

  if (binding.executionSystemId) {
    const sys = await getObjectByIdOrUrnAnyType(tx, input.orgId, binding.executionSystemId);
    if (sys.typeId !== "execution-system") {
      throw new Error(
        `executor binding for target '${input.targetObjectId}' references '${binding.executionSystemId}', which is a '${sys.typeId}', not an execution-system`
      );
    }
    const props = sys.properties as {
      kind?: string;
      serverUrl?: string;
      tokenSecretKey?: string;
      allowInternalEgress?: boolean;
    };
    // Layer 2 (declared intent) is checked against layer 1 (the operator's env allowlist) inside
    // resolveInternalEgress — the property alone NEVER grants anything.
    allowInternalEgress = resolveInternalEgress(props.serverUrl, props.allowInternalEgress === true);
    // Pin egress to the system's OWN host (server-governed), so an internal-egress grant can only ever
    // reach the registered system — never a tenant-chosen `binding.allowedHosts` entry. This, not the
    // permission gate alone, is what keeps the allowance narrow (egress-guard.ts, MAJOR #6).
    if (props.serverUrl) {
      try {
        effectiveAllowedHosts = [new URL(props.serverUrl).hostname];
      } catch {
        throw new Error(
          `execution-system '${sys.id}' has an unparseable 'serverUrl' — refusing to resolve a binding against it`
        );
      }
    }
    if (!props.serverUrl) {
      throw new Error(`execution-system '${sys.id}' is missing a 'serverUrl' property`);
    }
    pluginModule = (props.kind ?? "").trim();
    pluginInstanceId = executionSystemInstanceId(sys.id);
    // The plugin reads its token via `ctx.secrets.get(<tokenSecretKey>)` (e.g. the Argo CD plugin);
    // the system's tokenSecretKey is both the config field name AND the secrets-table key.
    tenantConfig = {
      serverUrl: props.serverUrl,
      ...(props.tokenSecretKey ? { tokenSecretKey: props.tokenSecretKey } : {})
    };
    secretRefs = props.tokenSecretKey ? { [props.tokenSecretKey]: props.tokenSecretKey } : {};
  }

  if (!isKnownExecutorModule(pluginModule)) {
    throw new Error(
      `executor binding for target '${input.targetObjectId}' resolves to unknown or non-executor plugin module '${pluginModule}'`
    );
  }

  const resolvedSecrets = await resolveSecretRefs(tx, input.orgId, secretRefs, input.masterKey);

  const serverInjected: Record<string, unknown> = {
    statePath: join(pluginStateDir(), `${sanitizeInstanceId(pluginInstanceId)}.json`)
  };

  if (pluginModule === "managed-iac") {
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
      id: pluginInstanceId,
      module: pluginModule as PluginModule,
      orgId: input.orgId,
      domainId: input.domainId ?? "default",
      // Tenant config first, server-governed fields LAST (they win — CRITICAL #1 / MAJOR #4).
      config: { ...tenantConfig, ...serverInjected },
      secrets: resolvedSecrets,
      allowedHosts: effectiveAllowedHosts,
      allowInternalEgress
    }
  };
}
