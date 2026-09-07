import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { AlarmStateEvidence, PipelineHookKind, TestRunEvidence } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects, pipelineEvidence, pipelineHooks } from "../db/schema.js";
import { appendJournalEntry } from "../federation/journal-repo.js";
import {
  computePipelineEvidenceContentHash,
  computePipelineHookContentHash
} from "../graph/content-hash.js";
import type { BakeAlarmReport } from "./pipeline-hook-verdicts.js";
import { enqueueProbeScheduleRetraction } from "./continuous-probe-retractions-repo.js";

/** STORAGE for the pipeline test hooks and their evidence. See docs/coordination.md §644. */

/** A `pipeline_hooks` row. The per-kind columns are nullable because the four kinds carry different
 *  fields (see the table's doc comment); the closed per-kind shape is Zod's job at the write door. */
export interface PipelineHookRow {
  id: string;
  orgId: string;
  componentObjectId: string;
  kind: PipelineHookKind;
  hookId: string;
  workflow: unknown;
  stage: string | null;
  everySeconds: number | null;
  maxAgeSeconds: number | null;
  quietWindowSeconds: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** IDENTITY — the tuple the UNIQUE constraint enforces (`ManifestPipelineHookSchema`: "there is no
 *  update path keyed on a subset"). Every mutating function below takes exactly this, never a
 *  looser lookup, so no caller can reach a row by a partial key. */
export interface PipelineHookIdentity {
  componentObjectId: string;
  kind: PipelineHookKind;
  hookId: string;
}

/** Set by the federation IMPORT path only. Skips the journal append, because a receiver that
 *  re-journalled what it was sent would echo the entry back to its sender and, with two peers
 *  paired both ways, loop. The same reason `createObject` carries `federationImport`. */
export interface FederationImportable {
  federationImport?: boolean;
}

export interface UpsertPipelineHookInput extends FederationImportable, PipelineHookIdentity {
  workflow?: unknown;
  stage?: string | null;
  everySeconds?: number | null;
  maxAgeSeconds?: number | null;
  quietWindowSeconds?: number | null;
}

function toHookRow(row: typeof pipelineHooks.$inferSelect): PipelineHookRow {
  return {
    id: row.id,
    orgId: row.orgId,
    componentObjectId: row.componentObjectId,
    kind: row.kind as PipelineHookKind,
    hookId: row.hookId,
    workflow: row.workflow ?? null,
    stage: row.stage,
    everySeconds: row.everySeconds,
    maxAgeSeconds: row.maxAgeSeconds,
    quietWindowSeconds: row.quietWindowSeconds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/** Every hook declared on any of `componentObjectIds`. See docs/coordination.md §645. */
export async function listHooksForComponents(
  tx: TenantTx,
  orgId: string,
  componentObjectIds: string[]
): Promise<PipelineHookRow[]> {
  if (componentObjectIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(pipelineHooks)
    .where(
      and(
        eq(pipelineHooks.orgId, orgId),
        inArray(pipelineHooks.componentObjectId, componentObjectIds)
      )
    );
  return rows.map(toHookRow);
}

/** Create-or-update keyed on the identity tuple. See docs/coordination.md §646. */
export async function upsertHook(
  tx: TenantTx,
  orgId: string,
  input: UpsertPipelineHookInput
): Promise<PipelineHookRow> {
  const values = {
    workflow: input.workflow ?? null,
    stage: input.stage ?? null,
    everySeconds: input.everySeconds ?? null,
    maxAgeSeconds: input.maxAgeSeconds ?? null,
    quietWindowSeconds: input.quietWindowSeconds ?? null
  };
  const [row] = await tx
    .insert(pipelineHooks)
    .values({
      id: uuidv7(),
      orgId,
      componentObjectId: input.componentObjectId,
      kind: input.kind,
      hookId: input.hookId,
      ...values
    })
    .onConflictDoUpdate({
      target: [
        pipelineHooks.orgId,
        pipelineHooks.componentObjectId,
        pipelineHooks.kind,
        pipelineHooks.hookId
      ],
      set: { ...values, updatedAt: new Date() }
    })
    .returning();
  const hook = toHookRow(row!);
  // The declaration travels to the domain that will run it. See docs/coordination.md §647.
  if (input.federationImport !== true)
    await appendJournalEntry(tx, {
      orgId,
      entryKind: "pipeline_hook_upsert",
      contentHash: computePipelineHookContentHash({
        orgId,
        componentObjectId: hook.componentObjectId,
        kind: hook.kind,
        hookId: hook.hookId,
        workflow: hook.workflow,
        stage: hook.stage,
        everySeconds: hook.everySeconds,
        maxAgeSeconds: hook.maxAgeSeconds,
        quietWindowSeconds: hook.quietWindowSeconds
      }),
      // IDENTITY PLUS DECLARATION, never the local row id — a hook's identity is
      // `(orgId, componentObjectId, kind, hookId)` and the uuid belongs to whichever instance minted
      // it. An outpost applying this mints its own.
      payload: {
        componentObjectId: hook.componentObjectId,
        kind: hook.kind,
        hookId: hook.hookId,
        workflow: hook.workflow,
        stage: hook.stage,
        everySeconds: hook.everySeconds,
        maxAgeSeconds: hook.maxAgeSeconds,
        quietWindowSeconds: hook.quietWindowSeconds
      }
    });
  return hook;
}

/** Removes one declared hook. Returns the deleted row, or `undefined` when there was none — a no-op
 *  delete is not an error here: apply-time prune legitimately asks for hooks that a previous apply
 *  already removed. */
export async function deleteHook(
  tx: TenantTx,
  orgId: string,
  identity: PipelineHookIdentity,
  federationImport?: boolean
): Promise<PipelineHookRow | undefined> {
  const [row] = await tx
    .delete(pipelineHooks)
    .where(
      and(
        eq(pipelineHooks.orgId, orgId),
        eq(pipelineHooks.componentObjectId, identity.componentObjectId),
        eq(pipelineHooks.kind, identity.kind),
        eq(pipelineHooks.hookId, identity.hookId)
      )
    )
    .returning();
  if (!row) return undefined;
  const hook = toHookRow(row);
  // A continuous hook owns a schedule the delete cannot remove. See docs/coordination.md §648.
  if (hook.kind === "continuous") await enqueueProbeScheduleRetraction(tx, orgId, hook);
  // The tombstone carries the same hash the upsert did. See docs/coordination.md §649.
  if (federationImport !== true)
    await appendJournalEntry(tx, {
      orgId,
      entryKind: "pipeline_hook_tombstone",
      contentHash: computePipelineHookContentHash({
        orgId,
        componentObjectId: hook.componentObjectId,
        kind: hook.kind,
        hookId: hook.hookId,
        workflow: hook.workflow,
        stage: hook.stage,
        everySeconds: hook.everySeconds,
        maxAgeSeconds: hook.maxAgeSeconds,
        quietWindowSeconds: hook.quietWindowSeconds
      }),
      payload: {
        componentObjectId: hook.componentObjectId,
        kind: hook.kind,
        hookId: hook.hookId
      }
    });
  return hook;
}

/** Where an evidence row came from. SERVER-STAMPED at every write door and NEVER read from a request
 *  body — `SubmitPipelineEvidenceRequestSchema` deliberately has no such field. */
/** WHO PRODUCED a piece of evidence. Server-side only. See docs/coordination.md §650. */
export type PipelineEvidenceSource =
  "rollout_analysis" | "pushed" | "executor_observed" | "peer_reported";

/** What a piece of evidence is bound to. Exactly one of the two is required by the consuming hook
 *  (`postMerge` -> commit, the other three -> digest); both may be present on the wire. */
export interface PipelineEvidenceBinding {
  artifactDigest?: string | null;
  commitSha?: string | null;
}

export interface PipelineEvidenceSubjectRef extends PipelineEvidenceBinding {
  componentObjectId: string;
  targetObjectId: string;
  hookId: string;
}

export interface RecordTestRunEvidenceInput
  extends PipelineEvidenceSubjectRef, FederationImportable {
  /** SERVER-STAMPED by the caller from the authenticated request — see `recordTestRunEvidence`. */
  source: PipelineEvidenceSource;
  /** SERVER-STAMPED by the caller from the authenticated subject. `null` for machine-observed rows
   *  that have no human principal behind them. */
  producerSubjectId?: string | null;
  evidence: TestRunEvidence;
}

export interface RecordAlarmEvidenceInput extends PipelineEvidenceSubjectRef {
  /** NARROWER THAN THE COLUMN, on purpose: `BakeAlarmReport["source"]` is a two-member union, and
   *  `evaluateBakeGate` computes coverage PER SOURCE over exactly those two. Admitting a third
   *  spelling here would create a source the gate can never satisfy a window from, whose rows would
   *  be silently invisible to the only function that reads them. */
  source: BakeAlarmReport["source"];
  producerSubjectId?: string | null;
  evidence: AlarmStateEvidence;
}

export interface PipelineEvidenceRow {
  id: string;
  orgId: string;
  componentObjectId: string;
  targetObjectId: string;
  hookId: string;
  kind: "testRun" | "alarmState";
  artifactDigest: string | null;
  commitSha: string | null;
  source: PipelineEvidenceSource;
  producerSubjectId: string | null;
  payload: unknown;
  createdAt: Date;
}

function toEvidenceRow(row: typeof pipelineEvidence.$inferSelect): PipelineEvidenceRow {
  return {
    id: row.id,
    orgId: row.orgId,
    componentObjectId: row.componentObjectId,
    targetObjectId: row.targetObjectId,
    hookId: row.hookId,
    kind: row.kind as "testRun" | "alarmState",
    artifactDigest: row.artifactDigest,
    commitSha: row.commitSha,
    source: row.source as PipelineEvidenceSource,
    producerSubjectId: row.producerSubjectId,
    payload: row.payload,
    createdAt: row.createdAt
  };
}

/** Records a concluded test run, superseding any prior. See docs/coordination.md §651. */
export async function recordTestRunEvidence(
  tx: TenantTx,
  orgId: string,
  input: RecordTestRunEvidenceInput
): Promise<PipelineEvidenceRow> {
  const artifactDigest = input.artifactDigest ?? null;
  const commitSha = input.commitSha ?? null;

  // Supersede in the SAME transaction as the insert. See docs/coordination.md §652.
  await tx
    .delete(pipelineEvidence)
    .where(
      and(
        eq(pipelineEvidence.orgId, orgId),
        eq(pipelineEvidence.componentObjectId, input.componentObjectId),
        eq(pipelineEvidence.targetObjectId, input.targetObjectId),
        eq(pipelineEvidence.hookId, input.hookId),
        eq(pipelineEvidence.kind, "testRun"),
        sql`coalesce(${pipelineEvidence.artifactDigest}, '') = coalesce(${artifactDigest}::text, '')`,
        sql`coalesce(${pipelineEvidence.commitSha}, '') = coalesce(${commitSha}::text, '')`
      )
    );

  const [row] = await tx
    .insert(pipelineEvidence)
    .values({
      id: uuidv7(),
      orgId,
      componentObjectId: input.componentObjectId,
      targetObjectId: input.targetObjectId,
      hookId: input.hookId,
      kind: "testRun",
      artifactDigest,
      commitSha,
      source: input.source,
      producerSubjectId: input.producerSubjectId ?? null,
      payload: input.evidence
    })
    .returning();
  const evidence = toEvidenceRow(row!);
  // OUTPOST-RUN PROBES, THE UPWARD HALF. See docs/coordination.md §653.
  if (input.federationImport !== true)
    await appendJournalEntry(tx, {
      orgId,
      entryKind: "pipeline_evidence_upsert",
      contentHash: computePipelineEvidenceContentHash({
        orgId,
        componentObjectId: evidence.componentObjectId,
        targetObjectId: evidence.targetObjectId,
        hookId: evidence.hookId,
        artifactDigest: evidence.artifactDigest,
        commitSha: evidence.commitSha,
        payload: evidence.payload
      }),
      // NO `source` AND NO `producerSubjectId` ON THE WIRE, deliberately. Both are provenance the
      // RECEIVER stamps from what it knows (which peer signed this bundle), and shipping them would
      // invite a receiver to trust a sender's claim about its own authority — the exact inversion
      // `recordTestRunEvidence`'s own doc refuses for the pushed door.
      payload: {
        componentObjectId: evidence.componentObjectId,
        targetObjectId: evidence.targetObjectId,
        hookId: evidence.hookId,
        artifactDigest: evidence.artifactDigest,
        commitSha: evidence.commitSha,
        evidence: evidence.payload
      }
    });
  return evidence;
}

/** Records one alarm-state report. THIS ACCUMULATES. See docs/coordination.md §654. */
export async function recordAlarmEvidence(
  tx: TenantTx,
  orgId: string,
  input: RecordAlarmEvidenceInput
): Promise<PipelineEvidenceRow> {
  const [row] = await tx
    .insert(pipelineEvidence)
    .values({
      id: uuidv7(),
      orgId,
      componentObjectId: input.componentObjectId,
      targetObjectId: input.targetObjectId,
      hookId: input.hookId,
      kind: "alarmState",
      artifactDigest: input.artifactDigest ?? null,
      commitSha: input.commitSha ?? null,
      source: input.source,
      producerSubjectId: input.producerSubjectId ?? null,
      payload: input.evidence
    })
    .returning();
  return toEvidenceRow(row!);
}

export interface LatestTestRunEvidenceQuery extends PipelineEvidenceBinding {
  componentObjectId: string;
  targetObjectId: string;
  hookId: string;
}

/** The single latest test-run row for a hook and target. See docs/coordination.md §655. */
export async function latestTestRunEvidence(
  tx: TenantTx,
  orgId: string,
  query: LatestTestRunEvidenceQuery
): Promise<PipelineEvidenceRow | null> {
  const conditions = [
    eq(pipelineEvidence.orgId, orgId),
    eq(pipelineEvidence.componentObjectId, query.componentObjectId),
    eq(pipelineEvidence.targetObjectId, query.targetObjectId),
    eq(pipelineEvidence.hookId, query.hookId),
    eq(pipelineEvidence.kind, "testRun")
  ];
  if (query.artifactDigest !== undefined) {
    conditions.push(
      sql`coalesce(${pipelineEvidence.artifactDigest}, '') = coalesce(${query.artifactDigest}::text, '')`
    );
  }
  if (query.commitSha !== undefined) {
    conditions.push(
      sql`coalesce(${pipelineEvidence.commitSha}, '') = coalesce(${query.commitSha}::text, '')`
    );
  }

  const rows = await tx
    .select()
    .from(pipelineEvidence)
    .where(and(...conditions))
    .orderBy(desc(pipelineEvidence.createdAt), desc(pipelineEvidence.id))
    .limit(1);
  return rows[0] ? toEvidenceRow(rows[0]) : null;
}

export interface AlarmReportsInWindowQuery {
  componentObjectId: string;
  targetObjectId: string;
  hookId: string;
  /** The required window — normally `targetDeployedAt` .. `+ quietWindowSeconds`, i.e. exactly what
   *  `evaluateBakeGate` derives from the same two facts. */
  windowStart: Date;
  windowEnd: Date;
}

/** Every alarm report whose window overlaps the required one. See docs/coordination.md §656. */
export async function alarmReportsInWindow(
  tx: TenantTx,
  orgId: string,
  query: AlarmReportsInWindowQuery
): Promise<BakeAlarmReport[]> {
  const rows = await tx
    .select()
    .from(pipelineEvidence)
    .where(
      and(
        eq(pipelineEvidence.orgId, orgId),
        eq(pipelineEvidence.componentObjectId, query.componentObjectId),
        eq(pipelineEvidence.targetObjectId, query.targetObjectId),
        eq(pipelineEvidence.hookId, query.hookId),
        eq(pipelineEvidence.kind, "alarmState"),
        sql`(${pipelineEvidence.payload} ->> 'windowStart')::timestamptz <= ${query.windowEnd.toISOString()}::timestamptz`,
        sql`(${pipelineEvidence.payload} ->> 'windowEnd')::timestamptz >= ${query.windowStart.toISOString()}::timestamptz`
      )
    )
    .orderBy(pipelineEvidence.createdAt);

  return rows.map((row) => {
    const payload = row.payload as AlarmStateEvidence;
    return {
      // The stamped column. `executor_observed` is not a member of `BakeAlarmReport["source"]` and
      // `recordAlarmEvidence` refuses to write it, so this narrowing is total for every row this
      // query can return.
      source: row.source as BakeAlarmReport["source"],
      evidence: {
        windowStart: payload.windowStart,
        windowEnd: payload.windowEnd,
        alarms: payload.alarms
      }
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Admission support — the two reads the gate (`pipeline-hook-gate.ts`) and the per-target hold
// (`continuous-hold.ts`) both need, defined ONCE here rather than twice beside them.
// ---------------------------------------------------------------------------------------------

/** Inertness probe: does this org declare any such hook. See docs/coordination.md §657. */
export async function orgDeclaresHookKind(
  tx: TenantTx,
  orgId: string,
  kind: PipelineHookKind
): Promise<boolean> {
  const rows = await tx
    .select({ id: pipelineHooks.id })
    .from(pipelineHooks)
    .where(and(eq(pipelineHooks.orgId, orgId), eq(pipelineHooks.kind, kind)))
    .limit(1);
  return rows.length > 0;
}

/** What a wave target is, in the two coordinates used. See docs/coordination.md §658. */
export interface PipelineHookSubject {
  targetObjectId: string;
  componentObjectId: string;
  /** `null` for a legacy component-shaped wave target, which names no place. Reported for the
   *  Decision's explanation; nothing keys on it. */
  deploymentTargetObjectId: string | null;
}

export async function resolveHookSubjects(
  tx: TenantTx,
  orgId: string,
  targetObjectIds: string[]
): Promise<Map<string, PipelineHookSubject>> {
  const subjects = new Map<string, PipelineHookSubject>();
  if (targetObjectIds.length === 0) return subjects;

  const rows = await tx
    .select({ id: objects.id, typeId: objects.typeId, properties: objects.properties })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        inArray(objects.id, [...new Set(targetObjectIds)]),
        isNull(objects.deletedAt)
      )
    );

  for (const row of rows) {
    if (row.typeId !== "placement") {
      subjects.set(row.id, {
        targetObjectId: row.id,
        componentObjectId: row.id,
        deploymentTargetObjectId: null
      });
      continue;
    }
    const props = row.properties as { componentId?: unknown; deploymentTargetId?: unknown };
    if (typeof props.componentId !== "string" || typeof props.deploymentTargetId !== "string") {
      // A placement missing either half resolves to nothing rather than to a guess. It is absent
      // from the map, so every caller treats it as "no hooks apply" — the same reading a target
      // whose object was deleted gets.
      continue;
    }
    subjects.set(row.id, {
      targetObjectId: row.id,
      componentObjectId: props.componentId,
      deploymentTargetObjectId: props.deploymentTargetId
    });
  }
  return subjects;
}
