import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ComponentPipelineObservedRun } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { changeSourceEvents, changes, objects } from "../db/schema.js";
import { canonicalizeSourceRef, extractHint } from "./webhook-processor.js";

/** THE `observedRun` FIELD OF A COMPONENT'S PIPELINE. See docs/coordination.md §575. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A run/pipeline id, read as a string either way GitHub/gitea/gitlab spell it (a JSON number for
 *  every provider here, but read leniently). */
function runIdOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return nonEmptyString(value);
}

interface RawRunFields {
  runId: string | null;
  url: string | null;
  workflowName: string | null;
  workflowPath: string | null;
}

/** The github/gitea run object's citable fields. `citeNameAndPath` is false for gitea (see the
 *  module doc — its adapter cites no such keys). */
function githubLikeRunFields(run: Record<string, unknown>, citeNameAndPath: boolean): RawRunFields {
  return {
    runId: runIdOf(run.id),
    url: nonEmptyString(run.html_url),
    workflowName: citeNameAndPath ? nonEmptyString(run.name) : null,
    workflowPath: citeNameAndPath ? nonEmptyString(run.path) : null
  };
}

/** GitLab's `GitlabPipeline` (observed shape) — id/web_url only; no workflow name/path exists on a
 *  pipeline at all. */
function gitlabPipelineFields(pipeline: Record<string, unknown>): RawRunFields {
  return {
    runId: runIdOf(pipeline.id),
    url: nonEmptyString(pipeline.web_url),
    workflowName: null,
    workflowPath: null
  };
}

/** One candidate's run identity, or null when nothing readable here counts as one. */
export interface RunIdentity {
  repo: string | null;
  runId: string;
  workflowName: string | null;
  workflowPath: string | null;
  url: string | null;
}

/** The predicate applied to one change's source ref. See docs/coordination.md §576. */
export function runIdentityOfSourceRef(
  sourceKind: string | null | undefined,
  sourceRef: unknown
): RunIdentity | null {
  if (!isRecord(sourceRef)) return null;
  const repo = nonEmptyString(sourceRef.repo);

  const isObservedRunEvent =
    sourceRef._observed === true && sourceRef.kind === "workflow_run" && isRecord(sourceRef.raw);

  let fields: RawRunFields | null = null;

  if (sourceKind === "github") {
    if (isRecord(sourceRef.workflow_run)) {
      fields = githubLikeRunFields(sourceRef.workflow_run, true);
    } else if (isObservedRunEvent) {
      fields = githubLikeRunFields(sourceRef.raw as Record<string, unknown>, true);
    }
  } else if (sourceKind === "gitea") {
    if (isObservedRunEvent) {
      fields = githubLikeRunFields(sourceRef.raw as Record<string, unknown>, false);
    }
  } else if (sourceKind === "gitlab") {
    if (isObservedRunEvent) {
      fields = gitlabPipelineFields(sourceRef.raw as Record<string, unknown>);
    } else if (isRecord(sourceRef.object_attributes)) {
      const attrs = sourceRef.object_attributes;
      const runId = runIdOf(attrs.id);
      const isPipelineShape =
        runId !== null && nonEmptyString(attrs.sha) !== null && nonEmptyString(attrs.ref) !== null;
      // No url key is cited anywhere in the adapter's Pipeline Hook case (see module doc), so this
      // shape never carries one — stated null rather than guessed.
      fields = isPipelineShape
        ? { runId, url: null, workflowName: null, workflowPath: null }
        : null;
    }
  }

  if (!fields || !fields.runId) return null;
  if (!fields.url && !repo) return null;

  return {
    repo,
    runId: fields.runId,
    workflowName: fields.workflowName,
    workflowPath: fields.workflowPath,
    url: fields.url
  };
}

interface ObservedRunChangeCandidate {
  id: string;
  sourceKind: string | null;
  sourceRef: unknown;
  createdAt: Date;
}

/** Bounded newest-first scan size. See docs/coordination.md §577. */
const OBSERVED_RUN_SCAN_LIMIT = 50;

/** Ceiling on the run events read for one component's candidate commits. One commit legitimately
 *  carries several runs (CI, lint, a re-run), so this is a multiple of the change page, not equal
 *  to it. Stated as a bound so the read can never be the unbounded scan of an append-only table. */
const OBSERVED_RUN_EVENT_LIMIT = 200;

/** The source kinds `runIdentityOfSourceRef` can read a run out of. Anything else yields nothing,
 *  so it is not worth a lookup. */
const RUN_SOURCE_KINDS = ["github", "gitea", "gitlab"] as const;

/** The bounded, org-scoped read of stored events at the given commits, newest first. Exported so
 *  the index-usage test EXPLAINs this exact query rather than a copy of it. */
export function selectEventsByCommit(
  tx: TenantTx,
  orgId: string,
  sourceKinds: string[],
  commits: string[]
) {
  return tx
    .select({
      id: changeSourceEvents.id,
      sourceKind: changeSourceEvents.sourceKind,
      headers: changeSourceEvents.headers,
      payload: changeSourceEvents.payload,
      createdAt: changeSourceEvents.createdAt,
      // `change_source_events.commit_sha` (0113) — the database-derived commit of the stored payload.
      commit: changeSourceEvents.commitSha
    })
    .from(changeSourceEvents)
    .where(
      and(
        eq(changeSourceEvents.orgId, orgId),
        inArray(changeSourceEvents.sourceKind, sourceKinds),
        // The generated COLUMN, never the jsonb expression it is derived from: `->>` is not leakproof,
        // so under forced RLS an expression predicate cannot be an index condition (0113).
        inArray(changeSourceEvents.commitSha, commits)
      )
    )
    .orderBy(desc(changeSourceEvents.createdAt), desc(changeSourceEvents.id))
    .limit(OBSERVED_RUN_EVENT_LIMIT);
}

