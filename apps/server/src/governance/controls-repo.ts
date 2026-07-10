import { and, desc, eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { ControlOutcomeStatus } from "@scp/plugin-api";
import type { TenantTx } from "../db/tenant-tx.js";
import { controlBindings, controlRuns } from "../db/schema.js";

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
    .where(and(eq(controlBindings.orgId, orgId), eq(controlBindings.controlObjectId, controlObjectId)))
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

export async function upsertControlBinding(tx: TenantTx, input: UpsertControlBindingInput): Promise<ControlBindingRow> {
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
}

export interface ControlRunRow {
  id: string;
  controlObjectId: string;
  changeObjectId: string;
  status: ControlOutcomeStatus;
  evidence: Record<string, unknown>;
  detail: string | null;
  decisionId: string | null;
  createdAt: Date;
}

export async function insertControlRun(tx: TenantTx, input: InsertControlRunInput): Promise<ControlRunRow> {
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
      decisionId: input.decisionId ?? null
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

export async function listControlRunsForChange(tx: TenantTx, orgId: string, changeObjectId: string): Promise<ControlRunRow[]> {
  const rows = await tx
    .select()
    .from(controlRuns)
    .where(and(eq(controlRuns.orgId, orgId), eq(controlRuns.changeObjectId, changeObjectId)))
    .orderBy(desc(controlRuns.createdAt));
  return rows as unknown as ControlRunRow[];
}
