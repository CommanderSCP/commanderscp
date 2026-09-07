import type {
  DependencyLineProducer,
  DependencyLineProducerKey,
  DependencyLineProducerView,
  DependencyObjectRef,
  DependencyProducerLineImpact,
  DependencyProducerOpenBump
} from "@scp/schemas";
import { and, eq, inArray } from "drizzle-orm";
import { objects } from "../db/schema.js";
import type { TenantTx } from "../db/tenant-tx.js";
import type { Permission } from "../authz/resolve.js";
import { authorize } from "../authz/resolve.js";
import { insertDecision } from "../coordination/decisions-repo.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import {
  declareDependencyLineProducer,
  getDependencyLineProducer,
  listComponentsDeclaringLine,
  listDependencyLinesForCoordinate,
  resetLineHead,
  retractDependencyLineProducer
} from "./dependency-inventory-repo.js";
import { listSubscribedComponentLines } from "./subscription-resolution.js";
import { listOpenBumpAuthorshipsForCoordinate } from "./bump-authorship-repo.js";

/** THE PRODUCER DECLARATION'S EFFECTS, IN ONE PLACE. See docs/dependencies.md §348. */

/** The Decision kind both verbs write. See docs/dependencies.md §349. */
export const PRODUCER_DECISION_KIND = "dependency_line_producer";

/** THE AUTHORITY EVERY PRODUCER WRITE TAKES. See docs/dependencies.md §350. */
export function dependencyProducerScopeCheck(orgId: string): {
  permission: Permission;
  scopeObjectId: string;
} {
  return { permission: "policy:write", scopeObjectId: orgId };
}

/** The inline form, for a door that authorizes as it goes. Same pair, one definition. */
export async function authorizeDependencyProducerWrite(
  tx: TenantTx,
  input: { orgId: string; subjectObjectId: string }
): Promise<void> {
  await authorize(tx, {
    orgId: input.orgId,
    subjectObjectId: input.subjectObjectId,
    ...dependencyProducerScopeCheck(input.orgId)
  });
}

/** One covered line, as the blast-radius read returns it before anything is written. */
export interface ProducerLineBefore {
  lineId: string;
  major: string;
  tagPattern: string | null;
  latestVersion: string | null;
  latestDigest: string | null;
  latestObservedAt: string | null;
  subscribedComponentObjectIds: string[];
  /** The same set, named — one per id, same order. */
  subscribedComponents: DependencyObjectRef[];
}

/** The names behind a set of object ids. See docs/dependencies.md §351. */
export async function namesForObjectIds(
  tx: TenantTx,
  orgId: string,
  ids: readonly string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const byId = new Map<string, string>();
  if (unique.length === 0) return byId;
  const rows = await tx
    .select({ id: objects.id, name: objects.name })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), inArray(objects.id, unique)));
  for (const row of rows) byId.set(row.id, row.name);
  return byId;
}

/** `{objectId, name}` for each id, in the ids' order; unknown ids name `""`. */
export function refsForIds(
  ids: readonly string[],
  names: Map<string, string>
): DependencyObjectRef[] {
  return ids.map((objectId) => ({ objectId, name: names.get(objectId) ?? "" }));
}

/** THE WIRE VIEW of stored declarations. See docs/dependencies.md §352. */
export async function viewsOfDeclarations(
  tx: TenantTx,
  orgId: string,
  declarations: readonly DependencyLineProducer[]
): Promise<DependencyLineProducerView[]> {
  const names = await namesForObjectIds(
    tx,
    orgId,
    declarations.flatMap((d) => [d.producerObjectId, d.declaredByObjectId])
  );
  return declarations.map((d) => ({
    ...d,
    producer: { objectId: d.producerObjectId, name: names.get(d.producerObjectId) ?? "" },
    declaredBy: { objectId: d.declaredByObjectId, name: names.get(d.declaredByObjectId) ?? "" }
  }));
}

