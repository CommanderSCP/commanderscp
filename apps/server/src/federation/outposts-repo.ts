import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  asTrustDomainId,
  type GraphObject,
  type OutpostConfig,
  type OutpostConfigReconcileResult,
  type OutpostTrustTier
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../errors.js";
import {
  createObject,
  deleteObject,
  getObjectByIdOrUrn,
  toGraphObject,
  updateObject
} from "../graph/objects-repo.js";
import { deriveUrn } from "../graph/urn.js";
import { findPeerByDomainId } from "./peers-repo.js";
import { ensureFederationSelf } from "./self-repo.js";

/**
 * M16.2 phase A (E1) — the commander-side write/read surface for `outpost` GRAPH OBJECTS: the
 * commander-authored, owner-ENTERED config about one enrolled outpost, which syncs down to that
 * outpost as a read-only replica because it is an ordinary graph object.
 *
 * READ `federation/outpost-binding.ts` FIRST — it states the authority split between this object and
 * the `federation_peers` row, and it holds the enforcement of the 1:1 peer binding (applied inside
 * `graph/objects-repo.ts`, so EVERY local write door gets it, not just this module).
 *
 * This module deliberately owns no invariant of its own beyond URN derivation: it composes
 * `createObject`/`updateObject` so the object is journaled, audited, content-hashed and
 * single-writer-guarded by exactly the same machinery as every other graph object (charter principle
 * 2 — no parallel mechanism).
 */

export const OUTPOST_OBJECT_TYPE_ID = "outpost";

/** The object's URN is derived from the PEER DOMAIN ID, never from its display name — so the
 *  `(org_id, urn)` unique index is a second, database-level guarantee of the 1:1 binding, and
 *  renaming the object can never fork it. `deriveUrn`'s slugify leaves a UUID intact. */
export function outpostConfigUrn(orgId: string, peerDomainId: string): string {
  return deriveUrn(orgId, OUTPOST_OBJECT_TYPE_ID, peerDomainId);
}

/** The tiers THIS build understands. Deliberately a local list rather than the registered JSON
 *  Schema's: the registered type keeps `trustTier` an OPEN string so a bundle carrying a tier a newer
 *  commander invented cannot abort an older outpost's import (see drizzle/0043's header). An
 *  unrecognised tier therefore reads as NO tier here — honestly declared unknown, never guessed at. */
const KNOWN_TRUST_TIERS: ReadonlySet<string> = new Set([
  "commercial",
  "govcloud",
  "fedramp-high",
  "il5",
  "airgap"
]);

function readTrustTier(properties: Record<string, unknown>): OutpostTrustTier | null {
  const value = properties.trustTier;
  // NEVER DEFAULTED. `trustTier` has no source anywhere but this property, so an absent value stays
  // absent all the way to the wire (`null`) and is declared in `unknownFields` — a blank or a
  // fabricated `commercial` would be an assertion no operator ever made. The same is true of a tier
  // this build does not recognise: reporting it as `commercial` would invent a posture.
  return typeof value === "string" && KNOWN_TRUST_TIERS.has(value)
    ? (value as OutpostTrustTier)
    : null;
}

/**
 * Projects the underlying graph object into the API's read view, carrying the honest-unknown
 * declaration (`unknownFields`) the rest of this codebase already uses.
 *
 * `selfDomainId` is REQUIRED (review round 4): without origin-vs-self and `provenance` on the wire, a
 * consumer cannot tell a commander's own asserted config from an unverified hand-filled shadow claiming
 * a foreign origin, and would render the latter as the former. `originDomainId` alone does not answer
 * it — a reader would have to know this instance's own domain id to compare against.
 */
export function toOutpostConfig(object: GraphObject, selfDomainId: string): OutpostConfig {
  const properties = object.properties;
  const trustTier = readTrustTier(properties);
  const peerDomainId = typeof properties.peerDomainId === "string" ? properties.peerDomainId : "";
  const originIsSelf = object.originDomainId === selfDomainId;
  const unknownFields: string[] = [];
  if (trustTier === null) unknownFields.push("trustTier");
  // An UNVERIFIED shadow's tier is not an assertion this instance can stand behind: it was typed in by
  // hand and no signed bundle has confirmed it. The value still rides the wire for shape stability, and
  // is declared here so a UI renders it as unknown rather than as a commander assertion — the exact
  // `ServiceBoardRow.unknownFields` contract.
  else if (object.provenance === "manual") unknownFields.push("trustTier");
  return {
    objectId: object.id,
    urn: object.urn,
    name: object.name,
    peerDomainId,
    trustTier,
    originDomainId: object.originDomainId,
    originIsSelf,
    provenance: object.provenance ?? null,
    revision: object.revision,
    version: object.version,
    unknownFields,
    createdAt: object.createdAt,
    updatedAt: object.updatedAt
  };
}

