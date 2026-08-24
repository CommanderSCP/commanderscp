import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { ComponentPipelineObservedRun } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { changes, objects } from "../db/schema.js";

/**
 * THE `observedRun` FIELD OF A COMPONENT'S PIPELINE (component-journey-view.md §3 Segment 2 —
 * "upstream build"): "no binding: draw a single 'built upstream' marker carrying what SCP *did*
 * observe … it reads 'GitHub Actions · CI · run 30858160395 ↗', not 'build: unknown'." Nothing reads
 * the run fields out of `changes.source_ref` anywhere else in the tree; this module is the one place
 * that does.
 *
 * ## The writer shapes this module traces (every one, before coding)
 *
 * `changes.source_ref` is either hand-set through `POST /changes` (untyped, whatever the caller
 * sends) or minted by `coordination/webhook-processor.ts#canonicalizeSourceRef`, which starts from
 * the RAW delivery payload kept VERBATIM (DESIGN §8) and layers a few canonical keys on top
 * (`repo`/`ref`/`commit`/`artifact_digest`/`sbom` — never a run id/url/name/path). "Raw" itself
 * differs by how the event arrived:
 *
 *   - **OBSERVED (poll)** — `coordination/observe.ts#ingestObservedEvents` persists
 *     `{repo, path, ref, commitSha, kind: ev.kind, observedAt, _observed: true, raw: ev.raw, ...}` as
 *     the delivery `payload`; `canonicalizeSourceRef` spreads that WHOLE object onto `sourceRef`
 *     verbatim. So a polled event's run object sits NESTED under `sourceRef.raw`, discriminated by
 *     `sourceRef.kind === "workflow_run"` (the event kind `pollRuns()` emits) — `sourceRef._observed`
 *     is checked alongside it as a belt-and-suspenders marker no real provider payload sets.
 *     `ev.raw` is:
 *       - **github** (`packages/plugins/github/src/index.ts#pollRuns`) — the FULL GitHub
 *         "list workflow runs" API run object: `id`, `name`, `html_url`, `path`, `head_sha`,
 *         `workflow_id`, `repository.full_name`, … (only `id`/`status`/`conclusion`/`html_url`/
 *         `head_sha`/`created_at`/`workflow_id` are typed locally as `WorkflowRun`, but the object at
 *         runtime carries the rest — `name`/`path` are read here too).
 *       - **gitea** (`packages/plugins/gitea/src/index.ts#pollRuns`) — `GiteaActionRun`, whose own
 *         doc comment names ONLY `id`/`status`/`head_sha`/`html_url`/`created_at` as load-bearing
 *         ("the EXACT field set is version-dependent"). No workflow name/path is cited, so those stay
 *         null for gitea rather than guessed.
 *       - **gitlab** (`packages/plugins/gitlab/src/index.ts#pollRuns`) — `GitlabPipeline`, whose doc
 *         comment cites ONLY `id`/`status`/`sha`/`ref`/`web_url`. A pipeline has no workflow name or
 *         path at all.
 *
 *   - **WEBHOOK (github only)** — `route.body` (the FULL provider delivery) becomes `sourceRef`
 *     verbatim, so a `workflow_run` GitHub webhook's run object sits NESTED at
 *     `sourceRef.workflow_run` (GitHub's own envelope: `{action, workflow_run: {...}, repository,
 *     sender}` — see `mapGithubWebhookEventToHint`'s `case "workflow_run"`). Read with the SAME
 *     field set as the observed github shape (both are the identical GitHub run object, just nested
 *     one level differently).
 *     Gitea's webhook adapter (`giteaAdapter.mapEvent`) maps only push/pull_request/release/package
 *     — no run-completion event — so a gitea WEBHOOK delivery never carries run identity; only its
 *     OBSERVED shape does.
 *     GitLab's "Pipeline Hook" webhook nests `id`/`sha`/`ref` under `sourceRef.object_attributes`
 *     (`mapGitlabWebhookEventToHint`'s `case "Pipeline Hook"` cites exactly those three keys — no
 *     url). Requiring all three together (not `id` alone) matters: a GitLab "Merge Request Hook"
 *     delivery ALSO nests a real `object_attributes.id` (the MR's own internal id, a genuine GitLab
 *     field, not a pipeline id) but carries no sibling `sha`/`ref` there — reading `id` alone would
 *     misread an MR webhook as a pipeline run.
 *
 * A change proposed directly through `POST /changes` with a hand-crafted `sourceRef` that happens to
 * match one of these shapes is read exactly the same way (nothing here distinguishes how a change
 * arrived) — which is also how the HTTP-layer test drives this without needing the whole webhook
 * pipeline standing up.
 *
 * Every reader below is defensive: a key that is absent, the wrong type, or empty yields `null`
 * fields, never a thrown error and never a fabricated value.
 */

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

/**
 * THE PREDICATE ("a change's `sourceRef` carries run identity") applied to ONE change's
 * `(sourceKind, sourceRef)` — see the module doc for every shape traced. Returns the identity when
 * the predicate holds: a citable run id AND at least one of `url`/`repo` (a bare run id names a
 * number nobody could act on or place, so it alone does not count). Exported for unit testing.
 */
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

/** Bounded newest-first scan size — same shape as `artifact-facts.ts#pickArtifactChange`'s fallback
 *  page: the predicate spans three providers' writer shapes and cannot be expressed as one portable
 *  SQL prefilter, so a page of candidates is read and reduced in JS. component-journey-view.md §1
 *  measured 336 of 343 changes on the estate as carrying run identity, so this is not a starvation
 *  risk in practice. */
const OBSERVED_RUN_SCAN_LIMIT = 50;

/**
 * THE PICK — the MOST RECENT change of the component (newest `created_at`, object-id tiebreak, the
 * same deterministic ordering `artifact-facts.ts` uses) whose `sourceRef` carries run identity. Null
 * when none of the scanned page does.
 */
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
