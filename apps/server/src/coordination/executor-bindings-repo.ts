import { tmpdir } from "node:os";
import type {
  KubernetesLauncherSettings,
  KubernetesRunnerPodConventions
} from "@scp/runner-launcher";
import { join } from "node:path";
import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { categoryOfType, type ExecutorType, type ExecutorCategory } from "@scp/schemas";
import type { ExecutorLane } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { executorBindings, objects } from "../db/schema.js";
import { argoOpsPinsForOrg } from "./ops-argo-pin.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { resolveSecretRefs } from "../secrets/secrets-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { managedIacWorkspaceKey, ManagedIacWorkspaceRefInvalid } from "@scp/plugin-managed-iac";
import { isLocallyAuthoredExecutionSystem } from "../authz/execution-system-routing-door.js";
import { stackWiredRouting } from "../stack/wired-routing.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import type { PluginHostInstanceConfig, PluginModule } from "../plugin-host/contract.js";
import { assertManagedTimeoutSchemas } from "../plugin-host/call-policy.js";
import {
  assertEveryModuleHasManifest,
  assertNoSystemOnlyConfig,
  declaredConfigKeys,
  withoutSystemOnlyConfig
} from "../plugin-host/plugin-manifests.js";

/** Stable plugin-instance id for an execution-system-backed binding — every binding that references
 *  the same execution system shares this id, so they share one observe() poll + cursor. */
export function executionSystemInstanceId(executionSystemId: string): string {
  return `${EXECUTION_SYSTEM_INSTANCE_PREFIX}${executionSystemId}`;
}

/** The plugin config a SYSTEM-BACKED binding runs with, derived from the execution-system object.
 *
 *  `serverUrl` + `tokenSecretKey` are not the whole config surface: argo-workflows REQUIRES
 *  `namespace` and interpolates it into every API path, so a config built from those two keys alone
 *  submitted to `/api/v1/workflows/undefined/submit` — silently, with no error at bind or resolve.
 *
 *  Only keys the module's manifest DECLARES are carried. An execution-system's `properties` need
 *  `secret:write` at the org root (ADR-0056 addendum 3), and a replicated system is refused above;
 *  intersecting with the declared set still keeps even that writer from introducing a config key
 *  the plugin never advertised, and server-injected keys (`statePath`,
 *  `runnerImage`, …) are absent from every `configSchema` by construction. `serverUrl` is always
 *  written from the system itself, so egress stays pinned to the system's own host.
 *
 *  NOT VALIDATED AGAINST THE MODULE'S SCHEMA, deliberately. This branch REPLACES the binding's own
 *  `config` rather than merging it, and several modules' required keys are per-BINDING rather than
 *  per-system — `gitea` requires `owner`/`repo`, `github` adds `appId`/`installationId`,
 *  `terraform` and `pipeline-generic` require `triggerUrl`. A system-derived config therefore
 *  cannot satisfy those schemas, and running `validatePluginConfig` here refuses every gitea and
 *  github system-backed binding (caught by `executors.integration.test.ts`'s M15.1b gitea case).
 *  That those modules resolve to a config missing their own required keys is a REAL pre-existing
 *  gap, and a separate one: closing it means deciding whether a system-backed binding may merge
 *  binding-level config, which is a design question, not a rename. Tracked, not smuggled in here. */
export function executionSystemPluginConfig(
  props: { serverUrl?: string; tokenSecretKey?: string },
  pluginModule: string
): Record<string, unknown> {
  const carried: Record<string, unknown> = {};
  for (const key of declaredConfigKeys(pluginModule)) {
    if (key === "serverUrl" || key === "tokenSecretKey") continue;
    const value = (props as Record<string, unknown>)[key];
    if (value !== undefined) carried[key] = value;
  }
  return {
    ...carried,
    serverUrl: props.serverUrl,
    ...(props.tokenSecretKey ? { tokenSecretKey: props.tokenSecretKey } : {})
  };
}

/** managed-iac's one Type (ADR-0056 addendum 4) and the index that makes its workspace one binding's. */
export const MANAGED_IAC_BINDING_TYPE: BindingType = "infrastructure";
const MANAGED_IAC_WORKSPACE_INDEX = "executor_bindings_managed_iac_workspace_uq";

/** RESERVED plugin-instance-id namespace: only `executionSystemInstanceId()` may mint ids under it. */
export const EXECUTION_SYSTEM_INSTANCE_PREFIX = "execution-system:";

/** The charset a caller-supplied plugin instance id must match: no whitespace, quotes or
 *  brackets, so an id can never carry text a reader of an error message could mistake for anything
 *  else. (':' is allowed; the reserved `execution-system:` prefix is refused separately.) */
export const SAFE_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Refuse an instance id inside the reserved namespace. See docs/coordination.md §434. */
export function assertNotReservedInstanceId(pluginInstanceId: string): void {
  if (pluginInstanceId.startsWith(EXECUTION_SYSTEM_INSTANCE_PREFIX)) {
    throw new Error(
      `pluginInstanceId '${pluginInstanceId}' uses the reserved '${EXECUTION_SYSTEM_INSTANCE_PREFIX}' namespace — ` +
        `bind via --execution-system instead of naming its instance id directly`
    );
  }
  // A SAFE CHARSET for every caller-supplied id (M28.4 review round 3). An instance id is echoed
  // into host error text (`plugin '<id>' RPC error: …`), logs and Decisions; free text there let a
  // tenant plant a string that later parsing mistook for a plugin's verdict (probe F). Validated on
  // WRITE only — the /v1 schemas are unchanged, so no stored row or response shape moves.
  if (!SAFE_INSTANCE_ID.test(pluginInstanceId)) {
    throw badRequest(
      `pluginInstanceId must be 1–128 characters of letters, digits, '.', '_', ':' or '-', starting ` +
        `with a letter or digit`
    );
  }
}

/** `executor_bindings`, the registry-object gap it fills. See docs/coordination.md §435. */

/** WHICH pipeline a binding drives — the routing Type (ADR-0007). Closed set, re-exported from the
 *  schemas contract so the repo and the wire share one definition. */
