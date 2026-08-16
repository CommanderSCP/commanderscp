import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { asTrustDomainId } from "@scp/schemas";
import type { TenantTx } from "../db/tenant-tx.js";
import { federationPeers, objects } from "../db/schema.js";
import { badRequest, conflict } from "../errors.js";
import { ensureFederationSelf } from "./self-repo.js";

/**
 * M16.2 phase A (E1) — THE AUTHORITY-SPLIT RULE, and the one choke point that enforces it.
 *
 * DECISION RECORD: `docs/adr/0022-outpost-config-authority-split.md` (referenced from BUILD_AND_TEST.md's
 * M16 entry). The ADR carries the WHY — why the journal cannot carry a peer, why the peer PATCH is
 * structurally keyless, why trust tier and transport mode are separate fields, why the registered JSON
 * Schema is deliberately open, and where the trust-tier vocabulary comes from (docs/GLOSSARY.md, which is
 * authoritative for vocabulary per CLAUDE.md). What follows is the normative statement it records.
 *
 * ============================================================================================
 * THE RULE (normative; `outpost-object.integration.test.ts` checks every clause of it)
 * ============================================================================================
 * After this increment "an outpost" exists TWICE in a commander's database, and the two halves own
 * DISJOINT, NON-OVERLAPPING sets of facts:
 *
 *  (1) THE `federation_peers` ROW (+ `federation_peer_keys`) IS THE SOLE AUTHORITY FOR TRANSPORT
 *      IDENTITY AND REACHABILITY: the peer's trust-domain id, its Ed25519 signing key and cosign
 *      verification key (with their sequence-anchored windows), `base_url`, `sync_scope`,
 *      `delivery_target`, `poke_mode`, and the scheduler's per-peer timestamps. It is LOCAL and
 *      PER-SIDE: it never rides the sync journal, is never reconciled with the other side, and is
 *      operationally load-bearing (the exporter, the puller, the poke sender and every signature
 *      verification read it and nothing else). Its only write doors are `POST /v1/federation/peers`
 *      (pair/re-pair, the only door that may touch key material) and
 *      `PATCH /v1/federation/peers/{id}` (transport only, structurally keyless).
 *
 *  (2) THE `outpost` GRAPH OBJECT IS THE SOLE AUTHORITY FOR COMMANDER-DECLARED CONFIG ABOUT THAT
 *      OUTPOST: today `trustTier`, plus the `peerDomainId` that binds it to (1). It is
 *      commander-origin, rides `object_upsert` on the sync journal, and lands at the outpost as a
 *      READ-ONLY REPLICA (`objects-repo.ts`'s single-writer guard). Its write doors are
 *      `POST/PATCH /v1/federation/outposts…`, and — for a future IaC manifest — the plan-apply path,
 *      which resolves `federation:write` for this type rather than plain `object:write`.
 *
 *  (3) NEITHER MAY EXPRESS THE OTHER'S FIELDS — enforced by TWO DIFFERENT MECHANISMS ON THE TWO WRITE
 *      DOORS CLAUSE (2) NAMES, not by any structural unrepresentability of the stored object (review
 *      round 6, M2 — the previous wording of this clause claimed exactly that structural guarantee, and
 *      it was false: the IaC plan-apply door clause (2) itself names is the second door, it does NOT go
 *      through the request bodies below, and it CAN store a transport-shaped key):
 *        * THE OPERATOR-TYPING DOOR — `POST/PATCH /v1/federation/outposts…` — carries no transport
 *          field of any kind: the request bodies (`CreateOutpostConfigRequestSchema`/
 *          `UpdateOutpostConfigRequestSchema`) are `z.strictObject`, so an unknown property (including a
 *          transport-shaped one) is REFUSED WITH 400 rather than silently stripped (review round 5, N6).
 *          This is what actually stops an OPERATOR from typing a transport field into the object; it is
 *          NOT a claim about the IaC door below.
 *        * THE IaC PLAN-APPLY DOOR does not go through those request bodies. The registered JSON Schema
 *          for `outpost` is deliberately OPEN (review round 4, H7 — read drizzle/0043's header before
 *          tightening it: that schema is journaled and validated on the RECEIVING side, so closing it
 *          would turn every future property into a fail-closed version-skew hazard that aborts whole
 *          sync bundles), so a plan-apply manifest CAN store a `baseUrl`/`trustTier`-shaped key under an
 *          `outpost` object's properties and pass validation — MEASURED (review round 6, M2), not merely
 *          possible. What stops that from being a privilege escalation is NOT unrepresentability: it is
 *          (a) the IaC door resolves the same `federation:write` an operator-typed write does (no
 *          broader grant reaches it), (b) the 1:1 peer-binding guard in clause (4) still fires against
 *          it exactly as it does against any other write, and (c) whatever lands in `properties` is
 *          INERT — every transport read (the exporter, the puller, the poke sender, every signature
 *          verification) reads ONLY the peer row, never the object's `properties`, so a smuggled
 *          `baseUrl` is stored but never consulted.
 *        * no declared-config field is REPRESENTABLE on the peer row — there IS a structural guarantee
 *          in this direction: there is no trust-tier column, and the PATCH body admits only
 *          `{name, baseUrl, syncScope, deliveryTarget, pokeMode}`.
 *      Consequence, and the shape the tests assert in BOTH directions: a config write through the
 *      operator-typing door leaves `federation_peers`/`federation_peer_keys` untouched and appends
 *      exactly one journal entry; a transport write leaves the object's `version`/`revision` untouched
 *      and appends NO journal entry at all (F1 — peer state cannot ride the journal, by construction).
 *
 *  (4) THE PEER ROW IS THE ANCHOR; THE BINDING IS 1:1 AND OBJECT→PEER ONLY. An `outpost` object must
 *      name an already-paired peer that holds role `outpost` (an unbound `peerDomainId` is a 400) —
 *      OR, since pipeline-substrate-registry-scan.md §10.5 (owner, 2026-08-16), THIS INSTANCE'S OWN
 *      TRUST DOMAIN (`federation_self.domainId`): THE CO-LOCATED OUTPOST, the "commander and outpost
 *      are one and the same" case, in which every target this instance authors is within an outpost
 *      too — accepted ONLY when `federation_self.role` is `commander` (an outpost's own record is
 *      commander-declared and arrives replicated; a locally authored one would outrank the replica in
 *      every `byAuthority` read). Those are the ONLY two accepted shapes; anything else stays fail-closed. A second object
 *      for the same domain (peer OR self) is a 409. The object never creates, mutates, or is
 *      required by the peer row — deleting nothing and blocking nothing. Federation works exactly as
 *      before for a peer that has no `outpost` object; the object only adds declared config. The
 *      self-bound record has NO peer row at all — every reader that joins a record to its peer row
 *      renders it as "this instance" (name/role from `federation_self`; `OutpostConfig.peerIsSelf`).
 *      ONE ASYMMETRY, and it is the H1 fix: on an UPDATE the 409 fires only for an AUTHORITATIVE
 *      claimant. An unverified `provenance:'manual'` shadow gets no veto over an edit to the row that
 *      actually holds authority — that veto was reachable, permanent, and had no delete door. Duplicates
 *      are removable through `POST /v1/federation/outposts/{peer}/reconcile` (`outposts-repo.ts`).
 *
 *  (5) TIE-BREAK, when both halves could seem to answer one question: THE PEER ROW WINS for anything
 *      about reachability. "Is this outpost air-gapped?" is derived from `base_url`/`delivery_target`
 *      on the peer row — never from `trustTier`, which is why the transport channel is deliberately NOT
 *      a trust tier (one field meaning both trust posture and reachability would mean neither). The
 *      derived field is `transportMode` on the status row, and it reports what CONFIG says
 *      (`dialable`/`air-gap`), never an observation of reachability — see `status-repo.ts`.
 * ============================================================================================
 *
 * WHERE THIS IS ENFORCED, AND WHY HERE. Clause (4) is checked in ONE place — `graph/objects-repo.ts`'s
 * `createObject`/`updateObject`, for LOCAL-ORIGIN writes only — rather than at each route. Guarding
 * routes one at a time is precisely the incomplete-call-site-census failure this project keeps
 * hitting: the free-form-`typeId` local write doors are the generic `/objects/{type}` endpoints, the
 * IaC plan-apply path, the federation OVERLAY route, and `POST /discovery/{...}/accept`, and any
 * future door would silently be a fifth. Sitting inside the repo write path covers all of them and
 * everything added later.
 *
 * IMPORT PATHS STAY PERMISSIVE BY CONSTRUCTION, and must: the check is skipped whenever
 * `federationImport` is set. At the OUTPOST, the arriving replica names the outpost's OWN domain id
 * as `peerDomainId` — which is deliberately NOT in that instance's `federation_peers` (an instance is
 * not its own peer), so applying clause (4) to a replica would refuse every legitimate sync. A bundle can
 * ALSO legitimately carry a THIRD domain's `outpost` object (a commander at full sync scope ships outpost
 * B's config down to outpost A), so the skip cannot be narrowed to "names my own domain" on this path
 * either — doing so would abort whole bundles.
 *
 * THAT SKIP IS WHY HAND-FILL NEEDED ITS OWN GUARD (review round 4, H1). `handfill-repo.ts` stamps a
 * FOREIGN origin through the same `federationImport` channel, so it inherited the skip — but unlike a
 * journal entry its `peerDomainId` is OPERATOR-SUPPLIED and nothing has verified it, which made
 * `POST /v1/federation/hand-fill` a fifth free-form-`typeId` local write door that bypassed all three
 * clause-(4) refusals. It is closed AT THAT MODULE (`assertHandFillableType`), which restricts a
 * hand-filled peer-bound object to the receiving instance's OWN domain id — the only shape a real replica
 * has. `import-repo.ts` and `handfill-repo.ts` are the complete census of `federationImport` suppliers.
 */

