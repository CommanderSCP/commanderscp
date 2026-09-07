import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  asTrustDomainId,
  formatOutpostClaimantToken,
  type GraphObject,
  type OutpostClaimantToken,
  type OutpostConfig,
  type OutpostConfigReconcileResult,
  type OutpostTrustTier
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { objects } from "../db/schema.js";
import { badRequest, conflict, notFound, preconditionFailed } from "../errors.js";
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

/** The commander-side write and read surface for outposts. See docs/federation.md §330. */

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

/** Projects the graph object into the API's read view. See docs/federation.md §331. */
export function toOutpostConfig(object: GraphObject, selfDomainId: string): OutpostConfig {
  const properties = object.properties;
  const trustTier = readTrustTier(properties);
  const peerDomainId = typeof properties.peerDomainId === "string" ? properties.peerDomainId : "";
  const originIsSelf = object.originDomainId === selfDomainId;
  // §10.5 — the HQ outpost: this record is ABOUT this instance's own domain. Independent of
  // `originIsSelf` (on an outpost site its own replica is commander-authored AND about self).
  const peerIsSelf = peerDomainId === selfDomainId;
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
    peerIsSelf,
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

/** Declares the config object for an already-paired peer. See docs/federation.md §332. */
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
    // Falls back to this instance's own federation name for the HQ outpost (§10.5 — there
    // is no peer row to take one from), and to the raw id when the peer does not exist — a name the
    // guard is about to make irrelevant by refusing the write. `createObject` requires a name, so
    // this keeps the ORDER of refusals in the guard's hands instead of the name default's.
    name:
      input.name ??
      peer?.name ??
      (input.peerDomainId === (self.domainId as string) ? self.name : input.peerDomainId),
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

/** EVERY LIVE `outpost` object, RESOLVED TO ONE PER PEER. See docs/federation.md §333. */
export async function resolveOutpostObjectsByPeer(
  tx: TenantTx,
  orgId: string
): Promise<Map<string, { id: string; name: string; trustTier: OutpostTrustTier | null }>> {
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
  const byPeer = new Map<string, GraphObject[]>();
  for (const row of rows) {
    const object = toGraphObject(row);
    const peerDomainId = object.properties.peerDomainId;
    if (typeof peerDomainId !== "string" || peerDomainId.length === 0) continue;
    const list = byPeer.get(peerDomainId) ?? [];
    list.push(object);
    byPeer.set(peerDomainId, list);
  }
  const resolved = new Map<
    string,
    { id: string; name: string; trustTier: OutpostTrustTier | null }
  >();
  for (const [peerDomainId, list] of byPeer) {
    const winner = byAuthority(list, self.domainId)[0];
    if (!winner) continue;
    resolved.set(peerDomainId, {
      id: winner.id,
      name: winner.name,
      trustTier: readTrustTier(winner.properties)
    });
  }
  return resolved;
}

/** Every live outpost bound to a peer, in a fixed order. See docs/federation.md §334. */
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

/** Which of several rows bound to one peer is the authority. See docs/federation.md §335. */
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

/** THE OPTIMISTIC-CONCURRENCY PRECONDITION on the recovery door. See docs/federation.md §336. */
function assertClaimantsUnchanged(
  peerDomainId: string,
  live: readonly GraphObject[],
  previewed: readonly OutpostClaimantToken[],
  selfDomainId: string
): void {
  const liveById = new Map(live.map((o) => [o.id, o]));
  const previewedById = new Map(previewed.map((c) => [c.objectId, c]));
  const appeared = live.filter((o) => !previewedById.has(o.id));
  const disappeared = previewed.filter((c) => !liveById.has(c.objectId));
  const changed = previewed.filter((c) => {
    const row = liveById.get(c.objectId);
    return row !== undefined && row.version !== c.version;
  });
  if (appeared.length === 0 && disappeared.length === 0 && changed.length === 0) return;

  // The detail NAMES WHAT CHANGED, computed from token-vs-reality. "A second configuration appeared"
  // is a sentence an operator can act on; "precondition failed" is not.
  const parts: string[] = [];
  if (appeared.length > 0) {
    parts.push(
      `${appeared.length} appeared (${appeared.map((o) => formatOutpostClaimantToken({ objectId: o.id, version: o.version })).join(", ")})`
    );
  }
  if (disappeared.length > 0) {
    parts.push(
      `${disappeared.length} disappeared (${disappeared.map((c) => c.objectId).join(", ")})`
    );
  }
  if (changed.length > 0) {
    parts.push(
      `${changed.length} changed since the preview (${changed
        .map((c) => `${c.objectId}: version ${c.version} -> ${liveById.get(c.objectId)!.version}`)
        .join(
          ", "
        )}) — a claimant whose version moved may have changed ORIGIN or PROVENANCE, which ` +
        `changes which row reconcile keeps`
    );
  }
  throw preconditionFailed(
    `the live outpost config claimants for peer '${peerDomainId}' are not the ones this call was ` +
      `previewed against: ${parts.join("; ")}. NOTHING was adopted, removed or journaled. Re-read the ` +
      `claimants (they are on this response), review what reconcile would now do, and re-issue with a ` +
      `fresh ?ifClaimant= set.`,
    {
      extensions: {
        claimants: byAuthority([...live], selfDomainId).map((o) => toOutpostConfig(o, selfDomainId))
      }
    }
  );
}

/** THE RECOVERY DOOR. See docs/federation.md §337. */
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
    /** The claimant set this call was PREVIEWED against (`?ifClaimant=<objectId>:<version>`).
     *  Absent = proceed unchecked, which is exactly the pre-existing behaviour — see
     *  {@link assertClaimantsUnchanged} for why the default has to be that and why no first-party
     *  surface relies on it. */
    ifClaimants?: readonly OutpostClaimantToken[];
  }
): Promise<OutpostConfigReconcileResult> {
  const self = await ensureFederationSelf(tx, input.orgId);
  const live = await listOutpostObjectsForPeer(tx, input.orgId, input.peerDomainId);
  // First, before the 404 and before anything is written. See docs/federation.md §338.
  if (input.ifClaimants !== undefined) {
    assertClaimantsUnchanged(input.peerDomainId, live, input.ifClaimants, self.domainId);
  }
  const rows = byAuthority(live, self.domainId);
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
    // 409, not 404: the peer demonstrably has configuration. See docs/federation.md §339.
    throw conflict(
      `peer '${input.peerDomainId}' has ${rows.length} live outpost config objects and ${unremovable.length} of ` +
        `them are signature-verified replicas this domain did not author (${unremovable
          .map((o) => o.id)
          .join(
            ", "
          )}) — reconcile never deletes one, because that would make the next real import a ` +
        `single-writer violation and wedge this peer's sync. Reconcile removes UNVERIFIED hand-filled ` +
        `shadows, and — with ?keep=<objectId> — rows THIS domain authored. If the verified replica is the ` +
        `one that should survive, re-run with ?keep=${unremovable[0]!.id}`
    );
  }

  /** Surplus removal, and when the override is passed. See docs/federation.md §340. */
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
  // Split BEFORE removal, and reported separately (review round 6, M1): `unremovable` above already
  // guarantees every row left in `surplus` is either a shadow or locally authored (a verified foreign
  // surplus row would have thrown), so these two filters partition it exactly, and neither call site
  // downstream can recombine "removed a stray copy" with "deleted and journaled my own config".
  const removedShadowObjectIds = surplus.filter(isShadow).map((o) => o.id);
  const removedLocalObjectIds = surplus.filter(isLocallyAuthored).map((o) => o.id);

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
      removedShadowObjectIds,
      removedLocalObjectIds
    };
  }

  await removeSurplus();
  return {
    config: toOutpostConfig(kept, self.domainId),
    adoptedObjectId,
    removedShadowObjectIds,
    removedLocalObjectIds
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

/** Edits the commander-origin config. See docs/federation.md §341. */
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
