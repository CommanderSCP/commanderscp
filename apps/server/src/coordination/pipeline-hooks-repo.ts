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

/**
 * STORAGE for the pipeline test hooks and their evidence (team-pipeline-iac increment 8,
 * migration 0096).
 *
 * The contract is `packages/schemas/src/pipeline-behaviors.ts` and the consumers are the pure verdict
 * functions in `./pipeline-hook-verdicts.ts`. This module is the seam between them: it fetches, it
 * writes, and it shapes its output to the verdict functions' EXACT input types (`BakeAlarmReport`,
 * `LatestContinuousEvidence`) rather than to a parallel shape that merely looks similar. Where a
 * return type here is one the verdict module already declares, it is IMPORTED from there — a
 * structurally-identical local copy is exactly how two "matching" shapes drift apart.
 *
 * NO ROUTES AND NO ZOD SCHEMAS LIVE HERE. The write doors that will call `record*Evidence` stamp
 * `source` and `producerSubjectId` from the authenticated request; see those functions' docs.
 */

// ---------------------------------------------------------------------------------------------
// Hooks — the DECLARED half
// ---------------------------------------------------------------------------------------------

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

/**
 * Every hook declared on any of `componentObjectIds`.
 *
 * Batched by design: reconcile evaluates a whole wave's targets in one tick, and a per-component
 * query there is the N+1 that turns one tick into one query per target. An EMPTY id list returns `[]`
 * without touching the database — `inArray` with an empty array compiles to invalid SQL in drizzle,
 * which is a runtime error rather than the empty result a caller would reasonably expect.
 */
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

/**
 * Create-or-update keyed on the identity tuple, for the later plan-apply path.
 *
 * `ON CONFLICT` on the identity constraint rather than a read-then-branch: apply runs concurrently
 * with nothing today, but a lookup-then-insert has a window in which two applies both see no row and
 * both insert, and the constraint would then turn the second one into an error the operator has to
 * interpret instead of the convergence they asked for.
 *
 * Note this does NOT make a changed hook an in-place edit at the CONTRACT level — the manifest's
 * identity rule stands, and plan-diff still renders a kind/hookId change as delete + create because
 * those fields ARE the identity. What this updates is the payload BESIDE the identity.
 */
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
  // OUTPOST-RUN PROBES — the declaration travels to the domain that will RUN it. Journalled on the
  // same seam objects and relationships use (`appendJournalEntry`), unconditionally: WHICH peers
  // receive it is `scope-filter.ts`'s decision, not this writer's, exactly as for `object_upsert`.
  // Emitting here rather than at the IaC apply site means a hook written by any door — apply, a
  // future API, a test harness — federates, instead of one door federating and the others not.
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
  // The tombstone carries the SAME content hash the upsert did, so a receiver can tell which
  // declaration is being removed rather than only which identity — the discipline
  // `relationship_tombstone` follows (it passes `existing.contentHash`). A no-op delete journals
  // NOTHING: apply-time prune legitimately asks for hooks a previous apply already removed, and a
  // tombstone for a row that never existed would be a fact this instance cannot vouch for.
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

// ---------------------------------------------------------------------------------------------
// Evidence — the OBSERVED half
// ---------------------------------------------------------------------------------------------

/** Where an evidence row came from. SERVER-STAMPED at every write door and NEVER read from a request
 *  body — `SubmitPipelineEvidenceRequestSchema` deliberately has no such field. */
/**
 * WHO PRODUCED a piece of evidence. Server-side only — it appears nowhere in `openapi.v1.json`
 * (measured), so adding a member costs no oasdiff exception.
 *
 * `peer_reported` is the OUTPOST-RUN PROBE source: evidence a peer produced in its own domain and
 * journalled upward. It is STAMPED BY THE RECEIVER at import, never read from the entry's payload —
 * provenance is the authorization boundary, not the payload shape, and a shape-valid payload is
 * forgeable by anyone who can read the schema. A peer's journal is SIGNED, which proves who sent
 * it; it does not make the contents true, so the receiver records what it knows (this came from
 * that peer) rather than what the sender claimed about itself.
 */
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

