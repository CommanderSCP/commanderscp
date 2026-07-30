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
import { maxAppliedSequenceForPeer, permitCursorReanchor } from "./cursors-repo.js";
import { federationPeerRequiresMtls } from "./federation-outbound.js";

/**
 * Peer pairing + the peer public-key registry (DESIGN.md §13). Pairing itself is always initiated
 * from THIS side dialing/registering the other — never the reverse (§13 outpost-initiated-only;
 * for air-gapped peers, an out-of-band exchange of each side's `scp federation status` output).
 * This module only persists the result; it does not perform any network handshake itself (that's
 * `packages/plugins/federation-https`'s job for the connected-mTLS case).
 */

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
  /** M14.4 (ADR-0009, drizzle/0038) — the scheduler's per-peer due-state, ISO-8601 or `null`
   *  ("never"). `lastPullAttemptAt` is stamped by the conditional claim (every attempt, success or
   *  not); `lastPullSuccessAt` only by an `imported` outcome; `lastPokeReceivedAt` by the M14.2 poke
   *  handler when it ACCEPTS a poke from this peer. See {@link isPeerDue} for how the three combine
   *  into the frequent/sparse decision, and drizzle/0038 for why NULL is deliberately "due now". */
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
  /** M14.1 (ADR-0009) — per-peer poke-mode. Tri-state on re-pair, mirroring `deliveryTarget`'s
   *  additive discipline (a boolean has no null state, so: `undefined` = field absent = PRESERVE
   *  the current value; `true`/`false` = SET). An EFFECTIVE (post-write) `true` requires an
   *  https/mTLS-capable EFFECTIVE `baseUrl` — the pair-time guard (see `pairPeer`) checks the merged
   *  tuple, so a re-pair can neither set poke-mode true on a non-https peer NOR downgrade the baseUrl
   *  of a peer whose poke-mode stays true. */
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

  const syncScope = input.syncScope ?? { mode: "full" as const };
  // ADDITIVE (E5): distinguish "cosign key omitted" (undefined — a pre-E5 client that never knew the
  // field; PRESERVE whatever is already registered) from "cosign key supplied" (a concrete value —
  // set or rotate). The over-the-wire schema is `.optional()` (not nullable), so absent === undefined.
  const cosignProvided = input.cosignPublicKey !== undefined;

  // M14.1 pair-time guard (ADR-0009; the fail-closed transport-identity invariant). Poke-mode TRUE
  // requires an https/mTLS-capable peer baseUrl — the poke must authenticate the caller as the
  // enrolled commander (ADR-0001), which only the mTLS transport does. This is the EARLY guard (the
  // pair refuses); full enforcement (the outpost's poke endpoint refusing) is M14.2.
  //
  // M14.3 HARDENING — the guard validates the EFFECTIVE POST-WRITE STATE, not the input transition.
  // The two fields MERGE with OPPOSITE rules below (baseUrl: request wins when present; pokeMode:
  // tri-state, EXISTING wins when absent), so keying the guard off `input.pokeMode === true` checked a
  // DIFFERENT tuple than the one actually persisted. The hole: a re-pair that sets
  // `baseUrl: 'http://…'` while OMITTING pokeMode skipped the guard entirely and left an
  // `{http baseUrl, pokeMode: true}` row — which the sender would then dial with the federation bearer
  // in cleartext (scheme-derived `requireMtls` never fires for http). Computing the effective tuple
  // makes `pokeMode=true` on a non-https baseUrl UNREPRESENTABLE through EVERY path: explicit true on
  // http, explicit true with no baseUrl, an omitted pokeMode that preserves true while downgrading the
  // baseUrl, and a re-pair that preserves both. `pokeMode=false` (effective) is always allowed.
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

  // ── THE RE-ANCHOR ON `full` (pre-M16 residual W1; drizzle/0042; R1 fix). SECURITY-SENSITIVE.
  //
  // This side's own `sync_scope` for a peer being (or ending up) `full` is a SUPPORTED configuration
  // state that used to wedge that peer permanently the first time it happened: while narrow, this
  // side verified the peer's sparse chain and advanced its cursor with `last_applied_row_hash = NULL`
  // (correct — it never held the range tail's hash). The strict path then sat in front of an
  // ANCHORLESS cursor, whose absent hash `verifyJournalChain` reads as JOURNAL_GENESIS_HASH, so the
  // peer's next run — contiguous, gap-free, authentic — could not link, and every subsequent import
  // was refused forever. The prescribed recovery ("align both sync_scope values, re-export") was
  // inert.
  //
  // ORIGINALLY THIS WAS GATED ON THE TRANSITION (`previousScope.mode !== "full" && syncScope.mode ===
  // "full"`), which issues the permit exactly once, at the moment of the widen. That missed the ONLY
  // population that actually existed: every peer already wedged by the pre-fix bug already has
  // `sync_scope.mode === "full"` (the operator widened it with the OLD code, before this fix existed)
  // and an anchorless cursor — so there is no transition left to catch, and the message's own
  // prescribed recovery (re-pair with `--sync-scope full`) was a no-op transition-wise and issued
  // nothing. THE FIX: key issuance off the RESULTING scope and the cursor's actual state, not off
  // what it changed FROM. `permitCursorReanchor` itself already only touches a cursor that is
  // anchorless (`last_applied_row_hash IS NULL AND last_applied_seq > 0` — see cursors-repo.ts), so
  // calling it on every `pairPeer` that leaves this peer at `full` is safe and idempotent: a peer
  // that is already strictly anchored has nothing for the predicate to match, and re-declaring the
  // SAME `full` scope on an already-wedged peer now heals it, exactly as the refusal message says.
  //
  // A scope of `full` being set is a LOCAL, AUTHENTICATED OPERATOR ACTION on config that is never
  // carried on the wire and never reconciled, so it is the one signal it is legitimate to key a
  // re-anchor off. ANCHORING OFF WIRE DATA — e.g. adopting the row hash of whatever entry the bundle
  // claims sits at the cursor — would be an anchor chosen by the sender, which is precisely the
  // splice this cursor exists to prevent. Nothing a peer sends reaches this function: `pairPeer` has
  // exactly one caller, `POST /v1/federation/peers`, behind `federation:write`.
  //
  // ONLY TO `full`. `full` is the only mode that demands a contiguous, anchored chain, so it is the
  // only resulting scope that can strand an anchorless cursor. Narrowing needs no permit (sparse
  // verification never consults the anchor) and gets none. `permitCursorReanchor` additionally
  // refuses to touch any cursor that DOES hold a real anchor — see cursors-repo.ts.
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