export type BindingType = ExecutorType;

/** The Type reconcile resolves by default when a caller names none. Making this explicit (rather than
 *  an inline literal at each call site) keeps the default checkable in one place (ADR-0007). */
export const DEFAULT_BINDING_TYPE: BindingType = "configuration";

/** Turns an execution-system object into a binding identity. See docs/coordination.md §436. */
export function executionSystemBindingIdentity(
  sys: { id: string; typeId: string; properties: unknown; originDomainId: string },
  reference: string,
  selfDomainId: string
): { pluginModule: string; pluginInstanceId: string; executionSystemId: string } {
  if (sys.typeId !== "execution-system") {
    throw badRequest(`'${reference}' is a '${sys.typeId}', not an execution-system`);
  }
  // The write-door twin of the resolver's refusal: binding to a REPLICATED system would hand a
  // peer's routing this instance's credentials (`isLocallyAuthoredExecutionSystem`).
  if (!isLocallyAuthoredExecutionSystem(sys, selfDomainId)) {
    throw badRequest(
      `execution-system '${sys.id}' was authored by domain '${sys.originDomainId}' and replicated ` +
        `here; a replicated system is not executable at this domain. Register this domain's own ` +
        `system (scp connect) and bind to that.`
    );
  }
  const props = sys.properties as { kind?: string; serverUrl?: string };
  if (!props.serverUrl) {
    throw badRequest(`execution-system '${sys.id}' is missing a 'serverUrl' property`);
  }
  const pluginModule = (props.kind ?? "").trim();
  if (!isKnownExecutorModule(pluginModule)) {
    throw badRequest(`execution-system kind '${pluginModule}' is not a known executor module`);
  }
  return {
    pluginModule,
    pluginInstanceId: executionSystemInstanceId(sys.id),
    executionSystemId: sys.id
  };
}

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

/** The binding driving one pipeline, resolved by its Type. See docs/coordination.md §437. */
export async function getExecutorBinding(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  type: BindingType = DEFAULT_BINDING_TYPE,
  /** ADR-0046 §4 / §14 res 7 — WHICH LANE. See docs/coordination.md §438. */
  lane: ExecutorLane = "build"
): Promise<ExecutorBindingRow | undefined> {
  const rows = await tx
    .select()
    .from(executorBindings)
    .where(
      and(
        eq(executorBindings.orgId, orgId),
        eq(executorBindings.targetObjectId, targetObjectId),
        eq(executorBindings.type, type),
        eq(executorBindings.lane, lane)
      )
    )
    .limit(1);
  return rows[0] ? toRow(rows[0]) : undefined;
}

/** WHERE fragment: the binding's target object is still LIVE. See docs/coordination.md §439. */
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

/** Every binding in an org whose target is still live. See docs/coordination.md §440. */
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

/** Every binding whose target is one of `targetObjectIds`. See docs/coordination.md §441. */
export async function listExecutorBindingsForTargets(
  tx: TenantTx,
  orgId: string,
  targetObjectIds: string[]
): Promise<ExecutorBindingRow[]> {
  if (targetObjectIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(executorBindings)
    .where(
      and(
        eq(executorBindings.orgId, orgId),
        inArray(executorBindings.targetObjectId, targetObjectIds),
        targetObjectIsLive(tx)
      )
    );
  return rows.map(toRow);
}

/** Resolves the bound target's locality for the audit append. See docs/coordination.md §442. */
async function targetDomainLocal(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string
): Promise<boolean> {
  const rows = await tx
    .select({ domainLocal: objects.domainLocal })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), eq(objects.id, targetObjectId)))
    .limit(1);
  return rows[0]?.domainLocal ?? false;
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
  /** @default "build" — see `getExecutorBinding`'s `lane` for why it is filtered, not just stored. */
  lane?: ExecutorLane;
  /** ADR-0046 §4 — the winning policy's object id when the domain reconciler derived this row;
   *  omitted (NULL) for a hand-authored binding, which is what keeps the reconciler's prune off
   *  one-offs. Provenance is read from the row, never inferred from what matches now. */
  managedByPolicyId?: string | null;
  /** WHO/WHAT REQUEST is doing this write. See docs/coordination.md §443. */
  actorObjectId: string;
  requestId: string;
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
    // The repo-level net for execution-system-only config keys (ADR-0055 D9): every inline write
    // door — the route, the IaC apply, the binding-policy reconciler — passes through here.
    assertNoSystemOnlyConfig(input.pluginModule, input.config);
  }
  // managed-iac's externalRef NAMES A DIRECTORY (its workspace). Refused here, at every binding write
  // door, unless it is already a plain name — the plugin refuses rather than maps it too, so no two
  // refs can reach one directory and `..` reaches nothing (#417 probes G and H).
  if (input.pluginModule === "managed-iac" && input.externalRef != null) {
    try {
      managedIacWorkspaceKey(input.externalRef);
    } catch (err) {
      if (err instanceof ManagedIacWorkspaceRefInvalid) throw badRequest(err.message);
      throw err;
    }
  }
  // …and managed-iac serves ONE pipeline: `infrastructure`, where the apply gate is. Bound as any
  // other Type its trigger bypasses the lane — and the workspace collision check with it (probe I).
  if (
    input.pluginModule === "managed-iac" &&
    (input.type ?? DEFAULT_BINDING_TYPE) !== MANAGED_IAC_BINDING_TYPE
  ) {
    throw badRequest(
      `a managed-iac binding drives the '${MANAGED_IAC_BINDING_TYPE}' pipeline only — its plans and ` +
        `applies go through the infrastructure lane's gate (ADR-0056 addendum 4); bind it with type ` +
        `'${MANAGED_IAC_BINDING_TYPE}'`
    );
  }
  // Key the "is this an update or an insert" lookup on (target, TYPE). Without the Type the lookup
  // found "the" binding and UPDATED it — which is exactly how binding a component's second pipeline
  // silently destroyed the first one before P3.
  const type = input.type ?? DEFAULT_BINDING_TYPE;
  // …and on the LANE, for the reason that parameter's doc gives: without it this lookup finds "the"
  // binding for (target, Type) and UPDATES it, so writing a test-lane binding would silently destroy
  // the build-lane one — the identical failure the paragraph above records for Type.
  const lane = input.lane ?? "build";
  const existing = await getExecutorBinding(tx, input.orgId, input.targetObjectId, type, lane);
  let row: ExecutorBindingRow;
  try {
    if (existing) {
      const [updated] = await tx
        .update(executorBindings)
        .set({
          pluginModule: input.pluginModule,
          pluginInstanceId: input.pluginInstanceId,
          config: input.config ?? {},
          secretRefs: input.secretRefs ?? {},
          allowedHosts: input.allowedHosts ?? [],
          externalRef: input.externalRef ?? null,
          executionSystemId: input.executionSystemId ?? null,
          managedByPolicyId: input.managedByPolicyId ?? null,
          updatedAt: new Date()
        })
        .where(eq(executorBindings.id, existing.id))
        .returning();
      row = toRow(updated!);
    } else {
      const [inserted] = await tx
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
          executionSystemId: input.executionSystemId ?? null,
          lane,
          managedByPolicyId: input.managedByPolicyId ?? null
        })
        .returning();
      row = toRow(inserted!);
    }
  } catch (err) {
    if (isUniqueViolation(err, MANAGED_IAC_WORKSPACE_INDEX)) {
      throw conflict(
        `another managed-iac binding in this organization already uses the workspace ` +
          `'${input.externalRef ?? input.targetObjectId}' (case-insensitively) — one workspace belongs ` +
          `to one binding, or one target's plan would overwrite another's (ADR-0056 addendum 4)`
      );
    }
    throw err;
  }
  // NEVER config/secrets — `reason` carries only the identity a binding is keyed on (target, Type,
  // which plugin), the same restraint `beforeHash`/`afterHash` observe for object mutations (those
  // hash the properties rather than inline them; a binding's `config`/`secretRefs` has no such hash
  // to point at, so the honest choice is to name neither in the audit row at all).
  await appendAuditEvent(tx, {
    orgId: input.orgId,
    actorId: input.actorObjectId,
    action: "executor.binding.put",
    subjectId: input.targetObjectId,
    reason: `${existing ? "updated" : "created"} '${row.type}' binding on '${input.targetObjectId}' -> plugin '${row.pluginModule}'${row.executionSystemId ? ` (execution-system '${row.executionSystemId}')` : ""}`,
    requestId: input.requestId,
    // ADR-0031 S2 / M20.2 — a domain-local target's binding lifecycle must not journal its id to
    // peers, same as every other audited mutation of it.
    subjectDomainLocal: await targetDomainLocal(tx, input.orgId, input.targetObjectId)
  });
  return row;
}

