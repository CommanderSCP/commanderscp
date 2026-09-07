import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import {
  type ComponentDependency,
  type DeclareLineProducerInput,
  type DependencyLine,
  type DependencyLineKey,
  type DependencyLineProducer,
  type DependencyLineProducerKey,
  type ObserveDependencyLineHeadInput,
  type UpsertComponentDependencyInput,
  type UpsertDependencyLineInput
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { componentDependencies, dependencyLineProducers, dependencyLines } from "../db/schema.js";
import { writeOutboxEvent } from "../events/outbox-repo.js";
import {
  asThirdPartyLine,
  evaluateHeadMovement,
  evaluateIngressAuthority,
  type HeadRefusalReason,
  type HeadWriteIngress,
  type ThirdPartyLine
} from "./line-head.js";

/** M21.2 — the DEPENDENCY INVENTORY repo. See docs/dependencies.md §164. */

function toDependencyLine(row: typeof dependencyLines.$inferSelect): DependencyLine {
  return {
    id: row.id,
    orgId: row.orgId,
    // The DB column is plain `text` with no CHECK (0060 header): packages/schemas is the only
    // enforcement point, so a row written before an ecosystem was removed from the enum would
    // surface here. Cast rather than re-validate — the write paths below are the choke point, and a
    // read that threw would make an unrelated ecosystem's row un-listable.
    ecosystem: row.ecosystem as DependencyLine["ecosystem"],
    coordinate: row.coordinate,
    major: row.major,
    tagPattern: row.tagPattern,
    // NO PRODUCER FIELDS. The declaration is per COORDINATE and lives in
    // `dependency_line_producers` (drizzle/0068); a caller that needs internal-ness JOINS. That is
    // what makes a brand-new major of a declared coordinate internal from the instant it is minted.
    latestVersion: row.latestVersion,
    latestDigest: row.latestDigest,
    latestObservedAt: row.latestObservedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function toComponentDependency(
  row: typeof componentDependencies.$inferSelect
): ComponentDependency {
  return {
    orgId: row.orgId,
    componentObjectId: row.componentObjectId,
    lineId: row.lineId,
    manifestPath: row.manifestPath,
    declaredVersion: row.declaredVersion,
    resolvedVersion: row.resolvedVersion,
    resolvedDigest: row.resolvedDigest,
    observedRepo: row.observedRepo,
    observedRef: row.observedRef,
    observedAt: row.observedAt.toISOString(),
    createdAt: row.createdAt.toISOString()
  };
}

/** `tag_pattern` is meaningful for `oci` ONLY. See docs/dependencies.md §165. */
function tagPatternFor(
  ecosystem: DependencyLineKey["ecosystem"],
  tagPattern: string | undefined
): string | null {
  return ecosystem === "oci" ? (tagPattern ?? null) : null;
}

/** Insert or return the line identified by that key. See docs/dependencies.md §166. */
export async function upsertDependencyLine(
  tx: TenantTx,
  orgId: string,
  input: UpsertDependencyLineInput
): Promise<DependencyLine> {
  const [row] = await tx
    .insert(dependencyLines)
    .values({
      id: uuidv7(),
      orgId,
      ecosystem: input.ecosystem,
      coordinate: input.coordinate,
      major: input.major,
      tagPattern: tagPatternFor(input.ecosystem, input.tagPattern)
    })
    .onConflictDoUpdate({
      target: [
        dependencyLines.orgId,
        dependencyLines.ecosystem,
        dependencyLines.coordinate,
        dependencyLines.major
      ],
      set: {
        // `coalesce(excluded, existing)` so a re-ingestion that omits the pattern does not erase a
        // pattern an operator set — the same shape `unattached-change-status-repo.ts` uses.
        tagPattern: sql`coalesce(excluded.tag_pattern, ${dependencyLines.tagPattern})`,
        updatedAt: new Date()
      }
    })
    .returning();
  if (!row) throw new Error("failed to upsert dependency line");
  return toDependencyLine(row);
}

/** The line identified by its natural key, or `null`. A single index descent on
 *  `dependency_lines_identity`. */
export async function getDependencyLineByKey(
  tx: TenantTx,
  orgId: string,
  key: DependencyLineKey
): Promise<DependencyLine | null> {
  const [row] = await tx
    .select()
    .from(dependencyLines)
    .where(
      and(
        eq(dependencyLines.orgId, orgId),
        eq(dependencyLines.ecosystem, key.ecosystem),
        eq(dependencyLines.coordinate, key.coordinate),
        eq(dependencyLines.major, key.major)
      )
    )
    .limit(1);
  return row ? toDependencyLine(row) : null;
}

export async function getDependencyLineById(
  tx: TenantTx,
  orgId: string,
  lineId: string
): Promise<DependencyLine | null> {
  const [row] = await tx
    .select()
    .from(dependencyLines)
    .where(and(eq(dependencyLines.orgId, orgId), eq(dependencyLines.id, lineId)))
    .limit(1);
  return row ? toDependencyLine(row) : null;
}

function toDependencyLineProducer(
  row: typeof dependencyLineProducers.$inferSelect
): DependencyLineProducer {
  return {
    orgId: row.orgId,
    // Plain `text` with no CHECK (0068 header, same reading as `dependencyLines.ecosystem`).
    ecosystem: row.ecosystem as DependencyLineProducer["ecosystem"],
    coordinate: row.coordinate,
    producerObjectId: row.producerObjectId,
    declaredAt: row.declaredAt.toISOString(),
    declaredByObjectId: row.declaredByObjectId
  };
}

/** DECLARE the component that produces this COORDINATE. See docs/dependencies.md §167. */
export async function declareDependencyLineProducer(
  tx: TenantTx,
  orgId: string,
  input: DeclareLineProducerInput
): Promise<DependencyLineProducer> {
  const [row] = await tx
    .insert(dependencyLineProducers)
    .values({
      orgId,
      ecosystem: input.ecosystem,
      coordinate: input.coordinate,
      producerObjectId: input.producerObjectId,
      declaredAt: new Date(),
      declaredByObjectId: input.declaredByObjectId
    })
    .onConflictDoUpdate({
      target: [
        dependencyLineProducers.orgId,
        dependencyLineProducers.ecosystem,
        dependencyLineProducers.coordinate
      ],
      // The provenance MOVES WITH THE LINK: re-declaring to a different producer records who said
      // so and when, so principle 6's "which principal asserted this coordinate is ours" answers
      // about the assertion that is standing, not about the first one ever made.
      set: {
        producerObjectId: input.producerObjectId,
        declaredAt: new Date(),
        declaredByObjectId: input.declaredByObjectId
      }
    })
    .returning();
  if (!row) throw new Error("failed to declare dependency line producer");
  return toDependencyLineProducer(row);
}

/** Retract the declaration, returning the removed row. See docs/dependencies.md §168. */
export async function retractDependencyLineProducer(
  tx: TenantTx,
  orgId: string,
  key: DependencyLineProducerKey
): Promise<DependencyLineProducer | null> {
  const [row] = await tx
    .delete(dependencyLineProducers)
    .where(
      and(
        eq(dependencyLineProducers.orgId, orgId),
        eq(dependencyLineProducers.ecosystem, key.ecosystem),
        eq(dependencyLineProducers.coordinate, key.coordinate)
      )
    )
    .returning();
  return row ? toDependencyLineProducer(row) : null;
}

/** The declaration for one coordinate, or `null` — one primary-key descent. THE point read behind
 *  `isInternalDependencyLine`. */
export async function getDependencyLineProducer(
  tx: TenantTx,
  orgId: string,
  key: DependencyLineProducerKey
): Promise<DependencyLineProducer | null> {
  const [row] = await tx
    .select()
    .from(dependencyLineProducers)
    .where(
      and(
        eq(dependencyLineProducers.orgId, orgId),
        eq(dependencyLineProducers.ecosystem, key.ecosystem),
        eq(dependencyLineProducers.coordinate, key.coordinate)
      )
    )
    .limit(1);
  return row ? toDependencyLineProducer(row) : null;
}

/** Every declaration in the org, optionally narrowed to one ecosystem or one exact coordinate. The
 *  coordinate filter is BYTE EQUALITY, never a prefix — `@acme/lib` and `acme-lib` share a URN slug
 *  and must not share an answer. */
export async function listDependencyLineProducers(
  tx: TenantTx,
  orgId: string,
  filter: { ecosystem?: string; coordinate?: string } = {}
): Promise<DependencyLineProducer[]> {
  const conditions = [eq(dependencyLineProducers.orgId, orgId)];
  if (filter.ecosystem !== undefined) {
    conditions.push(eq(dependencyLineProducers.ecosystem, filter.ecosystem));
  }
  if (filter.coordinate !== undefined) {
    conditions.push(eq(dependencyLineProducers.coordinate, filter.coordinate));
  }
  const rows = await tx
    .select()
    .from(dependencyLineProducers)
    .where(and(...conditions))
    .orderBy(dependencyLineProducers.ecosystem, dependencyLineProducers.coordinate);
  return rows.map(toDependencyLineProducer);
}

/** The coordinates a set of components is DECLARED to produce. See docs/dependencies.md §169. */
export async function listDependencyLineProducersForComponents(
  tx: TenantTx,
  orgId: string,
  componentObjectIds: string[]
): Promise<DependencyLineProducer[]> {
  if (componentObjectIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(dependencyLineProducers)
    .where(
      and(
        eq(dependencyLineProducers.orgId, orgId),
        inArray(dependencyLineProducers.producerObjectId, componentObjectIds)
      )
    )
    .orderBy(dependencyLineProducers.ecosystem, dependencyLineProducers.coordinate);
  return rows.map(toDependencyLineProducer);
}

/** The declarations for a set of coordinates in one trip. See docs/dependencies.md §170. */
export async function listDependencyLineProducersForKeys(
  tx: TenantTx,
  orgId: string,
  keys: readonly DependencyLineProducerKey[]
): Promise<DependencyLineProducer[]> {
  if (keys.length === 0) return [];
  const wanted = new Set(keys.map((k) => `${k.ecosystem}\u0000${k.coordinate}`));
  const rows = await tx
    .select()
    .from(dependencyLineProducers)
    .where(
      and(
        eq(dependencyLineProducers.orgId, orgId),
        inArray(dependencyLineProducers.coordinate, [...new Set(keys.map((k) => k.coordinate))])
      )
    );
  return rows
    .filter((r) => wanted.has(`${r.ecosystem}\u0000${r.coordinate}`))
    .map(toDependencyLineProducer);
}

/** EVERY MAJOR LINE of one coordinate. See docs/dependencies.md §171. */
export async function listDependencyLinesForCoordinate(
  tx: TenantTx,
  orgId: string,
  key: DependencyLineProducerKey
): Promise<DependencyLine[]> {
  const rows = await tx
    .select()
    .from(dependencyLines)
    .where(
      and(
        eq(dependencyLines.orgId, orgId),
        eq(dependencyLines.ecosystem, key.ecosystem),
        eq(dependencyLines.coordinate, key.coordinate)
      )
    )
    .orderBy(dependencyLines.major, dependencyLines.id);
  return rows.map(toDependencyLine);
}

/** What {@link recordDependencyLineHead} did, and why — the caller puts this in its Decision, so a
 *  refusal is as legible as a move (charter principle 6). `line` is the row as it stands AFTER the
 *  call in both branches, so a refused caller can report the head that actually survived. */
/** The CloudEvents `type` emitted when a line's head ADVANCES. See docs/dependencies.md §172. */
export const DEPENDENCY_LINE_HEAD_ADVANCED_EVENT = "scp.dependency.line_head_advanced";

export type RecordDependencyLineHeadOutcome =
  | {
      readonly recorded: true;
      readonly movement: "advanced" | "restated";
      readonly detail: string;
      readonly line: DependencyLine;
    }
  | {
      readonly recorded: false;
      readonly reason: HeadRefusalReason;
      readonly detail: string;
      readonly line: DependencyLine;
    };

/** THE ONE WRITER OF THE `latest_*` TRIO. See docs/dependencies.md §173. */
export async function recordDependencyLineHead(
  tx: TenantTx,
  orgId: string,
  input: ObserveDependencyLineHeadInput,
  /** WHICH INGRESS IS ASKING. See docs/dependencies.md §174. */
  ingress: HeadWriteIngress
): Promise<RecordDependencyLineHeadOutcome> {
  const [current] = await tx
    .select()
    .from(dependencyLines)
    .where(and(eq(dependencyLines.orgId, orgId), eq(dependencyLines.id, input.lineId)))
    .limit(1)
    .for("update");
  if (!current) throw new Error(`dependency line not found: ${input.lineId}`);
  const before = toDependencyLine(current);

  // Re-read the producer state here, under the lock taken. See docs/dependencies.md §175.
  const declaration = await getDependencyLineProducer(tx, orgId, {
    ecosystem: before.ecosystem,
    coordinate: before.coordinate
  });
  // THE IDENTITY IS HANDED OVER, NOT A BOOLEAN. `declaration !== null` used to be what this passed,
  // which asked "is a producer declared?" and never "is THIS one?" — so a coordinate TRANSFERRED
  // from P to Q left P's in-flight derivation free to write the head and fan bumps out from it.
  const authority = evaluateIngressAuthority(ingress, {
    producerObjectId: declaration?.producerObjectId ?? null
  });
  if (!authority.authorized) {
    return {
      recorded: false,
      reason: authority.reason,
      detail: authority.detail,
      line: before
    };
  }

  const movement = evaluateHeadMovement(before, input.latestVersion);
  if (!movement.moves) {
    return { recorded: false, reason: movement.reason, detail: movement.detail, line: before };
  }

  // THE PAIR MOVES TOGETHER. See docs/dependencies.md §176.
  const latestDigest =
    movement.movement === "advanced"
      ? input.latestDigest
      : (input.latestDigest ?? before.latestDigest);

  const now = new Date();
  const [row] = await tx
    .update(dependencyLines)
    .set({
      latestVersion: input.latestVersion,
      latestDigest,
      latestObservedAt: now,
      updatedAt: now
    })
    .where(and(eq(dependencyLines.orgId, orgId), eq(dependencyLines.id, input.lineId)))
    .returning();
  if (!row) throw new Error(`dependency line not found: ${input.lineId}`);
  const after = toDependencyLine(row);

  // AND THIS IS WHERE THE BUMP STARTS. See docs/dependencies.md §177.
  if (movement.movement === "advanced") {
    await writeOutboxEvent(tx, {
      orgId,
      type: DEPENDENCY_LINE_HEAD_ADVANCED_EVENT,
      source: "/dependencies/lines",
      // The LINE is the subject; the dispatcher re-derives everything else from the row, so a
      // redelivered event cannot make it act on facts that have since moved.
      subject: after.id,
      data: {
        lineId: after.id,
        ecosystem: after.ecosystem,
        coordinate: after.coordinate,
        major: after.major,
        latestVersion: after.latestVersion,
        latestDigest: after.latestDigest
      }
    });
  }

  return {
    recorded: true,
    movement: movement.movement,
    detail: movement.detail,
    line: after
  };
}

/** The one exception to that function being the sole writer. See docs/dependencies.md §178. */
export async function resetLineHead(
  tx: TenantTx,
  orgId: string,
  lineId: string
): Promise<{
  cleared: boolean;
  before: Pick<DependencyLine, "latestVersion" | "latestDigest" | "latestObservedAt">;
}> {
  const [current] = await tx
    .select()
    .from(dependencyLines)
    .where(and(eq(dependencyLines.orgId, orgId), eq(dependencyLines.id, lineId)))
    .limit(1)
    .for("update");
  if (!current) throw new Error(`dependency line not found: ${lineId}`);
  const before = toDependencyLine(current);
  const had =
    before.latestVersion !== null ||
    before.latestDigest !== null ||
    before.latestObservedAt !== null;
  // A line with nothing observed is left ALONE rather than written with three NULLs it already has:
  // `updated_at` is what a reader uses to tell "this row was touched" from "this row was not", and
  // stamping it on a no-op would make every dry-run-shaped reasoning about the row false.
  if (!had) {
    return {
      before: {
        latestVersion: before.latestVersion,
        latestDigest: before.latestDigest,
        latestObservedAt: before.latestObservedAt
      },
      cleared: false
    };
  }
  await tx
    .update(dependencyLines)
    .set({
      latestVersion: null,
      latestDigest: null,
      latestObservedAt: null,
      updatedAt: new Date()
    })
    .where(and(eq(dependencyLines.orgId, orgId), eq(dependencyLines.id, lineId)));
  return {
    before: {
      latestVersion: before.latestVersion,
      latestDigest: before.latestDigest,
      latestObservedAt: before.latestObservedAt
    },
    cleared: true
  };
}

/** Insert or update one declaration read from one manifest. See docs/dependencies.md §179. */
export async function upsertComponentDependency(
  tx: TenantTx,
  orgId: string,
  input: UpsertComponentDependencyInput
): Promise<ComponentDependency> {
  const observedAt = input.observedAt ?? new Date();
  const [row] = await tx
    .insert(componentDependencies)
    .values({
      orgId,
      componentObjectId: input.componentObjectId,
      lineId: input.lineId,
      manifestPath: input.manifestPath,
      declaredVersion: input.declaredVersion,
      resolvedVersion: input.resolvedVersion ?? null,
      resolvedDigest: input.resolvedDigest ?? null,
      observedRepo: input.observedRepo ?? null,
      observedRef: input.observedRef ?? null,
      observedAt
    })
    .onConflictDoUpdate({
      target: [
        componentDependencies.orgId,
        componentDependencies.componentObjectId,
        componentDependencies.lineId,
        componentDependencies.manifestPath
      ],
      set: {
        declaredVersion: input.declaredVersion,
        resolvedVersion: input.resolvedVersion ?? null,
        resolvedDigest: input.resolvedDigest ?? null,
        observedRepo: input.observedRepo ?? null,
        observedRef: input.observedRef ?? null,
        observedAt
      }
    })
    .returning();
  if (!row) throw new Error("failed to upsert component dependency");
  return toComponentDependency(row);
}

/** FORWARD lookup — "what does component C declare?". See docs/dependencies.md §180. */
export async function listComponentDependencies(
  tx: TenantTx,
  orgId: string,
  componentObjectId: string,
  options?: { manifestPath?: string }
): Promise<ComponentDependency[]> {
  const conditions = [
    eq(componentDependencies.orgId, orgId),
    eq(componentDependencies.componentObjectId, componentObjectId)
  ];
  if (options?.manifestPath !== undefined) {
    conditions.push(eq(componentDependencies.manifestPath, options.manifestPath));
  }
  const rows = await tx
    .select()
    .from(componentDependencies)
    .where(and(...conditions));
  return rows.map(toComponentDependency);
}

/** REVERSE lookup — "which components declare line L?". See docs/dependencies.md §181. */
export async function listComponentsDeclaringLine(
  tx: TenantTx,
  orgId: string,
  lineId: string
): Promise<ComponentDependency[]> {
  const rows = await tx
    .select()
    .from(componentDependencies)
    .where(and(eq(componentDependencies.orgId, orgId), eq(componentDependencies.lineId, lineId)));
  return rows.map(toComponentDependency);
}

/** Prune the declarations for ONE. See docs/dependencies.md §182. */
export async function pruneComponentDependencies(
  tx: TenantTx,
  orgId: string,
  input: {
    componentObjectId: string;
    /** The repository this run READ. Only rows observed in it are candidates for deletion. */
    observedRepo: string;
    manifestPath: string;
    keepLineIds: string[];
  }
): Promise<number> {
  const scope = and(
    eq(componentDependencies.orgId, orgId),
    eq(componentDependencies.componentObjectId, input.componentObjectId),
    eq(componentDependencies.observedRepo, input.observedRepo),
    eq(componentDependencies.manifestPath, input.manifestPath)
  );
  const rows = await tx
    .delete(componentDependencies)
    .where(
      input.keepLineIds.length === 0
        ? scope
        : and(scope, notInArray(componentDependencies.lineId, input.keepLineIds))
    )
    .returning({ lineId: componentDependencies.lineId });
  return rows.length;
}

/** The lines named by a set of ids, in one round trip. See docs/dependencies.md §183. */
export async function listDependencyLinesByIds(
  tx: TenantTx,
  orgId: string,
  lineIds: string[]
): Promise<DependencyLine[]> {
  if (lineIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(dependencyLines)
    .where(and(eq(dependencyLines.orgId, orgId), inArray(dependencyLines.id, lineIds)));
  return rows.map(toDependencyLine);
}

/** The same batched lookup, narrowed to third-party lines. See docs/dependencies.md §184. */
export async function listThirdPartyDependencyLinesByIds(
  tx: TenantTx,
  orgId: string,
  lineIds: string[]
): Promise<ThirdPartyLine[]> {
  if (lineIds.length === 0) return [];
  const rows = await tx
    .select()
    .from(dependencyLines)
    .where(
      and(
        eq(dependencyLines.orgId, orgId),
        inArray(dependencyLines.id, lineIds),
        sql`NOT EXISTS (
          SELECT 1 FROM ${dependencyLineProducers} p
          WHERE p.org_id = ${dependencyLines.orgId}
            AND p.ecosystem = ${dependencyLines.ecosystem}
            AND p.coordinate = ${dependencyLines.coordinate}
        )`
      )
    );
  const out: ThirdPartyLine[] = [];
  for (const row of rows) {
    // The row survived the anti-join, so there is no declaration for its coordinate. That FACT is
    // what the constructor takes — it is not re-derived from a column, because there is no longer a
    // column to re-derive it from.
    const line = asThirdPartyLine(toDependencyLine(row), { hasDeclaredProducer: false });
    if (line !== null) out.push(line);
  }
  return out;
}
