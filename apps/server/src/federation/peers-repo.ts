import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { SyncScope } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { federationPeers, federationPeerKeys } from "../db/schema.js";
import { badRequest, notFound } from "../errors.js";
import { isUuid } from "../graph/objects-repo.js";
import { maxAppliedSequenceForPeer } from "./cursors-repo.js";

/**
 * Peer pairing + the peer public-key registry (DESIGN.md §13). Pairing itself is always initiated
 * from THIS side dialing/registering the other — never the reverse (§13 outpost-initiated-only;
 * for air-gapped peers, an out-of-band exchange of each side's `scp federation status` output).
 * This module only persists the result; it does not perform any network handshake itself (that's
 * `packages/plugins/federation-https`'s job for the connected-mTLS case).
 */

export interface FederationPeerRow {
  id: string; // = peer's own federation domain id
  orgId: string;
  name: string;
  role: "commander" | "outpost" | "retrans";
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
    role: peer.role as "commander" | "outpost" | "retrans",
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

export interface PeerKeyWindow {
  publicKey: string;
  effectiveFromSequence: number;
  supersededAtSequence: number | null;
}

/** Every registered public key for a peer with its SEQUENCE-anchored validity window, oldest
 *  first. The verification anchor (DESIGN §13; M6 review fix) — timestamps are never consulted. */
export async function listPeerKeyWindows(
  tx: TenantTx,
  orgId: string,
  peerDomainId: string
): Promise<PeerKeyWindow[]> {
  const rows = await tx
    .select()
    .from(federationPeerKeys)
    .where(
      and(eq(federationPeerKeys.orgId, orgId), eq(federationPeerKeys.peerDomainId, peerDomainId))
    )
    .orderBy(asc(federationPeerKeys.effectiveFromSequence));
  return rows.map((row) => ({
    publicKey: row.publicKey,
    effectiveFromSequence: Number(row.effectiveFromSequence),
    supersededAtSequence:
      row.supersededAtSequence === null ? null : Number(row.supersededAtSequence)
  }));
}

/**
 * Resolves the public key that must verify an entry signed at origin `sequence` — the ONLY key
 * selection permitted (SECURITY-SENSITIVE, M6 review fix — CRITICAL). A key is valid for sequence
 * `S` iff `effectiveFromSequence < S AND (supersededAtSequence IS NULL OR S <= supersededAtSequence)`.
 * Returns `null` (fail-closed) if no window covers `S`. Because rotation anchors the old key's
 * `supersededAtSequence` to the highest sequence this domain had already applied, and every future
 * import applies only entries with sequence beyond that, a rotated-away/compromised key can never
 * verify content that will ever be applied — never by a self-declared timestamp.
 */
export function verificationKeyForSequence(
  keys: PeerKeyWindow[],
  sequence: number
): string | null {
  for (const key of keys) {
    if (
      key.effectiveFromSequence < sequence &&
      (key.supersededAtSequence === null || sequence <= key.supersededAtSequence)
    ) {
      return key.publicKey;
    }
  }
  return null;
}

export interface PairPeerInput {
  orgId: string;
  domainId: string;
  name: string;
  role: "commander" | "outpost" | "retrans";
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
    // SECURITY-SENSITIVE (M6 review fix — CRITICAL): anchor the rotation to the AUTHENTICATED
    // journal sequence, not a timestamp. The old key legitimately signed everything this domain has
    // already applied from the peer (its cursor high-water mark); the new key takes over from there.
    // Every future import applies only entries beyond the cursor, so the old key is hard-revoked for
    // all content that will ever be applied — no timestamp fallback an attacker could backdate.
    const anchor = await maxAppliedSequenceForPeer(tx, input.orgId, input.domainId);
    await tx
      .update(federationPeerKeys)
      .set({ supersededAt: now, supersededAtSequence: anchor })
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
      effectiveFrom: now,
      effectiveFromSequence: anchor
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
