import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { ExecutionPhase, ExecutorPlugin } from "@scp/plugin-api";
import type { CapturedWorkflowRef, PipelineHookKind, TestRunEvidence } from "@scp/schemas";
import {
  CapturedWorkflowRefSchema,
  TestBundleRefSchema,
  WorkflowRefSchema
} from "@scp/schemas";
import type { Db } from "../db/client.js";
import type { TenantTx } from "../db/tenant-tx.js";
import { withTenantTx } from "../db/tenant-tx.js";
import { pipelineHookRuns } from "../db/schema.js";
import { commitShaOfSourceRef } from "../governance/gate-orchestrator.js";
import { getChangeRow } from "./changes-repo.js";
import type { PluginHost } from "../plugin-host/contract.js";
import {
  DEFAULT_BINDING_TYPE,
  getExecutorBinding,
  resolveExecutorPluginInstance
} from "./executor-bindings-repo.js";
import { recordTestRunEvidence } from "./pipeline-hooks-repo.js";

/**
 * RUN TRACKING for pipeline test hooks (team-pipeline-iac increment 8, migration 0098) — the layer
 * between "SCP triggers a test workflow" and "evidence exists".
 *
 * ============================================================================================
 * THE GAP THIS CLOSES, STATED AS THE CONTRACT STATES IT
 * ============================================================================================
 * `TestRunEvidenceSchema.outcome` is `passed|failed` and nothing else, deliberately: "Evidence is a
 * record of something that FINISHED; an in-flight run is expressed by the ABSENCE of evidence."
 *
 * That is right for evidence and it leaves one fact homeless. Between dispatching a postDeploy suite
 * for wave N and that suite finishing, nothing in the database says the dispatch happened. The
 * reconcile tick runs once a second; every tick would look for evidence, correctly find none,
 * correctly conclude `awaiting` — and dispatch the suite again. `pipeline_hook_runs` records exactly
 * the one fact evidence structurally cannot: THAT WE ALREADY ASKED.
 *
 * It is not a second evidence table. `evaluatePostDeployGate` never reads it; the verdict functions
 * in `./pipeline-hook-verdicts.ts` see only `pipeline_evidence` rows, exactly as before. What this
 * module guarantees is that exactly one such row eventually appears per run, and that the run fires
 * once.
 *
 * ============================================================================================
 * THE SHAPE IS `reconcile.ts`'s, NOT A SECOND ONE
 * ============================================================================================
 * Both drivers below are deliberate copies of the two shapes `coordination/reconcile.ts` already
 * uses, because a second shape for the same problem is how two answers to one question get written:
 *
 *   TRIGGER — `triggerWaveTarget`'s crash-safe three steps (PR #7 review CRITICAL #2). tx A claims;
 *     the external `trigger()` call happens OUTSIDE any open transaction; tx B records the returned
 *     ref. A crash anywhere between leaves a durable claim and nothing else, and the next tick
 *     re-derives the SAME `idempotencyKey` and re-calls `trigger()`, which a conformant executor
 *     dedups into the same `ExternalRunRef`.
 *
 *   POLL — `reconcileExecutingChange`'s status loop: resolve the instance, `client.status(ref)`,
 *     map the phase, persist the observation in its own short transaction.
 *
 * BOTH TAKE `db`, NOT `tx`, AND THAT IS THE WHOLE POINT of the shape rather than a convenience. An
 * external RPC inside an open transaction is the bug reconcile.ts spent CRITICAL #2 removing: the
 * side effect is irreversible and the transaction is not, so any later failure in the same
 * transaction rolls back the record of a dispatch that really happened. The tx-taking halves are
 * exported separately (`claimHookRun`, `listNonTerminalHookRuns`, `applyHookRunObservation`) so a
 * caller that genuinely only wants the database half has one, without an executor call riding along.
 */

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

