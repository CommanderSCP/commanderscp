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
 * deliberately cannot reach the `latest_*` observation columns, which belong to M21.4 detection.
 * Two different ingresses writing one row must not be able to clobber each other's fields. It
 * cannot reach the PRODUCER DECLARATION either, and since drizzle/0068 that is structural rather
 * than a matter of this SET list: the declaration is a row of `dependency_line_producers`, a table
 * `inventory-ingestion.ts` does not import.
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

/**
 * DECLARE the component that produces this COORDINATE — the ONE way a coordinate becomes internal
 * (ADR-0032 §7/§7e, ADR-0030 §2). Idempotent: re-declaring restates the producer and re-stamps the
 * provenance.
 *
 * IT IS A SEPARATE VERB FROM `upsertDependencyLine`, AND THAT IS THE WHOLE PROPERTY. If ingestion
 * could pass a producer alongside a coordinate it just observed, "declared, never inferred" would
 * survive only as long as every ingestion call site remembered to leave the field unset — and this
 * repo has already shipped a provenance label that went false the moment its matcher covered a
 * second case (charter principle 6). The split removes the capability FROM INGESTION rather than
 * guarding it there, and since 0068 it is stronger than a split verb: the producer lives in a
 * DIFFERENT TABLE that `inventory-ingestion.ts` does not import at all.
 *
 * THE GRAIN IS THE COORDINATE. It used to be the line, i.e. one major; see 0068's header for why
 * that re-armed dependency confusion at every major bump.
 *
 * WHAT THIS FUNCTION DOES NOT DO, and must not be read as doing: it does not make the declaration
 * HUMAN, it does not check that `producerObjectId` names a live in-org `component`, and it does not
 * clear the affected lines' heads. Those are the ROUTE's obligations (`routes/dependency-producers.ts`)
 * — the org-unbound `objects(id)` reference here is the mitigation 0061's header said an eventual
 * route owed, and `resetLineHead` below is the head half.
 */
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

/**
 * RETRACT the declaration for one coordinate, returning the row that was removed, or `null` when
 * there was none.
 *
 * Retraction is a DELETE rather than a `retracted_at` flag, which is why 0068 grants DELETE on this
 * table and 0061 deliberately withheld it on `dependency_lines`. The row's EXISTENCE is the
 * declaration; a tombstone column would put the table back in the business of representing a
 * half-state, which is exactly the shape the retired `dependency_lines_internal_is_declared` CHECK
 * existed to police.
 *
 * IT DOES NOT CLEAR THE HEADS, AND IT MUST BE CALLED WITH SOMETHING THAT DOES. See `resetLineHead`.
 */
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

/**
 * The coordinates a set of components is DECLARED to produce — the FIRST hop of M21.4's
 * internal-release derivation, served by `dependency_line_producers_org_producer`.
 *
 * This replaces the partial index on the old column. It returns DECLARATIONS, not lines: the caller
 * resolves each coordinate's lines with {@link listDependencyLinesForCoordinates}, whose predicate
 * is a prefix of `dependency_lines_identity`.
 */
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

/**
 * The declarations for a SET OF COORDINATES in one round trip — the inventory read surface's batched
 * producer hydration (`dependency-read-surface.ts`): a page of lines names its coordinates, and each
 * row's `producer` is the declaration for that row's `(ecosystem, coordinate)`, or none.
 *
 * `IN` over `coordinate` inside the `org_id` prefix of the primary key, then the ecosystem is
 * matched in JS — coordinates are ecosystem-native and rarely collide across ecosystems, and a
 * tuple `IN` buys nothing over that here. Byte equality on the coordinate, as everywhere in this
 * table. Empty keys ⇒ empty result, no scan.
 */
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

/**
 * EVERY MAJOR LINE of one coordinate — the set a producer declaration covers, and the set whose
 * heads both verbs clear.
 *
 * One index descent on the `(org_id, ecosystem, coordinate)` PREFIX of `dependency_lines_identity`.
 * An EMPTY result is ordinary and correct: a producer may be declared before any consumer's
 * manifest has minted a line, which is exactly what per-coordinate grain exists to make
 * representable.
 */
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
/**
 * The CloudEvents `type` emitted when a line's head ADVANCES (M21.5). Declared here — beside the
 * only function that can emit it — and consumed by `dependencies/bump-dispatch.ts`'s router, so the
 * producer and the consumer read one constant rather than two string literals.
 */
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

