import { and, asc, eq, exists, isNull, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  parsePipelineClassification,
  type ExecutorType,
  type PipelineClassification
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects, sourceMappings } from "../db/schema.js";
import { globMatch } from "./glob-match.js";
import { createObject } from "../graph/objects-repo.js";
import { createRelationship } from "../graph/relationships-repo.js";

/**
 * Correlation (DESIGN.md §9.2): "Executor events carry correlation hints — repo + path patterns,
 * commit SHA, artifact digest, labels, explicit correlation key — matched against
 * `source_mappings` rows (repo/path pattern -> component)."
 */
export interface CorrelationHint {
  sourceKind: string;
  repo?: string;
  path?: string;
  /**
   * EVERY path the event touched. A `pathPattern` matches when it matches `path` **or any entry
   * here**, so this is what lets one repository route to per-directory components.
   *
   * Why it exists as a separate field rather than replacing `path`: `path` is a singular *location*
   * some providers carry natively (a release's target commitish, a package path), and it predates
   * this. A commit is not a location — it touches many files — so it could never be expressed in
   * the singular field. Until a provider populated this, every `pathPattern` mapping was skipped
   * by the guard below, which meant a repo-only mapping set on a monorepo collapsed to exactly ONE
   * live route (most-constrained, then oldest) while every other mapping on that repo silently
   * never fired.
   */
  paths?: string[];
  /**
   * The event's git REF, fully qualified (`refs/heads/dev`) — what a `refPattern` mapping matches
   * against (migration 0057, ADR-0030 §1). This is what makes "the dev branch drives the dev
   * pipeline" expressible: before it, a push to `dev` and a push to `main` in the same repository
   * correlated to the same component AND the same routing Type.
   *
   * The value was already being carried and already being thrown away for routing purposes — git
   * provider adapters set it as `correlationKey` (`refs/heads/<branch>`), which is read downstream
   * only to GROUP changes onto a `coordinated-change` object, never to select the mapping.
   *
   * **Left undefined by sources that have no ref**, which is most non-git ones: a registry/package
   * push (harbor `PUSH_ARTIFACT`, gitea `package`) carries no branch. Those events therefore never
   * match a ref-scoped mapping — correct, and fail-closed by the same rule as `paths` below.
   */
  ref?: string;
}

/** What a source event resolves to: the component, and WHICH of its pipelines the source drives. */
export interface SourceMatch {
  componentObjectId: string;
  /** From the matched mapping (M12 P4A) — the routing Type (ADR-0007). The release itself says which
   *  pipeline it is, rather than being inferred from sourceKind (a GitHub Actions workflow can run
   *  Terraform OR deploy an app). Mappings default to 'configuration' (the server default). */
  type: ExecutorType;
  /** From the matched mapping (ADR-0030 §2) — the operator's DECLARED classification of this
   *  pipeline (`dev`|`beta`), or `null` for an ordinary one. READ from the winning row; never
   *  inferred from the branch name, which goes false as soon as that branch drives a second kind.
   *
   *  **UI/reporting only.** Nothing downstream may gate on this: enforcement keys on the path, and
   *  forging or removing it changes no gate outcome (ADR-0030 §3, ADR-0018 §4). */
  classification: PipelineClassification | null;
}

