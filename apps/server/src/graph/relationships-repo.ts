import { and, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Relationship } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects, relationships } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from "../pagination.js";
import {
  assertContainmentDepthAdmits,
  containmentChain,
  containmentParentChainForDoor,
  type ChainEntry
} from "./containment.js";
import { computeRelationshipContentHash } from "./content-hash.js";
import { requireRelationshipType } from "./type-registry-repo.js";
import { validateProperties } from "./property-validation.js";
import { appendAuditEvent } from "../audit/audit-repo.js";
import { policyReachFor, recordGovernanceReachChange } from "../governance/governance-reach.js";
import { assertMayWriteGovernanceLabels } from "../governance/governance-labels.js";
import {
  assertMayJoinRoleBearingSubject,
  assertOrgRetainsAdministrativeFloor
} from "../authz/role-binding-door.js";
import { inArray } from "drizzle-orm";
import { eventBus } from "../events/event-bus.js";
import { ensureFederationSelf } from "../federation/self-repo.js";
import { appendJournalEntry } from "../federation/journal-repo.js";
import type { FederationImportContext } from "./objects-repo.js";

/**
 * M20.3 (ADR-0031 §4) — does either endpoint of an edge stay inside its own security domain?
 *
 * Deliberately reads endpoints **including soft-deleted ones** (no `deletedAt` predicate): the one
 * caller is `deleteRelationship`, which frequently runs while an endpoint is itself being torn down,
 * and resolving a deleted endpoint to "not domain-local" would leak precisely at teardown — the
 * moment a `relationship_tombstone` naming its id would otherwise cross.
 *
 * One query for both endpoints; a self-edge collapses to a single row, which `.some()` handles
 * without a special case.
 */
async function eitherEndpointIsDomainLocal(
  tx: TenantTx,
  orgId: string,
  fromId: string,
  toId: string
): Promise<boolean> {
  const rows = await tx
    .select({ domainLocal: objects.domainLocal })
    .from(objects)
    .where(and(eq(objects.orgId, orgId), inArray(objects.id, [fromId, toId])));
  return rows.some((row) => row.domainLocal);
}

function toRelationship(row: typeof relationships.$inferSelect): Relationship {
  return {
    id: row.id,
    orgId: row.orgId,
    typeId: row.typeId,
    fromId: row.fromId,
    toId: row.toId,
    properties: row.properties as Record<string, unknown>,
    labels: row.labels as Record<string, unknown>,
    originDomainId: row.originDomainId,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null
  };
}

async function requireLiveObject(tx: TenantTx, orgId: string, id: string, label: "from" | "to") {
  const row = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.id, id), eqOp(t.orgId, orgId), isNullOp(t.deletedAt))
  });
  if (!row) throw badRequest(`${label} object '${id}' does not exist in this org`);
  return row;
}

/**
 * The 409 for "the `to` side already has an incoming edge of this type" — shared by BOTH the
 * app-level `assertCardinality` pre-check AND the DB-index race backstop in `createRelationship`'s
 * catch block, so a component that already has a service surfaces the SAME message whichever guard
 * fires (M12 P5b — the migration-0022 partial unique index caught a concurrent create with the
 * misleading generic "relationship id already exists" before this).
 */
function cardinalityToSideConflict(cardinality: string, typeId: string, toId: string) {
  return conflict(
    `cardinality '${cardinality}' violated: '${toId}' already has an incoming '${typeId}' relationship`
  );
}

/**
 * The mirror of `cardinalityToSideConflict` for the FROM side — shared by the app-level
 * `assertCardinality` pre-check and by the migration-0049 index race backstop, so a component that
 * already has a pipeline surfaces the SAME message whichever guard fires.
 */
function cardinalityFromSideConflict(cardinality: string, typeId: string, fromId: string) {
  return conflict(
    `cardinality '${cardinality}' violated: '${fromId}' already has an outgoing '${typeId}' relationship`
  );
}

/**
 * Which side of the edge each cardinality makes singular. Exhaustive BY CONSTRUCTION: an
 * unrecognised value is absent from this map and `assertCardinality` refuses the write rather than
 * falling through unenforced (`relationship_types.cardinality` is plain `text` with no CHECK
 * constraint, so a typo in a migration is reachable). That silent fall-through is exactly the trap
 * migration 0021 had to design around when `many_to_one` did not exist.
 */
const SINGULAR_SIDES: Record<string, { from: boolean; to: boolean }> = {
  many_to_many: { from: false, to: false },
  one_to_many: { from: false, to: true },
  many_to_one: { from: true, to: false },
  one_to_one: { from: true, to: true }
};