/** THE BLAST RADIUS. See docs/dependencies.md §353. */
export async function readProducerBlastRadius(
  tx: TenantTx,
  orgId: string,
  key: DependencyLineProducerKey,
  actorObjectId: string
): Promise<ProducerLineBefore[]> {
  const lines = await listDependencyLinesForCoordinate(tx, orgId, key);
  const out: ProducerLineBefore[] = [];
  for (const line of lines) {
    const declaring = await listComponentsDeclaringLine(tx, orgId, line.id);
    const componentObjectIds = [...new Set(declaring.map((d) => d.componentObjectId))];
    const subscribed =
      componentObjectIds.length === 0
        ? []
        : await listSubscribedComponentLines(tx, orgId, { actorObjectId, componentObjectIds });
    out.push({
      lineId: line.id,
      major: line.major,
      tagPattern: line.tagPattern,
      latestVersion: line.latestVersion,
      latestDigest: line.latestDigest,
      latestObservedAt: line.latestObservedAt,
      subscribedComponentObjectIds: subscribed
        .filter((s) => s.lineId === line.id)
        .map((s) => s.componentObjectId)
        .sort(),
      subscribedComponents: []
    });
  }
  // NAMED, in one batched read for every line at once — the report a human confirms before the
  // write must name what it reaches (schema note on `subscribedComponents`).
  const names = await namesForObjectIds(
    tx,
    orgId,
    out.flatMap((l) => l.subscribedComponentObjectIds)
  );
  for (const l of out) l.subscribedComponents = refsForIds(l.subscribedComponentObjectIds, names);
  return out;
}

/** The dry-run projection of what a verb WOULD do to each covered line — no writes. A dry run that
 *  reported `headCleared: false` everywhere would hide the single most consequential thing the verb
 *  does. */
export function projectLineImpacts(before: ProducerLineBefore[]): DependencyProducerLineImpact[] {
  return before.map((l) => ({
    lineId: l.lineId,
    major: l.major,
    tagPattern: l.tagPattern,
    headBefore: {
      latestVersion: l.latestVersion,
      latestDigest: l.latestDigest,
      latestObservedAt: l.latestObservedAt
    },
    headCleared: l.latestVersion !== null || l.latestDigest !== null || l.latestObservedAt !== null,
    subscribedComponentObjectIds: l.subscribedComponentObjectIds,
    subscribedComponents: l.subscribedComponents
  }));
}

/** Clears the observed head of every covered line and reports what was discarded — see
 *  `resetLineHead`'s header for why BOTH verbs must do this, and why it is a security fix rather
 *  than a tidiness one. */
async function clearHeads(
  tx: TenantTx,
  orgId: string,
  before: ProducerLineBefore[]
): Promise<DependencyProducerLineImpact[]> {
  const lines: DependencyProducerLineImpact[] = [];
  for (const l of before) {
    const reset = await resetLineHead(tx, orgId, l.lineId);
    lines.push({
      lineId: l.lineId,
      major: l.major,
      tagPattern: l.tagPattern,
      headBefore: reset.before,
      headCleared: reset.cleared,
      subscribedComponentObjectIds: l.subscribedComponentObjectIds,
      subscribedComponents: l.subscribedComponents
    });
  }
  return lines;
}

/** The `reasonTree` half both verbs share: sorted, free of wall-clock values, so two Decisions about
 *  one coordinate can be diffed against each other by an operator. The heads that were CLEARED are
 *  facts about the act and stay. Each verb adds the half only it can report — the subscribers a
 *  declaration reaches, the open bumps a retraction cannot recall. */
function producerReasonTree(lines: DependencyProducerLineImpact[]): Record<string, unknown> {
  return {
    linesCovered: lines.map((l) => l.lineId).sort(),
    headsCleared: lines
      .filter((l) => l.headCleared)
      .map((l) => ({ lineId: l.lineId, wasVersion: l.headBefore.latestVersion }))
      .sort((a, b) => (a.lineId < b.lineId ? -1 : 1))
  };
}