/**
 * Returns the matching component + its pipeline, or `null` if no `source_mappings` row matches.
 * More than one row can match one event, so the order below is the whole contract of this function.
 *
 * PRECEDENCE — most-constrained first, most-specific next, oldest last to break what remains:
 *
 *   1. MOST CONSTRAINED WINS. A mapping is ranked by how many of its THREE globs it actually sets:
 *      repo+path+ref (3) beats two (2) beats one (1) beats a catch-all that sets none (0). All three
 *      patterns are NULLABLE and the matcher SKIPS a null one, so a catch-all matches EVERY event of
 *      its sourceKind and therefore overlaps with every specific mapping beside it — "catch-all plus
 *      a specific override" is a normal operator setup, and this rank is what makes the override
 *      actually override rather than race the fallback.
 *   2. MOST SPECIFIC GLOB WINS (owner decision, 2026-08-02 — this rank previously did NOT exist and
 *      its absence is what made rule 3 load-bearing; see below). Two sub-keys, in order:
 *        a. NARROWEST WILDCARD. Per pattern: no wildcard (3) beats `*` (2) beats `**` (1) beats
 *           unset (0), summed across repo, path and ref. `*` outranks `**` because `*` cannot cross
 *           a `/` and therefore matches strictly less.
 *        b. MOST LITERAL TEXT. The count of non-wildcard characters, summed across all three patterns.
 *           This is what separates two patterns of the same shape: `alloy/manifests/**` beats
 *           `alloy/**` for `alloy/manifests/x.yaml`, which (a) alone cannot express since both are
 *           `**` patterns.
 *   3. OLDEST WINS (created_at, then id — the primary key, so the order is TOTAL and no two rows
 *      can tie). Deliberately oldest and not newest: an established mapping keeps its releases when
 *      someone later adds an equally-specific one. A new ambiguous mapping then visibly never
 *      fires, instead of silently stealing another component's pipeline.
 *
 * WHY RULE 2 WAS ADDED. Until 2026-08-02 this function deliberately did not compare glob against
 * glob, on the reasoning that an operator who needs an override should set both patterns. A real
 * estate showed the gap: a GitOps monorepo's app-of-apps legitimately claims `bootstrap/**` while
 * each child application claims its own `bootstrap/<name>-app.yaml`. Both set exactly one pattern,
 * so both were rank 1 and the winner fell to CREATION ORDER — which meant 89 mappings routed
 * correctly only because they happened to be created in the right sequence, an ordering that is
 * invisible in the data and that the next mapping someone adds would silently violate. Making
 * specificity explicit removes the trap; it does not remove rule 3, which still settles genuine ties.
 *
 * One thing this rank still deliberately does NOT do: it does not rank repo-only above path-only
 * above ref-only, or any other ordering among them. They are equally constrained and there is no
 * principled reason to prefer one axis, so `(a)` and `(b)` sum all three sides symmetrically rather
 * than ordering them. Note what this costs, because it is the widened version of the trap rule 2 was
 * added to close: repo-only and ref-only mappings on the same repository tie on rules 1 and 2 unless
 * their wildcards or literal lengths differ, and fall through to rule 3 (oldest). An operator who
 * wants a ref-scoped mapping to override a repo-scoped one must therefore set the ref pattern ON the
 * more specific mapping (repo+ref, rank 2) rather than relying on ref-only to outrank repo-only —
 * exactly the "set both patterns" discipline the pre-2026-08-02 design assumed and that rule 2 only
 * partially relieved.
 *
 * Ordered in SQL rather than sorted in TS so that the precedence cannot be lost by a caller
 * re-querying, and by existing columns rather than a new `priority` column: ordering the data we
 * already have is enough (CLAUDE.md priority 1, Simplicity).
 *
 * Before M12 P4A an ambiguous match only picked WHICH COMPONENT; since P4A the winning row also
 * carries the routing `type` (ADR-0007), so it picks WHICH PIPELINE — an unordered match could route
 * a release into the wrong pipeline depending on the query plan.
 */
/**
 * Does `pattern` match the event's location at all — the singular `path`, or ANY member of `paths`?
 *
 * The `||` order is deliberate and not an optimisation: `path` is checked first so a provider that
 * sets only the singular field behaves exactly as it did before `paths` existed.
 *
 * **An event with no path information at all still fails this**, which is the pre-existing
 * fail-closed behaviour and is load-bearing: a path-scoped mapping must never match an event whose
 * changed set is unknown, or it would claim releases it cannot prove are its own. The practical
 * consequence is worth stating, because it is a silent degradation rather than an error — when a
 * provider cannot determine paths (a truncated commit-file list, a poll past its fetch budget, a
 * provider that carries none), path-scoped mappings are skipped and the event falls through to
 * whatever repo-only mapping wins. It routes, but by repository rather than by directory.
 */
function matchesAnyPath(pattern: string, hint: CorrelationHint): boolean {
  if (hint.path && globMatch(pattern, hint.path)) return true;
  return (hint.paths ?? []).some((candidate) => globMatch(pattern, candidate));
}

/** Rule 2a: how NARROW a pattern's widest wildcard is — exact 3, `*` 2, `**` 1, unset 0. */
function wildcardTier(column: AnyPgColumn) {
  return sql`(case
    when ${column} is null or ${column} = '' then 0
    when ${column} like '%**%' then 1
    when ${column} like '%*%' then 2
    else 3 end)`;
}

/** Rule 2b: how much LITERAL text a pattern pins, wildcards removed. */
function literalLength(column: AnyPgColumn) {
  return sql`length(replace(replace(coalesce(${column}, ''), '**', ''), '*', ''))`;
}

/**
 * A mapping whose COMPONENT has been soft-deleted must not match.
 *
 * `source_mappings` has no `deleted_at` of its own and no foreign key to `objects`, so the row
 * outlives its component unless a query excludes it — the SAME shape, and the same sentence, as
 * `executor-bindings-repo.ts`'s `targetObjectIsLive` (M12 P5c). That one was fixed; this one was
 * not, which is the incomplete-call-site pattern BUILD_AND_TEST.md §4.4 exists for.
 *
 * WHAT IT COSTS TO OMIT — and it is not a stale row, it is a SILENT FAKE SUCCESS:
 *   push -> `matchComponentForSource` returns the DEAD component
 *        -> a change is proposed against it
 *        -> its wave target is a deleted object
 *        -> `listVisibleBindingsForTarget` correctly reports zero (the bindings repo already
 *           excludes a dead target)
 *        -> `reconcile.ts` reads zero bindings as ADR-0006 case (a), "intended-fake"
 *        -> the wave target FAKE-SUCCEEDS. Green release, nothing deployed.
 *
 * Measured on the live homelab 2026-08-02: FIVE mappings pointed at components soft-deleted that
 * same day by the ADR-0026 §6 pair merges, on repo patterns as broad as `AgentKitProject/agentkit`
 * with no path pattern. Every remaining pair merge creates more, so this compounds.
 */
