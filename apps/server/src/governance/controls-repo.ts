import { and, desc, eq, sql } from "drizzle-orm";
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

/**
 * M22.0a (ADR-0033 §10) — the most recent run of `controlObjectId` against `changeObjectId` **FOR A
 * SPECIFIC GATE CROSSING**.
 *
 * WHY GATE IDENTITY IS PART OF THE KEY. `latestControlRun` below ignores the gate entirely, so ONE
 * run satisfied every gate that change would ever face. The deciding run is normally the reconcile
 * PREWARM, made while the change sits in `validating`; that single row then answered the accept
 * edge AND every subsequent `wave_boundary` gate in every wave, including the production wave, for
 * the rest of the change's life. A control outcome is evidence that a PARTICULAR crossing was
 * authorized, not a permanent property of the change.
 *
 * That was tolerable while a control verdict could only get *stricter* over time. It stops being
 * tolerable with ADR-0033: an exclusion grant carries an EXPIRY, so a 7-day grant resolved during
 * validation would otherwise still authorize a production wave three weeks after it lapsed. This is
 * the "verify the lever, not just the signal" failure in its purest form — the grant is readable
 * and nothing re-reads it.
 *
 * THIS DOES NOT BREAK THE PREWARM -> ACCEPT-EDGE PATH, and that is not luck: prewarm writes
 * `gateKind: "lifecycle_edge"` with `gateRef: {fromState: "validating", toState: "accepted"}`
 * (gate-orchestrator.ts), and the accept-edge gate passes `{fromState: ctx.fromState, toState:
 * ctx.toState}` — byte-identical for that transition. The accept gate still finds prewarm's run.
 * What no longer matches is a WAVE boundary, whose `gateRef` is `{topologyObjectId, waveIndex}` —
 * exactly the crossing that must be re-decided.
 *
 * `gate_ref` is compared as `jsonb`, whose equality is over the normalized binary form, so key
 * ORDER in the caller's object is irrelevant and no canonicalization is needed here.
 *
 * COST, STATED PLAINLY: a change with N waves now produces up to N+1 runs per control rather than
 * one. That is the correct semantics — each crossing is authorized on its own evidence — and for
 * `github-check` the `EXPIRED_RECHECK_INTERVAL_MS` cooldown still bounds the external call rate.
 */
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

/** The most recent run of `controlObjectId` against `changeObjectId`, regardless of gate.
 *
 *  PREFER `latestControlRunForGate` for any AUTHORIZATION decision — see its doc for why keying
 *  without the gate let one run authorize every later crossing. This gate-agnostic form remains for
 *  surfacing "what happened to this control on this change at all", where the newest outcome across
 *  every gate is the intended answer. */
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
