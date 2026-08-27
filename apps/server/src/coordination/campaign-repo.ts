import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type {
  Campaign,
  CampaignDeadline,
  CampaignDeadlineInput,
  CampaignDeadlineOverride,
  CampaignRecipe,
  CampaignStatus,
  ContainmentDomainId,
  ExecutorType,
  TrustDomainId
} from "@scp/schemas";
import { CAMPAIGN_DEADLINE_PROPERTY_KEY, CAMPAIGN_RECIPE_PROPERTY_KEY } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import {
  campaignPlans,
  campaignWaves,
  campaignWaveTargets,
  changes,
  objects
} from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { decodeCursor, encodeCursor, keysetAfter, keysetOrderBy } from "../pagination.js";
import { createObject, getObjectByIdOrUrnAnyType, updateObject } from "../graph/objects-repo.js";
import { authorize } from "../authz/resolve.js";
import { insertDecision } from "./decisions-repo.js";
import { computeCampaignStatus, type CampaignWaveStatusInput } from "./campaign-status.js";
import { getLatestCampaignPlan } from "./campaign-plan-service.js";
import { resolveChangeRecipe } from "./campaign-recipe.js";
import { evaluateCampaignDeadlineLock, resolveCampaignDeadline } from "./campaign-deadline-lock.js";

export type ObjectRow = typeof objects.$inferSelect;
/** The minimal object shape `toCampaignShape` actually reads — satisfied by both a raw
 *  `ObjectRow` (joined-query callers) and a `GraphObject` (createObject's return shape in
 *  `proposeCampaign`, which has ISO-string dates and no `contentHash`) without forcing either side
 *  to convert (mirrors `changes-repo.ts`'s `ObjectLike`). */
type ObjectLike = Pick<ObjectRow, "id" | "orgId" | "urn" | "name"> & {
  properties: unknown;
  createdAt: Date | string;
  updatedAt: Date | string;
};