/**
 * A run's status, PINNED TO `ExecutionPhase` MEMBER FOR MEMBER.
 *
 * Not "similar to" it — the `PHASE_TO_STATUS` map below is a TOTAL `Record<ExecutionPhase, ...>`, so
 * a member added to `@scp/plugin-api`'s union and not handled here is a COMPILE ERROR rather than a
 * run that silently stays non-terminal forever and re-polls until the heat death of the estate. That
 * total-`Record` idiom is the one this repo already uses to pin `DependencyIndexEcosystem` and
 * `RolloutTargetClass` across the same package boundary, and it is used here for the same reason:
 * the two copies of the ecosystem vocabulary DID drift once, precisely because no test crossed it.
 */
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

/**
 * Which executor Type a hook run resolves its binding on (ADR-0007 routing).
 *
 * ONE CONSTANT, USED BY BOTH THE TRIGGER AND THE POLL, and that is the property that matters rather
 * than the value. `reconcile.ts` has a comment on exactly this hazard — resolving the poll on a
 * different Type than the trigger used "would silently drive the wrong pipeline" — and it avoids it
 * by persisting the wave target's Type. This table does not carry a Type column, so agreement is
 * bought instead by there being a single definition that both paths read.
 *
 * `configuration` because §14 resolution 6's DEDICATED TEST LANE would be a new member of
 * `ExecutorTypeSchema`, which is a closed enum in `@scp/schemas` and therefore an API-surface change
 * owned by a different increment. When that member lands, this constant is the ONE line that
 * changes, and trigger and poll move together by construction.
 */
export const HOOK_RUN_EXECUTOR_TYPE = DEFAULT_BINDING_TYPE;

// ---------------------------------------------------------------------------------------------
// Identity and the idempotency key
// ---------------------------------------------------------------------------------------------

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

/**
 * `TriggerIntent.idempotencyKey` for one logical run, DERIVED — never minted.
 *
 * ============================================================================================
 * WHY THIS IS A PURE FUNCTION OF THE IDENTITY AND NOT, SAY, THE ROW'S `id`
 * ============================================================================================
 * The contract's requirement is that the key be "IDENTICAL every time ... including after a
 * crash/resume where the engine can't tell whether the previous call's side effect actually fired".
 * The row id would satisfy that too (it is stable once claimed, and `claimHookRun` returns the
 * EXISTING row on conflict, so a retry re-reads the same id) — that is exactly what `reconcile.ts`
 * does with `waveTargetId`.
 *
 * Deriving from the identity instead buys one extra property that matters here and does not there:
 * the key is computable BEFORE the row exists, and by any caller, from facts alone. So the claim
 * and the trigger cannot disagree even in the window where the claim's outcome is unknown, and a
 * test can assert the key without reaching into storage. The two derivations agree in every case
 * anyway, because the row id is itself a function of the identity via the unique constraint.
 *
 * SHA-256 hex rather than the joined components: the pre-image contains NUL bytes and unbounded-ish
 * text, and this value crosses a JSON-RPC boundary into third-party plugin code that may forward it
 * to an executor with its own charset and length limits. A fixed 64-char lowercase-hex tail is safe
 * everywhere and reveals nothing about the tenant.
 */
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

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

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

/**
 * The BINDING CARRIER for a run — the graph object whose executor binding this run dispatches
 * through, and the object a later poll must resolve the SAME instance from.
 *
 * Derived rather than stored, so the two paths cannot disagree: the deployment target when there is
 * one, and the component when there is not (`postMerge`, which is not target-specific).
 */
export function hookRunBindingCarrier(
  run: Pick<PipelineHookRunRow, "targetObjectId" | "componentObjectId">
): string {
  return run.targetObjectId ?? run.componentObjectId;
}

// ---------------------------------------------------------------------------------------------
// 0b. The D23 capture — three facts that must ALL be present, or nothing
// ---------------------------------------------------------------------------------------------