/**
 * Refuses a `contains` edge that would close a containment cycle — **over BOTH containment routes,
 * because containment has two and this check used to walk one.**
 *
 * Before the `assembly` level, a cycle was IMPOSSIBLE by construction: `contains` only ran
 * `service -> component`, and a component has no children. Widening the type makes A-contains-B,
 * B-contains-A expressible for the first time.
 *
 * ## What this used to claim, and what was actually true
 *
 * The previous wording said a cycle "is an infinite walk in the code paths that authorize releases",
 * and named `containmentChain` (policy scope, freeze scope, RBAC scope) and the ADR-0029 binding
 * ladder as the victims. Both halves were wrong, and they were wrong in opposite directions:
 *
 *  - **Not infinite.** Every named consumer is bounded. `graph/containment.ts`'s `containmentChain`
 *    and `authz/resolve.ts`'s `scopeExpandCte` both stop at `CONTAINMENT_WALK_MAX_DEPTH`;
 *    `coordination/binding-resolution.ts`'s ladder stops at `MAX_ANCESTOR_HOPS` (3). A loop costs
 *    them iterations, not termination.
 *  - **Not protected.** `containmentChain` walks `domain_id` AND `contains` (and a placement's pair).
 *    This function walked `contains` alone, so the MIXED loop — one hop of each — was invisible to
 *    it and writable through this door. MEASURED before this change, on the real HTTP doors: create
 *    an assembly A, create a service S with `domainId: A`, then `POST /relationships {contains,
 *    from: S, to: A}` answered **201**, and `S -> A -> S` was in the table. The `domain_id` door
 *    refuses exactly that loop (`graph/containment-parent-authz.ts` calls
 *    `assertRootedContainmentParent`, which checks the WHOLE walk and says so in as many words);
 *    the edge door did not. One concept, two doors, one of them taught.
 *
 * ## What a mixed loop actually costs, since it is not a hang
 *
 * It cannot DETACH a row — adding an edge only adds parents, and `domain_id` parents are kept rooted
 * by their own door, so the org root stays on every chain. What it corrupts is DEPTH.
 * `containmentChain` re-reaches a looped node at every second iteration, keeps the MAXIMUM raw depth
 * per id, and then inverts, so the target of the walk can come out at inverted depth 0 — the value
 * the convention reserves for the org root — with the actual org root ranked BELOW it. Measured on
 * the loop above: the walk ran to the depth bound and `assertRootedContainmentParent`'s `hops`
 * (derived from that inverted depth) reported **1**. That matters because the truncation refusal
 * `hops` feeds exists precisely to fail CLOSED when a walk was cut short and the cycle answer is
 * therefore unproven — near a loop it silently stops firing. Refusing to write the loop is the
 * cheapest place to stop that, and it is the place the other door already stops it.
 *
 * ## Why `containmentChain` rather than a widened hand-rolled walk
 *
 * It is the definition of "what contains this object" that every consumer of this decision reads, so
 * a route added there (route 4 arrived after route 3) is inherited here instead of drifting away from
 * here — the exact failure `graph/containment.ts`'s header records paying for twice. It is also a
 * FIXED one query, where the hand-rolled walk was one round trip PER HOP (1 in the common shape, up
 * to 32), so the widened check is not paid for in latency on the deep shapes. Its bound is the shared
 * `CONTAINMENT_WALK_MAX_DEPTH`, and since nested domains landed the walk from `fromId` covers the
 * container's whole `domain_id` ancestry too — a container under nine stacked domains sits at ten
 * hops, which is why the depth question below is asked here at all. It also skips tombstoned
 * ancestors, matching `scopeExpandCte` — a deleted object is not a container.
 *
 * ## The cycle question AND the depth question — not `assertRootedContainmentParent` wholesale
 *
 * A `contains` edge is containment ROUTE 2 (`graph/containment.ts`), so writing one adds a hop to
 * the `to` row's chain exactly as a `domain_id` write does — and to every row UNDER it. The DOOR
 * INVARIANT (owner ruling 2026-08-18, ADR-0037 Consequences: every live row reaches the org root
 * within the bound over its longest route) therefore has to be enforced here as well as at the
 * `domain_id` doors, with the ONE shared arithmetic in `assertContainmentDepthAdmits`:
 * `hops(container) + 1 + height(to) > bound` refuses. RETIRED REASONING, kept so nobody reinstalls
 * it: an earlier version of this block declined the depth refusal on the grounds that "a ten-hop
 * chain is complete and readable" and that refusing under such a container "would quietly lower a
 * documented limit". The container's chain IS complete at ten hops; the COMPONENT attached to it
 * then sits at hop eleven, and every walk of that component refuses (measured: `containmentChain`
 * threw, `matchPoliciesForTargets` threw, and in an org with any policy at all the reach capture
 * below refused the create with the walk's 409 AFTER the row was written, so the whole thing was
 * already being refused — accidentally, and only when a policy existed). The limit was never
 * lowered; the door now counts the row it writes.
 *
 * The ROOT-REACHABILITY refusal (`assertRootedContainmentParent`'s third) is still deliberately
 * left out here: it would newly reject edges inside an already-stranded subtree, which is the one
 * place an operator still has to work.
 *
 * ## `federationImport` — the cycle question runs, the depth question does not
 *
 * A signed-journal replica reaches this door too (`federation/import-repo.ts` `relationship_upsert`).
 * The depth refusal is carved out for it for the reason the `domain_id` doors state at theirs: the
 * receiving domain does not referee a peer-authored containment — and here the depth of a replica's
 * chain is not even the origin's depth, because `resolveImportDomainId` may have re-parented the
 * replicated rows above it onto THIS org's root. Failure mode, grounded: that importer catches a
 * 400 per ENTRY (the edge is skipped) but re-throws anything else, so a door 400 here would silently
 * drop a peer's edge rather than wedge the channel, and the walk's own 409 — `containmentChain`
 * refusing because the imported CONTAINER is already past the bound — DOES wedge the whole bundle
 * today, independent of this door. Both are named rather than fixed here. The cycle check keeps
 * running on import (a loop is invalid in any org), and its 400 is the one that importer skips.
 */
