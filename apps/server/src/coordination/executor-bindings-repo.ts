import { tmpdir } from "node:os";
import type {
  KubernetesLauncherSettings,
  KubernetesRunnerPodConventions
} from "@scp/runner-launcher";
import { join } from "node:path";
import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { categoryOfType, type ExecutorType, type ExecutorCategory } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { executorBindings, objects } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { resolveSecretRefs } from "../secrets/secrets-repo.js";
import { getObjectByIdOrUrnAnyType } from "../graph/objects-repo.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import type { PluginHostInstanceConfig, PluginModule } from "../plugin-host/contract.js";
import { assertManagedTimeoutSchemas } from "../plugin-host/call-policy.js";
import { assertEveryModuleHasManifest } from "../plugin-host/plugin-manifests.js";

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

/**
 * Turns a loaded `execution-system` object into the (module, instance id) identity a binding to it
 * must carry, rejecting anything that isn't a bindable system. Lives HERE rather than inline in
 * `routes/executors.ts` because IaC apply (docs/proposals/post-import-configuration.md §8 C1) became
 * a second door that writes execution-system-backed bindings, and both doors must derive the same
 * identity and refuse the same inputs — a check that lives in one route handler is a check the next
 * write path silently doesn't have.
 *
 * CALL ORDER MATTERS AND IS THE CALLER'S JOB: authorize `object:write` at `sys.id` BEFORE calling
 * this. Every rejection below discloses the object's type or properties, so calling it first would
 * turn it into a type/existence oracle for objects the caller may not read (the reason
 * `bindTargetToExecutionSystem` authorizes before its own checks, and the reason `plans-repo.ts`
 * defers this to `executePlanDiff`, after every `authorize()` has run).
 */
export function executionSystemBindingIdentity(
  sys: { id: string; typeId: string; properties: unknown },
  reference: string
): { pluginModule: string; pluginInstanceId: string; executionSystemId: string } {
  if (sys.typeId !== "execution-system") {
    throw badRequest(`'${reference}' is a '${sys.typeId}', not an execution-system`);
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

/**
 * Every binding whose target is one of `targetObjectIds` — the IaC ownership-scoped pool (C1: a
 * binding belongs to the stack that owns its target object). Keeps `targetObjectIsLive`: the caller
 * derives these ids from live object rows, so it is redundant today, but the property this filter
 * exists for ("a soft-deleted target should surface no bindings ANYWHERE", M12 P5c) holds for every
 * list function or none — omitting it here because one caller happens to be safe is exactly how the
 * next caller inherits the bug.
 */
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

/**
 * Resolves the bound target's `domainLocal` flag for the `subjectDomainLocal` argument every audit
 * append below needs (ADR-0031 S2 / M20.2) — one cheap `objects` read by id, keyed exactly the way
 * every write door here already keys its own row (`orgId`, `targetObjectId`). None of the four
 * binding-identity write doors in this module load the target OBJECT for any other reason (they only
 * ever touch `executor_bindings`, itself keyed by the target's id), so this is resolved HERE, at the
 * one place the audit call already lives, rather than threaded as a parameter through every route and
 * `iac/plans-repo.ts` call site — the same reasoning `UpsertExecutorBindingInput.actorObjectId`'s doc
 * comment gives for centralizing the audit write itself: one door covered once, not five that could
 * drift. Missing target (should not happen inside a transaction that is itself mutating that target's
 * binding) reads `false` — the pre-existing behavior of journaling unconditionally — rather than
 * inventing a new failure mode for an edge case that was never previously distinguished.
 */
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
  /** WHO/WHAT REQUEST is doing this write — carried through to `executor.binding.put`'s audit event
   *  (2026-08-25 gap: PUT and DELETE binding wrote no audit event at all; the only executor-ish
   *  audit action ever written was `change.wave_target.no_executor`, a READ-time observation, not a
   *  record of the binding itself changing). Threaded HERE rather than appended at each call site,
   *  the same "one shared write, every caller covered" idiom `objects-repo.ts`'s `createObject` and
   *  `relationships-repo.ts`'s `createRelationship` already use (M6's audit-repo doc: "zero
   *  additional call-site wiring anywhere else in the codebase") — this is the ONE function every
   *  binding write already funnels through (the typed routes AND `iac/plans-repo.ts`'s apply-time
   *  create/update loop), so putting the audit call here covers both doors in one change instead of
   *  two that could drift. */
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
  }
  // Key the "is this an update or an insert" lookup on (target, TYPE). Without the Type the lookup
  // found "the" binding and UPDATED it — which is exactly how binding a component's second pipeline
  // silently destroyed the first one before P3.
  const type = input.type ?? DEFAULT_BINDING_TYPE;
  const existing = await getExecutorBinding(tx, input.orgId, input.targetObjectId, type);
  let row: ExecutorBindingRow;
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
        executionSystemId: input.executionSystemId ?? null
      })
      .returning();
    row = toRow(inserted!);
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