/**
 * THE ONE WRITER OF THE `latest_*` TRIO — both M21.4 ingresses (internal detection and the
 * third-party poll) reach those columns only through here.
 *
 * It writes only that trio, so it cannot disturb the identity columns or the declared producer
 * link. What is new in M21.4 is that it also DECIDES rather than obeying: every rule about what
 * `latest_version`/`latest_digest` MEAN is applied here, once, instead of at each caller — because
 * the two callers demonstrably meant different things by them. `line-head.ts` states the meaning in
 * full; the FOUR rules enforced here are:
 *
 *  0. THE INGRESS MUST OWN THE LINE — THIS ONE, not a line of its category. A `third_party` write is
 *     refused while any producer is declared for the coordinate; an `internal` write is refused
 *     while none is, AND refused while the standing declaration names a DIFFERENT component than the
 *     one the release was derived from (`line_transferred`). See `ingress` below — this is the only
 *     one of the four that is about WHO is writing rather than about the version, and it is
 *     therefore decided FIRST: "you may not write here" dominates "that version is behind the head".
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
 *
 * ============================================================================================
 * AND THAT SAME LOCK IS WHAT MAKES RULE 0 A RULE RATHER THAN A NARROWER WINDOW
 * ============================================================================================
 * The declaration is read AFTER the `FOR UPDATE` succeeds and in a separate statement, which under
 * READ COMMITTED (the isolation `withTenantTx` runs at) takes a snapshot at statement start — i.e.
 * after the lock. Both producer verbs call `resetLineHead` on every line of the coordinate in the
 * SAME transaction as the declaration write, so they take the same row lock. The two orders are
 * therefore both correct and there is no third:
 *
 *   - the verb commits FIRST: this call blocks on `FOR UPDATE`, then reads the committed
 *     declaration and refuses. Nothing is written and no bump event is emitted.
 *   - this call gets the lock FIRST: the verb blocks, this head write lands on a line that really
 *     was third-party at that instant, and the verb's own `resetLineHead` then clears it — which is
 *     exactly what `resetLineHead` exists to do.
 *
 * A coordinate with NO line row yet is covered too: there is nothing for the verb to reset, and
 * this function refuses on the declaration alone.
 */