export interface CreateOutpostConfigInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  peerDomainId: string;
  name?: string;
  trustTier?: OutpostTrustTier;
}

/**
 * Declares the config object for an already-paired outpost peer. The peer-binding guard
 * (`assertOutpostPeerBinding`, reached through `createObject`) refuses an unbound `peerDomainId`
 * (400), a peer whose role is not `outpost` (400), and a second object for the same peer (409).
 *
 * The peer lookup here is NON-throwing (`findPeerByDomainId`) and is used ONLY to default the display
 * name. Validating the binding is the guard's job at the choke point — so an unpaired peer produces
 * the guard's own precise 400 ("not a paired federation peer") rather than a 404 from a name lookup,
 * and a caller that bypasses this module gets the identical refusal.
 */
export async function createOutpostConfig(
  tx: TenantTx,
  input: CreateOutpostConfigInput
): Promise<OutpostConfig> {
  const self = await ensureFederationSelf(tx, input.orgId);
  const peer = await findPeerByDomainId(tx, input.orgId, asTrustDomainId(input.peerDomainId));
  const object = await createObject(tx, {
    orgId: input.orgId,
    typeId: OUTPOST_OBJECT_TYPE_ID,
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    urn: outpostConfigUrn(input.orgId, input.peerDomainId),
    // Falls back to the raw id when the peer does not exist — a name the guard is about to make
    // irrelevant by refusing the write. `createObject` requires a name, so this keeps the ORDER of
    // refusals in the guard's hands instead of the name default's.
    name: input.name ?? peer?.name ?? input.peerDomainId,
    properties: {
      peerDomainId: input.peerDomainId,
      // Written ONLY when the operator supplied one — an omitted tier leaves the key absent, which
      // is what makes "no tier asserted" distinguishable from "tier asserted as commercial".
      ...(input.trustTier !== undefined ? { trustTier: input.trustTier } : {})
    }
  });
  return toOutpostConfig(object, self.domainId);
}

/** Every `outpost` config object in this org, oldest first. Includes the read-only REPLICA an outpost
 *  holds of its own config (that instance's `originDomainId` names the commander) — the projection
 *  makes the difference legible rather than hiding it. */
export async function listOutpostConfigs(tx: TenantTx, orgId: string): Promise<OutpostConfig[]> {
  const self = await ensureFederationSelf(tx, orgId);
  const rows = await tx
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, OUTPOST_OBJECT_TYPE_ID),
        isNull(objects.deletedAt)
      )
    )
    .orderBy(asc(objects.createdAt), asc(objects.id));
  return rows.map((row) => toOutpostConfig(toGraphObject(row), self.domainId));
}

/**
 * Every LIVE `outpost` object bound to `peerDomainId`, in a TOTALLY DETERMINISTIC order.
 *
 * The binding is meant to be 1:1 and `assertOutpostPeerBinding` keeps it that way going forward, but a
 * database can still HOLD a duplicate — one left behind by the hand-fill door before it was narrowed
 * (review round 4), or by any future write door. `(created_at, id)` makes the order total: `created_at`
 * alone is not unique inside one transaction, and an ORDER-BY-less `LIMIT 1` (what this used to be) made
 * `GET`/`PATCH /v1/federation/outposts/{peer}` resolve NONDETERMINISTICALLY and land on whichever copy
 * Postgres happened to return — including a foreign-origin one, which then 409'd as a "read-only replica".
 */
async function listOutpostObjectsForPeer(
  tx: TenantTx,
  orgId: string,
  peerDomainId: string
): Promise<GraphObject[]> {
  const rows = await tx
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.orgId, orgId),
        eq(objects.typeId, OUTPOST_OBJECT_TYPE_ID),
        isNull(objects.deletedAt),
        sql`${objects.properties} ->> 'peerDomainId' = ${peerDomainId}`
      )
    )
    .orderBy(asc(objects.createdAt), asc(objects.id));
  return rows.map(toGraphObject);
}