function isoOf(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

/** M25.4 — the campaign's recipe as the READ surface sees it. `resolveChangeRecipe` is the same
 *  parse; it is reached through this thin wrapper here because the campaign's own `properties` is
 *  the AUTHORING copy and the change's is the fanned-out one, and only one of the two is on the
 *  trigger path. Both parse with `CampaignRecipeSchema` — one schema, two readers, never two
 *  schemas. */
function recipeOf(properties: Record<string, unknown>): CampaignRecipe | undefined {
  const resolved = resolveChangeRecipe(properties);
  return resolved.outcome === "recipe" ? resolved.recipe : undefined;
}

/** M25.6a — the campaign's deadline as the READ surface sees it, through the SAME parse the actuator
 *  uses. `null` covers BOTH "none declared" and "declared but unreadable", and that collapse is
 *  correct HERE and only here: this is a display surface, and both states have the identical
 *  operator-visible consequence — nothing is being withheld from anybody. At the ACTUATOR the two
 *  are emphatically not the same, and `campaign-reconcile.ts` records the unreadable one as a `warn`
 *  Decision naming what failed to parse. */
function deadlineOf(properties: Record<string, unknown>): CampaignDeadline | null {
  const resolved = resolveCampaignDeadline(properties);
  return resolved.outcome === "deadline" ? resolved.deadline : null;
}

export function toCampaignShape(object: ObjectLike, status: CampaignStatus): Campaign {
  const properties = object.properties as Record<string, unknown>;
  const targets = Array.isArray(properties.targets)
    ? (properties.targets as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
  return {
    id: object.id,
    orgId: object.orgId,
    urn: object.urn,
    name: object.name,
    description: typeof properties.description === "string" ? properties.description : null,
    targets,
    topologyObjectId: (properties.topologyObjectId as string | undefined) ?? null,
    topologyVersion: (properties.topologyVersion as number | undefined) ?? null,
    status,
    // M25.4 — re-parsed through the SAME schema the write door uses rather than cast, so a row
    // planted by a door that predates the guard cannot make a `Campaign` response fail its own
    // wire schema. A recipe that no longer parses reads as absent HERE (a display surface, where
    // absence is honest); at the ACTUATOR the same document is a loud refusal, never an absence —
    // see `campaign-recipe.ts`.
    ...(recipeOf(properties) !== undefined ? { recipe: recipeOf(properties) } : {}),
    // M25.6a — ALWAYS PRESENT, `null` when this campaign declares no deadline. A required nullable
    // response property, not an optional one: "is anything being withheld from this campaign's
    // laggards?" must not be answered by an absence a reader has to interpret.
    deadline: deadlineOf(properties),
    createdAt: isoOf(object.createdAt),
    updatedAt: isoOf(object.updatedAt)
  };
}

export interface ProposeCampaignInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  id?: string;
  urn?: string;
  /** CONTAINMENT sense (ADR-0021 D4). */
  domainId?: ContainmentDomainId | null;
  name: string;
  description?: string;
  labels?: Record<string, unknown>;
  topologyIdOrUrn?: string;
  /** WHICH pipeline every fanned-out change rolls (M12 P4A) — the routing Type (ADR-0007).
   *  Omitted => 'configuration' (the server default). */
  type?: ExecutorType;
  /** M25.4 (D3) — the coordination lever: ONE trigger intent fanned across every target. Written
   *  verbatim to `properties.recipe`; the shape refusal lives at the `objects-repo` choke point
   *  (`governance/campaign-recipe-guard.ts`), not here, because two other doors reach that property
   *  without passing through this function. */
  recipe?: CampaignRecipe;
  /** M25.6a (D4) — the date past which this campaign stops fanning out to targets it cannot observe
   *  as migrated. Authored here so a deadlined campaign is one call; MOVED and CLEARED afterwards
   *  through `POST /campaigns/{id}/deadline`, which demands a reason and records the previous
   *  value.
   *
   *  `CampaignDeadlineInput`, NOT `CampaignDeadline` — the type, like the wire schema, omits
   *  `overrides`, so a campaign cannot be BORN carrying waivers this route's `object:write` never
   *  authorized (M25.6b: minting one takes the Owner-only `campaign:deadline-override`). */
  deadline?: CampaignDeadlineInput;
  /** Object ids or URNs this campaign fans out to — one member Change per target, per wave. */
  targets: string[];
}

/**
 * Creates a Campaign: a graph object (type `campaign`, pre-seeded built-in — 0002 §5) plus a
 * Decision so `scp campaign status`/`:explain` always has at least one entry from the moment a
 * campaign exists, mirroring `changes-repo.ts`'s `proposeChange` exactly. NOT a state transition
 * (campaigns have no transition-guarded state machine — `campaign-status.ts`'s module doc) so this
 * does not go through `transitionChange`/an equivalent.
 *
 * SECURITY-SENSITIVE (M5 adversarial-review surface — "a campaign can't coordinate a change the
 * actor lacks authority over"): member Changes are proposed LATER, by the SYSTEM actor, during
 * campaign reconciliation (`campaign-reconcile.ts`) — that actor's own authority is not a
 * meaningful gate on WHICH targets a campaign may declare. The authorization decision has to be
 * made HERE, against the actual requesting actor, once, for every declared target — not deferred
 * to (and silently skipped by) the system-actor-driven reconciliation loop that creates the member
 * Changes. Checked per-target (not once at the campaign's own domain) because a campaign's targets
 * can span multiple domains a coarse single check would miss.
 */
export async function proposeCampaign(
  tx: TenantTx,
  input: ProposeCampaignInput
): Promise<{ campaign: Campaign; targetObjectIds: string[] }> {
  if (input.targets.length === 0) throw badRequest("a campaign must target at least one object");

  const targetObjectIds: string[] = [];
  for (const idOrUrn of input.targets) {
    const target = await getObjectByIdOrUrnAnyType(tx, input.orgId, idOrUrn);
    await authorize(tx, {
      orgId: input.orgId,
      subjectObjectId: input.actorObjectId,
      permission: "object:write",
      scopeObjectId: target.id
    });
    targetObjectIds.push(target.id);
  }

  let topologyObjectId: string | undefined;
  let topologyVersion: number | undefined;
  if (input.topologyIdOrUrn) {
    const topology = await getObjectByIdOrUrnAnyType(tx, input.orgId, input.topologyIdOrUrn);
    if (topology.typeId !== "release-topology") {
      throw badRequest(`'${input.topologyIdOrUrn}' is not a release-topology object`);
    }
    topologyObjectId = topology.id;
    topologyVersion = topology.version;
  }

  const object = await createObject(tx, {
    orgId: input.orgId,
    typeId: "campaign",
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    id: input.id,
    urn: input.urn,
    name: input.name,
    domainId: input.domainId,
    properties: {
      targets: targetObjectIds,
      // Read back by `campaign-reconcile.ts` via `typeOf` and stamped onto every change this campaign
      // fans out (M12 P4A / ADR-0007). Always written — a campaign object that omitted it would read
      // as 'configuration' anyway, and persisting it explicitly keeps the campaign self-describing.
      type: input.type ?? "configuration",
      // M25.4 — ONLY written when the author declared one, so a campaign without a recipe is
      // byte-identical to a pre-M25.4 campaign and every reader's fast path stays a pure absence
      // check (`resolveChangeRecipe` returns before parsing anything).
      ...(input.recipe !== undefined ? { [CAMPAIGN_RECIPE_PROPERTY_KEY]: input.recipe } : {}),
      // M25.6a — ONLY written when the author declared one, so a campaign without a deadline is
      // byte-identical to a pre-M25.6a campaign and `resolveCampaignDeadline` returns on a pure
      // key-absence check without parsing anything.
      ...(input.deadline !== undefined ? { [CAMPAIGN_DEADLINE_PROPERTY_KEY]: input.deadline } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(topologyObjectId !== undefined ? { topologyObjectId, topologyVersion } : {})
    },
    labels: input.labels
  });

  await insertDecision(tx, {
    orgId: input.orgId,
    kind: "transition",
    subjectId: object.id,
    verdict: "allow",
    inputContext: {
      trigger: "propose",
      actorId: input.actorObjectId,
      targets: targetObjectIds,
      topologyObjectId: topologyObjectId ?? null
    },
    reasonTree: { summary: `campaign proposed for ${targetObjectIds.length} target(s)` }
  });

  return { campaign: toCampaignShape(object, "proposed"), targetObjectIds };
}

async function fetchCampaignObject(tx: TenantTx, orgId: string, id: string): Promise<ObjectRow> {
  const row = await tx.query.objects.findFirst({
    where: (t, { eq: eqOp, and: andOp, isNull: isNullOp }) =>
      andOp(eqOp(t.orgId, orgId), eqOp(t.id, id), eqOp(t.typeId, "campaign"), isNullOp(t.deletedAt))
  });
  if (!row) throw notFound(`campaign '${id}' not found`);
  return row;
}

/**
 * The object ids a campaign declares as its targets, read off `properties.targets` — the same
 * filtered read `toCampaignShape` does, WITHOUT deriving status.
 *
 * A separate helper because its one caller (`POST /campaigns/{id}/deadline-override`) needs the
 * target set to make an AUTHORIZATION decision per target, and `getCampaign` would drag
 * `getCampaignStatus` — the campaign's whole plan, every member change's state, a freeze evaluation
 * and the deadline predicate — into a path that has not yet decided the actor may act at all.
 */
export async function listCampaignTargetObjectIds(
  tx: TenantTx,
  orgId: string,
  campaignObjectId: string
): Promise<string[]> {
  const row = await fetchCampaignObject(tx, orgId, campaignObjectId);
  const properties = (row.properties ?? {}) as Record<string, unknown>;
  return Array.isArray(properties.targets)
    ? (properties.targets as unknown[]).filter((t): t is string => typeof t === "string")
    : [];
}

/**
 * M25.6a — SET, MOVE OR CLEAR a campaign's deadline. THE ESCAPE HATCH, and the reason this
 * increment is not an entrance with no exit.
 *
 * CLEARING the deadline unlocks every target of the campaign at once, on the next tick, with no
 * unlock verb and no backfill. §4.5's second, narrower waiver — `POST
 * /campaigns/{id}/deadline-override`, per-target, behind the Owner-only
 * `campaign:deadline-override` (drizzle/0088) — is `overrideCampaignDeadline` below, added in
 * M25.6b. The two are different prices for different radii and both remain.
 *
 * AT THE CAMPAIGN, not at the targets — checked by the route. The thing being configured is this
 * campaign's own policy about its own fan-out, and a target-scoped check would hand the laggard
 * their own waiver, which is exactly the inversion §4.5 warns about for the override.
 * `hasPermission` expands the checked scope UPWARD, so an Administrator bound at the campaign's
 * containment domain can move its deadline and an actor bound at one unrelated service cannot.
 *
 * TWO PRICES, ONE VERB (owner ruling 2026-08-25, D1 b-i). Setting a FIRST deadline and SHORTENING an
 * existing one are TIGHTENINGS — strictly more targets are withheld afterwards — and run at plain
 * `object:write` at the campaign. CLEARING it, and moving `at` to an instant LATER than the stored
 * one, RELEASE targets, and both additionally demand the Owner-only `campaign:deadline-override`
 * (drizzle/0088) at the campaign. The bar is ADDED, never substituted: `object:write` still governs
 * all three acts. As shipped, all three ran at `object:write` while the NARROWER per-target waiver
 * one route down needed an Owner, so an operator refused a one-target waiver could clear the whole
 * deadline instead and excuse everybody — a wider verb at the narrower verb's price.
 *
 * **THE ROW IS READ `FOR UPDATE`**, and that is not defensive habit — it is M25.1's measured lesson
 * applied to the identical shape. This is a read-modify-write whose READ decides what goes into a
 * permanent record: `before` becomes the Decision's `deadline.from` and the audit event's account of
 * what the deadline used to be. Unlocked under READ COMMITTED, two concurrent moves let the second
 * compute its `from` against a snapshot that was never live — so the chain would record a slip from
 * a date nobody ever set. `updateObject` re-locks the same row a moment later (`lockObjectRow`), so
 * this takes the lock at the START of the sequence rather than in the middle of it.
 *
 * RETURNS BOTH VALUES so the route can put the previous one in the record. "The deadline slipped
 * four times" is otherwise unreconstructible from a chain of writes that each say only where it
 * landed.
 */
export interface SetCampaignDeadlineResult {
  /** What the campaign's deadline was, immediately before this write — `null` when it had none, and
   *  ALSO `null` when what it had did not parse. The two are distinguished by `beforeUnreadable`
   *  rather than collapsed, because "you replaced a broken document" and "you set the first one" are
   *  different facts and the audit trail should not have to guess. */
  before: CampaignDeadline | null;
  /** True when the value being replaced was present but unreadable. */
  beforeUnreadable: boolean;
  after: CampaignDeadline | null;
  campaign: Campaign;
}

/**
 * THE CAMPAIGN ROW, LOCKED `FOR UPDATE` — shared by both deadline writers.
 *
 * Extracted rather than copied because both are read-modify-writes over the SAME JSON document
 * (`properties.deadline`) and a second copy of the lock is a second chance to omit it. Two
 * concurrent writers without it would each compute their edit against a snapshot the other is about
 * to replace: a move would record a `from` nobody ever set, and — worse for M25.6b — two overrides
 * minted in the same instant would produce a document containing only one of them, with two audit
 * events on the chain asserting both.
 */
async function lockCampaignRowForUpdate(
  tx: TenantTx,
  orgId: string,
  campaignObjectId: string
): Promise<ObjectRow> {
  const locked = await tx
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.id, campaignObjectId),
        eq(objects.typeId, "campaign"),
        sql`${objects.deletedAt} IS NULL`
      )
    )
    .for("update")
    .limit(1);
  const row = locked[0];
  if (!row) throw notFound(`campaign '${campaignObjectId}' not found`);
  return row;
}

