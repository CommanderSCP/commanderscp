import { and, desc, eq, isNull, or } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { SyncScope } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { federationPeers, federationPeerKeys } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { isUuid } from "../graph/objects-repo.js";

/**
 * Peer pairing + the peer public-key registry (DESIGN.md §13). Pairing itself is always initiated
 * from THIS side dialing/registering the other — never the reverse (§13 child-initiated-only; for
 * air-gapped peers, an out-of-band exchange of each side's `scp federation status` output). This
 * module only persists the result; it does not perform any network handshake itself (that's
 * `packages/plugins/federation-https`'s job for the connected-mTLS case).
 */

export interface FederationPeerRow {
  id: string; // = peer's own federation domain id
  orgId: string;
  name: string;
  role: "parent" | "child";
  baseUrl: string | null;
  syncScope: SyncScope;
  pairedAt: string;
  publicKey: string;
}

function toPeerRow(
  peer: typeof federationPeers.$inferSelect,
  publicKey: string
): FederationPeerRow {
  return {
    id: peer.id,
    orgId: peer.orgId,
    name: peer.name,
    role: peer.role as "parent" | "child",
    baseUrl: peer.baseUrl,
    syncScope: peer.syncScope as SyncScope,
    pairedAt: peer.pairedAt.toISOString(),
    publicKey
  };
}

export async function currentPeerPublicKey(
  tx: TenantTx,
  orgId: string,
  peerDomainId: string
): Promise<string | null> {
  const rows = await tx
    .select()
    .from(federationPeerKeys)
    .where(
      and(
        eq(federationPeerKeys.orgId, orgId),
        eq(federationPeerKeys.peerDomainId, peerDomainId),
        isNull(federationPeerKeys.supersededAt)
      )
    )
    .orderBy(desc(federationPeerKeys.effectiveFrom))
    .limit(1);
  return rows[0]?.publicKey ?? null;
}

/** Resolves the public key that was in force for a peer AT a given point in time — needed to
 *  verify a segment signed before a later key rotation (DESIGN §13: keys "rotated via signed
 *  journal events", old segments must remain verifiable against the key that was current when
 *  they were signed). Falls back to the current key if no historical row predates `at`. */
export async function peerPublicKeyAt(
  tx: TenantTx,
  orgId: string,
  peerDomainId: string,
  at: Date
): Promise<string | null> {
  const rows = await tx
    .select()
    .from(federationPeerKeys)
    .where(
      and(eq(federationPeerKeys.orgId, orgId), eq(federationPeerKeys.peerDomainId, peerDomainId))
    )
    .orderBy(desc(federationPeerKeys.effectiveFrom));
  for (const row of rows) {
    if (row.effectiveFrom <= at && (row.supersededAt === null || row.supersededAt > at)) {
      return row.publicKey;
    }
  }
  return rows[0]?.publicKey ?? null;
}

export interface PairPeerInput {
  orgId: string;
  domainId: string;
  name: string;
  role: "parent" | "child";
  publicKey: string;
  baseUrl?: string;
  syncScope?: SyncScope;
}

/** Idempotent upsert: pairing the same peer again updates its metadata; a public-key CHANGE is
 *  treated as an explicit rotation (a new `federation_peer_keys` row, the old one superseded) —
 *  never a silent overwrite, so a peer's signing history stays fully reconstructible. */
export async function pairPeer(tx: TenantTx, input: PairPeerInput): Promise<FederationPeerRow> {
  const existing = await tx
    .select()
    .from(federationPeers)
    .where(and(eq(federationPeers.orgId, input.orgId), eq(federationPeers.id, input.domainId)))
    .limit(1);

  const syncScope = input.syncScope ?? { mode: "full" as const };

  if (!existing[0]) {
    const [row] = await tx
      .insert(federationPeers)
      .values({
        id: input.domainId,
        orgId: input.orgId,
        name: input.name,
        role: input.role,
        baseUrl: input.baseUrl ?? null,
        syncScope
      })
      .returning();
    if (!row) throw new Error("pairPeer: failed to insert peer");
    await tx.insert(federationPeerKeys).values({
      id: uuidv7(),
      orgId: input.orgId,
      peerDomainId: input.domainId,
      publicKey: input.publicKey
    });
    return toPeerRow(row, input.publicKey);
  }

  const [row] = await tx
    .update(federationPeers)
    .set({
      name: input.name,
      role: input.role,
      baseUrl: input.baseUrl ?? existing[0].baseUrl,
      syncScope
    })
    .where(and(eq(federationPeers.orgId, input.orgId), eq(federationPeers.id, input.domainId)))
    .returning();
  if (!row) throw new Error("pairPeer: failed to update peer");

  const current = await currentPeerPublicKey(tx, input.orgId, input.domainId);
  if (current !== input.publicKey) {
    const now = new Date();
    await tx
      .update(federationPeerKeys)
      .set({ supersededAt: now })
      .where(
        and(
          eq(federationPeerKeys.orgId, input.orgId),
          eq(federationPeerKeys.peerDomainId, input.domainId),
          isNull(federationPeerKeys.supersededAt)
        )
      );
    await tx.insert(federationPeerKeys).values({
      id: uuidv7(),
      orgId: input.orgId,
      peerDomainId: input.domainId,
      publicKey: input.publicKey,
      effectiveFrom: now
    });
  }
  return toPeerRow(row, input.publicKey);
}

export async function listPeers(tx: TenantTx, orgId: string): Promise<FederationPeerRow[]> {
  const rows = await tx.select().from(federationPeers).where(eq(federationPeers.orgId, orgId));
  const out: FederationPeerRow[] = [];
  for (const row of rows) {
    const key = await currentPeerPublicKey(tx, orgId, row.id);
    out.push(toPeerRow(row, key ?? ""));
  }
  return out;
}

/** Resolves a peer by its domain id OR its human name (CLI/route ergonomics — mirrors
 *  `graph/objects-repo.ts`'s idOrUrn convention). */
export async function getPeerByIdOrName(
  tx: TenantTx,
  orgId: string,
  idOrName: string
): Promise<FederationPeerRow> {
  if (!idOrName) throw badRequest("peer identifier is required");
  // `federationPeers.id` is a `uuid` column — comparing it against a non-UUID string (a plain
  // peer NAME) is a Postgres type error, not merely a non-match, so the id branch of the OR is
  // only included when `idOrName` actually parses as a UUID (mirrors `graph/objects-repo.ts`'s
  // `idOrUrnCondition` convention for the identical id-or-friendly-name ergonomic).
  const condition = isUuid(idOrName)
    ? or(eq(federationPeers.id, idOrName), eq(federationPeers.name, idOrName))
    : eq(federationPeers.name, idOrName);
  const rows = await tx
    .select()
    .from(federationPeers)
    .where(and(eq(federationPeers.orgId, orgId), condition))
    .limit(1);
  if (!rows[0])
    throw notFound(
      `federation peer '${idOrName}' not found — pair it first with 'scp federation pair'`
    );
  const key = await currentPeerPublicKey(tx, orgId, rows[0].id);
  return toPeerRow(rows[0], key ?? "");
}
