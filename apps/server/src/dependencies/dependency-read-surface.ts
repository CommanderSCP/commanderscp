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
import { componentDependencies, decisions, objects } from "../db/schema.js";
import { latestDecisionForSubjectKind } from "../coordination/decisions-repo.js";
import { decodeCursor, encodeCursor } from "../pagination.js";
import { listBumpAuthorshipsByComponent } from "./bump-authorship-repo.js";
import { DEPENDENCY_BUMP_DECISION_KIND } from "./bump-dispatch.js";
import { DEPENDENCY_BUMP_MERGE_DECISION_KIND } from "./bump-gate.js";
import { listDependencyLinesByIds } from "./dependency-inventory-repo.js";
import { DEPENDENCY_INVENTORY_DECISION_KIND } from "./inventory-ingestion.js";
import {
  mergeComponentIngestionGate,
  resolveDeclaredComponentLines
} from "./subscription-resolution.js";

/**
 * M21.6 — THE READ SURFACE over the dependency inventory and the bump history, for ONE component
 * (docs/proposals/dependency-subscription-ui.md §3.1/§3.2, owner decisions §8 Q1/Q4).
 *
 * Two assemblers, both READ-ONLY, both scoped to one component, both paged. They exist so that the
 * route handlers in `routes/dependency-subscriptions.ts` stay thin and so that the joins are
 * testable through the same functions the routes call.
 *
 * THE ONE RULE THIS MODULE MUST NOT BREAK: IT WRITES THE AND ZERO TIMES, AND IT HAS NO
 * GATHER-AND-MERGE LOOP OF ITS OWN. Every per-row `subscription` comes from
 * `resolveDeclaredComponentLines(..., { includeDisabled: true })` — THE SAME function the ingestion
 * work-list is the enabled-only projection of, one gather + one unlock read per request — and the
 * component gate comes from `mergeComponentIngestionGate` over the candidates and instance THAT call
 * returned. Nothing here tests `enabled`, filters on it, or infers a tier. That is what makes
 * `rows[].subscription` byte-equal to the resolution GET for the same actor and line (pinned in
 * `dependency-inventory-routes.integration.test.ts`), and what would silently stop being true the
 * day someone "optimised" the per-row merge into a local predicate — or copied the work-list's loop
 * "minus its filter" into this file (the M21.7 review note on the proposal, §3.4, names exactly that
 * fork as the thing a fix round would have to undo).
 *
 * THE ACTOR IS THE CALLER. Both assemblers take `actorObjectId` and thread it exactly as the
 * resolution GET does (`auth.subjectObjectId`), so a human reading their component's page sees the
 * same enablement the resolution GET would report to them — and, as documented on
 * `GatherSubscriptionCandidatesInput.actorObjectId`, that can differ from what the SYSTEM actor's
 * jobs see for a `scope.group` policy. This module reports; it does not reconcile the two.
 *
 * DIRECT DECLARATIONS ONLY, NO TRAVERSAL, NO RELATIONSHIP — the inventory repo's boundary
 * (ADR-0032 §3/§4/§5) holds here: one keyset page of `component_dependencies`, one batched line
 * hydration, one batched producer-name lookup, one batched Decision lookup per kind. Nothing walks.
 */

// -------------------------------------------------------------------------------------------
// The inventory
// -------------------------------------------------------------------------------------------

/**
 * The inventory page cursor — the last row's `(lineId, manifestPath)`, which is the tail of the
 * `component_dependencies` primary key and therefore a total order over one component's rows.
 * Opaque on the wire (base64url JSON), like every other cursor in this codebase.
 */
function encodeInventoryCursor(row: { lineId: string; manifestPath: string }): string {
  return Buffer.from(
    JSON.stringify({ lineId: row.lineId, manifestPath: row.manifestPath })
  ).toString("base64url");
}