export async function setCampaignDeadline(
  tx: TenantTx,
  input: {
    orgId: string;
    campaignObjectId: string;
    actorObjectId: string;
    requestId: string;
    /** `null` CLEARS it — the exit. Carries NO `overrides`: the wire schema for this verb is
     *  `CampaignDeadlineInputSchema`, which omits the key, because this door is never the waiver
     *  door. A first set or a shortening runs at plain `object:write` while minting a waiver takes
     *  the Owner-only `campaign:deadline-override`; and even on the acts where D1(b-i) DOES demand
     *  that same permission here (a clear, or a move to a later instant), this door still never
     *  demands the per-target `object:write` a waiver does, nor names targets, nor writes the
     *  per-target audit event. Either way, accepting the key would make this route the waiver
     *  route's bypass. */
    deadline: CampaignDeadlineInput | null;
  }
): Promise<SetCampaignDeadlineResult> {
  const row = await lockCampaignRowForUpdate(tx, input.orgId, input.campaignObjectId);

  const properties = (row.properties ?? {}) as Record<string, unknown>;
  const existing = resolveCampaignDeadline(properties);

  // ==============================================================================================
  // M25.6b — THE WAIVERS ALREADY IN FORCE SURVIVE A SET OR A MOVE.
  // ==============================================================================================
  // This verb's request body CANNOT express `overrides` (that is the whole point of
  // `CampaignDeadlineInputSchema`), so an author moving the date has said NOTHING about the waivers.
  // Dropping them would be an unexpressed act — a silent TIGHTENING, re-locking targets an Owner
  // deliberately excused, performed by someone holding only `object:write`. Carrying them forward is
  // the reading that matches what a waiver MEANS: "this target is excused from this campaign's
  // deadline", not "excused from the particular instant it happened to carry that day".
  //
  // A CLEAR takes them with it, and that is not an inconsistency: clearing removes the deadline
  // itself, so there is nothing left to be excused from. Re-setting one afterwards starts clean,
  // which is the honest default — the old waivers were granted against a deadline that no longer
  // exists.
  //
  // An UNREADABLE previous document loses them, necessarily: `resolveCampaignDeadline` could not
  // parse it, so there is nothing to carry. The route records that as `beforeUnreadable`.
  const carriedOverrides =
    existing.outcome === "deadline" ? existing.deadline.overrides : undefined;
  const after: CampaignDeadline | null =
    input.deadline === null
      ? null
      : {
          ...input.deadline,
          ...(carriedOverrides !== undefined && carriedOverrides.length > 0
            ? { overrides: carriedOverrides }
            : {})
        };

  // `updateObject` replaces `properties` WHOLESALE, so the spread is what preserves `targets`,
  // `type`, `recipe`, `topologyObjectId` and everything else. Clearing DELETES the key rather than
  // writing `null`: `resolveCampaignDeadline` treats both as "none", but a stored `null` would make
  // a cleared campaign textually different from one that never had a deadline, for no gain — and it
  // is one more shape every future reader of this bag has to know about.
  const { [CAMPAIGN_DEADLINE_PROPERTY_KEY]: _dropped, ...withoutDeadline } = properties;
  const nextProperties =
    after === null
      ? withoutDeadline
      : { ...withoutDeadline, [CAMPAIGN_DEADLINE_PROPERTY_KEY]: after };

  const updated = await updateObject(tx, {
    orgId: input.orgId,
    typeId: "campaign",
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    idOrUrn: input.campaignObjectId,
    properties: nextProperties
  });

  const status = await getCampaignStatus(
    tx,
    input.orgId,
    input.campaignObjectId,
    nextProperties as Record<string, unknown>
  );

  return {
    before: existing.outcome === "deadline" ? existing.deadline : null,
    beforeUnreadable: existing.outcome === "malformed",
    // WHAT WAS STORED, not what was asked for — the two differ by exactly the carried waivers, and
    // the Decision this feeds must record the document that now exists rather than the request that
    // produced it.
    after,
    campaign: toCampaignShape(updated, status)
  };
}