/**
 * Deletes a target's binding for one Type (M12 P5c) — a HARD delete (executor_bindings has no
 * soft-delete column; a binding is config, not an audited graph object). Detaching a binding is the
 * primitive that was missing: before P5c a binding could be created and repointed but never removed,
 * so a stale/mis-imported binding polled forever. Returns the deleted row (for the route to report),
 * or undefined if no such binding exists (the route 404s).
 *
 * WRITES `executor.binding.delete` in THIS transaction, same reasoning as `upsertExecutorBinding`'s
 * doc — this is the one function both the DELETE route and `iac/plans-repo.ts`'s apply-time prune
 * funnel through, so the audit event needs writing here once, not per caller. A no-op delete (no
 * such binding) writes NOTHING — there is no row to name, and the route 404s instead.
 */
export async function deleteExecutorBinding(
  tx: TenantTx,
  orgId: string,
  targetObjectId: string,
  type: BindingType = DEFAULT_BINDING_TYPE,
  // REQUIRED, not optional: an optional pair here is exactly the shape that lets a future caller
  // silently skip the audit event by omission (the failure mode this increment exists to close —
  // `executor.binding.put`/`.delete` had NO caller writing them at all until now). Both current
  // callers (the DELETE route, `iac/plans-repo.ts`'s apply-time prune) already hold both.
  actorObjectId: string,
  requestId: string
): Promise<ExecutorBindingRow | undefined> {
  const [deleted] = await tx
    .delete(executorBindings)
    .where(
      and(
        eq(executorBindings.orgId, orgId),
        eq(executorBindings.targetObjectId, targetObjectId),
        eq(executorBindings.type, type)
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

/**
 * Relabels which pipeline a target's binding drives (M12 P5c): moves the (target, fromType) binding
 * to (target, toType). The motivating case is a discovery-imported binding defaulted to
 * 'configuration' that is actually an `infrastructure` pipeline — and it is exactly the
 * merge-collision resolution owner ruling Q1 mandates ("relabel one first, don't guess"). Rejects
 * (409) if the target already holds a binding at toType: UNIQUE(org,target,type) forbids two, and the
 * caller must delete/repurpose that one first — surfaced as a clear conflict, not a raw
 * unique-violation. A same-type relabel is an idempotent no-op. Returns undefined if no (target,
 * fromType) binding exists (route 404s).
 *
 * AUDITED (`executor.binding.retype`) — same census that added `.put`/`.delete`: PATCH is a third
 * binding-identity write door (the only one reachable through the typed routes besides PUT/DELETE)
 * and was equally silent. The idempotent same-type no-op returns early and writes NOTHING — nothing
 * changed, so there is nothing to record.
 */
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

/**
 * Re-points a binding onto a DIFFERENT target object (M12 P5d merge) — moves the binding from its
 * current target onto `newTargetObjectId`, keeping its Type. The caller (`mergeComponents`) verifies
 * the destination has no binding at this Type first (owner Q1: reject-and-relabel, no
 * auto-collision); this still catches a concurrent racer at `UNIQUE(org,target,type)` and surfaces
 * the same one-per-Type 409 rather than a raw unique-violation.
 *
 * AUDITED (`executor.binding.repoint`) — CORRECTING THE PREMISE THE PRIOR VERSION OF THIS COMMENT
 * EXCUSED ITSELF ON. That version left this door silent on the claim that "`POST
 * /v1/components/{id}/merge` writes NO audit event at all today, for the merge OR any of its side
 * effects". That premise is false: `mergeComponents` (component-merge-repo.ts) already
 * soft-deletes the loser through `deleteObject`, which writes a `component.delete` audit event in
 * the SAME transaction, and records the merge itself as a `transition` Decision
 * (`insertDecision`). The merge IS audit-visible. The binding REPOINT was the one genuinely
 * invisible side effect — this is the FOURTH binding-identity write door (PUT/DELETE/PATCH being
 * the other three, all audited), reached only from `mergeComponents`, and closing it beats
 * excusing it now that the excuse it was left open on does not hold.
 */
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
    if (isUniqueViolation(err, "executor_bindings_org_target_type_key")) {
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

/**
 * `executor_bindings.plugin_module` is a free-form string at the schema layer (validated no
 * further than "non-empty" by the route's Zod schema) — this is the only thing standing between
 * an attacker/misconfigured-operator-controlled binding and `host.start()` provisioning an
 * arbitrary subprocess module. Mirrors `governance/control-runner.ts`'s identical
 * `KNOWN_CONTROL_MODULES` allowlist pattern, scoped to the modules that are actually
 * `ExecutorPlugin`s (excludes `webhook-control` — a `ControlPlugin` — and `github-discovery`/
 * `gitea-discovery`/`gitlab-discovery`/`webhook-notify`/`smtp-notify`, which are `DiscoveryPlugin`/`NotificationPlugin`
 * and would only ever produce a confusing "unknown method" RPC failure if a wave target were bound
 * to one).
 */
export const KNOWN_EXECUTOR_MODULES: PluginModule[] = [
  "fake-executor",
  "github",
  "gitea",
  "gitlab",
  "argocd",
  "terraform",
  "pipeline-generic",
  "managed-iac",
  "managed-scan",
  // M21.5 — the third managed executor (charter `scp-managed-dep` amendment 2026-08-13). It joins
  // this list for the same reason `managed-scan` did: the allowlist is checked at BOTH write time
  // (`routes/executors.ts`) and dispatch time (`resolveExecutorPluginInstance`, below), and missing
  // either end fails closed as a confusing "unknown method" RPC error rather than a legible refusal.
  // Its ORDINARY dispatch is server-side and binding-free — see `managedDepServerSettings` for why
  // it needs no executor `type`.
  "managed-dep"
];

/**
 * BEING ON THE ALLOWLIST ABOVE AND HAVING A CONFIG SCHEMA ARE TWO DIFFERENT PROPERTIES, and only
 * the first was ever checked. The allowlist decides WHICH MODULE may be provisioned; the manifest
 * decides WHAT CONFIG that module may be provisioned with. `fake-executor`, `pipeline-generic` and
 * `managed-scan` passed the first and failed the second, and `validatePluginConfig` skipped a
 * module it had no manifest for — so their binding configs were stored entirely unvalidated. The
 * sharpest consequence: `@scp/plugin-managed-scan` runs `execFile(config.dockerBinary ?? "docker")`,
 * and `dockerBinary` is not among the keys `resolveExecutorPluginInstance` injects, so a tenant
 * binding could name any host executable.
 *
 * Asserted HERE, at module load, because this file is where the allowlist lives — the invariant
 * belongs beside the list it constrains, not in a test that a future edit can be made without
 * running. Adding a module below without a manifest now fails at BOOT, naming the module.
 */
assertEveryModuleHasManifest(KNOWN_EXECUTOR_MODULES, "KNOWN_EXECUTOR_MODULES");

/**
 * AND THE SECOND PROPERTY OF THE SAME MANIFEST, checked in the same place and at the same moment,
 * because the first one on its own is not enough (M23.1c).
 *
 * `assertEveryModuleHasManifest` above answers "may this module's config be validated at all". This
 * answers "is the one tenant-settable number in that config BOUNDED" — and for the three managed
 * classes it is load-bearing twice over: the plugin's `execFile` timeout is what stops a wedged
 * runner, and the plugin HOST derives that module's `trigger` RPC budget from the very same bounds
 * (`plugin-host/call-policy.ts`). All three shipped `{ type: "integer", minimum: 1000 }` with no
 * ceiling, so a tenant with plain `object:write` on a Component could set 2^31 and remove both.
 *
 * Beside the allowlist, at module load, for the reason the assertion above it is: a missing ceiling
 * is a defect the moment it is committed, and deleting one degrades SILENTLY (that module's trigger
 * reverts to the 10s hang detector that SIGKILLs a live `tofu apply`) rather than failing anything.
 */
assertManagedTimeoutSchemas();

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

/**
 * SERVER/OPERATOR-GOVERNED `scp-managed-scan` runner settings (ADR-0020 §1) — the exact same
 * never-tenant-suppliable trust tier as `managedIacServerSettings` above. The commander's promotion
 * scan step (`federation/promotion-scan-step.ts`) reads these directly; a tenant managed-scan
 * binding (should one ever be created) has them injected here, spread LAST, so tenant config can
 * never influence WHAT image runs or on WHICH network.
 *
 *  - SCP_MANAGED_SCAN_RUNNER_IMAGE  — the vetted, pinned `scp-runner-scan` image (unset ⇒ managed
 *    scanning is not enabled; a managed-scan binding then fails closed with a clear error).
 *  - SCP_MANAGED_SCAN_NETWORK_MODE  — `docker create --network` (default "none" — the runner reaches
 *    no hosts; the SERVER, not the runner, pulls the scan subject's bytes).
 *  - SCP_MANAGED_SCAN_WORKSPACE_ROOT — operator root the promotion scan step derives per-run scratch
 *    directories (pulled OCI layout + evidence sink) under.
 *  - SCP_MANAGED_SCAN_DB_CACHE — (M13.3b-ii) operator DB cache dir the runner's Trivy DB is
 *    pre-loaded from (a PVC in Helm). Unset ⇒ the runner uses the image-baked DB (fail-closed
 *    fallback, as stale as the image), and there is no staleness gate.
 */
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

/**
 * WHICH LAUNCHER ADAPTER EVERY MANAGED EXECUTOR USES (M23.2) — operator/server-governed, the same
 * trust tier as `SCP_MANAGED_RUNNER_DOCKER_BINARY`, and EXPLICIT rather than detected.
 *
 * ANYTHING OTHER THAN THE EXACT STRING `"kubernetes"` IS DOCKER, including a typo. That direction is
 * chosen deliberately: the failure mode of a mistyped value is "the deployment keeps doing what it
 * did before", not "managed execution silently switches substrate". A Kubernetes deployment whose
 * value did not take is diagnosable in one step — nothing works, and `scpd` ships no docker binary —
 * whereas a compose deployment nudged onto Jobs it has no API server for is not.
 */
function managedRunnerLauncherKind(): "docker" | "kubernetes" {
  return process.env.SCP_MANAGED_RUNNER_LAUNCHER?.trim() === "kubernetes" ? "kubernetes" : "docker";
}

/**
 * THE KUBERNETES LAUNCHER'S DEPLOYMENT SETTINGS — read here, from the environment, for exactly the
 * reason `managedDepServerSettings` gives: the plugin subprocess never sees `process.env`
 * (`host.ts`'s `minimalChildEnv` strips it), so injected config is the ONLY channel these values
 * have.
 *
 * THE WORKSPACE VOLUME IS A CLOSED UNION BUILT HERE, never operator-supplied JSON. This object lands
 * verbatim inside a pod spec the worker POSTs with its own service-account token, so "whatever JSON
 * the operator put in an env var" would be an arbitrary-volume-mount primitive wearing a config
 * field's clothes — a `hostPath: /` away from reading the node. Two shapes, and only two: an RWX
 * PersistentVolumeClaim (production; owner decision 5 makes RWX a documented prerequisite) and a
 * host path (the kind-based test harness, which has no RWX storage class to offer).
 *
 * RETURNS `undefined` WHEN THE LAUNCHER IS DOCKER, so nothing about Kubernetes reaches a plugin on a
 * compose deployment — and returns `undefined` when the launcher is Kubernetes and the settings are
 * incomplete, so the resolver's named refusal is what an operator sees rather than a half-built
 * manifest.
 */
/**
 * THE DEPLOYMENT'S POD CONVENTIONS FOR THE RUNNER JOB (M23.5) — parsed into a CLOSED shape here,
 * never handed through as operator JSON.
 *
 * THE CENSUS, NOT THE TWO FIELDS THAT WERE REPORTED. `deploy/helm` creates six pods. Five are Helm
 * templates and every one of them sets `.Values.imagePullSecrets`, `.Values.image.pullPolicy` and a
 * `resources` block, because a human wrote the same lines into each. The sixth — the runner Job — is
 * built by `jobManifest()` from settings that described a namespace, a workspace and two booleans and
 * nothing about the pod, so it inherited NONE of them. The missing thing was the channel; this is it.
 *
 * WHY IT IS PARSED RATHER THAN PASSED. These strings land verbatim inside a pod spec the worker
 * POSTs with its own service-account token — the same reason `workspaceVolume` below is a closed
 * union built here instead of operator JSON. The distinction that makes `resources` acceptable where
 * a raw `volumes[]` would not be: a ResourceRequirements is a flat map of validated resource names to
 * validated quantities, naming no path, no object and no host. The worst a malformed one can do is
 * make the pod unschedulable.
 *
 * AND A MALFORMED VALUE THROWS RATHER THAN BEING DROPPED. A silently-dropped `imagePullSecret` is
 * `ErrImagePull` minutes into a promotion with nothing anywhere naming the cause — which is the exact
 * failure this whole block exists to end. The chart cannot produce one (it renders these from typed
 * values); a hand-rolled deployment can, and it gets the variable name and the offending value.
 */
const DNS_1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
/** A Kubernetes resource NAME: `cpu`, `memory`, `ephemeral-storage`, `nvidia.com/gpu`. */
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
    // THE GRANTED CAPABILITY (owner decision 2026-08-20, ADR-0035 §6). Enabling it here is only
    // half the change: without `secrets: create,delete` in the chart's Role the Secret POST 403s, so
    // the chart renders the RBAC and sets this variable from the SAME value.
    //
    // THE CODE DEFAULT STAYS `false` WHILE THE CHART DEFAULT IS `true`, AND THAT ASYMMETRY IS
    // DELIBERATE. This flag does not mean "per-run Secrets are a good idea"; it means "the RBAC to
    // create them EXISTS in this namespace", and only the thing that rendered the RBAC knows that.
    // The chart does, so it says so. A hand-rolled Kubernetes deployment that never applied a Role
    // does not, and for it the honest answer is the named refusal at step `secret-env` rather than a
    // 403 from inside a promotion, minutes in. Absent env var => the deployment made no such claim.
    // See `KubernetesRunnerLauncherConfig.perRunSecrets`.
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

/** Exported so the commander's promotion scan step, which constructs a `managed-scan` plugin context
 *  directly rather than through a binding, resolves the SAME operator-governed binary. Two code
 *  paths reading one knob; the alternative is a setting that silently applies to half the runs.
 *
 *  M23.2 WIDENS IT TO THE WHOLE LAUNCHER SLICE rather than adding a second function beside it. The
 *  reason is the defect this function already exists to prevent: `dockerBinary` shipped injected on
 *  the binding path and absent on the binding-free one, so an operator's podman applied to some of
 *  the runs. A launcher SELECTION with the same shape would mean the commander's own promotion scan
 *  stayed on Docker forever while bound executors moved to Jobs — the same bug with a larger blast
 *  radius. One function, every caller. */
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
 * image|rpm|deb|npm|infrastructure|configuration, "extensible only by deliberate owner decision").
 *
 * A dependency bump fits NONE of the six honestly. It is not a build (it turns no source into an
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
  workspaceRoot: string;
  dockerBinary: string;
  runnerLauncher: "docker" | "kubernetes";
  kubernetes?: KubernetesLauncherSettings;
} {
  return {
    runnerImage: process.env.SCP_MANAGED_DEP_RUNNER_IMAGE,
    workspaceRoot: process.env.SCP_MANAGED_DEP_WORKSPACE_ROOT ?? join(tmpdir(), "scp-managed-dep"),
    // THE OPERATOR'S RUNTIME AND, SINCE M23.2, THE WHOLE LAUNCHER SLICE — and it belongs in THIS
    // function rather than only at the binding injection site below, because this class has TWO
    // construction paths and the binding one is the rare one:
    // `dependencies/managed-dep-instance.ts` builds the ordinary, binding-free dispatch. Returning
    // it here is what makes both paths read the same knobs — the alternative, which is what
    // shipped, is a setting that silently applies to some of the runs.
    ...managedRunnerSettings()
  };
}

/**
 * Root for every executor instance's durable dedup/idempotency file. EXPORTED for
 * `test-support/plugin-state-isolation.integration.test.ts` only, which asserts that a test process
 * is not writing into the fixed machine-global default — the check that keeps
 * `test-support/plugin-state-dir.ts` from being a setup file nobody wired in (delete that
 * `setupFiles` entry and that test dies, which is the point).
 */
export function pluginStateDir(): string {
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
    scopeKey?: string;
    /** Which pipeline to resolve — the routing Type (ADR-0007). Defaults to 'configuration'. P4A
     *  supplies this from the wave target, so reconcile starts the instance for the pipeline it is
     *  about to trigger. */
    type?: BindingType;
  }
): Promise<ResolvedExecutorInstance | undefined> {
  // DELIBERATELY LITERAL, and this is load-bearing rather than an oversight (ADR-0026 amendment).
  // Both callers already pass the object that CARRIES the binding: `observe.ts` passes
  // `binding.targetObjectId` from a binding it is iterating, and `reconcile.ts` passes the object
  // `resolveBindingForTarget` resolved the binding ONTO — the placement, not the component. So the
  // placement fallback belongs at the point where a WAVE TARGET is interpreted, not here, and adding
  // it here would make this module depend on `binding-resolution.ts` which depends on it.
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

  if (pluginModule === "managed-dep") {
    const settings = managedDepServerSettings();
    if (!settings.runnerImage) {
      throw new Error(
        "managed-dep binding used but dependency-bump authoring is not enabled (SCP_MANAGED_DEP_RUNNER_IMAGE is unset)"
      );
    }
    serverInjected.runnerImage = settings.runnerImage;
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
      allowInternalEgress
    }
  };
}
