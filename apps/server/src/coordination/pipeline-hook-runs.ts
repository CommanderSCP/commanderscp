import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { ExecutionPhase, ExecutorPlugin } from "@scp/plugin-api";
import type {
  CapturedWorkflowRef,
  ExecutorLane,
  PipelineHookKind,
  TestRunEvidence
} from "@scp/schemas";
import { CapturedWorkflowRefSchema, TestBundleRefSchema, WorkflowRefSchema } from "@scp/schemas";
import type { Db } from "../db/client.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { pipelineHookRuns } from "../db/schema.js";
import { commitShaOfSourceRef } from "../governance/gate-orchestrator.js";
import { getChangeRow } from "./changes-repo.js";
import type { PluginHost } from "../plugin-host/contract.js";
import {
  DEFAULT_BINDING_TYPE,
  resolveLaneBinding,
  resolveExecutorPluginInstance
} from "./executor-bindings-repo.js";
import { recordTestRunEvidence } from "./pipeline-hooks-repo.js";

/** RUN TRACKING for pipeline test hooks. See docs/coordination.md §616. */

/** A run's status, pinned to the phase member for member. See docs/coordination.md §617. */
export type HookRunStatus = ExecutionPhase;

const PHASE_TO_STATUS: Record<ExecutionPhase, HookRunStatus> = {
  pending: "pending",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  aborted: "aborted"
};

const TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "aborted"
] as const satisfies readonly HookRunStatus[];
const NON_TERMINAL_STATUSES = ["pending", "running"] as const satisfies readonly HookRunStatus[];