/** The commit a change's release is at: the canonical `commit` key `canonicalizeSourceRef` lifts
 *  from the event hint. It is the only key every ingress path writes. */
function commitOfChange(sourceRef: unknown): string | null {
  return isRecord(sourceRef) ? nonEmptyString(sourceRef.commit) : null;
}

/** GitHub/Gitea/GitLab repo names are case-insensitive, and the same rule `correlation.ts`'s
 *  provenance joins use. */
function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * THE PICK — the MOST RECENT change of the component (newest `created_at`, object-id tiebreak) for
 * whose OWN COMMIT a CI run was observed. For that change, the newest such run is picked. See
 * docs/coordination.md §578.
 *
 * A run is NOT a change (docs/proposals/run-events-are-not-releases.md, owner decision
 * 2026-09-16). A run event is stored in `change_source_events` and proposes nothing, so the run
 * a release's commit went through is found by JOINING on that commit at read time rather than by
 * reading it off a change. Whichever of the push and the run arrived first, the answer is the same.
 *
 * The honesty rules are unchanged: a run counts only when `runIdentityOfSourceRef` holds (a citable
 * run id plus a url or repo), and null means none was found, never a guess. One rule is added, and
 * it is the one a commit join needs. The run's repo must be known and must equal the change's repo,
 * because a commit sha is not unique across repositories (a fork carries its parent's shas).
 */
async function pickObservedRun(
  tx: TenantTx,
  orgId: string,
  componentId: string
): Promise<{
  change: ObservedRunChangeCandidate;
  run: RunIdentity;
  sourceKind: string;
  observedAt: Date;
} | null> {
  const changeRows: ObservedRunChangeCandidate[] = await tx
    .select({
      id: objects.id,
      sourceKind: changes.sourceKind,
      sourceRef: changes.sourceRef,
      createdAt: changes.createdAt
    })
    .from(changes)
    .innerJoin(objects, and(eq(objects.id, changes.objectId), eq(objects.orgId, changes.orgId)))
    .where(
      and(
        eq(changes.orgId, orgId),
        eq(objects.typeId, "change"),
        isNull(objects.deletedAt),
        sql`${objects.properties} @> ${JSON.stringify({ targets: [componentId] })}::jsonb`
      )
    )
    .orderBy(desc(changes.createdAt), desc(changes.objectId))
    .limit(OBSERVED_RUN_SCAN_LIMIT);

  const candidates = changeRows.filter(
    (c) =>
      c.sourceKind !== null &&
      (RUN_SOURCE_KINDS as readonly string[]).includes(c.sourceKind) &&
      commitOfChange(c.sourceRef) !== null &&
      isRecord(c.sourceRef) &&
      nonEmptyString(c.sourceRef.repo) !== null
  );
  if (candidates.length === 0) return null;

  const commits = [...new Set(candidates.map((c) => commitOfChange(c.sourceRef)!))];
  const kinds = [...new Set(candidates.map((c) => c.sourceKind!))];
  const events = await selectEventsByCommit(tx, orgId, kinds, commits);

  for (const change of candidates) {
    const commit = commitOfChange(change.sourceRef)!;
    const changeRepo = nonEmptyString((change.sourceRef as Record<string, unknown>).repo)!;
    for (const event of events) {
      if (event.sourceKind !== change.sourceKind || event.commit !== commit) continue;
      // Read through the SAME canonicalization a change's `sourceRef` was built with, so every
      // writer shape `runIdentityOfSourceRef` traces is read exactly as it always was.
      const view = canonicalizeSourceRef(
        event.payload,
        extractHint(event.sourceKind, event.headers, event.payload)
      );
      const run = runIdentityOfSourceRef(event.sourceKind, view);
      if (!run || !run.repo || !sameRepo(run.repo, changeRepo)) continue;
      return { change, run, sourceKind: event.sourceKind, observedAt: event.createdAt };
    }
  }
  return null;
}

/**
 * `ComponentPipelineResponseSchema.observedRun` — see the module doc and
 * `ComponentPipelineObservedRunSchema`. Null when no change of the component has an observed run
 * for its own commit.
 */
export async function observedRunForComponent(
  tx: TenantTx,
  orgId: string,
  componentId: string
): Promise<ComponentPipelineObservedRun | null> {
  const pick = await pickObservedRun(tx, orgId, componentId);
  if (!pick) return null;
  return {
    sourceKind: pick.sourceKind,
    repo: pick.run.repo,
    runId: pick.run.runId,
    workflowName: pick.run.workflowName,
    workflowPath: pick.run.workflowPath,
    url: pick.run.url,
    // When SCP recorded the RUN EVENT, not the change. See docs/schemas.md for the field.
    observedAt: pick.observedAt.toISOString(),
    // The release whose commit the run was for.
    changeId: pick.change.id
  };
}
