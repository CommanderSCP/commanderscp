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
import { badRequest, notFound } from "../errors.js";
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
    const [row] = await tx
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
    .returning();
  if (!row) throw new Error("pairPeer: failed to update peer");

  // ── THE SCOPE-WIDEN RE-ANCHOR (pre-M16 residual W1; drizzle/0042). SECURITY-SENSITIVE.
  //
  // Widening this side's own `sync_scope` for a peer back to `full` is a SUPPORTED configuration
  // change that used to wedge that peer permanently: while narrow, this side verified the peer's
  // sparse chain and advanced its cursor with `last_applied_row_hash = NULL` (correct — it never
  // held the range tail's hash). Widening then put the strict path in front of an ANCHORLESS
  // cursor, whose absent hash `verifyJournalChain` reads as JOURNAL_GENESIS_HASH, so the peer's
  // next run — contiguous, gap-free, authentic — could not link, and every subsequent import was
  // refused forever. The prescribed recovery ("align both sync_scope values, re-export") was inert.
  //
  // A scope change is a LOCAL, AUTHENTICATED OPERATOR ACTION on config that is never carried on the
  // wire and never reconciled, so it is the one signal it is legitimate to key a re-anchor off.
  // ANCHORING OFF WIRE DATA — e.g. adopting the row hash of whatever entry the bundle claims sits at
  // the cursor — would be an anchor chosen by the sender, which is precisely the splice this cursor
  // exists to prevent. Nothing a peer sends reaches this function: `pairPeer` has exactly one
  // caller, `POST /v1/federation/peers`, behind `federation:write`.
  //
  // WIDEN ONLY, AND ONLY TO `full`. `full` is the only mode that demands a contiguous, anchored
  // chain, so it is the only transition that can strand an anchorless cursor. Narrowing needs no
  // permit (sparse verification never consults the anchor) and gets none. `permitCursorReanchor`
  // additionally refuses to touch any cursor that DOES hold a real anchor — see cursors-repo.ts.
  const previousScope = existing[0].syncScope as SyncScope;
  if (previousScope.mode !== "full" && syncScope.mode === "full") {
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
  // BOUNDARY (ADR-0021 D4): `idOrName` is an operator-supplied identifier that may be either a
  // trust-domain id or a human peer name. The `isUuid` branch is exactly where it has been
  // established to be the former, so that is where the brand is asserted.
  const condition = isUuid(idOrName)
    ? or(eq(federationPeers.id, asTrustDomainId(idOrName)), eq(federationPeers.name, idOrName))
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
