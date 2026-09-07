import { and, asc, desc, eq, isNull, lte, or } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import {
  asTrustDomainId,
  type DeliveryTarget,
  type SyncScope,
  type TrustDomainId
} from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { federationPeers, federationPeerKeys } from "../db/schema.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { isUniqueViolation } from "../db/pg-errors.js";
import { isUuid } from "../graph/objects-repo.js";
import { assertSyncScopeSelectorKeysAreGovernanceLabels } from "../governance/governance-labels.js";
import { maxAppliedSequenceForPeer, permitCursorReanchor } from "./cursors-repo.js";
import { federationPeerRequiresMtls } from "./federation-outbound.js";

/** Peer pairing + the peer public-key registry. See docs/federation.md §355. */

export interface FederationPeerRow {
  /** TRUST sense (ADR-0021 D4) — = the peer's own `federation_self.domainId`. */
  id: TrustDomainId;
  orgId: string;
  name: string;
  role: "commander" | "outpost" | "retrans";
  baseUrl: string | null;
  syncScope: SyncScope;
  /** M13.2a (§13.2) — the peer's per-peer DeliveryTarget; `null` = resolve through the instance
   *  env (`SCP_RELAY_OUT_DIR`/`SCP_RELAY_IN_DIR`) — today's behavior, unchanged. */
  deliveryTarget: DeliveryTarget | null;
  pairedAt: string;
  publicKey: string;
  /** M17.3 (E5) — the peer's REGISTERED cosign verification public key from pairing (the CURRENT
   *  key window). `null` for a peer paired before E5 or one that never supplied one. This is the
   *  ONLY value E6/M17.4 trusts to verify that peer's cosign-signed promotion manifests. */
  cosignPublicKey: string | null;
  /** M14.1 (ADR-0009) — whether this peer is configured for poke-mode. `false` (default, DB-backed
   *  NOT NULL DEFAULT false) is poll-mode; `true` means the commander MAY send it a contentless
   *  wake signal and its frequent poll is disabled (full enforcement is M14.4). */
  pokeMode: boolean;
  /** The scheduler's per-peer due state, or null. See docs/federation.md §356. */
  lastPullAttemptAt: string | null;
  lastPullSuccessAt: string | null;
  lastPokeReceivedAt: string | null;
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
    deliveryTarget: (peer.deliveryTarget as DeliveryTarget | null) ?? null,
    pokeMode: peer.pokeMode,
    lastPullAttemptAt: peer.lastPullAttemptAt?.toISOString() ?? null,
    lastPullSuccessAt: peer.lastPullSuccessAt?.toISOString() ?? null,
    lastPokeReceivedAt: peer.lastPokeReceivedAt?.toISOString() ?? null,
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
  peerDomainId: TrustDomainId
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
  peerDomainId: TrustDomainId
): Promise<string | null> {
  const row = await currentPeerKeyRow(tx, orgId, peerDomainId);
  return row?.publicKey ?? null;
}