/**
 * Records a concluded test run, SUPERSEDING any prior run for the same
 * `(org, component, target, hookId, artifactDigest-or-commitSha)`. One row survives per key: the
 * newest.
 *
 * ===========================================================================================
 * WHY THIS IS SEMANTICS AND NOT A RETENTION HACK
 * ===========================================================================================
 * The distinction is worth being precise about, because "we delete the old row" reads like a
 * space-saving measure and is not one. The contract's stale-reads-as-ABSENT rule
 * (`ManifestContinuousHookSchema`, implemented by `evaluateContinuousHold`) means every consumer of
 * test-run evidence reads the LATEST row for a key and nothing else — an older row cannot affect any
 * verdict, in any direction, ever. So it is not redundant data being pruned for cost; it is data that
 * is UNREADABLE BY DESIGN, and keeping it would mean storing rows whose only possible effect is to
 * make a future reader think there is history to consult when the contract says there is not.
 *
 * The idiom is the one `federation/scan-evidence.ts` already uses and is cited here deliberately:
 * runs are grouped by the QUESTION they answer (`questionKey`) and only the newest run of each
 * question is consulted — "an older pass therefore cannot outvote a newer fail, and ... a newer pass
 * DOES clear an older fail". Both directions matter, and both are what makes this a REPLACE rather
 * than an insert-if-absent: a newer FAILING run must be able to displace an older passing one.
 *
 * ===========================================================================================
 * `source` AND `producerSubjectId` ARE STAMPED BY THE CALLER FROM THE REQUEST, NEVER FROM THE BODY
 * ===========================================================================================
 * `SubmitPipelineEvidenceRequestSchema` carries no producer field and must never gain one:
 * PROVENANCE IS THE AUTHORIZATION BOUNDARY, NOT THE PAYLOAD SHAPE, because a shape-valid payload is
 * forgeable by anyone who can read the schema (`federation/scan-evidence.ts`). This function takes
 * them as explicit parameters precisely so the stamping is visible at every call site rather than
 * defaulted somewhere a caller could forget to override.
 */
