import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { TenantTx } from "../db/tenant-tx.js";
import { dependencyBumpAuthorships } from "../db/schema.js";

/** The one place that answers whether we authored this. See docs/dependencies.md §17. */

/** What SCP recorded about a bump it authored. Every field is server-written. */
export interface BumpAuthorship {
  changeObjectId: string;
  componentObjectId: string;
  lineId: string;
  repo: string;
  baseBranch: string;
  authoredRef: string;
  ecosystem: string;
  coordinate: string;
  manifestPath: string;
  fromVersion: string;
  toVersion: string;
  /** The commit SCP's own branch is at. `undefined` until the authored push is observed back. */
  headCommit?: string;
  /** The pull request SCP opened. `undefined` until the authoring run reports one. */
  pullRequestNumber?: number;
  /** That pull request's URL, as the provider returned it. See docs/dependencies.md §18. */
  pullRequestUrl?: string;
  /** When the provider confirmed the merge. `undefined` while the bump is still open. */
  mergedAt?: Date;
}

export interface RecordBumpAuthorshipInput {
  changeObjectId: string;
  componentObjectId: string;
  lineId: string;
  repo: string;
  baseBranch: string;
  authoredRef: string;
  ecosystem: string;
  coordinate: string;
  manifestPath: string;
  fromVersion: string;
  toVersion: string;
}

type Row = typeof dependencyBumpAuthorships.$inferSelect;

function toAuthorship(row: Row): BumpAuthorship {
  return {
    changeObjectId: row.changeObjectId,
    componentObjectId: row.componentObjectId,
    lineId: row.lineId,
    repo: row.repo,
    baseBranch: row.baseBranch,
    authoredRef: row.authoredRef,
    ecosystem: row.ecosystem,
    coordinate: row.coordinate,
    manifestPath: row.manifestPath,
    fromVersion: row.fromVersion,
    toVersion: row.toVersion,
    ...(row.headCommit ? { headCommit: row.headCommit } : {}),
    ...(typeof row.pullRequestNumber === "number"
      ? { pullRequestNumber: row.pullRequestNumber }
      : {}),
    ...(row.pullRequestUrl ? { pullRequestUrl: row.pullRequestUrl } : {}),
    ...(row.mergedAt ? { mergedAt: row.mergedAt } : {})
  };
}

/** Record that SCP is authoring this bump. See docs/dependencies.md §19. */
export async function recordBumpAuthorship(
  tx: TenantTx,
  orgId: string,
  input: RecordBumpAuthorshipInput
): Promise<void> {
  await tx
    .insert(dependencyBumpAuthorships)
    .values({ orgId, ...input })
    .onConflictDoNothing({
      target: [dependencyBumpAuthorships.orgId, dependencyBumpAuthorships.changeObjectId]
    });
}

/** What SCP recorded for this change, or `undefined` — which means SCP did not author it. */
export async function readBumpAuthorship(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string
): Promise<BumpAuthorship | undefined> {
  const rows = await tx
    .select()
    .from(dependencyBumpAuthorships)
    .where(
      and(
        eq(dependencyBumpAuthorships.orgId, orgId),
        eq(dependencyBumpAuthorships.changeObjectId, changeObjectId)
      )
    )
    .limit(1);
  return rows[0] ? toAuthorship(rows[0]) : undefined;
}

/** The open bump already authored for that exact target. See docs/dependencies.md §20. */
export async function findOpenBumpAuthorship(
  tx: TenantTx,
  orgId: string,
  key: {
    componentObjectId: string;
    manifestPath: string;
    coordinate: string;
    toVersion: string;
  }
): Promise<BumpAuthorship | undefined> {
  const rows = await tx
    .select()
    .from(dependencyBumpAuthorships)
    .where(
      and(
        eq(dependencyBumpAuthorships.orgId, orgId),
        eq(dependencyBumpAuthorships.componentObjectId, key.componentObjectId),
        eq(dependencyBumpAuthorships.manifestPath, key.manifestPath),
        eq(dependencyBumpAuthorships.coordinate, key.coordinate),
        eq(dependencyBumpAuthorships.toVersion, key.toVersion),
        sql`${dependencyBumpAuthorships.mergedAt} is null`
      )
    )
    .limit(1);
  return rows[0] ? toAuthorship(rows[0]) : undefined;
}

/** Every OPEN bump SCP authored for one coordinate. See docs/dependencies.md §21. */
export async function listOpenBumpAuthorshipsForCoordinate(
  tx: TenantTx,
  orgId: string,
  key: { ecosystem: string; coordinate: string }
): Promise<BumpAuthorship[]> {
  const rows = await tx
    .select()
    .from(dependencyBumpAuthorships)
    .where(
      and(
        eq(dependencyBumpAuthorships.orgId, orgId),
        eq(dependencyBumpAuthorships.ecosystem, key.ecosystem),
        eq(dependencyBumpAuthorships.coordinate, key.coordinate),
        sql`${dependencyBumpAuthorships.mergedAt} is null`
      )
    )
    .orderBy(dependencyBumpAuthorships.changeObjectId);
  return rows.map(toAuthorship);
}