/** The peer's CURRENT cosign VERIFICATION public key. See docs/federation.md §357. */
export async function currentPeerCosignPublicKey(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId
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
  peerDomainId: TrustDomainId
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

/** The public key that must verify an entry at that sequence. See docs/federation.md §358. */
export function verificationKeyForSequence(keys: PeerKeyWindow[], sequence: number): string | null {
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
  /** TRUST sense (ADR-0021 D4) — the peer's own federation identity. */
  domainId: TrustDomainId;
  name: string;
  role: "commander" | "outpost" | "retrans";
  publicKey: string;
  /** M17.3 (E5) — the peer's cosign verification public key, exchanged in the SAME out-of-band
   *  pairing step as `publicKey`. Optional/additive: an OLD pair request lacking it still pairs
   *  (the peer's cosign key stays `null`). Registered ALONGSIDE `publicKey` in the same key window. */
  cosignPublicKey?: string | null;
  baseUrl?: string;
  syncScope?: SyncScope;
  /** M13.2a (§13.2) — tri-state, mirroring `cosignPublicKey`'s additive discipline: `undefined`
   *  (field absent — an old client) PRESERVES whatever is already configured; an object SETS it;
   *  explicit `null` CLEARS it back to the instance-env fallback. */
  deliveryTarget?: DeliveryTarget | null;
  /** M14.1 (ADR-0009) — per-peer poke-mode. See docs/federation.md §359. */
  pokeMode?: boolean;
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

  // The reserved governance label namespace, applied here too. See docs/federation.md §360.
  assertSyncScopeSelectorKeysAreGovernanceLabels(input.syncScope);

  const syncScope = input.syncScope ?? { mode: "full" as const };
  // ADDITIVE (E5): distinguish "cosign key omitted" (undefined — a pre-E5 client that never knew the
  // field; PRESERVE whatever is already registered) from "cosign key supplied" (a concrete value —
  // set or rotate). The over-the-wire schema is `.optional()` (not nullable), so absent === undefined.
  const cosignProvided = input.cosignPublicKey !== undefined;

  // M14.1 pair-time guard. See docs/federation.md §361.
  const effectivePokeMode =
    input.pokeMode !== undefined ? input.pokeMode : (existing[0]?.pokeMode ?? false);
  const effectiveBaseUrl =
    input.baseUrl !== undefined ? input.baseUrl : (existing[0]?.baseUrl ?? null);
  if (effectivePokeMode && !federationPeerRequiresMtls(effectiveBaseUrl)) {
    throw badRequest(
      "poke-mode requires an mTLS/https peer — the poke must authenticate the caller as the enrolled commander"
    );
  }

  if (!existing[0]) {
    const cosignPublicKey = cosignProvided ? (input.cosignPublicKey ?? null) : null;
    const inserted = await tx
      .insert(federationPeers)
      .values({
        id: input.domainId,
        orgId: input.orgId,
        name: input.name,
        role: input.role,
        baseUrl: input.baseUrl ?? null,
        syncScope,
        deliveryTarget: input.deliveryTarget ?? null,
        // M14.1: a new peer defaults to poll-mode (false) unless poke-mode is explicitly set.
        pokeMode: input.pokeMode ?? false
      })
      .returning()
      // drizzle/0045: pairing a NEW peer under a name another peer in this org already holds is refused.
      // Two peers with one name make every name-based resolution (peer GET/PATCH, hand-fill, exports) a
      // coin flip — see the constraint's header.
      .catch((err: unknown) => rethrowPeerNameConflict(err, input.name));
    const row = inserted[0];
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

  const repaired = await tx
    .update(federationPeers)
    .set({
      name: input.name,
      role: input.role,
      baseUrl: input.baseUrl ?? existing[0].baseUrl,
      syncScope,
      // Tri-state (see PairPeerInput): absent preserves, object sets, explicit null clears — a
      // re-pair from an old client that never knew the field can never strip a configured target.
      deliveryTarget:
        input.deliveryTarget !== undefined ? input.deliveryTarget : existing[0].deliveryTarget,
      // M14.1 tri-state (see PairPeerInput): absent (undefined) preserves the current poke-mode; an
      // explicit true/false sets it. A re-pair from an old client that never knew the field can never
      // flip it.
      pokeMode: input.pokeMode !== undefined ? input.pokeMode : existing[0].pokeMode
    })
    .where(and(eq(federationPeers.orgId, input.orgId), eq(federationPeers.id, input.domainId)))
    .returning()
    // drizzle/0045: a RE-pair may not rename this peer onto a name another peer already holds either.
    .catch((err: unknown) => rethrowPeerNameConflict(err, input.name));
  const row = repaired[0];
  if (!row) throw new Error("pairPeer: failed to update peer");

  // ── THE RE-ANCHOR ON `full`. See docs/federation.md §362.
  if (syncScope.mode === "full") {
    await permitCursorReanchor(tx, input.orgId, input.domainId);
  }

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
    // SECURITY-SENSITIVE (M6 review fix — CRITICAL). See docs/federation.md §363.
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

/** Turns drizzle/0045's `(org_id, name)` unique violation into the operator-facing 409 it deserves.
 *  Without this, "I renamed a peer to a name another peer already holds" would surface as a 500 —
 *  a fail-closed refusal is the right behaviour, an opaque one is not. */
function rethrowPeerNameConflict(err: unknown, name: string | undefined): never {
  if (isUniqueViolation(err, "federation_peers_org_name_key")) {
    throw conflict(
      `another federation peer in this org is already named '${name}' — peer names identify a peer on ` +
        `every /v1/federation route that accepts a name, so they must be unique`
    );
  }
  throw err;
}

export interface UpdatePeerTransportInput {
  orgId: string;
  /** TRUST sense (ADR-0021 D4) — the EXISTING peer's own federation identity. Never patchable: the
   *  identity IS the row, and "changing" it would be pairing a different peer. */
  domainId: TrustDomainId;
  name?: string;
  baseUrl?: string;
  syncScope?: SyncScope;
  /** Tri-state, identical to `pairPeer`'s: absent PRESERVES, an object SETS, explicit `null` CLEARS. */
  deliveryTarget?: DeliveryTarget | null;
  /** Absent PRESERVES, `true`/`false` SETS. A per-side LOCAL flag — never a control over the peer's
   *  own flag (ADR-0009; the owner's "this side only" semantics are unchanged by this route). */
  pokeMode?: boolean;
}

/** M16.2 phase A (E4) — `PATCH /v1/federation/peers/{id}`. See docs/federation.md §364. */
export async function updatePeerTransport(
  tx: TenantTx,
  input: UpdatePeerTransportInput
): Promise<FederationPeerRow> {
  const existingRows = await tx
    .select()
    .from(federationPeers)
    .where(and(eq(federationPeers.orgId, input.orgId), eq(federationPeers.id, input.domainId)))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) {
    throw notFound(
      `federation peer '${input.domainId}' not found — pair it first with 'scp federation pair'`
    );
  }

  // G7 (M14.1/M14.3), re-applied over the EFFECTIVE POST-WRITE TUPLE — the same computation
  // `pairPeer` performs, for the same reason: the two fields merge with OPPOSITE rules, so only the
  // merged pair says what will actually be stored.
  const effectivePokeMode = input.pokeMode !== undefined ? input.pokeMode : existing.pokeMode;
  const effectiveBaseUrl = input.baseUrl !== undefined ? input.baseUrl : existing.baseUrl;
  if (effectivePokeMode && !federationPeerRequiresMtls(effectiveBaseUrl)) {
    throw badRequest(
      "poke-mode requires an mTLS/https peer — the poke must authenticate the caller as the enrolled commander"
    );
  }

  // The PATCH half of the same refusal — `pairPeer`'s note applies unchanged, and this half is the
  // one that matters, since a peer paired at `full` can be narrowed to `custom` here without ever
  // passing through a pair.
  assertSyncScopeSelectorKeysAreGovernanceLabels(input.syncScope);

  const effectiveSyncScope = input.syncScope ?? (existing.syncScope as SyncScope);

  const updated = await tx
    .update(federationPeers)
    .set({
      name: input.name ?? existing.name,
      baseUrl: input.baseUrl ?? existing.baseUrl,
      syncScope: effectiveSyncScope,
      deliveryTarget:
        input.deliveryTarget !== undefined ? input.deliveryTarget : existing.deliveryTarget,
      pokeMode: effectivePokeMode
    })
    .where(and(eq(federationPeers.orgId, input.orgId), eq(federationPeers.id, input.domainId)))
    .returning()
    // G12 (drizzle/0045, review round 4 H6) — a rename onto another peer's name is refused, not
    // arbitrated. THIS is the guard that makes name-based resolution safe on the very route that then
    // writes transport: `name` became patchable here, and a name is a resolution key.
    .catch((err: unknown) => rethrowPeerNameConflict(err, input.name));
  const row = updated[0];
  if (!row) throw new Error("updatePeerTransport: failed to update peer");

  // Re-applied, but only when this call declares a scope. See docs/federation.md §365.
  if (input.syncScope !== undefined && effectiveSyncScope.mode === "full") {
    await permitCursorReanchor(tx, input.orgId, input.domainId);
  }

  // The key window is READ, never written — the returned view must still carry the peer's registered
  // keys, and reading them here (rather than reconstructing them) is what makes it impossible for
  // this function to report a key it did not leave exactly as it found.
  const key = await currentPeerKeyRow(tx, input.orgId, input.domainId);
  return toPeerRow(row, key?.publicKey ?? "", key?.cosignPublicKey ?? null);
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

/** The peer row for a trust-domain id, or `null` when this org has no such peer — the NON-throwing
 *  counterpart of `getPeerByIdOrName`, for callers that must not turn "no such peer" into their own
 *  404 because a LATER, more specific guard owns that refusal (M16.2 E1: `outposts-repo.ts` uses this
 *  purely to default a display name, and lets the peer-binding guard produce the authoritative 400). */
export async function findPeerByDomainId(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId
): Promise<FederationPeerRow | null> {
  const rows = await tx
    .select()
    .from(federationPeers)
    .where(and(eq(federationPeers.orgId, orgId), eq(federationPeers.id, peerDomainId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const key = await currentPeerKeyRow(tx, orgId, row.id);
  return toPeerRow(row, key?.publicKey ?? "", key?.cosignPublicKey ?? null);
}

/** Resolves a peer by its domain id OR its human name (CLI/route ergonomics — mirrors
 *  `graph/objects-repo.ts`'s idOrUrn convention). */
export async function getPeerByIdOrName(
  tx: TenantTx,
  orgId: string,
  idOrName: string
): Promise<FederationPeerRow> {
  if (!idOrName) throw badRequest("peer identifier is required");
  // `federationPeers.id` is a `uuid` column. See docs/federation.md §366.
  const condition = isUuid(idOrName)
    ? or(eq(federationPeers.id, asTrustDomainId(idOrName)), eq(federationPeers.name, idOrName))
    : eq(federationPeers.name, idOrName);
  // `(org_id, name)` is UNIQUE from drizzle/0045 on, so this can resolve at most one row by name. The
  // total ORDER BY is belt-and-braces for a database that has not yet run 0045: an ORDER-BY-less
  // `LIMIT 1` over a name collision resolved ARBITRARILY, and a PATCH on this route writes transport
  // (review round 4, H6). Deterministic beats arbitrary even in the state the constraint has removed.
  const rows = await tx
    .select()
    .from(federationPeers)
    .where(and(eq(federationPeers.orgId, orgId), condition))
    .orderBy(asc(federationPeers.pairedAt), asc(federationPeers.id))
    .limit(1);
  if (!rows[0])
    throw notFound(
      `federation peer '${idOrName}' not found — pair it first with 'scp federation pair'`
    );
  const key = await currentPeerKeyRow(tx, orgId, rows[0].id);
  return toPeerRow(rows[0], key?.publicKey ?? "", key?.cosignPublicKey ?? null);
}

/** Claims one peer's pull slot for the window, atomically. See docs/federation.md §367. */
export async function claimPeerPull(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId,
  opts: { now: Date; intervalSeconds: number; force?: boolean }
): Promise<boolean> {
  const threshold = new Date(opts.now.getTime() - opts.intervalSeconds * 1000);
  const dueCondition = or(
    isNull(federationPeers.lastPullAttemptAt),
    lte(federationPeers.lastPullAttemptAt, threshold)
  );
  const rows = await tx
    .update(federationPeers)
    .set({ lastPullAttemptAt: opts.now })
    .where(
      opts.force
        ? and(eq(federationPeers.orgId, orgId), eq(federationPeers.id, peerDomainId))
        : and(eq(federationPeers.orgId, orgId), eq(federationPeers.id, peerDomainId), dueCondition)
    )
    .returning({ id: federationPeers.id });
  return rows.length > 0;
}

/** M14.4 — stamp a SUCCESSFUL pull (the `imported` outcome only). Leaving this untouched on a
 *  failure is what keeps `lastPullSuccessAt < lastPullAttemptAt` meaning "the last attempt failed",
 *  which returns a poke-mode peer to the frequent cadence until one pull succeeds (the reconnect
 *  leg — a pure timestamp pair, no counters, replica-safe). */
export async function markPeerPullSuccess(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId,
  now: Date = new Date()
): Promise<void> {
  await tx
    .update(federationPeers)
    .set({ lastPullSuccessAt: now })
    .where(and(eq(federationPeers.orgId, orgId), eq(federationPeers.id, peerDomainId)));
}

/** Stamps that this peer's poke was accepted. See docs/federation.md §368. */
export async function markPokeReceived(
  tx: TenantTx,
  orgId: string,
  peerDomainId: TrustDomainId,
  now: Date = new Date()
): Promise<void> {
  await tx
    .update(federationPeers)
    .set({ lastPokeReceivedAt: now })
    .where(and(eq(federationPeers.orgId, orgId), eq(federationPeers.id, peerDomainId)));
}
