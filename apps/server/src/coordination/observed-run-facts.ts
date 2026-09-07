import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { ComponentPipelineObservedRun } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { changes, objects } from "../db/schema.js";

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

/** THE PICK — the MOST RECENT change of the component. See docs/coordination.md §578. */
async function pickObservedRunChange(
  tx: TenantTx,
  orgId: string,
  componentId: string
): Promise<{ candidate: ObservedRunChangeCandidate; run: RunIdentity } | null> {
  const rows = await tx
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

  for (const row of rows) {
    const run = runIdentityOfSourceRef(row.sourceKind, row.sourceRef);
    if (run) return { candidate: row, run };
  }
  return null;
}

/**
 * `ComponentPipelineResponseSchema.observedRun` — see the module doc and
 * `ComponentPipelineObservedRunSchema`. Null when no change of the component carries run identity.
 */
export async function observedRunForComponent(
  tx: TenantTx,
  orgId: string,
  componentId: string
): Promise<ComponentPipelineObservedRun | null> {
  const pick = await pickObservedRunChange(tx, orgId, componentId);
  if (!pick) return null;
  return {
    // `pick.run` is only ever produced for sourceKind "github"/"gitea"/"gitlab" (see
    // `runIdentityOfSourceRef`), so `pick.candidate.sourceKind` is one of those three here by
    // construction; the fallback is defensive only, never expected to fire.
    sourceKind: pick.candidate.sourceKind ?? "unknown",
    repo: pick.run.repo,
    runId: pick.run.runId,
    workflowName: pick.run.workflowName,
    workflowPath: pick.run.workflowPath,
    url: pick.run.url,
    observedAt: pick.candidate.createdAt.toISOString(),
    changeId: pick.candidate.id
  };
}