/** Every bump opened and not yet merged: the work list. See docs/dependencies.md §22. */
export async function listOpenBumpAuthorshipsAwaitingMerge(
  tx: TenantTx,
  orgId: string
): Promise<BumpAuthorship[]> {
  const rows = await tx
    .select()
    .from(dependencyBumpAuthorships)
    .where(
      and(
        eq(dependencyBumpAuthorships.orgId, orgId),
        sql`${dependencyBumpAuthorships.mergedAt} is null`,
        isNotNull(dependencyBumpAuthorships.pullRequestNumber)
      )
    )
    .orderBy(dependencyBumpAuthorships.changeObjectId);
  return rows.map(toAuthorship);
}

/** The bump whose own branch head is that commit. See docs/dependencies.md §23. */
export async function findBumpAuthorshipByHeadCommit(
  tx: TenantTx,
  orgId: string,
  input: { repo: string; commit: string }
): Promise<BumpAuthorship | undefined> {
  const rows = await tx
    .select()
    .from(dependencyBumpAuthorships)
    .where(
      and(
        eq(dependencyBumpAuthorships.orgId, orgId),
        isNotNull(dependencyBumpAuthorships.headCommit),
        sql`lower(${dependencyBumpAuthorships.headCommit}) = lower(${input.commit.trim()})`,
        sql`lower(${dependencyBumpAuthorships.repo}) = lower(${input.repo.trim()})`
      )
    )
    .limit(1);
  return rows[0] ? toAuthorship(rows[0]) : undefined;
}

/** Record which commit SCP's authored branch is now at. See docs/dependencies.md §24. */
export async function recordBumpHeadCommit(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string,
  headCommit: string
): Promise<void> {
  await tx
    .update(dependencyBumpAuthorships)
    .set({ headCommit, updatedAt: new Date() })
    .where(
      and(
        eq(dependencyBumpAuthorships.orgId, orgId),
        eq(dependencyBumpAuthorships.changeObjectId, changeObjectId)
      )
    );
}

/** A provider-supplied URL this table is willing to store. See docs/dependencies.md §25. */
function storableProviderUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 2048) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  return trimmed;
}

/** Record the pull request the authoring run reported opening. See docs/dependencies.md §26. */
export async function recordBumpPullRequest(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string,
  pullRequestNumber: number,
  pullRequestUrl?: unknown
): Promise<void> {
  if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) return;
  const url = storableProviderUrl(pullRequestUrl);
  // Either disjunct guarantees the SET is safe: the first because the row has no number yet, the
  // second because the number it has is the one being written. Without a URL to contribute, the
  // second disjunct would match rows there is nothing to write to, so it is not offered.
  const writable = url
    ? sql`(${dependencyBumpAuthorships.pullRequestNumber} is null or (${dependencyBumpAuthorships.pullRequestNumber} = ${pullRequestNumber} and ${dependencyBumpAuthorships.pullRequestUrl} is null))`
    : sql`${dependencyBumpAuthorships.pullRequestNumber} is null`;
  await tx
    .update(dependencyBumpAuthorships)
    .set({ pullRequestNumber, ...(url ? { pullRequestUrl: url } : {}), updatedAt: new Date() })
    .where(
      and(
        eq(dependencyBumpAuthorships.orgId, orgId),
        eq(dependencyBumpAuthorships.changeObjectId, changeObjectId),
        writable
      )
    );
}

/** Record that the provider confirmed the merge. See docs/dependencies.md §27. */
export async function markBumpMerged(
  tx: TenantTx,
  orgId: string,
  changeObjectId: string,
  mergedAt: Date = new Date()
): Promise<void> {
  await tx
    .update(dependencyBumpAuthorships)
    .set({ mergedAt, updatedAt: new Date() })
    .where(
      and(
        eq(dependencyBumpAuthorships.orgId, orgId),
        eq(dependencyBumpAuthorships.changeObjectId, changeObjectId),
        sql`${dependencyBumpAuthorships.mergedAt} is null`
      )
    );
}

/** One page of {@link listBumpAuthorshipsByComponent}. `createdAt` is carried because it is the
 *  page's ordering key ("dispatched at") and the READ surface projects it. */
export interface BumpAuthorshipListItem extends BumpAuthorship {
  createdAt: Date;
}

/** THE READ SURFACE'S DOOR. See docs/dependencies.md §28. */
export async function listBumpAuthorshipsByComponent(
  tx: TenantTx,
  orgId: string,
  componentObjectId: string,
  page: { limit: number; cursor?: { createdAt: Date; id: string } | null }
): Promise<{ items: BumpAuthorshipListItem[]; hasMore: boolean }> {
  const conditions = [
    eq(dependencyBumpAuthorships.orgId, orgId),
    eq(dependencyBumpAuthorships.componentObjectId, componentObjectId)
  ];
  if (page.cursor) {
    conditions.push(
      sql`(date_trunc('milliseconds', ${dependencyBumpAuthorships.createdAt}), ${dependencyBumpAuthorships.changeObjectId}) < (${page.cursor.createdAt.toISOString()}::timestamptz, ${page.cursor.id}::uuid)`
    );
  }
  const rows = await tx
    .select()
    .from(dependencyBumpAuthorships)
    .where(and(...conditions))
    .orderBy(
      sql`date_trunc('milliseconds', ${dependencyBumpAuthorships.createdAt}) desc`,
      desc(dependencyBumpAuthorships.changeObjectId)
    )
    .limit(page.limit + 1);
  const hasMore = rows.length > page.limit;
  const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
  return {
    items: pageRows.map((row) => ({ ...toAuthorship(row), createdAt: row.createdAt })),
    hasMore
  };
}