async function assertContainsEdgeAdmissible(
  tx: TenantTx,
  orgId: string,
  fromId: string,
  toId: string,
  federationImport: FederationImportContext | undefined
): Promise<void> {
  if (fromId === toId) {
    // Kept as its own refusal for the message alone: "an object cannot contain itself" is the
    // diagnosis, where the cycle message below would report the object as its own ancestor.
    throw badRequest("an object cannot contain itself");
  }
  // Local writes take the DOOR's reading of the walk (the walk's 409 for a container already past
  // the bound becomes this door's 400 — `containmentParentChainForDoor`); the import path keeps the
  // raw walk, unchanged from before this door existed (see the module doc above for what that costs).
  let chain: ChainEntry[];
  let hops = 0;
  if (federationImport) {
    chain = await containmentChain(tx, orgId, fromId);
  } else {
    ({ chain, hops } = await containmentParentChainForDoor(tx, orgId, toId, fromId));
  }
  if (chain.some((entry) => entry.id === toId)) {
    throw badRequest(
      `'contains' would create a containment cycle: ${toId} is already an ancestor of ${fromId}`
    );
  }
  if (!federationImport) {
    // The `to` row EXISTS (loaded live by the caller), so its subtree — components under an
    // assembly, placements under a component — moves with it: childIsNew is false.
    await assertContainmentDepthAdmits(tx, {
      orgId,
      childId: toId,
      parentId: fromId,
      hops,
      childIsNew: false
    });
  }
}

async function assertCardinality(
  tx: TenantTx,
  orgId: string,
  typeId: string,
  cardinality: string,
  fromId: string,
  toId: string
): Promise<void> {
  const singular = SINGULAR_SIDES[cardinality];
  if (!singular) {
    // Fail closed. Permitting a write under a cardinality nothing can enforce is worse than a 500:
    // the constraint would read as enforced in the registry and be enforced nowhere.
    throw new Error(
      `relationship type '${typeId}' has unenforceable cardinality '${cardinality}' — no enforcement branch exists for it`
    );
  }
  if (!singular.from && !singular.to) return;

  if (singular.to) {
    // "to" side is singular: this `to_id` may not already have an incoming edge of this type.
    const toClash = await tx.query.relationships.findFirst({
      where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
        andOp(
          eqOp(t.orgId, orgId),
          eqOp(t.typeId, typeId),
          eqOp(t.toId, toId),
          isNullOp(t.deletedAt)
        )
    });
    if (toClash) {
      throw cardinalityToSideConflict(cardinality, typeId, toId);
    }
  }
  if (singular.from) {
    // "from" side is singular: this `from_id` may not already have an outgoing edge of this type.
    const fromClash = await tx.query.relationships.findFirst({
      where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
        andOp(
          eqOp(t.orgId, orgId),
          eqOp(t.typeId, typeId),
          eqOp(t.fromId, fromId),
          isNullOp(t.deletedAt)
        )
    });
    if (fromClash) {
      throw cardinalityFromSideConflict(cardinality, typeId, fromId);
    }
  }
}

export interface CreateRelationshipInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  id?: string;
  typeId: string;
  fromId: string;
  toId: string;
  properties?: Record<string, unknown>;
  /** Mirrors `objects.labels` (schema.ts doc). IaC applies (`iac/plans-repo.ts`) set the
   *  `scp:managed-by`/`scp:stack` markers here, but since drizzle/0068 those are a DESCRIPTIVE
   *  MIRROR: what an apply prunes on is the server-written `relationships.managed_by_stack` column,
   *  which this input deliberately cannot set. */
  labels?: Record<string, unknown>;
  /** M6: see `graph/objects-repo.ts`'s `FederationImportContext` doc comment. */
  federationImport?: FederationImportContext;
  /**
   * IdP GROUP SYNC (`auth/identity-sync.ts`) — exempts this write from the `member_of` subset rule
   * below, and from NOTHING ELSE.
   *
   * A login-time sync has no human actor: the "actor" is the identity provider, so the rule that
   * asks whether the actor already holds what the group confers can never be satisfied. Owner
   * decision (2026-08-28): carve the sync out and move the bar to AUTHORING THE MAPPING
   * (`authz/identity-mapping-door.ts`), because the escalation §2a closes is a principal choosing
   * to join a high-privileged group — and nobody chooses their own claims.
   *
   * DELIBERATELY A SEPARATE FLAG FROM `federationImport`, not a reuse of it. The two exemptions
   * cover different guards for different reasons, and folding this into that boolean would silently
   * widen the federation path the day either rule changes.
   */
  identitySync?: true;
}

