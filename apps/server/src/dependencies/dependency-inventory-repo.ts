import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
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

/**
 * Record the head of a line as OBSERVED by M21.4 detection. Writes only the `latest_*` trio, so it
 * cannot disturb the identity columns or the declared producer link.
 *
 * NOTE for the detection slice: this is an unconditional write of observation state, NOT a Decision.
 * Any per-tick VERDICT built on top of it must go through `insertDecisionIfChanged` — a daily poll
 * re-writing a byte-identical "no new version" Decision per dependency reproduces the measured
 * 1.44 GB/day amplification exactly (ADR-0032 §7, ADR-0024).
 */
export async function recordDependencyLineHead(
  tx: TenantTx,
  orgId: string,
  input: ObserveDependencyLineHeadInput
): Promise<DependencyLine> {
  const now = new Date();
  // A mutable tag is not an identity (ADR-0032 §7) — for `oci` the digest is what the version claim
  // actually means. An OMITTED `latestDigest` leaves the stored one alone (the key is absent from
  // the SET list, not set to undefined, which drizzle would render as a literal NULL); an EXPLICIT
  // `null` clears it, which is what a language ecosystem supplies.
  //
  // Both branches are pinned by "an omitted digest leaves the stored one alone, an explicit null
  // clears it" in `dependency-inventory.integration.test.ts`. The inverted form
  // (`{ latestDigest: input.latestDigest ?? null }`) type-checks identically, and under it a
  // language-ecosystem poll that omits the field would silently erase an image line's digest.
  const digestPatch = input.latestDigest === undefined ? {} : { latestDigest: input.latestDigest };
  const [row] = await tx
    .update(dependencyLines)
    .set({
      latestVersion: input.latestVersion,
      ...digestPatch,
      latestObservedAt: now,
      updatedAt: now
    })
    .where(and(eq(dependencyLines.orgId, orgId), eq(dependencyLines.id, input.lineId)))
    .returning();
  if (!row) throw new Error(`dependency line not found: ${input.lineId}`);
  return toDependencyLine(row);
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
  const observedAt = new Date();
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
 * Prune the declarations for ONE (component, dependency manifest) down to exactly `keepLineIds` —
 * the "the manifest dropped a dependency" path, and the reason `component_dependencies` carries a
 * DELETE grant while `dependency_lines` does not (0060 header; the precedent is 0050, which added
 * `source_mappings`' DELETE grant for the same "the declaration went away" reason).
 *
 * Scoped to one manifest path deliberately. A component's `go.mod` re-read must never prune what its
 * `Dockerfile` declared: an ingestion run that parsed only one manifest would otherwise delete every
 * declaration from the manifests it did not read, and the inventory would silently empty itself one
 * ecosystem at a time. Returns the number of rows removed so a caller can tell a real prune from a
 * no-op.
 *
 * An EMPTY `keepLineIds` means "this manifest now declares nothing" and removes every row for it —
 * which is a legitimate outcome, so it is expressed rather than short-circuited. `notInArray` with an
 * empty list is not portable-safe, hence the explicit branch.
 */
export async function pruneComponentDependencies(
  tx: TenantTx,
  orgId: string,
  input: { componentObjectId: string; manifestPath: string; keepLineIds: string[] }
): Promise<number> {
  const scope = and(
    eq(componentDependencies.orgId, orgId),
    eq(componentDependencies.componentObjectId, input.componentObjectId),
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
