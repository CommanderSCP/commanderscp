import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import {
  type ComponentDependency,
  type DeclareLineProducerInput,
  type DependencyLine,
  type DependencyLineKey,
  type ObserveDependencyLineHeadInput,
  type UpsertComponentDependencyInput,
  type UpsertDependencyLineInput
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { componentDependencies, dependencyLines } from "../db/schema.js";
import {
  asThirdPartyLine,
  evaluateHeadMovement,
  type HeadRefusalReason,
  type ThirdPartyLine
} from "./line-head.js";

/**
 * M21.2 — the DEPENDENCY INVENTORY repo (ADR-0032 §3/§4/§5/§7).
 *
 * Every function here is a SINGLE-HOP index lookup or a single-row write. That is not an accident
 * of the current feature set, it is the boundary that justifies the inventory being tables at all
 * (ADR-0032 §3): the moment a transitive traversal appears on this path, the graph representation
 * becomes necessary again and the measured `impact-of` recursive-CTE hazard applies. There is
 * deliberately no `listTransitiveDependencies`, no recursive CTE, and no reachability walk in this
 * file — and `dependency-inventory.integration.test.ts` pins that absence with a source-level census
 * rather than trusting the intention.
 *
 * NOTHING HERE WRITES A RELATIONSHIP. Package dependencies mint no `depends_on` edge (ADR-0032 §5):
 * that type is the wave-plan toposort input and the `impact-of`/`blast-radius` default relType, a
 * cycle among co-placed targets is a hard plan-compile error, and package graphs routinely contain
 * cycles. `relationships` is not imported by this module, which is the enforcement.
 *
 * All reads and writes run inside `withTenantTx`, so the `org_isolation` RLS policy on both tables
 * is the outer barrier and the explicit `eq(*.orgId, orgId)` predicates below are the inner one —
 * DESIGN §4.2's "cross-tenant leakage requires two independent failures".
 */

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
    producedByObjectId: row.producedByObjectId,
    producedByDeclaredAt: row.producedByDeclaredAt?.toISOString() ?? null,
    producedByDeclaredByObjectId: row.producedByDeclaredByObjectId,
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

/**
 * `tag_pattern` is meaningful for `oci` ONLY. The four language ecosystems carry their own version
 * grammar, so a tag pattern on one of them would be a field nothing reads that a later parser could
 * mistake for configuration. Normalised to NULL at the one write choke point rather than validated
 * at each call site.
 */
function tagPatternFor(
  ecosystem: DependencyLineKey["ecosystem"],
  tagPattern: string | undefined
): string | null {
  return ecosystem === "oci" ? (tagPattern ?? null) : null;
}

/**
 * Insert-or-return the line identified by `(orgId, ecosystem, coordinate, major)`.
 *
 * The conflict target is the NATURAL KEY, never a URN — `graph/urn.ts`'s `slugify` collapses
 * `@acme/lib`, `acme/lib` and `acme-lib` into one slug, so a URN-keyed upsert would silently merge
 * three different packages into one subscription target and then 409 (ADR-0032 §3, Context 2). The
 * coordinate goes in verbatim, case preserved; no normalisation is applied anywhere on this path.
 *
 * The update branch touches ONLY `tag_pattern` (and only when a non-null one is supplied). It
 * deliberately cannot reach `produced_by_*` — internal-ness is declared through
 * `declareDependencyLineProducer` — nor the `latest_*` observation columns, which belong to M21.4
 * detection. Two different ingresses writing one row must not be able to clobber each other's
 * fields.
 *
 * NOTHING BUT THE LITERAL SET LIST BELOW ENFORCES THAT — no constraint, no trigger, no column-level
 * grant. Widening the set by one key is a one-line change that type-checks and that every
 * round-trip test still passes, so the property is pinned behaviourally instead: see "manifest
 * re-ingestion cannot clobber a declared producer or an observed head" in
 * `dependency-inventory.integration.test.ts`. That test is the guard; this paragraph is not.
 */
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

/**
 * DECLARE (or retract) the component/service that produces this line — the ONE way a line becomes
 * internal (ADR-0032 §7, ADR-0030 §2).
 *
 * It is a separate verb from `upsertDependencyLine` on purpose. If ingestion could pass a producer
 * alongside a coordinate it just observed, "declared, never inferred" would survive only as long as
 * every ingestion call site remembered to leave the field unset — and this repo has already shipped
 * a provenance label that went false the moment its matcher covered a second case (charter principle
 * 6). Splitting the verb removes the capability FROM INGESTION rather than guarding it there.
 *
 * `declaredAt`/`declaredByObjectId` move with the link and are cleared together with it, which the
 * `dependency_lines_internal_is_declared` CHECK also enforces at the database level: all three
 * columns are NULL or all three are set, so a producer with no declaration and no principal behind
 * it cannot be stored at all.
 *
 * What that CHECK does NOT do — because the split above is the strong half and this is the weak one
 * — is make the declaration HUMAN. This function stamps all three columns unconditionally, so the
 * CHECK never fires on this path; it fires on a raw-SQL half-write or on a future verb that forgets
 * a column. "A human asserted this" is a property of this function's call sites and of the authz an
 * M21.3 route puts in front of it (0060's "INTERNAL vs THIRD-PARTY" header states the same split).
 */
export async function declareDependencyLineProducer(
  tx: TenantTx,
  orgId: string,
  input: DeclareLineProducerInput
): Promise<DependencyLine> {
  const retracting = input.producedByObjectId === null;
  const [row] = await tx
    .update(dependencyLines)
    .set({
      producedByObjectId: input.producedByObjectId,
      producedByDeclaredAt: retracting ? null : new Date(),
      producedByDeclaredByObjectId: retracting ? null : input.declaredByObjectId,
      updatedAt: new Date()
    })
    .where(and(eq(dependencyLines.orgId, orgId), eq(dependencyLines.id, input.lineId)))
    .returning();
  if (!row) throw new Error(`dependency line not found: ${input.lineId}`);
  return toDependencyLine(row);
}

/** What {@link recordDependencyLineHead} did, and why — the caller puts this in its Decision, so a
 *  refusal is as legible as a move (charter principle 6). `line` is the row as it stands AFTER the
 *  call in both branches, so a refused caller can report the head that actually survived. */
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

/**
 * THE ONE WRITER OF THE `latest_*` TRIO — both M21.4 ingresses (internal detection and the
 * third-party poll) reach those columns only through here.
 *
 * It writes only that trio, so it cannot disturb the identity columns or the declared producer
 * link. What is new in M21.4 is that it also DECIDES rather than obeying: every rule about what
 * `latest_version`/`latest_digest` MEAN is applied here, once, instead of at each caller — because
 * the two callers demonstrably meant different things by them. `line-head.ts` states the meaning in
 * full; the three rules enforced here are:
 *
 *  1. THE VERSION MUST BE ON THIS LINE — the same major line at the line's own precision, and for
 *     `oci` the same variant `tag_pattern` names. A `1.9.9` on the `2` line, or a plain tag on an
 *     `-alpine` line, is refused rather than written.
 *  2. THE HEAD NEVER MOVES BACKWARDS. A hotfix on an older minor of the same line is a real release
 *     and is not its head: it is refused with `behind_head`, and it belongs in the caller's
 *     Decision, which is where "this release happened and the head did not move" is recorded.
 *  3. THE DIGEST BELONGS TO THE VERSION. It is written from the SAME observation as the version and
 *     is never inherited across a version change, so the row cannot assert a (tag, digest) pair that
 *     never existed in any registry. A restatement of the SAME version may fill a digest in, and a
 *     null there does not erase the digest already resolved for that same version — nothing is
 *     claimed that was not seen, and nothing true is discarded.
 *
 * The row is taken FOR UPDATE first, because the decision reads the current head and both ingresses
 * can run at once (a daily tick, an accepted change): reading without the lock would let two
 * transactions each decide "I am ahead" against the same stale value and let the loser land last.
 */
export async function recordDependencyLineHead(
  tx: TenantTx,
  orgId: string,
  input: ObserveDependencyLineHeadInput
): Promise<RecordDependencyLineHeadOutcome> {
  const [current] = await tx
    .select()
    .from(dependencyLines)
    .where(and(eq(dependencyLines.orgId, orgId), eq(dependencyLines.id, input.lineId)))
    .limit(1)
    .for("update");
  if (!current) throw new Error(`dependency line not found: ${input.lineId}`);
  const before = toDependencyLine(current);

  const movement = evaluateHeadMovement(before, input.latestVersion);
  if (!movement.moves) {
    return { recorded: false, reason: movement.reason, detail: movement.detail, line: before };
  }

  // THE PAIR MOVES TOGETHER. On an ADVANCE the digest is whatever THIS observation resolved —
  // including `null`, which honestly says "this version's bytes were not resolved" and is the only
  // way the previous version's digest cannot survive beside a new tag. On a RESTATEMENT the stored
  // digest already belongs to this same version, so a null leaves it and a non-null (a repointed
  // tag) replaces it.
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
  return {
    recorded: true,
    movement: movement.movement,
    detail: movement.detail,
    line: toDependencyLine(row)
  };
}

/**
 * Insert-or-update one DECLARATION read out of one dependency manifest.
 *
 * Keyed on `(orgId, componentObjectId, lineId, manifestPath)` — the manifest path is part of the
 * identity because one component can legitimately declare the same line from two manifests (two
 * Dockerfiles; a root and a workspace `package.json`), and collapsing them would make a prune of one
 * silently delete the other's declaration.
 *
 * `createdAt` is NOT in the update set: it records when this declaration was first seen, and
 * re-observing an unchanged manifest must not reset it. `observedAt` IS, because that is the "we
 * looked" timestamp. Both halves are pinned by "re-observing preserves createdAt and advances
 * observedAt" in `dependency-inventory.integration.test.ts` — as with the line upsert above, the
 * absence of a key from a SET list is enforced by nothing except the literal.
 */
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

/**
 * FORWARD lookup — "what does component C declare?" (ADR-0032 §4). One index descent on the primary
 * key's `(org_id, component_object_id)` prefix. Optionally narrowed to a single dependency manifest.
 *
 * DIRECT DECLARATIONS ONLY. This returns what C's own manifests say and nothing further; there is no
 * option, flag or overload that walks into the returned lines' own dependencies. The transitive
 * closure is an SBOM by another name and ADR-0013 keeps SBOM bytes out of SCP deliberately.
 */
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

/**
 * REVERSE lookup — "which components declare line L?" (ADR-0032 §4). One index descent on
 * `component_dependencies_org_line`. This is the fan-out list a dependency subscription resolves
 * against, and it is single-hop for the same reason as above: the subscribers of L are the
 * components that DECLARE L, never the components that transitively reach it.
 */
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

/**
 * Prune the declarations for ONE (component, REPOSITORY, dependency manifest) down to exactly
 * `keepLineIds` — the "the manifest dropped a dependency" path, and the reason
 * `component_dependencies` carries a DELETE grant while `dependency_lines` does not (0060 header;
 * the precedent is 0050, which added `source_mappings`' DELETE grant for the same "the declaration
 * went away" reason).
 *
 * THE SCOPE IS THE EVIDENCE, and it has three parts because a caller only ever has evidence about
 * all three:
 *
 *  - ONE COMPONENT, because this is that component's inventory;
 *  - ONE REPOSITORY (`observedRepo`), because an ingestion pass reads exactly one, and "there is no
 *    `package.json` here" is a statement about the repo that was read and about no other. Without
 *    this conjunct a pass over a component fed by two repositories deleted the OTHER repository's
 *    declarations on every release — silently unsubscribing the component, since
 *    `listSubscribedComponentLines` derives subscription from these rows (drizzle/0063);
 *  - ONE MANIFEST PATH, because a `go.mod` re-read must never prune what a `Dockerfile` declared —
 *    a run that parsed one manifest would otherwise empty the inventory one ecosystem at a time.
 *
 * A row whose `observed_repo` is NULL is matched by NO repository and is therefore never pruned.
 * That is deliberate rather than incidental: the column records where a declaration came from, and
 * a row that never recorded one cannot be shown stale by evidence from anywhere. Stale and visible
 * beats deleted and silent; a re-observation stamps the column and the row becomes prunable again.
 *
 * Returns the number of rows removed so a caller can tell a real prune from a no-op.
 *
 * An EMPTY `keepLineIds` means "this manifest now declares nothing" and removes every row for it —
 * which is a legitimate outcome, so it is expressed rather than short-circuited. `notInArray` with an
 * empty list is not portable-safe, hence the explicit branch.
 */
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

/**
 * The lines named by a set of ids, in one round trip — the hydration step after either single-hop
 * lookup above. Returns nothing for an empty id list rather than scanning the org.
 *
 * This is a BATCHED POINT LOOKUP, not a traversal: the ids come from rows the caller already holds,
 * and the function performs no further expansion of what it returns.
 */
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

/**
 * The same batched point lookup, NARROWED IN SQL TO THIRD-PARTY LINES — the poll's only door onto
 * `dependency_lines` (ADR-0032 §7's ingress split).
 *
 * An INTERNAL line (`produced_by_object_id IS NOT NULL`) has its head DERIVED from the org's own
 * production releases and must never be asked of a public index: a stranger's package sharing the
 * coordinate would otherwise overwrite the org's own `2.1.0` with `9.9.9` and every subscriber would
 * be bumped onto it. That is dependency confusion, delivered by a background job on a timer.
 *
 * TWO INDEPENDENT BARRIERS, deliberately, because a filter is precisely what a caller forgets:
 *   1. this predicate, so an internal line is never even loaded into the work-list; and
 *   2. the {@link ThirdPartyLine} brand this returns — `queryLineHead` accepts nothing else, so a
 *      future caller that hydrates lines some other way does not compile rather than silently
 *      polling.
 * `isNull` is what makes barrier 1 real and `asThirdPartyLine` re-reads the same column for barrier
 * 2, so removing either alone still leaves the other refusing.
 */
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
        isNull(dependencyLines.producedByObjectId)
      )
    );
  const out: ThirdPartyLine[] = [];
  for (const row of rows) {
    const line = asThirdPartyLine(toDependencyLine(row));
    if (line !== null) out.push(line);
  }
  return out;
}
