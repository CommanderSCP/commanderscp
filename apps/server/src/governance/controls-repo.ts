import { and, desc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { ControlOutcomeStatus } from "@scp/plugin-api";
import type { TenantTx } from "../db/tenant-tx.js";
import { controlBindings, controlRuns } from "../db/schema.js";
import { assertNotReservedInstanceId } from "../coordination/executor-bindings-repo.js";

/**
 * Control graph objects (`objects` rows of type `control`, DESIGN §10.2) are managed through the
 * typed-registry endpoint like any other registry resource — this file only owns the TWO things
 * the generic object model has no place for: which ControlPlugin instance a control is BOUND to
 * (`control_bindings` — "swapping the impl changes a binding, never a policy"), and the persisted
 * outcome history of running it (`control_runs`, referenced by Decisions).
 */

export interface ControlBindingRow {
  id: string;
  controlObjectId: string;
  pluginModule: string;
  pluginInstanceId: string;
  config: unknown;
}

export async function getControlBinding(
  tx: TenantTx,
  orgId: string,
  controlObjectId: string
): Promise<ControlBindingRow | undefined> {
  const rows = await tx
    .select()
    .from(controlBindings)
    .where(
      and(eq(controlBindings.orgId, orgId), eq(controlBindings.controlObjectId, controlObjectId))
    )
    .limit(1);
  return rows[0];
}

export interface UpsertControlBindingInput {
  orgId: string;
  controlObjectId: string;
  pluginModule: string;
  pluginInstanceId: string;
  config?: unknown;
}

export async function upsertControlBinding(
  tx: TenantTx,
  input: UpsertControlBindingInput
): Promise<ControlBindingRow> {
  // Control instance ids are caller-supplied and share ONE flat PluginHost keyspace with
  // executor/notification instances — they must not squat the reserved `execution-system:<id>`
  // namespace (see assertNotReservedInstanceId).
  assertNotReservedInstanceId(input.pluginInstanceId);
  const existing = await getControlBinding(tx, input.orgId, input.controlObjectId);
  if (existing) {
    const [row] = await tx
      .update(controlBindings)
      .set({
        pluginModule: input.pluginModule,
        pluginInstanceId: input.pluginInstanceId,
        config: input.config ?? {},
        updatedAt: new Date()
      })
      .where(eq(controlBindings.id, existing.id))
      .returning();
    return row!;
  }
  const [row] = await tx
    .insert(controlBindings)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      controlObjectId: input.controlObjectId,
      pluginModule: input.pluginModule,
      pluginInstanceId: input.pluginInstanceId,
      config: input.config ?? {}
    })
    .returning();
  return row!;
}

export interface InsertControlRunInput {
  orgId: string;
  controlObjectId: string;
  changeObjectId: string;
  gateKind: "lifecycle_edge" | "wave_boundary";
  gateRef: Record<string, unknown>;
  status: ControlOutcomeStatus;
  evidence: Record<string, unknown>;
  detail?: string | undefined;
  decisionId?: string | undefined;
  /**
   * WHICH KIND OF CONTROL PRODUCED THIS RUN — the `control_bindings.plugin_module` of the binding
   * that actually ran, stamped ON the run at insert (migration 0063).
   *
   * `undefined` is the honest answer for a row no bound ControlPlugin produced:
   * `federation/promotion-scan-step.ts` deposits rows under a synthetic control id with no binding,
   * and `ensureControlRun` deposits a `fail` row when a binding is MISSING. A caller asking "what
   * kind of evidence is this?" must be able to tell those apart from a real module, so the column is
   * nullable rather than defaulted.
   */
  pluginModule?: string | undefined;
}

export interface ControlRunRow {
  id: string;
  controlObjectId: string;
  changeObjectId: string;
  status: ControlOutcomeStatus;
  evidence: Record<string, unknown>;
  detail: string | null;
  decisionId: string | null;
  /**
   * The plugin module that produced this run, as recorded WHEN IT RAN — see
   * {@link InsertControlRunInput.pluginModule}.
   *
   * IT IS NOT READ FROM THE BINDING AT QUERY TIME, and that is the whole reason the column exists. A
   * binding is mutable: re-pointing one control from `webhook-control` to `github-check` would
   * retroactively relabel every historical run of that control as "the component's own checks
   * passed" — and `dependencies/bump-actuator.ts` grants an unattended merge on exactly that label,
   * reading historical runs. Evidence about the past must not be re-narrated by a present-tense
   * edit (ADR-0030 §2's "declared, never inferred"; this repo's own provenance-label lesson).
   *
   * `null` on rows written before 0063, and on rows no bound plugin produced. Treated as NOT an
   * own-check by the one caller that weighs it — the fail-closed direction, which costs a pull
   * request rather than an unattended merge.
   */
  pluginModule: string | null;
  createdAt: Date;
}

export async function insertControlRun(
  tx: TenantTx,
  input: InsertControlRunInput
): Promise<ControlRunRow> {
  const [row] = await tx
    .insert(controlRuns)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      controlObjectId: input.controlObjectId,
      changeObjectId: input.changeObjectId,
      gateKind: input.gateKind,
      gateRef: input.gateRef,
      status: input.status,
      evidence: input.evidence,
      detail: input.detail ?? null,
      decisionId: input.decisionId ?? null,
      pluginModule: input.pluginModule ?? null
    })
    .returning();
  return row as unknown as ControlRunRow;
}

/** The most recent run of `controlObjectId` against `changeObjectId`, regardless of gate — used
 *  both to decide "has this already run" and to surface the outcome to `governance/evaluate.ts`. */
export async function latestControlRun(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string,
  controlObjectId: string
): Promise<ControlRunRow | undefined> {
  const rows = await tx
    .select()
    .from(controlRuns)
    .where(
      and(
        eq(controlRuns.orgId, orgId),
        eq(controlRuns.changeObjectId, changeObjectId),
        eq(controlRuns.controlObjectId, controlObjectId)
      )
    )
    .orderBy(desc(controlRuns.createdAt))
    .limit(1);
  return rows[0] as unknown as ControlRunRow | undefined;
}

export async function listControlRunsForChange(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<ControlRunRow[]> {
  const rows = await tx
    .select()
    .from(controlRuns)
    .where(and(eq(controlRuns.orgId, orgId), eq(controlRuns.changeObjectId, changeObjectId)))
    .orderBy(desc(controlRuns.createdAt));
  return rows as unknown as ControlRunRow[];
}