/** Deletes a target's binding for one Type (M12 P5c). See docs/coordination.md §444. */
/** THE LANE FALLBACK, IN ONE PLACE. See docs/coordination.md §445. */
export async function resolveLaneBinding(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  type: BindingType = DEFAULT_BINDING_TYPE,
  lane: ExecutorLane = "build"
): Promise<{ row: ExecutorBindingRow; viaLaneFallback: boolean } | undefined> {
  const own = await getExecutorBinding(tx, orgId, targetObjectId, type, lane);
  if (own) return { row: own, viaLaneFallback: false };
  if (lane === "build") return undefined;
  const build = await getExecutorBinding(tx, orgId, targetObjectId, type, "build");
  return build ? { row: build, viaLaneFallback: true } : undefined;
}

export async function deleteExecutorBinding(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  type: BindingType = DEFAULT_BINDING_TYPE,
  // REQUIRED, not optional: an optional pair here is exactly the shape that lets a future caller
  // silently skip the audit event by omission (the failure mode this increment exists to close —
  // `executor.binding.put`/`.delete` had NO caller writing them at all until now). Both current
  // callers (the DELETE route, `coordination-as-code/plans-repo.ts`'s apply-time prune) already hold both.
  actorObjectId: string,
  requestId: string,
  /** WHICH LANE to delete. See docs/coordination.md §446. */
  lane: ExecutorLane = "build"
): Promise<ExecutorBindingRow | undefined> {
  const [deleted] = await tx
    .delete(executorBindings)
    .where(
      and(
        eq(executorBindings.orgId, orgId),
        eq(executorBindings.targetObjectId, targetObjectId),
        eq(executorBindings.type, type),
        eq(executorBindings.lane, lane)
      )
    )
    .returning();
  if (!deleted) return undefined;
  const row = toRow(deleted);
  await appendAuditEvent(tx, {
    orgId,
    actorId: actorObjectId,
    action: "executor.binding.delete",
    subjectId: targetObjectId,
    reason: `deleted '${row.type}' binding on '${targetObjectId}' -> plugin '${row.pluginModule}'`,
    subjectDomainLocal: await targetDomainLocal(tx, orgId, targetObjectId),
    requestId
  });
  return row;
}

/** Relabels which pipeline a target's binding drives. See docs/coordination.md §447. */
export async function setExecutorBindingType(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  fromType: BindingType,
  toType: BindingType,
  actorObjectId: string,
  requestId: string
): Promise<ExecutorBindingRow | undefined> {
  const existing = await getExecutorBinding(tx, orgId, targetObjectId, fromType);
  if (!existing) return undefined;
  if (fromType === toType) return existing; // idempotent no-op relabel
  // The relabel door is a binding write too: managed-iac drives `infrastructure` only (probe I).
  if (existing.pluginModule === "managed-iac" && toType !== MANAGED_IAC_BINDING_TYPE) {
    throw conflict(
      `a managed-iac binding drives the '${MANAGED_IAC_BINDING_TYPE}' pipeline only — it cannot be ` +
        `relabelled '${toType}'`
    );
  }

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
  const updated = toRow(row!);
  await appendAuditEvent(tx, {
    orgId,
    actorId: actorObjectId,
    action: "executor.binding.retype",
    subjectId: targetObjectId,
    reason: `relabelled binding on '${targetObjectId}' from '${fromType}' to '${toType}' -> plugin '${updated.pluginModule}'`,
    subjectDomainLocal: await targetDomainLocal(tx, orgId, targetObjectId),
    requestId
  });
  return updated;
}