/** Declare: write the row, clear the heads, record it. See docs/dependencies.md §354. */
export async function declareProducerWithEffects(
  tx: TenantTx,
  input: {
    orgId: string;
    actorObjectId: string;
    requestId: string;
    key: DependencyLineProducerKey;
    producerObjectId: string;
  }
): Promise<{
  declaration: DependencyLineProducer;
  lines: DependencyProducerLineImpact[];
  decisionId: string;
}> {
  const { orgId, actorObjectId, requestId, key, producerObjectId } = input;
  const before = await readProducerBlastRadius(tx, orgId, key, actorObjectId);

  // Read before the upsert, since the write overwrites it. See docs/dependencies.md §355.
  const displaced = await getDependencyLineProducer(tx, orgId, key);

  const declaration = await declareDependencyLineProducer(tx, orgId, {
    ecosystem: key.ecosystem,
    coordinate: key.coordinate,
    producerObjectId,
    declaredByObjectId: actorObjectId
  });

  // CLEARING THE HEAD IS PART OF DECLARING. See docs/dependencies.md §356.
  const lines = await clearHeads(tx, orgId, before);

  // ALWAYS PERSISTED — see {@link PRODUCER_DECISION_KIND} for why persist-on-change was the wrong
  // guard here and why re-keying its identity would not have fixed it.
  const decision = await insertDecision(tx, {
    orgId,
    kind: PRODUCER_DECISION_KIND,
    // The PRODUCER is the subject: it is the object whose releases now author other teams' commits,
    // and it is a real `objects.id`, which the column requires.
    subjectId: producerObjectId,
    verdict: "declared",
    inputContext: {
      ecosystem: key.ecosystem,
      coordinate: key.coordinate,
      producerObjectId,
      // WHAT THIS ACT DISPLACED. `null` when the coordinate had no producer; another component's id
      // when this declaration TOOK the coordinate from it. Two declarations of the same coordinate
      // to the same producer are only the same event if nothing happened in between, and this is the
      // field that says whether anything did.
      displacedProducerObjectId: displaced?.producerObjectId ?? null,
      declaredByObjectId: actorObjectId
    },
    reasonTree: {
      ...producerReasonTree(lines),
      subscribedComponentObjectIds: [
        ...new Set(lines.flatMap((l) => l.subscribedComponentObjectIds))
      ].sort()
    }
  });

  await appendAuditEvent(tx, {
    orgId,
    actorId: actorObjectId,
    action: "dependency.producer.declare",
    subjectId: producerObjectId,
    reason: `${key.ecosystem} ${key.coordinate}`,
    decisionId: decision.id,
    requestId
  });

  return { declaration, lines, decisionId: decision.id };
}

/** Retract: delete the row, clear the heads, report. See docs/dependencies.md §357. */
export async function retractProducerWithEffects(
  tx: TenantTx,
  input: {
    orgId: string;
    actorObjectId: string;
    requestId: string;
    key: DependencyLineProducerKey;
    existing: DependencyLineProducer;
  }
): Promise<{
  lines: DependencyProducerLineImpact[];
  openBumps: DependencyProducerOpenBump[];
  decisionId: string;
}> {
  const { orgId, actorObjectId, requestId, key, existing } = input;
  const before = await readProducerBlastRadius(tx, orgId, key, actorObjectId);

  await retractDependencyLineProducer(tx, orgId, key);

  // Clearing the head is part of retracting, and is security. See docs/dependencies.md §358.
  const lines = await clearHeads(tx, orgId, before);

  // REPORTED, NEVER TOUCHED. A dispatched bump has left SCP — it is a pull request in another team's
  // repository, or under `auto_merge` a commit on their branch. Closing or rewriting these rows
  // would assert SCP closed a PR it did not close. Retraction stops FUTURE triggers only; this list
  // is what an operator takes away to go and close them.
  const openBumps = await listOpenBumpAuthorshipsForCoordinate(tx, orgId, key);

  const decision = await insertDecision(tx, {
    orgId,
    kind: PRODUCER_DECISION_KIND,
    subjectId: existing.producerObjectId,
    verdict: "retracted",
    inputContext: {
      ecosystem: key.ecosystem,
      coordinate: key.coordinate,
      producerObjectId: existing.producerObjectId,
      retractedByObjectId: actorObjectId
    },
    reasonTree: {
      ...producerReasonTree(lines),
      // THE ONES SCP CANNOT RECALL, on the record at the moment of retraction, because an operator's
      // only route to them is this list.
      openBumpAuthorships: openBumps
        .map((b) => ({
          changeObjectId: b.changeObjectId,
          componentObjectId: b.componentObjectId,
          repo: b.repo,
          toVersion: b.toVersion
        }))
        .sort((a, b) => (a.changeObjectId < b.changeObjectId ? -1 : 1))
    }
  });

  await appendAuditEvent(tx, {
    orgId,
    actorId: actorObjectId,
    action: "dependency.producer.retract",
    subjectId: existing.producerObjectId,
    reason: `${key.ecosystem} ${key.coordinate}`,
    decisionId: decision.id,
    requestId
  });

  return { lines, openBumps, decisionId: decision.id };
}