/**
 * M16.2 phase A (E4) — `PATCH /v1/federation/peers/{id}`: the NARROW, TRANSPORT-ONLY peer write.
 *
 * SECURITY-CRITICAL, AND THE WHOLE REASON IT EXISTS. `pairPeer` is a re-pair: `publicKey` is REQUIRED
 * in its body, a DIFFERENT value is a KEY ROTATION that supersedes the current key window and
 * hard-revokes the old key at the applied-sequence anchor, and `name`/`role` are overwritten
 * unconditionally. A Settings form built on it rotates a peer's TRUST ANCHOR the first time it drops
 * or mangles the key. This function touches `federation_peers` ONLY — there is no reference to
 * `federationPeerKeys` anywhere in its body, and its input type has no field that could carry key
 * material — so no call, however malformed, can open, close or supersede a key window.
 *
 * ============================================================================================
 * PAIR-TIME GUARD CENSUS — every validation `POST /federation/peers` performs, and how this path
 * accounts for it. A new write door that silently skips the old door's checks is the bypass class
 * this project has already been bitten by, so each one is listed and dispositioned, not assumed.
 * ============================================================================================
 *  G1 requireAuth ....................... RE-APPLIED (route handler, identical call).
 *  G2 authorize `federation:write` @ org . RE-APPLIED (route handler, identical call).
 *  G3 self-pair refusal ("cannot pair this domain with itself") .... N/A BY CONSTRUCTION: this route
 *     resolves an EXISTING `federation_peers` row and never inserts. An instance is never its own
 *     peer (`initFederationSelf` writes `federation_self`, not a peer row), so the id cannot resolve
 *     to self — an attempt 404s at `getPeerByIdOrName` before this function is reached.
 *  G4 `assertDeliveryTargetRooted` (SCP_DELIVERY_ROOTS / SCP_DELIVERY_S3_ENDPOINTS allowlists)
 *     ..................................... RE-APPLIED at the route, the same call pairing makes, so
 *     an out-of-root drop directory or an un-allowlisted S3 endpoint is refused before storage.
 *  G5 body schema validation (name length, `baseUrl` is a URL, `syncScope` union, `deliveryTarget`
 *     strict union incl. absolute traversal-free dirs / relative traversal-free prefixes / bare
 *     bucket, `pokeMode` boolean) ......... RE-APPLIED: `UpdateFederationPeerRequestSchema` reuses the
 *     very same `SyncScopeSchema`/`DeliveryTargetSchema` members and the same `z.string().url()`.
 *  G6 `trustDomainIdFromWire` boundary .... N/A: no wire domain id is accepted here. The brand comes
 *     from the RESOLVED existing row, which is stronger than validating an input.
 *  G7 M14.1/M14.3 poke-mode ⇒ https/mTLS baseUrl guard, over the EFFECTIVE POST-WRITE TUPLE
 *     ..................................... RE-APPLIED BELOW, and it MUST be: this route's fields merge
 *     with exactly the same opposite rules the re-pair path has (baseUrl: request wins when present;
 *     pokeMode: existing wins when absent), so keying it off the request alone would check a different
 *     tuple than the one persisted — the M14.3 hole verbatim. All four shapes stay unrepresentable:
 *     explicit poke on http, explicit poke with no baseUrl at all, an omitted pokeMode that preserves
 *     `true` while downgrading baseUrl to http, and a no-op patch on an already-bad row.
 *  G8 `permitCursorReanchor` when the request DECLARES a syncScope whose RESULT is `full`
 *     ..................................... RE-APPLIED BELOW. Widening a peer to `full` through this
 *     route must heal an anchorless cursor exactly as widening it through a re-pair does; otherwise the
 *     documented recovery ("set the scope to full") would work on one route and silently wedge the peer
 *     forever on the other. NARROWED in review round 4 (H8) by `input.syncScope !== undefined`: with
 *     absent-means-preserve, a PATCH that only set `name` also resolved to `full` and issued the permit,
 *     so a RENAME fired a scope-declaration guard. See the call site for the full note.
 *  G9 key-window rotation/superseding ..... DELIBERATELY ABSENT — the point of this route. No key
 *     material is representable in the input, and no `federationPeerKeys` write exists here, so the
 *     capability is structurally missing rather than conditionally skipped.
 *  G10 tri-state PRESERVE semantics for `deliveryTarget`/`pokeMode`/`cosignPublicKey`
 *     ..................................... RE-APPLIED for the two transport fields (absent preserves;
 *     `deliveryTarget: null` clears). `cosignPublicKey` is key material — see G9 — and is preserved
 *     untouched because nothing here writes the key window at all.
 *  G11 unconditional `name`/`role` overwrite .... INTENTIONALLY NARROWED: `name` is patched only when
 *     supplied, and `role` is NOT patchable at all. A peer's federation role is an identity-level
 *     assertion made at pairing (it decides whether this side pulls FROM or exports TO the peer, and
 *     which validation the boundary applies); a settings form must not be able to flip it. Changing a
 *     role remains a deliberate re-pair.
 *  G12 `(org_id, name)` UNIQUENESS .... NEW in review round 4 (H6), and it had to be, because this route
 *     is the reason `name` is patchable at all. `getPeerByIdOrName` resolves a non-UUID identifier BY
 *     NAME, so two peers sharing a name made a TRANSPORT WRITE land on an arbitrary one of them. Enforced
 *     in the DATABASE (drizzle/0045, with a self-healing backfill) rather than per-route, and surfaced
 *     here as a 409 instead of a 500.
 * ============================================================================================
 */
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

  // G8, re-applied — but ONLY when this call actually DECLARES a scope (review round 4, H8). Keyed off
  // the RESULTING scope, never the transition, for exactly the reasons `pairPeer`'s long note gives:
  // `permitCursorReanchor` only touches a cursor that is genuinely anchorless, so re-declaring `full`
  // heals an already-wedged peer and is safe and idempotent.
  //
  // `input.syncScope !== undefined` is the part that was missing, and it is a DOC-VS-CODE fix, not a
  // security one. Absent-means-preserve meant a PATCH that only set `name` still resolved to `full` and
  // still issued the permit — so a RENAME fired a one-shot re-anchor permit, while `cursors-repo.ts` and
  // the G8 census row both describe the two call sites as "operator DECLARATIONS of this peer's own
  // sync_scope". A rename is not a scope declaration. Nothing was exploitable (the anchorless-cursor
  // predicate is the whole safety story and is unchanged), but a guard whose trigger is WIDER than every
  // document describing it is the defect class this repo has now fixed several times — including
  // `permitCursorReanchor`'s own header, rewritten once already for exactly this kind of drift.
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
  // `federationPeers.id` is a `uuid` column — comparing it against a non-UUID string (a plain
  // peer NAME) is a Postgres type error, not merely a non-match, so the id branch of the OR is
  // only included when `idOrName` actually parses as a UUID (mirrors `graph/objects-repo.ts`'s
  // `idOrUrnCondition` convention for the identical id-or-friendly-name ergonomic).
  // BOUNDARY (ADR-0021 D4): `idOrName` is an operator-supplied identifier that may be either a
  // trust-domain id or a human peer name. The `isUuid` branch is exactly where it has been
  // established to be the former, so that is where the brand is asserted.
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