/** Object types whose objects must be bound to a paired federation peer. A ReadonlySet so the guard
 *  generalizes if a second peer-bound type ever appears, rather than hard-coding `"outpost"` at each
 *  call site (the `service-member-types.ts` convention). */
export const PEER_BOUND_OBJECT_TYPE_IDS: ReadonlySet<string> = new Set(["outpost"]);

export function isPeerBoundObjectType(typeId: string): boolean {
  return PEER_BOUND_OBJECT_TYPE_IDS.has(typeId);
}

/** The federation role a peer must hold to be the subject of an `outpost` config object. `retrans`
 *  and `commander` peers are refused: an `outpost` object asserting a trust tier about the commander
 *  this instance reports UP to is nonsense, and silently accepting it would put declared config on a
 *  peer no outpost UI will ever render. */
const REQUIRED_PEER_ROLE = "outpost";

/** The federation role THIS instance must hold (`federation_self.role`) to author the CO-LOCATED
 *  outpost record (§10.5) — the record about its own trust domain. Only a commander declares outpost
 *  config (clause (2)); on an outpost that record is the commander's replica, and a local one authored
 *  ahead of it would outrank the replica in every `byAuthority` read (see the check below). */
const SELF_BINDING_ROLE = "commander";

/**
 * Clause (4) of the rule above, for one local-origin `outpost` write. Throws `badRequest` when the
 * binding is missing/unbound/wrong-role and `conflict` when another live object already claims the
 * peer. `objectId` is the id being written — excluded from the duplicate scan so an UPDATE of an
 * existing object never conflicts with itself.
 */