/**
 * THE PIN A RUN IS CAPTURED AT, or `null`.
 *
 * ============================================================================================
 * THREE FACTS, ALL REQUIRED, NONE OF THEM INVENTED
 * ============================================================================================
 *   1. The DECLARED `WorkflowRef` (repo, branch, path) off the `pipeline_hooks` row — what the team
 *      wrote in IaC. On its own it is "a pointer into whatever the cluster happens to hold right
 *      now", which is exactly what D23 refuses to gate on.
 *   2. The BUILT COMMIT off the change's `source_ref` — read with `commitShaOfSourceRef`, the ONE
 *      definition of "which commit is this change about" that `gate-orchestrator.ts` already uses to
 *      bind a `postMerge` evidence lookup and a `github-check` control. A second reader here would
 *      be a run pinned to a different commit than the gate beside it asks about.
 *   3. The TEST BUNDLE `{repository, digest}` off `source_ref.testBundle` — the reference the build
 *      REPORTED (`ChangeReportRequestSchema.testBundle`). This is the fact that did not exist in the
 *      tree until now, and its absence is why every run's `captured_workflow` was NULL.
 *
 * ============================================================================================
 * WHAT THIS FUNCTION REFUSES TO DO, AND WHY EACH REFUSAL IS LOAD-BEARING
 * ============================================================================================
 * ANY of the three missing yields `null`, which the caller stores as NULL and the poll driver turns
 * into `no_captured_workflow`: terminal status recorded, NO evidence written, named reason logged.
 * That is today's behaviour preserved exactly, and it is preserved rather than patched because each
 * available shortcut is a lie of a different shape:
 *
 *   - Fabricating a digest (`sha256:` + zeros, or the image's own digest) would satisfy
 *     `CapturedWorkflowRefSchema`'s regex and produce evidence pinned to bytes nobody verified —
 *     the failure `evaluateScanCoverage`'s `not_digest_bound` refusal prevents one layer down.
 *   - Falling back to "the branch tip" for the commit would make "which tests gate this wave" a
 *     statement about whatever main holds today, which is the unreproducible thing D23 exists to
 *     replace.
 *   - Inferring the bundle repository by convention from the image repository (`acme/api` ->
 *     `acme/api-tests`) would bind a gate verdict to a location SCP GUESSED. D18's rule is that the
 *     source is always explicit, and this repo has already measured what a provenance label computed
 *     from "which branch matched" rather than read off the resolved object costs.
 *
 * PARSED, NOT ASSEMBLED: the result goes through `CapturedWorkflowRefSchema`, so a 7-character short
 * sha or a non-canonical digest yields `null` rather than a row that merely has the right keys.
 */
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

/**
 * Claims the right to trigger one run, or reports that somebody else already holds it.
 *
 * ============================================================================================
 * `ON CONFLICT DO NOTHING` RATHER THAN CATCH-THE-UNIQUE-VIOLATION, AND THIS IS NOT A STYLE CHOICE
 * ============================================================================================
 * The obvious spelling — insert, catch `23505`, then SELECT the existing row — does not work inside
 * a transaction, and fails in a way that looks like it works when the function is tested with its
 * own connection. A constraint violation ABORTS the enclosing PostgreSQL transaction; every
 * subsequent statement on it, including the recovery SELECT, fails with `25P02` until a rollback.
 * So the caught error would be swapped for a more confusing one, at exactly the moment the code path
 * is trying to be graceful. `ON CONFLICT DO NOTHING` never raises, so the transaction survives and
 * the follow-up read is a plain read.
 *
 * The UNIQUE constraint is still the guard — it is what makes the conflict happen. This is only the
 * spelling that lets the loser find out politely.
 */
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

