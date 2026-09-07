import { and, desc, eq, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { ControlOutcomeStatus } from "@scp/plugin-api";
import type { TenantTx } from "../db/tenant-tx.js";
import { controlBindings, controlRuns } from "../db/schema.js";
import { assertNotReservedInstanceId } from "../coordination/executor-bindings-repo.js";

/** Control graph objects. See docs/governance.md §52. */

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
  /** WHICH KIND OF CONTROL PRODUCED THIS RUN. See docs/governance.md §53. */
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
  /** The module that produced this run, as recorded then. See docs/governance.md §54. */
  pluginModule: string | null;
  /** M22.8 — WHICH GATE CROSSING this run authorized. Already stored (`NOT NULL` since M4) and
   *  already the cache key since M22.0a; declared on the row type so `listControlRunsForChange`'s
   *  caller can project it. Typed loosely because `select()` returns the column verbatim and the
   *  DB's CHECK, not this interface, is what constrains it. */
  gateKind: string;
  gateRef: Record<string, unknown>;
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

/** The most recent run of that control against the change. See docs/governance.md §55. */
export async function latestControlRunForGate(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string,
  controlObjectId: string,
  gateKind: "lifecycle_edge" | "wave_boundary",
  gateRef: Record<string, unknown>
): Promise<ControlRunRow | undefined> {
  const rows = await tx
    .select()
    .from(controlRuns)
    .where(
      and(
        eq(controlRuns.orgId, orgId),
        eq(controlRuns.changeObjectId, changeObjectId),
        eq(controlRuns.controlObjectId, controlObjectId),
        eq(controlRuns.gateKind, gateKind),
        sql`${controlRuns.gateRef} = ${JSON.stringify(gateRef)}::jsonb`
      )
    )
    .orderBy(desc(controlRuns.createdAt))
    .limit(1);
  return rows[0] as unknown as ControlRunRow | undefined;
}

/** The most recent run, regardless of which gate asked. See docs/governance.md §56. */
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