export async function createRelationship(
  tx: TenantTx,
  input: CreateRelationshipInput
): Promise<Relationship> {
  const type = await requireRelationshipType(tx, input.typeId);
  const properties = input.properties ?? {};
  const labels = input.labels ?? {};
  validateProperties(type.propertySchema, properties);

  // THE RESERVED GOVERNANCE LABEL NAMESPACE, on the edge table too — see
  // `governance/governance-labels.ts`. No governance decision reads a RELATIONSHIP's labels today
  // (`iac/plans-repo.ts`'s stack-ownership markers are the only reader), and that is exactly why it
  // is guarded here rather than later: the namespace is worth having only if the sentence "a
  // `scp.governance/` key was set by an org-root `policy:write` holder" is true of every labels bag
  // in the system. Left off, the next consumer to read an edge label inherits the same evasion, and
  // nothing about this file would flag it. Relationships have no update verb (create + soft-delete
  // only — see `deleteRelationship`), so this create is the complete census of edge-label writes.
  //
  // The `federationImport` exemption is the one this repo already applies at both choke points, for
  // the same reason: `federation/import-repo.ts`'s replay branch has no try/catch, so a throw there
  // aborts a whole signed bundle rather than one entry.
  if (!input.federationImport) {
    await assertMayWriteGovernanceLabels(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      before: {},
      after: labels,
      subject: `relationship '${type.id}'`
    });
  }

  const fromObj = await requireLiveObject(tx, input.orgId, input.fromId, "from");
  const toObj = await requireLiveObject(tx, input.orgId, input.toId, "to");

  if (type.fromTypes && !type.fromTypes.includes(fromObj.typeId)) {
    throw badRequest(
      `relationship type '${type.id}' does not allow '${fromObj.typeId}' as the 'from' endpoint`
    );
  }
  if (type.toTypes && !type.toTypes.includes(toObj.typeId)) {
    throw badRequest(
      `relationship type '${type.id}' does not allow '${toObj.typeId}' as the 'to' endpoint`
    );
  }

  // THE PAIRWISE RULES THE TYPE REGISTRY CANNOT EXPRESS (migration 0055's header).
  // `relationship_types` holds flat from/to arrays — a cross-product — so widening `contains` to
  // admit the `assembly` level necessarily also admits `assembly -> assembly`, which is not a shape
  // we want. It is refused here, with the containment cycle check, because there is nowhere in the
  // registry to say it.
  if (type.id === "contains") {
    if (fromObj.typeId === "assembly" && toObj.typeId === "assembly") {
      throw badRequest(
        "an assembly cannot contain another assembly — the levels are service -> assembly -> " +
          "component, so nest the components rather than the assemblies"
      );
    }
    await assertContainsEdgeAdmissible(
      tx,
      input.orgId,
      input.fromId,
      input.toId,
      input.federationImport
    );
  }

  // A `member_of` EDGE IS A ROLE GRANT — the no-escalation subset rule, at the choke point.
  //
  // `authz/resolve.ts`'s `subject_expand` walks `member_of` from_id -> to_id, so a role binding held
  // by a GROUP or TEAM resolves for every member. Writing this edge therefore hands `toId`'s
  // authority to `fromId` without a `role_bindings` row ever being written — which routes straight
  // around `docs/authz/role-binding-door.md` §2, the rule that stops a `role_binding:write` holder minting
  // themselves Owner. MEASURED before this guard: an org-root **Operator** — four rungs below
  // Administrator — self-joined a group holding Owner and resolved as Owner, using only the
  // `relationship:write` every org-root principal from Operator upward holds at every object.
  //
  // The both-endpoint `relationship:write` check in `routes/relationships.ts` was designed for
  // exactly this attack and its docblock says so; it only constrains a principal whose
  // `relationship:write` is NARROW, and an org-root binding is not narrow.
  //
  // HERE AND NOT AT THE ROUTE, because this function is where an edge is actually created: IaC apply
  // (`iac/plans-repo.ts` replays the manifest diff's free-form `typeId`) and discovery-accept
  // (`routes/executors.ts`) both reach it without passing through `POST /relationships`. A
  // route-only guard is the shape the campaign-deadline fix in this same programme had to abandon
  // twice. The full reasoning, the exploit chain and what this deliberately does NOT do (removal is
  // a narrowing and stays ungated; bar §1 is not applied here) are in that module's §2a.
  //
  // THIS GUARDS ONE OF TWO ORDERINGS. Joining a group that ALREADY holds a binding is refused here;
  // joining an empty group and having a binding written onto it afterwards is not, and must not be —
  // the empty-group join is every ordinary team membership on the estate. The other ordering is
  // `docs/authz/role-binding-door.md` §2b, on the grant door, and §8 of that module lists what neither closes.
  //
  // AND THERE IS A THIRD ORDERING: NEITHER. Concurrently, this join and that grant each read before
  // the other writes, so a request pair whose every SERIAL order refuses one of the two is admitted
  // twice. `assertMayJoinRoleBearingSubject` takes the org's advisory lock as its own first
  // statement to close that (`docs/authz/role-binding-door.md` §0) — HERE and not at the route, and taken
  // inside the guard and not beside it, because `createRelationship` has thirteen callers.
  //
  // The `federationImport` exemption is the one this file already applies to
  // `assertMayWriteGovernanceLabels` above, for the identical reason: `federation/import-repo.ts`'s
  // replay branch skips only a 400, so a 403 here would abort a peer's whole signed bundle rather
  // than one edge. A replicated membership was decided at the authoring domain's own door.
  //
  // The type guard keeps this off every other relationship write in the system — a `contains`,
  // `owns`, `places` or `depends_on` create short-circuits on a string comparison and costs nothing.
  if (type.id === "member_of" && !input.federationImport && !input.identitySync) {
    await assertMayJoinRoleBearingSubject(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      joinerObjectId: input.fromId,
      groupObjectId: input.toId
    });
  }

  await assertCardinality(tx, input.orgId, type.id, type.cardinality, input.fromId, input.toId);

  // CONTAINMENT ROUTE 2 — a `contains` edge IS a containment parent (`graph/containment.ts` route
  // 2, walked backwards), so creating one changes which policies reach the CHILD, under
  // `relationship:write`. That is weaker and differently held than the `policy:write` that authored
  // those policies — see `governance/governance-reach.ts`.
  //
  // The type guard keeps this off every other relationship write in the system: a `member_of`,
  // `owns`, `places` or `depends_on` create short-circuits on a string comparison and costs nothing.
  const reachBefore =
    input.typeId === "contains"
      ? await policyReachFor(tx, input.orgId, input.toId, input.actorObjectId)
      : null;

  const id = input.id ?? uuidv7();
  const contentHash = computeRelationshipContentHash({
    id,
    orgId: input.orgId,
    typeId: input.typeId,
    fromId: input.fromId,
    toId: input.toId,
    properties,
    labels
  });

  const originDomainId =
    input.federationImport?.originDomainId ??
    (await ensureFederationSelf(tx, input.orgId)).domainId;
  const revision = input.federationImport?.revision ?? 1;

  // ================================================================================================
  // RESURRECTION — re-creating an edge that was previously removed
  // ================================================================================================
  //
  // `relationships_org_type_from_to_key` is a FULL unique constraint on
  // `(org_id, type_id, from_id, to_id)` — NOT partial on `deleted_at IS NULL` — while every removal
  // in this codebase is a SOFT delete. Those two facts together meant an edge could be created
  // exactly once, ever: after a delete the triple was permanently occupied by a tombstone that
  // confers nothing, and re-creating it returned `409 relationship already exists` naming a row the
  // caller cannot see and which grants nothing.
  //
  // MEASURED on the ordinary route, not inferred: join a group, `DELETE /relationships/{id}`, then
  // POST the same edge -> 409. So a person removed from a team could never be re-added, by anyone,
  // for the life of the deployment. Pre-existing and independent of any IdP; found because a
  // directory sync must handle leave-and-rejoin, which is an entirely ordinary event.
  //
  // THE FIX IS RESURRECTION, NOT A PARTIAL INDEX. Making the index partial would allow N tombstones
  // plus one live row for the same triple, so `member_of` history would fan out and every reader
  // joining on the triple would have to learn to pick. Reviving the existing row keeps ONE row per
  // triple — the identity the constraint already asserts — and keeps the tombstone's history.
  //
  // EVERY GUARD ABOVE HAS ALREADY RUN at this point, including the `member_of` subset rule, so a
  // resurrection is authorized exactly as strictly as a first-time create. It deliberately does NOT
  // reuse the tombstone's old properties/labels: this is a new edge that happens to reuse a triple,
  // so the caller's current input wins, and `revision` advances rather than resetting.
  const tombstone = await tx.query.relationships.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNotNull: isNotNullOp }) =>
      andOp(
        eqOp(t.orgId, input.orgId),
        eqOp(t.typeId, input.typeId),
        eqOp(t.fromId, input.fromId),
        eqOp(t.toId, input.toId),
        isNotNullOp(t.deletedAt)
      )
  });
  if (tombstone) {
    const revivedContentHash = computeRelationshipContentHash({
      id: tombstone.id,
      orgId: input.orgId,
      typeId: input.typeId,
      fromId: input.fromId,
      toId: input.toId,
      properties,
      labels
    });
    const [revived] = await tx
      .update(relationships)
      .set({
        deletedAt: null,
        properties,
        labels,
        revision: tombstone.revision + 1,
        contentHash: revivedContentHash
      })
      .where(eq(relationships.id, tombstone.id))
      .returning();
    if (!revived) throw new Error("failed to revive relationship");

    // A RESURRECTION IS A CREATE, AND IT OWES EVERYTHING A CREATE OWES.
    //
    // This branch used to `return` right here, which made reviving an edge the one write in this
    // file that happened invisibly: no audit event, no governance-reach record for a `contains`
    // edge, no journal entry, no event publish. An operator reading the audit log saw the leave and
    // never the rejoin, a subscriber never learned the edge was back, and a peer that had already
    // replicated the tombstone kept it forever. The four calls below are the insert branch's, in
    // the same order and in the SAME transaction — the audit hash chain admits nothing else.
    const revivedIsDomainLocal = fromObj.domainLocal || toObj.domainLocal;
    await appendAuditEvent(tx, {
      orgId: input.orgId,
      actorId: input.actorObjectId,
      action: `relationship.${input.typeId}.create`,
      subjectId: revived.id,
      // `null`, not the tombstone's hash: the state this write starts from is "no edge", because a
      // tombstone confers nothing. Same value the insert branch records.
      beforeHash: null,
      afterHash: revivedContentHash,
      requestId: input.requestId,
      subjectDomainLocal: revivedIsDomainLocal
    });
    if (reachBefore) {
      // Subject is the CHILD — see the matching note in the insert branch.
      await recordGovernanceReachChange(tx, {
        orgId: input.orgId,
        actorObjectId: input.actorObjectId,
        requestId: input.requestId,
        subjectObjectId: input.toId,
        route: "contains",
        detail: {
          edgeAction: "create",
          relationshipId: revived.id,
          containerObjectId: input.fromId
        },
        before: reachBefore,
        subjectDomainLocal: revivedIsDomainLocal
      });
    }
    if (!input.federationImport && !revivedIsDomainLocal) {
      await appendJournalEntry(tx, {
        orgId: input.orgId,
        entryKind: "relationship_upsert",
        contentHash: revivedContentHash,
        payload: {
          id: revived.id,
          orgId: input.orgId,
          typeId: input.typeId,
          fromId: input.fromId,
          toId: input.toId,
          properties,
          labels,
          // THE REVIVED ROW'S OWN provenance and revision, not the `originDomainId`/`revision`
          // computed above for a fresh insert: a resurrection keeps the authoring domain the row
          // was created under, and its revision advances from the tombstone's rather than from 1.
          originDomainId: revived.originDomainId,
          revision: revived.revision
        }
      });
    }
    await eventBus.publish(tx, {
      orgId: input.orgId,
      type: "scp.relationship.created",
      source: `/relationships`,
      subject: revived.id,
      data: {
        id: revived.id,
        typeId: input.typeId,
        fromId: input.fromId,
        toId: input.toId
      }
    });

    return toRelationship(revived);
  }

  let row: typeof relationships.$inferSelect | undefined;
  try {
    [row] = await tx
      .insert(relationships)
      .values({
        id,
        orgId: input.orgId,
        typeId: input.typeId,
        fromId: input.fromId,
        toId: input.toId,
        properties,
        labels,
        originDomainId,
        revision,
        contentHash
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err, "relationships_org_type_from_to_key")) {
      // M6 idempotent replay: a re-imported create for an edge that already exists (created by
      // the same origin domain) is a no-op, not an error — the DoD's "double-import is a no-op"
      // applies to relationships too.
      if (input.federationImport) {
        const existing = await tx.query.relationships.findFirst({
          where: (t, { eq: eqOp, and: andOp }) =>
            andOp(
              eqOp(t.orgId, input.orgId),
              eqOp(t.typeId, input.typeId),
              eqOp(t.fromId, input.fromId),
              eqOp(t.toId, input.toId)
            )
        });
        if (existing && existing.originDomainId === input.federationImport.originDomainId) {
          return toRelationship(existing);
        }
        if (existing) {
          throw conflict(
            `single-writer authority violation: relationship '${existing.id}' is authoritatively owned by domain '${existing.originDomainId}', not '${input.federationImport.originDomainId}'`
          );
        }
      }
      throw conflict(
        `relationship '${input.typeId}' from '${input.fromId}' to '${input.toId}' already exists`
      );
    }
    if (isUniqueViolation(err, "relationships_contains_one_service_per_component")) {
      // Migration-0022 partial unique index: two concurrent `contains` creates for the same
      // component both passed `assertCardinality` under READ COMMITTED (no row lock), and this one
      // lost at the index. Surface the SAME one-service-per-component 409 the pre-check would have,
      // not the misleading generic "relationship id already exists" below (which blames the id).
      throw cardinalityToSideConflict("one_to_many", input.typeId, input.toId);
    }
    if (isUniqueViolation(err, "relationships_releases_via_one_pipeline_per_component")) {
      // Migration-0049 partial unique index — the FROM-side mirror of the 0022 case above. Two
      // concurrent `releases_via` creates for the same component both passed `assertCardinality`
      // under READ COMMITTED (no row lock) and this one lost at the index. Surface the SAME
      // one-pipeline-per-component 409 the pre-check would have.
      throw cardinalityFromSideConflict("many_to_one", input.typeId, input.fromId);
    }
    if (isUniqueViolation(err)) throw conflict(`relationship id '${id}' already exists`);
    throw err;
  }
  if (!row) throw new Error("failed to insert relationship");

  // M20.3 (ADR-0031 §4) — AN EDGE INHERITS LOCALITY FROM EITHER ENDPOINT.
  //
  // EITHER, not both, and that is the whole point: the interesting edge is the MIXED one — a
  // domain-local networking component `part_of` a service the commander knows about. Requiring both
  // endpoints to be local would let exactly the leaking case through, because a
  // `relationship_upsert` payload carries `fromId`, `toId`, `typeId`, `properties` and `labels`.
  // Shipping that and letting the receiver decline to store it is a leak with a swallow, not
  // invisibility — the edge still names the local object's id in a file written to disk and relayed.
  //
  // Both endpoints are already loaded and validated above (`requireLiveObject`), so this costs no
  // extra query — and reading them is the only correct source, since locality is a property of the
  // objects, never of the edge's own request.
  const edgeIsDomainLocal = fromObj.domainLocal || toObj.domainLocal;

  await appendAuditEvent(tx, {
    orgId: input.orgId,
    actorId: input.actorObjectId,
    action: `relationship.${input.typeId}.create`,
    subjectId: id,
    beforeHash: null,
    afterHash: contentHash,
    requestId: input.requestId,
    // The audit segment carries `subjectId` (the edge id) and the action names the type — enough to
    // tell a peer that a domain-local object gained an edge. Same reasoning as M20.2's object case.
    subjectDomainLocal: edgeIsDomainLocal
  });
  if (reachBefore) {
    // Subject is the CHILD — see the matching note in `deleteRelationship`.
    await recordGovernanceReachChange(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      requestId: input.requestId,
      subjectObjectId: input.toId,
      route: "contains",
      detail: { edgeAction: "create", relationshipId: id, containerObjectId: input.fromId },
      before: reachBefore,
      subjectDomainLocal: edgeIsDomainLocal
    });
  }
  // Never journaled when either endpoint is local — see M20.2's note in `graph/objects-repo.ts` for
  // why this is a SKIP rather than a stamp-and-filter (a filtered bundle is sparse, and a full-scope
  // receiver refuses a sparse chain).
  if (!input.federationImport && !edgeIsDomainLocal) {
    await appendJournalEntry(tx, {
      orgId: input.orgId,
      entryKind: "relationship_upsert",
      contentHash,
      payload: {
        id,
        orgId: input.orgId,
        typeId: input.typeId,
        fromId: input.fromId,
        toId: input.toId,
        properties,
        labels,
        originDomainId,
        revision
      }
    });
  }
  await eventBus.publish(tx, {
    orgId: input.orgId,
    type: "scp.relationship.created",
    source: `/relationships`,
    subject: id,
    data: { id, typeId: input.typeId, fromId: input.fromId, toId: input.toId }
  });

  return toRelationship(row);
}