/** Re-points a binding onto a DIFFERENT target object. See docs/coordination.md §448. */
export async function repointExecutorBindingTarget(
  tx: TenantTx,
  orgId: string,
  bindingId: string,
  newTargetObjectId: string,
  actorObjectId: string,
  requestId: string
): Promise<ExecutorBindingRow> {
  let row: typeof executorBindings.$inferSelect | undefined;
  try {
    [row] = await tx
      .update(executorBindings)
      .set({ targetObjectId: newTargetObjectId, updatedAt: new Date() })
      .where(and(eq(executorBindings.orgId, orgId), eq(executorBindings.id, bindingId)))
      .returning();
  } catch (err) {
    if (isUniqueViolation(err, "executor_bindings_org_target_type_lane_key")) {
      throw conflict(
        `target '${newTargetObjectId}' already has a binding for this type — relabel one first`
      );
    }
    throw err;
  }
  if (!row) throw notFound(`executor binding '${bindingId}' not found`);
  const updated = toRow(row);
  await appendAuditEvent(tx, {
    orgId,
    actorId: actorObjectId,
    action: "executor.binding.repoint",
    subjectId: newTargetObjectId,
    reason: `re-pointed '${updated.type}' binding '${bindingId}' onto '${newTargetObjectId}' -> plugin '${updated.pluginModule}'`,
    subjectDomainLocal: await targetDomainLocal(tx, orgId, newTargetObjectId),
    requestId
  });
  return updated;
}

/** The module is free-form at the schema layer, checked here. See docs/coordination.md §449. */
export const KNOWN_EXECUTOR_MODULES: PluginModule[] = [
  "fake-executor",
  "github",
  "gitea",
  "gitlab",
  "argocd",
  "argo-workflows",
  "terraform",
  "pipeline-generic",
  "managed-iac",
  "managed-scan",
  // M21.5 — the third managed executor. See docs/coordination.md §450.
  "managed-dep",
  // M27 — host-reaching managed execution. Unlike the three above, a run holds host login-grade
  // credentials, so its server-injected config carries the bound as well as the image.
  "managed-ops"
];

/** Being allowlisted and having a config schema differ. See docs/coordination.md §451. */
assertEveryModuleHasManifest(KNOWN_EXECUTOR_MODULES, "KNOWN_EXECUTOR_MODULES");

/** The second property of that manifest, checked here too. See docs/coordination.md §452. */
assertManagedTimeoutSchemas();

/** Exported for the create-time module allowlist. See docs/coordination.md §453. */
export function isKnownExecutorModule(value: string): value is PluginModule {
  return (KNOWN_EXECUTOR_MODULES as string[]).includes(value);
}

export interface ResolvedExecutorInstance {
  instanceConfig: PluginHostInstanceConfig;
}

/** Operator-governed settings, read from the process env. See docs/coordination.md §454. */
/** The operator's allowlist of hostnames a plugin may reach. See docs/coordination.md §455. */
function internalEgressHostAllowlist(): Set<string> {
  return new Set(
    (process.env.SCP_INTERNAL_EGRESS_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0)
  );
}

/** Both layers must permit it, not either one alone. See docs/coordination.md §456. */
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

/** Server-governed managed-scan runner settings. See docs/coordination.md §457. */
export function managedScanServerSettings(): {
  runnerImage: string | undefined;
  networkMode: string;
  workspaceRoot: string;
  dbCacheDir: string | undefined;
} {
  const dbCacheDir = process.env.SCP_MANAGED_SCAN_DB_CACHE;
  return {
    runnerImage: process.env.SCP_MANAGED_SCAN_RUNNER_IMAGE,
    networkMode: process.env.SCP_MANAGED_SCAN_NETWORK_MODE ?? "none",
    workspaceRoot:
      process.env.SCP_MANAGED_SCAN_WORKSPACE_ROOT ?? join(tmpdir(), "scp-managed-scan"),
    dbCacheDir: dbCacheDir && dbCacheDir.trim().length > 0 ? dbCacheDir.trim() : undefined
  };
}

/**
 * DEFENCE IN DEPTH for the managed executors' `dockerBinary` — the config key that decides WHICH
 * EXECUTABLE `@scp/plugin-managed-iac` and `@scp/plugin-managed-scan` `execFile`.
 *
 * DECISION (and it is a deliberate one, not a reflex): yes, inject it, for every managed executor,
 * regardless of schema. Both plugins already did `config.dockerBinary ?? "docker"`, and the ONLY
 * thing that stopped a tenant choosing that value was `validatePluginConfig` refusing the key at the
 * write door. That is a single point of failure of exactly the kind that just failed: `managed-scan`
 * carried a doc comment claiming the schema protected it while the schema was never consulted at all
 * (no entry in `MANIFEST_BY_MODULE`). Injecting here — LAST in the spread, so it wins — means a
 * future regression in the write-door gate downgrades from remote code execution to an accepted-but-
 * inert config key. The two defences now fail independently.
 *
 * SCP_MANAGED_RUNNER_DOCKER_BINARY — operator/server-governed, same trust tier as
 * SCP_MANAGED_IAC_RUNNER_IMAGE. Default `"docker"`, i.e. byte-identical behaviour to before for
 * every deployment that does not set it; an operator running podman-as-docker sets it once.
 */
function managedRunnerDockerBinary(): string {
  const value = process.env.SCP_MANAGED_RUNNER_DOCKER_BINARY?.trim();
  return value && value.length > 0 ? value : "docker";
}

/** WHICH LAUNCHER ADAPTER EVERY MANAGED EXECUTOR USES. See docs/coordination.md §458. */
function managedRunnerLauncherKind(): "docker" | "kubernetes" {
  return process.env.SCP_MANAGED_RUNNER_LAUNCHER?.trim() === "kubernetes" ? "kubernetes" : "docker";
}

