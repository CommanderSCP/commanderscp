import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  ComponentDependencyBump,
  ComponentDependencyIngestionGate,
  ComponentDependencyInventoryRow,
  ComponentDependencyLastIngestionDecision,
  DependencySubscriptionDelivery
} from "@scp/schemas";
import { DependencySubscriptionDeliverySchema } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { componentDependencies, decisions } from "../db/schema.js";
import { latestDecisionForSubjectKind } from "../coordination/decisions-repo.js";
import { CURSOR_UUID_RE, decodeCursor, encodeCursor } from "../pagination.js";
import { listBumpAuthorshipsByComponent } from "./bump-authorship-repo.js";
import { DEPENDENCY_BUMP_DECISION_KIND } from "./bump-dispatch.js";
import { DEPENDENCY_BUMP_MERGE_DECISION_KIND } from "./bump-gate.js";
import {
  listDependencyLineProducersForKeys,
  listDependencyLinesByIds
} from "./dependency-inventory-repo.js";
import { DEPENDENCY_INVENTORY_DECISION_KIND } from "./inventory-ingestion.js";
import { namesForObjectIds } from "./producer-declaration.js";
import {
  mergeComponentIngestionGate,
  resolveDeclaredComponentLines
} from "./subscription-resolution.js";

/** The read surface over the inventory and bump history. See docs/dependencies.md §204. */

/** The inventory page cursor. See docs/dependencies.md §205. */
function encodeInventoryCursor(row: { lineId: string; manifestPath: string }): string {
  return Buffer.from(
    JSON.stringify({ lineId: row.lineId, manifestPath: row.manifestPath })
  ).toString("base64url");
}

/** `null` (= the first page) for anything that is not a well-formed cursor — including a `lineId`
 *  that is not a uuid, which would otherwise reach `::uuid` and answer 500 to a client error. */
export function decodeInventoryCursor(
  cursor: string
): { lineId: string; manifestPath: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).lineId === "string" &&
      typeof (parsed as Record<string, unknown>).manifestPath === "string"
    ) {
      const p = parsed as { lineId: string; manifestPath: string };
      if (!CURSOR_UUID_RE.test(p.lineId)) return null;
      return { lineId: p.lineId, manifestPath: p.manifestPath };
    }
    return null;
  } catch {
    return null;
  }
}

/** A string array read leniently out of a Decision's jsonb — anything that is not an array of
 *  strings reads as `[]`, because a projection of an explanation must never itself throw. */
function stringArrayOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** The newest ingestion Decision about this component. See docs/dependencies.md §206. */
export async function readLastIngestionDecision(
  tx: TenantTx,
  orgId: string,
  componentObjectId: string
): Promise<ComponentDependencyLastIngestionDecision | null> {
  const decision = await latestDecisionForSubjectKind(
    tx,
    orgId,
    componentObjectId,
    DEPENDENCY_INVENTORY_DECISION_KIND
  );
  if (!decision) return null;
  const skippedRaw = (decision.reasonTree as Record<string, unknown>).skipped;
  const skipped: { path: string; reason: string }[] = [];
  if (Array.isArray(skippedRaw)) {
    for (const entry of skippedRaw) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).path === "string" &&
        typeof (entry as Record<string, unknown>).reason === "string"
      ) {
        const e = entry as { path: string; reason: string };
        skipped.push({ path: e.path, reason: e.reason });
      }
    }
  }
  return {
    decisionId: decision.id,
    firstObservedAt: decision.createdAt,
    manifestPathsRead: stringArrayOf(decision.inputContext.manifestPathsRead),
    manifestPathsAbsent: stringArrayOf(decision.inputContext.manifestPathsAbsent),
    skipped
  };
}

export interface ReadComponentDependencyInventoryInput {
  orgId: string;
  componentObjectId: string;
  /** The acting subject — the requesting principal. See the module doc. */
  actorObjectId: string;
  limit: number;
  cursor?: string | undefined;
}

export interface ComponentDependencyInventoryPage {
  componentGate: ComponentDependencyIngestionGate;
  lastIngestionDecision: ComponentDependencyLastIngestionDecision | null;
  rows: ComponentDependencyInventoryRow[];
  nextCursor: string | null;
}

/**
 * One page of a component's inventory, hydrated. See the module doc for the two properties this
 * function is the guardian of (no second AND; the actor is the caller).
 */