/** Every run recorded for one change, oldest first. */
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
  /** The Change this run gates. */
  change: { objectId: string };
  /** The deployment target, or `null` for `postMerge`, which is not target-specific. */
  target: { objectId: string } | null;
  /** `null` for `postMerge`, which belongs to no wave. */
  waveIndex: number | null;
  /** The object whose executor binding this run dispatches through, and the executor Type to resolve
   *  it on. Omit `objectId` to use the derived carrier (target, else component) — which is what a
   *  later poll will use, so overriding it here makes the two disagree. */
  binding?: { objectId?: string; type?: typeof HOOK_RUN_EXECUTOR_TYPE };
  /** The evidence binding this run's result will carry: digest for the deployed kinds, commit for
   *  `postMerge`. Absent is permitted here and refused at the evidence write. */
  artifactDigest?: string | null;
  commitSha?: string | null;
  /**
   * An EXPLICIT D23 pin, overriding the one this function derives.
   *
   * NORMALLY OMITTED. The derivation below reads the change's own `source_ref` inside the claim
   * transaction, so a caller cannot forget to supply the pin and silently get a run that writes no
   * evidence — the failure this repo names "component built, never installed", in the one shape
   * that produces no error anywhere. `null` and `undefined` both mean "derive it"; only a real
   * object overrides.
   */
  capturedWorkflow?: CapturedWorkflowRef | null;
}

export interface HookRunContext {
  orgId: string;
  host: PluginHost;
  masterKey: Buffer;
}

/**
 * Dispatches a hook's workflow exactly once per `(org, change, hookId, waveIndex)`, and returns the
 * run row either way.
 *
 * The three steps are `reconcile.ts`'s `triggerWaveTarget` steps, and the ordering is the design:
 *
 *   1. tx A — resolve the plugin instance and CLAIM the row. Committing this claim is what makes the
 *      dispatch decision durable and exclusive; the UNIQUE constraint arbitrates.
 *   2. OUTSIDE any transaction — `client.trigger()`, carrying the derived `idempotencyKey`.
 *   3. tx B — record the returned `ExternalRunRef` and move `pending` -> `running`.
 *
 * A caller that loses the claim in step 1 returns the winner's row and DOES NOT DISPATCH. A crash
 * between steps leaves a `pending` row with a NULL `externalRunId`; the next tick re-enters here,
 * loses nothing, re-derives the SAME key and re-calls `trigger()`, which a conformant executor
 * dedups into the same ref (`TriggerIntent.idempotencyKey`).
 */
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
      type
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
    const binding = await getExecutorBinding(tx, ctx.orgId, carrier, type);
    // THE D23 CAPTURE, resolved HERE rather than asked of the caller (see `capturedWorkflow`'s doc).
    // Read from the change row inside this transaction, so the pin is a fact about the change as it
    // stands at the moment the dispatch becomes durable. A missing change row is a missing fact like
    // any other — `null`, no pin, no evidence, named reason — never a throw that would wedge the
    // dispatch of a run whose gate is perfectly able to say "awaiting".
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

/**
 * The D23 pin for a run, or `null` when the build's capture step has not produced one.
 *
 * PARSED, NOT CAST. The column is `jsonb` and its writers are server-side, but a value that merely
 * has the right keys is not a `CapturedWorkflowRef` — the schema's regexes are what make `commitSha`
 * a 40-hex git sha and `bundle.digest` a canonical `sha256:<64-hex>`, and those are exactly the
 * fields that make the evidence a statement about specific bytes rather than about the word
 * "passed". So it goes through `CapturedWorkflowRefSchema` and a failure yields `null`, which the
 * caller treats as "no pin", not as "close enough".
 */
export function capturedWorkflowRefOf(run: PipelineHookRunRow): CapturedWorkflowRef | null {
  if (run.capturedWorkflow === null || run.capturedWorkflow === undefined) return null;
  const parsed = CapturedWorkflowRefSchema.safeParse(run.capturedWorkflow);
  return parsed.success ? parsed.data : null;
}

/**
 * Why a terminal run produced no evidence — returned so the caller can say so rather than leaving a
 * gate `awaiting` for a reason nobody can name.
 *
 * Every member is a MISSING FACT, not a failure to try. The rule they all serve is one this repo has
 * already paid for in the scan layer: unbound evidence is not evidence, and a shape-valid verdict
 * covering a digest it never examined is worse than no verdict at all
 * (`evaluateScanCoverage`'s `not_digest_bound`). So each of these makes the run terminal and writes
 * NOTHING.
 */
