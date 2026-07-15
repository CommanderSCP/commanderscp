import { and, eq, sql } from "drizzle-orm";
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
  /** From the matched mapping (M12 P4A). The infra repo maps to 'infra', the app repo to 'software' —
   *  the release itself says which pipeline it is, rather than being inferred from sourceKind (a
   *  GitHub Actions workflow can run Terraform OR deploy an app). Pre-P4A mappings default to
   *  'software', so every existing mapping resolves exactly what it resolved before. */
  purpose: "infra" | "software";
}

/** Returns the first matching component + its pipeline, or `null` if no `source_mappings` row matches. */
export async function matchComponentForSource(
  tx: TenantTx,
  orgId: string,
  hint: CorrelationHint
): Promise<SourceMatch | null> {
  const rows = await tx
    .select()
    .from(sourceMappings)
    .where(and(eq(sourceMappings.orgId, orgId), eq(sourceMappings.sourceKind, hint.sourceKind)));

  for (const row of rows) {
    if (row.repoPattern && (!hint.repo || !globMatch(row.repoPattern, hint.repo))) continue;
    if (row.pathPattern && (!hint.path || !globMatch(row.pathPattern, hint.path))) continue;
    return {
      componentObjectId: row.componentObjectId,
      purpose: (row.purpose as "infra" | "software" | null) ?? "software"
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