/**
 * M14.4 (ADR-0009) — CLAIM one peer's pull slot for the current window, ATOMICALLY.
 *
 * A single conditional `UPDATE … RETURNING`: the row's `last_pull_attempt_at` is advanced to `now`
 * ONLY if it is NULL (never attempted — deliberately "due now", drizzle/0038) or older than
 * `now - intervalSeconds`. Returns `true` when THIS caller won the slot, `false` when the peer was
 * already claimed inside the window.
 *
 * WHY A CONDITIONAL UPDATE AND NOT AN IN-MEMORY MAP (load-bearing): the scheduler runs on every
 * worker replica. An in-process throttle would let N replicas each pull the same peer per window,
 * multiplying the effective poll rate by the replica count and defeating "sparse" exactly where it
 * matters most. Postgres row-locking during the UPDATE makes the claim mutually exclusive across
 * replicas, processes, and restarts, with no new coordination primitive (charter principle 4).
 *
 * `force` (the poke path, S4) SKIPS the window predicate but still stamps the attempt — a poke-woken
 * tick must never be swallowed by the very due-gate the poke complements.
 *
 * The threshold is computed from the CALLER's `now` rather than the database's `now()` purely so the
 * scheduler can be driven by a deterministic test clock; the mutual exclusion comes from the atomic
 * UPDATE, not from the clock source (two replicas with slightly skewed clocks still cannot both win
 * the same row).
 */
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

/** M14.4 (owner decision D2 — SELF-PROVING SPARSE) — stamp that this peer's poke was ACCEPTED. The
 *  M14.2 poke handler calls this after its consent + rate-limit gates pass. Until a peer has stamped
 *  at least once, the scheduler keeps it on the FREQUENT cadence no matter what the local
 *  `poke_mode` flag says: an outpost must never go sparse on the strength of its own flag alone
 *  (the commander's half may never have been enabled — silent staleness with no error anywhere). */
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