export async function readComponentDependencyInventory(
  tx: TenantTx,
  input: ReadComponentDependencyInventoryInput
): Promise<ComponentDependencyInventoryPage> {
  const cursor = input.cursor ? decodeInventoryCursor(input.cursor) : null;
  const conditions = [
    eq(componentDependencies.orgId, input.orgId),
    eq(componentDependencies.componentObjectId, input.componentObjectId)
  ];
  if (cursor) {
    conditions.push(
      sql`(${componentDependencies.lineId}, ${componentDependencies.manifestPath}) > (${cursor.lineId}::uuid, ${cursor.manifestPath})`
    );
  }
  const declarationRows = await tx
    .select()
    .from(componentDependencies)
    .where(and(...conditions))
    .orderBy(asc(componentDependencies.lineId), asc(componentDependencies.manifestPath))
    .limit(input.limit + 1);
  const hasMore = declarationRows.length > input.limit;
  const page = hasMore ? declarationRows.slice(0, input.limit) : declarationRows;

  // THE ONE RESOLUTION CORE, asked for EVERY declared line of this component (disabled included):
  // one unlock read + one candidate gather, the same function the work-list projects from. The
  // gate is merged from the instance and candidates that very call returned — no second gather.
  const resolved = await resolveDeclaredComponentLines(tx, input.orgId, {
    actorObjectId: input.actorObjectId,
    componentObjectIds: [input.componentObjectId],
    includeDisabled: true
  });
  const resolutionByLineId = new Map(resolved.pairs.map((p) => [p.lineId, p.resolution]));
  const gate = mergeComponentIngestionGate({
    instance: resolved.instance,
    candidates: resolved.candidatesByComponent.get(input.componentObjectId) ?? []
  });

  const lineIds = [...new Set(page.map((r) => r.lineId))];
  const lines = await listDependencyLinesByIds(tx, input.orgId, lineIds);
  const lineById = new Map(lines.map((l) => [l.id, l]));

  // The declared producers, in one batched lookup. See docs/dependencies.md §207.
  const producers = await listDependencyLineProducersForKeys(
    tx,
    input.orgId,
    lines.map((l) => ({ ecosystem: l.ecosystem, coordinate: l.coordinate }))
  );
  const producerByKey = new Map(producers.map((p) => [`${p.ecosystem} ${p.coordinate}`, p]));
  const producerIds = [...new Set(producers.map((p) => p.producerObjectId))];
  const producerNameById = await namesForObjectIds(tx, input.orgId, producerIds);

  const rows: ComponentDependencyInventoryRow[] = [];
  for (const declaration of page) {
    const line = lineById.get(declaration.lineId);
    const subscription = resolutionByLineId.get(declaration.lineId);
    // A declaration whose line is gone cannot exist (composite FK), and every declared line was
    // resolved above (same table, same transaction) — but a projection that threw on the impossible
    // would make an unrelated row un-listable. Skip and move on.
    if (!line || !subscription) continue;
    const producer = producerByKey.get(`${line.ecosystem} ${line.coordinate}`) ?? null;
    rows.push({
      line: {
        id: line.id,
        ecosystem: line.ecosystem,
        coordinate: line.coordinate,
        major: line.major,
        tagPattern: line.tagPattern
      },
      manifestPath: declaration.manifestPath,
      declaredVersion: declaration.declaredVersion,
      resolvedVersion: declaration.resolvedVersion,
      resolvedDigest: declaration.resolvedDigest,
      observedRepo: declaration.observedRepo,
      observedRef: declaration.observedRef,
      observedAt: declaration.observedAt.toISOString(),
      head: {
        latestVersion: line.latestVersion,
        latestDigest: line.latestDigest,
        latestObservedAt: line.latestObservedAt
      },
      producer:
        producer !== null
          ? {
              objectId: producer.producerObjectId,
              name: producerNameById.get(producer.producerObjectId) ?? ""
            }
          : null,
      // The core's verdict for this line. Not a predicate written here.
      subscription
    });
  }

  const last = page[page.length - 1];
  return {
    componentGate: {
      enabled: gate.enabled,
      reason: gate.reason,
      contributions: gate.contributions
    },
    lastIngestionDecision: await readLastIngestionDecision(
      tx,
      input.orgId,
      input.componentObjectId
    ),
    rows,
    nextCursor: hasMore && last ? encodeInventoryCursor(last) : null
  };
}

export interface ReadComponentDependencyBumpsInput {
  orgId: string;
  componentObjectId: string;
  limit: number;
  cursor?: string | undefined;
}

