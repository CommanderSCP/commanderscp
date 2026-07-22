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
  /** M17.3 (E5) — the peer's REGISTERED cosign verification public key from pairing (the CURRENT
   *  key window). `null` for a peer paired before E5 or one that never supplied one. This is the
   *  ONLY value E6/M17.4 trusts to verify that peer's cosign-signed promotion manifests. */
  cosignPublicKey: string | null;
}

function toPeerRow(
  peer: typeof federationPeers.$inferSelect,
  publicKey: string,
  cosignPublicKey: string | null
): FederationPeerRow {
  return {
    id: peer.id,
    orgId: peer.orgId,
    name: peer.name,
    role: peer.role as "commander" | "outpost" | "retrans",
    baseUrl: peer.baseUrl,
    syncScope: peer.syncScope as SyncScope,
    pairedAt: peer.pairedAt.toISOString(),
    publicKey,
    cosignPublicKey
  };
}

/** The CURRENT (non-superseded) key-window row for a peer — both the Ed25519 `publicKey` and, since
 *  E5, the cosign verification pubkey ride in this SAME row. `null` when the peer has no key yet. */
export async function currentPeerKeyRow(
  tx: TenantTx,
  orgId: string,
  peerDomainId: string
): Promise<{ publicKey: string; cosignPublicKey: string | null } | null> {
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
  const row = rows[0];
  if (!row) return null;
  return { publicKey: row.publicKey, cosignPublicKey: row.cosignPublicKey ?? null };
}

export async function currentPeerPublicKey(
  tx: TenantTx,
  orgId: string,
  peerDomainId: string
): Promise<string | null> {
  const row = await currentPeerKeyRow(tx, orgId, peerDomainId);
  return row?.publicKey ?? null;
}

/** The peer's CURRENT cosign VERIFICATION public key (PEM), or `null` when the peer has none
 *  registered (paired pre-E5, or never supplied one). Parallels `currentPeerPublicKey` and rides
 *  the SAME non-superseded key window as the Ed25519 key, so a cosign rotation is anchored to the
 *  same journal-sequence window (never a timestamp). This is the ONLY key M17.4(a) trusts to verify
 *  that peer's cosign-signed promotion manifests — `null` is load-bearing for the downgrade defense
 *  (a manifest-less bundle from a peer that HAS a cosign key is a downgrade; from one that has none
 *  it is genuine pre-E6 back-compat). */
export async function currentPeerCosignPublicKey(
  tx: TenantTx,
  orgId: string,
  peerDomainId: string
): Promise<string | null> {
  const row = await currentPeerKeyRow(tx, orgId, peerDomainId);
  return row?.cosignPublicKey ?? null;
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
  /** M17.3 (E5) — the peer's cosign verification public key, exchanged in the SAME out-of-band
   *  pairing step as `publicKey`. Optional/additive: an OLD pair request lacking it still pairs
   *  (the peer's cosign key stays `null`). Registered ALONGSIDE `publicKey` in the same key window. */
  cosignPublicKey?: string | null;
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
  // ADDITIVE (E5): distinguish "cosign key omitted" (undefined — a pre-E5 client that never knew the
  // field; PRESERVE whatever is already registered) from "cosign key supplied" (a concrete value —
  // set or rotate). The over-the-wire schema is `.optional()` (not nullable), so absent === undefined.
  const cosignProvided = input.cosignPublicKey !== undefined;

  if (!existing[0]) {
    const cosignPublicKey = cosignProvided ? (input.cosignPublicKey ?? null) : null;
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
      publicKey: input.publicKey,
      cosignPublicKey
    });
    return toPeerRow(row, input.publicKey, cosignPublicKey);
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

  const current = await currentPeerKeyRow(tx, input.orgId, input.domainId);
  // The cosign key that WILL be in the window after this pairing: the supplied one when provided,
  // else the currently-registered one (a pre-E5 re-pair never strips an existing cosign key).
  const nextCosign = cosignProvided
    ? (input.cosignPublicKey ?? null)
    : (current?.cosignPublicKey ?? null);
  // M17.3 (E5): a rotation is a change to EITHER key in the window — the Ed25519 signing key OR the
  // cosign verification key. Both ride the SAME window row, so either change supersedes the old row
  // and opens a new one carrying BOTH current values (the unchanged key is re-carried verbatim).
  const rotated =
    current === null ||
    current.publicKey !== input.publicKey ||
    (current.cosignPublicKey ?? null) !== nextCosign;
  if (rotated) {
    const now = new Date();
    // SECURITY-SENSITIVE (M6 review fix — CRITICAL): anchor the rotation to the AUTHENTICATED
    // journal sequence, not a timestamp. The old key legitimately signed everything this domain has
    // already applied from the peer (its cursor high-water mark); the new key takes over from there.
    // Every future import applies only entries beyond the cursor, so the old key is hard-revoked for
    // all content that will ever be applied — no timestamp fallback an attacker could backdate. The
    // cosign key rides the SAME window, so the OLD cosign key is retained in its superseded window
    // exactly as the Ed25519 key is (fully reconstructible history for both).
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
      cosignPublicKey: nextCosign,
      effectiveFrom: now,
      effectiveFromSequence: anchor
    });
  }
  return toPeerRow(row, input.publicKey, nextCosign);
}

export async function listPeers(tx: TenantTx, orgId: string): Promise<FederationPeerRow[]> {
  const rows = await tx.select().from(federationPeers).where(eq(federationPeers.orgId, orgId));
  const out: FederationPeerRow[] = [];
  for (const row of rows) {
    const key = await currentPeerKeyRow(tx, orgId, row.id);
    out.push(toPeerRow(row, key?.publicKey ?? "", key?.cosignPublicKey ?? null));
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
  const key = await currentPeerKeyRow(tx, orgId, rows[0].id);
  return toPeerRow(rows[0], key?.publicKey ?? "", key?.cosignPublicKey ?? null);
}