function decodeInventoryCursor(cursor: string): { lineId: string; manifestPath: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).lineId === "string" &&
      typeof (parsed as Record<string, unknown>).manifestPath === "string"
    ) {
      const p = parsed as { lineId: string; manifestPath: string };
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

/**
 * The newest `dependency_inventory_ingestion` Decision about this component, projected LENIENTLY —
 * `inputContext.manifestPathsRead/Absent` and `reasonTree.skipped[{path, reason}]` are read as
 * written by `inventory-ingestion.ts` and anything malformed reads as empty rather than throwing.
 * `null` when no such Decision exists (never ingested, OR refused as not-enabled / not-addressable /
 * superseded — none of which write one).
 */
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

  // The DECLARED producers' names, one lookup. `producedByObjectId` carries a foreign key, so a
  // declared producer always names an object; a producer that has since been soft-deleted still
  // resolves here (the declaration is a stored fact and the name is what it was).
  const producerIds = [
    ...new Set(
      lines.map((l) => l.producedByObjectId).filter((id): id is string => typeof id === "string")
    )
  ];
  const producerNameById = new Map<string, string>();
  if (producerIds.length > 0) {
    const producers = await tx
      .select({ id: objects.id, name: objects.name })
      .from(objects)
      .where(and(eq(objects.orgId, input.orgId), inArray(objects.id, producerIds)));
    for (const p of producers) producerNameById.set(p.id, p.name);
  }

  const rows: ComponentDependencyInventoryRow[] = [];
  for (const declaration of page) {
    const line = lineById.get(declaration.lineId);
    const subscription = resolutionByLineId.get(declaration.lineId);
    // A declaration whose line is gone cannot exist (composite FK), and every declared line was
    // resolved above (same table, same transaction) — but a projection that threw on the impossible
    // would make an unrelated row un-listable. Skip and move on.
    if (!line || !subscription) continue;
    const producerName =
      line.producedByObjectId !== null ? producerNameById.get(line.producedByObjectId) : undefined;
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
        line.producedByObjectId !== null
          ? { objectId: line.producedByObjectId, name: producerName ?? "" }
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

// -------------------------------------------------------------------------------------------
// The bumps
// -------------------------------------------------------------------------------------------

export interface ReadComponentDependencyBumpsInput {
  orgId: string;
  componentObjectId: string;
  limit: number;
  cursor?: string | undefined;
}

/**
 * The newest Decision of one `kind` for EACH of a set of subjects, in ONE query — `DISTINCT ON
 * (subject_id)` over the `decisions_org_subject_kind_created` index. The per-change join the bump
 * list needs, written once and used for both the dispatch and the merge Decision.
 */
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

/**
 * One page of the bumps SCP authored for a component, newest first, each joined to its change's
 * name, its line's major, the newest `dependency_bump_dispatch` Decision (delivery + reason) and
 * the newest `dependency_bump_merge` Decision (the second look). `pullRequestUrl` is `null` on
 * every row — nothing server-side stores it, and it is never composed from `repo` + number.
 */
export async function readComponentDependencyBumps(
  tx: TenantTx,
  input: ReadComponentDependencyBumpsInput
): Promise<{ rows: ComponentDependencyBump[]; nextCursor: string | null }> {
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const { items, hasMore } = await listBumpAuthorshipsByComponent(
    tx,
    input.orgId,
    input.componentObjectId,
    { limit: input.limit, cursor }
  );
  if (items.length === 0) return { rows: [], nextCursor: null };

  const changeIds = items.map((a) => a.changeObjectId);
  const lineIds = [...new Set(items.map((a) => a.lineId))];
  const [changeNames, lines, mergeDecisions, dispatchDecisions] = await Promise.all([
    tx
      .select({ id: objects.id, name: objects.name })
      .from(objects)
      .where(and(eq(objects.orgId, input.orgId), inArray(objects.id, changeIds))),
    listDependencyLinesByIds(tx, input.orgId, lineIds),
    newestDecisionsBySubject(tx, input.orgId, DEPENDENCY_BUMP_MERGE_DECISION_KIND, changeIds),
    newestDecisionsBySubject(tx, input.orgId, DEPENDENCY_BUMP_DECISION_KIND, changeIds)
  ]);
  const nameById = new Map(changeNames.map((c) => [c.id, c.name]));
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
      // NOT STORED, NOT SYNTHESISED. See the schema doc.
      pullRequestUrl: null,
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