export type EvidenceSkipReason =
  /** `capturedWorkflow` is absent or does not parse — i.e. `deriveCapturedWorkflow` could not
   *  assemble all THREE of the declared `WorkflowRef`, the built commit, and the reported
   *  `sourceRef.testBundle`. A build that reports no bundle lands here, which is the honest reading:
   *  synthesising a bundle digest to satisfy the type would manufacture a pin to bytes nobody
   *  verified. */
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

/**
 * How a terminal phase becomes a `TestRunEvidence.outcome`, which has only two members.
 *
 * `aborted` -> `failed` IS A JUDGEMENT AND IS RECORDED AS ONE. An aborted run did not conclude with
 * a verdict about the target, so `failed` overstates what is known; but the alternative — writing no
 * evidence — leaves `evaluatePostDeployGate` returning `awaiting` forever, because the run row now
 * exists and correctly suppresses a re-trigger. That is a silent, permanent hang at a gate, which is
 * strictly worse than a loud hold: `evaluateBakeGate`'s stated rule for safety interlocks is that
 * "'wrongly held' and 'wrongly released' are not comparable costs", and the same asymmetry decides
 * this. The full truth is not lost — the RUN row keeps `aborted`, so an operator reading the run
 * sees "cancelled", not "the suite failed".
 */
export function outcomeFor(status: HookRunStatus): TestRunEvidence["outcome"] | null {
  if (status === "succeeded") return "passed";
  if (status === "failed" || status === "aborted") return "failed";
  return null;
}

/**
 * Persists ONE observation of ONE run, and — on the non-terminal -> terminal edge only — writes the
 * corresponding `pipeline_evidence` test-run row.
 *
 * ============================================================================================
 * "EXACTLY ONE EVIDENCE ROW, EVEN IF THE RUN IS OBSERVED TWICE" HAS TWO INDEPENDENT GUARDS
 * ============================================================================================
 * The first is the edge condition: the UPDATE below only matches a row still in a NON-TERMINAL
 * status, so a second observation of an already-terminal run updates nothing, returns
 * `becameTerminal: false`, and never reaches the evidence write. Two concurrent worker replicas both
 * polling the same run therefore produce one evidence write, because only one UPDATE can win the
 * row.
 *
 * The second is `pipeline_evidence_test_run_identity` (migration 0096), the PARTIAL unique index
 * that makes test-run evidence newest-wins per binding. Even if the edge guard were somehow
 * bypassed, `recordTestRunEvidence` deletes-then-inserts within the key, so the table still holds
 * exactly one row. Belt and braces, deliberately: the second guard is a property of the schema and
 * survives a future caller that forgets the first.
 */
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

/**
 * ONE ORG'S POLL PASS over every non-terminal hook run.
 *
 * ============================================================================================
 * THIS EXTENDS THE EXISTING RECONCILE TICK. IT IS NOT A SECOND LOOP, AND MUST NOT BECOME ONE.
 * ============================================================================================
 * It is called from `reconcileOrgTick`, in sequence with the other `advance*` steps, on the ONE
 * pg-boss tick job the engine already schedules. There is no `boss.work()` here and none may be
 * added: `boss.work()` is a COMPETING CONSUMER, so a second worker registered on the reconcile queue
 * would take ticks away from the engine rather than run alongside it, and a second queue would be a
 * second liveness surface to keep alive.
 *
 * MULTI-REPLICA SAFETY WITHOUT A CLAIM LOCK. Unlike `triggerWaveTarget`, this path takes no advisory
 * lock, because it does not need one: `status()` is a READ against the executor, so two replicas
 * polling the same run cost one extra HTTP call and nothing else, and the write is arbitrated by
 * `applyHookRunObservation`'s edge guard (only a still-non-terminal row can be moved). A lock here
 * would buy nothing and would add a way for the poll to stall.
 *
 * Mirrors `reconcileExecutingChange`'s status loop: `client.status(ref)` OUTSIDE any transaction, a
 * short transaction per observation, and a per-run try/catch so one unreachable executor cannot
 * abandon the rest of the org's runs.
 */
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
          type: HOOK_RUN_EXECUTOR_TYPE
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