export function isTerminalHookRunStatus(status: HookRunStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Which executor Type a hook run resolves its binding on. See docs/coordination.md §618. */
export const HOOK_RUN_EXECUTOR_TYPE = DEFAULT_BINDING_TYPE;

/** Which lane a hook run dispatches on, as one constant. See docs/coordination.md §619. */
export const HOOK_RUN_EXECUTOR_LANE: ExecutorLane = "test";

// Identity and the idempotency key

/**
 * The tuple the `pipeline_hook_runs_identity` UNIQUE constraint enforces, and the tuple the
 * idempotency key is derived from. `waveIndex` is `null` for `postMerge`, which belongs to no wave.
 */
export interface HookRunIdentity {
  orgId: string;
  changeObjectId: string;
  hookId: string;
  waveIndex: number | null;
}

/** Delimiter between identity components. NUL is this repo's composite-key delimiter, chosen
 *  because it cannot occur in any of the components being joined — uuids, a `hookId` bounded to
 *  printable text by `ManifestPipelineHookSchema`, and a decimal integer. It never leaves this
 *  function: what crosses to the plugin is the hex digest below. */
const KEY_DELIMITER = "\u0000";

/** The idempotency key is derived, never minted. See docs/coordination.md §620. */
export function hookRunIdempotencyKey(identity: HookRunIdentity): string {
  const preimage = [
    identity.orgId,
    identity.changeObjectId,
    identity.hookId,
    // `null` and `0` MUST NOT collide. The empty component is unambiguous because every other
    // spelling of a wave index is a decimal integer, and neither can contain the delimiter.
    identity.waveIndex === null ? "" : String(identity.waveIndex)
  ].join(KEY_DELIMITER);
  return `scp-hook-${createHash("sha256").update(preimage, "utf8").digest("hex")}`;
}

export interface PipelineHookRunRow {
  id: string;
  orgId: string;
  componentObjectId: string;
  targetObjectId: string | null;
  changeObjectId: string;
  hookId: string;
  kind: PipelineHookKind;
  waveIndex: number | null;
  artifactDigest: string | null;
  commitSha: string | null;
  externalRunId: string | null;
  externalUrl: string | null;
  status: HookRunStatus;
  pluginInstanceId: string;
  attempt: number;
  startedAt: Date;
  lastObservedAt: Date | null;
  capturedWorkflow: unknown;
  createdAt: Date;
  updatedAt: Date;
}

function toRunRow(row: typeof pipelineHookRuns.$inferSelect): PipelineHookRunRow {
  return {
    id: row.id,
    orgId: row.orgId,
    componentObjectId: row.componentObjectId,
    targetObjectId: row.targetObjectId,
    changeObjectId: row.changeObjectId,
    hookId: row.hookId,
    kind: row.kind as PipelineHookKind,
    waveIndex: row.waveIndex,
    artifactDigest: row.artifactDigest,
    commitSha: row.commitSha,
    externalRunId: row.externalRunId,
    externalUrl: row.externalUrl,
    status: row.status as HookRunStatus,
    pluginInstanceId: row.pluginInstanceId,
    attempt: row.attempt,
    startedAt: row.startedAt,
    lastObservedAt: row.lastObservedAt,
    capturedWorkflow: row.capturedWorkflow ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/** The BINDING CARRIER for a run. See docs/coordination.md §621. */
export function hookRunBindingCarrier(
  run: Pick<PipelineHookRunRow, "targetObjectId" | "componentObjectId">
): string {
  return run.targetObjectId ?? run.componentObjectId;
}

// 0b. The D23 capture — three facts that must ALL be present, or nothing

/** THE PIN A RUN IS CAPTURED AT, or `null`. See docs/coordination.md §622. */
export function deriveCapturedWorkflow(
  declaredWorkflow: unknown,
  sourceRef: unknown
): CapturedWorkflowRef | null {
  const workflow = WorkflowRefSchema.safeParse(declaredWorkflow);
  if (!workflow.success) return null;

  const commitSha = commitShaOfSourceRef(sourceRef);
  if (commitSha === undefined) return null;

  const ref =
    sourceRef !== null && typeof sourceRef === "object" && !Array.isArray(sourceRef)
      ? (sourceRef as Record<string, unknown>)
      : {};
  const bundle = TestBundleRefSchema.safeParse(ref.testBundle);
  if (!bundle.success) return null;

  const captured = CapturedWorkflowRefSchema.safeParse({
    ...workflow.data,
    commitSha,
    bundle: bundle.data
  });
  return captured.success ? captured.data : null;
}

// ---------------------------------------------------------------------------------------------
// 1. Claim — the database half of the trigger guard
// ---------------------------------------------------------------------------------------------

export interface ClaimHookRunInput extends HookRunIdentity {
  componentObjectId: string;
  targetObjectId: string | null;
  kind: PipelineHookKind;
  artifactDigest?: string | null;
  commitSha?: string | null;
  pluginInstanceId: string;
  /** The D23 pin, when the build's capture step has produced one. See `capturedWorkflowRefOf`. */
  capturedWorkflow?: CapturedWorkflowRef | null;
}

export interface ClaimHookRunResult {
  run: PipelineHookRunRow;
  /** `true` when THIS caller inserted the row and therefore owns the dispatch. `false` when the row
   *  already existed — another tick, or another worker replica, won the race and this caller must
   *  NOT call `trigger()`. */
  claimed: boolean;
}

/** Claims the right to trigger, or reports who holds it. See docs/coordination.md §623. */
export async function claimHookRun(
  tx: TenantTx,
  input: ClaimHookRunInput
): Promise<ClaimHookRunResult> {
  const inserted = await tx
    .insert(pipelineHookRuns)
    .values({
      id: uuidv7(),
      orgId: input.orgId,
      componentObjectId: input.componentObjectId,
      targetObjectId: input.targetObjectId,
      changeObjectId: input.changeObjectId,
      hookId: input.hookId,
      kind: input.kind,
      waveIndex: input.waveIndex,
      artifactDigest: input.artifactDigest ?? null,
      commitSha: input.commitSha ?? null,
      // NULL until the dispatch returns. See the column's doc: this is the state that makes
      // claim-before-trigger possible, and claim-before-trigger is the whole guard.
      externalRunId: null,
      externalUrl: null,
      status: "pending",
      pluginInstanceId: input.pluginInstanceId,
      attempt: 0,
      capturedWorkflow: input.capturedWorkflow ?? null
    })
    .onConflictDoNothing({
      target: [
        pipelineHookRuns.orgId,
        pipelineHookRuns.changeObjectId,
        pipelineHookRuns.hookId,
        pipelineHookRuns.waveIndex
      ]
    })
    .returning();

  if (inserted[0]) return { run: toRunRow(inserted[0]), claimed: true };

  const existing = await findHookRun(tx, input);
  if (!existing) {
    // Neither inserted nor findable. The only ways here are a concurrent DELETE between the two
    // statements (nothing deletes these rows today) or a conflict arbitrated by a DIFFERENT
    // constraint than the identity one — i.e. a bug in this function's `target`. Both are loud.
    throw new Error(
      `pipeline hook run claim for change ${input.changeObjectId} hook '${input.hookId}' wave ${String(input.waveIndex)} neither inserted nor found — the ON CONFLICT arbiter does not match the identity constraint`
    );
  }
  return { run: existing, claimed: false };
}

/** Reads one run by its identity tuple. `waveIndex: null` is matched as NULL (`IS NULL`), matching
 *  the constraint's `NULLS NOT DISTINCT` reading — a plain `= NULL` would find nothing and make the
 *  loser of a `postMerge` race think its row had vanished. */
export async function findHookRun(
  tx: TenantTx,
  identity: HookRunIdentity
): Promise<PipelineHookRunRow | undefined> {
  const rows = await tx
    .select()
    .from(pipelineHookRuns)
    .where(
      and(
        eq(pipelineHookRuns.orgId, identity.orgId),
        eq(pipelineHookRuns.changeObjectId, identity.changeObjectId),
        eq(pipelineHookRuns.hookId, identity.hookId),
        identity.waveIndex === null
          ? sql`${pipelineHookRuns.waveIndex} IS NULL`
          : eq(pipelineHookRuns.waveIndex, identity.waveIndex)
      )
    )
    .limit(1);
  return rows[0] ? toRunRow(rows[0]) : undefined;
}

export async function listHookRunsForChange(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<PipelineHookRunRow[]> {
  const rows = await tx
    .select()
    .from(pipelineHookRuns)
    .where(
      and(eq(pipelineHookRuns.orgId, orgId), eq(pipelineHookRuns.changeObjectId, changeObjectId))
    )
    .orderBy(asc(pipelineHookRuns.startedAt), asc(pipelineHookRuns.id));
  return rows.map(toRunRow);
}

/** Runs still in flight for one org — the poll driver's work list. Backed by the PARTIAL index
 *  `pipeline_hook_runs_non_terminal`, so it stays proportional to outstanding work. */
export async function listNonTerminalHookRuns(
  tx: TenantTx,
  orgId: string
): Promise<PipelineHookRunRow[]> {
  const rows = await tx
    .select()
    .from(pipelineHookRuns)
    .where(
      and(
        eq(pipelineHookRuns.orgId, orgId),
        inArray(pipelineHookRuns.status, [...NON_TERMINAL_STATUSES])
      )
    )
    .orderBy(asc(pipelineHookRuns.startedAt), asc(pipelineHookRuns.id));
  return rows.map(toRunRow);
}

// ---------------------------------------------------------------------------------------------
// 2. Trigger — claim, dispatch outside the transaction, record
// ---------------------------------------------------------------------------------------------

/** What the caller must supply to dispatch a hook run. */
export interface EnsureHookRunTriggeredInput {
  /** The declared hook (a `pipeline_hooks` row, or anything carrying these fields). */
  hook: {
    componentObjectId: string;
    kind: PipelineHookKind;
    hookId: string;
    /** `WorkflowRefSchema` as stored — the DECLARED half. It reaches the executor as a trigger
     *  parameter, and it is ALSO one of the three inputs `deriveCapturedWorkflow` needs: the
     *  evidence's pin is this ref PLUS the built commit PLUS the reported bundle. */
    workflow?: unknown;
  };
  change: { objectId: string };
  /** The deployment target, or `null` for `postMerge`, which is not target-specific. */
  target: { objectId: string } | null;
  waveIndex: number | null;
  /** The object whose executor binding this run dispatches through, and the executor Type to resolve
   *  it on. Omit `objectId` to use the derived carrier (target, else component) — which is what a
   *  later poll will use, so overriding it here makes the two disagree. */
  binding?: { objectId?: string; type?: typeof HOOK_RUN_EXECUTOR_TYPE };
  /** The evidence binding this run's result will carry: digest for the deployed kinds, commit for
   *  `postMerge`. Absent is permitted here and refused at the evidence write. */
  artifactDigest?: string | null;
  commitSha?: string | null;
  /** An explicit pin overriding the derivation below. See docs/coordination.md §624. */
  capturedWorkflow?: CapturedWorkflowRef | null;
}

export interface HookRunContext {
  orgId: string;
  host: PluginHost;
  masterKey: Buffer;
}

/** Dispatches a hook's workflow exactly once per key. See docs/coordination.md §625. */
export async function ensureHookRunTriggered(
  db: Db,
  ctx: HookRunContext,
  input: EnsureHookRunTriggeredInput
): Promise<PipelineHookRunRow> {
  const identity: HookRunIdentity = {
    orgId: ctx.orgId,
    changeObjectId: input.change.objectId,
    hookId: input.hook.hookId,
    waveIndex: input.waveIndex
  };
  const targetObjectId = input.target?.objectId ?? null;
  const carrier =
    input.binding?.objectId ??
    hookRunBindingCarrier({
      targetObjectId,
      componentObjectId: input.hook.componentObjectId
    });
  const type = input.binding?.type ?? HOOK_RUN_EXECUTOR_TYPE;

  // Step 1 — its own transaction, committed before anything external happens.
  const { run, claimed, externalRef } = await withTenantTx(db, ctx.orgId, async (tx) => {
    const resolved = await resolveExecutorPluginInstance(tx, {
      orgId: ctx.orgId,
      targetObjectId: carrier,
      masterKey: ctx.masterKey,
      type,
      // THE DISPATCH SEAM. See docs/coordination.md §626.
      lane: HOOK_RUN_EXECUTOR_LANE
    });
    if (!resolved) {
      // LOUD-UNBOUND, never a silent default (§14 resolution 2). A hook run that cannot address an
      // executor is not a run that quietly succeeds — this repo has already measured what an unbound
      // placement that fake-succeeds costs. Refusing here also keeps the poll honest: every row that
      // exists has a resolvable instance behind it.
      throw new Error(
        `no '${type}' executor binding for ${carrier} — refusing to claim a '${input.hook.kind}' hook run that could not be dispatched`
      );
    }
    // The SAME rule the dispatch seam above resolved through. See docs/coordination.md §627.
    const binding = (await resolveLaneBinding(tx, ctx.orgId, carrier, type, HOOK_RUN_EXECUTOR_LANE))
      ?.row;
    // The capture is resolved here, not asked of the caller. See docs/coordination.md §628.
    const changeRow = await getChangeRow(tx, ctx.orgId, input.change.objectId).catch(() => null);
    const capturedWorkflow =
      input.capturedWorkflow ??
      deriveCapturedWorkflow(input.hook.workflow, changeRow?.sourceRef ?? null);
    const claimResult = await claimHookRun(tx, {
      ...identity,
      componentObjectId: input.hook.componentObjectId,
      targetObjectId,
      kind: input.hook.kind,
      artifactDigest: input.artifactDigest ?? null,
      commitSha: input.commitSha ?? null,
      pluginInstanceId: resolved.instanceConfig.id,
      capturedWorkflow
    });
    await ctx.host.start([resolved.instanceConfig]);
    return {
      ...claimResult,
      externalRef: binding?.externalRef ?? null
    };
  });

  // Somebody else owns the dispatch. Return THEIR row — the caller wants "the run for this
  // identity", and there is exactly one.
  if (!claimed) return run;
  // Already dispatched and recorded by an earlier call that also claimed? Impossible: `claimed` is
  // true only for the inserting statement, which always writes `pending` with a NULL ref.
  if (run.externalRunId !== null) return run;

  // Step 2 — OUTSIDE any open transaction, on purpose (see the module doc).
  const client = ctx.host.executor(run.pluginInstanceId);
  let ref: Awaited<ReturnType<ExecutorPlugin["trigger"]>>;
  try {
    ref = await client.trigger({
      kind: "workflow_dispatch",
      targetRef: externalRef ?? carrier,
      idempotencyKey: hookRunIdempotencyKey(identity),
      parameters: {
        // What the executor needs to select and pin the run, from the DECLARED ref. Sent as
        // parameters rather than being resolved here: SCP coordinates, the executor executes.
        hookId: input.hook.hookId,
        hookKind: input.hook.kind,
        changeObjectId: input.change.objectId,
        ...(input.waveIndex === null ? {} : { waveIndex: input.waveIndex }),
        ...(input.hook.workflow === undefined || input.hook.workflow === null
          ? {}
          : { workflow: input.hook.workflow })
      }
    });
  } catch (err) {
    // The executor was REACHED and REFUSED. Record the attempt so a retry backs off instead of
    // re-firing on the next 1s tick — `reconcile.ts`'s `markWaveTargetTriggerFailed` idiom. Best
    // effort: if the bookkeeping write also fails, the executor's error is what the caller must see.
    await withTenantTx(db, ctx.orgId, (tx) =>
      tx
        .update(pipelineHookRuns)
        .set({ attempt: sql`${pipelineHookRuns.attempt} + 1`, updatedAt: new Date() })
        .where(and(eq(pipelineHookRuns.orgId, ctx.orgId), eq(pipelineHookRuns.id, run.id)))
    ).catch(() => undefined);
    throw err;
  }

  // Step 3 — its own transaction.
  return withTenantTx(db, ctx.orgId, async (tx) => {
    const [updated] = await tx
      .update(pipelineHookRuns)
      .set({
        externalRunId: ref.externalId,
        externalUrl: ref.url ?? null,
        status: "running",
        attempt: sql`${pipelineHookRuns.attempt} + 1`,
        updatedAt: new Date()
      })
      .where(and(eq(pipelineHookRuns.orgId, ctx.orgId), eq(pipelineHookRuns.id, run.id)))
      .returning();
    return toRunRow(updated!);
  });
}

// ---------------------------------------------------------------------------------------------
// 3. Poll — observe non-terminal runs, and write evidence exactly once on the terminal edge
// ---------------------------------------------------------------------------------------------

/** The pin for a run, or null; parsed rather than cast. See docs/coordination.md §629. */
export function capturedWorkflowRefOf(run: PipelineHookRunRow): CapturedWorkflowRef | null {
  if (run.capturedWorkflow === null || run.capturedWorkflow === undefined) return null;
  const parsed = CapturedWorkflowRefSchema.safeParse(run.capturedWorkflow);
  return parsed.success ? parsed.data : null;
}

/** Why a terminal run produced no evidence. See docs/coordination.md §630. */
export type EvidenceSkipReason =
  /** `capturedWorkflow` is absent or does not parse. See docs/coordination.md §631. */
  | "no_captured_workflow"
  /** `pipeline_evidence.target_object_id` is NOT NULL, because "an evidence row nobody can attribute
   *  is an evidence row nobody can revoke" — the authorization for evidence is scoped at the target.
   *  A `postMerge` run dispatched without one therefore has no subject to file evidence under. */
  | "no_target"
  /** Neither an artifact digest nor a built commit. `PipelineEvidenceSubjectSchema` refuses exactly
   *  this: evidence bound to nothing "would be read as covering whatever deploys next". */
  | "unbound";

export interface HookRunObservation {
  run: PipelineHookRunRow;
  /** `true` when this observation moved the run from non-terminal to terminal. Evidence is written
   *  on that edge and only on it. */
  becameTerminal: boolean;
  /** The id of the `pipeline_evidence` row written, when one was. */
  evidenceId?: string;
  /** Set when the run became terminal and evidence was deliberately NOT written. */
  evidenceSkipped?: EvidenceSkipReason;
}

/** How a terminal phase becomes one of two outcomes. See docs/coordination.md §632. */
export function outcomeFor(status: HookRunStatus): TestRunEvidence["outcome"] | null {
  if (status === "succeeded") return "passed";
  if (status === "failed" || status === "aborted") return "failed";
  return null;
}

/** Persists one observation, writing evidence on the edge. See docs/coordination.md §633. */
export async function applyHookRunObservation(
  tx: TenantTx,
  orgId: string,
  run: PipelineHookRunRow,
  phase: ExecutionPhase,
  observedAt: Date
): Promise<HookRunObservation> {
  const status = PHASE_TO_STATUS[phase];

  const [updated] = await tx
    .update(pipelineHookRuns)
    .set({ status, lastObservedAt: observedAt, updatedAt: observedAt })
    .where(
      and(
        eq(pipelineHookRuns.orgId, orgId),
        eq(pipelineHookRuns.id, run.id),
        // THE EDGE GUARD. Only a still-non-terminal row may be moved, so the terminal transition
        // happens at most once no matter how many observers arrive.
        inArray(pipelineHookRuns.status, [...NON_TERMINAL_STATUSES])
      )
    )
    .returning();

  if (!updated) {
    // Another observer terminalized it first (or it was already terminal). Report the current row
    // and write nothing — the evidence for this run has already been written, once, by them.
    const current = (await findHookRun(tx, run)) ?? run;
    return { run: current, becameTerminal: false };
  }

  const next = toRunRow(updated);
  const outcome = outcomeFor(status);
  if (outcome === null) return { run: next, becameTerminal: false };

  const captured = capturedWorkflowRefOf(next);
  if (captured === null) {
    return { run: next, becameTerminal: true, evidenceSkipped: "no_captured_workflow" };
  }
  if (next.targetObjectId === null) {
    return { run: next, becameTerminal: true, evidenceSkipped: "no_target" };
  }
  if (next.artifactDigest === null && next.commitSha === null) {
    return { run: next, becameTerminal: true, evidenceSkipped: "unbound" };
  }

  const evidence: TestRunEvidence = {
    kind: "testRun",
    hook: next.kind,
    hookId: next.hookId,
    workflow: captured,
    // `externalRunId` is NULL only while a claim has not yet been dispatched, and this branch is
    // reached only from a status poll of a dispatched run — but the fallback keeps the run's own id
    // (a real, resolvable handle) rather than an empty string, which `runId`'s `min(1)` refuses.
    runId: next.externalRunId ?? next.id,
    outcome,
    startedAt: next.startedAt.toISOString(),
    completedAt: observedAt.toISOString()
  };

  const row = await recordTestRunEvidence(tx, orgId, {
    componentObjectId: next.componentObjectId,
    targetObjectId: next.targetObjectId,
    hookId: next.hookId,
    artifactDigest: next.artifactDigest,
    commitSha: next.commitSha,
    // SERVER-STAMPED from the door this row came through, never from a payload: this row was
    // produced by SCP observing an executor, so it is `executor_observed`, and there is no human
    // principal behind it (`producerSubjectId` stays null). See `recordTestRunEvidence`'s doc.
    source: "executor_observed",
    producerSubjectId: null,
    evidence
  });

  return { run: next, becameTerminal: true, evidenceId: row.id };
}

/** ONE ORG'S POLL PASS over every non-terminal hook run. See docs/coordination.md §634. */
export async function pollNonTerminalHookRuns(
  db: Db,
  ctx: HookRunContext
): Promise<HookRunObservation[]> {
  const runs = await withTenantTx(db, ctx.orgId, (tx) => listNonTerminalHookRuns(tx, ctx.orgId));
  const observations: HookRunObservation[] = [];

  for (const run of runs) {
    if (run.externalRunId === null) {
      // Claimed but never dispatched — a crash between the claim and step 3, or a trigger that
      // threw. There is nothing to poll; re-dispatch is `ensureHookRunTriggered`'s job on the next
      // tick, and it will re-derive the SAME idempotency key. Skipped rather than errored.
      continue;
    }
    try {
      // Resolve the instance from the SAME carrier the trigger used (derived, not stored, so the two
      // cannot drift) and start it on THIS process's host — a freshly-started worker replica has
      // never called `host.start()` for an instance another replica triggered through.
      const resolved = await withTenantTx(db, ctx.orgId, (tx) =>
        resolveExecutorPluginInstance(tx, {
          orgId: ctx.orgId,
          targetObjectId: hookRunBindingCarrier(run),
          masterKey: ctx.masterKey,
          type: HOOK_RUN_EXECUTOR_TYPE,
          // Must match the trigger's lane; failure here is quiet. See docs/coordination.md §635.
          lane: HOOK_RUN_EXECUTOR_LANE
        })
      );
      if (!resolved || resolved.instanceConfig.id !== run.pluginInstanceId) {
        // The binding changed (or vanished) since the dispatch. Polling a DIFFERENT instance would
        // ask the wrong pipeline about this run's ref and get a confident, wrong answer, so this
        // leaves the run in flight and says so once per tick rather than terminalizing it on a
        // reading it never actually took.
        console.error(
          `[hook-runs] org ${ctx.orgId} run ${run.id}: executor binding for ${hookRunBindingCarrier(run)} no longer resolves to instance '${run.pluginInstanceId}' — leaving in flight`
        );
        continue;
      }
      await ctx.host.start([resolved.instanceConfig]);

      // OUTSIDE any transaction — an external RPC must never hold one open.
      const status = await ctx.host.executor(run.pluginInstanceId).status({
        externalId: run.externalRunId,
        ...(run.externalUrl === null ? {} : { url: run.externalUrl })
      });

      const observation = await withTenantTx(db, ctx.orgId, (tx) =>
        applyHookRunObservation(tx, ctx.orgId, run, status.phase, new Date())
      );
      observations.push(observation);

      if (observation.evidenceSkipped !== undefined) {
        // LOUD, per run, and only on the terminal edge (so it cannot become per-tick noise). A gate
        // that stays `awaiting` after its suite finished is otherwise a mystery hang, and the whole
        // reason for naming the skip reason is that the operator's next action differs per reason.
        console.error(
          `[hook-runs] org ${ctx.orgId} run ${run.id} ('${run.kind}'/'${run.hookId}') reached '${observation.run.status}' but NO evidence was written: ${observation.evidenceSkipped}`
        );
      }
    } catch (err) {
      // Still in flight as far as we know — polled again next tick. Per-run, so one unreachable
      // executor cannot abandon the rest of the org's runs.
      console.error(
        `[hook-runs] org ${ctx.orgId} run ${run.id} poll failed (will retry next tick):`,
        err
      );
    }
  }

  return observations;
}