/**
 * Which of several rows bound to one peer is the AUTHORITY, most-authoritative first:
 *   1. LOCAL-ORIGIN — this instance authored it. On a commander that is the operator's own declaration,
 *      and it must win over anything else: the commander is the single writer for outpost config in its
 *      own domain, so a foreign or hand-typed copy can never outrank it.
 *   2. A VERIFIED REPLICA (foreign origin, `provenance` NULL) — signature/chain-checked on import. This
 *      is the authoritative row on an OUTPOST, where the commander is the author.
 *   3. An UNVERIFIED SHADOW (`provenance = 'manual'`) — hand-typed, confirmed by nothing. Last.
 * Ties inside a class keep the caller's deterministic `(created_at, id)` order.
 */
function byAuthority(rows: GraphObject[], selfDomainId: string): GraphObject[] {
  const rank = (o: GraphObject): number =>
    o.originDomainId === selfDomainId ? 0 : o.provenance === "manual" ? 2 : 1;
  return rows
    .map((o, i) => ({ o, i }))
    .sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i)
    .map((e) => e.o);
}

/** The config object bound to `peerDomainId`, or `null` when the peer has none. Resolved through the
 *  BINDING (the JSONB property), not through the URN, so it still resolves for a replica whose URN
 *  was derived in the commander's org — and through `byAuthority`, so a stray unverified shadow can
 *  never shadow (nor be mistaken for) the row that actually holds authority. */
export async function findOutpostConfigByPeer(
  tx: TenantTx,
  orgId: string,
  peerDomainId: string
): Promise<OutpostConfig | null> {
  const self = await ensureFederationSelf(tx, orgId);
  const rows = byAuthority(await listOutpostObjectsForPeer(tx, orgId, peerDomainId), self.domainId);
  const row = rows[0];
  return row ? toOutpostConfig(row, self.domainId) : null;
}

export async function getOutpostConfigByPeer(
  tx: TenantTx,
  orgId: string,
  peerDomainId: string
): Promise<OutpostConfig> {
  const found = await findOutpostConfigByPeer(tx, orgId, peerDomainId);
  if (!found) {
    throw notFound(
      `peer '${peerDomainId}' has no outpost config object — declare one with POST /v1/federation/outposts`
    );
  }
  return found;
}

/**
 * THE RECOVERY DOOR (review round 4) — `POST /v1/federation/outposts/{peerDomainId}/reconcile`.
 *
 * WHY IT EXISTS. Before the hand-fill narrowing, `POST /v1/federation/hand-fill` could plant a second
 * live `outpost` object for a peer that already had a legitimate one. That left the peer UNRECOVERABLE
 * THROUGH THE API: the commander's own `PATCH /v1/federation/outposts/{peer}` 409'd forever
 * ("already has an outpost config object" / "read-only replica"), `DELETE /api/v1/objects/outpost/{id}`
 * is 403 by this milestone's own refusal, and no delete verb for the config existed. An unrecoverable
 * state reachable by a supported action is the one-way-ratchet failure class this project has already
 * paid for (PR #149), so the door is closed AND the existing wedge is made fixable — a database wedged
 * by an older build must be repairable without SQL.
 *
 * WHAT IT DOES, and nothing more:
 *   * keeps the single most authoritative row for the peer (`byAuthority`);
 *   * when NO authoritative row exists but an UNVERIFIED shadow does, ADOPTS the first shadow as this
 *     domain's own object (`unverifiedShadowOverride` — origin re-stamped, `provenance` cleared, and it
 *     journals from then on like any local object), so the operator's entered config is not thrown away;
 *   * SOFT-DELETES every remaining unverified shadow for that peer, restoring the 1:1 binding.
 *
 * WHAT IT REFUSES. A VERIFIED foreign-origin replica is never adopted and never DELETED: deleting one
 * would make the next real import a single-writer violation and wedge that peer's sync — trading one
 * unrecoverable state for a worse one. Two verified rows for one peer therefore stay a 409 and are
 * reported as such, which is an honest authority conflict rather than a silent pick.
 *
 * `keepObjectId` — THE VERIFIED-DUPLICATE ESCAPE (review round 5, N9). Without it, a VERIFIED
 * foreign-origin duplicate bound to one peer had NO public-API recovery AT ALL: `PATCH` 409s (the
 * binding scan's `blocking` filter exempts only `provenance='manual'`), the default reconcile refuses
 * by design, `DELETE /objects/outpost/{id}` is 403, and IaC prune only touches stack-managed objects —
 * and the refusal message named an action the API did not offer. That state is NOT reachable today (in
 * canonical hub-and-spoke, no bundle a commander imports carries an `outpost` row bound to one of ITS
 * peers) but becomes reachable the moment two authoring domains describe one outpost — hierarchical
 * sub-commanders, or a dual-homed outpost. Naming the row to KEEP lets the operator resolve the
 * authority conflict the only way that is actually safe: this domain DELETES THE ROW IT AUTHORED
 * ITSELF, which is an ordinary local tombstone that journals normally and can be re-declared at any
 * time. The refusal to delete a signature-verified replica is unchanged and unconditional — that half
 * is what stops this from trading the wedge for a sync wedge.
 */
