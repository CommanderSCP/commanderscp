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
import {
  findBumpAuthorshipByHeadCommit,
  readBumpAuthorship
} from "../dependencies/bump-authorship-repo.js";

/** Correlation (DESIGN.md §9.2). See docs/coordination.md §373. */
export interface CorrelationHint {
  sourceKind: string;
  repo?: string;
  path?: string;
  /** EVERY path the event touched. See docs/coordination.md §374. */
  paths?: string[];
  /** The event's git REF, fully qualified (`refs/heads/dev`). See docs/coordination.md §375. */
  ref?: string;
}

/** What a source event resolves to: the component, and WHICH of its pipelines the source drives. */
export interface SourceMatch {
  componentObjectId: string;
  /** From the matched mapping (M12 P4A) — the routing Type (ADR-0007). The release itself says which
   *  pipeline it is, rather than being inferred from sourceKind (a GitHub Actions workflow can run
   *  Terraform OR deploy an app). Mappings default to 'configuration' (the server default). */
  type: ExecutorType;
  /** From the matched mapping (ADR-0030 §2). See docs/coordination.md §376. */
  classification: PipelineClassification | null;
}

/** The matching component and its pipeline, or null. See docs/coordination.md §377. */
/** Does `pattern` match the event's location at all. See docs/coordination.md §378. */
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

/** A mapping whose component is soft-deleted must not match. See docs/coordination.md §379. */
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
      asc(sourceMappings.createdAt),
      asc(sourceMappings.id)
    );

  for (const row of rows) {
    // The operator's PAUSE SWITCH (migration 0063). See docs/coordination.md §380.
    if (!row.enabled && (row.disabledUntil === null || row.disabledUntil.getTime() > Date.now()))
      continue;
    if (row.repoPattern && (!hint.repo || !globMatch(row.repoPattern, hint.repo))) continue;
    if (row.pathPattern && !matchesAnyPath(row.pathPattern, hint)) continue;
    // Fail-closed on an unknown ref, the same rule throughout. See docs/coordination.md §381.
    if (row.refPattern && (!hint.ref || !globMatch(row.refPattern, hint.ref))) continue;
    return {
      componentObjectId: row.componentObjectId,
      type: (row.type as ExecutorType | null) ?? "configuration",
      classification: parsePipelineClassification(row.classification)
    };
  }
  return null;
}

/** Links a Change into its CoordinatedChange group. See docs/coordination.md §382. */
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

/** A commit CommanderSCP authored, coming back in. See docs/coordination.md §383. */

/** Restated from `dependencies/bump-actuator.ts` rather than imported, to keep this module free of a
 *  dependency on the dependencies subsystem; `bump-provenance.integration.test.ts` pins the two
 *  against each other, which is where a drift would actually bite. */
export const BUMP_AUTHORED_REF_PREFIX = "refs/heads/scp/dep-bump/";

/** Does this ref name a bump this instance authored. See docs/coordination.md §384. */
export async function matchAuthoredBumpChange(
  tx: TenantTx,
  orgId: string,
  hint: { repo?: string; ref?: string; commitSha?: string }
): Promise<string | null> {
  const ref = hint.ref;
  if (!ref || !ref.startsWith(BUMP_AUTHORED_REF_PREFIX)) {
    return matchAuthoredBumpChangeByHeadCommit(tx, orgId, hint);
  }
  const changeObjectId = ref.slice(BUMP_AUTHORED_REF_PREFIX.length);
  // The remainder must be an object id and nothing more. A ref like
  // `refs/heads/scp/dep-bump/<uuid>/extra` is NOT that change's branch and must not resolve to it.
  if (!/^[0-9a-fA-F-]{36}$/.test(changeObjectId)) return null;

  // SCP's OWN RECORD of what it authored — one primary-key lookup, and a row no tenant-facing write
  // path can create. Absent means SCP did not author a bump for that id, whatever a `source_ref`
  // somewhere claims.
  const authorship = await readBumpAuthorship(tx, orgId, changeObjectId);
  if (!authorship) return null;
  // SCP must have recorded THIS ref. Compared byte-for-byte: a ref is an identifier, and a normalised
  // comparison here would be the place a `refs/heads/x` and a `refs/heads/X` quietly became the same
  // branch on a case-sensitive provider.
  if (authorship.authoredRef !== ref) return null;
  // …and THIS repo. Case-insensitive, because all three providers address repository paths that way
  // — the same rule and the same sentence as `dependencies/manifest-reader.ts`'s
  // `normalizeRepoIdentity`. An event carrying no repo can never satisfy this, which is correct: a
  // record naming a repository is not matched by an event that names none.
  if (!hint.repo) return null;
  if (hint.repo.trim().toLowerCase() !== authorship.repo.trim().toLowerCase()) {
    return null;
  }
  return authorship.changeObjectId;
}

/** THE SECOND ROUTE. See docs/coordination.md §385. */
async function matchAuthoredBumpChangeByHeadCommit(
  tx: TenantTx,
  orgId: string,
  hint: { repo?: string; commitSha?: string }
): Promise<string | null> {
  const commit = hint.commitSha?.trim();
  const repo = hint.repo?.trim();
  if (!commit || !repo) return null;

  // ONE INDEXED LOOKUP, and it has to be. See docs/coordination.md §386.
  const authorship = await findBumpAuthorshipByHeadCommit(tx, orgId, { repo, commit });
  return authorship?.changeObjectId ?? null;
}

/** Restated from the actuator, for the same reason. See docs/coordination.md §387. */
export const BUMP_CHANGE_SOURCE_KIND = "dependency-bump";

/** The event emitted when an observation matches our bump. See docs/coordination.md §388. */
export const BUMP_OBSERVED_EVENT = "scp.dependency.bump_observed";