/** THE KUBERNETES LAUNCHER'S DEPLOYMENT SETTINGS. See docs/coordination.md §459. */
/** THE DEPLOYMENT'S POD CONVENTIONS FOR THE RUNNER JOB. See docs/coordination.md §460. */
const DNS_1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const K8S_RESOURCE_NAME = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?(\/[a-z0-9]([-a-z0-9.]*[a-z0-9])?)?$/;
/** A Kubernetes QUANTITY: `250m`, `1`, `512Mi`, `1.5`, `2Gi`, `1e3`. Deliberately narrow — anything
 *  this does not match is refused rather than sent to the API server to be rejected there. */
const K8S_QUANTITY = /^[+-]?([0-9.]+)([eEinumkKMGTP]*[0-9]*)$/;

const RUNNER_PULL_POLICIES = ["Always", "IfNotPresent", "Never"] as const;

function refuseRunnerPodConvention(envVar: string, detail: string): never {
  throw new Error(
    `${envVar} is not a valid value for the Kubernetes runner launcher: ${detail}. ` +
      `This variable lands verbatim in the pod spec of every managed run, so it is refused here ` +
      `rather than dropped — a dropped pull secret is an ErrImagePull minutes into a promotion ` +
      `with nothing naming the cause.`
  );
}

function managedRunnerPodConventions(): KubernetesRunnerPodConventions | undefined {
  const out: {
    imagePullSecrets?: string[];
    imagePullPolicy?: (typeof RUNNER_PULL_POLICIES)[number];
    resources?: { requests?: Record<string, string>; limits?: Record<string, string> };
  } = {};

  const secretsRaw = process.env.SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_SECRETS?.trim();
  if (secretsRaw) {
    const names = secretsRaw
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    for (const name of names) {
      if (name.length > 253 || !DNS_1123_SUBDOMAIN.test(name)) {
        refuseRunnerPodConvention(
          "SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_SECRETS",
          `${JSON.stringify(name)} is not a Secret name (RFC 1123 subdomain, <=253 chars)`
        );
      }
    }
    if (names.length > 0) out.imagePullSecrets = names;
  }

  const policy = process.env.SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_POLICY?.trim();
  if (policy) {
    if (!(RUNNER_PULL_POLICIES as readonly string[]).includes(policy)) {
      refuseRunnerPodConvention(
        "SCP_MANAGED_RUNNER_K8S_IMAGE_PULL_POLICY",
        `${JSON.stringify(policy)} is not one of ${RUNNER_PULL_POLICIES.join("|")}`
      );
    }
    out.imagePullPolicy = policy as (typeof RUNNER_PULL_POLICIES)[number];
  }

  const resourcesRaw = process.env.SCP_MANAGED_RUNNER_K8S_RESOURCES?.trim();
  if (resourcesRaw && resourcesRaw !== "{}" && resourcesRaw !== "null") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(resourcesRaw);
    } catch {
      refuseRunnerPodConvention("SCP_MANAGED_RUNNER_K8S_RESOURCES", "not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      refuseRunnerPodConvention("SCP_MANAGED_RUNNER_K8S_RESOURCES", "expected a JSON object");
    }
    const resources: { requests?: Record<string, string>; limits?: Record<string, string> } = {};
    for (const [side, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (side !== "requests" && side !== "limits") {
        refuseRunnerPodConvention(
          "SCP_MANAGED_RUNNER_K8S_RESOURCES",
          `unknown key ${JSON.stringify(side)} — only "requests" and "limits" are accepted`
        );
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        refuseRunnerPodConvention(
          "SCP_MANAGED_RUNNER_K8S_RESOURCES",
          `${side} must be a flat object`
        );
      }
      const sideOut: Record<string, string> = {};
      for (const [resource, quantity] of Object.entries(value as Record<string, unknown>)) {
        if (!K8S_RESOURCE_NAME.test(resource)) {
          refuseRunnerPodConvention(
            "SCP_MANAGED_RUNNER_K8S_RESOURCES",
            `${JSON.stringify(resource)} is not a Kubernetes resource name`
          );
        }
        // A YAML `cpu: 1` arrives as a NUMBER through `toJson`, and that is the common case rather
        // than an edge one — `values.yaml`'s own api/worker blocks write `cpu: "1"` quoted for
        // exactly this reason, and an operator who forgets the quotes must not be refused.
        const q = typeof quantity === "number" ? String(quantity) : quantity;
        if (typeof q !== "string" || !K8S_QUANTITY.test(q)) {
          refuseRunnerPodConvention(
            "SCP_MANAGED_RUNNER_K8S_RESOURCES",
            `${resource}=${JSON.stringify(quantity)} is not a Kubernetes quantity`
          );
        }
        sideOut[resource] = q;
      }
      if (Object.keys(sideOut).length > 0) resources[side] = sideOut;
    }
    if (Object.keys(resources).length > 0) out.resources = resources;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function managedRunnerKubernetesSettings(): KubernetesLauncherSettings | undefined {
  if (managedRunnerLauncherKind() !== "kubernetes") return undefined;
  const namespace = process.env.SCP_MANAGED_RUNNER_K8S_NAMESPACE?.trim();
  const workspaceRoot = process.env.SCP_MANAGED_RUNNER_K8S_WORKSPACE_ROOT?.trim();
  const claimName = process.env.SCP_MANAGED_RUNNER_K8S_WORKSPACE_CLAIM?.trim();
  const hostPath = process.env.SCP_MANAGED_RUNNER_K8S_WORKSPACE_HOST_PATH?.trim();
  if (!namespace || !workspaceRoot) return undefined;
  const workspaceVolume = claimName
    ? ({ kind: "persistentVolumeClaim", claimName } as const)
    : hostPath
      ? ({ kind: "hostPath", path: hostPath } as const)
      : undefined;
  if (!workspaceVolume) return undefined;
  const pod = managedRunnerPodConventions();
  return {
    namespace,
    workspaceRoot,
    workspaceVolume,
    // THE GRANTED CAPABILITY. See docs/coordination.md §461.
    perRunSecrets: process.env.SCP_MANAGED_RUNNER_K8S_PER_RUN_SECRETS?.trim() === "true",
    // OFF BY DEFAULT AND THAT IS A FINDING, not a preference: none of apps/runner-{iac,scan,dep}
    // has a `USER` line, so `true` makes every managed run fail with CreateContainerConfigError
    // before its entrypoint. Kept as a knob so an operator who rebuilds the images non-root can
    // harden it without a code change.
    runAsNonRoot: process.env.SCP_MANAGED_RUNNER_K8S_RUN_AS_NON_ROOT?.trim() === "true",
    // THE POD CONVENTIONS EVERY OTHER POD IN THIS CHART INHERITS (M23.5). Absent when the deployment
    // states none, so a launch is byte-identical to every one before it.
    ...(pod ? { pod } : {}),
    ...(process.env.SCP_MANAGED_RUNNER_K8S_API_BASE?.trim()
      ? { apiBase: process.env.SCP_MANAGED_RUNNER_K8S_API_BASE.trim() }
      : {})
  };
}

/** Exported for the commander's promotion scan step. See docs/coordination.md §462. */
export function managedRunnerSettings(): {
  dockerBinary: string;
  runnerLauncher: "docker" | "kubernetes";
  kubernetes?: KubernetesLauncherSettings;
} {
  const kubernetes = managedRunnerKubernetesSettings();
  return {
    dockerBinary: managedRunnerDockerBinary(),
    runnerLauncher: managedRunnerLauncherKind(),
    ...(kubernetes ? { kubernetes } : {})
  };
}

/**
 * SERVER/OPERATOR-GOVERNED `scp-managed-dep` runner settings (M21.5, charter amendment 2026-08-13) —
 * the exact same never-tenant-suppliable trust tier as `managedIacServerSettings` and
 * `managedScanServerSettings` above, and read here for the same reason: the plugin subprocess never
 * sees `process.env` (host.ts's `minimalChildEnv` strips it), so the config this function injects is
 * the ONLY channel these values have.
 *
 *  - SCP_MANAGED_DEP_RUNNER_IMAGE — the vetted, pinned `scp-runner-dep` image. UNSET IS THE DEFAULT
 *    AND IT MEANS OFF: with no image, a managed-dep dispatch fails closed here before a container
 *    could be launched or a credential minted. That is the deployment-level expression of "managed
 *    execution is never a default" (ADR-0006) for the one class that writes to a user's repository.
 *  - SCP_MANAGED_DEP_REVENDOR_RUNNER_IMAGE — the vetted, pinned `scp-runner-dep-vendor` SANDBOX
 *    (M29.8a, ADR-0059) the `re-vendor` strategy launches. UNSET means `re-vendor` specifically is
 *    off; `bump`/`merge` are governed by `SCP_MANAGED_DEP_RUNNER_IMAGE` alone and are unaffected.
 *  - SCP_MANAGED_DEP_SCP_REPO — `owner/repo`, the ONE repository `re-vendor` may ever write to
 *    (ADR-0059's containment half named "the target repository is the one CommanderSCP is
 *    configured to vendor its own stack into, which is never tenant-configurable"). UNSET means
 *    `re-vendor` specifically is off, same as an unset revendor runner image.
 *  - SCP_MANAGED_DEP_WORKSPACE_ROOT — operator root under which per-run scratch dirs are made.
 *
 * THERE IS DELIBERATELY NO NETWORK-MODE SETTING, and its absence IS the charter rather than an
 * omission. `managedIacServerSettings` and `managedScanServerSettings` each carry one because their
 * classes' network clauses are QUALIFIED — managed-scan's by the 2026-07-23 amendment, "excepting
 * operator-allowlisted registry pulls for the subject artifact's bytes". The `scp-managed-dep` clause
 * is not: "Runner network egress is `--network none`; the runner holds no credential, contains no
 * package manager, and edits only the bytes handed to it" (2026-08-15, unqualified). A knob with a
 * `none` default is an operator-facing way to contradict that, so the value is a LITERAL in the
 * plugin (`@scp/plugin-managed-dep`'s `RUNNER_NETWORK_MODE`) and there is nothing here to inject.
 * `SCP_MANAGED_DEP_NETWORK_MODE` is read by nothing; setting it does nothing.
 *
 * THE RUNNER REACHES NO HOSTS: it receives the manifest bytes by `docker cp`, edits them offline,
 * and returns them the same way. The ORCHESTRATOR (the plugin) is what holds the per-run
 * repository-write credential and reaches the git host — the same split `scp-managed-scan` already
 * ships, where the SERVER pulls the subject's bytes and the runner has no network. See
 * `packages/plugins/managed-dep/src/repo-write.ts` for the charter clauses this reconciles.
 *
 * WHY THERE IS NO NEW EXECUTOR `type` FOR THIS CLASS (schemas/executors.ts's closed enum
 * image|rpm|deb|npm|maven|python|go|chart|vm-image|infrastructure|configuration, "extensible only by
 * deliberate owner decision" — the build family grew by 5 members in the team-pipeline-IaC rework,
 * D13/D24, but the reasoning below is unchanged: none of the build-family members describe this).
 *
 * A dependency bump fits NONE of the eleven honestly. It is not a build (it turns no source into an
 * artifact), not `infrastructure`, and not `configuration` (it applies no desired state to a running
 * system). The `npm` member is a near-miss worth naming explicitly so nobody reaches for it later:
 * it means "an executor that BUILDS an npm artifact", not "an executor that touches npm packages",
 * and binding a bump actuator there would silently contend for the `UNIQUE(org, target, type)` slot
 * a component's real npm build pipeline occupies.
 *
 * The right answer is that the class needs no Type at all, and the precedent is `scp-managed-scan`:
 * it is in this same allowlist yet is never routed through `executor_bindings` in practice —
 * `federation/promotion-scan-step.ts` constructs the plugin and a `PluginContext` directly, because
 * it is a first-class step of the commander's own process rather than a tenant-bound pipeline. The
 * bump actuator is the same shape: its work-list comes from the subscription resolution, not from a
 * wave target, so nothing ever asks "which binding drives this target's <Type> pipeline?".
 *
 * The settings are still injected below for a managed-dep binding an operator creates by hand, so
 * that path cannot become the one that runs an unvetted image on an unrestricted network.
 */
export function managedDepServerSettings(): {
  runnerImage: string | undefined;
  revendorRunnerImage: string | undefined;
  scpRepo: string | undefined;
  workspaceRoot: string;
  dockerBinary: string;
  runnerLauncher: "docker" | "kubernetes";
  kubernetes?: KubernetesLauncherSettings;
} {
  return {
    runnerImage: process.env.SCP_MANAGED_DEP_RUNNER_IMAGE,
    revendorRunnerImage: process.env.SCP_MANAGED_DEP_REVENDOR_RUNNER_IMAGE,
    scpRepo: process.env.SCP_MANAGED_DEP_SCP_REPO,
    workspaceRoot: process.env.SCP_MANAGED_DEP_WORKSPACE_ROOT ?? join(tmpdir(), "scp-managed-dep"),
    // The operator's runtime, and now the whole launcher slice. See docs/coordination.md §463.
    ...managedRunnerSettings()
  };
}

/**
 * SERVER/OPERATOR-GOVERNED `scp-managed-ops` runner settings (M27, charter 2026-07-12 amendment) —
 * the same never-tenant-suppliable tier as the three managed runners above.
 *
 *  - SCP_MANAGED_OPS_RUNNER_IMAGE — the vetted, pinned `scp-runner-ops` image. UNSET IS THE DEFAULT
 *    AND IT MEANS OFF: with no image a managed-ops dispatch fails closed here, before a container
 *    could be launched or a certificate minted. That is "managed execution is never a default"
 *    (ADR-0006) for the one class that holds HOST login-grade credentials.
 *  - SCP_MANAGED_OPS_CATALOG_PUBKEY_SECRET_KEY — the cosign public key the runner verifies the task
 *    catalog against (ADR-0050). Carried as a SECRET KEY, not a path: the runner resolves it
 *    through the secret store like every other credential-shaped value.
 *
 * THERE IS DELIBERATELY NO NETWORK-MODE SETTING, and its absence is the charter rather than an
 * omission — the same argument `managedDepServerSettings` makes, reaching the opposite shape. That
 * class's clause is an unqualified `--network none`; this one's is QUALIFIED ("a scoped network
 * path to the hosts it changes"), and the scope is the per-run egress allowlist derived from
 * observed membership (M27.6b). A knob here could only widen that, so there is none.
 */
export function managedOpsServerSettings(): {
  runnerImage: string | undefined;
  catalogPubkeySecretKey: string | undefined;
  workspaceRoot: string;
  dockerBinary: string;
  runnerLauncher: "docker" | "kubernetes";
  kubernetes?: KubernetesLauncherSettings;
} {
  return {
    runnerImage: process.env.SCP_MANAGED_OPS_RUNNER_IMAGE,
    catalogPubkeySecretKey: process.env.SCP_MANAGED_OPS_CATALOG_PUBKEY_SECRET_KEY,
    workspaceRoot: process.env.SCP_MANAGED_OPS_WORKSPACE_ROOT ?? join(tmpdir(), "scp-managed-ops"),
    ...managedRunnerSettings()
  };
}

/** Root for every executor instance's durable dedup file. See docs/coordination.md §464. */
export function pluginStateDir(): string {
  return process.env.SCP_PLUGIN_STATE_DIR ?? join(tmpdir(), "scp-plugin-state");
}

function sanitizeInstanceId(instanceId: string): string {
  return instanceId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Resolves a target's binding into a provisionable instance. See docs/coordination.md §465. */
export async function resolveExecutorPluginInstance(
  tx: TenantTx,
  input: {
    orgId: string;
    targetObjectId: string;
    masterKey: Buffer;
    scopeKey?: string;
    /** Which pipeline to resolve — the routing Type (ADR-0007). Defaults to 'configuration'. P4A
     *  supplies this from the wave target, so reconcile starts the instance for the pipeline it is
     *  about to trigger. */
    type?: BindingType;
    /** WHICH LANE to dispatch to (ADR-0046 §4, §14 res 7). See docs/coordination.md §466. */
    lane?: ExecutorLane;
  }
): Promise<ResolvedExecutorInstance | undefined> {
  // Deliberately literal, and that is load-bearing. See docs/coordination.md §467.
  const resolved = await resolveLaneBinding(
    tx,
    input.orgId,
    input.targetObjectId,
    input.type ?? DEFAULT_BINDING_TYPE,
    input.lane ?? "build"
  );
  if (!resolved) return undefined;
  const binding = resolved.row;

  // Resolve the plugin identity and config from one of two. See docs/coordination.md §468.
  let pluginModule: string = binding.pluginModule;
  let pluginInstanceId = binding.pluginInstanceId;
  // An inline binding NEVER supplies an execution-system-only key, even from a row stored before
  // the write door refused it (ADR-0055 D9) — stripped, not trusted.
  let tenantConfig = withoutSystemOnlyConfig(
    binding.pluginModule,
    (binding.config ?? {}) as Record<string, unknown>
  );
  let secretRefs = binding.secretRefs;
  // M29.2: a stack registration's token and CA, handed over by the controller (never a secret key).
  let stackSecrets: Record<string, string> | undefined;
  let trustedCaPem: string | undefined;
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
    // A REPLICATED system is never executable here (`isLocallyAuthoredExecutionSystem`): its routing
    // was written by another domain, and its `tokenSecretKey` would resolve THIS instance's secret.
    const self = await ensureFederationSelf(tx, input.orgId);
    if (!isLocallyAuthoredExecutionSystem(sys, self.domainId)) {
      throw new Error(
        `executor binding for target '${input.targetObjectId}' references execution-system '${sys.id}', ` +
          `which domain '${sys.originDomainId}' authored — a replicated system is not executable at ` +
          `this domain. Register this domain's own system (scp connect) and bind to that.`
      );
    }
    // M29.2 (ADR-0060): a STANDARD STACK REGISTRATION is routed by the stack controller's wiring
    // and by nothing on the object — its endpoint, token, CA and egress allowance all come from
    // `stackWiredRouting`. `null` means an ordinary system, routed below exactly as before.
    const stack = await stackWiredRouting(tx, input.orgId, sys.id, input.masterKey);
    if (stack) {
      pluginModule = stack.pluginModule;
      pluginInstanceId = executionSystemInstanceId(sys.id);
      tenantConfig = stack.config;
      secretRefs = {};
      stackSecrets = stack.secrets;
      effectiveAllowedHosts = stack.allowedHosts;
      allowInternalEgress = stack.allowInternalEgress;
      trustedCaPem = stack.trustedCaPem;
    }
    const props = sys.properties as {
      kind?: string;
      serverUrl?: string;
      tokenSecretKey?: string;
      allowInternalEgress?: boolean;
    };
    if (!stack) {
      // Layer 2 (declared intent) is checked against layer 1 (the operator's env allowlist) inside
      // resolveInternalEgress — the property alone NEVER grants anything.
      allowInternalEgress = resolveInternalEgress(
        props.serverUrl,
        props.allowInternalEgress === true
      );
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
      // Carries the module's DECLARED settings off the system object — `namespace` for argo-workflows
      // is the case that forced it. The plugin reads its token via `ctx.secrets.get(<tokenSecretKey>)`;
      // the system's tokenSecretKey is both the config field name AND the secrets-table key.
      tenantConfig = executionSystemPluginConfig(props, pluginModule);
      secretRefs = props.tokenSecretKey ? { [props.tokenSecretKey]: props.tokenSecretKey } : {};
    }
  }

  if (!isKnownExecutorModule(pluginModule)) {
    throw new Error(
      `executor binding for target '${input.targetObjectId}' resolves to unknown or non-executor plugin module '${pluginModule}'`
    );
  }

  const resolvedSecrets =
    stackSecrets ?? (await resolveSecretRefs(tx, input.orgId, secretRefs, input.masterKey));

  const serverInjected: Record<string, unknown> = {
    statePath: join(pluginStateDir(), `${sanitizeInstanceId(pluginInstanceId)}.json`)
  };

  // M28.2 (ADR-0054 D9) — THE TEMPLATE CHECK'S EXPECTATION, server-governed. Before submitting an
  // SCP host-ops catalog template, `@scp/plugin-argo-workflows` checks ITS OWN endpoint against these
  // pins and reads the template back against the pinned digest and SCP API URL. ORG-WIDE (every pin
  // in the org, stably ordered), never per target: one instance serves every binding naming its id,
  // and the host restarts an instance whose config changes. ALWAYS set (`[]` without pins), because
  // tenant config spreads first and a tenant value must never stand in for the pins.
  if (pluginModule === "argo-workflows") {
    serverInjected.opsTemplatePins = await argoOpsPinsForOrg(tx, input.orgId);
  }

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
    Object.assign(serverInjected, managedRunnerSettings());
  }

  if (pluginModule === "managed-scan") {
    const settings = managedScanServerSettings();
    if (!settings.runnerImage) {
      throw new Error(
        "managed-scan binding used but managed scanning is not enabled (SCP_MANAGED_SCAN_RUNNER_IMAGE is unset)"
      );
    }
    serverInjected.runnerImage = settings.runnerImage;
    serverInjected.networkMode = settings.networkMode;
    serverInjected.workspaceRoot = settings.workspaceRoot;
    Object.assign(serverInjected, managedRunnerSettings());
  }

  if (pluginModule === "managed-ops") {
    const settings = managedOpsServerSettings();
    if (!settings.runnerImage) {
      throw new Error(
        "managed-ops binding used but host-reaching managed execution is not enabled " +
          "(SCP_MANAGED_OPS_RUNNER_IMAGE is unset)"
      );
    }
    // REFUSES WITHOUT A CATALOG KEY. ADR-0050 makes the signed catalog the thing that bounds what a
    // run can DO; a deployment that enabled the image but no verification key would run an
    // unverified catalog with host credentials, which is the whole hazard rather than a rough edge.
    if (!settings.catalogPubkeySecretKey) {
      throw new Error(
        "managed-ops binding used but no catalog verification key is configured " +
          "(SCP_MANAGED_OPS_CATALOG_PUBKEY_SECRET_KEY is unset). The signed task catalog is what " +
          "bounds a host-reaching run; refusing rather than running an unverified one."
      );
    }
    serverInjected.runnerImage = settings.runnerImage;
    serverInjected.catalogPubkeySecretKey = settings.catalogPubkeySecretKey;
    serverInjected.workspaceRoot = settings.workspaceRoot;
    // No `networkMode` — see `managedOpsServerSettings`. The bound is the per-run allowlist.
    Object.assign(serverInjected, managedRunnerSettings());
  }

  if (pluginModule === "managed-dep") {
    const settings = managedDepServerSettings();
    if (!settings.runnerImage) {
      throw new Error(
        "managed-dep binding used but dependency-bump authoring is not enabled (SCP_MANAGED_DEP_RUNNER_IMAGE is unset)"
      );
    }
    serverInjected.runnerImage = settings.runnerImage;
    // UNSET IS FINE HERE (unlike `runnerImage` above): re-vendor is a STRATEGY of this same
    // executor, not a separate binding, and its own absence-check lives in `triggerRevendor` itself
    // — a binding that never re-vendors must not be refused for a sandbox it never launches.
    serverInjected.revendorRunnerImage = settings.revendorRunnerImage;
    serverInjected.scpRepo = settings.scpRepo;
    // No `networkMode` — see `managedDepServerSettings`. The plugin uses a literal.
    serverInjected.workspaceRoot = settings.workspaceRoot;
    Object.assign(serverInjected, managedRunnerSettings());
  }

  return {
    instanceConfig: {
      id: pluginInstanceId,
      module: pluginModule as PluginModule,
      orgId: input.orgId,
      scopeKey: input.scopeKey ?? "default",
      // Tenant config first, server-governed fields LAST (they win — CRITICAL #1 / MAJOR #4).
      config: { ...tenantConfig, ...serverInjected },
      secrets: resolvedSecrets,
      allowedHosts: effectiveAllowedHosts,
      allowInternalEgress,
      ...(trustedCaPem ? { trustedCaPem } : {})
    }
  };
}