export async function reconcileOutpostConfig(
  tx: TenantTx,
  input: {
    orgId: string;
    actorObjectId: string;
    requestId: string;
    peerDomainId: string;
    /** Which live row for this peer should SURVIVE. Absent = the most authoritative one
     *  (`byAuthority`), i.e. the default behaviour is exactly as before. */
    keepObjectId?: string;
  }
): Promise<OutpostConfigReconcileResult> {
  const self = await ensureFederationSelf(tx, input.orgId);
  const rows = byAuthority(
    await listOutpostObjectsForPeer(tx, input.orgId, input.peerDomainId),
    self.domainId
  );
  if (rows.length === 0) {
    throw notFound(
      `peer '${input.peerDomainId}' has no outpost config object to reconcile — declare one with POST /v1/federation/outposts`
    );
  }

  let keeper = rows[0]!;
  if (input.keepObjectId !== undefined) {
    const chosen = rows.find((o) => o.id === input.keepObjectId);
    if (!chosen) {
      // 400, not 404: the PEER resolves fine and has config — the caller named a row that is not one
      // of its live claimants, which is a bad argument, not a missing resource.
      throw badRequest(
        `object '${input.keepObjectId}' is not one of the live outpost config objects bound to peer ` +
          `'${input.peerDomainId}' (${rows.map((o) => o.id).join(", ")})`
      );
    }
    keeper = chosen;
  }
  const isShadow = (o: GraphObject): boolean =>
    o.originDomainId !== self.domainId && o.provenance === "manual";
  /** Locally authored — this domain owns it outright, so removing it is an ordinary tombstone that
   *  journals like any other local delete. No override, no special case in `deleteObject`. */
  const isLocallyAuthored = (o: GraphObject): boolean => o.originDomainId === self.domainId;
  const surplus = rows.filter((o) => o.id !== keeper.id);
  const unremovable = surplus.filter((o) => !isShadow(o) && !isLocallyAuthored(o));
  if (unremovable.length > 0) {
    // 409, NOT 404 (review round 5, N3). This branch fires when the peer DEMONSTRABLY HAS config —
    // `GET /v1/federation/outposts/{peer}` answers 200 for the very same peer at the same instant —
    // so answering 404 told a status-keyed consumer "no outpost config" and HID the authority
    // conflict on the one door that exists to recover from it. The route's own response map already
    // declared 409 and the schema comment already called this a "409-shaped notFound"; the code is
    // now the shape it always described. 404 stays for the genuinely-no-rows branch above, which is
    // the only branch where the resource really is absent.
    // THE MESSAGE NAMES AN ACTION THE API ACTUALLY OFFERS (review round 5, N9). It previously said
    // "resolve the authority conflict at its source" — advice, not a verb, on a door whose whole
    // purpose is to be the verb.
    throw conflict(
      `peer '${input.peerDomainId}' has ${rows.length} live outpost config objects and ${unremovable.length} of ` +
        `them are signature-verified replicas this domain did not author (${unremovable
          .map((o) => o.id)
          .join(", ")}) — reconcile never deletes one, because that would make the next real import a ` +
        `single-writer violation and wedge this peer's sync. Reconcile removes UNVERIFIED hand-filled ` +
        `shadows, and — with ?keep=<objectId> — rows THIS domain authored. If the verified replica is the ` +
        `one that should survive, re-run with ?keep=${unremovable[0]!.id}`
    );
  }

  /** Surplus removal. `unverifiedShadowOverride` is passed only for a foreign shadow, which is the
   *  only row it applies to: for a LOCALLY AUTHORED row `deleteObject`'s replica check never fires,
   *  so the removal is an ordinary local tombstone that JOURNALS normally (a shadow's does not — this
   *  domain never authored it, so claiming authorship of its deletion would push a delete for a row
   *  the real authority still owns). Passing the flag for a local row would be a claim we do not
   *  need to make. */
  const removeSurplus = async (): Promise<void> => {
    for (const o of surplus) {
      await deleteObject(tx, {
        orgId: input.orgId,
        typeId: OUTPOST_OBJECT_TYPE_ID,
        actorObjectId: input.actorObjectId,
        requestId: input.requestId,
        idOrUrn: o.id,
        ...(isShadow(o) ? { unverifiedShadowOverride: true } : {})
      });
    }
  };

  let adoptedObjectId: string | null = null;
  let kept = keeper;
  if (isShadow(keeper)) {
    // Nothing authoritative survives (or the caller chose the shadow) — adopt it rather than discard
    // the operator's entry. The guard runs on this path too (`updateObject`'s choke point), so an
    // adopted object still has to satisfy clause (4): paired peer, role `outpost`, and — with the
    // surplus not yet removed — no OTHER claimant. Surplus removal therefore happens FIRST.
    await removeSurplus();
    kept = await updateObject(tx, {
      orgId: input.orgId,
      typeId: OUTPOST_OBJECT_TYPE_ID,
      actorObjectId: input.actorObjectId,
      requestId: input.requestId,
      idOrUrn: keeper.id,
      properties: keeper.properties,
      unverifiedShadowOverride: true
    });
    adoptedObjectId = kept.id;
    return {
      config: toOutpostConfig(kept, self.domainId),
      adoptedObjectId,
      removedObjectIds: surplus.map((o) => o.id)
    };
  }

  await removeSurplus();
  return {
    config: toOutpostConfig(kept, self.domainId),
    adoptedObjectId,
    removedObjectIds: surplus.map((o) => o.id)
  };
}

