import { and, asc, eq, sql } from "drizzle-orm";
import type { ExecutorType } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { sourceMappings } from "../db/schema.js";
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
}

/** What a source event resolves to: the component, and WHICH of its pipelines the source drives. */
export interface SourceMatch {
  componentObjectId: string;
  /** From the matched mapping (M12 P4A) — the routing Type (ADR-0007). The release itself says which
   *  pipeline it is, rather than being inferred from sourceKind (a GitHub Actions workflow can run
   *  Terraform OR deploy an app). Mappings default to 'configuration' (the server default). */
  type: ExecutorType;
}

/**
 * Returns the matching component + its pipeline, or `null` if no `source_mappings` row matches.
 * More than one row can match one event, so the order below is the whole contract of this function.
 *
 * PRECEDENCE — most-constrained first, oldest first to break ties:
 *
 *   1. MOST CONSTRAINED WINS. A mapping is ranked by how many of its two globs it actually sets:
 *      repo+path (2) beats one of them (1) beats a catch-all that sets neither (0). Both patterns
 *      are NULLABLE and the matcher SKIPS a null one, so a catch-all matches EVERY event of its
 *      sourceKind and therefore overlaps with every specific mapping beside it — "catch-all plus a
 *      specific override" is a normal operator setup, and this rank is what makes the override
 *      actually override rather than race the fallback.
 *   2. OLDEST WINS (created_at, then id — the primary key, so the order is TOTAL and no two rows
 *      can tie). Deliberately oldest and not newest: an established mapping keeps its releases when
 *      someone later adds an equally-constrained one. A new ambiguous mapping then visibly never
 *      fires, instead of silently stealing another component's pipeline.
 *
 * Two things this rank deliberately does NOT do, because an operator will otherwise assume they
 * happen (both fall through to rule 2, oldest-wins):
 *   - It does not rank repo-only above path-only, or vice versa. They are equally constrained and
 *     there is no principled reason to prefer either.
 *   - It does not compare glob against glob. `acme/app` and `acme/*` are BOTH rank 1; the exact
 *     pattern does not beat the wildcard one.
 * If either matters to an operator, the fix is a mapping that sets both patterns (rank 2), not a
 * cleverer ranking here.
 *
 * Ordered in SQL rather than sorted in TS so that the precedence cannot be lost by a caller
 * re-querying, and by existing columns rather than a new `priority` column: ordering the data we
 * already have is enough (CLAUDE.md priority 1, Simplicity).
 *
 * Before M12 P4A an ambiguous match only picked WHICH COMPONENT; since P4A the winning row also
 * carries the routing `type` (ADR-0007), so it picks WHICH PIPELINE — an unordered match could route
 * a release into the wrong pipeline depending on the query plan.
 */
export async function matchComponentForSource(
  tx: TenantTx,
  orgId: string,
  hint: CorrelationHint
): Promise<SourceMatch | null> {
  const rows = await tx
    .select()
    .from(sourceMappings)
    .where(and(eq(sourceMappings.orgId, orgId), eq(sourceMappings.sourceKind, hint.sourceKind)))
    .orderBy(
      sql`(case when ${sourceMappings.repoPattern} is not null then 1 else 0 end
           + case when ${sourceMappings.pathPattern} is not null then 1 else 0 end) desc`,
      asc(sourceMappings.createdAt),
      asc(sourceMappings.id)
    );

  for (const row of rows) {
    if (row.repoPattern && (!hint.repo || !globMatch(row.repoPattern, hint.repo))) continue;
    if (row.pathPattern && (!hint.path || !globMatch(row.pathPattern, hint.path))) continue;
    return {
      componentObjectId: row.componentObjectId,
      type: (row.type as ExecutorType | null) ?? "configuration"
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