export async function recordTestRunEvidence(
  tx: TenantTx,
  orgId: string,
  input: RecordTestRunEvidenceInput
): Promise<PipelineEvidenceRow> {
  const artifactDigest = input.artifactDigest ?? null;
  const commitSha = input.commitSha ?? null;

  // Supersede in the SAME transaction as the insert. Delete-then-insert rather than ON CONFLICT
  // because the identity index is an EXPRESSION index (`coalesce(...)`, partial on kind='testRun'),
  // which drizzle's `onConflictDoUpdate` target cannot name; the partial unique index in migration
  // 0096 still stands behind this as the race guard, so two concurrent writers cannot both land a
  // row for one key — the loser gets a unique violation and retries, which is the loud outcome.
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
  // OUTPOST-RUN PROBES, THE UPWARD HALF. A probe runs in the domain, so its result is produced
  // HERE and the commander's gate needs it. Journalled on the same seam the hook declaration came
  // down on, which is what makes the air gap work by construction: the entry rides return media
  // with everything else, and no outpost ever needs an outbound credential to the commander.
  //
  // `federationImport` skips it for the same reason the hook doors do — a commander that
  // re-journalled a peer's evidence would send it back, and with peers paired both ways, loop.
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

/**
 * Records one alarm-state report. THIS ACCUMULATES — it deliberately does NOT supersede.
 *
 * ===========================================================================================
 * WHY, AND WHAT THAT COSTS
 * ===========================================================================================
 * A bake gate is not asking "what is the latest alarm state"; it is asking "was the whole quiet
 * window observed, alarm-free, by a single source". `evaluateBakeGate` answers that by MERGING the
 * intervals a source asserted and checking they contiguously cover `[deployedAt, deployedAt +
 * quietWindowSeconds]` — "A GAP IS NOT COVERAGE". Superseding older reports would delete precisely
 * the earlier slices of the window that coverage is computed from, so a bake gate over a one-hour
 * window fed by five-minute reports would see exactly one five-minute interval and refuse forever.
 * The history IS the evidence here, in a way it structurally is not for test runs.
 *
 * THE CONSEQUENCE, STATED RATHER THAN GLOSSED: this table grows without bound. Retention for it is an
 * OPEN QUESTION and is deliberately left to the existing Decision/audit retention thread (ADR-0024's
 * retention classes, the measured 1.44 GB/day unbounded-decision incident) rather than invented here.
 * Inventing a local sweeper would be a second, uncoordinated retention policy in a tree that already
 * has one — and, worse, one written by the module least able to say which windows are still needed.
 *
 * `source` and `producerSubjectId` are stamped by the caller from the authenticated request, never
 * from the body — same rule as `recordTestRunEvidence`, and it bites harder here: coverage is
 * evaluated PER SOURCE, so a caller able to choose its own `source` could manufacture single-source
 * coverage of a window nobody observed.
 */
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

/**
 * The single latest test-run row for a (component, target, hook) and, when given, a specific binding.
 *
 * A binding field that is OMITTED is not filtered on; a binding field that is given is matched
 * exactly. That asymmetry is deliberate: `evaluateContinuousHold` asks "what is the latest word on
 * this target" with no binding, while `evaluatePostDeployGate` asks about the digest a specific wave
 * is promoting and must not be answered with evidence about different bytes. Passing an explicit
 * `null` means "bound to nothing here", which matches only rows that are themselves unbound on that
 * axis — the same reading `recordTestRunEvidence`'s supersession key uses, so a row written under one
 * binding is found by a query under the same binding.
 *
 * Ordered by `createdAt DESC` (the `pipeline_evidence_latest` index's trailing column), tie-broken by
 * `id DESC` — uuidv7 ids are time-ordered, so within one `now()` two rows still order by arrival.
 */
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

/**
 * Every alarm-state report for a (component, target, hook) whose ASSERTED window overlaps the
 * required one, shaped as `BakeAlarmReport[]` — the exact input `evaluateBakeGate` takes.
 *
 * OVERLAP, NOT CONTAINMENT: a report that starts before the required window and ends inside it
 * covers a real slice of it, and dropping it here would manufacture a gap that the merge step would
 * then correctly refuse. Deciding coverage is the verdict function's job (it merges intervals and
 * checks contiguity, per source); this query's job is only to withhold nothing relevant. The
 * predicate is therefore the standard interval overlap `start <= requiredEnd AND end >= requiredStart`.
 *
 * The returned `source` is the SERVER-STAMPED column, never anything from the payload — see
 * `recordAlarmEvidence`. It is included because `evaluateBakeGate` partitions by it and a report
 * without it could not be attributed to a source at all.
 *
 * The return type is IMPORTED from `pipeline-hook-verdicts.ts` rather than redeclared, so this is a
 * compile-time guarantee of shape agreement rather than a resemblance maintained by hand.
 */
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

/**
 * INERTNESS PROBE — does this org declare ANY hook of this kind, at all?
 *
 * The property this buys is the one `governance/freeze-scope.ts` states for freezes and has its own
 * counting test for: an org that declares nothing pays ONE indexed read per change per tick and
 * nothing else — no placement resolution, no per-target evidence query, no per-hook loop. Both
 * admission callers ask this first and return an empty verdict set when it is false.
 *
 * It is a `LIMIT 1` existence read, not a count: the answer is a boolean and counting the rows of an
 * estate-sized table to produce one would be the same query written the expensive way. The
 * `(org_id, component_object_id, kind, hook_id)` unique index is a usable prefix scan on `org_id`.
 */
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

/**
 * WHAT A WAVE TARGET IS, in the two coordinates every hook and every evidence row is keyed by.
 *
 * `pipeline_evidence` is keyed `(component_object_id, target_object_id, hook_id)` and
 * `pipeline_hooks` is keyed on the COMPONENT — but a wave target is a `placement` object id, which
 * is neither. This resolves the pair.
 *
 * BATCHED, and that is the whole reason it lives here rather than being `resolvePlacementPair`
 * called in a loop: `stage-dependency-hold.ts`'s single-target resolver issues one query per target,
 * which is exactly the N+1 `listHooksForComponents` was written to avoid on the line above it.
 *
 * A TARGET THAT IS NOT A PLACEMENT IS ITS OWN COMPONENT. A legacy-shaped wave target names a
 * component directly (see `resolvePlacementPair`, which returns `null` for one), and the honest
 * reading of "which component is this target about" is then the target itself. Evidence for such a
 * target is therefore keyed `(target, target, hookId)`. Returning nothing instead would make every
 * declared hook silently inapplicable on a legacy topology — a gate that is declared, rendered by
 * `scp iac render`, and enforces nothing.
 *
 * A SOFT-DELETED target resolves to NOTHING and is absent from the map: `containmentChain` does not
 * filter `deleted_at` on its base row and this one deliberately does, for the same reason
 * `freeze-hold.ts` refuses to hold a dead target — a hook cannot be about an object that was
 * deleted.
 */
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