export interface UpdateOutpostConfigInput {
  orgId: string;
  actorObjectId: string;
  requestId: string;
  peerDomainId: string;
  name?: string;
  trustTier?: OutpostTrustTier;
  expectedVersion?: number;
}

/**
 * Edits the commander-origin config. ABSENT MEANS PRESERVE for every field — an omitted `trustTier`
 * never clears an asserted one, and (phase A) there is no clear-to-unknown verb at all: un-asserting
 * a tier is a distinct, deliberate operation, and inventing it as a side effect of an omitted field
 * is exactly how a UI silently erases an operator's assertion.
 *
 * ON AN OUTPOST THIS CALL FAILS, and that is the point: the object there is a read-only replica, so
 * `updateObject`'s existing single-writer guard raises 409 before any of this module's logic runs
 * (proved by `outpost-config-sync.integration.test.ts`). No second mechanism was added for it.
 */
export async function updateOutpostConfig(
  tx: TenantTx,
  input: UpdateOutpostConfigInput
): Promise<OutpostConfig> {
  const current = await getOutpostConfigByPeer(tx, input.orgId, input.peerDomainId);
  const existing = await getObjectByIdOrUrn(
    tx,
    input.orgId,
    OUTPOST_OBJECT_TYPE_ID,
    current.objectId
  );
  const nextProperties: Record<string, unknown> = {
    ...existing.properties,
    // The binding is re-asserted verbatim, never taken from the request: `peerDomainId` is the
    // object's identity and is not patchable.
    peerDomainId: current.peerDomainId,
    ...(input.trustTier !== undefined ? { trustTier: input.trustTier } : {})
  };
  const updated = await updateObject(tx, {
    orgId: input.orgId,
    typeId: OUTPOST_OBJECT_TYPE_ID,
    actorObjectId: input.actorObjectId,
    requestId: input.requestId,
    idOrUrn: current.objectId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    properties: nextProperties,
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {})
  });
  const self = await ensureFederationSelf(tx, input.orgId);
  return toOutpostConfig(updated, self.domainId);
}