function componentIsLive(tx: TenantTx, orgId: string) {
  return exists(
    tx
      .select({ one: sql`1` })
      .from(objects)
      .where(
        and(
          eq(objects.id, sourceMappings.componentObjectId),
          eq(objects.orgId, orgId),
          isNull(objects.deletedAt)
        )
      )
  );
}

export async function matchComponentForSource(
  tx: TenantTx,
  orgId: string,
  hint: CorrelationHint
): Promise<SourceMatch | null> {
  const rows = await tx
    .select()
    .from(sourceMappings)
    .where(
      and(
        eq(sourceMappings.orgId, orgId),
        eq(sourceMappings.sourceKind, hint.sourceKind),
        componentIsLive(tx, orgId)
      )
    )
    .orderBy(
      // Rule 1 — how many globs are set at all.
      sql`(case when ${sourceMappings.repoPattern} is not null then 1 else 0 end
           + case when ${sourceMappings.pathPattern} is not null then 1 else 0 end
           + case when ${sourceMappings.refPattern} is not null then 1 else 0 end) desc`,
      // Rule 2a — narrowest wildcard: exact (3) > `*` (2) > `**` (1) > unset (0). Order matters
      // inside each CASE: `**` must be tested BEFORE `*`, since a `**` pattern also contains `*`.
      sql`(${wildcardTier(sourceMappings.repoPattern)} + ${wildcardTier(sourceMappings.pathPattern)}
           + ${wildcardTier(sourceMappings.refPattern)}) desc`,
      // Rule 2b — most literal text, which separates same-shaped patterns (`alloy/manifests/**`
      // over `alloy/**`). Wildcards are stripped rather than counted so a longer pattern does not
      // win merely by having more `*` in it.
      sql`(${literalLength(sourceMappings.repoPattern)} + ${literalLength(sourceMappings.pathPattern)}
           + ${literalLength(sourceMappings.refPattern)}) desc`,
      // Rule 3 — the total, stable tiebreak.
      asc(sourceMappings.createdAt),
      asc(sourceMappings.id)
    );

  for (const row of rows) {
    if (row.repoPattern && (!hint.repo || !globMatch(row.repoPattern, hint.repo))) continue;
    if (row.pathPattern && !matchesAnyPath(row.pathPattern, hint)) continue;
    // FAIL-CLOSED on an unknown ref, the same rule as `repoPattern` above and `matchesAnyPath`
    // below it: a ref-scoped mapping must never claim a release whose ref it cannot prove. The
    // practical consequence is a silent skip rather than an error — a source that carries no ref
    // (a registry/package push) falls through to whatever non-ref-scoped mapping wins, routing by
    // repository rather than by branch.
    if (row.refPattern && (!hint.ref || !globMatch(row.refPattern, hint.ref))) continue;
    return {
      componentObjectId: row.componentObjectId,
      type: (row.type as ExecutorType | null) ?? "configuration",
      classification: parsePipelineClassification(row.classification)
    };
  }
  return null;
}

/**
 * Links a Change into its CoordinatedChange group (DESIGN §9.2: "Matching changes are linked
 * into a CoordinatedChange group object via `correlates` relationships") — finds an existing
 * `coordinated-change` object whose `labels.correlationKey` matches, or creates one, then adds
 * the `correlates` edge from the change to it. Idempotent: re-running with the same
 * `changeObjectId`/`correlationKey` is a no-op the second time (relationship creation is already
 * idempotent via the `(org_id, type_id, from_id, to_id)` unique constraint —
 * `graph/relationships-repo.ts` maps that to a 409, which callers should treat as "already
 * linked" rather than an error; see `coordination/webhook-processor.ts`).
 */
export async function linkToCoordinatedChange(
  tx: TenantTx,
  input: {
    orgId: string;
    changeObjectId: string;
    correlationKey: string;
    actorObjectId: string;
    requestId: string;
  }
): Promise<string> {
  const existing = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(
        eqOp(t.orgId, input.orgId),
        eqOp(t.typeId, "coordinated-change"),
        isNullOp(t.deletedAt),
        sql`${t.labels} ->> 'correlationKey' = ${input.correlationKey}`
      )
  });

  const groupId = existing
    ? existing.id
    : (
        await createObject(tx, {
          orgId: input.orgId,
          typeId: "coordinated-change",
          actorObjectId: input.actorObjectId,
          requestId: input.requestId,
          name: `Coordinated: ${input.correlationKey}`,
          labels: { correlationKey: input.correlationKey }
        })
      ).id;

  await createRelationship(tx, {
    orgId: input.orgId,
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    typeId: "correlates",
    fromId: input.changeObjectId,
    toId: groupId
  });

  return groupId;
}