export interface OverrideCampaignDeadlineResult {
  /** The waivers as stored after this write — at most one per target, sorted by `targetObjectId`. */
  overrides: CampaignDeadlineOverride[];
  /** The targets this call excused, resolved to object ids and SORTED. Feeds the Decision's
   *  `inputContext` verbatim and drives one audit event each. */
  targetObjectIds: string[];
  campaign: Campaign;
}

/**
 * M25.6b (§4.5) — MINT A PER-TARGET WAIVER of this campaign's deadline.
 *
 * ================================================================================================
 * THE AUTHORITY CHECKS ARE THE ROUTE'S, AND THEY ARE TWO, AT TWO DIFFERENT OBJECTS
 * ================================================================================================
 * `routes/campaigns.ts` demands `campaign:deadline-override` AT THE CAMPAIGN (Owner-only,
 * drizzle/0088) and plain `object:write` AT EACH NAMED TARGET, in that order, before calling this.
 * They are not duplicated here for the reason `proposeCampaign`'s own doc gives about the inverse
 * case: one authority decision, made once, against the real requesting actor, at the door — not
 * scattered so that a future second caller can silently acquire a different one.
 *
 * WHY THE CAMPAIGN AND NOT THE TARGET, restated where the write happens because it is the load-
 * bearing decision of this milestone: the thing being waived is *this campaign's* deadline. A
 * target-scoped check would hand the laggard their own waiver — the component's own operator
 * excusing the component from the migration the campaign exists to force, which inverts the entire
 * mechanism. `object:write` at the target is a second, NARROWER bar (an actor with no standing on a
 * component cannot mint a governance record about it), never a substitute for the first.
 *
 * ================================================================================================
 * AT MOST ONE WAIVER PER TARGET, AND THE ARRAY IS STORED SORTED
 * ================================================================================================
 * Re-overriding a target REPLACES its entry rather than appending: the newest reason and the newest
 * `until` are the ones in force, and the superseded one survives on the hash chain, which is where
 * history belongs. Append-only would grow `campaign.properties` without bound — this document rides
 * `object_upsert` to every federated replica and is content-hashed on every write — and would make
 * "which waiver applies?" a question about array order.
 *
 * The sort is the same discipline `describeLockedTargets` documents one module over: a re-issued
 * waiver over an unchanged set must produce a byte-identical document, or every restatement
 * re-hashes the object and re-federates it.
 *
 * REFUSES A CAMPAIGN WITH NO DEADLINE (400). A waiver of nothing is dead data in a permanent record,
 * and an operator who believes they have excused a target that was never locked is worse off than
 * one who got an error.
 */