/** The newest Decision of a kind per subject, one query. See docs/dependencies.md §208. */
async function newestDecisionsBySubject(
  tx: TenantTx,
  orgId: string,
  kind: string,
  subjectIds: string[]
): Promise<Map<string, typeof decisions.$inferSelect>> {
  const out = new Map<string, typeof decisions.$inferSelect>();
  if (subjectIds.length === 0) return out;
  const rows = await tx
    .selectDistinctOn([decisions.subjectId])
    .from(decisions)
    .where(
      and(
        eq(decisions.orgId, orgId),
        eq(decisions.kind, kind),
        inArray(decisions.subjectId, subjectIds)
      )
    )
    .orderBy(decisions.subjectId, desc(decisions.createdAt), desc(decisions.id));
  for (const row of rows) out.set(row.subjectId, row);
  return out;
}

/** One page of the bumps authored for a component. See docs/dependencies.md §209. */
export async function readComponentDependencyBumps(
  tx: TenantTx,
  input: ReadComponentDependencyBumpsInput
): Promise<{ rows: ComponentDependencyBump[]; nextCursor: string | null }> {
  // The descending keyset in `listBumpAuthorshipsByComponent` casts the cursor id `::uuid`; a
  // well-formed cursor carrying a non-uuid id is a client error, answered as the first page.
  const decoded = input.cursor ? decodeCursor(input.cursor) : null;
  const cursor = decoded && CURSOR_UUID_RE.test(decoded.id) ? decoded : null;
  const { items, hasMore } = await listBumpAuthorshipsByComponent(
    tx,
    input.orgId,
    input.componentObjectId,
    { limit: input.limit, cursor }
  );
  if (items.length === 0) return { rows: [], nextCursor: null };

  const changeIds = items.map((a) => a.changeObjectId);
  const lineIds = [...new Set(items.map((a) => a.lineId))];
  const [nameById, lines, mergeDecisions, dispatchDecisions] = await Promise.all([
    namesForObjectIds(tx, input.orgId, changeIds),
    listDependencyLinesByIds(tx, input.orgId, lineIds),
    newestDecisionsBySubject(tx, input.orgId, DEPENDENCY_BUMP_MERGE_DECISION_KIND, changeIds),
    newestDecisionsBySubject(tx, input.orgId, DEPENDENCY_BUMP_DECISION_KIND, changeIds)
  ]);
  const lineById = new Map(lines.map((l) => [l.id, l]));

  const rows: ComponentDependencyBump[] = items.map((a) => {
    const line = lineById.get(a.lineId);
    const merge = mergeDecisions.get(a.changeObjectId);
    const dispatch = dispatchDecisions.get(a.changeObjectId);
    const effective = dispatch
      ? DependencySubscriptionDeliverySchema.safeParse(
          (dispatch.inputContext as Record<string, unknown>).effectiveDelivery
        )
      : null;
    const delivery: DependencySubscriptionDelivery | null =
      effective && effective.success ? effective.data : null;
    const reasonRaw = dispatch
      ? (dispatch.reasonTree as Record<string, unknown>).delivery
      : undefined;
    return {
      changeId: a.changeObjectId,
      changeName: nameById.get(a.changeObjectId) ?? "",
      line: {
        id: a.lineId,
        // The authorship carries ecosystem+coordinate verbatim as recorded at dispatch; the line
        // row supplies the major (and would agree on the other two — same FK-bound row).
        ecosystem: (line?.ecosystem ?? a.ecosystem) as ComponentDependencyBump["line"]["ecosystem"],
        coordinate: a.coordinate,
        major: line?.major ?? ""
      },
      manifestPath: a.manifestPath,
      fromVersion: a.fromVersion,
      toVersion: a.toVersion,
      repo: a.repo,
      baseBranch: a.baseBranch,
      authoredRef: a.authoredRef,
      pullRequestNumber: a.pullRequestNumber ?? null,
      // READ, NEVER SYNTHESISED: the URL the provider returned, as `recordBumpPullRequest` stored
      // it; `null` when SCP recorded no link. See the schema doc.
      pullRequestUrl: a.pullRequestUrl ?? null,
      headCommit: a.headCommit ?? null,
      dispatchedAt: a.createdAt.toISOString(),
      mergedAt: a.mergedAt ? a.mergedAt.toISOString() : null,
      delivery,
      deliveryReason: typeof reasonRaw === "string" ? reasonRaw : null,
      merge: merge
        ? {
            verdict: merge.verdict,
            decisionId: merge.id,
            evaluatedAt: merge.createdAt.toISOString()
          }
        : null
    };
  });

  const last = items[items.length - 1];
  return {
    rows,
    nextCursor:
      hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.changeObjectId }) : null
  };
}