export async function assertOutpostPeerBinding(
  tx: TenantTx,
  input: {
    orgId: string;
    objectId: string;
    properties: Record<string, unknown>;
    /** Set by the UPDATE half of the choke point only (review round 4, H1). See the note on the clash
     *  scan below: an UNVERIFIED hand-filled shadow must not be able to VETO an edit to the row that
     *  actually holds authority — that veto WAS the unrecoverable wedge. A CREATE stays strict, so the
     *  create door can never grow a second live claimant in the first place. */
    ignoreUnverifiedClash?: boolean;
  }
): Promise<void> {
  const raw = input.properties.peerDomainId;
  if (typeof raw !== "string" || raw.length === 0) {
    throw badRequest(
      "an 'outpost' object must carry properties.peerDomainId — the trust-domain id of the already-paired peer it describes, or this instance's own domain id for the co-located outpost"
    );
  }
  const peerDomainId = raw;

  // §10.5 — THE CO-LOCATED OUTPOST: `peerDomainId` naming THIS instance's own trust domain is the
  // second accepted shape. There is no peer row to check a role against (an instance is not its own
  // peer — `outpost-binding.ts` module doc, IMPORT PATHS), so the role checked is THIS instance's own
  // (`federation_self.role`), and it must be `commander` — clause (2): an outpost's record is
  // COMMANDER-DECLARED and arrives at the outpost as a read-only replica. Without this check an
  // OUTPOST-role instance could author a local-origin `outpost` object for its own domain BEFORE the
  // commander's record synced down; the replica then lands beside it (imports skip this guard, and
  // its URN carries the commander's org prefix so nothing clashes), and `byAuthority` (local-origin
  // first) would make the outpost's own declaration win every read of its own record while the
  // commander's tier never converged — the inversion of ADR-0022 for exactly the record §10.5 says
  // "arrives replicated". `outpost-config-sync.integration.test.ts` pins the refusal both before and
  // after the replica arrives. `unset` (never `scp federation init`) is refused too: fail-closed, and
  // the copy says which command designates the role. Accepted, it skips straight to the 1:1 scan
  // below, which applies to it exactly as to a peer: a second self-bound object is the same 409.
  // `ensureFederationSelf` is the ONE reader of `federation_self` (self-repo.ts) — lazily minted, so
  // this never fails for want of an identity row.
  const self = await ensureFederationSelf(tx, input.orgId);
  const isSelf = peerDomainId === (self.domainId as string);
  if (isSelf && self.role !== SELF_BINDING_ROLE) {
    throw badRequest(
      `peerDomainId '${peerDomainId}' is this instance's own trust domain, but this instance's ` +
        `federation role is '${self.role}', not '${SELF_BINDING_ROLE}' — an outpost's own record is ` +
        `commander-declared and arrives replicated from the commander; declare it there ` +
        (self.role === "unset"
          ? `(or designate this instance's role first: 'scp federation init --role commander')`
          : `('scp federation outpost declare --peer ${peerDomainId}' at the commander)`)
    );
  }

  const peerRows = isSelf
    ? []
    : await tx
        .select({ id: federationPeers.id, role: federationPeers.role })
        .from(federationPeers)
        // BOUNDARY (ADR-0021 D4): `properties.peerDomainId` names a PEER'S FEDERATION IDENTITY — the
        // TRUST sense — which is exactly what `federation_peers.id` holds. This lookup is where the
        // operator-supplied string is asserted to be that, and it fails closed one line below if it is
        // not actually a paired peer.
        .where(
          and(
            eq(federationPeers.orgId, input.orgId),
            eq(federationPeers.id, asTrustDomainId(peerDomainId))
          )
        )
        .limit(1);
  const peer = peerRows[0];
  if (!isSelf && !peer) {
    // FAIL-CLOSED on the anchor: config about a peer this instance has never paired with has no
    // transport to ride down and no identity to be verified against. Refuse rather than store a
    // dangling assertion that would look configured in a UI. The copy names BOTH accepted shapes.
    throw badRequest(
      `peerDomainId '${peerDomainId}' is neither a paired federation peer nor this instance's own ` +
        `trust domain ('${self.domainId}') — an 'outpost' config object may name a paired peer of role ` +
        `'${REQUIRED_PEER_ROLE}' (pair it first: 'scp federation pair') or this instance's own domain id ` +
        `(GET /federation/self) for the co-located outpost`
    );
  }
  if (peer && peer.role !== REQUIRED_PEER_ROLE) {
    throw badRequest(
      `peer '${peerDomainId}' has federation role '${peer.role}', not '${REQUIRED_PEER_ROLE}' — ` +
        `an 'outpost' config object may only describe a peer this instance holds as an outpost, or ` +
        `this instance's own trust domain ('${self.domainId}') as the co-located outpost`
    );
  }

  const clashing = await tx
    .select({ id: objects.id, provenance: objects.provenance })
    .from(objects)
    .where(
      and(
        eq(objects.orgId, input.orgId),
        eq(objects.typeId, "outpost"),
        isNull(objects.deletedAt),
        ne(objects.id, input.objectId),
        // The binding lives in the object's JSONB properties (graph-native: no new column), so the
        // uniqueness scan is a JSONB text comparison. Bounded by the number of outpost objects in
        // the org — one per enrolled outpost, i.e. tens at most.
        sql`${objects.properties} ->> 'peerDomainId' = ${peerDomainId}`
      )
    )
    .orderBy(asc(objects.createdAt), asc(objects.id));
  // AN UNVERIFIED SHADOW IS NOT AN AUTHORITY, AND ON AN UPDATE IT GETS NO VETO (review round 4, H1).
  // This scan used to be an unordered `LIMIT 1` applied identically to creates and updates, which is how
  // one hand-filled `provenance:'manual'` duplicate made the commander's own
  // `PATCH /v1/federation/outposts/{peer}` return 409 FOREVER — with no delete door anywhere in the API,
  // an UNRECOVERABLE state reached by a supported call. On an UPDATE the question is only "does another
  // row hold AUTHORITY for this peer?", and a hand-typed, signature-less copy does not.
  //
  // A CREATE stays strict against every live claimant, shadows included: that keeps the create door from
  // ever growing a second row, so the 1:1 invariant holds going forward. The recovery for a database that
  // already holds one is `POST /v1/federation/outposts/{peer}/reconcile`, named in the refusal below
  // precisely so the operator is never left guessing.
  const blocking = input.ignoreUnverifiedClash
    ? clashing.filter((row) => row.provenance !== "manual")
    : clashing;
  if (blocking[0]) {
    const unverified = blocking[0].provenance === "manual";
    throw conflict(
      `peer '${peerDomainId}' already has an outpost config object ('${blocking[0].id}') — ` +
        `the binding is one-to-one; PATCH that object instead of declaring a second one` +
        (unverified
          ? `. That object is an UNVERIFIED hand-filled shadow copy: POST ` +
            `/v1/federation/outposts/${peerDomainId}/reconcile adopts it as this domain's own config ` +
            `(or removes it when an authoritative row already exists)`
          : "")
    );
  }
}