export async function overrideCampaignDeadline(
  tx: TenantTx,
  input: {
    orgId: string;
    campaignObjectId: string;
    actorObjectId: string;
    requestId: string;
    /** Already resolved to object ids and verified to be targets of this campaign — the ROUTE does
     *  both, because both need the same `getObjectByIdOrUrnAnyType` lookup the per-target
     *  `object:write` check is made against. */
    targetObjectIds: string[];
    reason: string;
    until?: string | undefined;
    /** The write's own clock, stamped into every entry's `at`. Injected for the same reason
     *  `evaluateCampaignDeadlineLock`'s `now` is: a test must be able to mint a waiver whose `until`
     *  is in the past without waiting for it to become so. */
    now: Date;
  }
): Promise<OverrideCampaignDeadlineResult> {
  const row = await lockCampaignRowForUpdate(tx, input.orgId, input.campaignObjectId);

  const properties = (row.properties ?? {}) as Record<string, unknown>;
  const existing = resolveCampaignDeadline(properties);
  if (existing.outcome !== "deadline") {
    throw badRequest(
      existing.outcome === "malformed"
        ? `campaign '${input.campaignObjectId}' has an unreadable deadline (${existing.detail}) — ` +
            `it is withholding nothing from anybody, so there is nothing to waive. Fix or clear it ` +
            `with POST /campaigns/{id}/deadline first`
        : `campaign '${input.campaignObjectId}' declares no deadline — there is nothing to waive`
    );
  }

  const at = input.now.toISOString();
  const minted = new Map<string, CampaignDeadlineOverride>();
  for (const override of existing.deadline.overrides ?? []) {
    minted.set(override.targetObjectId, override);
  }
  for (const targetObjectId of input.targetObjectIds) {
    minted.set(targetObjectId, {
      targetObjectId,
      reason: input.reason,
      actorId: input.actorObjectId,
      at,
      ...(input.until !== undefined ? { until: input.until } : {})
    });
  }
  const overrides = [...minted.values()].sort((a, b) =>
    a.targetObjectId.localeCompare(b.targetObjectId)
  );

  const nextProperties = {
    ...properties,
    [CAMPAIGN_DEADLINE_PROPERTY_KEY]: { ...existing.deadline, overrides }
  };

  // THROUGH `updateObject`, so this is a versioned, content-hashed, ordinarily-audited graph write
  // underneath the governance record the route writes on top of it. No side door into
  // `objects.properties` — the same rule `setCampaignDeadline` follows.
  const updated = await updateObject(tx, {
    orgId: input.orgId,
    typeId: "campaign",
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    idOrUrn: input.campaignObjectId,
    properties: nextProperties
  });

  const status = await getCampaignStatus(
    tx,
    input.orgId,
    input.campaignObjectId,
    nextProperties as Record<string, unknown>
  );

  return {
    overrides,
    targetObjectIds: [...input.targetObjectIds].sort((a, b) => a.localeCompare(b)),
    campaign: toCampaignShape(updated, status)
  };
}

/**
 * The status-derivation DB helper (campaign-status.ts's module doc: campaign status is ALWAYS
 * re-derived, never stored). Loads the campaign's latest compiled plan (if any) and every wave
 * target's member Change's CURRENT state in one batched query, then hands off to the pure
 * `computeCampaignStatus`. Shared by `GET /campaigns`, `GET /campaigns/{id}`, the campaign
 * reconciler's own bookkeeping.
 */