export async function getRelationship(
  tx: TenantTx,
  orgId: string,
  id: string
): Promise<Relationship> {
  const row = await tx.query.relationships.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.id, id), eqOp(t.orgId, orgId), isNullOp(t.deletedAt))
  });
  if (!row) throw notFound(`relationship '${id}' not found`);
  return toRelationship(row);
}

export interface ListRelationshipsQuery {
  cursor?: string | undefined;
  limit: number;
  fromId?: string | undefined;
  toId?: string | undefined;
  typeId?: string | undefined;
}

export async function listRelationships(
  tx: TenantTx,
  orgId: string,
  query: ListRelationshipsQuery
): Promise<{ items: Relationship[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conditions = [eq(relationships.orgId, orgId), isNull(relationships.deletedAt)];
  if (query.fromId) conditions.push(eq(relationships.fromId, query.fromId));
  if (query.toId) conditions.push(eq(relationships.toId, query.toId));
  if (query.typeId) conditions.push(eq(relationships.typeId, query.typeId));
  if (cursor) {
    conditions.push(keysetAfter(relationships.createdAt, relationships.id, cursor));
  }

  const rows = await tx
    .select()
    .from(relationships)
    .where(and(...conditions))
    .orderBy(...keysetOrderBy(relationships.createdAt, relationships.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map(toRelationship),
    nextCursor: hasMore && last ? encodeCursor(last) : null
  };
}

export async function deleteRelationship(
  tx: TenantTx,
  input: {
    orgId: string;
    actorObjectId: string;
    requestId: string;
    id: string;
    /** M6: see `graph/objects-repo.ts`'s `FederationImportContext` doc comment. */
    federationImport?: FederationImportContext;
  }
): Promise<void> {
  const existing = await tx.query.relationships.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.id, input.id), eqOp(t.orgId, input.orgId), isNullOp(t.deletedAt))
  });
  if (!existing) throw notFound(`relationship '${input.id}' not found`);

  if (input.federationImport) {
    if (existing.originDomainId !== input.federationImport.originDomainId) {
      throw conflict(
        `single-writer authority violation: relationship '${existing.id}' is authoritatively owned by domain '${existing.originDomainId}', not '${input.federationImport.originDomainId}'`
      );
    }
    // Stale replay → no-op, EXCEPT under a resync force-overwrite permit (§7.2.6), which re-applies
    // even a stale-revision edge so a lost-tail restore re-converges relationships too.
    if (
      input.federationImport.revision <= existing.revision &&
      !input.federationImport.forceOverwrite
    )
      return;
  } else {
    const self = await ensureFederationSelf(tx, input.orgId);
    if (existing.originDomainId !== self.domainId) {
      throw conflict(
        `relationship '${existing.id}' is a read-only replica (authoritative domain '${existing.originDomainId}') — it cannot be mutated locally`
      );
    }
  }

  // CONTAINMENT ROUTE 2 — see `createRelationship` for the property. DETACHING is the dangerous
  // direction of the two: it is what takes an object out from under a `required` gate.
  const reachBefore =
    existing.typeId === "contains"
      ? await policyReachFor(tx, input.orgId, existing.toId, input.actorObjectId)
      : null;

  const nextRevision = input.federationImport?.revision ?? existing.revision + 1;
  await tx
    .update(relationships)
    .set({ deletedAt: new Date(), revision: nextRevision })
    .where(eq(relationships.id, existing.id));

  // THE ADMINISTRATOR FLOOR (`docs/authz/role-binding-door.md` §7) — DOOR B, AND THE CASCADE OF DOOR C.
  //
  // Removing the `member_of` edge under a group's administrative binding leaves the BINDING ROW
  // INTACT while no live principal resolves through it any more. MEASURED, in four plain sequential
  // requests with no concurrency and no special privilege: create a team, join it, bind Owner to it,
  // revoke the bootstrap admin's binding (admitted — the team reaches a live member), then
  // `DELETE /relationships/{that member_of edge}` -> 200, and the org is unadministrable with
  // hand-written SQL the only recovery. The revoke-time guard counted the surviving row and reported
  // success, because a check that models ONE verb is a check the other verbs route around.
  //
  // `deleteObject`'s edge cascade calls this function per edge, so tombstoning a group that HOLDS an
  // administrative binding is refused here too, on the edge whose removal actually empties the floor
  // rather than on the object tombstone that is merely its cause.
  //
  // AFTER the tombstone, on purpose: the predicate asks what is TRUE now rather than modelling what
  // this write is about to do, which is what makes it blind to the verb and therefore complete over
  // the cascade. It takes §0's org lock itself. See §7.
  //
  // `type_id = 'member_of'` is a statement about the floor's inputs, not a filter over callers: the
  // closure it walks contains no other edge type, so no other edge tombstone can change its answer.
  // Every other relationship delete in the system costs one string comparison.
  //
  // FEDERATION IMPORT IS EXEMPT, the mechanism this file already applies to
  // `assertMayWriteGovernanceLabels` and `assertMayJoinRoleBearingSubject`: `import-repo.ts`'s replay
  // branch re-throws anything but a 400, so a 409 here would abort a peer's whole signed bundle over
  // one replicated membership this instance has no authority to keep.
  if (existing.typeId === "member_of" && !input.federationImport) {
    await assertOrgRetainsAdministrativeFloor(tx, {
      orgId: input.orgId,
      act:
        `removing the 'member_of' edge '${existing.id}' ('${existing.fromId}' -> ` +
        `'${existing.toId}')`
    });
  }

  // M20.3 (ADR-0031 §4) — the tombstone inherits locality the same way the create did, and it has to
  // be RE-RESOLVED here: the edge row itself carries no locality (locality belongs to the objects),
  // so this is a real lookup rather than a field read. A tombstone payload names `fromId` and
  // `toId`, so letting it cross would disclose the local object's id and the fact that its edge was
  // removed. Endpoints are read even when soft-deleted — a deleted endpoint is still a domain-local
  // one, and resolving it to "not local" would leak precisely at teardown.
  const edgeIsDomainLocal = await eitherEndpointIsDomainLocal(
    tx,
    input.orgId,
    existing.fromId,
    existing.toId
  );

  await appendAuditEvent(tx, {
    orgId: input.orgId,
    actorId: input.actorObjectId,
    action: `relationship.${existing.typeId}.delete`,
    subjectId: existing.id,
    beforeHash: existing.contentHash,
    afterHash: null,
    requestId: input.requestId,
    subjectDomainLocal: edgeIsDomainLocal
  });
  if (reachBefore) {
    // Subject is the CHILD (`to_id`) — the object whose governance changed. The edge is the
    // instrument, not the victim, and an operator searching the audit log for "what happened to this
    // component" must find this event under the component's id.
    await recordGovernanceReachChange(tx, {
      orgId: input.orgId,
      actorObjectId: input.actorObjectId,
      requestId: input.requestId,
      subjectObjectId: existing.toId,
      route: "contains",
      detail: {
        edgeAction: "delete",
        relationshipId: existing.id,
        containerObjectId: existing.fromId
      },
      before: reachBefore,
      subjectDomainLocal: edgeIsDomainLocal
    });
  }
  if (!input.federationImport && !edgeIsDomainLocal) {
    await appendJournalEntry(tx, {
      orgId: input.orgId,
      entryKind: "relationship_tombstone",
      contentHash: existing.contentHash,
      payload: {
        id: existing.id,
        typeId: existing.typeId,
        fromId: existing.fromId,
        toId: existing.toId
      }
    });
  }
  await eventBus.publish(tx, {
    orgId: input.orgId,
    type: "scp.relationship.deleted",
    source: `/relationships`,
    subject: existing.id,
    data: { id: existing.id, typeId: existing.typeId, fromId: existing.fromId, toId: existing.toId }
  });
}