export async function recordDependencyLineHead(
  tx: TenantTx,
  orgId: string,
  input: ObserveDependencyLineHeadInput,
  /**
   * WHICH INGRESS IS ASKING — REQUIRED, and there is deliberately no default (an omitted argument
   * does not compile). A default would mean "whatever the last caller to be written meant", which
   * is precisely the per-caller divergence `line-head.ts` was created to end; and defaulting to
   * either value silently authorizes the other ingress's race.
   *
   * It cannot be the {@link ThirdPartyLine} brand instead: that brand is minted in an EARLIER
   * transaction, so it carries a compile-time fact about a world that may have changed by the time
   * this transaction opens. {@link HeadWriteIngress} carries the caller's claim; the declaration
   * read below carries the world; the disagreement between them is the refusal.
   *
   * AND THE `internal` ARM MUST NAME ITS PRODUCER (a required field of that arm, so it cannot be
   * omitted any more than the argument itself can). The claim being checked is "this component's
   * production release owns this line", and a claim with no subject can only be checked against the
   * coordinate's category — which is how a TRANSFERRED coordinate's former producer went on writing
   * heads and fanning bumps out of them.
   */
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

  // RULE 0 — re-read the producer state HERE, under the lock taken one statement ago, and compare
  // it with what the caller claims to be. The point of the whole exercise is that this read happens
  // inside the writing transaction: every earlier read of the same fact (the poll's work-list SQL,
  // `asThirdPartyLine`, internal detection's phase-1 producer query) is a read of a world the
  // network round trip between then and now gave an operator time to change.
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
  const after = toDependencyLine(row);

  // ============================================================================================
  // AND THIS IS WHERE THE BUMP STARTS — EMITTED AT THE WRITE DOOR, NOT AT EACH INGRESS (M21.5)
  // ============================================================================================
  // "A new head on a subscribed line produces a bump" is the whole point of M21.5, and it has to be
  // true of BOTH ingresses and of any third one. Emitting it here rather than in
  // `internal-release-detection.ts` and `version-poll.ts` is the same argument that put the head
  // RULES here (this function's own header; ADR-0032 §7b's closing line): a fact applied by each
  // caller has one place per caller to regress, and this file exists precisely because the two
  // callers demonstrably disagreed about what these columns meant. A future ingress — an air-gap
  // feed import, an operator-supplied head — dispatches a bump by construction rather than by
  // remembering to.
  //
  // ONLY ON `advanced`, never on `restated`. A restatement is the same point on the line
  // re-observed: the daily poll re-reads an unchanged head every day for every third-party line, and
  // enqueuing a job for each of those is a per-day-per-dependency job for work already done. Nothing
  // is lost — a component still declaring an older version is picked up by the next advance, and the
  // dispatch job re-derives from the row rather than from the event.
  //
  // The event rides the ORDINARY OUTBOX in this same transaction (DESIGN §8), so it is atomic with
  // the head write: a head that moved cannot fail to notify, and an event cannot name a head whose
  // transaction rolled back. Its consumer is a ROUTER on `domain-events`
  // (`dependencies/bump-dispatch.ts`), never a second worker on that queue — see `events/pgboss.ts`'s
  // `DomainEventRouter` for why that distinction is load-bearing.
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

/**
 * THE ONE EXCEPTION TO "`recordDependencyLineHead` IS THE ONLY WRITER OF THE `latest_*` TRIO", and
 * it is named here rather than discovered (ADR-0032 §7e, proposal §12.3.2).
 *
 * It sets the trio back to NULL — "not observed", which is exactly the state — and it is reachable
 * ONLY from the two producer verbs. It is deliberately IN THIS MODULE, beside the writer whose
 * monopoly it qualifies, under the same `FOR UPDATE`: a second module writing these columns is how
 * two ingresses come to disagree about what they mean, which is the failure `line-head.ts` exists to
 * have prevented once already.
 *
 * ==========================================================================================
 * WHY BOTH VERBS MUST CALL IT — AND WHY THIS IS A SECURITY FIX, NOT A TIDINESS ONE
 * ==========================================================================================
 * A head, once written, has NO RESET PATH: `recordDependencyLineHead` refuses backward movement
 * (`evaluateHeadMovement`), §7b clause 3's bounded exception rescues only a stored value that is not
 * on the line as defined now, and no API resets the column.
 *
 *  - RETRACTION must clear it. The coordinate returns to third-party polling carrying a head that
 *    the ORG'S OWN releases put there. In the ordinary case — internal `2.7.0` against upstream
 *    `2.3.1` — the line is WEDGED: the poll refuses every real public version until upstream passes
 *    `2.7.0`, and refuses it as `behind_head`, which reads as normal operation.
 *
 *    And a wedge is the mild reading. `latest_version` IS NOW A SECURITY-GATE INPUT: the M22 vendor
 *    rule grants a scan pass when a component is on the latest of its major line. A stale head left
 *    over from the internal era, on a coordinate that is third-party again, can therefore grant a
 *    VENDOR PASS AGAINST A VERSION NO REGISTRY EVER PUBLISHED. That is a gate answering yes on
 *    evidence the world never produced, which is a different class of defect from a stalled poll.
 *
 *  - DECLARATION must clear it too, symmetrically. A poisoned public head — the stranger's `9.9.9`
 *    — would otherwise survive the very declaration that exists to undo the confusion, and internal
 *    detection could never move the head back down to the org's real `2.1.0`, because that is
 *    backward movement and the door refuses it. Clearing is what makes the declaration an actual
 *    remedy rather than a change of ingress with the damage left in place.
 *
 * ==========================================================================================
 * WHAT CLEARING DOES *NOT* DO — AND WHAT DOES IT (corrected 2026-08-17, measured)
 * ==========================================================================================
 * This function used to be described as making the remedy DURABLE. It does not, and could not: it
 * clears the head STANDING AT THIS INSTANT, and both ingresses straddle a transaction boundary, so
 * an in-flight poll can hold an answer it fetched BEFORE the declaration and write it AFTER. That
 * was measured end to end: a public `2.99.0` landed on a just-declared internal line, fanned a bump
 * out, and became unfixable — the poll's work-list no longer visits an internal line, and the
 * legitimate internal `2.1.0` is refused as `behind_head`.
 *
 * DURABILITY IS RULE 0 AT THE WRITE DOOR, not this clearing: `recordDependencyLineHead` takes the
 * ingress it serves and re-reads the declaration under the same `FOR UPDATE`. The two are
 * complementary and neither is redundant — this clears what was written BEFORE the declaration,
 * rule 0 refuses what would be written AFTER it.
 *
 * NO EVENT IS EMITTED. `DEPENDENCY_LINE_HEAD_ADVANCED_EVENT` means "a newer version exists"; a reset
 * means "we no longer know", and dispatching bumps off a clearing would be a fan-out from an absence.
 *
 * Returns the head as it stood BEFORE, so the caller's Decision and its response can report what was
 * discarded rather than only that something was.
 */
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
 * The SQL `NOT EXISTS` is what makes barrier 1 real and `asThirdPartyLine` re-reads the same fact
 * for barrier 2, so removing either alone still leaves the other refusing.
 *
 * SINCE drizzle/0068 THE PREDICATE IS AN ANTI-JOIN, not `produced_by_object_id IS NULL`, and the
 * change is the point of the migration rather than a mechanical port. The declaration is keyed by
 * `(org_id, ecosystem, coordinate)`, so a BRAND-NEW MAJOR of a declared coordinate is excluded from
 * the poll the instant ingestion mints it — under the old per-line column that row carried a NULL
 * producer nobody had filled in, and the poll handed the org's own coordinate to a public index.
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