export async function getCampaignStatus(
  tx: TenantTx,
  orgId: string,
  campaignObjectId: string,
  /**
   * The campaign object's OWN `properties` — where its deadline and recipe live.
   *
   * REQUIRED, not optional, and both call sites already hold the row. Making it optional would let a
   * future caller silently get the no-deadline answer for a deadlined campaign, which is this
   * project's recurring "fixed some call sites of a concept" failure with a status field attached.
   */
  properties: Record<string, unknown> | null
): Promise<CampaignStatus> {
  // ============================================================================================
  // THE COST GUARD (§4.6) — RESOLVED BEFORE ANY QUERY IN THIS FUNCTION.
  // ============================================================================================
  // `getCampaignStatus` runs once per campaign inside `listCampaigns`'s already-N+1 loop, so a
  // per-target read added here is multiplied by the page size. A campaign with no deadline — every
  // campaign authored before M25.6a, and every one that simply does not want the feature — must pay
  // exactly what it paid before, and it does: this is a pure key-absence check on an object already
  // in hand, decided before `getLatestCampaignPlan` is even called.
  const deadline = resolveCampaignDeadline(properties);

  // `withFreezeHolds: true` — this read now IS the M25.2 freeze evaluation below (M25.UI):
  // `getLatestCampaignPlan` composes `plan.waves[].targets[].hold` through the SAME
  // `resolveActiveCampaignWaveFreezeHolds`/`evaluateFreezeHolds` this function used to call a
  // second time for `frozenTargetIds` alone. Reusing the composed result rather than
  // re-evaluating costs nothing extra: one `evaluateFreezeHolds` call either way, now shared by
  // both the status derivation below and the wire `hold`/`heldTargetCount` projection.
  const plan = await getLatestCampaignPlan(tx, orgId, campaignObjectId, { withFreezeHolds: true });
  if (!plan) return computeCampaignStatus({ hasPlan: false, waves: [] });

  const memberChangeIds = plan.waves
    .flatMap((w) => w.targets.map((t) => t.memberChangeObjectId))
    .filter((id): id is string => id !== null);
  const stateByChangeId = new Map<string, string>();
  if (memberChangeIds.length > 0) {
    const rows = await tx
      .select({ objectId: changes.objectId, state: changes.state })
      .from(changes)
      .where(and(eq(changes.orgId, orgId), inArray(changes.objectId, memberChangeIds)));
    for (const row of rows) stateByChangeId.set(row.objectId, row.state);
  }

  // M25.2 — WHICH TARGETS A FREEZE IS HOLDING RIGHT NOW. NO LONGER a second `evaluateFreezeHolds`
  // call here (M25.UI): `getLatestCampaignPlan({ withFreezeHolds: true })` above already ran the
  // IDENTICAL evaluation (`resolveActiveCampaignWaveFreezeHolds`, `campaign-plan-service.ts`) to
  // compose `plan.waves[].targets[].hold` for the wire, and a target's `hold` is present if and
  // only if it came back frozen from that evaluation — so reading it off the composed plan is the
  // same answer, not an approximation of it. This also keeps the two candidate-set rules (only the
  // RUNNING wave, only targets not yet fanned into a member Change) defined in exactly one place
  // rather than restated here.
  const frozenTargetIds = new Set(
    plan.waves
      .flatMap((w) => w.targets.filter((t) => t.hold !== undefined))
      .map((t) => t.targetObjectId)
  );

  // Still needed below, PURE (no query): the same candidate set the freeze evaluation used, re-derived
  // here from `plan.waves` for the deadline-lock check, which is a SEPARATE mechanism (M25.6a) with
  // its own read.
  const runningWaveTargetIds = plan.waves
    .filter((w) => w.status === "running")
    .flatMap((w) => w.targets.filter((t) => t.memberChangeObjectId === null))
    .map((t) => t.targetObjectId);

  // M25.6a — WHICH TARGETS THIS CAMPAIGN'S OWN DEADLINE IS LOCKING OUT RIGHT NOW, re-evaluated here
  // rather than read off the standing `campaign_deadline` Decision, for the identical reason the
  // freeze holds directly above are: a Decision is a historical record, and a status derived from
  // one keeps saying `blocked` after the component migrated or the deadline moved.
  //
  // SCOPED TO THE SAME CANDIDATE SET AS THE FREEZE HOLD — the running wave's not-yet-fanned-out
  // targets — and for the same two reasons. A deadline over a target of a wave that has not started
  // is withholding nothing yet, and a target that already minted its member change is past this
  // seam entirely.
  //
  // NOT DUE COSTS NOTHING: `evaluateCampaignDeadlineLock` compares two instants and returns before
  // touching `tx`. Past the deadline it costs one adoption read per candidate, which is exactly what
  // the reconciler pays for the same answer — one resolution core, one price.
  const deadlineLockedTargetIds =
    deadline.outcome !== "deadline" || runningWaveTargetIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await evaluateCampaignDeadlineLock(tx, {
              orgId,
              campaignObjectId,
              targetObjectIds: runningWaveTargetIds,
              deadline: deadline.deadline,
              at: deadline.at,
              recipe: recipeOf((properties ?? {}) as Record<string, unknown>),
              // A READ, so the clock is read HERE: there is no batch to keep internally consistent
              // (one request, one campaign) and nothing durable is written from this path.
              now: new Date()
            })
          ).locked.map((entry) => entry.targetObjectId)
        );

  const waves: CampaignWaveStatusInput[] = plan.waves.map((w) => ({
    waveIndex: w.waveIndex,
    waveStatus: w.status as CampaignWaveStatusInput["waveStatus"],
    frozenTargetCount: w.targets.filter((t) => frozenTargetIds.has(t.targetObjectId)).length,
    deadlineLockedTargetCount: w.targets.filter((t) =>
      deadlineLockedTargetIds.has(t.targetObjectId)
    ).length,
    targets: w.targets.map((t) => ({
      targetObjectId: t.targetObjectId,
      memberChangeState:
        t.memberChangeObjectId && stateByChangeId.has(t.memberChangeObjectId)
          ? (stateByChangeId.get(
              t.memberChangeObjectId
            ) as CampaignWaveStatusInput["targets"][number]["memberChangeState"])
          : null
    }))
  }));

  return computeCampaignStatus({ hasPlan: true, waves });
}

export async function getCampaign(tx: TenantTx, orgId: string, id: string): Promise<Campaign> {
  const object = await fetchCampaignObject(tx, orgId, id);
  const status = await getCampaignStatus(
    tx,
    orgId,
    id,
    object.properties as Record<string, unknown> | null
  );
  return toCampaignShape(object, status);
}

export interface ListCampaignsQuery {
  cursor?: string | undefined;
  limit: number;
  status?: CampaignStatus | undefined;
  /**
   * The rows this caller's authority REACHES, as a subquery yielding `id`
   * (`authz/list-door-scope.ts` builds it; `authz/readable-scope.ts` defines it).
   *
   * `null`/absent means NO FILTER — the caller holds the permission at the ORG ROOT, so this is
   * today's query verbatim. It is NOT "matches nothing": a subject with no allow binding at all
   * yields a real match-nothing subquery, and the two must never collapse.
   */
  readableFilter?: SQL | null | undefined;
}

/**
 * ⚠️ {@link ListCampaignsQuery.readableFilter} is applied as a `WHERE` condition, BEFORE the
 * `.limit(limit + 1)` below, and not over the returned page — role-model.md §8.2: this list is
 * keyset-paginated and takes `nextCursor` from the last row it selected, so a page filtered
 * afterwards is silently short while still advertising more.
 *
 * `query.status` is the counter-example living in this very function: it is a post-filter, it
 * predates this work, and it has exactly that defect (a `?status=` page can come back with fewer
 * items than `limit` and a non-null `nextCursor`). It is left alone here because status is not an
 * authority question and fixing it means expressing `computeCampaignStatus` in SQL — reported, not
 * fixed. Do not read it as a precedent for the filter above.
 */
export async function listCampaigns(
  tx: TenantTx,
  orgId: string,
  query: ListCampaignsQuery
): Promise<{ items: Campaign[]; nextCursor: string | null }> {
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const conditions = [
    eq(objects.orgId, orgId),
    eq(objects.typeId, "campaign"),
    sql`${objects.deletedAt} IS NULL`
  ];
  if (query.readableFilter) conditions.push(sql`${objects.id} IN ${query.readableFilter}`);
  if (cursor) {
    conditions.push(keysetAfter(objects.createdAt, objects.id, cursor));
  }

  const rows = await tx
    .select()
    .from(objects)
    .where(and(...conditions))
    .orderBy(...keysetOrderBy(objects.createdAt, objects.id))
    .limit(query.limit + 1);

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];

  const items: Campaign[] = [];
  for (const row of page) {
    const status = await getCampaignStatus(
      tx,
      orgId,
      row.id,
      row.properties as Record<string, unknown> | null
    );
    if (query.status && query.status !== status) continue;
    items.push(toCampaignShape(row, status));
  }

  return {
    items,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null
  };
}

/** Reads the target object ids `proposeCampaign` stashed under `properties.targets`. */
export function campaignTargetObjectIdsOf(
  properties: Record<string, unknown> | null | undefined
): string[] {
  const targets = properties?.targets;
  return Array.isArray(targets) ? targets.filter((t): t is string => typeof t === "string") : [];
}

/**
 * Every non-terminal campaign in the org — no plan yet, or a LATEST plan that is not
 * `completed`/`aborted` — the reconciler's batch-fetch, mirroring `changes-repo.ts`'s
 * `listChangeRowsInStates` shape (`ORDER BY updated_at ASC LIMIT n`).
 *
 * THE DOC SAID THIS FOR MONTHS AND THE QUERY DID NOT DO IT. Until 2026-08-01 the WHERE clause was
 * `org_id` + `type_id = 'campaign'` + `deleted_at IS NULL` and nothing else, so a campaign whose
 * latest plan was `completed` or `aborted` came back every tick forever and `reconcileOneCampaign`
 * early-returned on it having done nothing. The name said "Active", the doc said "non-terminal",
 * the query said "all of them" — and only the query runs.
 *
 * WHY THE PREDICATE IS SHAPED LIKE THIS. A campaign can have SEVERAL plans (a re-plan writes a new
 * row rather than mutating the old one), so the test is not "has no terminal plan" — it is "the
 * LATEST plan is not terminal". Those differ exactly where it is most dangerous: a campaign that
 * completed one plan and was then RE-PLANNED has a terminal plan AND an active one, and the naive
 * predicate would exclude it from the reconciler forever. Over-inclusion (the old behaviour) wastes
 * a batch slot; wrong exclusion silently strands a live campaign, which is far worse — so the
 * inner `DISTINCT ON` picks the latest row per campaign FIRST and only then tests its status.
 *
 * `ORDER BY created_at DESC, id DESC` MATCHES `campaign-plan-service.ts`'s `getLatestCampaignPlan`
 * EXACTLY, and both had to gain the `id` tiebreak together. `created_at` defaults to `now()`, which
 * in Postgres is TRANSACTION time, so two plans written in one transaction tie byte-for-byte and
 * "latest" was decided by planner order. If this filter and that reader disagreed under a tie, a
 * campaign could be excluded here as terminal while the reader handed the reconciler an ACTIVE plan
 * — a campaign that is never driven and reports no error anywhere. `id` is UUIDv7, so it is both
 * deterministic and time-ordered.
 *
 * `campaign_object_id` is NOT NULL, so the `NOT IN` carries no three-valued-logic hazard.
 *
 * The reconciler's own `plan.status === "completed" || "aborted"` early-return STAYS as defence in
 * depth — this filter is an efficiency and honesty fix, not the safety boundary.
 *
 * ## `selfDomainId` — the S10 single-writer filter, and why the campaign side needed it MORE
 *
 * The twin of `changes-repo.ts`'s `listChangeRowsInStates` argument of the same name (read that doc
 * comment for the shape of the remedy and why a round-robin bump is the wrong one). The two loops
 * now agree, but the hole they close was NOT equally severe, and the asymmetry is worth recording
 * because it is what made this one urgent:
 *
 *  - A synced CHANGE was never a candidate in the first place. `federation/import-repo.ts`'s
 *    `object_upsert` branch explicitly never creates a local `changes` state-machine row, and
 *    `listChangeRowsInStates` INNER JOINs that row, so the change-side guard was latent (measured in
 *    `change-origin-domain.integration.test.ts`'s header).
 *  - A synced CAMPAIGN was. `object_upsert` is TYPE-AGNOSTIC (`const typeId = String(payload.typeId)`)
 *    and `graph/objects-repo.ts`'s `journalEntryKindFor` routes every non-`policy` object onto that
 *    entry kind, so a peer's campaign object rides an ordinary `full`-scope journal and lands here
 *    through `upsertObjectByUrn(..., { federationImport: { originDomainId: exporterDomainId } })` —
 *    a real local row with a FOREIGN `origin_domain_id`, matched by every predicate above.
 *
 * `reconcileOneCampaign` would then compile a plan for ANOTHER DOMAIN'S campaign and propose member
 * Changes from it. That is a single-writer violation with real side effects — rows in
 * `campaign_plans`/`campaign_waves`/`campaign_wave_targets`, brand-new `changes`, a `coordinates`
 * edge hanging off a replica — not merely a scheduling problem. Worse, `reconcileCampaignsOrgTick`'s
 * unconditional round-robin bump then WROTE the replica's own `objects.updated_at` every tick.
 *
 * WHY THE FILTER AND NOT A MID-LOOP `continue`. This query is `ORDER BY objects.updated_at ASC LIMIT
 * n` — capped AND ordered — so a body-level skip that did not write the row would re-create the
 * batch-starvation property (`candidate-loop-registry.test.ts`) that cost 13 days of production
 * coordination. And the remedy used for every other instance of that property, a round-robin
 * `updated_at` bump, is ILLEGAL on a replica: it is itself the write S10 forbids. Filtering removes
 * the row from the candidate set entirely, which is starvation-free AND single-writer-clean, and it
 * keeps "SKIP, NOT PARK" intact — nothing is written, so the campaign rejoins the batch by itself
 * the moment authority returns.
 *
 * REQUIRED, not optional, and deliberately so: a future call site that forgets it would silently
 * re-open the hole, and this project's recurring bug is fixing SOME call sites of a concept. Pinned
 * by `foreign-origin-campaign.integration.test.ts`.
 */
export async function listActiveCampaignObjectIds(
  tx: TenantTx,
  orgId: string,
  limit: number,
  selfDomainId: TrustDomainId
): Promise<ObjectRow[]> {
  return tx
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, "campaign"),
        sql`${objects.deletedAt} IS NULL`,
        eq(objects.originDomainId, selfDomainId),
        sql`${objects.id} NOT IN (
          SELECT latest.campaign_object_id FROM (
            SELECT DISTINCT ON (p.campaign_object_id) p.campaign_object_id, p.status
            FROM campaign_plans p
            WHERE p.org_id = ${orgId}
            ORDER BY p.campaign_object_id, p.created_at DESC, p.id DESC
          ) latest
          WHERE latest.status IN ('completed', 'aborted')
        )`
      )
    )
    .orderBy(asc(objects.updatedAt))
    .limit(limit);
}

/**
 * The AUTHORITATIVE campaign membership (M5 CRITICAL, adversarial review) — the member Changes a
 * campaign's own plan compiler actually proposed, read straight from `campaign_wave_targets`
 * (joined via `campaign_plans` on `campaign_object_id`), NOT from raw `coordinates` graph edges.
 * This is the ONLY membership `campaign-rollback.ts` trusts: a `coordinates` edge is a
 * system-managed relationship (creatable only via authority-checked internal paths — see
 * `graph/system-managed-relationships.ts`), but sourcing rollback membership from the plan tables
 * instead of the edges means even a stray/legacy/pre-existing `coordinates` edge (a migration
 * artifact, a future bug) can NEVER inject a rollback target. Each row carries the member Change's
 * object id AND the wave target's own `target_object_id`, so the caller can re-verify the acting
 * actor's authority over each reverted target's scope (belt-and-suspenders).
 */
export async function authoritativeCampaignMembers(
  tx: TenantTx,
  orgId: string,
  campaignObjectId: string
): Promise<{ memberChangeObjectId: string; targetObjectId: string }[]> {
  const rows = await tx
    .select({
      memberChangeObjectId: campaignWaveTargets.memberChangeObjectId,
      targetObjectId: campaignWaveTargets.targetObjectId
    })
    .from(campaignWaveTargets)
    .innerJoin(campaignWaves, eq(campaignWaveTargets.waveId, campaignWaves.id))
    .innerJoin(campaignPlans, eq(campaignWaves.planId, campaignPlans.id))
    .where(
      and(
        eq(campaignWaveTargets.orgId, orgId),
        eq(campaignPlans.campaignObjectId, campaignObjectId)
      )
    );
  return rows
    .filter(
      (r): r is { memberChangeObjectId: string; targetObjectId: string } =>
        r.memberChangeObjectId !== null
    )
    .map((r) => ({
      memberChangeObjectId: r.memberChangeObjectId,
      targetObjectId: r.targetObjectId
    }));
}
